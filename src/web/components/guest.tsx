/**
 * ゲスト画面の部品: 外枠（埋め込み時はヘッダー・フッターなし）、予定の内容カード、質問フォーム。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import type { PublicBooking } from '../../shared/api';
import type { Question } from '../../shared/schema';
import { formatRangeJa } from '../../shared/time';
import { ErrorBox, MultiLine } from './ui';

export function GuestShell({ embed, children }: { embed: boolean; children: ReactNode }) {
  if (embed) return <div className="guest embed">{children}</div>;
  return (
    <div className="guest">
      <div className="guest-inner">{children}</div>
      <footer className="guest-footer">
        <span className="brand-mark" aria-hidden="true">
          ◷
        </span>{' '}
        Aiteru で日程調整
      </footer>
    </div>
  );
}

/** 確定した予定の内容（完了画面・予定確認ページ） */
export function BookingSummaryCard({ booking: b, timezone }: { booking: PublicBooking; timezone: string }) {
  return (
    <dl className="dl booking-summary">
      <dt>日時</dt>
      <dd className="strong">
        {formatRangeJa(b.startAt, b.endAt, timezone)}
        <div className="muted small">{timezone}</div>
      </dd>
      <dt>予定</dt>
      <dd>{b.calendarName}</dd>
      <dt>主催</dt>
      <dd>{b.displayName || b.hostNames.join('、')}</dd>
      <dt>場所</dt>
      <dd>
        {b.locationLabel}
        {b.locationText && <MultiLine text={b.locationText} />}
        {b.meetingUrl && (
          <div>
            <a href={b.meetingUrl} target="_blank" rel="noreferrer">
              {b.meetingUrl}
            </a>
          </div>
        )}
      </dd>
      <dt>お名前</dt>
      <dd>
        {b.guestName}（{b.guestEmail}）
      </dd>
    </dl>
  );
}

type Answers = Record<string, string | string[]>;

/** 質問フォーム。必須とメール形式だけ手元で確かめ、残りはサーバーで検証する */
export function QuestionForm({
  questions,
  initial,
  submitting,
  error,
  onBack,
  onSubmit,
  summary,
}: {
  questions: Question[];
  initial: Answers;
  submitting: boolean;
  error: unknown;
  onBack: () => void;
  onSubmit: (answers: Answers) => void;
  summary: ReactNode;
}) {
  const [values, setValues] = useState<Answers>(initial);
  const [missing, setMissing] = useState<string[]>([]);
  const set = (id: string, v: string | string[]) => setValues((prev) => ({ ...prev, [id]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const bad = questions
      .filter((q) => {
        const v = values[q.id];
        const empty = v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
        if (q.required && empty) return true;
        if (q.system === 'email' && typeof v === 'string' && v !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return true;
        return false;
      })
      .map((q) => q.id);
    setMissing(bad);
    if (bad.length === 0) onSubmit(values);
  };

  return (
    <form className="guest-form" onSubmit={submit} noValidate>
      <div className="selected-slot">{summary}</div>
      {questions.map((q) => {
        const v = values[q.id];
        const str = typeof v === 'string' ? v : '';
        const arr = Array.isArray(v) ? v : [];
        const invalid = missing.includes(q.id);
        return (
          <div className={invalid ? 'field has-error' : 'field'} key={q.id}>
            <label className="field-label" htmlFor={`q-${q.id}`}>
              {q.label}
              {q.required ? <span className="req">必須</span> : <span className="opt">任意</span>}
            </label>
            {q.help && <div className="field-hint top">{q.help}</div>}
            {q.type === 'textarea' && <textarea id={`q-${q.id}`} className="input" rows={4} value={str} onChange={(e) => set(q.id, e.target.value)} />}
            {(q.type === 'text' || q.type === 'date' || q.type === 'number') && (
              <input
                id={`q-${q.id}`}
                className="input"
                type={q.system === 'email' ? 'email' : q.type === 'date' ? 'date' : q.type === 'number' ? 'number' : 'text'}
                inputMode={q.type === 'number' ? 'numeric' : undefined}
                autoComplete={q.system === 'email' ? 'email' : q.system === 'name' ? 'name' : q.system === 'company' ? 'organization' : undefined}
                value={str}
                onChange={(e) => set(q.id, e.target.value)}
              />
            )}
            {q.type === 'select' && (
              <select id={`q-${q.id}`} className="input" value={str} onChange={(e) => set(q.id, e.target.value)}>
                <option value="">選択してください</option>
                {q.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {q.type === 'radio' && (
              <div className="choice-list">
                {q.options.map((o) => (
                  <label key={o} className="check">
                    <input type="radio" name={`q-${q.id}`} checked={str === o} onChange={() => set(q.id, o)} />
                    {o}
                  </label>
                ))}
              </div>
            )}
            {q.type === 'checkbox' && (
              <div className="choice-list">
                {q.options.map((o) => (
                  <label key={o} className="check">
                    <input type="checkbox" checked={arr.includes(o)} onChange={(e) => set(q.id, e.target.checked ? [...arr, o] : arr.filter((x) => x !== o))} />
                    {o}
                  </label>
                ))}
              </div>
            )}
            {invalid && <div className="field-error">{q.system === 'email' && str !== '' ? 'メールアドレスの形式が正しくありません' : '入力してください'}</div>}
          </div>
        );
      })}
      <ErrorBox error={error} />
      <div className="guest-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          ‹ 日時を選び直す
        </button>
        <button className="btn btn-primary btn-lg" disabled={submitting}>
          {submitting ? '送信中…' : 'この内容で日程調整を完了する'}
        </button>
      </div>
    </form>
  );
}
