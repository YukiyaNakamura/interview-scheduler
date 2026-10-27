/** カレンダー編集の各タブに渡すもの */
import type { CalendarDetail, MemberInfo } from '../../../shared/api';
import type { CalendarSettings, CalendarUpdateInput } from '../../../shared/schema';

export interface EditorProps {
  detail: CalendarDetail;
  draft: CalendarUpdateInput;
  /** name / slug / members など、settings 以外の更新 */
  setDraft: (patch: Partial<CalendarUpdateInput>) => void;
  /** settings の一部を更新 */
  setSettings: (patch: Partial<CalendarSettings>) => void;
  /** 登録済みのメンバー（参加メンバーの選択肢・名前の表示） */
  members: MemberInfo[];
  /** 'settings.durationMin' のようなパスのエラー文（前方一致） */
  issue: (path: string) => string | undefined;
}
