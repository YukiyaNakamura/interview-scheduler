/**
 * Worker の入口。/api/* と /auth/* を Hono で受け、それ以外は画面（dist/web）を返す（wrangler.jsonc の assets）。
 * 管理画面の API（/api/admin）と Google 連携（/auth/google）はログインが要る（/api/auth。docs/01「ログイン」）。
 * 応募者の API（/api/public）はログインなし
 * scheduled() は定時実行（wrangler.jsonc の triggers.crons と合わせる）
 */
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import type { ApiError, AppConfig } from '../shared/api';
import type { AppEnv, Bindings } from './env';
import { googleEnabled } from './integrations/google';
import { runCleanup, runReminders } from './jobs/reminders';
import { noStore, requireAdmin, sameOriginWrites } from './lib/session';
import { HttpError } from './lib/util';
import { accounts } from './routes/accounts';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { google } from './routes/google';
import { publicApi } from './routes/public';

const app = new Hono<AppEnv>();

// nosniff・HSTS・X-Frame-Options など。応募画面の埋め込み（?embed=1）は画面側（dist/web）の応答なのでここの対象外
app.use('*', secureHeaders());
for (const path of ['/api/auth/*', '/api/admin/*']) app.use(path, noStore, sameOriginWrites);
app.use('/api/admin/*', requireAdmin);

app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/config', (c) => c.json<AppConfig>({ appName: c.env.APP_NAME, googleEnabled: googleEnabled(c.env), emailProvider: c.env.EMAIL_PROVIDER }));

app.route('/api/auth', auth);
app.route('/api/admin', accounts);
app.route('/api/admin', admin);
app.route('/api/public', publicApi);
app.route('/auth/google', google);

app.notFound((c) => c.json<ApiError>({ error: 'Not Found' }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json<ApiError>({ error: err.message, issues: err.issues }, err.status);
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return c.json<ApiError>({ error: issues[0]?.message ?? '入力内容を確認してください', issues }, 400);
  }
  if (err instanceof SyntaxError) return c.json<ApiError>({ error: 'JSON が正しくありません' }, 400);
  console.log(`[error] ${c.req.method} ${c.req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return c.json<ApiError>({ error: 'サーバーでエラーが起きました。時間をおいてもう一度お試しください' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    if (controller.cron === '0 18 * * *') ctx.waitUntil(runCleanup(env));
    else ctx.waitUntil(runReminders(env).then((n) => console.log(`[reminders] ${n} 件送信`)));
  },
} satisfies ExportedHandler<Bindings>;
