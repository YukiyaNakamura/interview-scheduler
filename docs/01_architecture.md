# 構成

## 技術
- Cloudflare Workers 1つ（Hono）で API・定時実行・画面の配信をする。`/api/*` `/auth/*` は Worker、それ以外は SPA（`dist/web`）
- D1（SQLite）。スキーマは `migrations/`、日時はすべて UTC ISO 文字列
- 画面: React 19 + Vite + React Router + TanStack Query、プレーン CSS（`src/web/styles/`）
- 検証: Zod（`src/shared/schema.ts` を Worker と画面で共有）
- テスト: Vitest（`test/`。空き枠計算・パスワード・2段階認証のコードなどの純粋関数）

## ディレクトリ
```
src/shared/      Worker と画面で共有（API の型 api.ts、設定スキーマ schema.ts、日時 time.ts、空き枠計算 slots.ts、パスワードの決まり password.ts）
src/worker/      Worker
  index.ts       Hono アプリと scheduled()
  env.ts         Bindings の型
  routes/        API（auth, accounts, admin, google, public）
  db/            D1 アクセス（ORM なし）
  integrations/  google.ts（OAuth・FreeBusy・予定登録）, notify.ts（メール・Webhook）
  services/      予約の確定・キャンセル・リスケ（DB・Google・メール・Webhook をまとめる）
  jobs/          定時実行（reminders, cleanup）
  lib/           セッション（session.ts）・パスワード（password.ts）・2段階認証（totp.ts）・暗号化・ID・ICS など
src/web/         画面（管理画面 /admin・ログイン /login と応募画面 /c, /r）
public/_headers  画面の応答ヘッダー（管理画面・ログインの埋め込み禁止と CSP、Referrer-Policy）
```

## ログイン
**管理画面（`/admin`）だけログインが要る。応募者はログインしない**（`/c/<URL>` `/r/<トークン>` `/api/public/*` は誰でも開ける）。

- 管理者（`admin_users`）と面接官（`members`）は別。管理者どうしの権限の差はない
- ログインの順番: メールアドレス＋パスワード → 2段階認証（必須。認証アプリの6桁、TOTP）→ 仮パスワードなら変更 → 管理画面。
  `GET /api/auth/session` の `step`（AuthState）で今の段階を返し、`done` になるまで `/api/admin/*` と `/auth/google/*` は通さない
- 最初の管理者: 管理者が0人のときだけ `/login` に初期設定が出る。サーバーの秘密情報 `ADMIN_SETUP_TOKEN` を知っている人だけが作れる。
  アプリからは最後の1人を消せない（同時に消し合っても0人にならない）
- 2人目から: 管理画面の「アカウント」で名前とメールを入れると仮パスワードが1回だけ表示される。本人は初回ログインで2段階認証を登録し、パスワードを変える
- 忘れた・スマホを変えた: ほかの管理者が「パスワード再発行」「2段階認証をやり直す」（後者は仮パスワードも出し直す）。
  管理者が1人で自分のスマホをなくしたときは README の「管理者が1人でログインできなくなったとき」

守り方:

| 対象 | やり方 |
|---|---|
| パスワード | PBKDF2-SHA256・10万回（Workers の上限）・人ごとの salt。12文字以上、連番・よくある言葉・メールアドレスを含むものは不可（`src/shared/password.ts`） |
| 2段階認証 | TOTP（RFC 6238、30秒・6桁・前後30秒まで）。秘密鍵は TOKEN_ENC_KEY で AES-GCM 暗号化して保存。一度通したコードは使えない（`totp_last_step`） |
| 総当たり | パスワードやコードを確かめる**前に**1回分を数え、成功したら戻す（同時に大量に送っても上限を超えて試せない）。パスワードは同じメールアドレスで15分に5回・同じ IP で15分に20回、2段階認証は管理者ごとに24時間で10回まで（超えたらそれぞれ15分・24時間ロック）。2段階認証はパスワードと別に数えるので、他人がパスワードを当てずっぽうで試していても、パスワードを通った本人のコード入力は止まらない。ほかの管理者がリセットするとロックも解ける |
| 登録の有無 | 「メールアドレスまたはパスワードが違います」だけを返し、存在しないメールアドレスでも同じだけ時間をかける |
| セッション | Cookie は HttpOnly・SameSite=Lax・https では Secure と `__Host-` 接頭辞。DB には値の SHA-256 だけを持つ。パスワード段階は10分、ログイン後は12時間（2時間操作がなければ切れる）。段階が進むたび・パスワード変更のたびに値を作り直し、パスワード段階のセッションは1回しか使えない。パスワード変更・リセットでその人の全セッションを切る |
| CSRF | SameSite=Lax に加え、`/api/auth/*` `/api/admin/*` の書き込みは Origin（無ければ Sec-Fetch-Site）が自分のサイトでなければ 403 |
| ヘッダー | API は `secureHeaders`（nosniff・HSTS など）と `Cache-Control: no-store`。画面は `public/_headers` で管理画面・ログインに `X-Frame-Options: DENY` と CSP、全体に `Referrer-Policy: same-origin`。応募画面 `/c/*` は埋め込みウィジェットのため埋め込みを許す |
| 記録 | ログイン成功・失敗・ロック・パスワード変更・アカウントの追加/削除/リセットを `auth_events` に残し、「アカウント」画面に直近100件を出す（180日で削除） |

