# Payroll/Income Page Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Payroll page into a clean financials-only view + a new Income page (revenue + tips), remove Time Clock from default nav, and add manager-controlled hideable nav items stored in `setup_sessions.setup_data.hiddenPages`.

**Architecture:** Pure dashboard restructure (HTML+JS in `public/dashboard.html`) plus a tiny additive change to `GET/PATCH /api/settings` in `src/server/dashRoutes.js` to read/write `hiddenPages: string[]` inside the existing `setup_sessions.setup_data` JSONB. No schema migration needed — the JSONB column already exists with `DEFAULT '{}'`. The settings page already loads `/api/settings/full`, so we add `hiddenPages` there too to avoid a second fetch when rendering the toggles.

**Tech Stack:** Vanilla JS in `public/dashboard.html`, Express in `src/server/dashRoutes.js`, Supabase JSONB for storage.

---

## Anchor Reference

- `public/dashboard.html` is **3236 lines**.
- Nav HTML: lines **1328–1357** (`<nav class="sidebar-nav">` … `</nav>`).
- `PAGE_TITLES` dict: lines **1394–1402**.
- `let currentScheduleWeek` declared at line **1390**.
- `loadPage` switch (cases): lines **1913–1958**.
- `checkAuth()`: lines **1572–1579**.
- Init IIFE (auth + first nav): lines **3195–3225**.
- `let currentPayrollWeek`: line **2080**.
- `loadPayrollPage` / `renderPayrollPage`: lines **2118–2220**.
- `_submitRevenue`, `addRevenueNow`, `addRevenueAnyDate`: lines **2222–2264** (KEEP — reused by income page).
- `quickAddTips`: lines **2267–2278** (KEEP).
- `renderRevenueChartOnly`: lines **2280–2332** (KEEP — called by income page).
- `deleteDailyRevenue`: lines **2441–2449** (KEEP — used by daily grid).
- `changePayrollWeek`: lines **2451–2459** (KEEP).
- `logTips`: lines **2461–2468** (KEEP — leave unused for now).
- `loadTimeClockPage` / `renderTimeClockPage`: lines **2474–2604** (KEEP unchanged — page still works if navigated to directly).
- `loadSettingsPage` / `renderSettingsPage`: lines **2706–2956**. Sections inside `renderSettingsPage` are wrapped in `.settings-section` divs starting at line 2794 (Appearance), 2805 (Your Business), etc. We insert "Dashboard Navigation" right after Appearance (between current 2803-end and 2805).
- `dashRoutes.js` is **2175 lines**. `GET /settings` at **1336–1364**, `PATCH /settings` at **1365–1418**.

---

## Task 1: Wire `hiddenPages` into GET/PATCH `/api/settings` and `/api/settings/full`

**Files:**
- Modify: `src/server/dashRoutes.js:1336-1418` (GET + PATCH `/settings`)
- Modify: `src/server/dashRoutes.js:1887-2032` (GET + PATCH `/settings/full`) — only need to add `hiddenPages` read/write

- [ ] **Step 1:** Open `src/server/dashRoutes.js` and locate `GET /settings` at line 1336. Add `hiddenPages` to the response object so the dashboard load + toggle wiring can read it.

In the `res.json({ ... })` block (around line 1351), add a final field:

```js
hiddenPages: session?.setup_data?.hiddenPages ?? [],
```

- [ ] **Step 2:** Locate `PATCH /settings` at line 1365. Update the destructure and the validation guard to accept `hiddenPages`, and route it through the existing `setup_data` merge path.

Change the destructure:

```js
const { tipMode, overtimeThreshold, overtimeMultiplier, weeklyBudget, restaurantName, hiddenPages } = req.body
```

Update the guard:

```js
if (!tipMode && overtimeThreshold === undefined && overtimeMultiplier === undefined && weeklyBudget === undefined && !restaurantName && hiddenPages === undefined) {
  return res.status(400).json({ error: 'At least one setting field is required' })
}
```

In the `setup_data` merge branch (the `if (tipMode !== undefined || overtimeMultiplier !== undefined)` block), widen the condition and patch:

