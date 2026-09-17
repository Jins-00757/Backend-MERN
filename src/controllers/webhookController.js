
import Quote from '../models/Quote.js';
import User from '../models/User.js';
import SyncLog from '../models/SyncLog.js';
import SalesforceService from '../services/salesforceService.js';
import AuditLogger from '../services/AuditLogger.js';
import NotificationService from '../services/NotificationService.js';
import { calculateCommission, DEFAULT_COMMISSION_RATE } from '../utils/commissionCalculations.js';

const formatUsd = (amount) =>
  `$${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/**
 * @route   POST /api/webhooks/salesforce
 * @desc    Inbound endpoint for Salesforce-side changes this app didn't
 *          initiate - specifically an Opportunity being closed directly in
 *          Salesforce (e.g. an Account Executive working the record
 *          natively, not through this app's UI). Nothing in this codebase
 *          calls Salesforce -> here on its own; the org side is expected to
 *          be wired up with a Record-Triggered Flow (or Apex trigger) on
 *          Opportunity, filtered to IsClosed = true, doing an outbound HTTP
 *          callout to this URL with the JSON body documented below, signed
 *          per middleware/salesforceWebhook.js.
 *
 *          Expected body:
 *            {
 *              opportunityId: string (required, Salesforce Id),
 *              opportunityName?: string,
 *              accountName?: string,
 *              stageName?: string,
 *              isWon: boolean (required),
 *              isClosed: boolean (required),
 *              amount?: number,
 *              closeDate?: string (YYYY-MM-DD)
 *            }
 *
 *          Every Quote this app has sent (see quotesController.createQuote)
 *          is locked to both the Opportunity it was built against and the
 *          user who sent it - that link is how this handler knows *which*
 *          of potentially many connected users' dashboards to push the
 *          live "deal won" update to, something the Salesforce payload
 *          itself has no way to carry (it only knows about the org, not
 *          this app's per-user sessions).
 * @access  Public (HMAC-signed, see verifySalesforceWebhookSignature)
 */
export const handleSalesforceOpportunityWebhook = async (req, res) => {
  const { opportunityId, opportunityName, accountName, stageName, isWon, isClosed, amount, closeDate } =
    req.body || {};

  if (!opportunityId || typeof isWon !== 'boolean' || typeof isClosed !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'opportunityId, isWon, and isClosed are required',
    });
  }

  if (!isClosed) {
    // Only a genuine close (won or lost) drives the quote status sync and
    // live dashboard push below - an in-flight stage change is Salesforce's
    // to own, and already covered by this app's own UI-driven updates when
    // a user makes the change from inside the app.
    return res.status(200).json({ success: true, message: 'Ignored - opportunity is not closed' });
  }

  try {
    const quote = await Quote.findOne({ opportunityId, status: 'Sent' }).sort({ createdAt: -1 });

    if (!quote) {
      return res.status(200).json({
        success: true,
        message: 'No pending quote found for this opportunity - nothing to sync',
      });
    }

    const user = await User.findById(quote.userId);
    if (!user) {
      console.error(`Salesforce webhook: quote ${quote._id} references a user that no longer exists`);
      return res.status(200).json({ success: true, message: 'Quote owner no longer exists' });
    }

    // Prefer Salesforce's own live GrandTotal over the payload's `amount`
    // (the Opportunity's Amount field, which can differ from the quote's
    // actual priced total once discount/tax/shipping are applied) - fall
    // back to the payload if the user's Salesforce connection can't be
    // reached right now (e.g. a lapsed refresh token), so the deal still
    // gets marked closed instead of the whole webhook failing.
    let grandTotal = Number(amount) || 0;
    try {
      const salesforce = new SalesforceService(user);
      const quoteResult = await salesforce.getQuoteById(quote.salesforceQuoteId);
      if (quoteResult.records.length > 0 && quoteResult.records[0].GrandTotal != null) {
        grandTotal = quoteResult.records[0].GrandTotal;
      }
    } catch (sfError) {
      console.error(
        `Salesforce webhook: could not fetch live GrandTotal for quote ${quote.salesforceQuoteId}, falling back to payload amount:`,
        sfError.message
      );
    }

    const commissionRate = Number.isFinite(user.commissionRate) ? user.commissionRate : DEFAULT_COMMISSION_RATE;
    const commissionAmount = isWon ? calculateCommission(grandTotal, commissionRate) : 0;

    quote.status = isWon ? 'Closed Won' : 'Closed Lost';
    quote.closedAt = closeDate ? new Date(closeDate) : new Date();
    quote.grandTotalAtClose = grandTotal;
    quote.commissionRate = commissionRate;
    quote.commissionAmount = commissionAmount;
    await quote.save();

    const dealName = opportunityName || quote.opportunityName || quote.name;
    const eventType = isWon ? 'deal.won' : 'deal.lost';
    const title = isWon ? '🎉 Deal Won!' : 'Deal closed lost';
    const message = isWon
      ? `${dealName}${accountName ? ` (${accountName})` : ''} closed as Won - ${formatUsd(grandTotal)}${
          commissionAmount ? `, ${formatUsd(commissionAmount)} commission` : ''
        }`
      : `${dealName}${accountName ? ` (${accountName})` : ''} closed as Lost`;

    NotificationService.notify(quote.userId.toString(), eventType, {
      title,
      message,
      resourceId: opportunityId,
      changes: {
        dealName,
        accountName,
        stageName,
        quoteId: quote.salesforceQuoteId,
        grandTotal,
        commissionRate,
        commissionAmount,
      },
    });

    await AuditLogger.log('UPDATE', {
      userId: quote.userId,
      resourceType: 'Quote',
      resourceId: quote.salesforceQuoteId,
      eventType,
      title,
      message,
      changes: { opportunityId, isWon, grandTotal, commissionAmount },
    });

    await SyncLog.create({
      userId: quote.userId,
      syncType: 'automatic',
      status: 'completed',
      recordsProcessed: 1,
      recordsUpdated: 1,
      startedAt: new Date(),
      completedAt: new Date(),
      notes: `Salesforce webhook: Opportunity ${opportunityId} closed ${isWon ? 'won' : 'lost'}, quote ${quote.salesforceQuoteId} synced`,
    }).catch((err) => console.error('Failed to write SyncLog for Salesforce webhook:', err.message));

    return res.status(200).json({ success: true, message: 'Quote synced' });
  } catch (error) {
    console.error('Error processing Salesforce webhook:', error);
    return res.status(500).json({ success: false, message: 'Failed to process webhook' });
  }
};

export default { handleSalesforceOpportunityWebhook };
