import React, { useCallback, useEffect, useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, postJson, putJson, delJson, getCurrentUser } from '../../api.js';
import { Loading, ErrorBox, Kpi, Modal, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { droppedSecretNote } from '../droppedSecretText.js';
import { hostText, addressHiddenNote } from './addressHiddenText.js';
import {
  agoText, spanText, countText, bpsText, pctText, kpiItems, serverState, authStopText, isAuthStopped,
  missingFootnotes, itemLabel, CANDIDATE_NOTE, partsCell, bgpCell, portsCell, streamingText, filterDevices,
  partState, partCounts, seriesGeometry, seriesSourceNote, collectSummary,
  EMPTY_SERVER, serverToForm, serverPayload, settingsPayload, settingsToForm, SECRET_MASK,
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
  const [busy, setBusy] = useState(false);
  const [detailKey, setDetailKey] = useState(null); // { cvpId, key, hostname }
  const [adminOpen, setAdminOpen] = useState(false);
  const loadSeq = useRef(0);

  const u = getCurrentUser();
  const isAdmin = !u || u.role === 'admin';

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [main, devs] = await Promise.allSettled([fetchJson('/tools/cvp'), fetchJson('/tools/cvp/devices')]);
      if (seq !== loadSeq.current) return; // 늦게 온 이전 응답은 버린다
      if (main.status === 'fulfilled') { setData(main.value); setError(null); } else setError(main.reason);
      if (devs.status === 'fulfilled') { setDevices(devs.value); setDevErr(null); } else setDevErr(devs.reason);
    } catch (e) {
      if (seq === loadSeq.current) setError(e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const collectNow = async () => {
    setBusy(true); setMsg(null);
    try { const r = await postJson('/tools/cvp/collect', {}); setMsg({ ok: true, text: collectSummary(r) }); await load(); }
    catch (e) { setMsg({ ok: false, text: `수집 요청 실패: ${e.message || e}` }); }
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
  const shown = filterDevices(scoped, q);
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
          <button type="button" className="btn" onClick={collectNow} disabled={busy || poller.running}
            title={poller.running ? '수집이 진행 중입니다 — 끝난 뒤 다시 누르세요' : '중앙 직접 CVP 는 지금 수집하고, 엣지 위임 CVP 는 재수집을 요청합니다'}>
            {busy ? '요청 중…' : poller.running ? '수집 중…' : '지금 수집'}
          </button>
        </div>
      </div>

      {error && <div className="banner">새로고침에 실패했습니다 — 아래는 직전 값입니다({String(error.message || error)}).</div>}
      {msg && <div className="banner" style={{ borderColor: msg.ok ? 'var(--green)' : 'var(--red)' }}><BoldText text={msg.text} /></div>}
      {data.enabled === false && (
        <div className="banner">CVP 수집이 <b>꺼져 있습니다</b>. {isAdmin ? '아래 ‘등록·설정’ 에서 켜면 다음 주기부터 수집합니다.' : '관리자에게 설정을 요청하세요.'}</div>
      )}

      {addressHiddenNote(data) && <div className="banner">🔒 <BoldText text={addressHiddenNote(data)} /></div>}

      <div className="kpis">
        {kpiItems(data.totals).map((k) => (
          <Kpi key={k.key} label={k.label} value={k.value} accent={k.accent || undefined} meta={k.meta || undefined} />
        ))}
      </div>

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
                    <td><Badge tone={sv.tone} title={sv.detail}>{sv.label}</Badge>{sv.detail && sv.tone === 'bad' && sv.label === '실패' && <div style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{sv.detail}</div>}</td>
                    <td className="right">{countText(st.deviceCount)}{st.truncated ? ' (잘림)' : ''}</td>
                    <td style={{ fontSize: 12 }} data-sort={st.collectedAt || 0}>{agoText(st.collectedAt)}</td>
                    <td style={{ fontSize: 12 }} title={used.map((k) => `${itemLabel(k)}: ${st.usedPaths[k]}`).join('\n')}>
                      {used.length ? `${used.length}개 항목` : '—'}{miss.length ? ` · 미확인 ${miss.length}` : ''}
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
            {edges.map((e) => (
              <span key={e.agent} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                {e.agent}: <Badge tone={e.ok === false ? 'bad' : e.ok ? 'ok' : 'muted'} title={e.error || ''}>{e.ok === false ? '실패' : e.ok ? '정상' : '—'}</Badge>
                {' '}{agoText(e.lastPushAt)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ minWidth: 0 }}>
        <div style={ROW}>
          <b>장비 {countText(shown.length)}대{shown.length !== devList.length ? ` (전체 ${countText(devList.length)})` : ''}</b>
          {servers.length > 1 && (
            <select className="input" value={cvpSel} onChange={(e) => setCvpSel(e.target.value)} style={{ maxWidth: 220 }}>
              <option value="">모든 CVP</option>
              {servers.map((s) => <option key={s.id} value={String(s.id)}>{s.name || s.id}</option>)}
            </select>
          )}
          <SearchBox className="input" style={{ marginLeft: 'auto', maxWidth: 260, minWidth: 160 }} value={q} onChange={setQ}
            placeholder="호스트명·모델·시리얼·EOS" />
        </div>
        {devErr && !devices && <div style={{ marginTop: 8 }}><ErrorBox error={devErr} /></div>}
        {devices && numOrZero(devices.omitted) > 0 && (
          <div style={{ ...NOTE, marginTop: 6 }}>응답 상한으로 {countText(devices.omitted)}대를 빼고 받았습니다 — 검색으로 좁혀 보세요.</div>
        )}
        {devices && devList.length === 0 ? (
          <div style={{ ...NOTE, marginTop: 8 }}>아직 수집된 장비가 없습니다.</div>
        ) : devices ? (
          <STable minWidth={900} limit={500} style={{ marginTop: 8 }}>
            <thead><tr><th>호스트명</th><th>모델</th><th>시리얼</th><th>관리 주소</th><th>EOS</th><th>스트리밍</th><th>파트</th><th>포트 up/전체</th><th>BGP</th><th>CVP</th><th>수집</th></tr></thead>
            <tbody>
              {shown.map((d) => {
                const pc = partsCell(d.parts); const bc = bgpCell(d.bgp); const oc = portsCell(d.ports); const sc = streamingText(d.streaming);
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
  const [tab, setTab] = useState('parts');
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
          </div>
          <div style={ROW}>
            {[['parts', `장애 파트${parts ? ` (${parts.length})` : ''}`], ['ports', `포트${ports ? ` (${ports.length})` : ''}`],
              ['bgp', `BGP 피어${bgp ? ` (${bgp.length})` : ''}`], ['paths', '읽은 경로']].map(([k, l]) => (
              <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

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
            <div style={NOTE}>포트 구성을 읽지 못했습니다.</div>
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
                      <td><Badge tone={p.oper === 'up' ? 'ok' : p.oper ? (p.admin === 'down' ? 'muted' : 'warn') : 'muted'}>{p.oper || '—'}</Badge></td>
                      <td>{p.admin || '—'}</td>
                      <td>{p.vlan ?? '—'}</td>
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
            <div style={NOTE}>BGP 상태를 읽지 못했거나 BGP 를 쓰지 않는 장비입니다. 전체 라우팅 테이블은 수집하지 않습니다(피어 요약만).</div>
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
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={NOTE}><BoldText text={CANDIDATE_NOTE} /></div>
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

// ── 포트 추이 차트(간단 SVG, y축 0~100 고정) ─────────────────────────────────

const HOURS = [[24, '24시간'], [168, '7일'], [720, '30일']];

function PortChart({ target, port, onClose }) {
  const [hours, setHours] = useState(24);
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
  const pts = r && Array.isArray(r.points) ? r.points : [];
  const gin = seriesGeometry(pts, 'inUtil', { width: W, height: H, pad: PAD, intervalMs: r && r.intervalMs });
  const gout = seriesGeometry(pts, 'outUtil', { width: W, height: H, pad: PAD, intervalMs: r && r.intervalMs });
  const empty = gin.count === 0 && gout.count === 0;
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div style={ROW}>
        <b>{port} 사용률 추이</b>
        {HOURS.map(([h, l]) => (
          <button key={h} type="button" className={`tab${hours === h ? ' active' : ''}`} onClick={() => setHours(h)}>{l}</button>
        ))}
        <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
      {err && <ErrorBox error={err} />}
      {!r && !err && <Loading />}
      {r && (empty ? (
        <div style={{ ...NOTE, marginTop: 6 }}>
          이 기간에 사용률 표본이 없습니다 — 첫 수집(누적 카운터라 두 번째 주기부터 값이 나옵니다)이거나 인터페이스 속도를 모르는 포트일 수 있습니다.
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 320, maxWidth: W, display: 'block' }} role="img" aria-label={`${port} 사용률 추이`}>
              {[0, 50, 100].map((v) => {
                const y = PAD + (H - PAD * 2) - (v / 100) * (H - PAD * 2);
                return (
                  <g key={v}>
                    <line x1={PAD} x2={W - PAD} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
                    <text x={PAD - 4} y={y + 4} fontSize="10" textAnchor="end" fill="var(--text-dim)">{v}%</text>
                  </g>
                );
              })}
              {gin.paths.map((p, i) => <path key={`i${i}`} d={p} fill="none" stroke="var(--accent)" strokeWidth="1.5" />)}
              {gin.dots.map((p, i) => <circle key={`id${i}`} cx={p.x} cy={p.y} r="2.5" fill="var(--accent)" />)}
              {gout.paths.map((p, i) => <path key={`o${i}`} d={p} fill="none" stroke="var(--amber)" strokeWidth="1.5" />)}
              {gout.dots.map((p, i) => <circle key={`od${i}`} cx={p.x} cy={p.y} r="2.5" fill="var(--amber)" />)}
            </svg>
          </div>
          <div style={{ ...NOTE, marginTop: 4 }}>
            <span style={{ color: 'var(--accent)' }}>━ 수신</span> · <span style={{ color: 'var(--amber)' }}>━ 송신</span>
            {' '}· y축은 0~100% 고정 · 수집이 없던 구간은 선을 잇지 않습니다 · {seriesSourceNote(r)}
          </div>
        </>
      ))}
    </div>
  );
}

// ── 관리자: 서버 등록·설정 ───────────────────────────────────────────────────

function AdminPanel({ onChanged }) {
  const [list, setList] = useState(null);
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
        ? `성공${r.deviceCount != null ? ` — 장비 ${countText(r.deviceCount)}대` : ''}${r.version ? ` · CVP ${r.version}` : ''}`
        : `실패 — ${r && (r.error || r.reason) ? (r.error || r.reason) : '사유를 받지 못했습니다'}`;
      setTestMsg({ id: s.id, text, ok });
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
        </div>
        <div style={{ ...ROW, marginTop: 6 }}>
          <button type="button" className="btn" onClick={saveSettings} disabled={busy}>설정 저장</button>
          <span style={NOTE}>빈 칸은 보내지 않습니다 — 서버가 이전 값을 유지합니다. 엣지는 이 값을 받아 씁니다.</span>
        </div>
      </div>

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
              <label style={LBL}>수집 엣지(빈 칸 = 중앙 직접)<input className="input" value={form.agent} onChange={set('agent')} placeholder="엣지 이름" /></label>
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
              <label style={LBL}>DataCenter(선택)<input className="input" value={form.datacenterId} onChange={set('datacenterId')} /></label>
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
