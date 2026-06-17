# Setup Wizard Redesign — Design Spec

**Date:** 2026-06-17
**Topic:** Roles-first website setup wizard with AI shift parsing, bulk tooling, and verified account→dashboard→chat sync.
**File touched (primary):** `public/onboarding.html` (+ new `public/onboarding.js`), `src/server/accountRoutes.js`, `src/setup/mergeFromAccount.js`, `src/setup/connectAccount.js`.

---

## 1. Goal

Rebuild the website setup wizard (`public/onboarding.html`) into a faster, more polished, roles-first flow:

1. Create **roles** first; everything downstream pulls from that list.
2. Add **employees**, picking their role from the created list.
3. Define **shifts** in a forgiving manual grid, accelerated by an AI "describe your shifts" box (existing Cerebras/Groq parsing) and bulk day tooling.
4. Set **pay rates**, pre-filled one row per role.
5. **Connect Telegram.**

Plus ease-of-use accelerators (templates, bulk paste, smart time parsing, state persistence, a review step) and a verified guarantee that everything the owner enters reaches **both** the dashboard and the Telegram chat through the account.

---

## 2. Current state (as built)

- Wizard = single file `public/onboarding.html` with an inline ES-module script. Steps: Business name → Staff (free-text role) → Shifts (name/day/start/end) → Pay rates → Connect Telegram.
- Each step `PATCH`es `accounts.setup_data` (staging). Only the `staff` list is reloaded on return; shifts/rates/business-name reload partially or not at all.
- The parsers in `src/parsers/setupParsers.js` (`parseShift`, `parseStaff`, `parseShiftRequirements`) — Cerebras-first, Groq-fallback — are **only** wired into the Telegram bot setup flow. No HTTP endpoint exposes them, and the browser must not hold LLM keys.

### Sync chain (verified)

```
Wizard ──PATCH /api/account──▶ accounts.setup_data            (staging only)
                                     │
              Telegram group connects (connectGroupToAccount)
                                     │ mergeFromAccount()  ← one-time seed, guarded by setup_complete
                                     ▼
   group-keyed operational tables: shifts · shift_requirements · staff · role_rates · overtime_settings · tip_settings
                       ▲                                          ▲
   Dashboard (/api/dash/*) via req.manager.groupId   Chat / bot writers via same group_id
                       └──── getLinkedGroup(account.id) resolves the group ────┘
```

**Conclusion:** Dashboard and chat read/write the *same* operational tables keyed by `group_id`, resolved from the account via `setup_sessions.account_id` → `getLinkedGroup`. There is no second copy, so once connected they cannot drift. `setup_data` is a one-time seed, not a live mirror.

### Two issues the redesign must fix

**Issue A — Orphan-role gap (introduced by roles-first).**
`GET /api/roles` (dashboard) and `mergeFromAccount` derive the role list only from `staff[].role` + `role_rates[]` + `shift_requirements`. A wizard role created but never assigned to an employee, given a rate, or used in a shift requirement would **disappear at connect** — invisible to dashboard and chat.

**Fix:** in `mergeFromAccount`, after seeding staff/rates, materialize every `setup_data.roles[]` entry as a `role_rates` row if not already present. `updateRoleRate` upserts on `UNIQUE(group_id, role_name)` (default `hourly_rate = 0`), so this is idempotent and safe (~6 lines).

**Issue B — Merge is not idempotent.**
`saveShift` / `saveStaff` are plain `insert`s. On the partial-connect path (`status: needs_more`, `setup_complete` stays false), a re-add could re-run `mergeFromAccount` and **double-seed** staff/shifts.

**Fix:** after a successful merge, set `setup_data.account_merged = true` on the setup session; `connectGroupToAccount` skips `mergeFromAccount` when that flag is set. (Idempotency guard, not a data-model change.)

---

## 3. New step flow (6 steps)

