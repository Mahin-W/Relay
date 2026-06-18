// Normalize a free-typed time into canonical 24h "HH:MM". Shared by the
// dashboard shift routes and the wizard setup routes so both behave identically.
export function normalizeShiftTime(raw) {
  if (raw == null) return raw
  if (typeof raw !== 'string') return raw
  const s = raw.trim()
  if (!s) return s
  // Already canonical-ish: HH:MM[:SS]
  const hhmm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (hhmm) {
    const h = Number(hhmm[1]), m = Number(hhmm[2])
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
    return s
  }
  // 12-hour with AM/PM marker: "4:30 PM", "4pm", "12am"
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s)
  if (ampm) {
    let h = Number(ampm[1]); const m = Number(ampm[2] || 0); const mer = ampm[3].toLowerCase()
    if (!Number.isFinite(h) || h < 1 || h > 12 || m < 0 || m >= 60) return s
    if (mer === 'am') h = (h === 12) ? 0 : h
    else h = (h === 12) ? 12 : h + 12
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  // Bare hour ("4", "04", "16") with no AM/PM is ambiguous — leave alone.
  return s
}
