# Launch — Operator Action Items

Things I (the codebase) can't do for you. Each row tells you what to do, why it matters, and what "good enough for first customer" looks like.

Generated 2026-05-09 by the parallel pre-launch audit. Sister docs: `PRODUCTION_READINESS_REPORT.md`, `LAUNCH_AUDIT_BUGS.md`.

---

## 1. External uptime monitor (15 min)

**Why:** Render's "service running" status doesn't catch polling-dead. Without an external pinger, your first customer will message you saying "the bot is down" before you notice.

**Pick one (free tiers are fine):**
- **UptimeRobot** — `https://uptimerobot.com` — free for 50 monitors @ 5-min intervals. Email + push alerts.
- **BetterStack** — `https://betterstack.com/uptime` — free for 10 monitors @ 3-min intervals. Cleaner UI, better Slack integration.

**Setup:**
1. Sign up.
2. New monitor → HTTP(s) → `https://relay-v5ne.onrender.com/health` → 5-min interval.
3. Add your phone (push notification) and email as alert contacts.
4. Optional: also monitor `https://getrelay-app.netlify.app/login` so you catch frontend-only outages.

**Good enough:** one monitor, alerts to your phone.

**P1 followup (later):** the audit flagged that `/health` itself doesn't check polling/Supabase — it just confirms the web server is up. Once you've got the basic monitor working, fix `/health` to fail when polling is dead (mentioned in `LAUNCH_AUDIT_BUGS.md` P1-4).

---

## 2. Billing model (decide today)

**Why:** You have a public landing page and are about to put a paid product in front of someone. You have no billing code.

**Three reasonable choices for the first customer:**

| Option | Effort | When to pick |
|---|---|---|
| **Manual invoice** (Venmo, Stripe link, bank transfer) | 0 hr | First 1–3 customers. You know them personally. Skip the engineering. |
| **Stripe Payment Link** | 1 hr | First customer is a stranger; want some friction-free payment flow. No billing code in the app — just a URL you send them. |
| **Stripe Checkout + customer portal in-app** | 1 day | Multiple customers, recurring billing, self-serve cancel. |

**My recommendation:** Start manual. When you have 3 paying customers, do Stripe Checkout. Don't build billing infrastructure for hypothetical scale.

**Good enough:** decide on a price (per month, per location, per staff seat?) and write it down somewhere you'll remember.

---

## 3. Privacy Policy + Terms of Service (1 hr)

**Why:** You collect emails on your landing page (`public/index.html`) and store PII (phone numbers, names, schedules) in Supabase. In most jurisdictions you legally need both pages. Also: a non-trivial fraction of restaurant managers will check.

**Cheap options:**
- **Termly** — `https://termly.io` — free generators for Privacy + ToS + Cookie. Drop in your business name + URL, copy the HTML. ~15 min.
- **PolicyBee** — paid but cheaper than a lawyer if you want something defensible.

**What to do:**
1. Generate Privacy Policy + Terms of Service.
2. Host them at `https://getrelay-app.netlify.app/privacy` and `/terms` (just two more HTML files in `public/`).
3. Add footer links from `public/index.html` and `public/login.html`.

**Good enough:** Termly's free tier with your name + email + brief description. You're not running healthcare.gov.

---

## 4. Render plan (decide today, then pay)

**Why:** Free tier sleeps after 15 min idle. First Telegram message after a quiet period takes 30-90 sec to wake the bot. Acceptable for beta, embarrassing for paid.

**Two real choices:**
- **Stay on Free** — keep the keep-alive ping alive (already wired in `src/server/webServer.js:48-51`), document the cold-start to the customer ("first message of the day might take 30s"). $0/mo.
- **Render Starter** — $7/mo, no sleeping, free SSL, custom domain. Recommended.

**My recommendation:** Pay $7. The friction on cold-start is the kind of thing that makes a manager think your product is broken on day 1 even when it isn't.

**Good enough:** upgrade now via Render dashboard → Settings → Plan.

---

## 5. Status / fallback channel for the customer (10 min)

**Why:** When the bot is down, the customer needs to know it's not their fault, and they need a way to reach you. Already-done items: support email is in dashboard footer + manager-facing bot DMs (`mahinwaghray@gmail.com`). What's NOT done: anything in the Telegram group itself.

**What to do:**
After the customer's `/setup` is complete, **pin a message** in their Telegram group with text like:

> 📌 Relay is the scheduling bot here. If it stops responding, email mahinwaghray@gmail.com — usually replies within a day.

To pin: long-press the message → Pin → "Notify all" off.

**Good enough:** do this for every new customer manually until it's automated.

---

## 6. Onboarding doc / video (30 min)

**Why:** Half your customers will give up at step 3 of `/setup` if they're confused. A 5-min Loom changes that.

**What to record:**
1. Add the bot to a fresh Telegram group as admin.
2. Type `/setup` in the group.
3. Walk through the DM wizard: business name, shifts, role rates, staff names, overtime rules, tip settings.
4. In the group, run `/availability`. Show the staff DM flow.
5. Run `/makeschedule`. Approve. Show the published schedule.
6. Open the dashboard → log in with OTP → click around for 30 seconds.

**Tools:**
- **Loom** — `https://loom.com` — free for 5-min videos. Records screen + face. Auto-uploads.
- Alternative: just record on your phone, upload to YouTube unlisted.

**What to do with it:** put the URL in the bot's `/help` reply and on the landing page footer.

**Good enough:** raw 5-min walkthrough, no edit. Ugly is fine.

---

## 7. Smoke test the deploy you just shipped (10 min)

Before you sell to anyone, walk through the full path on the live system:

- [ ] `curl https://relay-v5ne.onrender.com/health` → 200 ✅ (verified 2026-05-09 14:27)
- [ ] Send a real message in your Telegram test group → bot responds
- [ ] Run `/setup` in a populated group → bot asks "yes wipe" instead of nuking
- [ ] Send a coverage request → bot DMs the eligible staff → reply "yes" from another account → schedule swap visible in dashboard
- [ ] Log in to `getrelay-app.netlify.app/login` → OTP arrives → dashboard loads with data
- [ ] Settings → Account → Download .xlsx → file opens in Excel with all your data

If any of these break, fix before charging anyone money.

---

## 8. Decide: who is your first customer?

If they're a friend / friendly beta: ship now with a "this is rough" disclaimer. They'll forgive bugs and give useful feedback.

If they're a stranger paying full price: knock down at least the top-3 P1s from `LAUNCH_AUDIT_BUGS.md` first (Cerebras JSON-mode workaround, polling auto-recovery, dashRoutes error-message leak). That's ~2 hr of work and is the difference between "rough but functional" and "broken in a way that loses trust."

---

## Already-done as of 2026-05-15

- ✅ Support contact email visible in dashboard footer (every page) and bot DMs during setup
- ✅ Data export at Settings → Account → Download .xlsx
- ✅ All 13 P0 launch blockers fixed and pushed (commits `4cb69c9`, `a5c1177`, `264afa2`, `1b4ad6b`)
- ✅ SQL migrations 008 + 009 applied to Supabase
- ✅ `LAUNCH_AUDIT_BUGS.md` lists the 32 P1s for week-1 followup
- ✅ **4 P1s fixed and deployed 2026-05-15:** dashRoutes error-message leaks (P1-1), polling auto-recovery (P1-3), LLM client timeout (P1-12), Cerebras JSON-mode routing (P1-28). Commits: `7383008`, `7b3075e`, `35727d1`
- ✅ **Render deploy green 2026-05-15** — `JWT_SECRET` set to ≥32-char value, container booting cleanly past the P0-1 fail-fast guard
