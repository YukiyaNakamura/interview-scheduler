/**
 * URL とページの対応表（docs/01「画面」）。
 * /admin/** は管理画面（AppLayout の中。ログインが要る）、/login は管理画面のログイン、/c/:slug と /r/:token は応募画面（ログインなし）。
 * / と旧 /app/* は /admin へ
 */
import { Navigate, createBrowserRouter } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { AccountsPage } from './pages/AccountsPage';
import { BookingDetailPage } from './pages/BookingDetailPage';
import { BookingsPage } from './pages/BookingsPage';
import { CalendarEditPage } from './pages/CalendarEditPage';
import { CalendarsPage } from './pages/CalendarsPage';
import { CandidatesNewPage } from './pages/CandidatesNewPage';
import { LoginPage } from './pages/LoginPage';
import { MembersPage } from './pages/MembersPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OutboxPage } from './pages/OutboxPage';
import { GuestBookingPage } from './pages/guest/GuestBookingPage';
import { ManagePage } from './pages/guest/ManagePage';

const toAdmin = <Navigate to="/admin" replace />;

export const router = createBrowserRouter([
  { path: '/', element: toAdmin },
  { path: '/app', element: toAdmin },
  { path: '/app/*', element: toAdmin },
  { path: '/login', Component: LoginPage },
  {
    path: '/admin',
    Component: AppLayout,
    children: [
      { index: true, Component: CalendarsPage },
      { path: 'calendars', element: toAdmin },
      { path: 'calendars/:id', Component: CalendarEditPage },
      { path: 'candidates/new', Component: CandidatesNewPage },
      { path: 'bookings', Component: BookingsPage },
      { path: 'bookings/:id', Component: BookingDetailPage },
      { path: 'members', Component: MembersPage },
      { path: 'outbox', Component: OutboxPage },
      { path: 'accounts', Component: AccountsPage },
      { path: '*', Component: NotFoundPage },
    ],
  },
  { path: '/c/:slug', Component: GuestBookingPage },
  { path: '/r/:token', Component: ManagePage },
  { path: '*', Component: NotFoundPage },
]);
