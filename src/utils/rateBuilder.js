// Shared helpers for the Rate Builder module (RateBuilder.jsx + OverheadBuilder.jsx).
// Keeping these in one place avoids the two components drifting out of sync — see
// CLAUDE.md Lessons Learned L3.

import { formatCurrency, parseCurrency } from './currency'

export const ANNUAL_HOURS = 2080

// "$"-prefixed display for read-only calculated dollar values (Row2,
// SubtotalRow2, TotalRow2, AverageRow, etc.). Wraps the canonical
// formatCurrency() in utils/currency.js — use formatCurrency() directly
// instead when a "$" is already rendered separately, to avoid a double sign.
export function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return '$' + formatCurrency(n)
}

export function fmtRate(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return fmt(n) + '/hr'
}

export function parseNum(raw) {
  const p = parseFloat(raw)
  return raw === '' || raw === null || raw === undefined || !Number.isFinite(p) ? 0 : p
}

export { formatCurrency, parseCurrency }

// A headcount of 0 is a deliberate "no one currently billing at this rate"
// and resolves to 0; a missing/null headcount (rows from before the column
// existed) falls back to 1.
function resolveHeadcount(stack) {
  return stack.headcount == null ? 1 : Number(stack.headcount) || 0
}

// Total projected billable hours across all title stacks — each stack
// contributes headcount × target utilization % × annual hours. Used both to
// compute the Overhead $/hr inside the Overhead Line-Item Builder and to
// detect when that calculation has gone stale (utilization or headcount
// changed since it was last run).
export function projectedBillableHours(stacks) {
  return (stacks || []).reduce(
    (sum, s) => sum + resolveHeadcount(s) * ((Number(s.target_utilization_pct) || 0) / 100) * ANNUAL_HOURS,
    0,
  )
}

// Total FTE count across all title stacks — the sum of headcount, used to
// scale "per user" overhead line items (e.g. per-seat software licenses).
export function totalFteCount(stacks) {
  return (stacks || []).reduce((sum, s) => sum + resolveHeadcount(s), 0)
}
