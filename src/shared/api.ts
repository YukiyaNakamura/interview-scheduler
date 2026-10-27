/**
 * Worker と画面の間の API の型（ここが正）。エンドポイントの一覧は docs/01_architecture.md「API」。
 * 日時（*At）はすべて UTC の ISO 文字列。
 * ログインはない。管理画面の API は /api/admin/*、応募者（ゲスト）の API は /api/public/*
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
}

/** GET /api/admin/outbox の1件 */
export interface OutboxItem {
  id: string;
  kind: string;
  toAddr: string;
  subject: string;
  body: string;
  status: 'logged' | 'sent' | 'failed';
  error: string | null;
  createdAt: string;
}

// ---- 公開 API（応募者。ログイン不要） ----

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
