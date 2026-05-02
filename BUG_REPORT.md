# Relay — 6-Month Stress Test Bug Report

Generated: 2026-05-02T04:38:24.080Z
Runtime: 0m 5s
Total Steps: 396
Passed: 396 ✅
Failed: 0 ❌

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 0 |
| 🟠 HIGH | 0 |
| 🟡 MEDIUM | 0 |
| 🔵 LOW | 0 |
| **REAL BUGS** | **0** |
| ⚪ SIM GAPS | 0 |

---

## Deployment Verdict

🟢 PRODUCTION READY — No critical or high-severity bugs

---

## Bugs by Severity

### 🔴 CRITICAL (blocks real restaurant operation)
_None found_


### 🟠 HIGH (creates wrong data or bad UX)
_None found_


### 🟡 MEDIUM
_None found_


### 🔵 LOW
_None found_


### ⚪ Sim Infrastructure Gaps (not bugs — areas the simulation can't exercise)
_None_


---

## Top Real Findings (manager-impact analysis)

The simulation surfaced these as the highest-impact issues a real manager would hit:



---

## Bugs by Category



---

## Test Coverage by Feature Area

| Feature        | Status |
|----------------|--------|
| Bot slash commands | 0 bugs |
| NL parsing | 0 bugs |
| Coverage flow | 0 bugs |
| Dashboard API | 0 bugs |
| Payroll/Tips | 0 bugs |
| Intelligence layer | 0 bugs |
| Cron jobs | 0 bugs |
| Time clock | 0 bugs |

---

## Features NOT Tested (gaps)

The simulation now exercises 220+ scenarios across bot/dashboard/cron paths.
Genuine gaps remaining:

- **Real Telegram polling** — requires live connection (sim mocks the bot)
- **Real Groq LLM parseMessage** — bypassed via `--skip-llm` (intents synthesized via keywords)
- **Cross-training NL intent** — production `parseMessage` doesn't emit a `cross_training` intent type, so manager notes like "Mike can now bartend" go uncaptured
- **Supabase realtime subscriptions** — no real DB connection
- **PDF export** — not invoked (Excel/CSV is exercised via /api/payroll/spreadsheet)
- **SMS/WhatsApp adapters** — stubbed in production code; only Telegram path tested
- **DST/timezone rollovers** — week boundaries probed but real-time clock not advanced

Now COVERED (Iteration 2 added handlers in simulateDashboardRequest):
- ✅ /api/dashboard/overview, /intelligence, /activity, /schedule
- ✅ /api/schedule/generate, /approve, /swap, /move, /status, DELETE /assign
- ✅ /api/payroll, /api/payroll/planned, /api/payroll/override
- ✅ /api/tips (GET, POST), /api/revenue/daily (GET, POST), /api/revenue/types
- ✅ /api/coverage (GET, POST), /api/timeclock/weekly, /api/events
- ✅ /api/settings (GET, PATCH), /api/settings/full, /api/roles, /api/rates
- ✅ /api/shifts (DELETE, requirements), /api/rules (DELETE)
- ✅ Multi-tenant isolation: 2-group cross-contamination probed
- ✅ Auth: forged JWT, modified signature, expired, empty, path traversal

---

## How to Re-run

```
node --env-file=.env src/tests/simulation/fullSixMonthTest.js
node --env-file=.env src/tests/simulation/fullSixMonthTest.js --month=1
```

_This report was auto-generated. Do not fix bugs in this file — track them separately._
