// IpScanSettings.jsx — IP관리 › IP 스캔 설정(에이전트별 능동 스캔 대역·포트·주기 + /24 제안 + 데이터센터 귀속). v2.639 에 IpamSettings.jsx(853줄)에서 나눴다.
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, canCsv } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { intervalMinText, scanSettingsBody } from './ipamScanForm.js';
import { useIpamDraft } from './useIpamDraft.js'; // v2.636: 편집 초안 — 페이지를 옮기거나 대장이 다시 로딩돼도 입력이 남는다
import { DraftBanner } from './IpamDraftBanner.jsx';
import { RangesCsv } from './IpamCsv.jsx'; // v2.638: 스캔 대역 CSV 를 이 페이지에서도
import { appendSubnets, coverageOf, dcDecisionText, rangesOf, suggestEmptyText, suggestSummaryText } from './ipScanDcText.js';
import { checkRangeList, normalizeRangeText, serverInvalidText } from './ipmsRangeText.js';
import { agentLabel, fmtDt, Frame, LOCAL_AGENT } from './ipamShared.jsx';
import { RangeCheck, SCAN_CAP } from './VcScanRangeEditor.jsx';
import { ScanProgressBar } from './IpamScanStatus.jsx';

/**
 * v2.622(감사 WEB-08): IP 스캔 응답 수용 판정(순수). 응답은 요청한 에이전트가 지금 고른 에이전트와 같을 때만
 * 화면에 반영한다. 예전에는 에이전트를 A→B 로 빠르게 바꾸면 늦게 온 A 의 first 로드가 B 폼을 A 설정으로 채웠고,
 * 저장이 그 값(대역·주기·포트)을 B 에 기록했다. 2초 폴링의 늦은 이전 응답도 상태·결과를 덮었다.
 */
export function ipScanAccept(requestedAgent, currentAgent) {
  return requestedAgent === currentAgent;
}

/** v2.638: 데이터센터 귀속 판정(서버) 한 줄 + 근거. pending = 고른 값을 아직 저장하지 않았다. */
function DcDecision({ info, pending }) {
  if (info === undefined) return <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>귀속 판정을 불러오는 중…</div>;
  const t = dcDecisionText(info);
  const color = t.tone === 'ok' ? 'var(--green)' : t.tone === 'warn' ? 'var(--amber)' : undefined;
  return (
    <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
      <span className="muted">스캔으로 찾은 IP 의 귀속: </span><b style={{ color }}>{t.text}</b>
      {pending && <span style={{ color: 'var(--amber)' }}> · 바꾼 값은 저장하면 적용됩니다(위 판정은 저장된 값 기준)</span>}
      <div className="muted">{t.detail}</div>
    </div>
  );
}

/**
 * v2.638: 에이전트가 쓰는 /24 대역 제안 — 그 에이전트가 수집하는 vCenter 의 VM·ESXi IP + 담당 iDRAC IP 를 /24 로 묶은 목록에서
 * 골라 스캔 대역 칸에 붙인다. 판정·조회는 서버(GET /admin/ipam/scan/suggest), 이미 입력된 대역 표시는 저장하지 않은 입력 기준.
 */
