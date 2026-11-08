/**
 * 다음 점검 ①(2차 · 사용자 결정 2026-11-08 "겹치는 노드의 IP · hostname · service tag 등을 수집해서 사용자가 추가할지 여부를 결정")
 * ‘식별 키가 겹치는 서버’ — 분류가 먼저 잡힌 한 대만 두고 남긴 서버 목록 · 서버마다 ‘수집에 추가’ / ‘제외 유지’ / ‘되돌리기’.
 * ⚠ 조회는 열 때 1회 + ‘다시 읽기’(폴링 없음) · 쓰기는 운영자 이상 + 그 법인 쓰기 범위(서버가 다시 막는다 — 404 → 403) · 주소는 관리자 판본만(서버가 비관리자에게 싣지 않는다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, delJson, hasRole } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import Select from '../../components/Select.jsx';
import { toneVar } from './toneVar.js';
import { readPageSize } from './bmMissingView.js';
import { OVERLAP_STATUS_TEXT, statusOf, sourceText, peerText, KEY_OVERLAP_HONEST, overlapView, overlapCorps } from './bmKeyOverlapText.js';

export function KeyOverlapTable({ rows = [], canWrite = false, busy = '', onDecide, onClear, showAddr = false }) {
  // 1440 판독(2차): 처음 판은 열 8개 · 법인 칸에 ‘이름(id)’ 를 한 줄로 실어 결정 열이 오른쪽에서 잘렸다 — 출처는 서버 칸 아래 줄로 · 법인 id 는 아래 줄로 · 버튼은 세로로.
  return (
    <STable minWidth={showAddr ? 860 : 760} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>서버 · 출처</th><th>법인</th><th>서비스 태그(원문)</th>{showAddr && <th>주소(iDRAC · OS)</th>}<th>겹친 상대(수집 중)</th><th>상태</th><th data-nosort style={{ width: 112 }}>결정</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const st = statusOf(r);
          const sv = OVERLAP_STATUS_TEXT[st];
          const can = canWrite && r.writable && !busy;
          return (
            <tr key={r.oid}>
              <td data-sort={r.name} className="bmo-name" style={{ overflowWrap: 'anywhere' }}>{r.name || r.key}<div className="bmo-sub">{r.serverId}{r.role === 'virt' ? ' · 가상화 호스트' : ''}</div><div className="bmo-sub">{sourceText(r.source)}</div></td>
              <td data-sort={r.vcenterId} style={{ overflowWrap: 'anywhere' }}>{r.vcName || r.vcenterId || '귀속 없음'}{r.vcName && r.vcName !== r.vcenterId ? <div className="bmo-sub">{r.vcenterId}</div> : null}</td>
              <td data-sort={r.serviceTag} style={{ overflowWrap: 'anywhere' }}>{r.serviceTag || '—'}<div className="bmo-sub">키 {r.key}</div></td>
              {showAddr && <td data-sort={r.idracHost || r.osHost || ''} style={{ overflowWrap: 'anywhere' }}>{r.idracHost || '—'}{r.osHost ? <div className="bmo-sub">OS {r.osHost}</div> : null}</td>}
              <td data-sort={r.dupOf?.name || ''} className="bmo-wrap">{peerText(r)}</td>
              <td data-sort={st} style={{ overflowWrap: 'anywhere' }}><span style={{ color: toneVar(sv.tone) }}>{sv.label}</span>
                {st === 'add' && <div className="bmo-sub">키 {r.decision?.key}{r.collecting ? ' · 수집 대상' : ' · 아직 대상 아님(경로 · 법인 확인)'}</div>}
                {r.decision?.by ? <div className="bmo-sub">{r.decision.by}</div> : null}</td>
              <td data-nosort>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                  {st !== 'add' && <button type="button" className="btn btn-sm bmp-touch" disabled={!can} title={`별도 키 ${r.decidedKey} 로 수집`} onClick={() => onDecide?.(r, 'add')}>수집에 추가</button>}
                  {st === 'pending' && <button type="button" className="btn btn-sm bmp-touch" disabled={!can} onClick={() => onDecide?.(r, 'exclude')}>제외 유지</button>}
                  {st !== 'pending' && <button type="button" className="btn btn-sm bmp-touch" disabled={!can} onClick={() => onClear?.(r)}>되돌리기</button>}
                </span>
                {canWrite && r.writable === false && <div className="bmo-sub">쓰기 권한 없음(조회 전용 법인)</div>}
              </td>
            </tr>
          );
        })}
        {!rows.length && <tr><td colSpan={showAddr ? 7 : 6} className="bmo-sub">겹치는 서버가 없습니다.</td></tr>}
      </tbody>
    </STable>
  );
}

export default function BmKeyOverlaps() {
  const canWrite = hasRole('admin', 'operator');
  const [st, setSt] = useState({ resp: null, err: null, loading: false });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [corp, setCorp] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setSt((p) => ({ ...p, loading: true, err: null }));
    try { const r = await fetchJson('/tools/bm-usage/key-overlaps', {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setSt({ resp: r, err: null, loading: false }); }
    catch (e) { if (g === gen.current) setSt({ resp: null, err: e, loading: false }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q, corp, status]);
  async function decide(r, decision) {
    setBusy(r.oid); setMsg(null);
    try {
      const res = await postJson('/tools/bm-usage/key-overlaps/decision', { oid: r.oid, decision }, { timeoutMs: 60_000 });
      setMsg(res?.ok === false ? { tone: 'bad', text: res.reason || '저장하지 못했습니다.' } : { tone: 'ok', text: `${r.name || r.key} — ${decision === 'add' ? `별도 키 ‘${res?.key || r.decidedKey}’ 로 다음 주기부터 수집합니다` : '제외 유지로 기록했습니다'}(감사 기록).` });
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusy(''); }
  }
  async function clear(r) {
    setBusy(r.oid); setMsg(null);
    try {
      const res = await delJson(`/tools/bm-usage/key-overlaps/decision?oid=${encodeURIComponent(r.oid)}`);
      setMsg(res?.ok === false ? { tone: 'bad', text: res.reason || '되돌리지 못했습니다.' } : { tone: 'ok', text: `${r.name || r.key} — 결정을 지웠습니다(다음 주기부터 수집 안 함 · 쌓인 값은 그대로).` });
      await load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusy(''); }
  }
  const rows = st.resp?.items || [];
  const view = overlapView(rows, { q, corp, status, page, pageSize: readPageSize() });
  const corps = overlapCorps(rows);
  const c = st.resp?.counts || {};
  return (
    <section className="bmob-sec" aria-label="식별 키가 겹치는 서버" style={{ marginTop: 14 }}>
      <h4 style={{ margin: '0 0 6px' }}>식별 키가 겹치는 서버</h4>
      <p className="bmo-note"><BoldText text={KEY_OVERLAP_HONEST} /></p>
      {st.err && <ErrorBox error={st.err} />}
      {st.loading && !st.resp && <p className="bmo-note">읽는 중…</p>}
      {st.resp && (
        <>
          <div className="bmob-filters" role="search" aria-label="겹치는 서버 필터" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="bmo-sub">전체 {c.total ?? 0}대 · 결정 전 {c.pending ?? 0} · 추가 {c.added ?? 0} · 제외 유지 {c.excluded ?? 0}</span>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름 · 서비스 태그 · 주소 · id" aria-label="검색" maxLength={200} />
            <Select className="select" value={corp} onChange={(e) => setCorp(e.target.value)} aria-label="법인">
              <option value="">법인 전체</option>
              {corps.map((o) => <option key={o.value} value={o.value}>{o.value || '귀속 없음'} ({o.n})</option>)}
            </Select>
            <Select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="상태">
              <option value="">상태 전체</option>
              {Object.entries(OVERLAP_STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
            <button className="btn btn-sm" type="button" onClick={load} disabled={st.loading}>{st.loading ? '읽는 중…' : '다시 읽기'}</button>
          </div>
          {msg && <p className="bmo-note" role="status" style={{ color: toneVar(msg.tone) }}>{msg.text}</p>}
          {st.resp.addressHidden && <p className="bmo-note">주소(iDRAC · OS)는 관리자에게만 보입니다 — 이름 · 서비스태그 · 겹친 상대로 고르세요.</p>}
          <KeyOverlapTable rows={view.rows} canWrite={canWrite} busy={busy} onDecide={decide} onClear={clear} showAddr={!st.resp.addressHidden} />
          {view.pages > 1 && (
            <div className="bmob-pager" aria-label="쪽 이동" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span className="bmo-sub">{view.from}–{view.to} / {view.matched}대</span>
              <button className="btn btn-sm" type="button" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>이전</button>
              <span className="bmo-sub">{view.page} / {view.pages}쪽</span>
              <button className="btn btn-sm" type="button" disabled={view.page >= view.pages} onClick={() => setPage(view.page + 1)}>다음</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
