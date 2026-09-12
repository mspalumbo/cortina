import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import OverheadBuilder from './OverheadBuilder'
import { ANNUAL_HOURS, fmt, fmtRate, parseCurrency, parseNum, projectedBillableHours } from '../../utils/rateBuilder'

const DEFAULT_ASSUMPTIONS = {
  bonus_pct: 5,
  health_welfare_annual: 18000,
  retirement_match_pct: 3,
  cell_phone_allowance: 1200,
  holiday_days: 10,
  payroll_taxes_pct: 11,
  overhead_support_pct: 5,
  overhead_profit_pct: 15,
}

const ASSUMPTION_FIELDS = [
  { key: 'bonus_pct', label: 'Bonus %', suffix: '%' },
  {
    key: 'health_welfare_annual',
    label: 'Health & Welfare ($/yr)',
    prefix: '$',
    calc: true,
    tooltip: 'Medical, dental, vision, life, disability, HSA employer cost only. Does NOT include firm insurance or workers comp — those belong in the Overhead builder.',
  },
  { key: 'retirement_match_pct', label: 'Retirement Match %', suffix: '%' },
  { key: 'cell_phone_allowance', label: 'Cell Phone ($/yr)', prefix: '$', calc: true },
  { key: 'holiday_days', label: 'Holiday Days' },
  {
    key: 'payroll_taxes_pct',
    label: 'Payroll Taxes %',
    suffix: '%',
    tooltip: 'Employer payroll taxes: FICA (7.65%) + FUTA/SUTA (~1-2%) + workers comp (~1-3%). Typically 10-12% total.',
  },
  { key: 'overhead_support_pct', label: 'Support Staff %', suffix: '%' },
  { key: 'overhead_profit_pct', label: 'Profit Target %', suffix: '%' },
]

const DOLLAR_FIELDS = ['health_welfare_annual', 'cell_phone_allowance']

// Maps a firm assumption field to the rate_cards columns that persist its
// calc-helper popover inputs, so the popover can pre-fill on reopen.
const CALC_FIELD_MAP = {
  health_welfare_annual: { amountCol: 'health_welfare_calc_amount', freqCol: 'health_welfare_calc_freq', defaultFreq: 'year' },
  cell_phone_allowance: { amountCol: 'cell_phone_calc_amount', freqCol: 'cell_phone_calc_freq', defaultFreq: 'month' },
}

const FREQUENCIES = [
  { key: 'month', label: 'Per Month', multiplier: 12 },
  { key: 'week', label: 'Per Week', multiplier: 52 },
  { key: 'pay_period', label: 'Per Pay Period', multiplier: 26 },
  { key: 'year', label: 'Per Year', multiplier: 1 },
  { key: 'hour', label: 'Per Hour', multiplier: ANNUAL_HOURS },
]

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Calculation engine — pure functions, no side effects. Runs entirely in the
// browser; the *_low/high/avg outputs are written to rate_cards afterward so
// other modules (fee builder, blended rate calc) can read them without
// re-deriving the burden math themselves.
// ---------------------------------------------------------------------------

function calcBand(salary, ptoWeeks, utilizationPct, assumptions, overheadPerHour, customItems) {
  const bonus = salary * assumptions.bonus_pct / 100
  const payrollTaxes = salary * assumptions.payroll_taxes_pct / 100
  const retirement = salary * assumptions.retirement_match_pct / 100
  const healthWelfare = assumptions.health_welfare_annual
  const cellPhone = assumptions.cell_phone_allowance
  const holidays = (salary / ANNUAL_HOURS) * assumptions.holiday_days * 8
  const ptoCost = (salary / ANNUAL_HOURS) * ptoWeeks * 40

  // CRITICAL (per CLAUDE.md spec): utilization cost is calculated on this
  // fully-loaded compensation figure, not on base salary alone.
  const totalLoadedComp = salary + bonus + payrollTaxes + retirement + healthWelfare + cellPhone + holidays + ptoCost
  const utilizationCost = totalLoadedComp * (1 - utilizationPct / 100)

  const compCustom = (customItems || []).filter((it) => (it.category || 'Compensation') === 'Compensation')
  const compCustomTotal = compCustom.reduce((sum, it) => {
    const amt = Number(it.amount) || 0
    return sum + (it.value_type === 'percent' ? (salary * amt) / 100 : amt)
  }, 0)

  const totalAnnualCost = totalLoadedComp + utilizationCost + compCustomTotal
  const costPerHour = totalAnnualCost / ANNUAL_HOURS

  const support = costPerHour * assumptions.overhead_support_pct / 100
  const profit = costPerHour * assumptions.overhead_profit_pct / 100

  const ohCustom = (customItems || []).filter((it) => it.category === 'Overhead')
  const ohCustomTotal = ohCustom.reduce((sum, it) => {
    const amt = Number(it.amount) || 0
    return sum + (it.value_type === 'percent' ? (costPerHour * amt) / 100 : amt)
  }, 0)

  const totalOverheadPerHour = (overheadPerHour || 0) + support + profit + ohCustomTotal
  const requiredRate = costPerHour + totalOverheadPerHour

  return {
    bonus, payrollTaxes, retirement, healthWelfare, cellPhone, holidays, ptoCost,
    totalLoadedComp, utilizationCost, compCustomTotal, totalAnnualCost,
    costPerHour, support, profit, ohCustomTotal, totalOverheadPerHour, requiredRate,
  }
}

