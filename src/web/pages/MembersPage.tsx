/**
 * メンバー（面接官）の登録と Google カレンダー連携。
 * 連携はログインではなく「このメンバーのカレンダーを読む・書く許可」をもらうだけ（/auth/google/start?member=<id>）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ConnectionInfo, GoogleCalendarItem, MemberInfo, MemberInput } from '../../shared/api';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { useConfig, useMembers } from '../lib/hooks';
import { Avatar, Badge, ConfirmButton, Empty, ErrorBox, Field, Spinner } from '../components/ui';

export function MembersPage() {
  const config = useConfig();
  const members = useMembers();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [form, setForm] = useState<MemberInput>({ name: '', email: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] });

  const add = useMutation({
    mutationFn: (body: MemberInput) => apiPost<MemberInfo>('/api/admin/members', body),
    onSuccess: async () => {
      setForm({ name: '', email: '' });
      await refresh();
    },
  });

  const error = params.get('error');
  const connected = params.get('connected');

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>メンバー（面接官）</h1>
          <p className="muted">日程調整カレンダーの参加メンバーにする人を登録します。Google カレンダーを連携すると、予定が入っている時間は候補から外れ、確定した予定が自動で登録されます。</p>
        </div>
      </div>

      {error && <div className="alert alert-error">Google カレンダーの連携に失敗しました（{error}）</div>}
      {connected && !error && <div className="alert alert-success">Google カレンダーを連携しました</div>}
      {config.data && !config.data.googleEnabled && (
        <div className="alert alert-warn small">Google カレンダー連携を使うには、GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET の設定が必要です（README 参照）。連携しなくても、このアプリ内の予定どうしの重なりは自動で避けます。</div>
      )}

      <section className="card">
        <h2>メンバーを追加</h2>
        <form
          className="member-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ name: form.name.trim(), email: form.email.trim() });
          }}
        >
          <input className="input" required placeholder="名前（例: 山田 太郎）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" required type="email" placeholder="メールアドレス（通知の送り先）" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <button className="btn btn-primary" disabled={add.isPending || form.name.trim() === '' || form.email.trim() === ''}>
            追加
          </button>
        </form>
        <ErrorBox error={add.error} />
      </section>

      {members.isLoading && <Spinner />}
      <ErrorBox error={members.error} />
      {members.data && members.data.length === 0 && <Empty>まだメンバーがいません。上のフォームから面接官を登録してください。</Empty>}
      {(members.data ?? []).map((m) => (
        <MemberCard key={m.id} member={m} googleEnabled={config.data?.googleEnabled ?? false} onChanged={refresh} />
      ))}
    </div>
  );
}

/** メンバー1人: 名前・メールの編集、削除、Google カレンダー連携 */
function MemberCard({ member: m, googleEnabled, onChanged }: { member: MemberInfo; googleEnabled: boolean; onChanged: () => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<MemberInput>({ name: m.name, email: m.email });
  const save = useMutation({
    mutationFn: (body: MemberInput) => apiPatch<MemberInfo>(`/api/admin/members/${m.id}`, body),
    onSuccess: async () => {
      setEditing(false);
      await onChanged();
    },
  });
  const remove = useMutation({ mutationFn: () => apiDelete(`/api/admin/members/${m.id}`), onSuccess: onChanged });

  return (
    <section className="card member-card">
      <div className="member-item">
        <Avatar name={m.name} size={40} />
        {editing ? (
          <form
            className="member-form grow"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ name: form.name.trim(), email: form.email.trim() });
            }}
          >
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="名前" />
            <input className="input" required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="メールアドレス" />
            <div className="row-gap">
              <button className="btn btn-sm btn-primary" disabled={save.isPending}>
                保存
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setForm({ name: m.name, email: m.email });
                  setEditing(false);
                }}
              >
                やめる
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="grow min0">
              <div className="strong">{m.name}</div>
              <div className="muted small ellipsis">{m.email}</div>
            </div>
            <Badge tone={m.connections.length > 0 ? 'green' : 'amber'}>{m.connections.length > 0 ? 'カレンダー連携済み' : 'カレンダー未連携'}</Badge>
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              編集
            </button>
            <ConfirmButton
              label="削除"
              danger
              message={`${m.name} さんを削除しますか？（参加メンバーからも外れます）`}
              confirmLabel="削除"
              onConfirm={() => remove.mutateAsync().then(() => undefined)}
            />
          </>
        )}
      </div>
      <ErrorBox error={save.error ?? remove.error} />

      <div className="member-conns">
        {m.connections.map((c) => (
          <ConnectionCard key={c.id} connection={c} onChanged={onChanged} />
        ))}
        {googleEnabled && (
          <a className="btn btn-sm btn-google-sm" href={`/auth/google/start?member=${encodeURIComponent(m.id)}&redirect=${encodeURIComponent('/admin/members')}`}>
            <span className="g-mark" aria-hidden="true">
              G
            </span>
            {m.connections.length > 0 ? '別の Google カレンダーを連携' : 'Googleカレンダーを連携'}
          </a>
        )}
      </div>
    </section>
  );
}

