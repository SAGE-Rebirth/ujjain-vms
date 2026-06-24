import React, { useEffect, useRef, useState } from 'react'
import CitizenApp from './apps/CitizenApp.jsx'
import OperatorApp from './apps/OperatorApp.jsx'
import CommandApp from './apps/CommandApp.jsx'

export const EVENT_DATES = ['2028-04-27', '2028-04-28', '2028-05-09']

const PORTALS = [
  { id: 'citizen', icon: '🚗', title: 'Citizen', tag: 'Book & manage passes',
    desc: 'Reserve a parking slot and carry an offline-verifiable QR pass.',
    tagCls: 'text-orange-300', dot: 'bg-orange-400', halo: 'from-orange-400/40',
    ring: 'hover:border-orange-300/60',
    glow: 'hover:shadow-[0_24px_70px_-18px_rgba(249,115,22,.55)]' },
  { id: 'operator', icon: '🚦', title: 'Gate Operator', tag: 'Checkpoint console',
    desc: 'Scan & admit vehicles — works with zero internet.',
    tagCls: 'text-emerald-300', dot: 'bg-emerald-400', halo: 'from-emerald-400/40',
    ring: 'hover:border-emerald-300/60',
    glow: 'hover:shadow-[0_24px_70px_-18px_rgba(16,185,129,.5)]' },
  { id: 'command', icon: '🛰️', title: 'Command Centre', tag: 'Admin & lockdown',
    desc: 'Capacity, live operations, emergency lockdown, audit.',
    tagCls: 'text-indigo-200', dot: 'bg-indigo-300', halo: 'from-indigo-400/45',
    ring: 'hover:border-indigo-300/60',
    glow: 'hover:shadow-[0_24px_70px_-18px_rgba(129,140,248,.6)]' },
]

// Headline figures for the hero — all grounded in the brief (7 zones, ~2.5 Cr
// peak devotees, offline-first, sub-5s gate decision).
const STATS = [
  { prefix: '', value: 7, decimals: 0, suffix: '', label: 'entry zones' },
  { prefix: '', value: 2.5, decimals: 1, suffix: ' Cr', label: 'peak devotees / day' },
  { prefix: '', value: 100, decimals: 0, suffix: '%', label: 'works offline' },
  { prefix: '<', value: 5, decimals: 0, suffix: 's', label: 'admit / deny' },
]

const SECTIONS = {
  citizen: [['home', 'Home'], ['book', 'Book a slot'], ['passes', 'My Passes']],
  operator: [['scan', 'Scanner'], ['lots', 'Parking'], ['reassign', 'Reassign'], ['activity', 'Activity'], ['node', 'Node']],
  command: [['dash', 'Dashboard'], ['parking', 'Parking'], ['capacity', 'Capacity'], ['audit', 'Audit']],
}
const DEFAULT_SECTION = { citizen: 'home', operator: 'scan', command: 'dash' }
const ROLES = ['citizen', 'operator', 'command']

// Lightweight URL routing (no router dependency). The portal + section live in the
// path — `/operator/scan`, `/command/dash` — so links are deep-linkable and the
// browser back/forward buttons work. `/` is the portal picker. Vite's dev server
// and central's SPA fallback both serve index.html for these paths.
function parsePath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  const role = ROLES.includes(parts[0]) ? parts[0] : null
  if (!role) return { role: null, section: null }
  const valid = SECTIONS[role].map((s) => s[0])
  return { role, section: valid.includes(parts[1]) ? parts[1] : DEFAULT_SECTION[role] }
}

