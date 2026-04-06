import Groq from 'groq-sdk'
import { logger } from './logger.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const SYSTEM_PROMPT = `You are an intent classifier for Relay, a shift coverage bot for restaurant staff group chats. Your ONLY job is to classify messages and extract key details.

CRITICAL: Return ONLY a valid JSON object. No markdown. No backticks. No explanation. No extra text. Raw JSON only.

Classify as ONE of these types:

COVERAGE_REQUEST — someone cannot work their shift and needs coverage:
{"type":"coverage_request","shift":"specific description of the shift e.g. Saturday lunch, Friday 6pm-close, tomorrow morning","person":"name of person who needs coverage, use sender name if unclear"}

Common coverage_request phrases: 'can anyone cover', 'need coverage', 'need someone for', 'anyone free', 'can't make it', 'calling in', 'sick', 'can't come in', 'need a sub', 'need someone to take', 'anyone available', 'who can work'

COVERAGE_CONFIRMATION — someone is volunteering to take the shift:
{"type":"coverage_confirmation","person":"name of person volunteering"}

Common confirmation phrases (formal): 'I can cover', 'I'll take it', 'I can do it', 'I'm free', 'put me down', 'I'll be there', 'I can come in', 'count me in'
Common confirmation phrases (slang/casual): 'bet', 'igu', 'i got u', 'i gotchu', 'fasho', 'fa sho', 'say less', 'alr bet', 'alr igu', 'ight', 'aight', 'word', 'i got it', 'on it', 'locked in', 'ima pull up', 'ill do it', 'i can', 'fs' (for sure), 'no cap ill be there'
Emoji confirmations: 👍 ✅ 💯 (when sent in response to a coverage request)
Typo tolerance: treat near-misses as the intended word — 'iguy'→'igu', 'fash'→'fasho', 'bettt'→'bet', 'shure'→'sure', 'yea i think igu'→confirmation (commitment wins over hedging when both appear)

IMPORTANT: If a message contains BOTH uncertainty AND a commitment phrase, classify as coverage_confirmation. The commitment phrase at the end overrides the hedge. Example: 'yea i think igu' = confirmation, 'idk maybe i can' = maybe.

COVERAGE_MAYBE — someone is genuinely unsure with no commitment at all (pure maybe with zero commitment phrase):
{"type":"coverage_maybe","person":"name of person who is unsure"}
Examples: 'maybe', 'idk', 'lemme check', 'lmk', 'i'll try', 'possibly' — with NO commitment phrase alongside it.

SCHEDULE_UPDATE — availability or schedule change, not urgent coverage:
{"type":"schedule_update","details":"brief description"}

IRRELEVANT — casual chat, emojis, questions, announcements:
{"type":"irrelevant"}

RULES:
- Be CONSERVATIVE. Only use coverage_request if someone clearly cannot work and needs someone else to cover their shift.
- If ambiguous, use irrelevant.
- The shift field should be specific — extract actual day/time if mentioned, otherwise describe what was said.
- Always use the sender's first name if no name is mentioned in message.
- Never return anything except valid JSON.`

// Determines if a DM reply is the person saying yes to covering a shift.
// Used instead of regex so natural language like "yea sure I got u" works.
export async function isDmConfirmation(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 10,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are reading a reply from a restaurant worker who was just DM'd: "Can you cover a shift?"

Your job: did they COMMIT to covering it? Return only valid JSON — {"yes":true} or {"yes":false}.

COMMITTED (yes:true) — they said yes in any form:
- Standard: yes, yea, yeah, ye, yep, yup, sure, ok, okay, alright, aight, ight, aite
- Slang/AAVE: bet, fasho, fa sho, say less, word, ight, no cap, on god, fr, igu, i got u, i gotchu, ig (used as yes), already, period, locked in, facts, say less, frl
- Acronyms: igs, igu, ig, ight, aight, fs (for sure), ofc (of course), ok, k
- Action phrases: i can, i'll do it, ill do it, i got it, i'm free, im free, i can make it, pulling up, ima pull up, i'll be there, ill be there, i'm in, im in, count me in, put me down, on it, done, i'll take it, ill take it, i can cover, i'll cover
- Emoji: 👍 ✅ 💯 🙌 👌

NOT COMMITTED (yes:false) — uncertain, asking questions, or declining:
- Uncertain: maybe, idk, not sure, depends, let me check, i think so, possibly, might be able to
- Uncommitted: lmk (let me know — they haven't decided), hmu, i'll try, i'll see
- Declining: nah, no, nope, can't, won't, busy, i wish, sorry, unable, i can't

Key rules:
- Be generous with typos — 'iguy'→'igu', 'shure'→'sure', 'yea i think igu'→yes
- If a message has BOTH a hedge AND a commitment ('yea i think igu', 'idk maybe i can do it'), the commitment wins → true
- Only return false if it's a pure maybe/decline with zero commitment phrase`,
        },
        { role: 'user', content: text },
      ],
    })
    const raw = completion.choices[0]?.message?.content ?? '{}'
    const result = JSON.parse(raw)
    logger.parse(`DM affirmative check: "${text}" → ${result.yes ? 'yes' : 'no'}`)
    return result.yes === true
  } catch (err) {
    logger.error(`isDmConfirmation failed: ${err.message}`)
    return false
  }
}

// Parses any natural language shift description — single or bulk — into an array of shifts.
// Handles inputs like "2 shifts a day 8am-12pm and 12pm-4pm on Mon-Fri" or "Saturday Lunch, 11am-3pm".
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

// Parses role requirements per shift. shiftNames is the list of configured shifts so the LLM can match them.
// Returns [{shift_name, role, count}]
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

// Parses staff descriptions into an array of {name, role} objects.
// Handles bulk inputs like "John and Sarah are servers, Mike is a cook".
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

export async function parseMessage(text, senderName, groupName) {
  logger.parse(`Parsing: [${groupName}] ${senderName}: "${text}"`)

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Message from ${senderName}: ${text}` },
      ],
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    const intent = JSON.parse(raw)
    logger.parse(`Result: ${JSON.stringify(intent)}`)
    return intent
  } catch (err) {
    logger.error(`parseMessage failed: ${err.message}`)
    return { type: 'irrelevant' }
  }
}
