// Canonical currency formatting/parsing for dollar amount fields across the
// Rate Builder module. utils/rateBuilder.js's fmt() wraps formatCurrency()
// for the common "$"-prefixed display case; call formatCurrency() directly
// wherever a "$" is already rendered separately (e.g. a fixed "$" label next
// to the input) so the sign isn't duplicated.

// Returns "1,000.00" — no "$" prefix, always 2 decimals, thousands commas.
export function formatCurrency(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0.00'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Strips "$" and "," from a typed currency string and parses it to a float.
export function parseCurrency(str) {
  if (str == null) return 0
  const cleaned = String(str).replace(/[$,]/g, '').trim()
  const p = parseFloat(cleaned)
  return Number.isFinite(p) ? p : 0
}
