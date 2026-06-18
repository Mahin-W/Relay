// Pure, dependency-free helpers for the setup wizard. Imported by
// public/onboarding.js (browser) and unit-tested directly in Node.

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const WEEKDAYS = DAYS.slice(0, 5)

// Multi-day grid rows → flat per-day shift payloads for POST /setup/shift.
export function expandShiftRows(rows) {
  const out = []
  for (const r of rows || []) {
    if (!r || !r.name || !Array.isArray(r.days) || !r.days.length) continue
    for (const day of r.days) {
      out.push({
        name: r.name,
        day_of_week: day,
        start_time: r.start || '',
        end_time: r.end || '',
        requirements: r.requirements || [],
      })
    }
  }
  return out
}

// Day-expanded parser output → grouped multi-day rows (identical name+time merge).
export function groupParsedShifts(parsed) {
  const map = new Map()
  for (const s of parsed || []) {
    const key = `${s.name}|${s.start_time}|${s.end_time}`
    if (!map.has(key)) {
      map.set(key, { name: s.name, days: [], start: s.start_time, end: s.end_time, requirements: [] })
    }
    const g = map.get(key)
    if (!g.days.includes(s.day_of_week)) g.days.push(s.day_of_week)
    for (const req of (s.requirements || [])) {
      const ex = g.requirements.find(x => x.role === req.role)
      if (ex) ex.count = Math.max(ex.count, req.count)
      else g.requirements.push({ role: req.role, count: req.count })
    }
  }
  return [...map.values()]
}

// Forgiving time parse → "h:MM AM/PM" display (server re-normalizes to 24h on save).
export function normalizeTime(input) {
  if (input == null) return input
  const s = String(input).trim().toLowerCase()
  if (!s) return s
  let h, m = 0, mer = null, mm
  if ((mm = /^(\d{1,2}):(\d{2})\s*(a|p|am|pm)?$/.exec(s))) { h = +mm[1]; m = +mm[2]; mer = mm[3] }
  else if ((mm = /^(\d{1,2})\s*(a|p|am|pm)$/.exec(s))) { h = +mm[1]; mer = mm[2] }
  else if ((mm = /^(\d{3,4})$/.exec(s))) { h = +mm[1].slice(0, mm[1].length - 2); m = +mm[1].slice(-2) }
  else if ((mm = /^(\d{1,2})$/.exec(s))) { h = +mm[1] }
  else return String(input)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(input)
  if (mer) { const am = mer[0] === 'a'; if (am) h = (h === 12 ? 0 : h); else h = (h === 12 ? 12 : h + 12) }
  if (h < 0 || h > 23 || m < 0 || m > 59) return String(input)
  const suffix = h < 12 ? 'AM' : 'PM'
  let h12 = h % 12; if (h12 === 0) h12 = 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

export function splitNames(text) {
  return String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
}

export const TEMPLATES = {
  Restaurant: {
    roles: ['Server', 'Cook', 'Host', 'Bartender', 'Manager'],
    shifts: [
      { name: 'Lunch', days: WEEKDAYS.slice(), start: '11:00 AM', end: '3:00 PM', requirements: [] },
      { name: 'Dinner', days: DAYS.slice(), start: '5:00 PM', end: '10:00 PM', requirements: [] },
    ],
  },
  'Café': {
    roles: ['Barista', 'Cook', 'Cashier', 'Manager'],
    shifts: [
      { name: 'Open', days: DAYS.slice(), start: '7:00 AM', end: '12:00 PM', requirements: [] },
      { name: 'Afternoon', days: DAYS.slice(), start: '12:00 PM', end: '5:00 PM', requirements: [] },
    ],
  },
  Bar: {
    roles: ['Bartender', 'Server', 'Barback', 'Security', 'Manager'],
    shifts: [
      { name: 'Evening', days: DAYS.slice(), start: '5:00 PM', end: '11:00 PM', requirements: [] },
      { name: 'Late', days: ['Friday', 'Saturday'], start: '11:00 PM', end: '2:00 AM', requirements: [] },
    ],
  },
  Retail: {
    roles: ['Sales Associate', 'Cashier', 'Stock', 'Manager'],
    shifts: [
      { name: 'Opening', days: DAYS.slice(), start: '9:00 AM', end: '2:00 PM', requirements: [] },
      { name: 'Closing', days: DAYS.slice(), start: '2:00 PM', end: '8:00 PM', requirements: [] },
    ],
  },
  'Coffee shop': {
    roles: ['Barista', 'Cashier', 'Shift Lead'],
    shifts: [
      { name: 'Morning', days: DAYS.slice(), start: '6:00 AM', end: '11:00 AM', requirements: [] },
      { name: 'Midday', days: DAYS.slice(), start: '11:00 AM', end: '4:00 PM', requirements: [] },
    ],
  },
}
