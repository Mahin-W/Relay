import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectManagerCoverageRequest,
  handleManagerCoveragePost,
  handleCoverageCommand,
} from '../../coverage/managerCoverage.js'
import { MockBot, makeGroupMsg } from '../helpers/mocks.js'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FRIDAY_DINNER = {
  id: 1,
  name: 'Friday Dinner',
  day_of_week: 'Friday',
  start_time: '17:00',
  end_time: '23:00',
}

const SATURDAY_LUNCH = {
  id: 2,
  name: 'Saturday Lunch',
  day_of_week: 'Saturday',
  start_time: '11:00',
  end_time: '16:00',
}

const FRIDAY_LUNCH = {
  id: 3,
  name: 'Friday Lunch',
  day_of_week: 'Friday',
  start_time: '11:00',
  end_time: '16:00',
}

function makeDb(overrides = {}) {
  let saveCalled = false
  let savedArgs = null
  return {
    getShiftsForGroup: async () => [FRIDAY_DINNER],
    saveCoverageRequest: async (...args) => {
      saveCalled = true
      savedArgs = args
      return { id: 42 }
    },
    getGroupMembersWithDm: async () => [
      { userId: 99, firstName: 'Marcus', dmChatId: '999' },
    ],
    _wasSaveCalled: () => saveCalled,
    _getSavedArgs: () => savedArgs,
    ...overrides,
  }
}

const ADMIN_USER_ID = 77777
const GROUP_CHAT_ID = '-100888777'

function makeAdminMsg(overrides = {}) {
  return makeGroupMsg({
    from: { id: ADMIN_USER_ID, first_name: 'Chef', ...overrides.from },
    chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Test Kitchen', ...overrides.chat },
    ...overrides,
  })
}

// ── Phase 1: handleManagerCoveragePost — non-admin ────────────────────────────

test('handleManagerCoveragePost: non-admin → nothing sent', async () => {
  const bot = new MockBot()
  // Default MockBot.getChatMember returns { status: 'member' } — non-admin
  const msg = makeAdminMsg()
  const intent = { shiftName: 'Friday Dinner', dayOfWeek: 'Friday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  // Should send nothing at all
  assert.equal(bot.sentMessages.length, 0, 'Non-admin should receive no messages')
})

// ── Phase 1: handleManagerCoveragePost — admin, single match ─────────────────

test('handleManagerCoveragePost: admin + single shift match → saveCoverageRequest called', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const msg = makeAdminMsg()
  const intent = { shiftName: 'Friday Dinner', dayOfWeek: 'Friday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  assert.ok(db._wasSaveCalled(), 'saveCoverageRequest should have been called')
})

test('handleManagerCoveragePost: admin + single match → posts coverage message to group', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const msg = makeAdminMsg()
  const intent = { shiftName: 'Friday Dinner', dayOfWeek: 'Friday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  const groupMsgs = bot.messagesTo(GROUP_CHAT_ID)
  assert.ok(groupMsgs.length > 0, 'Should post message to group')
  const found = groupMsgs.some(m =>
    m.text.toLowerCase().includes('coverage') || m.text.includes('Coverage')
  )
  assert.ok(found, `Expected coverage message in group. Got: ${groupMsgs.map(m => m.text).join('\n')}`)
})

test('handleManagerCoveragePost: admin + single match → DMs eligible staff', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const msg = makeAdminMsg()
  const intent = { shiftName: 'Friday Dinner', dayOfWeek: 'Friday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  const staffDms = bot.messagesTo('999')
  assert.ok(staffDms.length > 0, 'Should DM eligible staff member (dmChatId=999)')
})

test('handleManagerCoveragePost: admin + single match → notifies manager DM', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  // Simulate manager having a DM chat with the bot (private chat id matches user id)
  const managerChatId = String(ADMIN_USER_ID)
  const msg = makeAdminMsg({
    chat: { id: GROUP_CHAT_ID, type: 'supergroup', title: 'Test Kitchen' },
    from: { id: ADMIN_USER_ID, first_name: 'Chef' },
  })
  const intent = { shiftName: 'Friday Dinner', dayOfWeek: 'Friday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  // Manager DM is sent to their user id (ADMIN_USER_ID)
  const managerMsgs = bot.messagesTo(managerChatId)
  assert.ok(
    managerMsgs.length > 0,
    `Should notify manager via DM (chatId=${managerChatId}). All messages: ${bot.sentMessages.map(m => `[${m.chatId}] ${m.text.slice(0, 60)}`).join(' | ')}`
  )
  const confirmationMsg = managerMsgs.find(m =>
    m.text.toLowerCase().includes('coverage') ||
    m.text.toLowerCase().includes('posted') ||
    m.text.toLowerCase().includes('request')
  )
  assert.ok(confirmationMsg, `Manager DM should mention coverage/posted. Got: ${managerMsgs.map(m => m.text).join('\n')}`)
})

// ── Phase 1: handleManagerCoveragePost — no shift match ──────────────────────

test('handleManagerCoveragePost: no shift match → sends "Couldn\'t find" to manager DM', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const managerChatId = String(ADMIN_USER_ID)
  const msg = makeAdminMsg()
  // Intent for a shift that doesn't exist in db
  const intent = { shiftName: 'Sunday Brunch', dayOfWeek: 'Sunday' }
  const db = makeDb()

  await handleManagerCoveragePost(bot, msg, intent, db)

  const managerMsgs = bot.messagesTo(managerChatId)
  assert.ok(managerMsgs.length > 0, 'Should send message to manager DM')
  const errMsg = managerMsgs.find(m =>
    m.text.toLowerCase().includes("couldn't find") ||
    m.text.toLowerCase().includes('could not find') ||
    m.text.toLowerCase().includes("couldn't")
  )
  assert.ok(
    errMsg,
    `Should say "Couldn't find". Got: ${managerMsgs.map(m => m.text).join('\n')}`
  )
})

