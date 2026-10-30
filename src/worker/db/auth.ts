/**
 * admin_users / admin_sessions / auth_tokens / login_attempts / auth_events へのアクセス（docs/01「ログイン」）。
 * 管理者のメールアドレスは DB では暗号化（email_enc）と検索用の目印（email_hash）で持ち、ここで復号する（lib/pii.ts）
 */
import type { AccountInfo, AccountStatus, AuthEventItem, AuthEventKind } from '../../shared/api';
import { emailIndex, openOrNull, open, seal, sealEmail } from '../lib/pii';
import { newId, newToken, nowIso } from '../lib/util';

export interface AdminUserRow {
  id: string;
  /** 復号したメールアドレス */
  email: string;
  /** メールアドレスの目印（試行回数のキーにも使う） */
  email_hash: string;
  name: string;
  status: AccountStatus;
  password_hash: string;
  must_change_password: 0 | 1;
  totp_secret_enc: string | null;
  totp_last_step: number | null;
  password_changed_at: string;
  last_login_at: string | null;
  last_login_ip: string | null;
  created_at: string;
}

type AdminDbRow = Omit<AdminUserRow, 'email'> & { email_enc: string };

async function toAdminRow(r: AdminDbRow): Promise<AdminUserRow> {
  const { email_enc, ...rest } = r;
  return { ...rest, email: await open(email_enc) };
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  stage: 'password' | 'full';
  pending_totp_enc: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export function toAccountInfo(u: AdminUserRow, selfId: string): AccountInfo {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.status,
    mfaEnabled: u.totp_secret_enc !== null,
    mustChangePassword: u.must_change_password === 1,
    lastLoginAt: u.last_login_at,
    lastLoginIp: u.last_login_ip,
    createdAt: u.created_at,
    isSelf: u.id === selfId,
  };
}

// ---- 管理者 ----

/** 使える（承認済みの）管理者の人数。0 なら初期設定を出す */
export async function countActiveAdmins(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE status = 'active'").first<{ n: number }>())?.n ?? 0;
}

/** 承認待ちを先に、あとは作った順 */
export async function listAdmins(db: D1Database): Promise<AdminUserRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM admin_users ORDER BY CASE status WHEN 'pending_approval' THEN 0 WHEN 'pending_email' THEN 1 ELSE 2 END, created_at")
    .all<AdminDbRow>();
  return Promise.all(results.map(toAdminRow));
}

export async function listActiveAdmins(db: D1Database): Promise<AdminUserRow[]> {
  const { results } = await db.prepare("SELECT * FROM admin_users WHERE status = 'active' ORDER BY created_at").all<AdminDbRow>();
  return Promise.all(results.map(toAdminRow));
}

export async function getAdmin(db: D1Database, id: string): Promise<AdminUserRow | null> {
  const row = await db.prepare('SELECT * FROM admin_users WHERE id = ?').bind(id).first<AdminDbRow>();
  return row ? toAdminRow(row) : null;
}

export async function getAdminByEmail(db: D1Database, email: string): Promise<AdminUserRow | null> {
  const row = await db.prepare('SELECT * FROM admin_users WHERE email_hash = ?').bind(await emailIndex(email)).first<AdminDbRow>();
  return row ? toAdminRow(row) : null;
}

/**
 * 管理者を作る。onlyIfFirst なら「使える管理者がまだ1人もいないとき」だけ作る（初期設定を同時に2回送られても1人しかできない）。
 * 作れなかったら null
 */
export async function insertAdmin(
  db: D1Database,
  input: { name: string; email: string; passwordHash: string; mustChangePassword: boolean; status?: AccountStatus },
  onlyIfFirst = false,
): Promise<string | null> {
  const id = newId();
  const now = nowIso();
  const e = await sealEmail(input.email);
  const res = await db
    .prepare(
      `INSERT INTO admin_users (id, email_enc, email_hash, name, status, password_hash, must_change_password, password_changed_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM admin_users WHERE status = 'active')`,
    )
    .bind(id, e.enc, e.hash, input.name, input.status ?? 'active', input.passwordHash, input.mustChangePassword ? 1 : 0, now, now, onlyIfFirst ? 1 : 0)
    .run();
  return res.meta.changes === 1 ? id : null;
}

/** 新規登録をやり直したとき（メール確認待ちのまま、名前とパスワードを入れ直す） */
export async function updatePendingSignup(db: D1Database, id: string, name: string, passwordHash: string): Promise<void> {
  await db
    .prepare("UPDATE admin_users SET name = ?, password_hash = ?, password_changed_at = ? WHERE id = ? AND status = 'pending_email'")
    .bind(name, passwordHash, nowIso(), id)
    .run();
}

/** 状態を from から to に変える。変わったら true（同時に2回押されても1回だけ） */
export async function changeStatus(db: D1Database, id: string, from: AccountStatus, to: AccountStatus): Promise<boolean> {
  const res = await db.prepare('UPDATE admin_users SET status = ? WHERE id = ? AND status = ?').bind(to, id, from).run();
  return res.meta.changes === 1;
}

