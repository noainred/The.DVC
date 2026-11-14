/**
 * 디스크 배드 섹터 분석(v3.8.0) — 전 법인 서버의 iDRAC Lifecycle 로그에서 찾은 배드 섹터 기록.
 *
 * 설계: docs/design/idrac-disk-badsector/README.md(시안 Fleet · FleetCorp · Scan · Refs · Basis).
 * 구현 범위 A(사용자 선택 2026-11-14): 수집 · 분류 · 판정(근거 포함) · 전 법인 / 법인별 분석 · 점검(전체 · 법인 · 서버) · 6시간 자동 · 메일 · 근거.
 * '지금 쓰이는 곳' · 조치 우선순위 · 디스크 상태 값 · 설정 점검은 다음 단계다(이 화면에 없다).
 *
 * 화면 규칙:
 *  · 맨 위는 '이 숫자를 믿어도 되는가' — 읽은 서버 / 전체, 못 읽은 서버, 제외(HPE iLO), 데모 합성 여부.
 *  · 판정 · 라벨 · 분류표는 서버가 내려준다(이 파일은 조립만). 문구 판정은 diskBadText.js(vitest).
 *  · 무거운 집계라 폴링하지 않는다 — 마운트 1회 + 버튼. 점검이 도는 동안만 가벼운 작업 조회를 10초마다.
 *  · 훅은 전부 조기 return 위.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, hasRole, usePolling } from '../../api.js';
import { useHashTab } from '../../hooks/useHashTab.js';
import { Loading, ErrorBox, Kpi, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { DiskBadServerPanel } from './DiskBadServerPanel.jsx';
import { fmtDate, fmtDateTime, rateText, pctText, num, clsTone, verdictTone, confidenceTone, noteOf, clsOfCode, JOB_STATE_LABEL, jobStateTone, unitProgress, scopeLabel, shortLogNote, spanText, scanSent, pastCoverageText, traceTone, valCell } from './diskBadText.js';

const TABS = [
  { k: 'summary', label: '요약' }, { k: 'disks', label: '디스크 목록' }, { k: 'corps', label: '국가 · 법인' },
  { k: 'models', label: '모델' }, { k: 'trend', label: '추이' }, { k: 'servers', label: '서버' }, { k: 'basis', label: '근거' }, { k: 'scan', label: '점검' },
];
const VERDICT_FILTERS = [{ k: 'inUse', label: '아직 사용 중' }, { k: 'replaced', label: '교체됨' }, { k: 'unknown', label: '판단 불가' }, { k: '', label: '전체' }];

const box = { border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', minWidth: 0 };
const bar = (pct, color = 'var(--accent)') => <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-soft)', overflow: 'hidden', minWidth: 80 }}><div style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, height: '100%', background: color }} /></div>;

export function DiskBadTool() {
  const [tab, setTab] = useHashTab({ base: ['tools', 'disk-bad'], valid: TABS.map((t) => t.k), fallback: 'summary' });
  const [corp, setCorp] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [vf, setVf] = useState('inUse');
  const [detail, setDetail] = useState(null);
  const reqSeq = useRef(0);
  const load = (c = corp) => {
    const seq = ++reqSeq.current;
    setErr(null);
    return fetchJson('/tools/disk-bad', c ? { corp: c } : {})
      .then((d) => { if (seq === reqSeq.current) { setData(d); setJobs(d.jobs); } })
      .catch((e) => { if (seq === reqSeq.current) setErr(e); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(corp); }, [corp]);
  const running = (jobs || []).some((j) => j.running);
  // 점검이 도는 동안만 가벼운 작업 조회를 10초마다(무거운 집계는 다시 부르지 않는다 — 끝나면 한 번 다시 읽는다).
  const jobsPoll = usePolling(running ? '/tools/disk-bad/jobs' : null, {}, 10_000);
  useEffect(() => {
    const d = jobsPoll.data;
    if (!d) return;
    setJobs(d.jobs);
    if (!d.jobs.some((j) => j.running)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsPoll.data]);
  const fleet = data?.fleet || null;
  const labels = data?.labels || null;
  const canScan = hasRole('admin', 'operator');
  const corpName = useMemo(() => (data?.corps || []).find((c) => c.id === corp)?.name || '', [data, corp]);

  if (err && !data) return <ErrorBox error={err} />;
  if (!data) return <Loading label="디스크 배드 섹터 분석" />;
  if (!fleet) return <ErrorBox message={`디스크 배드 섹터 DB 를 열지 못했습니다 — ${data.db?.error || '포탈 로그를 확인하세요'}`} />;
  const T = fleet.totals;
  const shortNote = shortLogNote(T);
  const refs = labels.refs;
  const openServer = (r) => setDetail({ id: r.serverId, name: r.serverName, agent: r.agent ?? '' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div className="flex between" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12.5 }}>서버 iDRAC Lifecycle 로그에서 찾은 배드 섹터 기록 — 아직 쓰고 있는 디스크, 국가 · 법인별, 모델별, 월별 추이.</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <label className="muted" htmlFor="dbad-corp" style={{ fontSize: 12 }}>범위</label>
            <Select id="dbad-corp" className="select" value={corp} onChange={(e) => setCorp(e.target.value)} sort={false} style={{ minWidth: 220 }}>
              <option value="">{data.scoped ? '내 법인 전체' : '전체 법인'}</option>
              {data.corps.map((c) => <option key={c.id} value={c.id}>{c.country ? `${c.country} · ` : ''}{c.name} ({c.servers}대)</option>)}
            </Select>
            {corp && <span className="badge blue" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{corpName} 만 보는 중 <button className="tab" style={{ flex: 'none', padding: '0 6px', fontSize: 11 }} onClick={() => setCorp('')}>전체로</button></span>}
          </div>
        </div>
        <div className="tabs" role="tablist" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TABS.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} className={tab === t.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 11px' }} onClick={() => setTab(t.k)}>{t.label}</button>)}
        </div>
      </div>

      <div className="flex between" style={{ ...box, gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, minWidth: 0 }}>
          <b>서버 {num(T.servers)}대 중 {num(T.read)}대 읽음</b> · 못 읽음 {num(T.unread)}대 · 제외 {num(T.excluded)}대(HPE iLO)
          <div className="muted" style={{ fontSize: 12 }}>
            {data.auto?.enabled ? `${data.auto.intervalHours}시간마다 자동 점검(새 로그만)` : '자동 점검 꺼짐 — 점검 탭에서 켜거나 직접 점검합니다'}
            {' · '}못 읽은 서버의 디스크는 아래 수치에 들어 있지 않습니다{fleet.synthesized ? ' · 데모(합성) 결과가 섞여 있습니다' : ''}
          </div>
        </div>
        {canScan && <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => setTab('scan')}>{running ? '점검 진행 보기' : '지금 점검'}</button>}
      </div>

      {shortNote && (
        <div style={{ border: '1px solid rgba(245,158,11,.55)', background: 'rgba(245,158,11,.09)', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.6, minWidth: 0 }}>
          <b>{shortNote.title}</b>
          <div>{shortNote.body}</div>
        </div>
      )}

      <div className="kpis">
        <Kpi label="기록이 있는 디스크 자리" value={num(T.recordSlots)} meta={`서버 ${num(T.serversWithRecords)}대 · 기록 ${num(T.records)}건`} />
        <Kpi label="그 디스크를 아직 사용 중" value={num(T.inUse)} accent={T.inUse > 0 ? 'var(--red)' : undefined} meta="확정 + 추정" />
        <Kpi label="이미 교체됨" value={num(T.replaced)} />
        <Kpi label="판단 불가" value={num(T.unknown)} meta="근거가 모자라 말하지 않음" />
        <Kpi label="디스크 1,000개당 기록 디스크" value={rateText(T.ratePer1000)} meta={`읽은 디스크 ${num(T.disks)}개 기준`} />
      </div>

      {tab === 'summary' && <Summary fleet={fleet} refs={refs} openServer={openServer} setTab={setTab} setCorp={setCorp} />}
      {tab === 'disks' && <Disks fleet={fleet} refs={refs} vf={vf} setVf={setVf} openServer={openServer} />}
      {tab === 'corps' && <Corps fleet={fleet} setCorp={setCorp} canScan={canScan} onScanned={() => { setTab('scan'); load(); }} />}
      {tab === 'models' && <Models fleet={fleet} />}
      {tab === 'trend' && <Trend fleet={fleet} />}
      {tab === 'servers' && <Servers fleet={fleet} labels={labels} openServer={openServer} />}
      {tab === 'basis' && <Basis refs={refs} labels={labels} />}
      {tab === 'scan' && <ScanPanel data={data} jobs={jobs || []} corp={corp} canScan={canScan} reload={load} setJobs={setJobs} />}

      {detail && (
        <Modal title={`${detail.name} — 디스크 이력`} onClose={() => setDetail(null)} width={980}>
          <DiskBadServerPanel serverId={detail.id} agent={detail.agent} />
        </Modal>
      )}
    </div>
  );
}

function InUseTable({ list, refs, openServer, limit = 0 }) {
  if (!list.length) return <div className="muted" style={{ fontSize: 12.5 }}>해당하는 디스크가 없습니다.</div>;
  return (
    // 1440px 카드(약 1,130px)에 '근거' 열까지 들어오게 — 위치는 서버 칸 아래, 최근 기록은 기록 칸 아래에 싣는다(화면 재확인에서 근거 열이 카드 밖으로 밀렸다).
    <STable className="data-table" minWidth={1080} limit={limit} style={{ width: '100%', fontSize: 12.5 }}>
      <thead><tr><th>국가 · 법인</th><th>서버 · 위치</th><th>모델 · 시리얼</th><th>기록 · 최근</th><th>판정</th><th data-nosort style={{ minWidth: 240 }}>근거</th></tr></thead>
      <tbody>{list.map((s) => (
        <tr key={`${s.agent}|${s.serverId}|${s.slotKey}`}>
          <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{s.country ? `${s.country} · ` : ''}{s.corpName}</td>
          <td data-sort={s.serverName}><button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => openServer(s)}>{s.serverName}</button><div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{s.label}</div></td>
          <td>{s.drive ? <>{s.drive.model || '—'}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>S/N {s.drive.serial || '—'}</div></> : <span className="muted">—</span>}</td>
          <td data-sort={s.last}>{Object.entries(s.byCode).map(([c, n]) => <span key={c} className={`badge ${clsTone(clsOfCode(c, refs))}`} style={{ marginRight: 4 }} title={noteOf(c, refs)}>{c} {n}</span>)}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)', marginTop: 2 }}>최근 {fmtDate(s.last)}</div></td>
          <td data-sort={s.verdict}><span className={`badge ${verdictTone(s.verdict)}`}>{s.verdictLabel}</span> <span className={`badge ${confidenceTone(s.confidence)}`}>{s.confidenceLabel}</span></td>
          <td style={{ fontSize: 11.5, minWidth: 240, maxWidth: 360, whiteSpace: 'normal' }} className="muted">{s.evidence[s.evidence.length - 1]?.text || '—'}</td>
        </tr>
      ))}</tbody>
    </STable>
  );
}

/**
 * iDRAC 가 **지금** 알리는 디스크 상태(v3.8.2) — Lifecycle 로그의 과거 기록과 별개의 근거다. 활성 로그가 며칠치뿐이어도 여기는 보인다.
 * 판정 · 낱말은 서버가 준다(파트 장애 기능과 같은 코어 — 주의 · 이상). '배드 섹터가 났다' 는 뜻이 아니라고 밝힌다.
 */
