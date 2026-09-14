
import AnalyticsService from '../services/AnalyticsService.js';
import AuditLogger from '../services/AuditLogger.js';

export const getPipelineHealth = async (req, res) => {
  try {
    const { range = 30 } = req.query;
    const report = await AnalyticsService.getPipelineHealth(req.user, parseInt(range));

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
    const forecast = await AnalyticsService.getForecastByStage(req.user);

    res.json({
      success: true,
      data: forecast,
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
    const risks = await AnalyticsService.assessDealRisks(req.user);

    res.json({
      success: true,
      data: risks,
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
    const performance = await AnalyticsService.getTeamPerformance(req.user);

    res.json({
      success: true,
      data: performance,
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
    const trends = await AnalyticsService.getRevenueTrend(req.user, parseInt(months));

    res.json({
      success: true,
      data: trends,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};