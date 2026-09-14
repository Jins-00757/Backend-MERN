
import SalesforceService from './salesforceService.js';
import cacheService from './CacheService.js';

/**
 * Re-throw with a friendlier message while preserving the original error's
 * HTTP status (e.g. 400 "Salesforce account not connected") - without this,
 * every failure here would surface to the client as a generic 500. Mirrors
 * AnalyticsService.js's wrapError.
 */
const wrapError = (error, prefix) => {
  const wrapped = new Error(`${prefix}: ${error.message}`);
  wrapped.status = error.status;
  return wrapped;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const daysSince = (dateStr) => (dateStr ? Math.floor((Date.now() - new Date(dateStr).getTime()) / DAY_MS) : null);

/**
 * SaaSMetricsService - SaaS/Technology vertical analytics (ARR forecasting,
 * churn prediction, customer health scoring, expansion opportunities)
 * computed from a user's live Salesforce data.
 *
 * Like AnalyticsService.js, this never mirrors Salesforce records into
 * MongoDB - every report queries Salesforce directly via SOQL. There is no
 * subscription/MRR/ARR field anywhere in the org's schema as queried
 * elsewhere in this app, so "ARR" is derived from Closed-Won Opportunity
 * Amount/CloseDate and clearly labeled as an estimate wherever it's
 * returned - never presented as real contractual ARR.
 */
class SaaSMetricsService {
  /**
   * Build a per-account profile from Accounts + all Opportunities in
   * exactly two SOQL calls, shared by churn/health/expansion so those three
   * features cost one Salesforce round trip between them instead of three.
   * No date filter on Opportunity - churn detection needs to see old data
   * (e.g. "no win in the last 365 days") just as much as recent data.
   */
  async _buildAccountProfiles(user) {
    const cacheKey = `saas_profiles_${user._id}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) return new Map(cached);

    const salesforce = new SalesforceService(user);

    const [accounts, opportunities] = await Promise.all([
      salesforce.queryAll('SELECT Id, Name, Industry, AnnualRevenue, CreatedDate FROM Account'),
      salesforce.queryAll(
        `SELECT Id, Name, AccountId, Amount, StageName, CloseDate, Probability,
                Type, IsWon, IsClosed, CreatedDate, LastModifiedDate
         FROM Opportunity`
      ),
    ]);

    const profiles = new Map();

    accounts.forEach((account) => {
      profiles.set(account.Id, {
        accountId: account.Id,
        accountName: account.Name,
        annualRevenue: account.AnnualRevenue || null,
        closedWonCount: 0,
        closedWonValue: 0,
        closedLostCount: 0,
        openCount: 0,
        openValue: 0,
        lastWonDate: null,
        lastActivityDate: null,
        recentWonValue: 0, // Closed Won, CloseDate within the last 90 days
        priorWonValue: 0, // Closed Won, CloseDate 91-180 days ago
        winRate: 0,
      });
    });

    const now = Date.now();
    const ninetyDaysAgo = now - 90 * DAY_MS;
    const oneEightyDaysAgo = now - 180 * DAY_MS;

    opportunities.forEach((opp) => {
      const profile = profiles.get(opp.AccountId);
      if (!profile) return; // opportunity on an account outside the fetched set

      const amount = opp.Amount || 0;
      const closeTime = opp.CloseDate ? new Date(opp.CloseDate).getTime() : null;
      const modifiedTime = opp.LastModifiedDate ? new Date(opp.LastModifiedDate).getTime() : null;

      if (modifiedTime && (!profile.lastActivityDate || modifiedTime > new Date(profile.lastActivityDate).getTime())) {
        profile.lastActivityDate = opp.LastModifiedDate;
      }

      if (opp.IsWon || opp.StageName === 'Closed Won') {
        profile.closedWonCount += 1;
        profile.closedWonValue += amount;

        if (!profile.lastWonDate || (closeTime && closeTime > new Date(profile.lastWonDate).getTime())) {
          profile.lastWonDate = opp.CloseDate;
        }

        if (closeTime) {
          if (closeTime >= ninetyDaysAgo) {
            profile.recentWonValue += amount;
          } else if (closeTime >= oneEightyDaysAgo) {
            profile.priorWonValue += amount;
          }
        }
      } else if (opp.IsClosed || opp.StageName === 'Closed Lost') {
        profile.closedLostCount += 1;
      } else {
        profile.openCount += 1;
        profile.openValue += amount;
      }
    });

    profiles.forEach((profile) => {
      const closedTotal = profile.closedWonCount + profile.closedLostCount;
      profile.winRate = closedTotal > 0
        ? parseFloat(((profile.closedWonCount / closedTotal) * 100).toFixed(2))
        : 0;
    });

    // Only accounts with at least one opportunity carry any signal worth scoring.
    const withActivity = new Map(
      [...profiles].filter(([, p]) => p.closedWonCount + p.closedLostCount + p.openCount > 0)
    );

    await cacheService.set(cacheKey, [...withActivity], 300);
    return withActivity;
  }

  // ==========================================================================
  // ARR FORECAST
  // ==========================================================================

  async getArrForecast(user, months = 12, forecastMonths = 6) {
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

      // Same month-bucketing idiom as AnalyticsService.getRevenueTrend.
      const monthKeys = [];
      const buckets = {};
      for (let i = months - 1; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const monthKey = date.toISOString().substring(0, 7); // YYYY-MM
        monthKeys.push(monthKey);
        buckets[monthKey] = { revenue: 0, dealsCount: 0 };
      }

      wonOpportunities.forEach((opp) => {
        if (!opp.CloseDate) return;
        const monthKey = opp.CloseDate.substring(0, 7);
        if (!buckets[monthKey]) return; // outside the requested window
        buckets[monthKey].revenue += opp.Amount || 0;
        buckets[monthKey].dealsCount += 1;
      });

      let cumulative = 0;
      const monthlyTrend = monthKeys.map((monthKey) => {
        cumulative += buckets[monthKey].revenue;
        return {
          month: monthKey,
          revenue: buckets[monthKey].revenue,
          dealsCount: buckets[monthKey].dealsCount,
          cumulativeArr: cumulative,
        };
      });

      const currentArrEstimate = monthlyTrend
        .slice(-12)
        .reduce((sum, m) => sum + m.revenue, 0);

      // Simple run-rate + trend-delta forecast - no regression/stats library,
      // matching the rest of this codebase's in-memory arithmetic approach.
      const last3 = monthlyTrend.slice(-3);
      const prior3 = monthlyTrend.slice(-6, -3);
      const avgRecent3 = last3.length ? last3.reduce((s, m) => s + m.revenue, 0) / last3.length : 0;
      const avgPrior3 = prior3.length ? prior3.reduce((s, m) => s + m.revenue, 0) / prior3.length : 0;
      const monthlyDelta = Math.max(0, (avgRecent3 - avgPrior3) / 3);

      let forecastCumulative = cumulative;
      const forecast = [];
      for (let i = 1; i <= forecastMonths; i++) {
        const projectedNewBookings = Math.max(0, avgRecent3 + monthlyDelta * i);
        forecastCumulative += projectedNewBookings;

        const date = new Date();
        date.setMonth(date.getMonth() + i);

        forecast.push({
          month: date.toISOString().substring(0, 7),
          projectedNewBookings: Math.round(projectedNewBookings),
          projectedArr: Math.round(forecastCumulative),
        });
      }

      const growthRate = avgPrior3 > 0
        ? parseFloat((((avgRecent3 - avgPrior3) / avgPrior3) * 100).toFixed(2))
        : 0;

      return {
        currentArrEstimate: Math.round(currentArrEstimate),
        growthRate,
        isEstimate: true,
        methodology:
          'Derived from Closed-Won Opportunity Amount/CloseDate - no subscription/MRR field exists in this org.',
        monthlyTrend,
        forecast,
        generatedAt: new Date(),
      };
    } catch (error) {
      throw wrapError(error, 'ARR forecast failed');
    }
  }

  // ==========================================================================
  // CHURN RISK
  // ==========================================================================

  async getChurnRisk(user) {
    try {
      const profiles = await this._buildAccountProfiles(user);

      const risks = [...profiles.values()].map((profile) => {
        let riskScore = 0;
        const reasons = [];

        const daysSinceWon = daysSince(profile.lastWonDate);
        const daysSinceActivity = daysSince(profile.lastActivityDate);

        if (profile.closedWonCount === 0) {
          riskScore += 25;
          reasons.push('No closed-won deals on record');
        } else if (daysSinceWon !== null) {
          if (daysSinceWon > 365) {
            riskScore += 35;
            reasons.push('No recent wins (over a year since last closed-won deal)');
          } else if (daysSinceWon > 90) {
            riskScore += 20;
            reasons.push('No recent wins (over 90 days since last closed-won deal)');
          }
        }

        if (daysSinceActivity !== null && daysSinceActivity > 180) {
          riskScore += 20;
          reasons.push('No recent account activity');
        }

        if (profile.openCount === 0) {
          riskScore += 20;
          reasons.push('No active open pipeline');
        }

        const closedTotal = profile.closedWonCount + profile.closedLostCount;
        if (closedTotal > 0 && profile.closedLostCount / closedTotal > 0.5) {
          riskScore += 20;
          reasons.push('High loss ratio on past deals');
        }

        if (profile.priorWonValue > 0 && profile.recentWonValue < profile.priorWonValue * 0.5) {
          riskScore += 15;
          reasons.push('Declining deal value trend');
        }

        riskScore = Math.min(100, riskScore);

        return {
          accountId: profile.accountId,
          accountName: profile.accountName,
          churnScore: riskScore,
          riskLevel: riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low',
          reasons,
          daysSinceLastWin: daysSinceWon,
          daysSinceLastActivity: daysSinceActivity,
          openPipelineValue: profile.openValue,
        };
      });

      return risks.sort((a, b) => b.churnScore - a.churnScore);
    } catch (error) {
      throw wrapError(error, 'Churn risk assessment failed');
    }
  }

  // ==========================================================================
  // CUSTOMER HEALTH SCORE
  // ==========================================================================

  async getCustomerHealth(user) {
    try {
      const profiles = await this._buildAccountProfiles(user);

      const scores = [...profiles.values()].map((profile) => {
        const daysSinceActivity = daysSince(profile.lastActivityDate);

        let engagement = 0;
        if (daysSinceActivity !== null) {
          if (daysSinceActivity <= 30) engagement = 30;
          else if (daysSinceActivity <= 90) engagement = 20;
          else if (daysSinceActivity <= 180) engagement = 10;
        }

        let financial = 0;
        if (profile.closedWonValue > 500000) financial = 25;
        else if (profile.closedWonValue > 100000) financial = 15;
        else if (profile.closedWonValue > 0) financial = 5;

        let growth = 0;
        if (profile.priorWonValue > 0) {
          const ratio = profile.recentWonValue / profile.priorWonValue;
          if (ratio > 1.1) growth = 25;
          else if (ratio >= 0.9) growth = 15;
          else if (ratio >= 0.5) growth = 5;
        } else if (profile.recentWonValue > 0) {
          growth = 25; // new recent revenue with no prior baseline reads as growth
        }

        let winRateScore = 0;
        if (profile.winRate >= 50) winRateScore = 20;
        else if (profile.winRate >= 30) winRateScore = 12;
        else if (profile.winRate >= 10) winRateScore = 5;

        const healthScore = engagement + financial + growth + winRateScore;

        return {
          accountId: profile.accountId,
          accountName: profile.accountName,
          healthScore,
          healthCategory: healthScore >= 70 ? 'Healthy' : healthScore >= 40 ? 'Neutral' : 'At Risk',
          breakdown: { engagement, financial, growth, winRate: winRateScore },
        };
      });

      return scores.sort((a, b) => b.healthScore - a.healthScore);
    } catch (error) {
      throw wrapError(error, 'Customer health scoring failed');
    }
  }

  // ==========================================================================
  // EXPANSION OPPORTUNITIES
  // ==========================================================================

  async getExpansionOpportunities(user) {
    try {
      const [profiles, healthScores] = await Promise.all([
        this._buildAccountProfiles(user),
        this.getCustomerHealth(user),
      ]);

      const healthByAccount = new Map(healthScores.map((h) => [h.accountId, h]));

      const candidates = [...profiles.values()]
        .filter((profile) => (healthByAccount.get(profile.accountId)?.healthScore ?? 0) >= 40)
        .map((profile) => {
          const reasons = [];
          let suggestedAction = '';

          if (profile.openCount === 0 && profile.closedWonCount > 0) {
            reasons.push('Active customer with no open pipeline');
            suggestedAction = 'Schedule an account review to scope the next use case';
          }

          if (profile.priorWonValue > 0 && profile.recentWonValue > profile.priorWonValue * 1.2) {
            reasons.push('Recent deal sizes trending up');
            suggestedAction = suggestedAction || 'Propose an expansion/upsell package';
          }

          if (profile.annualRevenue > 0 && profile.closedWonValue < profile.annualRevenue * 0.01) {
            reasons.push('Captured revenue is under 1% of reported annual revenue');
            suggestedAction = suggestedAction || 'Explore cross-sell into adjacent departments';
          }

          return {
            accountId: profile.accountId,
            accountName: profile.accountName,
            expansionScore: reasons.length,
            reasons,
            suggestedAction,
            currentValue: profile.closedWonValue,
            healthScore: healthByAccount.get(profile.accountId)?.healthScore ?? 0,
          };
        })
        .filter((candidate) => candidate.expansionScore > 0);

      return candidates.sort(
        (a, b) => b.expansionScore - a.expansionScore || b.currentValue - a.currentValue
      );
    } catch (error) {
      throw wrapError(error, 'Expansion opportunity analysis failed');
    }
  }
}

export default new SaaSMetricsService();
