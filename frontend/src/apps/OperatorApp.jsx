import React, { useEffect, useState } from 'react'
import {
  cpStatus, cpLog, cpVerify, cpNetwork, cpDenyAll, cpSync, cpLots, cpParked, cpReassign, cpExit,
  getCheckpointBase, setCheckpointBase,
} from '../api.js'
import { Card, Badge, Button, Switch, Spinner, FillBar, staleness, vehicleIcon } from '../ui/components.jsx'
import QrScanner from '../ui/QrScanner.jsx'

export default function OperatorApp({ section }) {
  const [status, setStatus] = useState(null)
  const [reachable, setReachable] = useState(null) // null=unknown, false=node down
  const [log, setLog] = useState([])
  const [lots, setLots] = useState([])
  const [parked, setParked] = useState([])
  const [token, setToken] = useState('')
  const [code, setCode] = useState('')
  const [observed, setObserved] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [base, setBase] = useState(getCheckpointBase())
  const [scanning, setScanning] = useState(false)   // camera QR scanner on/off

  const refresh = () => {
    cpStatus().then((s) => { setStatus(s); setReachable(true) }).catch(() => setReachable(false))
    cpLog().then(setLog).catch(() => {})
    cpLots().then(setLots).catch(() => {})
    cpParked().then(setParked).catch(() => {})
  }
  useEffect(() => {
    refresh()
    const t = setInterval(() => { if (!document.hidden) refresh() }, 3000)
    return () => clearInterval(t)
  }, [])

  const online = status?.network === 'on'
  const denying = status?.denyall === 'on'
  const verify = async (body) => {
    setErr(''); setResult(null); setBusy(true)
    try {
      const r = await cpVerify({ ...body, observed_plate: observed || undefined })
      setResult(r)
      if (r.decision === 'admit') { setToken(''); setCode(''); setObserved('') }
    } catch (e) { setErr(e.message) } finally { setBusy(false); refresh() }
  }
  // Camera decoded a QR → feed the token in and verify immediately, no typing.
  // Any observed plate already entered is included so binding is still checked.
  const onScan = (text) => { setToken(text); verify({ token: text }) }
  const guard = (fn) => async () => { if (!status) return; setErr(''); try { await fn(); refresh() } catch (e) { setErr(e.message) } }
  const registerExit = async () => {
    setErr(''); setResult(null); setBusy(true)
    try {
      const r = await cpExit(token ? { token } : { code })
      setResult({ decision: 'admit', reason: `↩ exit registered — ${r.freed_lot} freed a space`, booking_id: r.booking_id })
      setToken(''); setCode('')
    } catch (e) { setErr(e.message) } finally { setBusy(false); refresh() }
  }
  const doReassign = async (to_lot) => {
    if (!result?.booking_id || !to_lot) return
    setErr('')
    try {
      const r = await cpReassign(result.booking_id, to_lot, 'operator override at gate')
      setResult({ ...result, lot_name: r.lot_name, overflow: false,
        reason: `re-parked → ${r.lot_name}${r.over_capacity ? ' (over capacity — logged)' : ''}` })
      refresh()
    } catch (e) { setErr(e.message) }
  }
  // Reassign any already-parked vehicle (not just the one just scanned) — used by
  // the Reassign tab. Offline-safe; the signed pass is never edited.
  const reassignParked = async (booking_id, to_lot) => {
    setErr('')
    try { await cpReassign(booking_id, to_lot, 'reassigned from parking screen'); refresh() }
    catch (e) { setErr(e.message) }
  }
  const st = staleness(status?.last_sync)

  return (
    <div className="max-w-3xl mx-auto px-5 lg:px-8 py-8 sm:py-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-slate-500">Checkpoint</div>
          <div className="text-2xl font-bold text-slate-900 leading-tight">{status?.zone_id || '…'} gate</div>
        </div>
        <div className="flex items-center gap-2">
          {denying && <Badge tone="red">⛔ deny-all</Badge>}
          {reachable === false
            ? <Badge tone="red">not connected</Badge>
            : <Badge tone={online ? 'green' : 'slate'}>
                <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-500 live-dot' : 'bg-slate-400'}`} />
                {online ? 'online · link to central' : 'offline · link cut'}
              </Badge>}
        </div>
      </div>

      {/* Node unreachable is different from the gate being offline: the gate DEVICE
          itself isn't answering (process not running / wrong URL). */}
      {reachable === false && (
        <Card className="p-6 border border-rose-200 bg-rose-50/40">
          <div className="text-lg font-bold text-rose-700">⚠ Gate device not reachable</div>
          <p className="text-[15px] text-slate-600 mt-1 leading-relaxed">
            This console can't reach the checkpoint node at <code className="text-rose-700">{base}</code>.
            The gate process probably isn't running. Start it, then this page reconnects automatically:
          </p>
          <pre className="mt-3 bg-slate-900 text-slate-100 rounded-xl p-3 text-xs overflow-x-auto">cd backend/checkpoint
ZONE_ID=indore CHECKPOINT_ID=cp-indore CENTRAL_URL=http://127.0.0.1:8000 \
  uvicorn node:app --host 127.0.0.1 --port 8001</pre>
          <div className="flex gap-2 mt-3 items-center">
            <input value={base} onChange={(e) => setBase(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 flex-1 text-sm" />
            <Button variant="subtle" onClick={() => { setCheckpointBase(base); refresh() }}>set URL</Button>
            <Button onClick={refresh}>Retry</Button>
          </div>
        </Card>
      )}

      {err && reachable !== false && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3">{err}</div>}

      <div key={section} className="fade-up">
        {section === 'scan' && (
          <div className="space-y-6">
            {result && (
              <div role="alert" aria-live="assertive"
                className={`rounded-2xl p-8 text-center text-white on-dark pop-in
                  ${result.decision === 'admit' ? 'bg-emerald-600' : 'bg-rose-600'}`}>
                <div className="text-6xl font-extrabold tracking-tight">
                  {result.decision === 'admit' ? '✓ ADMIT' : '✕ DENY'}
                </div>
                <div className="mt-2 text-lg opacity-90">{result.reason}</div>

                {/* Parking lot the gate assigned. Overflow = booked lot was full
                    and the vehicle was redirected down the zone cascade (§9). */}
                {result.decision === 'admit' && result.lot_name && (
                  <div className="mt-4 bg-white/15 rounded-xl px-5 py-3 inline-block">
                    <div className="text-xs uppercase tracking-wider opacity-75">
                      {result.overflow ? '↪ Overflow — redirect to' : 'Direct vehicle to'}
                    </div>
                    <div className="text-3xl font-extrabold tracking-tight">🅿 {result.lot_name}</div>
                  </div>
                )}

                {/* Vehicle binding: the plate the pass was issued for. The operator
                    eyeballs this against the actual number plate. */}
                {(result.plate || result.plate_last) && (
                  <div className="mt-4 bg-black/25 rounded-xl px-4 py-3 inline-block text-left">
                    <div className="text-xs uppercase tracking-wider opacity-75">
                      {result.decision === 'admit' ? 'Check this plate on the vehicle' : 'Pass was issued for'}
                    </div>
                    <div className="text-2xl font-mono font-bold tracking-[0.15em]">
                      {result.plate || `••• ${result.plate_last}`}
                    </div>
                    {!result.plate && result.plate_last && (
                      <div className="text-[11px] opacity-70">full plate shows after sync — check it ends in {result.plate_last}</div>
                    )}
                    {result.vdesc && <div className="text-sm opacity-90">{result.vdesc}</div>}
                    {result.observed_plate && (
                      <div className="text-sm mt-1 opacity-90">you entered: <span className="font-mono">{result.observed_plate}</span></div>
                    )}
                  </div>
                )}
                {result.decision === 'admit' && result.plate && !result.plate_checked && (
                  <div className="mt-3 text-sm font-semibold bg-amber-400/90 text-amber-950 rounded-full px-4 py-1 inline-block">
                    ⚠ confirm the number plate matches before lifting the barrier
                  </div>
                )}

                {result.offline && (
                  <div className="mt-3">
                    <span className="inline-block bg-black/25 rounded-full px-4 py-1 text-sm font-semibold">
                      decided OFFLINE
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Manual reassignment — the "they already parked in P5" / "P2 queue
                too long" override. Records where the vehicle actually went; the
                signed pass is never edited. */}
            {result?.decision === 'admit' && result.booking_id && lots.length > 0 && (
              <Card className="p-5">
                <div className="text-sm font-semibold text-slate-700 mb-1">Reassign parking lot</div>
                <div className="text-xs text-slate-500 mb-3">
                  Driver parked elsewhere, or this lot's queue is too long? Send them to another lot.
                </div>
                <div className="flex flex-wrap gap-2">
                  {lots.map((l) => (
                    <button key={l.id} onClick={() => doReassign(l.id)}
                      className={`rounded-xl border px-3 py-2 text-sm transition
                        ${l.full ? 'border-rose-200 bg-rose-50 text-rose-600'
                                 : 'border-slate-300 hover:border-orange-400 hover:bg-orange-50 text-slate-700'}`}>
                      <span className="font-semibold">{l.name}</span>
                      <span className="ml-2 tabular-nums text-xs text-slate-500">{l.occupied}/{l.capacity}</span>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            <Card className="p-6">
              {/* Camera QR scan — point the pass at the lens; it auto-feeds the
                  token and verifies offline-capably, no typing. */}
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-base font-semibold text-slate-800">📷 Scan QR with camera</div>
                  <div className="text-sm text-slate-500">Auto-reads &amp; verifies — hands-free at the gate.</div>
                </div>
                <Switch on={scanning} onClick={() => setScanning((s) => !s)} onLabel="CAM ON" offLabel="CAM OFF" />
              </div>
              {scanning && (
                <div className="mb-5">
                  <QrScanner onDetect={onScan} paused={busy} />
                  <p className="text-xs text-slate-400 mt-2">
                    Enter the observed plate below first if you want the gate to check vehicle binding on the auto-scan.
                  </p>
                </div>
              )}

              <label htmlFor="obs" className="text-sm font-medium text-slate-600">
                Observed number plate <span className="text-slate-400">(checked against the pass)</span>
              </label>
              <input id="obs" value={observed} onChange={(e) => setObserved(e.target.value.toUpperCase())}
                placeholder="read it off the vehicle — e.g. MP09 AB 1234" maxLength={16}
                className="w-full mt-2 mb-5 border border-slate-300 rounded-xl px-4 py-3 text-base
                  font-mono tracking-[0.15em] uppercase" />

              <label htmlFor="tok" className="text-sm font-medium text-slate-600">Or paste QR token (manual fallback)</label>
              <textarea id="tok" rows={2} value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="base64url ticket token from the QR…"
                className="w-full mt-2 border border-slate-300 rounded-xl p-3 text-sm font-mono" />
              <Button variant="indigo" className="w-full mt-2 py-3 text-base" disabled={!token || busy}
                onClick={() => verify({ token })}>{busy ? <Spinner /> : 'Verify QR'}</Button>

              <div className="flex items-center gap-3 my-5 text-sm text-slate-500">
                <div className="flex-1 border-t border-slate-200" /> or type the code <div className="flex-1 border-t border-slate-200" />
              </div>
              <div className="flex gap-3">
                <input value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABC123" aria-label="6-character entry code"
                  className="flex-1 border border-slate-300 rounded-xl px-4 py-3 text-lg font-mono tracking-[0.25em] tabular-nums text-center" />
                <Button variant="indigo" className="px-6 text-base" disabled={code.length < 6 || busy} onClick={() => verify({ code })}>Verify</Button>
              </div>

              {/* Gate-out: register a vehicle leaving so its lot frees a space. */}
              <div className="flex items-center gap-3 mt-5 pt-4 border-t border-slate-100">
                <span className="text-sm text-slate-500 flex-1">Vehicle leaving? Free its space:</span>
                <Button variant="ghost" disabled={(!token && !code) || busy} onClick={registerExit}>↩ Register exit</Button>
              </div>
            </Card>
          </div>
        )}

        {section === 'lots' && (
          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-1">Parking lots — this zone</h2>
            <p className="text-sm text-slate-500 mb-4">
              Cascade order (primary first). Occupancy is owned locally and survives offline;
              full lots auto-redirect at the gate.
            </p>
            <div className="space-y-4">
              {lots.map((l, i) => (
                <div key={l.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[15px] font-medium text-slate-800">
                      {i === 0 && <span className="text-xs text-orange-600 font-bold mr-1.5">PRIMARY</span>}
                      {l.name}
                    </span>
                    <span className="text-sm tabular-nums">
                      {l.full ? <Badge tone="red">full</Badge>
                        : <span className="text-slate-500">{l.available} free</span>}
                      <span className="text-slate-400 ml-2">{l.occupied}/{l.capacity}</span>
                    </span>
                  </div>
                  <FillBar booked={l.occupied} capacity={l.capacity} />
                </div>
              ))}
              {!lots.length && <div className="text-slate-500 text-sm">no lots synced yet — run a Sync from the Node tab</div>}
            </div>
          </Card>
        )}

        {section === 'reassign' && (
          <ReassignTab parked={parked} lots={lots} onReassign={reassignParked} />
        )}

        {section === 'activity' && (
          <Card className="p-6">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Recent decisions</h2>
            <div className="max-h-[60vh] overflow-auto divide-y divide-slate-100 text-sm font-mono">
              {log.map((e) => (
                <div key={e.id} className="flex justify-between gap-3 py-2">
                  <span className={e.decision === 'admit' ? 'text-emerald-700' : 'text-rose-700'}>
                    {e.decision === 'admit' ? '✓' : '✕'} {e.reason}
                  </span>
                  <span className="text-slate-500 shrink-0">{e.offline ? 'offline' : 'online'}{e.synced ? ' · synced' : ''}</span>
                </div>
              ))}
              {!log.length && <div className="text-slate-500 py-2">no scans yet</div>}
            </div>
          </Card>
        )}

        {section === 'node' && (
          <div className="space-y-6">
            <Card className="p-6 space-y-5">
              <h2 className="text-lg font-bold text-slate-800">Node controls</h2>
              <Ctl title="Network link" hint="Cut it — gate keeps working">
                <Switch on={online} disabled={!status} onClick={guard(() => cpNetwork(!online))} />
              </Ctl>
              <Ctl title="Deny-all kill switch" hint="Instant offline lockdown">
                <Switch on={denying} disabled={!status} tone="rose" onLabel="DENY" offLabel="off"
                  onClick={guard(() => cpDenyAll(!denying))} />
              </Ctl>
              <div className="flex items-center justify-between">
                <div><div className="text-base font-medium text-slate-800">Batch sync</div>
                  <div className="text-sm text-slate-500">push log · pull bookings/lockdowns</div></div>
                <Button className="px-5" disabled={!online} onClick={guard(cpSync)}>Sync now</Button>
              </div>
            </Card>

            <Card className="p-6">
              <h2 className="text-lg font-bold text-slate-800 mb-4">Local cache</h2>
              <Kv k="Cached bookings" v={status?.cached_bookings ?? '—'} />
              <Kv k="Unsynced scans" v={status?.pending_unsynced ?? '—'} />
              <Kv k="Cached lockdowns" v={status?.cached_lockdowns?.length
                ? <span className="text-rose-600 font-bold">{status.cached_lockdowns.map((l) => l.scope).join(',')}</span> : '0'} />
              <Kv k="Last sync" v={<Badge tone={st.tone}>{st.text}</Badge>} />
              <Kv k="Public key" v={status?.has_pubkey ? <Badge tone="green">provisioned</Badge> : <Badge tone="red">missing</Badge>} />
            </Card>

            <details className="text-sm text-slate-500">
              <summary className="cursor-pointer px-1 py-1">checkpoint node URL</summary>
              <div className="flex gap-2 mt-2">
                <input value={base} onChange={(e) => setBase(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 flex-1" />
                <Button variant="subtle" onClick={() => { setCheckpointBase(base); refresh() }}>set</Button>
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

// Reassign-any-parked-vehicle screen: pick a vehicle that's already in the lot,
// then send it to a different one. Unlike the inline reassign on the scan result,
// this works for ANY parked vehicle at any time — the marshal-rebalancing case.
function ReassignTab({ parked, lots, onReassign }) {
  const [sel, setSel] = useState(null)
  const v = parked.find((p) => p.id === sel)
  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="text-lg font-bold text-slate-800 mb-1">Reassign a parked vehicle</h2>
        <p className="text-sm text-slate-500 mb-4">
          Move any vehicle already admitted to this gate into a different lot — e.g. rebalancing
          queues after entry. Works offline; the signed pass is never edited, only the lot it points to.
        </p>
        {!parked.length && (
          <div className="text-slate-500 text-sm">no vehicles parked at this gate yet</div>
        )}
        <div className="divide-y divide-slate-100">
          {parked.map((p) => (
            <button key={p.id} onClick={() => setSel(sel === p.id ? null : p.id)}
              className="w-full text-left py-3 flex items-center gap-3">
              <div className="text-2xl">{vehicleIcon(p.vtype)}</div>
              <div className="flex-1 min-w-0">
                <div className="font-mono font-semibold text-slate-800 truncate">{p.plate || p.code}</div>
                <div className="text-sm text-slate-500 truncate">
                  {p.vdesc ? `${p.vdesc} · ` : ''}🅿 {p.lot_name || p.assigned_lot}
                </div>
              </div>
              <Badge tone={sel === p.id ? 'indigo' : 'slate'}>{sel === p.id ? 'selected' : 'move'}</Badge>
            </button>
          ))}
        </div>
      </Card>

      {v && (
        <Card className="p-5 pop-in">
          <div className="text-sm font-semibold text-slate-700 mb-1">
            Move <span className="font-mono">{v.plate || v.code}</span> to:
          </div>
          <div className="text-xs text-slate-500 mb-3">currently at 🅿 {v.lot_name || v.assigned_lot}</div>
          <div className="flex flex-wrap gap-2">
            {lots.map((l) => (
              <button key={l.id} disabled={l.id === v.assigned_lot}
                onClick={() => { onReassign(v.id, l.id); setSel(null) }}
                className={`rounded-xl border px-3 py-2 text-sm transition
                  ${l.id === v.assigned_lot ? 'opacity-40 border-slate-200 cursor-default'
                    : l.full ? 'border-rose-200 bg-rose-50 text-rose-600'
                    : 'border-slate-300 hover:border-orange-400 hover:bg-orange-50 text-slate-700'}`}>
                <span className="font-semibold">{l.name}</span>
                <span className="ml-2 tabular-nums text-xs text-slate-500">{l.occupied}/{l.capacity}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function Ctl({ title, hint, children }) {
  return (
    <div className="flex items-center justify-between">
      <div><div className="text-base font-medium text-slate-800">{title}</div>
        <div className="text-sm text-slate-500">{hint}</div></div>
      {children}
    </div>
  )
}
function Kv({ k, v }) {
  return <div className="flex items-center justify-between py-2 text-[15px] border-b border-slate-100 last:border-0">
    <span className="text-slate-500">{k}</span><span className="font-semibold text-slate-800">{v}</span></div>
}
