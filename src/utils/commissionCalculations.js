
/**
 * A rep's commission rate when their User document has never had one set
 * explicitly (see models/User.js's commissionRate field) - 10%, a common
 * flat-rate default for SaaS sales commissions.
 */
export const DEFAULT_COMMISSION_RATE = 0.1;

/**
 * Commission owed on a closed-won deal's grand total, rounded to the cent.
 * Used by webhookController.js when a Salesforce Opportunity closes won.
 */
export const calculateCommission = (grandTotal, commissionRate = DEFAULT_COMMISSION_RATE) => {
  const amount = Number(grandTotal) || 0;
  const rate = Number(commissionRate);
  const safeRate = Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_COMMISSION_RATE;
  return Math.round(amount * safeRate * 100) / 100;
};
