
import jsforce from 'jsforce';
import User from '../models/User.js';
import { config } from '../config/env.js';
import { encryptToken, decryptFieldAudited } from './encryptionService.js';

/**
 * The one place in this app that talks to Salesforce through jsforce rather
 * than the existing axios-based SalesforceService (salesforceService.js) -
 * reserved for actions the AI assistant proposes and the user explicitly
 * confirms (see aiToolsService.js). Every other feature (opportunities,
 * accounts, contacts, leads, contracts, quotes CRUD, bulk ops, exports, the
 * chat widget's own read-only lookups, etc.) keeps using SalesforceService
 * unchanged - this file only adds a second, narrowly-scoped client on top of
 * the same already-stored OAuth tokens, it doesn't replace anything.
 */

const decryptUserToken = (user, encrypted, fieldName) => {
  if (!encrypted) return null;
  return decryptFieldAudited(encrypted, {
    userId: user._id,
    resourceType: 'User',
    resourceId: user._id,
    fieldName,
  });
};

/**
 * Builds a jsforce Connection from this user's already-connected Salesforce
 * account. Mirrors SalesforceService's constructor guard (fails clearly if
 * the user never went through Salesforce OAuth) and its refresh-token
 * handling (this org rotates the refresh token on every use - see the
 * identical note in salesforceService.js's refreshAccessToken - so whatever
 * jsforce hands back on its own 'refresh' event must be persisted, not just
 * the new access token).
 */
export const getJsforceConnection = (user) => {
  if (!user.isSalesforceConnected || !user.salesforceInstanceUrl) {
    const err = new Error('Salesforce account not connected');
    err.status = 400;
    throw err;
  }

  const accessToken = decryptUserToken(user, user.salesforceAccessToken, 'salesforceAccessToken');
  const refreshToken = decryptUserToken(user, user.salesforceRefreshToken, 'salesforceRefreshToken');

  const conn = new jsforce.Connection({
    instanceUrl: user.salesforceInstanceUrl,
    accessToken,
    refreshToken,
    version: '59.0',
    oauth2: new jsforce.OAuth2({
      clientId: config.salesforceClientId,
      clientSecret: config.salesforceClientSecret,
      redirectUri: config.salesforceRedirectUri,
    }),
  });

  // jsforce refreshes automatically on a 401 and emits this once it does -
  // persist the result so the next call (through this connection or the
  // axios-based SalesforceService) uses the current token rather than
  // immediately hitting the same expired one.
  conn.on('refresh', (newAccessToken, res) => {
    User.findByIdAndUpdate(user._id, {
      salesforceAccessToken: encryptToken(newAccessToken),
      ...(res?.refresh_token ? { salesforceRefreshToken: encryptToken(res.refresh_token) } : {}),
    }).catch((err) => console.error('Failed to persist refreshed Salesforce token from jsforce:', err.message));
  });

  return conn;
};

/**
 * approveQuoteAndSyncToSalesforce - retrieves the quote first so a bad or
 * hallucinated quoteId (this is ultimately called off an AI tool call, via
 * aiToolsService.confirmPendingAction) fails with a clear 404 rather than a
 * confusing Salesforce error, then writes the new Status directly.
 */
export const approveQuoteAndSyncToSalesforce = async (user, { quoteId, status }) => {
  const conn = getJsforceConnection(user);

  let existing;
  try {
    existing = await conn.sobject('Quote').retrieve(quoteId);
  } catch (error) {
    if (error.errorCode === 'NOT_FOUND' || error.name === 'NOT_FOUND') {
      const err = new Error('Quote not found in Salesforce');
      err.status = 404;
      throw err;
    }
    throw error;
  }

  const result = await conn.sobject('Quote').update({ Id: quoteId, Status: status });

  if (!result.success) {
    const err = new Error(result.errors?.[0]?.message || 'Salesforce rejected the quote status update');
    err.status = 400;
    throw err;
  }

  return { quoteId, previousStatus: existing.Status, newStatus: status };
};
