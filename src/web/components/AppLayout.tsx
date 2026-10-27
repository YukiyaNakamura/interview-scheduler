/**
 * 管理画面（/admin/**）の骨組み。上にヘッダー（アプリ名・メニュー）、下にページ。
 * ログインはない（本番では Cloudflare Access で /admin を守る。docs/01「ログイン」）
 */
import { NavLink, Outlet, useLocation } from 'react-router';
import { useConfig } from '../lib/hooks';

const NAV = [
  { to: '/admin', label: '日程調整カレンダー', end: true },
  { to: '/admin/bookings', label: '予定一覧', end: false },
  { to: '/admin/members', label: 'メンバー', end: false },
  { to: '/admin/outbox', label: '送信ログ', end: false },
];

export function AppLayout() {
  const config = useConfig();
  const { pathname } = useLocation();
  // カレンダー編集・候補を選ぶ画面も「日程調整カレンダー」を選択中にする
  const inCalendars = /^\/admin\/(calendars|candidates)\//.test(pathname);
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
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