export default function App() {
  const [{ role, section }, setNav] = useState(parsePath)
  const [date, setDate] = useState(EVENT_DATES[0])

  // Reflect back/forward navigation into state.
  useEffect(() => {
    const onPop = () => setNav(parsePath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const go = (nextRole, nextSection) => {
    const s = nextRole ? (nextSection || DEFAULT_SECTION[nextRole]) : null
    const path = nextRole ? `/${nextRole}/${s}` : '/'
    if (window.location.pathname !== path) window.history.pushState({}, '', path)
    setNav({ role: nextRole, section: s })
  }
  const pickRole = (r) => go(r, DEFAULT_SECTION[r])
  const setSection = (s) => go(role, s)

  if (!role) return <Portal onPick={pickRole} />

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <NavBar role={role} date={date} setDate={setDate} section={section}
        setSection={setSection} onHome={() => go(null, null)} showDate={role !== 'operator'} />
      <main className="flex-1 w-full">
        {role === 'citizen' && <CitizenApp date={date} section={section} setSection={setSection} />}
        {role === 'operator' && <OperatorApp section={section} />}
        {role === 'command' && <CommandApp date={date} section={section} />}
      </main>
    </div>
  )
}

function NavBar({ role, date, setDate, section, setSection, onHome, showDate }) {
  const sections = SECTIONS[role]
  const Link = ({ id, label, mobile }) => {
    const active = section === id
    return (
      <button onClick={() => setSection(id)} aria-current={active ? 'page' : undefined}
        className={`whitespace-nowrap rounded-lg px-4 py-2 text-[15px] font-semibold transition
          ${active ? 'bg-orange-50 text-orange-700' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}
          ${mobile ? 'shrink-0' : ''}`}>
        {label}
      </button>
    )
  }
  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-5 lg:px-8">
        <div className="h-[68px] flex items-center gap-6">
          <button onClick={onHome} className="flex items-center gap-3 shrink-0 text-left">
            <span className="text-3xl">🛕</span>
            <span className="leading-tight">
              <span className="block font-extrabold text-slate-900 text-xl tracking-tight">
                Ujjain <span className="text-orange-600">VMS</span>
              </span>
              <span className="block text-xs text-slate-500 font-medium">Govt. of Madhya Pradesh</span>
            </span>
          </button>

          <nav className="hidden md:flex items-center gap-1 ml-2">
            {sections.map(([id, label]) => <Link key={id} id={id} label={label} />)}
          </nav>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {showDate && (
              <label className="hidden sm:flex items-center gap-2 text-sm text-slate-500">
                <span className="hidden lg:inline">Event date</span>
                <select value={date} onChange={(e) => setDate(e.target.value)}
                  className="bg-white text-slate-800 text-sm font-medium rounded-lg border border-slate-300 px-3 py-2">
                  {EVENT_DATES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            )}
            <button onClick={onHome}
              className="text-sm font-semibold text-slate-600 hover:text-slate-900 border border-slate-300
                rounded-lg px-3 py-2 hover:bg-slate-100">
              ↩ <span className="hidden sm:inline">Portals</span>
            </button>
          </div>
        </div>

        {/* mobile section nav row */}
        <nav className="md:hidden flex gap-1.5 overflow-x-auto pb-3 -mt-0.5">
          {sections.map(([id, label]) => <Link key={id} id={id} label={label} mobile />)}
        </nav>
      </div>
    </header>
  )
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => setReduced(m.matches)
    apply()
    m.addEventListener?.('change', apply)
    return () => m.removeEventListener?.('change', apply)
  }, [])
  return reduced
}

