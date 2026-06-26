# Relay Full-Platform Build Plan
*A long-horizon, multi-agent execution plan to make Relay replace 7shifts / Homebase / Toast / Square / Kickfin / TipHaus / Deputy / Gusto — with every feature usable from **both** the web dashboard **and** the Telegram group chat.*

> **This is a program, not a sprint.** ~40 work packages across 8 epics. Designed so each work package (WP) can be handed to a separate agent. Read "Section 0 — How to use this plan" first.

---

## Locked decisions (do not re-litigate)

| Decision | Choice |
|---|---|
| Payments rail | **Stripe** (Connect + Treasury + Issuing + Instant Payouts). |
| Geography | **US only** to start (multi-state aware; no intl). |
| POS | **Both Toast and Square** (Square first — easier API; Toast needs partner approval, start that paperwork day 1). |
| Payroll rail | **Check** is the single rail for **both** W-2 and 1099 (calc + withholding + filing + W-2/1099-NEC + owner→employee deposit). **Default tax type = W-2**; owner can switch any employee to 1099 in per-employee payroll settings (WP-2.6). Stripe no longer needed for the core flow. |
| Payment flow | **Owner-initiated only — no early cash-out / no EWA.** Money moves **owner's bank → employee's bank** directly; Relay never holds a float. |
| Tips | **Non-cash (card/POS) tips paid *with the paycheck*.** Cash tips out of scope (untrackable). |
| Core differentiator | **Group-chat flexibility** — every feature ships dual-surface (dashboard + chat). |

---

## Section 0 — How to use this plan (for the dispatcher)

