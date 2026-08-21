import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson, delJson, downloadFile } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import PreviewTable from './PreviewTable.jsx';

/**
 * 점검 템플릿 — 서비스 유형(Linux 서버·웹/TLS·DNS…)별 점검 묶음을 정의하고 대상에 적용한다.
 *
 * 항목 편집 폼의 필드 목록은 **서버 스키마**(`/svcmon/targets/csv-schema`)에서 만든다.
 * 프런트에 필드표를 또 적으면 필드를 추가한 날 화면만 낡는다(서버는 testSchema.js 하나에서
 * 파생하므로 그 표를 그대로 받아 쓰는 것이 유일한 어긋나지 않는 방법이다).
 *
 * 적용은 **미리보기 → 적용** 2단계이고, 기본은 기존 항목을 건드리지 않는 add-only 다.
 * '덮어쓰기'를 켜야 이미 있는 항목을 갱신하며, 그때도 점검 id 는 승계된다(id 가 바뀌면
 * 폴러의 연속 실패 횟수·다음 실행 시각이 리셋되고 수천 항목의 만기가 동시에 터진다).
 */

const KIND_LABEL = { '': '제한 없음', infra: '인프라', service: '서비스' };

/** 그 유형에서 의미를 갖는 필드만 — 서버가 준 usedBy 로 판단한다. */
function fieldsForType(schema, type) {
  if (!schema) return [];
  return schema.test.filter((f) => f.col !== 'test_name' && f.col !== 'type'
    && (!f.usedBy || f.usedBy.includes(type)));
}

/**
 * CSV 컬럼명 → 저장 객체 키. 서버 스키마는 컬럼명만 주므로 화면이 매핑을 안다.
 * 규칙 환산(snake→camel)만으로는 `test_name`→`name`, `test_enabled`→`enabled` 처럼
 * 접두사를 떼는 경우를 맞출 수 없어 표로 둔다. 컬럼이 추가되면 fallback 이 camelCase 로
 * 처리하고, 접두사가 붙은 새 컬럼이라면 여기에 한 줄을 더해야 한다.
 */
const camel = (col) => col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const COL_TO_KEY = {
  test_name: 'name', type: 'type', interval_sec: 'intervalSec', test_enabled: 'enabled',
  port: 'port', url: 'url', keyword: 'keyword', expect_status: 'expectStatus', insecure: 'insecure',
  record: 'record', server: 'server', expect: 'expect', payload: 'payload', send: 'send',
  body: 'body', soap_action: 'soapAction', warn_days: 'warnDays', warn_ms: 'warnMs',
  bad_ms: 'badMs', max_hops: 'maxHops',
};

const EMPTY_TPL = { name: '', desc: '', kind: '', items: [] };
const EMPTY_ITEM = { name: '', type: 'tcp', intervalSec: 300, enabled: true };

