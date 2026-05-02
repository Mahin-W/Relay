import { llmCreate, llmWithRetry, extractJSON } from '../parsers/llm.js'
import { saveCrossTraining, removeCrossTraining, getAllCrossTraining } from './crossTrainingDb.js'
import { logger } from '../logger.js'

const CROSS_TRAINING_SYSTEM_PROMPT = `You are a restaurant management assistant analyzing messages for cross-training information.

Given a message from a manager, determine if they are mentioning a specific staff member's ability, skill, or certification to work a role. This includes any mention of someone being able to, trained on, certified in, or learning a role.

Return ONLY JSON (no explanation):
{
  "isCrossTraining": boolean,
  "staffName": string or null,
  "roleName": string or null,
  "proficiency": "training" | "competent" | "proficient",
  "direction": "add" | "remove"
}

Set isCrossTraining to true when:
- A specific named staff member is mentioned with any role capability (e.g. "Marcus can bartend", "Sarah is certified on grill", "Marcus is fully trained on bar")
- Someone is learning or training on a role
- Someone is certified, skilled, or able to work a role

Proficiency levels:
- "training": currently learning (keywords: training, learning, shadowing)
- "competent": can work the role (keywords: can also, able to, knows how, can work, if needed)
- "proficient": fully skilled/certified (keywords: certified, fully trained, expert, mastered, fully certified)

Direction:
- "add": staff member CAN or IS LEARNING the role
- "remove": staff member NO LONGER does the role (keywords: no longer, stopped, removed from, can't anymore)

Set isCrossTraining to false ONLY when:
- No specific staff member name is mentioned (e.g. "everyone", "all staff")
- The message is about general restaurant operations, not about someone's role capabilities

Available staff: {staff}
Available roles: {roles}`

export async function extractCrossTrainingMention(text, staff, roles) {
  const staffNames = staff.map(s => s.name).join(', ')
  const roleNames = roles.map(r => r.name).join(', ')
  const systemPrompt = CROSS_TRAINING_SYSTEM_PROMPT
    .replace('{staff}', staffNames)
    .replace('{roles}', roleNames)

  try {
    const response = await llmWithRetry(() =>
      llmCreate({
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.1,
        max_tokens: 256,
      })
    )

    const raw = response.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(extractJSON(raw))

    if (!parsed.isCrossTraining) return { isCrossTraining: false }
    if (!parsed.staffName) return { isCrossTraining: false }

    // Fuzzy match staffName to actual staff
    const staffMatch = staff.find(s =>
      s.name.toLowerCase() === (parsed.staffName || '').toLowerCase() ||
      s.name.toLowerCase().includes((parsed.staffName || '').toLowerCase()) ||
      (parsed.staffName || '').toLowerCase().includes(s.name.toLowerCase())
    )
    const staffId = staffMatch?.id ?? null

    // Fuzzy match roleName to actual roles
    const roleMatch = roles.find(r =>
      r.name.toLowerCase() === (parsed.roleName || '').toLowerCase() ||
      r.name.toLowerCase().includes((parsed.roleName || '').toLowerCase()) ||
      (parsed.roleName || '').toLowerCase().includes(r.name.toLowerCase())
    )
    const roleId = roleMatch?.id ?? null

    return {
      isCrossTraining: true,
      staffName: parsed.staffName,
      staffId,
      roleName: parsed.roleName,
      roleId,
      proficiency: parsed.proficiency || 'competent',
      direction: parsed.direction || 'add',
    }
  } catch (err) {
    logger.error(`extractCrossTrainingMention failed: ${err.message}`)
    return { isCrossTraining: false }
  }
}

export async function handleCrossTrainingMention(bot, msg, groupId, db = null) {
  const staff = await (db?.getStaffForGroup ?? (() => []))(groupId)
  const roles = await (db?.getRolesForGroup ?? (() => []))(groupId)

  if (staff.length === 0 || roles.length === 0) return false

  const result = await extractCrossTrainingMention(msg.text, staff, roles)

  if (!result.isCrossTraining) return false
  if (!result.roleId) return false
  if (!result.staffId) return false

  if (result.direction === 'add') {
    await saveCrossTraining(groupId, result.staffId, result.roleId, result.proficiency, db)
    const profLabel = result.proficiency === 'training' ? 'training on' : `cross-trained as`
    await bot.sendMessage(groupId, `Noted: ${result.staffName} is now ${profLabel} ${result.roleName} (${result.proficiency}).`)
    return true
  }

  if (result.direction === 'remove') {
    await removeCrossTraining(groupId, result.staffId, result.roleId, db)
    await bot.sendMessage(groupId, `Noted: ${result.staffName} removed from cross-training as ${result.roleName}.`)
    return true
  }

  return false
}

export async function formatCrossTrainingRoster(groupId, db = null) {
  const allCT = await getAllCrossTraining(groupId, db)
  const staffIds = Object.keys(allCT)

  if (staffIds.length === 0) {
    return 'No cross-training records yet. Mention staff skills in chat (e.g. "Marcus can also tend bar") to start tracking.'
  }

  // We need staff names — get them from the CT records or db
  const staff = await (db?.getStaffForGroup ?? (() => []))(groupId)
  const staffMap = {}
  for (const s of staff) {
    staffMap[s.id] = s.name
  }

  let out = 'Cross-Training Roster:\n\n'
  for (const staffId of staffIds) {
    const name = staffMap[staffId] ?? `Staff #${staffId}`
    const roles = allCT[staffId]
    out += `${name}:\n`
    for (const r of roles) {
      out += `  - ${r.roleName} (${r.proficiency})\n`
    }
    out += '\n'
  }
  return out.trim()
}
