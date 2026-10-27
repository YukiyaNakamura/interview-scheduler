/** 予定の詳細。回答・Web会議 URL・担当者を見て、ホストからキャンセルできる */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { BookingDetail } from '../../shared/api';
import { LOCATION_LABELS } from '../../shared/schema';
import { formatRangeJa } from '../../shared/time';
import { apiGet, apiPost } from '../lib/api';
import { browserTimeZone, formatDateTimeJa } from '../lib/format';
import { Badge, ConfirmButton, CopyButton, ErrorBox, MultiLine, Spinner } from '../components/ui';

export function BookingDetailPage() {
  const { id = '' } = useParams();
  const tz = browserTimeZone();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const detail = useQuery({ queryKey: ['booking', id], queryFn: () => apiGet<BookingDetail>(`/api/admin/bookings/${id}`) });
  const cancel = useMutation({
    mutationFn: () => apiPost(`/api/admin/bookings/${id}/cancel`, { reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['booking', id] });
      queryClient.invalidateQueries({ queryKey: ['bookings'] });
    },
  });

  if (detail.isLoading) return <Spinner />;
  if (!detail.data) return <ErrorBox error={detail.error ?? new Error('見つかりません')} />;
  const b = detail.data;
  const params = Object.entries(b.urlParams);

  return (
    <div className="page narrow">
      <Link className="back-link" to="/admin/bookings">
        ‹ 予定一覧
      </Link>
      <div className="card">
        <div className="row-gap wrap">
          {b.status === 'confirmed' ? <Badge tone="green">確定</Badge> : <Badge tone="red">キャンセル済み</Badge>}
          {b.rescheduleCount > 0 && <Badge tone="amber">日程変更 {b.rescheduleCount} 回</Badge>}
        </div>
        <h1 className="booking-when">{formatRangeJa(b.startAt, b.endAt, tz)}</h1>
        <div className="muted">{b.calendarName}</div>

        <dl className="dl">
          <dt>応募者</dt>
          <dd>
            <div className="strong">{b.guestName}</div>
            {b.guestCompany && <div>{b.guestCompany}</div>}
            <a href={`mailto:${b.guestEmail}`}>{b.guestEmail}</a>
            <div className="muted small">タイムゾーン: {b.guestTimezone}</div>
          </dd>
          <dt>面接官</dt>
          <dd>{b.hosts.map((h) => h.name).join('、') || '—'}</dd>
          <dt>場所</dt>
          <dd>
            {LOCATION_LABELS[b.locationType]}
            {b.locationText && <div>{b.locationText}</div>}
            {b.meetingUrl && (
              <div className="row-gap wrap">
                <a href={b.meetingUrl} target="_blank" rel="noreferrer">
                  {b.meetingUrl}
                </a>
                <CopyButton text={b.meetingUrl} />
              </div>
            )}
          </dd>
          {b.guestComment && (
            <>
              <dt>コメント</dt>
              <dd>
                <MultiLine text={b.guestComment} />
              </dd>
            </>
          )}
          {b.answers.map((a) => (
            <Fragment key={a.questionId}>
              <dt>{a.label}</dt>
              <dd>
                <MultiLine text={a.value || '—'} />
              </dd>
            </Fragment>
          ))}
          {params.length > 0 && (
            <>
              <dt>URL パラメータ</dt>
              <dd>
                {params.map(([k, v]) => (
                  <div key={k}>
                    <code>{k}</code> = {v}
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt>受付日時</dt>
          <dd>{formatDateTimeJa(b.createdAt, tz)}</dd>
          {b.status === 'cancelled' && (
            <>
              <dt>キャンセル</dt>
              <dd>
                {b.cancelledBy === 'guest' ? '応募者' : '管理者'}が{b.cancelledAt ? formatDateTimeJa(b.cancelledAt, tz) : ''}にキャンセル
                {b.cancelReason && <MultiLine text={`理由: ${b.cancelReason}`} />}
              </dd>
            </>
          )}
        </dl>
      </div>

      {b.status === 'confirmed' && (
        <div className="card">
          <h2>日程変更用 URL</h2>
          <p className="muted small">応募者の予定確認ページです。応募者に送ると、空いている日時から選び直してもらえます。</p>
          <div className="share-url">
            <code>{b.manageUrl}</code>
            <CopyButton text={b.manageUrl} />
          </div>
        </div>
      )}

      {b.status === 'confirmed' && (
        <div className="card">
          <h2>この予定をキャンセル</h2>
          <p className="muted small">応募者にキャンセルのメールが届き、連携カレンダーの予定も削除されます。</p>
          <textarea className="input" rows={3} placeholder="キャンセルの理由（応募者へのメールに記載されます）" value={reason} onChange={(e) => setReason(e.target.value)} />
          <ErrorBox error={cancel.error} />
          <ConfirmButton label="キャンセルする" danger message="本当にキャンセルしますか？" confirmLabel="キャンセルする" className="btn btn-danger-ghost" onConfirm={() => cancel.mutateAsync().then(() => undefined)} />
        </div>
      )}
    </div>
  );
}
