import { groq, groqWithRetry } from './groq.js'
import { logger } from '../logger.js'

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

CANCEL_COVERAGE — the person who requested coverage wants to cancel/withdraw their request:
{"type":"cancel_coverage","person":"name of person cancelling, use sender name if unclear"}

Common cancel_coverage phrases: 'cancel the coverage', 'cancel my request', 'never mind', 'nvm', 'I found someone', 'I'm good', 'I'm good now', 'forget it', 'cancel it', 'disregard', 'I don't need coverage anymore', 'cancel coverage'
Only use this if they're clearly cancelling an existing coverage request — not just saying nevermind in general conversation.

TRADE_REQUEST — someone wants to trade/swap their own shift with another person's shift:
{"type":"trade_request","shift":"description of the shift they want to trade away","person":"name of person requesting the trade, use sender name if unclear"}

Common trade_request phrases: 'trade my', 'swap my', 'anyone want to trade', 'looking to swap', 'want to switch shifts', 'can anyone swap', 'anyone trade with me'
NOTE: 'trade my X' is ALWAYS trade_request, never coverage_request. Only classify as coverage_request if they clearly cannot work (sick, busy, can't make it).

TIME_OFF_REQUEST — someone asking for planned future time off, no urgency, no "anyone cover" language:
{"type":"time_off_request","person":"name of person, use sender name if unclear","date":"the date or day they want off","shift":"shift name if mentioned, null otherwise"}

Common time_off_request phrases: 'can I have X off', 'need X off', 'requesting X off', 'taking X off', 'won't be in X', 'can't work X', 'I can't work X', 'can I get X off', 'can I take X off'
IMPORTANT TIME-OFF vs COVERAGE RULES:
- time_off_request = planned/future, NO urgency markers, NO 'anyone cover' language — person asks for approval or informs in advance
- coverage_request = urgent/immediate, includes 'can anyone cover', 'I need a sub', 'calling in sick', 'can't come in today/now'
- Examples: 'I can't work Sunday' = time_off_request (future, no cover ask). 'can't come in today, anyone available?' = coverage_request.
- If someone says CAN'T WORK + specific future day + no urgency + no cover request → time_off_request.

RUNNING_LATE — someone saying they personally will be late to work (present or near-future tense about arriving soon):
{"type":"running_late","person":"name of person, use sender name if unclear","minutes":null,"eta":null}

Common running_late phrases: 'running late', 'gonna be late', 'gonna be a bit late', 'going to be late', 'will be late', 'running X min late', 'stuck in traffic', 'be there by X', 'running behind', 'on my way but late', 'delayed', 'a bit late', 'few minutes late', 'late today', 'heading there now but late'
Extract minutes if stated ('20 min late' → set minutes to 20, '15 min' → 15). Extract ETA if stated ('be there by 6:30' → set eta to '6:30'). If no minutes and no ETA, leave both null.
MUST NOT trigger on past tense: 'I was late last week', 'sorry I was late yesterday', 'the bus is always late' (not about them personally today).
MUST NOT trigger on coverage_request phrases. 'calling in sick' or 'can't come in' = coverage_request. Someone saying they're on their way but delayed = running_late.

SCHEDULE_UPDATE — availability or schedule change, not urgent coverage:
{"type":"schedule_update","details":"brief description"}

IRRELEVANT — casual chat, emojis, questions, announcements:
{"type":"irrelevant"}

RULES:
- Be CONSERVATIVE. Only use coverage_request if someone clearly cannot work and needs someone else to cover their shift.
- Use trade_request when someone wants to swap/trade shifts (they're willing to work, just on different days/times).
- If ambiguous, use irrelevant.
- The shift field should be specific — extract actual day/time if mentioned, otherwise describe what was said.
- Always use the sender's first name if no name is mentioned in message.
- Never return anything except valid JSON.`

export async function isDmConfirmation(text) {
  try {
    const completion = await groqWithRetry(() => groq.chat.completions.create({
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
    }))
    const raw = completion.choices[0]?.message?.content ?? '{}'
    const result = JSON.parse(raw)
    logger.parse(`DM affirmative check: "${text}" → ${result.yes ? 'yes' : 'no'}`)
    return result.yes === true
  } catch (err) {
    logger.error(`isDmConfirmation failed: ${err.message}`)
    return false
  }
}

export async function parseMessage(text, senderName, groupName) {
  logger.parse(`Parsing: [${groupName}] ${senderName}: "${text}"`)

  try {
    const completion = await groqWithRetry(() => groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      temperature: 0.0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Message from ${senderName}: ${text}` },
      ],
    }))

    const raw = completion.choices[0]?.message?.content ?? '{}'
    const intent = JSON.parse(raw)
    logger.parse(`Result: ${JSON.stringify(intent)}`)
    return intent
  } catch (err) {
    logger.error(`parseMessage failed: ${err.message}`)
    return { type: 'irrelevant' }
  }
}
