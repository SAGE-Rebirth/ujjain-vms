import React, { useEffect, useState } from 'react'
import {
  overview, audit, setLockdown, liftLockdown, setCapacity, reconcileNoshows,
  login, getStaff, setStaff, logoutStaff,
  nodesList, nodeUp, nodeDown, parking, cpStatusAt, cpSyncAt,
  getPricing, setPricing, listOperators, addOperator, removeOperator,
} from '../api.js'
import { Card, Badge, Button, Stat, Modal, Skeleton, Spinner, Switch, staleness, vehicleIcon } from '../ui/components.jsx'

const TITLES = {
  dash: 'Live operations', parking: 'Parking map',
  capacity: 'Capacity planner', pricing: 'Pricing',
  operators: 'Gate operators', audit: 'Audit log',
}

// Command Centre is gated: only an authenticated commander reaches the console.
export default function CommandApp({ date, section }) {
  const [staff, setStaffState] = useState(getStaff())
  // Single-session: another login for this commander (or a logout) kills this
  // token. `auth:expired` fires on the next 401 → drop to the login screen with a
  // notice instead of silently failing every poll.
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const onExpired = (e) => {
      if (e.detail?.scope !== 'staff') return
      setStaffState(null); setExpired(true)
    }
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  if (!staff || staff.role !== 'commander') {
    return <CommandLogin expired={expired} onLogin={(s) => { setExpired(false); setStaffState(s) }} />
  }
  return (
    <CommandConsole date={date} section={section} staff={staff}
      onLogout={async () => { await logoutStaff(); setStaffState(null) }} />
  )
}

