/**
 * 候補を選んで日程調整。メンバーの空き状況を見ながら候補枠（最大 20）をクリックで選び、1回限りの URL を作る。
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { AvailabilityInput, AvailabilityResponse, CalendarDetail, CandidateCalendarInput } from '../../shared/api';
import type { CalendarSettings } from '../../shared/schema';
import { WEEKDAY_JA, addDays, formatRangeJa, weekdayOf, zonedParts, zonedToUtc } from '../../shared/time';
import { apiPost } from '../lib/api';
import { browserTimeZone } from '../lib/format';
import { useMembers } from '../lib/hooks';
import { NoMembersCallout } from '../components/NoMembersCallout';
import { LocationFields, NumberInput } from '../components/editor/BasicTab';
import { Avatar, CopyButton, ErrorBox, Field, Spinner, Toggle } from '../components/ui';

const MAX_SLOTS = 20;
const MAX_MEMBERS = 3;

export function CandidatesNewPage() {
  const membersQuery = useMembers();
  const allMembers = membersQuery.data ?? [];
  // 候補の表は管理者のブラウザのタイムゾーンで表示する
  const tz = browserTimeZone();
  const today = zonedParts(new Date(), tz).date;

  const [name, setName] = useState('面接');
  const [durationMin, setDuration] = useState(60);
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [location, setLocation] = useState<CalendarSettings['location']>({ type: 'google_meet', detail: '' });
  const [eventPrivate, setEventPrivate] = useState(false);
  const [weekStart, setWeekStart] = useState(today);
  const [selected, setSelected] = useState<string[]>([]);
  const [created, setCreated] = useState<CalendarDetail | null>(null);

  // 最初は登録順で先頭のメンバーを選んだ状態にする
  const members = memberIds ?? (allMembers[0] ? [allMembers[0].id] : []);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const input: AvailabilityInput = {
    memberIds: members,
    durationMin,
    from: zonedToUtc(weekStart, '00:00', tz).toISOString(),
    to: zonedToUtc(addDays(weekStart, 7), '00:00', tz).toISOString(),
    timezone: tz,
  };
  const validDuration = Number.isFinite(durationMin) && durationMin >= 15 && durationMin <= 480;

  const availability = useQuery({
    queryKey: ['availability', input],
    queryFn: () => apiPost<AvailabilityResponse>('/api/admin/availability', input),
    enabled: members.length > 0 && validDuration,
  });

  // 表の形にする: 時刻（行）× 日付（列）
  const grid = useMemo(() => {
    const times = new Set<string>();
    const cell = new Map<string, { start: string; available: boolean }>();
    for (const s of availability.data?.slots ?? []) {
      const p = zonedParts(new Date(s.start), tz);
      times.add(p.time);
      cell.set(`${p.date} ${p.time}`, { start: s.start, available: s.available });
    }
    return { times: [...times].sort(), cell };
  }, [availability.data, tz]);

  const create = useMutation({
    mutationFn: (body: CandidateCalendarInput) => apiPost<CalendarDetail>('/api/admin/candidate-calendars', body),
    onSuccess: setCreated,
  });

  const toggleSlot = (start: string) => {
    if (selected.includes(start)) setSelected(selected.filter((s) => s !== start));
    else if (selected.length < MAX_SLOTS) setSelected([...selected, start].sort());
  };

  const endOf = (start: string) => new Date(new Date(start).getTime() + durationMin * 60_000);

  if (created) {
    const lines = selected.map((s) => `・${formatRangeJa(s, endOf(s), tz)}`);
    const text = `お世話になっております。\n${name}の日程につきまして、下記の候補からご都合のよい日時をお選びください。\n\n${lines.join('\n')}\n\n▼日程調整はこちらから\n${created.url}\n\nどうぞよろしくお願いいたします。`;
    return (
      <div className="page narrow">
        <div className="card center-card">
          <div className="done-mark" aria-hidden="true">
            ✓
          </div>
          <h1>日程調整ページを作成しました</h1>
          <p className="muted">この URL は1回限りです。1人目の応募者が日程を確定すると受付を終了します。</p>
          <div className="share-url">
            <code>{created.url}</code>
            <CopyButton text={created.url} label="URLをコピー" className="btn btn-sm btn-primary" />
          </div>
        </div>
        <section className="card">
          <h2>そのまま送れる文面</h2>
          <textarea className="input" rows={lines.length + 9} readOnly value={text} />
          <CopyButton text={text} label="文面をコピー" />
        </section>
        <div className="row-gap">
          <Link className="btn" to="/admin">
            一覧へ戻る
          </Link>
          <Link className="btn btn-ghost" to={`/admin/calendars/${created.id}`}>
            設定を開く
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link className="back-link" to="/admin">
            ‹ 日程調整カレンダー一覧
          </Link>
          <h1>候補を選んで日程調整</h1>
          <p className="muted">メンバーの空き状況を見ながら候補を最大{MAX_SLOTS}枠選び、1回限りの日程調整 URL を作ります。</p>
        </div>
      </div>

      {membersQuery.data && allMembers.length === 0 && <NoMembersCallout />}

      <div className="cand-layout">
        <section className="card cand-form">
          <Field label="予定名" required>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="所要時間" hint="15〜480分">
            <NumberInput value={durationMin} min={15} max={480} suffix="分" onChange={(n) => (setDuration(n), setSelected([]))} />
          </Field>
          <Field label={`参加メンバー（全員参加・${MAX_MEMBERS}人まで）`}>
            <div className="member-pick compact">
              {allMembers.map((m) => {
                const on = members.includes(m.id);
                return (
                  <label className={on ? 'member-row selected' : 'member-row'} key={m.id}>
                    <span className="member-main">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && members.length >= MAX_MEMBERS}
                        onChange={(e) => {
                          setMemberIds(e.target.checked ? [...members, m.id] : members.filter((x) => x !== m.id));
                          setSelected([]);
                        }}
                      />
                      <Avatar name={m.name} size={24} />
                      {m.name}
                    </span>
                  </label>
                );
              })}
            </div>
          </Field>
          <Field label="Web会議・場所">
            <LocationFields value={location} onChange={setLocation} />
          </Field>
          <Toggle checked={eventPrivate} onChange={setEventPrivate} label="予定を「非公開」で登録する" />

          <div className="cand-selected">
            <div className="strong">
              選んだ候補 {selected.length}/{MAX_SLOTS}
            </div>
            {selected.length === 0 && <div className="muted small">右の表で空いている枠をクリックしてください</div>}
            <ul className="candidate-list">
              {selected.map((s) => (
                <li key={s}>
                  {formatRangeJa(s, endOf(s), tz)}
                  <button type="button" className="icon-btn" aria-label="外す" onClick={() => toggleSlot(s)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <ErrorBox error={create.error} />
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={selected.length === 0 || name.trim() === '' || members.length === 0 || !validDuration || create.isPending}
            onClick={() => create.mutate({ name: name.trim(), durationMin, memberIds: members, location, eventPrivate, slots: selected })}
          >
            日程調整ページを作成する
          </button>
        </section>

        <section className="card cand-grid-card">
          <div className="slot-toolbar">
            <div className="slot-nav">
              <button type="button" className="icon-btn nav-arrow" aria-label="前の週" disabled={weekStart <= today} onClick={() => setWeekStart(addDays(weekStart, -7) < today ? today : addDays(weekStart, -7))}>
                ‹
              </button>
              <div className="slot-range">
                {Number(weekStart.slice(5, 7))}/{Number(weekStart.slice(8))} 〜 {Number((days[6] ?? weekStart).slice(5, 7))}/{Number((days[6] ?? weekStart).slice(8))}
              </div>
              <button type="button" className="icon-btn nav-arrow" aria-label="次の週" onClick={() => setWeekStart(addDays(weekStart, 7))}>
                ›
              </button>
            </div>
            <span className="muted small">{tz}・灰色はメンバーの予定あり</span>
          </div>
          {members.length === 0 && <div className="muted">参加メンバーを選んでください</div>}
          {availability.isLoading && <Spinner label="空き状況を確認しています…" />}
          <ErrorBox error={availability.error} />
          {availability.data && (
            <div className="avail-wrap">
              <table className="avail-table">
                <thead>
                  <tr>
                    <th />
                    {days.map((d) => (
                      <th key={d} className={weekdayOf(d) === 0 ? 'sun' : weekdayOf(d) === 6 ? 'sat' : ''}>
                        {Number(d.slice(5, 7))}/{Number(d.slice(8))}
                        <br />({WEEKDAY_JA[weekdayOf(d)]})
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.times.map((t) => (
                    <tr key={t}>
                      <th className="avail-time">{t}</th>
                      {days.map((d) => {
                        const c = grid.cell.get(`${d} ${t}`);
                        if (!c) return <td key={d} className="avail-cell none" />;
                        const sel = selected.includes(c.start);
                        return (
                          <td key={d} className="avail-td">
                            <button
                              type="button"
                              className={sel ? 'avail-cell selected' : c.available ? 'avail-cell free' : 'avail-cell busy'}
                              disabled={!c.available && !sel}
                              aria-pressed={sel}
                              aria-label={`${d} ${t}`}
                              onClick={() => toggleSlot(c.start)}
                            >
                              {sel ? '✓' : ''}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
