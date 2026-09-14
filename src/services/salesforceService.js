

import axios from 'axios';
import { Parser as CsvParser } from '@json2csv/plainjs';
import User from '../models/User.js';
import { encryptToken, decryptToken } from './encryptionService.js';

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
    this.accessToken = this.decryptToken(user.salesforceAccessToken);
    this.refreshToken = user.salesforceRefreshToken;
    this.tokenExpiresAt = user.salesforceTokenExpiresAt;
    this.apiVersion = 'v59.0';
    this.maxRetries = 3;
    this.retryDelay = 1000;
  }

  /**
   * Decrypt stored tokens (uses the same AES-256-CBC + IV scheme the OAuth
   * callback encrypts with in encryptionService.js - keeping a separate,
   * incompatible cipher here would make every stored token undecryptable).
   */
  decryptToken(encryptedToken) {
    if (!encryptedToken) return null;

    try {
      return decryptToken(encryptedToken);
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
  const soql = `SELECT StageName, COUNT() recordCount, SUM(Amount) totalAmount,
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