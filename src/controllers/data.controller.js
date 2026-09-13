import User from '../models/User.js';
import SalesforceService from '../services/salesforceService.js';

/**
 * Classify a thrown error from the getSalesforce* / getSalesPipelineSummary
 * helpers below into the right HTTP status - "not connected" and "expired"
 * are user-actionable states the frontend branches on, not generic failures.
 */
const sendSalesforceDataError = (res, error, fallbackMessage) => {
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
    error: fallbackMessage,
  });
};

/**
 * GET /api/data/opportunities
 */
export const getOpportunities = async (req, res) => {
  try {
    const result = await getSalesforceOpportunities(req.user._id);

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching opportunities:', error.message);
    sendSalesforceDataError(res, error, 'Failed to fetch opportunities');
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
    sendSalesforceDataError(res, error, 'Failed to fetch accounts');
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
    sendSalesforceDataError(res, error, 'Failed to fetch pipeline summary');
  }
};

/**
 * Standalone function to get Salesforce opportunities
 */
export const getSalesforceOpportunities = async (userId) => {
  const user = await User.findById(userId);

  if (!user || !user.isSalesforceConnected) {
    throw new Error('Salesforce account not connected');
  }

  const salesforce = new SalesforceService(user);
  const result = await salesforce.getOpportunities({
    limit: 100,
    offset: 0,
  });

  return {
    success: true,
    data: result.records,
    totalRecords: result.records.length,
  };
};

/**
 * Standalone function to get Salesforce accounts
 */
export const getSalesforceAccounts = async (userId) => {
  const user = await User.findById(userId);

  if (!user || !user.isSalesforceConnected) {
    throw new Error('Salesforce account not connected');
  }

  const salesforce = new SalesforceService(user);
  const result = await salesforce.getAccounts({
    limit: 100,
    offset: 0,
  });

  return {
    success: true,
    data: result.records,
    totalRecords: result.records.length,
  };
};

/**
 * Standalone function to get pipeline summary
 */
export const getSalesPipelineSummary = async (userId) => {
  const user = await User.findById(userId);

  if (!user || !user.isSalesforceConnected) {
    throw new Error('Salesforce account not connected');
  }

  const salesforce = new SalesforceService(user);
  
  // Get opportunities grouped by stage
  const soql = `SELECT StageName, COUNT() recordCount, SUM(Amount) totalAmount,
                       AVG(Probability) avgProbability
                FROM Opportunity
                WHERE IsClosed = false
                GROUP BY StageName
                ORDER BY StageName ASC`;

  const result = await salesforce.query(soql);

  const summary = {
    totalOpportunities: 0,
    totalPipelineValue: 0,
    averageProbability: 0,
    stageBreakdown: [],
  };

  let totalProbability = 0;
  let probabilityCount = 0;

  result.records.forEach((stage) => {
    summary.totalOpportunities += stage.recordCount || 0;
    summary.totalPipelineValue += stage.totalAmount || 0;
    
    if (stage.avgProbability) {
      totalProbability += stage.avgProbability * (stage.recordCount || 1);
      probabilityCount += stage.recordCount || 1;
    }

    summary.stageBreakdown.push({
      stage: stage.StageName,
      count: stage.recordCount || 0,
      totalAmount: stage.totalAmount || 0,
      avgProbability: stage.avgProbability || 0,
      percentOfPipeline: 0, // Will calculate below
    });
  });

  // Calculate percentages
  summary.stageBreakdown.forEach((stage) => {
    if (summary.totalPipelineValue > 0) {
      stage.percentOfPipeline = Math.round(
        (stage.totalAmount / summary.totalPipelineValue) * 100
      );
    }
  });

  // Calculate average probability across all open opportunities
  if (probabilityCount > 0) {
    summary.averageProbability = Math.round(totalProbability / probabilityCount);
  }

  return {
    success: true,
    data: summary,
  };
};

export default { getSalesforceOpportunities, getSalesforceAccounts, getSalesPipelineSummary };