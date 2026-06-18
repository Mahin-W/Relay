import { requireSession, authFetch, signOut } from './relayAuth.js'
import { DAYS, expandShiftRows, groupParsedShifts, normalizeTime, splitNames, TEMPLATES } from './onboardingHelpers.js'

const COMMON_ROLES = ['Server', 'Cook', 'Bartender', 'Host', 'Manager']
const errorEl = document.getElementById('error')
const showError = (m) => { errorEl.textContent = m; errorEl.classList.add('visible') }
const clearError = () => errorEl.classList.remove('visible')
let step = 0
let maxStep = 0

document.getElementById('logout-btn').addEventListener('click', () => signOut())

const roles = () => [...document.querySelectorAll('#role-rows .r-name')].map(i => i.value.trim()).filter(Boolean)
function roleOptions(selected = '') {
  const opts = roles().map(r => `<option ${r === selected ? 'selected' : ''}>${r}</option>`).join('')
  return `${opts}<option value="__new">＋ New role…</option>`
}
function refreshRoleSelects() {
  document.querySelectorAll('select.role-select').forEach(sel => {
    const cur = sel.value
    sel.innerHTML = roleOptions(cur)
  })
}

function setStep(n) {
  step = n; maxStep = Math.max(maxStep, n)
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n))
  document.querySelectorAll('#progress div').forEach(d => {
    const p = +d.dataset.p
    d.classList.toggle('done', p <= n)
    d.classList.toggle('clickable', p <= maxStep)
  })
  try { localStorage.setItem('relay_setup_step', String(n)) } catch {}
  if (n === 4) buildRateRows()
  if (n === 5) { buildReview(); startConnect() }
}
document.querySelectorAll('#progress div').forEach(d => {
  d.onclick = () => { const p = +d.dataset.p; if (p <= maxStep) setStep(p) }
})

