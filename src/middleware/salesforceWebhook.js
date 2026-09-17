
import crypto from 'crypto';
import { config } from '../config/env.js';

/**
 * Verifies the inbound Salesforce webhook's HMAC-SHA256 signature before
 * webhookController.handleSalesforceOpportunityWebhook ever runs - this
 * endpoint has no auth cookie/JWT to check (Salesforce, not a logged-in
 * browser, is calling it), so the signature is the only thing standing
 * between it and anyone on the internet POSTing a fake "deal closed won"
 * event.
 *
 * Expects the sender (a Salesforce Flow/Apex outbound callout, or a
 * middle-tier bridging Salesforce to this endpoint) to sign the exact raw
 * request body with SALESFORCE_WEBHOOK_SECRET and send it as
 * `X-Signature-256: sha256=<hex>`. Relies on app.js registering a
 * path-scoped `express.json({ verify })` for '/api/webhooks' ahead of the
 * general body parser, which stashes the raw bytes on `req.rawBody` -
 * signing has to happen over those exact bytes, not a re-serialized copy of
 * `req.body`, since JSON re-serialization isn't guaranteed to be byte-identical
 * (key order, whitespace) to what was actually signed.
 */
export const verifySalesforceWebhookSignature = (req, res, next) => {
  if (!config.salesforceWebhookSecret) {
    console.error('SALESFORCE_WEBHOOK_SECRET is not configured - rejecting inbound Salesforce webhook');
    return res.status(503).json({ success: false, message: 'Webhook receiver is not configured' });
  }

  const signatureHeader = req.get('x-signature-256') || req.get('x-signature');
  if (!signatureHeader || !req.rawBody) {
    return res.status(401).json({ success: false, message: 'Missing webhook signature' });
  }

  const provided = signatureHeader.replace(/^sha256=/, '').trim();
  const expected = crypto
    .createHmac('sha256', config.salesforceWebhookSecret)
    .update(req.rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');

  const isValid =
    expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!isValid) {
    return res.status(401).json({ success: false, message: 'Invalid webhook signature' });
  }

  next();
};
