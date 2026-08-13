// IdracDetailModal.jsx — IdracAdmin.jsx(구 1,309줄)에서 분리(v2.292 모듈화 감사 1순위).
// 본문은 원본 459~787행 그대로 이동(기능 변화 없음).
//
// 분리 이유(감사 확정): 이 모달은 IdracAdmin 렌더에서 아예 사용되지 않고 HardwareTools.jsx 만
// 소비하는데, 그 import 하나 때문에 ① 1,309줄 뷰 파일 전체가 결합되고 ② IdracAdmin 모듈이
// Settings 청크와 SpecialTools 청크 양쪽의 공유 의존이 되어 특수기능 사용자에게 설정 화면
// 코드가 배달됐다(vite 코드 스플리팅 관점). 분리로 두 문제가 함께 해소된다.
//
// 컴팩트 후 이어받기 메모: views/idrac/ 디렉터리는 v2.292 에서 IdracAdmin 분할로 생성 —
// IdracDetailModal(HardwareTools 전용)·ScanJobLogModal·IdracScanJobs·IdracScanRanges(셸이 조립).
import React, { useEffect, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import EscClose from '../../components/EscClose.jsx';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

const LINE_COLORS = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c', '#4ade80', '#e879f9', '#94a3b8', '#fca5a5'];
const FW_TYPE_ORDER = ['iDRAC', 'BIOS', 'NIC', 'Storage', 'GPU', 'PSU', 'Disk', 'CPLD', 'Driver', '기타'];

/** iDRAC 서버 상세 — 버전(iDRAC/BIOS/드라이버) + 온도센서·CPU 사용량 1분 시계열 차트. */
export function IdracDetailModal({ server, onClose }) {
  const [inv, setInv] = useState(null);
  const [invErr, setInvErr] = useState(null);
  const [sensors, setSensors] = useState(null);
  const [tab, setTab] = useState('charts'); // charts | versions | gpu
  const [gpuProbe, setGpuProbe] = useState(null); // null | 'loading' | result
  const [vh, setVh] = useState(null); // 서비스태그로 매칭된 vCenter 가상화 호스트
  const runGpuProbe = () => { setGpuProbe('loading'); fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/gpu-probe`).then(setGpuProbe).catch((e) => setGpuProbe({ ok: false, reason: e.message })); };
  const loadInv = (refresh) => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/inventory${refresh ? '?refresh=1' : ''}`)
    .then((r) => { setInv(r.inventory); setInvErr(null); }).catch((e) => setInvErr(e.message));
  const loadSensors = () => fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/sensors?minutes=180`).then(setSensors).catch(() => {});
  useEffect(() => {
    loadInv(false); loadSensors();
    fetchJson(`/admin/idrac/${encodeURIComponent(server.id)}/vcenter-host`).then(setVh).catch(() => setVh(null));
    const t = setInterval(loadSensors, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */
  }, [server.id]);

  const sensorNames = (sensors?.sensors || []).slice(0, 12);
  const fanNames = (sensors?.fanNames || []).slice(0, 12);
  const chartData = (sensors?.samples || []).map((s) => {
    const row = { t: new Date(s.t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }), cpu: s.cpu };
    for (const n of sensorNames) row[n] = s.temps?.[n] ?? null;
    for (const n of fanNames) row[`fan:${n}`] = s.fans?.[n] ?? null;
    return row;
  });
  const latest = sensors?.latest;
  const fwByType = {};
  for (const f of (inv?.firmware || [])) (fwByType[f.type] = fwByType[f.type] || []).push(f);
  const orderedTypes = Object.keys(fwByType).sort((a, b) => (FW_TYPE_ORDER.indexOf(a) + 1 || 99) - (FW_TYPE_ORDER.indexOf(b) + 1 || 99));

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <EscClose onClose={onClose} />
      <div className="modal card" style={{ maxWidth: 980, width: '94vw' }}>
        <div className="flex between" style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>🖥 {server.name} — iDRAC 상세 / 센서</b>
          <button className="logout-btn" onClick={onClose}>닫기</button>
        </div>

        {/* 물리 ↔ 가상화 브릿지: 서비스태그(= ESXi 일련번호)로 매칭된 vCenter 호스트 */}
        {vh && (
          <div className="card" style={{ padding: '10px 12px', marginBottom: 12, borderLeft: `3px solid ${vh.matched ? 'var(--accent, #60a5fa)' : 'rgba(148,163,184,.4)'}` }}>
            {vh.matched ? (
              <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
                <div style={{ fontSize: 13 }}>
                  🖧 <b>연결된 vCenter 호스트</b>: <b style={{ color: 'var(--accent, #60a5fa)' }}>{vh.host.name}</b>
                  <span className="muted" style={{ marginLeft: 8 }}>
                    · vCenter <b>{vh.host.vcenterId || '—'}</b>
                    {vh.host.cluster ? <> · 클러스터 {vh.host.cluster}</> : null}
                    {vh.host.connectionState ? <> · {vh.host.connectionState}</> : null}
                  </span>
                  <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>(서비스태그 {vh.serviceTag} 일치)</span>
                </div>
                <div className="flex gap" style={{ fontSize: 12.5 }}>
                  <span className="muted">CPU <b style={{ color: 'var(--text)' }}>{vh.host.cpuUsagePct ?? '—'}%</b></span>
                  <span className="muted">MEM <b style={{ color: 'var(--text)' }}>{vh.host.memUsagePct ?? '—'}%</b></span>
                  <span className="muted">VM <b style={{ color: 'var(--text)' }}>{vh.host.vmCount ?? '—'}</b></span>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12.5 }}>
                🔩 연결된 vCenter 호스트 없음 — 서비스태그 <b>{vh.serviceTag || '—'}</b>와 일치하는 ESXi 호스트가 없습니다(순수 베어메탈이거나 해당 vCenter 미수집).
              </div>
            )}
          </div>
        )}

        <div className="flex gap" style={{ marginBottom: 12 }}>
          <button className={tab === 'charts' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => setTab('charts')}>📈 센서 차트(온도·CPU)</button>
          <button className={tab === 'versions' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => setTab('versions')}>🏷 하드웨어 / 버전</button>
          <button className={tab === 'gpu' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '6px 14px' }} onClick={() => { setTab('gpu'); if (!gpuProbe) runGpuProbe(); }}>🎮 GPU 수집 확인</button>
          {tab === 'versions' && <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} onClick={() => { setInv(null); loadInv(true); }}>↻ 즉시 재수집</button>}
        </div>

        {tab === 'charts' && (
          <div>
            <div className="flex gap wrap" style={{ marginBottom: 10 }}>
              <span className="badge blue">CPU 사용량 {latest?.cpu != null ? `${latest.cpu}%` : '— (텔레메트리 미지원)'}</span>
              <span className="badge amber">최고 온도 {(() => { const t = Object.values(latest?.temps || {}); return t.length ? `${Math.max(...t)}℃` : '—'; })()}</span>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>1분 간격 · 최근 {sensors?.count || 0}샘플 · 30초마다 갱신</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>CPU 사용량 (%)</div>
            <div style={{ width: '100%', height: 180 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                  <Line type="monotone" dataKey="cpu" name="CPU %" stroke="#60a5fa" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>온도 센서 (℃) — {sensorNames.length}개</div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 4, right: 12, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={36} unit="℃" />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {sensorNames.map((n, i) => (
                    <Line key={n} type="monotone" dataKey={n} stroke={LINE_COLORS[i % LINE_COLORS.length]} dot={false} strokeWidth={1.6} isAnimationActive={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {fanNames.length > 0 && (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>팬 속도 (RPM) — {fanNames.length}개</div>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <LineChart data={chartData} margin={{ top: 4, right: 12, left: -4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.15)" />
                      <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={40} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} width={46} />
                      <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {fanNames.map((n, i) => (
                        <Line key={n} type="monotone" dataKey={`fan:${n}`} name={n} stroke={LINE_COLORS[i % LINE_COLORS.length]} dot={false} strokeWidth={1.4} isAnimationActive={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
            {(!sensors || !sensors.samples?.length) && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>아직 수집된 센서 샘플이 없습니다. 첫 수집(1분 주기) 후 표시됩니다.</div>}
          </div>
        )}

        {tab === 'versions' && (
          invErr ? <ErrorBox message={invErr} /> : !inv ? <Loading /> : (
            <div>
              <div className="flex gap wrap" style={{ marginBottom: 12 }}>
                {Object.entries({ 전체: inv.health?.overall, CPU: inv.health?.processor, 메모리: inv.health?.memory, 스토리지: inv.health?.storage, PSU: inv.health?.psu }).map(([k, v]) => v ? (
                  <span key={k} className={`badge ${/ok/i.test(v) ? 'green' : /warn/i.test(v) ? 'amber' : 'red'}`}>{k}: {v}</span>
                ) : null)}
              </div>
              <div className="spec-grid" style={{ marginBottom: 14 }}>
                <div><span className="muted">iDRAC 펌웨어</span><div><b>{inv.idrac?.firmwareVersion || '—'}</b> {inv.idrac?.model && <span className="muted">({inv.idrac.model})</span>}</div></div>
                <div><span className="muted">BIOS 버전</span><div><b>{inv.bios?.version || inv.system?.biosVersion || '—'}</b></div></div>
                <div><span className="muted">모델</span><div>{[inv.system?.manufacturer, inv.system?.model].filter(Boolean).join(' ') || '—'}</div></div>
                <div><span className="muted">서비스태그</span><div>{inv.system?.serviceTag || '—'}</div></div>
                <div><span className="muted">CPU</span><div>{inv.cpu?.model || '—'} {inv.cpu?.count ? <span className="muted">×{inv.cpu.count} · {inv.cpu.cores}C/{inv.cpu.threads}T</span> : ''}</div></div>
                <div><span className="muted">메모리</span><div>{inv.memory?.totalGiB ? `${inv.memory.totalGiB} GiB` : '—'}{inv.memoryDimms?.length ? <span className="muted"> · DIMM {inv.memoryDimms.length}</span> : ''}</div></div>
                {inv.powerCap?.limitWatts != null && <div><span className="muted">전력 한도</span><div>{inv.powerCap.limitWatts} W</div></div>}
              </div>

              {(inv.psus || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>전원공급장치(PSU) {inv.psus.length}</div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>모델</th><th style={{ textAlign: 'left' }}>용량/출력</th><th style={{ textAlign: 'left' }}>입력</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{inv.psus.map((p, i) => (
                      <tr key={i}><td>{p.name}</td><td className="muted">{p.model || '—'}</td>
                        <td className="tabular">{p.capacityWatts ? `${p.capacityWatts}W` : '—'}{p.outputWatts != null ? ` / ${p.outputWatts}W` : ''}</td>
                        <td className="tabular">{p.lineInputVoltage != null ? `${p.lineInputVoltage}V` : '—'}{p.inputWatts != null ? ` · ${p.inputWatts}W` : ''}</td>
                        <td><span className={`badge ${/ok/i.test(p.health) ? 'green' : p.health ? 'amber' : 'gray'}`}>{p.health || p.state || '—'}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {(inv.disks || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>물리 디스크 {inv.disks.length} {inv.disks.some((d) => d.predictiveFailure) && <span className="badge red" style={{ marginLeft: 6 }}>⚠ SMART 예측 실패</span>}</div>
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                      <thead><tr><th style={{ textAlign: 'left' }}>디스크</th><th style={{ textAlign: 'left' }}>용량</th><th style={{ textAlign: 'left' }}>미디어</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                      <tbody>{inv.disks.map((d, i) => (
                        <tr key={i}><td>{d.name}<div className="muted" style={{ fontSize: 11 }}>{d.model}</div></td>
                          <td className="tabular">{d.capacityGB != null ? `${d.capacityGB} GB` : '—'}</td>
                          <td className="muted">{d.media || '—'}{d.protocol ? ` · ${d.protocol}` : ''}</td>
                          <td>{d.predictiveFailure ? <span className="badge red">예측 실패</span> : <span className={`badge ${/ok/i.test(d.health) ? 'green' : d.health ? 'amber' : 'gray'}`}>{d.health || d.state || '—'}</span>}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              )}

              {(inv.gpus || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>GPU(iDRAC 인식) {inv.gpus.length}</div>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>이름</th><th style={{ textAlign: 'left' }}>모델</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{inv.gpus.map((g, i) => (
                      <tr key={i}><td>{g.name}</td><td className="muted">{[g.manufacturer, g.model].filter(Boolean).join(' ') || '—'}</td>
                        <td><span className={`badge ${/ok/i.test(g.health) ? 'green' : g.health ? 'amber' : 'gray'}`}>{g.health || g.state || '—'}</span></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}

              {(inv.nics || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>NIC 어댑터/포트 {inv.nics.length}</div>
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {inv.nics.map((n, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{n.model || n.name}</div>
                        <div className="flex gap wrap" style={{ marginTop: 2 }}>
                          {(n.ports || []).length === 0 ? <span className="muted" style={{ fontSize: 11 }}>포트 정보 없음</span> : n.ports.map((p, j) => (
                            <span key={j} className={`badge ${/up|enabled|linkup/i.test(p.link) ? 'green' : 'gray'}`} style={{ fontSize: 11 }}>
                              {p.id} {/up|enabled|linkup/i.test(p.link) ? '🔗' : '⛔'} {p.speedMbps ? `${p.speedMbps >= 1000 ? `${(p.speedMbps / 1000).toFixed(0)}G` : `${p.speedMbps}M`}` : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(inv.licenses || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 라이선스</div>
                  <div className="flex gap wrap">
                    {inv.licenses.map((l, i) => <span key={i} className="badge blue" title={l.entitlement}>{l.type || l.name}{l.expiry ? ` · ~${String(l.expiry).slice(0, 10)}` : ''}</span>)}
                  </div>
                </div>
              )}

              {(inv.idracUsers || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 계정 {inv.idracUsers.length}</div>
                  <div className="flex gap wrap">
                    {inv.idracUsers.map((u, i) => <span key={i} className={`badge ${u.enabled ? 'gray' : 'red'}`}>{u.userName} · {u.role || '—'}{u.enabled ? '' : '(비활성)'}</span>)}
                  </div>
                </div>
              )}

              {inv.boot && (inv.boot.overrideTarget || inv.boot.bootOrderCount != null) && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                  부팅: {inv.boot.bootOrderCount != null ? `순서 ${inv.boot.bootOrderCount}개` : ''}{inv.boot.overrideTarget && inv.boot.overrideTarget !== 'None' ? ` · 다음부팅 ${inv.boot.overrideTarget}(${inv.boot.overrideEnabled})` : ''}{inv.boot.mode ? ` · ${inv.boot.mode}` : ''}
                </div>
              )}

              {(inv.events || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>최근 하드웨어 이벤트(Critical/Warning) {inv.events.length}</div>
                  <div style={{ maxHeight: 160, overflow: 'auto' }}>
                    {inv.events.map((e, i) => (
                      <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid rgba(148,163,184,.12)' }}>
                        <span className={`badge ${/crit/i.test(e.severity) ? 'red' : 'amber'}`} style={{ marginRight: 6 }}>{e.severity}</span>
                        <span className="muted">{e.created ? new Date(e.created).toLocaleString('ko-KR') : ''}</span>
                        <div style={{ marginTop: 2 }}>{e.message}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>펌웨어 / 드라이버 버전 ({(inv.firmware || []).length})</div>
              {(inv.firmware || []).length === 0 ? <div className="muted" style={{ fontSize: 13 }}>펌웨어 인벤토리를 읽지 못했습니다(모델/권한 확인). “↻ 즉시 재수집”을 눌러보세요.</div> : (
                <div style={{ maxHeight: 340, overflow: 'auto' }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>종류</th><th style={{ textAlign: 'left' }}>구성요소</th><th style={{ textAlign: 'left' }}>버전</th></tr></thead>
                    <tbody>
                      {orderedTypes.map((ty) => fwByType[ty].map((f, i) => (
                        <tr key={ty + i}>
                          <td>{i === 0 ? <span className="badge gray">{ty}</span> : ''}</td>
                          <td>{f.name}</td>
                          <td className="tabular"><b>{f.version}</b></td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>인벤토리는 30분마다 자동 갱신됩니다. 방금 값을 보려면 “↻ 즉시 재수집”.</div>
            </div>
          )
        )}

        {tab === 'gpu' && (
          <div>
            <div className="flex gap" style={{ alignItems: 'center', marginBottom: 12 }}>
              <button className="logout-btn" style={{ padding: '7px 14px' }} disabled={gpuProbe === 'loading'} onClick={runGpuProbe}>{gpuProbe === 'loading' ? '확인 중…' : '↻ 다시 확인'}</button>
              <span className="muted" style={{ fontSize: 12 }}>iDRAC(Redfish)에서 이 서버의 GPU 사용률을 OOB로 수집할 수 있는지 실측합니다.</span>
            </div>
            {gpuProbe === 'loading' ? <Loading /> : !gpuProbe ? null : gpuProbe.ok === false ? <ErrorBox message={gpuProbe.reason} /> : (
              <div>
                <div className="card" style={{ padding: 14, marginBottom: 14, borderColor: gpuProbe.utilizationAvailable ? 'var(--green)' : 'var(--amber)' }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: gpuProbe.utilizationAvailable ? 'var(--green)' : 'var(--amber)' }}>
                    {gpuProbe.utilizationAvailable ? '✅ GPU 사용률 OOB 수집 가능' : '⚠ GPU 사용률 OOB 수집 불가/미확인'}
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
                    {gpuProbe.utilizationAvailable
                      ? 'iDRAC 텔레메트리/ProcessorMetrics에서 GPU 사용률 메트릭이 확인되었습니다. (게스트 nvidia-smi 없이도 수집 가능)'
                      : 'iDRAC에서 GPU 사용률 메트릭을 찾지 못했습니다. 보통 iDRAC9 + DataCenter 라이선스 + SMBPBI 지원 데이터센터 GPU + 텔레메트리 활성에서만 노출됩니다. 그 전까지는 게스트 OS의 nvidia-smi(설정 › GPU 게스트 수집)로 수집하세요.'}
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, margin: '6px 0' }}>iDRAC 인식 GPU {gpuProbe.gpus.length}</div>
                {gpuProbe.gpus.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>iDRAC가 인식한 GPU가 없습니다(패스쓰루로 게스트에 직접 할당된 경우 안 보일 수 있음).</div> : (
                  <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
                    <thead><tr><th style={{ textAlign: 'left' }}>GPU</th><th style={{ textAlign: 'left' }}>사용률</th><th style={{ textAlign: 'left' }}>온도</th><th style={{ textAlign: 'left' }}>전력</th><th style={{ textAlign: 'left' }}>상태</th></tr></thead>
                    <tbody>{gpuProbe.gpus.map((g, i) => (
                      <tr key={i}>
                        <td>{g.name}<div className="muted" style={{ fontSize: 11 }}>{[g.manufacturer, g.model].filter(Boolean).join(' ')}</div></td>
                        <td className="tabular">{g.utilPct != null ? `${g.utilPct}%` : g.bandwidthPct != null ? `${g.bandwidthPct}% (대역폭)` : '—'}</td>
                        <td className="tabular">{g.tempC != null ? `${g.tempC}℃` : '—'}</td>
                        <td className="tabular">{g.powerW != null ? `${g.powerW}W` : '—'}</td>
                        <td><span className={`badge ${/ok/i.test(g.health) ? 'green' : g.health ? 'amber' : 'gray'}`}>{g.health || g.state || '—'}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, margin: '12px 0 6px' }}>텔레메트리</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  TelemetryService: <b style={{ color: gpuProbe.telemetry.available ? 'var(--green)' : 'var(--text-faint)' }}>{gpuProbe.telemetry.available ? '있음' : '없음/비활성'}</b>
                  {gpuProbe.telemetry.gpuReports.length > 0 && <> · GPU 리포트 {gpuProbe.telemetry.gpuReports.map((r) => `${r.id}(${r.metrics}개${r.hasUtilization ? ', 사용률O' : ''})`).join(', ')}</>}
                </div>
                {(gpuProbe.notes || []).length > 0 && (
                  <ul className="muted" style={{ fontSize: 12, marginTop: 10, paddingLeft: 18 }}>
                    {gpuProbe.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
