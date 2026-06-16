// Integration tests for the account-centric layer: accounts DB module,
// one-time linking-code lifecycle, and mergeFromAccount() populating a group's
// setup tables from staged web-signup data.
//
// Run with:
//   node --experimental-test-module-mocks --test src/tests/integration/accountLinking.test.js

// Set before any module imports supabase.
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', {
  namedExports: { createClient: supabaseFake.createClient },
})
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake

// Dynamic imports so the env + mock above are in place first.
const accounts = await import('../../server/db/accounts.js')
const { mergeFromAccount } = await import('../../setup/mergeFromAccount.js')
const { connectGroupToAccount, announceConnection } = await import('../../setup/connectAccount.js')

// Minimal bot stub capturing sent messages and serving an invite link.
function fakeBot() {
  const sent = []
  return {
    sent,
    createChatInviteLink: async () => ({ invite_link: 'https://t.me/+invite123' }),
    exportChatInviteLink: async () => 'https://t.me/+invite123',
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }) },
  }
}

const AUTH_ID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => resetFakeClient())

describe('accounts DB module', () => {
  test('ensureAccount creates then returns the same row', async () => {
    const a = await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    assert.equal(a.id, AUTH_ID)
    assert.equal(a.email, 'owner@shop.com')
    const again = await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    assert.equal(again.id, AUTH_ID)
    assert.equal(getFakeClient()._table('accounts').length, 1)
  })

  test('updateAccountSetupData merges patches without clobbering', async () => {
    await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    await accounts.updateAccountSetupData(AUTH_ID, { restaurant_name: 'Bagels' })
    await accounts.updateAccountSetupData(AUTH_ID, { staff: [{ name: 'Sam', role: 'Server' }] })
    const a = await accounts.getAccountByAuthId(AUTH_ID)
    assert.equal(a.setup_data.restaurant_name, 'Bagels')
    assert.equal(a.setup_data.staff.length, 1)
  })

  test('getLinkedGroup returns the connected group', async () => {
    await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    seedTable('setup_sessions', [
      { group_id: 'grp-9', group_name: 'Bagels', account_id: AUTH_ID, setup_complete: true },
    ])
    const g = await accounts.getLinkedGroup(AUTH_ID)
    assert.equal(g.group_id, 'grp-9')
    assert.equal(g.setup_complete, true)
  })
})

describe('linking-code lifecycle', () => {
  test('generate → redeem binds the Telegram user to the account', async () => {
    await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    const link = await accounts.createAccountLink(AUTH_ID)
    assert.ok(link.code)

    const result = await accounts.redeemAccountLink(link.code, 55501)
    assert.equal(result.ok, true)
    assert.equal(result.account.id, AUTH_ID)

    const resolved = await accounts.getAccountByTelegramUser(55501)
    assert.equal(resolved.id, AUTH_ID)
  })

  test('a code cannot be redeemed twice', async () => {
    await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    const link = await accounts.createAccountLink(AUTH_ID)
    await accounts.redeemAccountLink(link.code, 55501)
    const second = await accounts.redeemAccountLink(link.code, 99999)
    assert.equal(second.ok, false)
    assert.equal(second.reason, 'used')
  })

  test('an expired code is rejected', async () => {
    await accounts.ensureAccount(AUTH_ID, 'owner@shop.com')
    seedTable('account_links', [{
      account_id: AUTH_ID,
      code: 'EXPIRED1',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }])
    const result = await accounts.redeemAccountLink('EXPIRED1', 55501)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'expired')
  })

  test('an unknown code is rejected', async () => {
    const result = await accounts.redeemAccountLink('does-not-exist', 1)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not_found')
  })
})

