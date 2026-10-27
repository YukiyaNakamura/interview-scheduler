/** カレンダー編集「受付時間」: 曜日ごと・特定の日・タイムゾーン・祝日・表示間隔 */
import { useState } from 'react';
import { WEEKDAY_JA, weekdayOf } from '../../../shared/time';
import { DayRangesEditor, WeeklyEditor } from '../WeeklyEditor';
import { TimezoneSelect } from '../TimezoneSelect';
import { Field, Toggle } from '../ui';
import { NumberInput } from './BasicTab';
import type { EditorProps } from './types';

const PRESET_INTERVALS = [15, 30, 60, 120];

export function HoursTab({ draft, setSettings, issue }: EditorProps) {
  const s = draft.settings;
  const [newDate, setNewDate] = useState('');
  const overrides = Object.entries(s.dateOverrides).sort(([a], [b]) => a.localeCompare(b));
  const intervalMode = s.slotIntervalMin === null ? 'auto' : PRESET_INTERVALS.includes(s.slotIntervalMin) ? String(s.slotIntervalMin) : 'custom';

  const setOverride = (date: string, ranges: { start: string; end: string }[] | undefined) => {
    const next = { ...s.dateOverrides };
    if (ranges === undefined) delete next[date];
    else next[date] = ranges;
    setSettings({ dateOverrides: next });
  };

  return (
    <div className="tab-body">
      <section className="section">
        <h2>曜日ごとの受付時間</h2>
        <p className="muted small">1日に5枠まで設定できます。連携カレンダーに予定が入っている時間は自動で候補から外れます。</p>
        <WeeklyEditor value={s.weekly} onChange={(weekly) => setSettings({ weekly })} />
        {issue('settings.weekly') && <div className="field-error">{issue('settings.weekly')}</div>}
      </section>

      <section className="section">
        <h2>特定の日の受付時間</h2>
        <p className="muted small">指定した日は曜日ごとの設定より優先されます。</p>
        <div className="row-gap wrap">
          <input className="input input-date" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
          <button
            type="button"
            className="btn btn-sm"
            disabled={newDate === '' || newDate in s.dateOverrides}
            onClick={() => {
              // 追加した日は、その曜日の設定を初期値にする
              setOverride(newDate, (s.weekly[weekdayOf(newDate)] ?? []).map((r) => ({ ...r })));
              setNewDate('');
            }}
          >
            日付を追加
          </button>
        </div>
        {overrides.length > 0 && (
          <div className="overrides">
            {overrides.map(([date, ranges]) => (
              <div className="override-row" key={date}>
                <div className="override-date">
                  <span className="strong">
                    {date.replaceAll('-', '/')}（{WEEKDAY_JA[weekdayOf(date)]}）
                  </span>
                  <Toggle checked={ranges.length > 0} onChange={(on) => setOverride(date, on ? [{ start: '10:00', end: '18:00' }] : [])} label={ranges.length > 0 ? '受け付ける' : '受け付けない'} />
                </div>
                <div className="override-body">{ranges.length > 0 && <DayRangesEditor ranges={ranges} onChange={(r) => setOverride(date, r)} />}</div>
                <button type="button" className="icon-btn" aria-label="この日の設定を削除" onClick={() => setOverride(date, undefined)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {issue('settings.dateOverrides') && <div className="field-error">{issue('settings.dateOverrides')}</div>}
      </section>

      <section className="section">
        <h2>その他</h2>
        <Field label="タイムゾーン" hint="受付時間・提示期間・受付件数の上限の基準になります" error={issue('settings.timezone')}>
          <TimezoneSelect value={s.timezone} onChange={(timezone) => setSettings({ timezone })} />
        </Field>
        <Field label="祝日の予約受付" hint="日本の祝日（タイムゾーンが Asia/Tokyo のときのみ）">
          <Toggle checked={s.acceptHolidays} onChange={(v) => setSettings({ acceptHolidays: v })} label={s.acceptHolidays ? '祝日も受け付ける' : '祝日は受け付けない'} />
        </Field>
        <Field label="日程候補の表示間隔" hint="候補の開始時刻をどれくらいの間隔で並べるか。各候補の長さは所要時間のまま" error={issue('settings.slotIntervalMin')}>
          <div className="row-gap wrap">
            <select
              className="input"
              value={intervalMode}
              onChange={(e) => {
                const v = e.target.value;
                setSettings({ slotIntervalMin: v === 'auto' ? null : v === 'custom' ? 45 : Number(v) });
              }}
            >
              <option value="auto">自動（所要時間と同じ）</option>
              {PRESET_INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {n}分
                </option>
              ))}
              <option value="custom">カスタム</option>
            </select>
            {intervalMode === 'custom' && <NumberInput value={s.slotIntervalMin ?? 45} min={10} max={120} suffix="分" onChange={(n) => setSettings({ slotIntervalMin: n })} />}
          </div>
        </Field>
      </section>
    </div>
  );
}
