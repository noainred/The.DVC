import React, { useEffect, useMemo, useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';   // v2.447: 서버 문구의 **강조** 별표 노출 방지(감사 I6)
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { fetchJson, postJson, delJson } from '../../api.js';
import { MODES, bucketText, perfQuery, toLocalDt, rangeIssueOf, rangeLabel, RANGE_MAX_DAYS } from './sanSwitchPerfText.js';
import { statusText, traceText, isActive, phaseLabel } from './sanSwitchTestText.js';
import SanZoningPanel from './SanZoningPanel.jsx';
import { Loading, ErrorBox, Kpi, UsageCell, Modal, SearchBox } from '../../components/ui.jsx';
import { stateLabel, stateTone, opticalHealth, errorLevel, capacityLevel, aggregate,
  throughputText, throughputTitle, filterPorts, shortDeviceName, saturationPct, saturationLevel, bytesPerSecText,
  toChartRows, topSeries, bps, sortPorts, nextSort, sortRows, seriesStats,
  RX_WARN_DBM, RX_BAD_DBM, alertsMeta, usedPctText, switchesMeta } from './sanSwitchPorts.js';
import { STable } from '../../components/STable.jsx';
import BulkDeviceIo from './BulkDeviceIo.jsx';
import CollectActivity from './CollectActivity.jsx';
import { perfDiagText, diagBorder, perfCollectSummary } from './sanPerfDiagText.js';
import { portsScopeNote } from './sanPortsScopeText.js';
import { DeviceHealthPanel, AllHealthCheck } from './SanHealthCheck.jsx';
import { authStopInfo, authStopSummary, credFpText } from './storageAuthText.js'; // v2.590: 인증 실패 정지 안내(도구 공통)
import { collectDropNote } from './collectDropText.js'; // v2.591: 결과 없이 폐기된 위임 '지금 수집' 요청

/**
 * 특수기능 › SAN 스위치 모니터링(v2.410 — 사용자 요구 'Brocade SAN switch 포트 모니터링 및
 * 용량 모니터링').
 *
 * '용량'의 뜻: SAN 스위치에는 저장 용량이 없다. 여기서 용량은 **포트 용량**이다 —
 * 라이선스(POD)로 쓸 수 있는 포트가 몇 개인지, 그중 몇 개가 실제로 물려 있는지, 몇 개가
 * 남았는지. 이 값이 신규 서버·어레이를 더 붙일 수 있는지를 결정한다.
 * ⚠ 라이선스 없는 포트(No_License)는 **여유에서 뺀다** — 살 수 없는 포트를 여유로 세면
 *   증설 판단이 틀린다(판정 규칙은 sanSwitchPorts.js·types.js summarizePorts 에 고정).
 *
 * 데이터 흐름은 스토리지 모니터링과 같다: 중앙 등록 → 엣지가 pull → 현지 수집 → 중앙 push.
 * 조회는 전체 범위 계정 전용(서버 403), 등록/수정/삭제/테스트는 admin.
 */

const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : `${Math.round(s / 3600)}시간 전`;
};
const TONE = { ok: 'var(--green, #22c55e)', warn: 'var(--amber, #f59e0b)', bad: 'var(--red, #ef4444)', muted: 'var(--muted, #94a3b8)' };
// 고정 폭 셀에서 긴 값이 옆 칸을 덮지 않게 하는 한 줄 말줄임(전문은 각 셀의 title 툴팁).
const ELLIPSIS = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** 수집 실패 사유 한 줄 — 부분 실패(섹션만 오류)여도 사유가 반드시 드러나게. */
function failReason(s) {
  if (!s) return '수집 기록 없음';
  return s.error
    || Object.entries(s.sections || {}).filter(([, v]) => v && v !== 'ok' && v !== 'skip').map(([k, v]) => `${k}: ${v}`).join(' · ')
    || '알 수 없는 오류';
}

const EMPTY_FORM = { type: 'brocade', name: '', host: '', username: 'admin', password: '',
  collectMethod: 'ssh', sshPort: 22, agent: '', datacenterId: '', vfId: '', note: '', enabled: true };

