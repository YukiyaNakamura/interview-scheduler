/**
 * Worker の入口。/api/* と /auth/* を Hono で受け、それ以外は画面（dist/web）を返す（wrangler.jsonc の assets）。
 * ログインはない（docs/01「ログイン」）。管理画面の API は /api/admin、応募者の API は /api/public
 * scheduled() は定時実行（wrangler.jsonc の triggers.crons と合わせる）
 */
import { Hono } from 'hono';
import { ZodError } from 'zod';
import type { ApiError, AppConfig } from '../shared/api';
import type { AppEnv, Bindings } from './env';
import { googleEnabled } from './integrations/google';
import { runCleanup, runReminders } from './jobs/reminders';
import { HttpError } from './lib/util';
import { admin } from './routes/admin';
import { google } from './routes/google';
import { publicApi } from './routes/public';

const app = new Hono<AppEnv>();

app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/config', (c) => c.json<AppConfig>({ appName: c.env.APP_NAME, googleEnabled: googleEnabled(c.env), emailProvider: c.env.EMAIL_PROVIDER }));

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
