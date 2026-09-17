
import SalesforceService from '../services/salesforceService.js';
import Quote from '../models/Quote.js';
import cacheService from '../services/CacheService.js';
import AuditLogger from '../services/AuditLogger.js';
import NotificationService from '../services/NotificationService.js';
import ExportService from '../services/ExportService.js';
import { createDownloadToken } from '../services/downloadTokenService.js';
import { sendQuotePdfEmail } from '../services/emailService.js';
import { calculateQuoteTotals } from '../utils/quoteCalculations.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const invalidateQuoteCaches = async (userId, id) => {
  const tasks = [cacheService.deleteByPrefix(`quotes_${userId}`)];
  if (id) {
    tasks.push(cacheService.delete(`quote_${userId}_${id}`));
    tasks.push(cacheService.delete(`quote_lines_${userId}_${id}`));
  }
  await Promise.all(tasks);
};

const recordActivity = async (req, { action, eventType, resourceId, changes, title, message }) => {
  NotificationService.notify(req.user._id.toString(), eventType, { title, message, resourceId, changes });

  await AuditLogger.log(action, {
    userId: req.user._id,
    resourceType: 'Quote',
    resourceId,
    eventType,
    title,
    message,
    changes,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error('Failed to audit-log quote activity:', err.message));
};

/**
 * pdfkit's PDFDocument is a Readable stream - collect it into a Buffer
 * before it can be hashed (createDownloadToken) or attached to an email.
 * Mirrors the identical helper in data.controller.js.
 */
const pdfDocToBuffer = (doc) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

/**
 * Load a quote and its line items together - shared by getQuoteById and the
 * PDF/email endpoints, which all need the exact same combined shape.
 */
const loadQuoteWithLineItems = async (salesforce, quoteId) => {
  const [quoteResult, lineItems] = await Promise.all([
    salesforce.getQuoteById(quoteId),
    salesforce.getQuoteLineItems(quoteId),
  ]);

  if (quoteResult.records.length === 0) return null;
  return { quote: quoteResult.records[0], lineItems };
};

/**
 * @route   GET /api/salesforce/quotes/meta/statuses
 * @access  Private
 */
export const getQuoteStatuses = async (req, res) => {
  try {
    const cacheKey = `quote_statuses_${req.user._id}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, data: cached, source: 'cache' });

    const salesforce = new SalesforceService(req.user);
    const statuses = await salesforce.getQuoteStatuses();

    await cacheService.set(cacheKey, statuses, 3600);
    res.status(200).json({ success: true, data: statuses });
  } catch (error) {
    console.error('Error fetching quote statuses:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/quotes/products
 * @desc    Product catalog for the line item picker, priced against either
 *          an explicit price book or the one resolved from an opportunity.
 * @access  Private
 */
export const getProductCatalog = async (req, res) => {
  try {
    const { opportunityId, pricebookId, search, limit = 50, offset = 0 } = req.query;

    if (!opportunityId && !pricebookId) {
      return res.status(400).json({ success: false, message: 'opportunityId or pricebookId is required' });
    }

    const salesforce = new SalesforceService(req.user);
    const resolvedPricebookId = pricebookId || (await salesforce.resolveQuotePricebookId(opportunityId));

    const cacheKey = `quote_products_${req.user._id}_${resolvedPricebookId}_${search}_${limit}_${offset}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, data: cached, source: 'cache' });

    const products = await salesforce.getProductCatalog({
      pricebookId: resolvedPricebookId,
      searchTerm: search,
      limit: Math.min(parseInt(limit), 200),
      offset: Math.max(0, parseInt(offset)),
    });

    // Products change far less often than quotes/line items - a longer TTL
    // keeps the picker snappy without needing its own invalidation path.
    await cacheService.set(cacheKey, products, 600);
    res.status(200).json({ success: true, data: products, source: 'salesforce' });
  } catch (error) {
    console.error('Error fetching product catalog:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/quotes
 * @access  Private
 */
export const getQuotes = async (req, res) => {
  try {
    const { limit = 50, offset = 0, opportunityId, accountId, status, search } = req.query;
    const cacheKey = `quotes_${req.user._id}_${limit}_${offset}_${opportunityId}_${accountId}_${status}_${search}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, data: cached, source: 'cache' });

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getQuotes({
      limit: Math.min(parseInt(limit), 200),
      offset: Math.max(0, parseInt(offset)),
      opportunityId,
      accountId,
      status,
      searchTerm: search,
    });

    await cacheService.set(cacheKey, result, 180);
    res.status(200).json({ success: true, data: result, source: 'salesforce' });
  } catch (error) {
    console.error('Error fetching quotes:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/quotes/:id
 * @desc    A single quote together with its line items.
 * @access  Private
 */
export const getQuoteById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `quote_${req.user._id}_${id}`;

    const cached = await cacheService.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, data: cached, source: 'cache' });

    const salesforce = new SalesforceService(req.user);
    const combined = await loadQuoteWithLineItems(salesforce, id);

    if (!combined) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    await cacheService.set(cacheKey, combined, 120);
    res.status(200).json({ success: true, data: combined });
  } catch (error) {
    console.error('Error fetching quote:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/quotes
 * @access  Private
 */
export const createQuote = async (req, res) => {
  try {
    const { Name, OpportunityId, ExpirationDate, Description, Discount, Tax, ShippingHandling } = req.body;

    if (!Name || !OpportunityId) {
      return res.status(400).json({ success: false, message: 'Quote name and Opportunity are required' });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createQuote({
      Name,
      OpportunityId,
      ExpirationDate: ExpirationDate || null,
      Description: Description || null,
      Discount: Discount !== undefined ? parseFloat(Discount) : null,
      Tax: Tax !== undefined ? parseFloat(Tax) : null,
      ShippingHandling: ShippingHandling !== undefined ? parseFloat(ShippingHandling) : null,
    });

    // Outbound sync, step 2: now that Salesforce has created the linked
    // Quote, lock the relationship (Salesforce QuoteId <-> OpportunityId
    // <-> the user who sent it) in Mongo - this is what lets the inbound
    // Salesforce webhook (see webhookController.js) find its way back to
    // *this* user's live dashboard when the Opportunity later closes.
    // Best-effort: a failure here must never fail the quote Salesforce
    // already successfully created, it just means this one quote won't get
    // a real-time "deal won" push later.
    try {
      await Quote.create({
        userId: req.user._id,
        salesforceQuoteId: result.id,
        opportunityId: OpportunityId,
        name: Name,
      });
    } catch (linkError) {
      console.error('Failed to create local Quote sync record:', linkError.message);
    }

    await invalidateQuoteCaches(req.user._id);

    await recordActivity(req, {
      action: 'CREATE',
      eventType: 'quote.created',
      resourceId: result.id,
      changes: { Name, OpportunityId },
      title: 'Quote created',
      message: `A new quote "${Name}" was drafted`,
    });

    res.status(201).json({ success: true, message: 'Quote created successfully', data: result });
  } catch (error) {
    console.error('Error creating quote:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PATCH /api/salesforce/quotes/:id
 * @access  Private
 */
export const updateQuote = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };

    if (updates.Discount !== undefined) updates.Discount = parseFloat(updates.Discount) || 0;
    if (updates.Tax !== undefined) updates.Tax = parseFloat(updates.Tax) || 0;
    if (updates.ShippingHandling !== undefined) updates.ShippingHandling = parseFloat(updates.ShippingHandling) || 0;

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateQuote(id, updates);

    await invalidateQuoteCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'quote.updated',
      resourceId: id,
      changes: updates,
      title: updates.Status ? `Quote ${updates.Status.toLowerCase()}` : 'Quote updated',
      message: updates.Status ? `A quote's status changed to ${updates.Status}` : 'A quote was updated',
    });

    res.status(200).json({ success: true, message: 'Quote updated successfully' });
  } catch (error) {
    console.error('Error updating quote:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   DELETE /api/salesforce/quotes/:id
 * @access  Private (manager/admin - see salesforce.routes.js)
 */
export const deleteQuote = async (req, res) => {
  try {
    const { id } = req.params;

    const salesforce = new SalesforceService(req.user);
    await salesforce.deleteQuote(id);

    await invalidateQuoteCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'DELETE',
      eventType: 'quote.deleted',
      resourceId: id,
      changes: null,
      title: 'Quote deleted',
      message: 'A quote was deleted',
    });

    res.status(200).json({ success: true, message: 'Quote deleted successfully' });
  } catch (error) {
    console.error('Error deleting quote:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   PUT /api/salesforce/quotes/:id/line-items
 * @desc    Replace the full set of line items on a quote in one call - the
 *          dynamic line item engine's save action (add/remove/reorder/edit
 *          quantities & discounts all collapse into one array the frontend
 *          sends as a whole). See salesforceService.replaceQuoteLineItems
 *          for why this is insert-then-delete rather than a diff/patch.
 * @access  Private
 */
export const saveQuoteLineItems = async (req, res) => {
  try {
    const { id } = req.params;
    const { lineItems } = req.body;

    if (!Array.isArray(lineItems)) {
      return res.status(400).json({ success: false, message: 'lineItems must be an array' });
    }
    if (lineItems.length > 200) {
      return res.status(400).json({ success: false, message: 'A quote cannot have more than 200 line items' });
    }

    for (const [index, item] of lineItems.entries()) {
      if (!item.pricebookEntryId) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: a product is required` });
      }
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: quantity must be greater than 0` });
      }
      const unitPrice = Number(item.unitPrice);
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: unit price cannot be negative` });
      }
      const discount = item.discount !== undefined ? Number(item.discount) : 0;
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        return res.status(400).json({ success: false, message: `Line ${index + 1}: discount must be between 0 and 100` });
      }
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.replaceQuoteLineItems(id, lineItems);

    await invalidateQuoteCaches(req.user._id, id);

    await recordActivity(req, {
      action: 'UPDATE',
      eventType: 'quote.lineitems_saved',
      resourceId: id,
      changes: { lineItemCount: lineItems.length },
      title: 'Quote line items updated',
      message: `Line items saved (${lineItems.length} item${lineItems.length === 1 ? '' : 's'})`,
    });

    if (result.orphanedOldIds.length > 0) {
      await AuditLogger.log('DELETE', {
        userId: req.user._id,
        resourceType: 'QuoteLineItem',
        resourceId: id,
        changes: { orphanedOldIds: result.orphanedOldIds },
        status: 'failure',
        errorMessage: 'Superseded line items could not be removed after the new set was saved',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch(() => {});

      return res.status(207).json({
        success: true,
        message: `Line items saved, but ${result.orphanedOldIds.length} old line item(s) could not be removed - refresh and try saving again to clean them up.`,
        data: result,
      });
    }

    res.status(200).json({ success: true, message: 'Line items saved successfully', data: result });
  } catch (error) {
    console.error('Error saving quote line items:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   GET /api/salesforce/quotes/:id/pdf
 * @desc    Render the quote to a styled PDF server-side and hand back a
 *          secure, single-use, 1-hour download link (same pattern as the
 *          dashboard stats export - see data.controller.js/exportDashboardStats)
 *          for the frontend to redeem for an instant browser download.
 * @access  Private
 */
export const getQuotePdfLink = async (req, res) => {
  try {
    const { id } = req.params;
    const salesforce = new SalesforceService(req.user);
    const combined = await loadQuoteWithLineItems(salesforce, id);

    if (!combined) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    const doc = await ExportService.exportQuoteToPDF(combined.quote, combined.lineItems, req.user);
    const content = await pdfDocToBuffer(doc);
    const filename = `${(combined.quote.QuoteNumber || combined.quote.Name || 'quote').replace(/[^a-z0-9-_]+/gi, '-')}.pdf`;

    const { token, fileHash, expiresAt } = await createDownloadToken({
      userId: req.user._id,
      ip: req.ip,
      filename,
      contentType: 'application/pdf',
      content,
    });

    await AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: 'Quote',
      resourceId: id,
      changes: { fileHash },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch((err) => console.error('Failed to audit-log quote PDF export:', err.message));

    res.status(200).json({
      success: true,
      data: { downloadUrl: `/export/download/${token}`, filename, expiresAt, fileHash },
    });
  } catch (error) {
    console.error('Error generating quote PDF:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

/**
 * @route   POST /api/salesforce/quotes/:id/email
 * @desc    Render the quote to PDF (same renderer as getQuotePdfLink) and
 *          email it as an attachment to a recipient the user supplies -
 *          never a client-uploaded file, so this can't be used to relay
 *          arbitrary attachments through the app's mail account.
 * @access  Private
 */
export const emailQuotePdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { to, recipientName } = req.body;

    if (!to || !EMAIL_RE.test(to)) {
      return res.status(400).json({ success: false, message: 'A valid recipient email address is required' });
    }

    const salesforce = new SalesforceService(req.user);
    const combined = await loadQuoteWithLineItems(salesforce, id);

    if (!combined) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    const doc = await ExportService.exportQuoteToPDF(combined.quote, combined.lineItems, req.user);
    const pdfBuffer = await pdfDocToBuffer(doc);
    const pdfFilename = `${(combined.quote.QuoteNumber || combined.quote.Name || 'quote').replace(/[^a-z0-9-_]+/gi, '-')}.pdf`;

    const totals = calculateQuoteTotals({
      lineItems: combined.lineItems.map((li) => ({ quantity: li.Quantity, unitPrice: li.UnitPrice, discount: li.Discount })),
      discount: combined.quote.Discount,
      tax: combined.quote.Tax,
      shippingHandling: combined.quote.ShippingHandling,
    });

    try {
      await sendQuotePdfEmail({
        to,
        recipientName,
        senderName: req.user.name,
        quoteName: combined.quote.Name,
        quoteNumber: combined.quote.QuoteNumber,
        accountName: combined.quote.Opportunity?.Account?.Name,
        grandTotal: totals.grandTotal,
        pdfBuffer,
        pdfFilename,
      });
    } catch (sendError) {
      NotificationService.notify(req.user._id.toString(), 'notification.email_failed', {
        title: 'Quote email failed to send',
        message: `We couldn't email the quote to ${to}. ${sendError.message}`,
        resourceId: id,
      });

      await AuditLogger.log('NOTIFY', {
        userId: req.user._id,
        resourceType: 'Quote',
        resourceId: id,
        changes: { channel: 'email', to },
        status: 'failure',
        errorMessage: sendError.message,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      }).catch(() => {});

      return res.status(502).json({ success: false, message: `Failed to send quote email: ${sendError.message}` });
    }

    await recordActivity(req, {
      action: 'NOTIFY',
      eventType: 'quote.emailed',
      resourceId: id,
      changes: { to },
      title: 'Quote emailed',
      message: `Quote "${combined.quote.Name}" was emailed to ${to}`,
    });

    res.status(200).json({ success: true, message: `Quote emailed to ${to}` });
  } catch (error) {
    console.error('Error emailing quote PDF:', error);
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  getQuoteStatuses,
  getProductCatalog,
  getQuotes,
  getQuoteById,
  createQuote,
  updateQuote,
  deleteQuote,
  saveQuoteLineItems,
  getQuotePdfLink,
  emailQuotePdf,
};
