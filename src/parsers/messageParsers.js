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

PARTIAL_COVERAGE_OFFER — someone volunteers to cover only PART of a shift (first half, second half, until a time, from a time, or a specific time range). ONLY use this when they explicitly state a partial time:
{"type":"partial_coverage_offer","person":"name of volunteer, use sender name","portion":"first_half|second_half|until|from|range","timeReference":"the time mentioned if applicable, null otherwise"}

Common partial_coverage_offer phrases: 'I can cover the first half', 'I can do the first part', 'I can cover until [time]', 'I can come in from [time]', 'I can do [time] to [time]', 'I can cover the morning part', 'available for the second half'
portion values: 'first_half' (first part/first half), 'second_half' (second part/second half), 'until' (I can cover until X), 'from' (I can come from X), 'range' (I can do X to Y)
MUST NOT trigger on: 'I can cover' alone → coverage_confirmation, 'I can cover that' → coverage_confirmation, 'I can cover the whole shift' → coverage_confirmation
KEY DISTINCTION: partial_coverage_offer requires explicit partial time language. Full coverage without time restrictions = coverage_confirmation.

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

AVAILABILITY_MENTION — someone passively mentions their own availability or unavailability for specific days or the whole week, without requesting coverage or asking for time off:
{"type":"availability_mention","person":"name of person, use sender name if unclear","available_days":[],"unavailable_days":[],"available_all_week":false,"unavailable_all_week":false}

Common availability_mention phrases: 'I can't do Tuesday', 'not available Monday', 'free Friday', 'I'm free Wednesday', 'can work Saturday', 'available Thursday', 'free all week', 'out of town Friday', 'off Monday', 'I won't be around Sunday', 'free next week'
Extract all day names mentioned into available_days or unavailable_days arrays.
Set available_all_week=true for 'free all week', 'free next week', 'available all week'.
Set unavailable_all_week=true for 'out all week', 'away all week', 'not available all week', 'out of town all week'.
MUST NOT trigger on: coverage requests ('can anyone cover my friday'), running late mentions, time-off requests (those get approval from manager).
DISTINCTION: availability_mention = informational statement about their own schedule. coverage_request = asking others to cover. time_off_request = asking manager for approval.

ON_CALL_OFFER — staff proactively volunteering to be on call / available for extra shifts this week, without responding to a specific coverage request:
{"type":"on_call_offer","person":"name of person, use sender name if unclear","days":[],"all_week":true}

Common on_call_offer phrases: 'I'm on call this week', 'ping me if you need someone', 'I can pick up extra shifts', 'available for extra shifts', 'put me on call', 'I'm available if needed', 'hit me up if you need coverage', 'I'm free if needed', 'available if anyone needs coverage'
Extract specific days if mentioned into the days array. Set all_week: true if no specific days are mentioned or they mention the whole week.
MUST NOT trigger on:
- 'I can cover that' / 'I can cover it' → coverage_confirmation (direct response to a specific request)
- 'I'm available Monday' / 'free Wednesday' → availability_mention (specific day only, no on-call framing)
- 'can anyone cover' → coverage_request (asking others to cover their shift)
KEY DISTINCTION: on_call_offer = proactively putting themselves on-call for the week. availability_mention = stating availability for specific days only.

NEW_HIRE_ANNOUNCEMENT — manager announces a new staff member joining the team:
{"type":"new_hire_announcement","person":"name of new hire extracted from message","startDate":null,"role":null}

Common new_hire_announcement phrases: 'everyone welcome [name]', 'please welcome [name]', 'welcome [name] to the team', '[name] is joining us', '[name] starts [day]', 'new team member [name]', 'introducing [name]', '[name] is our new [role]'
Extract: person = the new hire's name. role = their job role if mentioned. startDate = when they start if mentioned.
MUST NOT trigger on: 'welcome back [name]' (returning staff), 'welcome everyone' (no specific person), general greetings without a new hire context.

COPY_SCHEDULE_REQUEST — manager wants to repeat last week's schedule as-is:
{"type":"copy_schedule_request","person":null}

Common copy_schedule_request phrases: 'same as last week', 'copy last week', 'repeat last week', 'just do the same schedule', 'same schedule as before', 'copy the schedule', 'use last week again'
MUST NOT trigger on: 'can anyone cover' (coverage_request), 'my schedule' (irrelevant), 'make a new schedule' (irrelevant)

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
      model: 'llama3.1-8b',
      temperature: 0.0,
      max_tokens: 10,

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
      model: 'llama3.1-8b',
      temperature: 0.0,
      max_tokens: 200,

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
