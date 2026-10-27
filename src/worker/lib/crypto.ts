/**
 * Google のトークンの暗号化・復号（calendar_connections.*_enc。AES-GCM、base64: iv + ciphertext）。
 * - 鍵は環境変数 TOKEN_ENC_KEY（32バイトを base64 にした文字列。作り方: openssl rand -base64 32）。
 * - AES-GCM は「鍵」と「iv（毎回違う乱数、12バイト）」で暗号化する方式。同じ文字列でも毎回違う結果になる。
 * - 保存する形は base64( iv 12バイト + 暗号文 )。復号するときは先頭12バイトを iv として取り出す。
 * Workers にも Node.js にも入っている WebCrypto（crypto.subtle）だけを使い、ライブラリは入れない。
 */

/** iv の長さ（バイト）。AES-GCM の標準は 12 */
const IV_BYTES = 12;

/**
 * base64 の文字列 → バイト列（Uint8Array）。atob はブラウザ・Workers・Node に共通の関数。
 * 戻り値の型 Uint8Array<ArrayBuffer> は「普通のメモリ上のバイト列」という意味で、crypto.subtle に渡すのに必要
 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error('base64 として読めないデータです（鍵か暗号文が壊れています）');
  }
}

/** バイト列 → base64 の文字列 */
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** base64 の鍵文字列を、crypto.subtle が使える CryptoKey にする。32バイトでなければ例外 */
async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY は 32 バイトを base64 にしたものにしてください（今は ${raw.length} バイト）`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 平文（トークンなど）を暗号化して、保存用の base64 文字列を返す */
export async function encrypt(plainText: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plainText);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  // iv と暗号文をつなげて1つのバイト列にする
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bytesToBase64(out);
}

/** 保存用の base64 文字列を復号して平文を返す。鍵が違う・データが壊れている場合は例外になる */
export async function decrypt(encrypted: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const bytes = base64ToBytes(encrypted);
  const iv = bytes.slice(0, IV_BYTES);
  const cipher = bytes.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
