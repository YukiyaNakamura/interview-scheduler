/**
 * ホーム: 日程調整カレンダーの一覧。URL コピー・ワンタイム URL・受付停止・複製・削除をここからできる。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CalendarDetail, CalendarSummary, OneTimeLinkInfo } from '../../shared/api';
import { LOCATION_LABELS, PARTICIPATION_LABELS } from '../../shared/schema';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';
import { copyText, formatDuration } from '../lib/format';
import { useMembers } from '../lib/hooks';
import { NoMembersCallout } from '../components/NoMembersCallout';
import { AvatarStack, Badge, ConfirmButton, CopyButton, Empty, ErrorBox, Spinner } from '../components/ui';

export function CalendarsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const members = useMembers();
  const listQuery = useQuery({
    queryKey: ['calendars'],
    queryFn: () => apiGet<CalendarSummary[]>('/api/admin/calendars'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['calendars'] });

  const create = useMutation({
    mutationFn: (name: string) => apiPost<CalendarDetail>('/api/admin/calendars', { name }),
    onSuccess: (cal) => {
      refresh();
      navigate(`/admin/calendars/${cal.id}`);
    },
  });

  /** 失敗したら画面上部にエラーを出す共通の実行 */
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setActionError(null);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
      await refresh();
    } catch (err) {
      setActionError(err);
    }
  };

  const toggleStatus = (c: CalendarSummary) =>
    run(async () => {
      const d = await apiGet<CalendarDetail>(`/api/admin/calendars/${c.id}`);
      await apiPut(`/api/admin/calendars/${c.id}`, {
        name: d.name,
        internalName: d.internalName,
        slug: d.slug,
        status: d.status === 'open' ? 'closed' : 'open',
        settings: d.settings,
        members: d.members,
      });
    }, c.status === 'open' ? `「${c.name}」の受付を停止しました` : `「${c.name}」の受付を再開しました`);

  const oneTime = (c: CalendarSummary) =>
    run(async () => {
      const link = await apiPost<OneTimeLinkInfo>(`/api/admin/calendars/${c.id}/one-time-links`);
      await copyText(link.url);
    }, `ワンタイム URL をコピーしました（1回だけ日程調整できます）`);

  const calendars = listQuery.data ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>日程調整カレンダー</h1>
          <p className="muted">URL を応募者に送ると、面接官の空いている日時から選んでもらえます。</p>
        </div>
        <div className="row-gap wrap">
          <Link className="btn" to="/admin/candidates/new">
            候補を選んで日程調整
          </Link>
          <button type="button" className="btn btn-primary" disabled={members.data?.length === 0} onClick={() => setCreating(true)}>
            ＋ 新規作成
          </button>
        </div>
      </div>

      {creating && (
        <form
          className="card create-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim() !== '') create.mutate(newName.trim());
          }}
        >
          <label className="field-label">日程調整カレンダー名</label>
          <div className="row-gap wrap">
            <input className="input grow" autoFocus placeholder="例: 一次面接（オンライン 60分）" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn btn-primary" disabled={create.isPending || newName.trim() === ''}>
              作成して設定へ
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
              やめる
            </button>
          </div>
          <ErrorBox error={create.error} />
        </form>
      )}

      {members.data && members.data.length === 0 && <NoMembersCallout />}
      {message && <div className="alert alert-success">{message}</div>}
      <ErrorBox error={actionError} />
      {listQuery.isLoading && <Spinner />}
      <ErrorBox error={listQuery.error} />

      {listQuery.data && calendars.length === 0 && (
        <Empty>
          まだ日程調整カレンダーがありません。「新規作成」から作りましょう。
        </Empty>
      )}

      <div className="cal-grid">
        {calendars.map((c) => (
          <div className={c.status === 'open' ? 'cal-card' : 'cal-card closed'} key={c.id}>
            <div className="cal-card-top">
              <div className="row-gap wrap">
                {c.status === 'open' ? <Badge tone="green">受付中</Badge> : <Badge>受付停止</Badge>}
                {c.kind === 'candidates' && <Badge tone="blue">候補を選んで日程調整</Badge>}
              </div>
              <Link className="cal-name" to={`/admin/calendars/${c.id}`}>
                {c.name}
              </Link>
              {c.internalName && <div className="muted small">{c.internalName}</div>}
            </div>
            <div className="cal-meta">
              <span>⏱ {formatDuration(c.durationMin)}</span>
              <span>👥 {PARTICIPATION_LABELS[c.participation]}</span>
              <span>📍 {LOCATION_LABELS[c.locationType]}</span>
            </div>
            <div className="cal-members">
              <AvatarStack people={c.members.map((m) => ({ name: m.name, avatarUrl: null }))} />
              <span className="muted small">今後の予定 {c.upcomingCount} 件</span>
            </div>
            <div className="cal-url">
              <code title={c.url}>{c.url.replace(/^https?:\/\//, '')}</code>
            </div>
            <div className="cal-actions">
              <CopyButton text={c.url} label="URLをコピー" className="btn btn-sm btn-primary" />
              {c.kind === 'standard' && (
                <button type="button" className="btn btn-sm" onClick={() => oneTime(c)}>
                  ワンタイムURL
                </button>
              )}
              <Link className="btn btn-sm" to={`/admin/calendars/${c.id}`}>
                編集
              </Link>
              <details className="more">
                <summary className="btn btn-sm btn-ghost" aria-label="その他の操作">
                  …
                </summary>
                <div className="more-menu">
                  <a className="more-item" href={c.url} target="_blank" rel="noreferrer">
                    応募者の画面を開く
                  </a>
                  <button type="button" className="more-item" onClick={() => toggleStatus(c)}>
                    {c.status === 'open' ? '受付を停止する' : '受付を再開する'}
                  </button>
                  {c.kind === 'standard' && (
                    <button type="button" className="more-item" onClick={() => run(() => apiPost(`/api/admin/calendars/${c.id}/duplicate`), `「${c.name}」を複製しました`)}>
                      複製する
                    </button>
                  )}
                  <div className="more-item">
                    <ConfirmButton
                      label="削除する"
                      danger
                      message="削除しますか？"
                      confirmLabel="削除"
                      onConfirm={() => run(() => apiDelete(`/api/admin/calendars/${c.id}`), `「${c.name}」を削除しました`)}
                    />
                  </div>
                </div>
              </details>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