function CommandLogin({ onLogin, expired }) {
  const [u, setU] = useState(''); const [p, setP] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('')
    try {
      const s = await login(u.trim(), p)
      if (s.role !== 'commander') throw new Error('this portal needs a commander login')
      setStaff(s); onLogin(s)
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }
  return (
    <div className="max-w-sm mx-auto px-5 py-16 fade-up">
      <div className="text-center mb-6">
        <div className="text-4xl mb-2">🛰️</div>
        <h1 className="text-2xl font-bold text-slate-900">Command Centre</h1>
        <p className="text-sm text-slate-500 mt-1">Commander authentication required</p>
      </div>
      <Card className="p-6">
        <form onSubmit={submit} className="space-y-3">
          {expired && !err && (
            <div role="status" className="bg-amber-100 text-amber-800 rounded-xl p-3 text-sm">
              Session ended — this account was signed in on another device, or signed out.
            </div>
          )}
          {err && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3 text-sm">{err}</div>}
          <input value={u} onChange={(e) => setU(e.target.value)} placeholder="username"
            autoCapitalize="none" className="w-full border border-slate-300 rounded-xl px-4 py-3" />
          <input value={p} onChange={(e) => setP(e.target.value)} placeholder="password" type="password"
            className="w-full border border-slate-300 rounded-xl px-4 py-3" />
          <Button variant="indigo" className="w-full py-3" disabled={busy || !u || !p}>
            {busy ? <Spinner /> : 'Sign in'}
          </Button>
        </form>
        <div className="mt-4 text-xs text-slate-400 leading-relaxed border-t border-slate-100 pt-3">
          Demo accounts (pw <code className="text-slate-600">simhastha28</code>):
          <code className="text-slate-600"> commander.a</code>, <code className="text-slate-600">commander.b</code>.
          Lifting a lockdown needs <b>both</b>.
        </div>
      </Card>
    </div>
  )
}

function CommandConsole({ date, section, staff, onLogout }) {
  const [data, setData] = useState(null)
  const [logs, setLogs] = useState([])
  const [err, setErr] = useState('')
  const [confirm, setConfirm] = useState(null) // 'lock' | 'unlock'
  const [working, setWorking] = useState(false)
  const [nodes, setNodes] = useState({})       // zone_id -> { running, base, port, managed }

  // Central is the source of truth for gate processes now: it tells us which
  // zones' gates are up and on what URL, so the UI no longer hand-manages a list.
  const refreshNodes = React.useCallback(
    () => nodesList().then(setNodes).catch(() => {}), [])
  useEffect(() => {
    refreshNodes()
    const t = setInterval(() => { if (!document.hidden) refreshNodes() }, 5000)
    return () => clearInterval(t)
  }, [refreshNodes])

  useEffect(() => {
    const load = () => overview(date).then(setData).catch((e) => setErr(e.message))
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => clearInterval(t)
  }, [date])

  useEffect(() => {
    if (section !== 'audit') return
    const load = () => audit().then(setLogs).catch(() => {})
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => clearInterval(t)
  }, [section])

  const [liftScope, setLiftScope] = useState(null) // scope pending two-person lift
  const [note, setNote] = useState('')

  const refresh = () => overview(date).then(setData).catch((e) => setErr(e.message))
  const reconcile = async () => {
    setErr(''); setNote('')
    try {
      // Reclaim capacity from vehicles that never arrived, as of end of the day.
      const r = await reconcileNoshows(date, `${date}T23:59:00+00:00`)
      setNote(`Reconciled — ${r.noshow} no-show${r.noshow === 1 ? '' : 's'} marked, capacity reclaimed.`)
      refresh()
    } catch (e) { setErr(e.message) }
  }
  const act = (fn) => async () => { setErr(''); try { await fn(); refresh() } catch (e) { setErr(e.message) } }
  const runConfirm = async () => {
    setWorking(true); setErr('')
    try {
      await setLockdown('ALL', 'command-centre emergency lockdown') // activate = single commander
      refresh()
    } catch (e) { setErr(e.message) } finally { setWorking(false); setConfirm(null) }
  }

  const anyLock = data?.lockdowns?.length > 0
  if (!data) return <DashSkeleton />

  const tot = data.zones.reduce((a, z) => ({
    booked: a.booked + z.booked, arrived: a.arrived + z.arrived,
    cap: a.cap + z.capacity, locked: a.locked + (z.locked ? 1 : 0),
    synced: a.synced + (z.last_sync ? 1 : 0),
  }), { booked: 0, arrived: 0, cap: 0, locked: 0, synced: 0 })
  const allSynced = tot.synced === data.zones.length

  return (
    <div className="max-w-6xl mx-auto px-5 lg:px-8 py-8 sm:py-10 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold text-slate-900">{TITLES[section]} <span className="text-slate-400 font-medium text-lg">· {date}</span></h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500 hidden sm:inline">👤 {staff.name}</span>
          {anyLock
            ? <Button variant="ghost" onClick={() => setLiftScope('ALL')}>Lift lockdown</Button>
            : <Button variant="danger" className="px-5" onClick={() => setConfirm('lock')}>⚠ Lockdown ALL zones</Button>}
          <button onClick={onLogout} className="text-sm text-slate-400 hover:text-slate-700">sign out</button>
        </div>
      </div>

      {err && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3">{err}</div>}
      {note && <div className="bg-emerald-100 text-emerald-700 rounded-xl p-3">{note}</div>}
      {anyLock && (
        <div className="bg-rose-600 text-white rounded-2xl px-5 py-3 flex items-center justify-between pop-in">
          <span className="font-bold">🚨 LOCKDOWN ACTIVE — {data.lockdowns.map((l) => l.scope).join(', ')}</span>
          <span className="text-sm opacity-90 hidden sm:inline">passes revoked · gates deny offline</span>
        </div>
      )}

      <div key={section} className="fade-up space-y-6">
        {section === 'dash' && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Stat label="Booked" value={tot.booked} icon="🎫" tone="indigo" sub={`of ${tot.cap} capacity`} />
              <Stat label="Arrived" value={tot.arrived} icon="✅" tone="green" sub="verified at gates" />
              <Stat label="Zones locked" value={tot.locked} icon="🔒" tone={tot.locked ? 'red' : 'indigo'} sub={`of ${data.zones.length}`} />
              <Stat label="Checkpoints synced" value={`${tot.synced}/${data.zones.length}`} icon="🛰️"
                tone={allSynced ? 'green' : 'amber'} sub={allSynced ? 'all current' : 'some stale'} />
            </div>

            <div className="flex justify-end">
              <Button variant="ghost" onClick={reconcile}>♻ Reconcile no-shows</Button>
            </div>
            <Card>
              <div className="px-6 py-4 border-b border-slate-100 text-lg font-bold text-slate-800">Zones</div>
              <div className="divide-y divide-slate-100">
                {data.zones.map((z) => {
                  const s = staleness(z.last_sync)
                  return (
                    <div key={z.id} className="px-6 py-4 flex items-center gap-4">
                      <div className={`w-9 h-11 rounded-lg flex items-center justify-center text-base
                        ${z.locked ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>
                        {z.locked ? '🔒' : '🟢'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-base text-slate-800 truncate">{z.name}</div>
                        <div className="text-sm text-slate-500">sync <span className={s.cls}>{s.text}</span></div>
                      </div>
                      <div className="hidden lg:flex gap-2 text-center">
                        <Num n={z.booked} l="booked" />
                        <Num n={z.arrived} l="arrived" c="text-emerald-600" />
                        <Num n={z.capacity} l="cap" c="text-slate-400" />
                      </div>
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        <NodeControl node={nodes[z.id]} onChanged={() => { refreshNodes(); refresh() }} />
                        <ZoneSync node={nodes[z.id]} onSynced={refresh} />
                        {z.locked
                          ? <Button variant="subtle" onClick={() => setLiftScope(z.id)}>unlock</Button>
                          : <Button variant="ghost" onClick={act(() => setLockdown(z.id, 'zone closure'))}>lock</Button>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>

            <SyncAllPanel nodes={nodes} onSynced={refresh} />
          </>
        )}

        {section === 'parking' && <ParkingTab date={date} zones={data.zones} />}

        {section === 'capacity' && (
          <Card>
            <div className="px-6 py-4 border-b border-slate-100 text-lg font-bold text-slate-800">
              Set per-slot capacity for {date}
            </div>
            <div className="divide-y divide-slate-100">
              {data.zones.map((z) => <CapacityRow key={z.id} zone={z} date={date} onSaved={refresh} onErr={setErr} />)}
            </div>
          </Card>
        )}

        {section === 'pricing' && <PricingTab onErr={setErr} />}

        {section === 'operators' && <OperatorsTab zones={data.zones} onErr={setErr} />}

        {section === 'audit' && <AuditFeed logs={logs} />}
      </div>

      {confirm === 'lock' && (
        <Modal onClose={() => !working && setConfirm(null)}>
          <h3 className="font-bold text-rose-700 text-xl">Confirm full lockdown</h3>
          <p className="text-[15px] text-slate-600 my-4 leading-relaxed">
            Revokes <b>all</b> vehicle passes across every zone (VIP included) and denies
            entry even at offline gates. Emergency vehicles stay exempt. Activating is a
            single-commander action — re-opening will need two.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="subtle" disabled={working} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" disabled={working} onClick={runConfirm}>
              {working ? '…' : 'Confirm lockdown'}
            </Button>
          </div>
        </Modal>
      )}

      {liftScope && (
        <LiftModal scope={liftScope} actor={staff}
          onClose={() => setLiftScope(null)}
          onDone={() => { setLiftScope(null); refresh() }} />
      )}
    </div>
  )
}

// Two-person rule: lifting a lockdown re-opens entry during a crisis — the
// dangerous direction — so a SECOND, distinct commander must authenticate here
// (docs/AUDIT.md C2). The acting commander's token is sent automatically.
function LiftModal({ scope, actor, onClose, onDone }) {
  const [u, setU] = useState(''); const [p, setP] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const submit = async () => {
    setBusy(true); setErr('')
    try { await liftLockdown(scope, u.trim(), p); onDone() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <Modal onClose={() => !busy && onClose()}>
      <h3 className="font-bold text-indigo-900 text-xl">Lift lockdown — {scope}</h3>
      <p className="text-[15px] text-slate-600 mt-2 mb-1 leading-relaxed">
        Re-opening re-admits vehicles. This requires a <b>second commander</b> to approve.
      </p>
      <p className="text-xs text-slate-400 mb-4">Acting: {actor.name}. A different commander must sign below.</p>
      {err && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3 text-sm mb-3">{err}</div>}
      <div className="space-y-2">
        <input value={u} onChange={(e) => setU(e.target.value)} placeholder="second commander username"
          autoCapitalize="none" className="w-full border border-slate-300 rounded-xl px-4 py-2.5" />
        <input value={p} onChange={(e) => setP(e.target.value)} placeholder="their password" type="password"
          className="w-full border border-slate-300 rounded-xl px-4 py-2.5" />
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="subtle" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="indigo" disabled={busy || !u || !p} onClick={submit}>
          {busy ? '…' : 'Approve & lift'}
        </Button>
      </div>
    </Modal>
  )
}

// Detailed activity feed. The backend merges administrative actions with the gate
// decisions ingested from checkpoints, so a commander can see who did what, when,
// from which actor, and — critically — whether a gate decision was taken offline.
const CAT_TONE = {
  gate: 'green', lockdown: 'red', booking: 'indigo',
  capacity: 'amber', reconcile: 'amber', sync: 'slate', system: 'slate',
}
const FILTERS = [
  ['all', 'All'], ['gate', 'Gate decisions'], ['lockdown', 'Lockdown'],
  ['booking', 'Bookings'], ['sync', 'Sync'], ['capacity', 'Capacity'],
]
const actionTone = (l) =>
  l.action === 'gate.deny' ? 'red'
    : l.action === 'gate.exit' ? 'slate'
      : (CAT_TONE[l.category] || 'slate')

function fmtTs(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '', time: iso }
  return {
    day: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  }
}

function AuditFeed({ logs }) {
  const [filter, setFilter] = useState('all')
  const shown = filter === 'all' ? logs : logs.filter((l) => l.category === filter)
  const offlineCount = logs.filter((l) => l.offline).length

  return (
    <Card>
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-lg font-bold text-slate-800">Activity log</div>
          <div className="text-sm text-slate-500">
            {logs.length} recent event{logs.length === 1 ? '' : 's'}
            {offlineCount > 0 && <> · <span className="text-amber-600 font-semibold">{offlineCount} taken offline</span></>}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition
                ${filter === id ? 'bg-indigo-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[64vh] overflow-auto divide-y divide-slate-100">
        {shown.map((l) => {
          const t = fmtTs(l.ts)
          return (
            <div key={l.id} className="px-6 py-3 flex gap-3 items-baseline">
              <span className="text-xs text-slate-400 tabular-nums shrink-0 w-28 leading-tight">
                <span className="block font-semibold text-slate-500">{t.time}</span>
                <span className="block">{t.day}</span>
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge tone={actionTone(l)}>{l.action}</Badge>
                  {l.offline && <Badge tone="amber">offline</Badge>}
                  <span className="text-xs text-slate-400 font-mono">{l.actor}</span>
                </div>
                {l.detail && <div className="text-slate-600 text-sm mt-1 break-words">{l.detail}</div>}
              </div>
            </div>
          )
        })}
        {!shown.length && (
          <div className="px-6 py-8 text-slate-500">
            {logs.length ? 'no entries match this filter' : 'no activity yet'}
          </div>
        )}
      </div>
    </Card>
  )
}

// "Sync all gates" — fan a batch sync out to every RUNNING gate at once. The set
// of gates comes straight from central's node registry (no hand-managed URL list
// anymore). Each node still pulls only its OWN zone's delta; a gate whose uplink
// is cut is skipped (offline-first), a down gate is simply not in the list.
function SyncAllPanel({ nodes, onSynced }) {
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)
  const running = Object.values(nodes || {}).filter((n) => n.running)

  const syncAll = async () => {
    setBusy(true); setResults(null)
    const out = await Promise.all(running.map(async (n) => {
      try {
        const st = await cpStatusAt(n.base)
        if (st.network !== 'on') {
          return { zone: n.zone_id, tone: 'amber', msg: 'link cut — skipped' }
        }
        const r = await cpSyncAt(n.base)
        return { zone: n.zone_id, tone: 'green', msg: `pushed ${r.pushed} · pulled ${r.cached_bookings}` }
      } catch (e) {
        return { zone: n.zone_id, tone: 'red', msg: e.status === 409 ? 'link cut' : 'unreachable' }
      }
    }))
    setResults(out); setBusy(false); onSynced?.()
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Checkpoint sync</h2>
          <p className="text-sm text-slate-500">
            Batch-sync every running gate at once — each pulls its own zone.{' '}
            <span className="text-slate-400">{running.length} gate{running.length === 1 ? '' : 's'} up.</span>
          </p>
        </div>
        <Button className="px-5" disabled={busy || !running.length} onClick={syncAll}>
          {busy ? <Spinner /> : '🛰️ Sync all gates'}
        </Button>
      </div>

      {results && (
        <div className="mt-4 divide-y divide-slate-100">
          {results.map((r) => (
            <div key={r.zone} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="font-medium text-slate-700">{r.zone}</span>
              <Badge tone={r.tone}>{r.msg}</Badge>
            </div>
          ))}
        </div>
      )}
      {!running.length && (
        <p className="mt-3 text-sm text-slate-400">
          No gates are up. Switch a zone’s <b>GATE</b> on in the list above first.
        </p>
      )}
    </Card>
  )
}

// Per-zone gate on/off. Brings the zone's checkpoint node process up or down via
// central — so the commander never has to open a terminal. Shows the gate's port
// when running. A gate started outside (run.sh) can't be killed here (central
// reports 409) — staleness/ownership is surfaced, never faked.
function NodeControl({ node, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!node) return <span className="text-xs text-slate-300">…</span>
  const running = node.running
  const toggle = async () => {
    setBusy(true); setErr('')
    try { await (running ? nodeDown : nodeUp)(node.zone_id); onChanged?.() }
    catch (e) { setErr(e.status === 409 ? 'started elsewhere' : (e.message || 'failed')) }
    finally { setBusy(false) }
  }
  return (
    <div className="flex items-center gap-1.5" title={`gate ${node.base}`}>
      {busy
        ? <Spinner />
        : <Switch on={running} onClick={toggle} onLabel="GATE ON" offLabel="GATE OFF" />}
      <span className="text-[11px] font-mono text-slate-400 w-9 text-left">
        {running ? `:${node.port}` : err || ''}
      </span>
    </div>
  )
}

// Per-zone "sync now" — batch-sync just this zone's gate. Disabled when the gate
// is down. Never hides an offline/unreachable gate (staleness is a safety signal).
function ZoneSync({ node, onSynced }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null) // { tone, msg }
  const base = node?.base
  const up = node?.running

  const run = async () => {
    setBusy(true); setRes(null)
    try {
      const st = await cpStatusAt(base)
      if (st.network !== 'on') { setRes({ tone: 'amber', msg: 'link cut' }) }
      else {
        const r = await cpSyncAt(base)
        setRes({ tone: 'green', msg: `↑${r.pushed ?? r.ingested ?? 0} ↓${r.cached_bookings ?? 0}` })
      }
      onSynced?.()
    } catch (e) {
      setRes({ tone: 'red', msg: e.status === 409 ? 'link cut' : 'offline' })
    } finally { setBusy(false) }
  }
  return (
    <div className="flex items-center gap-2">
      {res && up && <Badge tone={res.tone}>{res.msg}</Badge>}
      <Button variant="ghost" disabled={busy || !up} onClick={run}>{busy ? <Spinner /> : '🛰️ sync'}</Button>
    </div>
  )
}

// ── Parking map — a BookMyShow-style spot grid per lot ─────────────────────
const SEAT = {
  open:       { cls: 'bg-white border-slate-200 text-slate-300', label: 'Open' },
  reserved:   { cls: 'bg-amber-100 border-amber-300 text-amber-700', label: 'Reserved' },
  parked:     { cls: 'bg-emerald-500 border-emerald-600 text-white', label: 'Parked' },
  reassigned: { cls: 'bg-violet-500 border-violet-600 text-white', label: 'Reassigned' },
}
const SEAT_LEGEND = ['open', 'reserved', 'parked', 'reassigned']

function ParkingTab({ date, zones }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [zoneId, setZoneId] = useState(zones[0]?.id)
  const [pick, setPick] = useState(null) // selected spot detail

  useEffect(() => {
    const load = () => parking(date).then(setData).catch((e) => setErr(e.message))
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => clearInterval(t)
  }, [date])

  if (err) return <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3">{err}</div>
  if (!data) return <Skeleton className="h-96" />

  const zone = data.zones.find((z) => z.id === zoneId) || data.zones[0]
  const roll = (z) => z.lots.reduce((a, l) => ({
    cap: a.cap + l.capacity,
    parked: a.parked + l.occupants.filter((o) => o.status === 'parked').length,
    reassigned: a.reassigned + l.occupants.filter((o) => o.status === 'reassigned').length,
    reserved: a.reserved + l.reserved.length,
  }), { cap: 0, parked: 0, reassigned: 0, reserved: 0 })
  const z = roll(zone)
  const open = Math.max(0, z.cap - z.parked - z.reassigned - z.reserved)

  return (
    <div className="space-y-5">
      {/* zone picker */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {data.zones.map((zz) => (
          <button key={zz.id} onClick={() => { setZoneId(zz.id); setPick(null) }}
            className={`shrink-0 rounded-xl px-3.5 py-2 text-sm font-semibold transition border
              ${zz.id === zone.id
                ? 'bg-indigo-900 text-white border-indigo-900'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {zz.name}{zz.locked && ' 🔒'}
          </button>
        ))}
      </div>

      {/* zone roll-up + legend */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
            <Roll n={z.cap} l="spaces" c="text-slate-800" />
            <Roll n={z.parked} l="parked" c="text-emerald-600" />
            <Roll n={z.reassigned} l="reassigned" c="text-violet-600" />
            <Roll n={z.reserved} l="reserved" c="text-amber-600" />
            <Roll n={open} l="open" c="text-slate-400" />
          </div>
          <div className="flex flex-wrap gap-3">
            {SEAT_LEGEND.map((k) => (
              <div key={k} className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className={`w-4 h-4 rounded border ${SEAT[k].cls}`} />{SEAT[k].label}
              </div>
            ))}
          </div>
        </div>
        {pick && (
          <div className="mt-4 pt-3 border-t border-slate-100 text-sm flex items-center gap-3 flex-wrap">
            <Badge tone={pick.status === 'reassigned' ? 'indigo' : pick.status === 'reserved' ? 'amber' : 'green'}>
              {SEAT[pick.status].label}
            </Badge>
            <span className="font-mono font-bold text-slate-800">{vehicleIcon(pick.vtype)} {pick.code}</span>
            {pick.last4 && <span className="text-slate-500">plate ···{pick.last4}</span>}
            <span className="text-slate-400">{pick.lotName}</span>
          </div>
        )}
      </Card>

      {zone.locked && (
        <div className="bg-rose-600 text-white rounded-xl px-4 py-2.5 text-sm font-semibold pop-in">
          🔒 {zone.name} is under lockdown — entry suspended.
        </div>
      )}

      {/* one "screen" block per lot */}
      <div className="space-y-4">
        {zone.lots.map((lot) => (
          <LotMap key={lot.id} lot={lot} onPick={(s) => setPick({ ...s, lotName: lot.name })} />
        ))}
      </div>
    </div>
  )
}

function LotMap({ lot, onPick }) {
  const parked = lot.occupants.filter((o) => o.status === 'parked').length
  const reassigned = lot.occupants.filter((o) => o.status === 'reassigned').length
  const used = lot.occupants.length + lot.reserved.length
  const open = Math.max(0, lot.capacity - used)
  const over = Math.max(0, used - lot.capacity)
  // Build the cell list: real occupants, then reservations, then open fillers.
  const cells = [
    ...lot.occupants.map((o) => ({ ...o })),
    ...lot.reserved.map((r) => ({ ...r, status: 'reserved' })),
    ...Array.from({ length: open }, () => ({ status: 'open' })),
  ]

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="font-semibold text-slate-800">
          {lot.name}
          {lot.primary
            ? <Badge tone="indigo" className="ml-2">primary</Badge>
            : <Badge tone="slate" className="ml-2">overflow #{lot.cascade_ord}</Badge>}
        </div>
        <div className="text-sm text-slate-500">
          <b className="text-slate-800">{used}</b>/{lot.capacity} filled
          {open > 0 && <> · {open} open</>}
          {over > 0 && <span className="text-rose-600 font-semibold"> · {over} over capacity</span>}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cells.map((c, i) => {
          const filled = c.status !== 'open'
          return (
            <button key={i} disabled={!filled}
              onClick={() => filled && onPick(c)}
              title={filled ? `${c.code} · ${c.vtype}${c.last4 ? ' ···' + c.last4 : ''}` : 'open space'}
              className={`w-7 h-7 rounded-md border text-[13px] flex items-center justify-center
                transition ${SEAT[c.status].cls} ${filled ? 'hover:scale-110 cursor-pointer' : 'cursor-default'}`}>
              {filled ? vehicleIcon(c.vtype) : ''}
            </button>
          )
        })}
        {!cells.length && <span className="text-sm text-slate-400">no spaces configured</span>}
      </div>
    </Card>
  )
}

function Roll({ n, l, c }) {
  return <div>
    <div className={`text-2xl font-bold tabular-nums ${c}`}>{n}</div>
    <div className="text-xs text-slate-500">{l}</div>
  </div>
}

function Num({ n, l, c = 'text-slate-800' }) {
  return <div className="w-14">
    <div className={`text-xl font-bold tabular-nums ${c}`}>{n}</div>
    <div className="text-xs text-slate-500">{l}</div></div>
}

function DashSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-5 lg:px-8 py-10 space-y-6">
      <Skeleton className="h-9 w-64" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      <Skeleton className="h-80" />
    </div>
  )
}

// ── Pricing planner — per-lane × per-vehicle fares, fetched + saved live ────
const PRICE_VTYPES = [['2w', '🏍 2-wheeler'], ['car', '🚗 Car'], ['bus', '🚌 Bus']]
const PRICE_LANES = [['public', 'Public'], ['vip', '⭐ VIP']]

function PricingTab({ onErr }) {
  const [pricing, setP] = useState(null)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')

  const load = () => getPricing()
    .then((r) => { setP(r.pricing); setDraft(r.pricing) })
    .catch((e) => onErr(e.message))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!pricing) return <Skeleton className="h-64" />

  const setCell = (lane, vt, val) =>
    setDraft((d) => ({ ...d, [lane]: { ...d[lane], [vt]: val } }))

  const changed = []
  for (const [lane] of PRICE_LANES) for (const [vt] of PRICE_VTYPES) {
    const v = Number(draft[lane]?.[vt])
    if (Number.isFinite(v) && v >= 0 && v !== pricing[lane]?.[vt]) {
      changed.push({ slot_type: lane, vtype: vt, price: v })
    }
  }

  const save = async () => {
    if (!changed.length) return
    setSaving(true); onErr(''); setNote('')
    try {
      const r = await setPricing(changed)
      setP(r.pricing); setDraft(r.pricing)
      setNote(`Updated ${changed.length} fare${changed.length === 1 ? '' : 's'}.`)
    } catch (e) { onErr(e.message) } finally { setSaving(false) }
  }

  return (
    <Card>
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-lg font-bold text-slate-800">Lane pricing (INR)</div>
          <div className="text-sm text-slate-500">Citizens see these fares live at booking — emergency is always free.</div>
        </div>
        {note && <Badge tone="green">{note}</Badge>}
      </div>
      <div className="p-6 overflow-x-auto">
        <table className="w-full text-sm min-w-[420px]">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="font-semibold pb-3">Vehicle</th>
              {PRICE_LANES.map(([id, label]) => <th key={id} className="font-semibold pb-3 px-3">{label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {PRICE_VTYPES.map(([vt, label]) => (
              <tr key={vt}>
                <td className="py-3 font-medium text-slate-700">{label}</td>
                {PRICE_LANES.map(([lane]) => (
                  <td key={lane} className="py-3 px-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-400">₹</span>
                      <input type="number" min="0" value={draft[lane]?.[vt] ?? ''}
                        onChange={(e) => setCell(lane, vt, e.target.value)}
                        aria-label={`${lane} ${vt} price`}
                        className="w-28 border border-slate-300 rounded-lg px-3 py-2 tabular-nums" />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end mt-5">
          <Button variant="indigo" className="px-6" disabled={saving || !changed.length} onClick={save}>
            {saving ? <Spinner /> : changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'No changes'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── Gate operators — add / list / remove zone-bound operator accounts ───────
function OperatorsTab({ zones, onErr }) {
  const [ops, setOps] = useState(null)
  const [form, setForm] = useState({
    username: '', password: '', display_name: '', zone_id: zones[0]?.id || '',
  })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = () => listOperators().then(setOps).catch((e) => onErr(e.message))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const valid = form.username.trim().length >= 3 && form.password.length >= 6
    && form.display_name.trim() && form.zone_id

  const add = async (e) => {
    e.preventDefault()
    if (!valid) return
    setBusy(true); onErr(''); setNote('')
    try {
      await addOperator({
        username: form.username.trim().toLowerCase(), password: form.password,
        display_name: form.display_name.trim(), zone_id: form.zone_id,
      })
      setNote(`Added ${form.username.trim().toLowerCase()}.`)
      setForm((f) => ({ ...f, username: '', password: '', display_name: '' }))
      load()
    } catch (e2) { onErr(e2.message) } finally { setBusy(false) }
  }
  const del = async (u) => {
    onErr('')
    try { await removeOperator(u); load() } catch (e) { onErr(e.message) }
  }

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="text-lg font-bold text-slate-800 mb-1">Add a gate operator</div>
        <p className="text-sm text-slate-500 mb-4">Creates a checkpoint login bound to one zone.</p>
        <form onSubmit={add} className="grid sm:grid-cols-2 gap-3">
          <input value={form.username} onChange={set('username')} placeholder="username (e.g. op.indore2)"
            autoCapitalize="none" className="border border-slate-300 rounded-xl px-4 py-2.5" />
          <input value={form.display_name} onChange={set('display_name')} placeholder="display name"
            className="border border-slate-300 rounded-xl px-4 py-2.5" />
          <input value={form.password} onChange={set('password')} type="password"
            placeholder="password (min 6 chars)" className="border border-slate-300 rounded-xl px-4 py-2.5" />
          <select value={form.zone_id} onChange={set('zone_id')}
            className="border border-slate-300 rounded-xl px-4 py-2.5 bg-white">
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <div className="sm:col-span-2 flex items-center justify-between gap-3">
            {note ? <Badge tone="green">{note}</Badge> : <span />}
            <Button variant="indigo" className="px-6" disabled={busy || !valid}>
              {busy ? <Spinner /> : '➕ Add operator'}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="px-6 py-4 border-b border-slate-100 text-lg font-bold text-slate-800">
          Operators {ops && <span className="text-slate-400 font-medium text-base">· {ops.length}</span>}
        </div>
        {!ops ? <Skeleton className="h-40" /> : (
          <div className="divide-y divide-slate-100">
            {ops.map((o) => (
              <div key={o.username} className="px-6 py-4 flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">🚦</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 truncate">
                    {o.display_name} <span className="font-mono text-sm text-slate-400">@{o.username}</span>
                  </div>
                  <div className="text-sm text-slate-500">{o.zone_name || o.zone_id}</div>
                </div>
                {o.online && <Badge tone="green">signed in</Badge>}
                <ConfirmDelete label={o.username} onConfirm={() => del(o.username)} />
              </div>
            ))}
            {!ops.length && <div className="px-6 py-8 text-slate-500">No operators yet — add one above.</div>}
          </div>
        )}
      </Card>
    </div>
  )
}

function ConfirmDelete({ label, onConfirm }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t) }, [armed])
  return armed ? (
    <Button variant="danger" className="px-3 py-1.5 text-sm" onClick={onConfirm} title={`Remove ${label}`}>
      Confirm
    </Button>
  ) : (
    <button onClick={() => setArmed(true)}
      className="text-sm text-slate-400 hover:text-rose-600 px-2 py-1.5">remove</button>
  )
}

function CapacityRow({ zone, date, onSaved, onErr }) {
  const [val, setVal] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const cap = Number(val)
    if (!Number.isFinite(cap) || cap < 0) return
    setSaving(true); onErr('')
    try { await setCapacity(zone.id, date, cap); setVal(''); onSaved() }
    catch (e) { onErr(e.message) } finally { setSaving(false) }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="px-6 py-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-base text-slate-800 truncate">{zone.name}</div>
        <div className="text-sm text-slate-500">now {zone.capacity} total / day</div>
      </div>
      <input value={val} onChange={(e) => setVal(e.target.value)} type="number" min="0"
        placeholder="cap/slot" aria-label={`capacity for ${zone.name}`}
        className="border border-slate-300 rounded-lg px-3 py-2 w-32 text-[15px]" />
      <Button variant="indigo" className="px-5" disabled={saving || val === ''}>{saving ? '…' : 'Apply'}</Button>
    </form>
  )
}
