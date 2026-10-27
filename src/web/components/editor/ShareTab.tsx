/** カレンダー編集「共有」: URL・ワンタイム URL・埋め込みコード・パラメータ連携の説明 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OneTimeLinkInfo } from '../../../shared/api';
import { apiDelete, apiGet, apiPost } from '../../lib/api';
import { ConfirmButton, CopyButton, Empty, ErrorBox, Spinner } from '../ui';
import type { EditorProps } from './types';

export function ShareTab({ detail, draft }: EditorProps) {
  const queryClient = useQueryClient();
  const url = detail.url;
  const linksKey = ['one-time-links', detail.id];
  const links = useQuery({
    queryKey: linksKey,
    queryFn: () => apiGet<OneTimeLinkInfo[]>(`/api/admin/calendars/${detail.id}/one-time-links`),
    enabled: detail.kind === 'standard',
  });
  const create = useMutation({
    mutationFn: () => apiPost<OneTimeLinkInfo>(`/api/admin/calendars/${detail.id}/one-time-links`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: linksKey }),
  });
  const remove = useMutation({
    mutationFn: (token: string) => apiDelete(`/api/admin/one-time-links/${token}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: linksKey }),
  });

  const embed = `<iframe src="${url}?embed=1" style="width:100%;height:760px;border:0" title="${detail.name}"></iframe>`;
  const companyQ = draft.settings.questions.find((q) => !q.system);
  const example = `${url}?name=山田太郎&email=taro@example.com${companyQ ? `&q_${companyQ.id}=…` : ''}&utm_source=indeed`;

  return (
    <div className="tab-body">
      <section className="section">
        <h2>日程調整 URL</h2>
        {draft.slug !== detail.slug && <div className="alert alert-warn small">URL の変更は保存すると反映されます。</div>}
        <div className="share-url">
          <code>{url}</code>
          <CopyButton text={url} label="URLをコピー" className="btn btn-sm btn-primary" />
          <a className="btn btn-sm" href={url} target="_blank" rel="noreferrer">
            開く
          </a>
        </div>
      </section>

      {detail.kind === 'standard' && (
        <section className="section">
          <h2>ワンタイム URL</h2>
          <p className="muted small">1回だけ日程調整ができる URL です。日程調整が完了すると無効になります。同じ応募者から重複して予約が入るのを防げます。</p>
          <button type="button" className="btn btn-sm btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            ＋ ワンタイム URL を発行
          </button>
          <ErrorBox error={create.error ?? remove.error ?? links.error} />
          {links.isLoading && <Spinner />}
          {links.data && links.data.length === 0 && <Empty>日程調整中のワンタイム URL はありません</Empty>}
          {links.data && links.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>作成日時</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {links.data.map((l) => (
                    <tr key={l.token}>
                      <td className="ellipsis">
                        <code>{l.url}</code>
                      </td>
                      <td>{new Date(l.createdAt).toLocaleString('ja-JP')}</td>
                      <td className="nowrap">
                        <CopyButton text={l.url} />
                        <ConfirmButton label="削除" danger message="削除しますか？" confirmLabel="削除" onConfirm={() => remove.mutateAsync(l.token).then(() => undefined)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="section">
        <h2>Web サイトに埋め込む（ウィジェット）</h2>
        <p className="muted small">このコードを採用ページなどの HTML に貼り付けると、そのページの中で応募者が日程調整できます。</p>
        <textarea className="input mono" readOnly rows={3} value={embed} onFocus={(e) => e.target.select()} />
        <CopyButton text={embed} label="埋め込みコードをコピー" />
      </section>

      <section className="section">
        <h2>パラメータ連携</h2>
        <p className="muted small">
          URL の後ろに <code>?name=</code> <code>&amp;email=</code> <code>&amp;company=</code> <code>&amp;q_質問ID=</code> を付けると、入力欄があらかじめ埋まった状態で開きます。それ以外のパラメータ（<code>utm_source</code> など）は予定に保存され、CSV と Webhook に出力されます。
        </p>
        <code className="block-code">{example}</code>
        <ul className="muted small">
          {draft.settings.questions.map((q) => (
            <li key={q.id}>
              {q.label}: <code>{q.system === 'name' ? 'name' : q.system === 'email' ? 'email' : q.system === 'company' ? 'company' : `q_${q.id}`}</code>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
