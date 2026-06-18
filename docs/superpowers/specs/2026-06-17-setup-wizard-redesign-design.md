# Setup Wizard Redesign — Design Spec (Unified-Store Model)

**Date:** 2026-06-17
**Topic:** Roles-first website setup wizard with AI shift parsing and bulk tooling, on a **single source of truth** that the wizard, dashboard, and Telegram chat all share — replacing the staging + merge layer with a provision-at-signup / rekey-at-connect model.

**Status:** Pre-launch, **clean cutover approved** (no live data to preserve). Permanent fix, not a bandaid.

---

## 1. Goal

Two outcomes:

1. **Fastest, easiest setup UX** — a roles-first wizard: create roles → add employees (role picked from that list) → define shifts (forgiving grid + AI "describe your shifts" + bulk day tooling) → set pay rates (pre-filled per role) → review → connect Telegram. Plus accelerators: business-type templates, bulk-paste employees, smart time parsing, instant resume, a review step.
2. **The simplest possible sync** — delete the dual-store architecture. One store (the operational tables), owned by the account from the moment it's created, so the wizard writes *live* data the dashboard and chat read directly.

---

## 2. The core problem (and why the old plan was a bandaid)

Today, truth lives in **two** places depending on lifecycle stage:

- **Before** a Telegram group connects → `accounts.setup_data` (JSON staging), because the dashboard's write-gate (`dashRoutes.js:28`) blocks all mutations while `groupId` is null.
- **After** connect → group-keyed operational tables, seeded once by `mergeFromAccount` translating the JSON field-by-field.

That staging+translate layer is the *direct* source of every sync defect: orphan roles (roles only materialize if referenced by staff/rates/requirements), non-idempotent merge (`saveShift`/`saveStaff` are plain inserts), and "wizard edits ignored after connect." Patching each is a bandaid. **Removing the layer removes the whole class of bugs.**

### Why removal is safe (verified)

- **No foreign keys on `group_id`** anywhere → the group key can be changed with plain `UPDATE`s.
- **Every operational table is `group_id TEXT`** → a synthetic string key is type-safe everywhere.
- **"A group" is just a `setup_sessions` row** (PK `group_id`, carries `account_id`) → provisioning one is a single insert.
- **`accounts.id` is a stable UUID** → a deterministic provisional key `web:<uuid>` that can never collide with a numeric Telegram chat id.

---

## 3. Unified architecture

**Principle: one source of truth — the operational tables, keyed by `group_id TEXT`. Every account owns a stable `group_id` from creation. At Telegram connect, that key is rekeyed to the real chat id.**

### 3.1 Provision a group at account creation

In `ensureAccount(authId, email)` (`src/server/db/accounts.js`), after ensuring the account row, ensure its session:

```sql
INSERT INTO setup_sessions (group_id, account_id, setup_complete)
VALUES ('web:' || <accountId>, <accountId>, false)
ON CONFLICT (group_id) DO NOTHING;   -- deterministic id ⇒ perfectly idempotent
```

Now `getLinkedGroup(accountId)` returns a real group from the first authed request, so `req.manager.groupId` is **never null**. (`ensureAccount` already runs in middleware before `getLinkedGroup`, so no ordering change is needed.)

### 3.2 "Connected" signal

`group_id` is always present, so connection is no longer "groupId exists." Add one helper:

```js
export const isProvisionalGroup = (id) => typeof id === 'string' && id.startsWith('web:')
```

- `GET /api/account/connection-status` → `connected = !!group && !isProvisionalGroup(group.group_id)`.
- Onboarding's "skip to dashboard if already connected" uses this.

### 3.3 Connect = rekey (future-proof, atomic)

Replace `mergeFromAccount` in `connectGroupToAccount` with a **rekey**. Add a Postgres function (migration + `supabase-schema.sql`) that rekeys **every** table carrying a `group_id`, discovered dynamically — so any table added in the future is covered automatically:

```sql
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

Server calls `supabase.rpc('rekey_group', { old_group: 'web:'+account.id, new_group: telegramId })` — one atomic server-side transaction. **Idempotent by construction:** after the first run no rows match the provisional id, so re-running is a no-op. **Orphan roles impossible:** roles are real `role_rates` rows from the start, so the rekey carries them like everything else.

`connectGroupToAccount` becomes:
1. `account = getAccountByTelegramUser(managerUserId)` (unchanged guard: no account → `no_account`).
2. If a session already exists for `telegramId` and is `setup_complete` → existing already-connected path (unchanged).
3. `rpc('rekey_group', 'web:'+account.id → telegramId)`; then update the (now-telegram-keyed) session: `group_name`, `manager_id`, `dm_chat_id`.
4. Compute completion from **live tables** (`getStaffForGroup`, `getShiftsForGroup`) → `complete` vs `needs_more`; set `setup_complete` / `step`. Telegram-side "continue setup" DM flow unchanged.
5. Invite-link logic unchanged.

`src/setup/mergeFromAccount.js` is **deleted**; its test is replaced by a rekey test.

### 3.4 Dashboard write-gate relaxation

Since `groupId` is always set, the `dashRoutes.js` "must be connected" mutation gate (line 28) can no longer fire on null. Replace its intent: mutations are always allowed (they write the account's real group, never orphans); only **bot-notifying side-effects** are skipped pre-connect — which they already are, because `safeSend` no-ops without a bot/DM. Net: the dashboard becomes usable pre-connect too (consistent with the wizard), and no row is ever orphaned.

---

## 4. Wizard setup API (reuses canonical writers)

The wizard does **not** use the 2FA/connected-gated `dashRoutes`. It gets a small, ungated (account-session) setup API in `src/server/accountRoutes.js` that calls the **existing bot-side writers** in `src/setup/db/*` — the same functions that populated operational tables before. Same writers ⇒ identical row shape ⇒ dashboard and chat see exactly what the wizard wrote. Sync is structural, not enforced.

| Endpoint | Action |
|---|---|
| `GET  /api/account/setup` | Read back `{ roles, staff, shifts (with requirements), rates, businessName, connected }` for instant resume. Uses `getStaffForGroup`, `getShiftsForGroup`, role/rate getters. |
| `POST /api/account/setup/role` `{ role }` | Create a role = `updateRoleRate(groupId, role, 0)` (idempotent upsert; rate 0 = unpriced until the Pay step). |
| `DELETE /api/account/setup/role/:role` | Remove a role's `role_rates` row. |
| `POST /api/account/setup/staff` `{ name, role }` | `saveStaff(groupId, name, role)`. |
| `PATCH/DELETE /api/account/setup/staff/:id` | Edit/remove a staff row. |
| `POST /api/account/setup/shift` `{ name, day_of_week, start_time, end_time, requirements:[{role,count}] }` | `saveShift(...)` then `saveShiftRequirement(shiftId, role, count)` per requirement. Server normalizes times via the existing `normalizeShiftTime`. |
| `DELETE /api/account/setup/shift/:id` | Remove a shift (+ its requirements). |
| `PATCH /api/account/setup/rate` `{ role, hourly_rate }` | `updateRoleRate(groupId, role, rate)`. |
| `POST /api/account/setup/business-name` `{ name }` | Set `accounts.business_name` and the provisional session's `group_name`. |

All `requireAuth + requireAccount`; `req.manager.groupId` is the provisioned id. `requireAccount` (already in `accountRoutes`) is **not** behind the dashboard's 2FA gate, so a fresh signup can complete setup before any 2FA step.

### 4.1 AI parse endpoints (browser can't hold LLM keys)

Also in `accountRoutes.js`, reusing `src/parseMessage.js`:

- `POST /api/account/parse-shifts` `{ text }` → `parseShift(text)`, then `parseShiftRequirements(text, shiftNames)` on the same text; merge counts → `{ shifts:[{name,day_of_week,start_time,end_time,requirements:[{role,count}]}] }`.
- `POST /api/account/parse-staff` `{ text }` → `parseStaff(text)` → `{ staff:[{name,role}] }`.

Both: 2000-char cap (400 on overflow); **503** `{reason:'no_llm'}` when `hasAnyLLM()` is false. Parsers already return `[]` on failure. **Parse endpoints are pure** (no DB) — they return structured data; the frontend then POSTs it to the setup write endpoints above. Clean separation.

---

## 5. New step flow (6 steps)

| # | Step | Summary |
|---|------|---------|
| 0 | Business name | + business-type template chips (§7.1). Writes via `setup/business-name`. |
| 1 | **Roles** | NEW first data step. Add role names (one per row) → `setup/role`. Seeded with one empty row + clickable common-role chips. Source of truth for all downstream dropdowns/pre-fills. |
| 2 | **Employees** | Name + role dropdown from Step 1 (each ends with "＋ New role…" inline-add → `setup/role`). Optional **"Describe your team" box** → `parse-staff`; unknown roles auto-created via `setup/role`. Bulk-paste names. Writes via `setup/staff`. |
| 3 | **Shifts** | Manual-first grid (multi-day chips + presets + `+ staffing`) + **"Describe your shifts" box** → `parse-shifts`. Writes via `setup/shift`. |
| 4 | **Pay rates** | **Pre-filled one row per role** (from `GET /api/account/setup`). Role label + $/hr → `setup/rate`. |
| 5 | **Review & Connect** | Read-only recap (roles/employees/shifts/rates) with inline Edit links + the existing Telegram connect block. |

Progress bar = 6 segments; completed segments clickable. Every data step keeps "Skip for now."

---

## 6. Shifts grid mechanics

Each row = **name · multi-day chip picker · start · end · `+ staffing`**:

- **Multi-day chips** (Mon–Sun) + presets **Weekdays / Every day / Weekend**. On Continue, `expandShiftRows` turns each row into one `setup/shift` POST per selected day (requirements carried) — "add across 5/7 days" in one control.
- **Duplicate row** = "copy this shift across the week."
- **`+ staffing` expander** (collapsed): rows of *role dropdown + count* → `requirements`.
- **Describe box:** parsed shifts come back day-expanded; `groupParsedShifts` collapses identical name+time across days into one multi-day row (merged requirements) and appends it to the same editable grid.
- Times: server `normalizeShiftTime` is the safety net; client `normalizeTime` gives instant feedback on blur.

---

## 7. Ease-of-use features

1. **Business-type quick-start templates** (Step 0): chips Restaurant / Café / Bar / Retail / Coffee shop. Tapping one pre-fills roles + a starter shift set (client-side data tables, no LLM); non-destructive merge with anything already entered.
2. **Bulk-paste employees** (Step 2): paste newline/comma names → one row each via `splitNames`; role defaults to first role / "Staff".
3. **Smart client-side time normalization** (Step 3): `normalizeTime` on blur.
4. **Instant resume + clickable progress**: because data is live, reload just re-reads `GET /api/account/setup`; the current step is remembered in `localStorage`. Completed progress segments jump back. (No `setup_data` entity staging.)
5. **Review & confirm step** (Step 5): recap with inline Edit links + note *"You can change all of this anytime from your dashboard or by chatting with Relay."*
6. **Enter-to-add-row** in every list; new row gets focus.

---

## 8. Frontend structure

- `public/onboarding.html` → lean markup only (mirrors the existing `relayAuth.js` split).
- **NEW `public/onboarding.js`** → ES module with all wizard logic + pure, testable named exports:
  - `expandShiftRows(rows)` — multi-day rows → flat per-day shift payloads.
  - `groupParsedShifts(parsed)` — day-expanded parser output → grouped multi-day rows.
  - `normalizeTime(input)` — `"11" | "11a" | "1330" | "1:30pm"` → `"11:00 AM"` / `"1:30 PM"`; pass-through if unparseable.
  - `splitNames(text)` — bulk-paste string → `string[]`.
  - `TEMPLATES` — business-type → `{ roles[], shifts[] }` data table.

---

## 9. Data model

- **No entity staging in `setup_data`.** Roles/employees/shifts/rates are live operational rows from the first keystroke (under the provisional `group_id`).
- **`role_rates` is the canonical "role exists" store** (already what `GET /api/roles`, payroll, and staff pickers read). Creating a role inserts a `role_rates` row at rate 0; the Pay step sets the real rate. (`hourly_rate` stays `NOT NULL DEFAULT 0`; 0 = unpriced. No schema change.)
- **Wizard UI state** (current step, chosen template) → `localStorage`. No server round-trip needed for navigation.
- `accounts.setup_data` may retain only incidental flags (e.g. nothing required by this feature); the `staff/shifts/role_rates/roles` keys and `mergeFromAccount` are removed.

---

## 10. Sync guarantee

```
Account created ──▶ provisional group  web:<uuid>  (setup_sessions row)
        │
Wizard (accountRoutes/setup/*) ─┐
                                ├─▶  ONE store: operational tables keyed by group_id
Dashboard (/api/dash/*) ────────┤        (shifts · shift_requirements · staff · role_rates · …)
Chat / bot writers ─────────────┘
        │
Telegram connect ──▶ rpc rekey_group(web:<uuid> → telegramId)   [atomic, idempotent, future-proof]
```

The wizard, dashboard, and bot all call writers that target the same `group_id`-keyed tables — and the wizard reuses the **bot's own writers**. There is no second copy and no translator, so drift is impossible by construction. Connect only changes the *key*, via a function that auto-covers every `group_id` table.

---

## 11. Error handling

- Parse box: `[]` → "Couldn't read that — add rows manually"; grid untouched.
- No LLM: parse endpoints 503 → describe boxes hide on load; manual grids fully functional.
- Write/network errors: per-call try/catch → existing `#error` banner; the failing row stays editable.
- Rekey: runs in a single DB transaction (the function); on RPC failure connect reports an error and leaves the provisional group intact (safe to retry — still idempotent).

---

## 12. Cutover / migration

1. Add `rekey_group` function + provisioning to `supabase-schema.sql` and a new `scripts/migrations` file; backfill provisional sessions for any existing accounts without one.
2. Provision in `ensureAccount`.
3. Replace `mergeFromAccount` call in `connectAccount.js` with the rekey; **delete** `src/setup/mergeFromAccount.js`.
4. Add the setup + parse endpoints to `accountRoutes.js`.
5. Relax the dash mutation gate.
6. Rebuild `onboarding.html` + add `onboarding.js`.
7. Remove entity-staging code paths.

---

## 13. Testing

- **Integration** (model on `accountAuthGuard.test.js` / `dashApiRoutesFull.test.js`):
  - `setup/*` write endpoints create real operational rows under the provisional group and read back via `GET /api/account/setup`.
  - parse endpoints: happy path (mocked parser), 503 no-LLM, 400 over-cap, auth guard.
  - **Rekey** (replaces `accountLinking` merge test): rows written under `web:<uuid>` move to the Telegram id after `connectGroupToAccount`; re-running connect is a no-op (no duplicates); a role created with no staff/shift survives the rekey (orphan-proof).
  - Provisioning is idempotent (double `ensureAccount` → one session).
- **Unit** (`node --test`, no DOM): `expandShiftRows`, `groupParsedShifts`, `normalizeTime`, `splitNames` from `public/onboarding.js`.

---

## 14. Out of scope

- No dedicated `roles` table (role_rates remains canonical).
- No redesign of dashboard/Telegram setup flows beyond the rekey swap and the gate relaxation.
- No change to overtime/tips steps (not in the web wizard).
- No live re-sync after connect (unnecessary — there was never a second store; dashboard/chat edit the same rows the wizard did).