/** 連携1件: 空き確認に使うカレンダー（複数）と予定を登録するカレンダーを選ぶ */
function ConnectionCard({ connection: c, onChanged }: { connection: ConnectionInfo; onChanged: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<string[]>(c.checkCalendarIds);
  const [write, setWrite] = useState(c.writeCalendarId);
  const calendars = useQuery({
    queryKey: ['connection-calendars', c.id],
    queryFn: () => apiGet<GoogleCalendarItem[]>(`/api/admin/connections/${c.id}/calendars`),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: () => apiPatch<ConnectionInfo>(`/api/admin/connections/${c.id}`, { checkCalendarIds: check, writeCalendarId: write }),
    onSuccess: async () => {
      setOpen(false);
      await onChanged();
    },
  });
  const remove = useMutation({ mutationFn: () => apiDelete(`/api/admin/connections/${c.id}`), onSuccess: onChanged });

  // 'primary' はメインカレンダーの別名なので、一覧の primary の項目と同じものとして扱う
  const isChecked = (item: GoogleCalendarItem) => check.includes(item.id) || (item.primary && check.includes('primary'));
  const toggle = (item: GoogleCalendarItem, on: boolean) => {
    const ids = check.filter((x) => x !== item.id && !(item.primary && x === 'primary'));
    setCheck(on ? [...ids, item.primary ? 'primary' : item.id] : ids);
  };

  return (
    <div className="conn-card">
      <div className="conn-head">
        <span className="g-mark" aria-hidden="true">
          G
        </span>
        <div className="grow min0">
          <div className="strong ellipsis">{c.accountEmail}</div>
          <div className="muted small">
            空き確認: {c.checkCalendarIds.length} 件のカレンダー ／ 登録先: {c.writeCalendarId === 'primary' ? 'メインカレンダー' : c.writeCalendarId}
          </div>
        </div>
        {c.status === 'active' ? <Badge tone="green">連携中</Badge> : <Badge tone="red">エラー</Badge>}
      </div>
      {c.status === 'error' && c.lastError && <div className="alert alert-error small">{c.lastError}（もう一度「Googleカレンダーを連携」すると直ります）</div>}
      <div className="row-gap wrap">
        <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)}>
          {open ? '閉じる' : '使うカレンダーを選ぶ'}
        </button>
        <ConfirmButton label="連携解除" danger message="連携を解除しますか？" confirmLabel="解除" onConfirm={() => remove.mutateAsync().then(() => undefined)} />
      </div>
      <ErrorBox error={remove.error} />
      {open && (
        <div className="conn-body">
          {calendars.isLoading && <Spinner />}
          <ErrorBox error={calendars.error} />
          {calendars.data && (
            <>
              <div className="field-label">空き確認に使うカレンダー</div>
              <div className="stack-sm">
                {calendars.data.map((item) => (
                  <label className="check" key={item.id}>
                    <input type="checkbox" checked={isChecked(item)} onChange={(e) => toggle(item, e.target.checked)} />
                    {item.summary}
                    {item.primary && <span className="muted small">（メイン）</span>}
                  </label>
                ))}
              </div>
              <Field label="予定を登録するカレンダー">
                <select className="input" value={write} onChange={(e) => setWrite(e.target.value)}>
                  {calendars.data
                    .filter((item) => item.accessRole === 'owner' || item.accessRole === 'writer')
                    .map((item) => (
                      <option key={item.id} value={item.primary ? 'primary' : item.id}>
                        {item.summary}
                        {item.primary ? '（メイン）' : ''}
                      </option>
                    ))}
                </select>
              </Field>
              <ErrorBox error={save.error} />
              <button type="button" className="btn btn-primary btn-sm" disabled={check.length === 0 || save.isPending} onClick={() => save.mutate()}>
                保存
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
