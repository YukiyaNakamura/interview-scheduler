/**
 * タイムゾーンつきの日時の計算。Worker（UTC で動く）とブラウザの両方で同じ結果になるよう、
 * Date のローカル時刻（getHours など）は使わず、Intl.DateTimeFormat でタイムゾーンを明示して計算する。
 * - DateStr: 'YYYY-MM-DD'（あるタイムゾーンでの日付）
 * - TimeStr: 'HH:MM'（あるタイムゾーンでの時刻。終了時刻だけ '24:00' を許す）
 */
export type DateStr = string;
export type TimeStr = string;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  date: DateStr;
  time: TimeStr;
  /** 0 = 日曜 */
  weekday: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** ある瞬間が、そのタイムゾーンで何日の何時何分か */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) p[part.type] = part.value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: WEEKDAY_INDEX[p.weekday ?? 'Sun'] ?? 0,
    year,
    month,
    day,
    hour,
    minute,
  };
}

/** そのタイムゾーンの UTC からのずれ（ミリ秒）。日本なら +9時間 */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const sec = instant.getUTCSeconds();
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, sec);
  return asUtc - (instant.getTime() - instant.getUTCMilliseconds());
}

/** 「そのタイムゾーンでの date time」を UTC の瞬間にする。夏時間の切り替えにも対応するため2回補正する */
export function zonedToUtc(date: DateStr, time: TimeStr, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(new Date(guess), timeZone);
  let result = guess - first;
  const second = offsetMs(new Date(result), timeZone);
  if (second !== first) result = guess - second;
  return new Date(result);
}

/** 'YYYY-MM-DD' に n 日足す（タイムゾーンに関係ない暦の計算） */
export function addDays(date: DateStr, n: number): DateStr {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' の曜日（0 = 日曜） */
export function weekdayOf(date: DateStr): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 2つの日付の差（日数）。b - a */
export function diffDays(a: DateStr, b: DateStr): number {
  const toMs = (s: DateStr) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(b) - toMs(a)) / 86_400_000);
}

/** 'HH:MM' → 0時からの分 */
export function minutesOf(time: TimeStr): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** 0時からの分 → 'HH:MM' */
export function timeOf(minutes: number): TimeStr {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** '2026年10月28日(水)' */
export function formatDateJa(instant: Date | string, timeZone: string): string {
  const p = zonedParts(new Date(instant), timeZone);
  return `${p.year}年${p.month}月${p.day}日(${WEEKDAY_JA[p.weekday]})`;
}

/** '2026年10月28日(水) 10:00〜11:00' */
export function formatRangeJa(start: Date | string, end: Date | string, timeZone: string): string {
  const s = zonedParts(new Date(start), timeZone);
  const e = zonedParts(new Date(end), timeZone);
  const endText = s.date === e.date ? e.time : `${e.month}/${e.day} ${e.time}`;
  return `${formatDateJa(start, timeZone)} ${s.time}〜${endText}`;
}

/** よく使うタイムゾーン（ゲスト画面の切り替え候補） */
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
  { id: 'Asia/Tokyo', label: '日本時間（Asia/Tokyo）' },
  { id: 'Asia/Seoul', label: 'ソウル（Asia/Seoul）' },
  { id: 'Asia/Shanghai', label: '中国（Asia/Shanghai）' },
  { id: 'Asia/Taipei', label: '台北（Asia/Taipei）' },
  { id: 'Asia/Singapore', label: 'シンガポール（Asia/Singapore）' },
  { id: 'Asia/Bangkok', label: 'バンコク（Asia/Bangkok）' },
  { id: 'Asia/Kolkata', label: 'インド（Asia/Kolkata）' },
  { id: 'Europe/London', label: 'ロンドン（Europe/London）' },
  { id: 'Europe/Paris', label: 'パリ（Europe/Paris）' },
  { id: 'America/New_York', label: 'ニューヨーク（America/New_York）' },
  { id: 'America/Los_Angeles', label: 'ロサンゼルス（America/Los_Angeles）' },
  { id: 'Australia/Sydney', label: 'シドニー（Australia/Sydney）' },
  { id: 'UTC', label: 'UTC' },
];
