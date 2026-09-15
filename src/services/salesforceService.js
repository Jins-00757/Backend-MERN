

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
   * Check if token needs refresh
   */
  async ensureValidToken() {
    const now = new Date();
    const expirationBuffer = 5 * 60 * 1000; // 5 minutes

    if (
      this.tokenExpiresAt &&
      now.getTime() >
        this.tokenExpiresAt.getTime() - expirationBuffer
    ) {
      await this.refreshAccessToken();
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken() {
    try {
      const response = await axios.post(
        `${this.instanceUrl}/services/oauth2/token`,
        {
          grant_type: 'refresh_token',
          client_id: process.env.SALESFORCE_CLIENT_ID,
          client_secret: process.env.SALESFORCE_CLIENT_SECRET,
          refresh_token: this.refreshToken,
        }
      );

      this.accessToken = response.data.access_token;

      // Update user in database with new token
      await User.findByIdAndUpdate(this.user._id, {
        salesforceAccessToken: this.encryptToken(
          response.data.access_token
        ),
        salesforceTokenExpiresAt: new Date(
          Date.now() + response.data.expires_in * 1000
        ),
      });

      this.tokenExpiresAt = new Date(
        Date.now() + response.data.expires_in * 1000
      );
      
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
    retryCount = 0
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
          retryCount + 1
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
    const message = error.response?.data?.[0]?.message || error.message;

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
    } = filters;

    let soql = `SELECT Id, Name, StageName, Amount, CloseDate,
                       Probability, AccountId, OwnerId, Owner.Name, CreatedDate,
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

    let soql = `SELECT Id, Name, BillingCity, BillingState, 
                       Industry, AnnualRevenue, Phone, Website,
                       CreatedDate FROM Account`;

    if (searchTerm) {
      soql += ` WHERE Name LIKE '%${soqlEscape(searchTerm)}%'`;
    }

    soql += ` ORDER BY Name ASC LIMIT ${limit} OFFSET ${offset}`;

    return this.query(soql);
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