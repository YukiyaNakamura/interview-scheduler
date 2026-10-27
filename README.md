# Aiteru（面接の日程調整）

TimeRex の仕様をもとにした面接の日程調整 Web アプリ。**ログインはない。**

- **管理画面** `/admin`: 面接官（メンバー）を登録し、日程調整カレンダーを作って URL を応募者に送る。確定した予定の確認・キャンセル・CSV
- **応募画面** `/c/<URL>`: 応募者は日時を選び、名前とメールアドレスを入れるだけで面接が確定する

- 仕様: [docs/00_spec.md](docs/00_spec.md)（✅ 実装済み / 🔜 未実装 の一覧つき）
- 構成・API・画面: [docs/01_architecture.md](docs/01_architecture.md)
- 技術: Cloudflare Workers（Hono）+ D1 + React 19 / Vite（sns_pdca と同じ構成）

## ローカルで動かす

```sh
npm install
npm run db:migrate:local   # 手元の D1 にテーブルを作る
npm run dev                # http://localhost:5180
```

http://localhost:5180/admin を開き、「メンバー」で面接官を登録 →「日程調整カレンダー」で新規作成 → URL を開くと応募画面。
メールは `EMAIL_PROVIDER=log` なので実際には送らず、管理画面の「送信ログ」で中身を確認できる。

```sh
npm test            # 空き枠計算・リマインド時刻のテスト
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

```sh
npx wrangler d1 create interview-scheduler-db   # 出てきた database_id を wrangler.jsonc に書く
npm run db:migrate:remote
npx wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put APP_URL                # 例: https://interview-scheduler.<サブドメイン>.workers.dev
# メールを実際に送るなら（Resend）
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM             # 例: 採用担当 <noreply@your-domain.jp>
#   さらに wrangler.jsonc の vars.EMAIL_PROVIDER を "resend" にする
npm run deploy
```

### 管理画面を守る（本番では必須）

ログインがないので、そのまま公開すると **URL を知っている人は誰でも管理画面で応募者の名前・メールを見られる。**
Cloudflare ダッシュボード → Zero Trust → Access → Applications で「Self-hosted」アプリを作り、次の3つのパスだけを社内のメールアドレスに限定する（アプリのコードは変更不要）:

- `<本番ドメイン>/admin*`
- `<本番ドメイン>/api/admin/*`
- `<本番ドメイン>/auth/*`

応募画面（`/c/*` `/r/*` `/api/public/*`）は誰でも開けるままにする。

## まだ無いもの（docs/00 の 🔜）

Zoom / Microsoft Teams の URL 自動発行、Outlook 予定表連携、質問のファイルアップロード、グループ投票・セミナー・ルーティング、
候補を選んで日程調整の「仮予定」登録、確定後の参加者変更、応募画面のボット対策（Turnstile）。
