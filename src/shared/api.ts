/**
 * Worker と画面の間の API の型（ここが正）。エンドポイントの一覧は docs/01_architecture.md「API」。
 * 日時（*At）はすべて UTC の ISO 文字列。
 * 管理画面の API（/api/admin/*）はログインが要る（/api/auth/*）。応募者（ゲスト）の API（/api/public/*）はログインなし
 */
import type { CalendarSettings, CalendarUpdateInput, LocationType, Question } from './schema';

export interface ApiError {
  error: string;
  /** zod の検証エラーのときの詳細（項目 → メッセージ） */
  issues?: { path: string; message: string }[];
}

/** GET /api/config */
export interface AppConfig {
  appName: string;
  /** Google カレンダー連携が使えるか（GOOGLE_CLIENT_ID / SECRET が設定済み） */
  googleEnabled: boolean;
  emailProvider: string;
}

// ---- ログイン（管理画面だけ。docs/01「ログイン」） ----

export interface AdminUserInfo {
  id: string;
  name: string;
  email: string;
}

/**
 * GET /api/auth/session。ログインのどの段階にいるか。step が 'done' になるまで /api/admin/* は 401。
 * パスワード → 2段階認証（未登録なら登録）→ 仮パスワードなら変更 → done の順に進む
 */
export type AuthState =
  | { step: 'setup' } // 管理者がまだ1人もいない。初期設定で最初の管理者を作る
  | { step: 'login' }
  | { step: 'mfa_enroll'; email: string } // パスワードは通った。認証アプリの登録が要る
  | { step: 'mfa_verify'; email: string } // パスワードは通った。6桁のコードが要る
  | { step: 'change_password'; user: AdminUserInfo } // 発行された仮パスワードのまま
  | { step: 'done'; user: AdminUserInfo };

/** POST /api/auth/setup（管理者が0人のときだけ） */
export interface SetupInput {
  setupToken: string;
  name: string;
  email: string;
  password: string;
}

/** POST /api/auth/login */
export interface LoginInput {
  email: string;
  password: string;
}

/** GET /api/auth/mfa/enroll。認証アプリに読み込ませる秘密鍵 */
export interface MfaEnrollInfo {
  /** 手入力用（base32） */
  secret: string;
  /** QR コードにする otpauth:// の URL */
  otpauthUrl: string;
}

/** POST /api/auth/mfa/enroll・/api/auth/mfa/verify */
export interface MfaCodeInput {
  code: string;
}

/** POST /api/auth/password */
export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/auth/signup（新規登録。メールの確認 → 管理者の承認のあとに使える） */
export interface SignupInput {
  name: string;
  email: string;
  password: string;
}

/** POST /api/auth/password-reset/request */
export interface PasswordResetRequestInput {
  email: string;
}

/** POST /api/auth/password-reset/confirm */
export interface PasswordResetConfirmInput {
  token: string;
  newPassword: string;
}

/** 新規登録・パスワード再設定・予定確認 URL の再送など、結果を文で返すだけの API の応答 */
export interface MessageResponse {
  message: string;
}

/**
 * 管理者アカウントの状態。
 * pending_email: 新規登録して、メールアドレスの確認待ち / pending_approval: 確認済みで、管理者の承認待ち / active: 使える
 */
export type AccountStatus = 'pending_email' | 'pending_approval' | 'active';

/** GET /api/admin/accounts の1件（管理画面にログインできる人） */
export interface AccountInfo {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
  isSelf: boolean;
}

/** POST /api/admin/accounts */
export interface AccountInput {
  name: string;
  email: string;
}

/** アカウントの追加・パスワード再発行・2段階認証のやり直しの結果。仮パスワードはこの1回しか見られない */
export interface TempPasswordResponse {
  account: AccountInfo;
  tempPassword: string;
}

export type AuthEventKind =
  | 'setup'
  | 'login_success'
  | 'login_failed'
  | 'login_locked'
  | 'mfa_enrolled'
  | 'mfa_failed'
  | 'logout'
  | 'password_changed'
  | 'account_created'
  | 'account_deleted'
  | 'password_reset'
  | 'mfa_reset'
  | 'signup_requested'
  | 'email_verified'
  | 'account_approved'
  | 'password_reset_requested'
  | 'password_reset_by_email';

