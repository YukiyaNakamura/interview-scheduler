/**
 * ゲストの日程調整ページ /c/:slug。
 * 日時を選ぶ → 質問に答える → 完了（または指定の URL へ移動）の3段階。
 * クエリ: ?ot=ワンタイム ?embed=1 埋め込み ?name ?email ?company ?q_<質問ID> 事前入力。それ以外は urlParams として予定に保存する
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { BookingCreateInput, BookingCreateResponse, NoSlotInput, PublicBooking, PublicCalendar } from '../../../shared/api';
import { formatRangeJa } from '../../../shared/time';
import { ApiCallError, apiGet, apiPost } from '../../lib/api';
import { browserTimeZone, formatDuration } from '../../lib/format';
import { BookingSummaryCard, GuestShell, QuestionForm } from '../../components/guest';
import { SlotPicker, type Slot } from '../../components/SlotPicker';
import { AvatarStack, ErrorBox, MultiLine, Spinner } from '../../components/ui';

const RESERVED = new Set(['ot', 'embed', 'name', 'email', 'company']);

export function GuestBookingPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const ot = params.get('ot');
  const embed = params.get('embed') === '1';

  const [password, setPassword] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [timezone, setTimezone] = useState(browserTimeZone());
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<PublicBooking | null>(null);

  const headers: Record<string, string> = password ? { 'x-calendar-password': password } : {};
  const calQuery = useQuery({
    queryKey: ['public-calendar', slug, ot ?? '', password ?? ''],
    queryFn: () => apiGet<PublicCalendar>(`/api/public/c/${encodeURIComponent(slug)}${ot ? `?ot=${encodeURIComponent(ot)}` : ''}`, headers),
    retry: false,
  });
  const cal = calQuery.data;

  // 事前入力（パラメータ連携）と、予定に保存する残りのパラメータ
  const { initial, urlParams } = useMemo(() => {
    const initial: Record<string, string | string[]> = {};
    const urlParams: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      if (k.startsWith('q_')) initial[k.slice(2)] = v;
      else if (!RESERVED.has(k)) urlParams[k] = v;
    }
    for (const q of cal?.questions ?? []) {
      if (q.system === 'name' || q.system === 'email' || q.system === 'company') {
        const v = params.get(q.system);
        if (v !== null) initial[q.id] = v;
      }
      // チェックボックスの事前入力は「,」区切り
      const pre = initial[q.id];
      if (q.type === 'checkbox' && typeof pre === 'string') initial[q.id] = pre.split(',').filter(Boolean);
    }
    return { initial, urlParams };
  }, [params, cal?.questions]);

  const book = useMutation({
    mutationFn: (answers: Record<string, string | string[]>) => {
      const body: BookingCreateInput = { start: slot?.start ?? '', timezone, answers, urlParams };
      if (ot) body.oneTimeToken = ot;
      return apiPost<BookingCreateResponse>(`/api/public/c/${encodeURIComponent(slug)}/bookings`, body, headers);
    },
    onSuccess: (res) => {
      if (res.redirectUrl) {
        // 埋め込み（iframe）の中からでも親ページごと移動する。できなければこの枠の中で移動する
        try {
          (window.top ?? window).location.href = res.redirectUrl;
        } catch {
          window.location.href = res.redirectUrl;
        }
        return;
      }
      setDone(res.booking);
      window.scrollTo({ top: 0 });
    },
    onError: (err) => {
      // 選んだ枠が埋まった（409）ときは日時の選択に戻して最新の空きを取り直す
      if (err instanceof ApiCallError && err.status === 409) {
        setSlot(null);
        queryClient.invalidateQueries({ queryKey: ['slots', slug] });
      }
    },
  });

  if (calQuery.isLoading) {
    return (
      <GuestShell embed={embed}>
        <Spinner />
      </GuestShell>
    );
  }
  if (!cal) {
    return (
      <GuestShell embed={embed}>
        <div className="guest-card center-card">
          <h1>ページが見つかりません</h1>
          <p className="muted">URL をご確認ください。</p>
          <ErrorBox error={calQuery.error} />
        </div>
      </GuestShell>
    );
  }

  // 閲覧パスワード
  if (cal.locked) {
    return (
      <GuestShell embed={embed}>
        <form
          className="guest-card center-card narrow-card"
          onSubmit={(e) => {
            e.preventDefault();
            setPassword(passwordInput);
          }}
        >
          <h1>{cal.name}</h1>
          <p className="muted">この日程調整ページを見るにはパスワードが必要です。</p>
          {password !== null && <div className="alert alert-error">パスワードが違います</div>}
          <input className="input" type="password" autoFocus value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} placeholder="パスワード" />
          <button className="btn btn-primary btn-block" disabled={passwordInput === ''}>
            表示する
          </button>
        </form>
      </GuestShell>
    );
  }

  // 完了画面
  if (done) {
    return (
      <GuestShell embed={embed}>
        <div className="guest-card">
          <div className="done-head">
            <div className="done-mark" aria-hidden="true">
              ✓
            </div>
            <h1>日程調整が完了しました</h1>
            <p className="muted">確認のメールを {done.guestEmail} にお送りしました。</p>
          </div>
          {done.completeMessage && (
            <div className="message-box">
              <MultiLine text={done.completeMessage} />
            </div>
          )}
          <BookingSummaryCard booking={done} timezone={timezone} />
          <div className="row-gap wrap center">
            <a className="btn" href={`/api/public/bookings/${done.manageToken}/ics`}>
              カレンダーに追加（.ics）
            </a>
            <a className="btn btn-ghost" href={`/r/${done.manageToken}`} target={embed ? '_blank' : undefined} rel="noreferrer">
              予定の確認・変更
            </a>
          </div>
        </div>
      </GuestShell>
    );
  }

  const hosts = cal.hosts.map((h) => ({ name: h.name, avatarUrl: h.avatarUrl }));

  return (
    <GuestShell embed={embed}>
      <div className="guest-layout">
        <aside className="guest-info">
          {cal.displayName && <div className="guest-host">{cal.displayName}</div>}
          <h1 className="guest-title">{cal.name}</h1>
          <div className="guest-facts">
            <div>⏱ {formatDuration(cal.durationMin)}</div>
            <div>📍 {cal.locationLabel}</div>
            {hosts.length > 0 && (
              <div className="row-gap">
                <AvatarStack people={hosts} />
              </div>
            )}
          </div>
          {cal.description && (
            <div className="guest-desc">
              <MultiLine text={cal.description} />
            </div>
          )}
        </aside>

        <section className="guest-main">
          {cal.closedReason ? (
            <div className="closed-box">
              <h2>受付を終了しました</h2>
              <p>{cal.closedReason}</p>
            </div>
          ) : slot === null ? (
            <>
              <h2 className="step-title">
                <span className="step-num">1</span>ご希望の日時を選んでください
              </h2>
              {book.error instanceof ApiCallError && book.error.status === 409 && <div className="alert alert-warn">{book.error.message}</div>}
              <SlotPicker slug={slug} timezone={timezone} onTimezoneChange={setTimezone} window={cal.window} ot={ot} password={password} onSelect={setSlot} />
              {cal.notifyNoSlot && <NoSlotForm slug={slug} headers={headers} />}
            </>
          ) : (
            <>
              <h2 className="step-title">
                <span className="step-num">2</span>お名前とご連絡先を入力してください
              </h2>
              <QuestionForm
                questions={cal.questions}
                initial={initial}
                submitting={book.isPending}
                error={book.error}
                onBack={() => setSlot(null)}
                onSubmit={(answers) => book.mutate(answers)}
                summary={
                  <>
                    <span className="muted small">選択した日時</span>
                    <div className="strong">{formatRangeJa(slot.start, slot.end, timezone)}</div>
                  </>
                }
              />
            </>
          )}
        </section>
      </div>
    </GuestShell>
  );
}

/** 都合の良い日程がないとき、ゲストがホストへ希望を送るフォーム */
function NoSlotForm({ slug, headers }: { slug: string; headers: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NoSlotInput>({ name: '', email: '', message: '' });
  const send = useMutation({ mutationFn: () => apiPost(`/api/public/c/${encodeURIComponent(slug)}/no-slot`, form, headers) });

  if (send.isSuccess) return <div className="alert alert-success">主催者にお知らせしました。追ってご連絡があります。</div>;
  if (!open) {
    return (
      <button type="button" className="link-btn no-slot-link" onClick={() => setOpen(true)}>
        都合の良い日程がない場合はこちら
      </button>
    );
  }
  return (
    <form
      className="no-slot-form"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <div className="strong">主催者に知らせる</div>
      <p className="muted small">ご都合の良い日時などをお書きください。主催者にメールでお知らせします。</p>
      <input className="input" required placeholder="お名前" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input className="input" required type="email" placeholder="メールアドレス" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <textarea className="input" required rows={3} placeholder="例: 11月第2週の平日 18時以降でしたら可能です" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
      <ErrorBox error={send.error} />
      <div className="row-gap">
        <button className="btn btn-primary btn-sm" disabled={send.isPending}>
          送信
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </div>
    </form>
  );
}