function outputsFor(stack, assumptions, overheadPerHour) {
  const low = calcBand(stack.salary_low, stack.pto_weeks, stack.target_utilization_pct, assumptions, overheadPerHour, stack.custom_items)
  const high = calcBand(stack.salary_high, stack.pto_weeks, stack.target_utilization_pct, assumptions, overheadPerHour, stack.custom_items)
  const requiredRateAvg = (low.requiredRate + high.requiredRate) / 2
  return {
    low,
    high,
    requiredRateAvg,
    dbFields: {
      cost_per_hour_low: low.costPerHour,
      cost_per_hour_high: high.costPerHour,
      required_rate_low: low.requiredRate,
      required_rate_high: high.requiredRate,
      required_rate_avg: requiredRateAvg,
    },
  }
}

// ---------------------------------------------------------------------------
// Small presentational building blocks
// ---------------------------------------------------------------------------

const COL_W = 'w-28'
const SPAN_W = 'w-[232px]'

function SectionHeader({ label }) {
  return (
    <div className="bg-[#F3F4F6] text-xs font-semibold uppercase tracking-wide px-2 py-1.5 rounded mt-3 mb-1">
      {label}
    </div>
  )
}

function TableHeader() {
  return (
    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[#6B7280] border-b border-[#E5E7EB] pb-1 mb-1">
      <span className="flex-1">Item</span>
      <span className={`${COL_W} text-right`}>Low</span>
      <span className={`${COL_W} text-right`}>High</span>
    </div>
  )
}

function Row2({ label, low, high }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="flex-1 text-xs text-[#6B7280]">{label}</span>
      <span className={`${COL_W} text-xs text-right font-medium text-[#1A1A2E]`}>{low}</span>
      <span className={`${COL_W} text-xs text-right font-medium text-[#1A1A2E]`}>{high}</span>
    </div>
  )
}

function SubtotalRow2({ label, low, high }) {
  return (
    <div className="flex items-center gap-2 py-2 border-t-2 border-[#1E3D2F] font-semibold mt-1">
      <span className="flex-1 text-xs text-[#1A1A2E]">{label}</span>
      <span className={`${COL_W} text-xs text-right text-[#1A1A2E]`}>{low}</span>
      <span className={`${COL_W} text-xs text-right text-[#1A1A2E]`}>{high}</span>
    </div>
  )
}

function TotalRow2({ label, low, high }) {
  return (
    <div className="flex items-center gap-2 py-2 bg-[#1E3D2F] text-white rounded px-2 mt-2 font-semibold">
      <span className="flex-1 text-xs">{label}</span>
      <span className={`${COL_W} text-xs text-right`}>{low}</span>
      <span className={`${COL_W} text-xs text-right`}>{high}</span>
    </div>
  )
}

function AverageRow({ label, value }) {
  return (
    <div className="flex items-center gap-2 py-2 bg-[#F3F4F6] rounded px-2 mt-1 font-semibold">
      <span className="flex-1 text-xs text-[#1A1A2E]">{label}</span>
      <span className={`${SPAN_W} text-xs text-right text-[#1A1A2E]`}>{value}</span>
    </div>
  )
}

// Calculator icon — used on every "open a calc helper" button (Health &
// Welfare, Cell Phone, Overhead) so all three read as the same affordance.
function CalculatorIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="1.5" width="12" height="13" rx="1.5" />
      <rect x="4" y="3.5" width="8" height="2.5" rx="0.5" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="9" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="9" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="9" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="11.8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="11.8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="11.8" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Hover/click info tooltip for firm assumption fields whose meaning needs
// clarifying (Health & Welfare scope, Payroll Taxes composition).
function InfoTooltip({ text }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-block ml-1">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault()
          setOpen((o) => !o)
        }}
        className="w-3.5 h-3.5 inline-flex items-center justify-center rounded-full bg-[#E5E7EB] text-[#6B7280] text-[9px] font-bold leading-none align-middle"
        aria-label="More info"
      >
        i
      </button>
      {open && (
        <div className="absolute z-30 bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-56 bg-[#1A1A2E] text-white text-[11px] leading-snug rounded px-2 py-1.5 shadow-lg">
          {text}
        </div>
      )}
    </span>
  )
}

