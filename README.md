# Aiteru（面接の日程調整）

TimeRex の仕様をもとにした面接の日程調整 Web アプリ。最初の画面（`/`）で「採用担当の方」か「応募者の方」を選ぶ。

- **管理画面** `/admin`（**ログインが要る**: パスワード＋2段階認証）: 面接官（メンバー）を登録し、日程調整カレンダーを作って URL を応募者に送る。確定した予定の確認・キャンセル・CSV
- **応募画面** `/c/<URL>`（ログインなし）: 応募者は日時を選び、名前とメールアドレスを入れるだけで面接が確定する

- 仕様: [docs/00_spec.md](docs/00_spec.md)（✅ 実装済み / 🔜 未実装 の一覧つき）
- 構成・API・画面: [docs/01_architecture.md](docs/01_architecture.md)
- 技術: Cloudflare Workers（Hono）+ D1 + React 19 / Vite（sns_pdca と同じ構成）

## ローカルで動かす

```sh
npm install
cp .dev.vars.example .dev.vars   # 手元用の設定。TOKEN_ENC_KEY と ADMIN_SETUP_TOKEN を埋める（下の注意）
npm run db:migrate:local   # 手元の D1 にテーブルを作る
npm run dev                # http://localhost:5180
```

`TOKEN_ENC_KEY` には、`openssl rand -base64 32` を実行して**表示された文字列**（`q3Zk…8w=` のような44文字ほど）を貼る。コマンドそのものを貼るのではない。
`ADMIN_SETUP_TOKEN` も同じように `openssl rand -base64 24` の出力を貼る。

http://localhost:5180 を開き「採用担当の方」を選ぶとログイン画面になる。初回は「最初の管理者を作る」が出るので、`.dev.vars` の `ADMIN_SETUP_TOKEN` を入れて自分のアカウントを作り、
スマホの認証アプリ（Google Authenticator など）で QR コードを読み取って6桁のコードを入れる。
ログインしたら「メンバー」で面接官を登録 →「日程調整カレンダー」で新規作成 → URL を開くと応募画面。
手元では `.dev.vars` の `EMAIL_PROVIDER=log` でメールを実際には送らず、管理画面の「送信ログ」で中身を確認できる
（新規登録の確認メール・パスワード再設定のリンクもここに出る。開発中は送信ログから URL を開いて試す）。

```sh
npm test            # 空き枠計算・リマインド時刻・パスワード・2段階認証・暗号化・回数制限のテスト
npm run typecheck
```

リマインドの定時実行を手元で試す: `curl "http://localhost:5180/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"`

## Google カレンダー連携を有効にする

1. Google Cloud Console でプロジェクトを作り、「Google Calendar API」を有効にする
2. OAuth 同意画面を作る（社内だけで使うなら「内部」）。スコープ: `openid` `email` `profile` `calendar.readonly` `calendar.events`
3. 認証情報 →「OAuth クライアント ID」（ウェブアプリケーション）。承認済みのリダイレクト URI に
   `http://localhost:5180/auth/google/callback` と本番の `https://<本番URL>/auth/google/callback` を入れる
4. `.dev.vars` に `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` を書いて `npm run dev` し直す
5. 管理画面の「メンバー」で、各面接官の「Googleカレンダーを連携」を押す（その人の Google アカウントで許可する）

連携すると、空き確認（FreeBusy）・予定の自動登録・Google Meet の URL 発行・キャンセル時の削除が動く。

## 本番に出す

`wrangler secret put` は値を聞いてくるので、そこに貼る。`openssl rand …` と書いたものは、そのコマンドを実行して表示された文字列を貼る（コマンドそのものではない）。

