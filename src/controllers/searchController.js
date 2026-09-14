
import SearchService from '../services/SearchService.js';
import ExportService from '../services/ExportService.js';

export const search = async (req, res) => {
  try {
    const { q, ...filters } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query is required',
      });
    }

    const results = await SearchService.search(req.user, q, filters);

    res.json({
      success: true,
      ...results,
    });
  } catch (error) {
    res.status(500).json({
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

    const suggestions = await SearchService.getSearchSuggestions(req.user, q);

    res.json({
      success: true,
      ...suggestions,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const exportData = async (req, res) => {
  try {
    const { format, q, ...filters } = req.query;

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
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};