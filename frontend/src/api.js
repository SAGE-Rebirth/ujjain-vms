// ── Central command API ──────────────────────────────────────────────────
// Relative path works in Vite dev (proxied) and when FastAPI serves the build.
const CENTRAL = ''

// The checkpoint node is a separate physical box; default :8001, overridable.
export function getCheckpointBase() {
  return localStorage.getItem('cp_base') || 'http://127.0.0.1:8001'
}
export function setCheckpointBase(v) { localStorage.setItem('cp_base', v) }

async function j(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  if (!res.ok) {
    let detail = res.statusText
    try { detail = (await res.json()).detail || detail } catch {}
    const e = new Error(detail); e.status = res.status; throw e
  }
  return res.json()
}

// ── Auth token storage (staff = command/operator; citizen = phone-verified) ──
export const getStaff = () => { try { return JSON.parse(localStorage.getItem('staff') || 'null') } catch { return null } }
export const setStaff = (s) => localStorage.setItem('staff', JSON.stringify(s))
export const clearStaff = () => localStorage.removeItem('staff')
export const getCitizen = () => { try { return JSON.parse(localStorage.getItem('citizen') || 'null') } catch { return null } }
export const setCitizen = (s) => localStorage.setItem('citizen', JSON.stringify(s))
export const clearCitizen = () => localStorage.removeItem('citizen')
const staffH = () => { const s = getStaff(); return s ? { Authorization: `Bearer ${s.token}` } : {} }
const citizenH = () => { const c = getCitizen(); return c ? { Authorization: `Bearer ${c.token}` } : {} }

// ── Single-session handling ────────────────────────────────────────────────
// The backend now keeps ONE live session per identity: a fresh login elsewhere
// (or a logout) makes this device's token dead → the next authed call returns 401.
// `jScope` catches that, drops the stale local token, and fires `auth:expired` so
// the app can drop to its login screen instead of looping on failed requests.
function emitExpired(scope) {
  try { window.dispatchEvent(new CustomEvent('auth:expired', { detail: { scope } })) } catch {}
}
async function jScope(scope, url, opts = {}) {
  const h = scope === 'staff' ? staffH() : citizenH()
  try {
    return await j(url, { ...opts, headers: { ...h, ...(opts.headers || {}) } })
  } catch (e) {
    if (e.status === 401) {
      if (scope === 'staff') clearStaff(); else clearCitizen()
      emitExpired(scope)
    }
    throw e
  }
}

