/** カレンダー編集「基本設定」: 名前・URL・所要時間・確保時間・参加方式・メンバー・Web会議 */
import { ASSIGNMENT_LABELS, LOCATION_LABELS, LOCATION_TYPES, PARTICIPATION_LABELS, UNSUPPORTED_LOCATIONS, type CalendarSettings } from '../../../shared/schema';
import { Link } from 'react-router';
import { Avatar, Field, Toggle } from '../ui';
import type { EditorProps } from './types';

const MAX_MEMBERS = 12;

export function NumberInput({ value, onChange, min, max, suffix, id }: { value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string; id?: string }) {
  return (
    <span className="num-input">
      <input id={id} className="input input-num" type="number" inputMode="numeric" value={Number.isFinite(value) ? value : ''} min={min} max={max} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  );
}

/** 場所（Web会議・電話・対面など）の選択。候補を選んで日程調整の作成画面でも使う */
export function LocationFields({ value, onChange }: { value: CalendarSettings['location']; onChange: (v: CalendarSettings['location']) => void }) {
  const needsDetail = value.type === 'phone' || value.type === 'in_person' || value.type === 'custom';
  const placeholder = value.type === 'phone' ? '例: 当日 03-xxxx-xxxx からお電話します' : value.type === 'in_person' ? '例: 東京都千代田区… ○○ビル 5F' : '場所や参加方法';
  return (
    <div className="stack-sm">
      <select className="input" value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as CalendarSettings['location']['type'] })}>
        {LOCATION_TYPES.map((t) => (
          <option key={t} value={t} disabled={UNSUPPORTED_LOCATIONS.includes(t)}>
            {LOCATION_LABELS[t]}
            {UNSUPPORTED_LOCATIONS.includes(t) ? '（近日対応）' : ''}
          </option>
        ))}
      </select>
      {needsDetail && <input className="input" placeholder={placeholder} value={value.detail} onChange={(e) => onChange({ ...value, detail: e.target.value })} />}
      {value.type === 'google_meet' && <div className="field-hint">日程が確定すると、担当者の Google カレンダーに予定を登録し Meet の URL を自動で発行します（Google カレンダー連携が必要）。</div>}
    </div>
  );
}

