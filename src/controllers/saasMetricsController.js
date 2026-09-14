
import SaaSMetricsService from '../services/SaaSMetricsService.js';
import cacheService from '../services/CacheService.js';

export const getArrForecast = async (req, res) => {
  try {
    const { months = 12, forecastMonths = 6 } = req.query;
    const cacheKey = `saas_arr_${req.user._id}_${months}_${forecastMonths}`;

    let data = await cacheService.get(cacheKey);
    let source = 'cache';

    if (!data) {
      data = await SaaSMetricsService.getArrForecast(req.user, parseInt(months), parseInt(forecastMonths));
      await cacheService.set(cacheKey, data, 600);
      source = 'salesforce';
    }

    res.json({ success: true, data, source });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getChurnRisk = async (req, res) => {
  try {
    const cacheKey = `saas_churn_${req.user._id}`;

    let data = await cacheService.get(cacheKey);
    let source = 'cache';

    if (!data) {
      data = await SaaSMetricsService.getChurnRisk(req.user);
      await cacheService.set(cacheKey, data, 600);
      source = 'salesforce';
    }

    res.json({ success: true, data, source });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getCustomerHealth = async (req, res) => {
  try {
    const cacheKey = `saas_health_${req.user._id}`;

    let data = await cacheService.get(cacheKey);
    let source = 'cache';

    if (!data) {
      data = await SaaSMetricsService.getCustomerHealth(req.user);
      await cacheService.set(cacheKey, data, 600);
      source = 'salesforce';
    }

    res.json({ success: true, data, source });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getExpansionOpportunities = async (req, res) => {
  try {
    const cacheKey = `saas_expansion_${req.user._id}`;

    let data = await cacheService.get(cacheKey);
    let source = 'cache';

    if (!data) {
      data = await SaaSMetricsService.getExpansionOpportunities(req.user);
      await cacheService.set(cacheKey, data, 600);
      source = 'salesforce';
    }

    res.json({ success: true, data, source });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
