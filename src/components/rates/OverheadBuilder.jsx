import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { fmt, fmtRate, projectedBillableHours } from '../../utils/rateBuilder'

// Pre-populated categories + default line items — used only when
// firm_settings.overhead_line_items has no items yet.
const CATEGORY_DEFS = [
  { key: 'Facilities & Operations', defaults: ['Office Rent', 'Utilities', 'Office Supplies'] },
  { key: 'Insurance', defaults: ['GL Insurance', 'Professional Liability/E&O', 'Workers Comp (firm policy)'] },
  { key: 'Technology & Software', defaults: ['Software Licenses', 'IT Support'] },
  { key: 'People & Administrative', defaults: ['Professional Development', 'Conferences & Memberships'] },
  { key: 'Other', defaults: ['Accounting & Bookkeeping', 'Legal Fees'] },
]

// Frequency options for overhead line items — separate (smaller) set than the
// firm-assumption calc popovers, per spec: Week / Month / Year only.
const ITEM_FREQUENCIES = [
  { key: 'week', label: 'Per Week', multiplier: 52 },
  { key: 'month', label: 'Per Month', multiplier: 12 },
  { key: 'year', label: 'Per Year', multiplier: 1 },
]

function annualize(inputAmount, freqKey) {
  const freqObj = ITEM_FREQUENCIES.find((f) => f.key === freqKey) || ITEM_FREQUENCIES[1]
  return (Number(inputAmount) || 0) * freqObj.multiplier
}

function buildDefaultItems() {
  const items = []
  for (const cat of CATEGORY_DEFS) {
    for (const label of cat.defaults) {
      items.push({
        id: crypto.randomUUID(),
        category: cat.key,
        label,
        notes: '',
        active: true,
        input_amount: 0,
        input_freq: 'month',
        annual_amount: 0,
      })
    }
  }
  return items
}

// Backfills items saved before the frequency selector existed — an item with
// annual_amount (or the old flat `amount` field) but no input_amount/input_freq
// displays that figure in the amount field with Per Year selected.
function normalizeItem(item) {
  if (item.input_amount != null && item.input_freq) {
    return { ...item, annual_amount: item.annual_amount ?? annualize(item.input_amount, item.input_freq) }
  }
  const annual = item.annual_amount ?? item.amount ?? 0
  return { ...item, input_amount: annual, input_freq: 'year', annual_amount: annual }
}

