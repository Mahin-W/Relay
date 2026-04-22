import { groq, groqWithRetry, extractJSON, GROQ_MODEL } from '../parsers/groq.js'
import { getRules, deactivateRule, saveRule } from './rulesDb.js'

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
      model: GROQ_MODEL,
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
  rules = rules ?? []
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

// ── detectRuleConflicts (pure) ───────────────────────────────────────────────
// Returns array of { ruleIdA, ruleIdB, description } for contradictory rule pairs.

export function detectRuleConflicts(rules) {
  if (!rules) return []
  const conflicts = []
  const active = rules.filter(r => r.active !== false)

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]

      const sidA = a.subjectStaffId ?? a.subject_staff_id ?? null
      const sidB = b.subjectStaffId ?? b.subject_staff_id ?? null
      const typeA = a.type
      const typeB = b.type

      // 1. day_off AND always-required for same staff on same day
      const isDayOff = (r) => r.type === 'day_off'
      const isAlwaysRequired = (r) => r.type === 'always-required' || r.type === 'always_required'

      if (isDayOff(a) && isAlwaysRequired(b)) {
        const dayA = a.dayOfWeek ?? a.day_of_week
        const dayB = b.dayOfWeek ?? b.day_of_week
        if (sidA && sidA === sidB && dayA && dayA === dayB) {
          conflicts.push({ ruleIdA: a.id, ruleIdB: b.id, description: `Staff #${sidA} has day_off on ${dayA} but also always-required on that day` })
        }
      } else if (isAlwaysRequired(a) && isDayOff(b)) {
        const dayA = a.dayOfWeek ?? a.day_of_week
        const dayB = b.dayOfWeek ?? b.day_of_week
        if (sidA && sidA === sidB && dayA && dayA === dayB) {
          conflicts.push({ ruleIdA: a.id, ruleIdB: b.id, description: `Staff #${sidA} has always-required on ${dayA} but also day_off on that day` })
        }
      }

      // 2. Duplicate rules (same type, same subject, same constraint_text)
      const textA = a.constraint_text ?? a.constraint ?? ''
      const textB = b.constraint_text ?? b.constraint ?? ''
      if (typeA === typeB && sidA !== null && sidA === sidB && textA && textA === textB) {
        conflicts.push({ ruleIdA: a.id, ruleIdB: b.id, description: `Duplicate rules: same type "${typeA}", same staff, same constraint text` })
      }

      // 3. always-required AND staff_conflict/never-together where the always-required subject is also in the conflict
      const isNeverTogether = (r) => r.type === 'staff_conflict' || r.type === 'never-together' || r.type === 'never_together'

      if (isAlwaysRequired(a) && isNeverTogether(b)) {
        const oidB = b.objectStaffId ?? b.object_staff_id ?? null
        // If the always-required staff is the subject of never-together, they can never be scheduled with their object
        if (sidA && sidA === sidB) {
          conflicts.push({ ruleIdA: a.id, ruleIdB: b.id, description: `Staff #${sidA} is always-required but also in a never-together rule — may prevent scheduling` })
        }
      } else if (isNeverTogether(a) && isAlwaysRequired(b)) {
        const oidA = a.objectStaffId ?? a.object_staff_id ?? null
        if (sidB && sidB === sidA) {
          conflicts.push({ ruleIdA: a.id, ruleIdB: b.id, description: `Staff #${sidB} is always-required but also in a never-together rule — may prevent scheduling` })
        }
      }
    }
  }

  return conflicts
}

// ── handleRuleConflictsCommand ────────────────────────────────────────────────

export async function handleRuleConflictsCommand(bot, msg, db) {
  try {
    const groupId = msg.chat.id
    const rules = await (db ? db.getRules(groupId) : (await import('./rulesDb.js')).getRules(groupId))
    const conflicts = detectRuleConflicts(rules)
    if (conflicts.length === 0) {
      await bot.sendMessage(msg.chat.id, '✅ No contradictory rules detected.')
      return
    }
    const lines = conflicts.map((c, i) => `${i + 1}. ${c.description}`)
    await bot.sendMessage(msg.chat.id, `⚠️ *Contradictory rules detected:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' })
  } catch (err) {
    await bot.sendMessage(msg.chat.id, 'Could not check rule conflicts.')
  }
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

// ── Pending rule state (in-memory, per-manager) ─────────────────────────────

const pendingRules = new Map()

export function setPendingRule(managerId, rule, groupId) {
  pendingRules.set(managerId, { rule, groupId, timestamp: Date.now() })
  setTimeout(() => pendingRules.delete(managerId), 5 * 60 * 1000)
}

export function getPendingRule(managerId) {
  const pending = pendingRules.get(managerId)
  if (!pending) return null
  if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
    pendingRules.delete(managerId)
    return null
  }
  return pending
}

export function clearPendingRule(managerId) {
  pendingRules.delete(managerId)
}

// ── handlePotentialRule — passive rule detection in DM ────────────────────────

const RULE_TRIGGERS = ['never', 'always', 'only works', 'needs to', 'has to', 'must leave', 'must be', "don't schedule", 'do not schedule', 'no scheduling', 'can\'t work', 'cannot work', 'off on', 'day off']

export async function handlePotentialRule(bot, msg, groupId, db = null) {
  const text = msg.text?.trim()
  if (!text || text.length < 10) return false

  // Fast keyword check to avoid LLM on every message
  const lower = text.toLowerCase()
  if (!RULE_TRIGGERS.some(t => lower.includes(t))) return false

  try {
    const { getStaffForGroup, getShiftsForGroup } = await import('../setup/setupDb.js')
    const [staff, shifts] = await Promise.all([
      getStaffForGroup(groupId),
      getShiftsForGroup(groupId),
    ])
    const result = await extractRule(text, staff, shifts, groupId)
    if (!result.isRule) return false

    setPendingRule(msg.from.id, result.rule, groupId)
    const constraint = result.rule.constraint || text
    await bot.sendMessage(msg.chat.id,
      `📋 Got it — I'll remember this rule:\n*${constraint}*\n\nReply *yes* to save, or *no* to cancel.`,
      { parse_mode: 'Markdown' })
    return true
  } catch (err) {
    return false
  }
}

export async function handleRuleConfirmation(bot, msg, db = null) {
  const userId = msg.from?.id
  const pending = getPendingRule(userId)
  if (!pending) return false

  const lower = (msg.text || '').trim().toLowerCase()
  if (['yes', 'yep', 'yeah', 'yea', 'confirm', 'save', 'y'].includes(lower)) {
    clearPendingRule(userId)
    await saveRule(pending.groupId, pending.rule, db)
    await bot.sendMessage(msg.chat.id, `✅ Rule saved. I'll apply this to every schedule from now on.`)
    return true
  }
  if (['no', 'nope', 'cancel', 'nah', 'n', 'nevermind'].includes(lower)) {
    clearPendingRule(userId)
    await bot.sendMessage(msg.chat.id, `Got it, rule discarded.`)
    return true
  }
  return false
}