// ── Phase 1: handleManagerCoveragePost — multiple shift matches ───────────────

test('handleManagerCoveragePost: multiple matches → sends disambiguation list to manager DM', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const managerChatId = String(ADMIN_USER_ID)
  const msg = makeAdminMsg()
  const intent = { shiftName: 'Friday', dayOfWeek: 'Friday' }
  // DB returns two Friday shifts
  const db = makeDb({
    getShiftsForGroup: async () => [FRIDAY_DINNER, FRIDAY_LUNCH],
  })

  await handleManagerCoveragePost(bot, msg, intent, db)

  const managerMsgs = bot.messagesTo(managerChatId)
  assert.ok(managerMsgs.length > 0, 'Should send message to manager DM')
  const disambigMsg = managerMsgs.find(m =>
    m.text.includes('1.') || m.text.includes('1)') || m.text.toLowerCase().includes('which')
  )
  assert.ok(
    disambigMsg,
    `Should send numbered disambiguation. Got: ${managerMsgs.map(m => m.text).join('\n')}`
  )
})

// ── Phase 1: handleCoverageCommand ────────────────────────────────────────────

test('handleCoverageCommand: match[1] empty → DMs "Which shift needs coverage"', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const managerChatId = String(ADMIN_USER_ID)
  const msg = makeAdminMsg({ text: '/coverage' })
  const match = ['/coverage', '']
  const db = makeDb()

  await handleCoverageCommand(bot, msg, match, db)

  const managerMsgs = bot.messagesTo(managerChatId)
  assert.ok(managerMsgs.length > 0, 'Should send message to manager DM')
  const helpMsg = managerMsgs.find(m =>
    m.text.toLowerCase().includes('which shift') ||
    m.text.toLowerCase().includes('needs coverage') ||
    m.text.toLowerCase().includes('coverage')
  )
  assert.ok(
    helpMsg,
    `Should ask which shift needs coverage. Got: ${managerMsgs.map(m => m.text).join('\n')}`
  )
})

test('handleCoverageCommand: match[1] = " Friday dinner" → runs without crash, sends something', async () => {
  const bot = new MockBot()
  bot.setAdmin(GROUP_CHAT_ID, ADMIN_USER_ID)
  const msg = makeAdminMsg({ text: '/coverage Friday dinner' })
  const match = ['/coverage Friday dinner', ' Friday dinner']
  const db = makeDb()

  // Should not throw
  await assert.doesNotReject(
    () => handleCoverageCommand(bot, msg, match, db),
    'handleCoverageCommand should not throw for valid shift text'
  )

  assert.ok(bot.sentMessages.length > 0, 'Should send at least one message')
})

// ── Phase 2: detectManagerCoverageRequest (LLM tests) ────────────────────────

const SHIFT_NAMES = ['Friday Dinner', 'Saturday Lunch']

test('detectManagerCoverageRequest: "post coverage for Friday dinner" → isManagerCoverage true', async () => {
  const result = await detectManagerCoverageRequest(
    'post coverage for Friday dinner',
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, true)
})

test('detectManagerCoverageRequest: "we need someone for Saturday lunch" → isManagerCoverage true', async () => {
  const result = await detectManagerCoverageRequest(
    'we need someone for Saturday lunch',
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, true)
})

test('detectManagerCoverageRequest: "looking for coverage tomorrow night" → isManagerCoverage true', async () => {
  const result = await detectManagerCoverageRequest(
    'looking for coverage tomorrow night',
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, true)
})

test('detectManagerCoverageRequest: "need a server for tonight" → isManagerCoverage true', async () => {
  const result = await detectManagerCoverageRequest(
    'need a server for tonight',
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, true)
})

test('detectManagerCoverageRequest: "I can\'t come in tonight" (staff callout) → isManagerCoverage false', async () => {
  const result = await detectManagerCoverageRequest(
    "I can't come in tonight",
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, false)
})

test('detectManagerCoverageRequest: "can anyone cover" alone (ambiguous) → isManagerCoverage false', async () => {
  const result = await detectManagerCoverageRequest(
    'can anyone cover',
    SHIFT_NAMES
  )
  assert.equal(result.isManagerCoverage, false)
})

test('detectManagerCoverageRequest: returns shiftName for "post coverage for Friday dinner"', async () => {
  const result = await detectManagerCoverageRequest(
    'post coverage for Friday dinner',
    ['Friday Dinner', 'Saturday Lunch']
  )
  assert.ok(result.shiftName, 'Should return a shiftName')
  assert.ok(
    result.shiftName.toLowerCase().includes('friday') || result.shiftName.toLowerCase().includes('dinner'),
    `shiftName should reference Friday Dinner, got: ${result.shiftName}`
  )
})
