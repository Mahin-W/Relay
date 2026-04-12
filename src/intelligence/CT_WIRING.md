# Cross-Training Wiring Instructions

## Database Table Required

```sql
CREATE TABLE cross_training (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id TEXT NOT NULL,
  staff_id BIGINT NOT NULL REFERENCES staff(id),
  role_id BIGINT NOT NULL REFERENCES role_rates(id),
  proficiency TEXT NOT NULL CHECK (proficiency IN ('training', 'competent', 'proficient')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, staff_id, role_id)
);

CREATE INDEX idx_cross_training_group ON cross_training(group_id) WHERE active = true;
CREATE INDEX idx_cross_training_role ON cross_training(group_id, role_id) WHERE active = true;

ALTER TABLE cross_training ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cross_training_all" ON cross_training FOR ALL USING (true);
```

## Wire into Group Router

In `src/routing/groupRouter.js`, add cross-training detection after existing message handling:

```javascript
import { handleCrossTrainingMention } from '../intelligence/crossTraining.js'

// After other message handlers, before the fallback:
const handled = await handleCrossTrainingMention(bot, msg, groupId, db)
if (handled) return
```

## Wire into Schedule Review

In `src/schedule/reviewSchedule.js`, when formatting the schedule for manager review, append cross-training usage notes:

```javascript
// After building schedule message, if crossTrainingUsed has entries:
if (result.crossTrainingUsed?.length > 0) {
  msg += '\n\nCross-trained staff used:\n'
  for (const note of result.crossTrainingUsed) {
    msg += `- ${note}\n`
  }
}
```

## Wire /crosstraining Command

Add to `src/routing/commandRouter.js`:

```javascript
import { formatCrossTrainingRoster } from '../intelligence/crossTraining.js'

// In command handler switch:
case '/crosstraining':
  const roster = await formatCrossTrainingRoster(groupId, db)
  await bot.sendMessage(chatId, roster)
  return
```

## Requirements for mockData Path

When using `generateWeeklySchedule` with `mockData`, pass `crossTrainingDb` with the mock DB that implements `getCrossTrainedForRole(groupId, roleId)`. Requirements must include `roleId` for cross-training gap-filling to activate.

```javascript
const mockData = {
  shifts: [...],
  staff: [...],
  availability: [...],
  requirements: [
    { shift_id: 1, role: 'Server', count: 2, roleId: 1 },
  ],
  crossTrainingDb: myMockDb,
}
```
