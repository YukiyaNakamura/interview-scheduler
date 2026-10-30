/**
 * Worker の API を呼ぶ fetch ラッパー。画面側は apiGet / apiPost / apiPut / apiPatch / apiDelete だけを使う。
 * - 失敗（4xx/5xx）は ApiCallError を投げる（TanStack Query がエラーとして扱える）。
 * - 管理画面の API が 401（ログインが切れた）なら、ログイン画面へ移る。ログイン後に今のページへ戻る
 * - <T> は返ってくる JSON の型。src/shared/api.ts の型を指定する。
 */
import type { ApiError } from '../../shared/api';

export class ApiCallError extends Error {
  status: number;
  issues: { path: string; message: string }[];
  constructor(message: string, status: number, issues: { path: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

type Headers = Record<string, string>;

export function apiGet<T>(path: string, headers: Headers = {}): Promise<T> {
  return request<T>('GET', path, undefined, headers);
}
export function apiPost<T>(path: string, body: unknown = {}, headers: Headers = {}): Promise<T> {
  return request<T>('POST', path, body, headers);
}
export function apiPut<T>(path: string, body: unknown, headers: Headers = {}): Promise<T> {
  return request<T>('PUT', path, body, headers);
}
export function apiPatch<T>(path: string, body: unknown, headers: Headers = {}): Promise<T> {
  return request<T>('PATCH', path, body, headers);
}
export function apiDelete<T = unknown>(path: string): Promise<T> {
  return request<T>('DELETE', path, undefined, {});
}

async function request<T>(method: string, path: string, body: unknown, headers: Headers): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    if (res.status === 401 && path.startsWith('/api/admin/')) goToLogin();
    const data = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiCallError(data?.error ?? `通信に失敗しました（${res.status}）`, res.status, data?.issues ?? []);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** ログイン画面へ（next に今のページを入れて、ログイン後に戻す） */
export function goToLogin(): void {
  if (window.location.pathname === '/login') return;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}