// staff + citizen auth
export const login = (username, password) =>
  j(`${CENTRAL}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username, password }) })
export const otpRequest = (phone) =>
  j(`${CENTRAL}/api/auth/otp/request`, { method: 'POST', body: JSON.stringify({ phone }) })
export const otpVerify = (phone, code) =>
  j(`${CENTRAL}/api/auth/otp/verify`, { method: 'POST', body: JSON.stringify({ phone, code }) })
export const myBookings = () => jScope('citizen', `${CENTRAL}/api/my/bookings`)

// Logout — end the server session (kills the token everywhere) THEN clear locally.
// Best-effort: a network failure still clears the device so the user isn't stuck.
export async function logoutStaff() {
  try { await j(`${CENTRAL}/api/auth/logout`, { method: 'POST', headers: staffH() }) } catch {}
  clearStaff()
}
export async function logoutCitizen() {
  try { await j(`${CENTRAL}/api/auth/logout`, { method: 'POST', headers: citizenH() }) } catch {}
  clearCitizen()
}

// citizen booking
export const listZones = (date) => j(`${CENTRAL}/api/zones?date=${date}`)
export const zoneSlots = (zone, date, type = 'public') =>
  j(`${CENTRAL}/api/zones/${zone}/slots?date=${date}&slot_type=${type}`)
export const zoneLots = (zone) => j(`${CENTRAL}/api/zones/${zone}/lots`)
export const createBooking = (body) =>
  jScope('citizen', `${CENTRAL}/api/bookings`, { method: 'POST', body: JSON.stringify(body) })
// Mint one per-vehicle pass for each item in a paid multi-vehicle order.
export const createBookingsBatch = (body) =>
  jScope('citizen', `${CENTRAL}/api/bookings/batch`, { method: 'POST', body: JSON.stringify(body) })
export const getBooking = (id) => j(`${CENTRAL}/api/bookings/${id}`)

// ── Pricing (public read) + payments ───────────────────────────────────────
export const getPricing = () => j(`${CENTRAL}/api/pricing`)
// Create a Razorpay order for the chosen lane/vehicle. Server computes the amount.
export const createOrder = (body) =>
  jScope('citizen', `${CENTRAL}/api/payments/order`, { method: 'POST', body: JSON.stringify(body) })

// Load Razorpay's checkout.js once (only needed in LIVE mode).
export function loadRazorpay() {
  return new Promise((res, rej) => {
    if (window.Razorpay) return res()
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => res()
    s.onerror = () => rej(new Error('could not load Razorpay checkout'))
    document.body.appendChild(s)
  })
}

// Open Razorpay checkout for an order; resolves with the payment proof, rejects on
// dismiss/failure. In mock mode the caller skips this and fabricates the proof.
export async function razorpayCheckout(order, who = {}) {
  await loadRazorpay()
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key: order.key_id, amount: order.amount_paise, currency: order.currency,
      name: order.name, description: order.description, order_id: order.order_id,
      prefill: { contact: who.phone || '' },
      theme: { color: '#4f46e5' },
      handler: (r) => resolve({
        razorpay_order_id: r.razorpay_order_id,
        razorpay_payment_id: r.razorpay_payment_id,
        razorpay_signature: r.razorpay_signature,
      }),
      modal: { ondismiss: () => reject(new Error('payment cancelled')) },
    })
    rzp.on('payment.failed', (r) => reject(new Error(r.error?.description || 'payment failed')))
    rzp.open()
  })
}
// Cancel a still-valid booking (frees capacity; the gate then denies the pass,
// even offline, once the cancellation syncs).
export const cancelBooking = (id) =>
  jScope('citizen', `${CENTRAL}/api/bookings/${id}/cancel`, { method: 'POST' })

// admin (staff token required)
export const overview = (date) => jScope('staff', `${CENTRAL}/api/admin/overview?date=${date}`)
export const audit = () => jScope('staff', `${CENTRAL}/api/admin/audit?limit=80`)
export const setLockdown = (scope, reason) =>
  jScope('staff', `${CENTRAL}/api/admin/lockdown`, {
    method: 'POST', body: JSON.stringify({ scope, reason }),
  })
// Two-person lift: the acting commander's token + a second commander's credentials.
export const liftLockdown = (scope, second_username, second_password) =>
  jScope('staff', `${CENTRAL}/api/admin/lockdown/${scope}/lift`, {
    method: 'POST', body: JSON.stringify({ second_username, second_password }),
  })
export const setCapacity = (zone_id, date, capacity) =>
  jScope('staff', `${CENTRAL}/api/admin/capacity`, {
    method: 'POST', body: JSON.stringify({ zone_id, date, capacity }),
  })
// Reconcile no-shows for a date (commander). `as_of` defaults to end-of-day so the
// 2028-dated demo can show capacity being reclaimed.
export const reconcileNoshows = (date, as_of) =>
  jScope('staff', `${CENTRAL}/api/admin/reconcile`, {
    method: 'POST', body: JSON.stringify({ date, as_of }),
  })

// checkpoint node lifecycle (command centre brings a zone's gate up/down) +
// parking visualisation. Central is the source of truth for gate base URLs now,
// so the UI no longer needs a hand-managed list.
// Pricing admin (commander) — `items` = [{slot_type, vtype, price}, …]
export const setPricing = (items) =>
  jScope('staff', `${CENTRAL}/api/admin/pricing`, {
    method: 'POST', body: JSON.stringify({ items }),
  })

// Gate-operator account management (commander)
export const listOperators = () => jScope('staff', `${CENTRAL}/api/admin/operators`)
export const addOperator = (body) =>
  jScope('staff', `${CENTRAL}/api/admin/operators`, { method: 'POST', body: JSON.stringify(body) })
export const removeOperator = (username) =>
  jScope('staff', `${CENTRAL}/api/admin/operators/${encodeURIComponent(username)}`, { method: 'DELETE' })

export const nodesList = () => jScope('staff', `${CENTRAL}/api/admin/nodes`)
export const nodeUp = (zone) =>
  jScope('staff', `${CENTRAL}/api/admin/nodes/${zone}/up`, { method: 'POST' })
export const nodeDown = (zone) =>
  jScope('staff', `${CENTRAL}/api/admin/nodes/${zone}/down`, { method: 'POST' })
export const parking = (date) => jScope('staff', `${CENTRAL}/api/admin/parking?date=${date}`)

// checkpoint node
export const cpStatus = () => j(`${getCheckpointBase()}/status`)
export const cpLog = () => j(`${getCheckpointBase()}/log`)
export const cpVerify = (body) =>
  j(`${getCheckpointBase()}/verify`, { method: 'POST', body: JSON.stringify(body) })
export const cpNetwork = (on) =>
  j(`${getCheckpointBase()}/network`, { method: 'POST', body: JSON.stringify({ on }) })
export const cpDenyAll = (on) =>
  j(`${getCheckpointBase()}/denyall`, { method: 'POST', body: JSON.stringify({ on }) })
export const cpSync = () => j(`${getCheckpointBase()}/sync`, { method: 'POST' })
// Base-parameterized variants for the Command-Centre "Sync all nodes" fan-out.
export const cpStatusAt = (base) => j(`${base}/status`)
export const cpSyncAt = (base) => j(`${base}/sync`, { method: 'POST' })
export const cpLots = () => j(`${getCheckpointBase()}/lots`)
export const cpParked = () => j(`${getCheckpointBase()}/parked`)
export const cpReassign = (booking_id, to_lot, reason) =>
  j(`${getCheckpointBase()}/reassign`, {
    method: 'POST', body: JSON.stringify({ booking_id, to_lot, reason }),
  })
export const cpExit = (body) =>
  j(`${getCheckpointBase()}/exit`, { method: 'POST', body: JSON.stringify(body) })

// ── "My Passes" — no auth in the prototype, so persist tickets locally ──────
const PASS_KEY = 'my_passes'
export function loadPasses() {
  try { return JSON.parse(localStorage.getItem(PASS_KEY) || '[]') } catch { return [] }
}
export function savePass(p) {
  const all = loadPasses()
  all.unshift(p)
  localStorage.setItem(PASS_KEY, JSON.stringify(all.slice(0, 30)))
}
export function removePass(id) {
  localStorage.setItem(PASS_KEY, JSON.stringify(loadPasses().filter((p) => p.id !== id)))
}

// Per-device "remove from list" for historical passes (arrived/departed/revoked/
// no-show). These are server records we can't cancel, so hiding them is a local,
// this-device-only preference — kept here so it persists across reloads.
const HIDE_KEY = 'hidden_passes'
export function loadHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) || '[]')) } catch { return new Set() }
}
export function hidePass(id) {
  const s = loadHidden(); s.add(id)
  localStorage.setItem(HIDE_KEY, JSON.stringify([...s]))
}
