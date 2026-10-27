/**
 * 曜日ごとの受付時間の編集（カレンダー編集とアカウント設定のデフォルト受付時間で使う）。
 * 1日 5 枠まで。時刻は 15 分刻みのセレクト（'24:00' も選べるように input type=time は使わない）。
 */
import { useState } from 'react';
import type { TimeRange, Weekly } from '../../shared/schema';
import { WEEKDAY_JA, minutesOf, timeOf } from '../../shared/time';

/** 月曜始まりで並べる（添字は 0 = 日曜のまま） */
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MAX_RANGES = 5;

function timeOptions(current: string[]): string[] {
  const list: string[] = [];
  for (let m = 0; m <= 24 * 60; m += 15) list.push(timeOf(m));
  for (const c of current) if (!list.includes(c)) list.push(c);
  return list.sort();
}

export function TimeSelect({ value, onChange, allowEnd = false }: { value: string; onChange: (v: string) => void; allowEnd?: boolean }) {
  const options = timeOptions([value]).filter((t) => allowEnd || t !== '24:00');
  return (
    <select className="input input-time" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/** 1日分の時間帯の編集 */
export function DayRangesEditor({ ranges, onChange }: { ranges: TimeRange[]; onChange: (r: TimeRange[]) => void }) {
  const update = (i: number, patch: Partial<TimeRange>) => onChange(ranges.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const add = () => {
    // 最後の枠の終わりから1時間の枠を足す（入りきらなければ 17:00〜18:00）
    const last = ranges[ranges.length - 1];
    const start = last ? Math.min(minutesOf(last.end) + 60, 23 * 60) : 10 * 60;
    onChange([...ranges, { start: timeOf(start), end: timeOf(Math.min(start + 60, 24 * 60)) }]);
  };
  return (
    <div className="ranges">
      {ranges.map((r, i) => (
        <div className="range-row" key={i}>
          <TimeSelect value={r.start} onChange={(v) => update(i, { start: v })} />
          <span className="range-sep">〜</span>
          <TimeSelect value={r.end} onChange={(v) => update(i, { end: v })} allowEnd />
          <button type="button" className="icon-btn" aria-label="この時間帯を削除" onClick={() => onChange(ranges.filter((_, n) => n !== i))}>
            ×
          </button>
          {r.start >= r.end && <span className="field-error inline">終了は開始より後に</span>}
        </div>
      ))}
      {ranges.length < MAX_RANGES && (
        <button type="button" className="link-btn" onClick={add}>
          ＋ 時間帯を追加
        </button>
      )}
    </div>
  );
}

export function WeeklyEditor({ value, onChange }: { value: Weekly; onChange: (w: Weekly) => void }) {
  // 「他の曜日にコピー」を開いている曜日と、コピー先の選択
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTo, setCopyTo] = useState<number[]>([]);

  const setDay = (day: number, ranges: TimeRange[]) => onChange(value.map((r, i) => (i === day ? ranges : r)));

  return (
    <div className="weekly">
      {DISPLAY_ORDER.map((day) => {
        const ranges = value[day] ?? [];
        const open = ranges.length > 0;
        return (
          <div className={open ? 'weekly-row' : 'weekly-row off'} key={day}>
            <label className="weekly-day">
              <input type="checkbox" checked={open} onChange={(e) => setDay(day, e.target.checked ? [{ start: '10:00', end: '18:00' }] : [])} />
              <span className={day === 0 ? 'wd sun' : day === 6 ? 'wd sat' : 'wd'}>{WEEKDAY_JA[day]}</span>
            </label>
            <div className="weekly-body">
              {open ? <DayRangesEditor ranges={ranges} onChange={(r) => setDay(day, r)} /> : <span className="muted">受け付けない</span>}
              {copyFrom === day && (
                <div className="copy-panel">
                  <div className="muted small">コピー先の曜日（今の設定は上書きされます）</div>
                  <div className="chip-row">
                    {DISPLAY_ORDER.filter((d) => d !== day).map((d) => (
                      <label key={d} className="chip-check">
                        <input
                          type="checkbox"
                          checked={copyTo.includes(d)}
                          onChange={(e) => setCopyTo(e.target.checked ? [...copyTo, d] : copyTo.filter((x) => x !== d))}
                        />
                        {WEEKDAY_JA[d]}
                      </label>
                    ))}
                  </div>
                  <div className="row-gap">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={copyTo.length === 0}
                      onClick={() => {
                        onChange(value.map((r, i) => (copyTo.includes(i) ? ranges.map((x) => ({ ...x })) : r)));
                        setCopyFrom(null);
                      }}
                    >
                      適用
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCopyFrom(null)}>
                      やめる
                    </button>
                  </div>
                </div>
              )}
            </div>
            {copyFrom !== day && (
              <button
                type="button"
                className="link-btn weekly-copy"
                onClick={() => {
                  setCopyFrom(day);
                  setCopyTo([]);
                }}
              >
                他の曜日にコピー
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
