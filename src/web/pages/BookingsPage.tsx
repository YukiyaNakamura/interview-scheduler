/** 予定一覧（今後・過去・キャンセル）。カレンダーとキーワードで絞り込み、CSV でも出せる。50件ずつ「さらに表示」で読む */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { BookingListResponse, CalendarSummary } from '../../shared/api';
import { formatRangeJa } from '../../shared/time';
import { apiGet } from '../lib/api';
import { browserTimeZone } from '../lib/format';
import { Badge, Empty, ErrorBox, Spinner } from '../components/ui';

const SCOPES = [
  { id: 'upcoming', label: '今後の予定' },
  { id: 'past', label: '過去の予定' },
  { id: 'cancelled', label: 'キャンセル' },
] as const;

export function BookingsPage() {
  // 管理画面の日時はブラウザのタイムゾーンで表示する
  const tz = browserTimeZone();
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') ?? 'upcoming';
  const calendarId = params.get('calendarId') ?? '';
  const q = params.get('q') ?? '';
  const [qInput, setQInput] = useState(q);

  const setParam = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value === '') p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true },
    );

  const query = new URLSearchParams({ scope });
  if (calendarId) query.set('calendarId', calendarId);
  if (q) query.set('q', q);

  const calendars = useQuery({ queryKey: ['calendars'], queryFn: () => apiGet<CalendarSummary[]>('/api/admin/calendars') });
  const list = useInfiniteQuery({
    queryKey: ['bookings', query.toString()],
    queryFn: ({ pageParam }) => apiGet<BookingListResponse>(`/api/admin/bookings?${query.toString()}${pageParam ? `&after=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const bookings = list.data?.pages.flatMap((p) => p.bookings) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>予定一覧</h1>
          <p className="muted">日程調整で確定した予定です。</p>
        </div>
        <a className="btn" href={`/api/admin/bookings.csv?${query.toString()}`} download>
          CSV をダウンロード
        </a>
      </div>

      <div className="tabs" role="tablist">
        {SCOPES.map((s) => (
          <button type="button" role="tab" key={s.id} aria-selected={scope === s.id} className={scope === s.id ? 'tab active' : 'tab'} onClick={() => setParam('scope', s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="filters">
        <select className="input" value={calendarId} onChange={(e) => setParam('calendarId', e.target.value)}>
          <option value="">すべてのカレンダー</option>
          {(calendars.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.internalName ? `（${c.internalName}）` : ''}
            </option>
          ))}
        </select>
        <form
          className="row-gap grow"
          onSubmit={(e) => {
            e.preventDefault();
            setParam('q', qInput.trim());
          }}
        >
          <input className="input grow" type="search" placeholder="応募者の名前・会社名・メールで検索" value={qInput} onChange={(e) => setQInput(e.target.value)} />
          <button className="btn">検索</button>
        </form>
      </div>

      {list.isLoading && <Spinner />}
      <ErrorBox error={list.error} />
      {list.data && bookings.length === 0 && <Empty>予定はありません</Empty>}

      {bookings.length > 0 && (
        <div className="table-wrap">
          <table className="table bookings-table">
            <thead>
              <tr>
                <th>日時</th>
                <th>応募者</th>
                <th>カレンダー</th>
                <th>面接官</th>
                <th>Web会議</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id} className={b.status === 'cancelled' ? 'row-cancelled' : ''}>
                  <td className="nowrap">
                    <Link to={`/admin/bookings/${b.id}`} className="strong">
                      {formatRangeJa(b.startAt, b.endAt, tz)}
                    </Link>
                    {b.status === 'cancelled' && (
                      <div>
                        <Badge tone="red">{b.cancelledBy === 'guest' ? '応募者がキャンセル' : 'キャンセル'}</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="strong">{b.guestName}</div>
                    {b.guestCompany && <div className="muted small">{b.guestCompany}</div>}
                    <div className="muted small">{b.guestEmail}</div>
                  </td>
                  <td>{b.calendarName}</td>
                  <td>{b.hosts.map((h) => h.name).join('、')}</td>
                  <td>
                    {b.meetingUrl ? (
                      <a href={b.meetingUrl} target="_blank" rel="noreferrer">
                        参加
                      </a>
                    ) : (
                      <span className="muted">{b.locationText || '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <div className="row-gap">
          <button type="button" className="btn" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
            {list.isFetchingNextPage ? '読み込み中…' : 'さらに表示'}
          </button>
        </div>
      )}
    </div>
  );
}