describe('mergeFromAccount', () => {
  test('populates group tables from staged setup_data', async () => {
    const GROUP = 'grp-merge'
    seedTable('setup_sessions', [{ group_id: GROUP, group_name: 'Bagels', account_id: AUTH_ID }])
    const account = {
      id: AUTH_ID,
      setup_data: {
        restaurant_name: 'Bagels',
        phone: '+14155550123',
        shifts: [
          { name: 'Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '3pm',
            requirements: [{ role: 'Server', count: 2 }] },
        ],
        staff: [{ name: 'Sam', role: 'Server' }, { name: 'Mia', role: 'Cook' }],
        role_rates: [{ role_name: 'Server', hourly_rate: 16.5 }],
        tips: { mode: 'pool', split_method: 'hours', boh_included: false },
      },
    }

    const summary = await mergeFromAccount(GROUP, account)
    assert.equal(summary.hasShifts, true)
    assert.equal(summary.hasStaff, true)
    assert.equal(summary.hasRates, true)

    const db = getFakeClient()
    assert.equal(db._table('shifts').length, 1)
    assert.equal(db._table('shifts')[0].group_id, GROUP)
    assert.equal(db._table('shift_requirements').length, 1)
    assert.equal(db._table('staff').length, 2)
    assert.equal(db._table('role_rates').length, 1)
    assert.equal(db._table('restaurant_tip_settings').length, 1)

    const session = db._table('setup_sessions').find(s => s.group_id === GROUP)
    assert.equal(session.phone, '+14155550123')
    assert.equal(session.setup_data.restaurant_name, 'Bagels')
  })

  test('reports missing essentials when staging is partial', async () => {
    const GROUP = 'grp-partial'
    seedTable('setup_sessions', [{ group_id: GROUP, group_name: 'X', account_id: AUTH_ID }])
    const summary = await mergeFromAccount(GROUP, {
      id: AUTH_ID,
      setup_data: { restaurant_name: 'X', staff: [{ name: 'Sam', role: 'Server' }] },
    })
    assert.equal(summary.hasStaff, true)
    assert.equal(summary.hasShifts, false)
  })
})

describe('connectGroupToAccount (auto-connect on bot-added)', () => {
  function seedLinkedAccount(tgUserId) {
    seedTable('accounts', [{
      id: AUTH_ID, business_name: 'Bagels',
      setup_data: {
        restaurant_name: 'Bagels',
        shifts: [{ name: 'Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '3pm' }],
        staff: [{ name: 'Sam', role: 'Server' }],
        role_rates: [{ role_name: 'Server', hourly_rate: 16 }],
      },
    }])
    seedTable('account_links', [{
      account_id: AUTH_ID, code: 'C1', telegram_user_id: tgUserId, used_at: new Date().toISOString(),
    }])
  }

  test('auto-connects, merges, completes, and stores an invite link', async () => {
    seedLinkedAccount(7001)
    const bot = fakeBot()
    const result = await connectGroupToAccount(bot, { groupId: 'grp-auto', groupName: 'Bagels Group', managerUserId: 7001 })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'complete')
    assert.equal(result.inviteLink, 'https://t.me/+invite123')

    const session = getFakeClient()._table('setup_sessions').find(s => s.group_id === 'grp-auto')
    assert.equal(session.account_id, AUTH_ID)
    assert.equal(session.setup_complete, true)
    assert.equal(session.setup_data.invite_link, 'https://t.me/+invite123')
    assert.equal(getFakeClient()._table('shifts').length, 1)
    assert.equal(getFakeClient()._table('staff').length, 1)

    await announceConnection(bot, { groupId: 'grp-auto', result })
    assert.ok(bot.sent.some(m => String(m.text).includes('invite123')))
  })

  test('returns no_account when the adder has no linked account', async () => {
    const bot = fakeBot()
    const result = await connectGroupToAccount(bot, { groupId: 'grp-x', groupName: 'X', managerUserId: 999999 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'no_account')
  })

  test('is idempotent on an already-connected group', async () => {
    seedLinkedAccount(7002)
    seedTable('setup_sessions', [{
      group_id: 'grp-done', group_name: 'Bagels', account_id: AUTH_ID,
      setup_complete: true, setup_data: { invite_link: 'https://t.me/+existing' },
    }])
    const bot = fakeBot()
    const result = await connectGroupToAccount(bot, { groupId: 'grp-done', groupName: 'Bagels', managerUserId: 7002 })
    assert.equal(result.already, true)
    // No duplicate setup_sessions row, no re-merge.
    assert.equal(getFakeClient()._table('setup_sessions').filter(s => s.group_id === 'grp-done').length, 1)
  })
})
