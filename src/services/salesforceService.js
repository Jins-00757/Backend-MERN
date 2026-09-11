import axios from 'axios';
import User from '../models/User.js';
import { config } from '../config/env.js';
import { encryptToken, decryptToken } from './encryptionService.js';

const SALESFORCE_API_VERSION = 'v57.0';

/**
 * Exchange the user's stored refresh token for a fresh access token and
 * persist it. Throws if the user never connected or Salesforce rejects the
 * refresh token (e.g. it was revoked) - callers must not retry after this.
 */
export const refreshAccessToken = async (userId) => {
  const user = await User.findById(userId);

  if (!user?.salesforceRefreshToken) {
    throw new Error('No refresh token available');
  }

  const refreshToken = decryptToken(user.salesforceRefreshToken);

  const response = await axios.post(
    config.salesforceTokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.salesforceClientId,
      client_secret: config.salesforceClientSecret,
      refresh_token: refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { access_token, instance_url } = response.data;

  await User.findByIdAndUpdate(userId, {
    salesforceAccessToken: encryptToken(access_token),
    ...(instance_url ? { salesforceInstanceUrl: instance_url } : {}),
  });

  return { accessToken: access_token, instanceUrl: instance_url || user.salesforceInstanceUrl };
};

/**
 * Run a SOQL query against the Salesforce REST API for the given user.
 * Retries exactly once after refreshing the access token on a 401, then
 * gives up - never recurses unboundedly.
 */
const runSoqlQuery = async (userId, soql, { isRetry = false } = {}) => {
  const user = await User.findById(userId);

  if (!user?.salesforceUserId) {
    throw new Error('User not connected to Salesforce');
  }

  const accessToken = decryptToken(user.salesforceAccessToken);
  const query = encodeURIComponent(soql);

  try {
    const response = await axios.get(
      `${user.salesforceInstanceUrl}/services/data/${SALESFORCE_API_VERSION}/query?q=${query}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data;
  } catch (error) {
    if (error.response?.status === 401 && !isRetry) {
      await refreshAccessToken(userId);
      return runSoqlQuery(userId, soql, { isRetry: true });
    }

    if (error.response?.status === 401) {
      throw new Error('Salesforce token expired - please reconnect');
    }

    throw error;
  }
};

/**
 * Get Salesforce opportunities (open deals)
 */
export const getSalesforceOpportunities = async (userId) => {
  try {
    const data = await runSoqlQuery(
      userId,
      'SELECT Id, Name, Amount, StageName, CloseDate, AccountId, Owner.Name ' +
        'FROM Opportunity WHERE IsClosed = false ORDER BY CloseDate ASC LIMIT 100'
    );

    const opportunities = data.records.map((opp) => ({
      id: opp.Id,
      name: opp.Name,
      amount: opp.Amount || 0,
      stage: opp.StageName,
      closeDate: opp.CloseDate,
      accountId: opp.AccountId,
      owner: opp.Owner?.Name || 'Unassigned',
    }));

    return {
      success: true,
      data: opportunities,
      totalRecords: data.totalSize,
    };
  } catch (error) {
    console.error('❌ Error fetching Salesforce opportunities:', error.message);
    throw error;
  }
};

/**
 * Get Salesforce accounts
 */
export const getSalesforceAccounts = async (userId) => {
  try {
    const data = await runSoqlQuery(
      userId,
      'SELECT Id, Name, Industry, Phone, Website, BillingCity, BillingCountry FROM Account LIMIT 100'
    );

    const accounts = data.records.map((acc) => ({
      id: acc.Id,
      name: acc.Name,
      industry: acc.Industry,
      phone: acc.Phone,
      website: acc.Website,
      city: acc.BillingCity,
      country: acc.BillingCountry,
    }));

    return {
      success: true,
      data: accounts,
      totalRecords: data.totalSize,
    };
  } catch (error) {
    console.error('❌ Error fetching Salesforce accounts:', error.message);
    throw error;
  }
};

/**
 * Get sales pipeline summary grouped by stage
 */
export const getSalesPipelineSummary = async (userId) => {
  try {
    const data = await runSoqlQuery(
      userId,
      'SELECT StageName, COUNT(Id) recordCount, SUM(Amount) totalAmount ' +
        'FROM Opportunity WHERE IsClosed = false GROUP BY StageName ORDER BY StageName ASC'
    );

    const summary = data.records.map((record) => ({
      stage: record.StageName,
      count: record.recordCount || 0,
      total: record.totalAmount || 0,
    }));

    return {
      success: true,
      data: summary,
    };
  } catch (error) {
    console.error('❌ Error fetching sales pipeline summary:', error.message);
    throw error;
  }
};

export default {
  getSalesforceOpportunities,
  getSalesforceAccounts,
  getSalesPipelineSummary,
  refreshAccessToken,
};
