import React, { useEffect, useState } from 'react';
import { fetchJson, putJson, postJson, delJson, usePolling } from '../api.js';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('ko-KR') : '—');
const TYPE_LBL = { 'login-fails': '로그인 실패', 'net-issues': '네트워크 이슈' };

/** 게스트 조사 스케줄 작업 관리(공용). props.type으로 해당 유형만 표시/추가. */
export default function GuestScanJobs({ type }) {
  const { data: vcs } = usePolling('/vcenters', {}, 60_000);
  const [jobs, setJobs] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => fetchJson('/admin/security/guest-scans').then((r) => setJobs((r.jobs || []).filter((j) => !type || j.type === type))).catch(() => setJobs([]));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [type]);

  const blank = { name: '', type: type || 'login-fails', vcenterId: '', os: 'all', intervalMin: 60, days: 7, maxVms: 100, enabled: true, guestUser: '', guestPass: '' };
  const save = async () => { try { await putJson('/admin/security/guest-scans', form); } catch (e) { /* */ } setForm(null); load(); };
  const run = async (id) => { try { await postJson(`/admin/security/guest-scans/${id}/run`, {}); } catch { /* */ } load(); };
  const del = async (id) => { try { await delJson(`/admin/security/guest-scans/${id}`); } catch { /* */ } load(); };
  const toggle = async (j) => { try { await putJson('/admin/security/guest-scans', { id: j.id, name: j.name, type: j.type, vcenterId: j.vcenterId, os: j.os, intervalMin: j.intervalMin, days: j.days, maxVms: j.maxVms, enabled: !j.enabled }); } catch { /* */ } load(); };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12 }}>
      <div className="flex between" style={{ alignItems: 'center', marginBottom: 8 }}>
        <div className="section-title" style={{ marginTop: 0, fontSize: 15 }}>게스트 조사 스케줄{type ? ` — ${TYPE_LBL[type]}` : ''}</div>
        <button className="login-btn" style={{ padding: '6px 12px' }} onClick={() => setForm(blank)}>+ 조사 추가</button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>지정한 주기로 vCenter별·OS별 게스트 OS를 조사해 기록·저장합니다(VMware Tools 가동 VM 대상). 게스트 계정 비우면 GPU 게스트 설정 계정 사용.</p>
      {!jobs ? <div className="muted">불러오는 중…</div> : jobs.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>등록된 조사가 없습니다.</div> : (
        <div className="table-wrap"><table><thead><tr><th>이름</th><th>vCenter</th><th>OS</th><th>주기</th><th>최근</th><th>건수</th><th>상태</th><th>작업</th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id}>
              <td><b>{j.name}</b></td><td style={{ fontSize: 12 }}>{j.vcenterId || '—'}</td><td style={{ fontSize: 12 }}>{j.os}</td><td style={{ fontSize: 12 }}>{j.intervalMin}분</td>
              <td className="muted" style={{ fontSize: 11 }}>{fmtTime(j.lastRun)}{j.lastErr ? ` · ${j.lastErr.slice(0, 30)}` : ''}</td>
              <td style={{ textAlign: 'right' }}>{j.lastFound ?? '—'}</td>
              <td>{j.enabled ? <span className="badge green">동작</span> : <span className="badge gray">중지</span>}</td>
              <td><div className="flex gap">
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => run(j.id)}>지금</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => toggle(j)}>{j.enabled ? '중지' : '시작'}</button>
                <button className="tab" style={{ padding: '3px 8px', fontSize: 11, color: 'var(--red)' }} onClick={() => del(j.id)}>삭제</button>
              </div></td>
            </tr>
          ))}</tbody></table></div>
      )}
      {form && (
        <div className="card" style={{ padding: 12, marginTop: 10, border: '1px solid var(--accent,#2563eb)' }}>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" placeholder="이름" style={{ width: 150 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            {!type && <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="login-fails">로그인 실패</option><option value="net-issues">네트워크 이슈</option></select>}
            <select className="select" value={form.vcenterId} onChange={(e) => setForm({ ...form, vcenterId: e.target.value })}><option value="">vCenter 선택</option>{(vcs || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            <select className="select" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })}><option value="all">전체 OS</option><option value="linux">Linux</option><option value="windows">Windows</option></select>
            <span className="muted">주기</span><input className="input" type="number" style={{ width: 64 }} value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} /><span className="muted">분</span>
            <span className="muted">최대</span><input className="input" type="number" style={{ width: 64 }} value={form.maxVms} onChange={(e) => setForm({ ...form, maxVms: e.target.value })} /><span className="muted">대</span>
          </div>
          <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span className="muted">게스트 계정(선택)</span>
            <input className="input" placeholder="사용자" style={{ width: 130 }} value={form.guestUser} onChange={(e) => setForm({ ...form, guestUser: e.target.value })} />
            <input className="input" type="password" placeholder="비번" style={{ width: 130 }} value={form.guestPass} onChange={(e) => setForm({ ...form, guestPass: e.target.value })} />
            <button className="login-btn" style={{ padding: '7px 16px' }} disabled={!form.vcenterId} onClick={save}>저장</button>
            <button className="logout-btn" style={{ padding: '7px 16px' }} onClick={() => setForm(null)}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
}
