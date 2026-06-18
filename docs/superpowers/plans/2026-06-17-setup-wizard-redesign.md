# Setup Wizard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's staging+merge sync with a single source of truth (provision a `group_id` at signup, write live operational rows, `rekey_group()` at Telegram connect), and rebuild `public/onboarding.html` as a roles-first 6-step wizard with AI parse endpoints and bulk shift tooling.

**Architecture:** Each account owns a stable `group_id` (`web:<uuid>`) from creation, stored as a `setup_sessions` row. The wizard writes staff/roles/shifts/rates straight into the operational tables via a new `/api/account/setup/*` API that reuses the bot's own canonical writers (`saveStaff`/`saveShift`/`saveShiftRequirement`/`updateRoleRate`). At Telegram connect, a Postgres `rekey_group(old,new)` function rewrites `group_id` on every table that has the column. No `setup_data` staging, no `mergeFromAccount` translator.

**Tech Stack:** Node 20 ESM, Express 5, Supabase (service role), `node:test` with a `supabaseFake` in-memory double, vanilla ES-module frontend.

**Spec:** `docs/superpowers/specs/2026-06-17-setup-wizard-redesign-design.md`

**Test commands:**
- Single integration file: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/<file>.test.js`
- Single unit file: `node --env-file=.env --test src/tests/unit/<file>.test.js`

---

## Phase A — Sync foundation (backend)

### Task 1: Extract `normalizeShiftTime` into a shared util

**Files:**
- Create: `src/utils/time.js`
- Modify: `src/server/dashRoutes.js:70-96` (remove local fn, import instead)
- Test: `src/tests/unit/timeNormalize.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/tests/unit/timeNormalize.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeShiftTime } from '../../utils/time.js'

