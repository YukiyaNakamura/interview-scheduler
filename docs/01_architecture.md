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
  lib/           セッション（session.ts）・回数の上限（limits.ts）・パスワード（password.ts）・2段階認証（totp.ts）・個人情報の暗号化（pii.ts）・ID・ICS など
src/web/         画面（最初の画面 /・応募者の案内 /guest・管理画面 /admin・ログイン /login と応募画面 /c, /r）
public/_headers  画面の応答ヘッダー（管理画面・ログインの埋め込み禁止と CSP、Referrer-Policy）
```

## ログイン
**管理画面（`/admin`）だけログインが要る。応募者はログインしない**（`/c/<URL>` `/r/<トークン>` `/api/public/*` は誰でも開ける）。

- 管理者（`admin_users`）と面接官（`members`）は別。管理者どうしの権限の差はない
- ログインの順番: メールアドレス＋パスワード → 2段階認証（必須。認証アプリの6桁、TOTP）→ 仮パスワードなら変更 → 管理画面。
  `GET /api/auth/session` の `step`（AuthState）で今の段階を返し、`done` になるまで `/api/admin/*` と `/auth/google/*` は通さない
- 最初の画面（`/`）で「採用担当の方」→ `/login`、「応募者の方」→ `/guest`（案内と、予約した面接の確認 URL の再送）を選ぶ
- 最初の管理者: 使える管理者が0人のときだけ `/login` に初期設定が出る。サーバーの秘密情報 `ADMIN_SETUP_TOKEN` を知っている人だけが作れる。
  アプリからは使える管理者を0人にできない（同時に消し合っても0人にならない）
- 2人目から（どちらか）:
  - **新規登録**（`/login?mode=signup`）: 名前・メール・パスワード → 確認メールのリンクを開き、**登録したパスワードを入れる**（他人が勝手に登録した確認メールを本人がうっかり開いても進まないように）
    → 状態が「承認待ち」になり、使える管理者全員に承認依頼のメール → 「アカウント」画面で承認すると本人にメール → 初回ログインで2段階認証を登録。
    登録済みのメールアドレスで登録されたときは、応答は同じにして本人のメールにだけ知らせる
  - **アカウントの追加**: 管理者が「アカウント」で名前とメールを入れると仮パスワードが1回だけ表示される。本人は初回ログインで2段階認証を登録し、パスワードを変える
- **パスワードを忘れた**（`/login?mode=forgot`）: メールアドレスを入れると再設定のリンク（30分・1回だけ）を送る。登録の有無は応答から分からない。
  再設定するとその人のセッションをすべて切る。2段階認証はそのまま必要
- スマホを変えた: ほかの管理者が「2段階認証をやり直す」（仮パスワードも出し直す）。
  管理者が1人で自分のスマホをなくしたときは README の「管理者が1人でログインできなくなったとき」

守り方:

| 対象 | やり方 |
|---|---|
| パスワード | PBKDF2-SHA256・10万回（Workers の上限）・人ごとの salt。12文字以上、連番・よくある言葉・メールアドレスを含むものは不可（`src/shared/password.ts`） |
| 2段階認証 | TOTP（RFC 6238、30秒・6桁・前後30秒まで）。秘密鍵は TOKEN_ENC_KEY で AES-GCM 暗号化して保存。一度通したコードは使えない（`totp_last_step`） |
| 総当たり・大量送信 | パスワードやコードを確かめる**前に**1回分を数え、成功したら戻す（同時に大量に送っても上限を超えて試せない。`lib/limits.ts`）。メールを送るもの（新規登録・パスワード再設定・予定確認 URL の再送）は送り先ごとに1時間3回・IP ごとに5回まで。パスワードは同じメールアドレスで15分に5回・同じ IP で15分に20回、2段階認証は管理者ごとに24時間で10回まで（超えたらそれぞれ15分・24時間ロック）。2段階認証はパスワードと別に数えるので、他人がパスワードを当てずっぽうで試していても、パスワードを通った本人のコード入力は止まらない。ほかの管理者がリセットするとロックも解ける |
| 登録の有無 | 「メールアドレスまたはパスワードが違います」だけを返し、存在しないメールアドレスでも同じだけ時間をかける |
| セッション | Cookie は HttpOnly・SameSite=Lax・https では Secure と `__Host-` 接頭辞。DB には値の SHA-256 だけを持つ。パスワード段階は10分、ログイン後は12時間（2時間操作がなければ切れる）。段階が進むたび・パスワード変更のたびに値を作り直し、パスワード段階のセッションは1回しか使えない。パスワード変更・リセットでその人の全セッションを切る |
| CSRF | SameSite=Lax に加え、`/api/auth/*` `/api/admin/*` の書き込みは Origin（無ければ Sec-Fetch-Site）が自分のサイトでなければ 403 |
| ヘッダー | API は `secureHeaders`（nosniff・HSTS など）と `Cache-Control: no-store`。画面は `public/_headers` で管理画面・ログインに `X-Frame-Options: DENY` と CSP、全体に `Referrer-Policy: same-origin`。応募画面 `/c/*` は埋め込みウィジェットのため埋め込みを許す |
| メールのリンク | 新規登録の確認（24時間）・パスワード再設定（30分）のトークンは DB に SHA-256 だけを持ち、1回使うと消す。画面は開いたらすぐ URL からトークンを消す |
| 記録 | ログイン成功・失敗・ロック・パスワード変更・新規登録・承認・アカウントの追加/削除/リセットを `auth_events` に残し、「アカウント」画面に直近100件を出す（180日で削除） |

## 個人情報の暗号化
DB（D1）にはメールアドレスを平文で入れない（`src/worker/lib/pii.ts`。D1 自体の保存時の暗号化とは別に、アプリ側でも暗号化する）。

| 何を | どう持つか |
|---|---|
| パスワード | 暗号化ではなく**ハッシュ化**（PBKDF2。元に戻せない） |
| メールアドレス（管理者・面接官・応募者・Google アカウント・ログインの記録） | `*_enc`（AES-GCM で暗号化。同じ値でも毎回違う暗号文）＋ `*_hash`（検索用の目印。小文字にしたメールの HMAC-SHA256。値から元のメールは分からない） |
| 応募者の回答（メールアドレスの回答を含む） | `answers_enc`（JSON ごと暗号化） |
| カレンダーの設定（通知先メールアドレス・閲覧パスワード・Webhook URL を含む） | `settings_enc`（JSON ごと暗号化） |
| 送信ログの宛先・件名・本文 | `to_addr_enc` `subject_enc` `body_enc` |
| 2段階認証の秘密鍵・Google のトークン | AES-GCM で暗号化（前から） |
| 名前・会社名 | 平文（予定一覧の部分一致検索に使うため） |

- 鍵は `TOKEN_ENC_KEY`（暗号化用）と、そこから HKDF で作った目印用の鍵。**この鍵をなくす・変えると、保存したメールアドレスなどは読めなくなる**
- 暗号化・復号は `src/worker/db/*` の読み書きでだけ行い、ほかのコードは復号済みの値を扱う。鍵は Worker の入口で `configurePii(env.TOKEN_ENC_KEY)` して覚える
- 予定一覧の検索: 名前・会社名は部分一致、メールアドレスは完全一致（大文字・小文字は問わない）

## そのほか
- 面接官の Google カレンダー連携（`/auth/google/*`）は管理画面へのログインとは別。ログイン中の管理者が、面接官ごとにカレンダーの読み書きの許可をもらう
- 応募者の予定の操作（キャンセル・日程変更）は予定ごとの乱数トークン（manage_token）の URL で行う
- さらに守りたいとき: Cloudflare Access で `/admin*` `/api/admin/*` `/api/auth/*` `/auth/*` `/login*` を社内のメールアドレスに限定すると、アプリのログインの前にもう一段の確認が入る（任意）

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
| POST | /api/auth/signup | SignupInput → 202 MessageResponse（確認メールを送る。登録の有無によらず同じ応答） |
| POST | /api/auth/verify-email | `{token, password}` → MessageResponse（承認待ちにして管理者へ依頼） |
| POST | /api/auth/password-reset/request | PasswordResetRequestInput → MessageResponse（登録の有無によらず同じ応答） |
| POST | /api/auth/password-reset/confirm | PasswordResetConfirmInput → MessageResponse |
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
| GET | /api/admin/bookings | BookingListResponse（`scope=upcoming\|past\|cancelled`, `calendarId`, `q`。`q` は名前・会社名の部分一致かメールアドレスの完全一致） |
| GET | /api/admin/bookings.csv | CSV（同じ絞り込み） |
| GET | /api/admin/bookings/:id | BookingDetail |
| POST | /api/admin/bookings/:id/cancel | 管理者がキャンセル `{reason}` |
| GET | /api/admin/outbox | 送信ログ OutboxItem[]（最新 200 件） |
| GET/POST | /api/admin/accounts | 管理者の一覧 AccountInfo[] / 追加 AccountInput → TempPasswordResponse |
| POST | /api/admin/accounts/:id/approve | 新規登録した人を承認（承認待ちの人だけ）→ AccountInfo |
| POST | /api/admin/accounts/:id/reset-password | 仮パスワードを発行（その人のセッションを切る。自分・承認前の人は不可）→ TempPasswordResponse |
| POST | /api/admin/accounts/:id/reset-mfa | 2段階認証を消し、仮パスワードも発行 → TempPasswordResponse |
| DELETE | /api/admin/accounts/:id | 削除（承認待ちの人の却下もこれ。自分は不可。使える管理者を0人にはできない） |
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
| POST | /api/public/booking-links | BookingLinksInput → MessageResponse（これからの予約があれば予定確認 URL をメールで送る。予約の有無によらず同じ応答） |

エラーは `{ error: string, issues?: [...] }`（ApiError）と 4xx/5xx。

## 画面
管理画面:

| パス | 画面 |
|---|---|
| / | 最初の画面。「採用担当の方」（→ /login）と「応募者の方」（→ /guest）を選ぶ |
| /login | ログイン（初期設定・パスワード・2段階認証・仮パスワードの変更）。`?mode=signup` 新規登録、`?mode=forgot` パスワードを忘れた。`?next=/admin/...` でログイン後の戻り先 |
| /login/verify?token= | 新規登録のメールアドレスの確認（登録したパスワードを入れる） |
| /login/reset?token= | パスワードの再設定 |
| /admin | 日程調整カレンダー一覧（ホーム） |
| /admin/calendars/:id | カレンダー編集（基本設定・受付時間・提示期間・質問・通知・共有） |
| /admin/candidates/new | 候補を選んで日程調整 |
| /admin/bookings | 予定一覧（今後・過去・キャンセル）と CSV |
| /admin/bookings/:id | 予定詳細・キャンセル |
| /admin/members | メンバー（面接官）の登録・Google カレンダー連携 |
| /admin/outbox | 送信ログ |
| /admin/accounts | 管理者のアカウント（新規登録の承認・追加・再発行・削除）、自分のパスワード変更、ログインの記録 |

応募画面:

| パス | 画面 |
|---|---|
| /guest | 応募者の方へ: 届いた URL から日時を選ぶ案内、予約した面接の確認 URL の再送 |
| /c/:slug | 日時を選ぶ → 名前・メールアドレスを入れる → 完了（`?ot=` `?embed=1` `?name=` `?email=` など） |
| /r/:token | 予定の確認・キャンセル・日程変更 |

## 定時実行
- `*/10 * * * *` リマインドメール（jobs/reminders.ts）
- `0 18 * * *` 期限切れの OAuth state・セッション・メールのリンク、古い試行回数、7日たってもメール確認されない新規登録、180日より前のログインの記録の削除
