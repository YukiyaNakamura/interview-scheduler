import type { AdminUserRow } from './db/auth';

/** Worker が受け取る binding・環境変数。wrangler.jsonc の vars と .dev.vars / wrangler secret に対応させる */
export interface Bindings {
  DB: D1Database;
  APP_NAME: string;
  /** 公開 URL（メールの中のリンクに使う）。未設定ならリクエストの origin を使う。定時実行では必須 */
  APP_URL?: string;
  /** トークン暗号化の鍵（32バイトの base64）。Google のトークンと2段階認証の秘密鍵の暗号化に使う */
  TOKEN_ENC_KEY: string;
  /** 最初の管理者を作るときに入れる合言葉（管理者が0人のときだけ使う）。未設定なら初期設定できない */
  ADMIN_SETUP_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 'log'（送らずに記録だけ）| 'resend' */
  EMAIL_PROVIDER: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** Hono の型。Variables は requireAdmin（lib/session.ts）が入れる、ログイン中の管理者 */
export interface AppEnv {
  Bindings: Bindings;
  Variables: {
    admin: AdminUserRow;
  };
}
