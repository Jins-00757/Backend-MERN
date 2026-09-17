
import SalesforceService from '../services/salesforceService.js';
import AuditLogger from '../services/AuditLogger.js';
import { loadQuoteWithLineItems } from './quotesController.js';
import {
  draftQuoteFollowUpEmail,
  assessQuoteRisk,
  summarizeAccountActivity,
  generateOpportunityExecSummary,
  draftDiscountJustification,
  parseNaturalLanguageSearch,
} from '../services/groqService.js';

// Matches the stage list AdvancedSearch.jsx's dropdown hardcodes - keep the
// two in sync if that list ever changes. Duplicated rather than imported
// since the frontend list lives in a component file, not a shared constant.
const SEARCH_STAGES = ['Prospecting', 'Qualification', 'Proposal/Price Quote', 'Closed Won'];

/**
 * Every action here is a read/generate action, never a data mutation - none
 * of them write to Salesforce or Mongo, so they all log as 'READ'. Only
 * usage metadata is recorded (resource id/type, which action ran), never the
 * generated content itself - same data-minimization stance as the chat
 * widget (see chatbotController.js).
 */
const auditAiAction = (req, { resourceType, resourceId, eventType, status = 'success', errorMessage }) =>
  AuditLogger.log('READ', {
    userId: req.user._id,
    resourceType,
    resourceId,
    eventType,
    status,
    errorMessage,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  }).catch((err) => console.error(`Failed to audit-log ${eventType}:`, err.message));

// Errors reaching here come from two sources with different status
// conventions: SalesforceService/SearchService throw plain Errors with a
// `.status` property (see salesforceService.js's soqlEscape-adjacent
// helpers), while groqService throws AppError with `.statusCode`. Checking
// both keeps e.g. a real 404 "Quote not found" from Salesforce from being
// flattened into a generic 500, matching how every other controller in this
// codebase (quotesController, accountsController, etc.) already responds.
const sendError = (res, error) => {
  const statusCode = error.statusCode || error.status || 500;
  res.status(statusCode).json({ success: false, message: error.message });
};

/**
 * @route   POST /api/ai/quotes/:id/draft-email
 * @desc    Draft a customer follow-up email grounded in this quote's real
 *          line items/totals, fetched server-side from Salesforce (never
 *          trusting client-supplied quote content). Draft-only: nothing here
 *          sends anything - the existing "Email PDF" flow with its own
 *          recipient allowlist still owns actually emailing a customer.
 * @access  Private
 */
export const draftQuoteEmail = async (req, res) => {
  const { id } = req.params;
  try {
    const salesforce = new SalesforceService(req.user);
    const combined = await loadQuoteWithLineItems(salesforce, id);

    if (!combined) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    const { quote, lineItems } = combined;
    const raw = await draftQuoteFollowUpEmail({
      quoteName: quote.Name,
      accountName: quote.Opportunity?.Account?.Name,
      opportunityName: quote.Opportunity?.Name,
      status: quote.Status,
      grandTotal: quote.GrandTotal,
      expirationDate: quote.ExpirationDate,
      lineItems: lineItems.map((li) => ({
        name: li.Product2?.Name || 'Item',
        quantity: li.Quantity,
        discount: li.Discount,
      })),
    });

    // The model is asked for a "Subject:" line up front - split it out here
    // so the frontend gets a clean {subject, body} pair rather than having
    // to parse free text itself.
    const subjectMatch = raw.match(/^Subject:\s*(.+)$/im);
    const subject = subjectMatch ? subjectMatch[1].trim() : `Following up on ${quote.Name}`;
    const body = subjectMatch ? raw.slice(subjectMatch.index + subjectMatch[0].length).trim() : raw.trim();

    auditAiAction(req, { resourceType: 'Quote', resourceId: id, eventType: 'quote.ai_email_drafted' });

    res.status(200).json({ success: true, data: { subject, body } });
  } catch (error) {
    console.error('Error drafting quote email:', error);
    auditAiAction(req, { resourceType: 'Quote', resourceId: id, eventType: 'quote.ai_email_drafted', status: 'failure', errorMessage: error.message });
    sendError(res, error);
  }
};

/**
 * @route   POST /api/ai/quotes/:id/risk
 * @desc    Red/amber/green risk badge for a quote, computed by Groq from
 *          this quote's real metrics (discount depth, days to expiration,
 *          whether terms/description are noted) - fetched server-side, never
 *          trusted from the client.
 * @access  Private
 */
export const getQuoteRisk = async (req, res) => {
  const { id } = req.params;
  try {
    const salesforce = new SalesforceService(req.user);
    const combined = await loadQuoteWithLineItems(salesforce, id);

    if (!combined) {
      return res.status(404).json({ success: false, message: 'Quote not found' });
    }

    const { quote, lineItems } = combined;
    const lineDiscounts = lineItems.map((li) => Number(li.Discount) || 0);
    const maxLineDiscount = lineDiscounts.length > 0 ? Math.max(...lineDiscounts) : 0;
    const discountPercent = Math.max(Number(quote.Discount) || 0, maxLineDiscount);

    let daysUntilExpiration = null;
    if (quote.ExpirationDate) {
      const diffMs = new Date(quote.ExpirationDate).getTime() - Date.now();
      daysUntilExpiration = Math.round(diffMs / (1000 * 60 * 60 * 24));
    }

    const result = await assessQuoteRisk({
      quoteName: quote.Name,
      grandTotal: quote.GrandTotal,
      discountPercent,
      daysUntilExpiration,
      hasDescription: Boolean(quote.Description && quote.Description.trim()),
      status: quote.Status,
    });

    auditAiAction(req, { resourceType: 'Quote', resourceId: id, eventType: 'quote.ai_risk_checked' });

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error assessing quote risk:', error);
    auditAiAction(req, { resourceType: 'Quote', resourceId: id, eventType: 'quote.ai_risk_checked', status: 'failure', errorMessage: error.message });
    sendError(res, error);
  }
};