```js
if (tipMode !== undefined || overtimeMultiplier !== undefined || hiddenPages !== undefined) {
  const patch = {}
  if (tipMode !== undefined) patch.tipMode = tipMode
  if (overtimeMultiplier !== undefined) patch.overtimeMultiplier = overtimeMultiplier
  if (hiddenPages !== undefined) patch.hiddenPages = Array.isArray(hiddenPages) ? hiddenPages : []
  updates.push(
    db.rpc('jsonb_merge_setup_data', { p_group_id: groupId, p_patch: patch })
      .then(() => {})
      .catch(async () => {
        const { data: sess } = await db.from('setup_sessions').select('setup_data').eq('group_id', groupId).single()
        const merged = { ...(sess?.setup_data || {}), ...patch }
        return db.from('setup_sessions').update({ setup_data: merged }).eq('group_id', groupId)
      })
  )
}
```

- [ ] **Step 3:** Mirror the GET addition into `/settings/full` (line ~1887). Find the `res.json({ ... })` block in `GET /settings/full` and add `hiddenPages: session?.setup_data?.hiddenPages ?? []` to the response. (Settings page reads `/settings/full`, so this lets us prefill toggles without an extra fetch.)

- [ ] **Step 4:** Verify syntax.

```bash
node --check /Users/mahin/relay-bot/src/server/dashRoutes.js
```

Expected: silent (exit 0).

---

## Task 2: Update nav HTML — add Income, remove Time Clock

**Files:**
- Modify: `public/dashboard.html:1341-1352`

- [ ] **Step 1:** In the `<nav class="sidebar-nav">` block, the current order after Payroll is: Time Clock → Event Log. Replace the Time Clock anchor (lines 1345-1348) with a new **Income** anchor and delete Time Clock entirely from the nav (page render functions stay).

Replace lines 1345-1348:

```html
        <a class="nav-item" data-page="timeclock" onclick="navigateTo('timeclock')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span class="nav-item-label">Time Clock</span>
        </a>
```

with:

```html
        <a class="nav-item" data-page="income" onclick="navigateTo('income')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/><path d="M3 17l4-4 3 3 5-5 6 6"/></svg>
          <span class="nav-item-label">Income</span>
        </a>
```

(Final default-visible order: Overview, Schedule, Staff, Payroll, Income, Event Log, Settings.)

---

## Task 3: PAGE_TITLES + currentIncomeWeek + loadPage 'income' case

**Files:**
- Modify: `public/dashboard.html:1394-1402` (PAGE_TITLES)
- Modify: `public/dashboard.html:2080` (declare `currentIncomeWeek`)
- Modify: `public/dashboard.html:1939-1947` (insert `case 'income'` before `case 'timeclock'`)

- [ ] **Step 1:** Add `income` to `PAGE_TITLES`. Replace the dict (lines 1394-1402) with:

```js
    const PAGE_TITLES = {
      overview: 'Overview',
      schedule: 'Schedule',
      staff: 'Staff',
      payroll: 'Payroll',
      income: 'Income',
      timeclock: 'Time Clock',
      eventlog: 'Event Log',
      settings: 'Settings'
    };
```

- [ ] **Step 2:** Just below `let currentPayrollWeek = getCurrentWeekStart();` at line 2080, add a sibling state for the income page:

```js
    let currentPayrollWeek = getCurrentWeekStart();
    let currentIncomeWeek  = getCurrentWeekStart();
```

- [ ] **Step 3:** In the `loadPage` switch, insert `case 'income'` between Payroll and Time Clock. The current block at lines 1939-1947 reads:

```js
        case 'payroll':
          showSkeleton();
          loadPayrollPage();
          break;

        case 'timeclock':
          showSkeleton();
          loadTimeClockPage();
          break;
```

Change to:

```js
        case 'payroll':
          showSkeleton();
          loadPayrollPage();
          break;

        case 'income':
          showSkeleton();
          loadIncomePage();
          break;

        case 'timeclock':
          showSkeleton();
          loadTimeClockPage();
          break;
```

