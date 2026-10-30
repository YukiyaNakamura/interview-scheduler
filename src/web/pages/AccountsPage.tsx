/**
 * 管理画面にログインできる人（管理者）の管理と、ログインの記録（/admin/accounts。docs/01「ログイン」）。
 * 追加・パスワード再発行・2段階認証のやり直しでは仮パスワードが1回だけ表示される。本人は次のログインで自分のパスワードに変える
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AccountInfo, AccountInput, AccountStatus, AuthEventItem, AuthEventKind, AuthState, TempPasswordResponse } from '../../shared/api';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { browserTimeZone, formatDateTimeJa } from '../lib/format';
import { useAuth } from '../lib/hooks';
import { Badge, ConfirmButton, CopyButton, Empty, ErrorBox, Spinner } from '../components/ui';
import { PasswordChangeForm } from './LoginPage';

const EVENT_LABELS: Record<AuthEventKind, string> = {
  setup: '初期設定',
  login_success: 'ログイン',
  login_failed: 'ログイン失敗',
  login_locked: 'ロック（失敗が続いた）',
  mfa_enrolled: '2段階認証を登録',
  mfa_failed: '2段階認証のコード違い',
  logout: 'ログアウト',
  password_changed: 'パスワード変更',
  account_created: 'アカウント追加',
  account_deleted: 'アカウント削除',
  password_reset: 'パスワード再発行',
  mfa_reset: '2段階認証のやり直し',
  signup_requested: '新規登録',
  email_verified: 'メールアドレスの確認',
  account_approved: '承認',
  password_reset_requested: 'パスワード再設定メールの送信',
  password_reset_by_email: 'パスワード再設定（メールから）',
};

const STATUS_BADGES: Record<Exclude<AccountStatus, 'active'>, { tone: 'amber' | 'gray'; label: string }> = {
  pending_approval: { tone: 'amber', label: '承認待ち' },
  pending_email: { tone: 'gray', label: 'メール確認待ち' },
};

const WARN_EVENTS: AuthEventKind[] = ['login_failed', 'login_locked', 'mfa_failed'];

export function AccountsPage() {
  const tz = browserTimeZone();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<AccountInfo[]>('/api/admin/accounts') });
  const events = useQuery({ queryKey: ['auth-events'], queryFn: () => apiGet<AuthEventItem[]>('/api/admin/auth-events') });
  const [form, setForm] = useState<AccountInput>({ name: '', email: '' });
  /** 直前に発行した仮パスワード（この画面を離れると二度と見られない） */
  const [issued, setIssued] = useState<{ title: string; result: TempPasswordResponse } | null>(null);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['auth-events'] });
  };

  const add = useMutation({
    mutationFn: (body: AccountInput) => apiPost<TempPasswordResponse>('/api/admin/accounts', body),
    onSuccess: async (result) => {
      setIssued({ title: 'アカウントを追加しました', result });
      setForm({ name: '', email: '' });
      await refresh();
    },
  });
  const [actionError, setActionError] = useState<unknown>(null);
  /** 一覧のボタンの操作。失敗したら一覧の上にエラーを出す */
  const run = (action: () => Promise<void>) => async () => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err);
    }
    await refresh();
  };
  const issue = (title: string, path: string) => run(async () => setIssued({ title, result: await apiPost<TempPasswordResponse>(path) }));
  const remove = (id: string) => run(() => apiDelete(`/api/admin/accounts/${id}`).then(() => undefined));
  const approve = (id: string) => run(() => apiPost<AccountInfo>(`/api/admin/accounts/${id}/approve`).then(() => undefined));
  const waiting = (accounts.data ?? []).filter((a) => a.status === 'pending_approval');

  const self = auth.data?.step === 'done' ? auth.data.user : null;

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>アカウント</h1>
          <p className="muted">管理画面にログインできる人です。応募者の名前・メールアドレスが見られるので、必要な人だけを追加してください。全員が同じ操作をできます。</p>
        </div>
      </div>

      {self && (
        <section className="card">
          <div className="row-gap wrap">
            <div className="grow min0">
              <div className="small muted">ログイン中</div>
              <div className="strong">{self.name}</div>
              <div className="muted small ellipsis">{self.email}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setChanging(!changing)}>
              {changing ? '閉じる' : 'パスワードを変更'}
            </button>
          </div>
          {changed && !changing && <div className="alert alert-success small">パスワードを変更しました。ほかの端末でのログインは切れました。</div>}
          {changing && (
            <div className="account-password">
              <PasswordChangeForm
                email={self.email}
                onDone={(s: AuthState) => {
                  queryClient.setQueryData(['auth'], s);
                  setChanging(false);
                  setChanged(true);
                  void refresh();
                }}
              />
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>アカウントを追加</h2>
        <form
          className="member-form"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ name: form.name.trim(), email: form.email.trim() });
          }}
        >
          <input className="input" required placeholder="名前" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="名前" />
          <input className="input" required type="email" placeholder="メールアドレス（ログインに使う）" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} aria-label="メールアドレス" />
          <button className="btn btn-primary" disabled={add.isPending || form.name.trim() === '' || form.email.trim() === ''}>
            追加
          </button>
        </form>
        <p className="muted small">追加すると仮パスワードが表示されます。本人は初回ログインで、2段階認証の登録と自分のパスワードへの変更をします。</p>
        <ErrorBox error={add.error} />
      </section>

      {issued && <TempPasswordNotice title={issued.title} result={issued.result} onClose={() => setIssued(null)} />}

      {waiting.length > 0 && (
        <div className="alert alert-warn">
          新規登録の承認待ちが {waiting.length} 人います。社内の人か確かめてから「承認」してください。心当たりがなければ「削除」で却下します。
        </div>
      )}

      <section className="card">
        <h2>ログインできる人</h2>
        {accounts.isLoading && <Spinner />}
        <ErrorBox error={accounts.error ?? actionError} />
        {(accounts.data ?? []).map((a) => (
          <div key={a.id} className="account-row">
            <div className="grow min0">
              <div className="strong">
                {a.name}
                {a.isSelf && <span className="muted small">（あなた）</span>}
              </div>
              <div className="muted small ellipsis">{a.email}</div>
              <div className="muted small">{a.lastLoginAt ? `最後のログイン: ${formatDateTimeJa(a.lastLoginAt, tz)}（${a.lastLoginIp ?? '-'}）` : 'まだログインしていません'}</div>
            </div>
            <div className="account-badges">
              {a.status !== 'active' ? (
                <Badge tone={STATUS_BADGES[a.status].tone}>{STATUS_BADGES[a.status].label}</Badge>
              ) : (
                <>
                  {a.mfaEnabled ? <Badge tone="green">2段階認証あり</Badge> : <Badge tone="amber">2段階認証は未登録</Badge>}
                  {a.mustChangePassword && <Badge tone="amber">仮パスワード</Badge>}
                </>
              )}
            </div>
            {!a.isSelf && a.status !== 'active' && (
              <div className="account-actions">
                {a.status === 'pending_approval' && (
                  <ConfirmButton label="承認" message={`${a.name}（${a.email}）さんに管理画面の利用を認めますか？`} confirmLabel="承認" onConfirm={approve(a.id)} className="btn btn-sm btn-primary" />
                )}
                <ConfirmButton label="削除" danger message={`${a.name} さんの登録を削除（却下）しますか？`} confirmLabel="削除" onConfirm={remove(a.id)} />
              </div>
            )}
            {!a.isSelf && a.status === 'active' && (
              <div className="account-actions">
                <ConfirmButton
                  label="パスワード再発行"
                  message={`${a.name} さんの仮パスワードを発行しますか？（今のパスワードは使えなくなります）`}
                  confirmLabel="発行"
                  onConfirm={issue(`${a.name} さんの仮パスワードを発行しました`, `/api/admin/accounts/${a.id}/reset-password`)}
                />
                <ConfirmButton
                  label="2段階認証をやり直す"
                  message={`${a.name} さんの2段階認証を消し、仮パスワードを発行しますか？（スマホをなくした・変えたとき）`}
                  confirmLabel="やり直す"
                  onConfirm={issue(`${a.name} さんの2段階認証を消し、仮パスワードを発行しました`, `/api/admin/accounts/${a.id}/reset-mfa`)}
                />
                <ConfirmButton label="削除" danger message={`${a.name} さんのアカウントを削除しますか？`} confirmLabel="削除" onConfirm={remove(a.id)} />
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <h2>ログインの記録</h2>
        <p className="muted small">直近 100 件。心当たりのないログイン失敗やロックが続くときは、パスワードを変えてください（180日で消えます）。</p>
        {events.isLoading && <Spinner />}
        <ErrorBox error={events.error} />
        {events.data && events.data.length === 0 && <Empty>まだ記録はありません。</Empty>}
        {events.data && events.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>内容</th>
                  <th>アカウント</th>
                  <th>操作した人</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {events.data.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{formatDateTimeJa(e.createdAt, tz)}</td>
                    <td>{WARN_EVENTS.includes(e.kind) ? <Badge tone={e.kind === 'login_locked' ? 'red' : 'amber'}>{EVENT_LABELS[e.kind]}</Badge> : EVENT_LABELS[e.kind]}</td>
                    <td className="ellipsis" title={e.userAgent ?? undefined}>
                      {e.userName ?? e.email ?? '-'}
                    </td>
                    <td>{e.actorName ?? ''}</td>
                    <td className="mono small">{e.ip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/** 発行した仮パスワード。閉じると二度と見られない */
function TempPasswordNotice({ title, result, onClose }: { title: string; result: TempPasswordResponse; onClose: () => void }) {
  return (
    <section className="card temp-password" role="status">
      <h2>{title}</h2>
      <p className="small">
        <strong>{result.account.name}</strong>（{result.account.email}）の仮パスワード:
      </p>
      <div className="row-gap">
        <code className="mono temp-password-value">{result.tempPassword}</code>
        <CopyButton text={result.tempPassword} />
      </div>
      <ul className="small muted temp-password-notes">
        <li>この仮パスワードは今しか表示されません。</li>
        <li>メールアドレスとは別の方法（口頭・社内チャットの個別メッセージなど）で本人に伝えてください。</li>
        <li>本人は次のログインで自分のパスワードに変えます（2段階認証が未登録なら、その登録も）。</li>
      </ul>
      <button type="button" className="btn btn-sm" onClick={onClose}>
        伝えたので閉じる
      </button>
    </section>
  );
}