export function BasicTab({ draft, setDraft, setSettings, members, issue }: EditorProps) {
  const s = draft.settings;
  const selected = new Map(draft.members.map((m) => [m.memberId, m]));
  const showAssignment = s.participation !== 'all';
  const showPriority = showAssignment && s.assignment === 'priority';

  const toggleMember = (memberId: string, on: boolean) => {
    if (on) {
      if (draft.members.length >= MAX_MEMBERS) return;
      const priority = draft.members.reduce((max, m) => Math.max(max, m.priority + 1), 0);
      setDraft({ members: [...draft.members, { memberId, group: 1, priority, bookingLimit: null }] });
    } else {
      setDraft({ members: draft.members.filter((m) => m.memberId !== memberId) });
    }
  };
  const patchMember = (memberId: string, patch: Partial<(typeof draft.members)[number]>) =>
    setDraft({ members: draft.members.map((m) => (m.memberId === memberId ? { ...m, ...patch } : m)) });

  const setParticipation = (p: CalendarSettings['participation']) => {
    // 「均等（担当件数優先）」は誰か1人方式のみ
    const assignment = p !== 'any' && s.assignment === 'balanced_count' ? 'balanced_slot' : s.assignment;
    setSettings({ participation: p, assignment });
  };

  return (
    <div className="tab-body">
      <section className="section">
        <h2>カレンダー</h2>
        <Field label="日程調整カレンダー名" required hint="応募者に表示されます" error={issue('name')}>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ name: e.target.value })} />
        </Field>
        <Field label="非公開カレンダー名" hint="ホストだけが見る管理用の名前（任意）" error={issue('internalName')}>
          <input className="input" value={draft.internalName} onChange={(e) => setDraft({ internalName: e.target.value })} />
        </Field>
        <Field label="URL" error={issue('slug')} hint="半角英小文字・数字・ハイフン（3〜64文字）">
          <div className="url-input">
            <span className="url-prefix">{window.location.origin}/c/</span>
            <input className="input" value={draft.slug} onChange={(e) => setDraft({ slug: e.target.value.toLowerCase() })} />
          </div>
        </Field>
        <Field label="受付状況">
          <Toggle checked={draft.status === 'open'} onChange={(v) => setDraft({ status: v ? 'open' : 'closed' })} label={draft.status === 'open' ? '受付中' : '受付停止中'} />
        </Field>
      </section>

      <section className="section">
        <h2>時間</h2>
        <div className="grid-2">
          <Field label="所要時間" hint="15〜480分" error={issue('settings.durationMin')}>
            <NumberInput value={s.durationMin} min={15} max={480} suffix="分" onChange={(n) => setSettings({ durationMin: n })} />
          </Field>
          <div />
          <Field label="前の確保時間" hint="0〜180分。準備・移動のための時間" error={issue('settings.bufferBeforeMin')}>
            <NumberInput value={s.bufferBeforeMin} min={0} max={180} suffix="分" onChange={(n) => setSettings({ bufferBeforeMin: n })} />
          </Field>
          <Field label="後の確保時間" hint="0〜180分" error={issue('settings.bufferAfterMin')}>
            <NumberInput value={s.bufferAfterMin} min={0} max={180} suffix="分" onChange={(n) => setSettings({ bufferAfterMin: n })} />
          </Field>
        </div>
        {(s.bufferBeforeMin > 0 || s.bufferAfterMin > 0) && (
          <Field label="確保時間の予定名" hint="連携カレンダーに登録する確保時間の予定の名前" error={issue('settings.bufferEventTitle')}>
            <input className="input" value={s.bufferEventTitle} onChange={(e) => setSettings({ bufferEventTitle: e.target.value })} />
          </Field>
        )}
      </section>

      <section className="section">
        <h2>参加メンバー</h2>
        <Field label="参加方式">
          <div className="radio-cards">
            {(Object.keys(PARTICIPATION_LABELS) as CalendarSettings['participation'][]).map((p) => (
              <label key={p} className={s.participation === p ? 'radio-card active' : 'radio-card'}>
                <input type="radio" name="participation" checked={s.participation === p} onChange={() => setParticipation(p)} />
                <span className="strong">{PARTICIPATION_LABELS[p]}</span>
                <span className="muted small">
                  {p === 'all' && '全員が空いている日時だけを候補にします'}
                  {p === 'any' && '1人でも空いていれば候補にし、確定時に1人を割り当てます'}
                  {p === 'groups' && 'グループ A・B それぞれに空きがある日時を候補にし、各グループから1人ずつ割り当てます'}
                </span>
              </label>
            ))}
          </div>
        </Field>
        {showAssignment && (
          <Field label="割り当て方法" error={issue('settings.assignment')}>
            <select className="input" value={s.assignment} onChange={(e) => setSettings({ assignment: e.target.value as CalendarSettings['assignment'] })}>
              {(Object.keys(ASSIGNMENT_LABELS) as CalendarSettings['assignment'][])
                .filter((a) => a !== 'balanced_count' || s.participation === 'any')
                .map((a) => (
                  <option key={a} value={a}>
                    {ASSIGNMENT_LABELS[a]}
                  </option>
                ))}
            </select>
            <div className="field-hint">
              {s.assignment === 'balanced_slot' && '選ばれた日時に空いている人のうち、このカレンダーでの担当件数が最も少ない人に割り当てます。'}
              {s.assignment === 'balanced_count' && '担当件数が最も少ない人の空き日時だけを応募者に見せます。'}
              {s.assignment === 'priority' && '空いている人のうち、優先度（数字が小さいほど優先）が最も高い人に割り当てます。'}
            </div>
          </Field>
        )}
        <Field label={`メンバー（${draft.members.length}/${MAX_MEMBERS}人）`} error={issue('members')}>
          {members.length === 0 && (
            <div className="muted small">
              メンバーが登録されていません。<Link to="/admin/members">メンバー（面接官）を登録</Link>してください。
            </div>
          )}
          <div className="member-pick">
            {members.map((m) => {
              const sel = selected.get(m.id);
              return (
                <div className={sel ? 'member-row selected' : 'member-row'} key={m.id}>
                  <label className="member-main">
                    <input type="checkbox" checked={sel !== undefined} disabled={!sel && draft.members.length >= MAX_MEMBERS} onChange={(e) => toggleMember(m.id, e.target.checked)} />
                    <Avatar name={m.name} />
                    <span>
                      <span className="strong">{m.name}</span>
                      <span className="muted small block">
                        {m.email}
                        {m.connections.length === 0 && ' ・カレンダー未連携'}
                      </span>
                    </span>
                  </label>
                  {sel && s.participation === 'groups' && (
                    <select className="input input-sm" value={sel.group} onChange={(e) => patchMember(m.id, { group: Number(e.target.value) as 1 | 2 })} aria-label="グループ">
                      <option value={1}>グループ A</option>
                      <option value={2}>グループ B</option>
                    </select>
                  )}
                  {sel && showPriority && (
                    <label className="inline-label">
                      優先度
                      <NumberInput value={sel.priority} min={0} max={100} onChange={(n) => patchMember(m.id, { priority: n })} />
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        </Field>
      </section>

      <section className="section">
        <h2>場所・Web会議</h2>
        <Field label="Web会議・場所" error={issue('settings.location')}>
          <LocationFields value={s.location} onChange={(location) => setSettings({ location })} />
        </Field>
        {s.location.type === 'google_meet' && (
          <Toggle checked={s.hideMeetingUrl} onChange={(v) => setSettings({ hideMeetingUrl: v })} label="応募者に Web 会議 URL を表示しない（面接官から個別に案内する）" />
        )}
      </section>
    </div>
  );
}
