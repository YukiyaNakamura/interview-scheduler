/**
 * メールのリンクから開く画面（docs/01「ログイン」）。
 * - /login/verify?token= 新規登録のメールアドレスの確認（登録したときのパスワードも入れる）
 * - /login/reset?token=  パスワードの再設定
 * どちらも開いたらすぐ URL からトークンを消す（画面の共有・履歴・ブラウザの拡張機能から漏れないように）
 */
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { MessageResponse, PasswordResetConfirmInput } from '../../shared/api';
import { passwordProblem } from '../../shared/password';
import { apiPost } from '../lib/api';
import { ErrorBox, Field } from '../components/ui';
import { AuthShell, issueFor, NewPasswordFields, SubmitButton, unlessShown } from './LoginPage';

/** URL の ?token= を最初の1回だけ読み、アドレスバーからは消す */
function useTokenFromUrl(): string {
  const [params] = useSearchParams();
  const [token] = useState(() => params.get('token') ?? '');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('token')) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return token;
}

function Done({ message }: { message: string }) {
  return (
    <div className="stack">
      <div className="alert alert-success" role="status">
        {message}
      </div>
      <Link className="btn btn-primary auth-submit" to="/login">
        ログイン画面へ
      </Link>
    </div>
  );
}

function NoToken() {
  return (
    <div className="stack">
      <div className="alert alert-error">リンクが正しくありません。メールに書かれた URL をそのまま開いてください。</div>
      <Link className="btn" to="/login">
        ログイン画面へ
      </Link>
    </div>
  );
}

export function VerifyEmailPage() {
  const token = useTokenFromUrl();
  const [password, setPassword] = useState('');
  const verify = useMutation({ mutationFn: (body: { token: string; password: string }) => apiPost<MessageResponse>('/api/auth/verify-email', body) });
  return (
    <AuthShell>
      <h1>メールアドレスの確認</h1>
      {!token ? (
        <NoToken />
      ) : verify.data ? (
        <Done message={verify.data.message} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate({ token, password });
          }}
        >
          <p className="muted small">新規登録したときに決めたパスワードを入れてください。本人の登録であることを確かめます。</p>
          <Field label="パスワード" error={issueFor(verify.error, 'password')}>
            <input className="input" required type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorBox error={unlessShown(verify.error, ['password'])} />
          <SubmitButton busy={verify.isPending}>確認する</SubmitButton>
          <p className="muted small">心当たりがない場合は、このページを閉じてください（登録は進みません）。</p>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const token = useTokenFromUrl();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const reset = useMutation({ mutationFn: (body: PasswordResetConfirmInput) => apiPost<MessageResponse>('/api/auth/password-reset/confirm', body) });
  // メールアドレスはこの画面では分からないので、メールアドレスを含むかどうかはサーバーで確かめる
  const problem = form.password === '' ? null : passwordProblem(form.password);
  const mismatch = form.confirm !== '' && form.confirm !== form.password;
  return (
    <AuthShell>
      <h1>パスワードの再設定</h1>
      {!token ? (
        <NoToken />
      ) : reset.data ? (
        <Done message={reset.data.message} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (problem || mismatch) return;
            reset.mutate({ token, newPassword: form.password });
          }}
        >
          <NewPasswordFields password={form.password} confirm={form.confirm} problem={problem ?? issueFor(reset.error, 'password')} mismatch={mismatch} onChange={(password, confirm) => setForm({ password, confirm })} />
          <ErrorBox error={unlessShown(reset.error, ['password'])} />
          <SubmitButton busy={reset.isPending}>パスワードを変更</SubmitButton>
          <p className="muted small">変更すると、ログイン中の端末はすべてログアウトします。</p>
        </form>
      )}
    </AuthShell>
  );
}
