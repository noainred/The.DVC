import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import PreviewTable from './PreviewTable.jsx';

/**
 * 대량 자동등록 — 줄마다 {엣지·호스트네임·IP} 를 직접 입력해 대상을 한꺼번에 만든다.
 *
 * 흐름: ① 위치 → ② 등록할 대상 입력(개수 지정 → 표 또는 자유형식 → 검증) → ③ 점검 템플릿
 *       → 미리보기 → 등록. 등록 후 대상별 엣지로 배정을 원클릭 동기화할 수 있다.
 *
 * 백엔드는 `/svcmon/targets/import`(format:'json') 를 쓴다 — 이름을 `{n}` 패턴으로 만들지 않고
 * 줄별 임의 호스트명을 그대로 등록하기 위해서다. 템플릿은 서버가 대상별로 실체화(치환)한다.
 *
 * 설계 불변조건(유지할 것):
 * 1) **전부 성공 또는 전부 취소(all-or-nothing)** — 오류 1건이면 0건 등록. 서버가 강제하고 미리보기가 노출.
 * 2) **기본이 '중지' 등록** — 잘못된 주소로 실트래픽이 나가지 않게, 확인 후 켜게 한다.
 * 3) **엣지는 후보 목록(candidates)에서만** — 대소문자 1글자 오타가 영구 무음 감시 공백이 된다.
 * 4) 대상에 엣지가 박히면 '그 엣지 전용'이다(배정 동기화 = PUT /assign/:agent {byAgent:true}).
 */

// 표로 그리는 최대 줄 수 — 이보다 많으면 자유형식/CSV 를 안내한다(수천 input 은 무겁다).
const TABLE_CAP = 500;
const MAX_COUNT = 2000;   // 서버 maxBulkRows 와 정렬.

/** IPv4/IPv6/호스트명 형식 검사 — 서버(nonCanonicalIp·SAFE_HOST)와 같은 취지. 빈값/오류면 메시지, OK 면 ''. */
function ipMsg(v) {
  const s = String(v || '').trim();
  if (!s) return 'IP를 입력하세요';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {           // IPv4 모양
    const parts = s.split('.');
    if (parts.some((p) => p.length > 1 && p[0] === '0')) return 'IPv4 형식 오류(선행 0)';
    if (parts.some((p) => Number(p) > 255)) return 'IPv4 형식 오류(0~255)';
    return '';
  }
  if (s.includes(':')) return /^[0-9a-fA-F:]+$/.test(s) ? '' : 'IPv6 형식 오류';
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) return '호스트/IP 형식 오류';   // 그 외는 호스트명 허용(서버 host 필드)
  return '';
}

const EMPTY_ROW = () => ({ edge: '', hostname: '', ip: '' });

/** 자유형식 텍스트 → 줄 배열. 한 줄에 "엣지, 호스트네임, IP"(쉼표/공백/탭 구분). '#' 은 주석. */
function parseFree(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    out.push({ edge: parts[0] || '', hostname: parts[1] || '', ip: parts[2] || '' });
  }
  return out;
}

