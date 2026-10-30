/**
 * 本番に出す前の確認（npm run deploy の途中で動く。README「本番に出す」）。
 * 設定が漏れたまま出すと、メールが1通も送られない・リマインドが止まるといったことが起きても気づけないので、ここで止める
 * - wrangler.jsonc の database_id が仮の値（0 並び）でない
 * - vars.EMAIL_PROVIDER が "resend"（"log" は開発用で、送らずに記録するだけ）
 * - 必須の秘密情報が wrangler secret に入っている
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** JSONC（コメント・末尾のカンマあり）を読む。文字列の中の // は残す */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const REQUIRED_SECRETS = {
  TOKEN_ENC_KEY: 'メールアドレスなどの暗号化の鍵（README「暗号化の鍵」。作った値は必ず控える）',
  APP_URL: '公開 URL。メールの中のリンクとリマインドに使う（例: https://interview-scheduler.<サブドメイン>.workers.dev）',
  RESEND_API_KEY: 'メール送信（Resend）の API キー',
  EMAIL_FROM: 'メールの送信元（例: 採用担当 <noreply@your-domain.jp>）',
};

const problems = [];
const config = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

const db = config.d1_databases?.find((d) => d.binding === 'DB');
if (!db || /^[0-]+$/.test(db.database_id)) {
  problems.push('wrangler.jsonc の database_id が仮の値のままです。`npx wrangler d1 create interview-scheduler-db` で出た値を書いてください');
}
if (config.vars?.EMAIL_PROVIDER !== 'resend') {
  problems.push(`wrangler.jsonc の vars.EMAIL_PROVIDER が "${config.vars?.EMAIL_PROVIDER}" です。本番は "resend" にしてください（"log" だとメールが1通も送られません）`);
}

let secrets = [];
try {
  const out = execFileSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  secrets = JSON.parse(out.slice(out.indexOf('['))).map((s) => s.name);
} catch (err) {
  const reason = String(err.stderr || err.message).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n')[0];
  problems.push(`wrangler secret list が失敗しました: ${reason}（\`npx wrangler login\` は済んでいますか。初めて出すときは、先に \`npx wrangler secret put\` で秘密情報を入れると Worker が作られます）`);
}
if (secrets.length > 0 || problems.length === 0) {
  for (const [name, what] of Object.entries(REQUIRED_SECRETS)) {
    if (!secrets.includes(name)) problems.push(`秘密情報 ${name} がありません。\`npx wrangler secret put ${name}\` で入れてください（${what}）`);
  }
}

if (problems.length > 0) {
  console.error('\n本番に出す前に直してください:\n' + problems.map((p) => `  - ${p}`).join('\n') + '\n');
  process.exit(1);
}
console.log('デプロイ前の確認: OK');
