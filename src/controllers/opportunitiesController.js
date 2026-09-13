// Backend-MERN/src/controllers/opportunitiesController.js

import SalesforceService, { soqlEscape } from '../services/salesforceService.js';
import SyncLog from '../models/SyncLog.js';
import cacheService from '../services/CacheService.js';

/**
 * @route   GET /api/salesforce/opportunities
 * @desc    Get all opportunities with filtering and pagination
 * @access  Private
 */
export const getOpportunities = async (req, res) => {
  try {
    const { limit = 50, offset = 0, stage, amountMin, amountMax } = req.query;
    const cacheKey = `opp_list_${req.user._id}_${limit}_${offset}_${stage}`;

    // Check cache
    let cached = cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.getOpportunities({
      limit: Math.min(parseInt(limit), 500),
      offset: Math.max(0, parseInt(offset)),
      stageName: stage,
      amountMin: amountMin ? parseFloat(amountMin) : null,
      amountMax: amountMax ? parseFloat(amountMax) : null,
    });

    // Cache for 5 minutes
    cacheService.set(cacheKey, result, 300);

    res.status(200).json({
      success: true,
      data: result,
      source: 'salesforce',
    });
  } catch (error) {
    console.error('Error fetching opportunities:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
      error: process.env.NODE_ENV === 'development' ? error : undefined,
    });
  }
};

/**
 * @route   GET /api/salesforce/opportunities/:id
 * @desc    Get single opportunity with details
 * @access  Private
 */
export const getOpportunityById = async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `opp_${req.user._id}_${id}`;

    let cached = cacheService.get(cacheKey);
    if (cached) {
      return res.status(200).json({
        success: true,
        data: cached,
        source: 'cache',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const soql = `SELECT Id, Name, StageName, Amount, CloseDate, 
                         Probability, AccountId, OwnerId, Description,
                         CreatedDate, LastModifiedDate 
                  FROM Opportunity WHERE Id = '${soqlEscape(id)}'`;
    const result = await salesforce.query(soql);

    if (result.records.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Opportunity not found',
      });
    }

    const opportunity = result.records[0];
    cacheService.set(cacheKey, opportunity, 300);

    res.status(200).json({
      success: true,
      data: opportunity,
    });
  } catch (error) {
    console.error('Error fetching opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/opportunities
 * @desc    Create new opportunity
 * @access  Private
 */
export const createOpportunity = async (req, res) => {
  try {
    const { Name, StageName, CloseDate, Amount, AccountId, Description } =
      req.body;

    // Validation
    if (!Name || !StageName || !CloseDate || !AccountId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: Name, StageName, CloseDate, AccountId',
      });
    }

    if (new Date(CloseDate) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Close date must be in the future',
      });
    }

    const salesforce = new SalesforceService(req.user);
    const result = await salesforce.createOpportunity({
      Name,
      StageName,
      CloseDate,
      Amount: Amount ? parseFloat(Amount) : null,
      AccountId,
      Description,
    });

    // Invalidate cache
    cacheService.deleteByPrefix(`opp_list_${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Opportunity created successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error creating opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   PATCH /api/salesforce/opportunities/:id
 * @desc    Update opportunity
 * @access  Private
 */
export const updateOpportunity = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Validate close date if provided
    if (updates.CloseDate && new Date(updates.CloseDate) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Close date must be in the future',
      });
    }

    if (updates.Amount !== undefined) {
      updates.Amount = parseFloat(updates.Amount);
    }

    const salesforce = new SalesforceService(req.user);
    await salesforce.updateOpportunity(id, updates);

    // Invalidate cache
    cacheService.delete(`opp_${req.user._id}_${id}`);
    cacheService.deleteByPrefix(`opp_list_${req.user._id}`);

    res.status(200).json({
      success: true,
      message: 'Opportunity updated successfully',
    });
  } catch (error) {
    console.error('Error updating opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   POST /api/salesforce/opportunities/:id/close
 * @desc    Close opportunity as won or lost
 * @access  Private
 */
export const closeOpportunity = async (req, res) => {
  try {
    const { id } = req.params;
    const { won = true } = req.body;

    const salesforce = new SalesforceService(req.user);
    await salesforce.closeOpportunity(id, true, won);

    cacheService.delete(`opp_${req.user._id}_${id}`);
    cacheService.deleteByPrefix(`opp_list_${req.user._id}`);

    res.status(200).json({
      success: true,
      message: `Opportunity closed as ${won ? 'Won' : 'Lost'}`,
    });
  } catch (error) {
    console.error('Error closing opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   DELETE /api/salesforce/opportunities/:id
 * @desc    Delete opportunity
 * @access  Private
 */
export const deleteOpportunity = async (req, res) => {
  try {
    const { id } = req.params;

    const salesforce = new SalesforceService(req.user);
    await salesforce.deleteOpportunity(id);

    cacheService.delete(`opp_${req.user._id}_${id}`);
    cacheService.deleteByPrefix(`opp_list_${req.user._id}`);

    res.status(200).json({
      success: true,
      message: 'Opportunity deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting opportunity:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @route   GET /api/salesforce/opportunities/sync/status
 * @desc    Get sync status for opportunities
 * @access  Private
 */
export const getSyncStatus = async (req, res) => {
  try {
    const syncLog = await SyncLog.findOne(
      {
        userId: req.user._id,
        syncType: { $in: ['opportunities', 'all'] },
      },
      {},
      { sort: { createdAt: -1 } }
    );

    res.status(200).json({
      success: true,
      data: syncLog || null,
    });
  } catch (error) {
    console.error('Error getting sync status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get sync status',
    });
  }
};