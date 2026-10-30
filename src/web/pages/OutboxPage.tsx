/**
 * 送信ログ。EMAIL_PROVIDER=log のときは実際には送らず、ここで内容を確認できる。
 * 実際に送るとき（resend）は本文を残さない（パスワード再設定のリンクなどを、ほかの管理者に見られないように）
 */
import { useQuery } from '@tanstack/react-query';
import type { OutboxItem } from '../../shared/api';
import { apiGet } from '../lib/api';
import { useConfig } from '../lib/hooks';
import { Badge, Empty, ErrorBox, Spinner } from '../components/ui';

const KIND_LABELS: Record<string, string> = {
  guest_confirmed: '完了（応募者）',
  host_confirmed: '完了（面接官）',
  cancelled: 'キャンセル',
  rescheduled: '日程変更',
  reminder: 'リマインド',
  no_slot: '日程がない',
  guest_links: '予定確認 URL の再送',
  signup_verify: '新規登録の確認',
  signup_exists: '登録済みの知らせ',
  signup_request: '承認の依頼',
  signup_approved: '承認の知らせ',
  password_reset: 'パスワード再設定',
};

const STATUS: Record<OutboxItem['status'], { label: string; tone: 'green' | 'gray' | 'red' | 'amber' }> = {
  logged: { label: '記録のみ', tone: 'gray' },
  pending: { label: '送信待ち', tone: 'amber' },
  sent: { label: '送信済み', tone: 'green' },
  failed: { label: '失敗', tone: 'red' },
};

export function OutboxPage() {
  const config = useConfig();
  const list = useQuery({
    queryKey: ['outbox'],
    queryFn: () => apiGet<OutboxItem[]>('/api/admin/outbox'),
    refetchInterval: 10_000,
  });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>送信ログ</h1>
          <p className="muted">
            送信したメールの記録です（最新 200 件、30日で消えます）。送れなかったメールは、間隔を空けて最大5回まで送り直します。
            {config.data?.emailProvider === 'log'
              ? ' 今は EMAIL_PROVIDER=log のため、メールは実際には送られず、ここに残るだけです。'
              : ' 本文は残しません（パスワード再設定のリンクなどが含まれるため）。'}
          </p>
        </div>
      </div>
      {list.isLoading && <Spinner />}
      <ErrorBox error={list.error} />
      {list.data && list.data.length === 0 && <Empty>まだメールはありません</Empty>}
      <div className="outbox">
        {(list.data ?? []).map((m) => (
          <details className="outbox-item" key={m.id}>
            <summary>
              <span className="outbox-meta">
                <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                <Badge tone="blue">{KIND_LABELS[m.kind] ?? m.kind}</Badge>
                <span className="muted small">{new Date(m.createdAt).toLocaleString('ja-JP')}</span>
              </span>
              <span className="outbox-subject">{m.subject}</span>
              <span className="muted small">宛先: {m.toAddr}</span>
            </summary>
            {m.error && (
              <div className="alert alert-error small">
                {m.attempts > 0 && `${m.attempts}回目: `}
                {m.error}
              </div>
            )}
            {m.body ? <pre className="outbox-body">{m.body}</pre> : <p className="muted small">本文は残していません。</p>}
          </details>
        ))}
      </div>
    </div>
  );
}