function LineItemRow({ item, onChange, onDelete }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 py-1">
      <input
        type="checkbox"
        checked={item.active}
        onChange={(e) => onChange({ active: e.target.checked })}
        className="shrink-0 w-4 h-4"
        aria-label={`${item.label || 'Line item'} active`}
      />
      <input
        type="text"
        value={item.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Line item"
        className={`flex-1 min-w-0 border border-[#E5E7EB] rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#F2903A] ${
          item.active ? 'text-[#1A1A2E]' : 'text-[#9CA3AF] line-through'
        }`}
      />
      <div className="flex items-center gap-1 shrink-0 flex-wrap">
        <span className="text-xs text-[#6B7280]">$</span>
        <input
          type="number"
          step="any"
          value={item.input_amount}
          onChange={(e) => onChange({ input_amount: parseFloat(e.target.value) || 0 })}
          className="w-20 text-sm text-right border border-[#E5E7EB] rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
        />
        <select
          value={item.input_freq}
          onChange={(e) => onChange({ input_freq: e.target.value })}
          className="text-xs border border-[#E5E7EB] rounded px-1 py-1.5 text-[#1A1A2E] focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
        >
          {ITEM_FREQUENCIES.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
        <span className="text-xs text-[#6B7280] whitespace-nowrap">= {fmt(item.annual_amount)}/yr</span>
      </div>
      <input
        type="text"
        value={item.notes || ''}
        onChange={(e) => onChange({ notes: e.target.value })}
        placeholder="Notes (optional)"
        className="flex-1 min-w-0 sm:max-w-[10rem] border border-[#E5E7EB] rounded px-2 py-1 text-xs text-[#6B7280] focus:outline-none focus:ring-1 focus:ring-[#F2903A]"
      />
      <button
        type="button"
        onClick={onDelete}
        className="text-[#6B7280] hover:text-red-600 text-base leading-none shrink-0 px-1"
        aria-label="Delete line item"
      >
        ×
      </button>
    </div>
  )
}

// Modal — opens over the Rate Builder page. Fetches overhead_line_items from
// firm_settings on mount, pre-populating defaults if none exist yet. All edits
// are local until Close, which persists the full item list plus the
// calculated $/hr back to firm_settings and hands the result to the parent.
export default function OverheadBuilder({ stacks, onClose }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [firmSettingsId, setFirmSettingsId] = useState(null)
  const [items, setItems] = useState([])

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchData() {
    setLoading(true)
    const { data, error } = await supabase
      .from('firm_settings')
      .select('id, overhead_line_items')
      .limit(1)
      .single()

    if (error) {
      console.error('Error fetching firm settings:', error)
      setLoading(false)
      return
    }

    setFirmSettingsId(data.id)
    const existing = data.overhead_line_items?.items
    setItems(existing && existing.length > 0 ? existing.map(normalizeItem) : buildDefaultItems())
    setLoading(false)
  }

  // Recomputes annual_amount whenever the amount or frequency changes, so the
  // stored figure is always the calculated annual total.
  function updateItem(id, patch) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it
        const next = { ...it, ...patch }
        if ('input_amount' in patch || 'input_freq' in patch) {
          next.annual_amount = annualize(next.input_amount, next.input_freq)
        }
        return next
      }),
    )
  }

  function deleteItem(id) {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  function addItem(category) {
    setItems((prev) => [
      ...prev,
      { id: crypto.randomUUID(), category, label: '', notes: '', active: true, input_amount: 0, input_freq: 'month', annual_amount: 0 },
    ])
  }

  const totalAnnualOverhead = items.filter((it) => it.active).reduce((sum, it) => sum + (Number(it.annual_amount) || 0), 0)
  const billableHours = projectedBillableHours(stacks)
  const calculatedRate = billableHours > 0 ? totalAnnualOverhead / billableHours : 0

  async function handleClose() {
    setSaving(true)
    const payload = {
      items,
      calculated_rate: calculatedRate,
      calculated_hours: billableHours,
      calculated_total: totalAnnualOverhead,
    }
    if (firmSettingsId) {
      const { error } = await supabase
        .from('firm_settings')
        .update({ overhead_line_items: payload })
        .eq('id', firmSettingsId)
      if (error) console.error('Error saving overhead line items:', error)
    }
    setSaving(false)
    onClose(payload)
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, firmSettingsId])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[#E5E7EB] sticky top-0 bg-white z-10">
          <h2 className="text-base font-semibold text-[#1A1A2E]">Overhead Line-Item Builder</h2>
          <button
            type="button"
            onClick={handleClose}
            className="text-[#6B7280] hover:text-[#1A1A2E] text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-4 sm:px-6 py-4">
          {loading ? (
            <div className="text-sm text-[#6B7280]">Loading...</div>
          ) : (
            CATEGORY_DEFS.map((cat) => {
              const catItems = items.filter((it) => it.category === cat.key)
              return (
                <div key={cat.key} className="mb-5">
                  <div className="bg-[#F3F4F6] text-xs font-semibold uppercase tracking-wide px-2 py-1.5 rounded mb-2">
                    {cat.key}
                  </div>
                  <div className="space-y-1.5">
                    {catItems.map((it) => (
                      <LineItemRow
                        key={it.id}
                        item={it}
                        onChange={(patch) => updateItem(it.id, patch)}
                        onDelete={() => deleteItem(it.id)}
                      />
                    ))}
                    {catItems.length === 0 && (
                      <div className="text-xs text-[#6B7280] italic py-1">No items in this category.</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => addItem(cat.key)}
                    className="mt-2 text-xs text-[#1E3D2F] hover:text-[#F2903A] font-medium"
                  >
                    + Add item
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="px-4 sm:px-6 py-4 border-t border-[#E5E7EB] bg-[#F8F9FA] sticky bottom-0">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex flex-col sm:flex-row flex-wrap gap-x-6 gap-y-1 text-xs text-[#6B7280]">
              <span>
                Total Annual Overhead: <span className="font-semibold text-[#1A1A2E]">{fmt(totalAnnualOverhead)}</span>
              </span>
              <span>
                Projected Billable Hours:{' '}
                <span className="font-semibold text-[#1A1A2E]">
                  {billableHours.toLocaleString('en-US', { maximumFractionDigits: 0 })} hrs
                </span>
              </span>
              <span>
                Calculated Overhead: <span className="font-semibold text-[#1E3D2F]">{fmtRate(calculatedRate)}</span>
              </span>
            </div>
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="bg-[#1E3D2F] text-white text-sm px-4 py-2 rounded hover:bg-[#2A5240] disabled:opacity-50 shrink-0"
            >
              {saving ? 'Saving...' : 'Close & Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