- 面接官の Google カレンダー連携（`/auth/google/*`）は管理画面へのログインとは別。ログイン中の管理者が、面接官ごとにカレンダーの読み書きの許可をもらう
- 応募者の予定の操作（キャンセル・日程変更）は予定ごとの乱数トークン（manage_token）の URL で行う
- さらに守りたいとき: Cloudflare Access で `/admin*` `/api/admin/*` `/api/auth/*` `/auth/*` `/login` を社内のメールアドレスに限定すると、アプリのログインの前にもう一段の確認が入る（任意）

## API
ログイン（`/api/auth`。ログイン前でも呼べる）:

| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/auth/session | 今の段階 AuthState |
| POST | /api/auth/setup | 最初の管理者を作る SetupInput（管理者が0人のときだけ。ADMIN_SETUP_TOKEN が要る）→ AuthState |
| POST | /api/auth/login | LoginInput → AuthState（`mfa_enroll` か `mfa_verify`） |
| GET | /api/auth/mfa/enroll | 認証アプリに登録する秘密鍵 MfaEnrollInfo（パスワード段階のセッションで、未登録のとき） |
| POST | /api/auth/mfa/enroll | `{code}` 最初のコードを確かめて登録 → AuthState |
| POST | /api/auth/mfa/verify | `{code}` → AuthState |
| POST | /api/auth/password | PasswordChangeInput（仮パスワードからの変更もここ）→ AuthState |
| POST | /api/auth/logout | ログアウト → AuthState |

管理画面用（`/api/admin`。ログインが要る。未ログインは 401）:

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
| GET/POST | /api/admin/accounts | 管理者の一覧 AccountInfo[] / 追加 AccountInput → TempPasswordResponse |
| POST | /api/admin/accounts/:id/reset-password | 仮パスワードを発行（その人のセッションを切る。自分は不可）→ TempPasswordResponse |
| POST | /api/admin/accounts/:id/reset-mfa | 2段階認証を消し、仮パスワードも発行 → TempPasswordResponse |
| DELETE | /api/admin/accounts/:id | 削除（自分・最後の1人は不可） |
| GET | /api/admin/auth-events | ログインの記録 AuthEventItem[]（直近 100 件） |

Google 連携（管理画面にログイン中の管理者だけ。未ログインならログイン画面へ）:

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
| /login | ログイン（初期設定・パスワード・2段階認証・仮パスワードの変更）。`?next=/admin/...` でログイン後の戻り先 |
| /admin | 日程調整カレンダー一覧（ホーム） |
| /admin/calendars/:id | カレンダー編集（基本設定・受付時間・提示期間・質問・通知・共有） |
| /admin/candidates/new | 候補を選んで日程調整 |
| /admin/bookings | 予定一覧（今後・過去・キャンセル）と CSV |
| /admin/bookings/:id | 予定詳細・キャンセル |
| /admin/members | メンバー（面接官）の登録・Google カレンダー連携 |
| /admin/outbox | 送信ログ |
| /admin/accounts | 管理者のアカウント（追加・再発行・削除）、自分のパスワード変更、ログインの記録 |

応募画面:

| パス | 画面 |
|---|---|
| /c/:slug | 日時を選ぶ → 名前・メールアドレスを入れる → 完了（`?ot=` `?embed=1` `?name=` `?email=` など） |
| /r/:token | 予定の確認・キャンセル・日程変更 |

## 定時実行
- `*/10 * * * *` リマインドメール（jobs/reminders.ts）
- `0 18 * * *` 期限切れの OAuth state・セッション・古いログイン失敗回数、180日より前のログインの記録の削除
