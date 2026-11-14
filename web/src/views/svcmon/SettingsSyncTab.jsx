import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import { STable } from '../../components/STable.jsx';
import './techView.css';
import {
  SYNC_STATE_META, SELECTABLE, FACETS, emptySelection, filterRows, facetCounts, chipValue, toggleFacet, sparkPoints, stackedBars, fmtMs, fmtAge, detectText,
} from './syncLogic.js';

/**
 * Monitoring 설정 › **설정 연동**(v2.915) — 포탈 설정에 등록된 시스템(vCenter · 엣지 · NSX · iDRAC · 스토리지 · SAN · PDU · CVP · Veeam ·
 * Bareos …)을 골라 Monitoring 대상으로 등록하고, 설정이 바뀌면(새 항목 · 주소 변경 · 사라짐) 차이를 보여 준다.
 * 기술 뷰(Datadog 대시보드 참고 — 시안 docs/design/monitoring-autoreg/Main.dc.html): 템플릿 변수 · Query Value · 커버리지 Top List ·
 * 드리프트 추이 · 엣지 배정 · 패싯 + 목록 · 이벤트 스트림.
 *
 * 규약: 상태 판정은 서버(svcmon/settingsSync.js)가 내려준 값 그대로 · 적용은 서버가 **지금** 다시 분류한 행으로만 판정한다(화면이 본 상태를
 * 믿지 않는다) · 무거운 조회라 폴링하지 않는다(마운트 1회 + 버튼) · 늦게 온 이전 응답은 버린다 · 조회 실패면 등록 버튼을 열지 않는다.
 * `compact` 는 등록 마법사(BulkTab) 안에서 쓰는 판본(QV·차트·이벤트 없이 패싯 + 목록만).
 */

const STATE_KEYS = ['new', 'changed', 'gone'];
const FACET_TOP = 6;
const ROW_LIMIT = 500;

function Spark({ values, color }) {
  const pts = sparkPoints(values);
  if (!pts) return null;
  return (
    <svg width="84" height="24" viewBox="0 0 84 24" aria-hidden="true"><polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} /></svg>
  );
}

function QV({ title, sub, value, cls = '', note, spark, color }) {
  return (
    <div className="tv-w">
      <div className="tv-wh">{title}<em>{sub}</em></div>
      <div className="tv-qv">
        <b className={cls}>{value}</b>
        <div className="d"><span>{note}</span>{spark && <Spark values={spark} color={color} />}</div>
      </div>
    </div>
  );
}

const timeOf = (at) => (at ? new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

function DriftChart({ ring, detect }) {
  const W = 600; const H = 130;
  const { bars, max } = stackedBars(ring, STATE_KEYS, { w: W, h: H - 18, left: 34, right: 8, top: 8 });
  const dt = detectText(detect);
  if (!ring.length) return <div className="tv-empty">{`아직 감지 기록이 없습니다 — ${dt.empty}(재시작하면 비어 있습니다).`}</div>;
  const color = { new: '#3b82f6', changed: '#f59e0b', gone: '#ef4444' };
  const first = ring[0]?.at; const last = ring[ring.length - 1]?.at; const mid = ring[Math.floor(ring.length / 2)]?.at;
  return (
    <svg className="tv-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
      aria-label={`${dt.every ? `${dt.every} ` : ''}감지마다의 미등록·주소 변경·사라짐 건수 누적 막대`}>
      <line x1="34" y1={H - 18} x2={W - 8} y2={H - 18} stroke="var(--border)" />
      <text x="2" y="14">{max || 0}</text><text x="2" y={H - 20}>0</text>
      {bars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={color[b.k]}><title>{`${timeOf(b.at)} ${SYNC_STATE_META[b.k].label} ${b.v}`}</title></rect>)}
      <text x="34" y={H - 4}>{timeOf(first)}</text>
      <text x={W / 2 - 14} y={H - 4}>{timeOf(mid)}</text>
      <text x={W - 44} y={H - 4}>{timeOf(last)}</text>
    </svg>
  );
}

