
import SalesforceService, { soqlEscape } from '../services/salesforceService.js';
import cacheService from '../services/CacheService.js';

/**
 * @route   GET /api/salesforce/accounts
 * @desc    Get all accounts with search and pagination
 * @access  Private
 */
export const getAccounts = async (req, res) => {
  try {
    const { limit = 50, offset = 0, search } = req.query;
    const cacheKey = `accounts_${req.user._id}_${limit}_${offset}_${search}`;

    // Check cache
    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getAccounts({
      limit: Math.min(parseInt(limit), 500),
      offset: Math.max(0, parseInt(offset)),
      searchTerm: search,
    });

    // Cache for 5 minutes
    await cacheService.set(cacheKey, result, 300);

    res.status(200).json({
      success: true,
      data: result,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/accounts/:id
 * @desc    Get single account details
 * @access  Private
 */
export const getAccountById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `account_${req.user._id}_${id}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const soql = `SELECT Id, Name, BillingStreet, BillingCity, 
                         BillingState, BillingPostalCode, BillingCountry,
                         Phone, Website, Industry, AnnualRevenue,
                         NumberOfEmployees, Description, CreatedDate,
                         LastModifiedDate
                  FROM Account WHERE Id = '${soqlEscape(id)}'`;
    const result = await salesforce.query(soql);

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Account not found',
      });
    }

    const account = result.records[0];
    await cacheService.set(cacheKey, account, 300);

    res.status(200).json({
      success: true,
      data: account,
    });
  } catch (error) {
    console.error('Error fetching account:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/accounts/:id/opportunities
 * @desc    Get opportunities for specific account
 * @access  Private
 */
export const getAccountOpportunities = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `account_opps_${req.user._id}_${id}`;

    let cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getAccountWithOpportunities(id);

    await cacheService.set(cacheKey, result, 300);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error fetching account opportunities:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/accounts
 * @desc    Create new account
 * @access  Private
 */
export const createAccount = async (req, res) => {
  try {
    const { Name, BillingCity, BillingState, Industry, AnnualRevenue, Phone, Website } = req.body;

    if (!Name) {
      return res.status(400).json({
        success: false,
        message: 'Account name is required',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createAccount({
      Name,
      BillingCity,
      BillingState,
      Industry,
      AnnualRevenue: AnnualRevenue ? parseFloat(AnnualRevenue) : null,
      Phone,
      Website,
    });

    // Invalidate cache
    await cacheService.deleteByPrefix(`accounts_${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error creating account:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   PATCH /api/salesforce/accounts/:id
 * @desc    Update account
 * @access  Private
 */
export const updateAccount = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (updates.AnnualRevenue !== undefined) {
      updates.AnnualRevenue = parseFloat(updates.AnnualRevenue);
    }

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateAccount(id, updates);

    // Invalidate cache
    await cacheService.delete(`account_${req.user._id}_${id}`);
    await cacheService.delete(`account_opps_${req.user._id}_${id}`);
    await cacheService.deleteByPrefix(`accounts_${req.user._id}`);

    res.status(200).json({
      success: true,
      message: 'Account updated successfully',
    });
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export default {
  getAccounts,
  getAccountById,
  getAccountOpportunities,
  createAccount,
  updateAccount,
};