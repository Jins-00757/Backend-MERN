/**
 * Guards against CSV/formula injection (aka "DDE injection"): a spreadsheet
 * app treats a cell starting with =, +, -, @, tab, or CR as a formula, which
 * lets an attacker-controlled Salesforce field (e.g. Opportunity Name) run
 * code when a user opens an exported CSV in Excel/Sheets. Prefixing such
 * values with a single quote forces the cell to be read as literal text.
 */
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

export const sanitizeCsvCell = (value) => {
  if (typeof value !== 'string' || value.length === 0) return value;
  return FORMULA_TRIGGER_CHARS.has(value[0]) ? `'${value}` : value;
};

export const sanitizeCsvRows = (rows) =>
  rows.map((row) => {
    const sanitized = {};
    for (const [key, value] of Object.entries(row)) {
      sanitized[key] = sanitizeCsvCell(value);
    }
    return sanitized;
  });
