import User from '../models/User.js';
import SalesforceService from '../services/salesforceService.js';
import ExportService from '../services/ExportService.js';
import AuditLogger from '../services/AuditLogger.js';
import { createDownloadToken } from '../services/downloadTokenService.js';

/**
 * pdfkit's PDFDocument is a Readable stream, not a Buffer - the download-
 * token flow needs the finished bytes up front (to hash and hand to
 * createDownloadToken), so collect the stream into one Buffer instead of
 * piping it straight to the response the way this used to work.
 */
const pdfDocToBuffer = (doc) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

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
  
  // Get opportunities grouped by stage. COUNT() (no argument) is the only
  // SOQL aggregate that Salesforce refuses to let you alias - MALFORMED_QUERY
  // ("unexpected token: 'COUNT()'") - so this counts Id instead, which can be.
  const soql = `SELECT StageName, COUNT(Id) recordCount, SUM(Amount) totalAmount,
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

/**
 * GET /api/data/export/:format
 * Export the Dashboard stats (pipeline summary by stage) as CSV or PDF.
 */
/**
 * Generates the export content and hands back a secure, single-use,
 * 1-hour download link (see services/downloadTokenService.js) instead of
 * streaming the file directly - the same content-freezing + hash
 * verification + audit trail every export in this app now goes through,
 * so a dashboard export is subject to the same guarantees as a bulk job's
 * results export.
 */
export const exportDashboardStats = async (req, res) => {
  try {
    const { format } = req.params;

    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid export format',
      });
    }

    const { data: stats } = await getSalesPipelineSummary(req.user._id);

    let content;
    let contentType;
    const filename = `dashboard-stats.${format}`;

    if (format === 'csv') {
      content = await ExportService.exportDashboardStatsToCSV(stats);
      contentType = 'text/csv';
    } else {
      const doc = await ExportService.exportDashboardStatsToPDF(stats, req.user);
      content = await pdfDocToBuffer(doc);
      contentType = 'application/pdf';
    }

    const { token, fileHash, expiresAt } = await createDownloadToken({
      userId: req.user._id,
      ip: req.ip,
      filename,
      contentType,
      content,
    });

    await AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: 'DashboardStats',
      resourceId: filename,
      changes: { format, fileHash },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.status(200).json({
      success: true,
      data: {
        downloadUrl: `/export/download/${token}`,
        expiresAt,
        fileHash,
        filename,
      },
    });
  } catch (error) {
    console.error('Error exporting dashboard stats:', error);
    sendSalesforceDataError(res, error, 'Failed to export dashboard stats');
  }
};

export default {
  getSalesforceOpportunities,
  getSalesforceAccounts,
  getSalesPipelineSummary,
  exportDashboardStats,
};