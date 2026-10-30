/**
 * 管理画面のログイン（/login。docs/01「ログイン」）。応募者は使わない。
 * /api/auth/session の step に合わせて、初期設定 → パスワード → 2段階認証の登録 or コード → 仮パスワードの変更 を出し分ける。
 * 各 API は次の step を返すので、それを ['auth'] に入れて画面を進める。step が done になったら next（/admin 配下だけ）へ移る。
 * パスワードの入力の段階では「ログイン」「新規登録」「パスワードを忘れた」を ?mode=（なし | signup | forgot）で切り替える
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { renderSVG } from 'uqr';
import type { AuthState, LoginInput, MessageResponse, MfaEnrollInfo, PasswordChangeInput, PasswordResetRequestInput, SetupInput, SignupInput } from '../../shared/api';
import { PASSWORD_MIN, passwordProblem } from '../../shared/password';
import { ApiCallError, apiGet, apiPost } from '../lib/api';
import { useAuth, useConfig } from '../lib/hooks';
import { CopyButton, ErrorBox, Field, Spinner } from '../components/ui';

/** ログイン後の戻り先。管理画面の中だけにする（ほかのサイトへ飛ばされないように。使える文字も絞る） */
function safeNext(next: string | null): string {
  return next && /^\/admin(\/[\w\-/]*)?(\?[\w\-=&%.]*)?$/.test(next) && !next.includes('//') ? next : '/admin';
}

/** 項目ごとのエラー（API の issues）を取り出す */
export function issueFor(error: unknown, path: string): string | undefined {
  return error instanceof ApiCallError ? error.issues.find((i) => i.path === path)?.message : undefined;
}

/** 項目の下に出したエラーは ErrorBox で重ねて出さない。ほかの項目のエラーがあればそのまま出す */
export function unlessShown(error: unknown, paths: string[]): unknown {
  return error instanceof ApiCallError && error.issues.length > 0 && error.issues.every((i) => paths.includes(i.path)) ? null : error;
}

/** ほかのサイトの中に埋め込まれていたら表示しない（見えない枠でクリックさせる攻撃の対策） */
export function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** ログインまわりの画面の枠（アプリ名・カード・下の案内） */
export function AuthShell({ children }: { children: ReactNode }) {
  const config = useConfig();
  if (isFramed()) return <FramedNotice />;
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            ◷
          </span>
          {config.data?.appName ?? 'Aiteru'}
          <span className="brand-sub">管理画面</span>
        </div>
        {children}
      </div>
      <p className="auth-foot muted small">
        このページは採用担当者用です。面接の日程を選ぶ方は <Link to="/guest">応募者の方へ</Link> をご覧ください。
      </p>
    </div>
  );
}

export function LoginPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const next = safeNext(params.get('next'));
  const advance = (s: AuthState) => queryClient.setQueryData(['auth'], s);
  const restart = useMutation({ mutationFn: () => apiPost<AuthState>('/api/auth/logout'), onSuccess: advance });

  const state = auth.data;
  if (state?.step === 'done') return <Navigate to={next} replace />;

  return (
    <AuthShell>
      {auth.isLoading && <Spinner />}
      <ErrorBox error={auth.error} />
      {state?.step === 'setup' && <SetupForm onDone={advance} />}
      {state?.step === 'login' && <PasswordStep onDone={advance} />}
      {state?.step === 'mfa_enroll' && <MfaEnroll email={state.email} onDone={advance} />}
      {state?.step === 'mfa_verify' && <MfaVerify email={state.email} onDone={advance} />}
      {state?.step === 'change_password' && (
        <>
          <h1>パスワードを変更してください</h1>
          <p className="muted small">発行された仮パスワードのままでは管理画面を使えません。{state.user.name} さんだけが知っているパスワードに変えてください。</p>
          <PasswordChangeForm email={state.user.email} onDone={advance} />
        </>
      )}
      {(state?.step === 'mfa_enroll' || state?.step === 'mfa_verify' || state?.step === 'change_password') && (
        <button type="button" className="btn btn-ghost btn-sm auth-restart" disabled={restart.isPending} onClick={() => restart.mutate()}>
          別のアカウントでログインし直す
        </button>
      )}
    </AuthShell>
  );
}

