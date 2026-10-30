/**
 * 日程調整カレンダーの設定（booking_calendars.settings の JSON）の形と初期値。
 * 各項目の意味は docs/00_spec.md「4. 日程調整カレンダー」。画面の入力チェックと API の検証の両方でこのスキーマを使う。
 */
import { z } from 'zod';
import { isValidTimeZone } from './time';

const TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** '' か http(s) の URL */
const optionalUrl = z
  .string()
  .max(1000)
  .refine((v) => v === '' || /^https?:\/\/\S+$/.test(v), 'URL は http:// か https:// で始めてください');

export const timeRangeSchema = z
  .object({ start: z.string().regex(TIME_RE), end: z.string().regex(TIME_RE) })
  .refine((r) => r.start < r.end, '終了時刻は開始時刻より後にしてください');
export type TimeRange = z.infer<typeof timeRangeSchema>;

/** 1日の受付時間帯（5枠まで）。空配列 = その日は受け付けない */
export const dayRangesSchema = z.array(timeRangeSchema).max(5, '受付時間帯は1日5枠までです');
/** 曜日ごとの受付時間。添字 0 = 日曜 … 6 = 土曜 */
export const weeklySchema = z.array(dayRangesSchema).length(7);
export type Weekly = z.infer<typeof weeklySchema>;

export const QUESTION_TYPES = ['text', 'textarea', 'checkbox', 'radio', 'select', 'date', 'number'] as const;
export const QUESTION_TYPE_LABELS: Record<(typeof QUESTION_TYPES)[number], string> = {
  text: 'テキスト',
  textarea: 'テキスト（複数行）',
  checkbox: 'チェックボックス（複数回答）',
  radio: 'ラジオボタン',
  select: 'セレクトメニュー',
  date: '日付',
  number: '数字',
};

export const questionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  type: z.enum(QUESTION_TYPES),
  label: z.string().min(1, '質問タイトルを入力してください').max(100),
  help: z.string().max(300),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(100)).max(30),
  /** 既定の4項目。name と email は削除・任意化できない */
  system: z.enum(['name', 'email', 'company', 'comment']).optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const LOCATION_TYPES = ['none', 'google_meet', 'zoom', 'teams', 'phone', 'in_person', 'custom'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
export const LOCATION_LABELS: Record<LocationType, string> = {
  none: '指定なし',
  google_meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  phone: '電話',
  in_person: '対面',
  custom: 'その他',
};
/** まだ自動発行に対応していない Web 会議（docs/00 🔜） */
export const UNSUPPORTED_LOCATIONS: LocationType[] = ['zoom', 'teams'];

export const PARTICIPATION_LABELS = {
  all: '全員が参加',
  any: '誰か1人が参加',
  groups: '2つのグループから1人ずつ参加',
} as const;
export const ASSIGNMENT_LABELS = {
  balanced_slot: '均等（日程候補優先）',
  balanced_count: '均等（担当件数優先）',
  priority: '優先度順',
} as const;

const windowSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('auto'),
    /** 何時間後から先の候補を出すか */
    minNoticeHours: z.number().int().min(0).max(720),
    /** 何日間分（今日を1日目） */
    daysAhead: z.number().int().min(1).max(200),
  }),
  z.object({
    mode: z.literal('fixed'),
    startDate: z.string().regex(DATE_RE),
    endDate: z.string().regex(DATE_RE),
    /** 各候補の開始の何時間前に締め切るか */
    minNoticeHours: z.number().int().min(0).max(720),
  }),
]);

