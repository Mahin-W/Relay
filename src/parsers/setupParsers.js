import { groq } from './groq.js'
import { logger } from '../logger.js'

export async function parseShift(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are parsing restaurant shift descriptions for a scheduling bot. The manager may describe one shift or many at once.

Expand ALL combinations. For example:
- "2 shifts a day 8am-12pm and 12pm-4pm on Mon Tue Wed Thu Fri" → 10 shifts (2 times × 5 days)
- "weekends 10am-6pm" → 2 shifts (Saturday + Sunday)
- "Saturday Lunch, 11am-3pm" → 1 shift

Return JSON: {"shifts":[{"name":"descriptive name e.g. Monday Morning","day_of_week":"full day name","start_time":"12-hour e.g. 8:00 AM","end_time":"12-hour e.g. 12:00 PM"},...]}

Naming rules:
- If a name is given, use it
- Otherwise combine day + time-of-day: "Monday Morning", "Friday Afternoon", "Saturday Evening"
- Time of day: Morning=before noon, Afternoon=noon-5pm, Evening=5pm+, Close=last shift of day

If the input does not describe any shifts at all, return {"shifts":[]}.
Always use full day names (Monday not Mon). Always use 12-hour AM/PM format.`,
        },
        { role: 'user', content: text },
      ],
    })
    const raw = completion.choices[0]?.message?.content ?? '{}'
    const result = JSON.parse(raw)
    const shifts = (result.shifts ?? []).filter(s => s.name && s.day_of_week && s.start_time)
    shifts.forEach(s => { if (!s.end_time) s.end_time = 'TBD' })
    logger.parse(`Parsed ${shifts.length} shift(s) from: "${text}"`)
    return shifts
  } catch (err) {
    logger.error(`parseShift failed: ${err.message}`)
    return []
  }
}

export async function parseShiftRequirements(text, shiftNames) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are parsing role requirements for restaurant shifts.

Configured shifts: ${shiftNames.join(', ')}

The manager will describe how many of each role they need per shift. Match shift names to the configured shifts above (fuzzy match is fine). Expand "all shifts" to every configured shift.

Examples:
- "Saturday Lunch needs 2 servers and 1 cook" → [{shift_name:"Saturday Lunch",role:"Server",count:2},{shift_name:"Saturday Lunch",role:"Cook",count:1}]
- "all shifts need 1 manager" → one entry per shift, role Manager, count 1
- "morning shifts: 2 servers, evening shifts: 1 bartender 1 server" → multiple entries

Return JSON: {"requirements":[{"shift_name":"exact name from configured list","role":"role name","count":number},...]}
If nothing can be parsed, return {"requirements":[]}.`,
        },
        { role: 'user', content: text },
      ],
    })
    const raw = completion.choices[0]?.message?.content ?? '{}'
    const result = JSON.parse(raw)
    const reqs = (result.requirements ?? []).filter(r => r.shift_name && r.role && r.count > 0)
    logger.parse(`Parsed ${reqs.length} shift requirement(s)`)
    return reqs
  } catch (err) {
    logger.error(`parseShiftRequirements failed: ${err.message}`)
    return []
  }
}

export async function parseStaff(text, senderName) {
  try {
    const senderLine = senderName
      ? `The person sending this message is named "${senderName}". If they say "I'm a [role]" or "I am a [role]", use "${senderName}" as their name.`
      : `If someone says "I'm a [role]" but no name is given, skip them.`

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are parsing restaurant staff descriptions for a scheduling bot. Extract ONLY the people explicitly named or self-identified in the message.

${senderLine}

Return JSON: {"staff":[{"name":"First name or full name","role":"their role e.g. Server, Cook, Bartender, Host, Manager"},...]}

Rules:
- ONLY include people who are actually mentioned in the message — NEVER invent or assume names
- ALWAYS use Title Case for names (e.g. "Alice", not "ALICE" or "alice")
- ALWAYS use Title Case for roles (e.g. "Cook", "Server", not "COOK" or "cook")
- If no role is mentioned, use "Staff"
- If the message doesn't name any real people, return {"staff":[]}`,
        },
        { role: 'user', content: text },
      ],
    })
    const raw = completion.choices[0]?.message?.content ?? '{}'
    const result = JSON.parse(raw)
    const staff = (result.staff ?? []).filter(s => s.name)
    logger.parse(`Parsed ${staff.length} staff member(s) from: "${text}"`)
    return staff
  } catch (err) {
    logger.error(`parseStaff failed: ${err.message}`)
    return []
  }
}