function FramedNotice() {
  return (
    <div className="auth-page">
      <div className="auth-card card">
        <h1>このページは開けません</h1>
        <p className="muted">安全のため、管理画面はほかのサイトの中では表示しません。</p>
        <a className="btn btn-primary" href={window.location.href} target="_top">
          このページだけで開く
        </a>
      </div>
    </div>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button className="btn btn-primary auth-submit" disabled={busy}>
      {busy ? '確認しています…' : children}
    </button>
  );
}

// ---- 初期設定（最初の管理者） ----

function SetupForm({ onDone }: { onDone: (s: AuthState) => void }) {
  const [form, setForm] = useState<SetupInput & { confirm: string }>({ setupToken: '', name: '', email: '', password: '', confirm: '' });
  const setup = useMutation({ mutationFn: (body: SetupInput) => apiPost<AuthState>('/api/auth/setup', body), onSuccess: onDone });
  const problem = form.password === '' ? null : passwordProblem(form.password, form.email);
  const mismatch = form.confirm !== '' && form.confirm !== form.password;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || mismatch) return;
        setup.mutate({ setupToken: form.setupToken.trim(), name: form.name.trim(), email: form.email.trim(), password: form.password });
      }}
    >
      <h1>最初の管理者を作る</h1>
      <p className="muted small">管理者がまだいません。サーバーに設定した「初期設定用の合言葉」（ADMIN_SETUP_TOKEN）を入れて、最初の管理者を作ります。2人目からは管理画面の「アカウント」で追加します。</p>
      <Field label="初期設定用の合言葉" required error={issueFor(setup.error, 'setupToken')}>
        <input className="input" required type="password" autoComplete="off" value={form.setupToken} onChange={(e) => setForm({ ...form, setupToken: e.target.value })} />
      </Field>
      <Field label="名前" required>
        <input className="input" required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="メールアドレス" required>
        <input className="input" required type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <NewPasswordFields password={form.password} confirm={form.confirm} problem={problem ?? issueFor(setup.error, 'password')} mismatch={mismatch} onChange={(password, confirm) => setForm({ ...form, password, confirm })} />
      <ErrorBox error={unlessShown(setup.error, ['setupToken', 'password'])} />
      <SubmitButton busy={setup.isPending}>作成して2段階認証の登録へ</SubmitButton>
    </form>
  );
}

// ---- パスワードの段階（ログイン・新規登録・パスワードを忘れた） ----

type Mode = 'login' | 'signup' | 'forgot';

function PasswordStep({ onDone }: { onDone: (s: AuthState) => void }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mode');
  const mode: Mode = raw === 'signup' || raw === 'forgot' ? raw : 'login';
  /** next（ログイン後の戻り先）は残したまま mode だけ変える */
  const go = (m: Mode) =>
    setParams((p) => {
      if (m === 'login') p.delete('mode');
      else p.set('mode', m);
      return p;
    });
  return (
    <div className="stack">
      {mode !== 'forgot' && (
        <div className="auth-tabs" role="tablist" aria-label="ログインか新規登録か">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'auth-tab active' : 'auth-tab'} onClick={() => go('login')}>
            ログイン
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'auth-tab active' : 'auth-tab'} onClick={() => go('signup')}>
            新規登録
          </button>
        </div>
      )}
      {mode === 'login' && <LoginForm onDone={onDone} onForgot={() => go('forgot')} />}
      {mode === 'signup' && <SignupForm onBack={() => go('login')} />}
      {mode === 'forgot' && <ForgotForm onBack={() => go('login')} />}
      <Link className="small auth-back" to="/">
        ← 最初の画面に戻る
      </Link>
    </div>
  );
}

/** 送信したら API の文を出して終わる画面（新規登録・パスワードを忘れた） */
function SentNotice({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="stack">
      <div className="alert alert-success" role="status">
        {message}
      </div>
      <p className="muted small">開発中（EMAIL_PROVIDER=log）は実際にはメールを送りません。管理画面の「送信ログ」に本文が残ります。</p>
      <button type="button" className="btn" onClick={onBack}>
        ログインに戻る
      </button>
    </div>
  );
}