export const calendarSettingsSchema = z
  .object({
    /** 開始時メッセージ（ゲスト画面の上部） */
    description: z.string().max(3000),
    /** 完了時メッセージ（完了画面・完了メール） */
    completeMessage: z.string().max(3000),
    /** 表示名（空ならメンバー名を出す） */
    displayName: z.string().max(100),
    durationMin: z.number().int().min(15).max(480),
    bufferBeforeMin: z.number().int().min(0).max(180),
    bufferAfterMin: z.number().int().min(0).max(180),
    bufferEventTitle: z.string().min(1).max(100),
    participation: z.enum(['all', 'any', 'groups']),
    assignment: z.enum(['balanced_slot', 'balanced_count', 'priority']),
    location: z.object({ type: z.enum(LOCATION_TYPES), detail: z.string().max(500) }),
    hideMeetingUrl: z.boolean(),
    timezone: z.string().refine(isValidTimeZone, 'タイムゾーンが正しくありません'),
    weekly: weeklySchema,
    /** 特定の日の受付時間（曜日の設定より優先）。空配列 = その日は受け付けない */
    dateOverrides: z.record(z.string().regex(DATE_RE), dayRangesSchema),
    acceptHolidays: z.boolean(),
    window: windowSchema,
    /** 日程候補の表示間隔。null = 自動（所要時間と同じ） */
    slotIntervalMin: z.number().int().min(10).max(120).nullable(),
    /** 予約受付件数の上限。null = 上限なし */
    limit: z
      .object({
        period: z.enum(['day', 'week', 'month']),
        mode: z.enum(['uniform', 'per_member']),
        count: z.number().int().min(1).max(1000),
      })
      .nullable(),
    notifyNoSlot: z.boolean(),
    /** キャンセル・リスケの期限（開始の何時間前まで）。null = 終了時刻まで */
    cancelDeadlineHours: z.number().int().min(0).max(720).nullable(),
    allowGuestCancel: z.boolean(),
    allowGuestReschedule: z.boolean(),
    questions: z.array(questionSchema).max(30),
    sendGuestConfirmation: z.boolean(),
    reminder: z.object({
      enabled: z.boolean(),
      /** 前日の何時に送るか（1〜23）。24 = 当日 0:00 */
      hour: z.number().int().min(1).max(24),
      message: z.string().max(2000),
    }),
    hostEmails: z.boolean(),
    notifyEmails: z.array(z.email('メールアドレスが正しくありません')).max(10),
    eventPrivate: z.boolean(),
    /** 連携カレンダーに登録する予定名。{calendar} {guest} {company} を差し込める */
    eventTitle: z.string().min(1).max(200),
    webhookUrl: optionalUrl,
    slackWebhookUrl: optionalUrl,
    redirectUrl: optionalUrl,
    /** 閲覧パスワード。'' = なし */
    password: z.string().max(100),
  })
  .superRefine((s, ctx) => {
    for (const key of ['name', 'email'] as const) {
      const q = s.questions.find((x) => x.system === key);
      if (!q || !q.required) {
        ctx.addIssue({ code: 'custom', path: ['questions'], message: '「名前」と「メールアドレス」は必須の質問として残してください' });
      }
    }
    const ids = new Set<string>();
    for (const q of s.questions) {
      if (ids.has(q.id)) ctx.addIssue({ code: 'custom', path: ['questions'], message: `質問IDが重複しています: ${q.id}` });
      ids.add(q.id);
      if ((q.type === 'checkbox' || q.type === 'radio' || q.type === 'select') && q.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['questions'], message: `「${q.label}」の選択肢を1つ以上入れてください` });
      }
    }
    if (s.window.mode === 'fixed' && s.window.startDate > s.window.endDate) {
      ctx.addIssue({ code: 'custom', path: ['window'], message: '終了日は開始日以降にしてください' });
    }
  });
export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;

/** 応募者に入力してもらう項目の初期値は「名前」と「メールアドレス」だけ（必要なら管理画面で質問を足せる） */
export const DEFAULT_QUESTIONS: Question[] = [
  { id: 'name', type: 'text', label: '名前', help: '', required: true, options: [], system: 'name' },
  { id: 'email', type: 'text', label: 'メールアドレス', help: '', required: true, options: [], system: 'email' },
];

/** 平日 10:00〜18:00（デフォルトの受付時間の初期値） */
export const DEFAULT_WEEKLY: Weekly = [
  [],
  [{ start: '10:00', end: '18:00' }],
  [{ start: '10:00', end: '18:00' }],
  [{ start: '10:00', end: '18:00' }],
  [{ start: '10:00', end: '18:00' }],
  [{ start: '10:00', end: '18:00' }],
  [],
];

export function defaultSettings(weekly: Weekly = DEFAULT_WEEKLY, timezone = 'Asia/Tokyo'): CalendarSettings {
  return {
    description: '',
    completeMessage: '',
    displayName: '',
    durationMin: 60,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    bufferEventTitle: '確保時間',
    participation: 'all',
    assignment: 'balanced_slot',
    location: { type: 'google_meet', detail: '' },
    hideMeetingUrl: false,
    timezone,
    weekly,
    dateOverrides: {},
    acceptHolidays: false,
    window: { mode: 'auto', minNoticeHours: 24, daysAhead: 30 },
    slotIntervalMin: 30,
    limit: null,
    notifyNoSlot: false,
    cancelDeadlineHours: null,
    allowGuestCancel: true,
    allowGuestReschedule: true,
    questions: DEFAULT_QUESTIONS,
    sendGuestConfirmation: true,
    reminder: { enabled: true, hour: 16, message: '' },
    hostEmails: true,
    notifyEmails: [],
    eventPrivate: false,
    eventTitle: '{calendar}（{guest}様）',
    webhookUrl: '',
    slackWebhookUrl: '',
    redirectUrl: '',
    password: '',
  };
}

/** カレンダーの URL スラッグ */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, 'URL は半角英小文字・数字・ハイフンで 3〜64 文字にしてください');

export const calendarMemberInputSchema = z.object({
  memberId: z.string().min(1),
  group: z.union([z.literal(1), z.literal(2)]),
  priority: z.number().int().min(0).max(100),
  bookingLimit: z.number().int().min(1).max(1000).nullable(),
});

export const calendarUpdateSchema = z.object({
  name: z.string().min(1, '日程調整カレンダー名を入力してください').max(100),
  internalName: z.string().max(100),
  slug: slugSchema,
  status: z.enum(['open', 'closed']),
  settings: calendarSettingsSchema,
  members: z.array(calendarMemberInputSchema).min(1, '参加メンバーを1人以上選んでください').max(12, '参加メンバーは12人までです'),
});
export type CalendarUpdateInput = z.infer<typeof calendarUpdateSchema>;
