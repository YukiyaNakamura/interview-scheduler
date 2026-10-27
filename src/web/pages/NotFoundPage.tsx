/** 見つからないページ */
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="page narrow">
      <div className="card center-card">
        <h1>ページが見つかりません</h1>
        <p className="muted">URL をご確認ください。</p>
        <Link className="btn" to="/admin">
          ホームへ
        </Link>
      </div>
    </div>
  );
}
