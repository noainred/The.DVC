/**
 * WikiMacros — 위키 포탈 매크로 그리기(v2.886 · C-5). 해석은 macro.js · markdown.js, 그리기만 여기서.
 *  · 값은 문서를 열 때 API 로 읽는다(저장된 글이 아니다) — 서버가 보는 사람의 범위 · 권한으로 거른다. 못 읽으면 사유를 보인다(빈 표로 숨기지 않는다).
 *  · {{include}} 는 한 단계만 — 포함된 문서 안의 매크로 · 포함은 그리지 않는다(MdView 에 renderMacro 를 넘기지 않는다 — 재귀 차단).
 *  · 폴링하지 않는다(문서를 열 때 1회 · ‘다시 읽기’).
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, toolAllowed } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import { MdView } from './MdView.jsx';
import { issuesMacroArgs, includeTarget } from './macro.js';
import { wikiHash, timeText } from './wikiText.js';
import { statusText, priorityText, dateText } from '../issues/issueText.js';

function useMacroData(load, deps) {
  const [st, setSt] = useState({ data: null, err: null, at: 0 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setSt((s) => ({ ...s, err: null }));
    load().then((data) => { if (alive) setSt({ data, err: null, at: Date.now() }); }).catch((err) => { if (alive) setSt({ data: null, err, at: Date.now() }); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [st, () => setTick((n) => n + 1)];
}
const errText = (e) => (e?.status === 403 ? '권한이 없어 볼 수 없습니다(범위 · 역할)' : e?.status === 404 ? '없거나 볼 수 없습니다' : String(e?.message || e || '읽지 못했습니다'));

function Frame({ title, at, onReload, children }) {
  return (
    <div className="md-macro">
      <div className="md-macro-head"><b>{title}</b><span className="muted">{at ? `${timeText(at)} 기준` : '읽는 중…'}</span><button type="button" className="md-linkbtn" onClick={onReload}>다시 읽기</button></div>
      {children}
    </div>
  );
}

function IssuesMacro({ args }) {
  const { query, limit } = issuesMacroArgs(args);
  const [st, reload] = useMacroData(() => fetchJson('/issues', { query, limit, done: 'all' }, undefined, { retries: 0 }), [query, limit]);
  return (
    <Frame title={`이슈 — ${query}`} at={st.at} onReload={reload}>
      {st.err ? <div className="muted">{st.err?.status === 400 ? `검색식을 읽지 못했습니다 — ${st.err.message}` : errText(st.err)}</div>
        : !st.data ? null
        : st.data.rows.length === 0 ? <div className="muted">맞는 이슈가 없습니다.</div>
        : (
          <>
            <STable className="tbl">
              <thead><tr><th>키</th><th>제목</th><th>상태</th><th>담당자</th><th>기한</th></tr></thead>
              <tbody>
                {st.data.rows.map((r) => (
                  <tr key={r.key}>
                    <td data-sort={r.num}><a href={`#/issues/list/${r.key}`} className="md-iss">{r.key}</a></td>
                    <td><span className={`md-macro-prio p-${r.priority}`} title={priorityText(r.priority)}>{priorityText(r.priority)}</span> {r.title}</td><td>{statusText(r.status)}</td>
                    <td>{r.assignee || '—'}</td><td data-sort={r.dueAt ?? ''}>{r.dueAt ? dateText(r.dueAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
            {st.data.total > st.data.rows.length && <div className="muted md-macro-foot">{st.data.total}건 중 {st.data.rows.length}건(limit={limit}) — <a href="#/issues/filters">필터 화면에서 전부 보기</a></div>}
          </>
        )}
    </Frame>
  );
}

function IncludeMacro({ args, pages, spaceId }) {
  const id = includeTarget(args);
  const [st, reload] = useMacroData(() => (id ? fetchJson(`/wiki/pages/${id}`, { nv: '1' }) : Promise.reject(Object.assign(new Error('문서 번호(W12)가 없습니다'), { status: 0 }))), [id]);
  const p = st.data?.page;
  return (
    <Frame title={p ? <>포함: <a href={wikiHash({ space: p.spaceId, id: p.id })}>{p.title}</a> <span className="muted">v{p.version}</span></> : `포함: ${id || '?'}`} at={st.at} onReload={reload}>
      {st.err ? <div className="muted">{errText(st.err)}</div>
        : p ? <MdView md={p.body} idPrefix={`inc${p.id}`} pages={pages} spaceId={spaceId} compact dropTitle={p.title} /> : null}
    </Frame>
  );
}

const pctText = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
function VcentersMacro() {
  const [st, reload] = useMacroData(() => fetchJson('/vcenters'), []);
  const rows = Array.isArray(st.data) ? st.data : [];
  return (
    <Frame title="법인(vCenter) 상태" at={st.at} onReload={reload}>
      {st.err ? <div className="muted">{errText(st.err)}</div> : !st.data ? null : rows.length === 0 ? <div className="muted">볼 수 있는 vCenter 가 없습니다.</div> : (
        <STable className="tbl">
          <thead><tr><th>vCenter</th><th>상태</th><th>호스트 · VM(켜짐)</th><th title="CPU · 메모리 · 스토리지 사용률">CPU · 메모리 · DS</th></tr></thead>
          <tbody>
            {rows.map((v) => {
              const m = v.metrics || {};
              return (
                <tr key={v.id}>
                  <td>{v.name || v.id}</td><td>{v.status || '—'}</td>
                  <td data-sort={m.hosts ?? ''}>{m.hosts ?? '—'} · {m.vms != null ? `${m.vms}(${m.vmsPoweredOn ?? '—'})` : '—'}</td>
                  <td data-sort={m.cpuUsagePct ?? ''}>{pctText(m.cpuUsagePct)} · {pctText(m.memUsagePct)} · {pctText(m.storageUsagePct)}</td>
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
    </Frame>
  );
}

function PartFaultsMacro() {
  // 도구 키 'part-faults' 가 막힌 계정은 부르지 않는다(audit2613a — 소유 화면 밖에서 도구 API 를 부를 때의 접근 가드). 서버도 도구 권한 · 전체 범위로 막는다.
  const allowed = toolAllowed('part-faults');
  const [st, reload] = useMacroData(() => (allowed ? fetchJson('/tools/part-faults') : Promise.reject(Object.assign(new Error('도구 권한 없음'), { status: 403 }))), [allowed]);
  const d = st.data;
  return (
    <Frame title="열린 파트 장애" at={st.at} onReload={reload}>
      {st.err ? <div className="muted">{st.err?.status === 403 ? '파트 장애는 도구 권한이 있는 전체 범위 계정만 봅니다.' : errText(st.err)}</div> : !d ? null : (
        <div className="md-macro-kpi">
          <span>장애 <b>{d.summary?.fault ?? '—'}</b></span><span>경고 <b>{d.summary?.warn ?? '—'}</b></span><span>장비 <b>{d.summary?.devices ?? '—'}</b></span>
          <a href="#/tools/part-faults">파트 장애 화면 →</a>
        </div>
      )}
    </Frame>
  );
}

/** MdView renderMacro 로 넘길 함수 — 문서 보기에서만. */
export function makeRenderMacro({ pages = [], spaceId = '' } = {}) {
  return (b) => {
    switch (b.name) {
      case 'issues': return <IssuesMacro args={b.args} />;
      case 'include': return <IncludeMacro args={b.args} pages={pages} spaceId={spaceId} />;
      case 'vcenters': return <VcentersMacro />;
      case 'partfaults': return <PartFaultsMacro />;
      default: return null;
    }
  };
}
