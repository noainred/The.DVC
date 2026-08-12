// IpamSettings.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, getToken } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { DEVTYPE_LABEL, MGMT } from './ipamShared.jsx';


/** Per-IP user memo + tags editor (separate from vCenter notes). */
export function MemoEditor({ init, onClose, onSaved }) {
  const [memo, setMemo] = useState(init.memo || '');
  const [tags, setTags] = useState(init.tags || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const body = { ip: init.ip, memo, tags: String(tags).split(/[,\n]/).map((s) => s.trim()).filter(Boolean) };
    const r = await putJson('/tools/ipam/annotation', body).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '저장 실패');
  };
  return (
    <Modal title={`메모 · 태그 — ${init.ip}`} onClose={onClose} width={720} resizable minWidth={460} minHeight={380}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 14 }}>vCenter 메모와 별개로, 이 IP에 직접 남기는 메모/태그입니다. (수집 갱신에도 유지)</div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      {/* 2열 폼: 라벨(왼쪽 기준선) · 입력 박스(오른쪽 기준선)로 정렬 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 16, alignItems: 'start' }}>
        <label style={{ fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' }}>메모</label>
        <textarea className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 보안취약점 점검 대상, 담당 홍길동"
          style={{ resize: 'vertical', minHeight: 140, width: '100%', boxSizing: 'border-box', display: 'block' }} />
        <label style={{ fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' }}>태그<span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> (쉼표로 구분)</span></label>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="예: 점검, IAM, 운영"
          style={{ width: '100%', boxSizing: 'border-box', display: 'block' }} />
        <div />
        <div className="flex gap" style={{ marginTop: 4 }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * IP 수동 관리(override) 편집기 — vCenter/스캔으로 자동 발견되는 정보와 별개로, 운영자가
 * IP 단위로 관리상태(예약/폐기/고정 등)·담당자·라벨·디바이스 종류·예약 만료·vCenter 귀속을
 * 지정한다. 신규(빈 IP)면 IP 직접 입력 + 콤마/줄바꿈으로 여러 IP 일괄 적용도 가능.
 */
export function OverrideEditor({ row, vcenters = [], onClose, onSaved }) {
  const isNew = !!row.__new;
  const [ip, setIp] = useState(row.ip || '');
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState(row.mgmtStatus || '');
  const [owner, setOwner] = useState(row.owner_ || '');
  const [label, setLabel] = useState(row.label || '');
  const [deviceType, setDeviceType] = useState(row.deviceType || '');
  const [hostnameOverride, setHostnameOverride] = useState((row.managed && row.hostName) || '');
  const [claimedVcenterId, setClaimedVcenterId] = useState(row.vcenterId || '');
  const [reservedUntil, setReservedUntil] = useState(row.reservedUntil ? String(row.reservedUntil).slice(0, 10) : '');
  const [note, setNote] = useState(row.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { fetchJson('/tools/ipam/manage-meta').then(setMeta).catch(() => setMeta({ statuses: Object.keys(MGMT), deviceTypes: Object.keys(DEVTYPE_LABEL) })); }, []);
  // 기존 IP면 서버에서 현재 override를 한 번 더 정확히 불러와 폼을 채운다(목록값 보강).
  useEffect(() => {
    if (isNew || !row.ip) return;
    fetchJson(`/tools/ipam/ip/${encodeURIComponent(row.ip)}`).then((r) => {
      const o = r.override; if (!o) return;
      setStatus(o.status || ''); setOwner(o.owner || ''); setLabel(o.label || '');
      setDeviceType(o.deviceType || ''); setHostnameOverride(o.hostnameOverride || '');
      setClaimedVcenterId(o.claimedVcenterId || ''); setNote(o.note || '');
      setReservedUntil(o.reservedUntil ? String(o.reservedUntil).slice(0, 10) : '');
    }).catch(() => {});
  }, [row.ip, isNew]);

  const ipList = String(ip).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bulk = ipList.length > 1;
  const fields = { status, owner, label, deviceType, hostnameOverride, claimedVcenterId, note, reservedUntil: reservedUntil || null };
  const save = async () => {
    if (!ipList.length) { setErr('IP를 입력하세요.'); return; }
    setBusy(true); setErr(null);
    let r;
    if (bulk) r = await postJson('/tools/ipam/bulk', { ips: ipList, ...fields }).catch((e) => ({ ok: false, reason: e.message }));
    else r = await putJson(`/tools/ipam/ip/${encodeURIComponent(ipList[0])}`, fields).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '저장 실패');
  };
  const remove = async () => {
    if (!ipList.length || bulk) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/tools/ipam/ip/${encodeURIComponent(ipList[0])}`, { method: 'DELETE', headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {} }).then((x) => x.json()).catch((e) => ({ ok: false, reason: e.message }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.reason || '삭제 실패');
  };

  const L = { fontWeight: 600, paddingTop: 9, whiteSpace: 'nowrap' };
  const statuses = meta?.statuses || Object.keys(MGMT);
  const devTypes = meta?.deviceTypes || Object.keys(DEVTYPE_LABEL);
  return (
    <Modal title={isNew ? 'IP 수동 등록 / 일괄 관리' : `IP 관리상태 — ${row.ip}`} onClose={onClose} width={760} resizable minWidth={520} minHeight={440}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        vCenter 수집·스캔으로 자동 채워지는 값과 <b>별개로</b> 운영자가 직접 지정하는 관리 정보입니다(수집 갱신에도 유지).
        {isNew && ' 여러 IP를 콤마/줄바꿈으로 넣으면 한 번에 같은 상태로 일괄 적용됩니다.'}
      </div>
      {err && <div className="login-error" style={{ marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 14, alignItems: 'start' }}>
        <label style={L}>IP{isNew && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}> (여러 개 가능)</span>}</label>
        {isNew
          ? <textarea className="input" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="예: 10.20.0.5  또는  10.20.0.5, 10.20.0.6" style={{ resize: 'vertical', minHeight: 56, width: '100%', boxSizing: 'border-box' }} />
          : <input className="input" value={ip} disabled style={{ width: '100%', boxSizing: 'border-box', opacity: .8 }} />}

        <label style={L}>관리상태</label>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 미지정 —</option>
          {statuses.map((s) => <option key={s} value={s}>{(MGMT[s]?.[0]) || s}</option>)}
        </select>

        <label style={L}>디바이스 종류</label>
        <select className="select" value={deviceType} onChange={(e) => setDeviceType(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 미지정 —</option>
          {devTypes.map((d) => <option key={d} value={d}>{DEVTYPE_LABEL[d] || d}</option>)}
        </select>

        <label style={L}>담당자/팀</label>
        <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="예: 인프라팀 / 홍길동" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>라벨(표시명)</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="자동 호스트명 대신 표시할 이름" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>호스트명 override</label>
        <input className="input" value={hostnameOverride} onChange={(e) => setHostnameOverride(e.target.value)} placeholder="자동 수집 호스트명을 덮어쓸 이름(선택)" style={{ width: '100%', boxSizing: 'border-box' }} />

        <label style={L}>vCenter 귀속</label>
        <select className="select" value={claimedVcenterId} onChange={(e) => setClaimedVcenterId(e.target.value)} style={{ width: '100%' }}>
          <option value="">— 없음(네트워크) —</option>
          {vcenters.filter((v) => v.vcenterId).map((v) => <option key={v.vcenterId} value={v.vcenterId}>{v.vcenterName}</option>)}
        </select>

        <label style={L}>예약 만료일</label>
        <input className="input" type="date" value={reservedUntil} onChange={(e) => setReservedUntil(e.target.value)} style={{ width: 200, boxSizing: 'border-box' }} />

        <label style={L}>비고</label>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="상태 관련 한 줄 메모(상세 메모/태그는 목록의 '메모·태그' 사용)" style={{ resize: 'vertical', minHeight: 56, width: '100%', boxSizing: 'border-box' }} />

        <div />
        <div className="flex gap" style={{ marginTop: 4, alignItems: 'center' }}>
          <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>{busy ? '저장 중…' : (bulk ? `일괄 적용 (${ipList.length}개)` : '저장')}</button>
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
          {!isNew && row.managed && <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto', color: 'var(--red)' }} disabled={busy} onClick={remove} title="관리상태 삭제(자동 발견 상태로 되돌림)">관리상태 삭제</button>}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 12, lineHeight: 1.7 }}>
        ※ 관리상태를 <b>숨김</b>으로 두면 대장 목록에서 해당 IP가 제외됩니다(오탐/사용 안 함 IP 정리용).
      </div>
    </Modal>
  );
}

export function IpmsSettings({ onClose }) {
  const [s, setS] = useState(null);
  const [vcs, setVcs] = useState([]);
  const [vc, setVc] = useState('');
  const [msg, setMsg] = useState(null);
  // vCenter별 스캔 대역(사전 정리 + 주기 스캔) — rangeStore(/vc-ranges) 백엔드 재사용.
  const [vcRanges, setVcRanges] = useState(null);
  const [scanText, setScanText] = useState('');
  const [scanEnabled, setScanEnabled] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState(null);
  const loadVcRanges = () => fetchJson('/tools/ipam/vc-ranges').then(setVcRanges).catch(() => {});
  useEffect(() => {
    fetchJson('/admin/ipam/settings').then((r) => setS(r.settings)).catch((e) => setMsg(e.message));
    fetchJson('/vcenters').then((list) => { setVcs(list); if (list[0]) setVc(list[0].id); }).catch(() => {});
    loadVcRanges();
  }, []);
  // 선택한 vCenter의 저장된 스캔 대역을 폼에 채운다.
  useEffect(() => {
    if (!vcRanges) return;
    const e = (vcRanges.ranges || []).find((x) => x.vcenterId === vc);
    setScanText(e ? (e.ranges || []).join('\n') : '');
    setScanEnabled(e ? e.enabled !== false : true);
  }, [vc, vcRanges]);
  const saveScanRanges = async () => {
    if (!vc) return;
    setScanBusy(true); setScanMsg(null);
    try {
      const r = await putJson('/admin/ipam/vc-ranges', { vcenterId: vc, ranges: scanText, enabled: scanEnabled });
      setScanMsg(r.ok ? { ok: true, text: `저장됨 — 대역 ${(r.ranges || []).length}개` } : { ok: false, text: r.reason });
      if (r.ok) await loadVcRanges();
    } catch (e) { setScanMsg({ ok: false, text: e.message }); } finally { setScanBusy(false); }
  };
  const scanNow = async () => {
    setScanBusy(true); setScanMsg(null);
    try { const r = await postJson('/admin/ipam/vc-ranges/scan', {}); setScanMsg(r.ok ? { ok: true, text: '스캔을 시작했습니다(백그라운드).' } : { ok: false, text: r.reason }); }
    catch (e) { setScanMsg({ ok: false, text: e.message }); } finally { setScanBusy(false); }
  };
  if (!s) return <Modal title="IPMS 설정" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;
  const vcRangeEntry = (vcRanges?.ranges || []).find((x) => x.vcenterId === vc);

  const globalText = (s.global || []).join('\n');
  const vcText = (s.vcenters?.[vc] || []).join('\n');
  const publicText = (s.publicRanges || []).join('\n');
  const privateText = (s.privateRanges || []).join('\n');
  const setGlobal = (t) => setS({ ...s, global: t.split('\n') });
  const setVcText = (t) => setS({ ...s, vcenters: { ...(s.vcenters || {}), [vc]: t.split('\n') } });
  const setPublic = (t) => setS({ ...s, publicRanges: t.split('\n') });
  const setPrivate = (t) => setS({ ...s, privateRanges: t.split('\n') });
  const save = async () => {
    const r = await putJson('/admin/ipam/settings', s).catch((e) => ({ error: e.message }));
    if (r.ok) onClose(); else setMsg(r.error || '저장 실패');
  };

  return (
    <Modal title="IPMS 설정 — 무시 대역 · vCenter 스캔 대역" onClose={onClose} width={560}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>여기 입력한 대역의 IP는 IP 관리대장/검색/공유DB에서 제외됩니다. 형식: CIDR(10.0.0.0/8), 범위(10.0.0.1-10.0.0.50), 단일 IP. 한 줄에 하나.</div>
      {msg && <div className="login-error" style={{ marginBottom: 8 }}>{msg}</div>}
      <label style={{ display: 'block', marginBottom: 12 }}>전체 무시 대역 (모든 vCenter)
        <textarea className="input" rows={5} value={globalText} onChange={(e) => setGlobal(e.target.value)} placeholder={'10.255.0.0/16\n8.8.8.8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
      </label>
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10 }}>
        <div className="flex gap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>vCenter별 무시 대역</b>
          <select className="select" value={vc} onChange={(e) => setVc(e.target.value)} style={{ maxWidth: 240 }}>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <textarea className="input" rows={5} value={vcText} onChange={(e) => setVcText(e.target.value)} placeholder={'172.16.0.0/12'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>선택한 <b>{vcs.find((v) => v.id === vc)?.name || vc}</b> 에서만 위 대역을 숨깁니다.</div>
      </div>

      {/* vCenter별 스캔 대역 — 사전 정리 + 주기 스캔(rangeStore) */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10, marginTop: 12 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>vCenter별 스캔 대역 (주기 스캔)</b>
          <span className="muted" style={{ fontSize: 11 }}>대상: <b>{vcs.find((v) => v.id === vc)?.name || vc}</b>{vcRangeEntry ? ` · 약 ${(vcRangeEntry.ipCount || 0).toLocaleString()} IP` : ''}</span>
        </div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>여기 정리한 대역은 주기 IP 스캔이 함께 스캔해 사용 현황(네트워크 맵·관리대장)을 자동 갱신합니다. 위 vCenter 선택기와 연동됩니다. 형식: CIDR·범위·단일 IP, 한 줄에 하나.</div>
        <textarea className="input" rows={5} value={scanText} onChange={(e) => setScanText(e.target.value)} placeholder={'10.94.42.0/24\n10.94.43.1-10.94.43.200'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
        <div className="flex gap" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12 }}><input type="checkbox" checked={scanEnabled} onChange={(e) => setScanEnabled(e.target.checked)} /> 주기 스캔 포함</label>
          <button className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={scanBusy || !vc} onClick={saveScanRanges}>대역 저장</button>
          <button className="logout-btn" style={{ padding: '7px 12px' }} disabled={scanBusy} onClick={scanNow}>🛰️ 지금 스캔</button>
          <span className="muted" style={{ fontSize: 11 }}>스캔 주기는 ‘IP 스캔’ 설정의 간격을 따릅니다.</span>
        </div>
        {scanMsg && <div style={{ marginTop: 8, padding: '7px 10px', borderRadius: 8, fontSize: 12, background: scanMsg.ok ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)', color: scanMsg.ok ? '#4ade80' : '#f87171' }}>{scanMsg.text}</div>}
      </div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 10, marginTop: 12 }}>
        <b style={{ fontSize: 13 }}>공인 / 사설 IP 분류</b>
        <div className="muted" style={{ fontSize: 11, margin: '4px 0 10px' }}>관리대장의 <b>분류</b> 열에 사용됩니다. 명시한 대역이 우선이고, 둘 다 해당 없으면 RFC1918(10/8·172.16/12·192.168/16)은 <b>사설</b>, 그 외는 <b>공인</b>으로 자동 분류됩니다. 사설이 우선합니다.</div>
        <div className="flex gap wrap">
          <label style={{ flex: 1, minWidth: 220 }}>공인(Public) 대역
            <textarea className="input" rows={4} value={publicText} onChange={(e) => setPublic(e.target.value)} placeholder={'203.0.113.0/24\n8.8.8.8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
          </label>
          <label style={{ flex: 1, minWidth: 220 }}>사설(Private) 대역
            <textarea className="input" rows={4} value={privateText} onChange={(e) => setPrivate(e.target.value)} placeholder={'100.64.0.0/10\n10.0.0.0/8'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
          </label>
        </div>
      </div>
      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} onClick={save}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={onClose}>취소</button>
      </div>
    </Modal>
  );
}

/** IP 능동 스캔(TCP 커넥트) 설정 + 수동 실행 + 결과. 물리/기타 서버 IP를 대장에 채운다. */
const LOCAL_AGENT = '__local__';
export function IpScanSettings({ onClose }) {
  const [s, setS] = useState(null);
  const [agent, setAgent] = useState(LOCAL_AGENT);
  const [agents, setAgents] = useState([LOCAL_AGENT]);
  const [newAgent, setNewAgent] = useState('');
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  const [reports, setReports] = useState({});
  const [centralEnabled, setCentralEnabled] = useState(true);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async (ag, first = false) => {
    try {
      const r = await fetchJson('/admin/ipam/scan/settings', { agent: ag });
      if (first) setS(r.settings);
      if (r.agents) setAgents(r.agents);
      setStatus(r.status); setInfo(r.info); setReports(r.reports || {}); setCentralEnabled(r.centralEnabled !== false);
    } catch (e) { setMsg(e.message); }
  };
  useEffect(() => { load(agent, true); const t = setInterval(() => load(agent, false), 2000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [agent]);
  if (!s) return <Modal title="IP 스캔" onClose={onClose}>{msg ? <ErrorBox message={msg} /> : <Loading />}</Modal>;

  const isLocal = agent === LOCAL_AGENT;
  const agentLabel = (a) => (a === LOCAL_AGENT ? '이 포탈에서 직접' : a);
  const switchAgent = (a) => { setS(null); setMsg(null); setAgent(a); };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/admin/ipam/scan/settings', { ...s, agent });
      setS(r.settings); setStatus(r.status);
      const cfg = r.settings || s;
      const mins = Math.max(1, Math.round((cfg.intervalMs || 3_600_000) / 60000));
      const nextAt = new Date(Date.now() + (cfg.intervalMs || 3_600_000)).toLocaleString('ko-KR');
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
    const nRanges = (s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length;
    setBusy(true); setMsg(`입력한 대역(${nRanges}개)을 저장하고 스캔을 시작하는 중…`);
    try {
      // 입력한 대역을 먼저 저장한 뒤 스캔(미저장 입력이 무시되어 첫 대역만 스캔되던 문제 방지).
      const sv = await putJson('/admin/ipam/scan/settings', { ...s, agent });
      if (sv?.settings) setS(sv.settings);
      const r = await postJson('/admin/ipam/scan/run', {});
      if (r.status) setStatus(r.status); if (r.info) setInfo(r.info);
      setMsg(r.ok ? `대역 ${nRanges}개 스캔을 백그라운드에서 시작했습니다(전체 IP는 진행 막대에 표시). 창을 닫아도 계속 실행됩니다.` : `시작 실패: ${r.reason}`);
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); load(agent, false); }
  };
  const last = status?.lastRun;

  return (
    <Modal title="🛰️ IP 능동 스캔 (TCP 커넥트)" onClose={onClose} width={680} resizable minWidth={460} minHeight={420}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        vCenter가 모르는 <b>물리서버·타 가상화·네트워크 장비</b> IP를 TCP 커넥트 스캔으로 찾아 IP 관리대장에 채웁니다.
        <b> 할당 에이전트</b>를 고르면 해당 에이전트가 이 설정을 읽어가 자기 사이트에서 스캔하고 결과를 포탈에 보고합니다.
        <span className="badge amber" style={{ marginLeft: 6 }}>승인된 대역만</span>
      </div>
      {msg && <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 14, alignItems: 'start' }}>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>할당 에이전트</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <select className="select" value={agent} onChange={(e) => switchAgent(e.target.value)} style={{ maxWidth: 260 }}>
            {agents.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
          </select>
          <input className="input" style={{ width: 160 }} placeholder="새 에이전트 이름" value={newAgent} onChange={(e) => setNewAgent(e.target.value)} />
          <button className="tab" style={{ flex: 'none', padding: '6px 12px' }} disabled={!newAgent.trim()} onClick={() => { const a = newAgent.trim(); setNewAgent(''); if (a) switchAgent(a); }}>추가/선택</button>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>사용</label>
        <label className="flex gap" style={{ alignItems: 'center', paddingTop: 9 }}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> 주기적으로 스캔
        </label>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>스캔 대역 <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>(한 줄에 하나)</span></label>
        <div>
          <textarea className="input" value={(s.ranges || []).join('\n')} onChange={(e) => setS({ ...s, ranges: e.target.value.split(/\n/) })}
            placeholder={'10.0.0.0/24\n192.168.1.1-192.168.1.50\n172.16.5.10'} style={{ resize: 'vertical', minHeight: 96, fontFamily: 'monospace', fontSize: 12, width: '100%', boxSizing: 'border-box', display: 'block' }} />
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>등록 대역 <b>{(s.ranges || []).map((x) => String(x).trim()).filter(Boolean).length}</b>개 — 모든 줄을 스캔합니다. <b>지금 스캔</b>은 입력값을 자동 저장 후 실행합니다.</div>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>포트</label>
        <input className="input" value={(s.ports || []).join(', ')} onChange={(e) => setS({ ...s, ports: e.target.value.split(/[\s,]+/).map(Number).filter(Boolean) })}
          style={{ width: '100%', boxSizing: 'border-box' }} />
        <label style={{ fontWeight: 600, paddingTop: 9 }}>주기 / 동시성 / 타임아웃</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <input className="input" type="number" min={1} style={{ width: 90 }} value={Math.round(s.intervalMs / 60000)} onChange={(e) => setS({ ...s, intervalMs: Math.max(1, Number(e.target.value) || 60) * 60000 })} /><span className="muted">분</span>
          <input className="input" type="number" min={1} max={1024} style={{ width: 80 }} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number(e.target.value) || 128 })} /><span className="muted">동시</span>
          <input className="input" type="number" min={100} max={10000} style={{ width: 90 }} value={s.timeoutMs} onChange={(e) => setS({ ...s, timeoutMs: Number(e.target.value) || 700 })} /><span className="muted">ms</span>
        </div>
        <label style={{ fontWeight: 600, paddingTop: 9 }}>역DNS / 보존</label>
        <div className="flex gap wrap" style={{ alignItems: 'center' }}>
          <label className="flex gap" style={{ alignItems: 'center' }}><input type="checkbox" checked={s.reverseDns} onChange={(e) => setS({ ...s, reverseDns: e.target.checked })} /> 역DNS 호스트명</label>
          <input className="input" type="number" min={0} style={{ width: 80 }} value={s.retentionDays} onChange={(e) => setS({ ...s, retentionDays: Number(e.target.value) || 0 })} /><span className="muted">일 보존</span>
        </div>
      </div>

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
            <table>
              <thead><tr><th>에이전트</th><th>마지막 보고</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th>상태</th></tr></thead>
              <tbody>
                {Object.entries(reports).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).map(([name, r]) => {
                  const ageMin = (Date.now() - (r.at || 0)) / 60000;
                  const fresh = ageMin < 90; // 90분 내 보고면 정상
                  return (
                    <tr key={name}>
                      <td><b>{name === LOCAL_AGENT ? '이 포탈' : name}</b></td>
                      <td className="muted" style={{ fontSize: 12 }}>{r.at ? new Date(r.at).toLocaleString('ko-KR') : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{(r.scanned ?? 0).toLocaleString()} / <b>{(r.alive ?? 0).toLocaleString()}</b></td>
                      <td><span className={`badge ${fresh ? 'green' : 'gray'}`}>{fresh ? '정상' : '오래됨'}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 12, marginTop: 14, fontSize: 13 }}>
        <span className="muted">이 포탈 상태 <b style={{ color: status?.running ? 'var(--amber)' : 'var(--text)' }}>{status?.running ? '스캔 중' : (status?.enabled ? '활성' : '비활성')}</b></span>{' · '}
        <span className="muted">저장된 결과 <b style={{ color: 'var(--text)' }}>{info?.count ?? 0}</b>개</span>
        {info?.byAgent && Object.keys(info.byAgent).length > 0 && <span className="muted"> ({Object.entries(info.byAgent).map(([a, n]) => `${a === LOCAL_AGENT ? '포탈' : a}:${n}`).join(', ')})</span>}
        {last && !last.skipped && !last.error && <span className="muted"> · 최근(포탈): {last.scanned}개 중 {last.alive}개 응답</span>}
        {last?.error && <span style={{ color: 'var(--red)' }}> · 오류: {last.error}</span>}
        <ScanProgressBar progress={status?.progress} />
      </div>

      <div className="flex gap" style={{ marginTop: 14 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '9px 18px' }} disabled={busy} onClick={save}>저장</button>
        <button className="logout-btn" style={{ padding: '9px 14px' }} disabled={busy || status?.running || !isLocal} title={isLocal ? '' : '원격 에이전트는 자체 주기로 스캔합니다'} onClick={runNow}>지금 스캔(포탈)</button>
        <button className="logout-btn" style={{ padding: '9px 14px', marginLeft: 'auto' }} onClick={onClose}>닫기</button>
      </div>
    </Modal>
  );
}

/** 진행 중 스캔 진행률 막대(스캔한 IP 수 / 전체 + %). progress 없으면 렌더 안 함. */
export function ScanProgressBar({ progress }) {
  if (!progress || !progress.total) return null;
  const pct = progress.pct ?? (progress.total ? Math.round((progress.done / progress.total) * 100) : 0); // total=0 시 NaN% 방지
  const elapsed = progress.startedAt ? Math.round((Date.now() - progress.startedAt) / 1000) : 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 4 }}>
        <span className="muted">진행 {progress.done.toLocaleString()} / {progress.total.toLocaleString()} · 응답 <b style={{ color: 'var(--green)' }}>{progress.alive}</b> · {elapsed}초 경과</span>
        <b className="tabular" style={{ color: 'var(--amber)' }}>{pct}%</b>
      </div>
      <div className="usage-bar" style={{ height: 10 }}><span style={{ width: `${Math.min(pct, 100)}%`, background: 'var(--amber)' }} /></div>
    </div>
  );
}

/** 대장 상단 '스캔 상태' 버튼이 여는 모달: 진행 중 스캔 + 완료된 스캔 이력. */
export function ScanStatusModal({ onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => fetchJson('/admin/ipam/scan/status').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t); }, []);
  const fmt = (t) => (t ? new Date(t).toLocaleString('ko-KR') : '—');
  const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}초`);
  const st = d?.status; const runs = d?.runs || [];
  return (
    <Modal title="🛰️ IP 스캔 상태 — 진행 중 · 이력" onClose={onClose} width={720} resizable minWidth={480} minHeight={400}>
      {err && <ErrorBox message={err} />}
      {!d ? <Loading /> : (
        <>
          <div className="card" style={{ padding: 12, marginBottom: 14 }}>
            <div className="flex between" style={{ alignItems: 'center' }}>
              <b style={{ fontSize: 14 }}>{st?.running ? '🔄 스캔 진행 중' : '대기 중(진행 중인 스캔 없음)'}</b>
              <span className="muted" style={{ fontSize: 12 }}>저장된 결과 {d.info?.count ?? 0}개</span>
            </div>
            {st?.running && <ScanProgressBar progress={st.progress} />}
            {!st?.running && st?.lastRun && !st.lastRun.error && !st.lastRun.skipped && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>최근(포탈): {st.lastRun.scanned}개 중 {st.lastRun.alive}개 응답 · {dur(st.lastRun.durationMs)} · {fmt(st.lastRun.at)}</div>
            )}
          </div>

          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>완료된 스캔 이력 (최근 {runs.length}건 · 포탈/에이전트 통합)</div>
          <div className="table-wrap" style={{ maxHeight: '46vh' }}>
            <table>
              <thead><tr><th>완료 시각</th><th>에이전트</th><th style={{ textAlign: 'right' }}>스캔 / 응답</th><th style={{ textAlign: 'right' }}>소요</th></tr></thead>
              <tbody>
                {runs.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 20 }}>완료된 스캔 이력이 없습니다.</td></tr>}
                {runs.map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmt(r.at)}</td>
                    <td><b>{r.agent === LOCAL_AGENT ? '이 포탈' : r.agent}</b></td>
                    <td style={{ textAlign: 'right' }} className="tabular">{(r.scanned ?? 0).toLocaleString()} / <b style={{ color: 'var(--green)' }}>{(r.alive ?? 0).toLocaleString()}</b></td>
                    <td style={{ textAlign: 'right' }} className="muted">{dur(r.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