---

## Task 4: Strip the Payroll page

**Files:**
- Modify: `public/dashboard.html:2118-2220` (`loadPayrollPage` + `renderPayrollPage`)

- [ ] **Step 1:** Replace `loadPayrollPage` (currently lines 2118-2133) with a slimmer version that only loads payroll + settings:

```js
    async function loadPayrollPage() {
      try {
        const [payroll, settings] = await Promise.all([
          api(`/api/payroll?week=${currentPayrollWeek}`),
          api('/api/settings'),
        ]);
        renderPayrollPage(payroll || [], settings || {});
      } catch (e) {
        showToast(e.message, 'error');
        renderErrorInline("loadPage('payroll')");
      }
    }
```

- [ ] **Step 2:** Replace `renderPayrollPage` (currently lines 2135-2220) with a clean financials-only render:

```js
    function renderPayrollPage(payroll, settings) {
      const totalPay = payroll.reduce((s, r) => s + (r.total_gross_pay || 0), 0);
      const totalHrs = payroll.reduce((s, r) => s + (r.total_hours || 0), 0);
      const avgRate  = totalHrs > 0 ? totalPay / totalHrs : 0;
      const staffPaid = payroll.filter(r => (r.total_hours || 0) > 0).length;

      const rateOf = r => (r.total_hours || 0) > 0
        ? (r.total_gross_pay || 0) / (r.total_hours || 0) : 0;

      const rows = payroll.map(r => `
        <tr>
          <td>${escapeHtml(r.name || '')}</td>
          <td><span class="role-badge">${escapeHtml(r.role || '')}</span></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${(r.total_hours || 0).toFixed(1)}h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(rateOf(r))}/h</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${formatCurrency(r.total_gross_pay || 0)}</td>
        </tr>`).join('');

      const thisWeek = getCurrentWeekStart();
      const atCurrent = currentPayrollWeek >= thisWeek;
      const incomeHidden = (settings.hiddenPages || []).includes('income');

      setContent(`
        <div class="page-header">
          <h2 class="page-title">Payroll</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-small" onclick="changePayrollWeek(-7)">&larr; Prev</button>
            <span style="font-size:14px;font-weight:600;color:var(--text-secondary)">Week of ${formatWeekRange(currentPayrollWeek)}</span>
            <button class="btn-small" onclick="changePayrollWeek(7)" ${atCurrent ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>Next &rarr;</button>
            <a href="/api/payroll/spreadsheet?week=${currentPayrollWeek}" download class="btn-small">📥 Export CSV</a>
          </div>
        </div>

        <div class="stat-grid" style="margin-bottom:20px;grid-template-columns:repeat(4,1fr)">
          <div class="stat-card"><div class="stat-label">Labor Cost</div><div class="stat-value">${formatCurrency(totalPay)}</div></div>
          <div class="stat-card"><div class="stat-label">Total Hours</div><div class="stat-value">${totalHrs.toFixed(1)}h</div></div>
          <div class="stat-card"><div class="stat-label">Avg Hourly Rate</div><div class="stat-value">${totalHrs > 0 ? formatCurrency(avgRate) : '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Staff Paid</div><div class="stat-value">${staffPaid}</div></div>
        </div>

        <div class="card">
          <table class="data-table payroll-table">
            <thead><tr>
              <th>Name</th><th>Role</th>
              <th style="text-align:right">Hours</th>
              <th style="text-align:right">Rate</th>
              <th style="text-align:right">Gross Pay</th>
            </tr></thead>
            <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No payroll data for this week. Generate and approve a schedule to calculate payroll.</td></tr>'}</tbody>
            ${payroll.length ? `<tfoot><tr style="border-top:2px solid var(--surface-border);font-weight:700;color:var(--text)">
              <td>TOTAL</td><td>—</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${totalHrs.toFixed(1)}h</td>
              <td style="text-align:right">—</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(totalPay)}</td>
            </tr></tfoot>` : ''}
          </table>
        </div>

        ${incomeHidden ? `<div style="margin-top:16px;text-align:center">
          <a onclick="navigateTo('income')" style="font-size:13px;color:var(--accent);cursor:pointer;text-decoration:none">Track revenue and tips →</a>
        </div>` : ''}
      `);
    }
```

- [ ] **Step 3:** Sanity check the file still parses as HTML.

```bash
python3 -c "
c = open('/Users/mahin/relay-bot/public/dashboard.html').read()
print('div open:', c.count('<div'))
print('div close:', c.count('</div>'))
"
```

Expected: counts roughly equal (a few unbalanced is fine inside template strings, but the gap should not blow up).

---

## Task 5: Add Income page (load + render + week nav + daily grid)

**Files:**
- Modify: `public/dashboard.html` — insert new functions just after the new `renderPayrollPage` (i.e., just after the closing `}` of the function from Task 4).

- [ ] **Step 1:** Add the income loaders/renderers. Insert this block after the new `renderPayrollPage`:

```js
    // ───────────────────────────────────────────
    // ── PAGE: INCOME ──
    // ───────────────────────────────────────────
    async function loadIncomePage() {
      try {
        const [payroll, revenue, tips, settings] = await Promise.all([
          api(`/api/payroll?week=${currentIncomeWeek}`),
          api(`/api/revenue/daily?weekStart=${currentIncomeWeek}`),
          api(`/api/tips?weeks=4`),
          api('/api/settings'),
        ]);
        renderIncomePage(
          payroll || [],
          revenue || { days: {}, weekTotal: 0 },
          tips || [],
          settings || {}
        );
        await buildCategorySelector('now-rev-cat');
        await buildCategorySelector('any-rev-cat');
      } catch (e) {
        showToast(e.message, 'error');
        renderErrorInline("loadPage('income')");
      }
    }

    function changeIncomeWeek(days) {
      const d = parseDate(currentIncomeWeek);
      d.setDate(d.getDate() + days);
      const next = formatDate(d);
      if (days > 0 && next > getCurrentWeekStart()) return;
      currentIncomeWeek = next;
      loadIncomePage();
    }

    function renderDailyRevenueGrid(revenue) {
      const days = revenue.days || {};
      const dayOrder = Object.keys(days).sort();
      const dayLabel = dateStr => {
        const d = parseDate(dateStr);
        return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][d.getDay() === 0 ? 6 : d.getDay() - 1];
      };
      const dayDate = dateStr => {
        const d = parseDate(dateStr);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${months[d.getMonth()]} ${d.getDate()}`;
      };

      const grid = dayOrder.map(date => {
        const day = days[date];
        const entries = (day.entries || []).map(e => `
          <div class="revenue-entry">
            <span class="category-dot" style="background:${categoryColor(e.category)}" title="${categoryLabel(e.category)}"></span>
            <span class="entry-amount">$${Number(e.amount).toFixed(2)}</span>
            <span class="entry-note">${escapeHtml(e.note || categoryLabel(e.category))}</span>
            <button class="entry-delete" onclick="deleteDailyRevenue(${e.id})" aria-label="Delete">✕</button>
          </div>`).join('');
        return `
          <div class="revenue-day">
            <div class="day-label">${dayLabel(date)}</div>
            <div class="day-date">${dayDate(date)}</div>
            <div class="day-total">$${Number(day.total).toFixed(2)}</div>
            <div class="day-entries">${entries || '<div style="font-size:11px;color:var(--text-muted)">No entries</div>'}</div>
          </div>`;
      }).join('');

      return `
        <div class="card" style="padding:20px;margin-bottom:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <h3 style="margin:0;font-size:16px;font-weight:700;color:var(--text)">Daily Revenue</h3>
            <div class="week-total">Total: <strong>$${Number(revenue.weekTotal || 0).toFixed(2)}</strong></div>
          </div>
          <div class="revenue-grid">${grid}</div>
        </div>`;
    }

    function renderIncomePage(payroll, revenue, tips, settings) {
      const today = formatDate(new Date());
      const weekEnd = formatDate(new Date(parseDate(currentIncomeWeek).getTime() + 6 * 86400000));
      const thisWeek = getCurrentWeekStart();
      const atCurrent = currentIncomeWeek >= thisWeek;

      const totalLabor = payroll.reduce((s, r) => s + (r.total_gross_pay || 0), 0);
      const weekRevenue = Number(revenue.weekTotal || 0);
      const weekTipsRows = (tips || []).filter(t => t.shift_date >= currentIncomeWeek && t.shift_date <= weekEnd);
      const weekTipsTotal = weekTipsRows.reduce((s, t) => s + Number(t.total_tips || 0), 0);
      const tipsCount = weekTipsRows.length;
      const revenueEntries = Object.values(revenue.days || {}).reduce((n, d) => n + ((d.entries || []).length), 0);

      const laborPctNum = weekRevenue > 0 ? (totalLabor / weekRevenue) * 100 : null;
      const laborPctText = laborPctNum === null ? 'N/A' : `${laborPctNum.toFixed(1)}%`;
      const laborPctColor = laborPctNum === null ? 'var(--text-muted)'
        : laborPctNum < 30 ? 'var(--success)'
        : laborPctNum <= 40 ? 'var(--accent)'
        : 'var(--color-danger)';
      const laborPctSub = laborPctNum === null ? 'Log revenue to calculate' : 'of revenue';

      const net = weekRevenue - totalLabor;
      const netColor = weekRevenue === 0 ? 'var(--text)'
        : net >= 0 ? 'var(--success)' : 'var(--color-danger)';

      const tipsRows = (tips || []).map(t => {
        const d = parseDate(t.shift_date);
        const fmt = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' +
          ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate();
        return `<tr>
          <td>${fmt}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${formatCurrency(Number(t.total_tips || 0))}</td>
          <td style="color:var(--text-muted);font-size:12px">${escapeHtml(t.split_method || 'pool')}</td>
        </tr>`;
      }).join('');

      const showSummary = weekRevenue > 0;
      const pct = v => Math.max(0, Math.min(100, weekRevenue > 0 ? (v / weekRevenue) * 100 : 0));

      const summaryHtml = !showSummary ? '' : `
        <div class="card" style="margin-top:20px;padding:20px">
          <h3 style="margin:0 0 12px;font-size:16px;font-weight:700;color:var(--text)">This week at a glance</h3>
          <div class="summary-bar-wrap">
            <div class="summary-bar-label">Revenue</div>
            <div class="summary-bar-track"><div class="summary-bar-fill" style="width:100%;background:var(--accent)"></div></div>
            <div class="summary-bar-amount">${formatCurrency(weekRevenue)}</div>
          </div>
          <div class="summary-bar-wrap">
            <div class="summary-bar-label">Labor</div>
            <div class="summary-bar-track"><div class="summary-bar-fill" style="width:${pct(totalLabor)}%;background:#D97706"></div></div>
            <div class="summary-bar-amount">${formatCurrency(totalLabor)}</div>
          </div>
          <div class="summary-bar-wrap">
            <div class="summary-bar-label">Tips</div>
            <div class="summary-bar-track"><div class="summary-bar-fill" style="width:${pct(weekTipsTotal)}%;background:var(--success)"></div></div>
            <div class="summary-bar-amount">${formatCurrency(weekTipsTotal)}</div>
          </div>
          <div class="summary-bar-wrap" style="border-bottom:none">
            <div class="summary-bar-label">Net</div>
            <div class="summary-bar-track"></div>
            <div class="summary-bar-amount" style="color:${netColor}">${formatCurrency(net)}</div>
          </div>
        </div>`;

      setContent(`
        <div class="page-header">
          <h2 class="page-title">Income</h2>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-small" onclick="changeIncomeWeek(-7)">&larr; Prev</button>
            <span style="font-size:14px;font-weight:600;color:var(--text-secondary)">Week of ${formatWeekRange(currentIncomeWeek)}</span>
            <button class="btn-small" onclick="changeIncomeWeek(7)" ${atCurrent ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>Next &rarr;</button>
          </div>
        </div>

        <div class="stat-grid" style="margin-bottom:20px;grid-template-columns:repeat(4,1fr)">
          <div class="stat-card">
            <div class="stat-label">Total Revenue</div>
            <div class="stat-value">${formatCurrency(weekRevenue)}</div>
            <div class="stat-sub">${revenueEntries} ${revenueEntries === 1 ? 'entry' : 'entries'} this week</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Tips</div>
            <div class="stat-value">${formatCurrency(weekTipsTotal)}</div>
            <div class="stat-sub">${tipsCount} tip ${tipsCount === 1 ? 'record' : 'records'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Labor %</div>
            <div class="stat-value" style="color:${laborPctColor}">${laborPctText}</div>
            <div class="stat-sub">${laborPctSub}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Net</div>
            <div class="stat-value" style="color:${netColor}">${formatCurrency(net)}</div>
            <div class="stat-sub">after labor costs</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:20px;padding:20px">
          <h3 style="margin:0 0 12px;font-size:16px;font-weight:700;color:var(--text)">Log revenue</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">For right now <span style="font-weight:400;text-transform:none">(${today})</span></div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <div class="cat-wrap"><select id="now-rev-cat" style="padding:8px 10px;border:1px solid var(--surface-border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);font-family:inherit"></select></div>
                <input id="now-rev-amount" type="number" min="0" step="0.01" placeholder="Amount $" style="flex:1;min-width:100px;padding:8px 12px;border:1px solid var(--surface-border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);font-family:inherit">
                <button class="btn-primary" onclick="addRevenueNow()">Add now</button>
              </div>
            </div>
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">For a specific date</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <input id="any-rev-date" type="date" value="${today}" style="padding:8px 10px;border:1px solid var(--surface-border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);font-family:inherit">
                <div class="cat-wrap"><select id="any-rev-cat" style="padding:8px 10px;border:1px solid var(--surface-border);border-radius:6px;font-size:13px;background:var(--bg);color:var(--text);font-family:inherit"></select></div>
                <input id="any-rev-amount" type="number" min="0" step="0.01" placeholder="Amount $" style="flex:1;min-width:100px;padding:8px 12px;border:1px solid var(--surface-border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);font-family:inherit">
                <button class="btn-primary" onclick="addRevenueAnyDate()">Add</button>
              </div>
            </div>
          </div>
        </div>

        ${renderDailyRevenueGrid(revenue)}
        ${renderRevenueChartOnly(revenue)}

        <div class="card" style="margin-top:20px;padding:20px">
          <h3 style="margin:0 0 12px;font-size:16px;font-weight:700;color:var(--text)">Tips</h3>
          <div style="margin-bottom:16px">
            <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Add tips for today</div>
            <div style="display:flex;gap:8px">
              <input id="quick-tips" type="number" min="0" step="0.01" placeholder="Amount $" style="flex:1;padding:8px 12px;border:1px solid var(--surface-border);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text);font-family:inherit">
              <button class="btn-primary" onclick="quickAddTips()">Add Tips</button>
            </div>
          </div>
          <table class="data-table">
            <thead><tr><th>Date</th><th style="text-align:right">Amount</th><th>Notes</th></tr></thead>
            <tbody>${tipsRows || '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:16px">No tips recorded yet.</td></tr>'}</tbody>
          </table>
        </div>

        ${summaryHtml}
      `);
    }