function AlertingCard({ fleet, openServer }) {
  const T = fleet.totals;
  const list = fleet.alerting || [];
  if (!Number.isFinite(T.alertingDisks)) return null;   // 3.8.2 이전 중앙 응답 — 표시하지 않는다(0 이라고 하지 않는다)
  const unknown = Number.isFinite(T.drivesUnknownServers) && T.drivesUnknownServers > 0 ? ` · 디스크 목록을 읽지 못한 서버 ${num(T.drivesUnknownServers)}대는 빠져 있습니다` : '';
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <b style={{ fontSize: 13.5 }}>iDRAC 가 지금 이상을 알리는 디스크 <span className="muted" style={{ fontWeight: 400 }}>{num(T.alertingDisks)}개 · 서버 {num(T.alertingServers)}대</span></b>
      <div className="muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
        iDRAC 가 보고하는 현재 디스크 상태(주의 · 이상)와 고장 예측입니다 — 배드 섹터 기록과는 별개의 근거이고, 이것만으로 ‘배드 섹터가 났다’ 고 하지 않습니다{unknown}.
      </div>
      {list.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>지금 iDRAC 가 주의 · 이상으로 알리는 디스크는 없습니다(디스크 목록을 읽은 서버 기준).</div> : (
        <STable className="data-table" minWidth={860} limit={10} style={{ width: '100%', fontSize: 12.5 }}>
          <thead><tr><th>국가 · 법인</th><th>서버 · 위치</th><th>모델 · 시리얼</th><th>iDRAC 상태</th><th>배드 섹터 기록</th></tr></thead>
          <tbody>{list.map((a, i) => (
            <tr key={`${a.agent}|${a.serverId}|${a.slotKey || a.serial || i}`}>
              <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{a.country ? `${a.country} · ` : ''}{a.corpName}</td>
              <td data-sort={a.serverName}><button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => openServer(a)}>{a.serverName}</button><div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{a.label || '위치 모름'}</div></td>
              <td>{a.model || '—'}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>S/N {a.serial || '—'}</div></td>
              <td data-sort={a.level === 'fault' ? 2 : 1}><span className={`badge ${a.level === 'fault' ? 'red' : 'amber'}`}>{a.levelLabel}</span>{a.predictive && <span className="badge blue" style={{ marginLeft: 4 }}>고장 예측</span>}{a.raw && <div className="muted" style={{ fontSize: 11.5 }}>iDRAC 값 {a.raw}</div>}</td>
              <td data-sort={a.hasRecords ? 1 : 0}>{a.hasRecords ? <span className="badge red">기록 있음</span> : <span className="muted">읽은 로그에 없음</span>}</td>
            </tr>
          ))}</tbody>
        </STable>
      )}
    </div>
  );
}

