/**
 * メールアドレスなどの個人情報を、アプリ側で暗号化して DB に入れる（docs/01「個人情報の暗号化」）。
 * - 暗号化（seal / open）: AES-GCM。鍵は TOKEN_ENC_KEY。同じ値でも毎回違う暗号文になり、DB を見ても読めない
 * - 検索用の目印（emailIndex）: メールアドレスを小文字にして HMAC-SHA256。鍵は TOKEN_ENC_KEY から HKDF で作った別の鍵。
 *   同じメールなら同じ値になるので「このメールの管理者・予定」を探せるが、値から元のメールアドレスは分からない
 * 鍵は Worker の入口（index.ts の fetch / scheduled）で configurePii(env.TOKEN_ENC_KEY) して覚えておく。
 * DB の読み書き（src/worker/db/*）だけがここを使い、ほかのコードは復号済みの値を扱う
 */
import { base64ToBytes, bytesToBase64 } from './crypto';

const IV_BYTES = 12;
/** 暗号文の先頭に付ける版。鍵や方式を変えるときに古いものと見分けるため */
const PREFIX = 'v1:';

let keyBase64: string | null = null;
let keys: Promise<{ aes: CryptoKey; hmac: CryptoKey }> | null = null;

/** 鍵を覚える（何度呼んでもよい。同じ鍵なら作り直さない） */
export function configurePii(tokenEncKey: string): void {
  if (tokenEncKey === keyBase64) return;
  keyBase64 = tokenEncKey;
  keys = null;
}

function getKeys(): Promise<{ aes: CryptoKey; hmac: CryptoKey }> {
  if (!keyBase64) throw new Error('個人情報の暗号化の鍵がありません（configurePii(env.TOKEN_ENC_KEY) を先に呼んでください）');
  const b64 = keyBase64;
  keys ??= (async () => {
    const raw = base64ToBytes(b64);
    if (raw.length !== 32) throw new Error(`TOKEN_ENC_KEY は 32 バイトを base64 にしたものにしてください（今は ${raw.length} バイト）`);
    const aes = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    // 目印用の鍵は暗号化の鍵と分ける（同じ鍵を2つの用途に使わない）
    const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const hmac = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('aiteru'), info: new TextEncoder().encode('email-index') },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    return { aes, hmac };
  })();
  return keys;
}

/** 暗号化する。戻り値は 'v1:' + base64( iv 12バイト + 暗号文 ) */
export async function seal(plain: string): Promise<string> {
  const { aes } = await getKeys();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(plain)));
  const out = new Uint8Array(IV_BYTES + cipher.length);
  out.set(iv, 0);
  out.set(cipher, IV_BYTES);
  return PREFIX + bytesToBase64(out);
}

/** 復号する。鍵が違う・壊れているときは例外 */
export async function open(sealed: string): Promise<string> {
  if (!sealed.startsWith(PREFIX)) throw new Error('暗号化されていない値です');
  const { aes } = await getKeys();
  const bytes = base64ToBytes(sealed.slice(PREFIX.length));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, aes, bytes.slice(IV_BYTES));
  return new TextDecoder().decode(plain);
}

/** null をそのまま通す open */
export const openOrNull = async (sealed: string | null): Promise<string | null> => (sealed === null ? null : open(sealed));

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** メールアドレスの検索用の目印（16進 64 文字）。大文字・小文字、前後の空白の違いは同じ値になる */
export async function emailIndex(email: string): Promise<string> {
  const { hmac } = await getKeys();
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(normalizeEmail(email))));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** メールアドレスを保存用の2つの値（暗号文と目印）にする */
export async function sealEmail(email: string): Promise<{ enc: string; hash: string }> {
  const normalized = normalizeEmail(email);
  return { enc: await seal(normalized), hash: await emailIndex(normalized) };
}
