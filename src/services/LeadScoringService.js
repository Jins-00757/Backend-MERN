/**
 * LeadScoringService - rules-based B2B lead scoring.
 *
 * Salesforce's standard Lead object has no scoring field beyond the native
 * `Rating` picklist (Hot/Warm/Cold), and computing a real score requires
 * either Einstein/Pardot (a paid add-on this org doesn't have) or a custom
 * field added via the Metadata API (out of reach for a backend service
 * without org-admin schema access, and risky to attempt blind). So scoring
 * is computed here, in application code, from fields every Salesforce org
 * already has on Lead - and the resulting tier can optionally be written
 * back into the existing `Rating` picklist (see leadsController.syncScore),
 * without ever touching the org's schema.
 *
 * The model is a standard firmographic + engagement + recency scorecard -
 * the same shape real B2B sales teams use (company fit, seniority of the
 * contact, how the lead reached you, how reachable they are, how fresh the
 * lead is) - not a black box. Every point is individually explainable via
 * `breakdown`, which the UI renders directly so a rep can see *why* a lead
 * scored the way it did, not just the number.
 */

const MAX_SCORE = 100;

// Tier thresholds intentionally match Salesforce's own Rating picklist
// values (Hot/Warm/Cold) so a computed tier maps 1:1 onto that existing
// field with no translation table to keep in sync.
export const SCORE_TIERS = {
  HOT: { label: 'Hot', min: 70 },
  WARM: { label: 'Warm', min: 40 },
  COLD: { label: 'Cold', min: 0 },
};

export const tierForScore = (score) => {
  if (score >= SCORE_TIERS.HOT.min) return SCORE_TIERS.HOT.label;
  if (score >= SCORE_TIERS.WARM.min) return SCORE_TIERS.WARM.label;
  return SCORE_TIERS.COLD.label;
};

const scoreCompanySize = (employees) => {
  if (!employees) return { points: 0, max: 20, reason: 'Company size unknown' };
  if (employees >= 1000) return { points: 20, max: 20, reason: `${employees.toLocaleString()} employees (enterprise)` };
  if (employees >= 200) return { points: 15, max: 20, reason: `${employees.toLocaleString()} employees (mid-market)` };
  if (employees >= 50) return { points: 10, max: 20, reason: `${employees.toLocaleString()} employees (SMB)` };
  if (employees >= 10) return { points: 5, max: 20, reason: `${employees.toLocaleString()} employees (small business)` };
  return { points: 0, max: 20, reason: `${employees.toLocaleString()} employees (very small)` };
};

const scoreRevenue = (revenue) => {
  if (!revenue) return { points: 0, max: 20, reason: 'Annual revenue unknown' };
  const fmt = (n) => `$${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (revenue >= 50_000_000) return { points: 20, max: 20, reason: `${fmt(revenue)} annual revenue` };
  if (revenue >= 10_000_000) return { points: 15, max: 20, reason: `${fmt(revenue)} annual revenue` };
  if (revenue >= 1_000_000) return { points: 10, max: 20, reason: `${fmt(revenue)} annual revenue` };
  return { points: 5, max: 20, reason: `${fmt(revenue)} annual revenue` };
};

// Keyword match against free-text Title - Lead has no structured seniority
// field, so this is necessarily heuristic, applied in priority order
// (most senior match wins) rather than summed.
const SENIORITY_PATTERNS = [
  { points: 20, pattern: /\b(ceo|cfo|cto|coo|cmo|chief|president|founder|owner|partner)\b/i, label: 'C-level / Founder' },
  { points: 15, pattern: /\b(vp|vice president|head of|director)\b/i, label: 'VP / Director' },
  { points: 10, pattern: /\bmanager\b/i, label: 'Manager' },
];

const scoreTitle = (title) => {
  if (!title) return { points: 0, max: 20, reason: 'Title unknown' };
  const match = SENIORITY_PATTERNS.find((p) => p.pattern.test(title));
  if (match) return { points: match.points, max: 20, reason: `${title} (${match.label})` };
  return { points: 5, max: 20, reason: `${title} (individual contributor)` };
};

const LEAD_SOURCE_SCORES = {
  'Referral': 15,
  'Partner Referral': 15,
  'Partner': 12,
  'Web': 10,
  'Website': 10,
  'Trade Show': 8,
  'Advertisement': 5,
  'Other': 3,
};

const scoreLeadSource = (leadSource) => {
  if (!leadSource) return { points: 3, max: 15, reason: 'No lead source recorded' };
  const points = LEAD_SOURCE_SCORES[leadSource] ?? 3;
  return { points, max: 15, reason: `Source: ${leadSource}` };
};

const scoreCompleteness = (lead) => {
  let points = 0;
  const present = [];
  const missing = [];

  if (lead.Email) { points += 5; present.push('email'); } else missing.push('email');
  if (lead.Phone) { points += 5; present.push('phone'); } else missing.push('phone');
  if (lead.Company) { points += 5; present.push('company'); } else missing.push('company');

  const reason = present.length > 0
    ? `Has ${present.join(', ')}${missing.length ? ` - missing ${missing.join(', ')}` : ''}`
    : 'No contact details on file';

  return { points, max: 15, reason };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const scoreRecency = (createdDate) => {
  if (!createdDate) return { points: 0, max: 10, reason: 'Creation date unknown' };
  const ageDays = (Date.now() - new Date(createdDate).getTime()) / DAY_MS;

  if (ageDays <= 7) return { points: 10, max: 10, reason: `Created ${Math.max(0, Math.round(ageDays))} day(s) ago - fresh` };
  if (ageDays <= 30) return { points: 6, max: 10, reason: `Created ${Math.round(ageDays)} days ago` };
  if (ageDays <= 90) return { points: 3, max: 10, reason: `Created ${Math.round(ageDays)} days ago` };
  return { points: 0, max: 10, reason: `Created ${Math.round(ageDays)} days ago - stale` };
};

/**
 * Score a single Salesforce Lead record. Expects the standard fields
 * (NumberOfEmployees, AnnualRevenue, Title, LeadSource, Email, Phone,
 * Company, CreatedDate) - every one of these is a standard Lead field in
 * every Salesforce org, so this never depends on custom fields existing.
 */
export const scoreLead = (lead) => {
  const factors = {
    companySize: scoreCompanySize(lead.NumberOfEmployees),
    revenue: scoreRevenue(lead.AnnualRevenue),
    seniority: scoreTitle(lead.Title),
    leadSource: scoreLeadSource(lead.LeadSource),
    completeness: scoreCompleteness(lead),
    recency: scoreRecency(lead.CreatedDate),
  };

  const score = Object.values(factors).reduce((sum, f) => sum + f.points, 0);
  const clampedScore = Math.max(0, Math.min(MAX_SCORE, score));

  const breakdown = [
    { factor: 'Company Size', ...factors.companySize },
    { factor: 'Annual Revenue', ...factors.revenue },
    { factor: 'Seniority', ...factors.seniority },
    { factor: 'Lead Source', ...factors.leadSource },
    { factor: 'Reachability', ...factors.completeness },
    { factor: 'Recency', ...factors.recency },
  ];

  return {
    score: clampedScore,
    maxScore: MAX_SCORE,
    tier: tierForScore(clampedScore),
    breakdown,
  };
};

/**
 * Attach `scoreData` to every lead in a list without mutating the original
 * records - the leadsController spreads this over each Salesforce record.
 */
export const scoreLeads = (leads) => leads.map((lead) => ({ ...lead, scoreData: scoreLead(lead) }));

export default { scoreLead, scoreLeads, tierForScore, SCORE_TIERS };
