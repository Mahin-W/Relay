import { getOpenRequest as liveGetOpenRequest, markCovered as liveMarkCovered } from '../db.js'
import { logger } from '../logger.js'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Parse any time string to decimal hours.
 * Handles: "9pm", "21:00", "9:00pm", "9:00 AM", "11am"
 */
function parseHour(timeStr) {
  if (!timeStr) return 0
  const s = String(timeStr).trim().toLowerCase().replace(/\s+/g, '')
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (h24) return parseInt(h24[1], 10) + parseInt(h24[2], 10) / 60
  const h12full = s.match(/^(\d{1,2}):(\d{2})(am|pm)$/)
  if (h12full) {
    let h = parseInt(h12full[1], 10)
    const min = parseInt(h12full[2], 10) / 60
    if (h12full[3] === 'pm' && h !== 12) h += 12
    if (h12full[3] === 'am' && h === 12) h = 0
    return h + min
  }
  const h12 = s.match(/^(\d{1,2})(am|pm)$/)
  if (h12) {
    let h = parseInt(h12[1], 10)
    if (h12[2] === 'pm' && h !== 12) h += 12
    if (h12[2] === 'am' && h === 12) h = 0
    return h
  }
  return 0
}

function decimalToTimeStr(decimal) {
  // Handle 24+ for midnight crossing
  const normalized = decimal >= 24 ? decimal - 24 : decimal
  const h = Math.floor(normalized)
  const min = Math.round((normalized - h) * 60)
  const minStr = min === 0 ? '00' : String(min).padStart(2, '0')
  const period = h >= 12 && h < 24 ? 'pm' : 'am'
  const displayH = h === 0 || h === 24 ? 12 : h > 12 ? h - 12 : h
  return `${displayH}:${minStr}${period}`
}

// ── Pure functions ────────────────────────────────────────────────────────────

/**
 * Calculates the midpoint time string between two time strings.
 * Handles midnight crossing (e.g. 10pm to 2am).
 */
function getMidpoint(startTime, endTime) {
  let startH = parseHour(startTime)
  let endH = parseHour(endTime)
  // Handle midnight crossing: if end < start, add 24 to end
  if (endH < startH) endH += 24
  const mid = (startH + endH) / 2
  return decimalToTimeStr(mid)
}

/**
 * Returns { coverFrom, coverUntil } strings based on portion type and shift times.
 */
export function parseTimeReference(intent, shift) {
  const { portion, timeReference } = intent
  const { startTime, endTime } = shift
  const midpoint = getMidpoint(startTime, endTime)

  const fmt = (t) => decimalToTimeStr(parseHour(t))

  switch (portion) {
    case 'first_half':
      return { coverFrom: fmt(startTime), coverUntil: midpoint }
    case 'second_half':
      return { coverFrom: midpoint, coverUntil: fmt(endTime) }
    case 'until':
      return { coverFrom: fmt(startTime), coverUntil: fmt(timeReference) }
    case 'from':
      return { coverFrom: fmt(timeReference), coverUntil: fmt(endTime) }
    case 'range': {
      // timeReference like "11am to 2pm" or "11am-2pm"
      const parts = (timeReference || '').split(/\s*(?:to|-)\s*/i)
      if (parts.length === 2) {
        return { coverFrom: fmt(parts[0].trim()), coverUntil: fmt(parts[1].trim()) }
      }
      return { coverFrom: fmt(startTime), coverUntil: fmt(endTime) }
    }
    default:
      return { coverFrom: fmt(startTime), coverUntil: fmt(endTime) }
  }
}

/**
 * Returns uncovered time ranges for a shift given existing partial coverages.
 */
export function calculateRemainingCoverage(shift, partialCoverages) {
  const shiftStart = parseHour(shift.startTime)
  const rawEnd = parseHour(shift.endTime)
  const shiftEnd = rawEnd < shiftStart ? rawEnd + 24 : rawEnd

  if (!partialCoverages.length) {
    return [{ from: decimalToTimeStr(shiftStart), until: decimalToTimeStr(shiftEnd) }]
  }

  // Convert all partials to decimal ranges (handle both camelCase and snake_case)
  const covered = partialCoverages.map(p => {
    const s = parseHour(p.coverFrom ?? p.cover_from)
    const e = parseHour(p.coverUntil ?? p.cover_until)
    return [Math.max(s, shiftStart), Math.min(e < s ? e + 24 : e, shiftEnd)]
  }).filter(([s, e]) => s < e)

  // Sort and merge overlapping intervals
  covered.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [s, e] of covered) {
    if (!merged.length || merged[merged.length - 1][1] < s) {
      merged.push([s, e])
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e)
    }
  }

  // Find gaps
  const gaps = []
  let cursor = shiftStart
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push({ from: decimalToTimeStr(cursor), until: decimalToTimeStr(s) })
    cursor = e
  }
  if (cursor < shiftEnd) gaps.push({ from: decimalToTimeStr(cursor), until: decimalToTimeStr(shiftEnd) })

  return gaps
}

