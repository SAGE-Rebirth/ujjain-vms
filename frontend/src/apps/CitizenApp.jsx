import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  listZones, zoneSlots, zoneLots, createBookingsBatch, getBooking, loadPasses, savePass, removePass,
  loadHidden, hidePass, cancelBooking, otpRequest, otpVerify, myBookings,
  getCitizen, setCitizen, logoutCitizen,
  getPricing, createOrder, razorpayCheckout,
} from '../api.js'
import {
  Button, Card, Badge, FillBar, Stepper, Spinner, Skeleton, Empty,
  VEHICLES, vehicleIcon,
} from '../ui/components.jsx'

const STEPS = ['Zone', 'Time', 'Parking', 'Vehicle', 'Pay']

export default function CitizenApp({ date, section, setSection }) {
  const [resetKey, setResetKey] = useState(0)
  const [citizen, setCit] = useState(getCitizen())
  const [expired, setExpired] = useState(false)
  // Start the wizard fresh each time the user navigates to "Book".
  useEffect(() => { if (section === 'book') setResetKey((n) => n + 1) }, [section])

  // Single-session: verifying the same number on another device (or signing out)
  // kills this token. `auth:expired` fires on the next 401 → drop to the OTP login
  // with a notice instead of looping on failed pass/booking calls.
  useEffect(() => {
    const onExpired = (e) => {
      if (e.detail?.scope !== 'citizen') return
      setCit(null); setExpired(true)
    }
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])

  const onLogin = (c) => { setCitizen(c); setCit(c); setExpired(false) }
  const onLogout = async () => { await logoutCitizen(); setCit(null) }

  // Booking + passes are identity-bound (anti-tout, C13). Gate them behind a
  // phone-OTP login; Home stays public so live availability is browsable.
  const needsLogin = (section === 'book' || section === 'passes') && !citizen

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-5 lg:px-8 py-6 sm:py-10">
      {citizen && section !== 'home' && (
        <div className="flex justify-end mb-3 text-sm text-slate-500">
          📱 {citizen.phone}
          <button onClick={onLogout} className="ml-3 text-slate-400 hover:text-slate-700">sign out</button>
        </div>
      )}
      {section === 'home' && <Home date={date} onBook={() => setSection('book')} onPasses={() => setSection('passes')} />}
      {needsLogin && <CitizenLogin onLogin={onLogin} expired={expired} />}
      {section === 'book' && citizen && <BookWizard key={resetKey} date={date} onDone={() => setSection('passes')} />}
      {section === 'passes' && citizen && <Passes onBook={() => setSection('book')} />}
    </div>
  )
}

