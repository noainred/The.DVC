// v2.933(SAN·CVP 설계 C-②) SAN 플로우 모니터(도구 키 san-flow · ‘운영 작업’) — Brocade Flow Vision 플로우를 포탈이 만들고 · 지우고 · 카운터를 읽는다.
//   ⚠ 스위치 설정을 바꾸는 화면이다: 만들기 · 지우기는 본인 OTP 재인증 · 감사 로그. 명령은 서버만 만든다(미리보기도 서버가 만든 글자).
//   무거운 폴링 금지 — 목록은 마운트 1회 + 버튼, 작업 기록만 진행 중일 때 1초 폴링(끝나면 멈춘다). 늦게 온 이전 응답은 버린다. 문구는 sanFlowText.js(순수).
import React, { useEffect, useRef, useState } from 'react';
import BoldText from '../../components/boldText.jsx';
import { fetchJson, postJson } from '../../api.js';
import { ErrorBox, Loading } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { deviceRows, flowRows, flowKpis, jobTitle, jobTone, traceLines, isJobActive, hbaOptions, targetOptions, timeText } from './sanFlowText.js';

const OTP_IN = { width: 120 };
const otpClean = (v) => String(v || '').replace(/\D/g, '').slice(0, 8);

function CreateForm({ dev, onStarted, onClose }) {
  const [hosts, setHosts] = useState({ list: null, error: null, note: '' });
  const [hostId, setHostId] = useState('');
  const [cand, setCand] = useState({ d: null, error: null });
  const [hba, setHba] = useState('');
  const [picked, setPicked] = useState([]);
  const [pv, setPv] = useState({ d: null, error: '' });
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pvSeq = useRef(0);
  useEffect(() => {
    let live = true;
    fetchJson('/tools/san-flow/hosts', { deviceId: dev.id })
      .then((d) => { if (live) setHosts({ list: d.hosts || [], error: null, note: d.reason || '' }); })
      .catch((e) => { if (live) setHosts({ list: null, error: e, note: '' }); });
    return () => { live = false; };
  }, [dev.id]);
  useEffect(() => {
    setCand({ d: null, error: null }); setHba(''); setPicked([]);
    if (!hostId) return undefined;
    let live = true;
    fetchJson('/tools/san-flow/candidates', { hostId })
      .then((d) => { if (live) setCand({ d, error: null }); })
      .catch((e) => { if (live) setCand({ d: null, error: e }); });
    return () => { live = false; };
  }, [hostId]);
  const hbas = hbaOptions(cand.d, dev.id);
  useEffect(() => { if (hbas.length === 1 && !hba) setHba(hbas[0].hba); }, [cand.d]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = hbas.find((x) => x.hba === hba) || null;
  const targets = targetOptions(cur);
  useEffect(() => { setPicked(targets.slice(0, 1).map((t) => t.wwn)); }, [hba, cand.d]); // eslint-disable-line react-hooks/exhaustive-deps
  // 미리보기 — 서버가 만들기와 같은 판정 · 같은 명령 조립으로 답한다(스위치는 건드리지 않는다).
  useEffect(() => {
    const my = ++pvSeq.current;
    setPv({ d: null, error: '' });
    if (!hostId || !hba || !picked.length) return;
    postJson('/tools/san-flow/preview', { deviceId: dev.id, hostId, hba, targets: picked })
      .then((d) => { if (my === pvSeq.current) setPv(d?.ok ? { d, error: '' } : { d: null, error: d?.reason || '미리보기 실패' }); })
      .catch((e) => { if (my === pvSeq.current) setPv({ d: null, error: e?.message || String(e) }); });
  }, [dev.id, hostId, hba, picked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (w) => setPicked((p) => (p.includes(w) ? p.filter((x) => x !== w) : p.length >= 8 ? p : [...p, w]));
  const submit = () => {
    setBusy(true); setErr('');
    postJson('/tools/san-flow/create', { deviceId: dev.id, hostId, hba, targets: picked, otp })
      .then((r) => { setBusy(false); setOtp(''); if (r?.ok) onStarted(r.id); else setErr(r?.reason || '만들지 못했습니다'); })
      .catch((e) => { setBusy(false); setOtp(''); setErr(e?.message || String(e)); });
  };
  return (
    <div className="card" style={{ marginBottom: 12, minWidth: 0 }}>
      <div className="hd-card-h"><b>플로우 만들기 · {dev.name}</b><span className="muted">호스트를 고르면 HBA · 스위치 포트 · zone 안 타깃을 채웁니다(조닝 · 포트 연결 기준)</span></div>
      {hosts.error ? <ErrorBox error={hosts.error} /> : !hosts.list ? <Loading /> : (
        <div className="sf-form">
          <label className="sf-fld"><span>대상 호스트</span>
            <Select className="input" value={hostId} onChange={(e) => setHostId(e.target.value)} aria-label="대상 호스트">
              <option value="">{hosts.list.length ? `호스트 고르기(${hosts.list.length})` : '이 스위치에 로그인한 호스트 없음'}</option>
              {hosts.list.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.hbas.join(', ')}</option>)}
            </Select>
          </label>
          <label className="sf-fld"><span>HBA · 초기자 WWN</span>
            <Select className="input" value={hba} onChange={(e) => setHba(e.target.value)} disabled={!hbas.length} aria-label="HBA">
              <option value="">{!hostId ? '호스트를 먼저' : cand.d ? (hbas.length ? 'HBA 고르기' : '이 스위치에 로그인한 HBA 없음') : '읽는 중…'}</option>
              {hbas.map((x) => <option key={x.hba} value={x.hba}>{x.hba} · {x.wwn}</option>)}
            </Select>
          </label>
          <div className="sf-fld"><span>스위치 포트(ingrport · 자동)</span>
            <div className="input sf-static mono">{cur ? `${cur.switchName} ${cur.port.slotPort ?? cur.port.index}` : '—'}</div>
          </div>
          {cand.error ? <ErrorBox error={cand.error} /> : null}
          {hosts.note ? <div className="muted" style={{ fontSize: 12 }}>{hosts.note}</div> : null}
        </div>
      )}
      {cur && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>타깃(DID) — zone 안 타깃 {targets.length}개 · 고른 타깃마다 플로우 하나(최대 8)</div>
          <div className="flex wrap" style={{ gap: '4px 12px' }}>
            {targets.map((t) => (
              <label key={t.wwn} className="sf-chk" title={t.kind}>
                <input type="checkbox" checked={picked.includes(t.wwn)} onChange={() => toggle(t.wwn)} />
                <span className="mono">{t.wwn}</span> <span className="muted">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {(pv.d || pv.error) && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>미리보기 — 실행할 명령(서버가 만든 글자 · FOS 8.0.1 명령 참조 기준 · 실장비 문법 확인 전)</div>
          {pv.error ? <div style={{ color: 'var(--red)', fontSize: 12.5 }}>{pv.error}</div> : <pre className="sf-code">{pv.d.cmds.join('\n')}</pre>}
          {pv.d && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>스위치 플로우 {pv.d.known} / {pv.d.limit} · 포트 {pv.d.ingrport} 포탈 모니터 {pv.d.onPort} / {pv.d.perPort} · 같은 정의의 활성 플로우가 있으면 장비가 거부합니다(그대로 보여 줍니다)</div>}
        </div>
      )}
      <div className="flex wrap" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
        <input className="input mono" style={OTP_IN} inputMode="numeric" autoComplete="one-time-code" placeholder="본인 OTP" aria-label="본인 OTP" value={otp} onChange={(e) => setOtp(otpClean(e.target.value))} />
        <button type="button" className="btn primary" disabled={busy || !pv.d} onClick={submit}>{busy ? '보내는 중…' : `만들기${dev.agent ? ' · 엣지 대행' : ''}`}</button>
        <button type="button" className="btn" onClick={onClose}>닫기</button>
        {err ? <span style={{ color: 'var(--red)', fontSize: 12.5, minWidth: 0 }}>{err}</span> : null}
      </div>
    </div>
  );
}

export default function SanFlowTool() {
  const [st, setSt] = useState({ d: null, error: null });
  const [form, setForm] = useState(null);           // 만들기 폼을 연 스위치 id
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState(null);
  const [act, setAct] = useState({ busy: '', msg: '', error: '' });
  const [del, setDel] = useState(null);             // { deviceId, name }
  const [delOtp, setDelOtp] = useState('');
  const seq = useRef(0);
  const load = () => {
    const my = ++seq.current;
    fetchJson('/tools/san-flow')
      .then((d) => { if (my === seq.current) setSt({ d, error: null }); })
      .catch((e) => { if (my === seq.current) setSt((s) => ({ d: s.d, error: e })); });
  };
  useEffect(() => { load(); }, []);
  // 작업 기록 — 진행 중일 때만 1초 폴링(끝나면 목록을 한 번 다시 읽고 멈춘다).
  useEffect(() => {
    if (!jobId) return undefined;
    let live = true; let t = null;
    const tick = () => fetchJson(`/tools/san-flow/job/${encodeURIComponent(jobId)}`)
      .then((r) => { if (!live) return; setJob(r.job); if (isJobActive(r.job)) t = setTimeout(tick, 1000); else load(); })
      .catch((e) => { if (live) setAct((a) => ({ ...a, error: e?.message || String(e) })); });
    tick();
    return () => { live = false; if (t) clearTimeout(t); };
  }, [jobId]);
  const started = (id) => { setJob(null); setJobId(id); setForm(null); };
  const run = (path, body, label) => {
    setAct({ busy: label, msg: '', error: '' });
    postJson(path, body)
      .then((r) => { if (r?.ok) { setAct({ busy: '', msg: '', error: '' }); started(r.id); } else setAct({ busy: '', msg: '', error: r?.reason || '실패' }); })
      .catch((e) => setAct({ busy: '', msg: '', error: e?.message || String(e) }));
  };
  const doDelete = () => {
    const x = del; setDel(null);
    run('/tools/san-flow/delete', { deviceId: x.deviceId, name: x.name, otp: delOtp }, `del:${x.name}`);
    setDelOtp('');
  };

  if (st.error && !st.d) return <ErrorBox error={st.error} />;
  if (!st.d) return <Loading />;
  const d = st.d;
  const devs = deviceRows(d);
  const flows = flowRows(d);
  const formDev = devs.find((x) => x.id === form) || null;
  const recent = Array.isArray(d.jobs) ? d.jobs : [];
  const shown = job || recent[0] || null;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="banner warn" style={{ marginBottom: 12 }}>
        <BoldText text={'이 화면은 **스위치 설정을 바꿉니다**(flow --create · flow --delete). 엣지에 위임한 스위치는 그 법인의 엣지가 현지에서 실행하고 결과만 올립니다(SAN 연결 테스트 대행과 같은 큐 → 가져감 → 회신). 포탈은 ‘dvc_’ 로 시작하는 자기 플로우만 지웁니다 — 사람이 만든 플로우는 보여 주기만 합니다. 수집 계정이 제한된 셸(rbash)이면 flow 명령이 막혀 있을 수 있으니 **계정 권한 점검**(flow --show — 읽기만)을 먼저 통과해야 만들 수 있습니다. 문법 · 출력 형식 · 상한(스위치 128 · 디렉터 512 · 포트당 모니터 64)은 FOS 8.0.1 명령 참조 기준이고 실장비로 확인하지 못했습니다.'} />
      </div>
      {st.error ? <div style={{ marginBottom: 8 }}><ErrorBox error={st.error} /></div> : null}
      <div className="hd-kpis" style={{ marginBottom: 12 }}>
        {flowKpis(d).map((k) => <div key={k.label} className="ht-kpi"><span className="ht-kpi-l">{k.label}</span><span className="ht-kpi-v" style={{ fontSize: 16 }}>{k.value}</span><span className="ht-kpi-s" title={k.meta}>{k.meta}</span></div>)}
      </div>

      <div className="card" style={{ marginBottom: 12, minWidth: 0 }}>
        <div className="hd-card-h"><b>스위치 · 라이선스 · 계정 권한</b>
          <span className="flex wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="muted">라이선스는 스냅샷 라이선스 목록의 ‘Fabric Vision’ · 권한 점검은 읽기 명령(flow --show)만 보냅니다</span>
            <button type="button" className="btn" onClick={load}>새로 읽기</button>
          </span>
        </div>
        {act.error ? <div style={{ color: 'var(--red)', fontSize: 12.5, marginBottom: 6 }}>{act.error}</div> : null}
        <div className="table-wrap">
          <STable minWidth={860}>
            <thead><tr><th>스위치</th><th>Fabric Vision</th><th>계정 권한 점검</th><th>플로우 / 상한</th><th>실행 위치</th><th>모델</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {devs.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.name}</b>{x.datacenterId ? <div className="muted" style={{ fontSize: 11 }}>{x.datacenterId}</div> : null}</td>
                  <td data-sort={x.fvB.label} title={x.fvB.title}><span className={`badge ${x.fvB.tone}`}>{x.fvB.label}</span></td>
                  <td data-sort={x.chk.label} title={x.chk.title}><span className={`badge ${x.chk.tone}`}>{x.chk.label}</span></td>
                  <td data-sort={x.countSort} className="tabular">{x.countText}</td>
                  <td className="muted">{x.where}</td>
                  <td className="muted">{x.model || '—'}</td>
                  <td>
                    <div className="flex wrap" style={{ gap: 6 }}>
                      <button type="button" className="btn" disabled={!!act.busy || x.fv?.state === 'no'} onClick={() => run('/tools/san-flow/check', { deviceId: x.id }, `chk:${x.id}`)} title="flow --show(읽기만) — 라이선스 · 명령 사용 가능 여부 · 플로우 개수">{act.busy === `chk:${x.id}` ? '보내는 중…' : '권한 점검'}</button>
                      <button type="button" className="btn primary" disabled={!!x.block} onClick={() => setForm(x.id)} title={x.block || '이 스위치에 플로우 만들기'}>{x.block || '만들기'}</button>
                      {x.portalFlows > 0 ? <button type="button" className="btn" disabled={!!act.busy} onClick={() => run('/tools/san-flow/show', { deviceId: x.id }, `show:${x.id}`)}>카운터 읽기</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {!devs.length ? <div className="muted" style={{ padding: 8 }}>등록된 SAN 스위치가 없습니다(SAN 스위치 모니터링에서 등록).</div> : null}
      </div>

      {formDev ? <CreateForm key={formDev.id} dev={formDev} onStarted={started} onClose={() => setForm(null)} /> : null}

      {shown && (
        <div className="card" style={{ marginBottom: 12, minWidth: 0 }}>
          <div className="hd-card-h"><b>실행 기록</b><span className={`badge ${jobTone(shown)}`}>{jobTitle(shown)}</span></div>
          <div className="sf-trace">
            {traceLines(shown).map((l) => (
              <div key={l.key} className={`sf-step ${l.level}`}><span className="mono muted">{l.t}</span><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{l.msg}</span></div>
            ))}
          </div>
          {shown.result?.outputs?.length ? (
            <details style={{ marginTop: 6 }}><summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>장비 출력 원문 {shown.result.outputs.length}건</summary>
              <pre className="sf-code">{shown.result.outputs.map((o) => `$ ${o.cmd}\n${o.out}`).join('\n\n')}</pre>
            </details>
          ) : null}
          {recent.length > 1 ? (
            <div className="flex wrap" style={{ gap: 6, marginTop: 8 }}>
              {recent.slice(0, 8).map((j) => <button type="button" key={j.id} className="btn" style={{ fontSize: 11.5 }} onClick={() => { setJob(j); setJobId(isJobActive(j) ? j.id : ''); }}>{timeText(j.startedAt)} {jobTitle(j)}</button>)}
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>엣지 위임 작업은 가져감 10분 · 회신 5분 안에 없으면 실패로 닫고 사유를 남깁니다. 기록에 비밀번호는 없습니다.</div>
        </div>
      )}

      <div className="card" style={{ minWidth: 0 }}>
        <div className="hd-card-h"><b>플로우 결과</b><span className="muted">flow --show 누적 카운터의 직전 두 번 차이 · ESXi 경로 실측(같은 HBA · 타깃)과 비교는 시점이 달라 참고값</span></div>
        {del && (
          <div className="flex wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ minWidth: 0 }}>‘{del.name}’ 을 스위치에서 지웁니다 —</span>
            <input className="input mono" style={OTP_IN} inputMode="numeric" autoComplete="one-time-code" placeholder="본인 OTP" aria-label="본인 OTP(지우기)" value={delOtp} onChange={(e) => setDelOtp(otpClean(e.target.value))} />
            <button type="button" className="btn danger" onClick={doDelete}>지우기</button>
            <button type="button" className="btn" onClick={() => { setDel(null); setDelOtp(''); }}>취소</button>
          </div>
        )}
        <div className="table-wrap">
          <STable minWidth={1080}>
            <thead><tr><th>플로우</th><th>상태</th><th>지금 Rx / Tx</th><th>ESXi 실측 대비</th><th>호스트 · HBA</th><th>SID → DID</th><th>스토리지</th><th>누적 바이트</th><th>스위치</th><th data-nosort>동작</th></tr></thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.key}>
                  <td className="mono" style={{ fontSize: 12 }}>{f.name}</td>
                  <td data-sort={f.state.label} title={f.lastError || undefined}><span className={`badge ${f.state.tone}`}>{f.state.label}</span>{f.lastError ? <div className="muted" style={{ fontSize: 11, maxWidth: 220, overflowWrap: 'anywhere' }}>{f.lastError}</div> : null}</td>
                  <td data-sort={f.rateSort} className="tabular">{f.rate}</td>
                  <td data-sort={f.diffSort ?? undefined} className="tabular" title={`ESXi 경로 실측 ${f.esxi}`} style={f.diffWarn ? { color: 'var(--amber, #fbbf24)' } : undefined}>{f.diff}{f.diffWarn ? ' △' : ''}</td>
                  <td>{f.host}</td>
                  <td className="mono muted" style={{ fontSize: 11 }} title={f.pairTitle}>{f.pair}</td>
                  <td>{f.target}</td>
                  <td data-sort={f.bytesSort} className="tabular">{f.bytes}</td>
                  <td className="muted">{f.sw}</td>
                  <td>{f.portal && f.state.label !== '지움' ? <button type="button" className="btn danger" disabled={!!act.busy} onClick={() => { setDel({ deviceId: f.deviceId, name: f.name }); setDelOtp(''); }}>지우기</button> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        </div>
        {!flows.length ? <div className="muted" style={{ padding: 8 }}>아직 플로우가 없습니다 — 라이선스가 있는 스위치에서 권한 점검을 통과한 뒤 만들 수 있습니다.</div> : null}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>라이선스가 없는 패브릭은 이 화면에서 만들 수 없습니다 — 그 법인은 호스트 상세의 ESXi 경로 실측 · IPF 로 봅니다.</div>
      </div>
    </div>
  );
}
