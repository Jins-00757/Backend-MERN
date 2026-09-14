
import Opportunity from '../models/Opportunity.js';
import salesforceService from './SalesforceService.js';

class AnalyticsService {
  // Pipeline Health Report
  async getPipelineHealth(user, dateRange = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - dateRange);

      const opportunities = await Opportunity.find({
        userId: user._id,
        createdAt: { $gte: startDate },
      });

      const stageDistribution = {};
      let totalValue = 0;
      let closedWonCount = 0;
      let closedWonValue = 0;

      opportunities.forEach((opp) => {
        const stage = opp.stage || 'Unknown';
        stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;
        totalValue += opp.amount || 0;

        if (opp.stage === 'Closed Won') {
          closedWonCount += 1;
          closedWonValue += opp.amount || 0;
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
      throw new Error(`Pipeline health analysis failed: ${error.message}`);
    }
  }

  // Forecast by Stage
  async getForecastByStage(user) {
    try {
      const opportunities = await Opportunity.find({ userId: user._id });

      const forecast = {};
      const stageWeights = {
        'Prospecting': 0.1,
        'Qualification': 0.2,
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
        const stage = opp.stage || 'Unknown';
        const weight = stageWeights[stage] || 0.5;
        const weightedValue = (opp.amount || 0) * weight;

        if (!forecast[stage]) {
          forecast[stage] = {
            count: 0,
            totalValue: 0,
            weightedForecast: 0,
            avgDealSize: 0,
          };
        }

        forecast[stage].count += 1;
        forecast[stage].totalValue += opp.amount || 0;
        forecast[stage].weightedForecast += weightedValue;
      });

      // Calculate averages
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
      throw new Error(`Forecast analysis failed: ${error.message}`);
    }
  }

  // Sales Rep Performance
  async getTeamPerformance(user) {
    try {
      const opportunities = await Opportunity.find({});

      const teamStats = {};

      opportunities.forEach((opp) => {
        const ownerId = opp.userId.toString();
        
        if (!teamStats[ownerId]) {
          teamStats[ownerId] = {
            totalDeals: 0,
            totalValue: 0,
            closedWon: 0,
            closedWonValue: 0,
            avgDealSize: 0,
          };
        }

        teamStats[ownerId].totalDeals += 1;
        teamStats[ownerId].totalValue += opp.amount || 0;

        if (opp.stage === 'Closed Won') {
          teamStats[ownerId].closedWon += 1;
          teamStats[ownerId].closedWonValue += opp.amount || 0;
        }
      });

      // Calculate averages and win rates
      Object.keys(teamStats).forEach((ownerId) => {
        const stats = teamStats[ownerId];
        stats.avgDealSize = stats.totalValue / stats.totalDeals;
        stats.winRate = ((stats.closedWon / stats.totalDeals) * 100).toFixed(2);
      });

      return teamStats;
    } catch (error) {
      throw new Error(`Team performance analysis failed: ${error.message}`);
    }
  }

  // Revenue Trend Analysis
  async getRevenueTrend(user, months = 6) {
    try {
      const trends = {};

      for (let i = months - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthKey = date.toISOString().substring(0, 7); // YYYY-MM

        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
        const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);

        const monthOpps = await Opportunity.find({
          userId: user._id,
          closedAt: { $gte: monthStart, $lte: monthEnd },
          stage: 'Closed Won',
        });

        const revenue = monthOpps.reduce((sum, opp) => sum + (opp.amount || 0), 0);

        trends[monthKey] = {
          month: monthKey,
          revenue,
          dealsCount: monthOpps.length,
          avgDealSize: monthOpps.length > 0 ? revenue / monthOpps.length : 0,
        };
      }

      return trends;
    } catch (error) {
      throw new Error(`Revenue trend analysis failed: ${error.message}`);
    }
  }

  // Deal Risk Assessment
  async assessDealRisks(user) {
    try {
      const today = new Date();
      const opportunities = await Opportunity.find({ userId: user._id });

      const risks = opportunities.map((opp) => {
        let riskScore = 0;
        const risks = [];

        // Check if close date is near or overdue
        const daysToClose = Math.floor(
          (new Date(opp.closeDate) - today) / (1000 * 60 * 60 * 24)
        );

        if (daysToClose < 0) {
          riskScore += 30;
          risks.push('Close date passed');
        } else if (daysToClose < 7) {
          riskScore += 20;
          risks.push('Close date approaching');
        }

        // Check probability
        if ((opp.probability || 0) < 30) {
          riskScore += 25;
          risks.push('Low probability');
        }

        // Check deal size variance
        if ((opp.amount || 0) > 500000) {
          riskScore += 15;
          risks.push('High deal value');
        }

        // Check stage progression
        const earlyStages = ['Prospecting', 'Qualification'];
        if (earlyStages.includes(opp.stage) && daysToClose < 30) {
          riskScore += 20;
          risks.push('Early stage with near close date');
        }

        return {
          opportunityId: opp.salesforceId,
          opportunityName: opp.name,
          riskScore: Math.min(100, riskScore),
          riskLevel: riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low',
          risks,
          daysToClose,
        };
      });

      // Sort by risk score
      return risks.sort((a, b) => b.riskScore - a.riskScore);
    } catch (error) {
      throw new Error(`Risk assessment failed: ${error.message}`);
    }
  }
}

export default new AnalyticsService();