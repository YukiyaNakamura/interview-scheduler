/**
 * 管理画面のセッション（Cookie）と、ログインが要る API の入口の確認（docs/01「ログイン」）。
 * - Cookie: HttpOnly（JavaScript から読めない）・SameSite=Lax（ほかのサイトからの POST に付かない）・https なら Secure と __Host- 接頭辞
 * - Cookie の値は 32 バイトの乱数。DB にはその SHA-256 だけを持つ
 * - パスワードだけ通った段階（stage='password'）は 10 分。2段階認証まで通ると 12 時間、ただし 2 時間操作がなければ切れる
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type AdminUserRow, getAdmin, getSession, hashSessionToken, type SessionRow, touchSession } from '../db/auth';
import type { AppEnv } from '../env';
import { HttpError } from './util';

export const SESSION_TTL = {
  /** パスワードを通してから2段階認証を終えるまで */
  passwordStageMs: 10 * 60_000,
  /** ログインしてから必ず切れるまで */
  absoluteMs: 12 * 3_600_000,
  /** 操作がなくて切れるまで */
  idleMs: 2 * 3_600_000,
  /** last_seen_at を書き直す間隔（毎回書くと DB への書き込みが増えるので） */
  touchEveryMs: 5 * 60_000,
};

const isHttps = (c: Context<AppEnv>) => new URL(c.req.url).protocol === 'https:';

/** Cookie の名前。https では __Host- 付きになる（Secure・Path=/・Domain なしでないと受け付けられない名前。サブドメインから上書きされない） */
const COOKIE = 'aiteru_session';

const cookiePrefix = (c: Context<AppEnv>) => (isHttps(c) ? ('host' as const) : undefined);

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAgeMs: number): void {
  setCookie(c, COOKIE, token, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: '/', maxAge: Math.floor(maxAgeMs / 1000), prefix: cookiePrefix(c) });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE, { path: '/', secure: isHttps(c), prefix: cookiePrefix(c) });
}

const readSessionToken = (c: Context<AppEnv>) => getCookie(c, COOKIE, cookiePrefix(c));

/** 記録用の IP と User-Agent。Cloudflare の外（手元）では IP は 'local' */
export function clientInfo(c: Context<AppEnv>): { ip: string; userAgent: string } {
  return { ip: c.req.header('cf-connecting-ip') ?? 'local', userAgent: c.req.header('user-agent') ?? '' };
}

export interface CurrentSession {
  session: SessionRow;
  user: AdminUserRow;
}

/** Cookie のセッションを読む。期限切れ・操作がなく切れたもの・消えた管理者のものは null */
export async function currentSession(c: Context<AppEnv>): Promise<CurrentSession | null> {
  const token = readSessionToken(c);
  if (!token || token.length > 100) return null;
  const session = await getSession(c.env.DB, await hashSessionToken(token));
  if (!session) return null;
  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) return null;
  if (session.stage === 'full' && now - new Date(session.last_seen_at).getTime() > SESSION_TTL.idleMs) return null;
  const user = await getAdmin(c.env.DB, session.user_id);
  return user ? { session, user } : null;
}

/** 2段階認証まで終わり、仮パスワードも変えた管理者か */
export const isFullyLoggedIn = (s: CurrentSession | null): s is CurrentSession => s !== null && s.session.stage === 'full' && s.user.must_change_password === 0;

/** ログイン中の管理者を c.var.admin に入れる。いなければ 401 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = await currentSession(c);
  if (!isFullyLoggedIn(s)) throw new HttpError(401, 'ログインしてください');
  if (Date.now() - new Date(s.session.last_seen_at).getTime() > SESSION_TTL.touchEveryMs) await touchSession(c.env.DB, s.session.id_hash);
  c.set('admin', s.user);
  await next();
};

/**
 * ほかのサイトから送られた書き込み（CSRF）を断る。SameSite=Lax の Cookie に加えた二重の守り。
 * ブラウザは POST などに Origin を付けるので、自分の origin と違えば 403。
 * Origin が無いのはブラウザ以外（curl など。Cookie を盗まれない限り CSRF にならない）なので通す
 */
export const sameOriginWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');
    const allowed = new Set([new URL(c.req.url).origin, ...(c.env.APP_URL ? [new URL(c.env.APP_URL).origin] : [])]);
    if ((origin && !allowed.has(origin)) || (!origin && site && site !== 'same-origin' && site !== 'none')) {
      throw new HttpError(403, 'このページからは操作できません（別のサイトからの送信は受け付けません）');
    }
  }
  await next();
};

/** ログインまわりと管理画面の API の応答をブラウザや途中の経路に残さない */
export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};
