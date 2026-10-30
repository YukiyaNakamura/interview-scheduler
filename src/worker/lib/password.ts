/**
 * 管理者のパスワードのハッシュ化と照合（admin_users.password_hash）。
 * - PBKDF2-SHA256（WebCrypto）。回数は Workers の上限の 100,000 回。salt は人ごとに 16 バイトの乱数
 * - 保存する形: 'pbkdf2-sha256$<回数>$<salt base64>$<hash base64>'。回数を中に持つので、後から回数を変えても古いものを照合できる
 * - 比べるときは時間が一定の比較（timingSafeEqual）を使い、どこまで一致したかを処理時間から推測させない
 */
import { base64ToBytes, bytesToBase64 } from './crypto';

/** Cloudflare Workers の PBKDF2 は 100,000 回までしか受け付けない */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS));
}

/** 長さが同じなら、内容によらず同じ時間で比べる */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (scheme !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(password, base64ToBytes(salt), iterations), base64ToBytes(hash));
}

let dummyHash: Promise<string> | undefined;

/**
 * 存在しないメールアドレスでも、存在するときと同じだけ時間をかける。
 * 応答時間の差から「このメールアドレスの管理者がいる」と分からないようにする
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
  return false;
}

/** 読み間違えやすい文字（0 O 1 l I）を除いた文字 */
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 仮パスワード（例: Kx7p-Qm3d-Rt8v-Wn2h。約 93 ビット）。次のログインで変更させる */
export function generateTempPassword(): string {
  const groups: string[] = [];
  // 57 文字から偏りなく選ぶため、256 を 57 で割り切れる範囲（0〜227）だけを使う
  const limit = 256 - (256 % TEMP_ALPHABET.length);
  let group = '';
  while (groups.length < 4) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte >= limit) continue;
      group += TEMP_ALPHABET[byte % TEMP_ALPHABET.length];
      if (group.length === 4) {
        groups.push(group);
        group = '';
        if (groups.length === 4) break;
      }
    }
  }
  return groups.join('-');
}
