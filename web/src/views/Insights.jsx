import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, putJson, postJson, usePolling } from '../api.js';
import { Loading, ErrorBox, VmLink } from '../components/ui.jsx';
import { enableNotifications } from '../pwa.js';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
};
const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('ko-KR') : '—');

function Kpi({ label, value, sub, color }) {
  return (
    <div className="card" style={{ padding: '12px 16px', minWidth: 150, flex: '1 1 150px' }}>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || 'inherit' }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

const GRID = 'rgba(148,163,184,.15)';

/* ───────────────────────── FinOps ───────────────────────── */
function FinOps() {
  const [d, setD] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const load = () => fetchJson('/insights/finops').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); fetchJson('/insights/finops/config').then(setCfg).catch(() => {}); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);
  if (err) return <ErrorBox message={err} />;
  if (!d || !cfg) return <Loading />;
  const cur = d.config.currency;
  const c = (v) => `${cur}${num(v)}`;
  const saveCfg = async () => {
    setBusy(true); setMsg(null);
    try { const r = await putJson('/insights/finops/config', cfg); setCfg(r); setMsg('저장됨 — 다음 갱신부터 반영'); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>전력 수집(iDRAC/OME/원격) 기반 에너지·비용·탄소 추정. 현재 소비전력 × PUE {d.config.pue} 기준. 측정 호스트 {d.measuredHosts}/{d.totalHosts}.</p>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        <Kpi label="현재 소비전력" value={`${num(d.totals.watts)} W`} sub={`설비 포함 ${num(d.totals.facilityWatts)} W`} />
        <Kpi label="월 에너지" value={`${num(d.totals.kwhMonth)} kWh`} sub={`연 ${num(d.totals.kwhYear)} kWh`} />
        <Kpi label="월 전기요금" value={c(d.totals.costMonth)} sub={`일 ${c(d.totals.costDay)}`} color="#fbbf24" />
        <Kpi label="연 전기요금" value={c(d.totals.costYear)} color="#fbbf24" />
        <Kpi label="월 탄소배출" value={`${num(d.totals.co2MonthKg)} kg`} sub={`연 ${num(d.totals.co2YearKg)} kg CO₂`} color="#34d399" />
      </div>
      {d.byVcenter.length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0 }}>vCenter별 월 전기요금</div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={d.byVcenter.slice(0, 15)}>
              <CartesianGrid stroke={GRID} />
              <XAxis dataKey="vcId" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => c(v)} contentStyle={{ background: '#1e293b', border: 'none', fontSize: 12 }} />
              <Bar dataKey="costMonth" name="월 요금" fill="#fbbf24" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <div className="flex gap wrap" style={{ alignItems: 'flex-start' }}>
        <div className="card" style={{ padding: 14, flex: '2 1 380px' }}>
          <div className="section-title" style={{ marginTop: 0 }}>전력 상위 호스트</div>
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table><thead><tr><th>호스트</th><th>vCenter</th><th>모델</th><th style={{ textAlign: 'right' }}>W</th></tr></thead>
              <tbody>{d.topHosts.map((h) => (
                <tr key={h.host}><td><b>{h.host}</b></td><td className="muted">{h.vcenterId}</td><td className="muted" style={{ fontSize: 12 }}>{h.model || '—'}</td><td style={{ textAlign: 'right' }}>{num(h.watts)}</td></tr>
              ))}</tbody></table>
          </div>
        </div>
        <div className="card" style={{ padding: 14, flex: '1 1 260px' }}>
          <div className="section-title" style={{ marginTop: 0 }}>요금/탄소 단가 설정</div>
          <label className="muted" style={{ fontSize: 12 }}>전기요금 단가 (통화/kWh)</label>
          <input className="input" type="number" value={cfg.tariffPerKwh} onChange={(e) => setCfg({ ...cfg, tariffPerKwh: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted" style={{ fontSize: 12 }}>통화 기호</label>
          <input className="input" value={cfg.currency} onChange={(e) => setCfg({ ...cfg, currency: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted" style={{ fontSize: 12 }}>CO₂ 계수 (kg/kWh)</label>
          <input className="input" type="number" step="0.01" value={cfg.co2KgPerKwh} onChange={(e) => setCfg({ ...cfg, co2KgPerKwh: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
          <label className="muted" style={{ fontSize: 12 }}>PUE (설비 효율, 1.0~)</label>
          <input className="input" type="number" step="0.1" value={cfg.pue} onChange={(e) => setCfg({ ...cfg, pue: e.target.value })} style={{ width: '100%', marginBottom: 10 }} />
          <button className="login-btn" disabled={busy} onClick={saveCfg} style={{ padding: '7px 14px' }}>저장</button>
          {msg && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{msg}</div>}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── 이상탐지 ───────────────────────── */
function Anomaly() {
  const [z, setZ] = useState(3.5);
  const { data: d, error, loading } = usePolling('/insights/anomalies', { z, windowHours: 24 }, 30_000);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>임계값이 아니라 <b>평소 패턴 대비 이탈</b>을 통계(중앙값·MAD 기반 Z-score)로 탐지합니다. 최근 24시간 분포 기준.</p>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <Kpi label="탐지된 이상" value={num(d?.total)} color={d?.total ? '#f87171' : '#34d399'} />
        <label className="muted" style={{ fontSize: 12 }}>민감도 Z =
          <select className="select" value={z} onChange={(e) => setZ(Number(e.target.value))} style={{ marginLeft: 6 }}>
            {[2.5, 3, 3.5, 4, 5].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>
      {(d?.families || []).map((fam) => (
        <div key={fam.metric} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="flex between"><b>{fam.label}</b><span className={`badge ${fam.count ? 'red' : 'green'}`}>{fam.count}건</span></div>
          {fam.items.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: '36vh', marginTop: 6 }}>
              <table><thead><tr><th>엔티티</th><th style={{ textAlign: 'right' }}>현재값</th><th style={{ textAlign: 'right' }}>평소</th><th style={{ textAlign: 'right' }}>Z</th><th>시각</th></tr></thead>
                <tbody>{fam.items.map((it) => (
                  <tr key={it.key}>
                    <td style={{ fontSize: 12 }}>{it.key}</td>
                    <td style={{ textAlign: 'right' }}><b style={{ color: it.direction === 'high' ? '#f87171' : '#60a5fa' }}>{it.value}{it.unit}</b></td>
                    <td style={{ textAlign: 'right' }} className="muted">{it.baseline}{it.unit}</td>
                    <td style={{ textAlign: 'right' }}><span className="badge red">{it.direction === 'high' ? '▲' : '▼'} {Math.abs(it.z)}</span></td>
                    <td className="muted" style={{ fontSize: 11 }}>{fmtAgo(it.at)}</td>
                  </tr>
                ))}</tbody></table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── 용량 예측 ───────────────────────── */
function Forecast() {
  const { data: d, error, loading } = usePolling('/insights/forecast', { days: 14 }, 60_000);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  const dsRow = (x) => (
    <tr key={x.id}>
      <td><b>{x.name}</b></td><td className="muted">{x.vcenterId}</td>
      <td style={{ textAlign: 'right' }}>{x.usagePct}%</td>
      <td style={{ textAlign: 'right' }}>{x.slopePerDay > 0 ? '+' : ''}{x.slopePerDay} GB/일</td>
      <td style={{ textAlign: 'right' }}>{x.daysToLimit == null ? '안정' : <span className={`badge ${x.daysToLimit <= 14 ? 'red' : x.daysToLimit <= 30 ? 'amber' : 'gray'}`}>{x.daysToLimit}일</span>}</td>
      <td className="muted" style={{ fontSize: 12 }}>{x.etaTs ? fmtDate(x.etaTs) : '—'}</td>
    </tr>
  );
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>최근 14일 추세를 선형회귀해 <b>한계 도달 시점(ETA)</b>을 추정합니다. 신뢰도(R²) 0.3 이상만 표시.</p>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        <Kpi label="30일 내 포화 예상 DS" value={num((d?.soon || []).length)} color={(d?.soon || []).length ? '#f87171' : '#34d399'} />
        <Kpi label="예측 가능 DS" value={num((d?.datastores || []).length)} />
        <Kpi label="GPU 추세 vCenter" value={num((d?.gpu || []).length)} />
      </div>
      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="section-title" style={{ marginTop: 0 }}>데이터스토어 포화 예측</div>
        {(d?.datastores || []).length === 0
          ? <div className="muted" style={{ fontSize: 12 }}>아직 추세를 낼 만큼 시계열이 쌓이지 않았습니다(며칠 후 표시).</div>
          : <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table><thead><tr><th>데이터스토어</th><th>vCenter</th><th style={{ textAlign: 'right' }}>사용률</th><th style={{ textAlign: 'right' }}>증가율</th><th style={{ textAlign: 'right' }}>포화까지</th><th>예상일</th></tr></thead>
              <tbody>{d.datastores.map(dsRow)}</tbody></table>
          </div>}
      </div>
      {(d?.gpu || []).length > 0 && (
        <div className="card" style={{ padding: 14 }}>
          <div className="section-title" style={{ marginTop: 0 }}>GPU 사용률 추세(vCenter)</div>
          <div className="table-wrap"><table><thead><tr><th>vCenter</th><th style={{ textAlign: 'right' }}>현재</th><th style={{ textAlign: 'right' }}>증가율</th><th style={{ textAlign: 'right' }}>포화까지</th><th>예상일</th></tr></thead>
            <tbody>{d.gpu.map((g) => (
              <tr key={g.vcenterId}><td><b>{g.vcenterId}</b></td><td style={{ textAlign: 'right' }}>{g.current}%</td><td style={{ textAlign: 'right' }}>{g.slopePerDay > 0 ? '+' : ''}{g.slopePerDay}%/일</td>
                <td style={{ textAlign: 'right' }}>{g.daysToLimit == null ? '안정' : <span className="badge amber">{g.daysToLimit}일</span>}</td><td className="muted">{g.etaTs ? fmtDate(g.etaTs) : '—'}</td></tr>
            ))}</tbody></table></div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── 보안 자세 ───────────────────────── */
function Security() {
  const { data: d, error, loading } = usePolling('/insights/security', {}, 60_000);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  const badge = (w) => <span className={`badge ${w === 'critical' ? 'red' : w === 'warning' ? 'amber' : 'green'}`}>{w === 'critical' ? '위험' : w === 'warning' ? '주의' : '정상'}</span>;
  const advCell = (x) => (
    <td style={{ fontSize: 11 }}>
      {x.eol && <span className="badge red" title={`지원종료 ${x.eolDate}`}>EOL {x.eolDate}</span>}
      {(x.advisories || []).map((a) => <span key={a.id + a.cve} className="badge amber" title={`${a.note} · ${a.fix}`} style={{ marginLeft: 4 }}>{a.cve}</span>)}
      {!x.eol && !(x.advisories || []).length && <span className="muted">—</span>}
    </td>
  );
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>수집된 ESXi/vCenter 빌드를 내장 VMSA 권고 + 수명(EOL) 데이터셋과 대조합니다(데이터셋 {d?.dataset?.date}, 권고 {d?.dataset?.advisories}건). ⚠️ 참고용 — 패치 전 공식 VMSA 확인.</p>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        <Kpi label="위험" value={num(d?.summary.critical)} color="#f87171" />
        <Kpi label="주의" value={num(d?.summary.warning)} color="#fbbf24" />
        <Kpi label="정상" value={num(d?.summary.ok)} color="#34d399" />
        <Kpi label="지원종료(EOL)" value={num(d?.summary.eol)} color={d?.summary.eol ? '#f87171' : '#34d399'} />
      </div>
      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div className="section-title" style={{ marginTop: 0 }}>vCenter</div>
        <div className="table-wrap"><table><thead><tr><th>vCenter</th><th>버전</th><th>빌드</th><th>상태</th><th>취약점/EOL</th></tr></thead>
          <tbody>{(d?.vcenters || []).map((v) => (
            <tr key={v.id}><td><b>{v.name}</b></td><td>{v.version}</td><td className="muted">{v.build || '—'}</td><td>{badge(v.worst)}</td>{advCell(v)}</tr>
          ))}</tbody></table></div>
      </div>
      <div className="card" style={{ padding: 14 }}>
        <div className="section-title" style={{ marginTop: 0 }}>ESXi 호스트 ({(d?.hosts || []).length})</div>
        <div className="table-wrap" style={{ maxHeight: '48vh' }}><table><thead><tr><th>호스트</th><th>vCenter</th><th>버전</th><th>빌드</th><th>상태</th><th>취약점/EOL</th></tr></thead>
          <tbody>{(d?.hosts || []).map((h) => (
            <tr key={h.id}><td><b>{h.name}</b></td><td className="muted">{h.vcenterId}</td><td>{h.version}</td><td className="muted">{h.build || '—'}</td><td>{badge(h.worst)}</td>{advCell(h)}</tr>
          ))}</tbody></table></div>
      </div>
    </div>
  );
}

/* ───────────────────────── 토폴로지 ───────────────────────── */
function TreeNode({ node, depth }) {
  const [open, setOpen] = useState(depth < 2);
  const hasKids = (node.children || []).length > 0;
  const icon = node.type === 'vcenter' ? '🏢' : node.type === 'cluster' ? '🗄' : node.type === 'host' ? '🖥' : '📦';
  const stateColor = node.power === 'POWERED_OFF' ? '#94a3b8' : node.state === 'DISCONNECTED' || node.status === 'unreachable' ? '#f87171' : node.status === 'connected' || node.state === 'CONNECTED' ? '#34d399' : 'inherit';
  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div className="flex gap" style={{ alignItems: 'center', padding: '3px 0', fontSize: 13 }}>
        {hasKids ? <button className="logout-btn" style={{ padding: '0 6px', minWidth: 22 }} onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'}</button> : <span style={{ width: 22 }} />}
        <span>{icon}</span>
        {node.type === 'vm'
          ? <VmLink name={node.label} ip={node.ip} />
          : <b style={{ color: stateColor }}>{node.label}</b>}
        <span className="muted" style={{ fontSize: 11 }}>
          {node.type === 'vcenter' && `· ${node.region || ''} v${node.version || '?'} · 호스트 ${node.hosts} · VM ${node.vmCount}`}
          {node.type === 'cluster' && `· 호스트 ${node.hosts} · VM ${node.vmCount}`}
          {node.type === 'host' && `· CPU ${node.cpuPct}% MEM ${node.memPct}% · VM ${node.vmOn}/${node.vmCount}${node.gpus ? ` · GPU ${node.gpus}` : ''}${node.watts ? ` · ${node.watts}W` : ''}`}
          {node.type === 'vm' && `· ${node.guestOS || ''} ${node.cpuPct}%/${node.memPct}%${node.gpu ? ` · ${node.gpu}` : ''}`}
        </span>
      </div>
      {open && hasKids && node.children.map((ch) => <TreeNode key={ch.id} node={ch} depth={depth + 1} />)}
    </div>
  );
}
function Topology() {
  const [vc, setVc] = useState('');
  const { data: d, error, loading } = usePolling('/insights/topology', vc ? { vcenterId: vc } : {}, 30_000);
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>vCenter → 클러스터 → 호스트 → VM 의존성 트리. 장애 영향 범위 파악용. 특정 vCenter 선택 시 개별 VM까지 펼칩니다.</p>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <select className="select" value={vc} onChange={(e) => setVc(e.target.value)}>
          <option value="">전체 vCenter (호스트까지)</option>
          {(d?.vcenters || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>노드 {num(d?.nodeCount)} · {fmtAgo(d?.generatedAt)}</span>
      </div>
      <div className="card" style={{ padding: 14, maxHeight: '64vh', overflow: 'auto' }}>
        {(d?.tree || []).length === 0 ? <div className="muted">표시할 토폴로지가 없습니다.</div>
          : d.tree.map((n) => <TreeNode key={n.id} node={n} depth={0} />)}
      </div>
    </div>
  );
}

/* ───────────────────────── 인시던트 ───────────────────────── */
function Incidents() {
  const { data: d, error, loading } = usePolling('/insights/incidents', {}, 20_000);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  if (error) return <ErrorBox message={error} />;
  if (loading && !d) return <Loading />;
  const sev = (s) => <span className={`badge ${s === 'critical' ? 'red' : s === 'warning' ? 'amber' : s === 'resolved' ? 'green' : 'gray'}`}>{s === 'critical' ? '위험' : s === 'warning' ? '경고' : s === 'resolved' ? '해소' : s}</span>;
  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 8 }}>
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>경보 발생/해소 + vCenter 수집 실패를 시간순으로 추적합니다. {d?.summary.channelsOn ? '알림 채널 켜짐' : '알림 채널 꺼짐(설정 › 알림)'}.</p>
        {notif !== 'unsupported' && (
          notif === 'granted'
            ? <span className="badge green" style={{ flex: 'none' }}>🔔 브라우저 알림 켜짐</span>
            : <button className="logout-btn" style={{ padding: '6px 12px', flex: 'none' }} onClick={async () => setNotif(await enableNotifications())}>🔔 브라우저 알림 켜기</button>
        )}
      </div>
      <div className="flex gap wrap" style={{ marginBottom: 12 }}>
        <Kpi label="진행중" value={num(d?.summary.open)} color={d?.summary.open ? '#fbbf24' : '#34d399'} />
        <Kpi label="진행중(위험)" value={num(d?.summary.openCritical)} color={d?.summary.openCritical ? '#f87171' : '#34d399'} />
        <Kpi label="최근 24h 발생" value={num(d?.summary.recent24h)} />
      </div>
      {(d?.byDay || []).length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0 }}>일자별 발생 추세</div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={d.byDay}>
              <CartesianGrid stroke={GRID} />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#1e293b', border: 'none', fontSize: 12 }} />
              <Line type="monotone" dataKey="critical" name="위험" stroke="#f87171" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="warning" name="경고" stroke="#fbbf24" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {(d?.open || []).length > 0 && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="section-title" style={{ marginTop: 0 }}>진행중 인시던트</div>
          <div className="table-wrap"><table><thead><tr><th>심각도</th><th>제목</th><th>상세</th><th style={{ textAlign: 'right' }}>경과</th></tr></thead>
            <tbody>{d.open.map((o) => (
              <tr key={o.key}><td>{sev(o.severity)}</td><td><b>{o.title}</b></td><td className="muted" style={{ fontSize: 12 }}>{o.detail}</td><td style={{ textAlign: 'right' }}>{o.ageMin}분</td></tr>
            ))}</tbody></table></div>
        </div>
      )}
      <div className="card" style={{ padding: 14 }}>
        <div className="section-title" style={{ marginTop: 0 }}>타임라인</div>
        {(d?.timeline || []).length === 0 ? <div className="muted" style={{ fontSize: 12 }}>기록된 이벤트가 없습니다.</div>
          : <div className="table-wrap" style={{ maxHeight: '48vh' }}><table><thead><tr><th>시각</th><th>구분</th><th>심각도</th><th>제목</th></tr></thead>
            <tbody>{d.timeline.map((e, i) => (
              <tr key={i}><td className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleString('ko-KR')}</td><td style={{ fontSize: 12 }}>{e.kind === 'resolved' ? '해소' : '발생'}</td><td>{sev(e.severity)}</td><td style={{ fontSize: 12 }}>{e.title}</td></tr>
            ))}</tbody></table></div>}
      </div>
    </div>
  );
}

/* ───────────────────────── ChatOps ───────────────────────── */
function ChatOps() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true); setQ('');
    setLog((l) => [...l, { role: 'user', text: question }]);
    try {
      const r = await postJson('/insights/chatops', { question });
      setLog((l) => [...l, { role: 'ai', text: r.answer, source: r.source, search: r.search }]);
    } catch (e) { setLog((l) => [...l, { role: 'ai', text: `오류: ${e.message}`, source: 'error' }]); }
    finally { setBusy(false); }
  };
  const examples = ['CPU 80% 넘는 호스트 보여줘', '진행중인 경보 요약해줘', '용량 부족한 데이터스토어 몇 개야?', '가장 전력 많이 쓰는 vCenter는?'];
  return (
    <div style={{ maxWidth: 860 }}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>자연어로 인프라 현황을 질문하세요. 실제 데이터는 포탈을 떠나지 않고 요약 컨텍스트만 LLM에 전달됩니다(설정 › AI 검색에서 Ollama 활성화 시 자연어 답변, 아니면 규칙 기반 요약).</p>
      <div className="card" style={{ padding: 14, minHeight: 280, maxHeight: '54vh', overflow: 'auto', marginBottom: 10 }}>
        {log.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            예시 질문:
            <div className="flex gap wrap" style={{ marginTop: 8 }}>
              {examples.map((ex) => <button key={ex} className="tab" style={{ flex: 'none' }} onClick={() => setQ(ex)}>{ex}</button>)}
            </div>
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} style={{ marginBottom: 12, textAlign: m.role === 'user' ? 'right' : 'left' }}>
            <div style={{ display: 'inline-block', maxWidth: '85%', padding: '8px 12px', borderRadius: 10, whiteSpace: 'pre-wrap', textAlign: 'left',
              background: m.role === 'user' ? 'var(--accent,#2563eb)' : 'rgba(148,163,184,.12)', color: m.role === 'user' ? '#fff' : 'inherit', fontSize: 13 }}>
              {m.text}
              {m.source && m.role === 'ai' && <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>({m.source === 'llm' ? 'LLM' : m.source === 'fallback' ? '규칙기반' : m.source})</div>}
            </div>
          </div>
        ))}
        {busy && <div className="muted" style={{ fontSize: 12 }}>생각 중…</div>}
      </div>
      <div className="flex gap">
        <input className="input" style={{ flex: 1 }} value={q} placeholder="질문을 입력하세요…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
        <button className="login-btn" disabled={busy} onClick={ask} style={{ padding: '8px 18px' }}>질문</button>
      </div>
    </div>
  );
}

/* ───────────────────────── 컨테이너 ───────────────────────── */
const PANELS = [
  { k: 'finops', label: '💰 FinOps', C: FinOps },
  { k: 'anomaly', label: '🤖 이상탐지', C: Anomaly },
  { k: 'forecast', label: '📈 용량예측', C: Forecast },
  { k: 'security', label: '🛡 보안', C: Security },
  { k: 'topology', label: '🌐 토폴로지', C: Topology },
  { k: 'incidents', label: '🚨 인시던트', C: Incidents },
  { k: 'chatops', label: '💬 ChatOps', C: ChatOps },
];

export default function Insights() {
  const [sub, setSub] = useState('finops');
  const Cur = (PANELS.find((p) => p.k === sub) || PANELS[0]).C;
  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>📊 인사이트</div>
      <div className="vcd-views" style={{ marginBottom: 14 }}>
        {PANELS.map((p) => (
          <button key={p.k} className={sub === p.k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '8px 14px' }} onClick={() => setSub(p.k)}>{p.label}</button>
        ))}
      </div>
      <Cur />
    </div>
  );
}