| # | Step | Summary |
|---|------|---------|
| 0 | Business name | Unchanged. Quick-start template chips appear here (see §6.1). |
| 1 | **Roles** | NEW first data step. Add role names (one per row). Seeded with one empty row + clickable common-role chips. Single source of truth for all downstream dropdowns/pre-fills. |
| 2 | **Employees** | Name + **role dropdown populated from Step 1** (each dropdown ends with "＋ New role…" inline-add). Optional **"Describe your team" box** → `parse-staff`; unknown roles auto-added to the roles list. Bulk-paste names supported. |
| 3 | **Shifts** | Manual-first grid (multi-day chips + presets + `+ staffing`) accelerated by a **"Describe your shifts" box** → `parse-shifts`. |
| 4 | **Pay rates** | **Pre-filled one row per role** from Step 1 (role label + $/hr). Add-row still allowed for ad-hoc roles. |
| 5 | **Review & Connect** | Recap of everything (roles/employees/shifts/rates) with inline Edit links, then the existing Telegram connect block. |

Progress bar grows from 5 → 6 segments; completed segments are clickable to jump back. Every data step keeps a "Skip for now" affordance.

---

## 4. Architecture & files

### 4.1 Backend — two new authed parse endpoints (`src/server/accountRoutes.js`)

Reuse existing parsers via `src/parseMessage.js`. Browser posts text; server parses with its own keys.

- `POST /api/account/parse-shifts` `{ text }`
  → `parseShift(text)`, then `parseShiftRequirements(text, shiftNames)` on the same text; merge counts onto matching shifts.
  → `{ shifts: [{ name, day_of_week, start_time, end_time, requirements: [{ role, count }] }] }`
- `POST /api/account/parse-staff` `{ text }`
  → `parseStaff(text)` → `{ staff: [{ name, role }] }`

Both: `requireAuth` + `requireAccount`; input capped at **2000 chars** (400 on overflow); **503** with `{ error, reason: 'no_llm' }` when `hasAnyLLM()` is false. On parser failure the parsers already return `[]`, so endpoints return an empty list rather than erroring.

### 4.2 Backend — sync fixes

- `src/setup/mergeFromAccount.js`: materialize `setup_data.roles[]` into `role_rates` (Issue A); honor `account_merged` flag (Issue B).
- `src/setup/connectAccount.js`: set `setup_data.account_merged = true` after a successful merge; skip merge when already set.

### 4.3 Frontend — split markup from logic

- `public/onboarding.html`: lean markup/structure only (mirrors how `relayAuth.js` is already a separate module).
- **NEW `public/onboarding.js`**: ES module with all wizard logic. Exposes pure, testable named exports:
  - `expandShiftRows(rows)` — multi-day grid rows → flat `shifts[]` (one per selected day, requirements carried).
  - `groupParsedShifts(parsed)` — day-expanded parser output → grouped multi-day rows (collapse identical name+time, merge requirements).
  - `normalizeTime(input)` — `"11" | "11a" | "1330" | "1:30pm"` → `"11:00 AM"` / `"1:30 PM"`; returns input unchanged if unparseable.
  - `splitNames(text)` — bulk-paste names string → `string[]`.

---

## 5. Shifts grid — ease-of-use mechanics

Each shift row = **name · multi-day chip picker · start · end · `+ staffing`**:

- **Multi-day chips** (Mon–Sun) with presets **Weekdays / Every day / Weekend**. On save, each row expands via `expandShiftRows` to one shift per selected day → the `shifts[]` array `mergeFromAccount` already expects ("add across 5/7 days" in one control).
- **Duplicate row** button = "copy this shift across the week."
- **`+ staffing` expander** (collapsed by default): rows of *role dropdown (from roles list) + count*, stored as `requirements: [{ role, count }]` on each expanded day's shift.
- **Describe box:** parsed shifts come back day-expanded; `groupParsedShifts` collapses identical name+time across days into one multi-day row (with merged requirements) and appends it to the same editable grid.
- **Time fields** run through `normalizeTime` on blur.

---

