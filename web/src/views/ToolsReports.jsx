/**
 * 특수기능 리포트 10종(v2.217) — 커뮤니티(r/vmware·vCheck·RVTools) 표준 점검 항목.
 * 각 컴포넌트는 SpecialTools의 ToolPanel에서 scope(vCenter 범위)와 isAdmin을 받아 렌더한다.
 * 규약: 훅은 조기 return 위에 선언(React #310) · error && !data 일 때만 전체 오류 · CSV는 BOM.
 */
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, usePolling } from '../api.js';
import { DataTable, Loading, ErrorBox, StateBadge, ResultCount, Kpi, SearchBox, VmLink } from '../components/ui.jsx';
import { csvCell } from '../util/csv.js'; // 수식 인젝션 가드 포함 공통 셀 이스케이프

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString('ko-KR') : '—');
const tb = (gb) => (gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`);

// CSV 내보내기 — BOM 필수(엑셀 한글 깨짐 방지).
function exportCsv(name, head, rows) {
  const csv = [head.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

const STATUS_BADGE = {
  ok: ['정상', 'green'], warn: ['주의', 'amber'], crit: ['위험', 'red'],
  expired: ['만료됨', 'red'], critical: ['D-30 위험', 'red'], expiring: ['D-90 임박', 'amber'],
  unknown: ['미상', 'gray'], error: ['프로브 실패', 'gray'], blocked: ['차단됨', 'gray'],
  eol: ['지원 종료', 'red'], ending: ['종료 임박', 'amber'], supported: ['지원 중', 'green'],
};
function SBadge({ s }) {
  const m = STATUS_BADGE[s] || [s, 'gray'];
  return <span className={`badge ${m[1]}`}>{m[0]}</span>;
}
const errBanner = (error) => error && (
  <div className="badge red" style={{ marginBottom: 8 }}>갱신 실패(직전 데이터 표시 중): {error}</div>
);

/* ── ① 일일 헬스체크 리포트 ─────────────────────────────────────────── */
export function DailyHealth({ scope, isAdmin }) {
  const [open, setOpen] = useState(null); // 펼친 섹션 key
  const [sched, setSched] = useState(null); // 관리자 스케줄 설정
  const [saving, setSaving] = useState('');
  const { data, error, loading } = usePolling('/tools/report/health', { vcenterId: scope }, 30_000);
  useEffect(() => {
    if (!isAdmin) return;
    fetchJson('/admin/report/daily').then(setSched).catch(() => {});
  }, [isAdmin]);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const saveSched = async (patch) => {
    setSaving('저장 중…');
    try { const r = await putJson('/admin/report/daily', { ...sched, ...patch }); setSched({ ...sched, ...r.settings }); setSaving('저장됨'); }
    catch (e) { setSaving(`실패: ${e.message}`); }
  };
  const runNow = async () => {
    setSaving('발송 중…');
    try { const r = await postJson('/admin/report/daily/run', {}); setSaving(r.ok ? `발송 완료 (${(r.results || []).join(', ') || '채널 미설정'})` : `실패: ${(r.results || []).join(', ') || r.reason}`); }
    catch (e) { setSaving(`실패: ${e.message}`); }
  };
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="종합 상태" value={{ ok: '✅ 정상', warn: '🟠 주의', crit: '🔴 위험' }[data.overall] || data.overall} />
        <Kpi label="발견 이슈" value={data.summary.issues} unit="건" accent={data.summary.issues ? 'var(--amber)' : undefined} />
        <Kpi label="vCenter" value={data.summary.vcenters} />
        <Kpi label="호스트" value={data.summary.hosts} />
        <Kpi label="VM" value={data.summary.vms} />
      </div>
      {isAdmin && sched && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="flex wrap gap" style={{ alignItems: 'center' }}>
            <b style={{ fontSize: 13 }}>⏰ 매일 자동 발송</b>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={!!sched.enabled} onChange={(e) => saveSched({ enabled: e.target.checked })} /> 사용
            </label>
            <input className="input" type="number" min="0" max="23" style={{ width: 64 }} value={sched.hour}
              onChange={(e) => setSched({ ...sched, hour: e.target.value })} onBlur={() => saveSched({})} />
            <span className="muted">시</span>
            <input className="input" type="number" min="0" max="59" style={{ width: 64 }} value={sched.minute}
              onChange={(e) => setSched({ ...sched, minute: e.target.value })} onBlur={() => saveSched({})} />
            <span className="muted">분 · 알림 채널(Slack/Teams/웹훅)로 발송 · 마지막 발송: {fmtDate(sched.lastRunTs)}</span>
            <button className="logout-btn" onClick={runNow}>지금 발송(테스트)</button>
            {saving && <span className="muted" style={{ fontSize: 12 }}>{saving}</span>}
          </div>
        </div>
      )}
      {data.sections.map((s) => (
        <div key={s.key} className="card" style={{ marginBottom: 8, cursor: s.count ? 'pointer' : 'default' }}
          onClick={() => s.count && setOpen(open === s.key ? null : s.key)}>
          <div className="flex between" style={{ alignItems: 'center' }}>
            <div className="flex gap" style={{ alignItems: 'center' }}>
              <SBadge s={s.status} />
              <b style={{ fontSize: 14 }}>{s.label}</b>
              <span className="muted" style={{ fontSize: 13 }}>{s.count}건</span>
            </div>
            {s.count > 0 && <span className="muted">{open === s.key ? '▲ 접기' : '▼ 펼치기'}</span>}
          </div>
          {open === s.key && s.items?.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10, maxHeight: '40vh' }}>
              <table>
                <thead><tr>{Object.keys(s.items[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                <tbody>
                  {s.items.map((it, i) => (
                    <tr key={i}>{Object.entries(it).map(([k, v]) => <td key={k}>{k.toLowerCase().includes('ts') ? fmtDate(v) : String(v ?? '—')}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12 }}>vCheck 스타일 점검: 임계 — 스냅샷 {data.config.snapshotAgeDays}일 · 데이터스토어 {data.config.dsWarnPct}% (쿼리 파라미터로 조정 가능)</p>
    </>
  );
}

/* ── ② 스냅샷 나이 감시 ────────────────────────────────────────────── */
export function SnapshotAge({ scope }) {
  const [minAgeDays, setMinAgeDays] = useState(3);
  const [minSizeGB, setMinSizeGB] = useState(0);
  const { data, error, loading } = usePolling('/tools/report/snapshot-age', { vcenterId: scope, minAgeDays, minSizeGB }, 30_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const rows = data.items || [];
  const columns = [
    { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'ageDays', label: '나이', align: 'right', render: (r) => (r.ageDays != null ? <b style={r.ageDays >= 30 ? { color: 'var(--red)' } : r.ageDays >= 7 ? { color: 'var(--amber)' } : {}}>{r.ageDays}일</b> : '—') },
    { key: 'oldestTs', label: '가장 오래된 생성일', render: (r) => fmtDay(r.oldestTs) },
    { key: 'snapshotCount', label: '개수', align: 'right' },
    { key: 'snapshotSizeGB', label: '크기', align: 'right', render: (r) => tb(r.snapshotSizeGB) },
    { key: 'snapshotNames', label: '스냅샷 이름', render: (r) => (r.snapshotNames || []).join(', ') || '—' },
    { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
  ];
  return (
    <>
      {errBanner(error)}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">최소 나이</span>
            <input className="input" type="number" min="0" style={{ width: 80 }} value={minAgeDays} onChange={(e) => setMinAgeDays(Number(e.target.value) || 0)} />
            <span className="muted">일</span>
          </label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">최소 크기</span>
            <input className="input" type="number" min="0" style={{ width: 80 }} value={minSizeGB} onChange={(e) => setMinSizeGB(Number(e.target.value) || 0)} />
            <span className="muted">GB</span>
          </label>
          <span className="muted" style={{ fontSize: 13 }}>총 {data.count}대 · 델타 {tb(data.totalSizeGB)} · 생성일 확인 {data.withAge}대</span>
          <button className="logout-btn" onClick={() => exportCsv('snapshot-age', ['VM', 'vCenter', '나이(일)', '생성일', '개수', '크기GB', '전원'],
            rows.map((r) => [r.name, r.vcenterId, r.ageDays ?? '', r.oldestTs ? new Date(r.oldestTs).toISOString() : '', r.snapshotCount, r.snapshotSizeGB, r.powerState]))}>CSV</button>
        </div>
      </div>
      <ResultCount count={rows.length} />
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'ageDays', dir: 'desc' }} emptyText="조건에 맞는 스냅샷 보유 VM이 없습니다." />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>생성일은 vCenter 스냅샷 트리의 createTime 기준입니다(수집 주기 내 최신).</p>
    </>
  );
}

/* ── ③ 좀비/방치 리소스 ────────────────────────────────────────────── */
export function ZombieVms({ scope }) {
  const [tab, setTab] = useState('poweredOff');
  const { data, error, loading } = usePolling('/tools/report/zombies', { vcenterId: scope }, 30_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const s = data.summary;
  const TABS = [
    ['poweredOff', `장기 정지 VM (${s.poweredOffCount})`],
    ['snapshotHogs', `스냅샷 대식가 (${s.snapshotHogCount})`],
    ['orphaned', `고아/접근불가 (${s.orphanedCount})`],
    ['templates', `템플릿 (${s.templateCount})`],
  ];
  const rows = data[tab] || [];
  const base = [
    { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'cluster', label: '클러스터' },
    { key: 'storageGB', label: '디스크', align: 'right', render: (r) => tb(r.storageGB) },
  ];
  const columns = tab === 'snapshotHogs'
    ? [...base, { key: 'snapshotSizeGB', label: '스냅샷', align: 'right', render: (r) => tb(r.snapshotSizeGB) }, { key: 'snapshotAgeDays', label: '나이', align: 'right', render: (r) => (r.snapshotAgeDays != null ? `${r.snapshotAgeDays}일` : '—') }]
    : tab === 'orphaned'
      ? [...base, { key: 'connectionState', label: '상태', render: (r) => <span className="badge red">{r.connectionState}</span> }]
      : [...base, { key: 'guestOS', label: 'OS' }];
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="회수 가능(추정)" value={tb(s.reclaimableGB)} meta="정지 VM 디스크 + 스냅샷 델타" accent="var(--green)" />
        <Kpi label="정지 VM 점유" value={tb(s.poweredOffGB)} />
        <Kpi label="스냅샷 델타" value={tb(s.snapshotHogGB)} />
        <Kpi label="템플릿 점유" value={tb(s.templateGB)} />
        <Kpi label="고아/접근불가" value={s.orphanedCount} unit="대" accent={s.orphanedCount ? 'var(--red)' : undefined} />
      </div>
      <div className="vcd-views" style={{ marginBottom: 10 }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'storageGB', dir: 'desc' }} emptyText="해당 항목이 없습니다." />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{data.note}</p>
    </>
  );
}

/* ── ④ 인증서 만료 감시 ────────────────────────────────────────────── */
export function CertExpiry({ isAdmin }) {
  const [refreshing, setRefreshing] = useState('');
  const { data, error, loading } = usePolling('/tools/report/certs', {}, 30_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const rows = data.items || [];
  const bad = rows.filter((r) => ['expired', 'critical'].includes(r.status)).length;
  const soon = rows.filter((r) => r.status === 'expiring').length;
  const refresh = async () => {
    setRefreshing('프로브 중…');
    try { const r = await postJson('/admin/certs/refresh', {}); setRefreshing(`완료 (${r.count}건)`); }
    catch (e) { setRefreshing(`실패: ${e.message}`); }
  };
  const columns = [
    { key: 'status', label: '상태', render: (r) => <SBadge s={r.status} /> },
    { key: 'daysLeft', label: '남은 일수', align: 'right', render: (r) => (r.daysLeft != null ? <b style={r.daysLeft < 0 ? { color: 'var(--red)' } : r.daysLeft <= 30 ? { color: 'var(--red)' } : r.daysLeft <= 90 ? { color: 'var(--amber)' } : {}}>{r.daysLeft < 0 ? `만료 +${-r.daysLeft}일` : `D-${r.daysLeft}`}</b> : '—') },
    { key: 'name', label: '대상', render: (r) => <b>{r.name}</b> },
    { key: 'kind', label: '종류', render: (r) => <span className={`badge ${r.kind === 'vcenter' ? 'blue' : 'purple'}`}>{r.kind === 'vcenter' ? 'vCenter' : 'NSX'}</span> },
    { key: 'host', label: '호스트' },
    { key: 'validTo', label: '만료일', render: (r) => fmtDay(r.validTo) },
    { key: 'issuer', label: '발급자', render: (r) => `${r.issuer || '—'}${r.selfSigned ? ' (자체서명)' : ''}` },
    { key: 'error', label: '비고', render: (r) => r.error || '—' },
  ];
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="만료/D-30 위험" value={bad} unit="건" accent={bad ? 'var(--red)' : undefined} />
        <Kpi label="D-90 임박" value={soon} unit="건" accent={soon ? 'var(--amber)' : undefined} />
        <Kpi label="감시 대상" value={rows.length} unit="건" meta="등록된 vCenter + NSX" />
        <Kpi label="마지막 프로브" value={data.at ? fmtDate(data.at) : '대기 중'} />
      </div>
      {isAdmin && (
        <div className="flex gap" style={{ alignItems: 'center', marginBottom: 10 }}>
          <button className="logout-btn" onClick={refresh}>지금 다시 프로브</button>
          {refreshing && <span className="muted" style={{ fontSize: 12 }}>{refreshing}</span>}
        </div>
      )}
      <DataTable columns={columns} rows={rows} emptyText="감시 대상이 없습니다(vCenter/NSX를 등록하세요)." />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>443 포트 리프 인증서를 12시간마다 검증 없이 읽어 만료일만 추적합니다. vCenter는 머신 인증서 만료 시 로그인 자체가 막히므로 D-30 이내는 즉시 갱신을 권장합니다.</p>
    </>
  );
}

/* ── ⑤ VM 라이트사이징 ─────────────────────────────────────────────── */
export function Rightsizing({ scope }) {
  const [tab, setTab] = useState('oversized');
  const { data, error, loading } = usePolling('/tools/report/rightsizing', { vcenterId: scope }, 30_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const TABS = [['oversized', `과대할당 (${data.oversizedCount})`], ['idle', `유휴 (${data.idleCount})`], ['undersized', `과소/증설 검토 (${data.undersizedCount})`]];
  const rows = data[tab] || [];
  const pctCol = (key, label) => ({ key, label, align: 'right', render: (r) => (r[key] != null ? `${r[key]}%` : '—') });
  const columns = [
    { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'vcpu', label: 'vCPU', align: 'right' },
    { key: 'ramGB', label: 'RAM', align: 'right', render: (r) => `${r.ramGB}GB` },
    pctCol('cpuAvg', 'CPU평균'), pctCol('cpuMax', 'CPU피크'), pctCol('memAvg', 'MEM평균'), pctCol('memMax', 'MEM피크'),
    ...(tab === 'oversized' ? [
      { key: 'suggestedVcpu', label: '추천 vCPU', align: 'right', render: (r) => <b style={{ color: 'var(--green)' }}>{r.suggestedVcpu}</b> },
      { key: 'suggestedRamGB', label: '추천 RAM', align: 'right', render: (r) => <b style={{ color: 'var(--green)' }}>{r.suggestedRamGB}GB</b> },
    ] : []),
    { key: 'samples', label: '관측', align: 'right', render: (r) => (r.samples ? `${r.samples}회` : <span className="badge gray" title="누적 통계가 부족해 순간값으로 판정">순간값</span>) },
  ];
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="회수 가능 vCPU" value={data.reclaimableVcpu} unit="개" accent="var(--green)" />
        <Kpi label="회수 가능 RAM" value={data.reclaimableRamGB} unit="GB" accent="var(--green)" />
        <Kpi label="통계 기반 판정" value={data.observedVms} unit="대" meta={data.stats?.sinceTs ? `관측 시작 ${fmtDate(data.stats.sinceTs)}` : ''} />
        <Kpi label="순간값 판정" value={data.instantOnlyVms} unit="대" meta="관측 누적 전(기동 직후)" />
      </div>
      <div className="vcd-views" style={{ marginBottom: 10 }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <DataTable columns={columns} rows={rows} emptyText="해당 항목이 없습니다." />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>추천 사양은 관측 피크 기준 CPU 60%·RAM 75% 목표 여유로 계산합니다. 서버 재시작 시 관측 통계가 초기화됩니다.</p>
    </>
  );
}

/* ── ⑥ 용량 고갈 예측 ──────────────────────────────────────────────── */
export function CapacityForecast({ scope }) {
  const [days, setDays] = useState(14);
  const { data, error, loading } = usePolling('/tools/report/capacity', { vcenterId: scope, days }, 60_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const rows = data.datastores || [];
  const columns = [
    { key: 'name', label: '데이터스토어', render: (r) => <b>{r.name}</b> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'usagePct', label: '사용률', align: 'right', render: (r) => `${r.usagePct}%` },
    { key: 'usedGB', label: '사용', align: 'right', render: (r) => tb(r.usedGB) },
    { key: 'capacityGB', label: '전체', align: 'right', render: (r) => tb(r.capacityGB) },
    { key: 'slopePerDay', label: '증가/일', align: 'right', render: (r) => `${r.slopePerDay > 0 ? '+' : ''}${r.slopePerDay}GB` },
    { key: 'daysToLimit', label: '고갈까지', align: 'right', render: (r) => (r.daysToLimit != null ? <b style={r.daysToLimit <= 30 ? { color: 'var(--red)' } : r.daysToLimit <= 90 ? { color: 'var(--amber)' } : {}}>{r.daysToLimit}일</b> : '—') },
    { key: 'etaTs', label: '예상일', render: (r) => fmtDay(r.etaTs) },
    { key: 'r2', label: '신뢰도(R²)', align: 'right' },
  ];
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="30일 내 고갈 예상" value={(data.soon || []).length} unit="개" accent={(data.soon || []).length ? 'var(--red)' : undefined} />
        <Kpi label="추세 산출" value={rows.length} unit="개" meta={`관측 ${data.config?.days}일 · 분석 대상 ${data.scannedDatastores}개`} />
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
          <span className="muted">관측 기간</span>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d}일</option>)}
          </select>
          <span className="muted">증가 추세가 있는 데이터스토어만 표시됩니다(선형회귀 R² ≥ 0.3).</span>
        </label>
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'daysToLimit', dir: 'asc' }} emptyText="증가 추세가 감지된 데이터스토어가 없습니다(시계열 누적 중일 수 있음)." />
    </>
  );
}

/* ── ⑦ 알림 채널·이력 ──────────────────────────────────────────────── */
export function AlertChannels({ isAdmin }) {
  const [cfg, setCfg] = useState(null);   // 관리자 전체 설정(URL 포함)
  const [msg, setMsg] = useState('');
  const { data, error, loading } = usePolling('/tools/report/alerts', {}, 15_000);
  useEffect(() => {
    if (!isAdmin) return;
    fetchJson('/admin/alerts').then((r) => setCfg(r.config)).catch(() => {});
  }, [isAdmin]);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const save = async () => {
    setMsg('저장 중…');
    try { await putJson('/admin/alerts', cfg); setMsg('저장됨'); }
    catch (e) { setMsg(`실패: ${e.message}`); }
  };
  const test = async () => {
    setMsg('테스트 발송 중…');
    try { const r = await postJson('/admin/alerts/test', {}); setMsg(`결과: ${(r.results || []).join(', ') || '활성 채널 없음'}`); }
    catch (e) { setMsg(`실패: ${e.message}`); }
  };
  const CH_LABEL = { slack: 'Slack', teams: 'Microsoft Teams', webhook: '일반 웹훅(JSON)' };
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        {Object.entries(data.channels).map(([k, c]) => (
          <Kpi key={k} label={CH_LABEL[k]} value={c.enabled ? '켜짐' : '꺼짐'} meta={c.configured ? 'URL 설정됨' : 'URL 미설정'}
            accent={c.enabled && c.configured ? 'var(--green)' : undefined} />
        ))}
        <Kpi label="발화 중 알림" value={(data.firing || []).length} unit="건" accent={(data.firing || []).length ? 'var(--red)' : undefined} />
        <Kpi label="중복 억제 창" value={data.suppressWindowMin} unit="분" meta={`재알림 쿨다운 ${data.cooldownMin}분`} />
      </div>
      {isAdmin && cfg && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 13 }}>채널 설정 (관리자)</b>
          {['slack', 'teams', 'webhook'].map((k) => (
            <div key={k} className="flex wrap gap" style={{ alignItems: 'center', marginTop: 8 }}>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, width: 170 }}>
                <input type="checkbox" checked={!!cfg.channels?.[k]?.enabled}
                  onChange={(e) => setCfg({ ...cfg, channels: { ...cfg.channels, [k]: { ...cfg.channels?.[k], enabled: e.target.checked } } })} />
                {CH_LABEL[k]}
              </label>
              <input className="input" style={{ flex: 1, minWidth: 280 }} placeholder={`${CH_LABEL[k]} incoming webhook URL`}
                value={cfg.channels?.[k]?.url || ''}
                onChange={(e) => setCfg({ ...cfg, channels: { ...cfg.channels, [k]: { ...cfg.channels?.[k], url: e.target.value } } })} />
            </div>
          ))}
          <div className="flex wrap gap" style={{ alignItems: 'center', marginTop: 10 }}>
            <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
              <span className="muted">중복 억제 창(분)</span>
              <input className="input" type="number" min="0" style={{ width: 80 }} value={cfg.suppressWindowMin ?? 5}
                onChange={(e) => setCfg({ ...cfg, suppressWindowMin: Number(e.target.value) || 0 })} />
            </label>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={save}>저장</button>
            <button className="logout-btn" onClick={test}>테스트 발송</button>
            {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
          </div>
        </div>
      )}
      {(data.firing || []).length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <b style={{ fontSize: 13, color: 'var(--red)' }}>🔥 발화 중</b>
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: '30vh' }}>
            <table>
              <thead><tr><th>심각도</th><th>제목</th><th>상세</th><th>시작</th></tr></thead>
              <tbody>
                {data.firing.map((f, i) => (
                  <tr key={i}><td><span className={`badge ${f.severity === 'critical' ? 'red' : 'amber'}`}>{f.severity}</span></td><td>{f.title}</td><td className="muted">{f.detail}</td><td>{fmtDate(f.since)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px' }}><b style={{ fontSize: 13 }}>최근 발송 이력</b></div>
        <div className="table-wrap" style={{ maxHeight: '45vh' }}>
          <table>
            <thead><tr><th>시각</th><th>심각도</th><th>제목</th><th>채널 결과</th></tr></thead>
            <tbody>
              {(data.recent || []).length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 16, textAlign: 'center' }}>발송 이력이 없습니다.</td></tr>}
              {(data.recent || []).map((r, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtDate(r.at)}</td>
                  <td><span className={`badge ${r.severity === 'critical' ? 'red' : r.severity === 'resolved' ? 'green' : 'amber'}`}>{r.severity}</span></td>
                  <td>{r.title}</td>
                  <td className="muted">{(r.channels || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── ⑧ 버전/패치 준수 리포트 ───────────────────────────────────────── */
export function ComplianceReport({ scope }) {
  const [tab, setTab] = useState('tools');
  const { data, error, loading } = usePolling('/tools/report/compliance', { vcenterId: scope }, 30_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const s = data.summary;
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="Tools 업그레이드 필요" value={s.toolsNeedUpgrade} unit="대" accent={s.toolsNeedUpgrade ? 'var(--amber)' : undefined} />
        <Kpi label="구버전 HW(≤vmx-13)" value={s.oldHwVms} unit="대" accent={s.oldHwVms ? 'var(--amber)' : undefined} />
        <Kpi label="EOL ESXi 호스트" value={s.eolHosts} unit="대" accent={s.eolHosts ? 'var(--red)' : undefined} />
        <Kpi label="지원 종료 임박" value={s.endingHosts} unit="대" meta="6개월 내" />
      </div>
      <div className="vcd-views" style={{ marginBottom: 10 }}>
        {[['tools', 'VMware Tools'], ['hw', 'VM 하드웨어 버전'], ['esxi', 'ESXi 버전']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'tools' && (
        <>
          <DataTable columns={[{ key: 'label', label: '상태' }, { key: 'count', label: 'VM 수', align: 'right' }]} rows={data.tools.dist} initialSort={{ key: 'count', dir: 'desc' }} />
          {data.tools.needUpgrade.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>업그레이드 필요 목록</div>
              <DataTable columns={[
                { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
                { key: 'vcenterId', label: 'vCenter' }, { key: 'toolsVersion', label: 'Tools 버전' },
                { key: 'status', label: '상태' }, { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
              ]} rows={data.tools.needUpgrade} />
            </>
          )}
        </>
      )}
      {tab === 'hw' && (
        <>
          <DataTable columns={[{ key: 'label', label: '하드웨어 버전' }, { key: 'count', label: 'VM 수', align: 'right' }]} rows={data.hwVersion.dist} initialSort={{ key: 'count', dir: 'desc' }} />
          {data.hwVersion.old.length > 0 && (
            <>
              <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>구버전(≤vmx-{data.config.oldHwMax}) 목록</div>
              <DataTable columns={[
                { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
                { key: 'vcenterId', label: 'vCenter' }, { key: 'hwVersion', label: 'HW 버전' },
                { key: 'powerState', label: '전원', render: (r) => <StateBadge state={r.powerState} /> },
              ]} rows={data.hwVersion.old} />
            </>
          )}
        </>
      )}
      {tab === 'esxi' && (
        <DataTable columns={[
          { key: 'version', label: 'ESXi 버전' }, { key: 'build', label: '빌드' },
          { key: 'count', label: '호스트 수', align: 'right' },
          { key: 'status', label: '지원 상태', render: (r) => <SBadge s={r.status} /> },
          { key: 'eol', label: '지원 종료일', render: (r) => r.eol || '—' },
        ]} rows={data.esxi} initialSort={{ key: 'count', dir: 'desc' }} />
      )}
    </>
  );
}

/* ── ⑨ 구성 변경 이력 ──────────────────────────────────────────────── */
export function ChangeHistory({ scope }) {
  const [days, setDays] = useState(7);
  const [category, setCategory] = useState('');
  const [user, setUser] = useState('');
  const [entity, setEntity] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    fetchJson('/tools/report/changes', { vcenterId: scope, days, category, user, entity })
      .then((r) => { if (live) { setData(r); setErr(''); } })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [scope, days, category, user, entity]);
  if (err && !data) return <ErrorBox message={err} />;
  if (!data) return <Loading />;
  const CAT_COLOR = { 스냅샷: 'purple', '설정 변경': 'blue', 전원: 'amber', 마이그레이션: 'teal', '생성/등록': 'green', '삭제/해제': 'red', 권한: 'red' };
  return (
    <>
      {err && <div className="badge red" style={{ marginBottom: 8 }}>갱신 실패(직전 데이터 표시 중): {err}</div>}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 3, 7, 14, 30, 90].map((d) => <option key={d} value={d}>최근 {d}일</option>)}
          </select>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">전체 분류</option>
            {(data.categories || []).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <SearchBox className="input" style={{ width: 160 }} placeholder="변경한 계정" value={user} onChange={setUser} />
          <SearchBox className="input" style={{ width: 160 }} placeholder="대상(VM/호스트)" value={entity} onChange={setEntity} />
          <span className="muted" style={{ fontSize: 13 }}>
            변경 {data.total}건 / 스캔 {data.scanned}건{data.truncated ? ' (스캔 상한 도달 — 기간을 줄이세요)' : ''}
          </span>
          <button className="logout-btn" onClick={() => exportCsv('change-history', ['시각', 'vCenter', '분류', '타입', '계정', '대상', '내용'],
            (data.rows || []).map((r) => [new Date(r.ts).toISOString(), r.vcenterId, r.category, r.type, r.user, r.entity, r.message]))}>CSV</button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap" style={{ maxHeight: '62vh' }}>
          <table>
            <thead><tr><th>시각</th><th>분류</th><th>계정</th><th>대상</th><th>내용</th><th>vCenter</th></tr></thead>
            <tbody>
              {(data.rows || []).length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16, textAlign: 'center' }}>조건에 맞는 변경 이벤트가 없습니다.</td></tr>}
              {(data.rows || []).map((r, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtDate(r.ts)}</td>
                  <td><span className={`badge ${CAT_COLOR[r.category] || 'gray'}`}>{r.category}</span></td>
                  <td>{r.user || '—'}</td>
                  <td><b>{r.entity || '—'}</b></td>
                  <td className="muted" style={{ maxWidth: 520 }}>{r.message}</td>
                  <td>{r.vcenterId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>vCenter 이벤트 장기 보관 DB 기반 — 로그 수집 설정(관리자 › vCenter 로그)의 보관 기간 내 이벤트만 조회됩니다.</p>
    </>
  );
}

/* ── ⑩ 미보호 VM(백업 공백) ────────────────────────────────────────── */
export function UnprotectedVms({ scope }) {
  const [lookbackDays, setLookbackDays] = useState(7);
  const [patterns, setPatterns] = useState('');
  const [tab, setTab] = useState('unprotected');
  const { data, error, loading } = usePolling('/tools/report/unprotected', { vcenterId: scope, lookbackDays, patterns }, 60_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox message={error} />;
  const s = data.summary;
  const rows = tab === 'unprotected' ? data.unprotected : data.protected;
  const columns = [
    { key: 'name', label: 'VM', render: (r) => <VmLink id={r.id} name={r.name} /> },
    { key: 'vcenterId', label: 'vCenter' },
    { key: 'cluster', label: '클러스터' },
    { key: 'guestOS', label: 'OS' },
    { key: 'storageGB', label: '디스크', align: 'right', render: (r) => tb(r.storageGB) },
    ...(tab === 'protected' ? [
      { key: 'lastBackupTs', label: '마지막 백업 이벤트', render: (r) => fmtDate(r.lastBackupTs) },
      { key: 'backupUser', label: '백업 계정' },
    ] : []),
  ];
  return (
    <>
      {errBanner(error)}
      <div className="kpis">
        <Kpi label="미보호 VM" value={s.unprotectedCount} unit="대" accent={s.unprotectedCount ? 'var(--red)' : undefined} />
        <Kpi label="보호 확인" value={s.protectedCount} unit="대" pct={s.protectedPct} accent="var(--green)" />
        <Kpi label="백업 이벤트" value={s.backupEvents} unit="건" meta={`최근 ${data.config.lookbackDays}일`} />
        <Kpi label="판정 대상" value={s.scannedVms} unit="대" meta="가동 중 VM" />
      </div>
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="flex wrap gap" style={{ alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}>
            <span className="muted">조회 기간</span>
            <select className="select" value={lookbackDays} onChange={(e) => setLookbackDays(Number(e.target.value))}>
              {[3, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d}일</option>)}
            </select>
          </label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13, flex: 1, minWidth: 280 }}>
            <span className="muted nowrap">백업 계정 패턴</span>
            <SearchBox className="input" style={{ flex: 1 }} placeholder={(data.config.patterns || []).join(', ')} value={patterns} onChange={setPatterns} />
          </label>
          <button className="logout-btn" onClick={() => exportCsv('unprotected-vms', ['VM', 'vCenter', '클러스터', 'OS', '디스크GB'],
            (data.unprotected || []).map((r) => [r.name, r.vcenterId, r.cluster, r.guestOS, r.storageGB]))}>CSV</button>
        </div>
      </div>
      <div className="vcd-views" style={{ marginBottom: 10 }}>
        {[['unprotected', `미보호 (${s.unprotectedCount})`], ['protected', `보호 확인 (${s.protectedCount})`]].map(([k, label]) => (
          <button key={k} className={tab === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <DataTable columns={columns} rows={rows} initialSort={{ key: 'storageGB', dir: 'desc' }} emptyText="해당 항목이 없습니다." />
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{data.note}</p>
    </>
  );
}
