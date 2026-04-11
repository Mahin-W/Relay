import { getRules, deactivateRule } from './rulesDb.js'

// ── extractRule (LLM) ────────────────────────────────────────────────────────

const RULE_SYSTEM_PROMPT = `You extract scheduling rules from natural language messages.
Given a message from a restaurant manager, determine if it contains a scheduling rule.

Rule types:
- staff_conflict: Two staff members should never work together
- time_constraint: A staff member must leave by a certain time on specific days
- day_off: A staff member cannot work on a specific day
- shift_preference: A staff member prefers certain types of shifts

Return JSON (no markdown):
{
  "isRule": true/false,
  "type": "staff_conflict" | "time_constraint" | "day_off" | "shift_preference",
  "subjectName": "primary staff name or null",
  "objectName": "second staff name or null (for staff_conflict)",
  "constraint": "human-readable summary of the rule",
  "dayOfWeek": "Monday" | "Tuesday" | etc. or null,
  "latestEndTime": "HH:MM in 24h format or null",
  "shiftPreference": "morning/afternoon/evening/night or null"
}

If the message is not a scheduling rule, return: {"isRule": false}`

export async function extractRule(text, staff, shifts, groupId) {
  // Lazy import to avoid module-level crash when CEREBRAS_API_KEY is missing
  const { groqWithRetry, extractJSON, groq } = await import('../parsers/groq.js')
  const staffNames = staff.map(s => s.name).join(', ')
  const shiftNames = shifts.map(s => `${s.name} (${s.dayOfWeek} ${s.startTime}-${s.endTime})`).join(', ')

  const userPrompt = `Staff: ${staffNames}
Shifts: ${shiftNames}

Message: "${text}"

Extract the scheduling rule if present.`

  const response = await groqWithRetry(() =>
    groq.chat.completions.create({
      model: 'llama3.1-8b',
      messages: [
        { role: 'system', content: RULE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
    })
  )

  const raw = response.choices[0]?.message?.content ?? ''
  let parsed
  try {
    parsed = JSON.parse(extractJSON(raw))
  } catch {
    return { isRule: false }
  }

  if (!parsed.isRule) return { isRule: false }

  // Resolve staff names to IDs
  const subjectStaffId = resolveStaffId(parsed.subjectName, staff)
  const objectStaffId = resolveStaffId(parsed.objectName, staff)

  return {
    isRule: true,
    rule: {
      type: parsed.type,
      subjectStaffId,
      objectStaffId,
      constraint: parsed.constraint || text,
      raw: text,
      dayOfWeek: parsed.dayOfWeek || null,
      latestEndTime: parsed.latestEndTime || null,
      shiftPreference: parsed.shiftPreference || null,
      active: true,
    },
  }
}

function resolveStaffId(name, staff) {
  if (!name) return null
  const lower = name.toLowerCase()
  // Prefer exact match
  const exact = staff.find(s => s.name.toLowerCase() === lower)
  if (exact) return exact.id
  // Partial match
  const partial = staff.find(s => s.name.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()))
  return partial ? partial.id : null
}

// ── applyRulesToAssignments (pure) ───────────────────────────────────────────

function parseTime24(timeStr) {
  if (!timeStr) return null
  // Handle "HH:MM" 24h format
  const match24 = timeStr.match(/^(\d{1,2}):(\d{2})$/)
  if (match24) return parseInt(match24[1]) * 60 + parseInt(match24[2])
  // Handle "11pm", "4pm", "9am" etc
  const match12 = timeStr.match(/^(\d{1,2})(:\d{2})?\s*(am|pm)$/i)
  if (match12) {
    let h = parseInt(match12[1])
    const m = match12[2] ? parseInt(match12[2].slice(1)) : 0
    const period = match12[3].toLowerCase()
    if (period === 'pm' && h !== 12) h += 12
    if (period === 'am' && h === 12) h = 0
    return h * 60 + m
  }
  return null
}

export function applyRulesToAssignments(assignments, shifts, staff, rules) {
  const conflicts = []

  for (const rule of rules) {
    if (rule.active === false) continue

    if (rule.type === 'staff_conflict') {
      // Check if both subject and object are assigned to the same shift
      const subjectShiftIds = assignments.filter(a => a.staffId === rule.subjectStaffId).map(a => a.shiftId)
      const objectShiftIds = assignments.filter(a => a.staffId === rule.objectStaffId).map(a => a.shiftId)
      const overlap = subjectShiftIds.filter(id => objectShiftIds.includes(id))
      for (const shiftId of overlap) {
        const shift = shifts.find(s => s.id === shiftId)
        const subjectName = staff.find(s => s.id === rule.subjectStaffId)?.name ?? 'Unknown'
        const objectName = staff.find(s => s.id === rule.objectStaffId)?.name ?? 'Unknown'
        conflicts.push({
          ruleId: rule.id,
          constraint: rule.constraint,
          staffName: subjectName,
          shiftName: shift?.name ?? `Shift #${shiftId}`,
          description: `${subjectName} and ${objectName} both on ${shift?.name ?? `Shift #${shiftId}`}`,
        })
      }
    }

    if (rule.type === 'time_constraint') {
      const subjectAssignments = assignments.filter(a => a.staffId === rule.subjectStaffId)
      for (const a of subjectAssignments) {
        const shift = shifts.find(s => s.id === a.shiftId)
        if (!shift) continue
        if (rule.dayOfWeek && shift.dayOfWeek !== rule.dayOfWeek) continue
        const shiftEnd = parseTime24(shift.endTime)
        const ruleLimit = parseTime24(rule.latestEndTime)
        if (shiftEnd !== null && ruleLimit !== null && shiftEnd > ruleLimit) {
          const subjectName = staff.find(s => s.id === rule.subjectStaffId)?.name ?? 'Unknown'
          conflicts.push({
            ruleId: rule.id,
            constraint: rule.constraint,
            staffName: subjectName,
            shiftName: shift.name,
            description: `${subjectName} assigned to ${shift.name} (ends ${shift.endTime}) but must leave by ${rule.latestEndTime}`,
          })
        }
      }
    }

    if (rule.type === 'day_off') {
      const subjectAssignments = assignments.filter(a => a.staffId === rule.subjectStaffId)
      for (const a of subjectAssignments) {
        const shift = shifts.find(s => s.id === a.shiftId)
        if (!shift) continue
        if (shift.dayOfWeek === rule.dayOfWeek) {
          const subjectName = staff.find(s => s.id === rule.subjectStaffId)?.name ?? 'Unknown'
          conflicts.push({
            ruleId: rule.id,
            constraint: rule.constraint,
            staffName: subjectName,
            shiftName: shift.name,
            description: `${subjectName} assigned on ${rule.dayOfWeek} but has day off`,
          })
        }
      }
    }

    // shift_preference: informational only — flag if outside preference
    if (rule.type === 'shift_preference') {
      const subjectAssignments = assignments.filter(a => a.staffId === rule.subjectStaffId)
      for (const a of subjectAssignments) {
        const shift = shifts.find(s => s.id === a.shiftId)
        if (!shift) continue
        const startMinutes = parseTime24(shift.startTime)
        if (startMinutes === null) continue
        const pref = rule.shiftPreference?.toLowerCase()
        let outside = false
        if (pref === 'morning' && startMinutes >= 720) outside = true  // noon
        if (pref === 'afternoon' && (startMinutes < 720 || startMinutes >= 1020)) outside = true
        if (pref === 'evening' && startMinutes < 1020) outside = true  // 5pm
        if (pref === 'night' && startMinutes < 1200) outside = true    // 8pm
        if (outside) {
          const subjectName = staff.find(s => s.id === rule.subjectStaffId)?.name ?? 'Unknown'
          conflicts.push({
            ruleId: rule.id,
            constraint: rule.constraint,
            staffName: subjectName,
            shiftName: shift.name,
            description: `${subjectName} prefers ${pref} shifts but assigned to ${shift.name}`,
          })
        }
      }
    }
  }

  return { valid: conflicts.length === 0, conflicts }
}

// ── formatRuleConflicts (pure) ───────────────────────────────────────────────

export function formatRuleConflicts(conflicts) {
  if (!conflicts || conflicts.length === 0) return null
  const lines = conflicts.map(c =>
    `- ${c.description} (rule: "${c.constraint}")`
  )
  return `⚠️ *Schedule conflicts with business rules:*\n\n${lines.join('\n')}\n\nReply "approve anyway" to override these rules.`
}

// ── handleListRules ──────────────────────────────────────────────────────────

export async function handleListRules(bot, msg, groupId, db = null) {
  const rules = await getRules(groupId, db)

  if (!rules || rules.length === 0) {
    await bot.sendMessage(msg.chat.id, 'No rules saved yet.')
    return
  }

  const lines = rules.map((r, i) => {
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : 'unknown'
    const constraint = r.constraint_text || r.constraint
    return `${i + 1}. ${constraint} (added ${date})`
  })

  await bot.sendMessage(msg.chat.id, `📋 *Active scheduling rules:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' })
}

// ── handleDeleteRule ─────────────────────────────────────────────────────────

export async function handleDeleteRule(bot, msg, ruleNumber, groupId, db = null) {
  const rules = await getRules(groupId, db)

  if (!rules || ruleNumber < 1 || ruleNumber > rules.length) {
    const max = rules?.length || 0
    await bot.sendMessage(msg.chat.id, `Invalid rule number. Please choose between 1 and ${max}.`)
    return
  }

  const rule = rules[ruleNumber - 1]
  await deactivateRule(rule.id, groupId, db)

  const constraint = rule.constraint_text || rule.constraint
  await bot.sendMessage(msg.chat.id, `✅ Rule removed: "${constraint}"`)
}
