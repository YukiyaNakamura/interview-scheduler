/** 画面の表示用の小さな関数（文字の整形・クリップボード） */
import { formatDateJa, zonedParts } from '../../shared/time';

/** 60 → '60分'、90 → '1時間30分' */
export function formatDuration(min: number): string {
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/** ISO → '10/28 10:00'（一覧の短い表示） */
export function formatShort(iso: string, timeZone: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  return `${p.month}/${p.day} ${p.time}`;
}

/** ISO → '2026年10月28日(水) 10:00' */
export function formatDateTimeJa(iso: string, timeZone: string): string {
  return `${formatDateJa(iso, timeZone)} ${zonedParts(new Date(iso), timeZone).time}`;
}

/** ブラウザのタイムゾーン（取れなければ日本時間） */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Tokyo';
  } catch {
    return 'Asia/Tokyo';
  }
}

/** 名前の頭文字（アバター画像がないときの表示） */
export function initials(name: string): string {
  const t = name.trim();
  return t === '' ? '?' : t.slice(0, 1).toUpperCase();
}

/** クリップボードにコピーする。古いブラウザや http では textarea を使うやり方に切り替える */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

/** 乱数の短い ID（質問の追加など） */
export function shortId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
