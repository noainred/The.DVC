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
import { fetchJson, postJson, putJson, canCsv, hasRole } from '../../api.js';
import { scopeSaveSuffix } from '../scopeSaveText.js';
import { fleetPartialsNote, fleetHeldNote } from '../fleetPartialText.js'; // v2.744(감사 후속 FC): fleetHeldNote — 등록부 손상으로 직전 목록 유지
import { Loading, ErrorBox, Kpi } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import DeviceFacetBar from './DeviceFacetBar.jsx';
import { facetState, toggleIn } from './deviceFacets.js';
const BmUsageChart = React.lazy(() => import('./BmUsageChart.jsx'));   // 추이 차트(v2.551)
import BoldText from '../../components/boldText.jsx';
import { addressHiddenNote } from './addressHiddenText.js'; // v2.600 AUTHZ-2600-08
import { rangeOf } from './bmUsageChart.js';
import { distStateOf, lapsedVerifiedNote, distributionSummary, centralManagedNote, ignoredCentralNote, DIST_ENTERPRISE_NOTE,
  distModeLabel, findDistRow, edgeOnView, edgeOnConfirmLines, edgeOffConfirmLines, edgeOnSavedText } from './bmUsageDistText.js'; // v2.627 · v2.927 중앙에서 켜기
import { fmtAgo } from '../../util/fmt.js';
import {
  pctText, bpsText, ageText, usageTone, toneVar, srcMark,
  emptyDiag, firstSampleNote, skippedNotes, detailNotes, retentionNote, edgeNote, missingMark, missingFootnotes, hbaBasisFootnote, authStopNote, keyConflictNote, sourceErrorsNote, lastPruneNote,
  facetRows, pathTypeLabel, topBusiest, corpSummary, csvOf, telemetryNote, hostsUnreadNote,
  // v2.554 — iDRAC 라이선스 인식 · Enterprise 대체 수집 · 귀속 원인 · 엣지 보관분
  licenseMark, licenseNote, enterpriseConsentNote, enterpriseStatusNote, entDetailNotes, usageDetailNote,
  unassignedNote, edgePullState, edgePullNote, edgeNoteRows, blurNumber, BLANK_KEPT_TEXT, esxiCollectNote,
  edgeDelegatedByAgent, edgeDelegatedChip, edgeDelegatedGuide } from './bmUsageText.js';   // v2.959 엣지 수집 — 엣지별
import Select from '../../components/Select.jsx';
// v2.920(리눅스 성능 2단계 화면): USE 매트릭스 보드 · 서버 성능 상세 — 문구·표시 규약은 bmPerfText.js, 판정은 서버 useJudge.js.
import BmPerfBoard from './BmPerfBoard.jsx';
import BmPerfDetail from './BmPerfDetail.jsx';
import { boardItems, allAuthStops } from './bmPerfText.js';
// v2.923(리눅스 성능 4단계): 함대 ‘용도 분석’ · ‘장애 기록’ 보기(도구 키 그대로 — 이 화면 안의 보기 전환).
import { BmPurposeFleet, BmFaultsFleet } from './BmOpsFleet.jsx';
import BmPerfRulesPanel from './BmPerfRulesPanel.jsx';
import BmOnboardPanel from './BmOnboardPanel.jsx'; // 7b단계 서버 등록 · SSH 키 저장소 · 누락 점검
import BmKeyOverlaps from './BmKeyOverlaps.jsx'; // 다음 점검 ①(2차) — 식별 키가 겹치는 서버 · 사용자 결정
import { keyOverlapNote } from './bmKeyOverlapText.js';
// 6단계: 서버 비교(2~5대) — 고른 서버 목록은 이 화면이 들고(보드 체크 · 상세 ‘비교에 추가’ · 병목 Top 5 · 용도 그룹) 비교 보기가 그린다.
import BmCompareView from './BmCompareView.jsx';
import BmCollectHealth from './BmCollectHealth.jsx'; // 6단계 수집 건강 보드(관리자 · 운영자)
import BmLogsFleet from './BmLogsFleet.jsx'; // 7a단계 로그 분석 함대 보기
import BmCapacityFleet from './BmCapacityFleet.jsx'; // 8a단계 용량 소진 예측 함대 보기
import BmIdleFleet from './BmIdleFleet.jsx'; // 8b단계 ㉑ 저활용 서버 함대 보기
import BmPowerFleet from './BmPowerFleet.jsx'; // 8b단계 ㉒ 전력 · 온도 함대 보기
import BmMaintPanel from './BmMaintPanel.jsx'; // 8a단계 정비 창 · 알림 억제(설정 절)
import { addKey } from './bmCompareText.js';
import { refOf, parseRef, normRef } from './bmPerfUrl.js'; // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 상세 · 비교 · 공유 링크에 법인을 싣는다
import { parseShareHash } from './bmShare.js'; // 6단계 공유 링크(#/tools/bm-usage/share?… — 도구 키 그대로) // v2.929(5단계): 리눅스 성능 알림 규칙 · 집중 · 베이스라인 · 소모품 기준(별도 파일 · 별도 절)

