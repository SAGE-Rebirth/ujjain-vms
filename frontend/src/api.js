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

// staff + citizen auth
export const login = (username, password) =>
  j(`${CENTRAL}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username, password }) })
export const otpRequest = (phone) =>
  j(`${CENTRAL}/api/auth/otp/request`, { method: 'POST', body: JSON.stringify({ phone }) })
export const otpVerify = (phone, code) =>
  j(`${CENTRAL}/api/auth/otp/verify`, { method: 'POST', body: JSON.stringify({ phone, code }) })
export const myBookings = () => j(`${CENTRAL}/api/my/bookings`, { headers: citizenH() })

// citizen booking
export const listZones = (date) => j(`${CENTRAL}/api/zones?date=${date}`)
export const zoneSlots = (zone, date, type = 'public') =>
  j(`${CENTRAL}/api/zones/${zone}/slots?date=${date}&slot_type=${type}`)
export const zoneLots = (zone) => j(`${CENTRAL}/api/zones/${zone}/lots`)
export const createBooking = (body) =>
  j(`${CENTRAL}/api/bookings`, { method: 'POST', body: JSON.stringify(body), headers: citizenH() })
export const getBooking = (id) => j(`${CENTRAL}/api/bookings/${id}`)
// Cancel a still-valid booking (frees capacity; the gate then denies the pass,
// even offline, once the cancellation syncs).
export const cancelBooking = (id) =>
  j(`${CENTRAL}/api/bookings/${id}/cancel`, { method: 'POST', headers: citizenH() })

// admin (staff token required)
export const overview = (date) => j(`${CENTRAL}/api/admin/overview?date=${date}`, { headers: staffH() })
export const audit = () => j(`${CENTRAL}/api/admin/audit?limit=80`, { headers: staffH() })
export const setLockdown = (scope, reason) =>
  j(`${CENTRAL}/api/admin/lockdown`, {
    method: 'POST', body: JSON.stringify({ scope, reason }), headers: staffH(),
  })
// Two-person lift: the acting commander's token + a second commander's credentials.
export const liftLockdown = (scope, second_username, second_password) =>
  j(`${CENTRAL}/api/admin/lockdown/${scope}/lift`, {
    method: 'POST', body: JSON.stringify({ second_username, second_password }), headers: staffH(),
  })
export const setCapacity = (zone_id, date, capacity) =>
  j(`${CENTRAL}/api/admin/capacity`, {
    method: 'POST', body: JSON.stringify({ zone_id, date, capacity }), headers: staffH(),
  })
// Reconcile no-shows for a date (commander). `as_of` defaults to end-of-day so the
// 2028-dated demo can show capacity being reclaimed.
export const reconcileNoshows = (date, as_of) =>
  j(`${CENTRAL}/api/admin/reconcile`, {
    method: 'POST', body: JSON.stringify({ date, as_of }), headers: staffH(),
  })

// checkpoint node lifecycle (command centre brings a zone's gate up/down) +
// parking visualisation. Central is the source of truth for gate base URLs now,
// so the UI no longer needs a hand-managed list.
export const nodesList = () => j(`${CENTRAL}/api/admin/nodes`, { headers: staffH() })
export const nodeUp = (zone) =>
  j(`${CENTRAL}/api/admin/nodes/${zone}/up`, { method: 'POST', headers: staffH() })
export const nodeDown = (zone) =>
  j(`${CENTRAL}/api/admin/nodes/${zone}/down`, { method: 'POST', headers: staffH() })
export const parking = (date) => j(`${CENTRAL}/api/admin/parking?date=${date}`, { headers: staffH() })

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
