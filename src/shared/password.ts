/**
 * 管理者のパスワードの決まり。画面（入力中の表示）と Worker（保存前の確認）の両方で使う。
 * NIST SP 800-63B に合わせ、記号・大文字の混在は求めず「長さ」と「推測しやすい形でないこと」だけを見る
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** よく使われる言葉。これを含むパスワードは推測されやすいので断る */
const COMMON_WORDS = ['password', 'passw0rd', 'qwerty', 'asdfgh', 'zxcvbn', 'abc123', 'letmein', 'welcome', 'aiteru', 'iloveyou'];

/** 同じ文字の繰り返し（aaaaaaaaaaaa・abababababab）や並び（123456789012・abcdefghijkl）だけでできているか */
function isMonotone(password: string): boolean {
  const chars = [...password.toLowerCase()];
  if (new Set(chars).size < 4) return true;
  const codes = chars.map((ch) => ch.codePointAt(0) ?? 0);
  // 数字の 9→0・0→9 は並びの続きとして扱う
  const steps = new Set(
    codes.slice(1).map((code, i) => {
      const d = code - (codes[i] ?? 0);
      return d === -9 ? 1 : d === 9 ? -1 : d;
    }),
  );
  return steps.size === 1 && [1, -1].includes([...steps][0] ?? 0);
}

/** パスワードの問題点。問題なければ null */
export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < PASSWORD_MIN) return `パスワードは ${PASSWORD_MIN} 文字以上にしてください`;
  if (password.length > PASSWORD_MAX) return `パスワードは ${PASSWORD_MAX} 文字以内にしてください`;
  if (password.trim() !== password) return 'パスワードの最初と最後に空白を入れないでください';
  const lower = password.toLowerCase();
  if (isMonotone(password)) return '同じ文字や連続した文字だけのパスワードは使えません';
  if (COMMON_WORDS.some((w) => lower.includes(w))) return '推測されやすい言葉（password・qwerty など）を含むパスワードは使えません';
  const local = email.toLowerCase().split('@')[0] ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'メールアドレスを含むパスワードは使えません';
  return null;
}