export default function SettingsSyncTab({ canEdit = false, compact = false, onApplied = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(emptySelection);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [moreFacet, setMoreFacet] = useState({});
  const [modal, setModal] = useState(false);
  const [opts, setOpts] = useState({ enabled: false, goneAction: 'disable', syncAssign: true, withChecks: true });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState(null);
  const [autoKinds, setAutoKinds] = useState(null);
  const [rp, setRp] = useState(null);   // v2.988 '법인 폴더로 정리' — { preview, result, busy, msg } · null = 닫힘
  const seq = useRef(0);
  const rpSeq = useRef(0);   // v2.988(반증 R10): 닫은 뒤 늦게 온 미리보기 응답이 창을 다시 열지 않게
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true); setErr(null);
    try {
      const d = await fetchJson('/svcmon/settings-sync/catalog');
      if (my !== seq.current) return;   // 늦게 온 이전 응답은 버린다
      setData(d);
      setAutoKinds(new Set(d.options?.autoKinds || []));
      setPicked((p) => new Set([...p].filter((k) => d.rows.some((r) => r.key === k && SELECTABLE.has(r.state)))));
      if (firstLoad.current) {
        firstLoad.current = false;
        // 첫 화면은 '할 일' 이 있는 상태만 — 없으면 전체.
        const act = STATE_KEYS.filter((s) => (d.counts?.[s] || 0) > 0);
        if (act.length) setSel((s) => ({ ...s, state: new Set(act) }));
      }
    } catch (e) {
      if (my !== seq.current) return;
      setErr(e);
    } finally { if (my === seq.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const kinds = useMemo(() => data?.kinds || {}, [data]);
  const labelOf = useMemo(() => ({
    state: (v) => SYNC_STATE_META[v]?.label || v,
    kind: (v) => kinds[v]?.label || v,
  }), [kinds]);
  const rows = useMemo(() => data?.rows || [], [data]);
  const shown = useMemo(() => filterRows(rows, sel, q), [rows, sel, q]);
  const facets = useMemo(() => facetCounts(rows, sel, q, labelOf), [rows, sel, q, labelOf]);
  const selectableShown = useMemo(() => shown.filter((r) => SELECTABLE.has(r.state)), [shown]);
  const maxApply = data?.limits?.maxApply || 2000;

  if (loading && !data) return <Loading label="설정 카탈로그" />;
  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return null;

  const c = data.counts || {};
  const daily = data.drift?.daily || [];
  const ring = data.drift?.ring || [];
  const detectEvery = detectText(data.detect).every;   // v2.932(점검 D1-08): 감지 주기는 서버 값
  const present = (c.total || 0) - (c.gone || 0) - (c.held || 0);
  const pickedRows = rows.filter((r) => picked.has(r.key));
  const togglePick = (k) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else if (n.size < maxApply) n.add(k); return n; });
  const allPicked = selectableShown.length > 0 && selectableShown.every((r) => picked.has(r.key));
  const pickAll = () => setPicked((p) => {
    const n = new Set(p);
    if (allPicked) { for (const r of selectableShown) n.delete(r.key); return n; }
    for (const r of selectableShown) { if (n.size >= maxApply) break; n.add(r.key); }
    return n;
  });

  const body = (extra = {}) => ({ keys: [...picked], ...opts, ...extra });
  const doPreview = async () => {
    setBusy(true); setMsg(''); setPreview(null); setResult(null);
    try { const r = await postJson('/svcmon/settings-sync/preview', body()); setPreview(r.preview); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const doApply = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await postJson('/svcmon/settings-sync/apply', body());
      // 추가가 취소돼도(오류 1건이면 0건) 서버는 200 + ok:false 로 결과를 준다 — 선택을 지우지 않고 결과만 보여 준다.
      setResult(r); setPreview(null);
      if (r.result?.committed !== false) setPicked(new Set());
      onApplied?.(r);
      load();
    } catch (e) {
      setMsg(e.message);
    } finally { setBusy(false); }
  };
  // v2.988 '법인 폴더로 정리' — 설정 연동이 놓은 자리에 그대로 있고 지금은 법인을 알 수 있는 연동 대상(행의 repath)만. 미리보기 → 옮기기.
  const repathKeys = rows.filter((r) => r.repath).map((r) => r.key).slice(0, maxApply);
  const openRepath = async () => {
    const my = ++rpSeq.current;
    setRp({ busy: true });
    try {
      const r = await postJson('/svcmon/settings-sync/repath', { keys: repathKeys });
      if (r?.ok === false) throw new Error(r.error || '미리보기를 받지 못했습니다.');
      if (my === rpSeq.current) setRp({ preview: r.preview });
    } catch (e) { if (my === rpSeq.current) setRp({ msg: e.message }); }
  };
  const closeRepath = () => { rpSeq.current += 1; setRp(null); };
  const doRepath = async () => {
    const keys = (rp?.preview?.move || []).map((m) => m.key);
    const my = ++rpSeq.current;
    setRp((p) => ({ ...p, busy: true, msg: '' }));
    try {
      const r = await postJson('/svcmon/settings-sync/repath', { keys, mode: 'apply' });
      if (r?.ok === false && !r.result) throw new Error(r.error || '옮기지 못했습니다.');
      onApplied?.(r);
      load();
      if (my === rpSeq.current) setRp({ result: r });   // 창을 닫았어도 적용은 끝났다 — 목록은 다시 읽는다
    } catch (e) { if (my === rpSeq.current) setRp((p) => ({ ...p, busy: false, msg: e.message })); }
  };
  const saveAuto = async () => {
    setBusy(true); setMsg('');
    try { const r = requireChanged(await putJson('/svcmon/settings-sync/options', { autoKinds: [...(autoKinds || [])] }), '자동 등록 설정을 저장하지 못했습니다.'); setAutoKinds(new Set(r.options?.autoKinds || [])); setMsg('자동 등록 설정을 저장했습니다.'); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };

  const chipLabel = (k) => chipValue(sel, k, labelOf[k] || ((v) => v));
  const kindTop = (c.byKind || []).filter((k) => k.total > 0).slice(0, 12);
  const topNew = (c.byKind || []).map((k) => ({ ...k, n: rows.filter((r) => r.kind === k.kind && r.state === 'new').length })).sort((a, b) => b.n - a.n)[0];

  return (
    <div className="tv-root">
      <div className="card tv-top">
        <h3>설정 연동</h3>
        {FACETS.map((f) => <span key={f.k} className="tv-var"><span>{f.k}</span><b>{chipLabel(f.k)}</b></span>)}
        <span className="tv-spacer">
          {!compact && <span className="tv-var"><span>refresh</span><b>{`5m · ${timeOf(data.drift?.last?.at) || '감지 전'}`}</b></span>}
          <button type="button" className="btn" disabled={busy || loading} onClick={load}>{loading ? '읽는 중…' : '카탈로그 다시 읽기'}</button>
          <button type="button" className="btn primary" disabled={!canEdit || !picked.size || busy}
            title={canEdit ? '' : '등록은 operator 이상'} onClick={() => { setModal(true); setPreview(null); setResult(null); setMsg(''); }}>
            {`선택 ${picked.size}건 등록…`}
          </button>
        </span>
      </div>

      {err && <ErrorBox error={err} />}
      {canEdit && repathKeys.length > 0 && (
        <div className="tv-bulkbar" style={{ marginTop: 0 }}>
          <b>{`법인 폴더로 옮길 수 있는 연동 대상 ${repathKeys.length}건`}{(c.repath || 0) > repathKeys.length ? ` (전체 ${c.repath}건 — 목록에 보이는 행만)` : ''}</b>
          <span className="sub">설정 연동이 놓은 자리에 그대로 있고 지금은 법인을 알 수 있는 대상입니다 — 사람이 옮긴 대상 · 경로 기준 엣지 배정 대상은 건드리지 않습니다.</span>
          <span className="btns"><button type="button" className="btn" disabled={busy || !!rp?.busy} onClick={openRepath}>법인 폴더로 정리…</button></span>
        </div>
      )}

      {!compact && (
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          출처는 <b>통신 점검 › 설정 전수 점검</b>과 같은 카탈로그입니다. 장비 <b>자격증명은 옮기지 않습니다</b> — 등록되는 점검은 무인증(TCP · 인증서 만료 · HTTP 상태 · SSH/SMTP 배너)뿐이고,
          401/403 응답은 살아 있음으로 봅니다. 등록하면 트리의 ‘{data.root}\그룹\법인’ 아래에 <b>중지 상태</b>로 들어갑니다. 담당 엣지가 배정 후보면 그 엣지 전용 대상이 되고(배정 동기화), 이 포탈이 점검을 직접 실행하는 역할이면 이 포탈도 함께 잽니다.
        </div>
      )}

      {!compact && (
        <div className="tv-qvs">
          <QV title="설정된 시스템" sub="catalog" value={present} note={`${(c.byKind || []).length}종 · 출처 오류 ${(data.sourceErrors || []).length}`} spark={daily.map((d) => d.total)} color="#3b82f6" />
          <QV title="등록됨" sub="linked" value={(c.linked || 0) + (c.changed || 0)} cls="tv-ok" note={c.coveragePct == null ? '커버리지 —' : `커버리지 ${c.coveragePct}%`} spark={daily.map((d) => d.linked)} color="#22c55e" />
          <QV title="미등록" sub="new" value={c.new || 0} note={topNew?.n ? `${topNew.label} ${topNew.n}` : '—'} spark={daily.map((d) => d.new)} color="#8b9bb4" />
          <QV title="주소 변경" sub="host-changed" value={c.changed || 0} cls={c.changed ? 'tv-warn' : ''} note="설정과 대상 주소가 다름" spark={daily.map((d) => d.changed)} color="#f59e0b" />
          <QV title="설정에서 사라짐" sub="gone" value={c.gone || 0} cls={c.gone ? 'tv-bad' : ''} note={c.held ? `판정 보류 ${c.held}` : '대상은 남아 있음'} spark={daily.map((d) => d.gone)} color="#ef4444" />
          <QV title="카탈로그 읽기" sub="read" value={fmtMs(data.readMs)} cls="tv-blue" note={`설정 문제 ${c.problem || 0} · 제외 ${c.excluded || 0}`} />
        </div>
      )}

      {!compact && (
        <div className="tv-row3">
          <div className="tv-w">
            <div className="tv-wh">등록 커버리지 · 종류별<em>linked / total</em></div>
            <div className="tv-tl">
              {kindTop.map((k) => (
                <div key={k.kind}>
                  <span className="k" title={k.label}>{k.label}</span>
                  <span className="bar"><i style={{ width: `${k.total ? Math.round((k.linked / k.total) * 100) : 0}%` }} /></span>
                  <span className="n">{`${k.linked} / ${k.total}`}</span>
                </div>
              ))}
              {!kindTop.length && <div className="tv-empty">설정에 등록된 시스템이 없습니다.</div>}
            </div>
          </div>
          <div className="tv-w">
            <div className="tv-wh">{`미등록 · 변경 · 사라짐 추이 — ${detectEvery ? `${detectEvery} ` : '주기 '}감지`}<em>settingsDrift</em></div>
            <DriftChart ring={ring} detect={data.detect} />
            <div className="tv-legend">
              <span><i style={{ background: '#3b82f6' }} />미등록</span><span><i style={{ background: '#f59e0b' }} />주소 변경</span><span><i style={{ background: '#ef4444' }} />사라짐</span>
              <span style={{ marginLeft: 'auto' }}>감지 = 카탈로그 읽기만(네트워크 점검 아님) · 적용은 사람이</span>
            </div>
          </div>
          <div className="tv-w">
            <div className="tv-wh">엣지별 배정 · 보고<em>assign · edge-state</em></div>
            <div style={{ overflowX: 'auto' }}>
              <STable className="tv-table" minWidth={330}>
                <thead><tr><th>엣지</th><th>배정 대상</th><th>설정 연동</th><th>보고</th></tr></thead>
                <tbody>
                  {(data.edges || []).map((e) => (
                    <tr key={e.agent}>
                      <td className="mono">{e.agent}</td>
                      <td className="mono" data-sort={e.assignedTargets ?? ''}>{e.assignedTargets ?? '—'}{e.byAgent ? '' : e.assignedTargets != null ? ' (경로)' : ''}</td>
                      <td className="mono" data-sort={e.syncTargets || 0}>{e.syncTargets || 0}</td>
                      <td>{e.noReport ? <span className="tv-pill gone">보고 없음</span> : e.silent ? <span className="tv-pill gone">무보고</span> : <span className="tv-pill ok">{fmtAge(e.ageMs)}</span>}</td>
                    </tr>
                  ))}
                  {!(data.edges || []).length && <tr><td colSpan={4} className="tv-empty">배정·보고 중인 엣지가 없습니다 — 등록한 대상은 이 포탈이 직접 잽니다.</td></tr>}
                </tbody>
              </STable>
            </div>
          </div>
        </div>
      )}

      <div className="tv-row2">
        <div className="tv-w">
          {FACETS.map((f) => {
            const list = facets[f.k] || [];
            const open = !!moreFacet[f.k];
            return (
              <div key={f.k} className="tv-facet">
                <h4>{f.label}<em>{list.length}</em></h4>
                {(open ? list : list.slice(0, FACET_TOP)).map((x) => (
                  <label key={x.v} className={x.n ? '' : 'zero'}>
                    <input type="checkbox" checked={!!sel[f.k]?.has(x.v)} onChange={() => setSel((s) => toggleFacet(s, f.k, x.v))} />
                    <span className="l" title={x.label}>{x.label}</span><span className="n">{x.n}</span>
                  </label>
                ))}
                {list.length > FACET_TOP && (
                  <button type="button" className="more" onClick={() => setMoreFacet((m) => ({ ...m, [f.k]: !open }))}>{open ? '접기' : `${list.length - FACET_TOP}개 더…`}</button>
                )}
              </div>
            );
          })}
          <div className="tv-facet">
            <button type="button" className="more" onClick={() => { setSel(emptySelection()); setQ(''); }}>패싯 모두 풀기</button>
          </div>
        </div>

        <div className="tv-w">
          <div className="tv-list-head">
            <input type="search" aria-label="이름·주소·종류 검색" placeholder="이름 · 주소 · 종류 · 법인 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>{`${shown.length} rows · 선택 ${picked.size}`}{data.truncated ? ` · 전체 ${data.total} 중 앞 ${rows.length}` : ''}</span>
            {canEdit && (
              <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!selectableShown.length} onClick={pickAll}>
                {allPicked ? '보이는 행 선택 해제' : `보이는 등록 가능 행 선택(${Math.min(selectableShown.length, maxApply)})`}
              </button>
            )}
          </div>
          {/* 목록은 상자 안에서 스크롤 — 수백 행이 페이지를 수만 px 로 늘리지 않게(Chromium 실측: 279행 = 13,190px). */}
          <div style={{ overflow: 'auto', maxHeight: compact ? 420 : 640 }}>
            <STable className="tv-table" minWidth={900} limit={ROW_LIMIT}>
              <thead><tr>
                <th data-nosort style={{ width: 30 }} />
                <th style={{ width: 96 }}>STATE</th><th>NAME</th><th>TAGS</th><th>HOST:PORT</th><th>CHECKS</th><th>비고</th>
              </tr></thead>
              <tbody>
                {shown.map((r) => {
                  const m = SYNC_STATE_META[r.state] || SYNC_STATE_META.excluded;
                  const can = canEdit && SELECTABLE.has(r.state);
                  return (
                    <tr key={r.key} style={r.state === 'excluded' || r.state === 'held' ? { opacity: 0.6 } : undefined}>
                      <td data-nosort>{can ? <input type="checkbox" aria-label={`${r.name} 선택`} checked={picked.has(r.key)} onChange={() => togglePick(r.key)} /> : null}</td>
                      <td data-sort={m.pill}><span className={`tv-pill ${m.cls}`}>{m.pill}</span></td>
                      <td style={{ fontWeight: 500, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 120 }} title={r.address || r.name}>{r.name}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                        <span className="tv-tag k">{`kind:${r.kindLabel}`}</span>
                        <span className="tv-tag c">{`corp:${r.corp || '전역'}`}</span>
                        <span className="tv-tag e" title={r.agentNote || ''}>{`edge:${r.agent || (r.agentDeclared ? `${r.agentDeclared}→중앙` : 'central')}`}</span>
                        {r.depth && <span className="tv-tag d">{`depth:${r.depth}`}</span>}
                      </td>
                      <td className="mono">
                        {r.state === 'changed'
                          ? <><s style={{ color: 'var(--text-faint)' }}>{`${r.prevHost}${r.prevPort ? `:${r.prevPort}` : ''}`}</s>{` → ${r.host}${r.port ? `:${r.port}` : ''}`}</>
                          : (r.host ? `${r.host}${r.port ? `:${r.port}` : ''}` : (r.address || '—'))}
                      </td>
                      <td style={{ whiteSpace: 'normal', minWidth: 110 }}>{(r.checks || []).map((x, i) => <span key={i} className="tv-chk">{x.type}{x.port ? `:${x.port}` : ''}</span>)}{!(r.checks || []).length && <span className="muted">—</span>}</td>
                      <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'normal', minWidth: 160 }}>
                        {r.reason || (r.targetId ? `대상 ${r.targetName || r.targetId}${r.targetEnabled === false ? ' · 중지' : ''}` : '')}
                        {r.agentNote && !r.reason ? r.agentNote : ''}
                        {r.repath ? <div className="mono" title={r.repath}>{`→ 법인 폴더: ${r.repath}`}</div> : null}
                      </td>
                    </tr>
                  );
                })}
                {!shown.length && <tr><td colSpan={7} className="tv-empty">조건에 맞는 항목이 없습니다 — 패싯을 풀어 보세요.</td></tr>}
              </tbody>
            </STable>
          </div>
          {shown.length > ROW_LIMIT && <div className="tv-note">{`앞 ${ROW_LIMIT}행만 표시합니다(정렬 뒤 자름) — 패싯·검색으로 좁히세요.`}</div>}
        </div>
      </div>

      {!compact && (
        <div className="tv-w">
          <div className="tv-wh">이벤트 스트림 · 설정 연동<em>감지 · 적용 · 연동 해제 — 재시작 이후</em></div>
          {(data.events || []).slice(0, 12).map((e, i) => (
            <div key={i} className="tv-ev">
              <span className="t">{timeOf(e.at)}</span>
              <span><span className={`tv-pill ${e.kind === 'gone' ? 'gone' : e.kind === 'drift' ? 'chg' : 'ok'}`}>{(e.kind || '').toUpperCase()}</span></span>
              <span className="x">{e.text}</span>
            </div>
          ))}
          {!(data.events || []).length && <div className="tv-empty">아직 이벤트가 없습니다.</div>}
        </div>
      )}

      {!compact && canEdit && (
        <div className="tv-w">
          <div className="tv-wh">자동 등록 — 종류별(기본 끔)<em>새 설정 항목을 감지하면 중지 상태로 등록</em></div>
          <div style={{ padding: '10px 12px' }} className="tv-opts">
            <div className="muted" style={{ fontSize: 12 }}>
              켠 종류의 <b>한 번도 연동된 적 없는</b> 새 항목만 등록합니다(지운 대상을 되살리지 않습니다). 등록은 언제나 중지 상태이고 배정 동기화는 하지 않습니다.
            </div>
            <div className="tv-kindgrid">
              {Object.entries(kinds).filter(([, v]) => !v.excluded).map(([k, v]) => (
                <label key={k}><input type="checkbox" checked={!!autoKinds?.has(k)} onChange={() => setAutoKinds((s) => { const n = new Set(s || []); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />{v.label}</label>
              ))}
            </div>
            <div><button type="button" className="btn" disabled={busy} onClick={saveAuto}>자동 등록 저장</button></div>
          </div>
        </div>
      )}
      {msg && !modal && <div className="svc-warn">{msg}</div>}

      {modal && (
        <Modal title={`설정 연동 — 선택 ${picked.size}건`} onClose={() => { setModal(false); setPreview(null); }} width={1000}>
          <div className="tv-opts">
            <div className="muted" style={{ fontSize: 12 }}>
              {`미등록 ${pickedRows.filter((r) => r.state === 'new').length} · 주소 변경 ${pickedRows.filter((r) => r.state === 'changed').length} · 사라짐 ${pickedRows.filter((r) => r.state === 'gone').length}`}
              {' — 추가는 전부 성공 또는 전부 취소, 주소 반영·사라짐 처리는 대상별로 결과를 보고합니다. 옵션을 바꾸면 미리보기를 다시 봐야 적용할 수 있습니다.'}
            </div>
            <label htmlFor="ss-enabled">등록 직후 상태
              <Select sort={false} className="select" id="ss-enabled" value={opts.enabled ? 'on' : 'off'} onChange={(e) => { setOpts((o) => ({ ...o, enabled: e.target.value === 'on' })); setPreview(null); }}>
                <option value="off">중지 (권장 — 확인 후 켬)</option><option value="on">사용</option>
              </Select>
            </label>
            <label htmlFor="ss-gone">설정에서 사라진 대상
              <Select sort={false} className="select" id="ss-gone" value={opts.goneAction} onChange={(e) => { setOpts((o) => ({ ...o, goneAction: e.target.value })); setPreview(null); }}>
                <option value="disable">중지로 표시 (기본 — 삭제하지 않음)</option><option value="keep">표지만 남김</option><option value="delete">삭제</option>
              </Select>
            </label>
            <label><input type="checkbox" checked={opts.withChecks} onChange={(e) => { setOpts((o) => ({ ...o, withChecks: e.target.checked })); setPreview(null); }} />종류별 기본 점검 넣기(끄면 대상만 등록)</label>
            <label><input type="checkbox" checked={opts.syncAssign} onChange={(e) => { setOpts((o) => ({ ...o, syncAssign: e.target.checked })); setPreview(null); }} />담당 엣지에 배정 동기화(엣지별 배정이거나 배정이 없는 엣지만 — 경로 기준 배정은 바꾸지 않습니다)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn" disabled={busy || !picked.size} onClick={doPreview}>{busy && !preview ? '확인 중…' : '미리보기'}</button>
              <button type="button" className="btn primary" disabled={busy || !preview || (preview.errors || []).length > 0 || (preview.over || []).length > 0} onClick={doApply}>
                {preview ? `적용 (추가 ${preview.add.length} · 변경 ${preview.change.length} · 사라짐 ${preview.gone.length})` : '적용(미리보기 먼저)'}
              </button>
            </div>
            {msg && <div className="svc-warn">{msg}</div>}
            {preview && (
              <div style={{ overflowX: 'auto' }}>
                {[...(preview.over || []), ...(preview.errors || []).map((e) => `${e.name || ''}: ${e.reason}`)].map((x, i) => <div key={i} className="svc-warn" style={{ marginBottom: 4 }}>{x}</div>)}
                <STable className="tv-table" minWidth={820} limit={300}>
                  <thead><tr><th>결과</th><th>이름</th><th>경로</th><th>호스트:포트</th><th>점검</th><th>점검 위치</th></tr></thead>
                  <tbody>
                    {preview.add.map((a) => (
                      <tr key={a.key}><td><span className="tv-pill ok">추가</span></td><td>{a.name}</td><td className="mono">{a.path}</td><td className="mono">{`${a.host}:${a.port}`}</td>
                        <td>{a.checks.map((x, i) => <span key={i} className="tv-chk">{x.type}{x.port ? `:${x.port}` : ''}</span>)}</td><td>{a.agent || '중앙'}</td></tr>
                    ))}
                    {preview.change.map((x) => (
                      <tr key={x.key}><td><span className="tv-pill chg">변경</span></td><td>{x.name}</td><td className="mono">—</td><td className="mono">{`${x.prevHost}${x.prevPort ? `:${x.prevPort}` : ''} → ${x.host}:${x.port}`}</td><td className="muted">점검 id 승계 · url·포트 갱신</td><td>—</td></tr>
                    ))}
                    {preview.gone.map((x) => (
                      <tr key={x.key}><td><span className="tv-pill gone">사라짐</span></td><td>{x.name}</td><td className="mono">—</td><td className="mono">—</td><td className="muted">{x.action === 'delete' ? '대상 삭제' : x.action === 'keep' ? '표지만' : '중지 + 표지'}</td><td>—</td></tr>
                    ))}
                    {[...(preview.skip || []), ...(preview.bulkSkipped || [])].map((x, i) => (
                      <tr key={`s${i}`}><td><span className="tv-pill ex">건너뜀</span></td><td>{x.name || x.key}</td><td className="mono">{x.path || '—'}</td><td>—</td><td className="muted" colSpan={2}>{x.reason}</td></tr>
                    ))}
                  </tbody>
                </STable>
              </div>
            )}
            {result && (
              <div className="tv-w">
                <div className="tv-wh">적용 결과<em>{result.result?.batch}</em></div>
                <div className="tv-note">
                  {`추가 ${result.result?.added ?? 0}(점검 ${result.result?.newTests ?? 0}) · 주소 반영 ${(result.result?.changed || []).length} · 사라짐 처리 ${(result.result?.gone || []).length}`}
                  {result.result?.committed === false ? ` · 추가 취소(오류 ${(result.result?.addErrors || []).length}건 — 하나라도 틀리면 0건 등록)` : ''}
                  {(result.result?.errors || []).length ? ` · 실패 ${(result.result.errors).length}: ${result.result.errors.slice(0, 3).map((e) => `${e.name} ${e.reason}`).join(' / ')}` : ''}
                </div>
                {(result.assign || []).map((a) => (
                  <div key={a.agent} className="tv-note">{`엣지 ${a.agent}: ${a.ok ? `배정 동기화 ${a.targets}대상` : a.reason}`}</div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {rp && (
        <Modal title="법인 폴더로 정리" onClose={closeRepath} width={1000}>
          <div className="tv-opts">
            <div className="muted" style={{ fontSize: 12 }}>
              등록할 때 법인을 몰라 ‘전역’ 같은 폴더에 들어간 연동 대상을 지금 아는 법인 폴더로 옮깁니다. 대상 · 점검 id 는 그대로라 이 포탈이 직접 재는 점검은 연속 횟수 · 만기 · 기록이 이어집니다.
              담당 엣지가 있는 대상은 그 엣지 배정을 다시 굳힙니다 — 엣지는 점검을 다시 등록하므로 <b>엣지 쪽 연속 횟수는 새로 시작</b>하고, 실패 중인 점검은 경로가 바뀌어 다시 알릴 수 있습니다.
              건너뜀: 경로 기준 배정 엣지가 맡는(옮기기 전이든 뒤든) 대상 · 옮길 폴더에 같은 이름의 대상이 있는 것 · 그사이 사람이 옮긴 것.
              {rows.length < (data.total || 0) ? ` 목록이 잘려(${rows.length}/${data.total}) 보이는 행만 대상입니다.` : ''}
            </div>
            {rp.busy && !rp.preview && <Loading label="미리보기" />}
            {rp.msg && <div className="svc-warn">{rp.msg}</div>}
            {rp.preview && (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 12 }}>{`옮김 ${rp.preview.move.length} · 건너뜀 ${rp.preview.skip.length}`}</span>
                  <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} disabled={!!rp.busy || !rp.preview.move.length} onClick={doRepath}>
                    {rp.busy ? '옮기는 중…' : `${rp.preview.move.length}건 옮기기`}
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <STable className="tv-table" minWidth={760} limit={300}>
                    <thead><tr><th>결과</th><th>이름</th><th>지금 경로</th><th>옮길 경로 · 사유</th></tr></thead>
                    <tbody>
                      {rp.preview.move.map((m) => (
                        <tr key={m.key}><td><span className="tv-pill ok">옮김</span></td><td>{m.name}</td><td className="mono">{m.from}</td><td className="mono">{m.to}</td></tr>
                      ))}
                      {rp.preview.skip.map((x, i) => (
                        <tr key={`s${i}`}><td><span className="tv-pill ex">건너뜀</span></td><td>{x.name || x.key}</td><td className="mono">—</td><td className="muted" style={{ whiteSpace: 'normal' }}>{x.reason}</td></tr>
                      ))}
                      {!rp.preview.move.length && !rp.preview.skip.length && <tr><td colSpan={4} className="tv-empty">옮길 대상이 없습니다.</td></tr>}
                    </tbody>
                  </STable>
                </div>
              </>
            )}
            {rp.result && (
              <div className="tv-w">
                <div className="tv-wh">정리 결과<em>repath</em></div>
                <div className="tv-note">
                  {`옮김 ${(rp.result.result?.moved || []).length} · 건너뜀 ${(rp.result.result?.skip || []).length}`}
                  {(rp.result.result?.errors || []).length ? ` · 실패 ${rp.result.result.errors.length}: ${rp.result.result.errors.slice(0, 3).map((e) => `${e.name} ${e.reason}`).join(' / ')}` : ''}
                </div>
                {(rp.result.assign || []).map((a) => (
                  <div key={a.agent} className="tv-note">{`엣지 ${a.agent}: ${a.ok ? `배정 동기화 ${a.targets}대상` : a.reason}`}</div>
                ))}
                <div style={{ padding: '0 12px 10px' }}><button type="button" className="btn" onClick={closeRepath}>닫기</button></div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
