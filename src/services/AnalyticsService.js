
import SalesforceService from './salesforceService.js';

/**
 * Re-throw with a friendlier message while preserving the original error's
 * HTTP status (e.g. 400 "Salesforce account not connected") - without this,
 * every failure here would surface to the client as a generic 500.
 */
const wrapError = (error, prefix) => {
  const wrapped = new Error(`${prefix}: ${error.message}`);
  wrapped.status = error.status;
  return wrapped;
};

/**
 * AnalyticsService - Pipeline analytics computed from a user's live
 * Salesforce data.
 *
 * This app never mirrors Opportunities into MongoDB (see
 * opportunitiesController.js) - every report here queries Salesforce
 * directly via SOQL and aggregates the results in memory, the same way the
 * rest of the app reads Salesforce data.
 */
class AnalyticsService {
  // Pipeline Health Report
  async getPipelineHealth(user, dateRange = 30) {
    try {
      const salesforce = new SalesforceService(user);

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - dateRange);

      const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                           AccountId, OwnerId, CreatedDate
                    FROM Opportunity
                    WHERE CreatedDate >= ${startDate.toISOString()}`;

      const opportunities = await salesforce.queryAll(soql);

      const stageDistribution = {};
      let totalValue = 0;
      let closedWonCount = 0;
      let closedWonValue = 0;

      opportunities.forEach((opp) => {
        const stage = opp.StageName || 'Unknown';
        stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;
        totalValue += opp.Amount || 0;

        if (opp.StageName === 'Closed Won') {
          closedWonCount += 1;
          closedWonValue += opp.Amount || 0;
        }
      });

      const winRate = opportunities.length > 0
        ? ((closedWonCount / opportunities.length) * 100).toFixed(2)
        : 0;

      return {
        dateRange,
        periodStart: startDate,
        periodEnd: new Date(),
        totalOpportunities: opportunities.length,
        totalPipelineValue: totalValue,
        closedWonCount,
        closedWonValue,
        winRate: parseFloat(winRate),
        stageDistribution,
        avgDealSize: opportunities.length > 0 ? totalValue / opportunities.length : 0,
      };
    } catch (error) {
      throw wrapError(error, 'Pipeline health analysis failed');
    }
  }

  // Forecast by Stage
  async getForecastByStage(user) {
    try {
      const salesforce = new SalesforceService(user);

      const soql = `SELECT Id, Name, StageName, Amount
                    FROM Opportunity
                    WHERE IsClosed = false`;

      const opportunities = await salesforce.queryAll(soql);

      const forecast = {};
      const stageWeights = {
        Prospecting: 0.1,
        Qualification: 0.2,
        'Needs Analysis': 0.3,
        'Value Proposition': 0.4,
        'Identification of Decision Makers': 0.5,
        'Perception Analysis': 0.6,
        'Proposal/Price Quote': 0.75,
        'Negotiation/Review': 0.9,
        'Closed Won': 1.0,
        'Closed Lost': 0.0,
      };

      opportunities.forEach((opp) => {
        const stage = opp.StageName || 'Unknown';
        const weight = stageWeights[stage] ?? 0.5;
        const weightedValue = (opp.Amount || 0) * weight;

        if (!forecast[stage]) {
          forecast[stage] = {
            count: 0,
            totalValue: 0,
            weightedForecast: 0,
            avgDealSize: 0,
          };
        }

        forecast[stage].count += 1;
        forecast[stage].totalValue += opp.Amount || 0;
        forecast[stage].weightedForecast += weightedValue;
      });

      Object.keys(forecast).forEach((stage) => {
        forecast[stage].avgDealSize =
          forecast[stage].totalValue / forecast[stage].count;
      });

      const totalForecast = Object.values(forecast)
        .reduce((sum, data) => sum + data.weightedForecast, 0);

      return {
        byStage: forecast,
        totalForecast: Math.round(totalForecast),
        generatedAt: new Date(),
      };
    } catch (error) {
      throw wrapError(error, 'Forecast analysis failed');
    }
  }

  // Rep Performance within the connected org
  async getTeamPerformance(user) {
    try {
      const salesforce = new SalesforceService(user);

      const soql = `SELECT Id, Amount, StageName, OwnerId, Owner.Name
                    FROM Opportunity`;

      const opportunities = await salesforce.queryAll(soql);

      const teamStats = {};

      opportunities.forEach((opp) => {
        const ownerId = opp.OwnerId;

        if (!teamStats[ownerId]) {
          teamStats[ownerId] = {
            ownerName: opp.Owner?.Name || 'Unknown',
            totalDeals: 0,
            totalValue: 0,
            closedWon: 0,
            closedWonValue: 0,
            avgDealSize: 0,
            winRate: 0,
          };
        }

        teamStats[ownerId].totalDeals += 1;
        teamStats[ownerId].totalValue += opp.Amount || 0;

        if (opp.StageName === 'Closed Won') {
          teamStats[ownerId].closedWon += 1;
          teamStats[ownerId].closedWonValue += opp.Amount || 0;
        }
      });

      Object.keys(teamStats).forEach((ownerId) => {
        const stats = teamStats[ownerId];
        stats.avgDealSize = stats.totalDeals > 0 ? stats.totalValue / stats.totalDeals : 0;
        stats.winRate = stats.totalDeals > 0
          ? parseFloat(((stats.closedWon / stats.totalDeals) * 100).toFixed(2))
          : 0;
      });

      return teamStats;
    } catch (error) {
      throw wrapError(error, 'Team performance analysis failed');
    }
  }

  // Revenue Trend Analysis - one query covering the whole window, bucketed
  // by month in memory (avoids firing `months` separate SOQL queries).
  async getRevenueTrend(user, months = 6) {
    try {
      const salesforce = new SalesforceService(user);

      const rangeStart = new Date();
      rangeStart.setMonth(rangeStart.getMonth() - (months - 1));
      rangeStart.setDate(1);
      rangeStart.setHours(0, 0, 0, 0);

      const soql = `SELECT Id, Amount, CloseDate
                    FROM Opportunity
                    WHERE StageName = 'Closed Won' AND CloseDate >= ${rangeStart.toISOString().slice(0, 10)}`;

      const wonOpportunities = await salesforce.queryAll(soql);

      const trends = {};
      for (let i = months - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthKey = date.toISOString().substring(0, 7); // YYYY-MM
        trends[monthKey] = { month: monthKey, revenue: 0, dealsCount: 0, avgDealSize: 0 };
      }

      wonOpportunities.forEach((opp) => {
        if (!opp.CloseDate) return;
        const monthKey = opp.CloseDate.substring(0, 7);
        if (!trends[monthKey]) return; // outside the requested window
        trends[monthKey].revenue += opp.Amount || 0;
        trends[monthKey].dealsCount += 1;
      });

      Object.values(trends).forEach((month) => {
        month.avgDealSize = month.dealsCount > 0 ? month.revenue / month.dealsCount : 0;
      });

      return trends;
    } catch (error) {
      throw wrapError(error, 'Revenue trend analysis failed');
    }
  }

  // Deal Risk Assessment - open pipeline only, closed deals carry no risk
  async assessDealRisks(user) {
    try {
      const salesforce = new SalesforceService(user);

      const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability
                    FROM Opportunity
                    WHERE IsClosed = false`;

      const opportunities = await salesforce.queryAll(soql);
      const today = new Date();

      const risks = opportunities.map((opp) => {
        let riskScore = 0;
        const reasons = [];

        const daysToClose = opp.CloseDate
          ? Math.floor((new Date(opp.CloseDate) - today) / (1000 * 60 * 60 * 24))
          : null;

        if (daysToClose !== null) {
          if (daysToClose < 0) {
            riskScore += 30;
            reasons.push('Close date passed');
          } else if (daysToClose < 7) {
            riskScore += 20;
            reasons.push('Close date approaching');
          }
        }

        if ((opp.Probability || 0) < 30) {
          riskScore += 25;
          reasons.push('Low probability');
        }

        if ((opp.Amount || 0) > 500000) {
          riskScore += 15;
          reasons.push('High deal value');
        }

        const earlyStages = ['Prospecting', 'Qualification'];
        if (earlyStages.includes(opp.StageName) && daysToClose !== null && daysToClose < 30) {
          riskScore += 20;
          reasons.push('Early stage with near close date');
        }

        return {
          opportunityId: opp.Id,
          opportunityName: opp.Name,
          riskScore: Math.min(100, riskScore),
          riskLevel: riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low',
          risks: reasons,
          daysToClose,
        };
      });

      return risks.sort((a, b) => b.riskScore - a.riskScore);
    } catch (error) {
      throw wrapError(error, 'Risk assessment failed');
    }
  }
}

export default new AnalyticsService();
