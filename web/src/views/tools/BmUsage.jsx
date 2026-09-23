/**
 * 베어메탈 사용률 — **서버 분석 › 구분 › Baremetal(미가상화 물리)** 로 분류된 서버만
 * CPU·메모리·디스크·네트워크·HBA 사용률을 수집해 보여준다(v2.550).
 *
 * 사용자 요청(2026-09-17): "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어".
 * 선택: **iDRAC + OS SSH 둘 다(되는 것부터)** · **법인 단위로 켠다** · **5분 · 원시 90일 + 일롤업
 * 5년** · **Linux + Windows 둘 다**.
 *
 * 화면 설계 의도:
 *  1. 맨 위는 **'이 숫자를 믿어도 되는가'** — 꺼짐/법인 미선택/대상 0/첫 주기/오래됨을 구분해 말한다.
 *  2. 표는 다섯 지표를 나란히 두고 **값이 없으면 `—`** 다(0 을 그리지 않는다).
 *  3. 행을 누르면 상세 — 무엇을 읽었고 무엇을 못 읽었는지, 장치·인터페이스별 값, 추이.
 *  4. 판정·문구는 `bmUsageText.js`(순수, vitest 고정)가 소유한다. 이 파일은 조립만 한다.
 *
 * ⚠ **폴링하지 않는다** — '지금 수집' 은 SSH·Redfish 왕복이다(마운트 1회 + 버튼, v2.508 규약).
 * ⚠ 전역 잠금을 쓰지 않는다 — 수집 중에도 설정을 고칠 수 있어야 한다(v2.529 규약).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import DeviceFacetBar from './DeviceFacetBar.jsx';
import { facetState, toggleIn } from './deviceFacets.js';
const BmUsageChart = React.lazy(() => import('./BmUsageChart.jsx'));   // 추이 차트(v2.551)
import BoldText from '../../components/boldText.jsx';
import { rangeOf } from './bmUsageChart.js';
import {
  pctText, bpsText, ageText, usageTone, toneVar, srcMark,
  emptyDiag, firstSampleNote, skippedNotes, detailNotes, retentionNote, edgeNote, missingMark, missingFootnotes, authStopNote, keyConflictNote,
  facetRows, pathTypeLabel, topBusiest, corpSummary, csvOf, telemetryNote,
  // v2.554 — iDRAC 라이선스 인식 · Enterprise 대체 수집 · 귀속 원인 · 엣지 보관분
  licenseMark, licenseNote, enterpriseConsentNote, enterpriseStatusNote, entDetailNotes,
  unassignedNote, edgePullState, edgePullNote, blurNumber, BLANK_KEPT_TEXT } from './bmUsageText.js';

/** 표의 지표 열 — 서버가 준 `metrics` 계약과 같은 순서를 쓴다. */
const COLS = [
  { col: 'cpu_pct', label: 'CPU', kind: 'pct' },
  { col: 'mem_pct', label: '메모리', kind: 'pct' },
  { col: 'disk_busy_pct', label: '디스크 I/O', kind: 'pct' },
  { col: 'disk_used_pct', label: '디스크 공간', kind: 'pct' },
  { col: 'net_pct', label: '네트워크', kind: 'pct' },
  { col: 'net_bps', label: '네트워크 처리량', kind: 'bps' },
  { col: 'hba_pct', label: 'HBA', kind: 'pct' },
  { col: 'hba_bps', label: 'HBA 처리량', kind: 'bps' },
];

function Cell({ v, kind }) {
  if (kind === 'bps') return <span>{bpsText(v)}</span>;
  return <span style={{ color: toneVar(usageTone(v)) }}>{pctText(v)}</span>;
}

