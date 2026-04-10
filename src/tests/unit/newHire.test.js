import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockBot, makeGroupMsg, makeDMMsg } from '../helpers/mocks.js'
import { handleNewHireAnnouncement, handleNewHireRegistration } from '../../onboarding/handleNewHire.js'

const GROUP_ID = '-100'
const MANAGER_DM = 9001
const BOT_USERNAME = 'RelayTestBot'

function makeDb(overrides = {}) {
  const records = []
  return {
    getSetupSession: async () => ({ manager_id: 101, dm_chat_id: MANAGER_DM, group_id: GROUP_ID }),
    saveOnboardingRecord: async (groupId, name, role, startDate) => {
      const r = { id: records.length + 1, groupId, name, role, startDate, status: 'pending' }
      records.push(r)
      return r
    },
    getPendingOnboarding: async (groupId) => records.filter(r => r.groupId === groupId && r.status === 'pending'),
    completeOnboarding: async (id) => {
      const r = records.find(r => r.id === id)
      if (r) r.status = 'completed'
      return r
    },
    upsertStaffDm: async () => {},
    upsertGroupMember: async () => {},
    _records: records,
    ...overrides,
  }
}

// ── handleNewHireAnnouncement ─────────────────────────────────────────────────

test('handleNewHireAnnouncement: posts group message', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsgs = bot.messagesTo(GROUP_ID)
  assert.ok(groupMsgs.length > 0, 'should post in group')
})

test('handleNewHireAnnouncement: group message contains person name', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes('Jake'), 'should include person name')
})

test('handleNewHireAnnouncement: group message contains registration link', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes('t.me/') || groupMsg.text.includes('register'), 'should include registration link')
})

test('handleNewHireAnnouncement: registration link contains groupId', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const groupMsg = bot.messagesTo(GROUP_ID)[0]
  assert.ok(groupMsg.text.includes(GROUP_ID.replace('-', '')), 'link should contain group ID')
})

test('handleNewHireAnnouncement: DM sent to manager', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: null, startDate: null }
  await handleNewHireAnnouncement(bot, msg, intent, makeDb())
  const dmMsgs = bot.messagesTo(MANAGER_DM)
  assert.ok(dmMsgs.length > 0, 'should DM manager')
})

test('handleNewHireAnnouncement: onboarding record saved with status pending', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ chat: { id: GROUP_ID, type: 'group', title: 'Test Kitchen' }, from: { id: 202, first_name: 'Manager' } })
  const intent = { type: 'new_hire_announcement', person: 'Jake', role: 'chef', startDate: null }
  const db = makeDb()
  await handleNewHireAnnouncement(bot, msg, intent, db)
  assert.equal(db._records.length, 1)
  assert.equal(db._records[0].status, 'pending')
  assert.equal(db._records[0].name, 'Jake')
})

// ── handleNewHireRegistration ─────────────────────────────────────────────────

test('handleNewHireRegistration: sends welcome DM', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  await handleNewHireRegistration(bot, msg, GROUP_ID, makeDb())
  const dms = bot.messagesTo(3030)
  assert.ok(dms.length > 0, 'Jake should get a welcome DM')
})

test('handleNewHireRegistration: welcome DM mentions Relay', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  await handleNewHireRegistration(bot, msg, GROUP_ID, makeDb())
  const dm = bot.messagesTo(3030)[0]
  assert.ok(dm.text.includes('Relay') || dm.text.includes('schedule'), 'welcome DM should mention Relay')
})

test('handleNewHireRegistration: notifies manager with staff name', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  const db = makeDb()
  // Pre-seed a pending record so it completes
  db._records.push({ id: 1, groupId: GROUP_ID, name: 'Jake', status: 'pending' })
  await handleNewHireRegistration(bot, msg, GROUP_ID, db)
  const managerDms = bot.messagesTo(MANAGER_DM)
  assert.ok(managerDms.length > 0, 'should notify manager')
  assert.ok(managerDms[0].text.includes('Jake'), 'notification should include staff name')
})

test('handleNewHireRegistration: onboarding record marked completed', async () => {
  const bot = new MockBot()
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeDMMsg({ from: { id: 303, first_name: 'Jake' }, chat: { id: 3030 } })
  const db = makeDb()
  db._records.push({ id: 1, groupId: GROUP_ID, name: 'Jake', status: 'pending' })
  await handleNewHireRegistration(bot, msg, GROUP_ID, db)
  const record = db._records.find(r => r.id === 1)
  assert.equal(record.status, 'completed')
})

// ── /welcome command ──────────────────────────────────────────────────────────

test('/welcome: posts group registration message', async () => {
  const { handleWelcomeCommand } = await import('../../onboarding/handleNewHire.js')
  const bot = new MockBot()
  bot.setAdmin(GROUP_ID, 101)
  bot.getMe = async () => ({ username: BOT_USERNAME })
  const msg = makeGroupMsg({ text: '/welcome Jake', chat: { id: GROUP_ID, type: 'group' }, from: { id: 101, first_name: 'Manager' } })
  await handleWelcomeCommand(bot, msg, 'Jake')
  const groupMsgs = bot.messagesTo(GROUP_ID)
  assert.ok(groupMsgs.length > 0)
  assert.ok(groupMsgs[0].text.includes('Jake'))
})

test('/welcome: blocked for non-admins', async () => {
  const { handleWelcomeCommand } = await import('../../onboarding/handleNewHire.js')
  const bot = new MockBot()
  // NOT setAdmin
  const msg = makeGroupMsg({ text: '/welcome Jake', chat: { id: GROUP_ID, type: 'group' }, from: { id: 999, first_name: 'Rando' } })
  await handleWelcomeCommand(bot, msg, 'Jake')
  assert.ok(!bot.lastMessage(GROUP_ID), 'non-admin should get no reply')
})

// ── Groq intent tests ─────────────────────────────────────────────────────────

const { parseMessage } = await import('../../parseMessage.js')

test('[LLM] "everyone welcome Jake!" → new_hire_announcement, person Jake', async () => {
  const r = await parseMessage('everyone welcome Jake!', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
  assert.ok(r.person?.toLowerCase().includes('jake'), `expected person=Jake, got ${r.person}`)
})

test('[LLM] "please welcome Sarah to the team" → new_hire_announcement', async () => {
  const r = await parseMessage('please welcome Sarah to the team', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
})

test('[LLM] "introducing our new chef Marcus" → new_hire_announcement, role chef', async () => {
  const r = await parseMessage('introducing our new chef Marcus', 'Manager', 'Test Kitchen')
  assert.equal(r.type, 'new_hire_announcement')
})

test('[LLM] "welcome back Emma" → NOT new_hire_announcement (returning staff)', async () => {
  const r = await parseMessage('welcome back Emma', 'Manager', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})

test('[LLM] "welcome everyone" → NOT new_hire_announcement (no specific person)', async () => {
  const r = await parseMessage('welcome everyone', 'Manager', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})

test('[LLM] "can anyone cover my shift" → NOT new_hire_announcement', async () => {
  const r = await parseMessage('can anyone cover my shift', 'Alice', 'Test Kitchen')
  assert.notEqual(r.type, 'new_hire_announcement')
})
