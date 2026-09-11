import {
  getSalesforceOpportunities,
  getSalesforceAccounts,
  getSalesPipelineSummary,
} from '../services/salesforceService.js';

/**
 * GET /api/data/opportunities
 */
export const getOpportunities = async (req, res) => {
  try {
    const result = await getSalesforceOpportunities(req.user._id);

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching opportunities:', error.message);

    if (error.message.includes('not connected')) {
      return res.status(400).json({
        success: false,
        error: 'Salesforce account not connected',
      });
    }

    if (error.message.includes('expired')) {
      return res.status(401).json({
        success: false,
        error: 'Salesforce token expired - please reconnect',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch opportunities',
    });
  }
};

/**
 * GET /api/data/accounts
 */
export const getAccounts = async (req, res) => {
  try {
    const result = await getSalesforceAccounts(req.user._id);

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching accounts:', error.message);

    res.status(500).json({
      success: false,
      error: 'Failed to fetch accounts',
    });
  }
};

/**
 * GET /api/data/pipeline-summary
 */
export const getPipelineSummary = async (req, res) => {
  try {
    const result = await getSalesPipelineSummary(req.user._id);

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching pipeline summary:', error.message);

    res.status(500).json({
      success: false,
      error: 'Failed to fetch pipeline summary',
    });
  }
};

export default { getOpportunities, getAccounts, getPipelineSummary };