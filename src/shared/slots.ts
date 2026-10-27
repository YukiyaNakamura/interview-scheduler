/**
 * 空き枠（日程候補）の計算。DB や Google には触らない純粋関数にして、test/slots.test.ts で確かめる。
 * 仕様は docs/00_spec.md「4.1 基本設定」「4.2 詳細設定」:
 * - 受付時間帯（曜日 / 特定の日 / 祝日）の中に、表示間隔ごとに「所要時間」の枠を並べる
 * - 枠の前後に確保時間を足した範囲が、メンバーの予定（busy）と重ならないこと
 * - 提示期間（何時間後から・何日分 / 日付指定）の中であること
 * - 予約受付件数の上限に達したメンバーは、その期間は空きなし扱い
 * - 参加方式（全員 / 誰か1人 / 2グループ）でメンバーの空きを組み合わせる
 */
import { japaneseHolidayName } from './holidays';
import type { CalendarSettings, TimeRange } from './schema';
import { addDays, type DateStr, diffDays, minutesOf, timeOf, weekdayOf, zonedParts, zonedToUtc } from './time';

/** ミリ秒（epoch）の区間。end は含まない */
export interface Interval {
  start: number;
  end: number;
}

export interface MemberInput {
  userId: string;
  /** 2グループ方式のグループ（それ以外の方式では無視） */
  group: 1 | 2;
  /** 小さいほど優先 */
  priority: number;
  /** 埋まっている時間（連携カレンダーの予定 + このアプリで確定した予定の確保時間込みの範囲） */
  busy: Interval[];
  /** このカレンダーでの担当件数（期間キー → 件数）。上限の判定に使う。キーは periodKey() */
  periodCounts: Map<string, number>;
  /** このメンバーの上限（null = 上限なし） */
  limit: number | null;
  /** このカレンダーでの担当件数の合計（均等割り当てに使う） */
  totalCount: number;
}

export type SlotSettings = Pick<
  CalendarSettings,
  | 'durationMin'
  | 'bufferBeforeMin'
  | 'bufferAfterMin'
  | 'participation'
  | 'assignment'
  | 'timezone'
  | 'weekly'
  | 'dateOverrides'
  | 'acceptHolidays'
  | 'window'
  | 'slotIntervalMin'
  | 'limit'
>;

export interface SlotInput {
  settings: SlotSettings;
  members: MemberInput[];
  now: Date;
  /** 求める範囲（枠の開始がこの範囲に入るもの） */
  from: Date;
  to: Date;
  /** 候補を選んで日程調整のときの候補枠（開始時刻の ISO）。指定すると受付時間・提示期間の代わりにこれを使う */
  candidateStarts?: string[];
}

export interface Slot {
  start: string;
  end: string;
  /** グループごとの、この枠に空いているメンバー。全員方式・誰か1人方式はグループ1つ */
  freeByGroup: string[][];
}

/** 提示期間（カレンダーのタイムゾーンの日付）と、これより前は出さない時刻 */
export interface WindowInfo {
  startDate: DateStr;
  endDate: DateStr;
  earliest: number;
  /** 日付指定で終了日を過ぎている */
  expired: boolean;
}

export function windowOf(settings: Pick<SlotSettings, 'window' | 'timezone'>, now: Date): WindowInfo {
  const today = zonedParts(now, settings.timezone).date;
  const w = settings.window;
  const earliest = now.getTime() + w.minNoticeHours * 3_600_000;
  if (w.mode === 'auto') {
    return { startDate: today, endDate: addDays(today, w.daysAhead - 1), earliest, expired: false };
  }
  // 日付指定: 開始日より後にアクセスしたら今日が開始日。終了日は開始日から 200 日まで
  const startDate = w.startDate > today ? w.startDate : today;
  const endDate = diffDays(w.startDate, w.endDate) > 200 ? addDays(w.startDate, 200) : w.endDate;
  return { startDate, endDate, earliest, expired: today > endDate };
}

/** その日の受付時間帯。特定の日の設定 > 祝日 > 曜日 の順に決める */
export function rangesForDate(settings: Pick<SlotSettings, 'weekly' | 'dateOverrides' | 'acceptHolidays' | 'timezone'>, date: DateStr): TimeRange[] {
  const override = settings.dateOverrides[date];
  if (override) return override;
  if (!settings.acceptHolidays && settings.timezone === 'Asia/Tokyo' && japaneseHolidayName(date)) return [];
  return settings.weekly[weekdayOf(date)] ?? [];
}

