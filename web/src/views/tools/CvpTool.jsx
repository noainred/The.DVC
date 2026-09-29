import React, { useCallback, useEffect, useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, postJson, putJson, delJson, getCurrentUser, downloadFile, canCsv } from '../../api.js';
import { Loading, ErrorBox, Kpi, Modal, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { droppedSecretNote } from '../droppedSecretText.js';
import { useHashTab } from '../../hooks/useHashTab.js';
import CvpBulkIo from './CvpBulkIo.jsx';
import {
  overviewRows, sysCell, eventReadNotes, severityCounts, severityTone, severityLabel, EVENT_SEVERITIES,
  portUsageKpis, PORT_USAGE_NOTE, utilTone, rateText, probeRows, PROBE_NOTE,
} from './cvpMoreText.js';
import { hostText, addressHiddenNote } from './addressHiddenText.js';
import {
  agoText, spanText, countText, bpsText, pctText, kpiItems, serverState, authStopText, isAuthStopped,
  missingFootnotes, itemLabel, CANDIDATE_NOTE, deviceCountLabel, partsCell, bgpCell, portsCell, streamingText, filterDevices,
  partState, partCounts, seriesGeometry, seriesSourceNote, collectSummary,
  EMPTY_SERVER, serverToForm, serverPayload, choiceOptions, settingsPayload, settingsToForm, SECRET_MASK,
  isTruncated, canCollect, listNotes, partsMissingText, telemetryText,
  edgeReportView, serverMetaText, dbStatsText, DEVICE_CHIPS, chipCounts, filterByChip, devicesCsvPath, CSV_NOTE,
  CHART_MODES, seriesGeometryBps, chartCutNote, faultKindLabel, faultRowView, faultEventText, faultKpi, faultScanNote, FAULT_INTRO,
  sampleRows, SAMPLE_NOTE, PREVIEW_NOTE, previewSummary, previewColumns, sampleBadge, SYS_HIGH_PCT,
  eventDeviceRefs, eventDeviceSort,
} from './cvpText.js';

/**
 * 특수기능 › Arista CloudVision(CVP) — v2.608.
 *
 * CVP 에 등록된 네트워크 스위치의 인벤토리·EOS 버전·장애 파트·포트 구성·포트 사용량·BGP 요약을 본다.
 * 수집은 엣지(현지) 또는 중앙 직접이고, 이 화면은 중앙이 가진 값만 읽는다(장비 왕복 없음).
 *  · **폴링하지 않는다** — 마운트 1회 + 새로고침 버튼(v2.508 V4 규약).
 *  · 판정·문구는 cvpText.js 하나가 소유한다(vitest). 못 읽은 값은 '—'(단위 없음).
 *  · 조회 권한: tools + 전체 범위(서버 403 → ErrorBox 가 권한 안내로 바꾼다). 등록·설정은 admin.
 */

const TONE = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', muted: 'var(--text-dim)' };
const Badge = ({ tone = 'muted', children, title }) => (
  <span title={title} style={{ color: TONE[tone] || TONE.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>
);
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minWidth: 0 };
const NOTE = { fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 };

export default function CvpTool() {
  // ⚠ 훅은 전부 조기 return 위에(React #310 회귀 방지).
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [devices, setDevices] = useState(null);
  const [devErr, setDevErr] = useState(null);
  const [q, setQ] = useState('');
  const [cvpSel, setCvpSel] = useState('');
  const [msg, setMsg] = useState(null);
  const [collectErr, setCollectErr] = useState(null); // 403 등 — ErrorBox 가 권한 안내로 바꾼다(v2.398)
  const [busy, setBusy] = useState(false);
  const [detailKey, setDetailKey] = useState(null); // { cvpId, key, hostname }
  const [adminOpen, setAdminOpen] = useState(false);
  const [chip, setChip] = useState('all');          // v2.640 ④ 필터 칩(화면 전용)
  const [faults, setFaults] = useState(null);       // v2.640 ③ 장애 이력 응답
  const [faultsErr, setFaultsErr] = useState(null);
  const [csvMsg, setCsvMsg] = useState(null);
  const loadSeq = useRef(0);
  // v2.641: 화면 전환(장비 · 포트 사용량 · 이벤트) — URL 에 싣는다(v2.613 도구 안 서브탭 규약).
  const [view, setView] = useHashTab({ base: ['tools', 'cvp'], valid: ['devices', 'ports', 'events'], fallback: 'devices' });

  const u = getCurrentUser();
  const isAdmin = !u || u.role === 'admin';
  const mayCollect = canCollect(u); // 서버가 admin·operator 만 받는다 — 누를 수 없는 버튼은 보이지 않게(WEB2611-11)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [main, devs, fl] = await Promise.allSettled([fetchJson('/tools/cvp'), fetchJson('/tools/cvp/devices'), fetchJson('/tools/cvp/faults')]);
      if (seq !== loadSeq.current) return; // 늦게 온 이전 응답은 버린다
      if (main.status === 'fulfilled') { setData(main.value); setError(null); } else setError(main.reason);
      if (devs.status === 'fulfilled') { setDevices(devs.value); setDevErr(null); } else setDevErr(devs.reason);
      if (fl.status === 'fulfilled') { setFaults(fl.value); setFaultsErr(null); } else setFaultsErr(fl.reason);
    } catch (e) {
      if (seq === loadSeq.current) setError(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const collectNow = async () => {
    setBusy(true); setMsg(null); setCollectErr(null);
    try { const r = await postJson('/tools/cvp/collect', {}); setMsg({ ok: true, text: collectSummary(r) }); await load(); }
    catch (e) {
      // 403 은 '오류' 가 아니라 정책이다 — ErrorBox 가 AccessDenied 로 바꾼다(v2.398). 그 밖의 실패만 빨간 배너.
      if (e && e.status === 403) setCollectErr(e);
      else setMsg({ ok: false, text: `수집 요청 실패: ${e.message || e}` });
    }
    finally { setBusy(false); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const servers = Array.isArray(data.servers) ? data.servers.filter((s) => s && typeof s === 'object') : [];
  const stopped = servers.filter((s) => isAuthStopped(s.status && s.status.authStopped));
  const foot = missingFootnotes(servers);
  const edges = Array.isArray(data.edges) ? data.edges.filter((e) => e && typeof e === 'object') : [];
  const poller = data.poller && typeof data.poller === 'object' ? data.poller : {};
  const devList = devices && Array.isArray(devices.devices) ? devices.devices : [];
  const scoped = cvpSel ? devList.filter((d) => String(d.cvpId) === cvpSel) : devList;
  const searched = filterDevices(scoped, q);
  const chips = chipCounts(searched); // 칩 개수는 '검색만 적용한 집합' 에서(v2.533 deviceFacets 규약 — 자기 칩으로 자기 개수를 줄이지 않는다)
  const shown = filterByChip(searched, chip);
  const downloadCsv = async () => {
    setCsvMsg(null);
    try { await downloadFile(devicesCsvPath(cvpSel, q)); }
    catch (e) { setCsvMsg(e); }
  };
  const nameOf = (id) => (servers.find((s) => String(s.id) === String(id)) || {}).name || id || '—';

  return (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      <div style={{ ...ROW, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>Arista CloudVision (CVP)</h3>
          <div style={NOTE}>
            CVP 에 등록된 스위치의 인벤토리·버전·장애 파트·포트·BGP 요약 — 수집 주기 {spanText(poller.intervalMs)}
            {poller.lastRun ? ` · 마지막 수집 ${agoText(typeof poller.lastRun === 'object' ? poller.lastRun.at : poller.lastRun)}` : ''}
          </div>
        </div>
        <div style={ROW}>
          <button type="button" className="btn" onClick={load}>새로고침</button>
          {mayCollect && (
            <button type="button" className="btn" onClick={collectNow} disabled={busy || poller.running}
              title={poller.running ? '수집이 진행 중입니다 — 끝난 뒤 다시 누르세요' : '중앙 직접 CVP 는 지금 수집하고, 엣지 위임 CVP 는 재수집을 요청합니다'}>
              {busy ? '요청 중…' : poller.running ? '수집 중…' : '지금 수집'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner">새로고침에 실패했습니다 — 아래는 직전 값입니다({String(error.message || error)}).</div>}
      {msg && <div className="banner" style={{ borderColor: msg.ok ? 'var(--green)' : 'var(--red)' }}><BoldText text={msg.text} /></div>}
      {collectErr && <ErrorBox error={collectErr} />}
      {listNotes(data).map((t, i) => <div key={`note-${i}`} className="banner"><BoldText text={t} /></div>)}
      {data.enabled === false && (
        <div className="banner">CVP 수집이 <b>꺼져 있습니다</b>. {isAdmin ? '아래 ‘등록·설정’ 에서 켜면 다음 주기부터 수집합니다.' : '관리자에게 설정을 요청하세요.'}</div>
      )}

      {addressHiddenNote(data) && <div className="banner">🔒 <BoldText text={addressHiddenNote(data)} /></div>}

      <div className="kpis">
        {[...kpiItems(data.totals), faultKpi(data.faults)].map((k) => (
          <Kpi key={k.key} label={k.label} value={k.value} accent={k.accent || undefined} meta={k.meta || undefined} />
        ))}
      </div>

      <div style={ROW}>
        {[['devices', '장비'], ['ports', '포트 사용량'], ['events', '이벤트']].map(([k, l]) => (
          <button key={k} type="button" className={`tab${view === k ? ' active' : ''}`} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>

      {view === 'ports' && <PortUsageCard servers={servers} onOpen={(p) => setDetailKey({ cvpId: p.cvpId, key: p.key, hostname: p.hostname, tab: 'ports' })} />}
      {view === 'events' && <EventsCard servers={servers} isAdmin={isAdmin} onOpen={(t) => setDetailKey(t)} />}

      {view === 'devices' && (<>
      <div className="card" style={{ minWidth: 0 }}>
        <b>CVP 서버 {servers.length}대</b>
        {stopped.map((s) => (
          <div key={`stop-${s.id}`} className="banner" style={{ marginTop: 8, borderColor: 'var(--red)' }}>
            <BoldText text={authStopText(s.status.authStopped, s.name || s.id)} />
          </div>
        ))}
        {servers.length === 0 ? (
          <div style={{ ...NOTE, marginTop: 8 }}>등록된 CVP 서버가 없습니다. {isAdmin ? '아래 ‘등록·설정’ 에서 추가하세요.' : ''}</div>
        ) : (
          <STable minWidth={760} style={{ marginTop: 8 }}>
            <thead><tr><th>이름</th><th>주소</th><th>수집 위치</th><th>인증</th><th>상태</th><th>장비</th><th>수집 시각</th><th>읽은 경로</th></tr></thead>
            <tbody>
              {servers.map((s) => {
                const st = s.status || {};
                const sv = serverState(s, { enabled: data.enabled !== false });
                const used = st.usedPaths && typeof st.usedPaths === 'object' ? Object.keys(st.usedPaths) : [];
                const miss = st.missing && typeof st.missing === 'object' ? Object.keys(st.missing) : [];
                return (
                  <tr key={s.id}>
                    <td><b>{s.name || s.id}</b></td>
                    <td style={{ fontSize: 12 }}>{hostText(s.host)}</td>
                    <td style={{ fontSize: 12 }}>{s.agent ? `엣지 ${s.agent}` : '중앙 직접'}</td>
                    <td style={{ fontSize: 12 }}>{s.authMode === 'password' ? 'ID/비밀번호' : '토큰'}</td>
                    <td><Badge tone={sv.tone} title={sv.detail}>{sv.label}</Badge>{sv.detail && (sv.tone === 'bad' || sv.tone === 'warn') && <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{sv.detail}</div>}</td>
                    <td className="right">{countText(st.deviceCount)}{isTruncated(st.truncated) ? ' (잘림)' : ''}</td>
                    <td style={{ fontSize: 12 }} data-sort={st.collectedAt || 0}>{agoText(st.collectedAt)}</td>
                    <td style={{ fontSize: 12 }} title={[serverMetaText(st), ...used.map((k) => `${itemLabel(k)}: ${st.usedPaths[k]}`)].filter(Boolean).join('\n')}>
                      {used.length ? `${used.length}개 항목` : '—'}{miss.length ? ` · 미확인 ${miss.length}` : ''}
                      {st.cvpVersion ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>CVP {st.cvpVersion}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        )}
        <div style={{ ...NOTE, marginTop: 8 }}><BoldText text={CANDIDATE_NOTE} /></div>
        {foot.length > 0 && (
          <div style={{ ...NOTE, marginTop: 4 }}>
            <b>확인하지 못한 경로</b>
            <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
              {foot.map((f) => (
                <li key={f.item}>{itemLabel(f.item)} — {f.servers.join(', ')}{f.reasons.length ? ` (${f.reasons.join(' / ')})` : ''}</li>
              ))}
            </ul>
          </div>
        )}
        {edges.length > 0 && (
          <div style={{ ...NOTE, marginTop: 8 }}>
            <b>엣지 보고</b>{' '}
            {edges.map((e) => {
              const v = edgeReportView(e); // v2.640 ①: devicesUnavailable(엣지 DB 불가)도 말한다
              return (
                <span key={e.agent} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                  {e.agent}: <Badge tone={v.tone} title={v.title}>{v.label}</Badge>
                  {' '}{agoText(e.lastPushAt)}{v.extras.length ? ` · ${v.extras.join(' · ')}` : ''}
                </span>
              );
            })}
          </div>
        )}
        {isAdmin && data.db && <div style={{ ...NOTE, marginTop: 6 }}>{dbStatsText(data.db)}</div>}
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={ROW}>
          {/* v2.612 WEB2612-07: 장비 목록을 아직 받지 못했거나 실패했으면 '0대' 가 아니라 '—'(읽지 못함) */}
          <b>{deviceCountLabel(devices, shown.length, devList.length)}</b>
          {servers.length > 1 && (
            <select className="input" value={cvpSel} onChange={(e) => setCvpSel(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">모든 CVP</option>
              {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
            </select>
          )}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 160 }} value={q} onChange={setQ}
            placeholder="호스트명·모델·시리얼·EOS" />
          {canCsv() && <button type="button" className="btn" onClick={downloadCsv} disabled={!devices} title={CSV_NOTE.replace(/\*\*/g, '')}>CSV 내보내기</button>}
        </div>
        {/* v2.640 ④: 필터 칩 — 개수는 검색만 적용한 집합에서 센다. 'unread' 는 못 읽은 장비(정상이 아니라 모름). */}
        <div style={{ ...ROW, marginTop: 8 }}>
          {DEVICE_CHIPS.map((c) => (
            <button key={c.key} type="button" className={`tab${chip === c.key ? ' active' : ''}`} onClick={() => setChip(c.key)}>
              {c.label} {countText(chips[c.key])}
            </button>
          ))}
        </div>
        {csvMsg && <div style={{ marginTop: 8 }}><ErrorBox error={csvMsg} /></div>}
        {devErr && !devices && <div style={{ marginTop: 8 }}><ErrorBox error={devErr} /></div>}
        {devices && numOrZero(devices.omitted) > 0 && (
          <div style={{ ...NOTE, marginTop: 6 }}>응답 상한으로 {countText(devices.omitted)}대를 빼고 받았습니다 — 검색으로 좁혀 보세요.</div>
        )}
        {devices && devList.length === 0 ? (
          <div style={{ ...NOTE, marginTop: 8 }}>아직 수집된 장비가 없습니다.</div>
        ) : devices ? (
          <STable minWidth={1040} limit={500} style={{ marginTop: 8 }}>
            <thead><tr><th>호스트명</th><th>모델</th><th>시리얼</th><th>관리 주소</th><th>EOS</th><th>스트리밍</th><th>파트</th><th>포트 up/전체</th><th>BGP</th><th>CPU</th><th>메모리</th><th>CVP</th><th>수집</th></tr></thead>
            <tbody>
              {shown.map((d) => {
                const inf = d.info && typeof d.info === 'object' ? d.info : {};
                const pc = partsCell(d.parts); const bc = bgpCell(d.bgp, { empty: inf.bgpEmpty === true }); const oc = portsCell(d.ports, { empty: inf.portsEmpty === true }); const sc = streamingText(d.streaming);
                const cc = sysCell(d.cpuPct); const mc = sysCell(d.memPct);
                return (
                  <tr key={`${d.cvpId}|${d.key}`} style={{ cursor: 'pointer' }} onClick={() => setDetailKey({ cvpId: d.cvpId, key: d.key, hostname: d.hostname })}>
                    <td><b style={{ textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>{d.hostname || d.key || '—'}</b></td>
                    <td style={{ fontSize: 12 }}>{d.model || '—'}</td>
                    <td style={{ fontSize: 12 }}>{d.serial || '—'}</td>
                    <td style={{ fontSize: 12 }}>{hostText(d.mgmtIp)}</td>
                    <td style={{ fontSize: 12 }}>{d.eosVersion || '—'}</td>
                    <td><Badge tone={sc.tone}>{sc.text}</Badge></td>
                    <td><Badge tone={pc.tone} title={pc.title}>{pc.text}</Badge></td>
                    <td><Badge tone={oc.tone} title={oc.title}>{oc.text}</Badge></td>
                    <td><Badge tone={bc.tone} title={bc.title}>{bc.text}</Badge></td>
                    <td data-sort={d.cpuPct ?? ''}><Badge tone={cc.tone} title={cc.title}>{cc.text}</Badge></td>
                    <td data-sort={d.memPct ?? ''}><Badge tone={mc.tone} title={mc.title}>{mc.text}</Badge></td>
                    <td style={{ fontSize: 12 }}>{nameOf(d.cvpId)}{d.agent ? ` · ${d.agent}` : ''}</td>
                    <td style={{ fontSize: 12 }} data-sort={d.collectedAt || 0}>{agoText(d.collectedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </STable>
        ) : <Loading />}
        {shown.length > 500 && <div style={{ ...NOTE, marginTop: 6 }}>표는 정렬 기준 상위 500대만 그립니다({countText(shown.length - 500)}대 생략) — 검색으로 좁혀 보세요.</div>}
      </div>

      <FaultsCard faults={faults} err={faultsErr} isAdmin={isAdmin} mayCollect={mayCollect} onChanged={load} />
      </>)}

      {isAdmin && (
        <div className="card" style={{ minWidth: 0 }}>
          <button type="button" className="btn" onClick={() => setAdminOpen((v) => !v)}>
            {adminOpen ? '▾' : '▸'} 등록·설정(관리자)
          </button>
          {adminOpen && <AdminPanel onChanged={load} />}
        </div>
      )}

      {detailKey && <DeviceModal target={detailKey} onClose={() => setDetailKey(null)} />}
    </div>
  );
}

function numOrZero(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// ── 장비 상세 ────────────────────────────────────────────────────────────────

function DeviceModal({ target, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [port, setPort] = useState(null);
  const [tab, setTab] = useState(target.tab || 'overview'); // v2.641: 개요가 첫 탭(포트 사용량 화면에서 열면 포트 탭)
  useEffect(() => {
    let active = true;
    setD(null); setErr(null);
    fetchJson('/tools/cvp/device', { cvpId: target.cvpId, key: target.key })
      .then((r) => { if (active) setD(r); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [target.cvpId, target.key]);

  const dev = d && d.device && typeof d.device === 'object' ? d.device : {};
  const parts = d && Array.isArray(d.parts) ? d.parts : null;
  const ports = d && Array.isArray(d.ports) ? d.ports : null;
  const bgp = d && d.bgp && Array.isArray(d.bgp.peers) ? d.bgp.peers : null;
  const pc = partCounts(parts);

  return (
    <Modal title={`${target.hostname || target.key} — 장비 상세`} onClose={onClose} width={1000}>
      {err && <ErrorBox error={err} />}
      {!d && !err && <Loading />}
      {d && (
        <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
          <div style={{ ...NOTE, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
            <span>모델 {dev.model || '—'}</span><span>시리얼 {dev.serial || '—'}</span>
            <span>EOS {dev.eosVersion || '—'}</span><span>관리 주소 {hostText(dev.mgmtIp)}</span>
            <span>수집 {agoText(dev.collectedAt)}</span>
            {telemetryText(dev.telemetry) && <span>{telemetryText(dev.telemetry)}</span>}
          </div>
          <div style={ROW}>
            {[['overview', '개요'], ['parts', `장애 파트${parts ? ` (${parts.length})` : ''}`], ['ports', `포트${ports ? ` (${ports.length})` : ''}`],
              ['bgp', `BGP 피어${bgp ? ` (${bgp.length})` : ''}`], ['paths', '읽은 경로']].map(([k, l]) => (
              <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === 'overview' && <OverviewView target={target} dev={dev} addressHidden={!!d.addressHidden} />}

          {tab === 'parts' && partsMissingText(d.partsMissingKinds) && (
            <div style={NOTE}><BoldText text={partsMissingText(d.partsMissingKinds)} /></div>
          )}
          {tab === 'parts' && (parts == null ? (
            <div style={NOTE}>파트 상태를 읽지 못했습니다 — <b>정상이라는 뜻이 아닙니다</b>. ‘읽은 경로’ 탭에서 사유를 보세요.</div>
          ) : (
            <>
              <div style={NOTE}>
                정상 {pc.ok} · 주의 {pc.warn} · 장애 {pc.fault} · 상태 미확인 {pc.unknown} · 빈 슬롯 {pc.absent}
                {' '}— 미확인·빈 슬롯은 정상에도 장애에도 넣지 않습니다.
              </div>
              {parts.length === 0 ? <div style={NOTE}>보고된 부품이 없습니다.</div> : (
                <STable minWidth={560}>
                  <thead><tr><th>종류</th><th>이름</th><th>상태</th><th>상세</th></tr></thead>
                  <tbody>
                    {parts.filter((p) => p && typeof p === 'object').map((p, i) => {
                      const ps = partState(p.state);
                      return (
                        <tr key={`${p.kind}|${p.name}|${i}`}>
                          <td>{p.kind || '—'}</td><td>{p.name || '—'}</td>
                          <td><Badge tone={ps.tone}>{ps.label}</Badge></td>
                          <td style={{ fontSize: 12, whiteSpace: 'normal' }}>{p.detail || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              )}
            </>
          ))}

          {tab === 'ports' && (ports == null ? (
            <div style={NOTE}>포트 구성을 읽지 못했습니다{dev.info && dev.info.portsEmpty ? ' — 포트 경로가 빈 응답을 돌려줬습니다(포트 0개라는 뜻이 아닙니다). ‘읽은 경로’ 탭의 경로 탐색 표본을 보세요' : ''}.</div>
          ) : (
            <>
              {port && <PortChart target={target} port={port} onClose={() => setPort(null)} />}
              <div style={NOTE}>포트 이름을 누르면 사용률 추이를 봅니다. 사용률은 인터페이스 속도를 알 때만 방향별로 계산합니다.</div>
              <STable minWidth={980} limit={1024}>
                <thead><tr><th>포트</th><th>설명</th><th>속도</th><th>상태</th><th>관리</th><th>VLAN</th><th>LAG</th><th>수신</th><th>송신</th><th>수신 %</th><th>송신 %</th><th>오류(수/송)</th></tr></thead>
                <tbody>
                  {ports.filter((p) => p && typeof p === 'object').map((p) => (
                    <tr key={p.name}>
                      <td><button type="button" className="btn" style={{ padding: '2px 8px' }} onClick={() => setPort(p.name)}>{p.name}</button></td>
                      <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.desc || ''}>{p.desc || '—'}</td>
                      <td data-sort={p.speedBps ?? ''}>{bpsText(p.speedBps)}</td>
                      <td><Badge tone={p.oper === 'up' ? 'ok' : p.oper === 'nolink' ? 'muted' : p.oper ? (p.admin === 'down' ? 'muted' : 'warn') : 'muted'}>{p.oper === 'nolink' ? '미연결' : (p.oper || '—')}</Badge></td>
                      <td>{p.admin || '—'}</td>
                      <td>{p.vlan == null || p.vlan === '' ? '—' : p.vlan}</td>
                      <td>{p.lag || '—'}</td>
                      <td data-sort={p.inBps ?? ''}>{bpsText(p.inBps)}</td>
                      <td data-sort={p.outBps ?? ''}>{bpsText(p.outBps)}</td>
                      <td data-sort={p.inUtil ?? ''}>{pctText(p.inUtil)}</td>
                      <td data-sort={p.outUtil ?? ''}>{pctText(p.outUtil)}</td>
                      <td>{countText(p.inErr)} / {countText(p.outErr)}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </>
          ))}

          {tab === 'bgp' && (bgp == null ? (
            <div style={NOTE}>{dev.info && dev.info.bgpEmpty ? 'BGP 경로가 빈 응답을 돌려줬습니다 — BGP 를 쓰지 않는 장비이거나 이 CVP 에서 경로가 다릅니다(피어 0개라는 뜻이 아닙니다).' : 'BGP 상태를 읽지 못했거나 BGP 를 쓰지 않는 장비입니다.'} 전체 라우팅 테이블은 수집하지 않습니다(피어 요약만).</div>
          ) : bgp.length === 0 ? <div style={NOTE}>설정된 BGP 피어가 없습니다.</div> : (
            <STable minWidth={560}>
              <thead><tr><th>피어</th><th>AS</th><th>VRF</th><th>상태</th><th>받은 prefix</th></tr></thead>
              <tbody>
                {bgp.filter((p) => p && typeof p === 'object').map((p, i) => (
                  <tr key={`${p.vrf}|${p.peer}|${i}`}>
                    <td>{hostText(p.peer)}</td><td>{p.asn ?? '—'}</td><td>{p.vrf || '—'}</td>
                    <td><Badge tone={/^established$/i.test(String(p.state || '')) ? 'ok' : p.state ? 'bad' : 'muted'}>{p.state || '—'}</Badge></td>
                    <td className="right">{countText(p.prefixes)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          ))}

          {tab === 'paths' && <PathsView d={d} />}
        </div>
      )}
    </Modal>
  );
}

function PathsView({ d }) {
  const used = d.usedPaths && typeof d.usedPaths === 'object' ? d.usedPaths : {};
  const miss = d.missing && typeof d.missing === 'object' ? d.missing : {};
  const seen = d.seenFields && typeof d.seenFields === 'object' ? d.seenFields : {};
  const items = [...new Set([...Object.keys(used), ...Object.keys(miss), ...Object.keys(seen)])];
  const samples = sampleRows(d.samples); // v2.640 ②: admin 만 받는다(비-admin 은 samplesHidden)
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={NOTE}><BoldText text={CANDIDATE_NOTE} /></div>
      {samples.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}><b>원문 표본 {samples.length}종</b> (관리자)</summary>
          <div style={{ ...NOTE, marginTop: 4 }}><BoldText text={SAMPLE_NOTE} /></div>
          {samples.map((r) => (
            <details key={r.kind} style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12 }}>
                <Badge tone={sampleBadge(r).tone}>{sampleBadge(r).label}</Badge>
                {' '}{r.label} — <span style={{ wordBreak: 'break-all' }}>{r.path || '—'}</span>{r.bytes != null ? ` · ${countText(r.bytes)}B` : ''}{r.at ? ` · ${agoText(r.at)}` : ''}{r.reason ? ` · ${r.reason}` : ''}
              </summary>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflow: 'auto', margin: '4px 0 0', padding: 8, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6 }}>{r.head || '(본문 없음)'}</pre>
            </details>
          ))}
        </details>
      )}
      {probeRows(d.probes).length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}><b>경로 탐색 표본 {probeRows(d.probes).length}곳</b> (관리자)</summary>
          <div style={{ ...NOTE, marginTop: 4 }}><BoldText text={PROBE_NOTE} /></div>
          <STable minWidth={640}>
            <thead><tr><th>경로</th><th>결과</th><th>크기</th><th>응답 앞부분</th></tr></thead>
            <tbody>
              {probeRows(d.probes).map((p, i) => (
                <tr key={`${p.path}|${i}`}>
                  <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{p.path}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'normal' }}><Badge tone={p.ok ? (p.shape.startsWith('빈 응답') ? 'warn' : 'ok') : 'bad'}>{p.shape}</Badge></td>
                  <td className="right" style={{ fontSize: 12 }}>{p.bytes == null ? '—' : `${countText(p.bytes)}B`}</td>
                  <td><details><summary style={{ cursor: 'pointer', fontSize: 11 }}>보기</summary>
                    <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto', margin: '4px 0 0' }}>{p.head || '(본문 없음)'}</pre></details></td>
                </tr>
              ))}
            </tbody>
          </STable>
        </details>
      )}
      {d.samplesHidden && <div style={NOTE}>원문 표본·경로 탐색 표본은 관리자에게만 표시됩니다.</div>}
      {items.length === 0 ? <div style={NOTE}>경로 기록이 없습니다.</div> : (
        <STable minWidth={640}>
          <thead><tr><th>항목</th><th>읽은 경로</th><th>읽지 못한 이유</th><th>응답에 있던 필드</th></tr></thead>
          <tbody>
            {items.map((k) => (
              <tr key={k}>
                <td>{itemLabel(k)}</td>
                <td style={{ fontSize: 12, wordBreak: 'break-all' }}>{used[k] || '—'}</td>
                <td style={{ fontSize: 12, whiteSpace: 'normal' }}>{typeof miss[k] === 'string' ? miss[k] : miss[k] ? JSON.stringify(miss[k]) : '—'}</td>
                <td style={{ fontSize: 11, whiteSpace: 'normal', wordBreak: 'break-word' }}>{Array.isArray(seen[k]) ? seen[k].join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      )}
    </div>
  );
}

// ── v2.641 ② 장비 개요 + ③ CPU·메모리 추이 ───────────────────────────────────
function OverviewView({ target, dev, addressHidden }) {
  const [hours, setHours] = useState(24);
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    setR(null); setErr(null);
    fetchJson('/tools/cvp/device-series', { cvpId: target.cvpId, key: target.key, hours })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [target.cvpId, target.key, hours]);
  const rows = overviewRows({ ...dev, addressHidden });
  const cc = sysCell(dev.cpuPct); const mc = sysCell(dev.memPct);
  const pts = r && Array.isArray(r.points) ? r.points : [];
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={ROW}>
        <span style={NOTE}>CPU</span><Badge tone={cc.tone} title={cc.title}>{cc.text}</Badge>
        <span style={NOTE}>메모리</span><Badge tone={mc.tone} title={mc.title}>{mc.text}</Badge>
        <span style={NOTE}>{dev.sysAt ? `측정 ${agoText(dev.sysAt)}` : 'CPU·메모리를 읽지 못했습니다(0% 라는 뜻이 아닙니다)'}</span>
      </div>
      <div className="card" style={{ minWidth: 0 }}>
        <div style={{ ...ROW, justifyContent: 'space-between' }}>
          <b>CPU·메모리 추이</b>
          <div style={ROW}>{HOURS.slice(0, 2).map(([h, l]) => <button key={h} type="button" className={`tab${hours === h ? ' active' : ''}`} onClick={() => setHours(h)}>{l}</button>)}</div>
        </div>
        {err && <ErrorBox error={err} />}
        {!r && !err && <Loading />}
        {r && (pts.length < 2 ? (
          <div style={{ ...NOTE, marginTop: 6 }}>{pts.length === 0 ? '이 기간에 CPU·메모리 표본이 없습니다.' : '표본이 1개뿐이라 선을 그리지 않습니다(한 점을 선으로 만들면 추세가 있는 것처럼 보입니다).'} 원시 표본은 {countText(r.rawRetentionDays)}일 보관합니다.</div>
        ) : <SysChart points={pts} intervalMs={r.intervalMs} />)}
        {r && r.truncated && <div style={{ ...NOTE, marginTop: 4 }}>표본 상한({countText(r.limit)})으로 최근 것만 그렸습니다.</div>}
      </div>
      <STable minWidth={560}>
        <thead><tr><th data-nosort>항목</th><th data-nosort>값</th><th data-nosort>비고</th></tr></thead>
        <tbody>
          {rows.map(([l, v, n]) => (
            <tr key={l}><td style={{ fontSize: 12 }}>{l}</td><td>{v}</td><td style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{n || ''}</td></tr>
          ))}
        </tbody>
      </STable>
    </div>
  );
}

/** CPU·메모리 추이 — y축 0~100 고정(v2.551 — 데이터 범위에 맞추면 잔물결이 '거의 100%' 처럼 보인다). 수집이 끊긴 구간은 잇지 않는다. */
function SysChart({ points, intervalMs }) {
  const W = 640; const H = 160; const PAD = 30;
  const geo = (key) => seriesGeometry(points.map((p) => ({ ts: p.ts, v: p[key] })), 'v', { width: W, height: H, pad: PAD, intervalMs: intervalMs || 300_000 });
  const c = geo('cpu'); const m = geo('mem');
  return (
    <div style={{ overflowX: 'auto', marginTop: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 320, maxWidth: W, display: 'block' }} role="img" aria-label="CPU·메모리 사용률 추이">
        {[0, 50, SYS_HIGH_PCT, 100].map((y) => {
          const yy = H - PAD - ((H - 2 * PAD) * y) / 100;
          return <g key={y}><line x1={PAD} x2={W - 8} y1={yy} y2={yy} stroke="var(--border)" strokeDasharray={y === SYS_HIGH_PCT ? '4 3' : undefined} /><text x={PAD - 4} y={yy + 3} fontSize="9" textAnchor="end" fill="var(--text-dim)">{y}%</text></g>;
        })}
        {c.paths.map((d, i) => <path key={`c${i}`} d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" />)}
        {c.dots.map((p, i) => <circle key={`cd${i}`} cx={p.x} cy={p.y} r="2" fill="var(--accent)" />)}
        {m.paths.map((d, i) => <path key={`m${i}`} d={d} fill="none" stroke="var(--amber)" strokeWidth="1.5" />)}
        {m.dots.map((p, i) => <circle key={`md${i}`} cx={p.x} cy={p.y} r="2" fill="var(--amber)" />)}
      </svg>
      <div style={{ ...NOTE, display: 'flex', gap: 12 }}>
        <span><span style={{ color: 'var(--accent)' }}>━</span> CPU</span><span><span style={{ color: 'var(--amber)' }}>━</span> 메모리</span>
        <span>점선 = {SYS_HIGH_PCT}%</span>
      </div>
    </div>
  );
}

// ── v2.641 ⑤ 포트 사용량 ──────────────────────────────────────────────────────
function PortUsageCard({ servers, onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [minUtil, setMinUtil] = useState(0);
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson('/tools/cvp/port-usage', { ...(cvpId ? { cvpId } : {}), minUtil, limit: 500 })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) { setErr(e); setR(null); } });
    return () => { active = false; };
  }, [cvpId, minUtil, reload]);
  const ports = r && Array.isArray(r.ports) ? r.ports.filter((p) => p && typeof p === 'object') : [];
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={ROW}>
        <b>포트 사용량</b>
        {servers.length > 1 && (
          <select className="input" value={cvpId} onChange={(e) => setCvpId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">모든 CVP</option>
            {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
          </select>
        )}
        {[[0, '전체'], [50, '50% 이상'], [80, '80% 이상']].map(([v, l]) => (
          <button key={v} type="button" className={`tab${minUtil === v ? ' active' : ''}`} onClick={() => setMinUtil(v)}>{l}</button>
        ))}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
      </div>
      <div style={{ ...NOTE, marginTop: 6 }}><BoldText text={PORT_USAGE_NOTE} /></div>
      {err && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      {!r && !err && <Loading />}
      {r && (
        <>
          <div className="kpis" style={{ marginTop: 8 }}>
            {portUsageKpis(r.counts, { staleMs: r.staleMs }).map((k) => <Kpi key={k.key} label={k.label} value={k.value} accent={k.accent || undefined} meta={k.meta || undefined} />)}
          </div>
          {ports.length === 0 ? (
            <div style={{ ...NOTE, marginTop: 8 }}>{minUtil > 0 ? `사용률 ${minUtil}% 이상인 포트가 없습니다(사용률을 계산한 포트 기준).` : '사용률을 계산한 포트가 아직 없습니다 — 처리량은 두 번째 수집 주기부터 나오고, 포트 카운터를 읽지 못하면 계산하지 않습니다.'}</div>
          ) : (
            <STable minWidth={900} style={{ marginTop: 8 }}>
              <thead><tr><th>장비</th><th>포트</th><th>설명</th><th>속도</th><th>사용률(최대)</th><th>수신</th><th>송신</th><th>오류(수/송)</th><th>CVP</th><th>측정</th></tr></thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={`${p.agent}|${p.cvpId}|${p.key}|${p.port}`}>
                    <td><button type="button" className="btn" style={{ padding: '2px 8px' }} onClick={() => onOpen(p)}>{p.hostname || p.key}</button></td>
                    <td style={{ fontSize: 12 }}>{p.port}</td>
                    <td style={{ fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.desc || ''}>{p.desc || '—'}</td>
                    <td data-sort={p.speedBps ?? ''}>{bpsText(p.speedBps)}</td>
                    <td data-sort={p.util ?? ''}><Badge tone={utilTone(p.util)}>{pctText(p.util)}</Badge></td>
                    <td data-sort={p.inBps ?? ''} style={{ fontSize: 12 }}>{rateText(p.inBps, p.inUtil)}</td>
                    <td data-sort={p.outBps ?? ''} style={{ fontSize: 12 }}>{rateText(p.outBps, p.outUtil)}</td>
                    <td style={{ fontSize: 12 }}>{countText(p.inErr)} / {countText(p.outErr)}</td>
                    <td style={{ fontSize: 12 }}>{p.cvpName || p.cvpId}</td>
                    <td style={{ fontSize: 12 }} data-sort={p.rateAt || 0}>{agoText(p.rateAt)}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          {numOrZero(r.omitted) > 0 && <div style={{ ...NOTE, marginTop: 6 }}>상위 {countText(r.limit)}개만 받았습니다({countText(r.omitted)}개 생략) — 사용률 조건으로 좁혀 보세요.</div>}
        </>
      )}
    </div>
  );
}

// ── v2.641 ④ 이벤트 ──────────────────────────────────────────────────────────
function EventsCard({ servers, isAdmin, onOpen }) {
  const [cvpId, setCvpId] = useState('');
  const [sev, setSev] = useState('');
  const [hours, setHours] = useState(24);
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setErr(null);
    fetchJson('/tools/cvp/events', { ...(cvpId ? { cvpId } : {}), ...(sev ? { severity: sev } : {}), hours, limit: 500 })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) { setErr(e); setR(null); } });
    return () => { active = false; };
  }, [cvpId, sev, hours, reload]);
  const events = r && Array.isArray(r.events) ? r.events.filter((e) => e && typeof e === 'object') : [];
  const notes = r ? eventReadNotes(r.readState) : [];
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={ROW}>
        <b>CVP 이벤트</b>
        {servers.length > 1 && (
          <select className="input" value={cvpId} onChange={(e) => setCvpId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">모든 CVP</option>
            {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
          </select>
        )}
        {[[24, '1일'], [168, '7일'], [720, '30일']].map(([h, l]) => (
          <button key={h} type="button" className={`tab${hours === h ? ' active' : ''}`} onClick={() => setHours(h)}>{l}</button>
        ))}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={() => setReload((x) => x + 1)}>새로고침</button>
      </div>
      {err && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      {!r && !err && <Loading />}
      {r && (
        <>
          {notes.map((t, i) => <div key={`en-${i}`} className="banner" style={{ marginTop: 8 }}><BoldText text={t} /></div>)}
          <div style={{ ...ROW, marginTop: 8 }}>
            <button type="button" className={`tab${!sev ? ' active' : ''}`} onClick={() => setSev('')}>전체</button>
            {EVENT_SEVERITIES.map(([k, l]) => {
              const c = severityCounts(r.counts).find((x) => x.key === k);
              if (!c && sev !== k) return null;
              return <button key={k} type="button" className={`tab${sev === k ? ' active' : ''}`} onClick={() => setSev(k)}>{l} {countText(c ? c.count : 0)}</button>;
            })}
          </div>
          {events.length === 0 ? (
            <div style={{ ...NOTE, marginTop: 8 }}>이 기간에 받은 이벤트가 없습니다{notes.length ? ' — 위 안내처럼 이벤트를 읽지 못한 CVP 가 있으면 0건은 확인된 값이 아닙니다' : ''}.</div>
          ) : (
            <STable minWidth={820} style={{ marginTop: 8 }}>
              <thead><tr><th>발생</th><th>심각도</th><th>제목</th><th>설명</th><th>장비</th><th>CVP</th><th>확인</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={`${e.agent}|${e.cvpId}|${e.key}|${e.ts}`}>
                    <td style={{ fontSize: 12 }} data-sort={e.ts || 0}>{agoText(e.ts)}</td>
                    <td><Badge tone={severityTone(e.severity)}>{severityLabel(e.severity)}</Badge></td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal' }}>{e.title || '—'}</td>
                    <td style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 320 }}>{e.desc || '—'}</td>
                    <td style={{ fontSize: 12 }} data-sort={eventDeviceSort(e)}><EventDevices e={e} onOpen={onOpen} /></td>
                    <td style={{ fontSize: 12 }}>{e.cvpName || e.cvpId}</td>
                    <td style={{ fontSize: 12 }}>{e.ack === true ? '확인됨' : e.ack === false ? '미확인' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          )}
          {r.truncated && <div style={{ ...NOTE, marginTop: 6 }}>최근 {countText(r.limit)}건만 받았습니다 — 심각도·기간으로 좁혀 보세요.</div>}
          <div style={{ ...NOTE, marginTop: 6 }}>
            이벤트는 CVP 가 보고한 것을 그대로 옮깁니다(보관 {countText(r.retentionDays)}일). 진행 중·종료 여부는 CVP 응답에 종료 시각이 없어 판정하지 않습니다.
            {!isAdmin && r.addressHidden ? ' 제목·설명의 주소는 가렸습니다.' : ''}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * v2.643: 이벤트의 장비 칸 — 시리얼 대신 호스트명을 보이고, 누르면 장비 상세를 연다(사용자 요청).
 *   서버가 장비 색인에서 찾지 못한 식별자는 원문 그대로 둔다(호스트명을 지어내지 않는다 · 클릭 불가).
 */
function EventDevices({ e, onOpen }) {
  const refs = eventDeviceRefs(e);
  if (!refs.length) return '—';
  const shown = refs.slice(0, 2);
  return (
    <span>
      {shown.map((d, i) => (
        <span key={`${d.id}-${i}`}>
          {i > 0 ? ', ' : ''}
          {d.key && onOpen ? (
            <span role="button" tabIndex={0} title={`시리얼 ${d.id} — 누르면 장비 상세`}
              style={{ cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3, color: 'inherit' }}
              onClick={() => onOpen({ cvpId: e.cvpId, key: d.key, hostname: d.hostname })}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen({ cvpId: e.cvpId, key: d.key, hostname: d.hostname }); } }}>
              {d.label}
            </span>
          ) : <span title={d.key ? undefined : '장비 목록에서 이 식별자를 찾지 못했습니다'}>{d.label}</span>}
        </span>
      ))}
      {refs.length > 2 ? ` 외 ${refs.length - 2}` : ''}
    </span>
  );
}

// ── 포트 추이 차트(간단 SVG, y축 0~100 고정) ─────────────────────────────────

const HOURS = [[24, '24시간'], [168, '7일'], [720, '30일']];

function PortChart({ target, port, onClose }) {
  const [hours, setHours] = useState(24);
  const [mode, setMode] = useState('util'); // v2.640 ④: 사용률(0~100 고정) / 처리량(데이터 최대에 맞춤 + 단위)
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let active = true;
    setR(null); setErr(null);
    fetchJson('/tools/cvp/port-series', { cvpId: target.cvpId, key: target.key, port, hours })
      .then((x) => { if (active) setR(x); }).catch((e) => { if (active) setErr(e); });
    return () => { active = false; };
  }, [target.cvpId, target.key, port, hours]);
  const W = 640; const H = 180; const PAD = 30;
  // 처리량 눈금('50.0 Kbps')은 '50%' 보다 넓어 PAD 안에 들어가지 않는다 — viewBox 를 왼쪽으로 늘려 라벨이 잘리지 않게 한다
  // (v2.640 Chromium 판독에서 'Kbps' 만 보이고 숫자가 잘려 있었다. 기하(pad)는 그대로 — 선·점 좌표는 바뀌지 않는다).
  const XL = mode === 'bps' ? 34 : 0;
  const pts = r && Array.isArray(r.points) ? r.points : [];
  const opt = { width: W, height: H, pad: PAD, intervalMs: r && r.intervalMs };
  const gin = seriesGeometry(pts, 'inUtil', opt);
  const gout = seriesGeometry(pts, 'outUtil', opt);
  const gb = seriesGeometryBps(pts, ['inBps', 'outBps'], opt);
  const empty = mode === 'bps' ? gb.count === 0 : (gin.count === 0 && gout.count === 0);
  const cut = chartCutNote(r);
  const ticks = mode === 'bps' ? gb.ticks : [0, 50, 100].map((v) => ({ v, y: PAD + (H - PAD * 2) - (v / 100) * (H - PAD * 2), label: `${v}%` }));
  const inPaths = mode === 'bps' ? gb.paths.inBps : gin.paths; const inDots = mode === 'bps' ? gb.dots.inBps : gin.dots;
  const outPaths = mode === 'bps' ? gb.paths.outBps : gout.paths; const outDots = mode === 'bps' ? gb.dots.outBps : gout.dots;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={ROW}>
        <b>{port} {mode === 'bps' ? '처리량' : '사용률'} 추이</b>
        {HOURS.map(([h, l]) => (
          <button key={h} type="button" className={`tab${hours === h ? ' active' : ''}`} onClick={() => setHours(h)}>{l}</button>
        ))}
        <span style={{ width: 8 }} />
        {CHART_MODES.map(([m, l]) => (
          <button key={m} type="button" className={`tab${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>{l}</button>
        ))}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (empty ? (
        <div style={{ ...NOTE, marginTop: 6 }}>
          {mode === 'bps'
            ? '이 기간에 처리량 표본이 없습니다 — 첫 수집(누적 카운터라 두 번째 주기부터 값이 나옵니다)이거나 카운터를 읽지 못한 포트일 수 있습니다.'
            : '이 기간에 사용률 표본이 없습니다 — 첫 수집(누적 카운터라 두 번째 주기부터 값이 나옵니다)이거나 인터페이스 속도를 모르는 포트일 수 있습니다(처리량 보기는 속도 없이도 그립니다).'}
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <svg viewBox={`${-XL} 0 ${W + XL} ${H}`} style={{ width: '100%', minWidth: 320, maxWidth: W + XL, display: 'block' }} role="img" aria-label={`${port} ${mode === 'bps' ? '처리량' : '사용률'} 추이`}>
              {ticks.map((t) => (
                <g key={t.v}>
                  <line x1={PAD} x2={W - PAD} y1={t.y} y2={t.y} stroke="var(--border)" strokeWidth="1" />
                  <text x={PAD - 4} y={t.y + 4} fontSize="10" textAnchor="end" fill="var(--text-dim)">{t.label}</text>
                </g>
              ))}
              {inPaths.map((p, i) => <path key={`i${i}`} d={p} fill="none" stroke="var(--accent)" strokeWidth="1.5" />)}
              {inDots.map((p, i) => <circle key={`id${i}`} cx={p.x} cy={p.y} r="2.5" fill="var(--accent)" />)}
              {outPaths.map((p, i) => <path key={`o${i}`} d={p} fill="none" stroke="var(--amber)" strokeWidth="1.5" />)}
              {outDots.map((p, i) => <circle key={`od${i}`} cx={p.x} cy={p.y} r="2.5" fill="var(--amber)" />)}
            </svg>
          </div>
          <div style={{ ...NOTE, marginTop: 4 }}>
            <span style={{ color: 'var(--accent)' }}>━ 수신</span> · <span style={{ color: 'var(--amber)' }}>━ 송신</span>
            {' '}· {mode === 'bps' ? `y축 상한 ${bpsText(gb.axisMax)}(데이터 최대에 맞춤)` : 'y축은 0~100% 고정'} · 수집이 없던 구간은 선을 잇지 않습니다 · {seriesSourceNote(r)}
            {cut ? ` · ${cut}` : ''}
          </div>
        </>
      ))}
    </div>
  );
}

// ── v2.640 ③ 장애 이력 카드 ──────────────────────────────────────────────────

function FaultsCard({ faults, err, isAdmin, mayCollect, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [closeTarget, setCloseTarget] = useState(null);
  const [closeReason, setCloseReason] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const f = faults && typeof faults === 'object' ? faults : null;
  const open = f && Array.isArray(f.open) ? f.open.filter((x) => x && typeof x === 'object') : [];
  const events = f && Array.isArray(f.events) ? f.events.filter((x) => x && typeof x === 'object') : [];
  const scanNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson('/tools/cvp/faults/scan', {}); setMsg({ ok: true, text: `판정했습니다 — ${faultScanNote(r && r.result, f && f.settings)}` }); onChanged && onChanged(); }
    catch (e) { setMsg({ ok: false, text: `판정 실패: ${e.message || e}` }); }
    finally { setBusy(false); }
  };
  const doClose = async () => {
    if (!closeTarget) return;
    setBusy(true); setMsg(null);
    try {
      const r = await postJson('/tools/cvp/faults/close', { agent: closeTarget.agent || '', cvpId: closeTarget.cvpId, deviceKey: closeTarget.deviceKey, faultKey: closeTarget.faultKey, reason: closeReason });
      if (r && r.ok === false) setMsg({ ok: false, text: `닫지 못했습니다: ${r.reason || ''}` });
      else { setMsg({ ok: true, text: '수동으로 닫았습니다(이력에 남습니다).' }); setCloseTarget(null); setCloseReason(''); onChanged && onChanged(); }
    } catch (e) { setMsg({ ok: false, text: `닫지 못했습니다: ${e.message || e}` }); }
    finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={ROW}>
        <b>장애 이력(전이) {f ? `— 열림 ${countText(open.length)}` : ''}</b>
        {mayCollect && <button type="button" className="btn" onClick={scanNow} disabled={busy} title="중앙이 가진 최신값만 다시 판정합니다 — 장비·엣지 왕복 없음">{busy ? '판정 중…' : '지금 판정'}</button>}
        <button type="button" className="btn" onClick={() => setShowEvents((v) => !v)}>{showEvents ? '이력 숨기기' : `최근 이력 ${countText(events.length)}건`}</button>
      </div>
      <div style={{ ...NOTE, marginTop: 6 }}><BoldText text={FAULT_INTRO} /></div>
      {err && !f && <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>}
      {msg && <div className="banner" style={{ marginTop: 8, borderColor: msg.ok ? 'var(--green)' : 'var(--red)' }}><BoldText text={msg.text} /></div>}
      {f && <div style={{ ...NOTE, marginTop: 6 }}>{faultScanNote(f.scan, f.settings)}{f.unavailable ? ' · 장애 DB 를 읽지 못했습니다(아래는 비어 있어도 ‘장애 0’ 이 아닙니다)' : ''}</div>}
      {f && !f.unavailable && open.length === 0 && <div style={{ ...NOTE, marginTop: 8 }}>열린 장애가 없습니다{f.scan && f.scan.at ? '' : ' — 아직 판정하지 않았으므로 ‘없다’ 가 아니라 ‘모른다’ 입니다'}.</div>}
      {open.length > 0 && (
        <STable minWidth={860} limit={500} style={{ marginTop: 8 }}>
          <thead><tr><th>종류</th><th>장비</th><th>파트·포트·피어</th><th>상태</th><th>상세</th><th>처음 관측</th><th>마지막 관측</th><th>보류</th>{isAdmin && <th data-nosort>작업</th>}</tr></thead>
          <tbody>
            {open.map((x) => {
              const v = faultRowView(x);
              return (
                <tr key={`${x.agent}|${x.cvpId}|${x.deviceKey}|${x.faultKey}`}>
                  <td>{v.kindLabel}</td>
                  <td><b>{v.device}</b><div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{v.where}</div></td>
                  <td style={{ fontSize: 12 }}>{x.label || '—'}</td>
                  <td><Badge tone={v.state.tone}>{v.state.label}</Badge>{v.notified ? <span style={{ fontSize: 11, color: 'var(--text-dim)' }}> · 알림됨</span> : null}</td>
                  <td style={{ fontSize: 12, whiteSpace: 'normal' }}>{x.detail || '—'}</td>
                  <td style={{ fontSize: 12 }} data-sort={v.since || ''}>{agoText(v.since)}</td>
                  <td style={{ fontSize: 12 }} data-sort={v.lastSeen || ''}>{agoText(v.lastSeen)}</td>
                  <td style={{ fontSize: 11, whiteSpace: 'normal', color: v.hold ? 'var(--amber)' : 'var(--text-dim)' }}>{v.hold || '—'}</td>
                  {isAdmin && <td><button type="button" className="btn" style={{ padding: '2px 8px' }} onClick={() => { setCloseTarget(x); setCloseReason(''); }}>닫기</button></td>}
                </tr>
              );
            })}
          </tbody>
        </STable>
      )}
      {closeTarget && (
        <div className="card" style={{ marginTop: 8, display: 'grid', gap: 6 }}>
          <b>수동 닫기 — {closeTarget.deviceName || closeTarget.deviceKey} · {faultKindLabel(closeTarget.kind)} {closeTarget.label}</b>
          <div style={NOTE}>수동 닫기는 ‘고쳐졌다’ 는 판정이 아니라 관리자의 결정입니다(감사 로그에 남습니다). 다시 관측되면 새 장애로 열립니다.</div>
          <input className="input" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="사유(필수) — 예: 장비 철거, 포트 용도 변경" />
          <div style={ROW}>
            <button type="button" className="btn" onClick={doClose} disabled={busy || !closeReason.trim()}>닫기 확정</button>
            <button type="button" className="btn" onClick={() => setCloseTarget(null)}>취소</button>
          </div>
        </div>
      )}
      {showEvents && (events.length === 0 ? <div style={{ ...NOTE, marginTop: 8 }}>최근 {f && f.days ? f.days : 30}일 이력이 없습니다.</div> : (
        <STable minWidth={760} limit={500} style={{ marginTop: 8 }}>
          <thead><tr><th>시각</th><th>종류</th><th>장비</th><th>파트·포트·피어</th><th>사건</th><th>상세</th></tr></thead>
          <tbody>
            {events.map((x) => (
              <tr key={x.id ?? `${x.at}|${x.faultKey}`}>
                <td style={{ fontSize: 12 }} data-sort={x.at || ''}>{agoText(x.at)}</td>
                <td>{faultKindLabel(x.kind)}</td>
                <td>{x.deviceName || x.deviceKey || '—'}<div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{x.cvpName || x.cvpId}{x.agent ? ` · 엣지 ${x.agent}` : ''}</div></td>
                <td style={{ fontSize: 12 }}>{x.label || '—'}</td>
                <td style={{ fontSize: 12 }}>{faultEventText(x)}</td>
                <td style={{ fontSize: 12, whiteSpace: 'normal' }}>{x.detail || '—'}</td>
              </tr>
            ))}
          </tbody>
        </STable>
      ))}
    </div>
  );
}

// ── v2.640 ② 파서 시험(관리자) ────────────────────────────────────────────────

const PREVIEW_KIND_OPTIONS = [['inventory', '인벤토리'], ['cvpVersion', 'CVP 버전'], ['interfaces', '포트 구성'], ['counters', '포트 카운터'], ['bgp', 'BGP'], ['power', '전원(PSU)'], ['cooling', '팬'], ['temperature', '온도 센서'], ['xcvr', '트랜시버']];

function PreviewPanel() {
  const [kind, setKind] = useState('inventory');
  const [text, setText] = useState('');
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setErr(null); setR(null);
    try { const x = await postJson('/tools/cvp/parse-preview', { kind, text }); setR(x && x.preview ? x.preview : x); }
    catch (e) { setErr(e); }
    finally { setBusy(false); }
  };
  const sum = r ? previewSummary(r) : null;
  const items = r && Array.isArray(r.items) ? r.items.filter((x) => x && typeof x === 'object') : [];
  const cols = previewColumns(items);
  return (
    <div style={{ minWidth: 0 }}>
      <b>파서 시험(응답 붙여넣기)</b>
      <div style={{ ...NOTE, marginTop: 4 }}><BoldText text={PREVIEW_NOTE} /></div>
      <div style={{ ...ROW, marginTop: 6 }}>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 220 }}>
          {PREVIEW_KIND_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button type="button" className="btn" onClick={run} disabled={busy || !text.trim()}>{busy ? '해석 중…' : '해석'}</button>
        {text.length > 900_000 && <span style={{ ...NOTE, color: 'var(--amber)' }}>본문이 큽니다({countText(text.length)}자) — 서버 상한(약 1MB)을 넘으면 거부됩니다. 앞부분만 붙여넣으세요.</span>}
      </div>
      <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="CVP 응답 원문(JSON·NDJSON)을 붙여넣으세요" style={{ width: '100%', marginTop: 6, fontFamily: 'monospace', fontSize: 12, minWidth: 0, boxSizing: 'border-box' }} />
      {err && <div style={{ marginTop: 6 }}><ErrorBox error={err} /></div>}
      {sum && <div className="banner" style={{ marginTop: 6, borderColor: sum.ok ? 'var(--green)' : 'var(--amber)' }}>{sum.text}</div>}
      {r && Array.isArray(r.keys) && r.keys.length > 0 && <div style={{ ...NOTE, marginTop: 4 }}>응답에 있던 필드: {r.keys.join(', ')}</div>}
      {items.length > 0 && (
        <STable minWidth={640} limit={50} style={{ marginTop: 6 }}>
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>{cols.map((c) => <td key={c} style={{ fontSize: 12, whiteSpace: 'normal', wordBreak: 'break-all' }}>{it[c] == null ? '—' : typeof it[c] === 'object' ? JSON.stringify(it[c]) : String(it[c])}</td>)}</tr>
            ))}
          </tbody>
        </STable>
      )}
      {r && r.ok !== false && items.length === 0 && <div style={{ ...NOTE, marginTop: 6 }}>읽은 항목이 0개입니다 — 형식은 알지만 인식한 필드가 없는 개체뿐입니다(‘응답에 있던 필드’ 를 보세요).</div>}
    </div>
  );
}

// ── 관리자: 서버 등록·설정 ───────────────────────────────────────────────────

function AdminPanel({ onChanged }) {
  const [list, setList] = useState(null);
  const [choices, setChoices] = useState({ agents: [], datacenters: [] });
  const [err, setErr] = useState(null);
  const [form, setForm] = useState(null);
  const [formNote, setFormNote] = useState(null);
  const [sform, setSform] = useState(null);
  const [smsg, setSmsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [sv, st] = await Promise.all([fetchJson('/tools/cvp/servers'), fetchJson('/tools/cvp/settings')]);
      setList(Array.isArray(sv) ? sv : Array.isArray(sv && sv.servers) ? sv.servers : []);
      setChoices({ agents: Array.isArray(sv && sv.agents) ? sv.agents : [], datacenters: Array.isArray(sv && sv.datacenters) ? sv.datacenters : [] });
      setSform(settingsToForm(st && st.settings ? st.settings : st));
      setErr(null);
    } catch (e) { setErr(e); }
  }, []);
  useEffect(() => { loadAll(); }, [loadAll]);

  const save = async () => {
    const isNew = !form.id;
    const { body, issue } = serverPayload(form, { isNew });
    if (issue) { setFormNote({ ok: false, text: issue }); return; }
    setBusy(true); setFormNote(null);
    try {
      const r = isNew ? await postJson('/tools/cvp/servers', body) : await putJson(`/tools/cvp/servers/${encodeURIComponent(form.id)}`, body);
      const dropped = droppedSecretNote(r);
      await loadAll(); onChanged && onChanged();
      if (dropped) { setFormNote({ ok: false, text: dropped }); setForm((f) => ({ ...f, id: (r && (r.id || (r.server && r.server.id))) || f.id })); }
      else { setForm(null); setSmsg({ ok: true, text: '저장했습니다.' }); }
    } catch (e) { setFormNote({ ok: false, text: `저장 실패: ${e.message || e}` }); }
    finally { setBusy(false); }
  };

  const remove = async (s) => {
    if (!window.confirm(`${s.name || s.id} 을(를) 삭제할까요? 수집된 이력은 보존 기간에 따라 정리됩니다.`)) return;
    try { await delJson(`/tools/cvp/servers/${encodeURIComponent(s.id)}`); await loadAll(); onChanged && onChanged(); }
    catch (e) { setSmsg({ ok: false, text: `삭제 실패: ${e.message || e}` }); }
  };

  const test = async (s) => {
    setTestMsg({ id: s.id, text: '연결 테스트 중…' });
    try {
      const r = await postJson(`/tools/cvp/servers/${encodeURIComponent(s.id)}/test`, {});
      const ok = r && r.ok !== false;
      const text = ok
        ? `성공${r.deviceCount != null ? ` — 장비 ${countText(r.deviceCount)}대` : ''}${r.cvpVersion || r.version ? ` · CVP ${r.cvpVersion || r.version}` : ''}${r.usedPath ? ` · 경로 ${r.usedPath}` : ''}`
        : `실패 — ${r && (r.error || r.reason) ? (r.error || r.reason) : '사유를 받지 못했습니다'}`;
      setTestMsg({ id: s.id, text, ok, sample: r && r.sample && typeof r.sample === 'object' ? r.sample : null });
    } catch (e) { setTestMsg({ id: s.id, text: `실패 — ${e.message || e}`, ok: false }); }
  };

  const saveSettings = async () => {
    setBusy(true); setSmsg(null);
    try {
      const r = await putJson('/tools/cvp/settings', settingsPayload(sform));
      setSform(settingsToForm(r && r.settings ? r.settings : r));
      setSmsg({ ok: true, text: '설정을 저장했습니다(빈 칸은 이전 값을 유지합니다).' });
      onChanged && onChanged();
    } catch (e) { setSmsg({ ok: false, text: `설정 저장 실패: ${e.message || e}` }); }
    finally { setBusy(false); }
  };

  if (err && !list) return <div style={{ marginTop: 8 }}><ErrorBox error={err} /></div>;
  if (!list || !sform) return <Loading />;
  const set = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setForm((f) => ({ ...f, [k]: v })); };
  const sset = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setSform((f) => ({ ...f, [k]: v })); };
  const LBL = { fontSize: 12, display: 'grid', gap: 2, minWidth: 0 };

  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 10, minWidth: 0 }}>
      {smsg && <div className="banner" style={{ borderColor: smsg.ok ? 'var(--green)' : 'var(--red)' }}><BoldText text={smsg.text} /></div>}
      <div>
        <b>수집 설정</b>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px,100%),1fr))', gap: 8, marginTop: 6 }}>
          <label style={{ ...LBL, alignContent: 'end' }}><span><input type="checkbox" checked={!!sform.enabled} onChange={sset('enabled')} /> 수집 켜기</span></label>
          <label style={LBL}>주기(분, 하한 1)<input className="input" inputMode="decimal" value={sform.intervalMin} onChange={sset('intervalMin')} /></label>
          <label style={LBL}>원시 보존(일)<input className="input" inputMode="numeric" value={sform.rawRetentionDays} onChange={sset('rawRetentionDays')} /></label>
          <label style={LBL}>일 롤업 보존(일)<input className="input" inputMode="numeric" value={sform.dailyRetentionDays} onChange={sset('dailyRetentionDays')} /></label>
          <label style={LBL}>동시 수집 수<input className="input" inputMode="numeric" value={sform.concurrency} onChange={sset('concurrency')} /></label>
          <label style={LBL}>CVP 당 시한(초)<input className="input" inputMode="numeric" value={sform.deviceTimeoutSec} onChange={sset('deviceTimeoutSec')} /></label>
          <label style={{ ...LBL, alignContent: 'end' }} title="부품 장애·포트 down·BGP down 전이가 생길 때 알림 채널(설정 › 알림)로 보냅니다. 전이 기록은 이 값과 무관하게 남습니다."><span><input type="checkbox" checked={!!sform.faultAlerts} onChange={sset('faultAlerts')} /> 장애 전이 알림</span></label>
          <label style={{ ...LBL, alignContent: 'end' }}><span><input type="checkbox" checked={sform.faultAlertsClosed !== false} onChange={sset('faultAlertsClosed')} disabled={!sform.faultAlerts} /> 해소도 알림</span></label>
        </div>
        <div style={{ ...ROW, marginTop: 6 }}>
          <button type="button" className="btn" onClick={saveSettings} disabled={busy}>설정 저장</button>
          <span style={NOTE}>빈 칸은 보내지 않습니다 — 서버가 이전 값을 유지합니다. 엣지는 이 값을 받아 씁니다.</span>
        </div>
      </div>

      <PreviewPanel />

      {/* v2.641 ⑥: CVP 서버 CSV·자유텍스트 대량 등록·내보내기(공용 BulkDeviceIo — 비밀 포함 내보내기는 설정 소유자 전용) */}
      <CvpBulkIo onDone={loadAll} />

      <div style={{ minWidth: 0 }}>
        <div style={ROW}>
          <b>CVP 서버 등록</b>
          <button type="button" className="btn" onClick={() => { setForm({ ...EMPTY_SERVER }); setFormNote(null); }}>+ 추가</button>
        </div>
        {list.length > 0 && (
          <STable minWidth={640} style={{ marginTop: 6 }}>
            <thead><tr><th>이름</th><th>주소</th><th>수집 위치</th><th>인증</th><th data-nosort>작업</th></tr></thead>
            <tbody>
              {list.filter((s) => s && typeof s === 'object').map((s) => (
                <tr key={s.id}>
                  <td>{s.name || s.id}{s.enabled === false ? ' (비활성)' : ''}</td>
                  <td style={{ fontSize: 12 }}>{hostText(s.host)}</td>
                  <td style={{ fontSize: 12 }}>{s.agent ? `엣지 ${s.agent}` : '중앙 직접'}</td>
                  <td style={{ fontSize: 12 }}>{s.authMode === 'password' ? 'ID/비밀번호' : '토큰'}</td>
                  <td>
                    <div style={ROW}>
                      <button type="button" className="btn" onClick={() => { setForm(serverToForm(s)); setFormNote(null); }}>수정</button>
                      <button type="button" className="btn" onClick={() => test(s)} title={s.agent ? '엣지 위임 CVP 는 중앙에서 닿지 않을 수 있습니다' : ''}>연결 테스트</button>
                      <button type="button" className="btn" onClick={() => remove(s)}>삭제</button>
                    </div>
                    {testMsg && testMsg.id === s.id && <div style={{ fontSize: 12, color: testMsg.ok === false ? 'var(--red)' : 'var(--text-dim)', whiteSpace: 'normal' }}>{testMsg.text}</div>}
                    {testMsg && testMsg.id === s.id && testMsg.sample && (
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 12 }}>원문 표본 보기{testMsg.sample.path ? ` — ${testMsg.sample.path}` : ''}</summary>
                        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto', margin: '4px 0 0', padding: 8, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6 }}>{testMsg.sample.head || '(본문 없음)'}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        )}
        {form && (
          <div className="card" style={{ marginTop: 8, display: 'grid', gap: 8, minWidth: 0 }}>
            <b>{form.id ? `수정 — ${form.name || form.id}` : '새 CVP 서버'}</b>
            {formNote && <div className="banner" style={{ borderColor: 'var(--red)' }}><BoldText text={formNote.text} /></div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px,100%),1fr))', gap: 8 }}>
              <label style={LBL}>표시명<input className="input" value={form.name} onChange={set('name')} placeholder="예: CVP-HQ" /></label>
              <label style={LBL}>주소<input className="input" value={form.host} onChange={set('host')} placeholder="https://cvp.example.local 또는 10.0.0.10" /></label>
              <label style={LBL}>수집 주체
                <select className="input" value={form.agent} onChange={set('agent')}
                  title="CVP 가 중앙에서 닿지 않으면 그 사이트의 엣지를 고르세요. 목록은 중앙과 통신한 적이 있는 엣지입니다.">
                  <option value="">중앙이 직접 수집</option>
                  {choiceOptions(choices.agents, form.agent).map((o) => <option key={o.value} value={o.value}>{o.missing ? o.label : `엣지 ${o.label}`}</option>)}
                </select>
              </label>
              <label style={LBL}>인증 방식
                <select className="input" value={form.authMode} onChange={set('authMode')}>
                  <option value="token">서비스 계정 토큰</option>
                  <option value="password">ID/비밀번호</option>
                </select>
              </label>
              {form.authMode === 'token' ? (
                <label style={LBL}>토큰<input className="input" type="password" autoComplete="new-password" value={form.token} onChange={set('token')} /></label>
              ) : (
                <>
                  <label style={LBL}>계정<input className="input" value={form.username} onChange={set('username')} autoComplete="off" /></label>
                  <label style={LBL}>비밀번호<input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} /></label>
                </>
              )}
              <label style={LBL}>DataCenter(선택)
                <select className="input" value={form.datacenterId} onChange={set('datacenterId')}
                  title="설정 › DataCenter(법인) 에 등록된 목록입니다.">
                  <option value="">(미지정)</option>
                  {choiceOptions(choices.datacenters, form.datacenterId).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label style={LBL}>메모<input className="input" value={form.note} onChange={set('note')} /></label>
            </div>
            <div style={ROW}>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={!!form.verifyTls} onChange={set('verifyTls')} /> TLS 인증서 검증</label>
              <label style={{ fontSize: 12 }}><input type="checkbox" checked={form.enabled !== false} onChange={set('enabled')} /> 사용</label>
            </div>
            <div style={NOTE}>
              {`‘${SECRET_MASK}’ 는 저장된 값을 그대로 쓴다는 뜻입니다. 주소·계정·인증 방식을 바꾸면 저장된 비밀은 승계하지 않으니 다시 입력하세요.`}
            </div>
            <div style={ROW}>
              <button type="button" className="btn" onClick={save} disabled={busy}>{busy ? '저장 중…' : '저장'}</button>
              <button type="button" className="btn" onClick={() => { setForm(null); setFormNote(null); }}>닫기</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
