/**
 * Pure quote math shared by the PDF renderer (ExportService.exportQuoteToPDF)
 * so the numbers on a downloaded/emailed PDF always match what Salesforce
 * itself would compute for the same inputs.
 *
 * Mirrored (not imported - separate npm packages, no shared workspace) on
 * the frontend at Fronted-MERN/src/utils/quoteCalculations.js for the quote
 * builder's live, client-side preview. Keep both in sync if this changes.
 *
 * Per line item: Quantity * UnitPrice, reduced by Discount% - the standard
 * Salesforce QuoteLineItem formula. Quote-level Discount is also a percent
 * (applied to the line item subtotal), Tax and ShippingHandling are flat
 * currency amounts, matching the standard Quote object's field types.
 */
export const calculateLineTotal = ({ quantity = 0, unitPrice = 0, discount = 0 }) => {
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const disc = Math.min(100, Math.max(0, Number(discount) || 0));
  return qty * price * (1 - disc / 100);
};

export const calculateQuoteTotals = ({ lineItems = [], discount = 0, tax = 0, shippingHandling = 0 }) => {
  const subtotal = lineItems.reduce((sum, item) => sum + calculateLineTotal(item), 0);
  const discountPct = Math.min(100, Math.max(0, Number(discount) || 0));
  const discountAmount = subtotal * (discountPct / 100);
  const taxAmount = Number(tax) || 0;
  const shippingAmount = Number(shippingHandling) || 0;
  const grandTotal = subtotal - discountAmount + taxAmount + shippingAmount;

  return {
    subtotal,
    discountAmount,
    tax: taxAmount,
    shippingHandling: shippingAmount,
    grandTotal,
  };
};
