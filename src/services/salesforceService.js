

import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { Parser as CsvParser } from '@json2csv/plainjs';
import User from '../models/User.js';
import { encryptToken, decryptFieldAudited } from './encryptionService.js';

const xmlParser = new XMLParser({ removeNSPrefix: true });

/**
 * Escape a value for safe interpolation inside SOAP XML (leadId/status
 * strings sent to convertLead below) - SOAP has no bind parameters either,
 * so user-influenced values (a custom Lead Status label, in particular)
 * must be entity-escaped or a value containing `<`/`&` would corrupt the
 * envelope.
 */
const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * Escape a value for safe interpolation inside a single-quoted SOQL string
 * literal (SOQL has no query parameters, so this is the standard mitigation
 * Salesforce recommends against SOQL injection: escape backslashes first,
 * then single quotes).
 */
export const soqlEscape = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * A plain `YYYY-MM-DD` date, as produced by an HTML `<input type="date">` -
 * used to validate exportObjectRecords()'s dateFrom/dateTo filters below
 * before they're interpolated into SOQL. Unlike soqlEscape() (for *string*
 * literals), a SOQL date literal takes no quotes at all, so escaping isn't
 * the right defense here - only a value that provably matches this exact
 * shape is safe to splice in unescaped.
 */
const isPlainDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Field lists for the Bulk Operations page's "Export Data" tab - one curated,
 * hardcoded SELECT per object rather than accepting field names from the
 * client, which would otherwise be the one place in this service where a
 * SOQL field/object name comes from user input instead of a fixed string
 * this codebase wrote. `searchField` is optional and used for the export
 * form's free-text search box.
 */
