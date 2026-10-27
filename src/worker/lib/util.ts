/** ID・トークン・HTTP エラーなど、Worker のあちこちで使う小さな道具 */
import type { Context } from 'hono';
import type { AppEnv, Bindings } from '../env';

export const newId = (): string => crypto.randomUUID();

/** URL に入れる推測できない乱数（base64url、24バイト） */
export function newToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const nowIso = (): string => new Date().toISOString();

/** API で返すエラー。index.ts の onError が { error } の JSON にする */
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 | 502,
    message: string,
    /** 入力チェックのエラーの詳細（項目 → メッセージ） */
    public issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

/** 公開 URL（末尾の / なし） */
export function appUrl(env: Bindings, c?: Context<AppEnv>): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, '');
  if (c) return new URL(c.req.url).origin;
  throw new Error('APP_URL が設定されていません');
}

export const calendarUrl = (base: string, slug: string) => `${base}/c/${slug}`;
export const manageUrl = (base: string, token: string) => `${base}/r/${token}`;

/** JSON 列を読む。壊れていたら fallback */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
