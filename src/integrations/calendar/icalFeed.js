// iCal feed generation (Epic 7 / WP-7.3) — PURE.
//
// buildIcsFeed(staffName, shifts) → a valid RFC 5545 VCALENDAR string with one
// VEVENT per shift, so staff can subscribe to their schedule in Google/Apple
// Calendar. Pure string building; serving the feed over HTTP is a thin route
// (merge-time wiring). Times are treated as UTC (basic format, trailing Z).

const escapeText = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

function toUtcStamp(date, time) {
  if (!date) return null
  const [y, mo, d] = String(date).split('-')
  if (!y || !mo || !d) return null
  const [h = '00', mi = '00'] = String(time || '00:00').split(':')
  return `${y}${mo}${d}T${h.padStart(2, '0')}${mi.padStart(2, '0')}00Z`
}

/**
 * @param {string} staffName
 * @param {Array<{date:string, start?:string, end?:string, name?:string}>} shifts
 * @returns {string} ICS (CRLF-delimited)
 */
export function buildIcsFeed(staffName, shifts = []) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Relay//Shifts//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(`${staffName || 'My'} Shifts`)}`,
  ]
  for (const s of shifts ?? []) {
    const dtStart = toUtcStamp(s.date, s.start)
    if (!dtStart) continue
    const dtEnd = toUtcStamp(s.date, s.end) || dtStart
    const uid = `${s.date}-${String(s.start || '').replace(':', '')}-${escapeText(s.name || 'shift')}@relay`.replace(/\s+/g, '')
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTART:${dtStart}`, `DTEND:${dtEnd}`, `SUMMARY:${escapeText(s.name || 'Shift')}`, 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n')
}
