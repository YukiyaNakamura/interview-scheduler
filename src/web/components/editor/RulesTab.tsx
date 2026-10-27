/** カレンダー編集「提示期間・受付ルール」: 提示期間・受付件数の上限・キャンセル期限・主催者に知らせる */
import { addDays, zonedParts } from '../../../shared/time';
import { Field, Toggle } from '../ui';
import { NumberInput } from './BasicTab';
import type { EditorProps } from './types';

const PERIOD_LABELS = { day: '1日あたり', week: '1週間あたり（月〜日）', month: '1か月あたり' } as const;

export function RulesTab({ draft, setDraft, setSettings, members, issue }: EditorProps) {
  const s = draft.settings;
  const w = s.window;
  const today = zonedParts(new Date(), s.timezone).date;
  const nameOf = (memberId: string) => members.find((m) => m.id === memberId)?.name ?? '（削除されたメンバー）';

  return (
    <div className="tab-body">
      <section className="section">
        <h2>提示期間</h2>
        <div className="radio-row">
          <label className="radio">
            <input type="radio" checked={w.mode === 'auto'} onChange={() => setSettings({ window: { mode: 'auto', minNoticeHours: w.minNoticeHours, daysAhead: 30 } })} />
            自動で設定
          </label>
          <label className="radio">
            <input
              type="radio"
              checked={w.mode === 'fixed'}
              onChange={() => setSettings({ window: { mode: 'fixed', startDate: today, endDate: addDays(today, 30), minNoticeHours: w.minNoticeHours } })}
            />
            日付を指定
          </label>
        </div>
        {w.mode === 'auto' ? (
          <div className="grid-2">
            <Field label="何時間後から先の日程候補を提示しますか？" hint="0〜720時間" error={issue('settings.window.minNoticeHours')}>
              <NumberInput value={w.minNoticeHours} min={0} max={720} suffix="時間後から" onChange={(n) => setSettings({ window: { ...w, minNoticeHours: n } })} />
            </Field>
            <Field label="何日間分の日程候補を提示しますか？" hint="1〜200日（今日を1日目として数えます）" error={issue('settings.window.daysAhead')}>
              <NumberInput value={w.daysAhead} min={1} max={200} suffix="日間" onChange={(n) => setSettings({ window: { ...w, daysAhead: n } })} />
            </Field>
          </div>
        ) : (
          <div className="grid-2">
            <Field label="開始日" error={issue('settings.window.startDate')}>
              <input className="input" type="date" value={w.startDate} onChange={(e) => setSettings({ window: { ...w, startDate: e.target.value } })} />
            </Field>
            <Field label="終了日" hint="開始日から200日以内" error={issue('settings.window.endDate') ?? issue('settings.window')}>
              <input className="input" type="date" value={w.endDate} min={w.startDate} max={addDays(w.startDate, 200)} onChange={(e) => setSettings({ window: { ...w, endDate: e.target.value } })} />
            </Field>
            <Field label="各日程候補開始時刻の何時間前に予約を締め切りますか？" hint="0〜720時間" error={issue('settings.window.minNoticeHours')}>
              <NumberInput value={w.minNoticeHours} min={0} max={720} suffix="時間前" onChange={(n) => setSettings({ window: { ...w, minNoticeHours: n } })} />
            </Field>
          </div>
        )}
      </section>

      <section className="section">
        <h2>予約受付件数の上限</h2>
        <Toggle
          checked={s.limit !== null}
          onChange={(on) => setSettings({ limit: on ? { period: 'day', mode: 'uniform', count: 3 } : null })}
          label="上限を設定する"
        />
        {s.limit && (
          <div className="stack">
            <p className="muted small">確定した予定の開催日時で数えます。「誰か1人が参加」ではメンバーごとに数え、上限に達した人の枠だけ候補から外れます。</p>
            <div className="grid-2">
              <Field label="期間">
                <select className="input" value={s.limit.period} onChange={(e) => s.limit && setSettings({ limit: { ...s.limit, period: e.target.value as 'day' | 'week' | 'month' } })}>
                  {(Object.keys(PERIOD_LABELS) as (keyof typeof PERIOD_LABELS)[]).map((p) => (
                    <option key={p} value={p}>
                      {PERIOD_LABELS[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="設定方法">
                <select className="input" value={s.limit.mode} onChange={(e) => s.limit && setSettings({ limit: { ...s.limit, mode: e.target.value as 'uniform' | 'per_member' } })}>
                  <option value="uniform">全員一律に設定</option>
                  <option value="per_member">メンバー毎に設定</option>
                </select>
              </Field>
            </div>
            {s.limit.mode === 'uniform' ? (
              <Field label="上限件数" error={issue('settings.limit')}>
                <NumberInput value={s.limit.count} min={1} max={1000} suffix="件まで" onChange={(n) => s.limit && setSettings({ limit: { ...s.limit, count: n } })} />
              </Field>
            ) : (
              <div className="per-member">
                {draft.members.map((m) => (
                  <div className="row-gap" key={m.memberId}>
                    <span className="grow">{nameOf(m.memberId)}</span>
                    <NumberInput
                      value={m.bookingLimit ?? s.limit?.count ?? 1}
                      min={1}
                      max={1000}
                      suffix="件まで"
                      onChange={(n) => setDraft({ members: draft.members.map((x) => (x.memberId === m.memberId ? { ...x, bookingLimit: n } : x)) })}
                    />
                  </div>
                ))}
                <div className="field-hint">未入力のメンバーには「{s.limit.count}件」が使われます。</div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="section">
        <h2>キャンセル・リスケジュール</h2>
        <Toggle checked={s.allowGuestCancel} onChange={(v) => setSettings({ allowGuestCancel: v })} label="応募者がキャンセルできる" />
        <Toggle checked={s.allowGuestReschedule} onChange={(v) => setSettings({ allowGuestReschedule: v })} label="応募者が日程変更（リスケジュール）できる" />
        <Toggle
          checked={s.cancelDeadlineHours !== null}
          onChange={(on) => setSettings({ cancelDeadlineHours: on ? 24 : null })}
          label="期限を設定する（未設定なら予定の終了時刻まで操作できます）"
        />
        {s.cancelDeadlineHours !== null && (
          <Field label="予定開始の何時間前まで受け付けますか？" hint="0〜720時間" error={issue('settings.cancelDeadlineHours')}>
            <NumberInput value={s.cancelDeadlineHours} min={0} max={720} suffix="時間前まで" onChange={(n) => setSettings({ cancelDeadlineHours: n })} />
          </Field>
        )}
      </section>

      <section className="section">
        <h2>都合の良い日程がない場合</h2>
        <Toggle checked={s.notifyNoSlot} onChange={(v) => setSettings({ notifyNoSlot: v })} label="「主催者に知らせる」を表示する（応募者が希望を書いて送れます）" />
      </section>
    </div>
  );
}