/**
 * @route   POST /api/ai/accounts/:id/activity-summary
 * @desc    3-bullet summary of an account's own audit trail plus its current
 *          open opportunities, both fetched server-side.
 * @access  Private
 */
export const getAccountActivitySummary = async (req, res) => {
  const { id } = req.params;
  try {
    const salesforce = new SalesforceService(req.user);
    const [{ account, opportunities }, events] = await Promise.all([
      salesforce.getAccountWithOpportunities(id),
      AuditLogger.getChangeSummary(id, 'Account'),
    ]);

    const bullets = await summarizeAccountActivity({
      accountName: account.Name,
      events,
      opportunities,
    });

    auditAiAction(req, { resourceType: 'Account', resourceId: id, eventType: 'account.ai_activity_summarized' });

    res.status(200).json({ success: true, data: { bullets } });
  } catch (error) {
    console.error('Error summarizing account activity:', error);
    auditAiAction(req, { resourceType: 'Account', resourceId: id, eventType: 'account.ai_activity_summarized', status: 'failure', errorMessage: error.message });
    // getAccountWithOpportunities throws a plain "Account not found" Error
    // with no .status for a missing record - surface that as 404 rather
    // than falling through sendError's 500 default.
    if (error.message === 'Account not found') {
      return res.status(404).json({ success: false, message: error.message });
    }
    sendError(res, error);
  }
};

/**
 * @route   POST /api/ai/opportunities/exec-summary
 * @desc    2-3 sentence executive summary generated from the rep's own
 *          in-progress (not-yet-saved) opportunity notes. `notes` is the
 *          user's own draft text, not someone else's stored data, so it's
 *          accepted from the request body rather than re-fetched.
 * @access  Private
 */
export const generateExecSummary = async (req, res) => {
  const { opportunityId, opportunityName, accountName, stage, amount, notes } = req.body;

  if (typeof notes !== 'string' || !notes.trim()) {
    return res.status(400).json({ success: false, message: 'notes is required' });
  }
  if (notes.length > 5000) {
    return res.status(400).json({ success: false, message: 'notes must be 5000 characters or fewer' });
  }

  try {
    const summary = await generateOpportunityExecSummary({ opportunityName, accountName, stage, amount, notes });

    auditAiAction(req, { resourceType: 'Opportunity', resourceId: opportunityId || null, eventType: 'opportunity.ai_exec_summary' });

    res.status(200).json({ success: true, data: { summary } });
  } catch (error) {
    console.error('Error generating opportunity exec summary:', error);
    auditAiAction(req, { resourceType: 'Opportunity', resourceId: opportunityId || null, eventType: 'opportunity.ai_exec_summary', status: 'failure', errorMessage: error.message });
    sendError(res, error);
  }
};

/**
 * @route   POST /api/ai/quotes/discount-justification
 * @desc    Draft-only: generates justification text for an above-threshold
 *          discount. Persisting/notifying the manager is a separate,
 *          explicit step - see quotesController.submitDiscountJustification.
 * @access  Private
 */
export const draftQuoteDiscountJustification = async (req, res) => {
  const { quoteId, quoteName, accountName, grandTotal, discountPercent, isLineLevel } = req.body;

  if (!quoteName) {
    return res.status(400).json({ success: false, message: 'quoteName is required' });
  }
  const parsedDiscount = Number(discountPercent);
  if (!Number.isFinite(parsedDiscount) || parsedDiscount < 0 || parsedDiscount > 100) {
    return res.status(400).json({ success: false, message: 'discountPercent must be a number between 0 and 100' });
  }

  try {
    const text = await draftDiscountJustification({
      quoteName,
      accountName,
      grandTotal,
      discountPercent: parsedDiscount,
      isLineLevel: Boolean(isLineLevel),
    });

    auditAiAction(req, { resourceType: 'Quote', resourceId: quoteId || null, eventType: 'quote.ai_discount_justification_drafted' });

    res.status(200).json({ success: true, data: { text } });
  } catch (error) {
    console.error('Error drafting discount justification:', error);
    auditAiAction(req, { resourceType: 'Quote', resourceId: quoteId || null, eventType: 'quote.ai_discount_justification_drafted', status: 'failure', errorMessage: error.message });
    sendError(res, error);
  }
};

/**
 * @route   POST /api/ai/search/parse-query
 * @desc    Parses a natural-language search request into the exact filter
 *          shape SearchService.search() already accepts (see
 *          groqService.parseNaturalLanguageSearch for the validation this
 *          re-applies). Returns the parsed filters only - the frontend fills
 *          them into the real filter controls and runs the existing
 *          GET /search/opportunities itself; this endpoint never executes a
 *          search or touches Salesforce.
 * @access  Private
 */
export const parseSearchQuery = async (req, res) => {
  const { query } = req.body;

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ success: false, message: 'query is required' });
  }
  if (query.length > 300) {
    return res.status(400).json({ success: false, message: 'query must be 300 characters or fewer' });
  }

  try {
    const filters = await parseNaturalLanguageSearch({ naturalLanguageQuery: query, availableStages: SEARCH_STAGES });

    auditAiAction(req, { resourceType: 'Search', resourceId: null, eventType: 'search.ai_query_parsed' });

    res.status(200).json({ success: true, data: { filters } });
  } catch (error) {
    console.error('Error parsing natural-language search query:', error);
    auditAiAction(req, { resourceType: 'Search', resourceId: null, eventType: 'search.ai_query_parsed', status: 'failure', errorMessage: error.message });
    sendError(res, error);
  }
};
