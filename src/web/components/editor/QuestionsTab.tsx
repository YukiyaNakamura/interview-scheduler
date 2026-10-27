/** カレンダー編集「応募者への質問」: 追加・編集・削除・並べ替え。名前とメールは削除・任意化できない */
import { useState } from 'react';
import { QUESTION_TYPE_LABELS, QUESTION_TYPES, type Question } from '../../../shared/schema';

/** よく使う既定の任意項目（まだ無ければワンクリックで足せる） */
const OPTIONAL_SYSTEM: Question[] = [
  { id: 'company', type: 'text', label: '会社名', help: '', required: false, options: [], system: 'company' },
  { id: 'comment', type: 'textarea', label: 'コメント', help: '', required: false, options: [], system: 'comment' },
];
import { shortId } from '../../lib/format';
import { Badge, Field } from '../ui';
import type { EditorProps } from './types';

const CHOICE_TYPES: Question['type'][] = ['checkbox', 'radio', 'select'];

export function QuestionsTab({ draft, setSettings, issue }: EditorProps) {
  const questions = draft.settings.questions;
  const [newType, setNewType] = useState<Question['type']>('text');
  const set = (qs: Question[]) => setSettings({ questions: qs });
  const missingOptional = OPTIONAL_SYSTEM.filter((o) => !questions.some((q) => q.system === o.system || q.id === o.id));
  const patch = (i: number, p: Partial<Question>) => set(questions.map((q, n) => (n === i ? { ...q, ...p } : q)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    set(next);
  };

  return (
    <div className="tab-body">
      <section className="section">
        <h2>応募者への質問</h2>
        <p className="muted small">日程を選んだあとに入力してもらう項目です。初期設定は「名前」と「メールアドレス」の2つだけで、この2つは完了メールの送信に使うため削除や任意にはできません。必要なら質問を追加してください。</p>
        {issue('settings.questions') && <div className="alert alert-error">{issue('settings.questions')}</div>}
        <div className="questions">
          {questions.map((q, i) => {
            const locked = q.system === 'name' || q.system === 'email';
            return (
              <div className="question-card" key={q.id}>
                <div className="question-head">
                  <Badge tone={q.system ? 'blue' : 'gray'}>{q.system === 'email' ? 'メールアドレス' : QUESTION_TYPE_LABELS[q.type]}</Badge>
                  {q.system && <span className="muted small">既定の項目</span>}
                  <span className="grow" />
                  <button type="button" className="icon-btn" aria-label="上へ" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className="icon-btn" aria-label="下へ" disabled={i === questions.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button type="button" className="icon-btn danger" aria-label="削除" disabled={locked} title={locked ? 'この項目は削除できません' : '削除'} onClick={() => set(questions.filter((_, n) => n !== i))}>
                    🗑
                  </button>
                </div>
                <div className="grid-2">
                  <Field label="質問タイトル">
                    <input className="input" value={q.label} onChange={(e) => patch(i, { label: e.target.value })} />
                  </Field>
                  <Field label="補足事項">
                    <input className="input" value={q.help} placeholder="入力例や注意事項（任意）" onChange={(e) => patch(i, { help: e.target.value })} />
                  </Field>
                </div>
                {CHOICE_TYPES.includes(q.type) && (
                  <Field label="選択肢" hint="1行に1つ">
                    <textarea
                      className="input"
                      rows={Math.max(3, q.options.length + 1)}
                      value={q.options.join('\n')}
                      onChange={(e) => patch(i, { options: e.target.value.split('\n').map((x) => x.trim()).filter((x, n, arr) => x !== '' || n === arr.length - 1) })}
                      onBlur={(e) => patch(i, { options: e.target.value.split('\n').map((x) => x.trim()).filter((x) => x !== '') })}
                    />
                  </Field>
                )}
                <label className="check">
                  <input type="checkbox" checked={q.required} disabled={locked} onChange={(e) => patch(i, { required: e.target.checked })} />
                  回答を必須にする
                </label>
              </div>
            );
          })}
        </div>
        {missingOptional.length > 0 && (
          <div className="row-gap wrap add-question">
            <span className="muted small">よく使う項目:</span>
            {missingOptional.map((o) => (
              <button type="button" key={o.id} className="btn btn-sm" disabled={questions.length >= 30} onClick={() => set([...questions, { ...o }])}>
                ＋ {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="row-gap wrap add-question">
          <select className="input" value={newType} onChange={(e) => setNewType(e.target.value as Question['type'])}>
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={questions.length >= 30}
            onClick={() =>
              set([
                ...questions,
                {
                  id: shortId('q'),
                  type: newType,
                  label: '新しい質問',
                  help: '',
                  required: false,
                  options: CHOICE_TYPES.includes(newType) ? ['選択肢1', '選択肢2'] : [],
                },
              ])
            }
          >
            ＋ 質問を追加
          </button>
        </div>
      </section>
    </div>
  );
}