export function isFullyCovered(shift, partialCoverages) {
  return calculateRemainingCoverage(shift, partialCoverages).length === 0
}

export function formatPartialCoverageMessage(shiftName, volunteer, coverFrom, coverUntil, remaining) {
  let msg = `✅ *${volunteer}* will cover *${shiftName}* from ${coverFrom} to ${coverUntil}.\n`

  if (remaining.length > 0) {
    const gapList = remaining.map(g => `${g.from}–${g.until}`).join(', ')
    msg += `\n📋 Still need coverage from ${gapList}.\nAnyone available for this portion?`
  }

  return msg
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function liveGetShiftById(shiftId) {
  try {
    const { data, error } = await supabase
      .from('shifts').select('*').eq('id', shiftId).maybeSingle()
    if (error) throw error
    return data
  } catch (err) {
    logger.error(`getShiftById failed: ${err.message}`)
    return null
  }
}

async function liveGetPartialCoverages(requestId) {
  try {
    const { data, error } = await supabase
      .from('partial_coverage').select('*').eq('coverage_request_id', requestId)
    if (error) throw error
    return data ?? []
  } catch (err) {
    logger.error(`getPartialCoverages failed: ${err.message}`)
    return []
  }
}

async function liveSavePartialCoverage(data) {
  try {
    const { data: row, error } = await supabase
      .from('partial_coverage').insert(data).select().single()
    if (error) throw error
    return row
  } catch (err) {
    logger.error(`savePartialCoverage failed: ${err.message}`)
    return null
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handlePartialCoverageOffer(bot, msg, intent, db = null) {
  const _getOpenRequest      = db?.getOpenRequest      ?? (() => liveGetOpenRequest(String(msg.chat.id)))
  const _getShiftById        = db?.getShiftById        ?? liveGetShiftById
  const _getPartialCoverages = db?.getPartialCoverages ?? liveGetPartialCoverages
  const _savePartialCoverage = db?.savePartialCoverage ?? liveSavePartialCoverage
  const _markCovered         = db?.markCovered         ?? liveMarkCovered

  const groupId   = String(msg.chat.id)
  const volunteer = intent.person || msg.from?.first_name || 'Someone'

  const openRequest = await _getOpenRequest()
  if (!openRequest) {
    await bot.sendMessage(msg.chat.id, 'No open coverage requests right now 👍')
    return
  }

  const shift = await _getShiftById(openRequest.matched_shift_id)
  if (!shift) {
    await bot.sendMessage(msg.chat.id, 'Could not find shift details. Try again shortly.')
    return
  }

  const shiftForCalc = { startTime: shift.start_time, endTime: shift.end_time }
  const { coverFrom, coverUntil } = parseTimeReference(intent, shiftForCalc)

  await _savePartialCoverage({
    coverage_request_id: openRequest.id,
    staff_name: volunteer,
    staff_id: null,
    cover_from: coverFrom,
    cover_until: coverUntil,
    group_id: groupId,
  })

  const allPartials = await _getPartialCoverages(openRequest.id)
  // Normalize partial records to { coverFrom, coverUntil }
  // Include current offer in case DB doesn't return the just-saved record yet
  const normalizedPartials = [
    ...allPartials.map(p => ({
      coverFrom: p.cover_from ?? p.coverFrom,
      coverUntil: p.cover_until ?? p.coverUntil,
    })),
    { coverFrom, coverUntil },
  ]

  if (isFullyCovered(shiftForCalc, normalizedPartials)) {
    // Build the full coverage confirmation
    const coverageList = allPartials.map(p =>
      `• ${p.staff_name ?? p.staffName}: ${p.cover_from ?? p.coverFrom}–${p.cover_until ?? p.coverUntil}`
    ).join('\n')

    await bot.sendMessage(msg.chat.id,
      `✅ *${shift.name}* is fully covered!\n\n${coverageList}`,
      { parse_mode: 'Markdown' })

    await _markCovered(openRequest.id, volunteer)
  } else {
    const remaining = calculateRemainingCoverage(shiftForCalc, normalizedPartials)
    const text = formatPartialCoverageMessage(shift.name, volunteer, coverFrom, coverUntil, remaining)
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' })
  }
}
