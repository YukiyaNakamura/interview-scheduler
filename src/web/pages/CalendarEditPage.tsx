/**
 * 日程調整カレンダーの編集。詳細を取ってきて手元の下書き（draft）で編集し、「保存」で PUT する。
 * 保存前に共有スキーマ（calendarUpdateSchema）で検証し、エラーを項目の近くに出す。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { CalendarDetail } from '../../shared/api';
import { calendarUpdateSchema, type CalendarSettings, type CalendarUpdateInput } from '../../shared/schema';
import { formatRangeJa } from '../../shared/time';
import { ApiCallError, apiGet, apiPut } from '../lib/api';
import { useMembers } from '../lib/hooks';
import { BasicTab, LocationFields } from '../components/editor/BasicTab';
import { HoursTab } from '../components/editor/HoursTab';
import { NotifyTab } from '../components/editor/NotifyTab';
import { QuestionsTab } from '../components/editor/QuestionsTab';
import { RulesTab } from '../components/editor/RulesTab';
import { ShareTab } from '../components/editor/ShareTab';
import type { EditorProps } from '../components/editor/types';
import { CopyButton, ErrorBox, Field, Spinner, Toggle } from '../components/ui';

const TABS = [
  { id: 'basic', label: '基本設定', Comp: BasicTab },
  { id: 'hours', label: '受付時間', Comp: HoursTab },
  { id: 'rules', label: '提示期間・受付ルール', Comp: RulesTab },
  { id: 'questions', label: '質問', Comp: QuestionsTab },
  { id: 'notify', label: '表示・通知', Comp: NotifyTab },
  { id: 'share', label: '共有', Comp: ShareTab },
] as const;

type Issue = { path: string; message: string };

function toInput(d: CalendarDetail): CalendarUpdateInput {
  return { name: d.name, internalName: d.internalName, slug: d.slug, status: d.status, settings: d.settings, members: d.members };
}

export function CalendarEditPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('tab')) ?? TABS[0];
  const queryClient = useQueryClient();
  const members = useMembers();

  const detailQuery = useQuery({ queryKey: ['calendar', id], queryFn: () => apiGet<CalendarDetail>(`/api/admin/calendars/${id}`) });
  const [draft, setDraftState] = useState<CalendarUpdateInput | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saved, setSaved] = useState(false);

  // 詳細を取れたら下書きを作る（保存後に取り直したときも作り直す）
  useEffect(() => {
    if (detailQuery.data) setDraftState(toInput(detailQuery.data));
  }, [detailQuery.data]);

  const dirty = useMemo(() => draft !== null && detailQuery.data !== undefined && JSON.stringify(draft) !== JSON.stringify(toInput(detailQuery.data)), [draft, detailQuery.data]);

  const save = useMutation({
    mutationFn: (input: CalendarUpdateInput) => apiPut<CalendarDetail>(`/api/admin/calendars/${id}`, input),
    onSuccess: (d) => {
      queryClient.setQueryData(['calendar', id], d);
      queryClient.invalidateQueries({ queryKey: ['calendars'] });
      setSaved(true);
      setIssues([]);
    },
    onError: (err) => {
      if (err instanceof ApiCallError) setIssues(err.issues);
    },
  });

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  if (detailQuery.isLoading || (detailQuery.data && !draft)) return <Spinner />;
  if (detailQuery.error || !detailQuery.data || !draft) return <ErrorBox error={detailQuery.error ?? new Error('見つかりません')} />;
  const detail = detailQuery.data;

  const setDraft = (patch: Partial<CalendarUpdateInput>) => setDraftState((d) => (d ? { ...d, ...patch } : d));
  const setSettings = (patch: Partial<CalendarSettings>) => setDraftState((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const issue = (path: string) => issues.find((i) => i.path === path || i.path.startsWith(`${path}.`))?.message;

  const onSave = () => {
    const result = calendarUpdateSchema.safeParse(draft);
    if (!result.success) {
      setIssues(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })));
      return;
    }
    save.mutate(result.data);
  };

  const props: EditorProps = { detail, draft, setDraft, setSettings, members: members.data ?? [], issue };

  return (
    <div className="page">
      <div className="page-head sticky-head">
        <div className="min0">
          <Link className="back-link" to="/admin">
            ‹ 日程調整カレンダー一覧
          </Link>
          <h1 className="ellipsis">{draft.name || '（名前なし）'}</h1>
        </div>
        <div className="row-gap wrap">
          {dirty && <span className="muted small">未保存の変更があります</span>}
          {saved && <span className="saved">保存しました</span>}
          <CopyButton text={detail.url} label="URLをコピー" />
          <button type="button" className="btn btn-primary" disabled={save.isPending || !dirty} onClick={onSave}>
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="alert alert-error" role="alert">
          <div>入力内容を確認してください</div>
          <ul className="issue-list">
            {issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {save.error && issues.length === 0 && <ErrorBox error={save.error} />}

      {detail.kind === 'candidates' ? (
        <CandidatesEditor {...props} />
      ) : (
        <>
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                type="button"
                role="tab"
                aria-selected={t.id === tab.id}
                key={t.id}
                className={t.id === tab.id ? 'tab active' : 'tab'}
                onClick={() =>
                  setParams((p) => {
                    p.set('tab', t.id);
                    return p;
                  }, { replace: true })
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <tab.Comp {...props} />
        </>
      )}
    </div>
  );
}

/** 候補を選んで日程調整の編集（変えられるのは名前・受付・場所・プライバシーだけ） */
function CandidatesEditor({ detail, draft, setDraft, setSettings, issue }: EditorProps) {
  const s = draft.settings;
  return (
    <div className="tab-body">
      <section className="section">
        <h2>候補を選んで日程調整</h2>
        <p className="muted small">1人目の応募者が日程を確定すると受付を終了します。日時の変更はできないため、変えたいときは作り直してください。</p>
        <Field label="予定名" required error={issue('name')}>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ name: e.target.value })} />
        </Field>
        <Field label="受付状況">
          <Toggle checked={draft.status === 'open'} onChange={(v) => setDraft({ status: v ? 'open' : 'closed' })} label={draft.status === 'open' ? '受付中' : '受付終了'} />
        </Field>
        <Field label="Web会議・場所">
          <LocationFields value={s.location} onChange={(location) => setSettings({ location })} />
        </Field>
        <Toggle checked={s.eventPrivate} onChange={(v) => setSettings({ eventPrivate: v })} label="予定を「非公開」で登録する" />
      </section>
      <section className="section">
        <h2>候補日時（{detail.candidateSlots.length}枠）</h2>
        <ul className="candidate-list">
          {detail.candidateSlots.map((start) => (
            <li key={start}>{formatRangeJa(start, new Date(new Date(start).getTime() + s.durationMin * 60_000), s.timezone)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
