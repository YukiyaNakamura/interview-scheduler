// ログインまわりの部品（パスワードの決まり・ハッシュ・2段階認証のコード）のテスト
import { describe, expect, it } from 'vitest';
import { passwordProblem } from '../src/shared/password';
import { generateTempPassword, hashPassword, verifyPassword } from '../src/worker/lib/password';
import { base32Decode, base32Encode, otpauthUrl, totpCode, totpStep, verifyTotp } from '../src/worker/lib/totp';

describe('passwordProblem', () => {
  it('12文字以上の普通のパスフレーズは通る', () => {
    expect(passwordProblem('sakura-mochi-2026', 'tanaka@example.com')).toBeNull();
    expect(passwordProblem('badminton court 42', 'x@example.com')).toBeNull();
  });
  it('短い・長すぎる・前後の空白は断る', () => {
    expect(passwordProblem('short-pass1')).toMatch('12 文字以上');
    expect(passwordProblem('a'.repeat(129))).toMatch('128 文字以内');
    expect(passwordProblem(' sakura-mochi-2026')).toMatch('空白');
  });
  it('繰り返し・連番・よくある言葉・メールアドレスは断る', () => {
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch('連続');
    expect(passwordProblem('abababababab')).toMatch('連続');
    expect(passwordProblem('123456789012')).toMatch('連続');
    expect(passwordProblem('abcdefghijkl')).toMatch('連続');
    expect(passwordProblem('MyPassword2026!')).toMatch('推測');
    expect(passwordProblem('tanaka-hanako-26', 'tanaka@example.com')).toMatch('メールアドレス');
  });
});

describe('hashPassword / verifyPassword', () => {
  it('同じパスワードでも salt が違うので毎回違う形になり、どちらも照合できる', async () => {
    const a = await hashPassword('sakura-mochi-2026');
    const b = await hashPassword('sakura-mochi-2026');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword('sakura-mochi-2026', a)).toBe(true);
    expect(await verifyPassword('sakura-mochi-2027', a)).toBe(false);
  });
  it('形の壊れたハッシュや上限を超える回数は false', async () => {
    expect(await verifyPassword('x', 'plain-text')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2-sha256$999999999$AAAA$AAAA')).toBe(false);
  });
});

describe('generateTempPassword', () => {
  it('4文字×4組で、読み間違えやすい文字を含まない', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      expect(p).not.toMatch(/[01OlI]/);
    }
  });
});

describe('TOTP', () => {
  // RFC 6238 の付録 B（SHA-1、秘密鍵 "12345678901234567890"）。8桁の値の下6桁が6桁のコードになる
  const rfcSecret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ];

  it('RFC 6238 のテストベクタと一致する', async () => {
    for (const [sec, code8] of vectors) {
      expect(await totpCode(rfcSecret, totpStep(sec * 1000), 8)).toBe(code8);
      expect(await totpCode(rfcSecret, totpStep(sec * 1000))).toBe(code8.slice(2));
    }
  });

  it('base32 は往復できる', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    expect(base32Encode(new TextEncoder().encode('foobar'))).toBe('MZXW6YTBOI');
  });

  it('前後30秒までのずれは通し、それより外・使い回し・形の違うものは断る', async () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = (s: number) => totpCode(rfcSecret, s);
    expect(await verifyTotp(rfcSecret, await code(step), now, null)).toBe(step);
    expect(await verifyTotp(rfcSecret, await code(step - 1), now, null)).toBe(step - 1);
    expect(await verifyTotp(rfcSecret, await code(step + 1), now, null)).toBe(step + 1);
    expect(await verifyTotp(rfcSecret, await code(step - 2), now, null)).toBeNull();
    // 前回通したステップと同じもの・それより前のものは、正しいコードでも通さない
    expect(await verifyTotp(rfcSecret, await code(step), now, step)).toBeNull();
    expect(await verifyTotp(rfcSecret, await code(step - 1), now, step - 1)).toBeNull();
    expect(await verifyTotp(rfcSecret, '12345', now, null)).toBeNull();
    expect(await verifyTotp(rfcSecret, 'abcdef', now, null)).toBeNull();
  });

  it('otpauth URL に発行者とアカウントが入る', () => {
    const url = otpauthUrl('Aiteru', 'tanaka@example.com', 'ABCDEF');
    expect(url).toBe('otpauth://totp/Aiteru%3Atanaka%40example.com?secret=ABCDEF&issuer=Aiteru&algorithm=SHA1&digits=6&period=30');
  });
});
