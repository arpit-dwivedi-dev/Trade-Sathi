import { describe, expect, it } from 'vitest';

import { currentProcessingSlots } from './daily-briefing-processing';

describe('currentProcessingSlots', () => {
  it('ignores processing rows from a previous persisted date', () => {
    const now = new Date('2026-09-08T06:00:00.000Z');

    expect(
      currentProcessingSlots(
        [
          { briefing_date: '2026-09-07', run_hour_ist: 7, run_minute_ist: 0 },
          { briefing_date: '2026-09-08', run_hour_ist: 8, run_minute_ist: 15 },
        ],
        now,
      ),
    ).toEqual([{ hour: 8, minute: 15 }]);
  });

  it('keeps all current-date processing slots', () => {
    const now = new Date('2026-09-08T06:00:00.000Z');

    expect(
      currentProcessingSlots(
        [
          { briefing_date: '2026-09-08', run_hour_ist: 7, run_minute_ist: 0 },
          { briefing_date: '2026-09-08', run_hour_ist: 18, run_minute_ist: 30 },
        ],
        now,
      ),
    ).toEqual([
      { hour: 7, minute: 0 },
      { hour: 18, minute: 30 },
    ]);
  });
});