function SignupForm({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState<SignupInput & { confirm: string }>({ name: '', email: '', password: '', confirm: '' });
  const signup = useMutation({ mutationFn: (body: SignupInput) => apiPost<MessageResponse>('/api/auth/signup', body) });
  const problem = form.password === '' ? null : passwordProblem(form.password, form.email);
  const mismatch = form.confirm !== '' && form.confirm !== form.password;
  if (signup.data) return <SentNotice message={signup.data.message} onBack={onBack} />;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || mismatch) return;
        signup.mutate({ name: form.name.trim(), email: form.email.trim(), password: form.password });
      }}
    >
      <p className="muted small">登録すると確認メールが届きます。メールのリンクを開いたあと、ほかの管理者が承認すると使えるようになります（応募者の個人情報を守るため）。</p>
      <Field label="名前" required>
        <input className="input" required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="メールアドレス" required>
        <input className="input" required type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <NewPasswordFields password={form.password} confirm={form.confirm} problem={problem ?? issueFor(signup.error, 'password')} mismatch={mismatch} onChange={(password, confirm) => setForm({ ...form, password, confirm })} />
      <ErrorBox error={unlessShown(signup.error, ['password'])} />
      <SubmitButton busy={signup.isPending}>登録して確認メールを受け取る</SubmitButton>
    </form>
  );
}

function ForgotForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const request = useMutation({ mutationFn: (body: PasswordResetRequestInput) => apiPost<MessageResponse>('/api/auth/password-reset/request', body) });
  if (request.data) return <SentNotice message={request.data.message} onBack={onBack} />;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate({ email: email.trim() });
      }}
    >
      <h1>パスワードを忘れた</h1>
      <p className="muted small">登録したメールアドレスを入れると、パスワードを再設定するためのリンクを送ります（30分有効）。再設定したあとも、ログインには2段階認証のコードが必要です。</p>
      <Field label="メールアドレス">
        <input className="input" required type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <ErrorBox error={request.error} />
      <SubmitButton busy={request.isPending}>再設定のメールを送る</SubmitButton>
      <p className="muted small">認証アプリを入れたスマホをなくした・変えたときは、ほかの管理者に「アカウント」画面の「2段階認証をやり直す」を頼んでください。</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
        ログインに戻る
      </button>
    </form>
  );
}

function LoginForm({ onDone, onForgot }: { onDone: (s: AuthState) => void; onForgot: () => void }) {
  const [form, setForm] = useState<LoginInput>({ email: '', password: '' });
  const login = useMutation({ mutationFn: (body: LoginInput) => apiPost<AuthState>('/api/auth/login', body), onSuccess: onDone });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        login.mutate({ email: form.email.trim(), password: form.password });
      }}
    >
      <Field label="メールアドレス">
        <input className="input" required type="email" autoComplete="username" autoFocus value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label="パスワード">
        <input className="input" required type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      <ErrorBox error={login.error} />
      <SubmitButton busy={login.isPending}>次へ</SubmitButton>
      <button type="button" className="btn btn-link auth-forgot" onClick={onForgot}>
        パスワードを忘れた方
      </button>
    </form>
  );
}

// ---- 2段階認証 ----

function CodeInput({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label="6桁のコード" error={error}>
      <input
        className="input auth-code"
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        placeholder="123456"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, ''))}
      />
    </Field>
  );
}

function MfaVerify({ email, onDone }: { email: string; onDone: (s: AuthState) => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: (c: string) => apiPost<AuthState>('/api/auth/mfa/verify', { code: c }),
    onSuccess: onDone,
    onError: async (err) => {
      setCode('');
      // 間違いが続いてセッションが消えたら、パスワードの入力に戻す
      if (err instanceof ApiCallError && err.status === 401) await queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate(code.replace(/\s/g, ''));
      }}
    >
      <h1>2段階認証</h1>
      <p className="muted small">
        認証アプリ（Google Authenticator など）に出ている <strong>{email}</strong> の6桁のコードを入れてください。
      </p>
      <CodeInput value={code} onChange={setCode} />
      <ErrorBox error={verify.error} />
      <SubmitButton busy={verify.isPending}>ログイン</SubmitButton>
    </form>
  );
}