export async function setPassword(db: D1Database, id: string, passwordHash: string, mustChange: boolean): Promise<void> {
  await db
    .prepare('UPDATE admin_users SET password_hash = ?, must_change_password = ?, password_changed_at = ? WHERE id = ?')
    .bind(passwordHash, mustChange ? 1 : 0, nowIso(), id)
    .run();
}

export async function setTotpSecret(db: D1Database, id: string, secretEnc: string | null, step: number | null): Promise<void> {
  await db.prepare('UPDATE admin_users SET totp_secret_enc = ?, totp_last_step = ? WHERE id = ?').bind(secretEnc, step, id).run();
}

/**
 * 通ったコードのステップを記録する。前回より後のステップのときだけ書き換わる（同時に同じコードを2回送られても1回しか通らない）。
 * 書き換わったら true
 */
export async function claimTotpStep(db: D1Database, id: string, step: number): Promise<boolean> {
  const res = await db
    .prepare('UPDATE admin_users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)')
    .bind(step, id, step)
    .run();
  return res.meta.changes === 1;
}

export async function recordLogin(db: D1Database, id: string, ip: string): Promise<void> {
  await db.prepare('UPDATE admin_users SET last_login_at = ?, last_login_ip = ? WHERE id = ?').bind(nowIso(), ip, id).run();
}

/**
 * 管理者を消す。使える管理者が自分しかいないときは消さない（同時に2人が互いを消しても0人にならないよう、数えるのと消すのを1つの SQL で行う）。
 * 承認待ち・メール確認待ちの人（却下）はいつでも消せる。消せたら true。セッションは外部キーで一緒に消える
 */
export async function deleteAdminIfNotLast(db: D1Database, id: string): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM admin_users WHERE id = ?1 AND (status != 'active' OR (SELECT COUNT(*) FROM admin_users WHERE status = 'active' AND id != ?1) > 0)")
    .bind(id)
    .run();
  return res.meta.changes === 1;
}

// ---- メールで送るリンクのトークン（新規登録の確認・パスワードの再設定） ----

export type TokenPurpose = 'verify_email' | 'reset_password';

/** トークンを作り、URL に入れる値を返す。同じ人・同じ用途の古いトークンは消す（最後に送ったリンクだけが使える） */
export async function createAuthToken(db: D1Database, userId: string, purpose: TokenPurpose, ttlMs: number): Promise<string> {
  const token = newToken(32);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').bind(userId, purpose),
    db
      .prepare('INSERT INTO auth_tokens (token_hash, purpose, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashSessionToken(token), purpose, userId, new Date(now + ttlMs).toISOString(), new Date(now).toISOString()),
  ]);
  return token;
}

/** 使う前に確かめる（消さない）。期限切れ・無いものは null */
export async function peekAuthToken(db: D1Database, token: string, purpose: TokenPurpose): Promise<string | null> {
  if (token.length > 100) return null;
  const row = await db
    .prepare('SELECT user_id FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?')
    .bind(await hashSessionToken(token), purpose, nowIso())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** 1回だけ使う（消す）。消せたらその人の ID、期限切れ・使用済みなら null */
export async function consumeAuthToken(db: D1Database, token: string, purpose: TokenPurpose): Promise<string | null> {
  if (token.length > 100) return null;
  const row = await db
    .prepare('DELETE FROM auth_tokens WHERE token_hash = ? AND purpose = ? RETURNING user_id, expires_at')
    .bind(await hashSessionToken(token), purpose)
    .first<{ user_id: string; expires_at: string }>();
  return row && row.expires_at > nowIso() ? row.user_id : null;
}

// ---- セッション ----

/** Cookie に入れる値 → DB に持つ値（SHA-256 の16進） */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** セッションを作り、Cookie に入れる値を返す */
export async function createSession(
  db: D1Database,
  userId: string,
  stage: SessionRow['stage'],
  ttlMs: number,
  client: { ip: string; userAgent: string },
): Promise<{ token: string; idHash: string }> {
  const token = newToken(32);
  const idHash = await hashSessionToken(token);
  const now = new Date();
  await db
    .prepare('INSERT INTO admin_sessions (id_hash, user_id, stage, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(idHash, userId, stage, client.ip, client.userAgent.slice(0, 300), now.toISOString(), now.toISOString(), new Date(now.getTime() + ttlMs).toISOString())
    .run();
  return { token, idHash };
}

export async function getSession(db: D1Database, idHash: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM admin_sessions WHERE id_hash = ?').bind(idHash).first<SessionRow>();
}

export async function touchSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id_hash = ?').bind(nowIso(), idHash).run();
}

export async function setPendingTotp(db: D1Database, idHash: string, secretEnc: string): Promise<void> {
  await db.prepare('UPDATE admin_sessions SET pending_totp_enc = ? WHERE id_hash = ?').bind(secretEnc, idHash).run();
}

/**
 * パスワード段階のセッションを使い切る（消す）。消せたら true。
 * 同時に届いた2つ目以降のリクエストは false になり、full のセッションは1つしかできない
 */
export async function consumePasswordStageSession(db: D1Database, idHash: string): Promise<boolean> {
  const row = await db.prepare("DELETE FROM admin_sessions WHERE id_hash = ? AND stage = 'password' RETURNING id_hash").bind(idHash).first<{ id_hash: string }>();
  return row !== null;
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').bind(idHash).run();
}

/** その人のセッションをすべて消す（パスワード変更・リセット時。ほかの端末からもログアウトさせる） */
export async function deleteSessionsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId).run();
}

