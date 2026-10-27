/**
 * ゲストの予定確認ページ /r/:token。予定の内容を見て、期限内ならキャンセル・リスケジュールできる。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import type { PublicBooking, PublicCalendar } from '../../../shared/api';
import { formatRangeJa } from '../../../shared/time';
import { apiGet, apiPost } from '../../lib/api';
import { browserTimeZone, formatDateTimeJa } from '../../lib/format';
import { BookingSummaryCard, GuestShell } from '../../components/guest';
import { SlotPicker, type Slot } from '../../components/SlotPicker';
import { ConfirmButton, ErrorBox, Spinner } from '../../components/ui';

export function ManagePage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const key = ['public-booking', token];
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [reason, setReason] = useState('');
  const [newSlot, setNewSlot] = useState<Slot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);

  const booking = useQuery({ queryKey: key, queryFn: () => apiGet<PublicBooking>(`/api/public/bookings/${token}`), retry: false });
  const b = booking.data;
  const tz = timezone ?? b?.guestTimezone ?? browserTimeZone();

  // リスケのときだけ、提示期間を知るためにカレンダーの公開情報を取る
  const cal = useQuery({
    queryKey: ['public-calendar', b?.calendarSlug ?? '', '', ''],
    queryFn: () => apiGet<PublicCalendar>(`/api/public/c/${encodeURIComponent(b?.calendarSlug ?? '')}`),
    enabled: mode === 'reschedule' && b !== undefined,
    retry: false,
  });

  const cancel = useMutation({
    mutationFn: () => apiPost<PublicBooking>(`/api/public/bookings/${token}/cancel`, { reason }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      setNotice('予定をキャンセルしました。');
    },
  });
  const reschedule = useMutation({
    mutationFn: (start: string) => apiPost<PublicBooking>(`/api/public/bookings/${token}/reschedule`, { start }),
    onSuccess: (res) => {
      queryClient.setQueryData(key, res);
      setMode('view');
      setNewSlot(null);
      setNotice('日時を変更しました。確認のメールをお送りしました。');
      window.scrollTo({ top: 0 });
    },
  });

  if (booking.isLoading) {
    return (
      <GuestShell embed={false}>
        <Spinner />
      </GuestShell>
    );
  }
  if (!b) {
    return (
      <GuestShell embed={false}>
        <div className="guest-card center-card">
          <h1>予定が見つかりません</h1>
          <ErrorBox error={booking.error} />
        </div>
      </GuestShell>
    );
  }

  const cancelled = b.status === 'cancelled';

  return (
    <GuestShell embed={false}>
      <div className="guest-card manage">
        <h1>{cancelled ? 'この予定はキャンセルされました' : 'ご予約の確認'}</h1>
        {cancelled && <p className="muted">{b.cancelledBy === 'host' ? '主催者によってキャンセルされました。' : 'キャンセルを受け付けました。'}</p>}
        {notice && <div className="alert alert-success">{notice}</div>}
        <BookingSummaryCard booking={b} timezone={tz} />

        {!cancelled && mode === 'view' && (
          <>
            <div className="row-gap wrap">
              <a className="btn" href={`/api/public/bookings/${token}/ics`}>
                カレンダーに追加（.ics）
              </a>
              {b.canReschedule && (
                <button type="button" className="btn btn-primary" onClick={() => setMode('reschedule')}>
                  日時を変更する
                </button>
              )}
            </div>
            {(b.canCancel || b.canReschedule) && <p className="muted small">変更・キャンセルの期限: {formatDateTimeJa(b.deadlineAt, tz)}</p>}
            {!b.canCancel && !b.canReschedule && <p className="muted small">この予定はこのページから変更・キャンセルできません。主催者に直接ご連絡ください。</p>}

            {b.canCancel && (
              <div className="cancel-box">
                <h2>キャンセルする</h2>
                <textarea className="input" rows={3} placeholder="キャンセルの理由（任意）" value={reason} onChange={(e) => setReason(e.target.value)} />
                <ErrorBox error={cancel.error} />
                <ConfirmButton label="予定をキャンセルする" danger message="本当にキャンセルしますか？" confirmLabel="キャンセルする" className="btn btn-danger-ghost" onConfirm={() => cancel.mutateAsync().then(() => undefined)} />
              </div>
            )}
          </>
        )}

        {!cancelled && mode === 'reschedule' && (
          <div className="reschedule">
            <h2>新しい日時を選んでください</h2>
            {newSlot === null ? (
              <>
                {cal.isLoading && <Spinner />}
                {!cal.isLoading && (
                  <SlotPicker
                    slug={b.calendarSlug}
                    timezone={tz}
                    onTimezoneChange={setTimezone}
                    window={cal.data && !cal.data.locked ? cal.data.window : null}
                    reschedule={token}
                    onSelect={setNewSlot}
                  />
                )}
                <button type="button" className="btn btn-ghost" onClick={() => setMode('view')}>
                  やめる
                </button>
              </>
            ) : (
              <div className="stack">
                <div className="selected-slot">
                  <div className="muted small">変更前</div>
                  <div className="strike">{formatRangeJa(b.startAt, b.endAt, tz)}</div>
                  <div className="muted small">変更後</div>
                  <div className="strong">{formatRangeJa(newSlot.start, newSlot.end, tz)}</div>
                </div>
                <ErrorBox error={reschedule.error} />
                <div className="row-gap wrap">
                  <button type="button" className="btn btn-ghost" onClick={() => setNewSlot(null)}>
                    ‹ 選び直す
                  </button>
                  <button type="button" className="btn btn-primary" disabled={reschedule.isPending} onClick={() => reschedule.mutate(newSlot.start)}>
                    この日時に変更する
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </GuestShell>
  );
}