export function BmUsage() {
  // ⚠ 훅은 전부 조기 return 위에(루트 CLAUDE.md — 조기 반환 뒤 훅 추가는 React #310 크래시).
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [dcSel, setDcSel] = useState(() => new Set());
  const [typeSel, setTypeSel] = useState(() => new Set());
  const [topMetric, setTopMetric] = useState('cpu_pct');
  const [sel, setSel] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rangeKey, setRangeKey] = useState('24h');
  const [showSkipped, setShowSkipped] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  /*
   * ⚠ 엣지 보관분(v2.554) — **폴링하지 않는다**(사용자 지시 "중앙으로 전달은 중앙에서 조회할때만").
   *   마운트 1회 + 버튼(v2.508 규약). `/edges` 는 네트워크에 나가지 않고 보관분만 읽는다.
   */
  const [edges, setEdges] = useState(null);
  const [showEdges, setShowEdges] = useState(false);
  const [pulling, setPulling] = useState('');
  // Enterprise 동의 체크 — 저장 버튼을 누르기 전 단계(서버는 ack 없이는 켜지 않는다).
  const [entAgree, setEntAgree] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const d = await fetchJson('/tools/bm-usage'); setData(d); setForm(d.settings || null); setError(''); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  /** 엣지 보관분 — 마운트 1회. ⚠ 실패해도 화면 전체를 오류로 갈아치우지 않는다(부가 패널이다). */
  const loadEdges = React.useCallback(async () => {
    try { setEdges(await fetchJson('/tools/bm-usage/edges')); }
    catch (e) { setEdges({ ok: false, reason: e?.message || String(e), rows: [] }); }
  }, []);
  useEffect(() => { loadEdges(); }, [loadEdges]);

  /** 엣지에서 지금 가져온다 — 사람이 누를 때만(상시 전송이 없는 것이 이 기능의 설계다). */
  async function pullEdge(agent) {
    setPulling(agent);
    try {
      const r = await postJson('/tools/bm-usage/edges/pull', { agents: [agent] });
      const one = (r.results || [])[0] || null;
      setMsg(one?.ok
        ? { tone: 'ok', text: `**${agent}** 에서 가져왔습니다(${one.ms}ms).` }
        : { tone: 'bad', text: `**${agent}** 가져오기 실패 — ${one?.reason || r.reason || '사유 미상'}` });
      await loadEdges();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setPulling(''); }
  }

  const rows = useMemo(() => {
    const byKey = new Map((data?.rows || []).map((r) => [String(r.key), r]));
    return (data?.targets || []).map((tg) => ({ ...tg, ...(byKey.get(String(tg.key)) || {}), key: tg.key }));
  }, [data]);

  /*
   * 법인·수집경로 필터 + 검색은 **공용 `deviceFacets.facetState` 하나**가 한다(v2.533 규약:
   * 스토리지·증가량 화면과 같은 모듈 — 20줄을 복사하면 두 화면의 칩 개수가 갈라진다).
   * ⚠ 검색을 여기서 또 걸지 말 것 — `facetState` 가 이미 한다(이중 적용이면 칩 개수가 어긋난다).
   */
  const facets = useMemo(() => facetState({
    rows: facetRows(rows), dcSel, typeSel, query: q,
    dcName: (id) => (id ? String(id) : '(귀속 없음)'),
    typeLabel: pathTypeLabel,
    hay: (r) => [r.name, r.serviceTag, r.vcenterId, r.model, r.idracHost, r.osHostName, pathTypeLabel(r.type)],
  }), [rows, dcSel, typeSel, q]);
  const shown = facets.shown;
  const top = useMemo(() => topBusiest(shown, { metric: topMetric, limit: 5 }), [shown, topMetric]);
  const corps = useMemo(() => corpSummary(shown, { metric: topMetric }), [shown, topMetric]);

  /** CSV 내보내기 — **화면에 보이는 것만**(필터를 적용한 결과다. 그 사실을 파일명이 말한다). */
  function exportCsv() {
    const csv = csvOf(shown);
    const stamp = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    // ⚠ 파일명은 ASCII — 헤드리스·일부 브라우저가 한글 download 이름을 떨어뜨린다(v2.519 실측).
    const name = `bm-usage-${stamp}${facets.facetOn || q.trim() ? '-filtered' : ''}.csv`;
    try {
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });   // BOM — 엑셀 한글
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMsg({ tone: 'ok', text: `**${shown.length}대**를 CSV 로 내보냈습니다(${name}).${facets.facetOn || q.trim() ? ' 지금 화면에 보이는 것만 담았습니다.' : ''}` });
    } catch (e) { setMsg({ tone: 'bad', text: `내보내기 실패: ${e?.message || e}` }); }
  }

  const diag = useMemo(() => (data ? emptyDiag(data) : null), [data]);

  async function collectNow() {
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/bm-usage/collect', {});
      setMsg(r.ok
        ? { tone: 'ok', text: `수집 완료 — 서버 ${r.servers ?? 0}대 중 **성공 ${r.okCount ?? 0}** · 실패 ${r.failCount ?? 0} · 저장 ${r.inserted ?? 0}행` }
        : { tone: 'bad', text: r.reason || '수집에 실패했습니다.' });
      load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }

  /**
   * 상세 조회. ⚠ **폴링하지 않는다** — 행을 누를 때와 기간을 바꿀 때만 1회다(v2.508 규약).
   * 90일은 원시가 아니라 일 롤업을 쓰므로 `days` 로 묻는다(뜻이 다른 데이터라 화면이 밝힌다).
   */
  const loadDetail = React.useCallback(async (key, rk) => {
    const r = rangeOf(rk);
    setDetailLoading(true);
    try {
      const q = r.source === 'daily' ? { key, days: r.days, hours: 1 } : { key, hours: r.hours, days: 90 };
      setDetail(await fetchJson('/tools/bm-usage/history', q));
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setDetailLoading(false); }
  }, []);
  async function openDetail(key) {
    setSel(key); setDetail(null); setRangeKey('24h');
    await loadDetail(key, '24h');
  }
  async function changeRange(rk) {
    setRangeKey(rk);
    if (sel) await loadDetail(sel, rk);
  }

  // v2.583 #36: 빈 칸을 0 으로 저장하지 않는다(서버가 하한으로 올려 보존일이 줄고 이력이 지워진다).
  function numBlur(e, field, scale = 1) {
    const n = blurNumber(e.target.value);
    if (n == null) {
      e.target.value = String(Math.round((Number(form?.[field]) || 0) / scale));
      setMsg({ tone: 'bad', text: BLANK_KEPT_TEXT });
      return;
    }
    if (Math.round(n * scale) === Number(form?.[field])) return; // 바뀐 게 없으면 저장하지 않는다
    saveSettings({ [field]: n * scale });
  }

  async function saveSettings(patch) {
    setSaving(true);
    try {
      const r = await putJson('/tools/bm-usage/settings', patch);
      setForm(r.settings); setMsg({ tone: 'ok', text: '설정을 저장했습니다.' });
      load();
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setSaving(false); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const st = data?.status || {};
  const selRow = rows.find((r) => r.key === sel) || null;
  const fsNote = firstSampleNote(data?.rows || []);
  const skNotes = skippedNotes(data?.skippedCounts || {}, data?.reasons || {});

  return (
    <div className="stack" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>베어메탈 사용률</h3>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'대상은 **서버 분석 › 구분 › Baremetal(미가상화 물리)** 과 정확히 같은 집합입니다. 디스크·네트워크·HBA 는 **OS 계정이 있는 서버만** 읽을 수 있고, iDRAC 텔레메트리는 CPU·메모리·I/O(집계)까지 줍니다.'} />
        </p>
        {diag?.text && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar(diag.waiting ? 'warn' : (diag.kind === 'ok' ? 'ok' : 'bad')) }}>
            <BoldText text={diag.text} />
          </p>
        )}
        {fsNote && <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={fsNote} /></p>}
        {/* ⚠ 키 충돌은 **오류 없이 틀린 값**을 만든다 — 조용히 두지 않는다(v2.550.3). */}
        {keyConflictNote(data?.keyConflicts || []) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('bad') }}>
            <BoldText text={keyConflictNote(data.keyConflicts)} />
          </p>
        )}
        {/* ⚠ 인증 실패 정지는 **반드시 화면이 말한다** — 조용히 멈추면 사용자는 수집되는 줄 안다(v2.528). */}
        {authStopNote(data?.authStops || []) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('bad') }}>
            <BoldText text={authStopNote(data.authStops)} />
          </p>
        )}
        {/*
          * ⚠⚠ **'법인 귀속 없음' 의 원인을 말한다**(v2.554 — 사용자 지시 "원인까지 조사").
          *   이 현장은 이 사유로 500대가 빠져 표가 통째로 비어 있었다. 사유만 말하고 원인·조치를
          *   말하지 않으면 사용자가 무엇을 고쳐야 하는지 알 수 없다.
          * ⚠ 긴 설명은 **여기 한 번만** — 행마다 반복하면 같은 문단이 화면을 덮는다(v2.509 규약).
          */}
        {unassignedNote(data?.unassignedInfo) && (
          <div style={{ margin: '0 0 6px', padding: '8px 10px', borderLeft: `3px solid ${toneVar('warn')}`, background: 'rgba(251,191,36,0.06)' }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}><BoldText text={unassignedNote(data.unassignedInfo).head} /></p>
            {unassignedNote(data.unassignedInfo).items.map((x, i) => (
              <p key={i} style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.6 }}><BoldText text={`· ${x}`} /></p>
            ))}
            <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={unassignedNote(data.unassignedInfo).how} /></p>
          </div>
        )}
        {/* Enterprise 대체 수집 상태 — '켰는데 왜 값이 없나' 를 말한다(예산으로 미룬 대수 포함). */}
        {enterpriseStatusNote(st) && (
          <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={enterpriseStatusNote(st)} /></p>
        )}
        {edgeNote(data?.isEdge) && <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={edgeNote(data.isEdge)} /></p>}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={retentionNote(data?.settings || {}, data?.db || {})} />
        </p>
      </div>

      <div className="kpis">
        <Kpi label="수집 대상" value={data?.counts?.targets ?? 0} />
        <Kpi label="OS 경로" value={data?.counts?.os ?? 0} />
        <Kpi label="iDRAC 경로" value={data?.counts?.idrac ?? 0} />
        <Kpi label="대상 아님" value={data?.counts?.skipped ?? 0} />
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <DeviceFacetBar
          dcChips={facets.dcChips} typeChips={facets.typeChips} dcSel={dcSel} typeSel={typeSel}
          onToggleDc={(v) => setDcSel((p) => toggleIn(p, v))}
          onToggleType={(v) => setTypeSel((p) => toggleIn(p, v))}
          onClear={() => { setDcSel(new Set()); setTypeSel(new Set()); setQ(''); }}
          query={q} onQuery={setQ} typeLabel={pathTypeLabel}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
          <button className="btn" onClick={exportCsv} disabled={!shown.length}>CSV 내보내기</button>
          <button className="btn" onClick={collectNow} disabled={busy || !data?.enabled} title={data?.enabled ? '' : '수집이 꺼져 있습니다'}>
            {busy ? '수집 중…' : '지금 수집'}
          </button>
          <button className="btn" onClick={load}>새로고침</button>
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? '설정 닫기' : '설정'}</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            마지막 수집 {ageText(st.last?.at)} · 주기 {st.intervalMs ? `${Math.round(st.intervalMs / 60000)}분` : '—'} · 동시 {st.concurrency ?? '—'}
            {st.last?.alerts && (st.last.alerts.sent > 0 || st.last.alerts.over > 0) && (
              <> · 알림 {st.last.alerts.sent}건 발송{st.last.alerts.capped > 0 && ` (상한으로 ${st.last.alerts.capped}건 생략)`}</>
            )}
          </span>
        </div>

        {/* ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 지표 열이 8개라 400px 에서 페이지를 밀어낸다. */}
        <div style={{ overflowX: 'auto', minWidth: 0 }}>
          <STable>
            <thead>
              <tr>
                <th>서버</th><th>법인</th><th>경로</th>
                {COLS.map((c) => <th key={c.col} className="right">{c.label}</th>)}
                <th>수집</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} style={{ background: sel === r.key ? 'rgba(255,255,255,0.04)' : undefined }}>
                  <td data-sort={r.name}>
                    <span
                      role="button" tabIndex={0}
                      onClick={() => openDetail(r.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.key); } }}
                      style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
                    >{r.name}</span>
                    {r.serviceTag && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.serviceTag}</div>}
                  </td>
                  <td data-sort={r.vcenterId || ''}>{r.vcenterId || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td data-sort={(r.paths || []).join(',')}>
                    <span style={{ fontSize: 12 }}>{(r.paths || []).map((p) => (p === 'os' ? 'OS' : 'iDRAC')).join('·') || '—'}</span>
                    {r.src && r.src !== (r.paths || []).join('+') && <div style={{ fontSize: 11, color: 'var(--muted)' }}>값 출처 {srcMark(r.src)}</div>}
                    {/* ⚠ 전부 `—` 인 행이 **왜** 비었는지 행 자체가 말해야 한다 — 긴 설명은 표 아래 각주가 한 번만 한다. */}
                    {!!(r.missing || []).length && (
                      <div style={{ fontSize: 11, color: toneVar('warn') }}>{missingMark(r.missing)}</div>
                    )}
                    {/* ⚠ 라이선스는 **짧은 표지**만(v2.509) — 설명은 서버를 눌러 상세에서. 미상이면 아무것도 쓰지 않는다. */}
                    {licenseMark(r.license) && (
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{licenseMark(r.license)}</div>
                    )}
                  </td>
                  {COLS.map((c) => (
                    <td key={c.col} className="right" data-sort={r[c.col] ?? -1}><Cell v={r[c.col]} kind={c.kind} /></td>
                  ))}
                  <td data-sort={r.ts || 0}>{r.ts ? ageText(r.ts) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {!shown.length && <p style={{ fontSize: 12, color: 'var(--muted)' }}>표시할 서버가 없습니다.</p>}
        {missingFootnotes(rows).map((f, i) => (
          <p key={i} style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={f} /></p>
        ))}
        <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'‘—’ 는 **못 읽은 것**이고 0% 가 아닙니다. 디스크·네트워크·HBA 의 값은 그 서버에서 **가장 높은 장치·회선** 기준입니다(평균을 쓰면 한 디스크가 가득 찬 서버가 낮게 보입니다). 네트워크·HBA 사용률(%)은 전이중이라 **방향별(수신·송신 중 큰 쪽)** ÷ 링크 속도이고, 처리량(B/s)은 두 방향의 합입니다.'.replace(/`/g, '')} />
        </p>
      </div>

      {/* ── 상위 N + 법인별 집계(v2.551) ─────────────────────────────────────── */}
      {!!shown.length && (
        <div className="card" style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <h4 style={{ margin: 0 }}>가장 바쁜 서버 · 법인별</h4>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>기준</span>
            {COLS.filter((c) => c.kind === 'pct').map((c) => (
              <button
                key={c.col} onClick={() => setTopMetric(c.col)}
                style={{
                  fontSize: 12, padding: '2px 8px', cursor: 'pointer', color: 'inherit', borderRadius: 4,
                  background: topMetric === c.col ? 'rgba(96,165,250,0.18)' : 'transparent',
                  border: '1px solid', borderColor: topMetric === c.col ? '#60a5fa' : 'var(--border, rgba(255,255,255,0.14))',
                }}
              >{c.label}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 12, minWidth: 0 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>상위 {top.list.length}대</div>
              <div style={{ overflowX: 'auto', minWidth: 0 }}>
                <STable>
                  <thead><tr><th>서버</th><th>법인</th><th className="right">{COLS.find((c) => c.col === topMetric)?.label}</th></tr></thead>
                  <tbody>
                    {top.list.map((r) => (
                      <tr key={r.key}>
                        <td data-sort={r.name}>
                          <span role="button" tabIndex={0} onClick={() => openDetail(r.key)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.key); } }}
                            style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
                          >{r.name}</span>
                        </td>
                        <td data-sort={r.vcenterId || ''}>{r.vcenterId || '—'}</td>
                        <td className="right" data-sort={r._v}><span style={{ color: toneVar(usageTone(r._v)) }}>{pctText(r._v)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              {/* ⚠ 값이 없는 서버를 0 으로 줄 세우지 않았다 — 제외했고 그 개수를 밝힌다. */}
              {top.excluded > 0 && (
                <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                  <BoldText text={`이 지표를 읽지 못한 **${top.excluded}대**는 순위에서 빼었습니다 — 0% 로 줄 세우면 '한가한 서버' 라는 거짓이 됩니다.`} />
                </p>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>법인별</div>
              <div style={{ overflowX: 'auto', minWidth: 0 }}>
                <STable>
                  <thead><tr><th>법인</th><th className="right">대수</th><th className="right">최대</th><th className="right">평균</th><th className="right">90%↑</th><th className="right">못 읽음</th></tr></thead>
                  <tbody>
                    {corps.map((c) => (
                      <tr key={c.vcenterId}>
                        <td data-sort={c.vcenterId}>{c.vcenterId}</td>
                        <td className="right" data-sort={c.servers}>{c.servers}</td>
                        <td className="right" data-sort={c.max ?? -1}><span style={{ color: toneVar(usageTone(c.max)) }}>{pctText(c.max)}</span></td>
                        <td className="right" data-sort={c.avg ?? -1}>{pctText(c.avg)}</td>
                        <td className="right" data-sort={c.over90}>{c.over90 ? <b style={{ color: toneVar('bad') }}>{c.over90}</b> : '—'}</td>
                        <td className="right" data-sort={c.unread}>{c.unread || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </STable>
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                <BoldText text={'평균은 **읽은 대수 기준**입니다 — 못 읽은 서버를 0 으로 세면 평균이 아래로 끌려갑니다.'} />
              </p>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <div className="card" style={{ borderLeft: `3px solid ${toneVar(msg.tone)}`, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}><BoldText text={msg.text} /></p>
        </div>
      )}

      {!!skNotes.length && (
        <div className="card" style={{ minWidth: 0 }}>
          <button onClick={() => setShowSkipped((v) => !v)} style={{ background: 'transparent', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontSize: 13 }}>
            {showSkipped ? '▾' : '▸'} 대상이 아닌 서버 {data?.counts?.skipped ?? 0}대 — 사유별
          </button>
          {showSkipped && skNotes.map((s, i) => (
            <p key={i} style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6 }}><BoldText text={s} /></p>
          ))}
        </div>
      )}

      {/* ── 엣지 보관분(v2.554) — 상시 전송 없음. 누를 때만 가져온다 ─────────── */}
      {!!(edges?.rows || []).length && (
        <div className="card" style={{ minWidth: 0 }}>
          <button onClick={() => setShowEdges((v) => !v)} style={{ background: 'transparent', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontSize: 13 }}>
            {showEdges ? '▾' : '▸'} 엣지 보관분 — {(edges.rows || []).filter((r) => r.snapAt).length}/{(edges.rows || []).length}곳
          </button>
          {showEdges && (
            <>
              <p style={{ margin: '6px 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
                <BoldText text={edgePullNote(edges.rows)} />
              </p>
              {/* ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 400px 에서 페이지를 밀어낸다(v2.549 실측). */}
              <div style={{ overflowX: 'auto', minWidth: 0 }}>
                <STable>
                  <thead><tr><th>엣지</th><th>상태</th><th className="right">서버</th><th>버전</th><th>가져온 때</th><th data-nosort>동작</th></tr></thead>
                  <tbody>
                    {(edges.rows || []).map((r) => {
                      const es = edgePullState(r, { minEdgeVersion: edges.minEdgeVersion, staleMs: edges.staleMs });
                      return (
                        <tr key={r.agent}>
                          <td data-sort={r.agent}>
                            {r.agent}
                            {/* ⚠ 엣지가 말한 이름이 다르면 **나란히** 보여준다 — 그 자체가 진단이다(v2.548 F5). */}
                            {r.reportedAgent && r.reportedAgent !== r.agent && (
                              <div style={{ fontSize: 11, color: toneVar('warn') }}>엣지 보고 이름 {r.reportedAgent}</div>
                            )}
                          </td>
                          <td data-sort={es.state}><span style={{ color: toneVar(es.tone) }}>{es.label}</span></td>
                          <td className="right" data-sort={(r.targets || []).length}>{r.snapAt ? (r.targets || []).length : '—'}</td>
                          <td data-sort={r.version || ''}>{r.version || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                          <td data-sort={r.snapAt || 0}>{r.snapAt ? ageText(r.snapAt) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                          <td>
                            <button className="btn btn-sm" onClick={() => pullEdge(r.agent)} disabled={!!pulling || r.enabled === false || !r.hasUrl}
                              title={r.enabled === false ? '중앙에서 비활성으로 두었습니다' : (!r.hasUrl ? 'URL 이 없습니다' : '')}>
                              {pulling === r.agent ? '가져오는 중…' : '지금 가져오기'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
              {/* ⚠ 사유는 **행 아래 한 번씩** — 표 안에 긴 문장을 넣으면 셀이 세로로 길어진다(v2.509). */}
              {(edges.rows || []).map((r) => {
                const es = edgePullState(r, { minEdgeVersion: edges.minEdgeVersion, staleMs: edges.staleMs });
                if (es.state === 'ok') return null;
                return (
                  <p key={`why-${r.agent}`} style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                    <BoldText text={`**${r.agent}** — ${es.why}`} />
                  </p>
                );
              })}
            </>
          )}
        </div>
      )}

      {showSettings && form && (
        <div className="card" style={{ minWidth: 0 }}>
          <h4 style={{ marginTop: 0 }}>수집 설정</h4>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} disabled={saving} />
            {' '}수집 켜기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'**법인을 하나씩 켜세요** — 한꺼번에 켜면 주기마다 SSH·Redfish 세션이 수백 개 열립니다. 회선·장비 부하를 보면서 늘리는 것이 이 설정의 목적입니다.'} />
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 6, marginBottom: 10 }}>
            {(data?.vcenters || []).map((v) => (
              <label key={v.id} style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <input
                  type="checkbox" disabled={saving}
                  checked={!!(form.corps || {})[v.id]}
                  onChange={(e) => saveSettings({ corps: { ...(form.corps || {}), [v.id]: e.target.checked } })}
                />
                {' '}{v.name}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>주기(분){' '}
              <input type="number" min={1} max={360} defaultValue={Math.round((form.intervalMs || 0) / 60000)} disabled={saving}
                onBlur={(e) => numBlur(e, 'intervalMs', 60000)} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>원시 보존(일){' '}
              <input type="number" min={7} max={365} defaultValue={form.rawRetentionDays} disabled={saving}
                onBlur={(e) => numBlur(e, 'rawRetentionDays')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>롤업 보존(일){' '}
              <input type="number" min={30} max={3650} defaultValue={form.dailyRetentionDays} disabled={saving}
                onBlur={(e) => numBlur(e, 'dailyRetentionDays')} style={{ width: 80, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.osSsh} onChange={(e) => saveSettings({ osSsh: e.target.checked })} disabled={saving} /> OS SSH
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.idracTelemetry} onChange={(e) => saveSettings({ idracTelemetry: e.target.checked })} disabled={saving} /> iDRAC 텔레메트리
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.includeUnassigned} onChange={(e) => saveSettings({ includeUnassigned: e.target.checked })} disabled={saving} /> 법인 귀속 없는 서버도 포함
            </label>
          </div>

          {/* ── iDRAC 텔레메트리 전수 모드(v2.551) ──────────────────────────── */}
          <h4 style={{ margin: '14px 0 6px' }}>iDRAC 텔레메트리</h4>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
            <input type="checkbox" checked={!!form.idracFullTelemetry} onChange={(e) => saveSettings({ idracFullTelemetry: e.target.checked })} disabled={saving} />
            {' '}리포트 전수 읽기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'켜면 iDRAC 의 텔레메트리 리포트 목록을 열거해 **NIC·FC 통계까지** 읽습니다 — OS 계정이 없는 서버도 네트워크·HBA 값이 나옵니다. 끄면 CPU·메모리·I/O(집계)만 읽습니다(v2.550 방식). ⚠ **이 현장 iDRAC 의 실제 리포트 목록을 확인한 적이 없습니다** — 장비별로 무엇을 읽었는지는 서버를 눌러 상세에서 보세요.'} />
          </p>

          {/* ── Enterprise 라이선스 대체 수집(v2.554) ───────────────────────── */}
          <h4 style={{ margin: '14px 0 6px' }}>Enterprise 라이선스 대체 수집</h4>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={enterpriseConsentNote()} />
          </p>
          {/*
            * ⚠⚠ **동의 없이는 켜지지 않는다**(사용자 지시: "사용할것이냐고 물어보고 사용하겠다고
            *   하면 기능을 구현한다"). 서버도 `enabled && ack` 로 못 박으므로 화면만 고쳐서는
            *   켤 수 없다 — 이 두 단계를 하나로 합치지 말 것.
            */}
          {!form.enterpriseAck ? (
            <>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
                <input type="checkbox" checked={entAgree} onChange={(e) => setEntAgree(e.target.checked)} disabled={saving} />
                {' '}위 부하를 확인했고 <b>사용하겠습니다</b>
              </label>
              <button
                onClick={() => saveSettings({ enterpriseAck: true, enterpriseEnabled: true })}
                disabled={!entAgree || saving}
                title={entAgree ? '' : '먼저 동의에 체크하세요'}
              >{saving ? '저장 중…' : '동의하고 켜기'}</button>
            </>
          ) : (
            <>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                <input type="checkbox" checked={!!form.enterpriseEnabled} onChange={(e) => saveSettings({ enterpriseEnabled: e.target.checked, enterpriseAck: true })} disabled={saving} />
                {' '}대체 수집 켜기
              </label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ fontSize: 12 }}>방식{' '}
                  <select value={form.enterpriseMode || 'auto'} disabled={saving}
                    onChange={(e) => saveSettings({ enterpriseMode: e.target.value })} style={{ minWidth: 0 }}>
                    <option value="auto">자동 — Redfish 센서 먼저, 못 읽으면 SSH</option>
                    <option value="api">Redfish 센서만(부하 가장 적음)</option>
                    <option value="ssh">iDRAC SSH(racadm)만</option>
                  </select>
                </label>
                {form.enterpriseAckAt ? (
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                    동의 {ageText(form.enterpriseAckAt)}{form.enterpriseAckBy ? ` · ${form.enterpriseAckBy}` : ''}
                  </span>
                ) : null}
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                <BoldText text={'⚠ **이 현장 장비에서 확인하지 못한 것이 있습니다** — 표준 Redfish 센서 컬렉션의 응답과 racadm 출력 형식입니다. 읽지 못하면 값을 지어내지 않고 **읽지 못했다고 표시**하며, 서버를 눌러 상세에서 **원문**을 볼 수 있습니다. 그 원문을 알려 주시면 파서를 맞추겠습니다.'} />
              </p>
            </>
          )}
          {!form.idracTelemetry && (
            <p style={{ margin: '6px 0 0', fontSize: 12, color: toneVar('warn'), lineHeight: 1.6 }}>
              <BoldText text={'⚠ 위에서 **iDRAC 텔레메트리가 꺼져 있어** 이 대체 수집도 돌지 않습니다 — 그 설정이 ‘iDRAC 로 수집할지’ 를 정하는 축입니다.'} />
            </p>
          )}

          {/* ── 임계 초과 알림(v2.551) ──────────────────────────────────────── */}
          <h4 style={{ margin: '14px 0 6px' }}>임계 초과 알림</h4>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
            <input type="checkbox" checked={!!form.alertEnabled} onChange={(e) => saveSettings({ alertEnabled: e.target.checked })} disabled={saving} />
            {' '}알림 켜기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'⚠ **기본 꺼짐**입니다 — 대상이 많고 주기가 짧아 한 번 튄 값으로 알리면 야간에 수백 통이 나갑니다. 그래서 **지속 시간**을 넘겨야 알리고, 같은 서버·같은 지표는 **재알림 간격** 안에 다시 보내지 않으며, 임계 아래로 내려오면 해제를 **1회** 알립니다. 채널은 설정 › 알림(Slack·Webhook·메일)을 그대로 씁니다.'} />
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>임계(%){' '}
              <input type="number" min={50} max={100} defaultValue={form.alertPct} disabled={saving}
                onBlur={(e) => numBlur(e, 'alertPct')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>지속(분){' '}
              <input type="number" min={0} max={240} defaultValue={form.alertSustainMin} disabled={saving}
                onBlur={(e) => numBlur(e, 'alertSustainMin')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>재알림 간격(시간){' '}
              <input type="number" min={1} max={168} defaultValue={form.alertRepeatHours} disabled={saving}
                onBlur={(e) => numBlur(e, 'alertRepeatHours')} style={{ width: 80, minWidth: 0 }} />
            </label>
            {data?.status?.alertState && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                추적 중 {data.status.alertState.tracked}건 · 알린 것 {data.status.alertState.notified}건
              </span>
            )}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'감시 지표는 **퍼센트 지표 6개**(CPU·메모리·디스크 I/O·디스크 공간·네트워크·HBA)입니다 — 처리량(B/s)은 장비마다 정상 범위가 달라 임계를 정하지 않습니다. **못 읽은 주기는 초과도 정상도 아닙니다**(판정 보류).'} />
          </p>
        </div>
      )}

      {selRow && (
        <div className="card" style={{ minWidth: 0 }}>
          <h4 style={{ marginTop: 0 }}>
            {selRow.name}
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, marginLeft: 8 }}>
              {selRow.serviceTag || selRow.key} · {selRow.model || '모델 미상'}
              {selRow.idracHost ? ` · iDRAC ${selRow.idracHost}` : ''}
              {selRow.osHostName ? ` · OS ${selRow.osHostName}` : ''}
            </span>
          </h4>
          {/* iDRAC 이 무엇을 지원하는지 장비별로 밝힌다(v2.551 — 사용자 선택). */}
          {telemetryNote(selRow.detail || {}) && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={telemetryNote(selRow.detail)} /></p>
          )}
          {detailNotes(detail?.target ? { ...detail.target, ...(selRow.detail || {}) } : (selRow.detail || {})).map((s, i) => (
            <p key={i} style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={s} /></p>
          ))}
          {/* 라이선스 — **언제 본 값인지** 함께(인벤토리는 느린 주기로 갱신된다). */}
          {licenseNote(selRow.detail?.license || selRow.license) && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={licenseNote(selRow.detail?.license || selRow.license)} /></p>
          )}
          {entDetailNotes(selRow.detail || {}).map((x, i) => (
            <p key={`ent${i}`} style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={x} /></p>
          ))}
          {/*
            * ⚠⚠ **원문을 그대로 보여주는 것이 이 기능의 정직성 장치다**(v2.542 `cliRaw` 규약):
            *   이 현장 racadm 출력 형식을 확인한 적이 없어 파싱이 빗나갈 수 있다. 그때 사용자가
            *   실제 출력을 보고 알려줄 수 있어야 한다 — '읽지 못했습니다' 만 남기면 추측만 남는다.
            */}
          {!!selRow.detail?.entRaw && (
            <details style={{ margin: '0 0 8px' }}>
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>iDRAC SSH(racadm) 원문 보기</summary>
              <pre style={{ margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflow: 'auto', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 4 }}>{selRow.detail.entRaw}</pre>
            </details>
          )}
          {detail?.rawTruncated && (
            <p style={{ margin: '0 0 6px', fontSize: 12, color: toneVar('warn'), lineHeight: 1.6 }}>
              <BoldText text={'조회 상한으로 **일부 구간이 잘렸습니다** — 더 긴 기간은 일 단위 롤업으로 보세요.'} />
            </p>
          )}
          {!detail && <p style={{ fontSize: 12, color: 'var(--muted)' }}>추이를 불러오는 중…</p>}
          {detail && !detail.raw?.length && !detail.daily?.length && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>저장된 추이가 없습니다 — 아직 수집되지 않았거나 이 서버의 값을 읽지 못했습니다.</p>
          )}
          {/* 추이 차트 — 판정·좌표는 순수 모듈이 갖는다. 롤업 표는 그 아래에 남긴다(수치 대조용). */}
          <React.Suspense fallback={<p style={{ fontSize: 12, color: 'var(--muted)' }}>차트를 불러오는 중…</p>}>
            <BmUsageChart
              raw={detail?.raw || []} daily={detail?.daily || []}
              rawTruncated={!!detail?.rawTruncated}
              intervalMs={data?.status?.intervalMs}
              absent={[...(selRow?.detail?.idracAbsent || []), ...(selRow?.detail?.osAbsent || [])]}
              rangeKey={rangeKey} onRange={changeRange} loading={detailLoading}
            />
          </React.Suspense>
          {!!detail?.daily?.length && (
            <div style={{ overflowX: 'auto', minWidth: 0 }}>
              <STable>
                <thead><tr><th>날짜</th><th className="right">CPU 평균</th><th className="right">CPU 최대</th><th className="right">메모리 평균</th><th className="right">메모리 최대</th><th className="right">디스크 최대</th><th className="right">네트워크 최대</th><th className="right">HBA 최대</th><th className="right">표본</th></tr></thead>
                <tbody>
                  {detail.daily.slice(-30).reverse().map((d) => (
                    <tr key={d.day}>
                      <td data-sort={d.day}>{d.day}</td>
                      <td className="right" data-sort={d.cpu_avg ?? -1}>{pctText(d.cpu_avg)}</td>
                      <td className="right" data-sort={d.cpu_max ?? -1}>{pctText(d.cpu_max)}</td>
                      <td className="right" data-sort={d.mem_avg ?? -1}>{pctText(d.mem_avg)}</td>
                      <td className="right" data-sort={d.mem_max ?? -1}>{pctText(d.mem_max)}</td>
                      <td className="right" data-sort={d.disk_busy_max ?? -1}>{pctText(d.disk_busy_max)}</td>
                      <td className="right" data-sort={d.net_max ?? -1}>{pctText(d.net_max)}</td>
                      <td className="right" data-sort={d.hba_max ?? -1}>{pctText(d.hba_max)}</td>
                      <td className="right" data-sort={d.samples ?? 0}>{d.samples ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default BmUsage;