export const EXPORT_OBJECT_CONFIG = {
  Account: {
    fields: ['Id', 'Name', 'BillingStreet', 'BillingCity', 'BillingState', 'BillingPostalCode', 'BillingCountry', 'Industry', 'AnnualRevenue', 'Phone', 'Website', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'Name',
  },
  Contact: {
    fields: ['Id', 'FirstName', 'LastName', 'Email', 'Phone', 'Title', 'Department', 'AccountId', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'LastName',
  },
  Lead: {
    fields: ['Id', 'FirstName', 'LastName', 'Company', 'Title', 'Email', 'Phone', 'Status', 'Rating', 'LeadSource', 'Industry', 'AnnualRevenue', 'IsConverted', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'Company',
  },
  Opportunity: {
    fields: ['Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'Probability', 'AccountId', 'OwnerId', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'Name',
  },
  Contract: {
    fields: ['Id', 'ContractNumber', 'AccountId', 'Status', 'StartDate', 'EndDate', 'ContractTerm', 'CreatedDate', 'LastModifiedDate'],
    searchField: null,
  },
  Quote: {
    fields: ['Id', 'Name', 'QuoteNumber', 'OpportunityId', 'Status', 'ExpirationDate', 'Subtotal', 'Discount', 'Tax', 'ShippingHandling', 'GrandTotal', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'Name',
  },
  Task: {
    fields: ['Id', 'Subject', 'Status', 'Priority', 'ActivityDate', 'WhatId', 'WhoId', 'OwnerId', 'CreatedDate', 'LastModifiedDate'],
    searchField: 'Subject',
  },
};

/**
 * SalesforceService - Handles all Salesforce API interactions
 * Implements retry logic, token refresh, and error handling
 */
class SalesforceService {
  constructor(user) {
    // Guard here rather than in every caller: accountsController,
    // contactsController, opportunitiesController and bulkOperationsController
    // all construct this directly from req.user with no connection check, so
    // without this an unconnected user's first request would build requests
    // against `${undefined}/services/data/...` and fail with a confusing
    // "Invalid URL" instead of a clear, actionable message.
    if (!user.isSalesforceConnected || !user.salesforceInstanceUrl) {
      const err = new Error('Salesforce account not connected');
      err.status = 400;
      throw err;
    }

    this.user = user;
    this.instanceUrl = user.salesforceInstanceUrl;
    this.accessToken = this.decryptToken(user.salesforceAccessToken, 'salesforceAccessToken');
    // BUG FIX: this was previously left as the raw stored value, which is
    // encrypted ciphertext (see salesforce.controller.js's OAuth callback,
    // which always calls encryptToken() before saving it) - refreshAccessToken()
    // below sends this straight to Salesforce's /oauth2/token endpoint, so
    // an undecrypted refresh token would have made every token refresh fail
    // with an invalid_grant error the moment the access token expired.
    this.refreshToken = this.decryptToken(user.salesforceRefreshToken, 'salesforceRefreshToken');
    this.tokenExpiresAt = user.salesforceTokenExpiresAt;
    this.apiVersion = 'v59.0';
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * Decrypt a stored OAuth token field, auditing the access (userId,
   * resourceId, and which field - salesforceAccessToken vs
   * salesforceRefreshToken - were decrypted) via
   * encryptionService.js's decryptFieldAudited.
   */
  decryptToken(encryptedToken, fieldName) {
    if (!encryptedToken) return null;

    try {
      return decryptFieldAudited(encryptedToken, {
        userId: this.user._id,
        resourceType: 'User',
        resourceId: this.user._id,
        fieldName,
      });
    } catch (error) {
      console.error('Token decryption error:', error);
      return null;
    }
  }

  /**
   * Proactively refresh only when we actually know the token is near
   * expiry. `tokenExpiresAt` is almost always unset in practice - Salesforce
   * never returns `expires_in` from its OAuth token endpoint (see
   * refreshAccessToken()), so there is usually nothing to proactively check
   * here. That's expected, not a bug: the real defense against a stale
   * access token is the reactive refresh-and-retry-once in request() below,
   * which refreshes only when Salesforce actually responds 401 - the one
   * signal we can trust, since we can't predict expiry ourselves.
   */
  async ensureValidToken() {
    if (!this.tokenExpiresAt) return;

    const expirationBuffer = 5 * 60 * 1000; // 5 minutes
    const isNearExpiry = Date.now() > this.tokenExpiresAt.getTime() - expirationBuffer;

    if (isNearExpiry) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Refresh access token using refresh token.
   *
   * BUG FIX: Salesforce's OAuth token endpoint (like every RFC 6749 token
   * endpoint) requires `application/x-www-form-urlencoded`, not JSON - the
   * previous plain-object body was silently serialized as JSON by axios,
   * which Salesforce rejected with `400 unsupported_grant_type` on every
   * single call. Confirmed empirically against a live org: the JSON body
   * fails immediately, the form-encoded body succeeds.
   *
   * BUG FIX: Salesforce's token response also never includes `expires_in`
   * (confirmed on the same live call - the response only has access_token,
   * refresh_token, signature, scope, instance_url, id, token_type,
   * issued_at) - unlike most OAuth providers, Salesforce access token
   * lifetime is governed by the org's Session Settings, not returned here.
   * The old code computed `Date.now() + undefined * 1000` = Invalid Date
   * and stored that. Rather than fabricate an expiry we don't have, leave
   * `salesforceTokenExpiresAt` unset - staleness is instead handled
   * reactively (see request()'s 401 retry) rather than proactively.
   *
   * BUG FIX: this org's connected app rotates the refresh token on every
   * use - each refresh response's `refresh_token` supersedes the one that
   * was just spent, and the old one stops working immediately. The old
   * code only persisted the new access_token, silently discarding the
   * rotated refresh_token - so the very next refresh attempt would fail
   * with `invalid_grant: expired access/refresh token`, permanently
   * breaking the connection after exactly one refresh. Now persists
   * whichever refresh_token Salesforce returned (falling back to the
   * existing one on the - apparently rare, for this org - response that
   * omits it, rather than overwriting a working token with undefined).
   */
  async refreshAccessToken() {
    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.SALESFORCE_CLIENT_ID,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET,
        refresh_token: this.refreshToken,
      });

      const response = await axios.post(
        `${this.instanceUrl}/services/oauth2/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      this.accessToken = response.data.access_token;
      if (response.data.refresh_token) {
        this.refreshToken = response.data.refresh_token;
      }

      // Update user in database with new token(s)
      await User.findByIdAndUpdate(this.user._id, {
        salesforceAccessToken: this.encryptToken(this.accessToken),
        salesforceRefreshToken: this.encryptToken(this.refreshToken),
      });

      console.log('✅ Access token refreshed');
    } catch (error) {
      console.error('Token refresh failed:', error.message);
      throw new Error('Failed to refresh Salesforce access token');
    }
  }

  /**
 * Get sales pipeline summary
 */
async getSalesPipelineSummary() {
  // COUNT() (no argument) is the only SOQL aggregate Salesforce refuses to
  // let you alias (MALFORMED_QUERY: "unexpected token: 'COUNT()'") - see the
  // identical query in data.controller.js for the same fix.
  const soql = `SELECT StageName, COUNT(Id) recordCount, SUM(Amount) totalAmount,
                       AVG(Probability) avgProbability
                FROM Opportunity
                GROUP BY StageName
                ORDER BY StageName ASC`;

  const result = await this.query(soql);
  
  // Transform results into summary format
  const summary = {
    totalOpportunities: 0,
    totalPipelineValue: 0,
    stageBreakdown: [],
  };

  result.records.forEach((stage) => {
    summary.totalOpportunities += stage.recordCount;
    summary.totalPipelineValue += stage.totalAmount || 0;
    
    summary.stageBreakdown.push({
      stage: stage.StageName,
      count: stage.recordCount,
      totalAmount: stage.totalAmount || 0,
      avgProbability: stage.avgProbability || 0,
    });
  });

  return summary;
}

  /**
   * Make API request with retry logic
   */
  async request(
    method,
    endpoint,
    data = null,
    headers = {},
    retryCount = 0,
    hasRetriedAuth = false
  ) {
    try {
      await this.ensureValidToken();

      const url = `${this.instanceUrl}/services/data/${this.apiVersion}${endpoint}`;
      const config = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...headers,
        },
      };

      if (data && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      // Reactive refresh: since ensureValidToken() usually has no expiry to
      // check against (see its docstring), a 401 here is the one reliable
      // signal that the access token is actually stale. Refresh once and
      // retry the exact same request - if the refresh itself fails (e.g. a
      // genuinely revoked refresh token), that error propagates as-is
      // rather than masking it behind a second, confusing 401.
      if (error.response?.status === 401 && !hasRetriedAuth) {
        await this.refreshAccessToken();
        return this.request(method, endpoint, data, headers, retryCount, true);
      }

      // Retry on 429 (rate limit) or 503 (service unavailable)
      const retryable = [429, 503].includes(error.response?.status);

      if (retryable && retryCount < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, retryCount);
        console.log(
          `Retrying request (attempt ${retryCount + 1}/${this.maxRetries}) after ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.request(
          method,
          endpoint,
          data,
          headers,
          retryCount + 1,
          hasRetriedAuth
        );
      }

      throw this.handleError(error);
    }
  }

  /**
   * Handle and normalize errors
   */
  handleError(error) {
    const status = error.response?.status;
    const salesforceErrors = error.response?.data;
    const message = salesforceErrors?.[0]?.message || error.message;
    const errorCode = salesforceErrors?.[0]?.errorCode;

    // The errorMap below intentionally replaces Salesforce's own error text
    // with a generic, user-safe message (never leak raw SOQL/schema detail
    // to the client) - but that means the *real* reason is otherwise lost
    // entirely. Log it here, once, in the one place every Salesforce API
    // error already passes through, so it's still visible server-side.
    if (status) {
      console.error(`Salesforce API error (${status}) at ${error.config?.method?.toUpperCase()} ${error.config?.url}:`, JSON.stringify(salesforceErrors));
    }

    // Quotes and Products/Price Books are disabled by default in many
    // Salesforce orgs (confirmed empirically: describe() on a not-enabled
    // Quote object 404s with NOT_FOUND, and a SOQL query against it 400s
    // with INVALID_TYPE) - callers otherwise only ever see a bare "Resource
    // not found"/"Invalid request" with no hint what to actually do about
    // it. Special-case exactly these two error codes against exactly the
    // quote/product-catalog objects this feature added, so everything else
    // (a genuine validation error once the feature *is* enabled, or any
    // other object's 404/400) still gets the normal generic message below.
    if (['NOT_FOUND', 'INVALID_TYPE'].includes(errorCode)) {
      const decodedUrl = decodeURIComponent(error.config?.url || '');
      const featureGatedObjects = ['QuoteLineItem', 'Quote', 'PricebookEntry', 'Pricebook2', 'Product2'];
      const mentionsFeatureGatedObject = featureGatedObjects.some(
        (obj) => decodedUrl.includes(`/sobjects/${obj}`) || new RegExp(`FROM\\s+${obj}\\b`, 'i').test(decodedUrl)
      );

      if (mentionsFeatureGatedObject) {
        const err = new Error(
          'Quotes, Products, or Price Books are not enabled in this Salesforce org yet. In Salesforce Setup, search for "Quote Settings" and turn quotes on, and confirm Products & Price Books are active with at least one active product on the Standard Price Book, then try again.'
        );
        err.status = 400;
        return err;
      }
    }

    const errorMap = {
      400: 'Invalid request',
      401: 'Unauthorized - token may have expired',
      403: 'Forbidden - insufficient permissions',
      404: 'Resource not found',
      429: 'Rate limit exceeded - please try again later',
      500: 'Salesforce server error',
      503: 'Salesforce service unavailable',
    };

    const errorMessage = errorMap[status] || message;
    const err = new Error(errorMessage);
    err.status = status;
    err.salesforceError = error.response?.data;
    
    return err;
  }

  /**
   * Encrypt token before storing
   */
  encryptToken(token) {
    return encryptToken(token);
  }

  // ========================================================================
  // SOQL QUERIES
  // ========================================================================

  /**
   * Execute SOQL query with limit and offset
   */
  async query(soql) {
    return this.request('GET', `/query?q=${encodeURIComponent(soql)}`);
  }

  /**
   * Query all records (handles pagination automatically)
   */
  async queryAll(soql) {
    const records = [];
    let query = soql;
    let done = false;

    while (!done) {
      const result = await this.query(query);
      records.push(...result.records);

      if (result.nextRecordsUrl) {
        query = result.nextRecordsUrl;
      } else {
        done = true;
      }
    }

    return records;
  }

  // ========================================================================
  // OPPORTUNITIES
  // ========================================================================

  /**
   * Get all opportunities for the org
   */
  async getOpportunities(filters = {}) {
    const {
      limit = 100,
      offset = 0,
      sortBy = 'CloseDate',
      sortOrder = 'DESC',
      stageName,
      amountMin,
      amountMax,
      accountId,
      searchTerm,
    } = filters;

    let soql = `SELECT Id, Name, StageName, Amount, CloseDate,
                       Probability, AccountId, Account.Name, OwnerId, Owner.Name, CreatedDate,
                       LastModifiedDate FROM Opportunity`;

    const whereClauses = [];

    if (stageName) {
      whereClauses.push(`StageName = '${soqlEscape(stageName)}'`);
    }

    if (amountMin) {
      whereClauses.push(`Amount >= ${amountMin}`);
    }

    if (amountMax) {
      whereClauses.push(`Amount <= ${amountMax}`);
    }

    if (accountId) {
      whereClauses.push(`AccountId = '${soqlEscape(accountId)}'`);
    }

    if (searchTerm) {
      whereClauses.push(`Name LIKE '%${soqlEscape(searchTerm)}%'`);
    }

    if (whereClauses.length > 0) {
      soql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    soql += ` ORDER BY ${sortBy} ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  /**
   * Create opportunity
   */
  async createOpportunity(opportunityData) {
    const requiredFields = ['Name', 'StageName', 'CloseDate', 'AccountId'];
    for (const field of requiredFields) {
      if (!opportunityData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return this.request(
      'POST',
      '/sobjects/Opportunity',
      opportunityData
    );
  }

  /**
   * Update opportunity
   */
  async updateOpportunity(opportunityId, updates) {
    return this.request(
      'PATCH',
      `/sobjects/Opportunity/${opportunityId}`,
      updates
    );
  }

  /**
   * Close opportunity
   */
  async closeOpportunity(opportunityId, isClosed = true, isWon = true) {
    return this.updateOpportunity(opportunityId, {
      IsClosed: isClosed,
      IsWon: isWon,
      StageName: isWon ? 'Closed Won' : 'Closed Lost',
    });
  }

  /**
   * Delete opportunity
   */
  async deleteOpportunity(opportunityId) {
    return this.request('DELETE', `/sobjects/Opportunity/${opportunityId}`);
  }

  // ========================================================================
  // ACCOUNTS
  // ========================================================================

  /**
   * Get all accounts
   */
  async getAccounts(filters = {}) {
    const { limit = 100, offset = 0, searchTerm } = filters;

    let soql = `SELECT Id, Name, BillingStreet, BillingCity, BillingState,
                       BillingPostalCode, BillingCountry,
                       Industry, AnnualRevenue, Phone, Website,
                       CreatedDate FROM Account`;

    if (searchTerm) {
      soql += ` WHERE Name LIKE '%${soqlEscape(searchTerm)}%'`;
    }

    soql += ` ORDER BY Name ASC LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  /**
   * Per-account opportunity count + total pipeline value, in one grouped
   * query instead of N per-account queries - used by the accounts map
   * (mapController.js) to annotate each pin without an N+1 fetch.
   */
  async getOpportunityTotalsByAccountIds(accountIds) {
    if (!accountIds || accountIds.length === 0) return {};

    const idList = accountIds.map((id) => `'${soqlEscape(id)}'`).join(',');
    const soql = `SELECT AccountId, COUNT(Id) oppCount, SUM(Amount) totalAmount
                  FROM Opportunity
                  WHERE AccountId IN (${idList})
                  GROUP BY AccountId`;

    const result = await this.query(soql);

    const totalsByAccountId = {};
    for (const record of result.records) {
      totalsByAccountId[record.AccountId] = {
        opportunityCount: record.oppCount,
        pipelineValue: record.totalAmount || 0,
      };
    }
    return totalsByAccountId;
  }

  /**
   * Get account with opportunities
   */
  async getAccountWithOpportunities(accountId) {
    const soql = `SELECT Id, Name, BillingCity, Industry, AnnualRevenue 
                  FROM Account WHERE Id = '${soqlEscape(accountId)}'`;
    const account = await this.query(soql);

    if (account.records.length === 0) {
      throw new Error('Account not found');
    }

    const oppSoql = `SELECT Id, Name, Amount, StageName, CloseDate 
                     FROM Opportunity WHERE AccountId = '${soqlEscape(accountId)}'
                     ORDER BY CloseDate DESC`;
    const opportunities = await this.query(oppSoql);

    return {
      account: account.records[0],
      opportunities: opportunities.records,
    };
  }

  /**
   * Create account
   */
  async createAccount(accountData) {
    if (!accountData.Name) {
      throw new Error('Account name is required');
    }

    return this.request('POST', '/sobjects/Account', accountData);
  }

  /**
   * Update account
   */
  async updateAccount(accountId, updates) {
    return this.request('PATCH', `/sobjects/Account/${accountId}`, updates);
  }

  // ========================================================================
  // CONTACTS
  // ========================================================================

  /**
   * Get contacts for an account
   */
  async getContacts(accountId = null, filters = {}) {
    const { limit = 100, offset = 0 } = filters;

    let soql = `SELECT Id, FirstName, LastName, Email, Phone, 
                       Title, AccountId, CreatedDate 
                FROM Contact`;

    if (accountId) {
      soql += ` WHERE AccountId = '${soqlEscape(accountId)}'`;
    }

    soql += ` ORDER BY LastName, FirstName ASC LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  /**
   * Create contact
   */
  async createContact(contactData) {
    const requiredFields = ['LastName', 'AccountId'];
    for (const field of requiredFields) {
      if (!contactData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return this.request('POST', '/sobjects/Contact', contactData);
  }

  /**
   * Update contact
   */
  async updateContact(contactId, updates) {
    return this.request('PATCH', `/sobjects/Contact/${contactId}`, updates);
  }

  // ========================================================================
  // LEADS
  // ========================================================================

  /**
   * Get leads, newest first. Every field selected here is a standard Lead
   * field (see LeadScoringService.js for why - scoring never depends on
   * custom fields this org may not have).
   */
  async getLeads(filters = {}) {
    const { limit = 100, offset = 0, status, rating, searchTerm } = filters;

    let soql = `SELECT Id, FirstName, LastName, Company, Title, Email, Phone,
                       Status, Rating, LeadSource, Industry, AnnualRevenue,
                       NumberOfEmployees, IsConverted, ConvertedOpportunityId,
                       OwnerId, Owner.Name, CreatedDate, LastModifiedDate
                FROM Lead`;

    const whereClauses = ['IsConverted = false'];

    if (status) whereClauses.push(`Status = '${soqlEscape(status)}'`);
    if (rating) whereClauses.push(`Rating = '${soqlEscape(rating)}'`);
    if (searchTerm) {
      whereClauses.push(
        `(Company LIKE '%${soqlEscape(searchTerm)}%' OR LastName LIKE '%${soqlEscape(searchTerm)}%' OR Email LIKE '%${soqlEscape(searchTerm)}%')`
      );
    }

    soql += ` WHERE ${whereClauses.join(' AND ')}`;
    soql += ` ORDER BY CreatedDate DESC LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  /**
   * The set of valid Lead Status values configured for this org, and which
   * ones Salesforce treats as "converted". Every org can customize these
   * (they're not a fixed enum), so convertLead() must never guess a status
   * string like "Closed - Converted" - it has to come from here. LeadStatus
   * is a standard, queryable Salesforce object for exactly this purpose.
   */
  async getLeadStatuses() {
    const result = await this.query(
      `SELECT MasterLabel, IsConverted, SortOrder FROM LeadStatus ORDER BY SortOrder ASC`
    );
    return result.records.map((r) => ({ label: r.MasterLabel, isConverted: r.IsConverted }));
  }

  async getLeadById(leadId) {
    const soql = `SELECT Id, FirstName, LastName, Company, Title, Email, Phone,
                         Status, Rating, LeadSource, Industry, AnnualRevenue,
                         NumberOfEmployees, Description, IsConverted,
                         ConvertedOpportunityId, ConvertedAccountId, ConvertedContactId,
                         OwnerId, Owner.Name, CreatedDate, LastModifiedDate
                  FROM Lead WHERE Id = '${soqlEscape(leadId)}'`;
    return this.query(soql);
  }

  async createLead(leadData) {
    const requiredFields = ['LastName', 'Company'];
    for (const field of requiredFields) {
      if (!leadData[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    return this.request('POST', '/sobjects/Lead', leadData);
  }

  async updateLead(leadId, updates) {
    return this.request('PATCH', `/sobjects/Lead/${leadId}`, updates);
  }

  async deleteLead(leadId) {
    return this.request('DELETE', `/sobjects/Lead/${leadId}`);
  }

  /**
   * Convert up to 200 Leads into Account + Contact (+ optionally an
   * Opportunity) pairs in a single call - Salesforce's SOAP `convertLead`
   * natively accepts a list of `leadConverts` and converts them all in one
   * round trip, returning one `<result>` per input in the same order,
   * confirmed empirically against a live org (2-lead batch: response came
   * back as an array of 2 results, each with its own leadId/success). The
   * 200 cap mirrors the limit Salesforce enforces on this and equivalent
   * SOAP list calls.
   *
   * There is no REST resource for lead conversion at all - confirmed
   * empirically across every API version a live org supports (v59-v67):
   * `/actions/standard/convertLead` returns 404 "Invalid Action Type", and
   * it appears in none of `/actions/standard`, the Lead object's
   * `/quickActions`, or `/connect/*`. It's a genuinely SOAP-only capability
   * (`core.wsdl`'s `convertLead()` call) - there is no plain `sobjects/Lead`
   * PATCH equivalent either, since the conversion system fields
   * (IsConverted, ConvertedAccountId/ContactId/OpportunityId) are read-only
   * outside Salesforce's own conversion process.
   *
   * This builds the minimal SOAP envelope by hand rather than pulling in a
   * full SOAP client library - one call, one well-documented shape - and
   * reuses the already-valid OAuth access token as the SOAP SessionId
   * (Salesforce accepts an OAuth bearer token there directly, so no
   * separate SOAP login is needed).
   *
   * @param {Array<{leadId, convertedStatus, createOpportunity, opportunityName}>} conversions
   * @returns {Promise<Array<{leadId, isSuccess, accountId, contactId, opportunityId, errors}>>}
   *   one entry per input, same order - a partial failure in the batch
   *   never throws, it's reflected per-entry so the caller can report
   *   exactly which leads did and didn't convert.
   */
  async convertLeads(conversions) {
    if (!Array.isArray(conversions) || conversions.length === 0) {
      throw new Error('At least one lead conversion request is required');
    }
    if (conversions.length > 200) {
      throw new Error('Cannot convert more than 200 leads in a single batch');
    }

    await this.ensureValidToken();

    const leadConvertsXml = conversions
      .map(({ leadId, convertedStatus, createOpportunity = true, opportunityName }) => `
      <urn:leadConverts>
        <urn:leadId>${xmlEscape(leadId)}</urn:leadId>
        <urn:convertedStatus>${xmlEscape(convertedStatus)}</urn:convertedStatus>
        <urn:doNotCreateOpportunity>${!createOpportunity}</urn:doNotCreateOpportunity>
        ${createOpportunity && opportunityName ? `<urn:opportunityName>${xmlEscape(opportunityName)}</urn:opportunityName>` : ''}
      </urn:leadConverts>`)
      .join('');

    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Header>
    <urn:SessionHeader>
      <urn:sessionId>${xmlEscape(this.accessToken)}</urn:sessionId>
    </urn:SessionHeader>
  </soapenv:Header>
  <soapenv:Body>
    <urn:convertLead>${leadConvertsXml}
    </urn:convertLead>
  </soapenv:Body>
</soapenv:Envelope>`;

    let responseXml;
    try {
      const response = await axios.post(`${this.instanceUrl}/services/Soap/u/${this.apiVersion.replace('v', '')}`, envelope, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
      });
      responseXml = response.data;
    } catch (error) {
      // A SOAP fault (bad session, malformed envelope, etc.) comes back as
      // a non-2xx with its own XML body rather than throwing through
      // handleError()'s REST-shaped error map - surface its faultstring
      // directly since that's the actual, specific reason, not a generic
      // "Invalid request".
      const faultXml = error.response?.data;
      if (typeof faultXml === 'string') {
        const parsedFault = xmlParser.parse(faultXml);
        const faultString = parsedFault?.Envelope?.Body?.Fault?.faultstring;
        if (faultString) {
          const err = new Error(`Lead conversion failed: ${faultString}`);
          err.status = error.response.status;
          throw err;
        }
      }
      throw this.handleError(error);
    }

    const parsed = xmlParser.parse(responseXml);
    const rawResult = parsed?.Envelope?.Body?.convertLeadResponse?.result;

    if (!rawResult) {
      throw new Error('Unexpected response from Salesforce while converting leads');
    }

    // fast-xml-parser only gives an array when there are 2+ sibling
    // <result> elements - a single-lead batch comes back as one bare
    // object, so normalize both shapes the same way `errors` already is
    // below.
    const results = Array.isArray(rawResult) ? rawResult : [rawResult];

    return results.map((result) => {
      const isSuccess = result.success === true || result.success === 'true';
      const rawErrors = result.errors ? (Array.isArray(result.errors) ? result.errors : [result.errors]) : [];

      return {
        leadId: result.leadId || null,
        isSuccess,
        accountId: result.accountId || null,
        contactId: result.contactId || null,
        opportunityId: result.opportunityId || null,
        errors: rawErrors.map((e) => ({ message: e.message, statusCode: e.statusCode })),
      };
    });
  }

  /**
   * Convert a single Lead - thin wrapper over convertLeads() for the
   * existing one-at-a-time call sites (leadsController.convertLead).
   */
  async convertLead(leadId, { convertedStatus, createOpportunity = true, opportunityName } = {}) {
    const [result] = await this.convertLeads([{ leadId, convertedStatus, createOpportunity, opportunityName }]);
    return result;
  }

  // ========================================================================
  // CONTRACTS
  // ========================================================================

  /**
   * Active picklist values for a standard/custom field on any sobject, via
   * the object's describe metadata. Used for Contract.Status, which - like
   * Lead.Status - is an org-configurable picklist Salesforce enforces its
   * own transition rules on (e.g. it won't let a brand-new contract skip
   * straight to "Activated"), so the valid values must come from the org
   * rather than being guessed/hardcoded here.
   */
  async getPicklistValues(sobject, fieldName) {
    const describe = await this.request('GET', `/sobjects/${sobject}/describe`);
    const field = describe.fields.find((f) => f.name === fieldName);
    if (!field) return [];
    return field.picklistValues.filter((p) => p.active).map((p) => p.value);
  }

  async getContracts(filters = {}) {
    const { limit = 100, offset = 0, accountId, status } = filters;

    let soql = `SELECT Id, ContractNumber, AccountId, Account.Name, Status,
                       StartDate, EndDate, ContractTerm, OwnerExpirationNotice,
                       Description, OwnerId, Owner.Name, CreatedDate, LastModifiedDate
                FROM Contract`;

    const whereClauses = [];
    if (accountId) whereClauses.push(`AccountId = '${soqlEscape(accountId)}'`);
    if (status) whereClauses.push(`Status = '${soqlEscape(status)}'`);
    if (whereClauses.length > 0) soql += ` WHERE ${whereClauses.join(' AND ')}`;

    soql += ` ORDER BY StartDate DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  async getContractById(contractId) {
    const soql = `SELECT Id, ContractNumber, AccountId, Account.Name, Status,
                         StartDate, EndDate, ContractTerm, OwnerExpirationNotice,
                         Description, ActivatedDate, OwnerId, Owner.Name,
                         CreatedDate, LastModifiedDate
                  FROM Contract WHERE Id = '${soqlEscape(contractId)}'`;
    return this.query(soql);
  }

  async createContract(contractData) {
    if (!contractData.AccountId) {
      throw new Error('Missing required field: AccountId');
    }

    // Contract is always created as Draft - Salesforce enforces that new
    // contracts start in Draft and only allows the (separate, restricted)
    // Activate action to move them to Activated, so any Status the caller
    // sent for a *new* contract is ignored rather than silently rejected
    // by Salesforce with a confusing error.
    const { Status, ...rest } = contractData;
    return this.request('POST', '/sobjects/Contract', rest);
  }

  async updateContract(contractId, updates) {
    return this.request('PATCH', `/sobjects/Contract/${contractId}`, updates);
  }

  // ========================================================================
  // QUOTES & PRODUCT CATALOG
  // ========================================================================

  /**
   * The org's active Standard Price Book Id. Every Quote line item is
   * priced off a PricebookEntry, and a PricebookEntry only exists against a
   * specific Pricebook2 - when an Opportunity has no Pricebook2Id of its own
   * (common until someone explicitly sets one), this is the fallback so a
   * quote can still be built. Cached on the instance since it never changes
   * within one request lifecycle and this is looked up on nearly every
   * quote/product call.
   */
  async getStandardPricebookId() {
    if (this._standardPricebookId) return this._standardPricebookId;

    const result = await this.query(
      `SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1`
    );

    if (result.records.length === 0) {
      const err = new Error(
        'No standard price book is active in this Salesforce org - enable Products/Price Books in Setup before creating quotes'
      );
      err.status = 400;
      throw err;
    }

    this._standardPricebookId = result.records[0].Id;
    return this._standardPricebookId;
  }

  /**
   * Which Pricebook2 a new Quote for this Opportunity should use: the
   * Opportunity's own Pricebook2Id when it has one (so line items stay
   * consistent with whatever the deal was already priced against), falling
   * back to the org's standard price book otherwise.
   */
  async resolveQuotePricebookId(opportunityId) {
    const result = await this.query(
      `SELECT Pricebook2Id FROM Opportunity WHERE Id = '${soqlEscape(opportunityId)}'`
    );

    if (result.records.length === 0) {
      const err = new Error('Opportunity not found');
      err.status = 404;
      throw err;
    }

    return result.records[0].Pricebook2Id || (await this.getStandardPricebookId());
  }

  /**
   * Active products available to add to a quote, priced against the given
   * price book - the picker the line item engine searches against. Joins
   * PricebookEntry -> Product2 so the result carries both the sellable
   * entry (what a QuoteLineItem actually references) and the product's
   * display name/code in one query.
   */
  async getProductCatalog(filters = {}) {
    const { pricebookId, searchTerm, limit = 50, offset = 0 } = filters;

    if (!pricebookId) {
      throw new Error('pricebookId is required to browse the product catalog');
    }

    let soql = `SELECT Id, UnitPrice, Product2Id, Product2.Name, Product2.ProductCode,
                       Product2.Description, Product2.IsActive
                FROM PricebookEntry
                WHERE Pricebook2Id = '${soqlEscape(pricebookId)}' AND IsActive = true
                      AND Product2.IsActive = true`;

    if (searchTerm) {
      soql += ` AND (Product2.Name LIKE '%${soqlEscape(searchTerm)}%' OR Product2.ProductCode LIKE '%${soqlEscape(searchTerm)}%')`;
    }

    soql += ` ORDER BY Product2.Name ASC LIMIT ${limit} OFFSET ${offset}`;

    const result = await this.query(soql);

    return result.records.map((entry) => ({
      pricebookEntryId: entry.Id,
      productId: entry.Product2Id,
      name: entry.Product2.Name,
      productCode: entry.Product2.ProductCode,
      description: entry.Product2.Description,
      listPrice: entry.UnitPrice,
    }));
  }

  /**
   * List quotes, optionally filtered by opportunity/account/status/name.
   */
  async getQuotes(filters = {}) {
    const { limit = 50, offset = 0, opportunityId, accountId, status, searchTerm } = filters;

    let soql = `SELECT Id, Name, QuoteNumber, OpportunityId, Opportunity.Name,
                       Opportunity.AccountId, Opportunity.Account.Name, Status,
                       ExpirationDate, Discount, Tax, ShippingHandling, Subtotal,
                       GrandTotal, Pricebook2Id, Description, OwnerId, Owner.Name,
                       CreatedDate, LastModifiedDate
                FROM Quote`;

    const whereClauses = [];
    if (opportunityId) whereClauses.push(`OpportunityId = '${soqlEscape(opportunityId)}'`);
    if (accountId) whereClauses.push(`Opportunity.AccountId = '${soqlEscape(accountId)}'`);
    if (status) whereClauses.push(`Status = '${soqlEscape(status)}'`);
    if (searchTerm) whereClauses.push(`Name LIKE '%${soqlEscape(searchTerm)}%'`);
    if (whereClauses.length > 0) soql += ` WHERE ${whereClauses.join(' AND ')}`;

    soql += ` ORDER BY LastModifiedDate DESC LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
  }

  async getQuoteById(quoteId) {
    const soql = `SELECT Id, Name, QuoteNumber, OpportunityId, Opportunity.Name,
                         Opportunity.AccountId, Opportunity.Account.Name, Status,
                         ExpirationDate, Discount, Tax, ShippingHandling, Subtotal,
                         GrandTotal, Pricebook2Id, Description, OwnerId, Owner.Name,
                         CreatedDate, LastModifiedDate
                  FROM Quote WHERE Id = '${soqlEscape(quoteId)}'`;
    return this.query(soql);
  }

  /**
   * Line items for a quote, oldest first. QuoteLineItem has no native
   * "sort order" field on the standard object, so display/edit order is
   * derived from creation order instead - see replaceQuoteLineItems() below,
   * which always re-creates the full set in the caller's intended order so
   * this ordering stays meaningful after every save (including reorders).
   */
  async getQuoteLineItems(quoteId) {
    const soql = `SELECT Id, QuoteId, Product2Id, Product2.Name, Product2.ProductCode,
                         PricebookEntryId, Quantity, UnitPrice, Discount, Description
                  FROM QuoteLineItem
                  WHERE QuoteId = '${soqlEscape(quoteId)}'
                  ORDER BY CreatedDate ASC, Id ASC`;
    const result = await this.query(soql);
    return result.records;
  }

  async createQuote(quoteData) {
    if (!quoteData.Name || !quoteData.OpportunityId) {
      throw new Error('Missing required field: Name and OpportunityId are required');
    }

    const pricebookId = await this.resolveQuotePricebookId(quoteData.OpportunityId);

    return this.request('POST', '/sobjects/Quote', {
      ...quoteData,
      Pricebook2Id: pricebookId,
    });
  }

  async updateQuote(quoteId, updates) {
    return this.request('PATCH', `/sobjects/Quote/${quoteId}`, updates);
  }

  async deleteQuote(quoteId) {
    return this.request('DELETE', `/sobjects/Quote/${quoteId}`);
  }

  /**
   * Replace every QuoteLineItem on a quote with `items`, in the given order.
   * This backs both "save my edits to the line item table" and "reorder
   * rows" - there is no writable ordering field to PATCH, so a reorder is
   * implemented as re-creating the whole set in the new order (Salesforce
   * assigns CreatedDate sequentially within one Collections insert, which is
   * what getQuoteLineItems() sorts by).
   *
   * Deliberately INSERT-then-DELETE, not the other way around: if the
   * insert of the new set fails (validation error, permissions, etc.) the
   * old line items are untouched and no data is lost. If the delete of the
   * old set then fails, the caller is told exactly which old records are
   * now orphaned duplicates so it can surface that and retry the cleanup,
   * rather than silently leaving the quote in a half-migrated state.
   */
  async replaceQuoteLineItems(quoteId, items) {
    if (items.length > 200) {
      throw new Error('A quote cannot have more than 200 line items in a single save');
    }

    const existing = await this.getQuoteLineItems(quoteId);

    let inserted = [];
    if (items.length > 0) {
      const records = items.map((item) => ({
        attributes: { type: 'QuoteLineItem' },
        QuoteId: quoteId,
        PricebookEntryId: item.pricebookEntryId,
        Quantity: item.quantity,
        UnitPrice: item.unitPrice,
        Discount: item.discount || 0,
        Description: item.description || null,
      }));

      const insertResult = await this.request('POST', '/composite/sobjects', {
        allOrNone: true,
        records,
      });

      inserted = insertResult;
    }

    let deletedOldCount = 0;
    let orphanedOldIds = [];
    if (existing.length > 0) {
      try {
        const idList = existing.map((rec) => rec.Id).join(',');
        await this.request('DELETE', `/composite/sobjects?ids=${encodeURIComponent(idList)}&allOrNone=true`);
        deletedOldCount = existing.length;
      } catch (deleteError) {
        orphanedOldIds = existing.map((rec) => rec.Id);
        console.error(`Failed to remove ${existing.length} superseded line item(s) on quote ${quoteId}:`, deleteError.message);
      }
    }

    return { inserted, deletedOldCount, orphanedOldIds };
  }

  async getQuoteStatuses() {
    return this.getPicklistValues('Quote', 'Status');
  }

  // ========================================================================
  // DATA EXPORT (Bulk Operations page - "Export Data")
  // ========================================================================

  /**
   * Every matching record for one of EXPORT_OBJECT_CONFIG's objects, for the
   * Bulk Operations page's export tab. Uses queryAll() (follows
   * nextRecordsUrl until exhausted) rather than the paginated getX() methods
   * elsewhere in this file, which always cap at a LIMIT/OFFSET page - an
   * export needs the full matching set, not one page of it.
   */
  async exportObjectRecords(objectType, filters = {}) {
    const config = EXPORT_OBJECT_CONFIG[objectType];
    if (!config) {
      const err = new Error(`Unsupported export object type: ${objectType}`);
      err.status = 400;
      throw err;
    }

    const { search, dateFrom, dateTo } = filters;

    let soql = `SELECT ${config.fields.join(', ')} FROM ${objectType}`;
    const whereClauses = [];

    if (search && config.searchField) {
      whereClauses.push(`${config.searchField} LIKE '%${soqlEscape(search)}%'`);
    }

    // Date literals (unlike string literals) take no surrounding quotes -
    // isPlainDate() is the actual safety check here, not soqlEscape, since a
    // quoted value would just be a different kind of malformed query, not a
    // safe one.
    if (dateFrom) {
      if (!isPlainDate(dateFrom)) {
        const err = new Error('dateFrom must be a YYYY-MM-DD date');
        err.status = 400;
        throw err;
      }
      whereClauses.push(`CreatedDate >= ${dateFrom}T00:00:00Z`);
    }
    if (dateTo) {
      if (!isPlainDate(dateTo)) {
        const err = new Error('dateTo must be a YYYY-MM-DD date');
        err.status = 400;
        throw err;
      }
      whereClauses.push(`CreatedDate <= ${dateTo}T23:59:59Z`);
    }

    if (whereClauses.length > 0) {
      soql += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    soql += ` ORDER BY CreatedDate DESC`;

    return this.queryAll(soql);
  }

  // ========================================================================
  // BULK OPERATIONS
  // ========================================================================

  /**
   * Create bulk job
   */
  async createBulkJob(operation, object) {
    // Bulk API 2.0 ingest jobs only accept CSV - CSV is also the default,
    // but set it explicitly since uploadBulkData() below always sends CSV.
    const jobData = {
      operation,
      object,
      contentType: 'CSV',
    };

    return this.request(
      'POST',
      '/jobs/ingest',
      jobData,
      { 'Sforce-Call-Options': 'client=SalesforceIntegration' }
    );
  }

  /**
   * Upload data to bulk job. Bulk API 2.0's batches endpoint takes a raw CSV
   * file body (Content-Type: text/csv) - it does not accept JSON, so the
   * records array is converted to CSV here before upload.
   */
  async uploadBulkData(jobId, records) {
    const fields = [...new Set(records.flatMap((record) => Object.keys(record)))];
    const parser = new CsvParser({ fields });
    const csv = parser.parse(records);

    return this.request(
      'PUT',
      `/jobs/ingest/${jobId}/batches`,
      csv,
      { 'Content-Type': 'text/csv' }
    );
  }

  /**
   * Close bulk job (start processing)
   */
  async closeBulkJob(jobId) {
    return this.request(
      'PATCH',
      `/jobs/ingest/${jobId}`,
      { state: 'UploadComplete' }
    );
  }

  /**
   * Get bulk job status
   */
  async getBulkJobStatus(jobId) {
    return this.request('GET', `/jobs/ingest/${jobId}`);
  }

  /**
   * Get bulk job results
   */
  async getBulkJobResults(jobId) {
    return this.request('GET', `/jobs/ingest/${jobId}/successfulResults/`);
  }

  /**
   * Get bulk job failed records
   */
  async getBulkJobFailedRecords(jobId) {
    return this.request('GET', `/jobs/ingest/${jobId}/failedResults/`);
  }
}

export default SalesforceService;

export const getSalesPipelineSummary = async (user) => {
  const service = new SalesforceService(user);
  return service.getSalesPipelineSummary();
};