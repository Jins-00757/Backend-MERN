
import SalesforceService, { soqlEscape, isPlainDate } from './salesforceService.js';

/**
 * Re-throw with a friendlier message while preserving the original error's
 * HTTP status (e.g. 400 "Salesforce account not connected").
 */
const wrapError = (error, prefix) => {
  const wrapped = new Error(`${prefix}: ${error.message}`);
  wrapped.status = error.status;
  return wrapped;
};

/**
 * CloseDate is a SOQL date literal, which takes no quotes at all - unlike
 * soqlEscape() (for *string* literals), only a value that provably matches
 * `YYYY-MM-DD` (as produced by the filter UI's `<input type="date">`) is
 * safe to splice into the WHERE clause unescaped.
 */
const assertPlainDate = (value, field) => {
  if (!isPlainDate(value)) {
    const err = new Error(`${field} must be a YYYY-MM-DD date`);
    err.status = 400;
    throw err;
  }
};

const SORTABLE_FIELDS = {
  amount: 'Amount DESC',
  date: 'CloseDate DESC',
  name: 'Name ASC',
  relevance: 'CloseDate DESC', // SOQL has no text-relevance ranking; fall back to most recent
};

class SearchService {
  async search(user, query, filters = {}) {
    try {
      const {
        stage,
        minAmount,
        maxAmount,
        startDate,
        endDate,
        sortBy = 'relevance',
        page = 1,
        limit = 20,
      } = filters;

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (pageNum - 1) * pageSize;

      const whereClauses = [];

      if (query) {
        // Description is a Long Text Area field on Opportunity - Salesforce
        // disallows those in a SOQL WHERE clause entirely (SOQL_INVALID_FILTER),
        // so only Name (a standard text field) can be filtered on here.
        whereClauses.push(`Name LIKE '%${soqlEscape(query)}%'`);
      }

      if (stage) whereClauses.push(`StageName = '${soqlEscape(stage)}'`);
      if (minAmount) whereClauses.push(`Amount >= ${parseFloat(minAmount)}`);
      if (maxAmount) whereClauses.push(`Amount <= ${parseFloat(maxAmount)}`);
      if (startDate) {
        assertPlainDate(startDate, 'startDate');
        whereClauses.push(`CloseDate >= ${startDate}`);
      }
      if (endDate) {
        assertPlainDate(endDate, 'endDate');
        whereClauses.push(`CloseDate <= ${endDate}`);
      }

      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
      const orderSql = SORTABLE_FIELDS[sortBy] || SORTABLE_FIELDS.relevance;

      const salesforce = new SalesforceService(user);

      const listSoql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                                AccountId, Description
                         FROM Opportunity${whereSql}
                         ORDER BY ${orderSql}
                         LIMIT ${pageSize} OFFSET ${offset}`;

      const countSoql = `SELECT COUNT() FROM Opportunity${whereSql}`;

      const [listResult, countResult] = await Promise.all([
        salesforce.query(listSoql),
        salesforce.query(countSoql),
      ]);

      const total = countResult.totalSize ?? 0;

      return {
        results: listResult.records,
        pagination: {
          page: pageNum,
          limit: pageSize,
          total,
          pages: Math.ceil(total / pageSize),
        },
      };
    } catch (error) {
      throw wrapError(error, 'Search failed');
    }
  }

  async getSearchSuggestions(user, query, limit = 10) {
    try {
      const salesforce = new SalesforceService(user);
      const escaped = soqlEscape(query);
      const half = Math.max(1, Math.floor(limit / 2));

      const nameSoql = `SELECT Id, Name FROM Opportunity
                         WHERE Name LIKE '${escaped}%'
                         ORDER BY Name ASC LIMIT ${half}`;
      const stageSoql = `SELECT StageName FROM Opportunity
                          WHERE StageName LIKE '${escaped}%'
                          LIMIT ${half}`;

      const [nameResult, stageResult] = await Promise.all([
        salesforce.query(nameSoql),
        salesforce.query(stageSoql),
      ]);

      const uniqueStages = [...new Set(stageResult.records.map((r) => r.StageName))];

      return {
        suggestions: [
          ...nameResult.records.map((n) => ({ type: 'opportunity', value: n.Name })),
          ...uniqueStages.map((s) => ({ type: 'stage', value: s })),
        ],
      };
    } catch (error) {
      throw wrapError(error, 'Suggestions retrieval failed');
    }
  }
}

export default new SearchService();