/**
 * 과거 기록 읽기 1단계(README §22) — 로그 기록은 없는데 디스크가 적어 둔 누적 값에 흔적이 있는 디스크. 판정 · 낱말은 서버(verdict.js)가 준다.
 * 값은 누적이라 날짜가 없다 — '흔적 있음 · 날짜 모름'. 출처별로 몇 대를 읽었는지(못 읽은 서버는 0 이 아니라 모름)를 같이 말한다.
 */
function TraceCard({ fleet, openServer }) {
  const T = fleet.totals;
  const cov = pastCoverageText(T);
  if (!cov) return null;   // 옛 중앙 응답 — 표시하지 않는다(0 이라고 하지 않는다)
  const list = fleet.traces || [];
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <b style={{ fontSize: 13.5 }}>로그 기록은 없는데 디스크 값에 흔적이 있는 디스크 <span className="muted" style={{ fontWeight: 400 }}>{num(T.traceDisks)}개 · 서버 {num(T.traceServers)}대 · 복구 불가 흔적 {num(T.traceUnrecoverable)}개{Number.isFinite(fleet.tracesTotal) && fleet.tracesTotal > list.length ? ` · 복구 불가 · 재할당 많은 순 ${num(list.length)}개만 싣습니다` : ''}</span></b>
      <div className="muted" style={{ fontSize: 12, margin: '2px 0 6px', lineHeight: 1.6 }}>
        디스크가 스스로 적어 둔 누적 값(재할당 · 보류 · 복구 불가)입니다 — 로그가 넘어가도 남지만 언제 생겼는지는 모릅니다. 값을 읽은 디스크만 셉니다.
        <div>{cov.vals}</div>
        <div>{cov.sel}</div>
      </div>
      {list.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>값을 읽은 디스크 가운데 로그 기록 없이 흔적만 있는 디스크는 없습니다.</div> : (
        <STable className="data-table" minWidth={900} limit={10} style={{ width: '100%', fontSize: 12.5 }}>
          <thead><tr><th>국가 · 법인</th><th>서버 · 위치</th><th>모델 · 시리얼</th><th style={{ textAlign: 'right' }}>재할당</th><th style={{ textAlign: 'right' }}>보류</th><th style={{ textAlign: 'right' }}>복구 불가</th><th>판정</th></tr></thead>
          <tbody>{list.map((d, i) => (
            <tr key={`${d.agent}|${d.serverId}|${d.id || i}`}>
              <td style={{ whiteSpace: 'normal', minWidth: 140 }}>{d.country ? `${d.country} · ` : ''}{d.corpName}</td>
              <td data-sort={d.serverName}><button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => openServer(d)}>{d.serverName}</button><div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{d.label}{d.logRead === false ? ' · 로그는 못 읽음' : ''}</div></td>
              <td>{d.model || '—'}<div className="muted" style={{ fontSize: 11.5, fontFamily: 'var(--mono)' }}>S/N {d.serial || '—'}{d.vals?.stale ? ` · 지난 값(${fmtDate(d.vals.readAt)})` : ''}</div></td>
              <td data-sort={d.vals?.realloc ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{valCell(d.vals?.realloc)}</td>
              <td data-sort={d.vals?.pending ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{valCell(d.vals?.pending)}</td>
              <td data-sort={d.vals?.uncorrectable ?? ''} style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>{valCell(d.vals?.uncorrectable)}</td>
              <td data-sort={d.trace}><span className={`badge ${traceTone(d.trace)}`}>{d.traceLabel}</span></td>
            </tr>
          ))}</tbody>
        </STable>
      )}
    </div>
  );
}

