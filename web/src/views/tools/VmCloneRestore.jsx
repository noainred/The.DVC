import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import Select from '../../components/Select.jsx';
import { dsOptionLabel } from './vmCloneDsText.js';
import { agoText, fmtBytes, restoreNameDefault, meterOf } from './vmCloneView.js';

const GIB = 1024 ** 3;
/** 안전 장치 한 줄의 아이콘(체크 · 주의). */
function SafeIcon({ ok }) {
  return ok
    ? <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" style={{ fill: 'rgba(34,197,94,.18)' }} /><path d="M4.5 8.2l2.2 2.2 4.8-4.8" fill="none" style={{ stroke: '#86efac' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    : <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" style={{ fill: 'rgba(245,158,11,.18)' }} /><path d="M8 4.2v4.6M8 11.3v.2" fill="none" style={{ stroke: '#fcd34d' }} strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

/**
 * VM 백업 센터 › 새 VM 으로 복구(시안 ④, v2.793).
 *  - 원본 VM 은 건드리지 않는다 — 고른 복원 지점을 **새 이름**으로 클론한다(제자리 복구는 제공하지 않는다).
 *  - 네트워크 카드를 끊은 채 만드는 것이 기본이다. 끊지 않으면 자동으로 켜지 않는다(서버도 같은 규칙 — vsOps.validateRestoreSpec).
 *  - 실행 위치는 서버가 정한다(엣지 위임 vCenter 면 담당 엣지).
 */
export default function VmCloneRestore({ d, job, initialRef, onBack, onDone }) {
  const clones = useMemo(() => [...(job.clones || [])].sort((a, b) => (b.at || 0) - (a.at || 0)), [job.clones]);
  const [ref, setRef] = useState(initialRef || clones[0]?.ref || '');
  const [newName, setNewName] = useState(() => restoreNameDefault(job.vmName));
  const [dsName, setDsName] = useState('');
  const [nicOff, setNicOff] = useState(true);
  const [powerOn, setPowerOn] = useState(false);
  const [dss, setDss] = useState([]);
  const [dsErr, setDsErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    setDsErr(null);
    fetchJson('/datastores', { vcenterId: job.vcenterId })
      .then((r) => { if (g === gen.current) setDss(r.items || []); })
      .catch((e) => { if (g === gen.current) setDsErr(e); });
  }, [job.vcenterId]);
  const pick = clones.find((c) => c.ref === ref);
  const now = Date.now();
  // v2.797 대상 여유 미터 — 수집된 데이터스토어 용량 + 고른 지점 크기(모르면 사용량만). 실제 판정은 서버가 실행 직전 실시간 여유로 한다.
  const dsPick = dss.find((x) => x.name === dsName) || null;
  const needGB = pick?.bytes != null && Number.isFinite(Number(pick.bytes)) ? Number(pick.bytes) / GIB : null;
  const meter = dsPick ? meterOf({ capacityGB: dsPick.capacityGB ?? null, freeGB: dsPick.freeGB ?? null, needGB }) : null;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson(`/tools/vm-clone/jobs/${encodeURIComponent(job.id)}/restore`, { ref, newName, datastoreName: dsName, nicDisconnect: nicOff, powerOn: nicOff && powerOn });
      if (r.ok === false) setErr(r.reason);
      else onDone(r.where === 'edge'
        ? `복구 요청을 담당 엣지(${r.agent})로 보냈습니다 — 엣지가 다음 동기화에 가져가 실행합니다. 결과는 세션 이력에 남습니다.`
        : `복구를 실행 큐에 넣었습니다 — '${newName}' 이 만들어지면 세션 이력에 남습니다.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="vbk">
      <div className="vbk-head">
        <div>
          <div className="vbk-crumb"><button type="button" onClick={onBack}>VM 백업</button> › {job.vmName} › 복구</div>
          <h2 className="vbk-title">새 VM 으로 복구</h2>
          <div className="vbk-sub">원본 VM 은 건드리지 않습니다. 고른 복원 지점을 새 이름으로 복제합니다.</div>
        </div>
      </div>

      <div className="vbk-cols">
        <div className="vbk-main">
          <div className="vbk-panel"><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="vbk-sec">1. 복원 지점</div>
            {clones.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>복원 지점이 없습니다.</div>}
            <div className="vbk-choice">
              {clones.slice(0, 12).map((c) => (
                <label key={c.ref} className={c.ref === ref ? 'on' : ''}>
                  <input type="radio" name="vbk-pt" checked={c.ref === ref} onChange={() => setRef(c.ref)} style={{ marginTop: 3 }} />
                  <span>{new Date(c.at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    <small>{agoText(c.at, now)} · {c.verify ? (c.verify.ok ? '부팅 확인' : '검증 실패') : '미검증'}{c.bytes != null ? ` · ${fmtBytes(c.bytes)}` : ''}</small></span>
                </label>
              ))}
            </div>
          </div></div>

          <div className="vbk-panel"><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="vbk-sec">2. 복구 위치</div>
            <div className="vbk-form">
              <label>새 VM 이름
                <input className="input" style={{ fontFamily: 'var(--mono)' }} maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
              <label>데이터스토어
                <Select className="select" value={dsName} onChange={(e) => setDsName(e.target.value)}>
                  <option value="">{dsErr ? '(데이터스토어 목록을 읽지 못함)' : '(선택)'}</option>
                  {dss.map((ds) => <option key={ds.id} value={ds.name}>{dsOptionLabel(ds)}</option>)}
                </Select>
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>폴더는 원본 VM 과 같은 폴더(원본이 없어졌으면 사본의 폴더), 호스트·리소스 풀은 vCenter 가 사본 기준으로 정합니다.</div>
            {dsErr && <div style={{ color: 'var(--amber)', fontSize: 12.5 }}>⚠ 데이터스토어 목록을 읽지 못했습니다({dsErr.message || String(dsErr)}) — 비어 있다는 뜻이 아닙니다.</div>}
          </div></div>

          <div className="vbk-panel"><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="vbk-sec">3. 네트워크 · 전원</div>
            <label className="vbk-opt">
              <input type="checkbox" checked={nicOff} onChange={(e) => { setNicOff(e.target.checked); if (!e.target.checked) setPowerOn(false); }} style={{ marginTop: 3 }} />
              <span><b>네트워크 카드를 끊은 채 만들기(권장)</b><small>원본이 살아 있으면 같은 IP·호스트명·AD 컴퓨터 계정이 충돌합니다. 확인한 뒤 vCenter 에서 직접 연결하세요.</small></span>
            </label>
            <label className={`vbk-opt${nicOff ? '' : ' off'}`}>
              <input type="checkbox" disabled={!nicOff} checked={nicOff && powerOn} onChange={(e) => setPowerOn(e.target.checked)} style={{ marginTop: 3 }} />
              <span><b>만든 뒤 바로 켜기</b><small>네트워크를 끊은 상태에서만 고를 수 있습니다.</small></span>
            </label>
            <div className="vbk-note" role="note">원본 VM 을 덮어쓰는 복구(제자리 복구)는 제공하지 않습니다. 새 VM 을 확인한 뒤 원본과의 교체는 운영자가 직접 합니다.</div>
            {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠ {err}</div>}
            <div className="flex wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="vbk-btn" onClick={onBack}>취소</button>
              <button type="button" className="vbk-btn primary" disabled={busy || !ref || !newName.trim() || !dsName} onClick={submit}>{busy ? '요청 중…' : '복구 시작'}</button>
            </div>
          </div></div>
        </div>

        <div className="vbk-side">
          <div className="vbk-panel"><div className="hd"><div className="vbk-sec">복구 요약</div></div><div className="bd">
            <div className="vbk-kv"><span>원본</span><span>{job.vmName} · {d.vcenterNames?.[job.vcenterId] || job.vcenterId}</span></div>
            <div className="vbk-kv"><span>복원 지점</span><span>{pick ? `${new Date(pick.at).toLocaleString('ko-KR')}${job.quiesce ? '(앱 정합)' : ''}` : '—'}</span></div>
            <div className="vbk-kv"><span>새 VM</span><span>{newName || '—'}</span></div>
            <div className="vbk-kv"><span>위치</span><span>{dsName || '—'}</span></div>
            <div className="vbk-kv"><span>네트워크</span><span>{nicOff ? '끊은 채 생성' : '원본과 같게(충돌 주의)'}</span></div>
            <div className="vbk-kv"><span>전원</span><span>{nicOff && powerOn ? '켜기' : '꺼진 상태'}</span></div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, borderTop: '1px solid var(--border-soft)', paddingTop: 10, marginTop: 6 }}>
              복구도 백업과 같은 실행 큐에서 한 번에 1개씩 돕니다{job.exec?.where === 'edge' ? `(담당 엣지 ${job.exec.agent})` : ''}. 결과는 잡의 세션 이력과 감사 로그에 남습니다.
            </div>
          </div></div>

          <div className="vbk-panel"><div className="hd"><div className="vbk-sec">대상 여유</div></div><div className="bd" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {!dsName && <div className="muted" style={{ fontSize: 12.5 }}>데이터스토어를 고르면 수집된 용량으로 보여 드립니다.</div>}
            {dsName && !meter && <div className="muted" style={{ fontSize: 12.5 }}>이 데이터스토어의 전체·여유 용량을 수집하지 못했습니다 — 실행 직전 서버가 실시간으로 다시 확인합니다.</div>}
            {meter && (
              <>
                <div className="vbk-meter" role="img" aria-label={`사용 중 ${Math.round(meter.usedPct)}% · 복원 지점 ${Math.round(meter.needPct)}%`}>
                  <b className="used" style={{ width: `${meter.usedPct}%` }} /><b className={`need${meter.over ? ' over' : ''}`} style={{ width: `${meter.needPct}%` }} />
                </div>
                <div className="vbk-meter-lg">
                  <span><i style={{ background: '#3a4766' }} />사용 중 {Math.round(meter.usedPct)}%</span>
                  {needGB != null ? <span><i style={{ background: meter.over ? 'var(--red)' : 'var(--accent)' }} />복원 지점 {fmtBytes(pick.bytes)}</span> : <span>복원 지점 크기 모름</span>}
                </div>
                <div className="vbk-kv"><span>여유 / 전체</span><span>{fmtBytes(meter.freeGB * GIB)} / {fmtBytes(meter.capacityGB * GIB)}</span></div>
                {meter.over && <div className="vbk-note">복원 지점이 수집된 여유보다 큽니다 — 서버가 실행 직전 다시 확인해 부족하면 시작하지 않습니다.</div>}
              </>
            )}
          </div></div>

          <div className="vbk-panel"><div className="hd"><div className="vbk-sec">안전 장치</div></div><div className="bd">
            <ul className="vbk-safety">
              <li><SafeIcon ok /><span>원본 VM 은 건드리지 않습니다 — 원본과 같은 이름은 서버가 거부합니다.</span></li>
              <li><SafeIcon ok /><span>이 vCenter 에 같은 이름의 VM 이 있으면 서버가 거부합니다.</span></li>
              <li><SafeIcon ok /><span>실행 직전 대상 데이터스토어의 실시간 여유를 확인해, 남겨 둘 여유 아래로 떨어지면 시작하지 않습니다(여유를 읽지 못하면 이 확인은 건너뜁니다).</span></li>
              <li className={nicOff ? '' : 'warn'}><SafeIcon ok={nicOff} /><span>{nicOff ? '네트워크 카드를 끊은 채 만듭니다.' : '네트워크 카드가 원본과 같게 연결됩니다 — IP·호스트명 충돌에 주의하세요.'}</span></li>
              <li><SafeIcon ok /><span>{nicOff && powerOn ? '네트워크를 끊은 상태로만 켭니다.' : '꺼진 상태로 만듭니다.'}</span></li>
              <li><SafeIcon ok /><span>복구로 만든 VM 은 보존 정리 대상이 아닙니다(포탈이 지우지 않습니다).</span></li>
            </ul>
          </div></div>
        </div>
      </div>
    </div>
  );
}