/** 上限を数える期間のキー（カレンダーのタイムゾーンの日付から）。週は月曜始まり */
export function periodKey(date: DateStr, period: 'day' | 'week' | 'month'): string {
  if (period === 'day') return date;
  if (period === 'month') return date.slice(0, 7);
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function overlaps(a: Interval, busy: Interval[]): boolean {
  return busy.some((b) => b.start < a.end && a.start < b.end);
}

/** 受付時間帯から、候補になりうる枠の開始時刻（ms）を並べる */
function rawStarts(input: SlotInput): number[] {
  const { settings, now, from, to } = input;
  if (input.candidateStarts) {
    return input.candidateStarts.map((s) => new Date(s).getTime()).filter((t) => t >= now.getTime() && t >= from.getTime() && t < to.getTime());
  }
  const win = windowOf(settings, now);
  if (win.expired) return [];
  const interval = settings.slotIntervalMin ?? settings.durationMin;
  const tz = settings.timezone;
  // 求める範囲にかかる日付だけ見る（前後1日広げて、タイムゾーンのずれを吸収する）
  let date = addDays(zonedParts(from, tz).date, -1);
  const lastDate = addDays(zonedParts(to, tz).date, 1);
  const starts: number[] = [];
  for (; date <= lastDate; date = addDays(date, 1)) {
    if (date < win.startDate || date > win.endDate) continue;
    for (const r of rangesForDate(settings, date)) {
      const endMin = minutesOf(r.end);
      for (let m = minutesOf(r.start); m + settings.durationMin <= endMin; m += interval) {
        const t = zonedToUtc(date, timeOf(m), tz).getTime();
        if (t >= win.earliest && t >= from.getTime() && t < to.getTime()) starts.push(t);
      }
    }
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function isOverLimit(member: MemberInput, settings: SlotSettings, startMs: number): boolean {
  if (!settings.limit || member.limit === null) return false;
  const key = periodKey(zonedParts(new Date(startMs), settings.timezone).date, settings.limit.period);
  return (member.periodCounts.get(key) ?? 0) >= member.limit;
}

/** 1つの枠について、グループごとに空いているメンバーを求める。枠として成り立たなければ null */
function freeMembersFor(startMs: number, members: MemberInput[], settings: SlotSettings): string[][] | null {
  const end = startMs + settings.durationMin * 60_000;
  const block: Interval = { start: startMs - settings.bufferBeforeMin * 60_000, end: end + settings.bufferAfterMin * 60_000 };
  const isFree = (m: MemberInput) => !overlaps(block, m.busy) && !isOverLimit(m, settings, startMs);

  if (settings.participation === 'all') {
    return members.length > 0 && members.every(isFree) ? [members.map((m) => m.userId)] : null;
  }
  if (settings.participation === 'any') {
    const free = members.filter(isFree).map((m) => m.userId);
    return free.length > 0 ? [free] : null;
  }
  const g1 = members.filter((m) => m.group === 1 && isFree(m)).map((m) => m.userId);
  const g2 = members.filter((m) => m.group === 2 && isFree(m)).map((m) => m.userId);
  return g1.length > 0 && g2.length > 0 ? [g1, g2] : null;
}

/**
 * 空き枠を求める。
 * 「均等（担当件数優先）」（誰か1人方式のみ）は、担当件数が最も少ないメンバーの枠だけを出す。
 * その人たちに求める範囲の空きが無いときは、次に少ない人たちへ広げる（全員が空きなしで候補がゼロになるのを避ける）
 */
export function computeSlots(input: SlotInput): Slot[] {
  const { settings } = input;
  const starts = rawStarts(input);
  const build = (members: MemberInput[]): Slot[] => {
    const slots: Slot[] = [];
    for (const t of starts) {
      const free = freeMembersFor(t, members, settings);
      if (free) slots.push({ start: new Date(t).toISOString(), end: new Date(t + settings.durationMin * 60_000).toISOString(), freeByGroup: free });
    }
    return slots;
  };

  if (settings.participation === 'any' && settings.assignment === 'balanced_count') {
    const counts = [...new Set(input.members.map((m) => m.totalCount))].sort((a, b) => a - b);
    for (const c of counts) {
      const slots = build(input.members.filter((m) => m.totalCount <= c));
      if (slots.length > 0) return slots;
    }
    return [];
  }
  return build(input.members);
}

/**
 * 確定する枠の担当者を決める（docs/00「割り当て方法」）。
 * 全員方式は全員。それ以外はグループごとに1人: 優先度順なら優先度→件数、均等なら件数→優先度 の順に小さい人
 */
export function pickHosts(slot: Slot, members: MemberInput[], settings: Pick<SlotSettings, 'participation' | 'assignment'>): string[] {
  if (settings.participation === 'all') return slot.freeByGroup[0] ?? [];
  const byId = new Map(members.map((m) => [m.userId, m]));
  return slot.freeByGroup.map((ids) => {
    const sorted = ids
      .map((id) => byId.get(id))
      .filter((m): m is MemberInput => m !== undefined)
      .sort((a, b) =>
        settings.assignment === 'priority'
          ? a.priority - b.priority || a.totalCount - b.totalCount
          : a.totalCount - b.totalCount || a.priority - b.priority,
      );
    const first = sorted[0];
    if (!first) throw new Error('担当者を決められませんでした');
    return first.userId;
  });
}