describe('normalizeShiftTime', () => {
  test('canonical HH:MM passes through padded', () => {
    assert.equal(normalizeShiftTime('9:05'), '09:05')
  })
  test('12-hour am/pm → 24h', () => {
    assert.equal(normalizeShiftTime('4:30 PM'), '16:30')
    assert.equal(normalizeShiftTime('11am'), '11:00')
    assert.equal(normalizeShiftTime('12am'), '00:00')
  })
  test('bare ambiguous hour left alone', () => {
    assert.equal(normalizeShiftTime('4'), '4')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/tests/unit/timeNormalize.test.js`
Expected: FAIL — cannot find module `../../utils/time.js`.

- [ ] **Step 3: Create the util** — copy the existing function body verbatim from `dashRoutes.js:70-96` and export it.

```js
// src/utils/time.js
// Normalize a free-typed time into canonical 24h "HH:MM". Shared by the
// dashboard shift routes and the wizard setup routes so both behave identically.
export function normalizeShiftTime(raw) {
  if (raw == null) return raw
  if (typeof raw !== 'string') return raw
  const s = raw.trim()
  if (!s) return s
  const hhmm = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (hhmm) {
    const h = Number(hhmm[1]), m = Number(hhmm[2])
    if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
    return s
  }
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s)
  if (ampm) {
    let h = Number(ampm[1]); const m = Number(ampm[2] || 0); const mer = ampm[3].toLowerCase()
    if (!Number.isFinite(h) || h < 1 || h > 12 || m < 0 || m >= 60) return s
    if (mer === 'am') h = (h === 12) ? 0 : h
    else h = (h === 12) ? 12 : h + 12
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  return s
}
```

- [ ] **Step 4: Replace the local function in `dashRoutes.js`** — delete lines `70-96` (the `function normalizeShiftTime(raw){…}`) and add to the import block at the top:

```js
import { normalizeShiftTime } from '../utils/time.js'
```

- [ ] **Step 5: Run tests**

Run: `node --test src/tests/unit/timeNormalize.test.js`
Expected: PASS (3 tests).
Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/dashApiRoutesFull.test.js`
Expected: PASS (no regressions — shift POST still normalizes).

- [ ] **Step 6: Commit**

```bash
git add src/utils/time.js src/server/dashRoutes.js src/tests/unit/timeNormalize.test.js
git commit -m "refactor: extract normalizeShiftTime to src/utils/time.js"
```

---

### Task 2: Provision an account-owned group at signup

**Files:**
- Modify: `src/server/db/accounts.js` (add `ensureAccountGroup`, `isProvisionalGroup`; call from `ensureAccount`)
- Test: `src/tests/integration/accountProvisioning.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/tests/integration/accountProvisioning.test.js
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, getFakeClient } = supabaseFake
const accounts = await import('../../server/db/accounts.js')

const AUTH_ID = '00000000-0000-0000-0000-000000000001'
beforeEach(() => resetFakeClient())

describe('account group provisioning', () => {
  test('ensureAccount creates exactly one provisional session', async () => {
    await accounts.ensureAccount(AUTH_ID, 'o@shop.com')
    await accounts.ensureAccount(AUTH_ID, 'o@shop.com') // idempotent
    const sessions = getFakeClient()._table('setup_sessions')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].group_id, 'web:' + AUTH_ID)
    assert.equal(sessions[0].account_id, AUTH_ID)
  })
  test('isProvisionalGroup flags web: ids', () => {
    assert.equal(accounts.isProvisionalGroup('web:abc'), true)
    assert.equal(accounts.isProvisionalGroup('-1001234567'), false)
    assert.equal(accounts.isProvisionalGroup(null), false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountProvisioning.test.js`
Expected: FAIL — `ensureAccountGroup`/`isProvisionalGroup` not exported; sessions length 0.

- [ ] **Step 3: Add the helpers and wire into `ensureAccount`** in `src/server/db/accounts.js`.

Add near the top-level exports:

```js
export const isProvisionalGroup = (id) => typeof id === 'string' && id.startsWith('web:')

// Ensure the account owns a group_id. Returns the group_id (provisional
// 'web:<accountId>' until a Telegram group is rekeyed onto it). Idempotent.
export async function ensureAccountGroup(accountId) {
  try {
    const existing = await getDb()
      .from('setup_sessions')
      .select('group_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()
    if (existing.data?.group_id) return existing.data.group_id
    const groupId = 'web:' + accountId
    await getDb()
      .from('setup_sessions')
      .insert({ group_id: groupId, account_id: accountId, setup_complete: false })
    return groupId
  } catch (err) {
    logger.error(`ensureAccountGroup failed: ${err.message}`)
    return null
  }
}
```

Then change `ensureAccount` so it always ensures a group, even when the account already existed:

```js
export async function ensureAccount(authId, email) {
  try {
    let account = await getAccountByAuthId(authId)
    if (!account) {
      const { data, error } = await getDb()
        .from('accounts')
        .upsert({ id: authId, email, updated_at: new Date().toISOString() }, { onConflict: 'id' })
        .select()
        .single()
      if (error) throw error
      account = data
    }
    await ensureAccountGroup(authId)
    return account
  } catch (err) {
    logger.error(`ensureAccount failed: ${err.message}`)
    return null
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountProvisioning.test.js`
Expected: PASS (2 tests).
Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountLinking.test.js`
Expected: the `ensureAccount` tests still PASS (a provisional session now also exists — those assertions only check `accounts` table length, so they remain green).

- [ ] **Step 5: Commit**

```bash
git add src/server/db/accounts.js src/tests/integration/accountProvisioning.test.js
git commit -m "feat: provision an account-owned group_id at signup (web:<uuid>)"
```

---

### Task 3: `rekey_group` SQL function + rekey wrapper + fake-client rpc

**Files:**
- Create: `scripts/migrations/030-rekey-group.sql`
- Modify: `supabase-schema.sql` (append the function)
- Create: `src/setup/db/rekey.js`
- Modify: `src/tests/helpers/supabaseFake.js:239` (implement `rpc('rekey_group', …)`)
- Test: `src/tests/integration/rekeyGroup.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/tests/integration/rekeyGroup.test.js
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const { rekeyGroup } = await import('../../setup/db/rekey.js')

beforeEach(() => resetFakeClient())

describe('rekeyGroup', () => {
  test('moves every group_id row from old to new, idempotently', async () => {
    seedTable('staff', [{ id: 1, group_id: 'web:a', name: 'Sam', role: 'Server' }])
    seedTable('role_rates', [{ id: 1, group_id: 'web:a', role_name: 'Server', hourly_rate: 0 }])
    seedTable('setup_sessions', [{ group_id: 'web:a', account_id: 'a' }])

    const ok = await rekeyGroup('web:a', '-100123')
    assert.equal(ok, true)
    assert.equal(getFakeClient()._table('staff')[0].group_id, '-100123')
    assert.equal(getFakeClient()._table('role_rates')[0].group_id, '-100123')
    assert.equal(getFakeClient()._table('setup_sessions')[0].group_id, '-100123')

    // Re-run is a no-op (nothing matches 'web:a' anymore)
    await rekeyGroup('web:a', '-100123')
    assert.equal(getFakeClient()._table('staff').length, 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/rekeyGroup.test.js`
Expected: FAIL — cannot find `../../setup/db/rekey.js`.

- [ ] **Step 3: Implement the fake-client rpc** — replace `rpc() { return Promise.resolve({ data: null, error: null }) }` at `src/tests/helpers/supabaseFake.js:239` with:

```js
  rpc(fn, args = {}) {
    if (fn === 'rekey_group') {
      const { old_group, new_group } = args
      for (const table of Object.keys(this.store)) {
        for (const row of this.store[table]) {
          if (row.group_id === old_group) row.group_id = new_group
        }
      }
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve({ data: null, error: null })
  }
```

- [ ] **Step 4: Create the JS wrapper**

```js
// src/setup/db/rekey.js
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'

// Rewrite group_id from oldGroupId to newGroupId across every table that has a
// group_id column (via the rekey_group Postgres function). Atomic + idempotent.
export async function rekeyGroup(oldGroupId, newGroupId, db = null) {
  try {
    const client = db || getDb()
    const { error } = await client.rpc('rekey_group', { old_group: oldGroupId, new_group: newGroupId })
    if (error) throw error
    logger.bot(`Rekeyed group ${oldGroupId} → ${newGroupId}`)
    return true
  } catch (err) {
    logger.error(`rekeyGroup failed: ${err.message}`)
    return false
  }
}
```

- [ ] **Step 5: Write the SQL function** in `scripts/migrations/030-rekey-group.sql`:

```sql
-- Rekey a tenant: rewrite group_id on every public table that has the column.
-- Future-proof — any new group_id table is covered automatically.
CREATE OR REPLACE FUNCTION rekey_group(old_group text, new_group text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'group_id'
  LOOP
    EXECUTE format('UPDATE public.%I SET group_id = $1 WHERE group_id = $2', t.table_name)
      USING new_group, old_group;
  END LOOP;
END $$;
```

Append the same `CREATE OR REPLACE FUNCTION …` block to the end of `supabase-schema.sql` so fresh deploys get it.

- [ ] **Step 6: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/rekeyGroup.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/migrations/030-rekey-group.sql supabase-schema.sql src/setup/db/rekey.js src/tests/helpers/supabaseFake.js src/tests/integration/rekeyGroup.test.js
git commit -m "feat: rekey_group() — move a tenant across group_id tables at connect"
```

---

### Task 4: Connect via rekey; delete `mergeFromAccount`

**Files:**
- Modify: `src/setup/connectAccount.js:37-85` (replace merge with rekey + live completion)
- Delete: `src/setup/mergeFromAccount.js`
- Modify: `src/tests/integration/accountLinking.test.js` (drop `mergeFromAccount` describe block; add rekey-connect test)

- [ ] **Step 1: Write the failing test** — append to `src/tests/integration/accountLinking.test.js` a new describe block (and delete the old `describe('mergeFromAccount', …)` block and its `import { mergeFromAccount }` line):

```js
describe('connectGroupToAccount via rekey', () => {
  test('rekeys provisional rows onto the Telegram group and survives orphan roles', async () => {
    const account = await accounts.ensureAccount(AUTH_ID, 'o@shop.com') // provisions web:<id>
    const prov = 'web:' + AUTH_ID
    // Live wizard data written under the provisional group:
    seedTable('staff', [{ id: 1, group_id: prov, name: 'Sam', role: 'Server', active: true }])
    seedTable('shifts', [{ id: 1, group_id: prov, name: 'Lunch', day_of_week: 'Monday', start_time: '11:00', end_time: '15:00', active: true }])
    // A role with NO staff/shift — must still survive (orphan-proof):
    seedTable('role_rates', [{ id: 9, group_id: prov, role_name: 'Dishwasher', hourly_rate: 0 }])
    // Link the Telegram user to this account so getAccountByTelegramUser resolves:
    seedTable('account_telegram_links', [{ account_id: AUTH_ID, telegram_user_id: 555 }])

    const bot = fakeBot()
    const result = await connectGroupToAccount(bot, { groupId: '-100999', groupName: 'Sam’s', managerUserId: 555 })

    assert.equal(result.ok, true)
    assert.equal(getFakeClient()._table('staff')[0].group_id, '-100999')
    assert.equal(getFakeClient()._table('shifts')[0].group_id, '-100999')
    assert.equal(getFakeClient()._table('role_rates')[0].group_id, '-100999')
    assert.equal(result.status, 'complete') // staff + shifts both present
  })
})
```

> Note: `getAccountByTelegramUser` reads whatever table the existing code uses to map a Telegram user → account. Before writing this test, open `src/server/db/accounts.js`, find `getAccountByTelegramUser`, and seed that exact table/columns in the test (the block above assumes `account_telegram_links{account_id, telegram_user_id}` — adjust the `seedTable` name/columns to match the real query).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountLinking.test.js`
Expected: FAIL — current `connectGroupToAccount` calls `mergeFromAccount` and does not rekey; rows keep `web:` group_id.

- [ ] **Step 3: Rewrite `connectGroupToAccount`** in `src/setup/connectAccount.js`. Replace the imports and the body between the guard and the return. New top imports:

```js
import { getSetupSession, createSetupSession, updateSetupSession } from './setupDb.js'
import { getAccountByTelegramUser } from '../server/db/accounts.js'
import { rekeyGroup } from './db/rekey.js'
import { getStaffForGroup } from './db/staff.js'
import { getShiftsForGroup } from './db/shifts.js'
import { getRatesForGroup } from './db/roles.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
```

Replace the function body from the `const dmChatId = …` line through the end of `connectGroupToAccount` with:

```js
  const dmChatId = await lookupDmChat(managerUserId)
  const provisionalId = 'web:' + account.id

  // Move everything the owner set up on the web (under the provisional group)
  // onto the real Telegram group id. Idempotent + covers every group_id table.
  await rekeyGroup(provisionalId, groupId)

  // The rekey moved the provisional session's PK to groupId (if it existed).
  // Ensure a session row exists for this Telegram group, then fill its fields.
  let sess = await getSetupSession(groupId)
  if (!sess) {
    await createSetupSession(groupId, groupName, managerUserId, dmChatId)
  }
  await updateSetupSession(groupId, {
    account_id: account.id,
    manager_id: managerUserId,
    dm_chat_id: dmChatId,
    group_name: groupName,
  })

  // Completion is derived from the live tables, not a merge summary.
  const [staff, shifts, rates] = await Promise.all([
    getStaffForGroup(groupId),
    getShiftsForGroup(groupId),
    getRatesForGroup(groupId),
  ])
  const summary = {
    hasStaff: staff.length > 0,
    hasShifts: shifts.length > 0,
    hasRates: rates.length > 0,
    restaurantName: account.business_name || groupName,
  }
  const bizName = summary.restaurantName
  const inviteLink = await ensureGroupInviteLink(bot, groupId)

  const sess2 = await getSetupSession(groupId)
  await updateSetupSession(groupId, {
    setup_data: { ...(sess2?.setup_data || {}), invite_link: inviteLink || null },
  })

  if (summary.hasShifts && summary.hasStaff) {
    await updateSetupSession(groupId, { step: 'complete', setup_complete: true })
    logger.bot(`Group ${groupId} connected to account ${account.id} (complete)`)
    return { ok: true, status: 'complete', account, summary, bizName, inviteLink }
  }

  const nextStep = !summary.hasShifts ? 'add_shifts' : 'add_staff'
  await updateSetupSession(groupId, { step: nextStep })
  logger.bot(`Group ${groupId} connected to account ${account.id} (continuing at ${nextStep})`)
  return { ok: true, status: 'needs_more', nextStep, account, summary, bizName, dmChatId, inviteLink }
```

(Keep the existing `account`/`existing.setup_complete` guard block at the top of the function unchanged. `announceConnection` below is unchanged — it already reads `result.summary`/`bizName`/`inviteLink`.)

- [ ] **Step 4: Delete the dead translator**

```bash
git rm src/setup/mergeFromAccount.js
```

- [ ] **Step 5: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountLinking.test.js`
Expected: PASS (rekey-connect test green; no remaining reference to `mergeFromAccount`).

- [ ] **Step 6: Commit**

```bash
git add src/setup/connectAccount.js src/tests/integration/accountLinking.test.js
git commit -m "feat: connect via rekey_group; delete setup_data->tables merge translator"
```

---

### Task 5: Connected signal + relax dashboard write-gate

**Files:**
- Modify: `src/server/accountRoutes.js:176-190` (`connection-status` connected logic) + import
- Modify: `src/server/dashRoutes.js:26-34` (mutation gate)
- Modify: `src/tests/integration/accountAuthGuard.test.js` (gate expectation, see Step 1)

- [ ] **Step 1: Update the guard test's expectation.** Open `src/tests/integration/accountAuthGuard.test.js`. The existing test asserts a mutation with **no connected group** returns `409 notConnected`. With provisioning, an account always has a group, so a logged-in owner CAN mutate pre-connect. Find the test that expects `409` for a mutation by an account whose group is null and change it to assert the mutation is **allowed** (e.g. status `201`/`200`) when `req.manager.groupId` is set, OR that the 409 only occurs when `groupId` is genuinely absent (legacy/no session). Concretely, locate the assertion `assert.equal(res.status, 409)` in the connect-guard describe block and replace its scenario so the seeded account has a provisional session (`seedTable('setup_sessions', [{ group_id: 'web:'+AUTH_ID, account_id: AUTH_ID }])`) and assert the POST is no longer 409.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountAuthGuard.test.js`
Expected: FAIL — gate still returns 409 for the now-provisioned mutation.

- [ ] **Step 3: Relax the dash mutation gate** in `src/server/dashRoutes.js` (lines ~26-34). Replace the gate body so it only blocks when there is genuinely no group at all (groupId null), which provisioning makes rare/legacy:

```js
router.use((req, res, next) => {
  // Every account owns a group_id from signup, so writes are never orphaned.
  // Only block the rare case of no group at all (legacy sessions).
  if (req.method !== 'GET' && !req.manager?.groupId) {
    return res.status(409).json({
      error: 'Your account is still initializing — refresh and try again.',
      notConnected: true,
    })
  }
  next()
})
```

(Bot-notifying side-effects already no-op pre-connect via `safeSend`, so allowing writes is safe.)

- [ ] **Step 4: Update `connection-status`** in `src/server/accountRoutes.js`. Add to the imports from `./db/accounts.js`: `isProvisionalGroup`. Change the handler's response:

```js
    const connected = !!group?.group_id && !isProvisionalGroup(group.group_id)
    res.json({
      connected,
      groupId: connected ? group.group_id : null,
      restaurantName: group?.group_name ?? null,
      setupComplete: group?.setup_complete ?? false,
      inviteLink: group?.setup_data?.invite_link ?? null,
    })
```

- [ ] **Step 5: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/accountAuthGuard.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/dashRoutes.js src/server/accountRoutes.js src/tests/integration/accountAuthGuard.test.js
git commit -m "feat: connected = non-provisional group; allow pre-connect dashboard writes"
```

---

## Phase B — Setup + parse API

### Task 6: DB helpers for edit/delete by id

**Files:**
- Modify: `src/setup/db/staff.js` (add `updateStaffById`, `deleteStaffById`)
- Modify: `src/setup/db/shifts.js` (add `deleteShiftById`)
- Modify: `src/setup/db/roles.js` (add `deleteRole`)
- Test: `src/tests/integration/setupDbHelpers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/tests/integration/setupDbHelpers.test.js
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const staff = await import('../../setup/db/staff.js')
const shifts = await import('../../setup/db/shifts.js')
const roles = await import('../../setup/db/roles.js')

beforeEach(() => resetFakeClient())

describe('setup db helpers', () => {
  test('updateStaffById changes name/role within group', async () => {
    seedTable('staff', [{ id: 1, group_id: 'g', name: 'Sam', role: 'Server' }])
    await staff.updateStaffById(1, 'g', { role: 'Cook' })
    assert.equal(getFakeClient()._table('staff')[0].role, 'Cook')
  })
  test('deleteStaffById removes the row', async () => {
    seedTable('staff', [{ id: 1, group_id: 'g', name: 'Sam', role: 'Server' }])
    await staff.deleteStaffById(1, 'g')
    assert.equal(getFakeClient()._table('staff').length, 0)
  })
  test('deleteShiftById removes shift and its requirements', async () => {
    seedTable('shifts', [{ id: 5, group_id: 'g', name: 'Lunch' }])
    seedTable('shift_requirements', [{ id: 1, shift_id: 5, role: 'Server', count: 2 }])
    await shifts.deleteShiftById(5, 'g')
    assert.equal(getFakeClient()._table('shifts').length, 0)
    assert.equal(getFakeClient()._table('shift_requirements').length, 0)
  })
  test('deleteRole removes the role_rates row', async () => {
    seedTable('role_rates', [{ id: 1, group_id: 'g', role_name: 'Server', hourly_rate: 0 }])
    await roles.deleteRole('g', 'Server')
    assert.equal(getFakeClient()._table('role_rates').length, 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupDbHelpers.test.js`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Add helpers.**

In `src/setup/db/staff.js`:

```js
export async function updateStaffById(id, groupId, changes) {
  try {
    const fields = {}
    if (changes.name !== undefined) fields.name = changes.name
    if (changes.role !== undefined) fields.role = changes.role
    const { data, error } = await getDb()
      .from('staff').update(fields).eq('id', id).eq('group_id', groupId).select().single()
    if (error) throw error
    return data
  } catch (err) { logger.error(`updateStaffById failed: ${err.message}`); return null }
}

export async function deleteStaffById(id, groupId) {
  try {
    const { error } = await getDb().from('staff').delete().eq('id', id).eq('group_id', groupId)
    if (error) throw error
    return true
  } catch (err) { logger.error(`deleteStaffById failed: ${err.message}`); return false }
}
```

In `src/setup/db/shifts.js`:

```js
export async function deleteShiftById(shiftId, groupId) {
  try {
    await getDb().from('shift_requirements').delete().eq('shift_id', shiftId)
    const { error } = await getDb().from('shifts').delete().eq('id', shiftId).eq('group_id', groupId)
    if (error) throw error
    return true
  } catch (err) { logger.error(`deleteShiftById failed: ${err.message}`); return false }
}
```

In `src/setup/db/roles.js`:

```js
export async function deleteRole(groupId, roleName, db = null) {
  if (db?.deleteRole) return db.deleteRole(groupId, roleName)
  try {
    const { error } = await getDb().from('role_rates').delete().eq('group_id', groupId).eq('role_name', roleName)
    if (error) throw error
    return true
  } catch (err) { logger.error(`deleteRole failed: ${err.message}`); return false }
}
```

- [ ] **Step 4: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupDbHelpers.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/db/staff.js src/setup/db/shifts.js src/setup/db/roles.js src/tests/integration/setupDbHelpers.test.js
git commit -m "feat: add updateStaffById/deleteStaffById/deleteShiftById/deleteRole helpers"
```

---

### Task 7: `setupRoutes.js` — resume read + roles + rates + business name

**Files:**
- Create: `src/server/setupRoutes.js`
- Modify: `src/server/accountRoutes.js` (export `requireAccount` as a named export)
- Modify: `src/server/webServer.js:52` (mount `setupRoutes` before `accountRoutes`)
- Test: `src/tests/integration/setupRoutes.test.js`

- [ ] **Step 1: Export `requireAccount`** from `src/server/accountRoutes.js` — change `function requireAccount(req, res, next) {` to `export function requireAccount(req, res, next) {`.

- [ ] **Step 2: Write the failing test**

```js
// src/tests/integration/setupRoutes.test.js
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'
process.env.SUPABASE_JWT_SECRET = 'supabase-test-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })
const { resetFakeClient, seedTable, getFakeClient } = supabaseFake
const setupRouter = (await import('../../server/setupRoutes.js')).default

const AUTH_ID = '00000000-0000-0000-0000-000000000042'
const PROV = 'web:' + AUTH_ID
function token() { return jwt.sign({ sub: AUTH_ID, email: 'o@shop.com', aud: 'authenticated', role: 'authenticated' }, process.env.SUPABASE_JWT_SECRET) }

function app() {
  const a = express(); a.use(express.json())
  a.use('/api/account/setup', setupRouter)
  return a
}
async function req(method, path, body) {
  const server = createServer(app()); await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  await new Promise(r => server.close(r))
  return { status: res.status, body: data }
}

beforeEach(() => {
  resetFakeClient()
  seedTable('accounts', [{ id: AUTH_ID, email: 'o@shop.com', business_name: 'Bagels', setup_data: {}, login_2fa_enabled: false }])
  seedTable('setup_sessions', [{ group_id: PROV, account_id: AUTH_ID, setup_complete: false }])
})

describe('setup routes: roles/rates/business + resume', () => {
  test('POST /role creates a role_rates row at 0', async () => {
    const r = await req('POST', '/api/account/setup/role', { role: 'Server' })
    assert.equal(r.status, 201)
    const rows = getFakeClient()._table('role_rates')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].group_id, PROV)
    assert.equal(rows[0].role_name, 'Server')
  })
  test('POST /role does not clobber an existing rate', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 18 }])
    await req('POST', '/api/account/setup/role', { role: 'Server' })
    assert.equal(getFakeClient()._table('role_rates')[0].hourly_rate, 18)
  })
  test('PATCH /rate sets the hourly rate', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 0 }])
    const r = await req('PATCH', '/api/account/setup/rate', { role: 'Server', hourly_rate: 16.5 })
    assert.equal(r.status, 200)
    assert.equal(getFakeClient()._table('role_rates')[0].hourly_rate, 16.5)
  })
  test('GET / returns roles + staff + shifts + businessName for resume', async () => {
    seedTable('role_rates', [{ id: 1, group_id: PROV, role_name: 'Server', hourly_rate: 16.5 }])
    seedTable('staff', [{ id: 1, group_id: PROV, name: 'Sam', role: 'Server', active: true }])
    const r = await req('GET', '/api/account/setup')
    assert.equal(r.status, 200)
    assert.equal(r.body.businessName, 'Bagels')
    assert.equal(r.body.roles[0].name, 'Server')
    assert.equal(r.body.roles[0].rate, 16.5)
    assert.equal(r.body.staff[0].name, 'Sam')
    assert.equal(r.body.connected, false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupRoutes.test.js`
Expected: FAIL — cannot find `setupRoutes.js`.

- [ ] **Step 4: Create `src/server/setupRoutes.js`** (this task adds GET/role/rate/business-name; staff/shift/parse come in Tasks 8-9 — leave room but only add these handlers now):

```js
import express from 'express'
import { requireAuth } from './middleware.js'
import { requireAccount } from './accountRoutes.js'
import {
  getAccountByAuthId, updateAccount, isProvisionalGroup,
} from './db/accounts.js'
import { updateSetupSession } from '../setup/setupDb.js'
import { getStaffForGroup } from '../setup/db/staff.js'
import { getShiftsForGroup, getShiftRequirements } from '../setup/db/shifts.js'
import { getRatesForGroup, updateRoleRate, deleteRole } from '../setup/db/roles.js'

const router = express.Router()
const gate = [requireAuth, requireAccount]

// GET /api/account/setup — everything the wizard needs to resume.
router.get('/', ...gate, async (req, res) => {
  try {
    const groupId = req.manager.groupId
    const [staff, shiftsRaw, rates, account] = await Promise.all([
      getStaffForGroup(groupId),
      getShiftsForGroup(groupId),
      getRatesForGroup(groupId),
      getAccountByAuthId(req.manager.accountId),
    ])
    const shifts = []
    for (const s of shiftsRaw) {
      const reqs = await getShiftRequirements(s.id)
      shifts.push({
        id: s.id, name: s.name, day_of_week: s.day_of_week,
        start_time: s.start_time, end_time: s.end_time,
        requirements: (reqs || []).map(r => ({ role: r.role, count: r.count })),
      })
    }
    res.json({
      businessName: account?.business_name || '',
      roles: (rates || []).map(r => ({ name: r.roleName, rate: Number(r.hourlyRate) || 0 })),
      staff: (staff || []).map(s => ({ id: s.id, name: s.name, role: s.role })),
      shifts,
      connected: !isProvisionalGroup(groupId),
    })
  } catch (err) {
    console.error('GET /setup error:', err.message)
    res.status(500).json({ error: 'Could not load your setup' })
  }
})

// POST /api/account/setup/role — create a role (idempotent, never clobbers a rate).
router.post('/role', ...gate, async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim()
    if (!role) return res.status(400).json({ error: 'Role name required' })
    const existing = await getRatesForGroup(req.manager.groupId)
    if (!existing.some(r => r.roleName.toLowerCase() === role.toLowerCase())) {
      await updateRoleRate(req.manager.groupId, role, 0)
    }
    res.status(201).json({ role })
  } catch (err) {
    console.error('POST /setup/role error:', err.message)
    res.status(500).json({ error: 'Could not add role' })
  }
})

// DELETE /api/account/setup/role/:role
router.delete('/role/:role', ...gate, async (req, res) => {
  try {
    await deleteRole(req.manager.groupId, decodeURIComponent(req.params.role))
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/role error:', err.message)
    res.status(500).json({ error: 'Could not remove role' })
  }
})

// PATCH /api/account/setup/rate — set hourly rate for a role.
router.patch('/rate', ...gate, async (req, res) => {
  try {
    const role = String(req.body?.role || '').trim()
    if (!role) return res.status(400).json({ error: 'Role required' })
    await updateRoleRate(req.manager.groupId, role, Number(req.body?.hourly_rate) || 0)
    res.json({ role, hourly_rate: Number(req.body?.hourly_rate) || 0 })
  } catch (err) {
    console.error('PATCH /setup/rate error:', err.message)
    res.status(500).json({ error: 'Could not save rate' })
  }
})

// POST /api/account/setup/business-name
router.post('/business-name', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name required' })
    await updateAccount(req.manager.accountId, { business_name: name })
    await updateSetupSession(req.manager.groupId, { group_name: name })
    res.json({ businessName: name })
  } catch (err) {
    console.error('POST /setup/business-name error:', err.message)
    res.status(500).json({ error: 'Could not save name' })
  }
})

export default router
```

- [ ] **Step 5: Mount the router** in `src/server/webServer.js`. Add the import near the other route imports and mount it **before** `accountRoutes`:

```js
import setupRoutes from './setupRoutes.js'
// …
  app.use('/api/account/setup', setupRoutes) // wizard live-write API (must precede /api/account)
  app.use('/api/account', accountRoutes)
```

- [ ] **Step 6: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupRoutes.test.js`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/server/setupRoutes.js src/server/accountRoutes.js src/server/webServer.js src/tests/integration/setupRoutes.test.js
git commit -m "feat: /api/account/setup — live resume read + roles/rates/business name"
```

---

### Task 8: `setupRoutes.js` — staff + shift writes

**Files:**
- Modify: `src/server/setupRoutes.js` (add staff + shift handlers)
- Test: `src/tests/integration/setupRoutes.test.js` (add a describe block)

- [ ] **Step 1: Write the failing test** — append to `src/tests/integration/setupRoutes.test.js`:

```js
describe('setup routes: staff + shifts', () => {
  test('POST /staff inserts a staff row under the group', async () => {
    const r = await req('POST', '/api/account/setup/staff', { name: 'Sam', role: 'Server' })
    assert.equal(r.status, 201)
    const rows = getFakeClient()._table('staff')
    assert.equal(rows[0].name, 'Sam')
    assert.equal(rows[0].group_id, PROV)
  })
  test('DELETE /staff/:id removes it', async () => {
    seedTable('staff', [{ id: 7, group_id: PROV, name: 'Sam', role: 'Server' }])
    const r = await req('DELETE', '/api/account/setup/staff/7')
    assert.equal(r.status, 204)
    assert.equal(getFakeClient()._table('staff').length, 0)
  })
  test('POST /shift creates a shift + its requirements, normalizing time', async () => {
    const r = await req('POST', '/api/account/setup/shift', {
      name: 'Lunch', day_of_week: 'Monday', start_time: '11am', end_time: '3pm',
      requirements: [{ role: 'Server', count: 2 }],
    })
    assert.equal(r.status, 201)
    const shift = getFakeClient()._table('shifts')[0]
    assert.equal(shift.start_time, '11:00')
    assert.equal(shift.end_time, '15:00')
    const reqs = getFakeClient()._table('shift_requirements')
    assert.equal(reqs[0].role, 'Server')
    assert.equal(reqs[0].count, 2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupRoutes.test.js`
Expected: FAIL — staff/shift routes return 404.

- [ ] **Step 3: Add handlers** to `src/server/setupRoutes.js`. Extend the imports:

```js
import { saveStaff, updateStaffById, deleteStaffById } from '../setup/db/staff.js'
import { saveShift, saveShiftRequirement, deleteShiftById } from '../setup/db/shifts.js'
import { normalizeShiftTime } from '../utils/time.js'
```

Add before `export default router`:

```js
// ── Staff ──
router.post('/staff', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name required' })
    const role = String(req.body?.role || 'Staff').trim() || 'Staff'
    const row = await saveStaff(req.manager.groupId, name, role)
    res.status(201).json({ id: row?.id, name, role })
  } catch (err) {
    console.error('POST /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not add team member' })
  }
})

router.patch('/staff/:id', ...gate, async (req, res) => {
  try {
    const changes = {}
    if (req.body?.name !== undefined) changes.name = String(req.body.name).trim()
    if (req.body?.role !== undefined) changes.role = String(req.body.role).trim()
    const row = await updateStaffById(req.params.id, req.manager.groupId, changes)
    res.json(row || {})
  } catch (err) {
    console.error('PATCH /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not update team member' })
  }
})

router.delete('/staff/:id', ...gate, async (req, res) => {
  try {
    await deleteStaffById(req.params.id, req.manager.groupId)
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/staff error:', err.message)
    res.status(500).json({ error: 'Could not remove team member' })
  }
})

// ── Shifts ──
router.post('/shift', ...gate, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim()
    const day = String(req.body?.day_of_week || '').trim()
    if (!name || !day) return res.status(400).json({ error: 'Shift name and day are required' })
    const start = normalizeShiftTime(String(req.body?.start_time || '').trim())
    const end = normalizeShiftTime(String(req.body?.end_time || '').trim())
    const shift = await saveShift(req.manager.groupId, name, day, start || null, end || null)
    if (shift?.id && Array.isArray(req.body?.requirements)) {
      for (const r of req.body.requirements) {
        if (r?.role) await saveShiftRequirement(shift.id, r.role, Number(r.count) || 1)
      }
    }
    res.status(201).json({ id: shift?.id, name, day_of_week: day, start_time: start, end_time: end })
  } catch (err) {
    console.error('POST /setup/shift error:', err.message)
    res.status(500).json({ error: 'Could not add shift' })
  }
})

router.delete('/shift/:id', ...gate, async (req, res) => {
  try {
    await deleteShiftById(req.params.id, req.manager.groupId)
    res.status(204).end()
  } catch (err) {
    console.error('DELETE /setup/shift error:', err.message)
    res.status(500).json({ error: 'Could not remove shift' })
  }
})
```

- [ ] **Step 4: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupRoutes.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/server/setupRoutes.js src/tests/integration/setupRoutes.test.js
git commit -m "feat: /api/account/setup staff + shift writes via canonical writers"
```

---

### Task 9: AI parse endpoints

**Files:**
- Modify: `src/server/setupRoutes.js` (add `/parse-shifts`, `/parse-staff`)
- Test: `src/tests/integration/setupParseRoutes.test.js`

- [ ] **Step 1: Write the failing test** (mocks the parsers + LLM presence):

```js
// src/tests/integration/setupParseRoutes.test.js
process.env.SUPABASE_URL = 'http://test.local'
process.env.SUPABASE_ANON_KEY = 'test-key'
process.env.JWT_SECRET = 'relay-dev-secret-change-in-production'
process.env.SUPABASE_JWT_SECRET = 'supabase-test-secret-change-in-production'

import { test, describe, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import jwt from 'jsonwebtoken'
import * as supabaseFake from '../helpers/supabaseFake.js'
mock.module('@supabase/supabase-js', { namedExports: { createClient: supabaseFake.createClient } })

let LLM_ON = true
mock.module('../../parsers/llm.js', { namedExports: { hasAnyLLM: () => LLM_ON } })
mock.module('../../parseMessage.js', { namedExports: {
  parseShift: async () => ([{ name: 'Lunch', day_of_week: 'Monday', start_time: '11:00 AM', end_time: '3:00 PM' }]),
  parseShiftRequirements: async () => ([{ shift_name: 'Lunch', role: 'Server', count: 2 }]),
  parseStaff: async () => ([{ name: 'Sam', role: 'Server' }]),
}})

const { resetFakeClient, seedTable } = supabaseFake
const setupRouter = (await import('../../server/setupRoutes.js')).default

const AUTH_ID = '00000000-0000-0000-0000-000000000042'
function token() { return jwt.sign({ sub: AUTH_ID, email: 'o@shop.com', aud: 'authenticated', role: 'authenticated' }, process.env.SUPABASE_JWT_SECRET) }
function app() { const a = express(); a.use(express.json()); a.use('/api/account/setup', setupRouter); return a }
async function req(method, path, body) {
  const server = createServer(app()); await new Promise(r => server.listen(0, r))
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => null)
  await new Promise(r => server.close(r)); return { status: res.status, body: data }
}

beforeEach(() => {
  LLM_ON = true
  resetFakeClient()
  seedTable('accounts', [{ id: AUTH_ID, email: 'o@shop.com', business_name: 'B', setup_data: {}, login_2fa_enabled: false }])
  seedTable('setup_sessions', [{ group_id: 'web:' + AUTH_ID, account_id: AUTH_ID, setup_complete: false }])
})

describe('setup parse routes', () => {
  test('POST /parse-shifts returns shifts with merged requirements', async () => {
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'lunch mon 11-3, 2 servers' })
    assert.equal(r.status, 200)
    assert.equal(r.body.shifts[0].name, 'Lunch')
    assert.deepEqual(r.body.shifts[0].requirements, [{ role: 'Server', count: 2 }])
  })
  test('POST /parse-staff returns staff', async () => {
    const r = await req('POST', '/api/account/setup/parse-staff', { text: 'Sam is a server' })
    assert.equal(r.body.staff[0].name, 'Sam')
  })
  test('503 when no LLM configured', async () => {
    LLM_ON = false
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'x' })
    assert.equal(r.status, 503)
    assert.equal(r.body.reason, 'no_llm')
  })
  test('400 when text over 2000 chars', async () => {
    const r = await req('POST', '/api/account/setup/parse-shifts', { text: 'a'.repeat(2001) })
    assert.equal(r.status, 400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupParseRoutes.test.js`
Expected: FAIL — parse routes 404.

- [ ] **Step 3: Add the parse handlers** to `src/server/setupRoutes.js`. Extend imports:

```js
import { parseShift, parseStaff, parseShiftRequirements } from '../parseMessage.js'
import { hasAnyLLM } from '../parsers/llm.js'
```

Add before `export default router`:

```js
const MAX_PARSE = 2000
function parseGuard(req, res) {
  if (!hasAnyLLM()) { res.status(503).json({ error: 'AI parsing is not available', reason: 'no_llm' }); return null }
  const text = String(req.body?.text || '')
  if (text.length > MAX_PARSE) { res.status(400).json({ error: 'That description is too long' }); return null }
  return text
}

router.post('/parse-shifts', ...gate, async (req, res) => {
  const text = parseGuard(req, res); if (text === null) return
  try {
    const shifts = await parseShift(text)
    const names = [...new Set(shifts.map(s => s.name))]
    const reqs = names.length ? await parseShiftRequirements(text, names) : []
    const byName = {}
    for (const r of reqs) (byName[r.shift_name] ||= []).push({ role: r.role, count: r.count })
    res.json({ shifts: shifts.map(s => ({ ...s, requirements: byName[s.name] || [] })) })
  } catch (err) {
    console.error('POST /setup/parse-shifts error:', err.message)
    res.json({ shifts: [] })
  }
})

router.post('/parse-staff', ...gate, async (req, res) => {
  const text = parseGuard(req, res); if (text === null) return
  try {
    res.json({ staff: await parseStaff(text, null) })
  } catch (err) {
    console.error('POST /setup/parse-staff error:', err.message)
    res.json({ staff: [] })
  }
})
```

- [ ] **Step 4: Run tests**

Run: `node --env-file=.env --experimental-test-module-mocks --test src/tests/integration/setupParseRoutes.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/setupRoutes.js src/tests/integration/setupParseRoutes.test.js
git commit -m "feat: /api/account/setup parse-shifts + parse-staff (server-side LLM)"
```

---

## Phase C — Frontend

### Task 10: Pure wizard helpers + unit tests

**Files:**
- Create: `public/onboardingHelpers.js`
- Test: `src/tests/unit/onboardingHelpers.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/tests/unit/onboardingHelpers.test.js
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { expandShiftRows, groupParsedShifts, normalizeTime, splitNames, TEMPLATES } from '../../../public/onboardingHelpers.js'

describe('expandShiftRows', () => {
  test('one row → one shift per selected day, requirements carried', () => {
    const out = expandShiftRows([{ name: 'Lunch', days: ['Monday', 'Tuesday'], start: '11:00 AM', end: '3:00 PM', requirements: [{ role: 'Server', count: 2 }] }])
    assert.equal(out.length, 2)
    assert.equal(out[0].day_of_week, 'Monday')
    assert.deepEqual(out[1].requirements, [{ role: 'Server', count: 2 }])
  })
  test('rows with no name or no days are skipped', () => {
    assert.equal(expandShiftRows([{ name: '', days: ['Monday'] }, { name: 'X', days: [] }]).length, 0)
  })
})

describe('groupParsedShifts', () => {
  test('collapses identical name+time across days into one multi-day row', () => {
    const rows = groupParsedShifts([
      { name: 'Lunch', day_of_week: 'Monday', start_time: '11:00 AM', end_time: '3:00 PM', requirements: [{ role: 'Server', count: 2 }] },
      { name: 'Lunch', day_of_week: 'Tuesday', start_time: '11:00 AM', end_time: '3:00 PM', requirements: [{ role: 'Server', count: 1 }] },
    ])
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].days, ['Monday', 'Tuesday'])
    assert.equal(rows[0].requirements[0].count, 2) // max merge
  })
})

describe('normalizeTime', () => {
  test('parses many formats to 12-hour display', () => {
    assert.equal(normalizeTime('11'), '11:00 AM')
    assert.equal(normalizeTime('11a'), '11:00 AM')
    assert.equal(normalizeTime('1330'), '1:30 PM')
    assert.equal(normalizeTime('5pm'), '5:00 PM')
    assert.equal(normalizeTime('12am'), '12:00 AM')
  })
  test('returns input unchanged when unparseable', () => {
    assert.equal(normalizeTime('lunchtime'), 'lunchtime')
  })
})

describe('splitNames', () => {
  test('splits on newlines and commas', () => {
    assert.deepEqual(splitNames('Sam, Alex\nJo'), ['Sam', 'Alex', 'Jo'])
  })
})

describe('TEMPLATES', () => {
  test('Restaurant template has roles and shifts', () => {
    assert.ok(TEMPLATES.Restaurant.roles.includes('Server'))
    assert.ok(TEMPLATES.Restaurant.shifts.length > 0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/tests/unit/onboardingHelpers.test.js`
Expected: FAIL — cannot find `public/onboardingHelpers.js`.

- [ ] **Step 3: Create `public/onboardingHelpers.js`** (pure, no imports — safe in Node and the browser):

```js
// Pure, dependency-free helpers for the setup wizard. Imported by
// public/onboarding.js (browser) and unit-tested directly in Node.

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
export const WEEKDAYS = DAYS.slice(0, 5)

// Multi-day grid rows → flat per-day shift payloads for POST /setup/shift.
export function expandShiftRows(rows) {
  const out = []
  for (const r of rows || []) {
    if (!r || !r.name || !Array.isArray(r.days) || !r.days.length) continue
    for (const day of r.days) {
      out.push({
        name: r.name,
        day_of_week: day,
        start_time: r.start || '',
        end_time: r.end || '',
        requirements: r.requirements || [],
      })
    }
  }
  return out
}

// Day-expanded parser output → grouped multi-day rows (identical name+time merge).
export function groupParsedShifts(parsed) {
  const map = new Map()
  for (const s of parsed || []) {
    const key = `${s.name}|${s.start_time}|${s.end_time}`
    if (!map.has(key)) {
      map.set(key, { name: s.name, days: [], start: s.start_time, end: s.end_time, requirements: [] })
    }
    const g = map.get(key)
    if (!g.days.includes(s.day_of_week)) g.days.push(s.day_of_week)
    for (const req of (s.requirements || [])) {
      const ex = g.requirements.find(x => x.role === req.role)
      if (ex) ex.count = Math.max(ex.count, req.count)
      else g.requirements.push({ role: req.role, count: req.count })
    }
  }
  return [...map.values()]
}

// Forgiving time parse → "h:MM AM/PM" display (server re-normalizes to 24h on save).
export function normalizeTime(input) {
  if (input == null) return input
  const s = String(input).trim().toLowerCase()
  if (!s) return s
  let h, m = 0, mer = null, mm
  if ((mm = /^(\d{1,2}):(\d{2})\s*(a|p|am|pm)?$/.exec(s))) { h = +mm[1]; m = +mm[2]; mer = mm[3] }
  else if ((mm = /^(\d{1,2})\s*(a|p|am|pm)$/.exec(s))) { h = +mm[1]; mer = mm[2] }
  else if ((mm = /^(\d{3,4})$/.exec(s))) { h = +mm[1].slice(0, mm[1].length - 2); m = +mm[1].slice(-2) }
  else if ((mm = /^(\d{1,2})$/.exec(s))) { h = +mm[1] }
  else return String(input)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(input)
  if (mer) { const am = mer[0] === 'a'; if (am) h = (h === 12 ? 0 : h); else h = (h === 12 ? 12 : h + 12) }
  if (h < 0 || h > 23 || m < 0 || m > 59) return String(input)
  const suffix = h < 12 ? 'AM' : 'PM'
  let h12 = h % 12; if (h12 === 0) h12 = 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

export function splitNames(text) {
  return String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
}

export const TEMPLATES = {
  Restaurant: {
    roles: ['Server', 'Cook', 'Host', 'Bartender', 'Manager'],
    shifts: [
      { name: 'Lunch', days: WEEKDAYS.slice(), start: '11:00 AM', end: '3:00 PM', requirements: [] },
      { name: 'Dinner', days: DAYS.slice(), start: '5:00 PM', end: '10:00 PM', requirements: [] },
    ],
  },
  'Café': {
    roles: ['Barista', 'Cook', 'Cashier', 'Manager'],
    shifts: [
      { name: 'Open', days: DAYS.slice(), start: '7:00 AM', end: '12:00 PM', requirements: [] },
      { name: 'Afternoon', days: DAYS.slice(), start: '12:00 PM', end: '5:00 PM', requirements: [] },
    ],
  },
  Bar: {
    roles: ['Bartender', 'Server', 'Barback', 'Security', 'Manager'],
    shifts: [
      { name: 'Evening', days: DAYS.slice(), start: '5:00 PM', end: '11:00 PM', requirements: [] },
      { name: 'Late', days: ['Friday', 'Saturday'], start: '11:00 PM', end: '2:00 AM', requirements: [] },
    ],
  },
  Retail: {
    roles: ['Sales Associate', 'Cashier', 'Stock', 'Manager'],
    shifts: [
      { name: 'Opening', days: DAYS.slice(), start: '9:00 AM', end: '2:00 PM', requirements: [] },
      { name: 'Closing', days: DAYS.slice(), start: '2:00 PM', end: '8:00 PM', requirements: [] },
    ],
  },
  'Coffee shop': {
    roles: ['Barista', 'Cashier', 'Shift Lead'],
    shifts: [
      { name: 'Morning', days: DAYS.slice(), start: '6:00 AM', end: '11:00 AM', requirements: [] },
      { name: 'Midday', days: DAYS.slice(), start: '11:00 AM', end: '4:00 PM', requirements: [] },
    ],
  },
}
```

- [ ] **Step 4: Run tests**

Run: `node --test src/tests/unit/onboardingHelpers.test.js`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add public/onboardingHelpers.js src/tests/unit/onboardingHelpers.test.js
git commit -m "feat: pure wizard helpers (expand/group shifts, time parse, templates)"
```

---

### Task 11: Rebuild `onboarding.html` + wizard module

**Files:**
- Rewrite: `public/onboarding.html`
- Create: `public/onboarding.js`

This task is UI wiring with no automated harness; verify manually in Task 12. Build it in small commits per step.

- [ ] **Step 1: Replace `public/onboarding.html`** with lean markup that loads the module. Keep the existing `<head>`/CSS block from the current file and ADD the styles below into the `<style>`; replace the `<body>` content and the inline `<script>` with the structure here.

Add these rules to the existing `<style>`:

```css
.chip { display:inline-block; padding:7px 12px; margin:0 6px 6px 0; border:1.5px solid #E8DFD0; border-radius:20px; background:#FAF7F2; font-size:13px; font-family:inherit; cursor:pointer; color:#4A3F35; }
.chip:hover { border-color:#D95F2B; color:#D95F2B; }
.chip.on { background:#D95F2B; color:#fff; border-color:#D95F2B; }
.day-chips { display:flex; flex-wrap:wrap; gap:4px; }
.day-chip { width:34px; height:30px; display:flex; align-items:center; justify-content:center; border:1.5px solid #E8DFD0; border-radius:6px; font-size:12px; cursor:pointer; background:#FAF7F2; }
.day-chip.on { background:#D95F2B; color:#fff; border-color:#D95F2B; }
.presets { margin:6px 0; }
.shift-card { border:1.5px solid #E8DFD0; border-radius:10px; padding:12px; margin-bottom:10px; }
.shift-top { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.ai-box { width:100%; min-height:64px; padding:10px 12px; border:1.5px solid #E8DFD0; border-radius:8px; font-family:inherit; font-size:14px; background:#FAF7F2; resize:vertical; }
.ai-row { display:flex; gap:8px; margin:8px 0 14px; }
.staffing { margin-top:8px; padding-top:8px; border-top:1px dashed #E8DFD0; }
.review-section { margin-bottom:16px; }
.review-section h3 { font-size:14px; margin-bottom:4px; }
.review-edit { font-size:13px; color:#D95F2B; background:none; border:none; cursor:pointer; font-family:inherit; }
.progress div.clickable { cursor:pointer; }
.muted { color:#9A8880; font-size:13px; }
```

Replace `<body>` with:

```html
<body>
  <nav class="nav">
    <div class="nav-left">
      <div class="nav-logo-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="20" height="20"><path d="M 7,2.5 L 25,2.5 Q 29,2.5 29,6 L 29,19 Q 29,23 25,23 L 10,23 L 4,28 L 6,23 Q 3,23 3,19 L 3,6 Q 3,2.5 7,2.5 Z" fill="white"/></svg></div>
      <span class="nav-logo-text">Relay</span>
    </div>
    <button class="link-btn" id="logout-btn">Sign out</button>
  </nav>
  <main class="main">
    <div class="card">
      <div class="progress" id="progress">
        <div data-p="0"></div><div data-p="1"></div><div data-p="2"></div><div data-p="3"></div><div data-p="4"></div><div data-p="5"></div>
      </div>

      <!-- Step 0: Business name + templates -->
      <div class="step active" data-step="0">
        <h1>What's your business called?</h1>
        <p class="subtitle">We'll use this across your dashboard and team chat.</p>
        <input type="text" class="form-input" id="business-name" placeholder="e.g. The Bagel Shop">
        <p class="label">Quick start (optional) — pick a type to pre-fill roles & shifts:</p>
        <div id="template-chips"></div>
        <div class="actions"><span></span><button class="btn-primary" data-next>Continue</button></div>
      </div>

      <!-- Step 1: Roles -->
      <div class="step" data-step="1">
        <h1>What roles do you staff?</h1>
        <p class="subtitle">Create your roles first — you'll assign people and shifts to them next.</p>
        <div id="role-rows"></div>
        <button class="add-row" id="add-role">+ Add role</button>
        <div class="muted" id="role-suggest" style="margin-top:8px"></div>
        <div class="actions"><button class="btn-skip" data-skip="roles">Skip</button><button class="btn-primary" data-next>Continue</button></div>
      </div>

      <!-- Step 2: Employees -->
      <div class="step" data-step="2">
        <h1>Add your team</h1>
        <p class="subtitle">Pick each person's role from your list.</p>
        <div class="ai-row" id="staff-ai">
          <textarea class="ai-box" id="staff-desc" placeholder="Or describe your team: 'Sam and Alex are servers, Mia cooks'"></textarea>
          <button class="btn-skip" id="staff-parse" type="button" style="white-space:nowrap">✨ Parse</button>
        </div>
        <div id="staff-rows"></div>
        <button class="add-row" id="add-staff">+ Add team member</button>
        <button class="add-row" id="paste-staff" style="margin-top:6px">📋 Paste a list of names</button>
        <div class="actions"><button class="btn-skip" data-skip="staff">Skip</button><button class="btn-primary" data-next>Continue</button></div>
      </div>

      <!-- Step 3: Shifts -->
      <div class="step" data-step="3">
        <h1>Set up your shifts</h1>
        <p class="subtitle">Pick the days each shift runs — one row covers the whole week.</p>
        <div class="ai-row" id="shift-ai">
          <textarea class="ai-box" id="shift-desc" placeholder="Or describe them: '2 shifts a day 8am-12pm and 12pm-4pm Mon-Fri, 2 servers each'"></textarea>
          <button class="btn-skip" id="shift-parse" type="button" style="white-space:nowrap">✨ Parse</button>
        </div>
        <div id="shift-rows"></div>
        <button class="add-row" id="add-shift">+ Add shift</button>
        <div class="actions"><button class="btn-skip" data-skip="shifts">Skip</button><button class="btn-primary" data-next>Continue</button></div>
      </div>

      <!-- Step 4: Pay rates -->
      <div class="step" data-step="4">
        <h1>Pay rates by role</h1>
        <p class="subtitle">Pre-filled from your roles. Hourly rates power payroll and labor-cost tracking.</p>
        <div id="rate-rows"></div>
        <div class="actions"><button class="btn-skip" data-skip="rates">Skip</button><button class="btn-primary" data-next>Continue</button></div>
      </div>

      <!-- Step 5: Review & connect -->
      <div class="step" data-step="5">
        <h1>Review &amp; connect</h1>
        <p class="subtitle">Here's what we set up. You can change all of this anytime from your dashboard or by chatting with Relay.</p>
        <div id="review"></div>
        <div class="deep-link-box">
          <div style="font-size:14px;color:#4A3F35;margin-bottom:4px">Connect your Telegram team chat to finish:</div>
          <a id="deep-link" href="#" target="_blank" rel="noopener">Open Telegram →</a>
        </div>
        <p class="status-line" id="conn-status">Not connected yet — this updates automatically once you add Relay…</p>
        <div id="invite-block" style="display:none;margin-top:16px">
          <div class="label">Share with your team 🎉</div>
          <div class="row"><input class="form-input" id="invite-link" readonly><button class="btn-skip" id="copy-invite" type="button" style="white-space:nowrap">Copy</button></div>
        </div>
        <div class="actions"><button class="btn-skip" id="finish-later">I'll do this later</button><button class="btn-primary" id="go-dashboard" style="display:none">Go to dashboard →</button></div>
      </div>

      <p class="error-message" id="error"></p>
    </div>
  </main>
  <script type="module" src="./onboarding.js"></script>
</body>
```

- [ ] **Step 2: Commit the markup**

```bash
git add public/onboarding.html
git commit -m "feat: roles-first 6-step onboarding markup + wizard styles"
```

- [ ] **Step 3: Create `public/onboarding.js`** — the full wizard controller:

```js
import { requireSession, authFetch, signOut } from './relayAuth.js'
import { DAYS, expandShiftRows, groupParsedShifts, normalizeTime, splitNames, TEMPLATES } from './onboardingHelpers.js'

const COMMON_ROLES = ['Server', 'Cook', 'Bartender', 'Host', 'Manager']
const errorEl = document.getElementById('error')
const showError = (m) => { errorEl.textContent = m; errorEl.classList.add('visible') }
const clearError = () => errorEl.classList.remove('visible')
let step = 0
let maxStep = 0

document.getElementById('logout-btn').addEventListener('click', () => signOut())

// ── State helpers ──
const roles = () => [...document.querySelectorAll('#role-rows .r-name')].map(i => i.value.trim()).filter(Boolean)
function roleOptions(selected = '') {
  const opts = roles().map(r => `<option ${r === selected ? 'selected' : ''}>${r}</option>`).join('')
  return `${opts}<option value="__new">＋ New role…</option>`
}
function refreshRoleSelects() {
  document.querySelectorAll('select.role-select').forEach(sel => {
    const cur = sel.value
    sel.innerHTML = roleOptions(cur)
  })
}

// ── Step navigation ──
function setStep(n) {
  step = n; maxStep = Math.max(maxStep, n)
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n))
  document.querySelectorAll('#progress div').forEach(d => {
    const p = +d.dataset.p
    d.classList.toggle('done', p <= n)
    d.classList.toggle('clickable', p <= maxStep)
  })
  try { localStorage.setItem('relay_setup_step', String(n)) } catch {}
  if (n === 4) buildRateRows()
  if (n === 5) { buildReview(); startConnect() }
}
document.querySelectorAll('#progress div').forEach(d => {
  d.onclick = () => { const p = +d.dataset.p; if (p <= maxStep) setStep(p) }
})

// ── Row builders ──
function roleRow(name = '') {
  const div = document.createElement('div'); div.className = 'row'
  div.innerHTML = `<input class="form-input r-name" placeholder="Role (e.g. Server)" value="${name}"><button class="row-del">×</button>`
  div.querySelector('.row-del').onclick = () => div.remove()
  div.querySelector('.r-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRole() } })
  return div
}
function addRole(name = '') {
  const div = roleRow(name); document.getElementById('role-rows').appendChild(div)
  if (!name) div.querySelector('.r-name').focus()
  return div
}

function staffRow(name = '', role = '') {
  const div = document.createElement('div'); div.className = 'row'
  div.innerHTML = `<input class="form-input s-name" placeholder="Name" value="${name}">
    <select class="form-select role-select s-role">${roleOptions(role)}</select>
    <button class="row-del">×</button>`
  const sel = div.querySelector('.s-role')
  sel.addEventListener('change', () => { if (sel.value === '__new') promptNewRole(sel) })
  div.querySelector('.row-del').onclick = () => div.remove()
  div.querySelector('.s-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addStaff() } })
  return div
}
function addStaff(name = '', role = '') {
  const div = staffRow(name, role); document.getElementById('staff-rows').appendChild(div)
  if (!name) div.querySelector('.s-name').focus()
  return div
}

function promptNewRole(sel) {
  const name = window.prompt('New role name:')
  if (name && name.trim()) {
    if (!roles().includes(name.trim())) addRole(name.trim())
    refreshRoleSelects(); sel.value = name.trim()
  } else { sel.selectedIndex = 0 }
}

function shiftCard(data = {}) {
  const div = document.createElement('div'); div.className = 'shift-card'
  const days = new Set(data.days || [])
  div.innerHTML = `
    <div class="shift-top">
      <input class="form-input sh-name" placeholder="Name (e.g. Lunch)" value="${data.name || ''}" style="flex:1;min-width:120px">
      <input class="form-input sh-start" placeholder="11am" value="${data.start || ''}" style="max-width:90px">
      <input class="form-input sh-end" placeholder="3pm" value="${data.end || ''}" style="max-width:90px">
      <button class="row-del sh-dup" title="Duplicate">⎘</button>
      <button class="row-del sh-del" title="Remove">×</button>
    </div>
    <div class="presets">
      <button class="chip" data-preset="weekdays" type="button">Weekdays</button>
      <button class="chip" data-preset="all" type="button">Every day</button>
      <button class="chip" data-preset="weekend" type="button">Weekend</button>
    </div>
    <div class="day-chips">${DAYS.map(d => `<div class="day-chip ${days.has(d) ? 'on' : ''}" data-day="${d}">${d.slice(0, 2)}</div>`).join('')}</div>
    <button class="btn-skip sh-staffing-toggle" type="button" style="margin-top:8px">+ staffing</button>
    <div class="staffing" style="display:${(data.requirements && data.requirements.length) ? 'block' : 'none'}"></div>`

  const dayChips = div.querySelector('.day-chips')
  dayChips.querySelectorAll('.day-chip').forEach(c => c.onclick = () => c.classList.toggle('on'))
  div.querySelectorAll('.presets .chip').forEach(btn => btn.onclick = () => {
    const map = { weekdays: DAYS.slice(0, 5), all: DAYS, weekend: ['Saturday', 'Sunday'] }
    const want = new Set(map[btn.dataset.preset])
    dayChips.querySelectorAll('.day-chip').forEach(c => c.classList.toggle('on', want.has(c.dataset.day)))
  })
  div.querySelector('.sh-del').onclick = () => div.remove()
  div.querySelector('.sh-dup').onclick = () => div.after(shiftCard(readShiftCard(div)))
  const staffingEl = div.querySelector('.staffing')
  div.querySelector('.sh-staffing-toggle').onclick = () => {
    staffingEl.style.display = staffingEl.style.display === 'none' ? 'block' : 'none'
    if (staffingEl.style.display === 'block' && !staffingEl.children.length) addStaffingRow(staffingEl)
  }
  for (const r of (data.requirements || [])) addStaffingRow(staffingEl, r.role, r.count)
  return div
}
function addStaffingRow(container, role = '', count = 1) {
  const row = document.createElement('div'); row.className = 'row'
  row.innerHTML = `<select class="form-select role-select st-role">${roleOptions(role)}</select>
    <input class="form-input st-count" type="number" min="1" value="${count}" style="max-width:80px">
    <button class="row-del">×</button>`
  row.querySelector('.row-del').onclick = () => row.remove()
  const sel = row.querySelector('.st-role')
  sel.addEventListener('change', () => { if (sel.value === '__new') promptNewRole(sel) })
  container.appendChild(row)
  const addBtn = document.createElement('button')
  // keep a single "+ role" affordance at the end
  container.parentElement // no-op to keep structure simple
}
function readShiftCard(div) {
  return {
    name: div.querySelector('.sh-name').value.trim(),
    start: div.querySelector('.sh-start').value.trim(),
    end: div.querySelector('.sh-end').value.trim(),
    days: [...div.querySelectorAll('.day-chip.on')].map(c => c.dataset.day),
    requirements: [...div.querySelectorAll('.staffing .row')].map(r => ({
      role: r.querySelector('.st-role').value,
      count: Number(r.querySelector('.st-count').value) || 1,
    })).filter(r => r.role && r.role !== '__new'),
  }
}
function addShift(data) { document.getElementById('shift-rows').appendChild(shiftCard(data)) }

function buildRateRows() {
  const container = document.getElementById('rate-rows'); container.innerHTML = ''
  const existingRates = window._rates || {}
  for (const role of roles()) {
    const div = document.createElement('div'); div.className = 'row'
    div.innerHTML = `<input class="form-input r-role" value="${role}" readonly style="flex:1">
      <input class="form-input r-rate" type="number" step="0.25" placeholder="$/hr" value="${existingRates[role] ?? ''}" style="max-width:140px">`
    container.appendChild(div)
  }
  if (!roles().length) container.innerHTML = '<p class="muted">No roles yet — add some in the Roles step.</p>'
}

function buildReview() {
  const el = document.getElementById('review')
  const staff = [...document.querySelectorAll('#staff-rows .row')].map(r => `${r.querySelector('.s-name').value} (${r.querySelector('.s-role').value})`).filter(s => s.trim()[0])
  const shifts = [...document.querySelectorAll('#shift-rows .shift-card')].map(c => { const d = readShiftCard(c); return `${d.name}: ${d.days.map(x => x.slice(0, 2)).join(' ')} ${d.start}–${d.end}` }).filter(s => s.trim()[0])
  const section = (title, items, goto) => `<div class="review-section"><h3>${title} <button class="review-edit" data-goto="${goto}">edit</button></h3><div class="muted">${items.length ? items.join('<br>') : '—'}</div></div>`
  el.innerHTML =
    section('Roles', roles(), 1) +
    section('Team', staff, 2) +
    section('Shifts', shifts, 3)
  el.querySelectorAll('.review-edit').forEach(b => b.onclick = () => setStep(+b.dataset.goto))
}

// ── Persist a step (write live rows) ──
async function saveRoles() {
  for (const role of roles()) { try { await authFetch('/api/account/setup/role', { method: 'POST', body: { role } }) } catch {} }
}
async function saveStaff() {
  for (const r of document.querySelectorAll('#staff-rows .row')) {
    const name = r.querySelector('.s-name').value.trim()
    const roleSel = r.querySelector('.s-role').value
    const role = roleSel === '__new' ? 'Staff' : roleSel
    if (name && !r.dataset.saved) {
      try { const res = await authFetch('/api/account/setup/staff', { method: 'POST', body: { name, role } }); r.dataset.saved = res?.id || '1' } catch {}
    }
  }
}
async function saveShifts() {
  const rows = [...document.querySelectorAll('#shift-rows .shift-card')].map(readShiftCard)
  for (const s of expandShiftRows(rows)) {
    try { await authFetch('/api/account/setup/shift', { method: 'POST', body: { name: s.name, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, requirements: s.requirements } }) } catch {}
  }
}
async function saveRates() {
  for (const r of document.querySelectorAll('#rate-rows .row')) {
    const role = r.querySelector('.r-role')?.value
    const rate = r.querySelector('.r-rate')?.value
    if (role && rate !== '') { try { await authFetch('/api/account/setup/rate', { method: 'PATCH', body: { role, hourly_rate: Number(rate) } }) } catch {} }
  }
}
async function saveBusinessName() {
  const v = document.getElementById('business-name').value.trim()
  if (v) { try { await authFetch('/api/account/setup/business-name', { method: 'POST', body: { name: v } }) } catch {} }
}

// ── Next / skip ──
async function handleNext() {
  clearError()
  try {
    if (step === 0) await saveBusinessName()
    else if (step === 1) await saveRoles()
    else if (step === 2) { await saveRoles(); await saveStaff() }
    else if (step === 3) await saveShifts()
    else if (step === 4) await saveRates()
    setStep(step + 1)
  } catch (err) { showError(err.message || 'Could not save — try again.') }
}
document.querySelectorAll('[data-next]').forEach(b => b.onclick = handleNext)
document.querySelectorAll('[data-skip]').forEach(b => b.onclick = () => setStep(step + 1))

// ── Add-row buttons ──
document.getElementById('add-role').onclick = () => addRole()
document.getElementById('add-staff').onclick = () => addStaff()
document.getElementById('add-shift').onclick = () => addShift()
document.getElementById('paste-staff').onclick = () => {
  const text = window.prompt('Paste names (one per line or comma-separated):')
  for (const n of splitNames(text)) addStaff(n)
}

// ── Templates ──
function renderTemplateChips() {
  const c = document.getElementById('template-chips')
  c.innerHTML = Object.keys(TEMPLATES).map(t => `<button class="chip" type="button" data-tpl="${t}">${t}</button>`).join('')
  c.querySelectorAll('.chip').forEach(btn => btn.onclick = () => applyTemplate(btn.dataset.tpl, btn))
}
function applyTemplate(name, btn) {
  const tpl = TEMPLATES[name]; if (!tpl) return
  document.querySelectorAll('#template-chips .chip').forEach(c => c.classList.remove('on'))
  btn.classList.add('on')
  for (const role of tpl.roles) if (!roles().includes(role)) addRole(role)
  refreshRoleSelects()
  const shiftRows = document.getElementById('shift-rows')
  if (!shiftRows.children.length) for (const s of tpl.shifts) addShift(s)
}

// ── Role suggestions ──
document.getElementById('role-suggest').innerHTML =
  'Common: ' + COMMON_ROLES.map(r => `<button class="chip" type="button" data-role="${r}">${r}</button>`).join('')
document.querySelectorAll('#role-suggest .chip').forEach(b => b.onclick = () => { if (!roles().includes(b.dataset.role)) addRole(b.dataset.role) })

// ── AI parse boxes ──
document.getElementById('staff-parse').onclick = async () => {
  clearError()
  const text = document.getElementById('staff-desc').value.trim(); if (!text) return
  try {
    const { staff } = await authFetch('/api/account/setup/parse-staff', { method: 'POST', body: { text } })
    for (const s of (staff || [])) { if (s.role && !roles().includes(s.role)) addRole(s.role) }
    refreshRoleSelects()
    for (const s of (staff || [])) addStaff(s.name, s.role || 'Staff')
    document.getElementById('staff-desc').value = ''
  } catch (err) {
    if (err.status === 503) document.getElementById('staff-ai').style.display = 'none'
    else showError("Couldn't read that — add rows manually.")
  }
}
document.getElementById('shift-parse').onclick = async () => {
  clearError()
  const text = document.getElementById('shift-desc').value.trim(); if (!text) return
  try {
    const { shifts } = await authFetch('/api/account/setup/parse-shifts', { method: 'POST', body: { text } })
    for (const row of groupParsedShifts(shifts || [])) {
      for (const r of row.requirements) if (r.role && !roles().includes(r.role)) addRole(r.role)
      addShift(row)
    }
    refreshRoleSelects()
    document.getElementById('shift-desc').value = ''
  } catch (err) {
    if (err.status === 503) document.getElementById('shift-ai').style.display = 'none'
    else showError("Couldn't read that — add rows manually.")
  }
}

// Normalize time fields on blur (delegated).
document.getElementById('shift-rows').addEventListener('blur', e => {
  if (e.target.classList?.contains('sh-start') || e.target.classList?.contains('sh-end')) {
    e.target.value = normalizeTime(e.target.value)
  }
}, true)

// ── Connect step ──
let pollTimer = null
async function startConnect() {
  try {
    const { deepLink } = await authFetch('/api/account/link-code', { method: 'POST' })
    document.getElementById('deep-link').href = deepLink
  } catch (err) { showError(err.message || 'Could not generate a linking code.') }
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(checkConnection, 4000); checkConnection()
}
async function checkConnection() {
  try {
    const s = await authFetch('/api/account/connection-status')
    if (s.connected) {
      const el = document.getElementById('conn-status')
      el.textContent = '✓ Connected to ' + (s.restaurantName || 'your group') + '!'
      el.classList.add('connected')
      document.getElementById('go-dashboard').style.display = ''
      if (s.inviteLink) { document.getElementById('invite-link').value = s.inviteLink; document.getElementById('invite-block').style.display = '' }
      if (pollTimer) clearInterval(pollTimer)
    }
  } catch {}
}
document.getElementById('copy-invite').onclick = () => {
  const el = document.getElementById('invite-link'); el.select()
  navigator.clipboard?.writeText(el.value).catch(() => {})
  const b = document.getElementById('copy-invite'); b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 1500)
}
document.getElementById('go-dashboard').onclick = () => location.href = '/dashboard'
document.getElementById('finish-later').onclick = () => location.href = '/dashboard'

// ── Init: resume from live data ──
;(async () => {
  await requireSession()
  await authFetch('/api/account/bootstrap', { method: 'POST' }).catch(() => {})
  renderTemplateChips()
  try {
    const s = await authFetch('/api/account/connection-status')
    if (s.connected && s.setupComplete) { location.href = '/dashboard'; return }
  } catch {}
  try {
    const d = await authFetch('/api/account/setup')
    if (d.businessName) document.getElementById('business-name').value = d.businessName
    window._rates = {}
    for (const r of (d.roles || [])) { addRole(r.name); window._rates[r.name] = r.rate }
    for (const st of (d.staff || [])) { const row = addStaff(st.name, st.role); row.dataset.saved = st.id }
    const grouped = groupParsedShifts((d.shifts || []).map(s => ({ name: s.name, day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, requirements: s.requirements })))
    for (const g of grouped) addShift(g)
  } catch {}
  if (!document.querySelector('#role-rows .row')) addRole()
  if (!document.querySelector('#staff-rows .row')) addStaff()
  if (!document.querySelector('#shift-rows .shift-card')) addShift({ days: [] })
})()
```

> Implementation note for the `addStaffingRow` "+ role" affordance: the stub above keeps staffing rows minimal (one role+count per row, add more via the toggle re-click). If you want an explicit "+ add role to this shift" button, add a small button after the first staffing row that calls `addStaffingRow(container)` — but keep it out of `readShiftCard`'s selector scope.

- [ ] **Step 4: Commit**

```bash
git add public/onboarding.js
git commit -m "feat: wizard controller — live writes, AI parse, bulk day tooling, resume"
```

---

### Task 12: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start the server**

Run: `npm start`
Expected: server boots; visit `http://localhost:<PORT>/onboarding` (check `.env`/logs for port). Sign in first if redirected to `/login`.

- [ ] **Step 2: Roles → Employees flow**

- On Step 1, click common-role chips (Server, Cook) and type one custom role. Continue.
- On Step 2, confirm the role dropdown lists exactly your created roles + "＋ New role…". Add a person; pick a role. Click "Paste a list of names", paste `Sam, Alex`, confirm two rows appear.
- If LLM keys are set, type "Mia is a dishwasher" in the describe box, click Parse → a row appears AND "Dishwasher" is added to the roles list (verify the dropdown now includes it).

- [ ] **Step 3: Shifts bulk tooling**

- On Step 3, add a shift "Lunch", click **Weekdays** preset → Mon–Fri light up. Type `11` in start, tab out → shows `11:00 AM`.
- Click the duplicate (⎘) button → an identical card appears. Click "+ staffing", add Server ×2.
- Continue. In Supabase (or via `GET /api/account/setup`), confirm 5 `shifts` rows for Lunch (one per weekday) each with a Server×2 requirement.

- [ ] **Step 4: Pay rates prefill + review**

- Step 4 shows one row per role (read-only role + rate input), pre-filled with any saved rates. Set a couple, Continue.
- Step 5 shows the review recap; click an "edit" link → jumps to that step. Click a completed progress segment → navigates.

- [ ] **Step 5: Sync verification (the core guarantee)**

- Before connecting Telegram, open the dashboard (`/dashboard`) in another tab → **the staff/shifts/roles you entered are already there** (same store, provisional group).
- Connect a Telegram group (add the bot). Confirm the dashboard still shows the same data (rekeyed) and the bot greets with the pulled-in shifts/staff.
- Re-add the bot / refresh → no duplicate staff or shifts (rekey idempotent).

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "fix: setup wizard manual-verification adjustments"
```

---

## Self-Review

- **Spec coverage:** §3.1 provisioning → Task 2. §3.2 connected signal → Task 5. §3.3 rekey → Tasks 3-4. §3.4 gate relaxation → Task 5. §4 setup API → Tasks 6-8. §4.1 parse endpoints → Task 9. §5 shift mechanics + §6 helpers → Tasks 10-11. §7 ease-of-use (templates/paste/time/resume/review/enter) → Tasks 10-11. §8 frontend split → Tasks 10-11. §9 role_rates-as-canonical → Tasks 6-7. §10 sync guarantee → Task 12 Step 5. §12 cutover → Tasks 2-4 + migration. §13 testing → every task. ✓
- **Type/name consistency:** `ensureAccountGroup`, `isProvisionalGroup`, `rekeyGroup`, `deleteRole`, `deleteStaffById`, `deleteShiftById`, `updateStaffById`, `expandShiftRows`, `groupParsedShifts`, `normalizeTime`, `splitNames`, `TEMPLATES` are defined once and referenced consistently. Endpoints use `/api/account/setup/*` throughout. ✓
- **Known soft spots flagged inline:** the `getAccountByTelegramUser` seed table name in Task 4 must be matched to the real query; the `addStaffingRow` "+ role" affordance is intentionally minimal.
