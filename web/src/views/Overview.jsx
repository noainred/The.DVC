import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { usePolling, fetchJson, putJson } from '../api.js';
import { Kpi, Loading, ErrorBox, SeverityBadge } from '../components/ui.jsx';
import STable from '../components/STable.jsx';
import { unplacedRows, corpNoteText, physNoteText } from './overviewServerText.js';
import { unitText } from './unitText.js'; // v2.583: 미배치 물리 서버 행

const REGION_COLORS = { '아시아': '#22d3ee', '중국': '#ef4444', '유럽': '#a855f7', '북미': '#3b82f6', Unknown: '#64748b' };

export default function Overview({ onSelectSite, onGotoTab }) {
  const { data: ov, error, loading } = usePolling('/overview', {}, 15_000);
  const { data: alarmData } = usePolling('/alarms', { severity: undefined }, 15_000);


  // 글로벌 현황 KPI를 '1줄'로 유지 — 한 줄에 안 들어가 둘째 줄로 넘어간 박스는 통째로 숨긴다(부분 잘림 없음).
  const kpisRef = useRef(null);
  useLayoutEffect(() => {
    const el = kpisRef.current;
    if (!el) return undefined;
    let lastW = -1;
    const recompute = () => {
      const kids = Array.from(el.children);
      if (!kids.length) return;
      kids.forEach((k) => { k.style.display = ''; });
      const top0 = kids[0].offsetTop;
      kids.forEach((k) => { if (k.offsetTop > top0) k.style.display = 'none'; });
    };
    recompute();
    lastW = el.clientWidth;
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w === lastW) return; lastW = w; recompute(); });
    ro.observe(el);
    return () => ro.disconnect();
  });

  if (loading && !ov) return <Loading />;
  // 데이터가 이미 있으면 일시적 폴링 실패 1건으로 대시보드 전체를 오류 화면으로 갈아치우지 않는다
  // (고RTT 환경에서 지도·KPI가 다음 주기까지 통째로 사라지던 문제) — 데이터 위 배너로 표시.
  if (error && !ov) return <ErrorBox message={error} />;
  if (!ov) return null;
  // 서버 첫 수집 완료 전에는 rollups(=global)가 없다 — 방어 없이 g.vcentersConnected 접근 시
  // TypeError 로 대시보드가 크래시한다(재시작 직후 실제 발생). /health 는 rollups?.global||{} 로
  // 이미 방어하므로 여기서도 수집 완료 전이면 로딩으로 처리한다(v2.385).
  if (!ov.global) return <div className="muted" style={{ padding: 40, textAlign: 'center' }}>수집 준비 중… (첫 vCenter 수집 완료 후 표시)</div>;

  const g = ov.global;
  // v2.593(감사 DATA-05): 분모가 0 이면(호스트·데이터스토어 0 — 범위 계정의 vCenter 가 전부 연결 불가일 때 등) 서버 pct() 가
  //   0 을 준다. 그것을 '사용률 0%' 로 그리면 '비어 있다' 는 거짓이 된다 — 측정할 대상이 없으면 '—'.
  const cpuPct = g.hosts > 0 && Number(g.cpuTotalGhz) > 0 ? (g.cpuUsagePct ?? null) : null;
  const memPct = g.hosts > 0 && Number(g.memTotalGB) > 0 ? (g.memUsagePct ?? null) : null;
  const stoPct = g.datastores > 0 && Number(g.storageTotalTB) > 0 ? g.storageUsagePct : null;
  const regions = ov.byRegion || [];
  const sites = ov.sites || [];
  const alarms = (alarmData?.items || []).slice(0, 8);

  const fmt = (n) => n?.toLocaleString('en-US');

  // VM 분포 by 법인(vCenter)
  const corpVmData = sites.map((s) => ({
    name: s.id || s.name,
    VM: s.metrics?.vms || 0,
    On: s.metrics?.vmsPoweredOn || 0,
  }));
  const capacityData = [
    { name: 'CPU', used: cpuPct },
    { name: 'Memory', used: memPct },
    { name: 'Storage', used: stoPct },
  ];
  const osPie = regions.map((r) => ({ name: r.key, value: r.vms, fill: REGION_COLORS[r.key] || '#64748b' }));

  // ── 서버·게스트 수량 (v2.526, v2.527 에 '합/물리 전용/가상화 호스트' 로 재구성) ──────────
  // 사용자 요청: "전체 물리 서버 수량(idrac 에서 찾은 수량), 가상화 호스트 수량, 법인별 서버
  // 수량과 guestos 수량" → (v2.527) "서버의 합/물리서버/가상화 호스트 이렇게 구분해서 전체
  // 서버의 수량을 볼 수 있게 수정해줘".
  //
  // ★ 세 수는 **겹치지 않는다**(서버 `idrac/serverByCorp.js` 머리말):
  //     서버 합계 = 물리 전용 + 가상화 호스트(ESXi)
  //   이 현장은 iDRAC 등록 물리 서버 대부분이 곧 ESXi 호스트라, 단순히 더하면 같은 장비를
  //   두 번 센다. 그래서 '물리 서버' 열을 **'물리 전용'**(= 가상화 호스트로 확인되지 않은
  //   서버)으로 바꾸고, 확인된 중복 대수를 화면이 함께 밝힌다.
  //
  // 그 밖의 정직성 규칙:
  //  · 물리 서버는 **iDRAC 에 등록된 것만** 센다 — 등록되지 않은 물리 서버는 포탈이 모른다.
  //  · 법인에 귀속되지 않은 서버를 아무 법인에나 넣지 않는다(`unassigned` 로 따로 밝힌다).
  //  · 값을 못 구했으면 **0 이 아니라 '—'** 다 — '없다' 가 아니라 '모른다' 이므로.
  //  · 숫자(주기·상한)를 문구에 박지 않는다 — 서버가 준 값만 쓴다.
  const pbc = ov.physicalByCorp && !ov.physicalByCorp.error ? ov.physicalByCorp : null;
  const pbcErr = ov.physicalByCorp?.error || null;
  // 합계·물리 전용은 서버 집계가 있을 때만 말한다(추정해서 채우지 않는다).
  const serverUnion = pbc ? pbc.union : null;
  const physOnly = pbc ? pbc.physicalOnly : null;

  const unionNote = (() => {
    if (pbcErr) return `물리 서버 집계 실패: ${pbcErr}`;
    if (!pbc) return '물리 서버 귀속 정보를 불러오지 못했습니다';
    const parts = [`물리 전용 ${fmt(physOnly)} + 가상화 호스트 ${fmt(pbc.hostsTotal)}`];
    // '확인된 중복' 은 근거다 — 0 이어도 적는다. 0 은 '중복이 없다' 가 아니라 '못 찾았다' 일
    // 수 있으므로(이름·서비스태그가 안 맞는 경우) 그 사실도 함께 말한다.
    parts.push(pbc.matchedCount
      ? `같은 장비로 확인돼 중복 제외한 서버 ${fmt(pbc.matchedCount)}대`
      : '중복으로 확인된 장비 없음(이름·서비스태그가 맞지 않으면 못 찾을 수 있습니다)');
    return parts.join(' · ');
  })();
  // v2.583(사용자 신고 "서버 합계에 물리서버 수량 안나오는거 수정해줘"): 예전에는 법인 미귀속 물리 서버가
  // 문구 한 줄로만 밝혀지고 표에는 없어 '물리 전용' 열이 전 행 0 으로 보였다. 이제 서버가 법인(DataCenter)·
  // 관리자 지정으로 vCenter 행을 정하고, 정하지 못한 것은 표 아래 고정 행으로 보인다(overviewServerText.js).
  const physNote = (() => {
    if (pbcErr) return 'iDRAC 집계 실패 — 설정 › iDRAC 등록을 확인하세요';
    if (!pbc) return '물리 서버 귀속 정보를 불러오지 못했습니다';
    return physNoteText(pbc);
  })();
  const corpNote = (() => {
    if (pbcErr) return `물리 서버 집계 실패: ${pbcErr}`;
    if (!pbc) return '물리 서버 귀속 정보를 불러오지 못했습니다';
    return corpNoteText(pbc);
  })();
  const extraRows = pbc ? unplacedRows(pbc) : [];
  const corpRows = sites.map((s) => {
    const m = s.metrics || {};
    const hosts = m.hosts || 0;
    const vms = m.vms || 0;
    // 서버 집계를 못 받았으면 0 이 아니라 null 이다('서버가 없다' 는 거짓을 만들지 않는다).
    const only = pbc ? (pbc.byVcenterPhysicalOnly?.[s.id] ?? 0) : null;
    return {
      id: s.id,
      name: s.name || s.id,
      physOnly: only,
      hosts,
      total: only == null ? null : only + hosts,
      vms,
      vmsOn: m.vmsPoweredOn || 0,
      perHost: hosts ? (vms / hosts).toFixed(1) : null,
    };
  });

  return (
    <div className="ov">
      {error && <div className="badge red" style={{ marginBottom: 8 }}>갱신 실패(직전 데이터 표시 중): {error}</div>}
      <div className="ov-console">
        <div className="ov-console-label"><b>▸</b> GLOBAL INFRASTRUCTURE OVERVIEW</div>
        <div className="ov-console-status">
          <i />
          <span><b>{g.vcentersConnected}</b>/{g.vcenters} VCENTERS</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span><b>{fmt(g.hosts)}</b> HOSTS</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span><b>{fmt(g.vms)}</b> VMS</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ color: 'var(--mint)' }}>LIVE</span>
        </div>
      </div>
      <div className="kpis" ref={kpisRef} title="한 줄에 안 들어가는 KPI는 자동으로 숨겨집니다(창을 넓히면 더 보입니다).">
        <Kpi label="vCenter" value={`${g.vcentersConnected}/${g.vcenters}`}
          meta={`${Math.max(0, g.vcenters - g.vcentersConnected - (g.vcentersMaintenance || 0) - (g.vcentersDisabled || 0))}개 연결 불가${g.vcentersMaintenance ? ` · 점검중 ${g.vcentersMaintenance}` : ''}${g.vcentersDisabled ? ` · 비활성 ${g.vcentersDisabled}` : ''}`}
          accent="var(--accent-2)" onClick={() => onGotoTab?.('vcenters')} />
        <Kpi label="ESXi 호스트" value={fmt(g.hosts)} meta={`정상 ${g.hostsConnected} · 점검 ${g.hostsMaintenance} · 끊김 ${g.hostsDisconnected}`} onClick={() => onGotoTab?.('hosts')} />
        <Kpi label="가상머신" value={fmt(g.vms)} meta={`구동중 ${fmt(g.vmsPoweredOn)} · 정지 ${fmt(g.vmsPoweredOff)}`} accent="var(--green)" onClick={() => onGotoTab?.('vms')} />
        {/* v2.486: 사용률(%)은 vCenter(ESXi 호스트) 실측이고, 두 번째 줄은 iDRAC 가 인식한 모든 물리 서버(베어메탈 포함)의
            코어·메모리 합계 — 출처가 달라 나란히 표기한다(물리 합계로 %를 다시 계산하지 않음: 베어메탈은 사용률 자료가 없다). */}
        <Kpi label="CPU 사용률" value={unitText(cpuPct, '%')} pct={cpuPct ?? undefined} meta={<>
          {g.cpuUsedGhz} / {g.cpuTotalGhz} GHz · ESXi {fmt(g.cpuCores)} cores
          {(g.hostsUsageExcluded ?? g.hostsDisconnected) > 0 && <span title="연결이 끊긴 호스트는 사용량을 알 수 없어 사용률 계산에서 뺐습니다(용량 합계에는 포함)"> · 끊긴 호스트 {fmt(g.hostsUsageExcluded ?? g.hostsDisconnected)}대 사용률 제외</span>}
          {ov.physical?.servers > 0 && <><br />물리 서버 코어 <b>{fmt(ov.physical.cores)}</b> · iDRAC {fmt(ov.physical.servers)}대{ov.physical.withCores < ov.physical.servers ? ` (코어 정보 ${fmt(ov.physical.withCores)}대)` : ''}</>}
        </>} />
        <Kpi label="메모리 사용률" value={unitText(memPct, '%')} pct={memPct ?? undefined} meta={<>
          {fmt(g.memUsedGB)} / {fmt(g.memTotalGB)} GB (ESXi){(g.hostsUsageExcluded ?? g.hostsDisconnected) > 0 ? ` · 끊긴 호스트 ${fmt(g.hostsUsageExcluded ?? g.hostsDisconnected)}대 사용률 제외` : ''}
          {ov.physical?.servers > 0 && <><br />물리 메모리 <b>{fmt(ov.physical.memGB)}</b> GB · iDRAC {fmt(ov.physical.servers)}대{ov.physical.withMemory < ov.physical.servers ? ` (메모리 정보 ${fmt(ov.physical.withMemory)}대)` : ''}</>}
        </>} />
        <Kpi label="스토리지 사용률" value={unitText(stoPct, '%')} pct={stoPct ?? undefined} meta={`${g.storageUsedTB} / ${g.storageTotalTB} TB · ${g.datastores} DS`} onClick={() => onGotoTab?.('datastores')} />
        {g.powerReporting > 0 && (
          <Kpi label="총 소비전력" value={`${fmt(g.powerKw)} kW`} accent="var(--amber)"
            meta={g.powerRegistered != null && g.powerRegistered !== g.powerReporting
              ? `전력 보고 ${fmt(g.powerReporting)}대 / 등록 ${fmt(g.powerRegistered)}대`
              : `전력 보고 ${fmt(g.powerReporting)}대 합계`}
            onClick={() => { window.location.hash = '#/tools/insights-hub'; }} />
        )}
        <Kpi label="GPU 카드 수량" value={fmt(ov.gpuCards)} accent="var(--accent-2)" meta="설치된 GPU 장수" onClick={() => onGotoTab?.('tools')} />
        <Kpi label="GPU 사용 VM 수량" value={fmt(ov.gpuVms)} accent="var(--green)" meta="GPU 할당된 VM 수" onClick={() => onGotoTab?.('tools')} />
      </div>

      {/* v2.526(사용자 요청 "overview 에서 지도 없애줘"): 세계 지도를 제거했다.
          ⚠ `components/WorldMap.jsx` 자체는 지우지 않는다 — 관제 콘솔(`console/pages/ConsoleOverview.jsx`)이
            같은 컴포넌트를 쓴다. 여기서만 뺀다. 서버의 `ui-settings` 지도 값(mapHeight/mapLambda/…)도
            그 화면이 계속 쓰므로 건드리지 않았다. */}

      {/* v2.526(사용자 요청): 서버·게스트 수량. v2.527 에 '합 / 물리 전용 / 가상화 호스트' 로 재구성 */}
      <div className="section-title">서버·게스트 수량</div>
      {/* ⚠ `cols-4` 같은 클래스는 styles.css 에 없다 — `.kpis`(auto-fit minmax 180px)를 쓸 것.
          쓰면 `.grid` 만 걸려 1열이 되고 카드가 세로로 쌓인다(v2.526 실제 결함). */}
      <div className="kpis" style={{ marginBottom: 12 }}>
        <Kpi label="서버 합계" value={serverUnion == null ? '—' : fmt(serverUnion)} accent="var(--accent)"
          meta={unionNote} onClick={() => onGotoTab?.('hosts')} />
        <Kpi label="물리 전용 서버" value={physOnly == null ? '—' : fmt(physOnly)} accent="var(--accent-2)"
          meta={physNote} onClick={() => onGotoTab?.('tools')} />
        <Kpi label="가상화 호스트(ESXi)" value={fmt(g.hosts)} accent="var(--accent)"
          meta={`정상 ${fmt(g.hostsConnected)} · 점검 ${fmt(g.hostsMaintenance)} · 끊김 ${fmt(g.hostsDisconnected)}`}
          onClick={() => onGotoTab?.('hosts')} />
        <Kpi label="게스트 OS(VM)" value={fmt(g.vms)} accent="var(--green)"
          meta={`구동중 ${fmt(g.vmsPoweredOn)} · 정지 ${fmt(g.vmsPoweredOff)}`}
          onClick={() => onGotoTab?.('vms')} />
        <Kpi label="호스트당 게스트" value={g.hosts ? (g.vms / g.hosts).toFixed(1) : '—'}
          meta="전체 VM ÷ 가상화 호스트" />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="flex between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
          <b>법인별 서버·게스트 수량</b>
          <span className="muted" style={{ fontSize: 11.5 }}>{corpNote}</span>
        </div>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <STable className="v3-table">
            <thead>
              <tr>
                <th>법인(vCenter)</th><th>서버 합계</th><th>물리 전용</th><th>가상화 호스트</th>
                <th>게스트 OS</th><th>구동중</th><th>호스트당 게스트</th>
              </tr>
            </thead>
            <tbody>
              {corpRows.map((r) => (
                <tr key={r.id}>
                  {/* 지도를 없앤 뒤 '사이트를 눌러 그 법인 호스트로 이동' 경로가 사라지지 않게,
                      법인 이름을 그 진입점으로 남긴다(지도가 하던 onSelectSite 와 같은 동작).
                      ⚠ v2.527(사용자 신고 "법인 글자가 파란색이라서 안보여"): `<a>` 기본 링크
                      색은 이 어두운 표에서 읽기 어렵다. **표의 다른 글자와 같은 색**을 쓰고
                      클릭 가능하다는 것은 점선 밑줄로 알린다(App.jsx:409 의 `openList` 관례). */}
                  <td>
                    <span role="button" tabIndex={0} title="클릭하면 이 법인의 호스트 목록으로 이동합니다"
                      onClick={() => onSelectSite?.(r.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSite?.(r.id); } }}
                      style={{ color: 'inherit', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
                      {r.name}
                    </span>
                  </td>
                  {/* 서버 집계를 못 받았으면 0 이 아니라 '—' 다 — iDRAC 에 등록되지 않았거나
                      이름·태그로 이 vCenter 에 연결되지 않은 것이지 '서버가 없다' 는 뜻이 아니다. */}
                  <td data-sort={String(r.total ?? -1)}><b>{r.total == null ? '—' : fmt(r.total)}</b></td>
                  <td data-sort={String(r.physOnly ?? -1)}>{r.physOnly == null ? '—' : fmt(r.physOnly)}</td>
                  <td data-sort={String(r.hosts)}>{fmt(r.hosts)}</td>
                  <td data-sort={String(r.vms)}>{fmt(r.vms)}</td>
                  <td data-sort={String(r.vmsOn)} className="muted">{fmt(r.vmsOn)}</td>
                  <td data-sort={String(r.perHost ?? -1)} className="muted">{r.perHost ?? '—'}</td>
                </tr>
              ))}
              {/* v2.583: vCenter 행을 정하지 못한 물리 서버 — 정렬에서 빼고 표 아래에 고정한다(data-pin). */}
              {extraRows.map((r) => (
                <tr key={r.id} data-pin title={r.title}>
                  <td className="muted" style={{ fontWeight: 600 }}>{r.name}</td>
                  <td><b>{fmt(r.total)}</b></td>
                  <td>{fmt(r.physOnly)}</td>
                  <td className="muted">—</td><td className="muted">—</td><td className="muted">—</td><td className="muted">—</td>
                </tr>
              ))}
              {!corpRows.length && !extraRows.length && <tr><td colSpan={7} className="muted">표시할 법인이 없습니다.</td></tr>}
            </tbody>
          </STable>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 12 }}>
            <b>법인별 VM 분포</b>
            <span className="muted" style={{ fontSize: 12 }}>전원 On / 전체</span>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={corpVmData} margin={{ top: 5, right: 10, left: -10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" />
              <XAxis dataKey="name" stroke="#8b9bb4" fontSize={10} interval={0} angle={-30} textAnchor="end" height={60} />
              <YAxis stroke="#8b9bb4" fontSize={12} />
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} cursor={{ fill: 'rgba(59,130,246,.08)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="VM" fill="#334b7a" radius={[4, 4, 0, 0]} />
              <Bar dataKey="On" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <b>글로벌 리소스 사용률</b>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart layout="vertical" data={capacityData} margin={{ top: 14, right: 20, left: 10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243049" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} stroke="#8b9bb4" fontSize={12} unit="%" />
              <YAxis type="category" dataKey="name" stroke="#8b9bb4" fontSize={12} width={70} />
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} cursor={{ fill: 'rgba(59,130,246,.08)' }} formatter={(v) => `${v}%`} />
              <Bar dataKey="used" radius={[0, 4, 4, 0]}>
                {capacityData.map((d, i) => (
                  <Cell key={i} fill={d.used >= 90 ? '#ef4444' : d.used >= 75 ? '#f59e0b' : '#22c55e'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="flex between" style={{ marginBottom: 6 }}>
            <b>최근 알람</b>
            <button className="tab" onClick={() => onGotoTab?.('alarms')}>전체 보기 →</button>
          </div>
          {alarms.length === 0 && <div className="muted" style={{ padding: 16 }}>활성 알람이 없습니다.</div>}
          {alarms.map((a) => (
            <div className="alarm-row" key={a.id}>
              <div className={`alarm-sev ${a.severity}`} />
              <div className="alarm-body">
                <div className="alarm-msg">{a.message}</div>
                <div className="alarm-meta">{a.entity} · {a.vcenterId} · {new Date(a.time).toLocaleString('ko-KR')}</div>
              </div>
              <SeverityBadge severity={a.severity} />
            </div>
          ))}
        </div>

        <div className="card">
          <b>리전별 워크로드 비중</b>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={osPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3}>
                {osPie.map((d, i) => <Cell key={i} fill={d.fill} />)}
              </Pie>
              <Tooltip contentStyle={tipStyle} itemStyle={itemStyle} labelStyle={labelStyle} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

const tipStyle = {
  background: '#0c1322', border: '1px solid #243049', borderRadius: 8, color: '#e6edf6', fontSize: 12,
};
const itemStyle = { color: '#e6edf6' };
const labelStyle = { color: '#8b9bb4' };
