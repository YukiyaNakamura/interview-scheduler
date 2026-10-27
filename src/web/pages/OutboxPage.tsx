/** 送信ログ。EMAIL_PROVIDER=log のときは実際には送らず、ここで内容を確認できる */
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
            送信したメールの記録です（最新 200 件）。
            {config.data?.emailProvider === 'log' && ' 今は EMAIL_PROVIDER=log のため、メールは実際には送られず、ここに残るだけです。'}
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
                <Badge tone={m.status === 'failed' ? 'red' : m.status === 'sent' ? 'green' : 'gray'}>{m.status === 'failed' ? '失敗' : m.status === 'sent' ? '送信済み' : '記録のみ'}</Badge>
                <Badge tone="blue">{KIND_LABELS[m.kind] ?? m.kind}</Badge>
                <span className="muted small">{new Date(m.createdAt).toLocaleString('ja-JP')}</span>
              </span>
              <span className="outbox-subject">{m.subject}</span>
              <span className="muted small">宛先: {m.toAddr}</span>
            </summary>
            {m.error && <div className="alert alert-error small">{m.error}</div>}
            <pre className="outbox-body">{m.body}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}
