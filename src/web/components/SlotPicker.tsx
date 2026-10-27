/**
 * ゲストが日程候補を選ぶ週表示（日程調整ページと予定確認ページのリスケで使う）。
 * 表示中のタイムゾーンで「週の7日間」を決め、その範囲の空き枠を API から取る。
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { SlotsResponse } from '../../shared/api';
import { WEEKDAY_JA, addDays, weekdayOf, zonedParts, zonedToUtc } from '../../shared/time';
import { apiGet } from '../lib/api';
import { TimezoneSelect } from './TimezoneSelect';
import { ErrorBox, Spinner } from './ui';

export interface Slot {
  start: string;
  end: string;
}

export function SlotPicker({
  slug,
  timezone,
  onTimezoneChange,
  window: win,
  ot,
  reschedule,
  password,
  selectedStart,
  onSelect,
}: {
  slug: string;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  /** 提示期間（PublicCalendar.window）。null なら制限なし */
  window: { start: string; end: string } | null;
  ot?: string | null;
  reschedule?: string | null;
  password?: string | null;
  selectedStart?: string | null;
  onSelect: (slot: Slot) => void;
}) {
  const today = zonedParts(new Date(), timezone).date;
  const minStart = win && win.start > today ? win.start : today;
  const [weekStart, setWeekStart] = useState(minStart);

  // タイムゾーンを変えて「今日」が変わったときなど、表示中の週が最小より前にならないようにする
  useEffect(() => {
    if (weekStart < minStart) setWeekStart(minStart);
  }, [minStart, weekStart]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const from = zonedToUtc(weekStart, '00:00', timezone).toISOString();
  const to = zonedToUtc(addDays(weekStart, 7), '00:00', timezone).toISOString();

  const params = new URLSearchParams({ from, to });
  if (ot) params.set('ot', ot);
  if (reschedule) params.set('reschedule', reschedule);
  const headers: Record<string, string> = password ? { 'x-calendar-password': password } : {};

  const slotsQuery = useQuery({
    queryKey: ['slots', slug, from, to, ot ?? '', reschedule ?? '', password ?? ''],
    queryFn: () => apiGet<SlotsResponse>(`/api/public/c/${encodeURIComponent(slug)}/slots?${params.toString()}`, headers),
  });

  // 日付ごとに枠をまとめる（表示中のタイムゾーンの日付）
  const byDate = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slotsQuery.data?.slots ?? []) {
      const d = zonedParts(new Date(s.start), timezone).date;
      const list = map.get(d) ?? [];
      list.push(s);
      map.set(d, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [slotsQuery.data, timezone]);

  const total = slotsQuery.data?.slots.length ?? 0;
  const canPrev = weekStart > minStart;
  const canNext = win === null || addDays(weekStart, 7) <= win.end;
  const [y, m] = weekStart.split('-').map(Number) as [number, number];
  const lastDay = days[6] ?? weekStart;

  return (
    <div className="slot-picker">
      <div className="slot-toolbar">
        <div className="slot-nav">
          <button type="button" className="icon-btn nav-arrow" aria-label="前の週" disabled={!canPrev} onClick={() => setWeekStart(addDays(weekStart, -7) < minStart ? minStart : addDays(weekStart, -7))}>
            ‹
          </button>
          <div className="slot-range">
            {y}年{m}月{Number(weekStart.slice(8))}日〜{Number(lastDay.slice(5, 7))}月{Number(lastDay.slice(8))}日
          </div>
          <button type="button" className="icon-btn nav-arrow" aria-label="次の週" disabled={!canNext} onClick={() => setWeekStart(addDays(weekStart, 7))}>
            ›
          </button>
        </div>
        <label className="slot-tz">
          <span className="muted small">タイムゾーン</span>
          <TimezoneSelect value={timezone} onChange={onTimezoneChange} className="input input-sm" />
        </label>
      </div>

      {slotsQuery.isLoading && <Spinner label="空き日程を確認しています…" />}
      {slotsQuery.error && <ErrorBox error={slotsQuery.error} />}

      {slotsQuery.data && (
        <>
          <div className="slot-grid">
            {days.map((d) => {
              const wd = weekdayOf(d);
              const list = byDate.get(d) ?? [];
              return (
                <div className={list.length === 0 ? 'slot-col empty' : 'slot-col'} key={d}>
                  <div className={wd === 0 ? 'slot-day sun' : wd === 6 ? 'slot-day sat' : 'slot-day'}>
                    <span className="slot-date">
                      {Number(d.slice(5, 7))}/{Number(d.slice(8))}
                    </span>
                    <span className="slot-wd">({WEEKDAY_JA[wd]})</span>
                  </div>
                  <div className="slot-list">
                    {list.length === 0 && <span className="slot-none">—</span>}
                    {list.map((s) => (
                      <button
                        type="button"
                        key={s.start}
                        className={selectedStart === s.start ? 'slot-btn selected' : 'slot-btn'}
                        onClick={() => onSelect(s)}
                      >
                        {zonedParts(new Date(s.start), timezone).time}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {total === 0 && (
            <div className="slot-empty">
              この週に選べる日程はありません
              {canNext && (
                <button type="button" className="btn btn-sm" onClick={() => setWeekStart(addDays(weekStart, 7))}>
                  次の週を見る
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