export default function BulkTab({ canEdit, prefill }) {
  const [kind, setKind] = useState(prefill?.kind === 'service' ? 'service' : 'infra');
  const [path, setPath] = useState(prefill?.path || '');
  const [count, setCount] = useState(3);
  const [inputMode, setInputMode] = useState('table');   // 'table' | 'free'
  const [rows, setRows] = useState(() => [EMPTY_ROW(), EMPTY_ROW(), EMPTY_ROW()]);
  const [freeText, setFreeText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [enabled, setEnabled] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [edges, setEdges] = useState([]);           // 배정 후보 엣지 [{agent,...}]
  const [folders, setFolders] = useState([]);
  const [showFolders, setShowFolders] = useState(false);
  const [validation, setValidation] = useState(null);   // { rows:[{edge,ip,name}], okCount, edgeBad, ipBad, edgeMissing, dupNames }
  const [preview, setPreview] = useState(null);
  const [batches, setBatches] = useState([]);
  const [syncedEdges, setSyncedEdges] = useState([]);   // 등록 후 배정 동기화 대상
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  const loadBatches = async () => { try { const r = await fetchJson('/svcmon/batches'); setBatches(r.batches || []); } catch { /* 비치명 */ } };
  const loadFolders = async () => { try { const r = await fetchJson('/svcmon/state?limit=1'); setFolders(r.folders || []); } catch { setFolders([]); } };
  const loadEdges = async () => { try { const r = await fetchJson('/svcmon/assign'); setEdges(r.candidates || []); } catch { setEdges([]); } };
  useEffect(() => {
    fetchJson('/svcmon/templates').then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([]));
    loadBatches(); loadFolders(); loadEdges();
  }, []);

  const edgeSet = useMemo(() => new Set(edges.map((e) => e.agent)), [edges]);
  const tpl = templates.find((t) => t.id === templateId) || null;
  const itemCount = tpl ? (tpl.items || []).length : 0;

  // 표 모드: 개수 변경 시 줄 수를 맞춘다(기존 입력 보존, 늘리면 빈 줄 추가·줄이면 뒤에서 자름).
  const setCountAndRows = (n) => {
    const c = Math.max(1, Math.min(MAX_COUNT, Number(n) || 0));
    setCount(c);
    if (c <= TABLE_CAP) {
      setRows((cur) => {
        const next = cur.slice(0, c);
        while (next.length < c) next.push(EMPTY_ROW());
        return next;
      });
    }
    setValidation(null); setPreview(null);
  };
  const setRow = (i, patch) => { setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r))); setValidation(null); setPreview(null); };
  const addRow = () => { setRows((cur) => [...cur, EMPTY_ROW()]); setCount((c) => c + 1); setValidation(null); setPreview(null); };
  const removeEmpty = () => {
    setRows((cur) => { const kept = cur.filter((r) => r.edge || r.hostname || r.ip); const next = kept.length ? kept : [EMPTY_ROW()]; setCount(next.length); return next; });
    setValidation(null); setPreview(null);
  };

  // 현재 입력을 줄 배열로 — 표 모드는 rows, 자유형식은 파싱.
  const effectiveRows = () => (inputMode === 'free' ? parseFree(freeText) : rows);

  // ── 검증: 엣지 존재(candidates) + IP 형식 + 호스트명 + 이름 중복 ──
  const validate = () => {
    const rs = effectiveRows().map((r) => ({ edge: (r.edge || '').trim(), hostname: (r.hostname || '').trim(), ip: (r.ip || '').trim() }));
    const seen = new Map();     // hostname(lower) → 첫 등장 행
    const detail = rs.map((r, i) => {
      const msgs = [];
      let edgeLevel = 'ok';
      if (!r.hostname) msgs.push('호스트네임 없음');
      if (!r.edge) { edgeLevel = 'warn'; msgs.push('엣지 미선택(경로 배정 따름)'); }
      else if (!edgeSet.has(r.edge)) { edgeLevel = 'error'; msgs.push(`없는 엣지: ${r.edge}`); }
      const ie = ipMsg(r.ip); if (ie) msgs.push(ie);
      const key = r.hostname.toLowerCase();
      if (r.hostname) { if (seen.has(key)) msgs.push(`이름 중복(${seen.get(key) + 1}행과 같음)`); else seen.set(key, i); }
      const hardBad = !r.hostname || (edgeLevel === 'error') || !!ie || (seen.get(key) !== i && !!r.hostname);
      return { i, ...r, msgs, edgeLevel, ok: !hardBad };
    });
    const edgeBad = detail.filter((d) => d.edgeLevel === 'error').length;
    const edgeMissing = detail.filter((d) => d.edgeLevel === 'warn').length;
    const ipBad = detail.filter((d) => ipMsg(d.ip)).length;
    const dupNames = detail.filter((d) => d.msgs.some((m) => m.startsWith('이름 중복'))).length;
    const okCount = detail.filter((d) => d.ok).length;
    setValidation({ detail, okCount, total: detail.length, edgeBad, edgeMissing, ipBad, dupNames });
    setPreview(null);
    return { detail, okCount, edgeBad, ipBad };
  };

  // JSON import payload — 줄 → {kind, path, name:hostname, host:ip, enabled, agent}.
  const buildTargets = () => effectiveRows()
    .map((r) => ({ edge: (r.edge || '').trim(), hostname: (r.hostname || '').trim(), ip: (r.ip || '').trim() }))
    .filter((r) => r.hostname || r.ip)
    .map((r) => ({ kind, path, name: r.hostname, host: r.ip, enabled, ...(r.edge ? { agent: r.edge } : {}) }));

  const call = async (mode) => {
    setBusy(mode); setErr(''); setDone('');
    try {
      const targets = buildTargets();
      if (!targets.length) { setErr('등록할 줄이 없습니다 — 호스트네임/IP 를 입력하세요.'); return; }
      const body = {
        format: 'json', mode: mode === 'apply' ? 'add' : 'preview',
        content: JSON.stringify({ targets }),
        templateId: templateId || undefined,
        ...(mode === 'apply' ? { expectedCount: preview?.expectedCount } : {}),
      };
      const r = await postJson('/svcmon/targets/import', body);
      if (r.error) { setErr(r.error); setPreview(r); return; }
      if (mode === 'preview') { setPreview(r); return; }
      // 등록 성공 — 대상별 엣지 목록을 배정 동기화 후보로 노출.
      const distinct = [...new Set(targets.map((t) => t.agent).filter(Boolean))];
      setSyncedEdges(distinct.map((agent) => ({ agent, state: 'pending' })));
      setDone(`대상 ${r.added}개 · 점검 ${r.newTests}개를 등록했습니다(배치 ${r.batch}). 확인 후 '사용'으로 바꾸세요.`);
      setPreview(null); setValidation(null);
      await loadBatches(); await loadFolders();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  // 등록한 대상별 엣지로 배정 동기화 — PUT /assign/:agent {byAgent:true} 가 그 엣지에 태그된
  // 모든 대상을 스냅샷해 배포한다. 엣지가 pull→ack 하면 '활성'이 된다.
  const syncEdge = async (agent) => {
    setBusy(`sync:${agent}`); setErr('');
    try {
      await putJson(`/svcmon/assign/${encodeURIComponent(agent)}`, { byAgent: true });
      setSyncedEdges((cur) => cur.map((e) => (e.agent === agent ? { ...e, state: 'done' } : e)));
    } catch (e) { setErr(`엣지 '${agent}' 배정 실패: ${e.message}`); } finally { setBusy(''); }
  };

  const rollback = async (b) => {
    const live = b.liveTargets ?? b.targets;
    if (!window.confirm(`배치 ${b.id} 를 되돌립니다.\n\n등록 당시 대상 ${b.targets}개 · 현재 남아 있는 대상 ${live}개를 삭제합니다.\n계속할까요?`)) return;
    setBusy('rollback'); setErr('');
    try {
      const r = await postJson(`/svcmon/batches/${b.id}/rollback`, { expectedCount: live });
      if (r.error) { setErr(r.error); await loadBatches(); return; }
      setDone(`배치 ${b.id} — 대상 ${r.removed}개 · 점검 ${r.tests}개를 삭제했습니다.`);
      setBatches(r.batches || []);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const folderPaths = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const f of folders) { if ((f.kind || 'infra') !== kind) continue; const p = f.path || ''; if (!p || seen.has(p)) continue; seen.add(p); out.push(p); }
    out.sort((a, b) => a.localeCompare(b, 'ko'));
    return out;
  }, [folders, kind]);

  const canCommit = preview && !preview.error && (preview.summary?.error || 0) === 0
    && (preview.summary?.create || 0) > 0 && preview.capacity?.verdict !== 'reject';

  const reset = () => {
    setCount(3); setInputMode('table'); setRows([EMPTY_ROW(), EMPTY_ROW(), EMPTY_ROW()]); setFreeText('');
    setTemplateId(''); setEnabled(false); setOnDuplicate('skip');
    setValidation(null); setPreview(null); setSyncedEdges([]); setErr(''); setDone('');
  };

  const parsedFreeCount = inputMode === 'free' ? parseFree(freeText).length : 0;

  return (
    <div className="flex col gap">
      {err && <ErrorBox message={err} />}
      {done && <div className="svc-ok">{done}</div>}

      {syncedEdges.length > 0 && (
        <div className="card" style={{ padding: 12 }}>
          <b>엣지 배정 동기화</b>
          <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
            방금 등록한 대상을 각 엣지가 점검하도록 배정합니다. 엣지가 받아 적용(ack)하면 '활성'이 됩니다.
          </div>
          <div className="flex gap wrap">
            {syncedEdges.map((e) => (
              <button key={e.agent} className={`tab ${e.state === 'done' ? 'active' : ''}`}
                disabled={!canEdit || e.state === 'done' || busy === `sync:${e.agent}`}
                onClick={() => syncEdge(e.agent)}>
                {e.state === 'done' ? '✓ ' : busy === `sync:${e.agent}` ? '동기화 중… ' : '⟳ '}{e.agent}
              </button>
            ))}
          </div>
        </div>
      )}

      {templates.length === 0 && (
        <div className="svc-warn">
          점검 템플릿이 없습니다. 대상만 만들면 점검이 하나도 없는 대상이 생깁니다 —
          먼저 '템플릿' 탭에서 템플릿을 고르거나 만드세요(기본 제공 6종이 있습니다).
        </div>
      )}

      {/* ① 위치 */}
      <div className="card" style={{ padding: 14 }}>
        <b>① 어디에 만들까요</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>구분</span>
            <select className="select" value={kind} onChange={(e) => { setKind(e.target.value); setPreview(null); }}>
              <option value="infra">인프라</option><option value="service">서비스</option>
            </select>
          </label>
          <label className="flex col" style={{ gap: 4, flex: 1, minWidth: 300 }}>
            <span className="muted" style={{ fontSize: 11 }}>트리 경로 — 구분자 <code>\</code> · 없는 폴더는 자동 생성</span>
            <input className="input" value={path} onChange={(e) => { setPath(e.target.value); setPreview(null); }} placeholder={'예: A.Infra\\OC2\\SBP 워커노드'} />
          </label>
          <button className="tab" type="button" onClick={() => { setShowFolders((v) => !v); if (!showFolders) loadFolders(); }}>
            {showFolders ? '기존 폴더 닫기' : '📁 기존 폴더에서 선택'}
          </button>
        </div>
        {showFolders && (
          <div className="table-wrap" style={{ maxHeight: '24vh', marginTop: 10, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6 }}>
            {folderPaths.length === 0 ? (
              <div className="muted center" style={{ padding: 16, fontSize: 12 }}>폴더가 아직 없습니다 — 위 입력창에 새 경로를 직접 적으세요.</div>
            ) : (
              <div style={{ padding: 6 }}>
                {folderPaths.map((p) => {
                  const depth = p.split('\\').length - 1; const leaf = p.split('\\').pop();
                  return (
                    <button key={p} type="button" className={`tab ${path === p ? 'active' : ''}`}
                      style={{ display: 'block', width: '100%', textAlign: 'left', marginLeft: depth * 16, marginBottom: 2, fontSize: 12 }}
                      onClick={() => { setPath(p); setPreview(null); }}>
                      📁 {leaf} <span className="muted" style={{ fontSize: 10 }}>({p})</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ② 등록할 대상 입력 */}
      <div className="card" style={{ padding: 14 }}>
        <b>② 등록할 대상 입력</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, width: 110 }}>
            <span className="muted" style={{ fontSize: 11 }}>몇 개 등록?</span>
            <input className="input" type="number" min={1} max={MAX_COUNT} value={count}
              onChange={(e) => setCountAndRows(e.target.value)} disabled={inputMode === 'free'} />
          </label>
          <div className="flex gap" style={{ alignItems: 'center' }}>
            {[['table', '표로 입력'], ['free', '자유형식 붙여넣기']].map(([v, t]) => (
              <label key={v} className={`tab ${inputMode === v ? 'active' : ''}`} style={{ cursor: 'pointer' }}>
                <input type="radio" name="inputMode" checked={inputMode === v} onChange={() => { setInputMode(v); setValidation(null); setPreview(null); }} style={{ marginRight: 6 }} />
                {t}
              </label>
            ))}
          </div>
        </div>

        {/* 표 모드 */}
        {inputMode === 'table' && (
          count > TABLE_CAP ? (
            <div className="svc-warn" style={{ marginTop: 12 }}>
              {count.toLocaleString()}개는 표로 그리기엔 많습니다(최대 {TABLE_CAP}개) — <b>자유형식</b>으로 붙여넣기하세요
              (한 줄에 <code>엣지, 호스트네임, IP</code>).
            </div>
          ) : (
            <div className="table-wrap" style={{ maxHeight: '46vh', marginTop: 12 }}>
              <table>
                <thead><tr>
                  <th style={{ width: 44 }}>#</th><th style={{ width: 200 }}>엣지 이름</th><th>호스트네임</th><th style={{ width: 200 }}>IP</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const vd = validation?.detail?.[i];
                    return (
                      <tr key={i}>
                        <td className="muted">{i + 1}</td>
                        <td>
                          <input className="input" list="svc-edge-list" style={{ width: '100%', fontSize: 12 }}
                            value={r.edge} placeholder="(엣지 선택/입력)" onChange={(e) => setRow(i, { edge: e.target.value })} />
                        </td>
                        <td>
                          <input className="input" style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                            value={r.hostname} placeholder="lesasbpdp1" onChange={(e) => setRow(i, { hostname: e.target.value })} />
                        </td>
                        <td>
                          <input className="input" style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12,
                            borderColor: vd && ipMsg(r.ip) ? 'var(--red,#ef4444)' : undefined }}
                            value={r.ip} placeholder="10.20.30.41" onChange={(e) => setRow(i, { ip: e.target.value })} />
                          {vd && vd.msgs.length > 0 && <div style={{ fontSize: 10, color: vd.ok ? 'var(--amber,#f59e0b)' : 'var(--red,#ef4444)' }}>{vd.msgs.join(' · ')}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* 자유형식 모드 */}
        {inputMode === 'free' && (
          <label className="flex col" style={{ gap: 4, marginTop: 12 }}>
            <span className="muted" style={{ fontSize: 11 }}>
              한 줄에 하나: <code>엣지, 호스트네임, IP</code> (쉼표·공백·탭 구분) · <code>#</code> 주석 · 파싱 {parsedFreeCount}줄
            </span>
            <textarea className="input" rows={8} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
              value={freeText} onChange={(e) => { setFreeText(e.target.value); setValidation(null); setPreview(null); }}
              placeholder={'SBP-EDGE, lesasbpdp1, 10.20.30.41\nSBP-EDGE  lesasbpdp2  10.20.30.42\nOC2-EDGE, lesoc2web1, 10.20.30.51'} />
          </label>
        )}

        {/* 엣지 datalist(표/자유형식 공용 자동완성) */}
        <datalist id="svc-edge-list">{edges.map((e) => <option key={e.agent} value={e.agent} />)}</datalist>

        <div className="flex gap wrap" style={{ alignItems: 'center', marginTop: 10 }}>
          {inputMode === 'table' && count <= TABLE_CAP && (
            <>
              <button type="button" className="tab" onClick={addRow}>＋ 줄 추가</button>
              <button type="button" className="tab" onClick={removeEmpty}>－ 빈 줄 삭제</button>
            </>
          )}
          <button type="button" className="login-btn" onClick={validate}>✓ 검증</button>
          {validation && (
            <span className={`badge ${validation.edgeBad || validation.ipBad || validation.dupNames ? 'red' : validation.edgeMissing ? 'amber' : 'green'}`}>
              유효 {validation.okCount}/{validation.total}
              {validation.edgeBad ? ` · 없는 엣지 ${validation.edgeBad}` : ''}
              {validation.ipBad ? ` · IP 오류 ${validation.ipBad}` : ''}
              {validation.dupNames ? ` · 이름중복 ${validation.dupNames}` : ''}
              {validation.edgeMissing ? ` · 엣지미선택 ${validation.edgeMissing}` : ''}
            </span>
          )}
          {edges.length === 0 && <span className="muted" style={{ fontSize: 11 }}>등록된 엣지(토큰/보고)가 없어 엣지 검증을 건너뜁니다.</span>}
        </div>
      </div>

      {/* ③ 점검 */}
      <div className="card" style={{ padding: 14 }}>
        <b>③ 어떤 점검을 넣을까요</b>
        <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
          <label className="flex col" style={{ gap: 4, minWidth: 260 }}>
            <span className="muted" style={{ fontSize: 11 }}>점검 템플릿 — 위에서 입력한 대상들에 적용</span>
            <select className="select" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setPreview(null); }}>
              <option value="">(점검 없이 대상만 등록)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} — 항목 {(t.items || []).length}개</option>)}
            </select>
          </label>
          <label className="flex col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 11 }}>등록 직후 상태</span>
            <select className="select" value={enabled ? '1' : '0'} onChange={(e) => { setEnabled(e.target.value === '1'); setPreview(null); }}>
              <option value="0">중지 (권장)</option><option value="1">바로 사용</option>
            </select>
          </label>
          <span className="muted" style={{ fontSize: 11, alignSelf: 'center' }}>이미 있는 이름은 건너뜁니다(미리보기에 '건너뜀'으로 표시).</span>
        </div>
        {tpl && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {tpl.name}: {(tpl.items || []).map((x) => `${x.type}${x.port ? `:${x.port}` : ''}`).join(', ')} · 대상당 점검 {itemCount}개
          </div>
        )}
        {enabled && (
          <div className="svc-warn">바로 사용으로 등록하면 즉시 점검이 시작됩니다 — 주소·개수를 잘못 넣으면 실트래픽이 나갑니다. '중지'로 확인 후 켜세요.</div>
        )}
        <div className="flex gap" style={{ marginTop: 12 }}>
          <button className="login-btn" disabled={!canEdit || busy === 'preview'} onClick={() => call('preview')}>{busy === 'preview' ? '검사 중…' : '미리보기'}</button>
          {preview && (
            <button className="login-btn" disabled={!canEdit || !canCommit || busy === 'apply'} onClick={() => call('apply')}>
              {busy === 'apply' ? '등록 중…' : `${(preview.summary?.create || 0).toLocaleString()}개 등록`}
            </button>
          )}
          <button className="tab" onClick={reset}>초기화</button>
        </div>
      </div>

      {preview && <PreviewTable result={preview} title="대량 등록 미리보기" />}

      {/* 등록 이력 / 롤백 */}
      <div className="card" style={{ padding: 14 }}>
        <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
          <b>등록 이력 (최근 50건)</b>
          <button className="tab" onClick={loadBatches}>새로 고침</button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          '되돌리기'는 그 배치로 등록된 대상만 삭제합니다. 등록 당시 수와 <b>현재 남아 있는 수</b>를 나란히 보여줍니다.
        </div>
        <div className="table-wrap" style={{ maxHeight: '34vh' }}>
          <table>
            <thead><tr>
              <th style={{ width: 100 }}>배치</th><th style={{ width: 150 }}>시각</th><th style={{ width: 90 }}>방식</th>
              <th>경로</th><th style={{ width: 110, textAlign: 'right' }}>대상(당시/현재)</th>
              <th style={{ width: 90, textAlign: 'right' }}>점검</th><th style={{ width: 110 }}>등록자</th><th style={{ width: 110 }} />
            </tr></thead>
            <tbody>
              {batches.length === 0 && <tr><td colSpan={8} className="center muted" style={{ padding: 20 }}>이력이 없습니다.</td></tr>}
              {batches.map((b) => (
                <tr key={b.id}>
                  <td><code>{b.id}</code></td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdAt ? new Date(b.createdAt).toLocaleString('ko-KR', { hour12: false }) : '—'}</td>
                  <td>{b.source === 'generate' ? '대량등록' : b.source === 'import' ? '가져오기' : b.source}</td>
                  <td><code style={{ fontSize: 11 }}>{b.path || '—'}</code></td>
                  <td style={{ textAlign: 'right' }}>{b.targets}{b.liveTargets !== undefined && b.liveTargets !== b.targets && <span className="muted"> / {b.liveTargets}</span>}</td>
                  <td style={{ textAlign: 'right' }}>{b.tests}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{b.createdBy || '—'}</td>
                  <td>{b.rolledBackAt ? <span className="badge gray">되돌림</span> : canEdit && <button className="tab" disabled={busy === 'rollback'} onClick={() => rollback(b)}>되돌리기</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
