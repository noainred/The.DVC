import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson, delJson, usePolling } from '../api.js';
import { STable } from '../components/STable.jsx';
import BoldText from '../components/boldText.jsx';
import { ErrorBox } from '../components/ui.jsx';
import { guestAuthLines } from './authSkipText.js'; // v2.591(감사 F2): 게스트 계정 인증 실패 정지·차단기

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const TYPE_LBL = { 'login-fails': '로그인 실패', 'net-issues': '네트워크 이슈' };

/**
 * 변경 요청 응답이 거부인가 — 사유 문구 또는 null(점검 A5-09). putJson·delJson 은 400·409 를 던지지 않고 본문을 돌려주고,
 * '지금 실행' 은 200 + { ok:false, reason } 를 줄 수 있다(이미 실행 중 · 작업 없음). 예전에는 응답을 보지 않고 창을 닫아
 * 저장·실행이 거부돼도 아무 말도 하지 않았다(무음 실패).
 */
export function guestScanFailText(r, fallback) {
  if (!r || typeof r !== 'object') return null;
  if (r.ok === false || r.error) return String(r.reason || r.error || fallback || '요청이 거부되었습니다.');
  return null;
}

/** 게스트 조사 스케줄 작업 관리(공용). props.type으로 해당 유형만 표시/추가. */
export default function GuestScanJobs({ type }) {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [jobs, setJobs] = useState(null);
  const [form, setForm] = useState(null);
  const [loadErr, setLoadErr] = useState(null); // v2.620(WEB2620-09): 조회 실패를 '없습니다' 로 보이지 않는다 — 권한·시한 실패는 사유와 함께.
  const load = () => fetchJson('/admin/security/guest-scans').then((r) => { setLoadErr(null); setJobs((r.jobs || []).filter((j) => !type || j.type === type)); }).catch((e) => { setLoadErr(e); setJobs([]); });
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [type]);

  const blank = { name: '', type: type || 'login-fails', vcenterId: '', os: 'all', intervalMin: 60, days: 7, maxVms: 100, enabled: true, guestUser: '', guestPass: '' };
  // 점검 A5-09: 저장·실행·삭제·중지 실패를 삼키지 않는다 — 오류(던짐·ok:false)를 보이고, 저장 실패면 입력 창을 닫지 않는다.
  // actErr = { err, where } — err 는 문자열 | Error(HttpError 403 이면 ErrorBox 가 권한 안내로 바꾼다), where 는 'form'(입력 창) | 'list'(표의 동작).
  const [actErr, setActErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn, fallback, { onOk, where = 'list' } = {}) => {
    if (busy) return false;
    setBusy(true); setActErr(null);
    try {
      const fail = guestScanFailText(await fn(), fallback);
      if (fail) { setActErr({ err: fail, where }); return false; }
      onOk?.();
      return true;
    } catch (e) { setActErr({ err: e, where }); return false; } finally { setBusy(false); load(); }
  };
  const save = () => act(() => putJson('/admin/security/guest-scans', form), '저장하지 못했습니다.', { onOk: () => setForm(null), where: 'form' });
  const run = (id) => act(() => postJson(`/admin/security/guest-scans/${id}/run`, {}), '실행하지 못했습니다.');
  const del = (id) => act(() => delJson(`/admin/security/guest-scans/${id}`), '삭제하지 못했습니다(이미 지워졌을 수 있습니다).');
  const toggle = (j) => act(() => putJson('/admin/security/guest-scans', { id: j.id, name: j.name, type: j.type, vcenterId: j.vcenterId, os: j.os, intervalMin: j.intervalMin, days: j.days, maxVms: j.maxVms, enabled: !j.enabled }), '상태를 바꾸지 못했습니다.');

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>게스트 조사 스케줄{type ? ` — ${TYPE_LBL[type]}` : ''}</div>
        <button className="login-btn" style={{ padding: '6px 12px' }} onClick={() => { setActErr(null); setForm(blank); }}>+ 조사 추가</button>
      </div>
      {/* 입력 창 밖 동작(지금·중지·삭제)의 실패 — 저장 실패는 입력 창 안에서 말한다(창을 닫지 않는다). */}
      {actErr?.where === 'list' && <div style={{ marginBottom: 8 }}><ErrorBox error={actErr.err} /></div>}
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>지정한 주기로 vCenter별·OS별 게스트 OS를 조사해 기록·저장합니다(VMware Tools 가동 VM 대상). 게스트 계정 비우면 GPU 게스트 설정 계정 사용.</p>
      {!jobs ? <div className="muted">불러오는 중…</div> : loadErr ? <ErrorBox error={loadErr} /> : jobs.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>등록된 조사가 없습니다.</div> : (
        <div className="table-wrap"><STable><thead><tr><th>이름</th><th>vCenter</th><th>OS</th><th>주기</th><th>최근</th><th>건수</th><th>상태</th><th>작업</th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id}>
              <td><b>{j.name}</b></td><td style={{ fontSize: 12 }}>{j.vcenterId || '—'}</td><td style={{ fontSize: 12 }}>{j.os}</td><td style={{ fontSize: 12 }}>{j.intervalMin}분</td>
              <td className="muted" style={{ fontSize: 11 }}>{fmtTime(j.lastRun)}{j.lastErr ? ` · ${j.lastErr.slice(0, 30)}` : ''}</td>
              <td style={{ textAlign: 'right' }}>{j.lastFound ?? '—'}</td>
              <td>{j.enabled ? <span className="badge green">동작</span> : <span className="badge gray">중지</span>}
                {j.lastAuth?.jobStopped && <span className="badge red" style={{ marginLeft: 4, whiteSpace: 'nowrap' }}>인증 실패 정지</span>}</td>
              <td><div className="flex gap">
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy} onClick={() => run(j.id)}>지금</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy} onClick={() => toggle(j)}>{j.enabled ? '중지' : '시작'}</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11, color: 'var(--red)' }} disabled={busy} onClick={() => del(j.id)}>삭제</button>
              </div></td>
            </tr>
          ))}</tbody></STable></div>
      )}
      {(jobs || []).filter((j) => guestAuthLines(j.lastAuth).length).map((j) => (
        <div key={`auth-${j.id}`} style={{ fontSize: 12, marginTop: 8, whiteSpace: 'normal', lineHeight: 1.55 }}>
          <b>{j.name}</b>
          {guestAuthLines(j.lastAuth, { manual: '지금' }).map((t, i) => <div key={i} className="muted"><BoldText text={t} /></div>)}
        </div>
      ))}
      {form && (
        <div className="card" style={{ padding: 12, marginTop: 10, border: '1px solid var(--accent,#2563eb)' }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" placeholder="이름" style={{ width: 150 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {!type && <Select sort={false} className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="login-fails">로그인 실패</option><option value="net-issues">네트워크 이슈</option></Select>}
            <Select className="select" value={form.vcenterId} onChange={(e) => setForm({ ...form, vcenterId: e.target.value })}><option value="">vCenter 선택</option>{(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
            <Select sort={false} className="select" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })}><option value="all">전체 OS</option><option value="linux">Linux</option><option value="windows">Windows</option></Select>
            <span className="muted">주기</span><input className="input" type="number" style={{ width: 64 }} value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} /><span className="muted">분</span>
            <span className="muted">최대</span><input className="input" type="number" style={{ width: 64 }} value={form.maxVms} onChange={(e) => setForm({ ...form, maxVms: e.target.value })} /><span className="muted">대</span>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span className="muted">게스트 계정(선택)</span>
            <input className="input" placeholder="사용자" style={{ width: 130 }} value={form.guestUser} onChange={(e) => setForm({ ...form, guestUser: e.target.value })} />
            <input className="input" type="password" placeholder="비번" style={{ width: 130 }} value={form.guestPass} onChange={(e) => setForm({ ...form, guestPass: e.target.value })} />
            <button className="login-btn" style={{ padding: '7px 16px' }} disabled={!form.vcenterId || busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
            <button className="logout-btn" style={{ padding: '7px 16px' }} onClick={() => { setForm(null); setActErr(null); }}>취소</button>
          </div>
          {actErr?.where === 'form' && <div style={{ marginTop: 8 }}><ErrorBox error={actErr.err} /></div>}
        </div>
      )}
    </div>
  );
}

import Select from '../components/Select.jsx';