// Salary Low / Salary High input: formatted currency at rest, plain number
// while focused so the user can type normally; saves the raw value on blur.
function SalaryFieldInput({ value, onCommit }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState(String(value ?? 0))

  return (
    <input
      type={editing ? 'number' : 'text'}
      step="any"
      value={editing ? raw : fmt(value)}
      onFocus={() => {
        setRaw(String(value ?? 0))
        setEditing(true)
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={(e) => {
        setEditing(false)
        onCommit(e.target.value)
      }}
      className="w-full text-xs text-right border border-[#E5E7EB] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
    />
  )
}

// A field shared across both bands (PTO Weeks, Utilization %) — one input,
// visually spanning the LOW+HIGH region, so it can't desync between columns.
function SharedEditRow({ label, value, onCommit, suffix }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="flex-1 text-xs text-[#6B7280]">{label}</span>
      <div className={`${SPAN_W} flex items-center justify-end gap-0.5`}>
        <input
          type="number"
          step="any"
          defaultValue={value}
          onBlur={(e) => onCommit(e.target.value)}
          className="w-16 text-xs text-right border border-[#E5E7EB] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
        />
        {suffix && <span className="text-xs text-[#6B7280]">{suffix}</span>}
      </div>
    </div>
  )
}

// Calc-helper popover for Health & Welfare / Cell Phone — enters amount +
// frequency, annualizes in real time, "Use this amount" writes the annual
// total back to the firm assumption field and saves.
function CalcPopover({ amount, freq, onAmountChange, onFreqChange, onApply, onClose }) {
  const freqObj = FREQUENCIES.find((f) => f.key === freq) || FREQUENCIES[0]
  const parsedAmount = parseFloat(amount) || 0
  const annualTotal = parsedAmount * freqObj.multiplier

  return (
    <div className="absolute top-full left-0 mt-1 bg-white border border-[#E5E7EB] rounded-lg shadow-lg p-4 w-64 z-40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[#1A1A2E]">Calculate Annual Amount</span>
        <button type="button" onClick={onClose} className="text-[#6B7280] hover:text-red-600 text-sm leading-none" aria-label="Close">
          ×
        </button>
      </div>
      <label className="block text-xs text-[#6B7280] mb-1">Amount</label>
      <input
        type="number"
        step="any"
        value={amount}
        onChange={(e) => onAmountChange(e.target.value)}
        className="w-full text-sm border border-[#E5E7EB] rounded px-2 py-1 mb-2 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
      />
      <label className="block text-xs text-[#6B7280] mb-1">Frequency</label>
      <select
        value={freq}
        onChange={(e) => onFreqChange(e.target.value)}
        className="w-full text-sm border border-[#E5E7EB] rounded px-2 py-1 mb-2 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
      >
        {FREQUENCIES.map((f) => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
      <div className="text-xs text-[#1A1A2E] font-medium mb-3">
        Annual Total: {parsedAmount === 0 ? '—' : fmt(annualTotal)}
      </div>
      <button
        type="button"
        onClick={() => onApply(annualTotal)}
        className="w-full bg-[#1E3D2F] text-white text-sm px-3 py-1.5 rounded hover:bg-[#2A5240]"
      >
        Use This Amount
      </button>
    </div>
  )
}

function DollarAssumptionInput({ value, focused, onFocusField, onCommit }) {
  const [raw, setRaw] = useState(String(value ?? 0))

  return (
    <input
      type={focused ? 'number' : 'text'}
      step="any"
      value={focused ? raw : fmt(value)}
      onFocus={() => {
        setRaw(String(value ?? 0))
        onFocusField()
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={(e) => onCommit(e.target.value)}
      className="text-sm border border-[#E5E7EB] rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
    />
  )
}

const CUSTOM_ITEM_SELECT = 'text-xs border border-[#E5E7EB] rounded px-1 py-0.5 text-[#1A1A2E]'

function CustomItemRow({ item, onEditLabel, onEditAmount, onChangeType, onChangeCategory, onDelete }) {
  const isPercent = item.value_type === 'percent'

  return (
    <div className="flex items-center gap-2 py-1 w-full flex-wrap sm:flex-nowrap">
      <input
        type="text"
        defaultValue={item.label}
        onBlur={(e) => onEditLabel(item.id, e.target.value)}
        placeholder="Item description..."
        className="flex-1 min-w-0 border border-[#E5E7EB] rounded px-2 py-1 text-sm text-[#1A1A2E] placeholder-[#9CA3AF]"
      />
      <input
        key={`${item.id}-${item.amount}-${item.value_type}`}
        type="text"
        defaultValue={isPercent ? `${item.amount}%` : fmt(item.amount)}
        onBlur={(e) => onEditAmount(item.id, e.target.value)}
        className="w-24 text-xs text-right border border-[#E5E7EB] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A] text-[#1A1A2E]"
      />
      <select value={item.value_type} onChange={(e) => onChangeType(item.id, e.target.value)} className={`w-28 ${CUSTOM_ITEM_SELECT}`}>
        <option value="amount">$ Amount</option>
        <option value="percent">% of Salary</option>
      </select>
      <select value={item.category} onChange={(e) => onChangeCategory(item.id, e.target.value)} className={`w-32 ${CUSTOM_ITEM_SELECT}`}>
        <option value="Compensation">Compensation</option>
        <option value="Overhead">Overhead</option>
      </select>
      <button type="button" onClick={() => onDelete(item.id)} className="text-[#6B7280] hover:text-red-600 text-sm leading-none shrink-0" aria-label="Delete custom item">
        ×
      </button>
    </div>
  )
}

// Always-present blank row for adding a new custom item.
function CustomItemDraftRow({ onCommit }) {
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [valueType, setValueType] = useState('amount')
  const [category, setCategory] = useState('Compensation')
  const isPercent = valueType === 'percent'

  function commit() {
    const trimmedLabel = label.trim()
    const parsedAmount = isPercent ? parseNum(amount) : parseCurrency(amount)
    if (!trimmedLabel && !parsedAmount) return
    onCommit(trimmedLabel || 'Custom Item', parsedAmount, valueType, category)
    setLabel('')
    setAmount('')
    setValueType('amount')
    setCategory('Compensation')
  }

  return (
    <div
      className="flex items-center gap-2 py-1 w-full flex-wrap sm:flex-nowrap"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) commit()
      }}
    >
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Add custom item..."
        className="flex-1 min-w-0 border border-[#E5E7EB] rounded px-2 py-1 text-sm text-[#1A1A2E] placeholder-[#9CA3AF]"
      />
      <input
        type="text"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={isPercent ? '% of salary' : '$0.00'}
        className="w-24 text-xs text-right border border-dashed border-[#E5E7EB] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A] text-[#6B7280]"
      />
      <select value={valueType} onChange={(e) => setValueType(e.target.value)} className={`w-28 ${CUSTOM_ITEM_SELECT}`}>
        <option value="amount">$ Amount</option>
        <option value="percent">% of Salary</option>
      </select>
      <select value={category} onChange={(e) => setCategory(e.target.value)} className={`w-32 ${CUSTOM_ITEM_SELECT}`}>
        <option value="Compensation">Compensation</option>
        <option value="Overhead">Overhead</option>
      </select>
      <span className="w-[14px] shrink-0" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-title-stack cost build-up card
// ---------------------------------------------------------------------------

function StackCard({ stack, firmAssumptions, overheadPerHour, canDelete, onFieldBlur, onDelete, onAddCustomItem, onEditCustomLabel, onEditCustomAmount, onChangeCustomType, onChangeCustomCategory, onDeleteCustomItem }) {
  const { low, high, requiredRateAvg } = outputsFor(stack, firmAssumptions, overheadPerHour)
  const healthy = Number(stack.billable_rate ?? 0) >= requiredRateAvg

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-b-lg rounded-tr-lg p-4 max-w-2xl">
      <div className="flex items-center justify-between gap-1 mb-2">
        <input
          type="text"
          defaultValue={stack.notes ?? ''}
          onBlur={(e) => onFieldBlur(stack.rate_id, 'notes', e.target.value, true)}
          className="text-sm font-semibold text-[#1A1A2E] border-b border-transparent hover:border-[#E5E7EB] focus:border-[#F2903A] focus:outline-none flex-1 min-w-0 py-0.5"
        />
        {canDelete && (
          <button type="button" onClick={() => onDelete(stack.rate_id)} className="text-[#6B7280] hover:text-red-600 text-lg leading-none shrink-0" aria-label="Delete title stack">
            ×
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mb-3">
        <label className="text-xs text-[#6B7280]">Headcount</label>
        <input
          type="number"
          min="0"
          step="1"
          defaultValue={stack.headcount ?? 1}
          onBlur={(e) => onFieldBlur(stack.rate_id, 'headcount', e.target.value)}
          className="w-16 text-xs text-right border border-[#E5E7EB] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
        />
        <span className="text-xs text-[#6B7280]">FTE currently billing at this rate</span>
      </div>

      <SectionHeader label="Compensation" />
      <TableHeader />

      <div className="flex items-center gap-2 py-1">
        <span className="flex-1 text-xs text-[#6B7280]">Salary Low / Salary High</span>
        <div className={COL_W}>
          <SalaryFieldInput value={stack.salary_low} onCommit={(v) => onFieldBlur(stack.rate_id, 'salary_low', v)} />
        </div>
        <div className={COL_W}>
          <SalaryFieldInput value={stack.salary_high} onCommit={(v) => onFieldBlur(stack.rate_id, 'salary_high', v)} />
        </div>
      </div>

      <Row2 label={`Bonus (${firmAssumptions.bonus_pct}%)`} low={fmt(low.bonus)} high={fmt(high.bonus)} />
      <Row2 label={`Payroll Taxes (${firmAssumptions.payroll_taxes_pct}%)`} low={fmt(low.payrollTaxes)} high={fmt(high.payrollTaxes)} />
      <Row2 label={`Retirement Match (${firmAssumptions.retirement_match_pct}%)`} low={fmt(low.retirement)} high={fmt(high.retirement)} />
      <Row2 label="Health & Welfare" low={fmt(firmAssumptions.health_welfare_annual)} high={fmt(firmAssumptions.health_welfare_annual)} />
      <Row2 label="Cell Phone" low={fmt(firmAssumptions.cell_phone_allowance)} high={fmt(firmAssumptions.cell_phone_allowance)} />
      <Row2 label={`Holidays (${firmAssumptions.holiday_days} days)`} low={fmt(low.holidays)} high={fmt(high.holidays)} />
      <SharedEditRow label="PTO Weeks" value={stack.pto_weeks} onCommit={(v) => onFieldBlur(stack.rate_id, 'pto_weeks', v)} />
      <Row2 label="PTO Cost" low={fmt(low.ptoCost)} high={fmt(high.ptoCost)} />
      <SharedEditRow label="Utilization %" value={stack.target_utilization_pct} suffix="%" onCommit={(v) => onFieldBlur(stack.rate_id, 'target_utilization_pct', v)} />
      <Row2 label="Utilization Cost" low={fmt(low.utilizationCost)} high={fmt(high.utilizationCost)} />

      <SubtotalRow2 label="Total Annual Cost" low={fmt(low.totalAnnualCost)} high={fmt(high.totalAnnualCost)} />

      <SectionHeader label="Overhead" />
      <TableHeader />
      <Row2 label="Overhead $/hr" low={fmt(overheadPerHour)} high={fmt(overheadPerHour)} />
      <Row2 label={`Support Staff (${firmAssumptions.overhead_support_pct}%)`} low={fmt(low.support)} high={fmt(high.support)} />
      <Row2 label={`Profit (${firmAssumptions.overhead_profit_pct}%)`} low={fmt(low.profit)} high={fmt(high.profit)} />

      <SubtotalRow2 label="Total Overhead/Hr" low={fmt(low.totalOverheadPerHour)} high={fmt(high.totalOverheadPerHour)} />

      <SectionHeader label="Rate Calculation" />
      <TableHeader />
      <Row2 label="Total Annual Cost" low={fmt(low.totalAnnualCost)} high={fmt(high.totalAnnualCost)} />
      <Row2 label="Billable Hours" low={`${ANNUAL_HOURS.toLocaleString('en-US')} hrs`} high={`${ANNUAL_HOURS.toLocaleString('en-US')} hrs`} />
      <Row2 label="Cost Per Hour" low={fmt(low.costPerHour)} high={fmt(high.costPerHour)} />
      <Row2 label="+ Total Overhead/Hr" low={fmt(low.totalOverheadPerHour)} high={fmt(high.totalOverheadPerHour)} />

      <TotalRow2 label="Required Rate" low={fmt(low.requiredRate)} high={fmt(high.requiredRate)} />
      <AverageRow label="Required Rate (Avg)" value={fmt(requiredRateAvg)} />

      <div className="mt-3 pt-2 border-t border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-[#6B7280]">Published Rate</span>
          <div className={`${SPAN_W} flex items-center justify-end gap-0.5`}>
            <span className={`text-xs font-semibold ${healthy ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>$</span>
            <input
              type="number"
              step="any"
              defaultValue={stack.billable_rate}
              onBlur={(e) => onFieldBlur(stack.rate_id, 'billable_rate', e.target.value)}
              className={`w-20 text-xs text-right font-semibold border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[#F2903A] ${
                healthy ? 'text-[#10B981] border-green-200' : 'text-[#EF4444] border-red-200'
              }`}
            />
          </div>
        </div>
        <div className={`text-xs mt-1 text-right ${healthy ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
          {healthy ? 'Covered' : 'Below Required'}
        </div>
      </div>

      <SectionHeader label="Custom Items" />
      {(stack.custom_items || []).map((item) => (
        <CustomItemRow
          key={item.id}
          item={item}
          onEditLabel={(id, v) => onEditCustomLabel(stack.rate_id, id, v)}
          onEditAmount={(id, v) => onEditCustomAmount(stack.rate_id, id, v)}
          onChangeType={(id, v) => onChangeCustomType(stack.rate_id, id, v)}
          onChangeCategory={(id, v) => onChangeCustomCategory(stack.rate_id, id, v)}
          onDelete={(id) => onDeleteCustomItem(stack.rate_id, id)}
        />
      ))}
      <CustomItemDraftRow onCommit={(label, amount, valueType, category) => onAddCustomItem(stack.rate_id, label, amount, valueType, category)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RateBuilder() {
  const [stacks, setStacks] = useState([])
  const [selectedRateId, setSelectedRateId] = useState(null)
  const [firmAssumptions, setFirmAssumptions] = useState(DEFAULT_ASSUMPTIONS)
  const [overheadData, setOverheadData] = useState({ items: [], calculated_rate: 0, calculated_hours: 0, calculated_total: 0 })
  const [firmSettingsId, setFirmSettingsId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showOverheadModal, setShowOverheadModal] = useState(false)
  const [popoverField, setPopoverField] = useState(null)
  const [popoverAmount, setPopoverAmount] = useState('')
  const [popoverFreq, setPopoverFreq] = useState('month')
  const [focusedField, setFocusedField] = useState(null)
  const popoverRef = useRef(null)

  useEffect(() => {
    fetchAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!popoverField) return
    function handleDocClick(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setPopoverField(null)
    }
    document.addEventListener('mousedown', handleDocClick)
    return () => document.removeEventListener('mousedown', handleDocClick)
  }, [popoverField])

  async function fetchAll() {
    setLoading(true)
    await Promise.all([fetchStacks(), fetchFirmSettings()])
    setLoading(false)
  }

  async function fetchStacks() {
    const { data, error } = await supabase
      .from('rate_cards')
      .select('*')
      .eq('rate_type', 'Role-Based')
      .order('sort_order', { ascending: true })

    if (error) {
      console.error('Error fetching title stacks:', error)
      return []
    }

    const rows = data || []
    setStacks(rows)

    setSelectedRateId((prev) => {
      if (rows.length === 0) return null
      if (prev && rows.some((s) => s.rate_id === prev)) return prev
      return rows[0].rate_id
    })

    if (rows.length > 0) {
      const first = rows[0]
      setFirmAssumptions({
        bonus_pct: first.bonus_pct ?? DEFAULT_ASSUMPTIONS.bonus_pct,
        health_welfare_annual: first.health_welfare_annual ?? DEFAULT_ASSUMPTIONS.health_welfare_annual,
        retirement_match_pct: first.retirement_match_pct ?? DEFAULT_ASSUMPTIONS.retirement_match_pct,
        cell_phone_allowance: first.cell_phone_allowance ?? DEFAULT_ASSUMPTIONS.cell_phone_allowance,
        holiday_days: first.holiday_days ?? DEFAULT_ASSUMPTIONS.holiday_days,
        payroll_taxes_pct: first.payroll_taxes_pct ?? DEFAULT_ASSUMPTIONS.payroll_taxes_pct,
        overhead_support_pct: first.overhead_support_pct ?? DEFAULT_ASSUMPTIONS.overhead_support_pct,
        overhead_profit_pct: first.overhead_profit_pct ?? DEFAULT_ASSUMPTIONS.overhead_profit_pct,
        health_welfare_calc_amount: first.health_welfare_calc_amount,
        health_welfare_calc_freq: first.health_welfare_calc_freq,
        cell_phone_calc_amount: first.cell_phone_calc_amount,
        cell_phone_calc_freq: first.cell_phone_calc_freq,
      })
    }

    return rows
  }

  async function fetchFirmSettings() {
    const { data, error } = await supabase
      .from('firm_settings')
      .select('id, overhead_line_items')
      .limit(1)
      .single()

    if (error) {
      console.error('Error fetching firm settings:', error)
      return
    }

    setFirmSettingsId(data.id)
    setOverheadData(data.overhead_line_items || { items: [], calculated_rate: 0, calculated_hours: 0, calculated_total: 0 })
  }

  const overheadPerHour = overheadData.calculated_rate || 0
  const currentProjectedHours = projectedBillableHours(stacks)
  const isOverheadStale =
    stacks.length > 0 &&
    overheadData.calculated_hours != null &&
    Math.abs(currentProjectedHours - overheadData.calculated_hours) > 0.5

  // Recalculates and saves cost_per_hour_*/required_rate_* for every stack —
  // used whenever a firm-wide input changes (assumption, overhead $/hr).
  async function recalcAllStacks(assumptions, ohPerHour, sourceStacks = stacks) {
    await Promise.all(
      sourceStacks.map((s) => {
        const { dbFields } = outputsFor(s, assumptions, ohPerHour)
        return supabase.from('rate_cards').update(dbFields).eq('rate_id', s.rate_id)
      }),
    )
  }

  // Title-specific field blur (salary_low, salary_high, pto_weeks,
  // target_utilization_pct, billable_rate, notes).
  async function handleStackFieldBlur(rateId, field, raw, isText = false) {
    let value
    if (isText) {
      value = raw.trim()
    } else if (field === 'headcount') {
      const parsed = parseInt(raw, 10)
      value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
    } else {
      value = parseNum(raw)
    }

    let updatedStack = null
    setStacks((prev) =>
      prev.map((s) => {
        if (s.rate_id !== rateId) return s
        updatedStack = { ...s, [field]: value }
        return updatedStack
      }),
    )

    if (!updatedStack) return
    const { dbFields } = outputsFor(updatedStack, firmAssumptions, overheadPerHour)
    const { error } = await supabase.from('rate_cards').update({ [field]: value, ...dbFields }).eq('rate_id', rateId)
    if (error) console.error('Error saving field:', error)
  }

  // Persists one firm assumption field (plus optional popover calc-input
  // columns) to every Role-Based row, then recalculates every stack's
  // outputs under the new assumptions. Per CLAUDE.md L14 — firm-wide fields
  // update ALL rows simultaneously.
  async function applyAssumptionValue(field, value, extraFields = {}) {
    const updatedAssumptions = { ...firmAssumptions, [field]: value }
    setFirmAssumptions(updatedAssumptions)

    const { error: bulkErr } = await supabase
      .from('rate_cards')
      .update({ [field]: value, ...extraFields })
      .eq('rate_type', 'Role-Based')
    if (bulkErr) console.error('Error saving firm assumption:', bulkErr)

    await recalcAllStacks(updatedAssumptions, overheadPerHour)
  }

  function handleAssumptionBlur(field, raw) {
    const value = DOLLAR_FIELDS.includes(field) ? parseCurrency(raw) : parseNum(raw)
    return applyAssumptionValue(field, value)
  }

  function openPopover(field) {
    setPopoverField(field)
    const calc = CALC_FIELD_MAP[field]
    if (calc) {
      const storedAmount = firmAssumptions[calc.amountCol]
      const storedFreq = firmAssumptions[calc.freqCol]
      setPopoverAmount(storedAmount != null ? String(storedAmount) : '')
      setPopoverFreq(storedFreq || calc.defaultFreq)
    } else {
      setPopoverAmount('')
      setPopoverFreq('month')
    }
  }

  async function handleCalcApply(field, annualValue) {
    const calc = CALC_FIELD_MAP[field]
    const extraFields = calc
      ? { [calc.amountCol]: parseFloat(popoverAmount) || null, [calc.freqCol]: popoverFreq }
      : {}
    await applyAssumptionValue(field, annualValue, extraFields)
    setPopoverField(null)
  }

  // Shared persist helper for all custom-item mutations.
  async function persistCustomItems(rateId, nextItems) {
    let updatedStack = null
    setStacks((prev) =>
      prev.map((s) => {
        if (s.rate_id !== rateId) return s
        updatedStack = { ...s, custom_items: nextItems }
        return updatedStack
      }),
    )
    if (!updatedStack) return
    const { dbFields } = outputsFor(updatedStack, firmAssumptions, overheadPerHour)
    const { error } = await supabase.from('rate_cards').update({ custom_items: nextItems, ...dbFields }).eq('rate_id', rateId)
    if (error) console.error('Error saving custom items:', error)
  }

  function handleAddCustomItem(rateId, label, amount, valueType, category) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const newItem = { id: crypto.randomUUID(), label, amount, value_type: valueType, category }
    persistCustomItems(rateId, [...(stack.custom_items || []), newItem])
  }

  function handleEditCustomLabel(rateId, itemId, rawLabel) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const nextItems = (stack.custom_items || []).map((it) => (it.id === itemId ? { ...it, label: rawLabel.trim() } : it))
    persistCustomItems(rateId, nextItems)
  }

  function handleEditCustomAmount(rateId, itemId, rawAmount) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const item = (stack.custom_items || []).find((it) => it.id === itemId)
    const isPercent = item?.value_type === 'percent'
    const parsed = isPercent ? parseNum(rawAmount) : parseCurrency(rawAmount)
    const nextItems = (stack.custom_items || []).map((it) => (it.id === itemId ? { ...it, amount: parsed } : it))
    persistCustomItems(rateId, nextItems)
  }

  function handleChangeCustomType(rateId, itemId, newType) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const nextItems = (stack.custom_items || []).map((it) => (it.id === itemId ? { ...it, value_type: newType } : it))
    persistCustomItems(rateId, nextItems)
  }

  function handleChangeCustomCategory(rateId, itemId, newCategory) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const nextItems = (stack.custom_items || []).map((it) => (it.id === itemId ? { ...it, category: newCategory } : it))
    persistCustomItems(rateId, nextItems)
  }

  function handleDeleteCustomItem(rateId, itemId) {
    const stack = stacks.find((s) => s.rate_id === rateId)
    if (!stack) return
    const nextItems = (stack.custom_items || []).filter((it) => it.id !== itemId)
    persistCustomItems(rateId, nextItems)
  }

  async function handleSeed() {
    setBusy(true)
    const defaults = {
      rate_type: 'Role-Based',
      effective_date: todayISO(),
      is_active: true,
      target_utilization_pct: 85,
      custom_items: [],
      headcount: 1,
      ...DEFAULT_ASSUMPTIONS,
    }

    const titleStacks = [
      { ...defaults, notes: 'Project Coordinator', role: 'Coordinator', billable_rate: 110, salary_low: 65000, salary_high: 80000, pto_weeks: 3, sort_order: 1 },
      { ...defaults, notes: 'Assistant Project Manager', role: 'PM', billable_rate: 130, salary_low: 80000, salary_high: 100000, pto_weeks: 3, sort_order: 2 },
      { ...defaults, notes: 'Project Manager', role: 'PM', billable_rate: 150, salary_low: 100000, salary_high: 120000, pto_weeks: 4, sort_order: 3 },
      { ...defaults, notes: 'Senior Project Manager', role: 'Sr-PM', billable_rate: 180, salary_low: 120000, salary_high: 144000, pto_weeks: 4, sort_order: 4 },
      { ...defaults, notes: 'Principal', role: 'Principal', billable_rate: 210, salary_low: 160000, salary_high: 200000, pto_weeks: 5, sort_order: 5 },
    ]

    const { error } = await supabase.from('rate_cards').insert(titleStacks)
    if (error) console.error('Error seeding title stacks:', error)
    else await fetchAll()
    setBusy(false)
  }

  async function handleAdd() {
    setBusy(true)
    const nextSortOrder = stacks.length > 0 ? Math.max(...stacks.map((s) => s.sort_order ?? 0)) + 1 : 1
    const newStack = {
      notes: 'New Title',
      role: 'PM',
      rate_type: 'Role-Based',
      billable_rate: 0,
      effective_date: todayISO(),
      is_active: true,
      sort_order: nextSortOrder,
      salary_low: 0,
      salary_high: 0,
      pto_weeks: 3,
      target_utilization_pct: 85,
      custom_items: [],
      headcount: 1,
      ...firmAssumptions,
    }

    const { data, error } = await supabase.from('rate_cards').insert(newStack).select().single()
    if (error) {
      console.error('Error adding title stack:', error)
      setBusy(false)
      return
    }

    await fetchAll()
    setSelectedRateId(data.rate_id)
    setBusy(false)
  }

  async function handleDelete(rateId) {
    if (stacks.length <= 1) return
    if (!window.confirm('Delete this title stack? This cannot be undone.')) return
    const idx = stacks.findIndex((s) => s.rate_id === rateId)
    const { error } = await supabase.from('rate_cards').delete().eq('rate_id', rateId)
    if (error) {
      console.error('Error deleting title stack:', error)
      return
    }
    const remaining = await fetchStacks()
    if (remaining.length === 0) {
      setSelectedRateId(null)
      return
    }
    const targetIdx = Math.min(Math.max(0, idx - 1), remaining.length - 1)
    setSelectedRateId(remaining[targetIdx].rate_id)
  }

  // Overhead builder modal closes → cache the new calculated $/hr and
  // re-save every stack's calculated outputs under it.
  async function handleOverheadClose(newOverheadData) {
    setOverheadData(newOverheadData)
    setShowOverheadModal(false)
    await recalcAllStacks(firmAssumptions, newOverheadData.calculated_rate || 0)
  }

  const selectedStack = stacks.find((s) => s.rate_id === selectedRateId) || null

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-[#1A1A2E]">Rate Builder</h1>
        <p className="text-sm text-[#6B7280] mt-1">Firm-wide burden assumptions and per-title rate stacks.</p>
      </div>

      {/* Section 1 — Firm Assumptions */}
      <div className="bg-white border border-[#E5E7EB] rounded-lg p-4 mb-6">
        <div className="text-xs font-semibold text-[#6B7280] uppercase tracking-wide mb-3">Firm Assumptions</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
          {ASSUMPTION_FIELDS.map((f) => {
            const isDollar = DOLLAR_FIELDS.includes(f.key)
            return (
              <div key={f.key} className="relative">
                <label className="flex items-center text-xs text-[#6B7280] uppercase tracking-wide mb-1">
                  {f.label}
                  {f.tooltip && <InfoTooltip text={f.tooltip} />}
                </label>
                <div className="flex items-center gap-1">
                  {f.prefix && <span className="text-sm text-[#6B7280]">{f.prefix}</span>}
                  {isDollar ? (
                    <DollarAssumptionInput
                      value={firmAssumptions[f.key]}
                      focused={focusedField === f.key}
                      onFocusField={() => setFocusedField(f.key)}
                      onCommit={(raw) => {
                        setFocusedField(null)
                        handleAssumptionBlur(f.key, raw)
                      }}
                    />
                  ) : (
                    <input
                      key={`${f.key}-${firmAssumptions[f.key]}`}
                      type="number"
                      step="any"
                      defaultValue={firmAssumptions[f.key]}
                      onBlur={(e) => handleAssumptionBlur(f.key, e.target.value)}
                      className="text-sm border border-[#E5E7EB] rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
                    />
                  )}
                  {f.suffix && <span className="text-sm text-[#6B7280]">{f.suffix}</span>}
                  {f.calc && (
                    <button
                      type="button"
                      onClick={() => openPopover(f.key)}
                      className="shrink-0 w-6 h-6 flex items-center justify-center rounded border border-[#E5E7EB] text-[#6B7280] hover:text-[#F2903A] hover:border-[#F2903A]"
                      aria-label="Calculate from amount + frequency"
                      title="Calculate from amount + frequency"
                    >
                      <CalculatorIcon />
                    </button>
                  )}
                </div>
                {popoverField === f.key && (
                  <div ref={popoverRef}>
                    <CalcPopover
                      amount={popoverAmount}
                      freq={popoverFreq}
                      onAmountChange={setPopoverAmount}
                      onFreqChange={setPopoverFreq}
                      onApply={(value) => handleCalcApply(f.key, value)}
                      onClose={() => setPopoverField(null)}
                    />
                  </div>
                )}
              </div>
            )
          })}

          {/* Overhead $/hr — calculated output, opens the line-item builder */}
          <div>
            <label className="block text-xs text-[#6B7280] uppercase tracking-wide mb-1">Overhead ($/hr)</label>
            <div className="flex items-center gap-1">
              <div className="flex-1 text-sm border border-[#E5E7EB] rounded px-2 py-1 text-[#1A1A2E] bg-white">
                {fmtRate(overheadPerHour)}
              </div>
              <button
                type="button"
                onClick={() => setShowOverheadModal(true)}
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded border border-[#E5E7EB] text-[#6B7280] hover:text-[#F2903A] hover:border-[#F2903A]"
                aria-label="Open overhead line-item builder"
                title="Open overhead line-item builder"
              >
                <CalculatorIcon />
              </button>
            </div>
            {isOverheadStale && (
              <div className="mt-1 text-[10px] text-[#F59E0B] font-medium">Utilization changed — recalculate</div>
            )}
          </div>
        </div>
      </div>

      {/* Section 2 — Title Stacks (tabbed) */}
      {loading ? (
        <div className="text-sm text-[#6B7280]">Loading...</div>
      ) : stacks.length === 0 ? (
        <div className="bg-white border border-[#E5E7EB] rounded-lg p-6 text-center py-12">
          <p className="text-sm text-[#6B7280] mb-4">No title stacks found. Set up your standard rate stacks to get started.</p>
          <button
            onClick={handleSeed}
            disabled={busy}
            className="bg-[#1E3D2F] text-white px-4 py-2 rounded text-sm hover:bg-[#2A5240] transition-colors disabled:opacity-40"
          >
            Set Up Standard Title Stacks
          </button>
        </div>
      ) : (
        <div>
          <div className="flex items-end gap-1 overflow-x-auto">
            {stacks.map((s) => {
              const active = s.rate_id === selectedRateId
              return (
                <button
                  key={s.rate_id}
                  type="button"
                  onClick={() => setSelectedRateId(s.rate_id)}
                  title={s.notes || 'Untitled'}
                  className={`shrink-0 max-w-[160px] truncate rounded-t px-4 py-2 text-sm ${
                    active ? 'bg-[#1E3D2F] text-white font-medium' : 'bg-[#F3F4F6] text-[#6B7280] cursor-pointer hover:bg-[#E5E7EB]'
                  }`}
                >
                  {s.notes || 'Untitled'}
                </button>
              )
            })}
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy}
              className="shrink-0 bg-[#F3F4F6] text-[#6B7280] rounded-t px-4 py-2 text-sm hover:bg-[#E5E7EB] disabled:opacity-40"
              aria-label="Add title stack"
            >
              +
            </button>
          </div>

          {selectedStack && (
            <StackCard
              key={selectedStack.rate_id}
              stack={selectedStack}
              firmAssumptions={firmAssumptions}
              overheadPerHour={overheadPerHour}
              canDelete={stacks.length > 1}
              onFieldBlur={handleStackFieldBlur}
              onDelete={handleDelete}
              onAddCustomItem={handleAddCustomItem}
              onEditCustomLabel={handleEditCustomLabel}
              onEditCustomAmount={handleEditCustomAmount}
              onChangeCustomType={handleChangeCustomType}
              onChangeCustomCategory={handleChangeCustomCategory}
              onDeleteCustomItem={handleDeleteCustomItem}
            />
          )}
        </div>
      )}

      {showOverheadModal && (
        <OverheadBuilder stacks={stacks} onClose={handleOverheadClose} />
      )}
    </div>
  )
}
