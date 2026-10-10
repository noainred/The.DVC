import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { Loading, ErrorBox, SearchBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { unitText } from '../unitText.js';
import { dsOptionLabel } from './vmCloneDsText.js'; // v2.632 WEB2632-05
import { cloneRunMark } from '../authSkipText.js'; // v2.591(감사 F1): 인증 정지로 건너뛴 실행은 실패도 성공도 아니다

/**
 * 특수기능 › VM 복제(백업)(v2.299, admin 전용) — 사용자 요구사항:
 *  - 각 vCenter 에서 VM 을 지정해 복제 잡 등록(트리에는 'Clone' 배지 표시 — VCenterDetail)
 *  - 스케줄(매일 HH:MM / N시간 간격)로 정기 복제 = 백업처럼 사용
 *  - 대상: 다른 데이터스토어(서버측 클론) / NFS(Edge 노드 마운트 — 설정 › NFS 마운트에서 관리)
 *  - 보존 개수(최근 N개 유지 — 오래된 것부터 자동 삭제, datastore 는 우리가 만든 클론 원장만)
 * 실행은 서버의 전역 직렬 큐(한 번에 1개) — 여기서는 등록/실행/현황만 본다.
 */
const MODE_LABEL = { manual: '수동만', daily: '매일', interval: '간격' };
import ScopeOmitBanner from '../ScopeOmitBanner.jsx'; // v2.631 A6-2631-06: 범위 제외 문구 단일 소스
import { requireChanged } from '../changeResult.js'; // v2.732 B5-03 계열: 삭제 실패 본문을 성공으로 읽지 않는다

/**
 * v2.732(점검 2회차 B5-05): 잡 추가 폼의 선택 목록(vCenter·VM·데이터스토어) 상태 → 'VM 검색·선택' 라벨.
 * 예전에는 조회가 실패하면 `catch → setVms([])` 라 일시 장애가 그대로 **'0대 중 · 일치 VM 없음'** 으로 굳었다(재현).
 * state: 'idle'(vCenter 미선택) · 'loading' · 'ok' · 'error'. total 은 /vms 응답의 전체 개수(상한 5,000 으로 잘렸으면 밝힌다).
 */
export function vmPickLabel({ state, count, total } = {}) {
  if (state === 'loading') return 'VM 검색·선택 (불러오는 중…)';
  if (state === 'error') return 'VM 검색·선택 — VM 목록을 읽지 못했습니다';
  const n = Number.isFinite(count) ? count : 0;
  if (Number.isFinite(total) && total > n) return `VM 검색·선택 (전체 ${total}대 중 앞 ${n}대 — 이름순)`;
  return `VM 검색·선택 (${n}대 중)`;
}
/** 목록 조회 실패 문구 — 사유를 그대로 말한다('0개' 로 보이지 않게). */
export function listFailText(what, err) {
  const why = (err && (err.message || String(err))) || '사유 미상';
  return `${what} 목록을 읽지 못했습니다(${why}) — 비어 있다는 뜻이 아닙니다.`;
}

export default function VmCloneTool() {
  const [d, setD] = useState(null);          // { jobs, status, mounts }
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);    // 잡 추가/수정 폼 | null

  const load = () => fetchJson('/tools/vm-clone').then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, []);

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const running = d.status?.running;

  const runNow = async (id) => {
    setBusy(true); setMsg(null);
    try { const r = await postJson(`/tools/vm-clone/jobs/${encodeURIComponent(id)}/run`, {}); setMsg(r.ok ? '실행 큐에 넣었습니다(한 번에 1개씩 직렬 실행).' : `실행 불가: ${r.reason}`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };
  const remove = async (j) => {
    if (!window.confirm(`'${j.vmName}' 복제 잡을 삭제할까요?\n(만들어 둔 클론/NFS 사본은 지우지 않습니다 — 잡 정의만 삭제)`)) return;
    setBusy(true); setMsg(null);
    try { requireChanged(await delJson(`/tools/vm-clone/jobs/${encodeURIComponent(j.id)}`)); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex gap wrap" style={{ alignItems: 'center', marginBottom: 10 }}>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => setForm({ vcenterId: '', vmId: '', vmName: '', dest: { type: 'datastore', datastoreName: '' }, schedule: { mode: 'daily', time: '02:00' }, keep: 3, quiesce: false, enabled: true })}>+ 복제 잡 추가</button>
        {running
          ? <span className="badge amber">실행 중 — {d.jobs.find((j) => j.id === running.jobId)?.vmName || running.jobId} · {running.phase}</span>
          : d.status?.runningOutOfScope
            ? <span className="muted" style={{ fontSize: 12 }}>조회 범위 밖 잡이 실행 중 — 복제는 한 번에 1개씩 직렬로 돕니다 · 대기 {d.status?.queued?.length || 0}건</span>
            : <span className="muted" style={{ fontSize: 12 }}>유휴 · 대기 {d.status?.queued?.length || 0}건</span>}
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>

      <div className="card" style={{ padding: '9px 13px', marginBottom: 12, fontSize: 12, lineHeight: 1.7 }} >
        <b>동작</b>: 스냅샷(선택 시 정지점) → <b>스냅샷 시점 복제</b>(켜진 VM 무중단) → 스냅샷 삭제 → 보존 N개 유지.
        데이터스토어 대상은 vCenter 가 서버측에서 복사하고(포탈 경유 없음), NFS 대상은 이 노드의 마운트 경로로 베이스 파일(vmx·vmdk)을 받습니다(스냅샷 델타·스왑 제외).
        사본은 <b>꺼진 상태로</b> 만들어집니다 — 같은 네트워크에서 켜면 원본과 IP/호스트명이 충돌하니 주의하세요.
      </div>

      {form && <JobForm d={d} form={form} setForm={setForm} onSaved={() => { setForm(null); load(); }} />}

      {/* v2.599(AUTHZ-2599-05): 범위 제한 계정에는 범위 밖 vCenter 의 잡을 빼고 그 개수를 밝힌다 */}
      {/* v2.631 A6-2631-06: scoped·omittedOutOfScope 판정·문구는 scopeOmitText.js 하나가 소유한다 */}
      <ScopeOmitBanner data={d} unit="복제 잡" counter="개" why="조회 범위 밖 vCenter 의" />

      <div className="table-wrap" style={{ maxHeight: '46vh' }}>
        <STable>
          <thead><tr><th>VM</th><th>vCenter</th><th>대상</th><th>스케줄</th><th style={{ textAlign: 'right' }}>보존</th><th>정지점</th><th>보유 사본</th><th>최근 실행</th><th className="right">작업</th></tr></thead>
          <tbody>
            {d.jobs.length === 0 && <tr><td colSpan={9} className="center muted" style={{ padding: 22 }}>복제 잡이 없습니다 — "+ 복제 잡 추가"로 vCenter별 VM 을 지정하세요.</td></tr>}
            {d.jobs.map((j) => (
              <tr key={j.id} style={{ opacity: j.enabled ? 1 : 0.55 }}>
                <td><b>{j.vmName}</b>{!j.enabled && <span className="badge gray" style={{ marginLeft: 6 }}>비활성</span>}</td>
                <td className="muted">{j.vcenterId}</td>
                <td>{j.dest.type === 'datastore' ? <span className="badge blue">DS · {j.dest.datastoreName}</span> : <span className="badge purple">NFS · {(d.mounts.find((m) => m.id === j.dest.mountId) || {}).server || j.dest.mountId}{j.dest.subdir ? `/${j.dest.subdir}` : ''}</span>}</td>
                <td className="muted" style={{ fontSize: 12 }}>{MODE_LABEL[j.schedule.mode]}{j.schedule.mode === 'daily' ? ` ${j.schedule.time}` : j.schedule.mode === 'interval' ? ` ${j.schedule.hours}h` : ''}</td>
                <td style={{ textAlign: 'right' }}>{j.keep}</td>
                <td>{j.quiesce ? <span className="badge green">앱 정합</span> : <span className="badge gray">크래시 정합</span>}</td>
                <td className="muted" style={{ fontSize: 11.5 }}>{j.dest.type === 'datastore' ? `${(j.clones || []).length}개${(j.clones || []).length ? ` · 최신 ${(j.clones[j.clones.length - 1] || {}).name || ''}` : ''}` : 'NFS 디렉터리 참조'}</td>
                <td style={{ fontSize: 11.5 }}>
                  {j.lastRun
                    ? <span style={{ color: `var(--${cloneRunMark(j.lastRun).tone})` }} title={j.lastRun.detail}>{cloneRunMark(j.lastRun).icon} {new Date(j.lastRun.at).toLocaleString('ko-KR')} · {Math.round((j.lastRun.ms || 0) / 1000)}s<div className="muted" style={{ fontSize: 10.5, maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.lastRun.detail}</div></span>
                    : <span className="muted">—</span>}
                </td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  <button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={() => runNow(j.id)}>지금 실행</button>
                  {' '}<button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12 }} disabled={busy} onClick={() => setForm({ ...j })}>수정</button>
                  {' '}<button className="logout-btn" style={{ padding: '4px 9px', fontSize: 12, color: 'var(--red)' }} disabled={busy} onClick={() => remove(j)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </STable>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        NFS 마운트 등록/해제·로그·트러블슈팅은 <b>설정 › NFS 마운트(백업 대상)</b>에서. 복제 대상 VM 은 Platform 트리에 <span className="badge blue" style={{ fontSize: 10 }}>Clone</span> 배지로 표시됩니다.
      </div>
    </div>
  );
}

/** 잡 추가/수정 폼 — vCenter 선택 → VM 검색 선택 → 대상/스케줄/보존. */
function JobForm({ d, form, setForm, onSaved }) {
  const [vcs, setVcs] = useState([]);
  const [vms, setVms] = useState([]);
  const [dss, setDss] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // v2.732(점검 2회차 B5-05): 세 목록의 조회 상태 — 실패를 빈 목록으로 삼키지 않는다(사유 + 다시 시도).
  const [vcErr, setVcErr] = useState(null);
  const [vmList, setVmList] = useState({ state: 'idle', total: null, err: null });
  const [dsErr, setDsErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const loadVcs = () => { setVcErr(null); fetchJson('/vcenters').then((r) => setVcs(r || [])).catch((e) => setVcErr(e)); };
  useEffect(() => { loadVcs(); }, []);
  // vCenter 를 고르면 그 vCenter 의 VM(선택용)·데이터스토어(대상용) 로드.
  // 세대(genRef) 가드 — 고RTT 에서 이전 vCenter 응답이 늦게 와 지금 고른 vCenter 의 VM/DS 를
  // 덮어쓰면, 복제 잡이 엉뚱한 VM/데이터스토어를 대상으로 만들어질 수 있다. 늦은 응답은 버린다.
  const loadGen = useRef(0);
  useEffect(() => {
    const gen = ++loadGen.current;
    setVms([]); setDss([]); setDsErr(null);
    if (!form.vcenterId) { setVmList({ state: 'idle', total: null, err: null }); return; }
    setVmList({ state: 'loading', total: null, err: null });
    fetchJson('/vms', { vcenterId: form.vcenterId, limit: 5000, sortBy: 'name', order: 'asc' })
      .then((r) => { if (gen === loadGen.current) { const items = r.items || []; setVms(items); setVmList({ state: 'ok', total: Number.isFinite(r.total) ? r.total : items.length, err: null }); } })
      .catch((e) => { if (gen === loadGen.current) setVmList({ state: 'error', total: null, err: e }); });
    fetchJson('/datastores', { vcenterId: form.vcenterId })
      .then((r) => { if (gen === loadGen.current) setDss(r.items || []); }).catch((e) => { if (gen === loadGen.current) setDsErr(e); });
  }, [form.vcenterId, retry]);

  const ql = q.trim().toLowerCase();
  const filtered = useMemo(() => (ql ? vms.filter((v) => v.name.toLowerCase().includes(ql)) : vms).slice(0, 50), [vms, ql]);
  const sel = vms.find((v) => v.id === form.vmId);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson('/tools/vm-clone/jobs', form);
      if (r.ok === false) setErr(r.reason); else onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, background: 'rgba(96,165,250,.05)' }}>
      <div className="flex between" style={{ marginBottom: 10 }}>
        <b style={{ fontSize: 13 }}>{form.id ? `복제 잡 수정 — ${form.vmName}` : '복제 잡 추가'}</b>
        <button className="logout-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setForm(null)}>닫기</button>
      </div>
      <div className="flex gap wrap" style={{ alignItems: 'flex-end' }}>
        <label style={{ fontSize: 12 }}>vCenter<br />
          <Select className="select" value={form.vcenterId} disabled={!!form.id}
            onChange={(e) => setForm({ ...form, vcenterId: e.target.value, vmId: '', vmName: '', dest: { ...form.dest, datastoreName: '' } })}>
            <option value="">{vcErr ? '(vCenter 목록을 읽지 못함)' : '(선택)'}</option>
            {vcs.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
          </Select>
        </label>
        {form.vcenterId && !form.id && (
          <label style={{ fontSize: 12, flex: '1 1 260px' }}>{vmPickLabel({ state: vmList.state, count: vms.length, total: vmList.total })}<br />
            <SearchBox value={q} onChange={setQ} placeholder="VM 이름 검색" style={{ width: '100%' }} />
            {ql && !sel && vmList.state === 'ok' && (
              <div className="card" style={{ maxHeight: 160, overflow: 'auto', marginTop: 4, padding: 6 }}>
                {filtered.map((v) => (
                  <div key={v.id} className="vcd-link" style={{ padding: '3px 6px', cursor: 'pointer', fontSize: 12.5 }}
                    onClick={() => { setForm({ ...form, vmId: v.id, vmName: v.name }); setQ(v.name); }}>
                    🧊 {v.name} <span className="muted">· {v.host || '—'} · {v.cpuCount}vCPU/{Math.round((v.memMB || 0) / 1024)}GB · 💾 {unitText(v.storageGB, 'GB')}</span>
                  </div>
                ))}
                {!filtered.length && <div className="muted" style={{ fontSize: 12, padding: 6 }}>일치 VM 없음</div>}
              </div>
            )}
          </label>
        )}
        {form.vmId && <span className="badge green" style={{ alignSelf: 'center' }}>선택: {form.vmName}</span>}
      </div>

      <div className="flex gap wrap" style={{ alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ fontSize: 12 }}>백업 대상<br />
          <Select sort={false} className="select" value={form.dest.type} onChange={(e) => setForm({ ...form, dest: { type: e.target.value, datastoreName: '', mountId: '', subdir: '' } })}>
            <option value="datastore">다른 데이터스토어(서버측 클론)</option>
            <option value="nfs">NFS(Edge 노드 마운트 — 파일 백업)</option>
          </Select>
        </label>
        {form.dest.type === 'datastore' ? (
          <label style={{ fontSize: 12 }}>대상 데이터스토어<br />
            <Select className="select" value={form.dest.datastoreName || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, datastoreName: e.target.value } })}>
              <option value="">{dsErr ? '(데이터스토어 목록을 읽지 못함)' : '(선택)'}</option>
              {dss.map((ds) => <option key={ds.id} value={ds.name}>{dsOptionLabel(ds)}</option>)}
            </Select>
          </label>
        ) : (
          <>
            <label style={{ fontSize: 12 }}>NFS 마운트(설정 › NFS 마운트에서 등록)<br />
              <Select className="select" value={form.dest.mountId || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, mountId: e.target.value } })}>
                <option value="">(선택)</option>
                {(d.mounts || []).map((m) => <option key={m.id} value={m.id}>{m.server}:{m.exportPath} {m.mounted ? '· 마운트됨' : '· ⚠ 미마운트'}</option>)}
              </Select>
            </label>
            <label style={{ fontSize: 12 }}>하위 폴더(선택)<br />
              <input className="input" style={{ width: 140 }} placeholder="예: prod" value={form.dest.subdir || ''} onChange={(e) => setForm({ ...form, dest: { ...form.dest, subdir: e.target.value } })} />
            </label>
          </>
        )}
        <label style={{ fontSize: 12 }}>스케줄<br />
          <Select sort={false} className="select" value={form.schedule.mode} onChange={(e) => setForm({ ...form, schedule: { mode: e.target.value, ...(e.target.value === 'daily' ? { time: '02:00' } : e.target.value === 'interval' ? { hours: 24 } : {}) } })}>
            <option value="daily">매일 지정 시각</option>
            <option value="interval">N시간 간격</option>
            <option value="manual">수동만</option>
          </Select>
        </label>
        {form.schedule.mode === 'daily' && <label style={{ fontSize: 12 }}>시각<br /><input className="input" type="time" value={form.schedule.time || '02:00'} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, time: e.target.value } })} /></label>}
        {form.schedule.mode === 'interval' && <label style={{ fontSize: 12 }}>간격(시간)<br /><input className="input" type="number" min={1} max={168} style={{ width: 80 }} value={form.schedule.hours || 24} onChange={(e) => setForm({ ...form, schedule: { ...form.schedule, hours: Number(e.target.value) || 24 } })} /></label>}
        <label style={{ fontSize: 12 }}>보존 개수<br /><input className="input" type="number" min={1} max={30} style={{ width: 70 }} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) || 3 })} /></label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }} title="VMware Tools 정지점(VSS/freeze) 스냅샷 — DB 등 앱 정합 사본. Tools 필수, 실패 시 잡이 오류로 끝납니다.">
          <input type="checkbox" checked={!!form.quiesce} onChange={(e) => setForm({ ...form, quiesce: e.target.checked })} /> 정지점(앱 정합)
        </label>
        <label className="muted flex gap" style={{ alignItems: 'center', fontSize: 12, padding: '6px 0' }}>
          <input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 활성
        </label>
        <button className="login-btn" style={{ flex: 'none', padding: '8px 18px' }} disabled={busy || !form.vmId} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
      {/* v2.732 B5-05: 선택 목록을 못 읽었으면 '없다' 가 아니라 '못 읽었다' 고 말하고 다시 시도하게 한다 */}
      {(vcErr || vmList.state === 'error' || dsErr) && (
        <div style={{ color: 'var(--amber)', fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
          {vcErr && <div>⚠ {listFailText('vCenter', vcErr)}</div>}
          {vmList.state === 'error' && <div>⚠ {listFailText('VM', vmList.err)}</div>}
          {dsErr && <div>⚠ {listFailText('데이터스토어', dsErr)}</div>}
          <button className="logout-btn" style={{ padding: '3px 10px', fontSize: 12, marginTop: 4 }}
            onClick={() => { if (vcErr) loadVcs(); setRetry((x) => x + 1); }}>다시 시도</button>
        </div>
      )}
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 8 }}>⚠ {err}</div>}
    </div>
  );
}

import Select from '../../components/Select.jsx';