function roleRow(name = '') {
  const div = document.createElement('div'); div.className = 'row'
  div.innerHTML = `<input class="form-input r-name" placeholder="Role (e.g. Server)" value="${name}"><button class="row-del">×</button>`
  div.querySelector('.row-del').onclick = () => div.remove()
  div.querySelector('.r-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRole() } })
  return div
}
function addRole(name = '') {
  const div = roleRow(name); document.getElementById('role-rows').appendChild(div)
  if (!name) div.querySelector('.r-name').focus()
  return div
}

function staffRow(name = '', role = '') {
  const div = document.createElement('div'); div.className = 'row'
  div.innerHTML = `<input class="form-input s-name" placeholder="Name" value="${name}">
    <select class="form-select role-select s-role">${roleOptions(role)}</select>
    <button class="row-del">×</button>`
  const sel = div.querySelector('.s-role')
  sel.addEventListener('change', () => { if (sel.value === '__new') promptNewRole(sel) })
  div.querySelector('.row-del').onclick = () => div.remove()
  div.querySelector('.s-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addStaff() } })
  return div
}
function addStaff(name = '', role = '') {
  const div = staffRow(name, role); document.getElementById('staff-rows').appendChild(div)
  if (!name) div.querySelector('.s-name').focus()
  return div
}

function promptNewRole(sel) {
  const name = window.prompt('New role name:')
  if (name && name.trim()) {
    if (!roles().includes(name.trim())) addRole(name.trim())
    refreshRoleSelects(); sel.value = name.trim()
  } else { sel.selectedIndex = 0 }
}

function shiftCard(data = {}) {
  const div = document.createElement('div'); div.className = 'shift-card'
  const days = new Set(data.days || [])
  div.innerHTML = `
    <div class="shift-top">
      <input class="form-input sh-name" placeholder="Name (e.g. Lunch)" value="${data.name || ''}" style="flex:1;min-width:120px">
      <input class="form-input sh-start" placeholder="11am" value="${data.start || ''}" style="max-width:90px">
      <input class="form-input sh-end" placeholder="3pm" value="${data.end || ''}" style="max-width:90px">
      <button class="row-del sh-dup" title="Duplicate">⎘</button>
      <button class="row-del sh-del" title="Remove">×</button>
    </div>
    <div class="presets">
      <button class="chip" data-preset="weekdays" type="button">Weekdays</button>
      <button class="chip" data-preset="all" type="button">Every day</button>
      <button class="chip" data-preset="weekend" type="button">Weekend</button>
    </div>
    <div class="day-chips">${DAYS.map(d => `<div class="day-chip ${days.has(d) ? 'on' : ''}" data-day="${d}">${d.slice(0, 2)}</div>`).join('')}</div>
    <button class="btn-skip sh-staffing-toggle" type="button" style="margin-top:8px">+ staffing</button>
    <div class="staffing" style="display:${(data.requirements && data.requirements.length) ? 'block' : 'none'}"></div>`

  const dayChips = div.querySelector('.day-chips')
  dayChips.querySelectorAll('.day-chip').forEach(c => c.onclick = () => c.classList.toggle('on'))
  div.querySelectorAll('.presets .chip').forEach(btn => btn.onclick = () => {
    const map = { weekdays: DAYS.slice(0, 5), all: DAYS, weekend: ['Saturday', 'Sunday'] }
    const want = new Set(map[btn.dataset.preset])
    dayChips.querySelectorAll('.day-chip').forEach(c => c.classList.toggle('on', want.has(c.dataset.day)))
  })
  div.querySelector('.sh-del').onclick = () => div.remove()
  div.querySelector('.sh-dup').onclick = () => div.after(shiftCard(readShiftCard(div)))
  const staffingEl = div.querySelector('.staffing')
  div.querySelector('.sh-staffing-toggle').onclick = () => {
    staffingEl.style.display = staffingEl.style.display === 'none' ? 'block' : 'none'
    if (staffingEl.style.display === 'block' && !staffingEl.children.length) addStaffingRow(staffingEl)
  }
  for (const r of (data.requirements || [])) addStaffingRow(staffingEl, r.role, r.count)
  return div
}
function addStaffingRow(container, role = '', count = 1) {
  const row = document.createElement('div'); row.className = 'row'
  row.innerHTML = `<select class="form-select role-select st-role">${roleOptions(role)}</select>
    <input class="form-input st-count" type="number" min="1" value="${count}" style="max-width:80px">
    <button class="row-del">×</button>`
  row.querySelector('.row-del').onclick = () => row.remove()
  const sel = row.querySelector('.st-role')
  sel.addEventListener('change', () => { if (sel.value === '__new') promptNewRole(sel) })
  container.appendChild(row)
}
function readShiftCard(div) {
  return {
    name: div.querySelector('.sh-name').value.trim(),
    start: div.querySelector('.sh-start').value.trim(),
    end: div.querySelector('.sh-end').value.trim(),
    days: [...div.querySelectorAll('.day-chip.on')].map(c => c.dataset.day),
    requirements: [...div.querySelectorAll('.staffing .row')].map(r => ({
      role: r.querySelector('.st-role').value,
      count: Number(r.querySelector('.st-count').value) || 1,
    })).filter(r => r.role && r.role !== '__new'),
  }
}
function addShift(data) { document.getElementById('shift-rows').appendChild(shiftCard(data)) }

function buildRateRows() {
  const container = document.getElementById('rate-rows'); container.innerHTML = ''
  const existingRates = window._rates || {}
  for (const role of roles()) {
    const div = document.createElement('div'); div.className = 'row'
    div.innerHTML = `<input class="form-input r-role" value="${role}" readonly style="flex:1">
      <input class="form-input r-rate" type="number" step="0.25" placeholder="$/hr" value="${existingRates[role] ?? ''}" style="max-width:140px">`
    container.appendChild(div)
  }
  if (!roles().length) container.innerHTML = '<p class="muted">No roles yet — add some in the Roles step.</p>'
}

function buildReview() {
  const el = document.getElementById('review')
  const staff = [...document.querySelectorAll('#staff-rows .row')].map(r => `${r.querySelector('.s-name').value} (${r.querySelector('.s-role').value})`).filter(s => s.trim()[0])
  const shifts = [...document.querySelectorAll('#shift-rows .shift-card')].map(c => { const d = readShiftCard(c); return `${d.name}: ${d.days.map(x => x.slice(0, 2)).join(' ')} ${d.start}–${d.end}` }).filter(s => s.trim()[0])
  const section = (title, items, goto) => `<div class="review-section"><h3>${title} <button class="review-edit" data-goto="${goto}">edit</button></h3><div class="muted">${items.length ? items.join('<br>') : '—'}</div></div>`
  el.innerHTML =
    section('Roles', roles(), 1) +
    section('Team', staff, 2) +
    section('Shifts', shifts, 3)
  el.querySelectorAll('.review-edit').forEach(b => b.onclick = () => setStep(+b.dataset.goto))
}

async function saveRoles() {
  for (const role of roles()) { try { await authFetch('/api/account/setup/role', { method: 'POST', body: { role } }) } catch {} }
}
async function saveStaff() {
  for (const r of document.querySelectorAll('#staff-rows .row')) {
    const name = r.querySelector('.s-name').value.trim()
    const roleSel = r.querySelector('.s-role').value
    const role = roleSel === '__new' ? 'Staff' : roleSel
    if (name && !r.dataset.saved) {
      try { const res = await authFetch('/api/account/setup/staff', { method: 'POST', body: { name, role } }); r.dataset.saved = res?.id || '1' } catch {}
    }
  }
}
async function saveShifts() {
  const rows = [...document.querySelectorAll('#shift-rows .shift-card')].map(readShiftCard)
  for (const s of expandShiftRows(rows)) {
    try { await authFetch('/api/account/setup/shift', { method: 'POST', body: { name: s.name, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, requirements: s.requirements } }) } catch {}
  }
}
async function saveRates() {
  for (const r of document.querySelectorAll('#rate-rows .row')) {
    const role = r.querySelector('.r-role')?.value
    const rate = r.querySelector('.r-rate')?.value
    if (role && rate !== '') { try { await authFetch('/api/account/setup/rate', { method: 'PATCH', body: { role, hourly_rate: Number(rate) } }) } catch {} }
  }
}
async function saveBusinessName() {
  const v = document.getElementById('business-name').value.trim()
  if (v) { try { await authFetch('/api/account/setup/business-name', { method: 'POST', body: { name: v } }) } catch {} }
}

async function handleNext() {
  clearError()
  try {
    if (step === 0) await saveBusinessName()
    else if (step === 1) await saveRoles()
    else if (step === 2) { await saveRoles(); await saveStaff() }
    else if (step === 3) await saveShifts()
    else if (step === 4) await saveRates()
    setStep(step + 1)
  } catch (err) { showError(err.message || 'Could not save — try again.') }
}
document.querySelectorAll('[data-next]').forEach(b => b.onclick = handleNext)
document.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => setStep(step + 1))

document.getElementById('add-role').onclick = () => addRole()
document.getElementById('add-staff').onclick = () => addStaff()
document.getElementById('add-shift').onclick = () => addShift()
document.getElementById('paste-staff').onclick = () => {
  const text = window.prompt('Paste names (one per line or comma-separated):')
  for (const n of splitNames(text)) addStaff(n)
}

function renderTemplateChips() {
  const c = document.getElementById('template-chips')
  c.innerHTML = Object.keys(TEMPLATES).map(t => `<button class="chip" type="button" data-tpl="${t}">${t}</button>`).join('')
  c.querySelectorAll('.chip').forEach(btn => btn.onclick = () => applyTemplate(btn.dataset.tpl, btn))
}
function applyTemplate(name, btn) {
  const tpl = TEMPLATES[name]; if (!tpl) return
  document.querySelectorAll('#template-chips .chip').forEach(c => c.classList.remove('on'))
  btn.classList.add('on')
  for (const role of tpl.roles) if (!roles().includes(role)) addRole(role)
  refreshRoleSelects()
  const shiftRows = document.getElementById('shift-rows')
  if (!shiftRows.children.length) for (const s of tpl.shifts) addShift(s)
}

document.getElementById('role-suggest').innerHTML =
  'Common: ' + COMMON_ROLES.map(r => `<button class="chip" type="button" data-role="${r}">${r}</button>`).join('')
document.querySelectorAll('#role-suggest .chip').forEach(b => b.onclick = () => { if (!roles().includes(b.dataset.role)) addRole(b.dataset.role) })

document.getElementById('staff-parse').onclick = async () => {
  clearError()
  const text = document.getElementById('staff-desc').value.trim(); if (!text) return
  try {
    const { staff } = await authFetch('/api/account/setup/parse-staff', { method: 'POST', body: { text } })
    for (const s of (staff || [])) { if (s.role && !roles().includes(s.role)) addRole(s.role) }
    refreshRoleSelects()
    for (const s of (staff || [])) addStaff(s.name, s.role || 'Staff')
    document.getElementById('staff-desc').value = ''
  } catch (err) {
    if (err.status === 503) document.getElementById('staff-ai').style.display = 'none'
    else showError("Couldn't read that — add rows manually.")
  }
}
document.getElementById('shift-parse').onclick = async () => {
  clearError()
  const text = document.getElementById('shift-desc').value.trim(); if (!text) return
  try {
    const { shifts } = await authFetch('/api/account/setup/parse-shifts', { method: 'POST', body: { text } })
    for (const row of groupParsedShifts(shifts || [])) {
      for (const r of row.requirements) if (r.role && !roles().includes(r.role)) addRole(r.role)
      addShift(row)
    }
    refreshRoleSelects()
    document.getElementById('shift-desc').value = ''
  } catch (err) {
    if (err.status === 503) document.getElementById('shift-ai').style.display = 'none'
    else showError("Couldn't read that — add rows manually.")
  }
}

document.getElementById('shift-rows').addEventListener('blur', e => {
  if (e.target.classList?.contains('sh-start') || e.target.classList?.contains('sh-end')) {
    e.target.value = normalizeTime(e.target.value)
  }
}, true)

let pollTimer = null
async function startConnect() {
  try {
    const { deepLink } = await authFetch('/api/account/link-code', { method: 'POST' })
    document.getElementById('deep-link').href = deepLink
  } catch (err) { showError(err.message || 'Could not generate a linking code.') }
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(checkConnection, 4000); checkConnection()
}
async function checkConnection() {
  try {
    const s = await authFetch('/api/account/connection-status')
    if (s.connected) {
      const el = document.getElementById('conn-status')
      el.textContent = '✓ Connected to ' + (s.restaurantName || 'your group') + '!'
      el.classList.add('connected')
      document.getElementById('go-dashboard').style.display = ''
      if (s.inviteLink) { document.getElementById('invite-link').value = s.inviteLink; document.getElementById('invite-block').style.display = '' }
      if (pollTimer) clearInterval(pollTimer)
    }
  } catch {}
}
document.getElementById('copy-invite').onclick = () => {
  const el = document.getElementById('invite-link'); el.select()
  navigator.clipboard?.writeText(el.value).catch(() => {})
  const b = document.getElementById('copy-invite'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 1500)
}
document.getElementById('go-dashboard').onclick = () => location.href = '/dashboard'
document.getElementById('finish-later').onclick = () => location.href = '/dashboard'

;(async () => {
  await requireSession()
  await authFetch('/api/account/bootstrap', { method: 'POST' }).catch(() => {})
  renderTemplateChips()
  try {
    const s = await authFetch('/api/account/connection-status')
    if (s.connected && s.setupComplete) { location.href = '/dashboard'; return }
  } catch {}
  try {
    const d = await authFetch('/api/account/setup')
    if (d.businessName) document.getElementById('business-name').value = d.businessName
    window._rates = {}
    for (const r of (d.roles || [])) { addRole(r.name); window._rates[r.name] = r.rate }
    for (const st of (d.staff || [])) { const row = addStaff(st.name, st.role); row.dataset.saved = st.id }
    const grouped = groupParsedShifts((d.shifts || []).map(s => ({ name: s.name, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, requirements: s.requirements })))
    for (const g of grouped) addShift(g)
  } catch {}
  if (!document.querySelector('#role-rows .row')) addRole()
  if (!document.querySelector('#staff-rows .row')) addStaff()
  if (!document.querySelector('#shift-rows .shift-card')) addShift({ days: [] })
})()
