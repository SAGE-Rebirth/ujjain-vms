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

// ── Event date picker (calendar popover) ─────────────────────────────────────
// A real month-grid calendar, but only the seeded event days are selectable —
// every other day is greyed out (the backend has no slots for them). Quick chips
// jump straight to an event day even when it's in another month.
const WK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const isoOf = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const parseISO = (s) => new Date(`${s}T00:00:00`)
export function EventDatePicker({ value, dates, onChange, className = '' }) {
  const [open, setOpen] = React.useState(false)
  const allowed = React.useMemo(() => new Set(dates), [dates])
  const init = value ? parseISO(value) : new Date()
  const [view, setView] = React.useState({ y: init.getFullYear(), m: init.getMonth() })
  const ref = React.useRef(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  // Re-centre the grid on the selected month whenever the picker is opened.
  React.useEffect(() => {
    if (open && value) { const d = parseISO(value); setView({ y: d.getFullYear(), m: d.getMonth() }) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const monthName = new Date(view.y, view.m, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const firstDow = new Date(view.y, view.m, 1).getDay()
  const nDays = new Date(view.y, view.m + 1, 0).getDate()
  const move = (delta) => setView((v) => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() } })
  const pick = (iso) => { onChange(iso); setOpen(false) }
  const jump = (iso) => { const d = parseISO(iso); setView({ y: d.getFullYear(), m: d.getMonth() }); onChange(iso); setOpen(false) }

  const cells = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= nDays; d++) cells.push(d)

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}
        className="flex items-center gap-2 bg-white text-slate-800 text-xs sm:text-sm font-medium
          rounded-lg border border-slate-300 px-2.5 sm:px-3 py-2 hover:border-slate-400 transition">
        <span>📅</span><span className="tabular-nums">{value}</span>
        <span className="text-slate-400 text-[10px]">▾</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Pick event date"
          className="absolute right-0 mt-2 z-50 w-[17rem] bg-white rounded-2xl border border-slate-200 shadow-xl p-3 pop-in">
          <div className="flex items-center justify-between mb-2">
            <button onClick={() => move(-1)} aria-label="previous month"
              className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 text-lg leading-none">‹</button>
            <span className="text-sm font-bold text-slate-800">{monthName}</span>
            <button onClick={() => move(1)} aria-label="next month"
              className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-100 text-lg leading-none">›</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-slate-400 mb-1">
            {WK.map((d, i) => <div key={i}>{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />
              const iso = isoOf(view.y, view.m, d)
              const ok = allowed.has(iso)
              const sel = iso === value
              return (
                <button key={i} disabled={!ok} onClick={() => pick(iso)}
                  aria-current={sel ? 'date' : undefined}
                  className={`relative h-9 rounded-lg text-sm font-medium transition
                    ${sel ? 'bg-orange-500 text-white font-bold shadow-sm'
                      : ok ? 'text-slate-800 ring-1 ring-orange-200 hover:bg-orange-100'
                      : 'text-slate-300 cursor-not-allowed'}`}>
                  {d}
                  {ok && !sel && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-orange-500" />}
                </button>
              )
            })}
          </div>
          <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap gap-1.5">
            {dates.map((d) => (
              <button key={d} onClick={() => jump(d)}
                className={`text-[11px] px-2 py-1 rounded-md font-semibold transition
                  ${d === value ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {parseISO(d).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-2 text-center">Event days only · Simhastha 2028</p>
        </div>
      )}
    </div>
  )
}

// ── Downloadable pass (canvas → PNG) ─────────────────────────────────────────
// Renders the ticket to an offline, self-contained PNG (the QR is already a data
// URL, so nothing is fetched). Works with no network — same constraint as the gate.
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
}
export async function downloadPass(pass) {
  const qr = await loadImg(pass.qr)
  const W = 720, pad = 48, S = 2
  const details = [
    ['DATE', pass.date],
    ['WINDOW', pass.window],
    ['VEHICLE', `${pass.vtype}${pass.vcount > 1 ? ` ×${pass.vcount}` : ''}`],
    pass.pax != null ? ['PEOPLE', String(pass.pax)] : null,
    pass.plate ? ['PLATE', pass.plate + (pass.vdesc ? ` · ${pass.vdesc}` : '')] : null,
    pass.lotName ? ['PARK AT', pass.lotName] : null,
  ].filter(Boolean)
  const headerH = 172, qrSize = 300, qrBlockH = qrSize + 150
  const rowH = 70, detailH = Math.ceil(details.length / 2) * rowH + 30
  const H = headerH + qrBlockH + detailH + 30
  const c = document.createElement('canvas')
  c.width = W * S; c.height = H * S
  const x = c.getContext('2d'); x.scale(S, S)
  const half = (W - pad * 2) / 2

  x.fillStyle = '#ffffff'; x.fillRect(0, 0, W, H)
  // header band
  x.fillStyle = '#1e1b4b'; x.fillRect(0, 0, W, headerH)
  x.fillStyle = 'rgba(255,255,255,.6)'; x.font = '600 17px sans-serif'
  x.fillText('ENTRY PASS · UJJAIN VMS', pad, 48)
  x.fillStyle = '#ffffff'; x.font = '700 38px sans-serif'
  x.fillText(pass.zoneName || '', pad, 98, W - pad * 2)
  x.fillStyle = 'rgba(255,255,255,.7)'; x.font = '400 20px sans-serif'
  x.fillText((pass.road || '') + (pass.lotName ? ` · ${pass.lotName}` : ''), pad, 134, W - pad * 2)
  if (pass.slot_type === 'vip') {
    x.fillStyle = '#f59e0b'; x.font = '700 16px sans-serif'; x.textAlign = 'right'
    x.fillText('★ VIP LANE', W - pad, 48); x.textAlign = 'left'
  }
  // QR + manual code
  const qx = (W - qrSize) / 2, qy = headerH + 36
  x.drawImage(qr, qx, qy, qrSize, qrSize)
  x.textAlign = 'center'
  x.fillStyle = '#64748b'; x.font = '400 16px sans-serif'
  x.fillText('Manual code (if scan fails)', W / 2, qy + qrSize + 38)
  x.fillStyle = '#312e81'; x.font = '700 40px monospace'
  x.fillText(pass.code, W / 2, qy + qrSize + 90)
  x.textAlign = 'left'
  // details grid (two columns)
  const dy = headerH + qrBlockH + 20
  details.forEach((d, i) => {
    const cx = pad + (i % 2) * half
    const cy = dy + Math.floor(i / 2) * rowH
    x.fillStyle = '#94a3b8'; x.font = '600 13px sans-serif'; x.fillText(d[0], cx, cy)
    x.fillStyle = '#1e293b'; x.font = '600 22px sans-serif'; x.fillText(String(d[1]), cx, cy + 28, half - 12)
  })

  const a = document.createElement('a')
  a.href = c.toDataURL('image/png')
  a.download = `ujjain-pass-${pass.code}.png`
  document.body.appendChild(a); a.click(); a.remove()
}

export const VEHICLES = [
  { id: '2w', label: '2-Wheeler', icon: '🏍️' },
  { id: 'car', label: 'Car', icon: '🚗' },
  { id: 'bus', label: 'Bus', icon: '🚌' },
]
export const vehicleIcon = (v) => (VEHICLES.find((x) => x.id === v) || { icon: '🚐' }).icon