function SubnetSuggest({ agent, ranges, onAdd }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [pick, setPick] = useState(() => new Set());
  const [note, setNote] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true; // 늦게 온 이전 에이전트의 응답을 버린다(v2.622 WEB-08 과 같은 규칙)
    setData(null); setErr(null); setPick(new Set()); setNote(null);
    fetchJson('/admin/ipam/scan/suggest', { agent }).then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [agent]);
  const covered = rangesOf(ranges);
  const list = (data?.subnets || []).filter((x) => !q.trim() || x.cidr.includes(q.trim()) || (x.vcenters || []).some((v) => v.toLowerCase().includes(q.trim().toLowerCase())));
  const toggle = (c) => setPick((p) => { const n = new Set(p); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const addable = list.filter((x) => coverageOf(x.cidr, covered) !== 'full');
  const add = () => {
    const r = appendSubnets(ranges, [...pick]);
    onAdd(r.lines);
    setNote(`${r.added}개 대역을 스캔 대역 칸에 넣었습니다${r.skipped ? `(이미 들어 있던 ${r.skipped}개는 뺐습니다)` : ''} — 아직 저장하지 않았습니다. 아래 ‘저장’ 을 누르세요.`);
    setPick(new Set());
  };
  return (
    <div className="card" style={{ padding: 10, marginTop: 8, minWidth: 0 }}>
      {err ? <ErrorBox message={err} /> : !data ? <Loading /> : (
        <>
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>{suggestSummaryText(data)}</div>
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>
            대상: {(data.vcenters || []).length ? `vCenter ${(data.vcenters || []).map((v) => v.name).join(', ')}` : 'vCenter 없음'}
            {` · iDRAC ${data.idracServers ?? 0}대(${data.idracSource === 'central-registry' ? '이 포탈 등록' : '엣지가 마지막으로 보고한 목록'})`}
          </div>
          {data.inputErrors && <div style={{ fontSize: 11, color: 'var(--amber)' }}>일부 등록부를 읽지 못했습니다({Object.keys(data.inputErrors).join(', ')}) — 목록이 빠졌을 수 있습니다.</div>}
          {(data.subnets || []).length === 0 ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{suggestEmptyText(data, agent === LOCAL_AGENT)}</div>
          ) : (
            <>
              <div className="flex gap wrap" style={{ alignItems: 'center', margin: '6px 0' }}>
                <input className="input" style={{ width: 200, maxWidth: '100%', minWidth: 0 }} placeholder="대역·vCenter 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="대역 검색" />
                <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12 }} onClick={() => setPick(new Set(addable.map((x) => x.cidr)))}>보이는 것 모두 선택({addable.length})</button>
                <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12 }} disabled={!pick.size} onClick={() => setPick(new Set())}>선택 해제</button>
                <button className="login-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} disabled={!pick.size} onClick={add}>선택한 {pick.size}개 추가</button>
              </div>
              <div className="table-wrap" style={{ maxHeight: 280 }}>
                <STable minWidth={520}>
                  <thead><tr><th data-nosort /><th>대역(/24)</th><th style={{ textAlign: 'right' }}>IP 수</th><th style={{ textAlign: 'right' }}>vCenter</th><th style={{ textAlign: 'right' }}>iDRAC</th><th>출처 vCenter</th><th>상태</th></tr></thead>
                  <tbody>
                    {list.map((x) => {
                      const cov = coverageOf(x.cidr, covered);
                      return (
                        <tr key={x.cidr}>
                          <td><input type="checkbox" aria-label={`${x.cidr} 선택`} disabled={cov === 'full'} checked={pick.has(x.cidr)} onChange={() => toggle(x.cidr)} /></td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{x.cidr}</td>
                          <td style={{ textAlign: 'right' }}>{x.ips}</td>
                          <td style={{ textAlign: 'right' }}>{x.vcenterIps}</td>
                          <td style={{ textAlign: 'right' }}>{x.idracIps}</td>
                          <td className="muted" style={{ fontSize: 11, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{(x.vcenters || []).join(', ') || '—'}</td>
                          <td>{cov === 'full' ? <span className="badge green">이미 입력됨</span> : cov === 'partial' ? <span className="badge amber" title="이 /24 의 일부만 입력된 대역에 들어 있습니다">일부 입력됨</span> : <span className="muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </STable>
              </div>
            </>
          )}
          {note && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--green)' }}>{note}</div>}
        </>
      )}
    </div>
  );
}

/** IP 능동 스캔(TCP 커넥트) 설정 + 수동 실행 + 결과. 물리/기타 서버 IP를 대장에 채운다. */
export function IpScanSettings({ onClose, asPage = false, onSaved }) { // v2.638: onSaved — 데이터센터 귀속이 바뀌면 대장을 다시 읽게
  const [agent, setAgent] = useState(LOCAL_AGENT);
  // v2.636: 폼 값은 에이전트마다 따로 편집 초안(scan:<에이전트>) — 저장 전까지 페이지를 옮기거나 에이전트를 바꿔도 남는다.
  const d = useIpamDraft(`scan:${agent}`);
  const s = d.value;
  const setS = d.set;
  const [agents, setAgents] = useState([LOCAL_AGENT]);
  const [newAgent, setNewAgent] = useState('');
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [reports, setReports] = useState({});
  const [centralEnabled, setCentralEnabled] = useState(true);
  const [msg, setMsg] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sFor, setSFor] = useState(null); // v2.622(감사 WEB-08): 폼(s)을 채운 에이전트
  const agentRef = useRef(LOCAL_AGENT);   // 지금 고른 에이전트(늦게 온 이전 에이전트 응답을 버린다)
  // v2.638: 데이터센터 귀속 판정(서버) + 고를 수 있는 DataCenter 목록 · /24 대역 제안 패널 · CSV 패널
  const [dcInfo, setDcInfo] = useState(undefined);  // undefined = 아직 모름(구버전 서버는 필드가 없다)
  const [dcList, setDcList] = useState(null);       // null = 목록을 못 받음
  const [dcListErr, setDcListErr] = useState(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const load = async (ag, first = false) => {
    try {
      const r = await fetchJson('/admin/ipam/scan/settings', { agent: ag });
      if (!ipScanAccept(ag, agentRef.current)) return; // v2.622(감사 WEB-08)
      if (first) { d.load(r.settings); setSFor(ag); }
      if ('datacenter' in r) setDcInfo(r.datacenter);
      if (Array.isArray(r.datacenters)) setDcList(r.datacenters);
      setDcListErr(r.datacentersError || null);
      if (r.agents) setAgents(r.agents);
      setStatus(r.status); setInfo(r.info); setReports(r.reports || {}); setCentralEnabled(r.centralEnabled !== false);
    } catch (e) {
      if (!ipScanAccept(ag, agentRef.current)) return; // v2.622(감사 WEB-08)
      if (first) setLoadErr(e); else setMsg(e.message);
      if (e?.status === 403) deniedRef.current = true;
    }
  };
  // v2.611 LEFT2611-07: 403(범위 제한 계정)은 정책 거부라 2초마다 다시 묻지 않는다.
  const deniedRef = useRef(false);
  useEffect(() => { load(agent, true); const t = setInterval(() => { if (!deniedRef.current) load(agent, false); }, 2000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [agent]);
  if (!s) return <Frame asPage={asPage} title="🛰️ IP 스캔 설정" onClose={onClose}>{loadErr ? <ErrorBox message={loadErr} /> : msg ? <ErrorBox message={msg} /> : <Loading />}</Frame>;

  const isLocal = agent === LOCAL_AGENT;
  const agentOptionLabel = (a) => (a === LOCAL_AGENT ? '이 포탈에서 직접' : a);
  // v2.639(D5): 대역 문법 검사 — 서버 PUT /ipam/scan/settings 도 v2.639 부터 같은 판정으로 400 을 준다. 오류 줄이 있으면 저장·지금 스캔을 잠근다.
  const rangeCheck = checkRangeList(s.ranges || [], { reversed: 'error', scanCap: SCAN_CAP });
  const rangeTitle = rangeCheck.invalid.length ? `형식 오류 ${rangeCheck.invalid.length}줄을 먼저 고치세요` : undefined;
  const msgView = typeof msg === 'string' ? { text: msg } : msg;
  const switchAgent = (a) => { agentRef.current = a; setSFor(null); setMsg(null); setLoadErr(null); setDcInfo(undefined); setAgent(a); }; // 폼은 useIpamDraft 가 키(에이전트)마다 새로 시작한다
  const save = async () => {
    // v2.622(감사 WEB-08): 다른 에이전트의 설정으로 채워진 폼은 저장하지 않는다.
    if (!ipScanAccept(sFor, agent)) { setMsg('이 폼은 지금 고른 에이전트의 설정이 아닙니다 — 다시 불러온 뒤 저장하세요.'); return; }
    if (rangeCheck.invalid.length) { setMsg({ text: `형식 오류 ${rangeCheck.invalid.length}줄을 먼저 고치세요`, list: rangeCheck.invalid.map((x) => serverInvalidText({ field: 'ranges', ...x })) }); return; } // 버튼 잠금의 이중 방어
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/ipam/scan/settings', scanSettingsBody(s, agent));
      // v2.638: 400(등록되지 않은 데이터센터 등)은 putJson 이 던지지 않고 본문을 돌려준다 — 사유를 말하고 초안을 남긴다.
      if (r && r.ok === false) { setMsg({ text: `저장하지 못했습니다: ${r.reason || '서버가 거부했습니다'}`, list: (r.invalid || []).map((x) => serverInvalidText(x)) }); return; }
      d.saved(r.settings); setStatus(r.status);
      if ('datacenter' in r) setDcInfo(r.datacenter);
      onSaved?.();
      const cfg = r.settings || s;
      const mins = Math.max(1, Math.round((cfg.intervalMs || 3_600_000) / 60000));
      const nextAt = fmtDt(Date.now() + (cfg.intervalMs || 3_600_000));
      const hasRanges = (cfg.ranges || []).filter(Boolean).length > 0;
      if (isLocal) {
        // 저장 후 '지금 스캔?' 확인 — 아니오면 설정된 주기/다음 스캔 시각 안내.
        if (hasRanges && window.confirm('설정을 저장했습니다.\n지금 바로 스캔할까요?\n\n[취소]를 누르면 설정된 주기에 따라 자동 스캔됩니다.')) {
          await runNow();
        } else if (cfg.enabled && hasRanges) {
          setMsg(`저장됨 · 자동 스캔 켜짐(주기 ${mins}분). 다음 자동 스캔 예정: 약 ${nextAt}. 지금 바로 하려면 '지금 스캔(포탈)'을 누르세요.`);
        } else {
          setMsg(`저장됨 · 자동 스캔이 꺼져 있습니다('주기적으로 스캔' 체크 후 저장하거나 '지금 스캔(포탈)'을 누르세요).`);
        }
      } else {
        // 원격 에이전트는 중앙에서 즉시 실행 불가 — 다음 주기에 스스로 읽어가 스캔.
        setMsg(cfg.enabled
          ? `저장됨 · '${agent}' 에이전트가 주기 ${mins}분마다 이 설정을 읽어가 스캔합니다. 다음 스캔: 최대 ${mins}분 이내(에이전트 다음 주기). 중앙에서 즉시 실행은 불가합니다.`
          : `저장됨 · '${agent}' 자동 스캔이 꺼져 있습니다('주기적으로 스캔' 체크 후 저장하세요).`);
      }
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const runNow = async () => {
    if (rangeCheck.invalid.length) { setMsg({ text: `형식 오류 ${rangeCheck.invalid.length}줄을 먼저 고치세요 — 스캔을 시작하지 않았습니다`, list: rangeCheck.invalid.map((x) => serverInvalidText({ field: 'ranges', ...x })) }); return; }
    const nRanges = (s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length;
    setBusy(true); setMsg(`입력한 대역(${nRanges}개)을 저장하고 스캔을 시작하는 중…`);
    try {
      // 입력한 대역을 먼저 저장한 뒤 스캔(미저장 입력이 무시되어 첫 대역만 스캔되던 문제 방지).
      const sv = await putJson('/admin/ipam/scan/settings', scanSettingsBody(s, agent));
      // v2.639(D2): 저장이 400(미등록 DataCenter·대역 문법 오류 — putJson 은 400 본문을 돌려준다)이면 스캔을 시작하지 않는다.
      //   예전에는 sv.ok 를 보지 않고 스캔을 시작하며 '입력한 대역 N개 스캔을 시작했습니다' 라고 말했다 — 실제로는 저장되지 않은 옛 대역으로 돌았다.
      if (sv && sv.ok === false) { setMsg({ text: `저장하지 못해 스캔을 시작하지 않았습니다: ${sv.reason || '서버가 거부했습니다'}`, list: (sv.invalid || []).map((x) => serverInvalidText(x)) }); return; }
      if (sv?.settings) d.saved(sv.settings);
      const r = await postJson('/admin/ipam/scan/run', {});
      if (r.status) setStatus(r.status); if (r.info) setInfo(r.info);
      setMsg(r.ok ? `대역 ${nRanges}개 스캔을 백그라운드에서 시작했습니다(전체 IP는 진행 막대에 표시). 창을 닫아도 계속 실행됩니다.` : `시작 실패: ${r.reason}`);
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); load(agent, false); }
  };
  const last = status?.lastRun;
  const runNowTitle = !isLocal ? '원격 에이전트는 자체 주기로 스캔합니다' : rangeTitle || (status?.running ? '스캔이 진행 중입니다' : '');

  return (
    <Frame asPage={asPage} title="🛰️ IP 능동 스캔 (TCP 커넥트)" onClose={onClose} width={680} resizable minWidth={460} minHeight={420}>
      <DraftBanner d={d} />
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        vCenter가 모르는 <b>물리서버·타 가상화·네트워크 장비</b> IP를 TCP 커넥트 스캔으로 찾아 IP 관리대장에 채웁니다.
        <b> 할당 에이전트</b>를 고르면 해당 에이전트가 이 설정을 읽어가 자기 사이트에서 스캔하고 결과를 포탈에 보고합니다.
        <span className="badge amber" style={{ marginLeft: 6 }}>승인된 대역만</span>
      </div>
      {msgView && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {msgView.text}
          {msgView.list?.length > 0 && <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{msgView.list.slice(0, 20).map((t, i) => <li key={i}>{t}</li>)}{msgView.list.length > 20 && <li>외 {msgView.list.length - 20}건</li>}</ul>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 16, rowGap: 14, alignItems: 'start' }}> {/* v2.636: 페이지(400px)에서 1fr 의 최소폭이 내용 폭이라 입력칸이 카드 밖으로 밀렸다 */}
        <label style={{ fontWeight: 600, paddingTop: 9 }}>할당 에이전트</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={agent} onChange={(e) => switchAgent(e.target.value)} style={{ maxWidth: '100%', width: 260 }} aria-label="할당 에이전트">
            {agents.map((a) => <option key={a} value={a}>{agentOptionLabel(a)}</option>)}
          </select>
          <input className="input" style={{ width: 160, maxWidth: '100%' }} placeholder="새 에이전트 이름" value={newAgent} onChange={(e) => setNewAgent(e.target.value)}
            title="목록에 아직 없는 엣지의 AGENT_NAME 을 적으면 그 이름으로 스캔 설정을 미리 만들어 둡니다. 엣지가 붙으면 이 설정을 읽어 갑니다." aria-label="새 에이전트 이름" />
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} disabled={!newAgent.trim()} title="입력한 이름의 스캔 설정을 새로 만들거나(없으면) 그 에이전트를 고릅니다" onClick={() => { const a = newAgent.trim(); setNewAgent(''); if (a) switchAgent(a); }}>추가/선택</button>
          <span className="muted" style={{ fontSize: 11, flexBasis: '100%' }}>‘새 에이전트 이름’ 은 목록에 아직 없는 엣지(AGENT_NAME)의 설정을 미리 만들어 둘 때만 씁니다.</span>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>데이터센터</label>
        <div style={{ minWidth: 0 }}>
          <select className="select" value={s.datacenterId || ''} onChange={(e) => setS({ ...s, datacenterId: e.target.value })} style={{ maxWidth: '100%', width: 260 }} aria-label="스캔 결과 데이터센터">
            <option value="">자동(에이전트가 속한 데이터센터)</option>
            {(dcList || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {s.datacenterId && dcList && !dcList.some((x) => x.id === s.datacenterId) && <option value={s.datacenterId}>{s.datacenterId} (목록에 없음)</option>}
          </select>
          {dcListErr && <div style={{ fontSize: 11, marginTop: 4, color: 'var(--amber)' }}>DataCenter 목록을 읽지 못했습니다({dcListErr}) — 지금은 ‘자동’ 만 고를 수 있습니다.</div>}
          <DcDecision info={dcInfo} pending={(s.datacenterId || '') !== ((d.base && d.base.datacenterId) || '')} />
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>사용</label>
        <label className="flex gap" style={{ alignItems: 'center', paddingTop: 9 }}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> 주기적으로 스캔
        </label>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>스캔 대역 <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>(한 줄에 하나)</span></label>
        <div>
          <textarea className="input" value={(s.ranges || []).join('\n')} onChange={(e) => setS({ ...s, ranges: normalizeRangeText(e.target.value).split('\n') })}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.50\n172.16.5.10'} style={{ resize: 'vertical', minHeight: 96, fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box', display: 'block' }} />
          <RangeCheck check={rangeCheck} />
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>등록 대역 <b>{(s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length}</b>개 — 모든 줄을 스캔합니다(쉼표는 줄바꿈으로 바뀝니다). <b>지금 스캔</b>은 입력값을 자동 저장 후 실행합니다.</div>
          <div className="flex gap wrap" style={{ marginTop: 6 }}>
            <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12, whiteSpace: 'normal', textAlign: 'left', maxWidth: '100%' }} aria-expanded={suggestOpen} onClick={() => setSuggestOpen((v) => !v)}>
              {suggestOpen ? '▾' : '▸'} 사용 중인 대역에서 고르기(/24)
            </button>
            {canCsv() && <button className="tab" style={{ flex: 'none', padding: '5px 10px', fontSize: 12, whiteSpace: 'normal', textAlign: 'left', maxWidth: '100%' }} aria-expanded={csvOpen} onClick={() => setCsvOpen((v) => !v)}>
              {csvOpen ? '▾' : '▸'} 스캔 대역 CSV 가져오기·내보내기
            </button>}
          </div>
          {suggestOpen && <SubnetSuggest agent={agent} ranges={s.ranges || []} onAdd={(lines) => setS({ ...s, ranges: lines })} />}
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>포트</label>
        <input className="input" value={(s.ports || []).join(', ')} onChange={(e) => setS({ ...s, ports: e.target.value.split(/[\s,]+/).map(Number).filter(Boolean) })}
          style={{ width: '100%', boxSizing: 'border-box' }} />
        <label style={{ fontWeight: 600, paddingTop: 9 }}>주기 / 동시성 / 타임아웃</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={1} style={{ width: 90 }} value={intervalMinText(s)} onChange={(e) => setS({ ...s, intervalMin: e.target.value })} /><span className="muted">분</span>
          <input className="input" type="number" min={1} max={1024} style={{ width: 80 }} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: e.target.value })} /><span className="muted">동시</span>
          <input className="input" type="number" min={100} max={10000} style={{ width: 90 }} value={s.timeoutMs} onChange={(e) => setS({ ...s, timeoutMs: e.target.value })} /><span className="muted">ms</span>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>역DNS / 보존</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={s.reverseDns} onChange={(e) => setS({ ...s, reverseDns: e.target.checked })} /> 역DNS 호스트명</label>
          <label className="flex gap" style={{ alignItems: 'center' }} title="TCP 포트가 전부 닫힌 서버도 ICMP 응답으로 '사용 중' 감지. 기본 꺼짐 — 큰 대역에서는 ping 프로세스 부하가 있으니 필요한 대역에만 켜세요(동시 실행은 소수로 제한됨)."><input type="checkbox" checked={s.ping === true} onChange={(e) => setS({ ...s, ping: e.target.checked })} /> ICMP ping 병행 <span className="muted" style={{ fontSize: 11 }}>(기본 꺼짐)</span></label>
          <input className="input" type="number" min={0} style={{ width: 80 }} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: e.target.value })} /><span className="muted">일 보존</span>
        </div>
      </div>

      {canCsv() && csvOpen && (
        <div style={{ marginTop: 12 }}>
          {d.dirty && <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--amber)' }}>이 화면에 저장하지 않은 입력이 있습니다 — CSV 로 적용해도 이 폼의 입력(초안)이 우선 보입니다. 저장하거나 ‘되돌리기’ 한 뒤 적용 결과를 확인하세요.</div>}
          <RangesCsv onApplied={() => load(agent, true)} />
        </div>
      )}

      {!isLocal && <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>※ 이 설정은 <b>{agent}</b> 에이전트(<code>AGENT_NAME={agent}</code>, <code>CENTRAL_URL</code> 설정 필요)가 다음 주기에 읽어가 자기 사이트에서 스캔하고 결과를 포탈로 보고합니다. '지금 스캔'은 이 포탈에서 직접 스캔할 때만 동작합니다.</div>}

      {/* 등록된 에이전트 없음 안내 */}
      {agents.filter((a) => a !== LOCAL_AGENT).length === 0 && (
        <div className="card" style={{ padding: 12, marginTop: 14, borderColor: 'var(--amber)', fontSize: 12.5, lineHeight: 1.7 }}>
          <b style={{ color: 'var(--amber)' }}>⚠ 등록된 에이전트가 없습니다.</b> 현재는 <b>이 포탈에서 직접</b>만 스캔할 수 있습니다.
          <div className="muted" style={{ marginTop: 6 }}>
            분산 에이전트가 목록에 뜨려면:
            <div>① <b>설정 › 에이전트 배포</b>로 에이전트를 배포하거나 <b>수집 서버</b>를 등록</div>
            <div>② 에이전트 측에 <code>AGENT_NAME</code>, <code>CENTRAL_URL</code>(이 포탈 주소), <code>CENTRAL_TOKEN</code> 설정</div>
            <div>③ <b>이 포탈에 <code>CENTRAL_TOKEN</code> 환경변수가 설정되어 있어야</b> 에이전트 보고가 허용됩니다 {centralEnabled ? <span className="badge green">설정됨</span> : <span className="badge red">미설정</span>}</div>
            <div style={{ marginTop: 4 }}>· 우측 <b>"새 에이전트 이름"</b>에 에이전트의 <code>AGENT_NAME</code>을 직접 입력해 미리 할당을 만들어 둘 수도 있습니다.</div>
          </div>
        </div>
      )}

      {/* 에이전트별 마지막 보고 현황 */}
      {Object.keys(reports).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>에이전트별 보고 현황</div>
          <div className="table-wrap" style={{ maxHeight: '24vh' }}>
            <STable minWidth={480} wrap={false}>
              <thead><tr><th>에이전트</th><th>마지막 보고</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th>상태</th></tr></thead>
              <tbody>
                {Object.entries(reports).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).map(([name, r]) => {
                  const ageMin = (Date.now() - (r.at || 0)) / 60000;
                  const fresh = ageMin < 90; // 90분 내 보고면 정상
                  return (
                    <tr key={name}>
                      <td><b>{agentLabel(name)}</b></td>
                      <td className="muted" style={{ fontSize: 12 }} data-sort={r.at ?? ''}>{fmtDt(r.at)}</td>
                      <td style={{ textAlign: 'right' }}>{(r.scanned ?? 0).toLocaleString()} / <b>{(r.alive ?? 0).toLocaleString()}</b></td>
                      <td><span className={`badge ${fresh ? 'green' : 'gray'}`}>{fresh ? '정상' : '오래됨'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginTop: 14, fontSize: 13 }}>
        <span className="muted">이 포탈 상태 <b style={{ color: status?.running ? 'var(--amber)' : 'var(--text)' }}>{status?.running ? '스캔 중' : (status?.enabled ? '활성' : '비활성')}</b></span>{' · '}
        <span className="muted">저장된 결과 <b style={{ color: 'var(--text)' }}>{info?.count ?? 0}</b>개</span>
        {info?.byAgent && Object.keys(info.byAgent).length > 0 && <span className="muted"> ({Object.entries(info.byAgent).map(([a, n]) => `${agentLabel(a)}:${n}`).join(', ')})</span>}
        {last && !last.skipped && !last.error && <span className="muted"> · 최근(포탈): {last.scanned}개 중 {last.alive}개 응답</span>}
        {last?.error && <span style={{ color: 'var(--red)' }}> · 오류: {last.error}</span>}
        <ScanProgressBar progress={status?.progress} />
      </div>

      <div className="flex gap wrap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy || rangeCheck.invalid.length > 0} title={rangeTitle} onClick={save}>저장{d.dirty ? ' ●' : ''}</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || status?.running || !isLocal || rangeCheck.invalid.length > 0} title={runNowTitle} onClick={runNow}>지금 스캔(포탈)</button>
        {!asPage && <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>}
      </div>
    </Frame>
  );
}