/** v2.920: 보기 기억(사용자별 편의 — 실패해도 화면은 기본값으로 그린다). */
const VIEW_KEY = 'bmUsage.view';
// 보기는 URL 해시가 아니라 localStorage 기억 + 자동 기본값(v2.920) — useHashTab 은 데이터 전 fallback 을 해시에 굳혀 ‘성능 항목이 있으면 USE’ 를 깬다(audit2613a 스윕의 명시 예외).
const VIEWS = ['use', 'util', 'purpose', 'faults', 'compare', 'health', 'logs', 'capacity', 'idle', 'power'];
function readView() { try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.includes(v) ? v : null; } catch { return null; } }
function writeView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* 저장 실패는 무시 — 다음에 기본값 */ } }
/** 6단계: 비교에 담은 서버(사람별 편의 — 실패해도 빈 목록으로 그린다). */
const CMP_KEY = 'bmUsage.compare';
// 비교에 담은 서버 = ‘법인|키’ 쌍 글자(예전 판이 저장한 키만도 읽는다 — 법인 모름 · 비교 화면이 법인 고르기를 보인다)
function readCmp() { try { const a = JSON.parse(localStorage.getItem(CMP_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x).map(normRef).filter(Boolean).slice(0, 8) : []; } catch { return []; } }
function writeCmp(a) { try { localStorage.setItem(CMP_KEY, JSON.stringify(a)); } catch { /* 무시 */ } }

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
  const [selVc, setSelVc] = useState('');   // 다음 점검 ①: 사용률 추이를 연 서버의 법인(이 노드 대상 — /history 에 함께)
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState(null);   // v2.612 WEB2612-03: 실패를 패널 안에서 말한다
  const detailGen = React.useRef(0);                  // v2.612 WEB2612-03: 늦게 온 다른 서버·기간 응답은 버린다
  const [rangeKey, setRangeKey] = useState('24h');
  const [showSkipped, setShowSkipped] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // v2.945.1(사용자 보고 "설정을 켜도 꺼도 화면에 변화가 없어"): 수집 설정 카드는 보드 · 표 · 엣지 보관분 **뒤**에 열린다 —
  //   열 때 그 카드로 화면을 옮긴다. 설정값을 못 받았으면(form 없음) 버튼 바로 아래에 이유를 보인다(조용히 아무것도 안 그리지 않는다).
  const settingsRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [distSaving, setDistSaving] = useState(false); // v2.627 엣지 배포 저장 중
  /*
   * ⚠ 엣지 보관분(v2.554) — **폴링하지 않는다**(사용자 지시 "중앙으로 전달은 중앙에서 조회할때만").
   *   마운트 1회 + 버튼(v2.508 규약). `/edges` 는 네트워크에 나가지 않고 보관분만 읽는다.
   */
  const [edges, setEdges] = useState(null);
  const [showEdges, setShowEdges] = useState(false);
  // v2.959: '대상이 아닌 서버' 의 엣지 수집 묶음에서 엣지 보관분 표로 옮긴다(펼치고 그 카드로 화면 이동). 숫자가 바뀔 때마다 한 번.
  const edgesRef = React.useRef(null);
  const [edgeJump, setEdgeJump] = useState(0);
  useEffect(() => {
    if (!edgeJump) return;
    const el = edgesRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [edgeJump]);
  const [pulling, setPulling] = useState('');
  // v2.927 '중앙에서 켜기' — 확인 단계(표 아래 상자) · 저장 중인 엣지(잠금은 그 엣지만)
  const [edgeAsk, setEdgeAsk] = useState(null);   // { agent, on }
  const [edgeOnSaving, setEdgeOnSaving] = useState('');
  // Enterprise 동의 체크 — 저장 버튼을 누르기 전 단계(서버는 ack 없이는 켜지 않는다).
  const [entAgree, setEntAgree] = useState(false);
  // v2.920: 보기 — 'use'(USE 매트릭스 보드) | 'util'(기존 사용률 표). null 이면 자동(성능 항목이 있으면 USE).
  const [viewSel, setViewSel] = useState(readView);
  const [perfSel, setPerfSel] = useState('');   // 성능 상세를 연 서버(엣지 위임 서버도 — 사용률 추이는 이 노드 대상만)
  const [perfVc, setPerfVc] = useState('');     // 다음 점검 ①: 그 서버의 법인(서버 = (법인, 키) 쌍 — 비면 서버가 정하고 모호하면 법인 고르기)
  const [cmpKeys, setCmpKeysState] = useState(readCmp);   // 6단계 서버 비교에 담은 서버
  const [cmpMsg, setCmpMsg] = useState('');
  const [cmpMax, setCmpMax] = useState(5);
  const setCmpKeys = React.useCallback((a) => { const v = [...new Set((Array.isArray(a) ? a : []).map(normRef).filter(Boolean))].slice(0, 8); setCmpKeysState(v); writeCmp(v); }, []);
  // 6단계 공유 링크 — 들어올 때 · 해시가 바뀔 때 한 번 적용한다(링크는 권한을 주지 않는다: 서버가 다시 판정 · 사라진 서버는 404/‘없음’).
  const [shareInit, setShareInit] = useState(() => (typeof window !== 'undefined' ? parseShareHash(window.location.hash) : null));
  useEffect(() => {
    const on = () => { const x = parseShareHash(window.location.hash); if (x) setShareInit(x); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // v2.628 WEB2628-06: 늦게 온 이전 GET 이 방금 저장한 설정(form)을 덮지 않게 세대로 거른다(저장 성공도 세대를 올린다).
  const loadGen = React.useRef(0);
  const load = React.useCallback(async () => {
    const gen = ++loadGen.current;
    setLoading(true);
    try {
      const d = await fetchJson('/tools/bm-usage');
      if (gen !== loadGen.current) return;
      setData(d); setForm(d.settings || null); setError('');
    } catch (e) { if (gen === loadGen.current) setError(e?.message || String(e)); }
    finally { if (gen === loadGen.current) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const formReady = !!form;
  useEffect(() => {
    if (!showSettings || !formReady) return;
    const el = settingsRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showSettings, formReady]);   // 열 때 · 설정값이 처음 도착할 때만 옮긴다(저장마다 옮기지 않게)

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
  /*
   * v2.920: USE 매트릭스 보드 항목 — 이 노드 대상 + 엣지 보관분(위임 수집 환경에서 중앙 보드가 비지 않게). 법인·경로 필터와 검색은
   *   같은 facetState 를 이 목록에 다시 건다(엣지 행도 같은 칩으로 걸러진다). 보드 보기에서는 칩도 이 목록 기준이다.
   */
  const perfItems = useMemo(() => boardItems(data || {}, edges), [data, edges]);
  const perfFacets = useMemo(() => facetState({
    rows: facetRows(perfItems.map((it) => ({ ...(it.target || {}), ...(it.row || {}), key: it.key, name: it.name, vcenterId: it.vcenterId, agent: it.agent, _it: it }))),
    dcSel, typeSel, query: q,
    dcName: (id) => (id ? String(id) : '(귀속 없음)'),
    typeLabel: pathTypeLabel,
    hay: (r) => [r.name, r.serviceTag, r.vcenterId, r.model, r.idracHost, r.osHostName, r.agent, pathTypeLabel(r.type)],
  }), [perfItems, dcSel, typeSel, q]);
  const perfShown = useMemo(() => perfFacets.shown.map((r) => r._it), [perfFacets]);
  // v2.920(반증 D6): 인증 정지는 이 노드 것 + 엣지 보관분 것(엣지 위임 서버의 ‘인증 정지’ 가 빠지지 않게).
  const perfAuthStops = useMemo(() => allAuthStops(data || {}, edges), [data, edges]);
  const view = viewSel || ((data?.perf || []).length || perfItems.some((it) => it.entry) ? 'use' : 'util');
  const barFacets = view === 'use' ? perfFacets : facets;
  function chooseView(v) { setViewSel(v); writeView(v); }
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
  const loadDetail = React.useCallback(async (key, rk, vc = '') => {
    const r = rangeOf(rk);
    const gen = ++detailGen.current;
    setDetailLoading(true); setDetailErr(null);
    try {
      const q0 = r.source === 'daily' ? { key, days: r.days, hours: 1 } : { key, hours: r.hours, days: 90 };
      const q = vc ? { ...q0, vcenterId: vc } : q0;
      const d = await fetchJson('/tools/bm-usage/history', q);
      if (gen === detailGen.current) setDetail(d);
    } catch (e) {
      // 실패하면 다른 기간의 값을 이 기간 것처럼 두지 않는다.
      if (gen === detailGen.current) { setDetail(null); setDetailErr(e?.message || String(e)); }
    } finally { if (gen === detailGen.current) setDetailLoading(false); }
  }, []);
  const [perfTab, setPerfTab] = useState('');   // v2.923: 함대 보기에서 연 서버는 그 탭으로(용도 · 장애 기록)
  useEffect(() => {
    if (!shareInit) return;
    if (shareInit.view === 'compare') { setCmpKeys(shareInit.keys); setViewSel('compare'); }
    else if (shareInit.view === 'detail') { setPerfSel(shareInit.key); setPerfVc(shareInit.vc || ''); setPerfTab(shareInit.tab || 'summary'); }
  }, [shareInit, setCmpKeys]);
  async function openDetail(key, tab = '', vc = '') {
    // 다음 점검 ①: 서버 = (법인, 키) 쌍 — 행이 가진 법인을 그대로 · 법인을 모르면(예전 링크 · 키만 담은 목록) 보이는 항목에서 그 키가 한 법인뿐일 때만 채운다
    //   (둘 이상이면 비워 둔다 — 서버가 400 ambiguous-key 로 후보를 주고 상세가 법인 고르기를 보인다).
    let v = String(vc || '');
    // 반증 S2: 엣지 보관분 목록을 받았을 때만 채운다 — 못 받았으면(아직 · 실패) 목록에 이 노드 서버만 있어 엉뚱한 서버를 조용히 연다. 그때는 서버에 맡긴다(모호하면 400 → 법인 고르기).
    const edgesOk = !!edges && edges.ok !== false && Array.isArray(edges.rows);
    if (!v && edgesOk) { const same = perfItems.filter((it) => it.key === String(key)); if (same.length === 1) v = same[0].vcenterId || ''; }
    setPerfSel(key); setPerfVc(v); setPerfTab(tab);
    // 사용률 추이(history)는 이 노드가 수집하는 대상만 있다 — 엣지 위임 서버는 성능 상세만 연다(없는 추이를 404 로 보이지 않게).
    const local = (data?.targets || []).filter((x) => String(x.key) === String(key) && (!v || String(x.vcenterId || '') === v));
    if (local.length !== 1) { setSel(''); setSelVc(''); setDetail(null); return; }
    setSel(key); setSelVc(String(local[0].vcenterId || '')); setDetail(null); setRangeKey('24h');
    await loadDetail(key, '24h', String(local[0].vcenterId || ''));
  }
  /** 상세의 법인 고르기(같은 키 여러 법인 — 서버 후보) — 그 법인으로 다시 연다(탭은 그대로). */
  function pickCorp(vc) { openDetail(perfSel, perfTab, vc); }
  /** 6단계 비교 — 담기 · 빼기(상한은 서버가 준 maxServers · 넘치면 이유를 말한다) · 여러 대를 한 번에 담고 비교 보기로. */
  function pickCmp(ref0) {
    const key = normRef(ref0);   // ‘법인|키’(다음 점검 ①)
    if (cmpKeys.includes(key)) { setCmpKeys(cmpKeys.filter((k) => k !== key)); setCmpMsg(''); return; }
    const r = addKey(cmpKeys, key, cmpMax);
    setCmpMsg(r.error); if (!r.error) setCmpKeys(r.list);
  }
  function compareKeys(keys0) { const keys = (keys0 || []).map(normRef).filter(Boolean); setCmpKeys(keys.slice(0, cmpMax)); setCmpMsg((keys || []).length > cmpMax ? `${cmpMax}대까지 비교합니다 — 앞 ${cmpMax}대만 담았습니다.` : ''); chooseView('compare'); }
  useEffect(() => { fetchJson('/tools/bm-usage/compare/sets').then((r) => { if (Number.isInteger(r?.maxServers)) setCmpMax(r.maxServers); }).catch(() => {}); }, []);
  async function changeRange(rk) {
    setRangeKey(rk);
    if (sel) await loadDetail(sel, rk, selVc);
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
    // v2.628 WEB2628-06: defaultValue 는 마운트 때만 읽힌다 — 서버가 범위로 자른 값(예 999 → 360)을 이 칸에 되돌려 보여 준다.
    const input = e.target;
    saveSettings({ [field]: n * scale }).then((saved) => {
      const v = Number(saved?.[field]);
      if (saved && Number.isFinite(v) && input && input.isConnected) input.value = String(Math.round(v / scale));
    });
  }

  async function saveSettings(patch) {
    setSaving(true);
    try {
      const r = await putJson('/tools/bm-usage/settings', patch);
      loadGen.current += 1; // 진행 중이던 이전 GET 은 저장 전 값이다 — 버린다
      setForm(r.settings); { const warn = scopeSaveSuffix(r) + ignoredCentralNote(r); setMsg({ tone: warn ? 'bad' : 'ok', text: `설정을 저장했습니다.${warn}` }); }
      load();
      return r.settings || null;
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); return null; }
    finally { setSaving(false); }
  }

  /** v2.627 엣지 배포 켬/끔·제외 — 엣지는 다음 인출에 받는다(응답 요약이 그 사실을 말한다). */
  async function saveDistribution(patch) {
    setDistSaving(true);
    try {
      const r = await putJson('/tools/bm-usage/distribute', patch);
      // ⚠ sendJson 은 400·409 를 던지지 않고 본문을 돌려준다 — v2.927 제외 ↔ 중앙 켜기 충돌(409)을 '저장했습니다' 로 보이면 거짓이고 배포 현황이 사라진다.
      if (r?.ok === false) { setMsg({ tone: 'bad', text: r.reason || '저장하지 못했습니다.' }); return; }
      setData((d) => (d ? { ...d, distribution: r.distribution } : d));
      setMsg({ tone: 'ok', text: `엣지 배포 설정을 저장했습니다. ${distributionSummary(r.distribution)}` });
    } catch (e) { setMsg({ tone: 'bad', text: e?.message || String(e) }); }
    finally { setDistSaving(false); }
  }

  /**
   * v2.927 중앙에서 켜기 · 다시 확인 · 해제 — 엣지는 다음 인출에 받는다(응답 문구가 그 사실을 말한다). 실패하면 서버 사유(409 충돌 등)를 그대로 보인다.
   *   켤 때는 확인 상자에 보인 법인 목록(corps)을 함께 보낸다 — 서버가 지금 매핑과 다르면 409 corps-changed(관리자가 본 목록 = 저장 목록).
   */
  async function saveEdgeOn(agent, on, { corps = null, reconfirm = false } = {}) {
    setEdgeOnSaving(agent);
    try {
      const r = await putJson('/tools/bm-usage/distribute/edge', { agent, on, ...(on && Array.isArray(corps) ? { corps } : {}) });
      // ⚠ sendJson 은 400·409 를 던지지 않고 본문을 돌려준다 — 충돌(409)·형식(400)을 성공으로 그리지 않는다(배포 현황을 undefined 로 덮지 않게).
      if (r?.ok === false) {
        // 법인 매핑이 바뀌었으면 화면을 새로 읽는다 — 확인 상자가 새 목록을 보이고 관리자가 다시 저장한다.
        if (r.conflict === 'corps-changed') load();
        throw new Error(r.reason || '저장하지 못했습니다.');
      }
      setData((d) => (d ? { ...d, distribution: r.distribution } : d));
      setMsg({ tone: 'ok', text: edgeOnSavedText(r, { reconfirm }) });
      setEdgeAsk(null);
    } catch (e) {
      // 409(제외·전체 배포·비엣지·매핑 바뀜)·400(법인 0)·403·404 사유는 확인 상자 안에도 남긴다 — 400 폭에서는 상단 메시지가 화면 밖이다.
      const text = e?.message || String(e);
      setMsg({ tone: 'bad', text });
      setEdgeAsk((a) => (a && a.agent === agent ? { ...a, err: text } : a));
    } finally { setEdgeOnSaving(''); }
  }

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;

  const st = data?.status || {};
  // v2.627: 중앙이 배포 중인 엣지는 배포 키 입력을 잠근다(서버도 저장하지 않는다 — Enterprise 칸만 열려 있다).
  const dl = saving || !!data?.central?.managed;
  const selRow = rows.find((r) => r.key === sel) || null;
  /*
   * v2.744(최종 수정분 검토 RV2744F-WEB-03): 서버별 수집 상세는 상세 조회 응답(`usageDetail` — 폴러가 그 서버의 마지막 수집에서 남긴 것)에만 있다.
   *   예전에는 목록 행의 `detail` 을 읽었는데 어떤 응답도 그 필드를 싣지 않아 상세 문구가 한 번도 나오지 않았다. 고른 서버와 다른 응답은 쓰지 않는다.
   *   상세가 없으면(재시작 직후 · 데모 · 옛 서버) 빈 객체 — 문구 함수가 아무것도 지어내지 않는다(이유는 usageDetailNote 가 말한다).
   */
  const detailForSel = detail && (detail.key === sel || detail.target?.key === sel) ? detail : null;
  const ud = detailForSel?.usageDetail && typeof detailForSel.usageDetail === 'object' ? detailForSel.usageDetail : null;
  const udNote = usageDetailNote(detailForSel, { enabled: data?.enabled });
  const fsNote = firstSampleNote(data?.rows || []);
  const skNotes = skippedNotes(data?.skippedCounts || {}, data?.reasons || {});
  /** v2.927 중앙에서 켜기 확인 상자 — 무엇이 바뀌는지(법인 · 주기·보존·경로·알림 값 · 보존 정리)를 저장 전에 말한다. 연 곳(엣지 보관분 표 · 엣지에 배포 표) 아래에 그린다. */
  const edgeAskBox = () => {
    if (!edgeAsk) return null;
    const dr = findDistRow(data?.distribution, edgeAsk.agent);
    const vcName = (id) => (data?.vcenters || []).find((v) => String(v.id) === String(id))?.name || id;
    const lines = edgeAsk.on
      ? edgeOnConfirmLines({ agent: edgeAsk.agent, distRow: dr, dist: data?.distribution, vcName, reconfirm: !!edgeAsk.reconfirm })
      : edgeOffConfirmLines(edgeAsk.agent, dr);
    // 법인을 모르거나 0 이면 저장 버튼을 열지 않는다(조회 실패 상태로 저장 금지 — 서버도 400 no-corps).
    const blocked = edgeAsk.on && !(Array.isArray(dr?.corps) && dr.corps.length);
    return (
      <div className="card" role="dialog" aria-label={edgeAsk.on ? (edgeAsk.reconfirm ? '중앙 켜기 다시 확인' : '중앙에서 켜기 확인') : '중앙 켜기 해제 확인'}
        style={{ marginTop: 10, borderLeft: `3px solid ${toneVar('warn')}`, minWidth: 0 }}>
        {lines.map((l, i) => (
          <p key={i} style={{ margin: i ? '6px 0 0' : 0, fontSize: 12, lineHeight: 1.6 }}><BoldText text={l} /></p>
        ))}
        {edgeAsk.err && <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6, color: toneVar('bad') }}><BoldText text={`저장하지 못했습니다 — ${edgeAsk.err}`} /></p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button className="btn btn-sm bmp-touch" disabled={!!edgeOnSaving || blocked}
            onClick={() => saveEdgeOn(edgeAsk.agent, edgeAsk.on, { corps: dr?.corps, reconfirm: !!edgeAsk.reconfirm })}>
            {edgeOnSaving ? '저장 중…' : (edgeAsk.on ? (edgeAsk.reconfirm ? '이 법인으로 다시 저장' : '중앙에서 켜기 저장') : '중앙 켜기 해제')}
          </button>
          <button className="btn btn-sm bmp-touch" disabled={!!edgeOnSaving} onClick={() => setEdgeAsk(null)}>취소</button>
        </div>
      </div>
    );
  };
  /** 버튼 이름 — edgeOnView 의 actions 낱말. */
  const EDGE_ACTION_LABEL = { on: '중앙에서 켜기', reconfirm: '다시 확인', off: '중앙 켜기 해제' };
  /**
   * v2.927: 엣지 보관분 한 줄 — 보관분 상태 + 중앙에서 켜기 판단(배포 현황은 전체 범위 관리자 · 중앙에만 온다).
   *   중앙 켜기 지시 상태(ev.instr)는 보관분 상태를 **대체하지 않고 함께** 보인다(반증 F8 — 보관분 오래됨·실패가 가려지지 않게).
   */
  const edgeRowView = (r) => {
    const ev = edgeOnView(r, findDistRow(data?.distribution, r.agent), { canManage: !!data?.distribution });
    const es = edgePullState(r, { minEdgeVersion: edges?.minEdgeVersion, staleMs: edges?.staleMs, canEnableCentral: ev.actions.includes('on'), offWhy: ev.offWhy });
    return { es, ev };
  };
  /*
   * v2.959: '엣지 수집' 서버를 엣지별로 — 응답의 제외 목록에서 센다(범위 계정은 서버가 범위 안 행만 준다). 상태는 엣지 보관분 표와 같은 판정(edgeRowView).
   *   표에 그 엣지가 없으면 상태를 지어내지 않는다(edgeDelegatedChip 이 '엣지 보관분 표에 없음' 으로 말한다).
   */
  const edgeRows = Array.isArray(edges?.rows) ? edges.rows : [];
  const edgeDel = edgeDelegatedByAgent(data?.skipped || [], {
    stateOf: (agent) => { const r = edgeRows.find((x) => String(x?.agent || '').trim().toLowerCase() === String(agent).trim().toLowerCase()); return r ? edgeRowView(r).es : null; },
  });

  return (
    <div className="stack" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {error && <ErrorBox error={error} />}

      <div className="card" style={{ minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>베어메탈 사용률</h3>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          <BoldText text={'대상은 **서버 분석 › 구분 › Baremetal(미가상화 물리)** 과 정확히 같은 집합입니다. 디스크·네트워크·HBA 는 **OS 계정이 있는 서버만** 읽을 수 있고, iDRAC 텔레메트리는 CPU·메모리·I/O(집계)까지 줍니다.'} />
        </p>
        {diag?.text && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar(diag.waiting || diag.kind === 'demo' ? 'warn' : (diag.kind === 'ok' ? 'ok' : 'bad')) }}>
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
        {/* 다음 점검 ①(2차): 식별 키가 겹쳐 수집하지 않는 서버 — 조용한 제외 금지(설정의 표에서 사용자가 정한다). */}
        {keyOverlapNote(data?.keyOverlaps) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('warn') }}>
            <BoldText text={keyOverlapNote(data.keyOverlaps)} />
          </p>
        )}
        {/* v2.605 LEFT2605-05: 호스트 미수집 vCenter 때문에 뺀 베어메탈 — 조용히 사라지지 않게 말한다. */}
        {hostsUnreadNote(data?.hostsUnread) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('warn') }}>
            <BoldText text={hostsUnreadNote(data.hostsUnread)} />
          </p>
        )}
        {/* v2.607 LEFT2607-02: 엣지가 일부만 보낸 베어메탈 목록 — 빠진 서버가 조용히 사라지지 않게 말한다. */}
        {fleetPartialsNote(data?.fleetPartials) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('warn') }}>{fleetPartialsNote(data.fleetPartials)}</p>
        )}
        {/* v2.744(감사 후속 FC — EDGE-01): 엣지 iDRAC 등록부 손상으로 중앙이 직전 베어메탈 목록을 유지 중 — 그 엣지 서버 목록이 갱신되지 않는다. */}
        {fleetHeldNote(data?.fleetPartials) && (
          <p style={{ margin: '0 0 6px', fontSize: 13, lineHeight: 1.6, color: toneVar('warn') }}>{fleetHeldNote(data.fleetPartials)}</p>
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
          {/* v2.629 A6-06: 보존 정리는 수집과 무관하게 돈다(v2.628) — 실제로 돌았는지 말한다. */}
          {' '}<BoldText text={lastPruneNote(st.lastPrune)} />
        </p>
      </div>

      <div className="kpis">
        <Kpi label="수집 대상" value={data?.counts?.targets ?? 0} />
        <Kpi label="OS 경로" value={data?.counts?.os ?? 0} />
        <Kpi label="iDRAC 경로" value={data?.counts?.idrac ?? 0} />
        <Kpi label="대상 아님" value={data?.counts?.skipped ?? 0} />
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        {/* v2.920: 보기 전환 — USE 매트릭스(성능 판정) / 사용률 표(기존 다섯 지표). 400 폭에서는 전폭 · 버튼 44px(styles.css .bmp-seg). */}
        <div className="bmp-seg bmp-seg-top" role="tablist" aria-label="보기">
          <button role="tab" aria-selected={view === 'use'} className={view === 'use' ? 'active' : ''} onClick={() => chooseView('use')}>USE 매트릭스</button>
          <button role="tab" aria-selected={view === 'util'} className={view === 'util' ? 'active' : ''} onClick={() => chooseView('util')}>사용률 표</button>
          <button role="tab" aria-selected={view === 'purpose'} className={view === 'purpose' ? 'active' : ''} onClick={() => chooseView('purpose')}>용도 분석</button>
          <button role="tab" aria-selected={view === 'faults'} className={view === 'faults' ? 'active' : ''} onClick={() => chooseView('faults')}>장애 기록</button>
          <button role="tab" aria-selected={view === 'compare'} className={view === 'compare' ? 'active' : ''} onClick={() => chooseView('compare')}>서버 비교{cmpKeys.length ? ` ${cmpKeys.length}` : ''}</button>
          {hasRole('admin', 'operator') && <button role="tab" aria-selected={view === 'health'} className={view === 'health' ? 'active' : ''} onClick={() => chooseView('health')}>수집 건강</button>}
          <button role="tab" aria-selected={view === 'logs'} className={view === 'logs' ? 'active' : ''} onClick={() => chooseView('logs')}>로그 분석</button>
          <button role="tab" aria-selected={view === 'capacity'} className={view === 'capacity' ? 'active' : ''} onClick={() => chooseView('capacity')}>용량 예측</button>
          <button role="tab" aria-selected={view === 'idle'} className={view === 'idle' ? 'active' : ''} onClick={() => chooseView('idle')}>저활용 서버</button>
          <button role="tab" aria-selected={view === 'power'} className={view === 'power' ? 'active' : ''} onClick={() => chooseView('power')}>전력 · 온도</button>
        </div>
        <DeviceFacetBar
          dcChips={barFacets.dcChips} typeChips={barFacets.typeChips} dcSel={dcSel} typeSel={typeSel}
          onToggleDc={(v) => setDcSel((p) => toggleIn(p, v))}
          onToggleType={(v) => setTypeSel((p) => toggleIn(p, v))}
          onClear={() => { setDcSel(new Set()); setTypeSel(new Set()); setQ(''); }}
          query={q} onQuery={setQ} typeLabel={pathTypeLabel}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
          {canCsv() && <button className="btn" onClick={exportCsv} disabled={!shown.length}>CSV 내보내기</button>}
          <button className="btn" onClick={collectNow} disabled={busy || !data?.enabled} title={data?.enabled ? '' : '수집이 꺼져 있습니다'}>
            {busy ? '수집 중…' : '지금 수집'}
          </button>
          <button className="btn" onClick={load}>새로고침</button>
          <button className="btn" onClick={() => setShowSettings((v) => !v)}>{showSettings ? '설정 닫기' : '설정'}</button>
          {showSettings && !form && (
            <span role="status" style={{ fontSize: 12, color: toneVar('warn') }}>
              {loading ? '설정값을 읽는 중…' : `설정값을 받지 못했습니다${error ? ` — ${String(error).slice(0, 160)}` : ''}. `}
              {!loading && <button className="btn btn-sm" type="button" onClick={load}>다시 읽기</button>}
            </span>
          )}
          {showSettings && form && (
            <button className="btn btn-sm" type="button" onClick={() => settingsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}>수집 설정으로 이동 ↓</button>
          )}
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            마지막 수집 {ageText(st.last?.at)} · 주기 {st.intervalMs ? `${Math.round(st.intervalMs / 60000)}분` : '—'} · 동시 {st.concurrency ?? '—'}
            {st.last?.alerts && (st.last.alerts.sent > 0 || st.last.alerts.over > 0) && (
              <> · 알림 {st.last.alerts.sent}건 발송{st.last.alerts.capped > 0 && ` (상한으로 ${st.last.alerts.capped}건 생략)`}</>
            )}
          </span>
        </div>

        {/* v2.629 A6-06: 이번 주기 입력(등록부·분류)을 못 읽었으면 표가 있어도 말한다 — 제외 사유가 틀릴 수 있다. */}
        {sourceErrorsNote(st.last) && (
          <div className="banner warn" style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 }}>
            <BoldText text={sourceErrorsNote(st.last).head} />
            {sourceErrorsNote(st.last).items.map((x, i) => <div key={i} style={{ overflowWrap: 'anywhere' }}>· {x}</div>)}
          </div>
        )}
        {view === 'util' && (<>
          {/* ⚠ 표는 **가로 스크롤 컨테이너**로 감싼다 — 지표 열이 8개라 400px 에서 페이지를 밀어낸다. */}
          <div style={{ overflowX: 'auto', minWidth: 0 }}>
            {/* v2.945.1(릴리스 검증 — 기존 결함): 12열 표가 1440 에서 1164 > 영역 1118 이라 마지막 ‘수집’ 열이 숨었다 — 글자 12px · 머리 줄바꿈 허용. */}
            <STable className="bmu-util" style={{ fontSize: 12 }}>
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
                        onClick={() => openDetail(r.key, '', r.vcenterId || '')}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.key, '', r.vcenterId || ''); } }}
                        style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
                      >{r.name}</span>
                      {r.role === 'virt' && <span title="ESXi(가상화) 호스트 — 설정의 'ESXi 호스트도 iDRAC 로 수집' 으로 들어온 서버입니다" style={{ marginLeft: 6, fontSize: 10, padding: '0 5px', borderRadius: 4, border: '1px solid var(--border)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>ESXi</span>}
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
                      <td key={c.col} className="right" data-sort={r[c.col] ?? ''}><Cell v={r[c.col]} kind={c.kind} /></td>
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
          {/* v2.744(감사 LEFT-08 ②): HBA 사용률 분모 근거 — 보이는 행 기준 각주 1회(근거가 없으면 그리지 않는다) */}
          {hbaBasisFootnote(shown) && (
            <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={hbaBasisFootnote(shown)} /></p>
          )}
          <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'‘—’ 는 **못 읽은 것**이고 0% 가 아닙니다. 디스크·네트워크·HBA 의 값은 그 서버에서 **가장 높은 장치·회선** 기준입니다(평균을 쓰면 한 디스크가 가득 찬 서버가 낮게 보입니다). 네트워크·HBA 사용률(%)은 전이중이라 **방향별(수신·송신 중 큰 쪽)** ÷ 링크 속도이고, 처리량(B/s)은 두 방향의 합입니다.'.replace(/`/g, '')} />
          </p>
        </>)}
      </div>

      {/* v2.920: USE 매트릭스 보드(신뢰 띠 · KPI · 매트릭스 · 병목 Top) — 이 노드 대상 + 엣지 보관분. */}
      {view === 'use' && (
        <BmPerfBoard
          items={perfShown} th={data?.perfThresholds || null} intervalMs={st.intervalMs ?? data?.settings?.intervalMs}
          authStops={perfAuthStops} staleMs={edges?.staleMs ?? null} corpOff={data?.skippedCounts?.['corp-off'] || 0}
          onOpen={openDetail} selKey={perfSel ? refOf(perfSel, perfVc) : ''} perfError={data?.perfError || ''}
          cmpKeys={cmpKeys} onPickCmp={pickCmp} onCompare={compareKeys} cmpMsg={cmpMsg}
        />
      )}
      {view === 'health' && hasRole('admin', 'operator') && <BmCollectHealth />}
      {view === 'compare' && (
        <BmCompareView keys={cmpKeys} onKeys={(k) => { setCmpKeys(k); setCmpMsg(''); }} onOpen={(ref) => { const p = parseRef(ref); openDetail(p.key, '', p.vc); }}
          key={shareInit?.view === 'compare' ? `share|${shareInit.keys.join(',')}` : 'cmp'}
          initial={shareInit?.view === 'compare' ? { view: shareInit.cv, group: shareInit.group, value: shareInit.value, range: shareInit.range, cross: shareInit.cross, metric: shareInit.metric } : {}}
          names={Object.fromEntries(perfItems.map((it) => [refOf(it.key, it.vcenterId), it.name]))} />
      )}
      {/* v2.920: 서버 성능 상세(머리 · 판정 띠 · 탭 요약/자원/하드웨어) — 사용률 추이는 아래 기존 상세 카드에 그대로. */}
      {/* v2.923: 함대 보기 — 서버를 누르면 아래 상세가 그 탭으로 열린다. */}
      {view === 'purpose' && <BmPurposeFleet onOpen={(k, vc) => openDetail(k, 'profile', vc)} onCompare={compareKeys} />}
      {view === 'faults' && <BmFaultsFleet onOpen={(k, vc) => openDetail(k, 'faults', vc)} />}
      {/* 7a단계: 로그 분석 함대(KPI · 공통 원인 후보 · 서버 표) — 서버를 누르면 상세 ‘로그’ 탭. */}
      {view === 'logs' && <BmLogsFleet onOpen={(k, vc) => openDetail(k, 'logs', vc)} />}
      {view === 'capacity' && <BmCapacityFleet onOpen={(k, vc) => openDetail(k, 'summary', vc)} />}
      {/* 8b단계: 저활용(점수 · 검토 상태 · 비교로 보내기) · 전력 · 온도(법인 · 랙 · 미매핑 · 더운 서버) — 서버를 누르면 상세 요약 탭. */}
      {view === 'idle' && <BmIdleFleet onOpen={(k, vc) => openDetail(k, 'summary', vc)} onCompare={compareKeys} />}
      {view === 'power' && <BmPowerFleet onOpen={(k, vc) => openDetail(k, 'summary', vc)} />}
      {perfSel && (
        <BmPerfDetail
          itemKey={perfSel} itemVc={perfVc} onPickCorp={pickCorp} item={(() => { const c = perfItems.filter((it) => it.key === perfSel && (!perfVc || it.vcenterId === perfVc)); return c.length === 1 ? c[0] : null; })()} initialTab={perfTab}
          authStops={perfAuthStops} staleMs={edges?.staleMs ?? null}
          keepDays={{ server: data?.settings?.dailyRetentionDays ?? null, dev: data?.settings?.store?.devHourlyDays ?? null }}
          onClose={() => { setPerfSel(''); setPerfVc(''); }}
          inCompare={cmpKeys.includes(refOf(perfSel, perfVc))} onCompareToggle={() => pickCmp(refOf(perfSel, perfVc))} cmpMsg={cmpMsg} shareInit={shareInit?.view === 'detail' ? shareInit : null}
        />
      )}

      {/* ── 상위 N + 법인별 집계(v2.551) ─────────────────────────────────────── */}
      {view === 'util' && !!shown.length && (
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
                          <span role="button" tabIndex={0} onClick={() => openDetail(r.key, '', r.vcenterId || '')}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.key, '', r.vcenterId || ''); } }}
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
                        <td className="right" data-sort={c.max ?? ''}><span style={{ color: toneVar(usageTone(c.max)) }}>{pctText(c.max)}</span></td>
                        <td className="right" data-sort={c.avg ?? ''}>{pctText(c.avg)}</td>
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
          {/* v2.959 엣지 수집 — 엣지별 대수 · 그 엣지의 보관분 상태 · 엣지 표로 이동 */}
          {showSkipped && !!edgeDel.length && (
            <div style={{ margin: '8px 0 0', minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>엣지 수집 — 엣지별</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4, minWidth: 0 }}>
                {edgeDel.map((x) => (
                  <span key={x.agent || '-'} className="badge" title={x.state?.why ? String(x.state.why).replace(/\*\*/g, '') : ''}
                    style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, border: `1px solid ${toneVar(x.state?.tone || 'idle')}`, color: 'inherit', minWidth: 0, overflowWrap: 'anywhere' }}>
                    {edgeDelegatedChip(x)}
                  </span>
                ))}
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}><BoldText text={edgeDelegatedGuide(edgeDel)} /></p>
              {!!edgeRows.length && (
                <button type="button" className="btn btn-sm bmp-touch" style={{ marginTop: 6 }} onClick={() => { setShowEdges(true); setEdgeJump((v) => v + 1); }}>
                  엣지 보관분 표로 이동 ↓
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 엣지 보관분(v2.554) — 상시 전송 없음. 누를 때만 가져온다 ─────────── */}
      {!!(edges?.rows || []).length && (
        <div className="card" style={{ minWidth: 0 }} ref={edgesRef}>
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
                    {(edges.rows || []).map((r, i) => {
                      const { es, ev } = edgeRowView(r);
                      return (
                        <tr key={`${i}-${r.agent}`}>
                          <td data-sort={r.agent}>
                            {r.agent}
                            {/* ⚠ 엣지가 말한 이름이 다르면 **나란히** 보여준다 — 그 자체가 진단이다(v2.548 F5). */}
                            {r.reportedAgent && r.reportedAgent !== r.agent && (
                              <div style={{ fontSize: 11, color: toneVar('warn') }}>엣지 보고 이름 {r.reportedAgent}</div>
                            )}
                          </td>
                          <td data-sort={es.state}>
                            <span style={{ color: toneVar(es.tone) }}>{es.label}</span>
                            {/* v2.927: 중앙 켜기 지시 상태는 보관분 상태와 **함께**(대체하지 않는다 — 반증 F8). */}
                            {ev.instr && <div style={{ fontSize: 11, color: toneVar(ev.instr.tone) }}>중앙 켜기 · {ev.instr.label}</div>}
                          </td>
                          <td className="right" data-sort={(r.targets || []).length}>{r.snapAt ? (r.targets || []).length : '—'}</td>
                          <td data-sort={r.version || ''}>{r.version || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                          <td data-sort={r.snapAt || 0}>{r.snapAt ? ageText(r.snapAt) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <button className="btn btn-sm bmp-touch" onClick={() => pullEdge(r.agent)} disabled={!!pulling || r.enabled === false || !r.hasUrl}
                                title={r.enabled === false ? '중앙에서 비활성으로 두었습니다' : (!r.hasUrl ? 'URL 이 없습니다' : '')}>
                                {pulling === r.agent ? '가져오는 중…' : '지금 가져오기'}
                              </button>
                              {/* v2.927 중앙에서 켜기 — 전체 범위 관리자 · 중앙에만(서버가 배포 현황을 줄 때만). 누르면 표 아래 확인 상자. */}
                              {ev.actions.map((a) => (
                                <button key={a} className="btn btn-sm bmp-touch" disabled={edgeOnSaving === r.agent}
                                  onClick={() => setEdgeAsk({ agent: r.agent, on: a !== 'off', reconfirm: a === 'reconfirm', where: 'edges' })}>
                                  {edgeOnSaving === r.agent ? '저장 중…' : EDGE_ACTION_LABEL[a]}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
              {/* ⚠ 사유는 **행 아래 한 번씩** — 표 안에 긴 문장을 넣으면 셀이 세로로 길어진다(v2.509). */}
              {/* v2.945.1(사용자 보고 — 같은 엣지 안내가 십여 줄 반복): 이름별 한 줄 · 키에 위치를 넣어 겹치지 않게(같은 키는 React 가 옛 줄을 남길 수 있다) ·
                  같은 이름이 등록부에 여러 개면 그 수를 밝힌다(조용히 합치지 않는다). */}
              {edgeNoteRows(edges.rows).map(({ r, dup }, i) => {
                const { es, ev } = edgeRowView(r);
                const parts = [es.state === 'ok' ? '' : es.why, ev.instr ? `중앙 켜기: ${ev.instr.why}` : '', ev.note, dup > 1 ? `(같은 이름이 등록부에 **${dup}개** 있습니다 — 설정 › 수집 서버(원격)에서 확인하세요)` : ''].filter(Boolean);
                if (!parts.length) return null;
                return (
                  <p key={`why-${i}-${r.agent}`} style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                    <BoldText text={`**${r.agent}** — ${parts.join(' ')}`} />
                  </p>
                );
              })}
              {edgeAsk?.where === 'edges' && edgeAskBox()}
            </>
          )}
        </div>
      )}

      {showSettings && form && (
        <div className="card" ref={settingsRef} style={{ minWidth: 0, scrollMarginTop: 72 }}>
          <h4 style={{ marginTop: 0 }}>수집 설정</h4>
          {centralManagedNote(data?.central, fmtAgo) && (
            <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.6, color: toneVar('warn') }}><BoldText text={centralManagedNote(data.central, fmtAgo)} /></p>
          )}
          <label style={{ display: 'block', fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} disabled={dl} />
            {' '}수집 켜기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'**법인을 하나씩 켜세요** — 한꺼번에 켜면 주기마다 SSH·Redfish 세션이 수백 개 열립니다. 회선·장비 부하를 보면서 늘리는 것이 이 설정의 목적입니다.'} />
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 6, marginBottom: 10 }}>
            {(data?.vcenters || []).map((v) => (
              <label key={v.id} style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <input
                  type="checkbox" disabled={dl}
                  checked={!!(form.corps || {})[v.id]}
                  onChange={(e) => saveSettings({ corps: { ...(form.corps || {}), [v.id]: e.target.checked } })}
                />
                {' '}{v.name}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>주기(분){' '}
              <input type="number" key={`v-${String(Math.round((form.intervalMs || 0) / 60000))}`} min={1} max={360} defaultValue={Math.round((form.intervalMs || 0) / 60000)} disabled={dl}
                onBlur={(e) => numBlur(e, 'intervalMs', 60000)} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>원시 보존(일){' '}
              <input type="number" key={`v-${String(form.rawRetentionDays)}`} min={7} max={365} defaultValue={form.rawRetentionDays} disabled={dl}
                onBlur={(e) => numBlur(e, 'rawRetentionDays')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>롤업 보존(일){' '}
              <input type="number" key={`v-${String(form.dailyRetentionDays)}`} min={30} max={3650} defaultValue={form.dailyRetentionDays} disabled={dl}
                onBlur={(e) => numBlur(e, 'dailyRetentionDays')} style={{ width: 80, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.osSsh} onChange={(e) => saveSettings({ osSsh: e.target.checked })} disabled={dl} /> OS SSH
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.idracTelemetry} onChange={(e) => saveSettings({ idracTelemetry: e.target.checked })} disabled={dl} /> iDRAC 텔레메트리
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.includeUnassigned} onChange={(e) => saveSettings({ includeUnassigned: e.target.checked })} disabled={dl} /> 법인 귀속 없는 서버도 포함
            </label>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!!form.includeVirtualization} onChange={(e) => saveSettings({ includeVirtualization: e.target.checked })} disabled={dl} /> ESXi 호스트도 iDRAC 로 수집
            </label>
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={esxiCollectNote(form)} />
          </p>

          {/* ── iDRAC 텔레메트리 전수 모드(v2.551) ──────────────────────────── */}
          <h4 style={{ margin: '14px 0 6px' }}>iDRAC 텔레메트리</h4>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
            <input type="checkbox" checked={!!form.idracFullTelemetry} onChange={(e) => saveSettings({ idracFullTelemetry: e.target.checked })} disabled={dl} />
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
                  <Select sort={false} value={form.enterpriseMode || 'auto'} disabled={saving}
                    onChange={(e) => saveSettings({ enterpriseMode: e.target.value })} style={{ minWidth: 0 }}>
                    <option value="auto">자동 — Redfish 센서 먼저, 못 읽으면 SSH</option>
                    <option value="api">Redfish 센서만(부하 가장 적음)</option>
                    <option value="ssh">iDRAC SSH(racadm)만</option>
                  </Select>
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
            <input type="checkbox" checked={!!form.alertEnabled} onChange={(e) => saveSettings({ alertEnabled: e.target.checked })} disabled={dl} />
            {' '}알림 켜기
          </label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'⚠ **기본 꺼짐**입니다 — 대상이 많고 주기가 짧아 한 번 튄 값으로 알리면 야간에 수백 통이 나갑니다. 그래서 **지속 시간**을 넘겨야 알리고, 같은 서버·같은 지표는 **재알림 간격** 안에 다시 보내지 않으며, 임계 아래로 내려오면 해제를 **1회** 알립니다. 채널은 설정 › 알림(Slack·Webhook·메일)을 그대로 씁니다.'} />
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 12 }}>임계(%){' '}
              <input type="number" key={`v-${String(form.alertPct)}`} min={50} max={100} defaultValue={form.alertPct} disabled={dl}
                onBlur={(e) => numBlur(e, 'alertPct')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>지속(분){' '}
              <input type="number" key={`v-${String(form.alertSustainMin)}`} min={0} max={240} defaultValue={form.alertSustainMin} disabled={dl}
                onBlur={(e) => numBlur(e, 'alertSustainMin')} style={{ width: 70, minWidth: 0 }} />
            </label>
            <label style={{ fontSize: 12 }}>재알림 간격(시간){' '}
              <input type="number" key={`v-${String(form.alertRepeatHours)}`} min={1} max={168} defaultValue={form.alertRepeatHours} disabled={dl}
                onBlur={(e) => numBlur(e, 'alertRepeatHours')} style={{ width: 80, minWidth: 0 }} />
            </label>
            {data?.status?.fleetCountsHidden && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>범위 계정에는 함대 전체의 수집 대수·실패 대수를 표시하지 않습니다.</div>
            )}
            {data?.status?.alertState && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                추적 중 {data.status.alertState.tracked}건 · 알린 것 {data.status.alertState.notified}건
              </span>
            )}
          </div>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
            <BoldText text={'감시 지표는 **퍼센트 지표 6개**(CPU·메모리·디스크 I/O·디스크 공간·네트워크·HBA)입니다 — 처리량(B/s)은 장비마다 정상 범위가 달라 임계를 정하지 않습니다. **못 읽은 주기는 초과도 정상도 아닙니다**(판정 보류).'} />
          </p>

          {/* ── v2.929(5단계) 리눅스 성능 알림 규칙 · 집중 모니터링 · 베이스라인 · 소모품 기준 — 별도 파일(bm-perf-rules.json) · 저장은 설정 소유자 ── */}
          <BmPerfRulesPanel vcenters={data?.vcenters || []} />

          {/* ── 8a단계 정비 창 · 알림 억제(중앙 저장 → 엣지 배포 · 쓰기는 운영자 이상 · 법인/태그/긴 창은 설정 소유자 등급) ── */}
          <BmMaintPanel vcenters={data?.vcenters || []} />

          {/* ── 7b단계 서버 등록 · SSH 키 저장소 · 공통 계정 · 엣지 배포 목록 · 누락 점검(관리자) ── */}
          <BmOnboardPanel vcenters={data?.vcenters || []} />

          {/* ── 다음 점검 ①(2차): 식별 키가 겹쳐 분류가 한 대만 남긴 서버 — 사용자가 수집에 추가 · 제외 유지 · 되돌리기(운영자 이상 + 그 법인 쓰기 범위) ── */}
          <BmKeyOverlaps />

          {/* ── 엣지에 배포(v2.627) — 중앙의 전체 범위 관리자에게만 온다(서버가 distribution 을 null 로 준다). ── */}
          {data?.distribution && (
            <>
              <h4 style={{ margin: '14px 0 6px' }}>엣지에 배포</h4>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                <input type="checkbox" checked={!!data.distribution.enabled} disabled={distSaving}
                  onChange={(e) => saveDistribution({ enabled: e.target.checked })} />
                {' '}이 설정을 모든 엣지에 배포(한 번에 켜기)
              </label>
              <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={distributionSummary(data.distribution)} /></p>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}><BoldText text={DIST_ENTERPRISE_NOTE} /></p>
              {/* v2.927: 중앙 켜기(이 엣지만) 엣지 목록 — 전체 배포가 꺼져 있어도 이 엣지들은 중앙 값을 받는다. */}
              {(data.distribution.rows || []).some((r) => r.perEdge) && (
                <p style={{ margin: '0 0 8px', fontSize: 12, lineHeight: 1.6 }}>
                  <BoldText text={`**중앙 켜기(이 엣지만)**: ${data.distribution.rows.filter((r) => r.perEdge).map((r) => `${r.agent}(${r.mode === 'per-edge' ? distStateOf(r.state).label : distModeLabel(r.mode)})`).join(' · ')} — 켜기는 '엣지 보관분' 표의 버튼으로, 다시 확인 · 해제는 그 표나 아래 표의 버튼으로 합니다.`} />
                </p>
              )}
              {(data.distribution.rows || []).length > 0 && (
                <STable className="v3-table" minWidth={620} style={{ fontSize: 12 }}>
                  <thead><tr><th>엣지</th><th>모드</th><th>상태</th><th>마지막 인출</th><th data-nosort>제외</th></tr></thead>
                  <tbody>
                    {data.distribution.rows.map((r) => {
                      const ds = distStateOf(r.state);
                      return (
                        <tr key={r.agent}>
                          <td>{r.agent}</td>
                          <td data-sort={r.mode || ''}>{distModeLabel(r.mode)}{r.perEdgeSuperseded ? ' (중앙 켜기 가려짐)' : ''}{r.conflict ? ' (제외와 충돌)' : ''}
                            {r.perEdge && r.corpsChanged === true && r.mode === 'per-edge' && <div style={{ fontSize: 11, color: toneVar('warn') }}>법인 매핑이 바뀜 — 다시 확인 필요</div>}
                            {r.perEdge && (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                                {r.corpsChanged === true && r.mode === 'per-edge' && (
                                  <button className="btn btn-sm bmp-touch" disabled={!!edgeOnSaving}
                                    onClick={() => setEdgeAsk({ agent: r.agent, on: true, reconfirm: true, where: 'dist' })}>다시 확인</button>
                                )}
                                <button className="btn btn-sm bmp-touch" disabled={!!edgeOnSaving}
                                  onClick={() => setEdgeAsk({ agent: r.agent, on: false, where: 'dist' })}>중앙 켜기 해제</button>
                              </div>
                            )}</td>
                          <td title={ds.why} style={{ color: toneVar(ds.tone) }}>{ds.label}</td>
                          <td data-sort={r.lastPullAt || 0}>{r.lastPullAt ? fmtAgo(r.lastPullAt) : '—'}
                            {lapsedVerifiedNote(r, fmtAgo) && <div className="muted" style={{ fontSize: 11 }}>{lapsedVerifiedNote(r, fmtAgo)}</div>}</td>
                          <td>
                            {/* v2.927: 중앙 켜기가 저장된 엣지는 제외할 수 없다(반대 지시 — 서버도 409). 중앙 켜기를 먼저 해제한다. */}
                            <input type="checkbox" checked={!!r.excluded} disabled={distSaving || (!!r.perEdge && !r.excluded)}
                              title={r.perEdge && !r.excluded ? '중앙 켜기가 저장된 엣지입니다 — 중앙 켜기를 먼저 해제하세요' : ''}
                              onChange={(e) => saveDistribution({ excluded: { ...(data.distribution.excluded || {}), [r.agent.toLowerCase()]: e.target.checked } })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              )}
              {edgeAsk?.where === 'dist' && edgeAskBox()}
            </>
          )}
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
          {/* v2.600: 비-admin 에는 iDRAC·OS 주소가 비어 온다 — 왜 없는지 한 번 말한다. */}
          {addressHiddenNote(data) && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}>🔒 <BoldText text={addressHiddenNote(data)} /></p>
          )}
          {/* iDRAC 이 무엇을 지원하는지 장비별로 밝힌다(v2.551 — 사용자 선택). */}
          {/* v2.744(RV2744F-WEB-03): 수집 상세가 언제 것인지 · 왜 없는지(재시작 직후 · 데모) — 없는 상세를 지어내지 않는다. */}
          {udNote && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}><BoldText text={udNote} /></p>
          )}
          {telemetryNote(ud || {}) && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={telemetryNote(ud || {})} /></p>
          )}
          {/* 대상(target — 라이선스 등)과 수집 상세(ud)를 겹친다. 상세가 없으면 대상만이라 상세 문구는 나오지 않는다. */}
          {(ud ? detailNotes({ ...(detailForSel?.target || {}), ...ud }) : []).map((s, i) => (
            <p key={i} style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={s} /></p>
          ))}
          {/* 라이선스 — **언제 본 값인지** 함께(인벤토리는 느린 주기로 갱신된다). */}
          {licenseNote(detailForSel?.target?.license || selRow.license) && (
            <p style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={licenseNote(detailForSel?.target?.license || selRow.license)} /></p>
          )}
          {entDetailNotes(ud || {}).map((x, i) => (
            <p key={`ent${i}`} style={{ margin: '0 0 6px', fontSize: 12, lineHeight: 1.6 }}><BoldText text={x} /></p>
          ))}
          {/*
            * ⚠⚠ **원문을 그대로 보여주는 것이 이 기능의 정직성 장치다**(v2.542 `cliRaw` 규약):
            *   이 현장 racadm 출력 형식을 확인한 적이 없어 파싱이 빗나갈 수 있다. 그때 사용자가
            *   실제 출력을 보고 알려줄 수 있어야 한다 — '읽지 못했습니다' 만 남기면 추측만 남는다.
            */}
          {!!ud?.entRaw && (
            <details style={{ margin: '0 0 8px' }}>
              <summary style={{ fontSize: 12, cursor: 'pointer' }}>iDRAC SSH(racadm) 원문 보기</summary>
              <pre style={{ margin: '6px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflow: 'auto', background: 'rgba(0,0,0,0.25)', padding: 8, borderRadius: 4 }}>{ud.entRaw}</pre>
            </details>
          )}
          {detail?.rawTruncated && (
            <p style={{ margin: '0 0 6px', fontSize: 12, color: toneVar('warn'), lineHeight: 1.6 }}>
              <BoldText text={'조회 상한으로 **일부 구간이 잘렸습니다** — 더 긴 기간은 일 단위 롤업으로 보세요.'} />
            </p>
          )}
          {!detail && !detailErr && <p style={{ fontSize: 12, color: 'var(--muted)' }}>추이를 불러오는 중…</p>}
          {!detail && detailErr && (
            <p style={{ fontSize: 12, color: toneVar('bad'), lineHeight: 1.6 }}>추이를 읽지 못했습니다: {detailErr}</p>
          )}
          {detail && !detail.raw?.length && !detail.daily?.length && (
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>저장된 추이가 없습니다 — 아직 수집되지 않았거나 이 서버의 값을 읽지 못했습니다.</p>
          )}
          {/* 추이 차트 — 판정·좌표는 순수 모듈이 갖는다. 롤업 표는 그 아래에 남긴다(수치 대조용). */}
          <React.Suspense fallback={<p style={{ fontSize: 12, color: 'var(--muted)' }}>차트를 불러오는 중…</p>}>
            <BmUsageChart
              raw={detail?.raw || []} daily={detail?.daily || []}
              rawTruncated={!!detail?.rawTruncated}
              intervalMs={data?.status?.intervalMs}
              absent={[...(ud?.idracAbsent || []), ...(ud?.osAbsent || [])]}
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
                      <td className="right" data-sort={d.cpu_avg ?? ''}>{pctText(d.cpu_avg)}</td>
                      <td className="right" data-sort={d.cpu_max ?? ''}>{pctText(d.cpu_max)}</td>
                      <td className="right" data-sort={d.mem_avg ?? ''}>{pctText(d.mem_avg)}</td>
                      <td className="right" data-sort={d.mem_max ?? ''}>{pctText(d.mem_max)}</td>
                      <td className="right" data-sort={d.disk_busy_max ?? ''}>{pctText(d.disk_busy_max)}</td>
                      <td className="right" data-sort={d.net_max ?? ''}>{pctText(d.net_max)}</td>
                      <td className="right" data-sort={d.hba_max ?? ''}>{pctText(d.hba_max)}</td>
                      <td className="right" data-sort={d.samples ?? ''}>{d.samples ?? '—'}</td>
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
