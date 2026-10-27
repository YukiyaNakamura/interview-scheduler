/**
 * 日本の祝日（振替休日・国民の休日を含む）。docs/00「祝日の予約受付」。
 * ライブラリの isHoliday は実行環境のローカル時刻で日付を判定するため使わず、年ごとの一覧から 'YYYY-MM-DD' の集合を作る
 */
import JapaneseHolidays from 'japanese-holidays';
import type { DateStr } from './time';

const cache = new Map<number, Map<DateStr, string>>();

function holidaysOf(year: number): Map<DateStr, string> {
  let map = cache.get(year);
  if (!map) {
    map = new Map();
    for (const h of JapaneseHolidays.getHolidaysOf(year)) {
      map.set(`${year}-${String(h.month).padStart(2, '0')}-${String(h.date).padStart(2, '0')}`, h.name);
    }
    cache.set(year, map);
  }
  return map;
}

/** 祝日ならその名前、祝日でなければ undefined */
export function japaneseHolidayName(date: DateStr): string | undefined {
  return holidaysOf(Number(date.slice(0, 4))).get(date);
}
