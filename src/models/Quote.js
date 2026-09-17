
import mongoose from 'mongoose';

/**
 * Quote - a local, lightweight record of a quote this app sent to
 * Salesforce (see quotesController.createQuote), created the moment the
 * Salesforce Quote/QuoteLineItems are successfully created there. Salesforce
 * remains the source of truth for the quote's own fields (line items,
 * pricing, header) - this record exists purely to "lock the relationship"
 * between (Salesforce QuoteId, Salesforce OpportunityId, the app user who
 * sent it), which is exactly what the inbound Salesforce webhook needs
 * (see webhookController.js) to know *whose* live dashboard to push a
 * real-time update to when that Opportunity is later closed directly in
 * Salesforce - a plain Salesforce webhook payload has no notion of this
 * app's per-user sessions on its own.
 */
const quoteSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    salesforceQuoteId: {
      type: String,
      required: true,
      index: true,
    },
    opportunityId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    opportunityName: String,
    accountName: String,
    status: {
      type: String,
      enum: ['Sent', 'Closed Won', 'Closed Lost'],
      default: 'Sent',
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    closedAt: Date,
    // Salesforce's own GrandTotal for this quote as of the moment the
    // linked Opportunity closed - captured by the webhook rather than kept
    // in sync continuously, since it only matters once, at close time.
    grandTotalAtClose: Number,
    commissionRate: Number,
    commissionAmount: Number,
    // Set by POST /quotes/:id/discount-justification (see
    // quotesController.submitDiscountJustification) when a rep requests
    // manager approval for an above-threshold discount. `text` may start
    // from an AI-drafted note (aiActionsController.draftDiscountJustification)
    // but is always what the rep actually submitted, edited or not.
    discountJustification: {
      text: String,
      discountPercent: Number,
      submittedAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

quoteSchema.index({ opportunityId: 1, status: 1 });

export default mongoose.model('Quote', quoteSchema);
