/**
 * 엣지 로그·진행상태 — 각 엣지(수집 서버) 포탈의 **콘솔 로그와 폴러 진행상태**를 중앙에서 본다(v2.549).
 *
 * 사용자 요청(2026-09-17): "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능 만들어줘".
 * 선택: **로그 + 진행상태** · **중앙이 당긴다(pull) + 폴백** · **즉석 조회 + 최근분 보관**.
 *
 * 화면 설계 의도:
 *  1. 맨 위는 **'지금 보이는 것이 무엇인가'** 다 — 보관분은 메모리에만 있고(재시작하면 사라진다),
 *     상시 수집이 아니라 누를 때만 간다. 비어 있는 것을 '장애' 로 읽게 두지 않는다.
 *  2. 엣지 표는 **'지금 누르면 되는가'** 를 말한다(`edgeHint`) — 구버전·비활성·URL 없음은 눌러도 안 된다.
 *  3. 상세는 **진행상태(그룹별)** 와 **로그**를 나눈다. 로그가 비어도 '아무 일 없었다' 고 말하지 않는다.
 *  4. 판정·문구는 `edgeLogText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — 가져오기는 엣지로 HTTP 왕복이다. 마운트 1회 + 버튼만(v2.508 V4 규약).
 * ⚠ 전역 잠금을 쓰지 않는다 — 한 엣지를 가져오는 동안 다른 엣지 버튼이 죽으면 안 된다(v2.529 규약).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import {
  EDGE_KIND_LABEL, toneVar, ageText, msText, edgeHint, fetchResultText, jobText,
  storeNote, logNote, maskNote, logRedactNote, lastAttemptNote, tableFootnotes, groupStatus, statusSummary, levelTone, identityNote, unregisteredNote,
} from './edgeLogText.js';

const LEVELS = [['', '전체'], ['error', '오류'], ['warn', '경고'], ['info', '정보']];

function StatusValue({ value }) {
  if (value === null || value === undefined) return <span style={{ color: 'var(--muted)' }}>—</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.45, maxHeight: 260, overflow: 'auto' }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function EdgeLog() {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAgent, setBusyAgent] = useState('');     // 그 엣지만 잠근다(전역 잠금 금지 — v2.529)
  const [sel, setSel] = useState('');                  // 선택한 엣지(빈 값 = 이 포탈)
  const [snap, setSnap] = useState(null);
  const [snapFor, setSnapFor] = useState('');
  const [snapFresh, setSnapFresh] = useState(false);
  const [note, setNote] = useState(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(0);
  const [level, setLevel] = useState('');
  const [openGroups, setOpenGroups] = useState({});
  const [showStatus, setShowStatus] = useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setData(await fetchJson('/tools/edge-log')); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => [r.agent, r.datacenter, r.version, EDGE_KIND_LABEL[r.kind]].some((v) => String(v || '').toLowerCase().includes(s)));
  }, [rows, q]);

  const store = useMemo(() => storeNote(data?.store || {}, { rows }), [data, rows]);
  const selRow = useMemo(() => rows.find((r) => r.agent === sel) || null, [rows, sel]);

  async function fetchEdge(agent) {
    setBusyAgent(agent); setNote(null);
    try {
      const body = { agent, withStatus: showStatus };
      if (limit) body.limit = limit;
      if (level) body.level = level;
      const r = await postJson('/tools/edge-log/fetch', body);
      setNote(fetchResultText(r));
      setSel(agent); setSnap(r.snap || null); setSnapFor(agent); setSnapFresh(!!r.fresh);
      load();
    } catch (e) {
      setNote({ tone: 'bad', text: e?.message || String(e) });
    } finally { setBusyAgent(''); }
  }

  async function openStored(agent) {
    setSel(agent); setNote(null);
    try {
      const r = await fetchJson(`/tools/edge-log/${encodeURIComponent(agent)}`);
      setSnap(r.snap || null); setSnapFor(agent); setSnapFresh(false);
      const fail = lastAttemptNote(r.lastAttempt);
      if (!r.snap) setNote({ tone: fail ? 'bad' : 'idle', text: fail ? `${fail} 보관된 로그도 없습니다 — 원인을 고친 뒤 **지금 가져오기** 를 누르세요.` : '이 엣지의 보관분이 없습니다 — **지금 가져오기** 를 누르세요.' });
      else if (fail) setNote({ tone: 'warn', text: `${fail} 아래에 보이는 것은 **그 이전에 가져온 보관분**이고 지금 상태가 아닙니다.` });
    } catch (e) { setNote({ tone: 'bad', text: e?.message || String(e) }); }
  }

  async function openLocal() {
    setSel(''); setBusyAgent('__local__'); setNote(null);
    try {
      const p = new URLSearchParams();
      if (limit) p.set('limit', String(limit));
      if (level) p.set('level', level);
      if (!showStatus) p.set('status', '0');
      const r = await fetchJson(`/tools/edge-log-local${p.toString() ? `?${p}` : ''}`);
      setSnap(r); setSnapFor(''); setSnapFresh(true);
    } catch (e) { setNote({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusyAgent(''); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const groups = groupStatus(snap?.status || [], data?.labels?.group || {});
  const sSum = snap ? statusSummary(snap) : null;
  const lNote = snap ? logNote(snap, { limits: data?.limits || {} }) : null;
  const mNote = snap ? maskNote(snap) : '';

  return (
    <div className="stack" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>엣지 로그 · 진행상태</h3>
        <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.6 }}>
          <BoldText text={store.text} />
        </p>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'각 엣지 포탈의 **콘솔 로그**와 **폴러 진행상태**를 중앙이 그때그때 당겨 옵니다. 닿지 못하면 요청을 남겨 두고 엣지가 스스로 인출해 회신합니다. 비밀번호·토큰은 엣지에서 가린 뒤 보냅니다.'} />
        </p>
      </div>

      <div className="kpis">
        <Kpi label="엣지" value={rows.length} />
        {/* ⚠ '보관분 있음' 은 **내용이 있는** 것만 센다 — 실패 기록만 있는 엣지를 세면 열었을 때 빈 화면이다. */}
        <Kpi label="보관분 있음" value={data?.counts?.hasData || 0} />
        <Kpi label="마지막 시도 실패" value={data?.counts?.failed || 0} />
        <Kpi label="폴백 대기" value={data?.jobs?.pending ?? 0} />
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <SearchBox value={q} onChange={setQ} placeholder="엣지 이름·법인 검색" />
          <label style={{ fontSize: 12 }}>
            줄 수{' '}
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ minWidth: 0 }}>
              <option value={0}>기본({data?.limits?.defaultLimit ?? '?'})</option>
              <option value={100}>100</option>
              <option value={data?.limits?.maxLimit || 1000}>최대({data?.limits?.maxLimit ?? '?'})</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            레벨{' '}
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={showStatus} onChange={(e) => setShowStatus(e.target.checked)} /> 진행상태 함께
          </label>
          <button onClick={openLocal} disabled={busyAgent === '__local__'}>{busyAgent === '__local__' ? '읽는 중…' : '이 포탈 로그 보기'}</button>
          <button onClick={load}>새로고침</button>
        </div>

        {/* ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 없으면 400px 에서 표가 페이지를 밀어낸다(실측 622px). */}
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
        <STable>
          <thead>
            <tr>
              <th>엣지</th><th>상태</th><th>버전</th><th>마지막 가져오기</th><th className="right">로그</th><th data-nosort>작업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const h = edgeHint(r, { minVersion: data?.minVersion });
              const j = jobText(r.job || {}, { jobs: data?.jobs || {} });
              return (
                <tr key={r.agent} style={{ background: sel === r.agent ? 'rgba(255,255,255,0.04)' : undefined }}>
                  <td data-sort={r.agent}>
                    <span
                      role="button" tabIndex={0}
                      onClick={() => openStored(r.agent)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStored(r.agent); } }}
                      style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
                    >{r.agent}</span>
                    {r.datacenter && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.datacenter}</div>}
                  </td>
                  <td data-sort={h.label}>
                    <span style={{ color: toneVar(h.tone) }}>{h.label}</span>
                    {j && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{j}</div>}
                  </td>
                  <td data-sort={r.version || ''}>{r.version || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td data-sort={r.last?.at || 0}>
                    {r.last?.at ? <>{ageText(r.last.at)} <span style={{ color: 'var(--muted)', fontSize: 11 }}>({msText(r.last.ms)})</span></> : <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                  <td className="right" data-sort={r.last?.logCount ?? -1}>{r.last?.logCount ?? <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>
                    <button onClick={() => fetchEdge(r.agent)} disabled={busyAgent === r.agent || !h.can} title={h.can ? '' : h.text.replace(/\*\*/g, '')}>
                      {busyAgent === r.agent ? '가져오는 중…' : '지금 가져오기'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </STable>
        </div>
        {!shown.length && <p style={{ fontSize: 12, color: 'var(--muted)' }}>표시할 엣지가 없습니다. 설정 › 수집 서버에 등록된 항목이 없으면 여기도 비어 있습니다.</p>}
        {/* 각주 — 눌러도 안 되는 종류의 조치는 표 아래에서 **한 번만** 말한다(행마다 반복하면 셀이 길어진다 — v2.509). */}
        {tableFootnotes(data?.counts || {}, { minVersion: data?.minVersion }).map((f, i) => (
          <p key={i} style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={f} /></p>
        ))}
      </div>

      {note && (
        <div className="card" style={{ borderLeft: `3px solid ${toneVar(note.tone)}`, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}><BoldText text={note.text} /></p>
        </div>
      )}

      {selRow && (identityNote(selRow) || unregisteredNote(selRow)) && (
        <div className="card" style={{ borderLeft: `3px solid ${toneVar('warn')}`, minWidth: 0 }}>
          {identityNote(selRow) && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}><BoldText text={identityNote(selRow)} /></p>}
          {unregisteredNote(selRow) && <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.6 }}><BoldText text={unregisteredNote(selRow)} /></p>}
        </div>
      )}

      {snap && (
        <div className="card" style={{ minWidth: 0 }}>
          <h4 style={{ marginTop: 0 }}>
            {snapFor ? snapFor : '이 포탈(중앙)'}
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>
              {snapFresh ? '방금 가져온 값' : `보관분 · ${ageText(snap.at)}`}
            </span>
          </h4>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {snap.node && <>호스트 {snap.node.hostname} · 버전 {snap.node.version} · {snap.node.role === 'edge' ? '엣지' : '중앙'} · 기동 {ageText(snap.node.startedAt)}</>}
          </p>
          {mNote && <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={mNote} /></p>}
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={logRedactNote()} /></p>

          {sSum && (
            <>
              <p style={{ margin: '10px 0 6px', fontSize: 13, lineHeight: 1.6 }}><BoldText text={sSum.text} /></p>
              {groups.map((g) => (
                <div key={g.group} style={{ border: '1px solid var(--line, #334155)', borderRadius: 6, marginBottom: 8, minWidth: 0 }}>
                  <button
                    onClick={() => setOpenGroups((o) => ({ ...o, [g.group]: !o[g.group] }))}
                    style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, padding: '8px 10px', cursor: 'pointer', color: 'inherit', fontSize: 13 }}
                  >
                    {openGroups[g.group] ? '▾' : '▸'} {g.label} <span style={{ color: 'var(--muted)', fontSize: 12 }}>({g.items.length}항목{g.failed ? ` · 확인 불가 ${g.failed}` : ''})</span>
                  </button>
                  {openGroups[g.group] && (
                    <div style={{ padding: '0 10px 10px', overflowX: 'auto', minWidth: 0 }}>
                      <STable>
                        <thead><tr><th>항목</th><th data-nosort>값</th></tr></thead>
                        <tbody>
                          {g.items.map((it) => (
                            <tr key={it.key}>
                              <td style={{ whiteSpace: 'normal', maxWidth: 200 }}>
                                {it.label}
                                {it.ok === false && <div style={{ fontSize: 11, color: toneVar('warn') }}>확인 불가: {it.error}</div>}
                                {it.truncated && <div style={{ fontSize: 11, color: 'var(--muted)' }}>값이 커서 일부를 잘랐습니다</div>}
                              </td>
                              <td style={{ minWidth: 0 }}><StatusValue value={it.value} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </STable>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {lNote && <p style={{ margin: '12px 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar(lNote.tone) }}><BoldText text={lNote.text} /></p>}
          {!!snap.logs?.items?.length && (
            <pre style={{ margin: 0, maxHeight: 420, overflow: 'auto', fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {snap.logs.items.map((l) => (
                <div key={l.id} style={{ color: toneVar(levelTone(l.level)) }}>
                  {l.time} [{l.level}] {l.msg}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export default EdgeLog;