export default function SanSwitchTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지 — CLAUDE.md).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [dcSel, setDcSel] = useState(() => new Set());
  const [form, setForm] = useState(null);          // null = 폼 닫힘
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  const [detail, setDetail] = useState(null);      // 포트 상세 모달 { device, ports, ... }
  const detailSeq = useRef(0);
  const testTimer = useRef(null);                  // 연결 테스트 폴링 타이머(v2.421) — 훅은 조기 return 위에
  const [dcPerf, setDcPerf] = useState(null);      // 법인 단위 스토리지 사용량 분석 모달
  const [bulkOpen, setBulkOpen] = useState(false);  // 대량 등록 모달(v2.513) — 훅은 조기 return 위에
  const [healthOpen, setHealthOpen] = useState(false); // 전체 점검 모달(v2.519) — 훅은 조기 return 위에
  const [portFilter, setPortFilter] = useState('all');
  const [portQ, setPortQ] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);   // 장비 일반 정보 펼침
  const [tab, setTab] = useState('ports');           // 포트 목록 / 사용량 분석
  const [sort, setSort] = useState({ key: 'index', dir: 'asc' });  // 표 정렬(제목 클릭)
  useEffect(() => () => { if (testTimer.current) clearInterval(testTimer.current); }, []); // 언마운트 시 테스트 폴링 정리

  const load = async () => {
    try { setData(await fetchJson('/tools/sanswitch')); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const dcName = useMemo(() => {
    const m = new Map((data?.datacenters || []).map((d) => [d.id, d.name || d.id]));
    return (id) => m.get(id) || id || '(법인 미지정)';
  }, [data]);
  // 칩은 법인 '이름'으로 고르는데 서버는 id 로 거른다 — 역방향 표를 하나 둔다.
  const dcIdOfName = useMemo(() => {
    const m = new Map((data?.datacenters || []).map((d) => [d.name || d.id, d.id]));
    // '(법인 미지정)' 은 서버 센티널 '__none__' 로 보낸다 — '' 는 쉼표 목록에서 사라져 전체로 둔갑했다(v2.417).
    return (name) => (name === '(법인 미지정)' ? '__none__' : (m.get(name) || ''));
  }, [data]);

  const rows = data?.devices || [];
  const searched = rows.filter((r) => {
    if (!q.trim()) return true;
    const s = q.trim().toLowerCase();
    return [r.name, r.host, r.agent, dcName(r.datacenterId), r.snap?.model, r.snap?.fabricOs]
      .some((v) => String(v || '').toLowerCase().includes(s));
  });
  const shown = searched.filter((r) => dcSel.size === 0 || dcSel.has(dcName(r.datacenterId)));
  // 칩은 검색 결과가 아니라 **등록 전체**에서 파생한다 — 검색어로 어떤 법인이 걸러지면 그 법인의
  // 활성 칩이 화면에서 사라져 해제할 수단이 없어진다(v2.416 리뷰 확정).
  const dcChips = [...new Set(rows.map((r) => dcName(r.datacenterId)))].sort((a, b) => a.localeCompare(b));
  const agg = aggregate(shown);

  if (error && !data) return <ErrorBox message={error} />;   // 데이터 보유 중 폴링 오류로 화면을 갈아치우지 않음
  if (!data) return <Loading />;

  const openForm = (r) => setForm(r
    ? { ...EMPTY_FORM, ...r, password: '', vfId: r.vfId ?? '' }
    : { ...EMPTY_FORM, agent: '', datacenterId: data.datacenters?.[0]?.id || '' });

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await postJson('/tools/sanswitch/devices', form); setForm(null); await load(); setMsg('저장되었습니다.'); }
    catch (e) { setMsg(`저장 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  const remove = async (r) => {
    if (!window.confirm(`'${r.name}' 스위치 등록을 삭제할까요? 수집된 스냅샷도 함께 지워집니다.`)) return;
    setBusy(true);
    try { await delJson(`/tools/sanswitch/devices/${r.id}`); await load(); setMsg('삭제되었습니다.'); }
    catch (e) { setMsg(`삭제 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  // 연결 테스트(v2.421): 등록 즉시 runId 를 받고 1초마다 진행 로그를 폴링한다 — 어느 단계에서 기다리는지 보인다.
  // verbose=true 면 SSH 프로토콜 로그(ssh -vvv 상당)까지 남긴다.
  const stopTestPoll = () => { if (testTimer.current) { clearInterval(testTimer.current); testTimer.current = null; } };
  const runTest = async (verbose = false) => {
    stopTestPoll();
    setBusy(true); setTest({ run: { status: 'running', trace: [], elapsedMs: 0, verbose } });
    try {
      const r = await postJson('/tools/sanswitch/test', { ...form, verbose });
      const poll = async () => {
        try {
          const d = await fetchJson(`/tools/sanswitch/test/${r.runId}`);
          setTest({ run: d.run });
          if (!isActive(d.run)) { stopTestPoll(); setBusy(false); }
        } catch (e) { stopTestPoll(); setBusy(false); setTest({ run: { status: 'done', trace: [], elapsedMs: 0, result: { ok: false, reason: e.message, phase: 'unknown' } } }); }
      };
      testTimer.current = setInterval(poll, 1000);
      await poll();
    } catch (e) { setBusy(false); setTest({ run: { status: 'done', trace: [], elapsedMs: 0, result: { ok: false, reason: e.message, phase: 'unknown' } } }); }
  };
  const collectNow = async (r) => {
    setBusy(true); setMsg(null);
    try { const res = await postJson(`/tools/sanswitch/devices/${r.id}/collect`, {}); setMsg(res.reason || '수집했습니다.'); await load(); }
    catch (e) { setMsg(`수집 실패: ${e.message}`); }
    finally { setBusy(false); }
  };
  /**
   * 전체 수집(v2.516, 사용자 요구 "san switch 전체 수집 기능 버튼 추가").
   * 중앙 직접 장비는 즉시, 엣지 위임 장비는 재수집 요청 등록 — **무엇을 했는지 나눠 알린다**
   * (뭉쳐서 '전부 수집했다' 고 말하면 거짓이다. 엣지는 다음 설정 pull 때 수집한다).
   */
  const collectAll = async () => {
    setBusy(true); setMsg('전체 수집 중… (중앙 직접 장비부터)');
    try {
      const r = await postJson('/tools/sanswitch/collect-all', {});
      if (r.ok === false) { setMsg(r.reason || '전체 수집 실패'); return; }
      const res = r.result || {};
      const centralPart = res.ok === false
        ? `중앙 수집은 건너뜀(${res.reason})`
        : `중앙 ${r.central}대 완료(성공 ${res.collected ?? 0}·실패 ${res.failed ?? 0})`;
      const edgePart = r.edge
        ? ` · 엣지 ${r.edge}대는 요청 등록 ${r.requested}건${r.alreadyQueued ? `(이미 대기 ${r.alreadyQueued}건)` : ''} — 다음 설정 pull 때 수집·push`
        : '';
      setMsg(`${centralPart}${edgePart}`);
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  const openDetail = async (r) => {
    // 응답 순서 가드 — 늦게 온 이전 요청이 현재 상세를 덮거나, 닫은 모달을 다시 여는 것 방지(고RTT).
    const seq = ++detailSeq.current;
    setDetail({ loading: true, device: r }); setPortFilter('all'); setPortQ(''); setInfoOpen(false); setTab('ports'); setSort({ key: 'index', dir: 'asc' });
    try { const d = await fetchJson(`/tools/sanswitch/devices/${r.id}/ports`); if (detailSeq.current === seq) setDetail({ device: r, ...d }); }
    catch (e) { if (detailSeq.current === seq) setDetail({ device: r, error: e.message }); }
  };
  const closeDetail = () => { detailSeq.current++; setDetail(null); };

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>🔗 SAN 스위치 모니터링</div>

      {/* 상단 KPI — '용량'은 포트 용량이다. 라이선스 없는 포트는 여유에서 빠진다. */}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="스위치" value={agg.switches} meta={switchesMeta(agg)} accent={agg.failed ? 'var(--red)' : undefined} />
        <Kpi label="물리 포트" value={agg.total.toLocaleString()} meta={`라이선스 ${agg.licensed.toLocaleString()}`} />
        <Kpi label="사용 중" value={agg.online.toLocaleString()} pct={agg.usedPct ?? undefined} meta={`포트 사용률 ${usedPctText(agg.usedPct)}`} />
        <Kpi label="여유 포트" value={agg.free.toLocaleString()} meta="라이선스 − 사용중(증설 가능분)" accent={capacityLevel(agg.usedPct) === 'bad' ? 'var(--red)' : capacityLevel(agg.usedPct) === 'warn' ? 'var(--amber)' : undefined} />
        <Kpi label="장애/비활성 포트" value={`${agg.faulty} / ${agg.disabled}`} meta={alertsMeta(agg)} accent={agg.faulty ? 'var(--red)' : undefined} />
      </div>

      {/* 법인 필터 + 검색 + 등록 */}
      <div className="vc-quicknav" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 8 }}>
          <span className="qn-label" style={{ minWidth: 60 }}>🏢 법인</span>
          {dcChips.map((dc) => {
            const on = dcSel.has(dc);
            const list = searched.filter((r) => dcName(r.datacenterId) === dc);
            const a = aggregate(list);
            return (
              <button key={dc} className={`qn-btn${on ? ' on' : ''}${a.failed ? ' down' : ''}`} aria-pressed={on}
                onClick={() => setDcSel((p) => { const n = new Set(p); n.has(dc) ? n.delete(dc) : n.add(dc); return n; })}
                title={`${dc} — 스위치 ${a.switches}대 · 포트 ${a.online}/${a.licensed} (${usedPctText(a.usedPct)}) · 여유 ${a.free}`}>
                {dc}<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{list.length}</span>
              </button>
            );
          })}
          {/* 법인 단위 스토리지 사용량 분석(v2.412, 사용자 요구) — 어레이는 팹 A/B 두 스위치에
              나눠 물리므로 스위치 하나만 보면 트래픽의 절반만 보인다. 선택한 법인의 모든
              스위치를 합산해야 어레이의 실제 사용량이 나온다. */}
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }}
            onClick={() => setDcPerf({
              // 선택한 법인을 **전부** 넘긴다(v2.414) — 예전에는 1개일 때만 그 법인이고 2개
              // 이상이면 '전체'로 뭉쳐져 법인 구분이 사라졌다(사용자 신고).
              datacenterIds: [...dcSel].map(dcIdOfName).filter(Boolean),
              label: dcSel.size ? [...dcSel].join(', ') : '전체',
            })}
            title={dcSel.size
              ? `선택한 법인(${[...dcSel].join(', ')})의 스위치를 법인별로 나눠 스토리지 사용량을 분석합니다.`
              : '법인 칩을 고르면 그 법인들만, 고르지 않으면 전체를 분석합니다. 법인을 2곳 이상 고르면 법인별로 분리해 보여줍니다.'}>
            📊 스토리지 사용량 분석{dcSel.size ? ` — ${[...dcSel].join(', ')}` : ' — 전체'}
          </button>
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 180 }}
            value={q} onChange={setQ} placeholder="스위치·host·모델·엣지 찾기" />
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} disabled={busy}
            title="중앙이 직접 수집하는 스위치를 지금 다시 수집하고, 엣지 위임 스위치는 재수집 요청을 등록합니다(엣지는 다음 설정 pull 때 수집 후 바로 push)."
            onClick={collectAll}>🔄 전체 수집</button>
          {/* 전체 점검(v2.519, 사용자 요청 "전체 SAN 스위치 점검하는 버튼") — 저장된 스냅샷을
              판정한다(스위치 재접속 없음. 28대 동시 SSH 는 그 자체가 운영 사고다).
              최신 상태가 필요하면 위 '전체 수집' 을 먼저 누른다. */}
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }}
            title="등록된 SAN 스위치를 월간 점검 체크리스트로 판정해 이상 유무를 요약하고, 세부 보고서를 PDF 로 내려받습니다. 스위치에 새로 접속하지 않고 마지막 수집 스냅샷을 판정합니다."
            onClick={() => setHealthOpen(true)}>🩺 전체 점검</button>
          <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={() => openForm(null)}>+ 스위치 등록</button>
          {/* v2.513(사용자 요청 "san switch 도 같은 메뉴") — CSV·자유텍스트 대량 등록/내보내기·샘플.
              스토리지 모니터링과 **같은 공용 컴포넌트**를 쓴다(판정·문구 단일 소스 — BulkDeviceIo 헤더).
              ⚠ 식별 키는 host **단독**이다(스토리지는 host+type) — sanswitch/registry.js 가 host
                중복을 거부하므로 type 을 키에 넣으면 '드라이런 통과 → 저장 예외' 가 된다. */}
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }}
            title="CSV 또는 자유텍스트로 스위치를 일괄 등록/수정합니다. 샘플 내려받기·형식 검증·실제 로그인 테스트·선택 등록을 한 창에서 합니다."
            onClick={() => setBulkOpen(true)}>⬆ 대량 등록(CSV·텍스트)</button>
        </div>
      </div>

      {msg && <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px 2px' }}>{msg}</div>}

      {/* v2.590(감사 F2): 인증 실패로 **주기 수집을 멈춘** 스위치 — 조용히 멈추지 않는다(authGuard 규칙 1). */}
      {authStopSummary(rows.filter((r) => r.snap?.extra?.authStopped), { unit: '대', what: 'SAN 스위치' }) && (
        <div className="card" style={{ marginBottom: 10, padding: '10px 14px', fontSize: 13, borderColor: TONE.bad }}>
          <BoldText text={authStopSummary(rows.filter((r) => r.snap?.extra?.authStopped), { unit: '대', what: 'SAN 스위치' })} />
          <span className="muted"> 행의 ‘수집’ 은 정지와 무관하게 1회 시도하고, 성공하면 정지가 풀립니다. 포트 사용량 수집도 같은 계정이라 함께 멈춥니다.</span>
        </div>
      )}

      {/* v2.591: 엣지가 가져갔지만 결과가 오지 않아 폐기된 '지금 수집' 요청 — 배지만 조용히 꺼지지 않게 */}
      {(() => {
        const t = collectDropNote(data?.collectDrops, (id) => rows.find((r) => r.id === id)?.name || id);
        return t ? (
          <div className="card" style={{ marginBottom: 10, padding: '10px 14px', fontSize: 13, borderColor: TONE.warn }}>
            ⚠ <BoldText text={t} />
          </div>
        ) : null;
      })()}

      {/* 스위치 목록 */}
      <div className="table-wrap">
        <STable>
          <thead>
            <tr>
              <th>스위치</th><th>법인</th><th>모델</th><th>FOS</th><th>Domain</th><th>상태</th>
              <th title="사용중 / 라이선스 포트. 라이선스 없는 포트(No_License)는 분모에서 뺍니다.">포트 사용</th>
              <th style={{ minWidth: 130 }}>포트 사용률</th>
              <th title="라이선스 − 사용중. 지금 새로 물릴 수 있는 포트 수입니다.">여유</th>
              <th>장애/비활성</th><th>수집</th><th>수집 시각</th><th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = r.snap;
              const p = s?.ports || {};
              const lvl = capacityLevel(p.usedPct);
              return (
                <tr key={r.id}>
                  <td>
                    <button className="tab" style={{ padding: '2px 8px', fontWeight: 600 }} onClick={() => openDetail(r)} title="클릭하면 포트 상세를 봅니다">{r.name}</button>
                    {/* 스위치가 스스로 보고한 이름(switchshow 의 switchName)을 함께 보여준다 —
                        등록 표시명은 사람이 정한 별칭이라, 현장에서 콘솔에 찍히는 실제 이름과
                        다를 수 있고 그때 어느 장비인지 헷갈린다(사용자 요구). */}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {s?.name && s.name !== r.name ? <><b style={{ fontWeight: 600 }}>{s.name}</b>{' · '}</> : null}
                      {r.host}{r.vfId ? ` · VF ${r.vfId}` : ''}
                    </div>
                  </td>
                  <td>{dcName(r.datacenterId)}</td>
                  <td>{s?.model || (s?.extra?.switchType
                    ? <span className="muted" title="chassisshow 에서 모델명을 읽지 못해 switchType 원값을 표시합니다.">type {s.extra.switchType}</span>
                    : <span className="muted">—</span>)}</td>
                  <td>{s?.fabricOs || <span className="muted">—</span>}</td>
                  <td>{s?.domainId ?? <span className="muted">—</span>}</td>
                  <td>
                    {s?.ok
                      ? <span style={{ color: s.switchState === 'Online' ? TONE.ok : TONE.warn }}>{s.switchState || 'OK'}</span>
                      : (
                        // v2.516(사용자 요구 "실패일때 클릭하면 구체적인 로그 보여주는 기능"):
                        // 예전에는 클릭 안 되는 <span title=…> 이라 사유가 툴팁에만 있었다 —
                        // 복사·공유가 안 되고 모바일에서는 볼 수도 없었다. 스토리지 화면은 이미
                        // 버튼이었다(게이팅 비대칭). 상세 창이 수집 오류 원문·섹션별 사유를 보여준다.
                        <button type="button" className="badge" style={{ background: TONE.bad, color: '#fff', cursor: 'pointer', border: 0, whiteSpace: 'nowrap' }}
                          title={s?.extra?.authStopped
                            ? `인증 실패로 주기 수집을 멈췄습니다 — ${authStopInfo(s.extra.authStopped, { what: '이 스위치' })?.detail || ''}\n\n(클릭하면 상세 창에서 사유와 자격증명 지문을 봅니다)`
                            : `실패 사유: ${failReason(s)}\n\n(클릭하면 상세 창에서 전문을 봅니다)`}
                          onClick={() => openDetail(r)}>{s?.extra?.authStopped ? '인증 실패 정지 ⓘ' : '실패 ⓘ'}</button>
                      )}
                  </td>
                  <td>{s?.ok ? <>{p.online}<span className="muted"> / {p.licensed}</span>{p.noLicense ? <span className="muted" style={{ fontSize: 11 }}> (미라이선스 {p.noLicense})</span> : null}</> : <span className="muted">—</span>}</td>
                  <td>{s?.ok ? lvl === 'unknown' ? <span className="muted" title="라이선스 포트 0 — 사용률 미상">—</span> : <span title={`${p.usedPct}% 사용 · ${lvl === 'bad' ? '증설 검토 필요' : lvl === 'warn' ? '여유 부족' : '여유 있음'}`}><UsageCell pct={p.usedPct || 0} /></span> : <span className="muted">—</span>}</td>
                  <td style={{ color: lvl === 'bad' ? TONE.bad : lvl === 'warn' ? TONE.warn : undefined, fontWeight: 600 }}>{s?.ok ? p.free : '—'}</td>
                  <td>{s?.ok ? <span style={{ color: (p.faulty || p.disabled) ? TONE.warn : undefined }}>{p.faulty} / {p.disabled}</span> : <span className="muted">—</span>}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{r.agent ? `엣지 ${r.agent}` : '중앙 직접'}<div>{r.collectMethod === 'rest' ? 'REST' : 'SSH'}</div></td>
                  <td className="muted" style={{ fontSize: 11 }}>{ago(s?.collectedAt)}{r.pending ? <div style={{ color: TONE.warn }}>재수집 대기</div> : null}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => collectNow(r)}>수집</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} onClick={() => openForm(r)}>수정</button>{' '}
                    <button className="tab" style={{ padding: '2px 8px' }} disabled={busy} onClick={() => remove(r)}>삭제</button>
                  </td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 24 }}>
              {rows.length ? '검색어/법인 필터에 맞는 스위치가 없습니다 — 검색어를 지우거나 법인 칩을 해제하세요.' : "등록된 SAN 스위치가 없습니다. 오른쪽 위 '+ 스위치 등록'으로 추가하세요."}
            </td></tr>}
          </tbody>
        </STable>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        수집 주기 {Math.round((data.poller?.intervalMs || 0) / 60000)}분(동시 {data.poller?.concurrency}대) ·
        마지막 수집 {ago(data.poller?.at)} · 성공 {data.poller?.collected ?? 0} / 실패 {data.poller?.failed ?? 0}
        {data.poller?.busy ? ' · 수집 진행중' : ''}
      </div>

      {/* 수집 작업 로그(v2.516, 사용자 요구 "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그").
          스토리지와 **같은 공용 컴포넌트**를 쓴다 — 주입하는 것은 API 경로와 수치 열뿐이다.
          ⚠ 스위치의 '용량' 은 저장 용량이 아니라 **포트 용량**이다(라이선스/사용중/여유) —
            sanSwitchPorts.js 머리말과 같은 규약. 용량(TB)을 여기 넣지 말 것. */}
      <CollectActivity
        path="/tools/sanswitch/activity"
        metricCols={[
          { key: 'ports', label: '포트(사용/라이선스)', align: 'right', sort: (e) => String(e.portsOnline ?? ''),
            render: (e) => (e.portsLicensed != null ? `${e.portsOnline ?? '—'}/${e.portsLicensed}` : '—'),
            detail: (e) => (e.portsLicensed != null ? `${e.portsOnline ?? '—'} / ${e.portsLicensed} (여유 ${e.portsFree ?? '—'})` : '') },
          { key: 'usedPct', label: '포트 사용률', align: 'right', muted: true, sort: (e) => String(e.usedPct ?? ''),
            render: (e) => (e.usedPct == null ? '—' : `${e.usedPct}%`),
            detail: (e) => (e.usedPct == null ? '' : `${e.usedPct}%`) },
        ]}
      />

      {form && <DeviceForm {...{ form, setForm, data, save, busy, runTest, test, setTest, stopTestPoll }} />}
      {detail && <PortDetail {...{ detail, setDetail, closeDetail, portFilter, setPortFilter, portQ, setPortQ, infoOpen, setInfoOpen, tab, setTab, sort, setSort }} />}
      {dcPerf && <DcStoragePerf dcPerf={dcPerf} onClose={() => setDcPerf(null)} />}
      {/* 전체 점검 모달(v2.519). 법인 칩 선택을 그대로 범위로 쓴다 — 목록에서 고른 것과
          점검 대상이 어긋나면 사용자가 '전체' 로 오해한다. */}
      {healthOpen && (
        <Modal title={`SAN 스위치 월간 점검${dcSel.size ? ` — ${[...dcSel].join(', ')}` : ' — 전체'}`} onClose={() => setHealthOpen(false)} width={1180}>
          <AllHealthCheck datacenterIds={[...dcSel]} />
        </Modal>
      )}

      {bulkOpen && (
        <BulkDeviceIo base="/tools/sanswitch" title="SAN 스위치 대량 등록 — CSV · 자유텍스트" keyLabel="host"
          onClose={() => setBulkOpen(false)} onDone={() => { setBulkOpen(false); load(); }} />
      )}
    </>
  );
}