```sh
npx wrangler d1 create interview-scheduler-db   # 出てきた database_id を wrangler.jsonc に書く
npx wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32 の出力（メールアドレスなどの暗号化の鍵。下の「暗号化の鍵」を必ず読む）
npx wrangler secret put ADMIN_SETUP_TOKEN      # 最初の管理者を作るときの合言葉。openssl rand -base64 24 の出力
npx wrangler secret put APP_URL                # 例: https://interview-scheduler.<サブドメイン>.workers.dev（メールのリンクとリマインドに使う）
npx wrangler secret put RESEND_API_KEY         # メール送信（Resend）の API キー
npx wrangler secret put EMAIL_FROM             # 例: 採用担当 <noreply@your-domain.jp>（Resend で認証したドメイン）
npx wrangler secret put GOOGLE_CLIENT_ID       # Google カレンダー連携を使うなら
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

`npm run deploy` は、型チェック → テスト → 設定の確認（`scripts/check-deploy.mjs`）→ 本番 DB のマイグレーション → ビルド → デプロイ の順に動く。
設定の確認では、`database_id` が仮の値のまま・`vars.EMAIL_PROVIDER` が `"resend"` でない・必須の秘密情報（`TOKEN_ENC_KEY` `APP_URL` `RESEND_API_KEY` `EMAIL_FROM`）が無い、のどれかがあると止まる
（メールが送れないと、確定・リマインドのメールが届かず、新規登録の確認・パスワードを忘れた・予定確認 URL の再送も使えないため）。
`wrangler.jsonc` の `vars` は本番の値で、手元では `.dev.vars` の値（`EMAIL_PROVIDER=log` など）が優先される。

本番のログ（`console.log` / `console.error`）は Cloudflare ダッシュボードの Workers Logs で見られる（`wrangler.jsonc` の `observability`）。
送れなかったメールは「送信ログ」に「送信待ち」「失敗」として出る。

### 暗号化の鍵（TOKEN_ENC_KEY）

メールアドレス・応募者の回答・カレンダーの設定・送信ログは、この鍵で暗号化して DB に入れている（docs/01「個人情報の暗号化」）。
**鍵をなくしたり別の値に変えたりすると、保存したメールアドレスなどが読めなくなる。** `wrangler secret put` で入れた値は後から見られないので、
作ったときにパスワード管理ソフトなど安全な場所に控えておく。

### 最初の管理者を作る

デプロイしたら、すぐに `https://<本番URL>/login` を開き、`ADMIN_SETUP_TOKEN` に入れた合言葉で最初の管理者を作る。
合言葉を知らない人は作れず、管理者が1人できた後はこの画面は出ない。2人目からは管理画面の「アカウント」で追加する
（仮パスワードが1回だけ表示されるので、メール以外の方法で本人に伝える）。
作り終えたら `npx wrangler secret delete ADMIN_SETUP_TOKEN` で合言葉を消しておくとより安全（初期設定をやり直すときにまた入れる）。

### ログインの仕組み（詳しくは docs/01「ログイン」）

- 管理画面と管理 API はパスワード＋2段階認証（認証アプリの6桁）が必須。応募画面（`/c/*` `/r/*` `/guest` `/api/public/*`）はログインなし
- 新規登録した人は、メールアドレスの確認と既存の管理者の承認（「アカウント」画面）が済むまで使えない
- パスワードを忘れたら、ログイン画面の「パスワードを忘れた方」からメールで再設定できる（2段階認証はそのまま必要）
- パスワードは同じメールアドレスで15分に5回・同じ IP で20回、2段階認証のコードは24時間に10回まで。超えるとロックし、ほかの管理者がリセットすると解ける。ログインの記録は「アカウント」画面で見られる
- さらに守りたいときは、Cloudflare Zero Trust → Access で `/admin*` `/api/admin/*` `/api/auth/*` `/auth/*` `/login` を社内のメールアドレスに限定できる（任意。アプリのコードは変更不要）

### 管理者が1人でログインできなくなったとき

ほかに管理者がいれば、その人に「アカウント」画面から「パスワード再発行」か「2段階認証をやり直す」をしてもらう。
管理者が1人だけで、パスワードを忘れた・スマホをなくしたときは、Cloudflare の権限がある人が次を実行すると、その人を消して初期設定からやり直せる
（予定やカレンダーは消えない）:

```sh
# 1. 消す人の id を調べる（メールアドレスは暗号化しているので、名前で見分ける）
npx wrangler d1 execute interview-scheduler-db --remote --command "SELECT id, name, status, created_at FROM admin_users"
# 2. その id の人を消す
npx wrangler d1 execute interview-scheduler-db --remote --command "DELETE FROM admin_users WHERE id = '<1で調べた id>'"
# そのあと /login を開くと「最初の管理者を作る」が出る（ADMIN_SETUP_TOKEN が要る。消していたら wrangler secret put で入れ直す）
```

## まだ無いもの（docs/00 の 🔜）

Zoom / Microsoft Teams の URL 自動発行、Outlook 予定表連携、質問のファイルアップロード、グループ投票・セミナー・ルーティング、
候補を選んで日程調整の「仮予定」登録、確定後の参加者変更、応募画面のボット対策（Turnstile）、
Google / Microsoft アカウントでの管理画面ログイン。
