
import AnalyticsService from '../services/AnalyticsService.js';
import AuditLogger from '../services/AuditLogger.js';
import ExportService from '../services/ExportService.js';
import cacheService from '../services/CacheService.js';
import { hasPermission } from '../middleware/rbac.js';

// Analytics reports are expensive (they pull and aggregate every open/closed
// Salesforce Opportunity for the user), so each is cached for 5 minutes -
// the same TTL opportunitiesController uses for opportunity list caching.
// Any opportunity create/update/close/delete invalidates the whole
// `analytics_<userId>` prefix (see invalidateOpportunityCaches there), so a
// cached report never outlives the data it was computed from by more than
// one write.
const REPORT_TTL = 300;

/**
 * Fetch `compute()`'s result from cache under `cacheKey`, or compute, cache,
 * and return it. Shared by every report endpoint below so each one only
 * has to describe its own cache key and computation.
 */
const withCache = async (cacheKey, compute) => {
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return { data: cached, source: 'cache' };
  }

  const data = await compute();
  await cacheService.set(cacheKey, data, REPORT_TTL);
  return { data, source: 'salesforce' };
};

export const getPipelineHealth = async (req, res) => {
  try {
    const { range = 30 } = req.query;
    const parsedRange = parseInt(range);
    const { data: report, source } = await withCache(
      `analytics_${req.user._id}_pipeline-health_${parsedRange}`,
      () => AnalyticsService.getPipelineHealth(req.user, parsedRange)
    );

    await AuditLogger.log('READ', {
      userId: req.user._id,
      resourceType: 'Analytics',
      action: 'getPipelineHealth',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      success: true,
      data: report,
      source,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getForecast = async (req, res) => {
  try {
    const { data: forecast, source } = await withCache(
      `analytics_${req.user._id}_forecast`,
      () => AnalyticsService.getForecastByStage(req.user)
    );

    res.json({
      success: true,
      data: forecast,
      source,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getDealRisks = async (req, res) => {
  try {
    const { data: risks, source } = await withCache(
      `analytics_${req.user._id}_risks`,
      () => AnalyticsService.assessDealRisks(req.user)
    );

    res.json({
      success: true,
      data: risks,
      source,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getTeamPerformance = async (req, res) => {
  try {
    const { data: performance, source } = await withCache(
      `analytics_${req.user._id}_team-performance`,
      () => AnalyticsService.getTeamPerformance(req.user)
    );

    res.json({
      success: true,
      data: performance,
      source,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getRevenueTrend = async (req, res) => {
  try {
    const { months = 6 } = req.query;
    const parsedMonths = parseInt(months);
    const { data: trends, source } = await withCache(
      `analytics_${req.user._id}_revenue-trend_${parsedMonths}`,
      () => AnalyticsService.getRevenueTrend(req.user, parsedMonths)
    );

    res.json({
      success: true,
      data: trends,
      source,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

const REPORT_FETCHERS = {
  health: (user, query) => AnalyticsService.getPipelineHealth(user, parseInt(query.range) || 30),
  forecast: (user) => AnalyticsService.getForecastByStage(user),
  risks: (user) => AnalyticsService.assessDealRisks(user),
  'team-performance': (user) => AnalyticsService.getTeamPerformance(user),
  'revenue-trend': (user, query) => AnalyticsService.getRevenueTrend(user, parseInt(query.months) || 6),
};

/**
 * GET /api/analytics/export/:format?report=health|forecast|risks|team-performance|revenue-trend
 */
export const exportAnalytics = async (req, res) => {
  try {
    const { format } = req.params;
    const { report = 'health' } = req.query;

    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid export format',
      });
    }

    const fetchReport = REPORT_FETCHERS[report];
    if (!fetchReport) {
      return res.status(400).json({
        success: false,
        message: `Invalid report type. Must be one of: ${Object.keys(REPORT_FETCHERS).join(', ')}`,
      });
    }

    // Team performance is gated behind manage:team on its own endpoint
    // (see analytics.routes.js) - the export route serves every report
    // type through one path, so that same check has to happen here too.
    if (report === 'team-performance' && !hasPermission(req.user.role, 'manage:team')) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }

    const data = await fetchReport(req.user, req.query);

    await AuditLogger.log('EXPORT', {
      userId: req.user._id,
      resourceType: 'Analytics',
      resourceId: report,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (format === 'csv') {
      const csv = await ExportService.exportAnalyticsToCSV(report, data);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="analytics-${report}.csv"`);
      res.send(csv);
    } else {
      const doc = await ExportService.exportAnalyticsToPDF(report, data, req.user);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="analytics-${report}.pdf"`);
      doc.pipe(res);
      doc.end();
    }
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};