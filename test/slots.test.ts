import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/shared/schema';
import { computeSlots, type MemberInput, periodKey, pickHosts, rangesForDate, windowOf } from '../src/shared/slots';
import { addDays, formatRangeJa, weekdayOf, zonedParts, zonedToUtc } from '../src/shared/time';

const TZ = 'Asia/Tokyo';
const jst = (date: string, time: string) => zonedToUtc(date, time, TZ);

function member(userId: string, extra: Partial<MemberInput> = {}): MemberInput {
  return { userId, group: 1, priority: 0, busy: [], periodCounts: new Map(), limit: null, totalCount: 0, ...extra };
}

// 2026-11-02 は月曜日。今は 10/30(金) 9:00 JST とする
const NOW = jst('2026-10-30', '09:00');
const MON = '2026-11-02';

function settings(over: Partial<ReturnType<typeof defaultSettings>> = {}) {
  return {
    ...defaultSettings(),
    durationMin: 60,
    slotIntervalMin: 60,
    window: { mode: 'auto' as const, minNoticeHours: 0, daysAhead: 30 },
    ...over,
  };
}

function day(date: string, s = settings(), members = [member('a')]) {
  return computeSlots({ settings: s, members, now: NOW, from: jst(date, '00:00'), to: jst(addDays(date, 1), '00:00') });
}
const times = (slots: { start: string }[]) => slots.map((x) => zonedParts(new Date(x.start), TZ).time);

