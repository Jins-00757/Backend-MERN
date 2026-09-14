
import Opportunity from '../models/Opportunity.js';

class SearchService {
  async search(user, query, filters = {}) {
    try {
      const {
        type = 'all', // 'opportunities', 'accounts', 'contacts', 'all'
        stage,
        minAmount,
        maxAmount,
        startDate,
        endDate,
        sortBy = 'relevance',
        page = 1,
        limit = 20,
      } = filters;

      const skip = (page - 1) * limit;
      const searchRegex = new RegExp(query, 'i');

      const mongoQuery = {
        userId: user._id,
        $or: [
          { name: searchRegex },
          { description: searchRegex },
        ],
      };

      // Apply filters
      if (stage) mongoQuery.stage = stage;

      if (minAmount || maxAmount) {
        mongoQuery.amount = {};
        if (minAmount) mongoQuery.amount.$gte = parseFloat(minAmount);
        if (maxAmount) mongoQuery.amount.$lte = parseFloat(maxAmount);
      }

      if (startDate || endDate) {
        mongoQuery.closeDate = {};
        if (startDate) mongoQuery.closeDate.$gte = new Date(startDate);
        if (endDate) mongoQuery.closeDate.$lte = new Date(endDate);
      }

      // Build sort option
      let sortOption = {};
      switch (sortBy) {
        case 'amount':
          sortOption = { amount: -1 };
          break;
        case 'date':
          sortOption = { closeDate: -1 };
          break;
        case 'name':
          sortOption = { name: 1 };
          break;
        default:
          sortOption = { score: { $meta: 'textScore' } };
      }

      const [results, total] = await Promise.all([
        Opportunity.find(mongoQuery)
          .sort(sortOption)
          .skip(skip)
          .limit(limit),
        Opportunity.countDocuments(mongoQuery),
      ]);

      return {
        results,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  async getSearchSuggestions(user, query, limit = 10) {
    try {
      const searchRegex = new RegExp(`^${query}`, 'i');

      const [names, stages] = await Promise.all([
        Opportunity.find(
          { userId: user._id, name: searchRegex },
          { name: 1 }
        )
          .limit(limit / 2),
        Opportunity.find(
          { userId: user._id, stage: searchRegex },
          { stage: 1 }
        )
          .distinct('stage')
          .limit(limit / 2),
      ]);

      return {
        suggestions: [
          ...names.map((n) => ({ type: 'opportunity', value: n.name })),
          ...stages.map((s) => ({ type: 'stage', value: s })),
        ],
      };
    } catch (error) {
      throw new Error(`Suggestions retrieval failed: ${error.message}`);
    }
  }
}

export default new SearchService();