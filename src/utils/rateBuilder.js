// Shared helpers for the Rate Builder module (RateBuilder.jsx + OverheadBuilder.jsx).
// Keeping these in one place avoids the two components drifting out of sync — see
// CLAUDE.md Lessons Learned L3.

export const ANNUAL_HOURS = 2080

export function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtRate(n) {
  if (n === null || n === undefined || isNaN(n)) return '—'
  return fmt(n) + '/hr'
}

export function parseNum(raw) {
  const p = parseFloat(raw)
  return raw === '' || raw === null || raw === undefined || !Number.isFinite(p) ? 0 : p
}

// Strips "$" and "," from a typed currency string.
export function parseCurrency(raw) {
  if (raw == null) return 0
  const cleaned = String(raw).replace(/[$,]/g, '').trim()
  const p = parseFloat(cleaned)
  return Number.isFinite(p) ? p : 0
}

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