export default function TemplateTab({ canEdit, initialApply = null }) {
  const [data, setData] = useState(null);
  const [schema, setSchema] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [sel, setSel] = useState('');
  const [draft, setDraft] = useState(null);          // 편집 중 템플릿(null = 미편집)
  const [itemEdit, setItemEdit] = useState(null);    // { idx, item } · idx<0 = 신규
  const [applyCfg, setApplyCfg] = useState(null);    // { kind, path, includeSub, overwrite }
  const [csvOpen, setCsvOpen] = useState(false);      // CSV 가져오기 패널
  const [csvText, setCsvText] = useState('');
  const [csvPreview, setCsvPreview] = useState(null);
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState('');

  const load = async () => {
    setErr('');
    try { setData(await fetchJson('/svcmon/templates')); }
    catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // 항목 편집 폼이 쓸 필드표 — 화면 진입 시 1회만 받는다.
    fetchJson('/svcmon/targets/csv-schema').then(setSchema).catch(() => setSchema(null));
  }, []);

  const templates = data?.templates || [];
  const cur = templates.find((t) => t.id === sel) || null;
  const editing = draft;
  const limits = data?.limits || { maxTemplates: 100, maxItems: 50 };
  const substVars = data?.substVars || ['host', 'name', 'path', 'kind'];
  const types = schema?.types || [];

  const itemFields = useMemo(
    () => fieldsForType(schema, itemEdit?.item?.type || 'tcp'),
    [schema, itemEdit?.item?.type],
  );

  if (!data && !err) return <Loading />;

  const startNew = () => { setDraft({ ...EMPTY_TPL }); setSel(''); setPreview(null); setDone(''); };
  const startEdit = (t) => { setDraft(JSON.parse(JSON.stringify(t))); setPreview(null); setDone(''); };

  const save = async () => {
    setBusy('save'); setErr('');
    try {
      const body = { name: draft.name, desc: draft.desc, kind: draft.kind, items: draft.items };
      const r = draft.id ? await putJson(`/svcmon/templates/${draft.id}`, body)
        : await postJson('/svcmon/templates', body);
      if (r.error) { setErr(r.error); return; }
      setDone(draft.id ? '템플릿을 저장했습니다.' : '템플릿을 만들었습니다.');
      setDraft(null);
      await load();
      if (r.template?.id) setSel(r.template.id);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const remove = async (t) => {
    const u = t.usage || {};
    const msg = u.tests
      ? `'${t.name}' 템플릿을 삭제합니다.\n\n이미 적용된 점검 ${u.tests}개(대상 ${u.targets}개)는 그대로 남습니다 — 감시가 끊기지 않습니다.\n계속할까요?`
      : `'${t.name}' 템플릿을 삭제할까요?`;
    if (!window.confirm(msg)) return;
    setBusy('del'); setErr('');
    try {
      const r = await delJson(`/svcmon/templates/${t.id}`);
      if (r.error) { setErr(r.error); return; }
      setDone(`템플릿을 삭제했습니다(남은 점검 ${r.orphanTests}개).`);
      if (sel === t.id) setSel('');
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const duplicate = async (t) => {
    setBusy('dup'); setErr('');
    try {
      const r = await postJson(`/svcmon/templates/${t.id}/duplicate`, {});
      if (r.error) { setErr(r.error); return; }
      await load();
      if (r.template?.id) { setSel(r.template.id); startEdit(r.template); }
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  /* ── CSV ── */
  const csvExport = async () => {
    setErr('');
    try { await downloadFile('/svcmon/templates/export.csv'); }
    catch (e) { setErr(e.message); }
  };
  const csvSample = async () => {
    setErr('');
    try { await downloadFile('/svcmon/templates/sample.csv'); }
    catch (e) { setErr(e.message); }
  };
  const onCsvFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setCsvText(String(r.result || '')); setCsvPreview(null); };
    r.onerror = () => setErr('파일을 읽지 못했습니다.');
    r.readAsText(f, 'utf-8');
  };
  const csvDo = async (mode) => {
    setBusy(`csv-${mode}`); setErr(''); setDone('');
    try {
      const r = await postJson('/svcmon/templates/import', { csv: csvText, mode });
      if (r.error) { setErr(r.error); setCsvPreview(r); return; }
      if (mode === 'preview') { setCsvPreview(r); return; }
      setDone(`템플릿 ${r.summary.create}개 생성 · ${r.summary.skip}개 건너뜀(이미 있는 이름).`);
      setCsvOpen(false); setCsvText(''); setCsvPreview(null);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  /* ── 항목 편집 ── */
  const saveItem = () => {
    const it = itemEdit.item;
    if (!it.name.trim()) { setErr('점검 이름을 입력하세요.'); return; }
    const next = { ...draft, items: [...draft.items] };
    // 빈 문자열은 키를 지운다 — 서버가 기본값을 채우게 하고, 빈 값이 하한으로 굳는 것을 막는다.
    const clean = {};
    for (const [k, v] of Object.entries(it)) {
      if (v === '' || v === undefined || v === null) continue;
      clean[k] = v;
    }
    if (itemEdit.idx < 0) next.items.push(clean); else next.items[itemEdit.idx] = { ...next.items[itemEdit.idx], ...clean };
    setDraft(next); setItemEdit(null); setErr('');
  };
  const delItem = (i) => {
    setDraft({ ...draft, items: draft.items.filter((_, k) => k !== i) });
  };
  const moveItem = (i, dir) => {
    const items = [...draft.items];
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];   // 순서 = 배열 순서 자체(order 필드를 두지 않는다)
    setDraft({ ...draft, items });
  };

  /* ── 적용 ── */
  const doPreview = async () => {
    setBusy('preview'); setErr(''); setDone('');
    try {
      const r = await postJson(`/svcmon/templates/${cur.id}/apply`, {
        mode: 'preview',
        scope: { kind: applyCfg.kind, path: applyCfg.path.trim(), includeSub: applyCfg.includeSub },
        overwrite: applyCfg.overwrite,
      });
      if (r.error) setErr(r.error);
      setPreview(r);
    } catch (e) { setErr(e.message); setPreview(null); } finally { setBusy(''); }
  };
  const doApply = async () => {
    setBusy('apply'); setErr('');
    try {
      const r = await postJson(`/svcmon/templates/${cur.id}/apply`, {
        mode: 'apply',
        scope: { kind: applyCfg.kind, path: applyCfg.path.trim(), includeSub: applyCfg.includeSub },
        overwrite: applyCfg.overwrite,
      });
      if (r.error) { setErr(r.error); setPreview(r); return; }
      setDone(`적용 완료 — 추가 ${r.summary.create} · 갱신 ${r.summary.update} · 건너뜀 ${r.summary.skip}`);
      setPreview(null); setApplyCfg(null);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const canApply = preview && !preview.error && (preview.summary?.error || 0) === 0
    && ((preview.summary?.create || 0) + (preview.summary?.update || 0)) > 0
    && preview.capacity?.verdict !== 'reject';

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}
      {done && <div className="svc-ok">{done}</div>}
      {initialApply && !done && (
        <div className="svc-warn">
          <b>이 폴더에 적용:</b> <code>{initialApply.path || 'Root(전체)'}</code> — 아래 템플릿에서 <b>적용…</b> 을 누르면 경로가 이 폴더로 채워집니다.
          하위 폴더 포함 여부를 정하고 미리보기 후 적용하세요.
        </div>
      )}

      <div className="card" style={{ padding: 14 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>점검 템플릿 ({templates.length} / {limits.maxTemplates})</b>
          <div className="flex gap">
            <button className="tab" onClick={csvExport}>⤓ CSV 내보내기</button>
            <button className="tab" onClick={csvSample}>⤓ 샘플 CSV</button>
            {canEdit && <button className="tab" onClick={() => { setCsvOpen((v) => !v); setCsvPreview(null); }}>⤒ CSV 가져오기</button>}
            {canEdit && !editing && <button className="login-btn" onClick={startNew}>+ 새 템플릿</button>}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          서버 유형별로 점검 묶음을 정해 두고 대상에 한꺼번에 적용합니다. 기본 제공 6종은 IANA
          표준 포트로 값이 정해지는 것만 담았습니다 — 앱 포트(8080)·헬스 경로·DB 리스너처럼
          조직마다 다른 값은 복제해서 채우세요.
        </div>

        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <table>
            <thead>
              <tr>
                <th>이름</th><th style={{ width: 84 }}>구분</th><th style={{ width: 58, textAlign: 'right' }}>항목</th>
                <th style={{ width: 54, textAlign: 'right' }}>rev</th><th style={{ width: 120 }}>적용됨</th>
                <th style={{ width: 150 }}>수정</th><th style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 && <tr><td colSpan={7} className="center muted" style={{ padding: 24 }}>템플릿이 없습니다.</td></tr>}
              {templates.map((t) => (
                <tr key={t.id} className={sel === t.id ? 'row-sel' : ''} onClick={() => setSel(t.id)}>
                  <td>
                    <b>{t.name}</b>
                    {t.builtin && <span className="badge gray" style={{ marginLeft: 6 }}>기본</span>}
                    {(t.items || []).some((x) => x.insecure) && <span className="badge amber" style={{ marginLeft: 6 }}>TLS 검증 해제 포함</span>}
                    {t.desc && <div className="muted" style={{ fontSize: 11 }}>{t.desc}</div>}
                  </td>
                  <td>{KIND_LABEL[t.kind ?? ''] || t.kind}</td>
                  <td style={{ textAlign: 'right' }}>{(t.items || []).length}</td>
                  <td style={{ textAlign: 'right' }}>{t.rev}</td>
                  <td className="muted">{t.usage ? `대상 ${t.usage.targets} · 점검 ${t.usage.tests}` : '—'}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {t.updatedAt ? new Date(t.updatedAt).toLocaleString('ko-KR', { hour12: false }) : '—'}
                    {t.updatedBy ? <div>{t.updatedBy}</div> : null}
                  </td>
                  <td>
                    {canEdit && (
                      <div className="flex gap" onClick={(e) => e.stopPropagation()}>
                        <button className="tab" onClick={() => { setSel(t.id); setApplyCfg({ kind: initialApply?.kind || t.kind || 'infra', path: initialApply?.path || '', includeSub: initialApply?.includeSub ?? true, overwrite: false }); setPreview(null); }}>적용…</button>
                        <button className="tab" onClick={() => { setSel(t.id); startEdit(t); }}>편집</button>
                        <button className="tab" disabled={busy === 'dup'} onClick={() => duplicate(t)}>복제</button>
                        <button className="tab" disabled={busy === 'del'} onClick={() => remove(t)}>삭제</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {csvOpen && (
        <div className="card" style={{ padding: 14 }}>
          <b>템플릿 CSV 가져오기</b>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            항목 1건이 1행이며 같은 template_name 행들이 한 템플릿으로 묶입니다. <b>이미 있는
            이름의 템플릿은 건너뜁니다</b>(덮어쓰지 않습니다). 미리보기는 파싱 수준 검증이라
            치환 변수·상한 검증은 등록 시점에 실패할 수 있습니다.
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center' }}>
            <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={onCsvFile} />
            <button className="login-btn" disabled={!csvText.trim() || busy === 'csv-preview'} onClick={() => csvDo('preview')}>
              {busy === 'csv-preview' ? '검사 중…' : '미리보기'}
            </button>
            {csvPreview && !csvPreview.error && (csvPreview.summary?.create || 0) > 0 && (
              <button className="login-btn" disabled={busy === 'csv-add'} onClick={() => csvDo('add')}>
                {busy === 'csv-add' ? '등록 중…' : `${csvPreview.summary.create}개 등록`}
              </button>
            )}
            <button className="tab" onClick={() => { setCsvOpen(false); setCsvText(''); setCsvPreview(null); }}>닫기</button>
          </div>
          {csvPreview && (
            <div style={{ marginTop: 8 }}>
              <div className="flex gap wrap" style={{ fontSize: 12 }}>
                <span className="badge green">생성 {csvPreview.summary?.create || 0}</span>
                <span className="badge gray">건너뜀 {csvPreview.summary?.skip || 0}</span>
                {(csvPreview.summary?.error || 0) > 0 && <span className="badge red">오류 {csvPreview.summary.error}</span>}
                {(csvPreview.unknownColumns || []).length > 0 && (
                  <span className="muted">무시된 컬럼: {csvPreview.unknownColumns.join(', ')}</span>
                )}
              </div>
              {(csvPreview.errors || []).length > 0 && (
                <div className="svc-err" style={{ marginTop: 6 }}>
                  <ul>{csvPreview.errors.slice(0, 30).map((e, i) => (
                    <li key={i}>{e.row ? `${e.row}행` : ''}{e.name ? ` · ${e.name}` : ''} — {e.reason}</li>
                  ))}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 템플릿 편집 ── */}
      {editing && (
        <div className="card" style={{ padding: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 10 }}>
            <b>{draft.id ? `템플릿 편집 — ${draft.name || '(이름 없음)'}` : '새 템플릿'}</b>
            <div className="flex gap">
              <button className="tab" onClick={() => { setDraft(null); setErr(''); }}>취소</button>
              <button className="login-btn" disabled={busy === 'save'} onClick={save}>{busy === 'save' ? '저장 중…' : '저장'}</button>
            </div>
          </div>

          <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
            <label className="flex col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>이름 (60자)</span>
              <input className="input" style={{ minWidth: 220 }} value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="예: SBP 워커노드" />
            </label>
            <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 260 }}>
              <span className="muted" style={{ fontSize: 11 }}>설명 (300자)</span>
              <input className="input" value={draft.desc || ''}
                onChange={(e) => setDraft({ ...draft, desc: e.target.value })} placeholder="어떤 서버에 쓰는 템플릿인지" />
            </label>
            <label className="flex col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>대상 구분</span>
              <select className="select" value={draft.kind || ''} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
                <option value="">제한 없음</option>
                <option value="infra">인프라</option>
                <option value="service">서비스</option>
              </select>
            </label>
          </div>

          <div className="flex between wrap gap" style={{ alignItems: 'center', margin: '14px 0 6px' }}>
            <b style={{ fontSize: 13 }}>점검 항목 ({draft.items.length} / {limits.maxItems})</b>
            <button className="tab" disabled={draft.items.length >= limits.maxItems}
              onClick={() => setItemEdit({ idx: -1, item: { ...EMPTY_ITEM } })}>+ 항목 추가</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            표시 순서 = 목록 순서입니다(정렬용 숫자를 따로 두지 않습니다). 치환 변수{' '}
            {substVars.map((v) => <code key={v} style={{ marginRight: 4 }}>{`{${v}}`}</code>)}
            를 문자 필드에 쓸 수 있고, 대소문자를 구분합니다.
          </div>

          <div className="table-wrap" style={{ maxHeight: '36vh' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th><th>이름</th><th style={{ width: 70 }}>유형</th>
                  <th style={{ width: 70 }}>포트</th><th style={{ width: 80, textAlign: 'right' }}>주기(초)</th>
                  <th style={{ width: 60 }}>사용</th><th>세부</th><th style={{ width: 160 }} />
                </tr>
              </thead>
              <tbody>
                {draft.items.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 20 }}>항목이 없습니다. '+ 항목 추가' 를 누르세요.</td></tr>}
                {draft.items.map((it, i) => (
                  <tr key={it.key || i}>
                    <td className="muted">{i + 1}</td>
                    <td>{it.name}</td>
                    <td><code>{it.type}</code></td>
                    <td>{it.port || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{it.intervalSec || 60}</td>
                    <td>{it.enabled === false ? '중지' : '사용'}</td>
                    <td className="muted" style={{ fontSize: 11 }}>
                      {[it.url, it.record && `record=${it.record}`, it.server && `server=${it.server}`,
                        it.keyword && `포함="${it.keyword}"`, it.expectStatus && `상태=${it.expectStatus}`,
                        it.warnDays && `D-${it.warnDays}`, it.warnMs && `warn ${it.warnMs}ms`,
                        it.badMs && `bad ${it.badMs}ms`, it.maxHops && `홉 ${it.maxHops}`,
                        it.send && `send="${it.send}"`, it.insecure && 'TLS 검증 해제',
                      ].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td>
                      <div className="flex gap">
                        <button className="tab" onClick={() => moveItem(i, -1)} disabled={i === 0}>↑</button>
                        <button className="tab" onClick={() => moveItem(i, 1)} disabled={i === draft.items.length - 1}>↓</button>
                        <button className="tab" onClick={() => setItemEdit({ idx: i, item: { ...it } })}>편집</button>
                        <button className="tab" onClick={() => delItem(i)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 항목 편집 모달 (필드는 서버 스키마에서 생성) ── */}
      {itemEdit && (
        <div className="modal-overlay" onClick={() => setItemEdit(null)}>
          <EscClose onClose={() => setItemEdit(null)} />
          <div className="card" style={{ width: 'min(720px, 95vw)', maxHeight: '86vh', overflow: 'auto', padding: 16 }}
            onClick={(e) => e.stopPropagation()}>
            <b>{itemEdit.idx < 0 ? '점검 항목 추가' : '점검 항목 편집'}</b>

            <div className="flex gap wrap" style={{ margin: '12px 0', alignItems: 'flex-end' }}>
              <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 200 }}>
                <span className="muted" style={{ fontSize: 11 }}>점검 이름 (80자) — 치환 변수 사용 가능</span>
                <input className="input" value={itemEdit.item.name}
                  onChange={(e) => setItemEdit({ ...itemEdit, item: { ...itemEdit.item, name: e.target.value } })}
                  placeholder="예: 워커 API" />
              </label>
              <label className="flex col" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 11 }}>유형</span>
                <select className="select" value={itemEdit.item.type}
                  onChange={(e) => setItemEdit({ ...itemEdit, item: { ...itemEdit.item, type: e.target.value } })}>
                  {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="flex col" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 11 }}>사용</span>
                <select className="select" value={itemEdit.item.enabled === false ? '0' : '1'}
                  onChange={(e) => setItemEdit({ ...itemEdit, item: { ...itemEdit.item, enabled: e.target.value === '1' } })}>
                  <option value="1">사용</option><option value="0">중지</option>
                </select>
              </label>
            </div>

            <div className="svc-fields">
              {itemFields.map((f) => {
                const key = COL_TO_KEY[f.col] || camel(f.col);
                const val = itemEdit.item[key];
                const set = (v) => setItemEdit({ ...itemEdit, item: { ...itemEdit.item, [key]: v } });
                const need = f.requiredFor?.includes(itemEdit.item.type);
                return (
                  <label key={f.col} className="flex col" style={{ gap: 4 }}>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {f.label}{need && <span className="badge red" style={{ marginLeft: 4 }}>필수</span>}
                    </span>
                    {f.kind === 'bool' ? (
                      <select className="select" value={val ? '1' : '0'} onChange={(e) => set(e.target.value === '1')}>
                        <option value="0">아니오</option><option value="1">예</option>
                      </select>
                    ) : (
                      <input className="input" value={val ?? ''} onChange={(e) => set(e.target.value)}
                        placeholder={f.kind === 'int' ? `${f.min}~${f.max}${f.dflt ? ` (기본 ${f.dflt})` : ' (비우면 미지정)'}`
                          : f.kind === 'port' ? '비우면 유형 기본 포트' : ''} />
                    )}
                  </label>
                );
              })}
            </div>

            <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
              치환 변수:{' '}
              {substVars.map((v) => (
                <code key={v} style={{ marginRight: 6 }}>{`{${v}}`}</code>
              ))}
              — 적용할 때 대상의 값으로 바뀝니다. 예: <code>{'https://{host}/health'}</code> →
              <code> https://10.20.30.41/health</code>. 치환되지 않은 변수가 남으면 그 항목은
              오류가 되고 생성되지 않습니다(런타임에 조용히 실패하는 것을 막습니다).
            </div>

            <div className="flex gap" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="tab" onClick={() => setItemEdit(null)}>취소</button>
              <button className="login-btn" onClick={saveItem}>확인</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 적용 ── */}
      {applyCfg && cur && (
        <div className="card" style={{ padding: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
            <b>템플릿 적용 — {cur.name} <span className="muted" style={{ fontWeight: 400 }}>(항목 {(cur.items || []).length}개)</span></b>
            <button className="tab" onClick={() => { setApplyCfg(null); setPreview(null); }}>닫기</button>
          </div>

          <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
            <label className="flex col" style={{ gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>대상 구분</span>
              <select className="select" value={applyCfg.kind} onChange={(e) => { setApplyCfg({ ...applyCfg, kind: e.target.value }); setPreview(null); }}>
                <option value="infra">인프라</option><option value="service">서비스</option>
              </select>
            </label>
            <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 240 }}>
              <span className="muted" style={{ fontSize: 11 }}>경로 (비우면 그 구분의 전체)</span>
              <input className="input" value={applyCfg.path}
                onChange={(e) => { setApplyCfg({ ...applyCfg, path: e.target.value }); setPreview(null); }}
                placeholder="예: A.Infra\OC2\워커노드" />
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={applyCfg.includeSub}
                onChange={(e) => { setApplyCfg({ ...applyCfg, includeSub: e.target.checked }); setPreview(null); }} />
              하위 폴더 포함
            </label>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={applyCfg.overwrite}
                onChange={(e) => { setApplyCfg({ ...applyCfg, overwrite: e.target.checked }); setPreview(null); }} />
              이미 있는 항목도 덮어쓰기
            </label>
            <button className="login-btn" disabled={busy === 'preview'} onClick={doPreview}>
              {busy === 'preview' ? '검사 중…' : '미리보기'}
            </button>
            {preview && (
              <button className="login-btn" disabled={!canApply || busy === 'apply'} onClick={doApply}>
                {busy === 'apply' ? '적용 중…' : '적용'}
              </button>
            )}
          </div>

          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            기본은 <b>이미 있는 항목을 건드리지 않습니다</b> — 대상에서 임계값을 조정해 둔 것이
            되돌아가지 않게 하려는 것입니다. '덮어쓰기'를 켜면 갱신하되 점검 id 는 승계하므로
            연속 실패 횟수와 다음 실행 시각이 유지됩니다. 템플릿에서 지운 항목은 대상에 그대로
            남습니다(감시를 임의로 끊지 않습니다).
          </div>

          {preview?.kindMismatch > 0 && (
            <div className="svc-warn">
              대상 구분이 템플릿의 권장 구분과 다른 대상 {preview.kindMismatch}개가 있습니다(적용은 됩니다).
            </div>
          )}
        </div>
      )}

      {preview && <PreviewTable result={preview} title="적용 미리보기" />}
    </div>
  );
}