/** 등록/수정 폼 — 수집 방식 목록은 서버 카탈로그(types.js)를 그대로 그린다. */
function DeviceForm({ form, setForm, data, save, busy, runTest, test, setTest, stopTestPoll }) {
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const type = data.types.find((t) => t.type === form.type) || data.types[0];
  return (
    <Modal title={form.id ? 'SAN 스위치 수정' : 'SAN 스위치 등록'} onClose={() => { setForm(null); setTest(null); stopTestPoll(); }} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <label style={{ fontSize: 12 }}>표시명<input className="input" value={form.name} onChange={set('name')} placeholder="예: SAN-A-01" /></label>
        <label style={{ fontSize: 12 }}>host (IP/호스트명)<input className="input" value={form.host} onChange={set('host')} placeholder="10.10.10.11" /></label>
        <label style={{ fontSize: 12 }}>타입
          <select className="input" value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value, collectMethod: (data.types.find((t) => t.type === e.target.value)?.methods || [])[0]?.value || 'ssh' }))}>
            {data.types.map((t) => <option key={t.type} value={t.type} disabled={!t.implemented}>{t.label}{t.implemented ? '' : ' (예정)'}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 방식
          <select className="input" value={form.collectMethod} onChange={set('collectMethod')}
            title={(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint || ''}>
            {(type?.methods || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>계정<input className="input" value={form.username} onChange={set('username')} autoComplete="off" /></label>
        <label style={{ fontSize: 12 }}>비밀번호
          <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password"
            placeholder={form.hasPassword ? '(변경할 때만 입력)' : ''} />
        </label>
        <label style={{ fontSize: 12 }}>SSH 포트<input className="input" type="number" value={form.sshPort} onChange={set('sshPort')} /></label>
        <label style={{ fontSize: 12 }}>법인(DataCenter)
          <select className="input" value={form.datacenterId} onChange={set('datacenterId')}>
            <option value="">(미지정)</option>
            {(data.datacenters || []).map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>수집 주체
          <select className="input" value={form.agent} onChange={set('agent')}
            title="중앙에서 스위치에 직접 닿지 않으면 그 법인의 엣지를 지정하세요. 엣지가 현지에서 수집해 중앙으로 올립니다.">
            <option value="">중앙이 직접 수집</option>
            {(data.agents || []).map((a) => <option key={a} value={a}>엣지 {a}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }} title="Virtual Fabrics 를 쓰는 장비에서 특정 논리 스위치만 볼 때 지정합니다. 비워두면 기본 컨텍스트만 수집합니다.">
          VF ID (선택)<input className="input" type="number" value={form.vfId} onChange={set('vfId')} placeholder="예: 128" />
        </label>
        <label style={{ fontSize: 12, gridColumn: '1 / -1' }}>메모<input className="input" value={form.note} onChange={set('note')} /></label>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        {(type?.methods || []).find((m) => m.value === form.collectMethod)?.hint}
      </div>
      <div className="flex gap wrap" style={{ marginTop: 12, alignItems: 'center' }}>
        <button className="tab" disabled={busy} onClick={() => runTest(false)}
          title={`입력한 값으로 실제 접속해 봅니다(저장하지 않음). DNS → TCP → SSH/REST → 명령 실행 순으로 단계별 로그가 실시간으로 표시됩니다.${form.agent ? `\n수집 주체가 엣지(${form.agent})이므로 그 엣지가 현지에서 실행합니다 — 엣지의 다음 설정 pull(기본 5분) 때 가져갑니다.` : '\n수집 주체가 "중앙이 직접 수집"이므로 중앙 포탈 서버에서 접속합니다 — 중앙에서 닿지 않는 IP 면 TCP 단계에서 멈춥니다.'}`}>
          연결 테스트
        </button>
        <button className="tab" disabled={busy} onClick={() => runTest(true)}
          title="ssh -vvv 에 해당하는 SSH 프로토콜 단계 로그(소켓 연결·ident 교환·키 교환 알고리즘·인증 방식 시도·채널 열기)까지 남깁니다. 어느 단계에서 멈추는지 추적할 때 쓰세요. 비밀번호는 로그에 남지 않습니다.">
          🔍 자세히 테스트(ssh -vvv)
        </button>
        <button className="login-btn" style={{ flex: 'none', padding: '6px 18px' }} disabled={busy} onClick={save}>저장</button>
        {busy && test?.run && <span className="muted" style={{ fontSize: 12 }}>{statusText(test.run)}</span>}
      </div>
      {test?.run && <TestResult run={test.run} />}
    </Modal>
  );
}

/**
 * 연결 테스트 결과(v2.421) — 실행 중에는 단계별 추적 로그를 실시간으로, 끝나면 성공/실패 + 단계 + 원인 안내.
 * 실패해도 원인을 감추지 않고, SSH 는 CLI 원문을 접어서 보여준다. '로그 복사'로 추적 로그 전체를 복사한다.
 */
function TestResult({ run }) {
  const [open, setOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);
  const active = isActive(run);
  const test = run.result || {};
  const trace = run.trace || [];
  useEffect(() => { if (active && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [trace.length, active]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(`${statusText(run)}\n${test.reason ? `사유: ${test.reason}\n` : ''}${test.hint ? `안내: ${test.hint}\n` : ''}\n${traceText(trace)}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setCopied(false); }
  };
  const debugCount = trace.filter((l) => l.level === 'debug').length;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ color: active ? TONE.warn : (test.ok ? TONE.ok : TONE.bad), fontWeight: 600 }}>
        {active ? '⏳ ' : ''}{statusText(run)}
        {run.target ? <span className="muted" style={{ fontWeight: 400 }}> · 실행 위치: 엣지 {run.target}</span> : <span className="muted" style={{ fontWeight: 400 }}> · 실행 위치: 중앙</span>}
        {run.verbose ? <span className="muted" style={{ fontWeight: 400 }}> · 자세히(ssh -vvv)</span> : null}
      </div>
      {!active && !test.ok && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.6 }}>
          <div><b>실패 단계:</b> {phaseLabel(test.phase)} · <b>사유:</b> {test.reason}</div>
          {test.hint && <div className="muted" style={{ marginTop: 4, borderLeft: '3px solid var(--amber)', paddingLeft: 8 }}>💡 <BoldText text={test.hint} /></div>}
        </div>
      )}
      {!active && test.ok && test.snap && (
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.7 }}>
          이름 <b>{test.snap.name}</b> · 모델 <b>{test.snap.model || '—'}</b> · FOS <b>{test.snap.fabricOs || '—'}</b>
          {' · '}Domain {test.snap.domainId ?? '—'} · 시리얼 {test.snap.serial || '—'}
          <div>포트 {test.snap.ports.online} / {test.snap.ports.licensed} 사용({test.snap.ports.usedPct}%) · 여유 {test.snap.ports.free} · 전체 {test.snap.ports.total}</div>
          {Object.entries(test.snap.sections || {}).filter(([, v]) => v !== 'ok').length > 0 && (
            <div className="muted" style={{ marginTop: 4 }}>
              일부 항목 미수집: {Object.entries(test.snap.sections).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}(${v})`).join(', ')}
            </div>
          )}
        </div>
      )}
      {/* 단계별 추적 로그 — 실행 중에도 보인다(어디서 기다리는지). */}
      <div className="flex gap" style={{ marginTop: 8, alignItems: 'center' }}>
        <button className="tab" style={{ padding: '2px 8px' }} onClick={() => setTraceOpen(!traceOpen)}
          title="DNS → TCP → SSH 핸드셰이크 → 인증 → 명령 실행 순으로, 각 단계의 시작·완료·소요 시간을 기록합니다. 마지막 줄이 지금 기다리는 곳입니다.">
          {traceOpen ? '▾' : '▸'} 단계별 추적 로그 ({trace.length}줄{debugCount ? ` · SSH 프로토콜 ${debugCount}줄` : ''})
        </button>
        <button className="tab" style={{ padding: '2px 8px' }} onClick={copy} title="상태·사유·안내·추적 로그 전체를 클립보드에 복사합니다(장애 문의에 붙여넣기).">{copied ? '복사됨 ✓' : '📋 로그 복사'}</button>
        {run.traceDropped ? <span className="muted" style={{ fontSize: 11 }}>상한 초과로 {run.traceDropped}줄 생략</span> : null}
      </div>
      {traceOpen && (
        <pre ref={logRef} style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '6px 0 0', maxHeight: 260, overflow: 'auto', lineHeight: 1.5 }}>
          {trace.length ? trace.map((l, i) => (
            <div key={i} style={{ color: l.level === 'error' ? TONE.bad : l.level === 'warn' ? TONE.warn : l.level === 'debug' ? TONE.muted : undefined }}>
              [+{(Number(l.t) / 1000).toFixed(3)}s] {l.level === 'debug' ? '· ' : ''}{l.msg}
            </div>
          )) : <span className="muted">아직 로그가 없습니다.</span>}
        </pre>
      )}
      {!active && !!(test.cliRaw || []).length && (
        <>
          <button className="tab" style={{ marginTop: 8, padding: '2px 8px' }} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} CLI 명령 원문 ({test.cliRaw.length}개)
          </button>
          {open && (
            <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
              {test.cliRaw.map((r, i) => (
                <details key={i} open={!r.ok}>
                  <summary style={{ cursor: 'pointer', color: r.ok ? undefined : TONE.warn }}>{r.cmd}</summary>
                  <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0 8px' }}>{r.sample}</pre>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 장비 일반 정보 한 줄 요약(v2.411, 사용자 요구) — 필터 줄 옆에 붙는다.
 * 값이 없는 항목은 아예 넣지 않는다(빈 칸을 '—' 로 나열하면 요약이 아니라 잡음이 된다).
 */
function infoSummary(d) {
  const h = d.health || {};
  const bits = [];
  if (d.domainId != null) bits.push(`Domain ${d.domainId}`);
  if (d.extra?.switchRole) bits.push(d.extra.switchRole);
  if (d.serial) bits.push(`S/N ${d.serial}`);
  if (h.fans?.total) bits.push(`팬 ${h.fans.total}`);
  if (h.psus?.total) bits.push(`PSU ${h.psus.total}${h.powerWatts ? ` · ${h.powerWatts}W` : ''}`);
  if (d.extra?.awakeDays != null) bits.push(`가동 ${d.extra.awakeDays}일`);
  return bits.join(' · ');
}

/** 장비 일반 정보 상세 — 수집된 값만 항목으로 만든다(없는 항목은 표시하지 않는다). */
function DeviceInfo({ d }) {
  const h = d.health || {};
  const rows = [
    ['스위치 이름', d.name],
    ['host', d.host],
    ['모델', d.model || (d.extra?.switchType ? `(모델명 미보고) switchType ${d.extra.switchType}` : '')],
    ['Fabric OS', d.fabricOs],
    ['섀시 시리얼', d.serial],
    ['섀시 Part Num', d.extra?.chassisPartNumber],
    ['섀시 ID', d.extra?.chassisId],
    ['Switch WWN', d.wwn],
    ['Domain ID', d.domainId],
    ['스위치 역할', d.extra?.switchRole],
    ['스위치 상태', d.switchState],
    ['Fabric 이름', d.extra?.fabricName],
    ['팹 스위치 수', d.fabric?.switches || null], // SSH 수집은 팹 정보를 채우지 않아 0 — 0대는 있을 수 없으므로 숨긴다
    ['활성 Zone 설정', d.zoning?.effectiveConfig],
    ['팬', h.fans ? (h.fans.ok == null ? `${h.fans.total}개` : `${h.fans.ok}/${h.fans.total} 정상`) : ''],
    ['전원공급장치', h.psus ? (h.psus.ok == null ? `${h.psus.total}개` : `${h.psus.ok}/${h.psus.total} 정상`) : ''],
    ['소비전력(PSU 합)', h.powerWatts ? `${h.powerWatts} W` : ''],
    ['SFP 최고 온도', h.tempC != null ? `${h.tempC} ℃` : ''],
    ['가동(Time Awake)', d.extra?.awakeDays != null ? `${d.extra.awakeDays}일` : ''],
    ['총 수명(Time Alive)', d.extra?.aliveDays != null ? `${d.extra.aliveDays}일` : ''],
    ['수집 방식', d.extra?.collectMethod === 'rest' ? 'REST API' : 'SSH CLI'],
    ['수집 주체', d.source],
  ].filter(([, v]) => v !== '' && v != null);

  return (
    <div className="card" style={{ marginBottom: 10, padding: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '4px 14px', fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 6, minWidth: 0 }}>
            <span className="muted" style={{ flex: '0 0 108px' }}>{k}</span>
            <b style={{ ...ELLIPSIS, minWidth: 0 }} title={String(v)}>{String(v)}</b>
          </div>
        ))}
      </div>
      {/* PSU 상세 — 입력 전압·소비전력은 전원 이상 징후를 바로 드러낸다(한쪽 0W = 계통 단선). */}
      {!!(h.psuDetail || []).length && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          PSU 상세: {h.psuDetail.map((p) => `#${p.unit} ${p.source || ''} ${p.voltageV != null ? `${p.voltageV}V` : ''} ${p.powerW != null ? `${p.powerW}W` : ''}${p.serial ? ` (S/N ${p.serial})` : ''}`.replace(/\s+/g, ' ').trim()).join(' · ')}
        </div>
      )}
      {!!(d.licenses || []).length && (
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          라이선스: {d.licenses.map((l) => l.name).join(' · ')}
        </div>
      )}
    </div>
  );
}

const HOURS = [[1, '1시간'], [6, '6시간'], [24, '24시간'], [24 * 7, '7일'], [24 * 30, '30일']];

/**
 * 기간 선택(v2.420, 사용자 요구 '조회 조건에 내가 원하는 기간의 값을 볼 수 있는 기능') —
 * 최근 N시간 칩 + '기간 지정'(시작·끝 datetime-local). range 가 있으면 칩보다 우선한다.
 */
function RangePicker({ hours, setHours, range, setRange }) {
  const [open, setOpen] = useState(false);
  const [fromStr, setFromStr] = useState(() => toLocalDt(Date.now() - 24 * 3600_000));
  const [toStr, setToStr] = useState('');
  const [issue, setIssue] = useState(null);
  const apply = () => {
    const r = rangeIssueOf(fromStr, toStr);
    if (r.issue) { setIssue(r.issue); return; }
    setIssue(null); setRange({ from: r.from, to: r.to }); setOpen(false);
  };
  return (
    <>
      <span className="muted" style={{ fontSize: 12, marginLeft: 6 }} title="차트·표가 계산되는 시간 구간입니다. 구간을 120 등분한 폭이 '버킷'이 되며, 버킷 폭은 차트 위 설명에 표시됩니다.">기간</span>
      {HOURS.map(([h, label]) => (
        <button key={h} className={!range && hours === h ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
          title={`지금부터 최근 ${label} 을 봅니다. 버킷 폭 ≈ ${bucketText(Math.max(60_000, (h * 3600_000) / 120))}`}
          onClick={() => { setRange(null); setHours(h); }}>{label}</button>
      ))}
      <button className={range ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
        title={`원하는 시작·끝 시각을 직접 지정합니다(한 번에 최대 ${RANGE_MAX_DAYS}일). 끝을 비우면 지금까지입니다.`}
        onClick={() => setOpen((v) => !v)}>
        📅 기간 지정{range ? `: ${rangeLabel(range)}` : ''}
      </button>
      {range && (
        <button className="tab" style={{ flex: 'none', padding: '4px 8px' }} title="기간 지정을 해제하고 최근 N시간 보기로 돌아갑니다."
          onClick={() => { setRange(null); setOpen(false); }}>✕</button>
      )}
      {open && (
        <div className="flex gap wrap" style={{ alignItems: 'center', width: '100%', fontSize: 12, marginTop: 4 }}>
          <label>시작 <input className="input" type="datetime-local" value={fromStr} onChange={(e) => setFromStr(e.target.value)} style={{ width: 200 }} /></label>
          <label>끝 <input className="input" type="datetime-local" value={toStr} onChange={(e) => setToStr(e.target.value)} style={{ width: 200 }} placeholder="비우면 지금" /></label>
          <button className="login-btn" style={{ flex: 'none', padding: '4px 12px' }} onClick={apply}>적용</button>
          <span className="muted">끝을 비우면 지금까지 · 최대 {RANGE_MAX_DAYS}일 · 보관 기간(설정 › 수집 서버) 밖의 시각은 데이터가 없습니다.</span>
          {issue && <span style={{ color: TONE.bad }}>{issue}</span>}
        </div>
      )}
    </>
  );
}

/** 평균/피크 보기 선택(v2.420, 사용자 요구) — 각 기준의 산출 방식을 툴팁으로 상세히 붙인다. */
function ModePicker({ mode, setMode }) {
  return (
    <>
      <span className="muted" style={{ fontSize: 12, marginLeft: 6 }} title="차트 선과 표의 평균·최대가 어떤 값으로 계산되는지 고릅니다.">기준</span>
      {MODES.map(([k, label, help]) => (
        <button key={k} className={mode === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
          title={help} onClick={() => setMode(k)}>{label}</button>
      ))}
    </>
  );
}

/**
 * 값 산출 방식 상세 설명(v2.420, 사용자 요구 '메뉴에 최대한 자세한 설명') — 접었다 펼친다.
 * 여기 문구는 서버 perfDb.js 의 실제 계산과 일치해야 한다(버킷 = 구간/120, 하한 60초; 평균 = 포트별 AVG 합;
 * 피크 = 포트별 MAX 합). 바꾸면 양쪽을 같이 고칠 것.
 */
function MetricHelp({ mode, bucketMs, hours, scope, intervalHint }) {
  const [open, setOpen] = useState(false);
  const bw = bucketText(bucketMs);
  return (
    <div style={{ fontSize: 11.5, lineHeight: 1.7 }}>
      <button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setOpen(!open)}
        title="이 화면의 숫자가 어떻게 계산되는지 자세히 설명합니다.">
        {open ? '▾' : '▸'} ⓘ 값 산출 방식 — 지금은 <b>{mode === 'peak' ? '피크 기준' : '평균 기준'}</b> · 버킷 폭 <b>{bw}</b>
      </button>
      {open && (
        <div className="card muted" style={{ marginTop: 6, padding: '8px 10px' }}>
          <div><b>① 원천 표본</b> — 설정된 수집 주기{intervalHint ? `(${intervalHint})` : ''}마다 각 스위치에 SSH 로 <code>portperfshow</code> 를 표본 시간만큼 받아쓰고,
            마지막 화면 1벌의 <b>포트별 바이트/초</b>를 DB 에 저장합니다. 즉 표본 1개는 그 순간(약 1초 창)의 처리량이며, <b>수집 주기 사이의 순간 변동은 관측되지 않습니다</b>(정직한 한계).</div>
          <div><b>② 버킷</b> — 조회 구간({scope || `최근 ${hours}시간`})을 120 등분(하한 60초)한 폭이 버킷입니다. 지금은 <b>{bw}</b>. 버킷마다 포트별로 표본의 <b>평균(AVG)</b>과 <b>최댓값(MAX)</b>을 계산합니다. 구간이 길수록 버킷이 넓어집니다.</div>
          <div><b>③ 평균 기준</b> — 버킷 안 포트별 AVG 를 같은 스토리지(어레이)에 물린 포트끼리 <b>합산</b>한 선입니다. 표의 '평균'은 이 선의 평균, '최대'는 이 선의 최댓값입니다. 지속 부하(평소 사용량)를 보는 데 맞고, 구간이 길면 순간 피크가 평균에 깎입니다.</div>
          <div><b>④ 피크 기준</b> — 버킷 안 포트별 MAX 를 같은 스토리지의 포트끼리 <b>합산</b>한 선입니다. 표의 '평균'은 이 선의 평균, '최대'는 기간 내 최고 피크입니다. 포화·증설 판단에 맞습니다. ⚠ 포트마다 최댓값이 찍힌 시각이 다를 수 있어 "동시에 발생한 총량"보다 <b>크거나 같은 상한값</b>입니다.</div>
          <div><b>⑤ 법인 카드·전체 합계</b> — 스토리지별 값의 <b>단순 합</b>입니다. 각 스토리지의 최댓값 시각이 다르므로 카드의 '최대'는 동시 최대가 아니라 상한입니다(예: A 가 10시에 200, B 가 14시에 150 이면 카드 최대 350).</div>
          <div><b>⑥ 단위·합산</b> — 스위치 보고값(바이트/초) × 8 = bps 로 표시합니다. 스토리지는 이중화를 위해 팹 A/B 두 스위치에 나눠 물리므로 법인 분석은 <b>모든 스위치를 합산</b>합니다. 엣지 위임 스위치의 시계열은 그 엣지에만 있어 중앙 합산에 빠집니다(안내 배너로 표시).</div>
          <div><b>⑦ 빈 구간</b> — 표본이 없는 버킷은 0 이 아니라 '없음'(선이 끊김)으로 두고 평균에서도 제외합니다. 0 으로 채우면 조회 범위를 넓힐수록 평균이 내려가는 왜곡이 생깁니다.</div>
        </div>
      )}
    </div>
  );
}

/** 제목 클릭 정렬 헤더(v2.412, 사용자 요구 '타이틀별로 소팅'). 분석 표 두 곳이 공유한다. */
function SortTh({ k, label, sort, setSort, title, style }) {
  const on = sort.key === k;
  return (
    <th onClick={() => setSort((c) => nextSort(c, k))} style={{ cursor: 'pointer', userSelect: 'none', ...style }}
      title={`${title ? `${title}\n\n` : ''}클릭하면 이 열로 정렬합니다.`}>
      {label}{title ? ' ⓘ' : ''}
      <span style={{ opacity: on ? 1 : 0.25, marginLeft: 3 }}>{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}
const LINE_COLORS = ['#60a5fa', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#fbbf24', '#22d3ee', '#fb7185'];
const tsLabel = (ts, hours) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return hours <= 24 ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}시`;
};

/**
 * 사용량 분석(v2.411, 사용자 요구 '수집한 포트 사용정보를 차트로 보면서 포트의 사용량을
 * 분석해서 스토리지 사용량을 볼 수 있게').
 *
 * 두 관점을 나란히 둔다:
 *  1) 포트별 — 어느 포트가 얼마나 쓰이나. 포화도(협상 속도 대비 %)까지 봐야 증설 판단이 된다.
 *  2) 스토리지별 — 같은 어레이에 여러 포트가 물려 있으므로(SYMMETRIX 의 SAF-1d/3d/5d…)
 *     포트 처리량을 어레이 단위로 합산해야 '그 스토리지가 실제로 얼마나 쓰이는지'가 보인다.
 */
/**
 * 사용량 표본이 없을 때의 안내(v2.517, 사용자 신고 "데이터 수집이 안되, edge 의 사용량도 분석하게 해줘").
 *
 * v2.516 까지는 원인이 무엇이든 "설정에서 켜면 쌓기 시작합니다" 한 문구였다 — REST 장비·제한 셸
 * 계정처럼 **켜도·기다려도 영원히 안 쌓이는** 경우까지 그 문구가 덮었다. 이제 서버가 원인을
 * 판정해(`sanswitch/perfDiag.js`) `diag.kind` 로 내려주고, 문구는 순수 모듈이 만든다.
 *
 * ⚠ 실패 원문은 툴팁이 아니라 `<pre>` 로 보여준다 — 복사·공유가 되고 모바일에서도 보인다(v2.516 규약).
 */
function PerfEmptyState({ diag, deviceId }) {
  const t = perfDiagText(diag);
  return (
    <div className="card" style={{ fontSize: 13, lineHeight: 1.8, borderColor: diagBorder(t.tone) }}>
      <div style={{ fontWeight: 600 }}>
        {t.waiting ? '⏳ ' : t.tone === 'fix' ? '⚠ ' : 'ℹ '}{t.title}
      </div>
      <div className="muted" style={{ marginTop: 2 }}>{t.body}</div>
      {t.action && <div style={{ marginTop: 6 }}>→ {t.action}</div>}
      {t.error && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 2 }}>장비가 준 사유(원문):</div>
          <pre style={{ margin: 0, padding: 8, background: 'var(--bg2, rgba(0,0,0,0.25))', borderRadius: 6,
            fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }}>{t.error}</pre>
        </div>
      )}
      {diag?.pendingRequest && (
        <div className="muted" style={{ marginTop: 6 }}>이 스위치의 엣지에 재수집 요청이 대기 중입니다 — 엣지가 다음 설정 pull 때 가져갑니다.</div>
      )}
      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        판정 근거는 아래 <b>수집 작업</b> 로그에서 확인할 수 있습니다{deviceId ? '(이 스위치의 최근 결과 포함)' : ''}.
      </div>
    </div>
  );
}

function PerfPanel({ deviceId, ports }) {
  /**
   * '지금 수집'(v2.517) — 중앙 직접 장비는 즉시, 엣지 위임 장비는 **재수집 요청만** 등록된다.
   * 응답을 뭉치지 않고 '즉시 N대 / 요청 M곳' 으로 나눠 말한다(v2.516 '전체 수집' 과 같은 규약).
   * 재진입: 진행 중이면 버튼을 잠근다(연타가 스위치 SSH 세션을 곱하지 않게).
   */
  const [collecting, setCollecting] = useState(false);
  const [collectMsg, setCollectMsg] = useState('');
  const [hours, setHours] = useState(24);
  const [range, setRange] = useState(null);     // {from,to} ms — 기간 지정(v2.420)
  const [mode, setMode] = useState('avg');      // 'avg' | 'peak' (v2.420)
  const [view, setView] = useState('port');     // 'port' | 'storage'
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });   // 기본: 많이 쓰는 순
  // 연결 스토리지별 뷰에서 어레이/호스트를 구분한다 — 같은 HBA 모델·펌웨어를 쓰는 서버들은
  // 네임서버 심볼릭 이름이 같아 한 덩어리로 묶인다(실측: 'QLE2692 FW:… (포트 25)').
  // 그게 스토리지 2위로 올라오면 오독하므로 기본은 스토리지만 본다.
  const [kind, setKind] = useState('array');

  /**
   * ⚠ 응답에 **어느 뷰의 것인지**를 각인해 두고, 뷰가 일치할 때만 그린다.
   * 처음에는 view 상태만 보고 그렸는데, `setView('storage')` 로 리렌더가 먼저 일어나고
   * 데이터 초기화(useEffect)는 그 다음이라 **'뷰는 storage, 데이터는 포트'** 인 렌더가 한 번
   * 끼어들었다. 그 렌더에서 포트 시리즈에 없는 `s.ports.length` 를 읽어 화면 전체가 크래시했다
   * (Playwright 로 실제로 잡음). 뷰-데이터 짝을 강제하면 이 부류가 원천 차단된다.
   */
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    const v = view;
    const path = v === 'storage' ? `/tools/sanswitch/devices/${deviceId}/perf/storage` : `/tools/sanswitch/devices/${deviceId}/perf`;
    fetchJson(path, perfQuery({ hours, range }))
      .then((d) => { if (alive) setData({ ...d, view: v }); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [deviceId, hours, range, view]);

  const collectNow = () => {
    setCollecting(true); setCollectMsg('수집 요청 중…');
    postJson('/tools/sanswitch/perf/collect', {})
      .then((r) => setCollectMsg(`${perfCollectSummary(r)}${r?.note ? ` — ${r.note}` : ''}`))
      .catch((e) => setCollectMsg(`수집 실패: ${e.message}`))
      .finally(() => setCollecting(false));
  };

  // 포트 현재 속도(포화도 계산용) — 목록 스냅샷에서 가져온다.
  const speedOf = useMemo(() => {
    const m = new Map((ports || []).map((p) => [p.index, p.speed]));
    return (port) => m.get(port) || '';
  }, [ports]);

  // 뷰가 일치하는 응답만 사용(위 주석 참조). 필드도 방어적으로 읽는다.
  const shown = data && data.view === view ? data : null;
  const raw = shown?.series || [];
  // 어레이/호스트 구분은 서버와 같은 규칙(perfDb.endpointKind)을 쓴다 — 이름에 '::' 가 있으면 어레이.
  const kindOf = (key) => (String(key) === '(미확인)' ? 'unknown' : (String(key).includes('::') ? 'array' : 'host'));
  const kindCounts = view === 'storage'
    ? raw.reduce((a, s) => { const k = kindOf(s.key); a[k] = (a[k] || 0) + 1; a.all = (a.all || 0) + 1; return a; }, {})
    : {};
  const rawShown = view === 'storage' && kind !== 'all' ? raw.filter((s) => kindOf(s.key) === kind) : raw;
  // 보기 기준(v2.420): 평균 = 버킷 AVG(합), 피크 = 버킷 MAX(합). 서버가 둘 다 내려주고 화면이 고른다.
  const peak = mode === 'peak';
  const seriesAll = view === 'storage'
    ? rawShown.map((s) => ({ key: s.key, label: `${s.key} (포트 ${(s.ports || []).length})`, values: (peak ? s.peak : s.sum) || [], portCount: (s.ports || []).length, kind: kindOf(s.key) }))
    : rawShown.map((s) => ({ key: `p${s.port}`, label: `${s.port}${s.name ? ` · ${shortDeviceName(s.name, 24)}` : ''}`, values: (peak ? s.peak : s.avg) || [], rawMax: s.max, port: s.port, speed: s.speed, name: s.name }));
  const effHours = shown?.hours || hours;
  const top = topSeries(seriesAll, 8);
  const rows = toChartRows(shown?.buckets || [], top);

  // 표에 쓸 파생값을 미리 계산해 두고(평균·최대·포화도) 그 위에서 정렬한다 —
  // 정렬 키와 화면에 보이는 값이 반드시 같은 계산이어야 한다.
  const tableRows = seriesAll.map((s) => {
    const st = seriesStats(s.values);
    const avg = st.avg;
    // '최대'는 버킷 평균의 최댓값이 아니라 서버가 준 **원시 샘플 피크**(MAX(bps))다 — 30일 조회면 버킷이
    // 6시간이라 평균의 최댓값은 피크를 크게 깎고, 그 값으로 포화도를 내면 과소 판정된다(v2.416 리뷰 확정).
    const max = s.rawMax != null && Number(s.rawMax) > 0 ? Number(s.rawMax) : st.max;
    const speed = view === 'port' ? (s.speed || speedOf(s.port)) : '';
    return { ...s, avg, max, speed, sat: view === 'port' ? saturationPct(max, speed) : null };
  });
  const SORTERS = {
    name: (r) => (view === 'storage' ? r.key : r.port),
    attached: (r) => (view === 'storage' ? r.portCount : (r.name || null)),
    speed: (r) => { const m = String(r.speed || '').match(/^(\d+)G$/); return m ? Number(m[1]) : null; },
    avg: (r) => r.avg,
    max: (r) => r.max,
    sat: (r) => r.sat,
  };
  const sorted = sortRows(tableRows, SORTERS[sort.key] || SORTERS.avg, sort.dir, (r) => r.key);

  return (
    <div style={{ marginBottom: 10 }}>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        {[['port', '포트별'], ['storage', '연결 스토리지별']].map(([k, label]) => (
          <button key={k} className={view === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
            onClick={() => setView(k)}
            title={k === 'storage' ? '같은 어레이에 물린 포트들의 처리량을 합산해, 그 스토리지가 실제로 얼마나 쓰이는지 보여줍니다.' : '포트 하나하나의 처리량입니다.'}>
            {label}
          </button>
        ))}
        {view === 'storage' && [['array', '스토리지'], ['host', '호스트(HBA)'], ['all', '전체']].map(([k, label]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }}
            onClick={() => setKind(k)}
            title={k === 'array' ? '벤더 심볼릭 이름이 어레이 형식인 연결 대상입니다.'
              : k === 'host' ? '서버 HBA 등 스토리지가 아닌 연결 대상입니다. 같은 HBA 모델·펌웨어를 쓰는 서버들은 네임서버 이름이 같아 한 덩어리로 묶입니다.'
              : '구분 없이 모두 봅니다.'}>
            {label}{kindCounts[k] != null ? ` ${kindCounts[k]}` : ''}
          </button>
        ))}
        <ModePicker mode={mode} setMode={setMode} />
        <RangePicker hours={hours} setHours={setHours} range={range} setRange={setRange} />
        <button className="tab" style={{ flex: 'none', padding: '4px 10px' }} disabled={collecting}
          onClick={collectNow}
          title="portperfshow 를 지금 1회 실행합니다. 중앙 직접 수집 장비는 즉시, 엣지 위임 장비는 재수집 요청만 등록됩니다(중앙은 엣지에 명령을 밀어넣을 수 없습니다).">
          {collecting ? '수집 중…' : '🔄 지금 수집'}
        </button>
      </div>
      {collectMsg && <div className="card muted" style={{ fontSize: 12, padding: 8, marginBottom: 6 }}>{collectMsg}</div>}
      {shown && <div style={{ marginBottom: 6 }}><MetricHelp mode={mode} bucketMs={shown.bucketMs} hours={effHours} scope={range ? rangeLabel(range) : ''} /></div>}
      {shown?.rangeIssue && <div className="card muted" style={{ fontSize: 12, borderColor: 'var(--amber)' }}>⚠ 기간 지정 무시됨: {shown.rangeIssue} — 최근 24시간으로 표시합니다.</div>}

      {error && <ErrorBox message={error} />}
      {!error && !shown && <Loading />}
      {shown && (!rows.length || !top.length) && (
        rows.length && raw.length && !seriesAll.length
          ? (
            <div className="card muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
              '{kind === 'array' ? '스토리지' : kind === 'host' ? '호스트(HBA)' : ''}' 로 분류된 연결 대상이 없습니다 — 위에서 '전체'를 눌러 보세요.
            </div>
          )
          : <PerfEmptyState diag={shown.diag} deviceId={deviceId} />
      )}

      {!!rows.length && (
        <>
          <div className="card" style={{ padding: 8, marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {view === 'storage' ? '연결 스토리지별 합산 처리량' : '포트별 처리량'} · <b>{peak ? '피크 기준(버킷 안 최댓값)' : '평균 기준(버킷 안 평균)'}</b> · 버킷 폭 {bucketText(shown.bucketMs)} ·
              {' '}상위 {top.length}개 · 값은 스위치가 보고한 바이트/초를 bps 로 환산한 것입니다.
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="ts" tickFormatter={(t) => tsLabel(t, effHours)} fontSize={11} minTickGap={28} />
                <YAxis tickFormatter={(v) => bps(v * 8)} fontSize={11} width={78} />
                <Tooltip
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                  formatter={(v, name) => [bytesPerSecText(v), name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {top.map((s, i) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} dot={false}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 분석 표 — 평균/최대, 그리고 포화도(협상 속도 대비 %). 절대값만으로는 증설 판단이 안 된다. */}
          <div className="table-wrap" style={{ maxHeight: '28vh', overflow: 'auto' }}>
            <STable>
              <thead>
                <tr>
                  <SortTh k="name" label={view === 'storage' ? '스토리지' : '포트'} sort={sort} setSort={setSort} />
                  <SortTh k="attached" label={view === 'storage' ? '포트 수' : '연결 장비'} sort={sort} setSort={setSort} />
                  {view === 'port' && <SortTh k="speed" label="속도" sort={sort} setSort={setSort} />}
                  <SortTh k="avg" label="평균" sort={sort} setSort={setSort}
                    title={peak ? '피크 기준: 버킷별 최댓값(포트별 MAX 합) 선의 평균입니다.' : '평균 기준: 버킷별 평균(포트별 AVG 합) 선의 평균입니다.'} />
                  <SortTh k="max" label="최대" sort={sort} setSort={setSort}
                    title={view === 'port' ? '기간 안 원시 표본의 최댓값(MAX)입니다 — 버킷 폭과 무관한 실제 피크.' : (peak ? '피크 기준: 기간 내 최고 피크(버킷별 포트 MAX 합의 최댓값)입니다.' : '평균 기준: 버킷별 평균 합 선의 최댓값입니다. 버킷이 넓을수록 실제 피크보다 낮게 나옵니다.')} />
                  {view === 'port' && <SortTh k="sat" label="포화도(최대)" sort={sort} setSort={setSort}
                    title="최대 처리량 ÷ 협상 속도. 속도를 모르는 포트는 판정하지 않습니다(빈칸이며 정렬에서도 뒤로 갑니다)." />}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => {
                  const lvl = saturationLevel(s.sat);
                  return (
                    <tr key={s.key}>
                      <td style={ELLIPSIS} title={s.label}>
                        <b>{view === 'storage' ? s.key : s.port}</b>
                        {view === 'storage' && s.kind === 'host'
                          ? <div className="muted" style={{ fontSize: 10.5 }}>호스트(HBA)</div> : null}
                      </td>
                      {view === 'storage'
                        ? <td className="muted">{s.portCount}</td>
                        : <td style={ELLIPSIS} title={s.name || ''}>{shortDeviceName(s.name || '', 30) || '—'}</td>}
                      {view === 'port' && <td>{s.speed || <span className="muted">—</span>}</td>}
                      <td>{bytesPerSecText(s.avg)}</td>
                      <td>{bytesPerSecText(s.max)}</td>
                      {view === 'port' && (
                        <td style={{ color: lvl === 'none' ? TONE.muted : TONE[lvl], fontWeight: lvl === 'bad' ? 600 : 400 }}>
                          {s.sat == null ? '—' : `${s.sat}%`}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </>
      )}

      {/* 수집 작업 로그(v2.517) — 기본 수집과 **같은 공용 패널**을 쓴다(응답 형태 {poller,events} 동일).
          '이 스위치가 왜 안 쌓이나' 의 판정 근거가 여기 있고, 실패 배지를 누르면 원문이 펼쳐진다. */}
      <CollectActivity
        path="/tools/sanswitch/perf/activity"
        title="사용량 수집 작업"
        metricCols={[
          { key: 'ports', label: '표본 포트', align: 'right', sort: (e) => String(e.ports ?? ''),
            render: (e) => (e.ports == null ? '—' : `${e.ports}개`),
            detail: (e) => (e.ports == null ? '' : `${e.ports}개 포트의 표본을 저장`) },
          { key: 'totalBps', label: '합계 처리량', align: 'right', muted: true, sort: (e) => String(e.totalBps ?? ''),
            render: (e) => (e.totalBps == null ? '—' : bytesPerSecText(e.totalBps)),
            detail: (e) => (e.totalBps == null ? '' : bytesPerSecText(e.totalBps)) },
        ]}
      />
    </div>
  );
}

/**
 * 법인 단위 스토리지 사용량 분석(v2.412, 사용자 요구 '법인을 선택하면 그 법인에 포함된
 * 모든 스토리지의 사용량을 다수개로 분석').
 *
 * 스위치 하나가 아니라 **법인 안의 모든 스위치를 합산**한다 — 어레이는 이중화를 위해
 * 팹 A/B 두 스위치에 나눠 물리므로(OC2-1/OC2-2, OC2-3/OC2-4), 한 대만 보면 그 어레이가
 * 실제로 쓰는 트래픽의 절반만 보인다.
 *
 * 표에는 대역폭(얼마나 바쁜가)과 **용량 사용률(얼마나 찼는가)** 을 나란히 둔다. 두 축은
 * 다른 문제를 가리킨다 — 용량은 널널한데 대역폭이 포화면 경로/포트 증설이고, 반대면 디스크
 * 증설이다. 용량은 등록된 스토리지의 시리얼이 어레이 시리얼과 **확실히 일치할 때만** 붙인다.
 */
function DcStoragePerf({ dcPerf, onClose }) {
  const [hours, setHours] = useState(24);
  const [range, setRange] = useState(null);     // 기간 지정(v2.420)
  const [mode, setMode] = useState('avg');      // 평균/피크 기준(v2.420)
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // 기본은 스토리지 어레이만 — 법인 합산이면 서버 HBA 가 수십 개 잡혀 표를 덮는다(실측 64개).
  const [kind, setKind] = useState('array');
  const [sort, setSort] = useState({ key: 'avg', dir: 'desc' });   // 기본: 많이 쓰는 순
  // 법인이 2곳 이상이면 기본은 **법인별 분리**. '합산'을 고르면 같은 어레이를 법인 구분 없이 합친다.
  const [split, setSplit] = useState(true);
  // 범위(법인)를 **창 안에서** 바꾼다 — 예전에는 목록 화면에서 칩을 먼저 고르고 창을 열어야 해서,
  // '전체 법인'과 '특정 법인'을 오가려면 매번 창을 닫아야 했다(사용자 요구, v2.415).
  // 빈 Set = 전체 법인.
  const [dcSet, setDcSet] = useState(() => new Set(dcPerf.datacenterIds || []));
  const dcParam = [...dcSet].join(',');

  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    fetchJson('/tools/sanswitch/perf/storage-summary', { datacenterId: dcParam, ...perfQuery({ hours, range }), split: split ? '1' : '0' })
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [dcParam, hours, range, split]);

  // 보기 기준(v2.420): 평균 = sum/avgTotal/maxTotal, 피크 = peak/peakAvg/peakTotal. 정렬 키와 표시 값이 같은 계산이어야 한다.
  const peak = mode === 'peak';
  const avgOf = (s) => (peak ? (s.peakAvg || 0) : s.avgTotal);
  const maxOf = (s) => (peak ? (s.peakTotal || 0) : s.maxTotal);
  const effHours = data?.hours || hours;
  const series = (data?.series || []).filter((s) => kind === 'all' || s.endpointKind === kind);
  const multiDc = dcSet.size !== 1;   // 법인 2곳 이상 또는 전체 — 그때만 분리/합산이 의미 있다
  const showDcCol = !!data?.split;
  const chartSeries = topSeries(series.map((s) => ({
    // 법인별로 분리했으면 라벨에 법인을 앞세운다 — 같은 어레이 이름이 법인마다 나오므로
    // 접두어가 없으면 범례에서 구분할 수 없다.
    key: `${s.datacenterId ?? ''}\u0000${s.key}`,
    label: `${showDcCol && s.datacenterName ? `${s.datacenterName} · ` : ''}${s.key} (스위치 ${s.switches.length}·포트 ${s.portCount})`,
    values: (peak ? s.peak : s.sum) || [],
  })), 8);
  const rows = toChartRows(data?.buckets || [], chartSeries);
  const grand = series.reduce((a, s) => a + avgOf(s), 0);
  const SORTERS = {
    dc: (s) => s.datacenterName || null,
    name: (s) => s.key,
    switches: (s) => s.switches.length,
    ports: (s) => s.portCount,
    avg: avgOf,
    max: maxOf,
    cap: (s) => (s.capacity?.pct ?? null),   // 용량 미매칭은 null → 항상 뒤로
  };
  const sorted = sortRows(series, SORTERS[sort.key] || SORTERS.avg, sort.dir, (s) => s.key);
  const scopeLabel = dcSet.size === 0
    ? '전체 법인'
    : (data?.allDatacenters || []).filter((d) => dcSet.has(d.id)).map((d) => d.name).join(', ') || dcPerf.label;
  // 법인 소계 앞에 '전체 합계'를 둔다 — 법인별로 나눠 보면서도 전사 총량을 함께 봐야
  // '어느 법인이 전체의 몇 %인가'를 판단할 수 있다.
  const dcTotals = data?.byDatacenter || [];
  const grandAvg = dcTotals.reduce((a, d) => a + avgOf(d), 0);
  const grandMax = dcTotals.reduce((a, d) => a + maxOf(d), 0);

  return (
    <Modal title={`스토리지 사용량 분석 — ${scopeLabel}`} onClose={onClose} width={1180}>
      {/* 범위 선택 — '전체 법인'과 개별 법인을 여기서 바로 오간다. */}
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12, minWidth: 42 }}>🏢 범위</span>
        <button className={dcSet.size === 0 ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
          onClick={() => setDcSet(new Set())}
          title="등록된 모든 법인을 대상으로 봅니다. 아래 '법인별 분리'로 법인마다 나눠 볼 수 있습니다.">
          전체 법인{(data?.allDatacenters || []).length ? ` ${data.allDatacenters.length}` : ''}
        </button>
        {(data?.allDatacenters || []).map((d) => {
          const on = dcSet.has(d.id);
          return (
            <button key={d.id || '_'} className={on ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
              aria-pressed={on}
              onClick={() => setDcSet((p) => { const n = new Set(p); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
              title={`${d.name} — 스위치 ${d.switches}대. 여러 법인을 함께 고를 수 있습니다.`}>
              {d.name}<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{d.switches}</span>
            </button>
          );
        })}
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
        {/* 연결 대상 구분 — 어레이/호스트를 섞으면 스토리지가 HBA 수십 개에 묻힌다. */}
        {[['array', '스토리지'], ['host', '호스트(HBA)'], ['all', '전체']].map(([k, label]) => (
          <button key={k} className={kind === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
            onClick={() => setKind(k)}
            title={k === 'array'
              ? '벤더 심볼릭 이름이 어레이 형식이거나, 등록된 스토리지의 시리얼과 일치하는 연결 대상입니다.'
              : k === 'host' ? '서버 HBA 등 스토리지가 아닌 연결 대상입니다.' : '구분 없이 모두 봅니다.'}>
            {label}{data?.counts?.[k] != null ? ` ${data.counts[k]}` : (k === 'all' && data ? ` ${(data.series || []).length}` : '')}
          </button>
        ))}
        {/* 법인이 2곳 이상일 때만 의미가 있다 — 한 법인이면 분리·합산이 같은 결과다. */}
        {multiDc && (
          <button className="tab" style={{ flex: 'none', padding: '4px 12px', marginLeft: 6 }}
            onClick={() => setSplit((v) => !v)}
            title={split
              ? '지금은 법인별로 나눠 보고 있습니다. 누르면 같은 어레이를 법인 구분 없이 합칩니다.'
              : '지금은 법인 구분 없이 합쳐 보고 있습니다. 누르면 법인별로 나눕니다.'}>
            {split ? '🏢 법인별 분리' : '🔗 법인 합산'}
          </button>
        )}
        <ModePicker mode={mode} setMode={setMode} />
        <RangePicker hours={hours} setHours={setHours} range={range} setRange={setRange} />
        {data && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }} title={peak ? '표시 중인 스토리지들의 피크 기준 평균(버킷별 MAX 합 선의 평균)을 더한 값' : '표시 중인 스토리지들의 평균 기준 평균을 더한 값'}>
            스위치 {data.switches.length}대 합산 · {series.length}개 · {peak ? '피크 평균 합' : '평균 합'} {bytesPerSecText(grand)}
          </span>
        )}
      </div>
      {data && <div style={{ marginBottom: 6 }}><MetricHelp mode={mode} bucketMs={data.bucketMs} hours={effHours} scope={range ? rangeLabel(range) : ''} /></div>}
      {data?.rangeIssue && <div className="card muted" style={{ fontSize: 12, borderColor: 'var(--amber)' }}>⚠ 기간 지정 무시됨: {data.rangeIssue} — 최근 24시간으로 표시합니다.</div>}

      {error && <ErrorBox message={error} />}
      {!error && !data && <Loading />}
      {data?.edgeNote && <div className="card muted" style={{ fontSize: 12.5, borderColor: 'var(--amber)' }}>ℹ {data.edgeNote}</div>}
      {data && (data.edgeSwitches || []).some((e) => e.lastSampleAt) && (
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
          엣지 중계 반영: {(data.edgeSwitches || []).filter((e) => e.lastSampleAt).map((e) => `${e.name} ${ago(e.lastSampleAt)}`).join(' · ')}
        </div>
      )}
      {data && (!rows.length || !series.length) && (
        <div className="card muted" style={{ fontSize: 13, lineHeight: 1.8 }}>
          {data.series?.length && !series.length ? null : <>'{scopeLabel}' 범위에 아직 수집된 포트 사용량이 없습니다.</>}
          <div style={{ marginTop: 4 }}>
            {/* v2.517: **꺼져 있을 때만** '켜세요' 라고 말한다. 예전에는 무조건 이 문구여서, 이미 켜져
                있고 장비에서 실패하는 상황에서도 사용자가 멀쩡한 설정을 의심하며 헤맸다(장비별 진단은
                장비 상세 › 사용량 분석 탭이 `perfDiag` 로 사유를 말한다). */}
            {data.perfEnabled === false
              ? <><b>설정 › 수집 서버 › SAN 스위치 포트 사용량</b> 에서 수집을 켜야 <code>portperfshow</code> 로 쌓기 시작합니다(기본 꺼짐).</>
              : <>포트 사용량 수집은 <b>켜져 있습니다</b> — 표본이 없는 이유는 스위치마다 다릅니다. 장비를 눌러 <b>사용량 분석</b> 탭을 열면 그 스위치의 사유(첫 주기 대기 / 엣지 미보고 / 명령 실패 등)를 알려줍니다.</>}
            {data.unavailable ? <div style={{ color: 'var(--amber)', marginTop: 4 }}>이 서버는 시계열 DB(node:sqlite)를 쓸 수 없어 이력이 저장되지 않습니다.</div> : null}
            {!data.switches.length ? <div style={{ marginTop: 4 }}>이 법인에 등록된 스위치가 없습니다.</div> : null}
            {data.series?.length && !series.length
              ? <div style={{ marginTop: 4 }}>'{kind === 'array' ? '스토리지' : '호스트(HBA)'}' 로 분류된 연결 대상이 없습니다 — 위에서 '전체'를 눌러 보세요.</div>
              : null}
          </div>
        </div>
      )}

      {/* 법인 소계 — '어느 법인이 얼마나 쓰나'를 먼저 보여준다(복수 법인 분리 보기의 핵심). */}
      {!!dcTotals.length && data.split && (
        <div className="kpis" style={{ marginBottom: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          {dcTotals.length > 1 && (
            <Kpi label={`🌐 전체 합계(${peak ? '피크' : '평균'} 기준)`} value={bytesPerSecText(grandAvg)} accent="var(--blue)"
              meta={`법인 ${dcTotals.length} · 스토리지 ${dcTotals.reduce((a, d) => a + d.storages, 0)} · 최대 ${bytesPerSecText(grandMax)}(법인별 최댓값의 단순 합 — 동시 최대가 아닌 상한)`} />
          )}
          {dcTotals.map((d) => (
            <Kpi key={d.datacenterId || '_'} label={`🏢 ${d.name}`} value={bytesPerSecText(avgOf(d))}
              pct={grandAvg ? Math.round((avgOf(d) / grandAvg) * 100) : undefined}
              meta={`스토리지 ${d.storages} · 스위치 ${d.switches} · 최대 ${bytesPerSecText(maxOf(d))}(스토리지별 최댓값의 합)`
                + (dcTotals.length > 1 && grandAvg ? ` · 전체의 ${Math.round((avgOf(d) / grandAvg) * 100)}%` : '')} />
          ))}
        </div>
      )}

      {!!rows.length && (
        <>
          <div className="card" style={{ padding: 8, marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              스토리지별 합산 처리량({data.split ? '법인별로 분리' : '법인 구분 없이 합산'}) · <b>{peak ? '피크 기준(버킷 안 포트별 최댓값 합)' : '평균 기준(버킷 안 포트별 평균 합)'}</b> · 버킷 폭 {bucketText(data.bucketMs)} ·
              상위 {chartSeries.length}개 · 스위치가 여러 대인 항목은 팹 A/B 를 합친 값입니다.
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="ts" tickFormatter={(t) => tsLabel(t, effHours)} fontSize={11} minTickGap={28} />
                <YAxis tickFormatter={(v) => bps(v * 8)} fontSize={11} width={78} />
                <Tooltip labelFormatter={(t) => new Date(t).toLocaleString()} formatter={(v, name) => [bytesPerSecText(v), name]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {chartSeries.map((s, i) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} dot={false}
                    stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={1.6} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="table-wrap" style={{ maxHeight: '40vh', overflow: 'auto' }}>
            <STable style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                {showDcCol && <col style={{ width: 110 }} />}
                <col /><col style={{ width: 150 }} /><col style={{ width: 70 }} />
                <col style={{ width: 110 }} /><col style={{ width: 110 }} /><col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr>
                  {showDcCol && <SortTh k="dc" label="법인" sort={sort} setSort={setSort} />}
                  <SortTh k="name" label="스토리지" sort={sort} setSort={setSort} />
                  <SortTh k="switches" label="연결 스위치" sort={sort} setSort={setSort} />
                  <SortTh k="ports" label="포트" sort={sort} setSort={setSort} />
                  <SortTh k="avg" label="평균" sort={sort} setSort={setSort}
                    title={peak ? '피크 기준: 버킷별 포트 MAX 합 선의 평균입니다(평소 피크 수준).' : '평균 기준: 버킷별 포트 AVG 합 선의 평균입니다(평소 사용량).'} />
                  <SortTh k="max" label="최대" sort={sort} setSort={setSort}
                    title={peak ? '피크 기준: 기간 내 최고 피크(버킷별 포트 MAX 합의 최댓값). 포트마다 최댓값 시각이 다를 수 있어 동시 총량의 상한입니다.' : '평균 기준: 버킷별 평균 합 선의 최댓값. 버킷이 넓을수록(긴 기간) 실제 피크보다 낮게 나옵니다 — 피크는 "피크 기준"으로 보세요.'} />
                  <SortTh k="cap" label="용량 사용률" sort={sort} setSort={setSort}
                    title="등록된 스토리지 장비의 시리얼이 이 어레이 시리얼과 일치할 때만 표시합니다. 대역폭(바쁨)과 용량(참)은 다른 축이라 나란히 봐야 합니다. 미매칭은 정렬에서 뒤로 갑니다." />
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr key={`${s.datacenterId ?? ''}|${s.key}`}>
                    {showDcCol && <td style={ELLIPSIS} title={s.datacenterName || ''}><b>{s.datacenterName || '—'}</b></td>}
                    <td style={ELLIPSIS} title={s.key}>
                      <b>{s.key}</b>
                      <div className="muted" style={{ fontSize: 10.5 }}>
                        {s.endpointKind === 'host' ? '호스트(HBA) · ' : ''}{s.arraySerial ? `S/N ${s.arraySerial}` : ''}
                      </div>
                    </td>
                    <td style={ELLIPSIS} title={s.switches.join(', ')}>{s.switches.join(', ')}</td>
                    <td>{s.portCount}</td>
                    <td>{bytesPerSecText(avgOf(s))}</td>
                    <td>{bytesPerSecText(maxOf(s))}</td>
                    <td>
                      {s.capacity
                        ? <span title={`${s.capacity.name} (${s.capacity.type})`}>
                            <UsageCell pct={s.capacity.pct ?? 0} />
                            <span className="muted" style={{ fontSize: 10.5, display: 'block', ...ELLIPSIS }}>{s.capacity.name}</span>
                          </span>
                        : <span className="muted" title="등록된 스토리지와 시리얼이 일치하지 않아 용량을 붙이지 않았습니다(억지 매칭 금지).">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            합산 대상 스위치: {data.switches.map((s) => s.name).join(' · ')}
          </div>
        </>
      )}
    </Modal>
  );
}

/** 포트 상세 — 이 화면이 '포트 모니터링'의 본체다. */
// ⚠ closeDetail 은 상위 컴포넌트의 함수라 **prop 으로 받아야** 한다 — v2.416 에서 응답 순서 가드를 넣으며 상위에만 정의하고
//   여기서 그대로 참조해, 포트 상세를 열면 ReferenceError 로 특수기능 화면 전체가 죽었다(v2.416~2.420 실제 장애, v2.421 수정).
//   eslint 에 no-undef 가 없어 잡지 못했다 → eslint.config.js 에 no-undef 추가.
function PortDetail({ detail, setDetail, closeDetail, portFilter, setPortFilter, portQ, setPortQ, infoOpen, setInfoOpen, tab, setTab, sort, setSort }) {
  const d = detail;
  const list = d.ports?.list || [];
  const unit = d.extra?.rateUnit || 'fps';
  const filtered = sortPorts(filterPorts(list, portFilter).filter((p) => {
    if (!portQ.trim()) return true;
    const s = portQ.trim().toLowerCase();
    return [p.slotPort, p.portType, p.attachedName, (p.attached || []).join(' '), p.sfpVendor, p.sfpSerial]
      .some((v) => String(v || '').toLowerCase().includes(s));
  }), sort.key, sort.dir);
  return (
    <Modal title={`포트 상세 — ${d.device?.name || ''}`} onClose={closeDetail} width={1180}>
      {d.loading && <Loading />}
      {d.error && <ErrorBox message={d.error} />}
      {/* v2.516: 수집이 **통째로 실패**한 장비는 아래 섹션 표도 만들어지지 않는다(원천이 없다).
          그래서 스냅샷의 오류 원문을 맨 위에 따로 보여준다 — 실패 배지를 눌러 여기로 온다.
          `<pre>` 로 두는 이유: 사용자가 사유를 선택·복사해 문의에 붙일 수 있어야 한다. */}
      {d.device?.snap && d.device.snap.ok === false && (
        <div className="card" style={{ padding: 10, marginBottom: 10, borderColor: TONE.bad }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: TONE.bad, marginBottom: 4 }}>수집 오류 원문</div>
          {d.device.snap.extra?.authStopped && (
            <div style={{ fontSize: 12.5, marginBottom: 6 }}>
              <BoldText text={authStopInfo(d.device.snap.extra.authStopped, { what: '이 스위치', manual: '수집' })?.text || ''} />
              {credFpText(d.device.snap.extra.credFp) && (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {`실제로 쓴 자격증명 지문${d.device.snap.extra.credFpSource ? `(${d.device.snap.extra.credFpSource === 'central' ? '중앙' : `엣지 ${d.device.snap.extra.credFpSource}`})` : ''}: `}
                  <BoldText text={credFpText(d.device.snap.extra.credFp)} />
                  {' '}— 등록값과 다르면 배포가 반영되지 않은 것이고, 같으면 장비의 비밀번호가 다를 가능성이 큽니다(짧은 해시라 같아도 단정하지 않습니다).
                </div>
              )}
            </div>
          )}
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, color: TONE.bad }}>{failReason(d.device.snap)}</pre>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            수집 시각 {ago(d.device.snap.collectedAt)} · 출처 {d.device.snap.agent || '중앙'}
            {' — '}단계별 로그는 <b>연결 테스트</b>(장비 수정 → 연결 테스트)에서, 과거 이력은 화면 하단 <b>수집 작업</b> 에서 봅니다.
          </div>
        </div>
      )}
      {!d.loading && !d.error && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {d.model || (d.extra?.switchType
              ? <span title="chassisshow 에서 모델명(Chassis Family)을 읽지 못했습니다. 대신 스위치가 보고한 switchType 원값을 그대로 표시합니다 — 타입 코드를 모델명으로 바꾸는 표는 확실하지 않아 넣지 않았습니다.">switchType {d.extra.switchType}</span>
              : '모델 미상')} · FOS {d.fabricOs || '—'} · {d.host || ''} · {d.source} · 수집 {ago(d.collectedAt)}
            {/* v2.517: 엣지 push 기본이 **전체 포트**로 바뀌었다(push.js 머리말 — gzip 실측 근거).
                그래서 이 배너는 '전체가 오지 않은 경우' 에만 뜨고, 세 원인(구버전 엣지 / 현장
                되돌림 / 크기 가드)을 **다르게** 안내한다 — 조치가 다르기 때문이다. 판정·문구는
                순수 모듈 `sanPortsScopeText.js` 가 소유한다(테스트가 고정). */}
            {(() => {
              const note = portsScopeNote({ agent: d.agent, ports: d.ports });
              if (!note) return null;
              return (
                <div style={{ color: TONE.warn, marginTop: 4 }}>
                  <BoldText text={note.text} />
                  {note.action && <div className="muted" style={{ marginTop: 2 }}>→ {note.action}</div>}
                </div>
              );
            })()}
            {d.extra?.rateReady === false && (
              <div style={{ marginTop: 4 }}>처리량은 두 번째 수집부터 표시됩니다(누적 카운터의 차이로 계산 — 첫 수집은 비교 대상이 없습니다).</div>
            )}
          </div>

          {/* 포트 목록 / 사용량 분석 전환(v2.411) — 분석 탭은 portperfshow 시계열 DB 를 읽는다. */}
          <div className="vc-views" style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
            {[['ports', '포트 목록'], ['perf', '📈 사용량 분석'], ['zoning', '🔗 조닝'], ['health', '🩺 점검']].map(([k, label]) => (
              <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 14px' }}
                onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === 'perf' && <PerfPanel deviceId={d.deviceId} ports={list} />}
          {/* 조닝(v2.511) — cfgshow 파싱 결과. 폴링하지 않는다(탭을 열 때 1회 조회). */}
          {tab === 'zoning' && <SanZoningPanel deviceId={d.deviceId} />}
          {/* 월간 점검(v2.519) — 저장된 스냅샷 판정. 폴링하지 않는다(탭을 열 때 1회). */}
          {tab === 'health' && <DeviceHealthPanel deviceId={d.deviceId} deviceName={d.name} />}

          {tab === 'ports' && <>
          <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 8 }}>
            {[['all', '전체'], ['online', '사용중'], ['free', '비어있음'], ['problem', '문제만']].map(([k, label]) => (
              <button key={k} className={portFilter === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }}
                onClick={() => setPortFilter(k)}>{label}</button>
            ))}
            {/* 장비 일반 정보(v2.411, 사용자 요구) — 수집은 하고 있었지만 화면에 쓰지 않던
                WWN·Domain·시리얼·팹·존·FRU·가동일을 여기서 보여준다. 요약은 한 줄,
                누르면 전체 항목이 펼쳐진다(표를 밀어내지 않게 기본은 접힘). */}
            <button className="tab" style={{ flex: 'none', padding: '4px 12px' }} onClick={() => setInfoOpen((v) => !v)}
              title="스위치 일반 정보 펼치기/접기">
              {infoOpen ? '▾' : '▸'} 장비 정보
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{infoSummary(d)}</span>
            <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 240 }} value={portQ} onChange={setPortQ}
              placeholder="포트·연결 장비·SFP 찾기" />
            <span className="muted" style={{ fontSize: 12 }}>{filtered.length} / {list.length}</span>
          </div>

          {infoOpen && <DeviceInfo d={d} />}

          {/* table-layout:fixed + 열 너비 명시(v2.411, 사용자 신고 '1줄에 길게 나와서 읽을 수 없음').
              기본 auto 레이아웃에서는 '연결 장비'의 긴 심볼릭 이름(SYMMETRIX::… 100자 이상)이
              칸을 밀고 나가 옆의 CRC 열 위에 겹쳐 그려졌다. 너비를 고정해야 어떤 값이 와도
              칸을 침범하지 못한다 — 긴 값은 셀 안에서 말줄임 처리하고 전문은 툴팁에 남긴다. */}
          <div className="table-wrap" style={{ maxHeight: '58vh', overflow: 'auto' }}>
            <STable style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: 96 }} />{/* 포트 */}
                <col style={{ width: 74 }} />{/* 상태 */}
                <col style={{ width: 58 }} />{/* 속도 */}
                <col style={{ width: 74 }} />{/* 타입 */}
                <col />{/* 연결 장비 — 남는 폭을 가져가되 넘치면 말줄임 */}
                <col style={{ width: 150 }} />{/* 에러 카운터 */}
                <col style={{ width: 132 }} />{/* 광레벨 */}
                <col style={{ width: 74 }} />{/* SFP 온도 */}
                <col style={{ width: 118 }} />{/* 처리량 */}
              </colgroup>
              {/* 제목 클릭으로 정렬(v2.411, 사용자 요구). 값이 없는 행은 방향과 무관하게 뒤로
                  간다(sanSwitchPorts.sortPorts) — 미수집이 맨 앞에 오면 오독을 만든다. */}
              <thead>
                <tr>
                  {[
                    ['index', '포트', ''],
                    ['state', '상태', ''],
                    ['speed', '속도', ''],
                    ['portType', '타입', ''],
                    ['attached', '연결 장비', ''],
                    ['err', 'CRC / LinkFail / LossSync', '누적 에러 카운터입니다 — 마지막 초기화 이후의 합계이며, 값이 크다고 지금 장애라는 뜻은 아닙니다. 정렬은 세 값의 합 기준입니다.'],
                    ['optical', '광레벨 Rx/Tx', `SFP 수신·송신 광레벨. 일반 권장 하한 ${RX_WARN_DBM} dBm, 위험 ${RX_BAD_DBM} dBm — 정확한 임계는 SFP 모델·거리에 따라 다릅니다. 정렬은 수신(Rx) 기준입니다.`],
                    ['temp', 'SFP 온도', ''],
                    ['throughput', '처리량 (In/Out)', ''],
                  ].map(([key, label, tip]) => (
                    <th key={key} onClick={() => setSort((c) => nextSort(c, key))}
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      title={`${tip ? `${tip}\n\n` : ''}클릭하면 이 열로 정렬합니다.`}>
                      {label}{tip ? ' ⓘ' : ''}
                      <span style={{ opacity: sort.key === key ? 1 : 0.25, marginLeft: 3 }}>
                        {sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const el = errorLevel(p);
                  const oh = opticalHealth(p.rxPowerDbm, p.txPowerDbm);
                  return (
                    <tr key={p.index}>
                      <td style={{ overflow: 'hidden' }}><b>{p.slotPort}</b><div className="muted" style={{ ...ELLIPSIS, fontSize: 10.5 }}>idx {p.index}{p.address ? ` · ${p.address}` : ''}</div></td>
                      <td><span style={{ color: TONE[stateTone(p.state)] }} title={p.stateRaw || ''}>{stateLabel(p.state)}</span></td>
                      <td>{p.speed || <span className="muted">—</span>}</td>
                      <td style={ELLIPSIS} title={p.portType || ''}>{p.portType || <span className="muted">—</span>}</td>
                      {/* 이름·WWN 모두 한 줄 말줄임. 전문은 툴팁(마우스 올리면 전체가 보인다). */}
                      <td style={{ overflow: 'hidden' }}
                        title={[p.attachedName, (p.attached || []).join(', ')].filter(Boolean).join('\n') || '연결된 장비 없음'}>
                        {p.attachedName
                          ? <div style={ELLIPSIS}>{shortDeviceName(p.attachedName)}</div>
                          : null}
                        <div className="muted" style={{ ...ELLIPSIS, fontSize: 10.5 }}>{(p.attached || []).join(', ') || '—'}</div>
                      </td>
                      <td style={{ color: TONE[el.level === 'ok' ? 'muted' : el.level] }}>
                        {p.errCrc ?? '—'} / {p.errLinkFail ?? '—'} / {p.errLossSync ?? '—'}
                      </td>
                      <td style={{ color: oh.level === 'none' ? TONE.muted : TONE[oh.level] }} title={oh.why}>
                        {p.rxPowerDbm ?? '—'} / {p.txPowerDbm ?? '—'}{oh.level === 'bad' || oh.level === 'warn' ? ' ⚠' : ''}
                      </td>
                      <td className="muted">{p.sfpTempC != null ? `${p.sfpTempC}℃` : '—'}</td>
                      <td title={throughputTitle(p)}>{throughputText(p, unit)}</td>
                    </tr>
                  );
                })}
                {!filtered.length && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 20 }}>조건에 맞는 포트가 없습니다.</td></tr>}
              </tbody>
            </STable>
          </div>

          </>}

          {Object.entries(d.sections || {}).filter(([, v]) => v && v !== 'ok').length > 0 && (
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              미수집 항목 — <b>포트 현황·사용량에는 영향이 없습니다.</b> 이 스위치가 그 명령을 제공하지 않거나 실행에 실패했습니다:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {Object.entries(d.sections).filter(([, v]) => v && v !== 'ok').map(([k, v]) => (
                  <li key={k} style={ELLIPSIS} title={String(v)}><b>{k}</b> — {String(v)}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
