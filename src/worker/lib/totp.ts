/**
 * 2段階認証のコード（TOTP。RFC 6238）。Google Authenticator・Microsoft Authenticator・1Password などの認証アプリと同じ方式。
 * - 秘密鍵は 20 バイトの乱数を base32 にしたもの。30 秒ごとに変わる 6 桁のコードを HMAC-SHA1 で作る
 * - 時計のずれを考えて前後 1 ステップ（±30 秒）まで受け付ける
 * - 同じコード（同じステップ）は2回通さない。最後に通したステップより後のものだけを受け付ける（呼び出し側で保存する）
 */
import { timingSafeEqual } from './password';

export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('base32 として読めない文字があります');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** 時刻（ミリ秒）→ ステップ番号（30 秒ごとに 1 増える） */
export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);

/** あるステップのコード（RFC 4226 の HOTP） */
export async function totpCode(secret: string, step: number, digits = TOTP_DIGITS): Promise<string> {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const at = (i: number) => mac[i] ?? 0;
  const offset = at(mac.length - 1) & 15;
  const bin = ((at(offset) & 127) << 24) | (at(offset + 1) << 16) | (at(offset + 2) << 8) | at(offset + 3);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * 入力されたコードを確かめ、通ったらそのステップ番号を返す（ダメなら null）。
 * lastStep（前回通したステップ）以下のものは、正しいコードでも使い回しとして断る
 */
export async function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number | null): Promise<number | null> {
  const input = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(input)) return null;
  const current = totpStep(nowMs);
  const enc = new TextEncoder();
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(enc.encode(await totpCode(secret, step)), enc.encode(input))) return step;
  }
  return null;
}

/** 認証アプリに読み込ませる URL（QR コードにする） */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
