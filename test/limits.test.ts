// 回数制限のキーと、メールの送り直しの間隔のテスト
import { describe, expect, it } from 'vitest';
import { MAX_MAIL_ATTEMPTS, retryDelayMs } from '../src/worker/integrations/notify';
import { ipBlock, LIMITS } from '../src/worker/lib/limits';

describe('ipBlock', () => {
  it('IPv4 はそのまま', () => {
    expect(ipBlock('203.0.113.7')).toBe('203.0.113.7');
  });
  it('IPv6 は先頭の4ブロック（/64）にまとめる。省略・大文字・先頭の0の違いは同じになる', () => {
    expect(ipBlock('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1234:5678::/64');
    expect(ipBlock('2001:0DB8:1234:5678::1')).toBe('2001:db8:1234:5678::/64');
    expect(ipBlock('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBlock('::1')).toBe('0:0:0:0::/64');
  });
  it('同じ /64 の中でアドレスを替えても、同じキーで数える', () => {
    expect(LIMITS.noSlotIp('2001:db8:1:2::a').key).toBe(LIMITS.noSlotIp('2001:db8:1:2:ffff::b').key);
    expect(LIMITS.noSlotIp('2001:db8:1:2::a').key).not.toBe(LIMITS.noSlotIp('2001:db8:1:3::a').key);
  });
});

describe('retryDelayMs', () => {
  it('5分・15分・1時間・3時間と間隔を空け、5回目で送り直しをやめる', () => {
    expect([1, 2, 3, 4].map((n) => retryDelayMs(n) / 60_000)).toEqual([5, 15, 60, 180]);
    expect(MAX_MAIL_ATTEMPTS).toBe(5);
  });
});
