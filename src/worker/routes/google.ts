/**
 * メンバーの Google カレンダー連携（管理画面へのログインとは別。カレンダーを読み書きする許可をもらうだけ）。
 * /auth/google/start?member=<id> → Google の同意画面 → /auth/google/callback でそのメンバーに連携を保存して redirect へ戻る。
 * どちらも管理画面にログイン中の管理者だけが使える（画面の移動なので、未ログインなら 401 ではなくログイン画面へ送る）
 */
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { consumeOAuthState, createOAuthState, getMember, upsertGoogleConnection } from '../db/members';
import type { AppEnv } from '../env';
import { encryptTokens, exchangeCode, fetchGoogleProfile, googleAuthUrl, googleEnabled } from '../integrations/google';
import { currentSession, isFullyLoggedIn } from '../lib/session';
import { appUrl, HttpError } from '../lib/util';

/**
 * 管理画面の中のパスだけを戻り先にする（外部サイトへのリダイレクトに使われないように）。
 * '/\evil.com' や '/%09/evil.com' はブラウザが '//evil.com' と同じに扱うので、使える文字を絞って弾く
 */
const safeRedirect = (to: string | undefined) => (to && /^\/admin(\/[\w\-/]*)?(\?[\w\-=&%.]*)?$/.test(to) && !to.includes('//') ? to : '/admin/members');

const withParam = (path: string, key: string, value: string) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;

export const google = new Hono<AppEnv>();

google.use('*', async (c, next) => {
  if (!isFullyLoggedIn(await currentSession(c))) return c.redirect(`/login?next=${encodeURIComponent('/admin/members')}`);
  await next();
});

google.get('/start', async (c) => {
  if (!googleEnabled(c.env)) throw new HttpError(400, 'Google 連携が設定されていません（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）');
  const member = await getMember(c.env.DB, c.req.query('member') ?? '');
  if (!member) throw new HttpError(404, 'メンバーが見つかりません');
  const state = await createOAuthState(c.env.DB, member.id, safeRedirect(c.req.query('redirect')));
  // state をこのブラウザの Cookie にも入れ、callback で一致を確かめる（別のブラウザで開かせる攻撃を防ぐ）
  setCookie(c, 'oauth_state', state, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/auth', maxAge: 600 });
  return c.redirect(googleAuthUrl(c.env, `${appUrl(c.env, c)}/auth/google/callback`, state));
});

google.get('/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const cookieState = getCookie(c, 'oauth_state');
  deleteCookie(c, 'oauth_state', { path: '/auth' });
  const saved = state && state === cookieState ? await consumeOAuthState(c.env.DB, state) : null;
  if (!saved) return c.redirect('/admin/members?error=state');
  const error = c.req.query('error');
  if (error) return c.redirect(withParam(saved.redirectTo, 'error', error));
  try {
    const tokens = await exchangeCode(c.env, c.req.query('code') ?? '', `${appUrl(c.env, c)}/auth/google/callback`);
    const profile = await fetchGoogleProfile(tokens.access_token);
    await upsertGoogleConnection(c.env.DB, saved.memberId, profile.email, await encryptTokens(c.env, tokens));
  } catch (err) {
    console.log(`[google] 連携に失敗: ${err instanceof Error ? err.message : String(err)}`);
    return c.redirect(withParam(saved.redirectTo, 'error', 'google_failed'));
  }
  return c.redirect(withParam(saved.redirectTo, 'connected', '1'));
});
