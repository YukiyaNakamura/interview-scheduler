// メールアドレスなどの暗号化（src/worker/lib/pii.ts）のテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { configurePii, emailIndex, open, seal, sealEmail } from '../src/worker/lib/pii';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('pii', () => {
  beforeAll(() => configurePii(KEY));

  it('暗号文に元のメールアドレスが含まれず、復号すると戻る', async () => {
    const sealed = await seal('yamada@example.com');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('yamada');
    expect(sealed).not.toContain('@');
    expect(await open(sealed)).toBe('yamada@example.com');
  });

  it('同じ値でも毎回違う暗号文になる（並べても同じ人だと分からない）', async () => {
    expect(await seal('a@example.com')).not.toBe(await seal('a@example.com'));
  });

  it('検索用の目印は大文字・小文字・前後の空白によらず同じで、元の値を含まない', async () => {
    const h = await emailIndex('Yamada@Example.com ');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await emailIndex('yamada@example.com'));
    expect(h).not.toBe(await emailIndex('yamada2@example.com'));
  });

  it('sealEmail は小文字にしてから暗号化する', async () => {
    const e = await sealEmail(' Tanaka@Example.COM');
    expect(await open(e.enc)).toBe('tanaka@example.com');
    expect(e.hash).toBe(await emailIndex('tanaka@example.com'));
  });

  it('鍵が違うと復号できず、目印も変わる', async () => {
    const sealed = await seal('secret@example.com');
    const hash = await emailIndex('secret@example.com');
    configurePii(OTHER_KEY);
    await expect(open(sealed)).rejects.toThrow();
    expect(await emailIndex('secret@example.com')).not.toBe(hash);
    configurePii(KEY);
    expect(await open(sealed)).toBe('secret@example.com');
  });

  it('暗号化されていない値は復号しない', async () => {
    await expect(open('plain@example.com')).rejects.toThrow('暗号化されていない');
  });
});