```

- [ ] **Step 2:** Update `quickAddTips` (lines 2267-2278) and `_submitRevenue` (lines 2222-2237) to refresh the income page if that's where they were called from. Easiest fix: instead of always calling `loadPayrollPage()`, call whichever page is current. Replace both `await loadPayrollPage();` lines inside `_submitRevenue` and `quickAddTips`, and the one in `deleteDailyRevenue`, with:

```js
        await (currentPage === 'income' ? loadIncomePage() : loadPayrollPage());
```

This keeps the legacy payroll-page call paths working in case anything else calls them, while the new income page refreshes correctly after add/delete actions.

- [ ] **Step 3:** Add the summary-bar CSS. Insert the rules just before the `.toggle` rule in the stylesheet (or anywhere inside the `<style>` block — for clarity, append after `.settings-section-title` near line 1245):

Find the existing CSS line:

```css
    .settings-section-title {
```

Just BEFORE this rule, add:

```css
    .summary-bar-wrap {
      display: flex; align-items: center;
      gap: 12px; padding: 8px 0;
      border-bottom: 1px solid var(--surface-border);
    }
    .summary-bar-label {
      width: 80px; font-size: 13px;
      color: var(--text-muted); font-weight: 500;
    }
    .summary-bar-track {
      flex: 1; height: 8px;
      background: var(--surface-border);
      border-radius: 4px; overflow: hidden;
    }
    .summary-bar-fill {
      height: 100%; border-radius: 4px;
      transition: width 0.4s ease;
    }
    .summary-bar-amount {
      width: 80px; font-size: 13px;
      font-weight: 600; text-align: right;
      color: var(--text);
    }

```

---

## Task 6: applyNavPreferences — load + apply on init

**Files:**
- Modify: `public/dashboard.html` — add helper near `checkAuth` (line 1571) and call it in init (line 3211).

- [ ] **Step 1:** Add `applyNavPreferences` immediately AFTER `checkAuth` (insert between lines 1579 and 1581):

```js
    async function applyNavPreferences() {
      try {
        const s = await api('/api/settings');
        const hidden = Array.isArray(s?.hiddenPages) ? s.hiddenPages : [];
        document.querySelectorAll('.nav-item[data-page]').forEach(el => {
          const page = el.dataset.page;
          el.style.display = hidden.includes(page) ? 'none' : '';
        });
      } catch {
        // fail silently — show all nav items
      }
    }
```

- [ ] **Step 2:** In the init IIFE, add a call to `applyNavPreferences()` right after `await checkAuth();` (line 3211) and before the hash routing:

```js
      // Check auth
      await checkAuth();

      // Apply nav visibility preferences
      await applyNavPreferences();

      // Route from hash
```

---

## Task 7: Settings page "Dashboard Navigation" section + toggle handler

**Files:**
- Modify: `public/dashboard.html` — `renderSettingsPage` near line 2794 (insert section after Appearance, before Your Business).
- Modify: `public/dashboard.html` — add `toggleNavPage` helper after the existing `submitNewRevenueType` block (around line 2776) for proximity.

- [ ] **Step 1:** Find the Appearance section closing `</div>` at line ~2803 (the section opens at 2794 with `<div class="settings-section">` and contains the dark-mode toggle). Insert a new `<div class="settings-section">` block immediately after Appearance, before the "Your Business" section at line 2805.

The exact content to insert (the `${...}` lines need real config data; we read from the loaded `config.hiddenPages` which we'll add to GET `/settings/full` in Task 1):

```html
        <div class="settings-section">
          <div class="settings-section-title">Dashboard Navigation</div>
          <div class="setting-desc" style="margin-bottom:12px">Show or hide sections you don't need.</div>
          ${[
            { id: 'income',    label: 'Income',     desc: 'Revenue and tips tracking' },
            { id: 'timeclock', label: 'Time Clock', desc: 'Clock-in/out tracking' },
            { id: 'eventlog',  label: 'Event Log',  desc: 'Coverage, trades, overtime history' },
          ].map(p => {
            const isOn = !(config.hiddenPages || []).includes(p.id);
            return `
            <div class="setting-row">
              <div>
                <div class="setting-label">${p.label}</div>
                <div class="setting-desc">${p.desc}</div>
              </div>
              <div class="toggle ${isOn ? 'on' : ''}" id="nav-toggle-${p.id}" onclick="toggleNavPage('${p.id}')"></div>
            </div>`;
          }).join('')}
        </div>
```

- [ ] **Step 2:** Add the `toggleNavPage` handler. Insert just after `deleteRevenueType` (line 2776):

```js
    async function toggleNavPage(pageId) {
      const toggle = document.getElementById(`nav-toggle-${pageId}`);
      if (!toggle) return;
      const isCurrentlyOn = toggle.classList.contains('on');
      try {
        const settings = await api('/api/settings');
        const hidden = Array.isArray(settings.hiddenPages) ? settings.hiddenPages : [];
        const newHidden = isCurrentlyOn
          ? Array.from(new Set([...hidden, pageId]))
          : hidden.filter(p => p !== pageId);
        await api('/api/settings', 'PATCH', { hiddenPages: newHidden });
        toggle.classList.toggle('on');
        await applyNavPreferences();
        showToast(isCurrentlyOn ? `${pageId} hidden` : `${pageId} shown in nav`);
      } catch (e) {
        showToast(e.message || 'Failed to update', 'error');
      }
    }
```

---

## Task 8: Verify

- [ ] **Step 1:** Syntax check Node side.

```bash
node --check /Users/mahin/relay-bot/src/server/dashRoutes.js
```

- [ ] **Step 2:** HTML balance sanity.

```bash
python3 -c "
c = open('/Users/mahin/relay-bot/public/dashboard.html').read()
print('div open:', c.count('<div'))
print('div close:', c.count('</div>'))
print('lines:', c.count(chr(10)))
"
```

- [ ] **Step 3:** Confirm revenue/tips functions only appear on income page.

```bash
grep -n "addRevenueNow\|addRevenueAnyDate\|quickAddTips" /Users/mahin/relay-bot/public/dashboard.html
```

- [ ] **Step 4:** Confirm payroll page no longer references revenue/tips quick-add UI.

```bash
sed -n '2118,2230p' /Users/mahin/relay-bot/public/dashboard.html | grep -E "now-rev|any-rev|quick-tips|renderRevenueChartOnly" || echo "clean"
```

Expected: prints `clean`.

- [ ] **Step 5:** Boot the server and confirm `/api/settings` returns `hiddenPages` (and doesn't 500). Probe with a bad cookie — should be 401 not 500.

```bash
cd /Users/mahin/relay-bot && node src/index.js &
SERVER_PID=$!
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: relay_session=bad" http://localhost:10000/api/settings
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
```

Expected: `401`.

---

## Task 9: Commit

- [ ] **Step 1:** Stage and commit.

```bash
git -C /Users/mahin/relay-bot add public/dashboard.html src/server/dashRoutes.js docs/superpowers/plans/2026-04-29-payroll-income-restructure.md
git -C /Users/mahin/relay-bot commit -m "$(cat <<'EOF'
feat: split payroll/income pages, hideable nav items in settings

- Strip Payroll page to financials only (Labor Cost, Total Hours,
  Avg Hourly Rate, Staff Paid + clean staff table with totals row).
- New Income page: stat cards (Revenue / Tips / Labor% / Net),
  log-revenue forms, daily revenue grid, bar chart, tips entry +
  history, and a labor-vs-revenue summary card.
- Replace Time Clock nav item with Income; Time Clock page still
  reachable via /api/dashboard hash and remains togglable.
- Manager can hide Income / Time Clock / Event Log from Settings
  → Dashboard Navigation. Stored under setup_sessions.setup_data.hiddenPages.
- Payroll page links to Income when Income is hidden so revenue
  tracking is never inaccessible.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

- **Spec coverage:** All 4 changes addressed (payroll strip → Task 4; income page → Task 5; remove timeclock from nav → Task 2; hideable nav → Tasks 1+6+7). Defense-in-depth list satisfied: timeclock still reachable directly (cases not removed); hidden pages scoped per group via existing `req.manager.groupId`; can't hide overview/schedule/staff/payroll/settings (toggle list omits them); income week nav guard via `if (days > 0 && next > getCurrentWeekStart()) return`; 0 revenue → `laborPctNum === null`, 'N/A'; tips empty handled via `(tips || [])`; net negative shows red; `applyNavPreferences` swallows errors.
- **No placeholders:** every step contains literal code/commands.
- **Type consistency:** `hiddenPages` is `string[]` everywhere; toggle IDs `nav-toggle-${id}` consistent across render + handler; `currentIncomeWeek` mirrors `currentPayrollWeek` shape.
