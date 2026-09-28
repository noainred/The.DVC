// IpamEditors.jsx — IP관리 › IP 단위 편집기(메모·태그 / 관리상태 override). v2.639 에 IpamSettings.jsx(853줄)에서 나눴다 — 본문 그대로.
import React, { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import { Modal } from '../../components/ui.jsx';
import { DEVTYPE_LABEL, MGMT } from './ipamShared.jsx';
import { reservedDayOf, reservedFieldForSave } from './ipamReserveText.js';

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
export function OverrideEditor({ row, vcenters = [], onClose, onSaved, tzOffsetMin = null }) {
  const isNew = !!row.__new;
  const [ip, setIp] = useState(row.ip || '');
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState(row.mgmtStatus || '');
  const [owner, setOwner] = useState(row.owner_ || '');
  const [label, setLabel] = useState(row.label || '');
  const [deviceType, setDeviceType] = useState(row.deviceType || '');
  const [hostnameOverride, setHostnameOverride] = useState((row.managed && row.hostName) || '');
  const [claimedVcenterId, setClaimedVcenterId] = useState(row.vcenterId || '');
  // v2.631(감사 R2631-02): 저장값은 '그 날 끝 = 다음 날 00:00' 이라 slice(0,10) 으로 되읽으면 오프셋에 따라 하루 밀린다 — 포탈 오프셋 기준 날짜로.
  const rowDay = reservedDayOf(row.reservedUntil, tzOffsetMin);
  const [reservedUntil, setReservedUntil] = useState(rowDay);
  const [loadedDay, setLoadedDay] = useState(rowDay);   // 폼을 연 시점의 저장값 — 바뀌지 않았으면 저장 본문에서 뺀다
  const [note, setNote] = useState(row.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [loadWarn, setLoadWarn] = useState(null);
  useEffect(() => { fetchJson('/tools/ipam/manage-meta').then(setMeta).catch(() => setMeta({ statuses: Object.keys(MGMT), deviceTypes: Object.keys(DEVTYPE_LABEL) })); }, []);
  // 기존 IP면 서버에서 현재 override를 한 번 더 정확히 불러와 폼을 채운다(목록값 보강).
  useEffect(() => {
    if (isNew || !row.ip) return;
    // v2.620(WEB2620-10): 응답이 늦게 오면(고RTT) 사용자가 이미 고친 칸을 서버 값으로 되돌렸다 — 목록값 그대로인 칸만 채운다.
    //   재조회 실패는 무음이었다(목록의 근사값으로 저장될 수 있다) — 사유를 적는다.
    const init = { status: row.mgmtStatus || '', owner: row.owner_ || '', label: row.label || '', deviceType: row.deviceType || '',
      hostnameOverride: (row.managed && row.hostName) || '', claimedVcenterId: row.vcenterId || '', note: row.note || '',
      reservedUntil: rowDay };
    const keep = (k, v) => (cur) => (cur === init[k] ? v : cur);
    let alive = true;
    fetchJson(`/tools/ipam/ip/${encodeURIComponent(row.ip)}`).then((r) => {
      if (!alive) return;
      const o = r.override; if (!o) return;
      setStatus(keep('status', o.status || '')); setOwner(keep('owner', o.owner || '')); setLabel(keep('label', o.label || ''));
      setDeviceType(keep('deviceType', o.deviceType || '')); setHostnameOverride(keep('hostnameOverride', o.hostnameOverride || ''));
      setClaimedVcenterId(keep('claimedVcenterId', o.claimedVcenterId || '')); setNote(keep('note', o.note || ''));
      const srvDay = r.reservedUntilDay != null ? String(r.reservedUntilDay) : reservedDayOf(o.reservedUntil, r.tzOffsetMin ?? tzOffsetMin);
      setReservedUntil(keep('reservedUntil', srvDay)); setLoadedDay(srvDay);
    }).catch((e) => { if (alive) setLoadWarn(`현재 저장값을 다시 읽지 못했습니다(${e?.message || '조회 실패'}) — 폼은 목록의 값입니다. 저장 전에 확인하세요.`); });
    return () => { alive = false; };
  }, [row.ip, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const ipList = String(ip).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const bulk = ipList.length > 1;
  const fields = { status, owner, label, deviceType, hostnameOverride, claimedVcenterId, note,
    ...reservedFieldForSave(reservedUntil, loadedDay, { always: isNew || bulk }) };
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
    // v2.613 WEB2613-10: api.js 를 우회한 직접 fetch 금지 — 401 전역 처리·403 안내(HttpError)·X-Request-Id 가 빠진다.
    const r = await delJson(`/tools/ipam/ip/${encodeURIComponent(ipList[0])}`).catch((e) => ({ ok: false, reason: e.message }));
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
      {loadWarn && <div className="muted" style={{ marginBottom: 8, fontSize: 12, color: 'var(--amber)' }}>{loadWarn}</div>}
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
