/**
 * 最初の画面（/）と応募者向けの案内（/guest）。docs/01「画面」。
 * - /: 「採用担当の方（管理者）」と「応募者の方」を選ぶ
 * - /guest: 応募者はログインしない。届いた URL から日時を選ぶ案内と、予約した面接の確認 URL をメールで送り直すフォーム
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { BookingLinksInput, MessageResponse } from '../../shared/api';
import { apiPost } from '../lib/api';
import { useConfig } from '../lib/hooks';
import { ErrorBox, Field } from '../components/ui';

function Brand() {
  const config = useConfig();
  return (
    <div className="home-brand">
      <span className="brand-mark" aria-hidden="true">
        ◷
      </span>
      {config.data?.appName ?? 'Aiteru'}
    </div>
  );
}

export function HomePage() {
  return (
    <div className="home-page">
      <Brand />
      <h1 className="home-title">面接の日程調整</h1>
      <p className="muted home-lead">あてはまる方を選んでください。</p>
      <div className="home-choices">
        <Link className="home-choice card" to="/login">
          <span className="home-choice-icon" aria-hidden="true">
            ⚙
          </span>
          <span className="home-choice-title">採用担当の方</span>
          <span className="muted small">管理者としてログインし、日程調整カレンダーの作成や予定の確認をします。</span>
          <span className="home-choice-go">ログイン・新規登録 →</span>
        </Link>
        <Link className="home-choice card" to="/guest">
          <span className="home-choice-icon" aria-hidden="true">
            ✉
          </span>
          <span className="home-choice-title">応募者の方</span>
          <span className="muted small">面接の日時を選ぶ方、予約した面接を確認・変更したい方はこちら。ログインは不要です。</span>
          <span className="home-choice-go">応募者の方へ →</span>
        </Link>
      </div>
    </div>
  );
}

export function GuestHomePage() {
  const [email, setEmail] = useState('');
  const send = useMutation({ mutationFn: (body: BookingLinksInput) => apiPost<MessageResponse>('/api/public/booking-links', body) });
  return (
    <div className="home-page">
      <Brand />
      <h1 className="home-title">応募者の方へ</h1>
      <section className="card home-section">
        <h2>面接の日時を選ぶ</h2>
        <p>
          採用担当者から届いたメールの <strong>日程調整の URL</strong> を開き、ご都合の良い日時を選んでください。名前とメールアドレスを入れると予約が確定します。ログインや会員登録は不要です。
        </p>
        <p className="muted small">URL が見当たらない場合は、応募先の採用担当者にお問い合わせください。</p>
      </section>
      <section className="card home-section">
        <h2>予約した面接の確認・変更</h2>
        <p className="small">予約したときのメールアドレスを入れると、予定の確認・キャンセル・日程変更ができる URL をメールでお送りします。</p>
        {send.data ? (
          <div className="alert alert-success" role="status">
            {send.data.message}
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate({ email: email.trim() });
            }}
          >
            <Field label="メールアドレス">
              <input className="input" required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <ErrorBox error={send.error} />
            <button className="btn btn-primary" disabled={send.isPending}>
              {send.isPending ? '送信しています…' : '確認用の URL を送る'}
            </button>
          </form>
        )}
      </section>
      <Link className="small" to="/">
        ← 最初の画面に戻る
      </Link>
    </div>
  );
}