function MfaEnroll({ email, onDone }: { email: string; onDone: (s: AuthState) => void }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const info = useQuery({ queryKey: ['mfa-enroll', email], queryFn: () => apiGet<MfaEnrollInfo>('/api/auth/mfa/enroll'), staleTime: Infinity, retry: false });
  const enroll = useMutation({
    mutationFn: (c: string) => apiPost<AuthState>('/api/auth/mfa/enroll', { code: c }),
    onSuccess: onDone,
    onError: async (err) => {
      setCode('');
      if (err instanceof ApiCallError && err.status === 401) await queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        enroll.mutate(code.replace(/\s/g, ''));
      }}
    >
      <h1>2段階認証を登録する</h1>
      <p className="muted small">管理画面には応募者の名前・メールアドレスが入っているため、パスワードに加えてスマホの認証アプリのコードが必要です。</p>
      <ol className="auth-steps">
        <li>スマホに認証アプリ（Google Authenticator・Microsoft Authenticator など）を入れる</li>
        <li>アプリで下の QR コードを読み取る</li>
        <li>アプリに出た6桁のコードを入れる</li>
      </ol>
      {info.isLoading && <Spinner />}
      <ErrorBox error={info.error} />
      {info.data && (
        <div className="auth-qr-wrap">
          {/* QR コードは手元（このブラウザ）で作る。秘密鍵をほかのサービスに送らない */}
          <div className="auth-qr" role="img" aria-label="認証アプリに読み取らせる QR コード" dangerouslySetInnerHTML={{ __html: renderSVG(info.data.otpauthUrl, { border: 1 }) }} />
          <details className="auth-secret">
            <summary>QR コードを読み取れないとき</summary>
            <p className="small muted">アプリで「セットアップキーを入力」を選び、次のキーを入れてください（種類: 時間ベース）。</p>
            <div className="row-gap">
              <code className="mono auth-secret-key">{info.data.secret.match(/.{1,4}/g)?.join(' ')}</code>
              <CopyButton text={info.data.secret} />
            </div>
          </details>
        </div>
      )}
      <CodeInput value={code} onChange={setCode} />
      <ErrorBox error={enroll.error} />
      <SubmitButton busy={enroll.isPending}>登録してログイン</SubmitButton>
    </form>
  );
}

// ---- パスワードの変更（アカウント画面でも使う） ----

export function NewPasswordFields({
  password,
  confirm,
  problem,
  mismatch,
  onChange,
}: {
  password: string;
  confirm: string;
  problem?: string | null;
  mismatch: boolean;
  onChange: (password: string, confirm: string) => void;
}) {
  return (
    <>
      <Field label="新しいパスワード" required hint={`${PASSWORD_MIN} 文字以上。覚えやすい長めの文（例: 単語を3〜4個つなげたもの）がおすすめです`} error={problem ?? undefined}>
        <input className="input" required type="password" autoComplete="new-password" value={password} onChange={(e) => onChange(e.target.value, confirm)} />
      </Field>
      <Field label="新しいパスワード（確認）" required error={mismatch ? '上と同じパスワードを入れてください' : undefined}>
        <input className="input" required type="password" autoComplete="new-password" value={confirm} onChange={(e) => onChange(password, e.target.value)} />
      </Field>
    </>
  );
}

export function PasswordChangeForm({ email, onDone }: { email: string; onDone: (s: AuthState) => void }) {
  const [form, setForm] = useState({ current: '', password: '', confirm: '' });
  const change = useMutation({
    mutationFn: (body: PasswordChangeInput) => apiPost<AuthState>('/api/auth/password', body),
    onSuccess: (s) => {
      setForm({ current: '', password: '', confirm: '' });
      onDone(s);
    },
  });
  const problem = form.password === '' ? null : passwordProblem(form.password, email);
  const mismatch = form.confirm !== '' && form.confirm !== form.password;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || mismatch) return;
        change.mutate({ currentPassword: form.current, newPassword: form.password });
      }}
    >
      {/* パスワード管理ソフトがどのアカウントのパスワードか分かるように、メールアドレスを隠して入れておく */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <Field label="今のパスワード" required error={issueFor(change.error, 'currentPassword')}>
        <input className="input" required type="password" autoComplete="current-password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
      </Field>
      <NewPasswordFields password={form.password} confirm={form.confirm} problem={problem ?? issueFor(change.error, 'password')} mismatch={mismatch} onChange={(password, confirm) => setForm({ ...form, password, confirm })} />
      <ErrorBox error={unlessShown(change.error, ['currentPassword', 'password'])} />
      <SubmitButton busy={change.isPending}>パスワードを変更</SubmitButton>
      <p className="muted small">変更すると、ほかの端末でのログインはすべて切れます。</p>
    </form>
  );
}
