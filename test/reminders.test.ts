import { describe, expect, it } from 'vitest';
import { reminderTimes } from '../src/worker/jobs/reminders';

describe('リマインドの送信時刻', () => {
  it('既定は前日 16:00（ゲストのタイムゾーン）', () => {
    const { sendAt, cutoff } = reminderTimes('2026-11-02T01:00:00.000Z', 'Asia/Tokyo', 16); // 11/2 10:00 JST
    expect(sendAt.toISOString()).toBe('2026-11-01T07:00:00.000Z'); // 11/1 16:00 JST
    expect(cutoff.toISOString()).toBe('2026-11-01T15:01:00.000Z'); // 11/2 0:01 JST
  });
  it('24 は当日 0:00', () => {
    expect(reminderTimes('2026-11-02T01:00:00.000Z', 'Asia/Tokyo', 24).sendAt.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
  it('ゲストが海外ならその土地の前日で計算する', () => {
    // 11/2 10:00 JST = 11/1 20:00 New York（夏時間終了後 -5h）→ 前日 = 10/31 16:00 NY
    expect(reminderTimes('2026-11-02T01:00:00.000Z', 'America/New_York', 16).sendAt.toISOString()).toBe('2026-10-31T20:00:00.000Z');
  });
});