// Count up to `value` on mount (eased), honouring reduced-motion. Uses the rAF
// timestamp (no Date.now), so it's deterministic and lint-safe.
function CountUp({ value, decimals = 0, duration = 1200 }) {
  const reduced = useReducedMotion()
  const [n, setN] = useState(0)
  useEffect(() => {
    if (reduced) { setN(value); return }
    let raf, start = null
    const tick = (t) => {
      if (start === null) start = t
      const p = Math.min(1, (t - start) / duration)
      setN(value * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(tick); else setN(value)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration, reduced])
  return <>{n.toFixed(decimals)}</>
}

// Faint rotating mandala behind the hero mark — a nod to the Simhastha motif.
function Mandala({ className }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="none"
      stroke="currentColor" strokeWidth="0.6" aria-hidden="true">
      <circle cx="50" cy="50" r="47" />
      <circle cx="50" cy="50" r="36" strokeDasharray="2 3" />
      <circle cx="50" cy="50" r="24" />
      {Array.from({ length: 12 }).map((_, i) => (
        <ellipse key={i} cx="50" cy="24" rx="5.5" ry="13"
          transform={`rotate(${i * 30} 50 50)`} />
      ))}
    </svg>
  )
}

// Stylised temple skyline along the foot of the page (seven towers = seven zones).
function Skyline() {
  const towers = [
    { x: 40, w: 68, h: 66 }, { x: 180, w: 92, h: 104 }, { x: 340, w: 60, h: 58 },
    { x: 560, w: 112, h: 120 }, { x: 770, w: 70, h: 72 }, { x: 1000, w: 96, h: 106 },
    { x: 1210, w: 80, h: 88 },
  ]
  const Temple = ({ x, w, h }) => {
    const cx = x + w / 2, top = 140 - h
    return (
      <g>
        <path d={`M${x},140 L${x},${top + w * 0.45} Q${x},${top} ${cx},${top - 7}
          Q${x + w},${top} ${x + w},${top + w * 0.45} L${x + w},140 Z`} />
        <rect x={cx - 1} y={top - 16} width="2" height="10" />
        <circle cx={cx} cy={top - 18} r="2.6" />
      </g>
    )
  }
  return (
    <div className="relative pointer-events-none select-none -mb-px" aria-hidden="true">
      <svg viewBox="0 0 1440 140" preserveAspectRatio="none"
        className="w-full h-20 sm:h-28" fill="rgba(8,6,32,.55)">
        <rect x="0" y="124" width="1440" height="16" />
        {towers.map((t, i) => <Temple key={i} {...t} />)}
      </svg>
    </div>
  )
}

function Portal({ onPick }) {
  const ref = useRef(null)
  // Track the cursor for two effects: the spotlight (--mx/--my, in px) and a
  // parallax offset (--px/--py, normalised −0.5…0.5) that nudges the backdrop.
  const onMove = (e) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    el.style.setProperty('--mx', `${x}px`)
    el.style.setProperty('--my', `${y}px`)
    el.style.setProperty('--px', (x / r.width - 0.5).toFixed(3))
    el.style.setProperty('--py', (y / r.height - 0.5).toFixed(3))
  }
  // Per-card glow that follows the cursor inside the card.
  const cardMove = (e) => {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    el.style.setProperty('--cx', `${e.clientX - r.left}px`)
    el.style.setProperty('--cy', `${e.clientY - r.top}px`)
  }

  return (
    <div ref={ref} onMouseMove={onMove}
      className="relative min-h-screen bg-portal-anim text-white on-dark flex flex-col overflow-x-clip">
      {/* decorative layers (clipped, non-interactive) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 dot-grid opacity-70 parallax"
          style={{ transform: 'translate3d(calc(var(--px,0) * -16px), calc(var(--py,0) * -16px), 0)' }} />
        <div className="absolute inset-0 spotlight" />
        <div className="absolute inset-0 parallax"
          style={{ transform: 'translate3d(calc(var(--px,0) * 30px), calc(var(--py,0) * 30px), 0)' }}>
          <div className="blob w-[34rem] h-[34rem] bg-orange-500/25 -top-40 -left-40 float-slow" />
          <div className="blob w-[30rem] h-[30rem] bg-indigo-500/30 top-1/4 -right-40 float-slower" />
          <div className="blob w-[26rem] h-[26rem] bg-fuchsia-500/20 bottom-10 left-1/3 float-slow"
            style={{ animationDelay: '1.2s' }} />
        </div>
      </div>

      <div className="relative flex-1 max-w-5xl mx-auto px-6 w-full flex flex-col justify-center py-14">
        <div className="text-center mb-10">
          {/* hero mark: rotating mandala + glow + floating temple */}
          <div className="relative inline-flex items-center justify-center mb-5">
            <Mandala className="absolute w-44 h-44 text-orange-300/25 mandala" />
            <div className="absolute w-24 h-24 rounded-full bg-orange-400/40 blur-2xl glow-pulse" />
            <div className="relative text-6xl float-slow">🛕</div>
          </div>

          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 border border-white/15
            px-3.5 py-1.5 text-xs font-semibold backdrop-blur mb-5 rise-in">
            <span className="w-2 h-2 rounded-full bg-emerald-400 live-dot" />
            Offline-first vehicle entry · Simhastha 2028
          </div>

          <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tight rise-in"
            style={{ animationDelay: '60ms' }}>
            Ujjain <span className="text-gradient-saffron">VMS</span>
          </h1>
          <p className="mt-5 text-lg text-white/80 max-w-2xl mx-auto leading-relaxed rise-in"
            style={{ animationDelay: '120ms' }}>
            Vehicle entry, booked like a movie seat — and verified at the gate{' '}
            <span className="text-orange-300 font-semibold">even with no internet</span>.
          </p>

          {/* animated stat chips */}
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-3xl mx-auto">
            {STATS.map((s, i) => (
              <div key={s.label}
                className="rounded-2xl bg-white/[0.06] border border-white/10 px-4 py-3 backdrop-blur
                  hover:bg-white/[0.1] transition-colors rise-in"
                style={{ animationDelay: `${i * 80 + 180}ms` }}>
                <div className="text-2xl sm:text-3xl font-extrabold tabular-nums">
                  {s.prefix}<CountUp value={s.value} decimals={s.decimals} />{s.suffix}
                </div>
                <div className="text-[11px] sm:text-xs text-white/60 font-medium mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          <p className="mt-9 text-white/70 font-medium rise-in" style={{ animationDelay: '520ms' }}>
            Choose your portal
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          {PORTALS.map((p, i) => (
            <button key={p.id} onClick={() => onPick(p.id)} onMouseMove={cardMove}
              style={{ animationDelay: `${i * 90 + 300}ms` }}
              className={`rise-in group relative overflow-hidden text-left rounded-2xl p-7
                bg-white/[0.07] hover:bg-white/[0.12] border border-white/15 ${p.ring} ${p.glow}
                backdrop-blur-xl transition-all duration-300 hover:-translate-y-1.5`}>
              {/* cursor-following glow inside the card */}
              <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ background: 'radial-gradient(220px circle at var(--cx,50%) var(--cy,50%), rgba(255,255,255,.12), transparent 60%)' }} />
              {/* corner halo on hover */}
              <div className={`pointer-events-none absolute -top-16 -right-12 w-44 h-44 rounded-full
                bg-gradient-to-br ${p.halo} to-transparent blur-2xl
                opacity-0 group-hover:opacity-100 transition-opacity duration-500`} />
              <div className="relative">
                <div className="text-5xl mb-4 transition-transform duration-300
                  group-hover:scale-110 group-hover:-rotate-6">{p.icon}</div>
                <div className="text-xl font-bold">{p.title}</div>
                <div className={`text-xs font-semibold uppercase tracking-wider mt-1 ${p.tagCls}`}>{p.tag}</div>
                <p className="mt-3 text-[15px] text-white/70 leading-relaxed">{p.desc}</p>
                <div className="mt-5 inline-flex items-center gap-1.5 text-[15px] font-semibold
                  text-white/85 group-hover:text-white">
                  Open <span className="transition-transform duration-300 group-hover:translate-x-1">→</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <Skyline />
      <footer className="relative text-center text-white/55 text-sm pb-7">
        Phase-0 prototype · offline-first · runs with no host dependencies
      </footer>
    </div>
  )
}
