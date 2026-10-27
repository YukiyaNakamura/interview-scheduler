/** メンバーが1人もいないときの案内（カレンダー一覧・候補を選ぶ画面） */
import { Link } from 'react-router';

export function NoMembersCallout() {
  return (
    <div className="callout">
      <div>
        <div className="strong">まずメンバー（面接官）を登録してください</div>
        <div className="muted small">日程調整カレンダーには、空き時間を確認する面接官が1人以上必要です。</div>
      </div>
      <Link className="btn btn-primary" to="/admin/members">
        メンバーを登録する
      </Link>
    </div>
  );
}