// Phone → OTP login. The OTP is the anti-tout identity anchor (per-phone booking
// caps) and the key for server-side pass retrieval (docs/AUDIT.md C10, C13).
function CitizenLogin({ onLogin, expired }) {
  const [phone, setPhone] = useState(''); const [code, setCode] = useState('')
  const [sent, setSent] = useState(null) // {demo_otp}
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')

  const request = async () => {
    setBusy(true); setErr('')
    try { setSent(await otpRequest(phone)) }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const verify = async () => {
    setBusy(true); setErr('')
    try { onLogin(await otpVerify(phone, code)) }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="max-w-sm mx-auto fade-up">
      <div className="text-center mb-6">
        <div className="text-4xl mb-2">📱</div>
        <h1 className="text-2xl font-bold text-slate-900">Verify your mobile</h1>
        <p className="text-sm text-slate-500 mt-1">
          One number, fair access — caps stop touts bulk-booking slots.
        </p>
      </div>
      <Card className="p-6 space-y-3">
        {expired && !err && (
          <div role="status" className="bg-amber-100 text-amber-800 rounded-xl p-3 text-sm">
            Session ended — this number was verified on another device, or signed out. Verify again to continue.
          </div>
        )}
        {err && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3 text-sm">{err}</div>}
        <div className="flex gap-2">
          <span className="inline-flex items-center px-3 rounded-xl bg-slate-100 text-slate-500 text-sm">+91</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric"
            placeholder="10-digit mobile" maxLength={10}
            className="flex-1 border border-slate-300 rounded-xl px-4 py-3 tracking-wide" />
        </div>
        {!sent ? (
          <Button variant="indigo" className="w-full py-3" disabled={busy || phone.length < 10} onClick={request}>
            {busy ? <Spinner /> : 'Send OTP'}
          </Button>
        ) : (
          <>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
              📩 Demo OTP: <b className="font-mono tracking-widest">{sent.demo_otp}</b>
              <div className="text-xs text-amber-600 mt-0.5">production sends this by SMS</div>
            </div>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
              placeholder="enter 6-digit OTP" maxLength={6}
              className="w-full border border-slate-300 rounded-xl px-4 py-3 text-center text-lg font-mono tracking-[0.3em]" />
            <Button variant="indigo" className="w-full py-3" disabled={busy || code.length < 6} onClick={verify}>
              {busy ? <Spinner /> : 'Verify & continue'}
            </Button>
            <button onClick={() => setSent(null)} className="w-full text-sm text-slate-400 hover:text-slate-600 py-1">
              change number
            </button>
          </>
        )}
      </Card>
    </div>
  )
}

// ── Home ────────────────────────────────────────────────────────────────────
function Home({ date, onBook, onPasses }) {
  const [zones, setZones] = useState(null)
  const passes = loadPasses()
  useEffect(() => { listZones(date).then(setZones).catch(() => setZones([])) }, [date])

  return (
    <div className="space-y-10 fade-up">
      <Card className="bg-saffron-grad on-dark text-white border-0 p-8 sm:p-10">
        <div className="text-3xl sm:text-4xl font-extrabold leading-tight tracking-tight">नमस्ते 🙏</div>
        <p className="text-white/90 text-base sm:text-lg mt-3 max-w-2xl leading-relaxed">
          Reserve your vehicle entry slot for Simhastha 2028 — pick a zone &amp; time,
          pay, and carry an offline-verifiable QR pass with your parking lot.
        </p>
        <Button variant="white" className="mt-6 py-3.5 px-6 text-base" onClick={onBook}>
          ➕ Book a parking slot
        </Button>
      </Card>

      <div>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-slate-800">Live availability</h2>
          <span className="text-sm text-emerald-600 flex items-center gap-1.5 font-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-500 live-dot" /> live · {date}
          </span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {zones === null && [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-24" />)}
          {zones?.map((z) => (
            <Card key={z.id} className="p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-base font-semibold text-slate-800">{z.name}</span>
                {z.locked ? <Badge tone="red">locked</Badge>
                  : z.available <= 0 ? <Badge tone="red">full</Badge>
                  : <Badge tone="green">{z.available} free</Badge>}
              </div>
              <FillBar booked={z.booked} capacity={z.capacity} locked={z.locked} />
              <div className="mt-2 text-sm text-slate-500">{z.road}</div>
            </Card>
          ))}
        </div>
      </div>

      <button onClick={onPasses} className="w-full text-left">
        <Card className="p-5 flex items-center justify-between hover:bg-slate-50 transition">
          <span className="text-base font-semibold text-slate-800">🎫 My Passes</span>
          <Badge tone="indigo">{passes.length}</Badge>
        </Card>
      </button>
    </div>
  )
}

// ── Booking wizard ──────────────────────────────────────────────────────────
function BookWizard({ date, onDone }) {
  const [step, setStep] = useState(0)
  const [zones, setZones] = useState(null)
  const [zone, setZone] = useState(null)
  const [slotType, setSlotType] = useState('public')
  const [slots, setSlots] = useState([])
  const [slot, setSlot] = useState(null)
  const [lots, setLots] = useState(null)
  // Multi-vehicle cart: one entry → one per-vehicle pass. Each carries its own
  // plate + headcount (people number only, no personal details stored).
  const [cart, setCart] = useState([{ vtype: 'car', plate: '', vdesc: '', pax: 1 }])
  const [paying, setPaying] = useState(false)
  const [tickets, setTickets] = useState(null)   // array of minted passes
  const [err, setErr] = useState('')
  const [pricing, setPricing] = useState(null)   // {public:{2w,car,bus}, vip:{…}}

  useEffect(() => { listZones(date).then(setZones).catch((e) => setErr(e.message)) }, [date])
  // Fares are fetched live (admin-editable) — never hard-coded in the client.
  useEffect(() => { getPricing().then((r) => setPricing(r.pricing)).catch(() => setPricing(null)) }, [])
  const loadSlots = (z, type) => zoneSlots(z.id, date, type).then(setSlots).catch((e) => setErr(e.message))
  const chooseZone = (z) => { setZone(z); loadSlots(z, slotType); setStep(1) }
  const chooseType = (t) => { setSlotType(t); setSlot(null); if (zone) loadSlots(zone, t) }
  const chooseSlot = (s) => {
    setSlot(s); setStep(2)
    setLots(null); zoneLots(zone.id).then(setLots).catch(() => setLots([]))
  }
  const priceOf = (vt) => pricing?.[slotType]?.[vt] ?? 0
  const fee = cart.reduce((sum, it) => sum + priceOf(it.vtype), 0)
  const totalPax = cart.reduce((sum, it) => sum + (it.pax || 0), 0)
  const cartReady = cart.length > 0 && cart.every((it) => it.plate.trim().length >= 4)

  // Cart editing helpers.
  const setItem = (i, patch) => setCart((c) => c.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  const addVehicle = () => setCart((c) => [...c, { vtype: 'car', plate: '', vdesc: '', pax: 1 }])
  const removeVehicle = (i) => setCart((c) => c.filter((_, j) => j !== i))

  const pay = async () => {
    setErr(''); setPaying(true)
    try {
      // 1) open ONE server-priced Razorpay order for the whole cart, 2) pay (real
      // checkout, or mock in demo mode), 3) mint one signed pass per vehicle.
      const items = cart.map((it) => ({
        vtype: it.vtype, plate: it.plate.trim(), vdesc: it.vdesc.trim(), pax: it.pax,
      }))
      const order = await createOrder({ slot_id: slot.id, slot_type: slotType, items })
      const proof = order.mock
        ? { razorpay_order_id: order.order_id, razorpay_payment_id: 'pay_mock', razorpay_signature: 'mock' }
        : await razorpayCheckout(order, { phone: getCitizen()?.phone })
      const res = await createBookingsBatch({ ...proof })
      const passes = res.passes.map((t) => ({
        id: t.id, code: t.code, token: t.token, qr: t.qr, sms: t.sms,
        zoneName: zone.name, road: zone.road, date: t.date, window: t.window,
        vtype: t.vtype, vcount: t.vcount, slot_type: t.slot_type, paid: t.amount,
        plate: t.plate, vdesc: t.vdesc, pax: t.pax, lotName: t.lot_name,
        lotLat: t.lot_lat, lotLng: t.lot_lng,
      }))
      passes.forEach(savePass)
      setTickets(passes)
    } catch (e) { setErr(e.message) } finally { setPaying(false) }
  }

  if (tickets) return <TicketView passes={tickets} onDone={onDone} />

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Stepper steps={STEPS} current={step} />
      {err && <div role="alert" className="bg-rose-100 text-rose-700 rounded-xl p-3 fade-up">{err}</div>}

      <div key={step} className="fade-up">
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-bold text-slate-800">Pick entry zone</h2>
            {zones === null && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
            <div className="grid sm:grid-cols-2 gap-4">
              {zones?.map((z) => {
                const dis = z.locked || z.available <= 0
                return (
                  <button key={z.id} disabled={dis} onClick={() => chooseZone(z)} className="text-left">
                    <Card className={`p-5 transition ${dis ? 'opacity-50' : 'hover:border-orange-300 hover:shadow-md'}`}>
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-base font-semibold text-slate-800">{z.name}</span>
                        {z.locked ? <Badge tone="red">locked</Badge>
                          : <span className="text-sm text-slate-500 tabular-nums">{z.available}/{z.capacity}</span>}
                      </div>
                      <FillBar booked={z.booked} capacity={z.capacity} locked={z.locked} />
                    </Card>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-5">
            <BackLink onClick={() => setStep(0)} label={zone.name} />
            <div className="flex rounded-xl bg-slate-200 p-1 text-[15px] font-semibold max-w-sm">
              {['public', 'vip'].map((t) => (
                <button key={t} onClick={() => chooseType(t)}
                  className={`flex-1 rounded-lg py-2 transition ${slotType === t
                    ? (t === 'vip' ? 'bg-amber-500 text-white' : 'bg-orange-500 text-white') : 'text-slate-600'}`}>
                  {t === 'vip' ? '⭐ VIP lane' : 'Public'}
                </button>
              ))}
            </div>
            <h2 className="text-xl font-bold text-slate-800">Pick arrival window</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {slots.map((s) => {
                const dis = s.available <= 0
                return (
                  <button key={s.id} disabled={dis} onClick={() => chooseSlot(s)}
                    className={`rounded-xl border p-4 text-left transition bg-white
                      ${dis ? 'opacity-40' : 'hover:border-orange-300 hover:shadow-md'}`}>
                    <div className="text-lg font-bold text-slate-800 tabular-nums">{s.start}</div>
                    <div className="text-sm text-slate-500">→ {s.end}</div>
                    <div className="text-sm text-emerald-600 mt-1.5 tabular-nums">{s.available} free</div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <BackLink onClick={() => setStep(1)} label={`${slot.start}–${slot.end}`} />
            <h2 className="text-xl font-bold text-slate-800">Parking for {zone.name}</h2>
            <p className="text-sm text-slate-500 -mt-2">
              You'll be directed to the primary lot; if it's full, the gate sends you to the
              next one in order. The exact lot is confirmed when you arrive.
            </p>
            {lots === null && [0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
            <div className="space-y-3">
              {lots?.map((l) => (
                <Card key={l.id} className={`p-4 ${l.primary ? 'border-orange-300 bg-orange-50/40' : ''}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[15px] font-semibold text-slate-800">
                      🅿 {l.name} {l.primary && <Badge tone="saffron">you’ll be directed here</Badge>}
                    </span>
                    <span className="text-sm tabular-nums text-slate-500">
                      {l.available <= 0 ? <Badge tone="red">full</Badge> : `${l.available} free`}
                    </span>
                  </div>
                  <FillBar booked={l.occupied} capacity={l.capacity} />
                </Card>
              ))}
            </div>
            <Button className="w-full py-3.5 text-base" onClick={() => setStep(3)}>Continue →</Button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <BackLink onClick={() => setStep(2)} label="Parking" />
            <div className="flex items-end justify-between">
              <h2 className="text-xl font-bold text-slate-800">Vehicles &amp; people</h2>
              <span className="text-sm text-slate-500 tabular-nums">
                {cart.length} vehicle{cart.length !== 1 ? 's' : ''} · {totalPax} 👤
              </span>
            </div>
            <p className="text-sm text-slate-500 -mt-3">
              Add each vehicle with its number plate — you'll get a separate pass per vehicle.
            </p>

            {cart.map((item, i) => (
              <Card key={i} className="p-4 sm:p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-slate-700">Vehicle {i + 1}</span>
                  {cart.length > 1 && (
                    <button onClick={() => removeVehicle(i)}
                      className="text-sm font-medium text-rose-500 hover:text-rose-700">remove</button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {VEHICLES.map((v) => (
                    <button key={v.id} onClick={() => setItem(i, { vtype: v.id })}
                      className={`rounded-xl border p-3 flex flex-col items-center gap-1 transition
                        ${item.vtype === v.id ? 'border-orange-400 bg-orange-50 shadow-sm' : 'bg-white hover:border-slate-300'}`}>
                      <span className="text-2xl">{v.icon}</span>
                      <span className="text-xs font-medium text-slate-600">{v.label}</span>
                      <span className="text-xs font-semibold text-indigo-700 tabular-nums">₹{priceOf(v.id)}</span>
                    </button>
                  ))}
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-600">
                    Number plate <span className="text-rose-500">*</span>
                  </label>
                  <input value={item.plate}
                    onChange={(e) => setItem(i, { plate: e.target.value.toUpperCase() })}
                    placeholder="MP09 AB 1234" maxLength={16}
                    className="w-full mt-1.5 border border-slate-300 rounded-xl px-4 py-2.5 text-base
                      font-mono tracking-[0.15em] uppercase" />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-600">People in this vehicle</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <button aria-label="fewer people" onClick={() => setItem(i, { pax: Math.max(1, item.pax - 1) })}
                      className="h-9 w-9 rounded-full bg-slate-200 hover:bg-slate-300 font-bold">−</button>
                    <span className="w-6 text-center font-bold tabular-nums">{item.pax}</span>
                    <button aria-label="more people" onClick={() => setItem(i, { pax: Math.min(100, item.pax + 1) })}
                      className="h-9 w-9 rounded-full bg-slate-200 hover:bg-slate-300 font-bold">+</button>
                  </div>
                </div>
                <input value={item.vdesc} onChange={(e) => setItem(i, { vdesc: e.target.value })}
                  placeholder="Colour / model (optional) — e.g. White Swift" maxLength={40}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2 text-sm" />
              </Card>
            ))}

            <button onClick={addVehicle}
              className="w-full rounded-xl border-2 border-dashed border-slate-300 hover:border-orange-400
                hover:bg-orange-50/40 text-slate-600 font-semibold py-3 transition">
              ➕ Add another vehicle
            </button>

            <p className="text-xs text-slate-400">
              Each plate is locked into its pass — the gate checks it against the actual vehicle,
              so a copied QR can't be used on a different one. We store the people count only, no personal details.
            </p>
            <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl p-4">
              <span className="text-base text-slate-700">Total</span>
              <span className="text-lg font-bold tabular-nums text-slate-900">₹{fee}</span>
            </div>
            <Button className="w-full py-3.5 text-base" disabled={!cartReady}
              onClick={() => setStep(4)}>Review →</Button>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <BackLink onClick={() => setStep(3)} label="Vehicles" />
            <Card className="p-6 space-y-3 text-[15px]">
              <Row k="Zone" v={zone.name} />
              <Row k="Lane" v={slotType === 'vip' ? '⭐ VIP' : 'Public'} />
              <Row k="Date" v={date} />
              <Row k="Window" v={`${slot.start}–${slot.end}`} />
              <Row k="People" v={`${totalPax} 👤`} />
              <div className="border-t border-slate-100 pt-3 space-y-2">
                {cart.map((it, i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <span className="text-slate-600 min-w-0 truncate">
                      {vehicleIcon(it.vtype)} <span className="font-mono">{it.plate || '—'}</span>
                      <span className="text-slate-400"> · {it.pax}👤</span>
                    </span>
                    <span className="font-semibold text-slate-800 tabular-nums shrink-0">₹{priceOf(it.vtype)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-200 pt-3 flex justify-between text-lg font-bold text-slate-900">
                <span>Total ({cart.length})</span><span className="tabular-nums">₹{fee}</span>
              </div>
            </Card>
            <Button className="w-full py-4 text-base" onClick={pay} disabled={paying || fee <= 0}>
              {paying ? <><Spinner /> Processing payment…</> : `Pay ₹${fee} securely`}
            </Button>
            <p className="text-sm text-center text-slate-500">
              🔒 Payments processed by Razorpay (test mode in this demo).
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function BackLink({ onClick, label }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800 py-1">
      <span className="text-lg leading-none">←</span> {label}
    </button>
  )
}
function Row({ k, v }) {
  return <div className="flex justify-between">
    <span className="text-slate-500">{k}</span><span className="font-semibold text-slate-800">{v}</span></div>
}

// Stacked label-over-value field — wraps gracefully in narrow ticket columns.
function Field({ k, v, sub }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{k}</div>
      <div className="font-semibold text-slate-800 break-words leading-snug">{v}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 break-words">{sub}</div>}
    </div>
  )
}

// ── Ticket ──────────────────────────────────────────────────────────────────
function TicketView({ passes, onDone }) {
  const total = passes.reduce((s, p) => s + (p.paid || 0), 0)
  const multi = passes.length > 1
  return (
    <div className="max-w-md mx-auto fade-up">
      <div className="text-center mb-5">
        <div className="text-emerald-600 text-3xl font-extrabold tracking-tight">✓ Payment successful</div>
        <div className="text-base text-slate-500 mt-1">
          ₹{total} paid via UPI (mock) · {passes.length} pass{multi ? 'es' : ''} booked
        </div>
      </div>
      <div className="space-y-5">
        {passes.map((p, i) => (
          <div key={p.id}>
            {multi && <div className="text-sm font-bold text-slate-500 mb-1.5">Pass {i + 1} of {passes.length}</div>}
            <TicketCard pass={p} />
          </div>
        ))}
      </div>
      <Button className="w-full mt-5 py-3.5 text-base" onClick={onDone}>View in My Passes →</Button>
    </div>
  )
}

export function TicketCard({ pass }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard?.writeText(pass.code); setCopied(true); setTimeout(() => setCopied(false), 1500) }
  return (
    <Card className="overflow-hidden pop-in">
      <div className="bg-indigo-950 on-dark text-white p-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.15em] text-white/60">Entry pass</div>
          <div className="font-bold text-lg truncate">{pass.zoneName}</div>
          <div className="text-sm text-white/70 truncate">{pass.road}{pass.lotName ? ` · 🅿 ${pass.lotName}` : ''}</div>
        </div>
        {pass.slot_type === 'vip' && <Badge tone="saffron" className="shrink-0">⭐ VIP</Badge>}
      </div>
      <div className="p-6 flex flex-col items-center">
        <img src={pass.qr} alt={`Entry QR for ${pass.zoneName}, code ${pass.code}`}
          className="w-44 h-44 sm:w-52 sm:h-52" />
        <div className="text-sm text-slate-500 mt-3">Manual code (if scan fails)</div>
        <button onClick={copy}
          className="text-3xl sm:text-4xl font-mono font-extrabold tracking-[0.18em] sm:tracking-[0.25em]
            tabular-nums text-indigo-900 hover:text-orange-600 transition break-all">
          {pass.code}
        </button>
        <span className="text-xs text-slate-400 h-4">{copied ? '✓ copied' : 'tap code to copy'}</span>
      </div>
      <div className="ticket-perf mx-5" />
      {/* Stacked label/value fields — never crowd a single row, so long lot names
          and plates wrap cleanly. One column on phones, two from sm up. */}
      <div className="p-5 sm:p-6 grid grid-cols-2 gap-x-4 gap-y-4 text-[15px]">
        <Field k="Date" v={pass.date} />
        <Field k="Window" v={pass.window} />
        <Field k="Vehicle" v={`${vehicleIcon(pass.vtype)} ${pass.vtype}${pass.vcount > 1 ? ` ×${pass.vcount}` : ''}`} />
        {pass.pax != null && <Field k="People" v={`${pass.pax} 👤`} />}
        {pass.statusBadge && <Field k="Status" v={pass.statusBadge} />}
        {pass.plate && (
          <Field k="Plate" v={<span className="font-mono tracking-wide">{pass.plate}</span>} sub={pass.vdesc} />
        )}
        {pass.lotName && (
          <Field k="Park at" v={<span className="text-indigo-800">🅿 {pass.lotName}</span>}
            sub="may change at the gate" />
        )}
      </div>
      {pass.lotLat != null && pass.lotLng != null && <LotMap pass={pass} />}
      {pass.sms && (
        <div className="mx-5 mb-5 bg-slate-100 rounded-xl p-3 text-sm text-slate-600 leading-relaxed">
          <span className="text-slate-400">📩 SMS sent (simulated):</span> {pass.sms}
        </div>
      )}
    </Card>
  )
}

// Pre-arrival wayfinding to the assigned lot. A real OSM map (no API key) plus a
// "Navigate" deep-link that hands off to Google Maps / the state's Sahayak app —
// an online convenience layered over physical signage (docs/AUDIT.md §6).
function LotMap({ pass }) {
  const { lotLat: lat, lotLng: lng, lotName } = pass
  const d = 0.006
  const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`
  const osm = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat}%2C${lng}&layer=mapnik`
  const nav = `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lng}`
  return (
    <div className="mx-5 mb-5">
      <div className="rounded-xl overflow-hidden border border-slate-200">
        <iframe title={`Map to ${lotName}`} src={osm} className="w-full h-40" loading="lazy" />
      </div>
      <a href={nav} target="_blank" rel="noreferrer"
        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl
          bg-indigo-900 hover:bg-indigo-800 text-white py-3 text-sm font-semibold transition-colors">
        🧭 Navigate to {lotName || 'parking'}
      </a>
    </div>
  )
}

// ── My Passes ───────────────────────────────────────────────────────────────
// Server-backed (keyed to the verified phone) so passes survive a new device or
// cleared browser (docs/AUDIT.md C10). Falls back to the localStorage cache when
// central is unreachable.
function mapServerPass(b) {
  return {
    id: b.id, code: b.code, token: b.token, qr: b.qr,
    zoneName: b.zone.charAt(0).toUpperCase() + b.zone.slice(1), road: '',
    date: b.date, window: b.window, vtype: b.vtype, vcount: b.vcount,
    slot_type: b.slot_type, plate: b.plate, vdesc: b.vdesc, lotName: b.lot_name,
    lotLat: b.lot_lat, lotLng: b.lot_lng, pax: b.pax, _status: b.status,
  }
}

const badgeFor = (s) => s === 'arrived' ? <Badge tone="green">parked ✓</Badge>
  : s === 'departed' ? <Badge tone="slate">exited</Badge>
  : s === 'revoked' ? <Badge tone="red">revoked</Badge>
  : s === 'noshow' ? <Badge tone="amber">no-show</Badge>
  : <Badge tone="indigo">valid</Badge>

// Only a still-valid (booked) pass can be cancelled; arrived/departed/revoked/
// no-show passes are historical records, so no cancel is offered for them.
const cancellable = (s) => !s || s === 'booked'

// Master-detail: a list of passes on the left, the selected pass rendered in a
// pinned preview on the right (desktop). On mobile a tap opens the pass
// full-screen, since there's no room for a side panel.
function Passes({ onBook }) {
  const [passes, setPasses] = useState(() => {
    const hidden = loadHidden()
    return loadPasses().filter((p) => !hidden.has(p.id))
  })
  const [status, setStatus] = useState({})
  const [sel, setSel] = useState(null)          // selected id → desktop preview
  const [mobileOpen, setMobileOpen] = useState(null) // explicit tap → mobile full-screen

  useEffect(() => {
    let live = true
    const hidden = loadHidden()
    myBookings()
      .then((rows) => {
        if (!live) return
        const mapped = rows.map(mapServerPass).filter((p) => !hidden.has(p.id))
        setPasses(mapped)
        setStatus(Object.fromEntries(mapped.map((p) => [p.id, p._status])))
      })
      .catch(() => {
        // offline / no server: fall back to locally-cached passes + per-id status
        if (live) setPasses(loadPasses().filter((p) => !hidden.has(p.id)))
        Promise.all(loadPasses().map((p) =>
          getBooking(p.id).then((b) => [p.id, b.status]).catch(() => [p.id, null])
        )).then((pairs) => { if (live) setStatus(Object.fromEntries(pairs)) })
      })
    return () => { live = false }
  }, [])

  // Auto-select the first pass for the desktop preview (does NOT open the mobile
  // full-screen — that needs an explicit tap).
  useEffect(() => {
    if (passes.length && !passes.some((p) => p.id === sel)) setSel(passes[0].id)
  }, [passes]) // eslint-disable-line react-hooks/exhaustive-deps

  const [busyId, setBusyId] = useState(null)
  const [cancelErr, setCancelErr] = useState('')

  // Cancel a booking server-side (frees capacity; the gate later denies the pass).
  // A 404 means it was never on the server (a local-only/offline pass) — in that
  // case we just drop it from this device. Other errors are surfaced, not hidden.
  const cancel = async (id) => {
    setBusyId(id); setCancelErr('')
    try {
      await cancelBooking(id)
    } catch (e) {
      if (e.status !== 404) { setCancelErr(e.message || 'could not cancel'); setBusyId(null); return }
    }
    removePass(id)
    setPasses((ps) => ps.filter((p) => p.id !== id))
    setMobileOpen(null)
    setBusyId(null)
  }
  // Historical passes can't be cancelled (they're records) — "Remove from list"
  // just hides them on this device.
  const hide = (id) => {
    hidePass(id); removePass(id)
    setPasses((ps) => ps.filter((p) => p.id !== id))
    setMobileOpen(null)
  }
  // Freeze the page behind the mobile full-screen pass so only the pass scrolls.
  // ONLY below lg — on desktop the overlay is hidden (the side preview is used),
  // so locking the body there would wrongly freeze the whole page after a click.
  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 1023px)').matches
    document.body.style.overflow = mobileOpen && mobile ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileOpen])

  const select = (id) => { setSel(id); setMobileOpen(id); setCancelErr('') }

  if (!passes.length) return (
    <div className="max-w-md mx-auto fade-up">
      <Empty icon="🎫" title="No passes yet" hint="Book a slot to get your entry pass." />
      <Button className="w-full py-3.5 text-base" onClick={onBook}>➕ Book a slot</Button>
    </div>
  )

  const selected = passes.find((p) => p.id === sel)
  const openPass = passes.find((p) => p.id === mobileOpen)

  return (
    <div className="fade-up">
      <h2 className="text-xl font-bold text-slate-800 mb-4">My Passes</h2>
      <div className="lg:flex lg:gap-6 lg:items-start">
        {/* List */}
        <div className="space-y-3 lg:w-80 lg:shrink-0">
          {passes.map((p) => (
            <button key={p.id} onClick={() => select(p.id)} className="w-full text-left">
              <Card className={`p-4 sm:p-5 flex items-center gap-3 sm:gap-4 transition
                ${p.id === sel ? 'ring-2 ring-orange-300 bg-orange-50/40' : 'hover:bg-slate-50'}`}>
                <div className="text-2xl sm:text-3xl shrink-0">{vehicleIcon(p.vtype)}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[15px] sm:text-base text-slate-800 truncate">{p.zoneName}</div>
                  <div className="text-sm text-slate-500 truncate">
                    {p.date} · {p.window} · {p.slot_type === 'vip' ? '⭐VIP' : 'public'}{p.lotName ? ` · ${p.lotName}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {badgeFor(status[p.id])}
                  <div className="font-mono text-sm text-slate-500 mt-1 tabular-nums">{p.code}</div>
                </div>
              </Card>
            </button>
          ))}
        </div>

        {/* Desktop pinned preview */}
        <div className="hidden lg:block flex-1 min-w-0">
          {selected ? (
            <div className="sticky top-24 max-w-md mx-auto">
              <PassDetail pass={selected} status={status[selected.id]}
                onCancel={cancellable(status[selected.id]) ? () => cancel(selected.id) : null}
                onRemove={cancellable(status[selected.id]) ? null : () => hide(selected.id)}
                busy={busyId === selected.id} error={cancelErr} />
            </div>
          ) : (
            <Empty icon="🎫" title="Select a pass" hint="Pick a pass on the left to view its QR and details." />
          )}
        </div>
      </div>

      {/* Mobile full-screen pass. Flex column: fixed top bar + a dedicated scroll
          region (flex-1, min-h-0) so the WHOLE card scrolls into view on short
          mobile viewports — no clipped bottom, no dead gap below the toolbar.
          Height uses 100dvh so the browser's dynamic URL bar is accounted for. */}
      {/* Portaled to <body> so no transformed/overflow ancestor (.fade-up) can trap
          the fixed overlay — that was breaking scroll. Full-screen, self-scrolling. */}
      {openPass && createPortal(
        // key by pass id → fresh scroll container per pass, so switching passes
        // never inherits a stuck/maxed-out touch-scroll position.
        <div key={openPass.id}
          className="lg:hidden fixed inset-0 z-[60] bg-slate-50 overflow-y-auto overscroll-contain"
          style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-slate-200 px-4 sm:px-5 py-3">
            <button onClick={() => setMobileOpen(null)}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-slate-900">
              <span className="text-lg leading-none">←</span> My Passes
            </button>
          </div>
          {/* Big bottom padding (incl. safe-area) guarantees the last buttons scroll
              clear of the mobile URL bar / home indicator on every browser. */}
          <div className="max-w-md mx-auto px-4 sm:px-5 pt-6"
            style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}>
            <PassDetail pass={openPass} status={status[openPass.id]}
              onCancel={cancellable(status[openPass.id]) ? () => cancel(openPass.id) : null}
              onRemove={cancellable(status[openPass.id]) ? null : () => hide(openPass.id)}
              busy={busyId === openPass.id} error={cancelErr} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function PassDetail({ pass, status, onCancel, onRemove, busy, error }) {
  const [confirm, setConfirm] = useState(false)
  // Reset the confirm prompt whenever a different pass is shown.
  useEffect(() => { setConfirm(false) }, [pass.id])
  return (
    <div className="fade-up">
      <TicketCard pass={{ ...pass, statusBadge: badgeFor(status) }} />
      {error && <div role="alert" className="mt-2 bg-rose-100 text-rose-700 rounded-xl p-2.5 text-sm">{error}</div>}

      {/* A still-valid pass can be CANCELLED (frees the slot). A historical pass
          (arrived/exited/revoked/no-show) can't be cancelled, only REMOVED from
          this device's list. Exactly one action is offered. */}
      {onCancel && (
        confirm ? (
          <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm text-rose-700 font-medium">Cancel this pass?</p>
            <p className="text-xs text-rose-500 mt-0.5">
              This frees the slot for someone else and the QR can no longer be used at the gate.
            </p>
            <div className="flex gap-2 mt-3">
              <Button variant="danger" className="flex-1 py-2" disabled={busy} onClick={onCancel}>
                {busy ? <Spinner /> : 'Yes, cancel'}
              </Button>
              <Button variant="subtle" className="flex-1 py-2" disabled={busy} onClick={() => setConfirm(false)}>
                Keep pass
              </Button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)}
            className="w-full mt-1 text-sm font-medium text-rose-600 hover:text-white
              hover:bg-rose-600 border border-rose-200 hover:border-rose-600 rounded-xl py-2.5 transition-colors">
            Cancel pass
          </button>
        )
      )}
      {onRemove && (
        <button onClick={onRemove}
          className="w-full mt-1 text-sm font-medium text-slate-500 hover:text-slate-800
            border border-slate-200 hover:bg-slate-100 rounded-xl py-2.5 transition-colors">
          Remove from list
        </button>
      )}
    </div>
  )
}
