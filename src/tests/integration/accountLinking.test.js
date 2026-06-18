// Integration tests for the account-centric layer: accounts DB module,
// one-time linking-code lifecycle, and connectGroupToAccount() rekeying
// provisional web rows onto the real Telegram group.
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
    // Seed with a future created_at so it sorts first (desc) over the provisional web: row.
    seedTable('setup_sessions', [
      { group_id: 'grp-9', group_name: 'Bagels', account_id: AUTH_ID, setup_complete: true,
        created_at: new Date(Date.now() + 10000).toISOString() },
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

describe('connectGroupToAccount via rekey', () => {
  test('rekeys provisional rows onto the Telegram group and survives orphan roles', async () => {
    const account = await accounts.ensureAccount(AUTH_ID, 'o@shop.com') // provisions web:<id>
    const prov = 'web:' + AUTH_ID
    seedTable('staff', [{ id: 1, group_id: prov, name: 'Sam', role: 'Server', active: true }])
    seedTable('shifts', [{ id: 1, group_id: prov, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true }])
    // A role with NO staff/shift — must still survive (orphan-proof):
    seedTable('role_rates', [{ id: 9, group_id: prov, role_name: 'Dishwasher', hourly_rate: 0 }])
    // Map Telegram user 555 -> this account (account_links is the real table):
    seedTable('account_links', [{ account_id: AUTH_ID, telegram_user_id: 555, used_at: new Date().toISOString() }])

    const bot = fakeBot()
    const result = await connectGroupToAccount(bot, { groupId: '-100999', groupName: 'Sams', managerUserId: 555 })

    assert.equal(result.ok, true)
    assert.equal(getFakeClient()._table('staff')[0].group_id, '-100999')
    assert.equal(getFakeClient()._table('shifts')[0].group_id, '-100999')
    assert.equal(getFakeClient()._table('role_rates')[0].group_id, '-100999')
    assert.equal(result.status, 'complete') // staff + shifts both present
  })
})

describe('connectGroupToAccount (auto-connect on bot-added)', () => {
  // Seeds an account with live provisioned rows (new model: wizard wrote live rows
  // under the provisional web:<id> group; connect rekeys them onto the Telegram group).
  function seedLinkedAccount(tgUserId) {
    const prov = 'web:' + AUTH_ID
    seedTable('accounts', [{ id: AUTH_ID, business_name: 'Bagels' }])
    seedTable('setup_sessions', [{ group_id: prov, account_id: AUTH_ID, setup_complete: false }])
    seedTable('shifts', [{ group_id: prov, name: 'Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '3pm', active: true }])
    seedTable('staff', [{ group_id: prov, name: 'Sam', role: 'Server', active: true }])
    seedTable('role_rates', [{ group_id: prov, role_name: 'Server', hourly_rate: 16 }])
    seedTable('account_links', [{
      account_id: AUTH_ID, code: 'C1', telegram_user_id: tgUserId, used_at: new Date().toISOString(),
    }])
  }

  test('auto-connects, rekeys, completes, and stores an invite link', async () => {
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
