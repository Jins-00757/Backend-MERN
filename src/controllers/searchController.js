
import SearchService from '../services/SearchService.js';
import ExportService from '../services/ExportService.js';
import cacheService from '../services/CacheService.js';

// Search hits Salesforce with two SOQL round trips per call (list + count -
// see SearchService.search), and typeahead suggestions can fire on nearly
// every keystroke, so both are cached briefly. The TTL is short (unlike the
// 5 minute analytics/opportunity list caches) since users expect a search
// they just refined to reflect data they just changed - it just needs to
// survive a few repeated/back-and-forth requests (re-renders, paging,
// re-typing the same query), which invalidateOpportunityCaches() in
// opportunitiesController.js also proactively clears on any write.
const SEARCH_TTL = 60;

const buildSearchCacheKey = (userId, q, filters) => {
  const {
    stage = '',
    minAmount = '',
    maxAmount = '',
    startDate = '',
    endDate = '',
    sortBy = 'relevance',
    page = 1,
    limit = 20,
  } = filters;

  return `search_${userId}_${q.toLowerCase()}_${stage}_${minAmount}_${maxAmount}_${startDate}_${endDate}_${sortBy}_${page}_${limit}`;
};

export const search = async (req, res) => {
  try {
    const { q, ...filters } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
      });
    }

    const cacheKey = buildSearchCacheKey(req.user._id, q, filters);
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({ success: true, ...cached, source: 'cache' });
    }

    const results = await SearchService.search(req.user, q, filters);
    await cacheService.set(cacheKey, results, SEARCH_TTL);

    res.json({
      success: true,
      ...results,
      source: 'salesforce',
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getSuggestions = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json({ success: true, suggestions: [] });
    }

    const cacheKey = `suggest_${req.user._id}_${q.toLowerCase()}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({ success: true, ...cached, source: 'cache' });
    }

    const suggestions = await SearchService.getSearchSuggestions(req.user, q);
    await cacheService.set(cacheKey, suggestions, SEARCH_TTL);

    res.json({
      success: true,
      ...suggestions,
      source: 'salesforce',
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const exportData = async (req, res) => {
  try {
    // `format` is a route param (GET /export/:format), not a query string key
    const { format } = req.params;
    const { q, ...filters } = req.query;

    if (!['csv', 'pdf'].includes(format)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid export format',
      });
    }

    const { results } = await SearchService.search(req.user, q || '', filters);

    if (format === 'csv') {
      const csv = await ExportService.exportToCSV(results);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="opportunities.csv"');
      res.send(csv);
    } else if (format === 'pdf') {
      const doc = await ExportService.exportToPDF(results, req.user);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="opportunities.pdf"');
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