1. **Freeze the contracts first.** Epic 0 defines shared interfaces (PaymentProvider, POSProvider, DocStore, notify, intentRegistry, commandRegistry, dmFlow, audit, idempotency, entitlements). **No parallel work starts until Epic 0 WPs that define interfaces are merged**, or agents will collide.
2. **One agent per WP.** Each WP block below is a complete brief: dependencies, files, DB, the three+ surfaces, provider notes, acceptance criteria, tests, size.
3. **Respect the dependency graph** (end of doc). WPs marked `∥` in the same group can run in parallel.
4. **Every WP ends with a review checkpoint** (use the repo's `requesting-code-review` / `/code-review` flow) before merge.
5. **Sizes:** S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks, XL ≈ 2–4 weeks (one agent). The whole program is realistically **4–7 months** of focused work.

### Global rules every agent MUST follow (from CLAUDE.md + this plan)
- ES modules only (`import`/`export`). Node 20+.
- **Every async function wrapped in try/catch.** Bot must never crash; preserve `process.on('unhandledRejection'|'uncaughtException')`.
- **No hardcoded values** — everything via `.env`. Add new keys to `.env.example`.
- **Service/adapter rule (the heart of dual-surface):** all feature logic lives in a `src/<domain>/` **service**. Routes (`src/server/*Routes.js`), chat routers (`groupRouter.js`, `dmRouter.js`), and `index.js` are **thin adapters only** — they parse input, call the service, format output. No business logic in adapters. A reviewer rejects any WP that puts logic in a route or router.
- **Money & swaps are atomic** with the existing compensation pattern (`markCovered`/`revertCovered` in `src/coverage/`, undo-stack in `tradeHandler.js`). All payout/payroll mutations follow this: write, and on downstream failure, revert.
- **Idempotency on every external money/POS call** (`src/lib/idempotency.js`, generalizing the `reminder_sends` dedup pattern).
- Supabase: server uses `SUPABASE_SERVICE_ROLE_KEY`; per-tenant **RLS** must deny anon for every new table. Every new table is keyed by `group_id`.
- LLM JSON: use `response_format:{type:"json_object"}` on **Groq**; Cerebras strips it — route strict-JSON parses through Groq or guard the parse.
- `JWT_SECRET` ≥32 chars; never weaken auth.
- New DB objects go in `supabase-schema.sql` **and** a numbered migration; keep schema-drift memory accurate (`MEMORY.md`).
- Tests follow existing patterns (`node:test`, `mock.timers` for anything time-dependent — see recent commits pinning clocks).

---

## Section 1 — North-star architecture: "one brain, two mouths"

Every feature is born with these surfaces, all calling one service:

```
                 ┌──────────────── src/<domain>/<feature>Service.js  (THE BRAIN) ─────────────┐
                 │  pure logic + DB + provider calls; atomic; idempotent; group_id-scoped       │
                 └─────────────────────────────────────────────────────────────────────────────┘
                        ▲                 ▲                      ▲                      ▲
        Dashboard REST  │   Chat NL intent│      Chat slash cmd  │        DM flow/confirm │
   src/server/*Routes.js│  messageParsers │     commandRegistry  │        dmFlow.js        │
                        │  → handler      │     → handler        │   (wizard + yes/no)     │
```

**Per-feature dual-surface checklist** (acceptance gate for every user-facing WP):
- [ ] Dashboard: REST route + UI control.
- [ ] Chat NL: a registered intent + few-shot examples in `intentRegistry`.
- [ ] Chat command: a `/command` in `commandRegistry`.
- [ ] DM: confirmation/receipt and (where input is needed) a `dmFlow` wizard.
- [ ] All four call the **same** service function.
- [ ] Notifications via `notify.js` (channel-agnostic).

---

## Section 2 — Shared contracts (FROZEN in Epic 0 — every agent imports these)

```js
// src/lib/money/PaymentProvider.js
export class PaymentProvider {
  async ensurePayee(groupId, staffId)            // -> {payeeRef} (Stripe Express acct)
  async getOnboardingLink(groupId, staffId)      // -> hosted KYC/bank-link URL
  async transfer({groupId, staffId, amountCents, idemKey, source}) // -> {transferRef}
  async instantPayout({payeeRef, amountCents, idemKey})            // -> {payoutRef}
  async fundPlatform({groupId, amountCents, idemKey})              // ACH debit restaurant
  async balance(groupId)                                            // -> {availableCents}
}

// src/integrations/pos/POSProvider.js
export class POSProvider {
  async connect(groupId, oauthCode)              // -> {connectionId}
  async fetchTips({groupId, since})              // -> [{shiftDate, amountCents, ...}]
  async fetchSales({groupId, since})             // -> [{hour, netSalesCents, covers}]
  async fetchTimecards({groupId, since})         // -> [{staffRef, clockIn, clockOut}]
  webhookVerify(req)                             // -> bool
}

// src/lib/notify.js
export async function notify(staffId, message, opts) // routes via platform_contacts (TG now; SMS/WA later)
export async function notifyGroup(groupId, message)

// src/parsers/intentRegistry.js
export function registerIntent({name, examples, schema, handler})  // extends the 14-intent parser

// src/lib/commandRegistry.js
export function registerCommand({name, role, handler, help})       // declarative slash cmds

// src/lib/dmFlow.js
export function startFlow(staffId, flowDef)         // multi-step DM wizard (generalizes setupFlow)
export function confirm(staffId, prompt)            // -> Promise<bool> (✅/❌ DM)

// src/lib/audit.js        -> logEvent({groupId, actor, action, target, meta})
// src/lib/idempotency.js  -> withIdempotency(key, fn)
// src/lib/entitlements.js -> can(groupId, feature) / requireFeature(...)
```

---

# EPIC 0 — Platform spine (foundations) `[BLOCKS EVERYTHING]`

Build these first; they make every later WP cheap.

### WP-0.1 — Service/adapter conventions + intent & command registries  `S` `∥A`
- **Goal:** Extract registries so `index.js` and `messageParsers.js` stop growing; document the service/adapter rule.
- **Files:** create `src/parsers/intentRegistry.js`, `src/lib/commandRegistry.js`; refactor `src/index.js` command wiring and `src/parsers/messageParsers.js` to consume registries (keep all 14 existing intents working).
- **Surfaces:** infra only.
- **Acceptance:** existing intents/commands still pass tests; a new demo intent/command can be added in <10 lines; no behavior change.
- **Tests:** registry unit tests; regression on existing parser tests.

### WP-0.2 — Generic DM flow + confirmation helper  `S` `∥A`
- **Goal:** `src/lib/dmFlow.js` generalizing `setupFlow.js`/`overtimeSteps.js` (step state in a `dm_flow_sessions` table; reuse `setup_sessions` shape).
- **Acceptance:** can define a 3-step wizard declaratively; `confirm()` returns a boolean from a ✅/❌ DM with timeout.

### WP-0.3 — Channel-agnostic notify fan-out  `S` `∥A`
- **Goal:** `src/lib/notify.js` over the existing `platform_contacts` table; Telegram adapter today, pluggable later.
- **Acceptance:** all new notifications go through `notify()`; Telegram parity with current DM sends.

### WP-0.4 — Audit log + idempotency  `S` `∥A`
- **DB:** `audit_log` (immutable: group_id, actor_id, action, target, meta jsonb, created_at); generalize dedup into `idempotency_keys` (key unique, result jsonb).
- **Files:** `src/lib/audit.js`, `src/lib/idempotency.js`.
- **Acceptance:** `withIdempotency(key, fn)` returns cached result on retry; audit entries written for any money/schedule mutation.

### WP-0.5 — Entitlements / feature flags / plan tiers  `M` `∥A`
- **DB:** `entitlements` (group_id, feature, enabled, tier).
- **Files:** `src/lib/entitlements.js` + dashboard settings toggle.
- **Acceptance:** any feature can be gated by `requireFeature(groupId,'payouts')`; default tier = current free feature set. (Used later by Stripe Billing, WP-7.7.)

### WP-0.6 — Stripe Connect platform bootstrap  `M` `[blocks Epic 1,2,7.7]`
- **Goal:** Stand up Relay as a **Stripe Connect platform** (test mode). Restaurants = connected entities; employees = **Express connected accounts** (Stripe owns their KYC + bank linking → keeps Relay out of PCI/bank-data scope).
- **Files:** `src/lib/money/stripeClient.js`, `src/server/webhooks/stripeWebhook.js` (signature-verified ingestion → dispatch table), env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_*`.
- **DB:** `stripe_accounts` (group_id, staff_id nullable, stripe_account_id, kind: platform|restaurant|employee, kyc_status).
- **Acceptance:** webhook endpoint verifies signatures and routes events; a test Express account can be created; **no raw bank/card data ever touches Relay** (Stripe-hosted onboarding only).

---

# EPIC 1 — Money movement 💸 (owner-initiated direct deposit) — *replaces the direct-deposit/payout half of Toast / Square / Homebase*

**Revised per owner decisions (no EWA, owner-controlled timing, tips on the paycheck):**
- **Owner-initiated only.** No early cash-out / EWA. The owner decides exactly when to pay.
- **Money flows owner's bank → employee's bank**, directly. Relay never holds a float/balance.
- **Non-cash (card/POS) tips are paid *with the paycheck*** — one deposit = wages + non-cash tips − deductions. **Cash tips out of scope** (untrackable).
- Everything is now a taxable paycheck, so **Epic 1 (move money) and Epic 2 (calc + tax) are one flow.**

### ⚠️ Rail decision: Check is the single rail (DECIDED)
**Check handles BOTH W-2 employees and 1099 contractors** — withholding + filing + W-2/1099-NEC + owner→employee direct deposit. So Check is the single rail for the whole paycheck flow; **Stripe is not needed** (the instant-tip/EWA flows that justified it are removed). Keep the thin `PaymentProvider` interface so a non-Check rail could slot in later, but build against `CheckProvider`.
- **Per-employee tax type:** default **W-2**; the owner can switch any employee to **1099** in per-employee payroll settings (WP-2.6). `payEmployee()` routes withholding and year-end forms by that flag.

### WP-1.1 — PaymentProvider interface + provider impl  `M` `[blocks 1.3,1.4]`
- **Files:** `src/lib/money/PaymentProvider.js` (frozen interface), `CheckProvider.js` (recommended core); `StripeProvider.js` optional for 1099/contractor pay.
- **Scope:** `ensurePayee`, `getOnboardingLink`, `payEmployee({grossCents, taxLines, tipCents})`, `runStatus`. **No** instantPayout, Treasury float, or platform balance.
- **Acceptance:** test-mode pay-run moves owner→employee, idempotent, with revert hooks.

### WP-1.2 — Employee direct-deposit onboarding (bank link + KYC)  `M`
- **Goal:** Employee links their bank via the provider's **hosted** onboarding (Relay never stores raw bank data — Flag E).
- **Surfaces:** Dashboard "Set up direct deposit" per staff; **DM:** first pay run triggers a secure onboarding-link DM; `/setuppay`; NL "set up my direct deposit".
- **Acceptance:** employee completes onboarding from phone; status shown in dashboard; pay is blocked until linked.

### WP-1.3 — Pay-run ledger + idempotent transfer engine  `L` `[blocks 1.4; Epic 2]`
- **DB:** `pay_runs`, `pay_run_items` (group_id, staff_id, wage_cents, tip_cents, deduction_cents, net_cents, status, provider_ref, idem_key, reversal_of).
- **Files:** `src/payouts/payRunEngine.js` — atomic create → debit owner → deposit employees → on failure **revert** (compensation pattern). Full audit trail; idempotent.
- **Acceptance:** a partial-failure run leaves no orphaned money; every transition audited; safe to retry.

### WP-1.4 — Owner pay-run execution (the flagship)  `L` `[dual-surface]`
- **Goal:** Owner triggers a run; Relay debits the **owner's** account and direct-deposits each employee **wages + non-cash tips − deductions**. Owner controls timing — nothing automatic.
- **Inputs:** wages from existing `src/payroll/payCalculator.js`; non-cash tips from `tip_records` (POS-imported in Epic 3, or manually entered); deductions from existing logic.
- **Surfaces:**
  - Dashboard: "Pay team" wizard with per-employee preview (wages, tips, net).
  - NL intent `pay_run_request`: "pay everyone for this week", "send out paychecks".
  - Command: `/paypeople [week]` (owner/manager only).
  - DM: owner confirm ("Pay 6 staff, $4,210 total, from your account ✅/❌"); each employee gets "💵 You've been paid $612 (incl. $84 tips) — arrives [date]".
- **Acceptance:** all surfaces call `payRunEngine.run()`; totals reconcile to the cent; non-cash tips reported as taxable on the paycheck; cash tips excluded; **each employee paid per their `tax_type`** (W-2 withholding vs. 1099 no-withholding — see WP-2.6).

### WP-1.5 — Pay-run webhook reconciliation  `M` `[depends 1.3]`
- **Goal:** Handle provider events (`payment.failed/paid`, `account.updated`) → update ledger, trigger compensation, notify owner + employee.
- **Acceptance:** a failed deposit auto-reverts the ledger row and DMs the owner; money state only set on a confirming webhook.

> **Removed vs. the original plan:** standalone instant tip payout (tips now ride the paycheck), Earned Wage Access / "Cash Out" (owner controls timing), Treasury float, Instant Payouts. This **deletes the EWA liability and most money-licensing exposure** (old Flags C & D).

---

# EPIC 2 — Tax, filing & pay documents — *completes the Gusto / Toast Payroll replacement*

> **Rail:** see Epic 1's "Rail decision" — **Check is the single rail** (calc + withholding + filing + owner→employee deposit). **Epic 1 executes the pay run; Epic 2 wires the tax & document outputs of that run.** Non-cash tips paid on the paycheck (WP-1.4) are reported as taxable wages by Check here — **no separate out-of-band reconciliation** (old Flag A dissolved).

### WP-2.1 — Pay stub PDF (quick win, no provider)  `S`
- **Goal:** Generate a stub from existing `payroll_records` (you already compute hours/OT/deductions).
- **Files:** `src/payroll/payStub.js` (add a PDF lib alongside ExcelJS).
- **Surfaces:** Dashboard download; NL "send me my pay stub"; `/paystub`; DM delivery.

### WP-2.2 — Check enrollment + tax configuration  `XL` `[regulated]`
- **Goal:** Employer + employee **tax** onboarding in Check, **branching by `tax_type`**: W-2 employees → withholding setup (W-4 from Epic 5, FICA/FUTA/SUTA, multi-state); 1099 contractors → contractor enrollment (W-9, 1099-NEC, no withholding). Plus company tax IDs + state registrations. (The provider *interface* and pay-run *execution* live in Epic 1; this WP wires the **tax** features behind them.)
- **Files:** `src/payroll/tax/checkTax.js`.
- **Surfaces:** Dashboard "Payroll setup" wizard; `/payrollsetup`; status surfaced before the first WP-1.4 run.
- **Acceptance:** test-mode employee is tax-enrolled; a WP-1.4 run withholds + schedules filings correctly; multi-rate/OT/non-cash-tips honored.

### WP-2.3 — Payday reminders (owner-initiated, NOT auto-run)  `S`
- **Goal:** Owner controls timing, so **never auto-run** payroll. Optional reminders only: "Payday is [date] — run payroll?" with a one-tap link to the WP-1.4 wizard.
- **Surfaces:** DM/group reminder via `notify.js`; dashboard banner; settings toggle; NL "remind me on paydays".

### WP-2.4 — W-2 / 1099 + tax documents  `M`
- **DB:** `tax_documents`. Year-end generation via provider; dashboard + DM delivery.

### WP-2.5 — Accounting export (QuickBooks / Xero / CSV)  `M`
- `src/payroll/accountingExport.js`; OAuth to QBO/Xero; scheduled journal export; CSV fallback.

### WP-2.6 — Per-employee payroll settings + tax classification (owner-only)  `M` `[dual-surface]`
- **Goal:** Owner opens payroll settings for any individual employee and changes their **tax type (W-2 ⇄ 1099)** plus related fields (filing status, allowances, exemptions; pay rate already exists). **Default = W-2.**
- **DB:** `employee_payroll_settings` (group_id, staff_id, tax_type default `'w2'`, filing_status, allowances, w4_ref/w9_ref, updated_by, updated_at). **Audit every change** — it's a compliance-sensitive field.
- **Routing:** `payRunEngine` (WP-1.4) and `checkTax` (WP-2.2) read `tax_type` to choose withholding vs. contractor pay and W-2 vs. 1099-NEC at year end.
- **Access control:** **owner-only.** Until WP-7.5 adds role tiers, gate with the existing admin check (`src/setup/db/admins.js`).
- **Surfaces:**
  - Dashboard: per-staff "Payroll settings" panel (owner-only).
  - NL intent `payroll_setting_change`: "set Maria to 1099", "make Jordan a W-2 employee".
  - Command: `/payrollsettings [name]`.
  - DM: owner confirm on any tax-type change ("Switch Maria to 1099 contractor? This changes tax withholding & year-end forms ✅/❌").
- **Acceptance:** changing tax type updates Check enrollment, is reflected in the next WP-1.4 run and the correct year-end form (W-2 vs 1099-NEC), is audit-logged, and only the owner can change it.

---

# EPIC 3 — POS integration (Toast + Square) — *replaces 7shifts / Fourth / Rightwork core*

> **Square first** (clean OAuth). **Toast** requires partner-program approval — submit the application on day 1 of this epic; it gates WP-3.3.

### WP-3.1 — POSProvider interface  `S` `[blocks 3.2,3.3]`
- `src/integrations/pos/POSProvider.js` (frozen) + `pos_connections` table (group_id, provider, oauth refs, status).

### WP-3.2 — SquareAdapter  `L` `∥B`
- OAuth + webhooks; map orders/payments/tips/timecards. `src/integrations/pos/SquareAdapter.js`.

### WP-3.3 — ToastAdapter  `L` `∥B` `[needs partner approval]`
- Toast partner OAuth + webhooks; same interface. `src/integrations/pos/ToastAdapter.js`.

### WP-3.4 — Auto tip import → tip_records  `M` `[depends 3.2/3.3 + Epic1]`
- POS tips → `tip_records` automatically → (Epic 1) auto-payout = full Kickfin parity.
- Surfaces: Dashboard "synced from POS" badge; NL "import tips from Square"; `/synctips`.

### WP-3.5 — Sales actuals ingestion  `M`
- **DB:** `sales_actuals` (group_id, hour, net_sales_cents, covers). Webhook + backfill.

### WP-3.6 — Forecasting engine + schedule integration  `L`
- **DB:** `sales_forecasts`. **Files:** `src/forecast/forecaster.js` — start simple (trailing averages + day-of-week/seasonal, leverage existing `staffingPatterns.js`/`demand_signals`); feed `generateSchedule.js` for demand-matched staffing.
- Surfaces: Dashboard forecast-vs-labor chart; NL "how busy will Friday be?", "build the schedule to match next week's sales"; `/forecast`.

### WP-3.7 — POS connect UI + chat surfaces  `S`
- Dashboard Settings → "Connect POS"; NL "connect my Toast"; `/connectpos`.

---

# EPIC 4 — Labor-law compliance guardrails — *replaces Deputy / HotSchedules compliance (no vendor)*

### WP-4.1 — Jurisdiction profiles + data  `M` `[blocks 4.2–4.5]`
- **DB:** `compliance_profiles` (group_id, state, city, ruleset jsonb); seed US states + Fair-Workweek cities (NYC, Chicago, Philly, SF, LA, Oregon, Seattle).
- Surfaces: Dashboard Settings "Location & compliance"; `/setlocation`.

### WP-4.2 — Break planning engine  `M`
- Meal (unpaid) + rest (paid) breaks with start/stop by hours worked & state; inserts into schedule.

### WP-4.3 — Minor labor rules  `M`
- DOB on staff; auto-block illegal under-18 shifts (school-night hours, max hours). Ties to scheduling + chat warnings.

### WP-4.4 — Fair Workweek / predictive scheduling + predictability pay  `L`
- Advance-notice tracking (7–14 days), flag late changes → **predictability pay** owed; good-faith estimate.

### WP-4.5 — Integrate into scheduling + chat warnings  `M`
- Hook into `generateSchedule.js` (block/warn) and `scheduleQuality.js` (score). **Chat:** when a manager assigns an illegal shift in the GC → instant "⚠️ Sam is 17, can't work past 10pm on a school night". `/compliance` report.

### WP-4.6 — Compliance audit log + reports  `S`
- `compliance_events`; exportable audit report (dashboard + `/complianceaudit`).

---

# EPIC 5 — HR onboarding, documents & certifications — *replaces Workstream / R365 / Connecteam onboarding*

### WP-5.1 — DocStore (Supabase Storage)  `S` `[blocks 5.2–5.4]`
- `src/lib/docs/DocStore.js` — per-`group_id` bucket, signed URLs, RLS.

### WP-5.2 — Documents + e-signature  `L`
- **DB:** `documents`, `document_signatures`. Forms: **W-4, I-9, direct-deposit auth** (feeds WP-1.2). E-sign capture.
- Surfaces: Dashboard doc vault per staff; DM flow to review+sign; NL "sign my onboarding docs".

### WP-5.3 — Onboarding wizard  `M`
- Extends `src/onboarding/handleNewHire.js`. Checklist (docs, certs, bank). **DM wizard** lets a new hire onboard entirely from chat; dashboard mirror; `/onboarding [name]`.

### WP-5.4 — Certifications + expiry reminders  `M`
- **DB:** `certifications` (type, issued, expires, doc_ref). Reuse **reminder cron + `reminder_sends` dedup** → auto-DM "your food handler cert expires in 14 days" + manager alert; **block scheduling on expired cert** (ties to Epic 4).
- Surfaces: Dashboard cert table; NL "upload my food handler cert" (photo → DocStore); `/certs`.

---

# EPIC 6 — Benefits & PTO accrual — *closes Homebase/Toast HR gap*

### WP-6.1 — PTO policies + accrual engine  `M`
- **DB:** `pto_policies`, `pto_balances`, `pto_ledger`. `src/hr/ptoAccrual.js` accrual cron.

### WP-6.2 — Balances + time-off integration + chat  `S`
- Integrate with `src/timeOff/handleTimeOff.js` (deduct on approval). NL "how much PTO do I have?" → `pto_balance_query`; `/pto`; dashboard widget.

---

# EPIC 7 — Platform reach & monetization — *removes every remaining gap; spread across the program*

### WP-7.1 — SMS adapter (Twilio)  `M` `∥C`
- New channel behind `notify.js` + `platform_contacts` → **zero handler changes**. Env: `TWILIO_*`.

### WP-7.2 — WhatsApp adapter  `M` `∥C`
- Same abstraction; WhatsApp Business API.

### WP-7.3 — Calendar sync (iCal + Google)  `M` `∥C`
- `src/integrations/calendar/`; signed per-staff iCal feed + Google push. NL "add my shifts to my calendar" → feed URL DM.

### WP-7.4 — Public API v1 + webhooks + Zapier  `L`
- `src/server/apiV1/`; scoped `api_keys` table; outbound webhooks; Zapier app.

### WP-7.5 — Multi-location + RBAC tiers  `L`
- `location_id` across operational tables; role tiers (owner / GM / shift-lead) above the current manager/staff binary. Touches RLS — careful migration.

### WP-7.6 — Installable PWA  `M`
- Make the dashboard a PWA (offline shell, install prompt, push) before any native app.

### WP-7.7 — Stripe Billing + plan tiers  `M` `[depends 0.5,0.6]`
- **Pricing model: FLAT FEE — no per-employee/per-seat component.** One flat monthly price per business (optionally a flat per-location price for multi-unit chains). Headcount does **not** affect price. This is a deliberate differentiator vs. Homebase/7shifts/When I Work, which all charge per active employee — Relay stays predictable as a team grows.
- Subscriptions via Stripe Billing; gate features via `entitlements` (payouts/payroll/POS as paid tiers); trial logic.
- **Implementation note:** since price is flat, the `entitlements` table gates *which features* a flat tier unlocks (e.g., Starter vs Pro), never a count. Do not meter `staff` rows for billing.

---

## Section 3 — Dependency graph & parallelization

```
EPIC 0 (spine)  ── must merge interface WPs first ──┐
  0.1∥0.2∥0.3∥0.4∥0.5  →  0.6 (Stripe bootstrap)     │
                                                     ▼
EPIC 1 (money): 1.1 → 1.2 → 1.3 → 1.4 → 1.5   (owner-initiated; no EWA)
EPIC 2 (tax/docs): 2.1 (now) ; 2.2 → {2.4, 2.6} → 2.5 ; 2.3 = optional payday reminders   (2.2 wires tax behind Epic 1's rail; 2.6 = per-employee W-2/1099 toggle, owner-only)
EPIC 3 (POS):   3.1 → {3.2 ∥ 3.3} → 3.4 (needs Epic1) , 3.5 → 3.6 → 3.7
EPIC 4 (compliance): 4.1 → {4.2,4.3,4.4} → 4.5 → 4.6        [independent of 1–3]
EPIC 5 (HR/docs):    5.1 → {5.2,5.3,5.4}                    [independent of 1–3]
EPIC 6 (PTO):        depends 5.x style HR; 6.1 → 6.2
EPIC 7: 7.1∥7.2∥7.3 anytime after Epic0; 7.4,7.5,7.6 independent; 7.7 after 0.5+0.6
```

**Suggested parallel tracks after Epic 0 (≈4 agents):**
- Track A: Epic 1 → Epic 2 (money & payroll, sequential, one strong agent).
- Track B: Epic 3 (POS) — start Toast partner paperwork immediately.
- Track C: Epic 4 (compliance) — fully independent.
- Track D: Epic 5 → 6 (HR/docs/PTO) — independent. Epic 7 WPs slotted in as capacity frees.

## Section 4 — Definition of Done (every WP)
- [ ] Service holds all logic; adapters are thin; dual-surface checklist satisfied (for user-facing WPs).
- [ ] try/catch everywhere; bot-crash handlers intact; no hardcoded values (`.env.example` updated).
- [ ] New tables have RLS + are in `supabase-schema.sql` + a numbered migration; `group_id`-scoped.
- [ ] Money/POS calls idempotent; mutations atomic with compensation.
- [ ] Tests (`node:test`, clocks mocked) for happy path + failure/compensation + idempotent retry.
- [ ] Audit-logged; gated by `entitlements` where applicable.
- [ ] Code review passed (`/code-review`); schema-drift memory updated if schema changed.

## Section 5 — Flag deep-dives & cross-cutting risks

These are the non-obvious traps. Each agent touching the relevant epic must read its flag.

### FLAG A — Stripe moves money; it does NOT do payroll tax (and tips/EWA still flow into payroll)
- **What Stripe does:** Connect (onboard payees + KYC/AML), Transfers (platform → connected account), Payouts (connected account → bank: standard next-business-day ACH is free; **Instant Payout** to debit card via RTP/Visa Direct for a per-payout fee), Treasury (hold a balance / FBO accounts), Issuing (branded pay cards).
- **What Stripe does NOT do:** calculate or withhold federal/state/local income tax, FICA, FUTA/SUTA; file 941/940/W-2/1099; remit to the IRS/states; new-hire reporting; garnishments; multi-state nexus. **There is no Stripe button for "run payroll and file taxes."**
- **Non-obvious nuance:** tips are **taxable wages** and must appear on the employee's W-2. An instant tip payout is therefore an **advance of already-earned, still-taxable money** — not a tax-free transfer. EWA is likewise an advance against taxable wages. **So every Stripe tip payout and EWA advance must reconcile back into the payroll system of record (Check) so W-2s are correct and advances are recouped at the next run.**
- **Architectural consequence (RESOLVED by owner decisions):** because non-cash tips now ride the **single** paycheck through Check (WP-1.4) and there is **no out-of-band instant payout and no EWA**, there is no "phantom money" to reconcile — Check reports tips as taxable wages natively. The old Epic 1⇄Epic 2 reconciliation dependency is **removed**. (A future Stripe 1099/contractor lane would need its own 1099 reporting — out of scope now.)

### FLAG B — Toast needs a "human owner"; what that means
"Human owner" = a real person at your company who owns the **business/legal tasks an autonomous agent cannot do**. For Toast specifically:
- Apply to the **Toast Partner / Developer program** (company entity details, integration use-case description).
- **Sign legal agreements** — partner agreement, API license, data-processing/security terms. Requires signature authority.
- Pass Toast's **app/security review** to get **production** API credentials (sandbox is lighter; production is gated).
- Maintain the relationship (renewals, compliance attestations).
- **Why an agent can't do it:** it requires legal signature authority, verified company identity, and a business relationship — none of which a coding agent has. An agent can write the integration code against the sandbox, but a human must unlock production access.
- **Square contrast:** developer account is self-serve, OAuth is straightforward, production access is much faster → **build Square first** (WP-3.2) while the Toast paperwork (WP-3.3) clears.
- **Action:** name the owner now and have them start the Toast application on day 1 of the program; it's the longest non-code lead time in the whole plan.

### FLAG C — EWA liability — ✅ REMOVED (no early cash-out)
- The owner decided **nobody cashes out early**; pay timing is owner-controlled. **EWA is cut from the plan**, which **eliminates the fronting/credit-risk liability entirely** — no underwriting, no balance-sheet exposure, no action needed.

### FLAG D — Money-movement licensing — ✅ largely MOOT now
- With **Check** as the rail, **Check is the licensed money mover + tax filer** → Relay avoids money-transmitter licensing for the paycheck flow.
- The EWA/lending-regulation concern is **gone** (EWA removed). A future Stripe 1099/contractor lane would keep that licensing with Stripe. No EWA legal review needed.

### FLAG E — PCI / sensitive-data scope (keep it minimal)
- Use **Stripe-hosted Connect onboarding + Stripe Elements** exclusively; **never store raw bank account / card / SSN** in Relay. This keeps Relay at **PCI SAQ-A** and out of bank-data custody.
- Never log sensitive fields; store only Stripe reference IDs (`stripe_accounts`). Same principle for I-9/W-4 PII in Epic 5 — encrypt at rest, signed-URL access only.

### FLAG F — Multi-location RLS regressions (WP-7.5)
- Adding `location_id` reshapes tenancy and is the **highest cross-tenant-leak risk** in the plan. Requires heavy review, explicit RLS policy tests, and a careful data migration. Do it as its own WP with a security-auditor pass.

### FLAG G — LLM intent collisions (the parser is a shared resource)
- The program adds many intents (`tip_payout_request`, `ewa_request`, `pto_balance_query`, `compliance` checks, doc-sign, POS-sync, …) on top of the existing **14**. More intents = more chance of misclassification degrading current behavior.
- **Action:** every new-intent WP must add **eval/regression cases** to the parser test suite and confirm no regression on the existing 14. As intent count grows past ~20, consider a **two-stage classifier** (coarse category → fine intent) rather than one flat prompt.

### FLAG H — Pricing is flat (no per-seat) — keep billing decoupled from headcount
- Per WP-7.7, billing is a **flat fee** with **no per-employee component**. Do **not** wire any billing logic to `staff`/`staff_members` row counts. `entitlements` gates *features by tier*, never *seats by count*. This protects the predictable-pricing differentiator and avoids a metering subsystem entirely.
```
```

---

## Open inputs still useful (defaults assumed if you don't answer)
1. ~~EWA cap / funder~~ **REMOVED** — no early cash-out; owner controls pay timing.
2. ~~Auto-nightly tip payout~~ **REMOVED** — non-cash tips ride the regular paycheck; cash tips out of scope. **DECIDED:** **Check** is the single rail for **both W-2 (default) and 1099**; per-employee tax type is owner-editable (WP-2.6). Stripe not needed for the core flow.
3. **Toast partner application owner** (someone must start it — it's the long pole).
4. **Billing model for WP-7.7** — **DECIDED: flat fee, no per-employee charge.** Default: one flat monthly price per business; optional flat per-location price for chains. (Still open: the actual dollar amount and how many flat tiers, e.g. Starter/Pro.)