describe('time', () => {
  it('JST の壁時計時刻を UTC にする', () => {
    expect(jst('2026-11-02', '10:00').toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(jst('2026-11-02', '24:00').toISOString()).toBe('2026-11-02T15:00:00.000Z');
  });
  it('夏時間のあるタイムゾーンでも正しく変換する', () => {
    // 2026-03-08 に米国東部は夏時間に入る（-5h → -4h）
    expect(zonedToUtc('2026-03-07', '10:00', 'America/New_York').toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(zonedToUtc('2026-03-09', '10:00', 'America/New_York').toISOString()).toBe('2026-03-09T14:00:00.000Z');
  });
  it('曜日と日本語の表示', () => {
    expect(weekdayOf(MON)).toBe(1);
    expect(formatRangeJa(jst(MON, '10:00'), jst(MON, '11:00'), TZ)).toBe('2026年11月2日(月) 10:00〜11:00');
  });
});

describe('受付時間と表示間隔', () => {
  it('平日 10:00〜18:00、60分、間隔60分 → 8枠', () => {
    expect(times(day(MON))).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
  });
  it('間隔30分なら 15 枠（最後は 17:00 開始）', () => {
    const slots = day(MON, settings({ slotIntervalMin: 30 }));
    expect(slots).toHaveLength(15);
    expect(times(slots).at(-1)).toBe('17:00');
  });
  it('間隔「自動」は所要時間と同じ', () => {
    expect(times(day(MON, settings({ slotIntervalMin: null, durationMin: 90 })))).toEqual(['10:00', '11:30', '13:00', '14:30', '16:00']);
  });
  it('土日は受け付けない（初期値）', () => {
    expect(day('2026-11-01')).toEqual([]);
  });
  it('1日に複数の時間帯', () => {
    const weekly = settings().weekly.map(() => [
      { start: '09:00', end: '10:00' },
      { start: '13:00', end: '15:00' },
    ]);
    expect(times(day(MON, settings({ weekly })))).toEqual(['09:00', '13:00', '14:00']);
  });
  it('特定の日の設定が曜日より優先。空配列なら受け付けない', () => {
    const s = settings({ dateOverrides: { [MON]: [{ start: '15:00', end: '17:00' }], '2026-11-04': [] } });
    expect(times(day(MON, s))).toEqual(['15:00', '16:00']);
    expect(day('2026-11-04', s)).toEqual([]);
  });
  it('祝日は受け付けない設定なら空（2026-11-03 文化の日）', () => {
    expect(rangesForDate(settings(), '2026-11-03')).toEqual([]);
    expect(day('2026-11-03')).toEqual([]);
    expect(day('2026-11-03', settings({ acceptHolidays: true }))).toHaveLength(8);
  });
});

describe('提示期間', () => {
  it('何時間後から: 今 9:00 で 25 時間後なら翌日 10:00 からになる', () => {
    const s = settings({ window: { mode: 'auto', minNoticeHours: 25, daysAhead: 30 } });
    expect(times(day('2026-10-30', s))).toEqual([]);
    expect(day('2026-10-31', s)).toEqual([]); // 土曜
    const fri = computeSlots({ settings: { ...s, weekly: s.weekly.map(() => [{ start: '09:00', end: '12:00' }]) }, members: [member('a')], now: NOW, from: jst('2026-10-31', '00:00'), to: jst('2026-11-01', '00:00') });
    expect(times(fri)).toEqual(['10:00', '11:00']);
  });
  it('何日間分: 今日を1日目として数える', () => {
    const w = windowOf(settings({ window: { mode: 'auto', minNoticeHours: 0, daysAhead: 3 } }), NOW);
    expect([w.startDate, w.endDate]).toEqual(['2026-10-30', '2026-11-01']);
    expect(day(MON, settings({ window: { mode: 'auto', minNoticeHours: 0, daysAhead: 3 } }))).toEqual([]);
  });
  it('日付指定: 期間外は空、終了日を過ぎたら expired', () => {
    const s = settings({ window: { mode: 'fixed', startDate: '2026-11-04', endDate: '2026-11-05', minNoticeHours: 0 } });
    expect(day(MON, s)).toEqual([]);
    expect(day('2026-11-04', s)).toHaveLength(8);
    expect(windowOf(s, jst('2026-11-06', '00:00')).expired).toBe(true);
  });
});

describe('予定との重なりと確保時間', () => {
  it('予定と重なる枠は出さない', () => {
    const busy = [{ start: jst(MON, '12:30').getTime(), end: jst(MON, '13:30').getTime() }];
    expect(times(day(MON, settings(), [member('a', { busy })]))).toEqual(['10:00', '11:00', '14:00', '15:00', '16:00', '17:00']);
  });
  it('前後30分の確保時間があると、隣接する枠も消える', () => {
    const busy = [{ start: jst(MON, '13:00').getTime(), end: jst(MON, '14:00').getTime() }];
    const s = settings({ bufferBeforeMin: 30, bufferAfterMin: 30 });
    expect(times(day(MON, s, [member('a', { busy })]))).toEqual(['10:00', '11:00', '15:00', '16:00', '17:00']);
  });
  it('ちょうど接する予定は重なりとみなさない', () => {
    const busy = [{ start: jst(MON, '11:00').getTime(), end: jst(MON, '12:00').getTime() }];
    expect(times(day(MON, settings(), [member('a', { busy })]))).toContain('10:00');
  });
});

describe('参加方式と割り当て', () => {
  const busyAt = (time: string) => [{ start: jst(MON, time).getTime(), end: jst(MON, time).getTime() + 3_600_000 }];

  it('全員が参加: 誰か1人でも埋まっていれば出さない', () => {
    const slots = day(MON, settings({ participation: 'all' }), [member('a', { busy: busyAt('10:00') }), member('b', { busy: busyAt('11:00') })]);
    expect(times(slots)).not.toContain('10:00');
    expect(times(slots)).not.toContain('11:00');
    expect(pickHosts(slots[0]!, [], { participation: 'all', assignment: 'priority' })).toEqual(['a', 'b']);
  });
  it('誰か1人が参加: 1人でも空いていれば出す。優先度順で決める', () => {
    const members = [member('a', { priority: 2 }), member('b', { priority: 1, busy: busyAt('10:00') })];
    const s = settings({ participation: 'any', assignment: 'priority' });
    const slots = day(MON, s, members);
    expect(times(slots)).toContain('10:00');
    expect(pickHosts(slots[0]!, members, s)).toEqual(['a']); // 10:00 は a だけ空き
    expect(pickHosts(slots[1]!, members, s)).toEqual(['b']); // 11:00 は優先度の高い b
  });
  it('均等（日程候補優先）: 件数の少ない人', () => {
    const members = [member('a', { totalCount: 3 }), member('b', { totalCount: 1 })];
    const s = settings({ participation: 'any', assignment: 'balanced_slot' });
    expect(pickHosts(day(MON, s, members)[0]!, members, s)).toEqual(['b']);
  });
  it('均等（担当件数優先）: 件数の最も少ない人の枠だけ出す', () => {
    const members = [member('a', { totalCount: 0, busy: busyAt('10:00') }), member('b', { totalCount: 5 })];
    const s = settings({ participation: 'any', assignment: 'balanced_count' });
    expect(times(day(MON, s, members))).not.toContain('10:00');
  });
  it('2つのグループから1人ずつ: 両方のグループに空きが必要', () => {
    const members = [member('a', { group: 1 }), member('b', { group: 2, busy: busyAt('10:00') }), member('c', { group: 2 })];
    const s = settings({ participation: 'groups', assignment: 'priority' });
    const slots = day(MON, s, members.slice(0, 2));
    expect(times(slots)).not.toContain('10:00');
    const all = day(MON, s, members);
    expect(times(all)).toContain('10:00');
    expect(pickHosts(all[0]!, members, s)).toEqual(['a', 'c']);
  });
});

describe('予約受付件数の上限', () => {
  it('日あたりの上限に達した日は出さない（メンバーごと）', () => {
    const s = settings({ participation: 'any', limit: { period: 'day', mode: 'uniform', count: 2 } });
    const full = member('a', { limit: 2, periodCounts: new Map([[MON, 2]]) });
    expect(day(MON, s, [full])).toEqual([]);
    expect(day(MON, s, [full, member('b', { limit: 2 })])).toHaveLength(8);
  });
  it('週のキーは月曜、月のキーは YYYY-MM', () => {
    expect(periodKey('2026-11-05', 'week')).toBe(MON);
    expect(periodKey(MON, 'week')).toBe(MON);
    expect(periodKey('2026-11-08', 'week')).toBe(MON); // 日曜は前の月曜の週
    expect(periodKey(MON, 'month')).toBe('2026-11');
  });
});

describe('候補を選んで日程調整', () => {
  it('候補枠だけを出し、埋まっている候補と過去の候補は除く', () => {
    const candidateStarts = [jst(MON, '10:00').toISOString(), jst(MON, '13:00').toISOString(), jst('2026-10-29', '10:00').toISOString()];
    const busy = [{ start: jst(MON, '13:00').getTime(), end: jst(MON, '14:00').getTime() }];
    const slots = computeSlots({
      settings: settings(),
      members: [member('a', { busy })],
      now: NOW,
      from: jst('2026-10-01', '00:00'),
      to: jst('2026-12-01', '00:00'),
      candidateStarts,
    });
    expect(times(slots)).toEqual(['10:00']);
  });
});
