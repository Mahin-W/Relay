# Tip Pool Calculator — Wiring Instructions

## 1. DM Router (src/routing/dmRouter.js)

Add import at top:
```js
import { handleTipMessage } from '../operations/tipPool.js'
```

In the DM message handler, add before the fallback/catch-all:
```js
const tipHandled = await handleTipMessage(bot, msg)
if (tipHandled) return
```

## 2. Command Router (src/routing/commandRouter.js or src/index.js)

Add imports:
```js
import { handleTipModeCommand, handleTipHistory } from '../operations/tipPool.js'
```

Register commands:
```js
bot.onText(/\/tipmode(.*)/, async (msg, match) => {
  const args = (match[1] || '').trim().split(/\s+/).filter(Boolean)
  await handleTipModeCommand(bot, msg, args)
})

bot.onText(/\/tips$/, async (msg) => {
  await handleTipHistory(bot, msg)
})
```

## 3. Supabase Schema

Create table `restaurant_tip_settings`:
```sql
CREATE TABLE restaurant_tip_settings (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'pool',
  split_method TEXT NOT NULL DEFAULT 'hours',
  boh_included BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE restaurant_tip_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON restaurant_tip_settings FOR ALL USING (true);
```

Create table `tip_records`:
```sql
CREATE TABLE tip_records (
  id BIGSERIAL PRIMARY KEY,
  group_id TEXT NOT NULL,
  shift_id BIGINT,
  shift_date DATE,
  total_tips NUMERIC(10,2) NOT NULL,
  splits JSONB,
  split_method TEXT,
  mode TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE tip_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON tip_records FOR ALL USING (true);
```

## 4. Setup Flow (already wired)

The setup wizard now includes a `tip_settings` step between `add_staff` and `overtime_setup`.
Flow: welcome -> add_shifts -> shift_roles -> role_rates -> add_staff -> tip_settings -> overtime_setup -> complete
