# 構成

## 技術
- Cloudflare Workers 1つ（Hono）で API・定時実行・画面の配信をする。`/api/*` `/auth/*` は Worker、それ以外は SPA（`dist/web`）
- D1（SQLite）。スキーマは `migrations/`、日時はすべて UTC ISO 文字列
- 画面: React 19 + Vite + React Router + TanStack Query、プレーン CSS（`src/web/styles/`）
- 検証: Zod（`src/shared/schema.ts` を Worker と画面で共有）
- テスト: Vitest（`test/`。空き枠計算などの純粋関数）

## ディレクトリ
```
src/shared/      Worker と画面で共有（API の型 api.ts、設定スキーマ schema.ts、日時 time.ts、空き枠計算 slots.ts）
src/worker/      Worker
  index.ts       Hono アプリと scheduled()
  env.ts         Bindings の型
  routes/        API（admin, google, public）
  db/            D1 アクセス（ORM なし）
  integrations/  google.ts（OAuth・FreeBusy・予定登録）, notify.ts（メール・Webhook）
  services/      予約の確定・キャンセル・リスケ（DB・Google・メール・Webhook をまとめる）
  jobs/          定時実行（reminders, cleanup）
  lib/           暗号化・ID・ICS など
src/web/         画面（管理画面 /admin と応募画面 /c, /r）
```

## ログイン
**このアプリにログインはない。** 管理画面（`/admin`）も応募画面（`/c/<URL>`）も URL を開くだけで使える。
- 面接官（メンバー）は管理画面で名前とメールアドレスを登録する。Google カレンダーはメンバーごとに「連携する」ボタンから OAuth でつなぐ（ログインではなく、カレンダーを読む・書く許可をもらうだけ）
- 応募者の予定の操作（キャンセル・日程変更）は予定ごとの乱数トークン（manage_token）の URL で行う
- **本番で管理画面を守る**: 管理画面と管理 API はパスを `/admin*` `/api/admin/*` `/auth/*` に分けてある。
  公開するときは Cloudflare Zero Trust の Access でこの3つのパスだけを社内のメールアドレスに限定する（アプリのコードは変えない）。
  応募画面 `/c/*` `/r/*` `/api/public/*` は誰でも開けるままにする

## API
管理画面用（`/api/admin`）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/config | アプリ設定 AppConfig |
| GET/POST | /api/admin/members | メンバー一覧 MemberInfo[] / 追加 MemberInput |
| PATCH/DELETE | /api/admin/members/:id | 名前・メールの変更 / 削除（担当中の予定が残っていても削除できる。参加メンバーからは外れる） |
| GET | /api/admin/connections/:id/calendars | Google のカレンダー一覧 GoogleCalendarItem[] |
| PATCH | /api/admin/connections/:id | `{checkCalendarIds, writeCalendarId}` → ConnectionInfo |
| DELETE | /api/admin/connections/:id | 連携解除 |
| GET | /api/admin/calendars | CalendarSummary[] |
| POST | /api/admin/calendars | `{name}` → CalendarDetail（初期値で作成） |
| GET/PUT/DELETE | /api/admin/calendars/:id | CalendarDetail / CalendarUpdateInput |
| POST | /api/admin/calendars/:id/duplicate | 複製 → CalendarDetail |
| GET/POST | /api/admin/calendars/:id/one-time-links | ワンタイム URL 一覧 OneTimeLinkInfo[] / 発行 |
| DELETE | /api/admin/one-time-links/:token | ワンタイム URL 削除 |
| POST | /api/admin/availability | 候補を選ぶ画面の空き状況 |
| POST | /api/admin/candidate-calendars | 候補を選んで日程調整を作成 → CalendarDetail |
| GET | /api/admin/bookings | BookingListResponse（`scope=upcoming\|past\|cancelled`, `calendarId`, `q`） |
| GET | /api/admin/bookings.csv | CSV（同じ絞り込み） |
| GET | /api/admin/bookings/:id | BookingDetail |
| POST | /api/admin/bookings/:id/cancel | 管理者がキャンセル `{reason}` |
| GET | /api/admin/outbox | 送信ログ OutboxItem[]（最新 200 件） |

Google 連携（ログインではない）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | /auth/google/start?member=<id>&redirect=/admin/members | そのメンバーの Google カレンダーを連携する |
| GET | /auth/google/callback | 連携の戻り先。終わったら redirect へ（失敗時は `?error=`） |

応募者用（`/api/public`）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/public/c/:slug | PublicCalendar（`?ot=` ワンタイム、ヘッダー `x-calendar-password`） |
| GET | /api/public/c/:slug/slots | SlotsResponse（`from` `to` は ISO、`ot`、`reschedule=<manageToken>`。reschedule があればパスワード不要） |
| POST | /api/public/c/:slug/bookings | BookingCreateInput → BookingCreateResponse |
| POST | /api/public/c/:slug/no-slot | NoSlotInput（都合の良い日程がない） |
| GET | /api/public/bookings/:token | PublicBooking |
| POST | /api/public/bookings/:token/cancel | `{reason}` |
| POST | /api/public/bookings/:token/reschedule | `{start}` → PublicBooking |
| GET | /api/public/bookings/:token/ics | ICS ファイル |

エラーは `{ error: string, issues?: [...] }`（ApiError）と 4xx/5xx。

## 画面
管理画面:

| パス | 画面 |
|---|---|
| / | /admin へ |
| /admin | 日程調整カレンダー一覧（ホーム） |
| /admin/calendars/:id | カレンダー編集（基本設定・受付時間・提示期間・質問・通知・共有） |
| /admin/candidates/new | 候補を選んで日程調整 |
| /admin/bookings | 予定一覧（今後・過去・キャンセル）と CSV |
| /admin/bookings/:id | 予定詳細・キャンセル |
| /admin/members | メンバー（面接官）の登録・Google カレンダー連携 |
| /admin/outbox | 送信ログ |

応募画面:

| パス | 画面 |
|---|---|
| /c/:slug | 日時を選ぶ → 名前・メールアドレスを入れる → 完了（`?ot=` `?embed=1` `?name=` `?email=` など） |
| /r/:token | 予定の確認・キャンセル・日程変更 |

## 定時実行
- `*/10 * * * *` リマインドメール（jobs/reminders.ts）
- `0 18 * * *` 期限切れの OAuth state の削除
