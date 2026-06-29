import React from 'react'

// ── Button ────────────────────────────────────────────────────────────────
const BTN = {
  primary: 'bg-orange-500 hover:bg-orange-600 text-white shadow-sm shadow-orange-500/25 hover:shadow-md hover:shadow-orange-500/30',
  indigo: 'bg-indigo-900 hover:bg-indigo-800 text-white shadow-sm hover:shadow-md',
  danger: 'bg-rose-600 hover:bg-rose-700 text-white shadow-sm hover:shadow-md hover:shadow-rose-500/30',
  white: 'bg-white hover:bg-orange-50 text-indigo-900 shadow-sm',
  ghost: 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 hover:border-slate-300 hover:shadow-sm',
  subtle: 'bg-slate-100 hover:bg-slate-200 text-slate-700',
}
export function Button({ variant = 'primary', className = '', children, ...p }) {
  // disabled:* variants have higher specificity than the base color utilities,
  // so they reliably override the variant — giving a clear greyed disabled state.
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5
        text-sm font-semibold transition-colors active:scale-[0.97]
        disabled:bg-slate-200 disabled:text-slate-400 disabled:border-transparent
        disabled:shadow-none disabled:active:scale-100 disabled:cursor-not-allowed
        ${BTN[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────
export function Card({ className = '', children, ...p }) {
  return (
    <div {...p} className={`bg-white rounded-2xl border border-slate-200/80 shadow-sm ${className}`}>
      {children}
    </div>
  )
}

// ── Badge ─────────────────────────────────────────────────────────────────
const BADGE = {
  green: 'bg-emerald-100 text-emerald-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-rose-100 text-rose-700',
  slate: 'bg-slate-100 text-slate-600',
  indigo: 'bg-indigo-100 text-indigo-700',
  saffron: 'bg-orange-100 text-orange-700',
}
export function Badge({ tone = 'slate', className = '', children }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5
      text-[11px] font-bold uppercase tracking-wide ${BADGE[tone]} ${className}`}>
      {children}
    </span>
  )
}

// ── Capacity fill bar ───────────────────────────────────────────────────────
export function FillBar({ booked, capacity, locked }) {
  const pct = capacity ? Math.min(100, Math.round((booked / capacity) * 100)) : 0
  const color = locked ? 'bg-slate-400'
    : pct >= 100 ? 'bg-rose-500'
    : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

// ── Stepper (booking wizard progress) ───────────────────────────────────────
export function Stepper({ steps, current }) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s} className="flex-1">
          <div className={`h-2 rounded-full transition-all
            ${i < current ? 'bg-orange-500' : i === current ? 'bg-orange-400' : 'bg-slate-200'}`} />
          <div className={`mt-2 text-xs font-semibold text-center
            ${i <= current ? 'text-orange-600' : 'text-slate-400'}`}>{s}</div>
        </div>
      ))}
    </div>
  )
}

// ── Stat card (admin) ───────────────────────────────────────────────────────
const STAT_TONE = {
  indigo: { text: 'text-indigo-800', bar: 'bg-indigo-500' },
  green: { text: 'text-emerald-700', bar: 'bg-emerald-500' },
  amber: { text: 'text-amber-700', bar: 'bg-amber-500' },
  red: { text: 'text-rose-700', bar: 'bg-rose-500' },
}
export function Stat({ label, value, sub, tone = 'indigo', icon }) {
  const t = STAT_TONE[tone]
  return (
    <Card className="p-5 relative overflow-hidden">
      <div className={`absolute inset-x-0 top-0 h-1 ${t.bar}`} />
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">{label}</span>
        <span className="text-lg opacity-80">{icon}</span>
      </div>
      <div className={`mt-1.5 text-4xl font-bold tabular-nums tracking-tight ${t.text}`}>{value}</div>
      {sub && <div className="text-sm text-slate-500 mt-1">{sub}</div>}
    </Card>
  )
}

// ── Skeleton (lightweight loading) ──────────────────────────────────────────
export function Skeleton({ className = '' }) {
  return <div className={`skeleton rounded-xl ${className}`} />
}

// ── Toggle switch ───────────────────────────────────────────────────────────
export function Switch({ on, onClick, disabled, onLabel = 'ON', offLabel = 'OFF', tone = 'emerald' }) {
  const onBg = tone === 'rose' ? 'bg-rose-600' : 'bg-emerald-600'
  return (
    <button onClick={onClick} disabled={disabled}
      className={`relative inline-flex h-7 w-[4.2rem] items-center rounded-full transition
        disabled:opacity-40 ${on ? onBg : 'bg-slate-300'}`}>
      <span className={`absolute text-[9px] font-bold text-white ${on ? 'left-2' : 'right-2'}`}>
        {on ? onLabel : offLabel}
      </span>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition
        ${on ? 'translate-x-[2.7rem]' : 'translate-x-1'}`} />
    </button>
  )
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 max-w-sm w-full max-h-[90dvh] overflow-y-auto pop-in"
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

// ── Spinner ─────────────────────────────────────────────────────────────────
export function Spinner({ className = '' }) {
  return (
    <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2
      border-white/40 border-t-white ${className}`} />
  )
}

// ── Empty state ─────────────────────────────────────────────────────────────
export function Empty({ icon = '📭', title, hint }) {
  return (
    <div className="text-center py-12 px-6">
      <div className="text-4xl mb-2">{icon}</div>
      <div className="font-semibold text-slate-700">{title}</div>
      {hint && <div className="text-sm text-slate-500 mt-1">{hint}</div>}
    </div>
  )
}

// "synced X ago" helper. Returns an explicit `cls` so callers never build a
// dynamic `text-${tone}-600` class (which Tailwind's JIT can't see).
const STALE_CLS = { slate: 'text-slate-500', amber: 'text-amber-600', red: 'text-rose-600' }
export function staleness(iso) {
  if (!iso) return { text: 'never synced', tone: 'red', cls: STALE_CLS.red }
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const text = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`
  const tone = secs > 120 ? 'amber' : 'slate'
  return { text, tone, cls: STALE_CLS[tone] }
}

export const VEHICLES = [
  { id: '2w', label: '2-Wheeler', icon: '🏍️' },
  { id: 'car', label: 'Car', icon: '🚗' },
  { id: 'bus', label: 'Bus', icon: '🚌' },
]
export const vehicleIcon = (v) => (VEHICLES.find((x) => x.id === v) || { icon: '🚐' }).icon
