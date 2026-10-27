/** カレンダー編集「表示・通知」: 表示名・メッセージ・メール・リマインド・予定名・パスワード・連携 */
import { useState } from 'react';
import { Field, Toggle } from '../ui';
import type { EditorProps } from './types';

/** リマインドの送信時刻の選択肢（1〜23 = 前日、24 = 当日 0:00） */
const REMINDER_HOURS = Array.from({ length: 24 }, (_, i) => i + 1);

export function NotifyTab({ draft, setSettings, members, issue }: EditorProps) {
  const s = draft.settings;
  // 通知先メールアドレスは文字のまま編集し、区切りごとに配列にする（入力途中の「,」を消さないため）
  const [emailsText, setEmailsText] = useState(s.notifyEmails.join('\n'));
  const memberNames = draft.members.map((m) => members.find((x) => x.id === m.memberId)?.name ?? '').filter(Boolean);

  return (
    <div className="tab-body">
      <section className="section">
        <h2>応募者の画面の表示</h2>
        <Field label="表示名" hint={`応募者の画面に表示する主催者名。空欄なら参加メンバー名（${memberNames.join('、') || '—'}）を表示します`} error={issue('settings.displayName')}>
          <input className="input" placeholder="例: 株式会社〇〇 採用担当" value={s.displayName} onChange={(e) => setSettings({ displayName: e.target.value })} />
        </Field>
        <Field label="日程調整開始時のメッセージ" hint="日程調整ページの上部に表示されます" error={issue('settings.description')}>
          <textarea className="input" rows={4} value={s.description} onChange={(e) => setSettings({ description: e.target.value })} />
        </Field>
        <Field label="日程調整完了時のメッセージ" hint="完了画面と完了メールに表示されます" error={issue('settings.completeMessage')}>
          <textarea className="input" rows={4} value={s.completeMessage} onChange={(e) => setSettings({ completeMessage: e.target.value })} />
        </Field>
        <Field label="完了後の遷移先URL" hint="指定すると完了画面の代わりにこの URL へ移動します（広告のコンバージョン計測など）" error={issue('settings.redirectUrl')}>
          <input className="input" type="url" placeholder="https://" value={s.redirectUrl} onChange={(e) => setSettings({ redirectUrl: e.target.value })} />
        </Field>
        <Field label="閲覧パスワード" hint="設定すると、パスワードを入力した応募者だけが日程候補を見られます" error={issue('settings.password')}>
          <input className="input" value={s.password} placeholder="なし" onChange={(e) => setSettings({ password: e.target.value })} autoComplete="off" />
        </Field>
      </section>

      <section className="section">
        <h2>応募者へのメール</h2>
        <Toggle checked={s.sendGuestConfirmation} onChange={(v) => setSettings({ sendGuestConfirmation: v })} label="応募者に日程調整完了メールを送信する" />
        {!s.sendGuestConfirmation && <div className="alert alert-warn small">オフにすると、Web 会議 URL や ICS ファイルもメールで案内されません。</div>}
        <Toggle checked={s.reminder.enabled} onChange={(v) => setSettings({ reminder: { ...s.reminder, enabled: v } })} label="リマインドメールを送る（応募者のみ）" />
        {s.reminder.enabled && (
          <div className="grid-2">
            <Field label="送信時刻" hint="応募者のタイムゾーン基準">
              <select className="input" value={s.reminder.hour} onChange={(e) => setSettings({ reminder: { ...s.reminder, hour: Number(e.target.value) } })}>
                {REMINDER_HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h === 24 ? '当日 0:00' : `前日 ${h}:00`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="リマインドメールの冒頭メッセージ" error={issue('settings.reminder')}>
              <textarea className="input" rows={3} value={s.reminder.message} onChange={(e) => setSettings({ reminder: { ...s.reminder, message: e.target.value } })} />
            </Field>
          </div>
        )}
      </section>

      <section className="section">
        <h2>面接官への通知</h2>
        <Toggle checked={s.hostEmails} onChange={(v) => setSettings({ hostEmails: v })} label="担当の面接官に日程調整完了・キャンセル・日程変更のメールを送る" />
        <Field label="通知先メールアドレス" hint="参加メンバー以外にも通知を送るアドレス（1行に1つ、10件まで）" error={issue('settings.notifyEmails')}>
          <textarea
            className="input"
            rows={3}
            value={emailsText}
            onChange={(e) => {
              setEmailsText(e.target.value);
              setSettings({ notifyEmails: e.target.value.split(/[\s,、]+/).map((x) => x.trim()).filter((x) => x !== '') });
            }}
          />
        </Field>
        <Field label="Slack 通知（Incoming Webhook URL）" error={issue('settings.slackWebhookUrl')}>
          <input className="input" type="url" placeholder="https://hooks.slack.com/services/…" value={s.slackWebhookUrl} onChange={(e) => setSettings({ slackWebhookUrl: e.target.value })} />
        </Field>
        <Field label="Webhook URL" hint="確定・キャンセル・リスケ時に JSON を POST します" error={issue('settings.webhookUrl')}>
          <input className="input" type="url" placeholder="https://" value={s.webhookUrl} onChange={(e) => setSettings({ webhookUrl: e.target.value })} />
        </Field>
      </section>

      <section className="section">
        <h2>連携カレンダーへの登録</h2>
        <Field label="予定名" hint={<>差し込み: <code>{'{calendar}'}</code> カレンダー名 / <code>{'{guest}'}</code> 応募者名 / <code>{'{company}'}</code> 会社名</>} error={issue('settings.eventTitle')}>
          <input className="input" value={s.eventTitle} onChange={(e) => setSettings({ eventTitle: e.target.value })} />
        </Field>
        <Toggle checked={s.eventPrivate} onChange={(v) => setSettings({ eventPrivate: v })} label="予定を「非公開」で登録する" />
      </section>
    </div>
  );
}