// ---- 試行回数（総当たり対策） ----

export interface AttemptLimit {
  key: string;
  /** windowMs の間に試せる回数 */
  max: number;
  windowMs: number;
  /** max を超えたときにロックする長さ */
  lockMs: number;
}

/**
 * 試す前に1回分を予約する（パスワードやコードを確かめるより先に数える）。
 * 1つの SQL で数えて結果を受け取るので、同時に何百件送られても max 件を超えては通らない（D1 は書き込みを1件ずつ処理する）。
 * 通ってよければ allowed: true。成功したら呼び出し側が releaseAttempt / clearFailures で戻す。
 * max を超えた最初の1件がロックをかけ、justLocked: true になる
 */
export async function reserveAttempt(db: D1Database, limit: AttemptLimit): Promise<{ allowed: boolean; lockedUntil: string | null; justLocked: boolean }> {
  const now = Date.now();
  const nowStr = new Date(now).toISOString();
  // ロック中でなく、最初の試行から windowMs を過ぎていたら数え直す
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (key, attempts, window_started_at) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         attempts = CASE WHEN login_attempts.window_started_at < ?3 AND IFNULL(login_attempts.locked_until, '') <= ?2 THEN 1 ELSE login_attempts.attempts + 1 END,
         window_started_at = CASE WHEN login_attempts.window_started_at < ?3 AND IFNULL(login_attempts.locked_until, '') <= ?2 THEN ?2 ELSE login_attempts.window_started_at END,
         locked_until = CASE WHEN IFNULL(login_attempts.locked_until, '') <= ?2 THEN NULL ELSE login_attempts.locked_until END
       RETURNING attempts, locked_until`,
    )
    .bind(limit.key, nowStr, new Date(now - limit.windowMs).toISOString())
    .first<{ attempts: number; locked_until: string | null }>();
  if (!row) return { allowed: false, lockedUntil: null, justLocked: false };
  if (row.locked_until) return { allowed: false, lockedUntil: row.locked_until, justLocked: false };
  if (row.attempts <= limit.max) return { allowed: true, lockedUntil: null, justLocked: false };
  const until = new Date(now + limit.lockMs).toISOString();
  const res = await db.prepare('UPDATE login_attempts SET locked_until = ? WHERE key = ? AND locked_until IS NULL').bind(until, limit.key).run();
  return { allowed: false, lockedUntil: until, justLocked: res.meta.changes === 1 };
}

/** 予約した1回分を戻す（成功した試行を失敗として数えないように） */
export async function releaseAttempt(db: D1Database, key: string): Promise<void> {
  await db.prepare('UPDATE login_attempts SET attempts = attempts - 1 WHERE key = ? AND attempts > 0').bind(key).run();
}

/** 回数とロックを消す（2段階認証が通ったとき、ほかの管理者がリセットしたとき） */
export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

// ---- ログインまわりの記録 ----

export async function logAuthEvent(
  db: D1Database,
  e: { kind: AuthEventKind; userId?: string | null; actorId?: string | null; email?: string | null; ip?: string | null; userAgent?: string | null },
): Promise<void> {
  await db
    .prepare('INSERT INTO auth_events (kind, user_id, actor_id, email_enc, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(e.kind, e.userId ?? null, e.actorId ?? null, e.email ? await seal(e.email) : null, e.ip ?? null, e.userAgent?.slice(0, 300) ?? null, nowIso())
    .run();
}

export async function listAuthEvents(db: D1Database, limit = 100): Promise<AuthEventItem[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.kind, e.email_enc, e.ip, e.user_agent, e.created_at, u.name AS user_name, a.name AS actor_name
       FROM auth_events e LEFT JOIN admin_users u ON u.id = e.user_id LEFT JOIN admin_users a ON a.id = e.actor_id
       ORDER BY e.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number; kind: AuthEventKind; email_enc: string | null; ip: string | null; user_agent: string | null; created_at: string; user_name: string | null; actor_name: string | null }>();
  return Promise.all(results.map(async (r) => ({
    id: r.id,
    kind: r.kind,
    email: await openOrNull(r.email_enc),
    userName: r.user_name,
    actorName: r.actor_name,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  })));
}

/** 期限切れのセッション・メールのリンク、2日より前の試行回数、180日より前の記録、7日たってもメール確認されない新規登録を消す（定時実行） */
export async function cleanupAuth(db: D1Database): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').bind(now),
    db.prepare("DELETE FROM admin_users WHERE status = 'pending_email' AND created_at < ?").bind(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    db.prepare('DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until < ?) AND window_started_at < ?').bind(now, new Date(Date.now() - 2 * 86_400_000).toISOString()),
    db.prepare('DELETE FROM auth_events WHERE created_at < ?').bind(new Date(Date.now() - 180 * 86_400_000).toISOString()),
  ]);
}
