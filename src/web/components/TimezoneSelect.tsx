/** タイムゾーンの選択。よく使うもの＋今の値（一覧にないとき） */
import { COMMON_TIMEZONES } from '../../shared/time';

export function TimezoneSelect({ value, onChange, id, className = 'input' }: { value: string; onChange: (tz: string) => void; id?: string; className?: string }) {
  const options = COMMON_TIMEZONES.some((t) => t.id === value) ? COMMON_TIMEZONES : [{ id: value, label: value }, ...COMMON_TIMEZONES];
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((t) => (
        <option key={t.id} value={t.id}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
