/**
 * 共通の小さな部品。ブラウザの confirm/alert は使わず、画面の中で確認する（ConfirmButton）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiCallError } from '../lib/api';
import { copyText, initials } from '../lib/format';

/** 押すとコピーし、少しの間「コピーしました」と表示するボタン */
export function CopyButton({ text, label = 'コピー', className = 'btn btn-sm' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        await copyText(text);
        setDone(true);
      }}
    >
      {done ? 'コピーしました' : label}
    </button>
  );
}

/** 1回目のクリックで確認を出し、「はい」で実行するボタン */
export function ConfirmButton({
  label,
  message,
  confirmLabel = 'はい',
  onConfirm,
  danger = false,
  disabled = false,
  className,
}: {
  label: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className ?? (danger ? 'btn btn-sm btn-danger-ghost' : 'btn btn-sm')} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm-inline" role="group">
      <span className="confirm-msg">{message}</span>
      <button
        type="button"
        className={danger ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary'}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAsking(false)}>
        やめる
      </button>
    </span>
  );
}

/** API のエラー表示。zod の項目ごとのエラーがあれば一覧にする */
export function ErrorBox({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = error instanceof ApiCallError ? error.issues : [];
  return (
    <div className="alert alert-error" role="alert">
      <div>{message}</div>
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Avatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (url) return <img className="avatar" src={url} alt={name} title={name} style={style} referrerPolicy="no-referrer" />;
  return (
    <span className="avatar avatar-text" title={name} style={style}>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 5 }: { people: { name: string; avatarUrl: string | null }[]; max?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((p, i) => (
        <Avatar key={i} name={p.name} url={p.avatarUrl} size={26} />
      ))}
      {people.length > max && <span className="avatar avatar-more">+{people.length - max}</span>}
    </span>
  );
}

export function Spinner({ label = '読み込み中…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" aria-live="polite">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export function Field({ label, hint, error, children, required }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; required?: boolean }) {
  return (
    <div className={error ? 'field has-error' : 'field'}>
      <label className="field-label">
        {label}
        {required && <span className="req">必須</span>}
      </label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={disabled ? 'toggle disabled' : 'toggle'}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

export function Badge({ tone = 'gray', children }: { tone?: 'green' | 'gray' | 'red' | 'blue' | 'amber'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 文字列の改行をそのまま表示する */
export function MultiLine({ text }: { text: string }) {
  return <div className="multiline">{text}</div>;
}