/** GET /api/admin/auth-events の1件 */
export interface AuthEventItem {
  id: number;
  kind: AuthEventKind;
  email: string | null;
  /** 本人の名前（アカウントが消えていれば null） */
  userName: string | null;
  /** 操作した管理者の名前（アカウントの追加・リセットのとき） */
  actorName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

// ---- メンバー（面接官） ----

export interface ConnectionInfo {
  id: string;
  provider: 'google';
  accountEmail: string;
  checkCalendarIds: string[];
  writeCalendarId: string;
  status: 'active' | 'error';
  lastError: string | null;
}

/** GET /api/admin/members の1件 */
export interface MemberInfo {
  id: string;
  name: string;
  email: string;
  /** 連携している Google カレンダー（無ければ空き確認・予定登録はこのアプリ内の予定だけ） */
  connections: ConnectionInfo[];
}

/** POST /api/admin/members, PATCH /api/admin/members/:id */
export interface MemberInput {
  name: string;
  email: string;
}

/** GET /api/admin/connections/:id/calendars */
export interface GoogleCalendarItem {
  id: string;
  summary: string;
  primary: boolean;
  /** 'owner' | 'writer' | 'reader' | 'freeBusyReader' */
  accessRole: string;
}

// ---- 日程調整カレンダー ----

export interface CalendarMemberView {
  memberId: string;
  name: string;
}

/** GET /api/admin/calendars の1件 */
export interface CalendarSummary {
  id: string;
  kind: 'standard' | 'candidates';
  slug: string;
  name: string;
  internalName: string;
  status: 'open' | 'closed';
  /** 応募者に送る URL（絶対 URL） */
  url: string;
  durationMin: number;
  participation: CalendarSettings['participation'];
  locationType: LocationType;
  members: CalendarMemberView[];
  /** 今後の確定予定の件数 */
  upcomingCount: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/admin/calendars/:id */
export interface CalendarDetail extends CalendarUpdateInput {
  id: string;
  kind: 'standard' | 'candidates';
  url: string;
  /** 候補を選んで日程調整の候補枠（開始時刻） */
  candidateSlots: string[];
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/calendars の入力（残りの項目は初期値で作る。参加メンバーは登録順で最初のメンバー） */
export interface CalendarCreateInput {
  name: string;
}

/** GET /api/admin/calendars/:id/one-time-links の1件 */
export interface OneTimeLinkInfo {
  token: string;
  url: string;
  createdAt: string;
}

/** POST /api/admin/availability（候補を選ぶ画面の空き状況） */
export interface AvailabilityInput {
  memberIds: string[];
  durationMin: number;
  /** 表示する期間（UTC ISO）。最大 14 日 */
  from: string;
  to: string;
  timezone: string;
}
export interface AvailabilityResponse {
  /** 8:00〜21:00 を 30 分刻みにした枠と、全員が空いているか */
  slots: { start: string; end: string; available: boolean }[];
}

/** POST /api/admin/candidate-calendars */
export interface CandidateCalendarInput {
  name: string;
  durationMin: number;
  memberIds: string[];
  location: { type: LocationType; detail: string };
  eventPrivate: boolean;
  /** 候補枠の開始時刻（UTC ISO）。1〜20 枠 */
  slots: string[];
}

// ---- 予定 ----

export interface Answer {
  questionId: string;
  label: string;
  /** チェックボックスは「、」区切りでつなげた文字列 */
  value: string;
}

export interface BookingSummary {
  id: string;
  calendarId: string;
  calendarName: string;
  status: 'confirmed' | 'cancelled';
  startAt: string;
  endAt: string;
  guestName: string;
  guestEmail: string;
  guestCompany: string;
  hosts: { memberId: string; name: string }[];
  locationType: LocationType;
  locationText: string;
  meetingUrl: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: 'guest' | 'host' | null;
}

/** GET /api/admin/bookings/:id */
export interface BookingDetail extends BookingSummary {
  guestComment: string;
  guestTimezone: string;
  answers: Answer[];
  urlParams: Record<string, string>;
  /** 応募者の予定確認ページ（キャンセル・日程変更） */
  manageUrl: string;
  cancelReason: string | null;
  rescheduleCount: number;
}

/** GET /api/admin/bookings?scope=upcoming|past|cancelled&calendarId=&q= */
export interface BookingListResponse {
  bookings: BookingSummary[];
  /** 続きがあれば、次のページを読むときに ?after= に渡す値 */
  nextCursor: string | null;
}

/** GET /api/admin/outbox の1件 */
export interface OutboxItem {
  id: string;
  kind: string;
  toAddr: string;
  subject: string;
  /** 本文。送り終えたものは空（EMAIL_PROVIDER=log の記録だけ残る） */
  body: string;
  /** 'pending' は送信待ち（送れなかったものは間隔を空けて送り直す） */
  status: 'logged' | 'pending' | 'sent' | 'failed';
  error: string | null;
  attempts: number;
  createdAt: string;
}

// ---- 公開 API（応募者。ログイン不要） ----

/** POST /api/public/booking-links（予約した面接の確認 URL をメールで送り直す） */
export interface BookingLinksInput {
  email: string;
}

/** GET /api/public/c/:slug?ot=<ワンタイムトークン>（パスワードはヘッダー x-calendar-password） */
export interface PublicCalendar {
  slug: string;
  kind: 'standard' | 'candidates';
  name: string;
  /** 表示名（未設定ならメンバー名を「、」でつないだもの） */
  displayName: string;
  status: 'open' | 'closed';
  /** 受け付けられない理由（受付停止・ワンタイム URL 使用済み・候補日程の確定済みなど）。受け付けられるなら null */
  closedReason: string | null;
  /** パスワードが必要で、まだ正しいものを受け取っていない。true のとき以下の詳細は空 */
  locked: boolean;
  description: string;
  durationMin: number;
  timezone: string;
  locationType: LocationType;
  locationLabel: string;
  hosts: { name: string; avatarUrl: string | null }[];
  questions: Question[];
  notifyNoSlot: boolean;
  /** 提示期間（カレンダーのタイムゾーンの日付）。候補を選ぶ方式は候補枠の最初と最後 */
  window: { start: string; end: string } | null;
}

/** GET /api/public/c/:slug/slots?from=<ISO>&to=<ISO>&ot=&reschedule=<manageToken> */
export interface SlotsResponse {
  slots: { start: string; end: string }[];
}

/** POST /api/public/c/:slug/bookings */
export interface BookingCreateInput {
  start: string;
  timezone: string;
  /** 質問 ID → 回答。チェックボックスは配列 */
  answers: Record<string, string | string[]>;
  oneTimeToken?: string;
  urlParams?: Record<string, string>;
}

/** 公開の予定（完了画面・予定確認ページ） */
export interface PublicBooking {
  calendarSlug: string;
  calendarName: string;
  calendarKind: 'standard' | 'candidates';
  displayName: string;
  status: 'confirmed' | 'cancelled';
  startAt: string;
  endAt: string;
  guestName: string;
  guestEmail: string;
  guestTimezone: string;
  locationType: LocationType;
  locationLabel: string;
  locationText: string;
  /** 応募者に非公開の設定なら null */
  meetingUrl: string | null;
  hostNames: string[];
  completeMessage: string;
  manageToken: string;
  canCancel: boolean;
  canReschedule: boolean;
  /** キャンセル・日程変更の期限 */
  deadlineAt: string;
  cancelledBy: 'guest' | 'host' | null;
}

export interface BookingCreateResponse {
  booking: PublicBooking;
  /** 完了後の遷移先 URL（設定があれば） */
  redirectUrl: string | null;
}

/** POST /api/public/c/:slug/no-slot（都合の良い日程がない） */
export interface NoSlotInput {
  name: string;
  email: string;
  message: string;
}
