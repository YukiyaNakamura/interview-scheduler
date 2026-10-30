/** 画面のあちこちで使う問い合わせ（アプリ設定・ログイン状態・メンバー一覧） */
import { useQuery } from '@tanstack/react-query';
import type { AppConfig, AuthState, MemberInfo } from '../../shared/api';
import { apiGet } from './api';

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => apiGet<AppConfig>('/api/config'), staleTime: Infinity });
}

/** ログインのどの段階にいるか（/api/auth/session）。ログイン・ログアウトの API が返す値で setQueryData して更新する */
export function useAuth() {
  return useQuery({ queryKey: ['auth'], queryFn: () => apiGet<AuthState>('/api/auth/session'), staleTime: 60_000 });
}

/** メンバー（面接官）の一覧。カレンダーの参加メンバー選択・名前の表示に使う */
export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: () => apiGet<MemberInfo[]>('/api/admin/members') });
}
