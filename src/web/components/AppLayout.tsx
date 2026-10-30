/**
 * 管理画面（/admin/**）の骨組み。上にヘッダー（アプリ名・メニュー・ログイン中の人）、下にページ。
 * ログインしていなければログイン画面（/login）へ送る（docs/01「ログイン」）。データを守るのは API 側（requireAdmin）で、ここは画面の切り替えだけ
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import type { AuthState } from '../../shared/api';
import { apiPost } from '../lib/api';
import { useAuth, useConfig } from '../lib/hooks';
import { isFramed } from '../pages/LoginPage';
import { ErrorBox, Spinner } from './ui';

const NAV = [
  { to: '/admin', label: '日程調整カレンダー', end: true },
  { to: '/admin/bookings', label: '予定一覧', end: false },
  { to: '/admin/members', label: 'メンバー', end: false },
  { to: '/admin/outbox', label: '送信ログ', end: false },
  { to: '/admin/accounts', label: 'アカウント', end: false },
];

export function AppLayout() {
  const config = useConfig();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { pathname, search } = useLocation();
  const logout = useMutation({
    mutationFn: () => apiPost<AuthState>('/api/auth/logout'),
    onSuccess: (s) => {
      // ほかの人の画面に前の人のデータが残らないように、取ってきたものを全部捨てる
      queryClient.clear();
      queryClient.setQueryData(['auth'], s);
    },
  });
  // カレンダー編集・候補を選ぶ画面も「日程調整カレンダー」を選択中にする
  const inCalendars = /^\/admin\/(calendars|candidates)\//.test(pathname);

  if (isFramed()) return <Navigate to="/login" replace />;
  if (auth.isLoading) return <Spinner />;
  if (auth.error) return <ErrorBox error={auth.error} />;
  if (auth.data?.step !== 'done') return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-inner">
          <NavLink className="brand" to="/admin">
            <span className="brand-mark" aria-hidden="true">
              ◷
            </span>
            {config.data?.appName ?? 'Aiteru'}
            <span className="brand-sub">管理画面</span>
          </NavLink>
          <nav className="app-nav" aria-label="メインメニュー">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => (isActive || (n.end && inCalendars) ? 'app-nav-link active' : 'app-nav-link')}
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="app-user">
            <span className="app-user-name ellipsis" title={auth.data.user.email}>
              {auth.data.user.name}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={logout.isPending} onClick={() => logout.mutate()}>
              ログアウト
            </button>
          </div>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