## 6. Ease-of-use features

1. **Business-type quick-start templates** (Step 0). Chips: Restaurant / Café / Bar / Retail / Coffee shop. Tapping one pre-fills the roles list and a starter shift set (e.g., Breakfast/Lunch/Dinner with typical times) into the relevant steps. Pure client-side data tables; no LLM. Non-destructive: merges with anything already entered; user edits freely.
2. **Bulk-paste employees** (Step 2). A "paste a list of names" affordance splits on newline/comma via `splitNames` → one row each (role defaults to first role or "Staff", editable). No LLM.
3. **Smart client-side time normalization** (Step 3, §5). `normalizeTime` on blur for manual entries.
4. **Full state persistence + clickable progress.** Every step auto-saves its slice to `setup_data` (debounced on Continue, same as today) and **reloads on return** — roles, employees, shifts, rates, business name. Completed progress segments are clickable to navigate back. (Today only `staff` reloads.)
5. **Review & confirm step** (Step 5, before connect). Read-only recap grouped by section with inline "Edit" links that jump to the relevant step. Footer note: *"You can change all of this anytime from your dashboard or by chatting with Relay."* Sets the seed-vs-live expectation.
6. **Enter-to-add-row** in every list (roles, employees, shifts, rates); the new row receives focus.

---

## 7. Data & persistence

`accounts.setup_data` keys (existing + new):

```jsonc
{
  "restaurant_name": "…",
  "roles":      ["Server", "Cook", "Bartender"],          // NEW — canonical role list
  "staff":      [{ "name": "…", "role": "Server" }],
  "shifts":     [{ "name": "…", "day_of_week": "Monday",
                  "start_time": "11:00 AM", "end_time": "3:00 PM",
                  "requirements": [{ "role": "Server", "count": 2 }] }],
  "role_rates": [{ "role_name": "Server", "hourly_rate": 16.5 }],
  "overtime":   { /* unchanged */ },
  "tips":       { /* unchanged */ },
  "skipped":    ["…"]
}
```

- The wizard writes the new `roles` key; `mergeFromAccount` reads it to materialize role rows (Issue A fix). All other keys keep their current contract — `staff`, `shifts`, `role_rates` flow into the operational tables exactly as today.
- No bot-side data-model migration; no new tables. `role_rates` remains the canonical "role exists" store that `GET /api/roles`, payroll, and staff role pickers already read.

---

## 8. Error handling

- **Parse box failures:** parsers return `[]` → UI shows "Couldn't read that — add rows manually" and leaves the grid untouched.
- **No LLM configured:** parse endpoints return 503; the describe boxes hide/disable on load (probe via the 503 reason). Manual grids fully functional.
- **Save/network errors:** reuse the existing `#error` banner and per-step try/catch (matches current `handleNext`).
- **Sync safety:** merge idempotency guard (Issue B) prevents duplicate seeding; orphan-role materialization (Issue A) prevents silent role loss.

---

## 9. Testing

- **Integration** (modeled on `src/tests/integration/accountAuthGuard.test.js` / `dashApiRoutes.test.js`): the two parse endpoints — happy path (mocked parser output), 503 when no LLM, 400 on >2000-char input, auth/account guard.
- **Integration** (extend `src/tests/integration/accountLinking.test.js`): `mergeFromAccount` materializes orphan roles into `role_rates`; re-running merge with `account_merged` set is a no-op (no duplicate staff/shifts).
- **Unit** (`node --test`, no DOM): `expandShiftRows`, `groupParsedShifts`, `normalizeTime`, `splitNames` as pure functions exported from `public/onboarding.js`.

---

## 10. Out of scope

- No dedicated `roles` DB table (role_rates remains canonical).
- No live re-sync of `setup_data` after a group is connected (dashboard/chat become the edit surface by design; the Review step communicates this).
- No redesign of the dashboard or Telegram setup flows beyond the two sync fixes.
- No change to overtime/tips steps (not currently in the web wizard).