function Summary({ fleet, refs, openServer, setTab, setCorp }) {
  return (
    <>
      <div className="card" style={{ padding: 12, minWidth: 0 }}>
        <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <b style={{ fontSize: 13.5 }}>배드 섹터 기록이 있는데 아직 쓰고 있는 디스크 <span className="muted" style={{ fontWeight: 400 }}>{fleet.inUse.length}개 · 복구 불가 많은 순</span></b>
          {fleet.inUse.length > 10 && <button className="tab" style={{ flex: 'none' }} onClick={() => setTab('disks')}>전부 보기</button>}
        </div>
        <InUseTable list={fleet.inUse.slice(0, 10)} refs={refs} openServer={openServer} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>빨강(복구 불가) = PDR46 · PDR47 · PDR63 · PDR64 / 주황 = PDR54(미디어 오류를 고쳐 씀) · PDR59(불량 블록을 옮김) · PDR57(불량 블록 표가 차 감) / 파랑 = PDR16(고장 예측 — 배드 섹터 수에 넣지 않음). 근거 칸은 판단 근거의 마지막 줄입니다 — 서버를 누르면 전부 봅니다.</div>
      </div>
      <AlertingCard fleet={fleet} openServer={openServer} />
      <TraceCard fleet={fleet} openServer={openServer} />
      {/* 법인 표(최소 640px)가 1440px 화면의 반쪽 카드에서 잘리지 않게 — 두 카드가 나란히 서려면 칸마다 700px 이상(넓은 화면만). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 700px), 1fr))', gap: 12 }}>
        <div className="card" style={{ padding: 12, minWidth: 0 }}>
          <b style={{ fontSize: 13.5 }}>국가 · 법인별 <span className="muted" style={{ fontWeight: 400 }}>1,000개당 많은 순</span></b>
          <CorpTable rows={fleet.byCorp.slice(0, 8)} setCorp={setCorp} />
          {fleet.byCorp.length > 8 && <button className="tab" style={{ flex: 'none', marginTop: 6 }} onClick={() => setTab('corps')}>나머지 {fleet.byCorp.length - 8}곳</button>}
        </div>
        <div className="card" style={{ padding: 12, minWidth: 0 }}>
          <b style={{ fontSize: 13.5 }}>모델별 <span className="muted" style={{ fontWeight: 400 }}>지금 꽂혀 있는 디스크 기준</span></b>
          <ModelTable fleet={fleet} limit={6} />
        </div>
      </div>
      <Trend fleet={fleet} compact />
    </>
  );
}

function Disks({ fleet, refs, vf, setVf, openServer }) {
  const list = vf ? fleet.slots.filter((s) => s.verdict === vf) : fleet.slots;
  const count = (k) => (k ? fleet.slots.filter((s) => s.verdict === k).length : fleet.slots.length);
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {VERDICT_FILTERS.map((f) => <button key={f.k} className={vf === f.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 10px' }} onClick={() => setVf(f.k)}>{f.label} {count(f.k)}</button>)}
      </div>
      <InUseTable list={list} refs={refs} openServer={openServer} limit={200} />
    </div>
  );
}

function CorpTable({ rows, setCorp, canScan = false, scanCorp = null, busy = '' }) {
  if (!rows.length) return <div className="muted" style={{ fontSize: 12.5 }}>법인이 없습니다.</div>;
  const max = Math.max(1, ...rows.map((r) => r.ratePer1000 || 0));
  return (
    <STable className="data-table" minWidth={canScan ? 760 : 640} style={{ width: '100%', fontSize: 12.5, marginTop: 6 }}>
      <thead><tr><th>국가 · 법인</th><th>서버 읽음</th><th>디스크</th><th>기록 디스크</th><th>1,000개당</th><th>사용 중</th>{canScan && <th data-nosort>법인 점검</th>}</tr></thead>
      <tbody>{rows.map((c) => (
        <tr key={c.id || '_none'}>
          <td>{c.id ? <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => setCorp(c.id)}>{c.country ? `${c.country} · ` : ''}{c.name}</button> : c.name}</td>
          <td data-sort={c.read} style={{ fontFamily: 'var(--mono)' }}>{num(c.read)} / {num(c.servers)}</td>
          <td data-sort={c.disks} style={{ fontFamily: 'var(--mono)' }}>{num(c.disks)}</td>
          <td data-sort={c.recordSlots} style={{ fontFamily: 'var(--mono)' }}>{num(c.recordSlots)}</td>
          <td data-sort={c.ratePer1000 ?? undefined}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{bar(((c.ratePer1000 || 0) / max) * 100)}<span style={{ fontFamily: 'var(--mono)' }}>{rateText(c.ratePer1000)}</span></div></td>
          <td data-sort={c.inUse} style={{ fontFamily: 'var(--mono)' }}><b>{num(c.inUse)}</b></td>
          {canScan && <td>{c.id ? <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} disabled={!!busy} onClick={() => scanCorp(c)}>{busy === c.id ? '보내는 중…' : '점검'}</button> : '—'}</td>}
        </tr>
      ))}</tbody>
    </STable>
  );
}

function Corps({ fleet, setCorp, canScan, onScanned }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const scanCorp = (c) => {
    setBusy(c.id); setMsg('');
    postJson('/tools/disk-bad/scan', { scope: 'corp', corpId: c.id, mode: 'incremental' })
      .then((r) => { const sent = scanSent(r); if (sent.ok) onScanned(); else setMsg(sent.text); }).catch((e) => setMsg(e?.message || String(e))).finally(() => setBusy(''));
  };
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <b style={{ fontSize: 13.5 }}>국가 · 법인별 <span className="muted" style={{ fontWeight: 400 }}>{fleet.byCorp.length}곳 · 법인 이름을 누르면 그 법인만 봅니다</span></b>
      <CorpTable rows={fleet.byCorp} setCorp={setCorp} canScan={canScan} scanCorp={scanCorp} busy={busy} />
      {msg && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{msg}</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>‘서버 읽음’ 이 전체보다 적은 법인은 읽은 서버의 디스크만으로 낸 값입니다. 디스크 수가 적은 법인은 한두 개로 값이 크게 움직입니다.</div>
    </div>
  );
}

function ModelTable({ fleet, limit = 0 }) {
  const rows = limit ? fleet.byModel.slice(0, limit) : fleet.byModel;
  const max = Math.max(0.01, ...rows.map((r) => r.ratePct || 0));
  return (
    <>
      <STable className="data-table" minWidth={560} style={{ width: '100%', fontSize: 12.5, marginTop: 6 }}>
        <thead><tr><th>모델</th><th>장착 수</th><th>기록 디스크</th><th>비율</th><th>복구 불가</th></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.model}>
            <td>{m.model}{m.small && <span className="badge gray" style={{ marginLeft: 6 }}>표본 적음</span>}</td>
            <td data-sort={m.mounted} style={{ fontFamily: 'var(--mono)' }}>{num(m.mounted)}</td>
            <td data-sort={m.recordDisks} style={{ fontFamily: 'var(--mono)' }}>{num(m.recordDisks)}</td>
            <td data-sort={m.ratePct ?? undefined}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{bar(((m.ratePct || 0) / max) * 100, m.small ? 'var(--text-faint)' : 'var(--accent)')}<span style={{ fontFamily: 'var(--mono)' }}>{pctText(m.ratePct)}</span></div></td>
            <td data-sort={m.unrecoverable} style={{ fontFamily: 'var(--mono)' }}>{num(m.unrecoverable)}</td>
          </tr>
        ))}</tbody>
      </STable>
      <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
        로그에는 모델 · 시리얼이 없습니다. 이미 교체됐거나 판단 불가인 기록 디스크 {num(fleet.unknownModel)}개는 어느 모델이었는지 알 수 없어 비율에서 빠졌고, 그만큼 실제보다 낮게 나옵니다. 장착 30개 미만은 ‘표본 적음’.
      </div>
    </>
  );
}

function Models({ fleet }) {
  return <div className="card" style={{ padding: 12, minWidth: 0 }}><b style={{ fontSize: 13.5 }}>모델별 <span className="muted" style={{ fontWeight: 400 }}>지금 꽂혀 있는 디스크 기준</span></b><ModelTable fleet={fleet} /></div>;
}

function Trend({ fleet, compact = false }) {
  const months = fleet.months;
  const max = Math.max(1, ...months.map((m) => m.unrecoverable + m.other));
  const H = compact ? 90 : 140;
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <div className="flex between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ fontSize: 13.5 }}>월별 추이 <span className="muted" style={{ fontWeight: 400 }}>최근 {months.length}개월 · 기록 건수</span></b>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }} className="muted">
          <span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--red)', marginRight: 5 }} />복구 불가</span>
          <span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--amber)', marginRight: 5 }} />PDR54 · PDR59 · PDR57</span>
          <span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--accent)', opacity: 0.7, marginRight: 5 }} />그 달 로그가 남아 있는 서버 비율</span>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 520, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          <div role="img" aria-label="월별 배드 섹터 기록 건수" style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: H, borderBottom: '1px solid var(--border)' }}>
            {months.map((m) => {
              const tot = m.unrecoverable + m.other;
              return (
                <div key={m.month} title={`${m.month}${m.partial ? '(진행 중)' : ''} · 복구 불가 ${m.unrecoverable} · 그 밖 ${m.other}`} style={{ flex: 1, minWidth: 14, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', opacity: m.partial ? 0.6 : 1 }}>
                  {tot > 0 && <div style={{ height: `${(m.other / max) * 100}%`, background: 'var(--amber)', borderRadius: m.unrecoverable ? 0 : '3px 3px 0 0' }} />}
                  {m.unrecoverable > 0 && <div style={{ height: `${(m.unrecoverable / max) * 100}%`, background: 'var(--red)', borderRadius: '3px 3px 0 0', marginTop: m.other ? 2 : 0 }} />}
                </div>
              );
            })}
          </div>
          <div role="img" aria-label="그 달의 로그가 남아 있는 서버 비율" style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 30, borderBottom: '1px solid var(--border)' }}>
            {months.map((m) => <div key={m.month} title={`${m.month} · ${m.coveragePct == null ? '—' : `${m.coveragePct}%`}`} style={{ flex: 1, minWidth: 14, height: `${m.coveragePct || 0}%`, background: 'var(--accent)', opacity: 0.7, borderRadius: '2px 2px 0 0' }} />)}
          </div>
          <div style={{ display: 'flex', gap: 4, fontSize: 10.5 }} className="muted">
            {months.map((m, i) => <span key={m.month} style={{ flex: 1, minWidth: 14, textAlign: 'center', fontFamily: 'var(--mono)' }}>{i % 3 === 0 || i === months.length - 1 ? m.month.slice(2) : ''}</span>)}
          </div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>파란 막대가 낮은 달은 로그가 남아 있는 서버가 적어 건수가 적게 잡힙니다 — 실제로 늘었는지는 파란 막대가 비슷한 달끼리만 견줄 수 있습니다. 마지막 달은 진행 중입니다.</div>
    </div>
  );
}

function Servers({ fleet, labels, openServer }) {
  const reasons = Object.entries(fleet.unreadReasons || {});
  return (
    <div className="card" style={{ padding: 12, minWidth: 0 }}>
      <b style={{ fontSize: 13.5 }}>서버별 <span className="muted" style={{ fontWeight: 400 }}>{fleet.servers.length}대</span></b>
      {reasons.length > 0 && <div className="muted" style={{ fontSize: 12, margin: '4px 0' }}>못 읽은 이유: {reasons.map(([k, n]) => `${k === 'never' ? '아직 점검하지 않음' : (labels.reason[k] || k)} ${n}대`).join(' · ')}</div>}
      <STable className="data-table" minWidth={1020} limit={300} style={{ width: '100%', fontSize: 12.5, marginTop: 6 }}>
        <thead><tr><th>국가 · 법인</th><th>서버</th><th>판정</th><th>기록 디스크</th><th>사용 중</th><th>복구 불가</th><th title="iDRAC 가 보여 주는 로그가 담고 있던 기간 — 로그 전체를 읽은 마지막 점검 기준(시간이 지나도 늘지 않습니다)">iDRAC 로그 길이</th><th>마지막 점검</th></tr></thead>
        <tbody>{fleet.servers.map((s) => (
          <tr key={`${s.agent}|${s.serverId}`}>
            <td>{s.country ? `${s.country} · ` : ''}{s.corpName}</td>
            <td><button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => openServer(s)}>{s.serverName}</button></td>
            <td data-sort={s.status}><span className={`badge ${s.status === 'records' ? 'red' : s.status === 'unread' ? 'gray' : s.status === 'clean' ? 'green' : 'amber'}`}>{s.statusLabel}</span>{s.lastStatusLabel && <div className="muted" style={{ fontSize: 11 }}>{s.lastStatusLabel}</div>}</td>
            <td data-sort={s.counts.slots} style={{ fontFamily: 'var(--mono)' }}>{num(s.counts.slots)}</td>
            <td data-sort={s.counts.inUse} style={{ fontFamily: 'var(--mono)' }}><b>{num(s.counts.inUse)}</b></td>
            <td data-sort={s.counts.unrecoverable} style={{ fontFamily: 'var(--mono)' }}>{num(s.counts.unrecoverable)}</td>
            <td data-sort={Number.isFinite(s.logSpanMs) ? s.logSpanMs : undefined} style={{ whiteSpace: 'nowrap' }}>
              {Number.isFinite(s.logSpanMs) ? <>{spanText(0, s.logSpanMs)}<div className="muted" style={{ fontSize: 11 }}>{Number.isFinite(s.continuousSince) ? `${fmtDate(s.continuousSince)} 부터 끊김 없이 봄` : '끊김 없이 본 구간 모름'}{Number.isFinite(s.loginShare) && s.loginShare >= 0.5 ? ` · 로그인 계열 ${Math.floor(s.loginShare * 100)}%+` : ''}</div></> : <span className="muted">—</span>}
            </td>
            <td data-sort={s.lastScanAt ?? undefined} style={{ whiteSpace: 'nowrap', fontFamily: 'var(--mono)' }}>{fmtDateTime(s.lastScanAt)}</td>
          </tr>
        ))}</tbody>
      </STable>
    </div>
  );
}

function Basis({ refs, labels }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="card" style={{ padding: 12, minWidth: 0 }}>
        <b style={{ fontSize: 13.5 }}>기록 ID 가 뜻하는 것 <span className="muted" style={{ fontWeight: 400 }}>근거 문서가 있는 ID 만 분류합니다</span></b>
        <STable className="data-table" minWidth={980} style={{ width: '100%', fontSize: 12.5, marginTop: 6 }}>
          <thead><tr><th>ID</th><th>포탈 분류</th><th>Dell 문서가 말하는 뜻</th><th>Dell 권장 조치</th><th>출처</th><th>확인</th></tr></thead>
          <tbody>{refs.map((r) => (
            <tr key={r.id}>
              <td><span className={`badge ${clsTone(r.cls)}`}>{r.id}</span></td>
              <td>{r.clsLabel}{r.counted ? '' : <div className="muted" style={{ fontSize: 11 }}>배드 섹터 수에 안 셈</div>}</td>
              <td style={{ whiteSpace: 'normal' }}>{r.note}</td>
              <td style={{ whiteSpace: 'normal' }} className={r.action ? '' : 'muted'}>{r.action || '—'}</td>
              <td style={{ whiteSpace: 'normal' }}>{r.sources.map((s, i) => <div key={i}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)' }}>{s.title}</a></div>)}</td>
              <td><span className={`badge ${r.level === 'dell' ? 'green' : 'amber'}`}>{r.level === 'dell' ? 'Dell 문서' : '커뮤니티'}</span></td>
            </tr>
          ))}</tbody>
        </STable>
        <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>모든 출처는 검색 요약으로 확인했고 원문 · 실장비 대조는 아직입니다. 매뉴얼 일부는 Dell 공식 호스트가 아닌 사본입니다. 문서를 찾지 못한 ID(PDR56 · 디스크 삽입 ID 등)는 분류하지 않고 원문만 보관합니다.</div>
      </div>
      <div className="card" style={{ padding: 12, minWidth: 0, fontSize: 12.5, lineHeight: 1.7 }}>
        <b style={{ fontSize: 13.5 }}>판정과 확신 수준</b>
        <div style={{ marginTop: 6 }}><span className="badge green">{labels.confidence.confirmed}</span> 포탈이 점검 때마다 적어 둔 시리얼로 맞춤 · <span className="badge amber">{labels.confidence.estimated}</span> 기록 뒤로 그 자리에 디스크 빠짐 기록이 없고 그 구간 로그를 끊김 없이 읽음 · <span className="badge gray">{labels.confidence.none}</span> 근거가 모자라 어느 쪽으로도 말하지 않음</div>
        <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li>디스크 빠짐(PDR5)은 케이블 · 인클로저 · 펌웨어 문제로도 뜹니다 — 이것만으로 ‘교체됨’ 이라고 하지 않습니다. 교체는 시리얼이 바뀐 것을 봤을 때만 확정합니다.</li>
          <li>고장 예측(PDR16)은 SSD 쓰기 수명으로도 뜨므로 배드 섹터 수에 넣지 않고 따로 셉니다.</li>
          <li>RAID 로 묶이지 않은 디스크(HBA · 패스스루)는 Patrol Read 가 돌지 않아 이 방법으로 볼 수 없습니다 — ‘기록 없음’ 이 아니라 따로 셉니다.</li>
          <li>‘기록 없음’ 은 ‘발생한 적 없음’ 이 아니라 ‘로그가 남은 구간에 기록 없음’ 입니다.</li>
        </ul>
      </div>
    </div>
  );
}

function ScanPanel({ data, jobs, corp, canScan, reload, setJobs }) {
  const [scope, setScope] = useState(corp ? 'corp' : (data.canScanAll ? 'all' : 'corp'));
  const [corpId, setCorpId] = useState(corp || '');
  const [mode, setMode] = useState('incremental');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [st, setSt] = useState(data.settings || null);
  const [corpToText, setCorpToText] = useState(() => Object.entries(data.settings?.corpTo || {}).map(([k, v]) => `${k}=${v.join(',')}`).join('\n'));
  const start = () => {
    setBusy(true); setMsg('');
    postJson('/tools/disk-bad/scan', scope === 'all' ? { scope, mode } : { scope: 'corp', corpId, mode })
      .then((r) => { const sent = scanSent(r, '점검을 보냈습니다.'); if (sent.ok && r.job) setJobs([r.job, ...jobs.filter((j) => j.id !== r.job.id)]); setMsg(sent.text); })
      .catch((e) => setMsg(e?.message || String(e))).finally(() => setBusy(false));
  };
  const act = (j, path, body) => postJson(`/tools/disk-bad/jobs/${encodeURIComponent(j.id)}/${path}`, body)
    .then((r) => setJobs(jobs.map((x) => (x.id === j.id ? r.job : x)))).catch((e) => setMsg(e?.message || String(e)));
  const saveSettings = (patch) => {
    const corpTo = {};
    for (const line of corpToText.split('\n')) { const i = line.indexOf('='); if (i > 0) corpTo[line.slice(0, i).trim()] = line.slice(i + 1).split(/[\s,;]+/).filter(Boolean); }
    return putJson('/tools/disk-bad/settings', { ...patch, corpTo }).then((r) => { setSt(r.settings); setMsg('저장했습니다.'); reload(); }).catch((e) => setMsg(e?.message || String(e)));
  };
  const selCount = scope === 'all' ? null : (data.corps.find((c) => c.id === corpId)?.servers ?? 0);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
      {canScan && (
        <div className="card" style={{ padding: 14, flex: '1 1 380px', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <b style={{ fontSize: 14 }}>어디를 점검할까요</b>
          {data.canScanAll && <label style={{ display: 'flex', gap: 8, fontSize: 12.5 }}><input type="radio" name="dbad-scope" checked={scope === 'all'} onChange={() => setScope('all')} /><span><b>전체 — 모든 법인의 서버</b><div className="muted" style={{ fontSize: 12 }}>법인마다 따로 돌고, 도는 중에도 법인별로 다시 점검 · 중단할 수 있습니다</div></span></label>}
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5 }}><input type="radio" name="dbad-scope" checked={scope === 'corp'} onChange={() => setScope('corp')} /><span><b>법인을 골라서</b></span></label>
          {scope === 'corp' && (
            <Select className="select" value={corpId} onChange={(e) => setCorpId(e.target.value)} sort={false}>
              <option value="">법인 선택</option>
              {data.corps.map((c) => <option key={c.id} value={c.id}>{c.country ? `${c.country} · ` : ''}{c.name} ({c.servers}대)</option>)}
            </Select>
          )}
          <b style={{ fontSize: 14 }}>어떻게 읽을까요</b>
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5 }}><input type="radio" name="dbad-mode" checked={mode === 'incremental'} onChange={() => setMode('incremental')} /><span><b>새 로그만 이어 읽기</b><div className="muted" style={{ fontSize: 12 }}>지난번 읽은 곳 뒤부터. 처음 점검하는 서버는 전체를 읽습니다</div></span></label>
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5 }}><input type="radio" name="dbad-mode" checked={mode === 'full'} onChange={() => setMode('full')} /><span><b>처음부터 다시 읽기</b><div className="muted" style={{ fontSize: 12 }}>서버마다 로그 전체를 다시 읽습니다. 오래 걸립니다</div></span></label>
          <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <span style={{ fontSize: 12.5 }}>{scope === 'all' ? '전체 법인' : (corpId ? `서버 ${selCount}대` : '법인을 고르세요')}</span>
            <button className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} disabled={busy || (scope === 'corp' && !corpId)} onClick={start}>{busy ? '보내는 중…' : '점검 시작'}</button>
          </div>
          {msg && <div className="muted" style={{ fontSize: 12 }}>{msg}</div>}
        </div>
      )}
      <div className="card" style={{ padding: 14, flex: '999 1 560px', maxWidth: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <b style={{ fontSize: 14 }}>점검 작업 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>최근 10개 · 법인마다 따로 돕니다 · 포탈을 다시 시작하면 진행 표시는 사라지고 결과는 남습니다</span></b>
        {!jobs.length && <div className="muted" style={{ fontSize: 12.5 }}>아직 점검한 적이 없습니다.</div>}
        {jobs.map((j) => (
          <div key={j.id} style={box}>
            <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12.5 }}><b>{scopeLabel(j)}</b> · {j.mode === 'full' ? '처음부터' : '새 로그만'} · {j.auto ? '자동' : (j.by || '수동')} · {fmtDateTime(j.at)}{j.finishedAt ? ` ~ ${fmtDateTime(j.finishedAt)}` : ''}<div className="muted" style={{ fontSize: 12 }}>서버 {num(j.done)} / {j.total == null ? '?' : num(j.total)} · 실패 {num(j.failed)} · 새 기록 {num(j.newRecords)}</div></div>
              {canScan && j.running && data.canScanAll && <button className="tab" style={{ flex: 'none' }} onClick={() => act(j, 'stop', {})}>전체 중단</button>}
            </div>
            <STable className="data-table" minWidth={640} style={{ width: '100%', fontSize: 12.5, marginTop: 6 }}>
              <thead><tr><th>엣지(법인)</th><th>상태</th><th>서버 진행</th><th>실패</th><th>새 기록</th>{canScan && <th data-nosort>이 법인만</th>}</tr></thead>
              <tbody>{j.units.map((u) => {
                const pr = unitProgress(u);
                return (
                  <tr key={u.agent || '_local'}>
                    <td>{u.label}</td>
                    <td><span className={`badge ${jobStateTone(u.state)}`}>{JOB_STATE_LABEL[u.state] || u.state}</span>{u.error && <div className="muted" style={{ fontSize: 11, whiteSpace: 'normal' }}>{u.error}</div>}</td>
                    <td data-sort={pr.done}><div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{bar(pr.pct || 0)}<span style={{ fontFamily: 'var(--mono)' }}>{pr.text}</span></div></td>
                    <td style={{ fontFamily: 'var(--mono)' }}>{num(u.failed)}</td>
                    <td style={{ fontFamily: 'var(--mono)' }}><b>{num(u.newRecords)}</b></td>
                    {canScan && <td>{(u.state === 'queued' || u.state === 'running')
                      ? <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => act(j, 'stop', { agent: u.agent })}>중단</button>
                      : ['not-started', 'no-response', 'failed', 'stopped', 'done'].includes(u.state)
                        ? <button className="tab" style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }} onClick={() => act(j, 'retry', { agent: u.agent })}>{u.state === 'done' ? '다시 점검' : '다시 보내기'}</button> : '—'}</td>}
                  </tr>
                );
              })}</tbody>
            </STable>
          </div>
        ))}
      </div>
      {st && (
        <div className="card" style={{ padding: 14, flex: '1 1 100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
          <b style={{ fontSize: 14 }}>설정 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>관리자 · 전체 범위</span></b>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={st.autoEnabled} onChange={(e) => saveSettings({ autoEnabled: e.target.checked })} /> {st.intervalHours}시간마다 자동 점검(새 로그만) — 기본 꺼짐. 켜면 전 법인 iDRAC 에 Lifecycle 로그 읽기가 나갑니다(서버마다 첫 회는 전량).</label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={st.mailEnabled} onChange={(e) => saveSettings({ mailEnabled: e.target.checked })} /> 새 기록이 나오면 법인별 한 통 메일(받는 사람: 설정 › 메일 발송의 ‘디스크 배드 섹터 새 기록’ 수신자 + 아래 법인 담당자)</label>
          <label htmlFor="dbad-corpto" className="muted">법인 담당자 — 한 줄에 ‘vCenter id=메일,메일’</label>
          <textarea id="dbad-corpto" className="input" rows={4} value={corpToText} onChange={(e) => setCorpToText(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 12, width: '100%', boxSizing: 'border-box' }} placeholder={data.corps.slice(0, 2).map((c) => `${c.id}=it-admin@example.com`).join('\n')} />
          <div><button className="tab" style={{ flex: 'none' }} onClick={() => saveSettings({})}>담당자 저장</button></div>
          {data.settingsLoadError && <div style={{ color: 'var(--red)' }}>설정 파일을 읽지 못해 기본값으로 시작했습니다 — {data.settingsLoadError.reason}</div>}
        </div>
      )}
    </div>
  );
}

export default DiskBadTool;
