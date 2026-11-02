/**
 * Bareos 운영 › 복원(v2.861 — 사용자 요청 '백업처럼 폴더에서 선택해서 복원' · '네트워크 연결 끊고 시작' · '어떤 데이터스토어에 복원하는지 선택'
 *   — 승인 시안 docs/design/bareos-ui-v2 ⑦~⑪). 왼쪽 = 법인 › 폴더 › VM 트리(백업 대상만 · 한 번에 한 법인 · 50대까지),
 *   오른쪽 = 3단계(① 복원 지점 ② 위치 · 이름 · 데이터스토어 · 네트워크 ③ 미리 보기 + 본인 OTP 한 번) + 최근 묶음 진행.
 *   판정은 서버(POST restore-check/bulk — bulkRestorePlan)가 한다. 화면은 빠른 확인과 글자만(bareosRestoreText.js).
 *   복원 지점 읽기와 실행은 Director 를 거친다 — 자동 재시도 없음 · 엣지 대행 법인은 서버 대기 시간만큼 기다린다(withRelayWait).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import BareosRehearsal from './BareosRehearsal.jsx';
import BareosRestoreTable from './BareosRestoreTable.jsx';   // v2.864 폴더 표(시안 ① 일반 복원)
import { RESTORE_VIEWS, loadRestoreView, saveRestoreView } from './bareosRestoreTree.js';
import { Note, ReadGuide, FilterChip } from './BareosBits.jsx';
import { stateBadge, withRelayWait, outcomeUnknown, unknownOutcomeText, driftText, levelLabel } from './bareosText.js';
import {
  RESTORE_MAX, MODE_SHORT, NIC_LABEL, restoreTree, pickBlock, defaultItem, withMode, itemBody, pointText, latestPoint, wizardIssue,
  dsText, capacityText, finishText, finishTone, batchView, latestBatchId, snapshotChip, SNAPSHOT_TITLE,
} from './bareosRestoreText.js';

const BASE = '/tools/bareos-backup';
const DIRECTOR_GET = { retries: 0, timeoutMs: 60_000 };   // Director 를 거치는 조회 — 자동 재시도 금지(계정 잠금 · 앞 요청이 계속 돈다)
const INP = { minWidth: 0, width: '100%', boxSizing: 'border-box' };
const ROW = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const STEPS = [[1, '복원 지점'], [2, '위치 · 이름 · 네트워크'], [3, '확인 · OTP']];
const FINISH_COLOR = { ok: '#86efac', bad: '#fca5a5', info: 'var(--text-dim)' };

export default function BareosRestore({ d, reload, preselect = '', onPreselectUsed = null }) {
  const jobs = useMemo(() => d.jobs || [], [d.jobs]);
  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => (preselect && jobsById.has(preselect) && !pickBlock(jobsById.get(preselect)) ? [preselect] : []));
  const [step, setStep] = useState(0);
  const [items, setItems] = useState({});
  const [pts, setPts] = useState(null);
  const [ptsErr, setPtsErr] = useState(null);
  const [dss, setDss] = useState({});
  const [check, setCheck] = useState(null);
  const [checkErr, setCheckErr] = useState(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [batchId, setBatchId] = useState(() => latestBatchId(jobs));
  const [view, setViewState] = useState(() => (typeof window === 'undefined' ? 'list' : loadRestoreView(window.localStorage)));
  const setView = (v) => { setViewState(v); saveRestoreView(v, typeof window === 'undefined' ? null : window.localStorage); };
  const gen = useRef(0);
  const usedRef = useRef(onPreselectUsed);
  usedRef.current = onPreselectUsed;
  useEffect(() => { if (preselect) usedRef.current?.(); }, [preselect]);

  const lockedDir = picked.length ? (jobsById.get(picked[0])?.directorId || '') : '';
  const dir = (d.directors || []).find((x) => x.id === lockedDir) || null;
  const tree = useMemo(() => restoreTree(jobs, { q }), [jobs, q]);
  const pickedJobs = picked.map((id) => jobsById.get(id)).filter(Boolean);
  const list = picked.map((id) => items[id]).filter(Boolean);
  const batch = useMemo(() => batchView(jobs, batchId), [jobs, batchId]);
  // 고른 대상이 원장에서 빠지면(삭제) 목록에서도 뺀다
  useEffect(() => { if (picked.some((id) => !jobsById.has(id))) setPicked((p) => p.filter((id) => jobsById.has(id))); }, [picked, jobsById]);

  const resetWizard = () => { gen.current++; setStep(0); setPts(null); setPtsErr(null); setCheck(null); setCheckErr(null); setOtp(''); setErr(null); };
  const toggle = (ids, on) => {
    resetWizard(); setDone(null);
    setPicked((p) => {
      const set = new Set(p);
      for (const id of ids) { if (on) { if (set.size < RESTORE_MAX) set.add(id); } else set.delete(id); }
      return [...set];
    });
  };
  const setItem = (id, patch) => setItems((m) => ({ ...m, [id]: { ...m[id], ...patch } }));

  // ① 복원 지점 — 고른 VM 을 한 번에(서버가 법인 Director 세션 하나로 차례로 읽는다)
  const loadPoints = () => {
    const g = ++gen.current;
    setStep(1); setPts(null); setPtsErr(null); setCheck(null);
    const wait = withRelayWait(DIRECTOR_GET, dir, d.relayLimits, 'restorePoints');
    postJson(`${BASE}/restore-points/bulk`, { ids: picked }, wait).then((r) => {
      if (g !== gen.current) return;   // 늦게 온 이전 응답은 버린다
      const byId = new Map((r.items || []).map((x) => [x.id, x]));
      setPts(byId);
      setItems((m) => {
        const out = { ...m };
        for (const id of picked) {
          const job = jobsById.get(id);
          const base = out[id] && out[id].id === id ? out[id] : defaultItem(job);
          const lp = latestPoint(byId.get(id)?.points);
          out[id] = { ...base, jobid: base.jobid && (byId.get(id)?.points || []).some((p) => p.jobid === base.jobid && p.chain) ? base.jobid : lp?.jobid ?? null };
        }
        return out;
      });
    }).catch((e) => { if (g === gen.current) setPtsErr(e); });
  };
  // ② 데이터스토어 목록(그 vCenter 인벤토리 — 여유 · 용량)
  const dsAsked = useRef(new Set());   // 요청을 보낸 vCenter — 응답 전에 다시 그려져도 같은 조회를 또 보내지 않는다
  const pickedVcKey = [...new Set(pickedJobs.map((j) => j.vcenterId))].sort().join('|');
  useEffect(() => {
    if (step !== 2) return;
    for (const vc of pickedVcKey.split('|').filter(Boolean)) {
      if (dsAsked.current.has(vc)) continue;
      dsAsked.current.add(vc);
      fetchJson('/datastores', { vcenterId: vc, limit: 2000 })
        .then((r) => setDss((m) => ({ ...m, [vc]: (r.items || []).filter((x) => x.accessible !== false).map((x) => ({ name: x.name, freeGB: x.freeGB ?? null, capacityGB: x.capacityGB ?? null })) })))
        .catch(() => setDss((m) => ({ ...m, [vc]: [] })));
    }
  }, [step, pickedVcKey]);
  // ③ 미리 보기(Director 에 닿지 않는다 · OTP 를 쓰지 않는다)
  const preview = () => {
    const g = ++gen.current;
    setStep(3); setCheck(null); setCheckErr(null); setErr(null);
    postJson(`${BASE}/restore-check/bulk`, { items: list.map(itemBody) }).then((r) => { if (g === gen.current) setCheck(r); }).catch((e) => { if (g === gen.current) setCheckErr(e); });
  };
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson(`${BASE}/restore/bulk`, { items: list.map(itemBody), otp }, withRelayWait({}, dir, d.relayLimits, 'restores'));
      requireChanged(r);
      setDone({ ok: !r.saveError, text: `복원을 시작했습니다 — ${r.started} / ${r.total}대${r.started < r.total ? '(시작하지 못한 VM 은 아래 진행 표의 사유를 보세요)' : ''}. 끝나면 네트워크 끊기를 고른 VM 은 포탈이 연결을 끊습니다 — 끊음 표시가 나오기 전에는 켜지 마세요.${r.saveError ? ` ${r.saveError}` : ''}`, items: r.items });
      setBatchId(r.batchId || '');
      setPicked([]); setItems({}); resetWizard();
      reload();
    } catch (e) {
      setErr(outcomeUnknown(e) ? unknownOutcomeText('복원', e) : e.message);
      setOtp('');   // 쓴(또는 틀린) OTP 를 남기면 다시 누를 때 실패 횟수만 오른다
    } finally { setBusy(false); }
  };

  const issue2 = step >= 2 ? wizardIssue(list, jobsById) : '';
  const planOk = !!check?.plan?.ok;
  const many = picked.length > 1;
  const tableMode = view === 'table';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {done && <Note tone={done.ok ? 'ok' : 'bad'}>{done.text}</Note>}
      {/* v2.864 고르는 방식 — 간단 목록(지금 방식 그대로) · 폴더 표(vCenter › 폴더 › VM 트리 표). 다음 단계는 둘 다 같은 마법사다 */}
      <div style={ROW}>
        <span className="muted" style={{ fontSize: 12 }}>고르는 방식</span>
        <div role="group" aria-label="고르는 방식" className="flex gap wrap" style={{ rowGap: 6 }}>
          {RESTORE_VIEWS.map(([k, l]) => <FilterChip key={k} on={view === k} onClick={() => setView(k)}>{l}</FilterChip>)}
        </div>
        {tableMode && step > 0 && <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12 }} onClick={resetWizard}>← 폴더 표로(고른 VM 은 그대로)</button>}
      </div>
      {tableMode && step === 0 && (
        <BareosRestoreTable jobs={jobs} directors={d.directors || []} picked={picked} toggle={toggle} lockedDir={lockedDir} onNext={loadPoints} onClear={() => { setPicked([]); resetWizard(); }} />
      )}
      {/* 트리는 좁게(최대 420px) · 마법사가 나머지 — 1440 에서 2단계 칸(데이터스토어 · 네트워크)이 가로 스크롤 뒤로 숨지 않게(Chromium 확인) · 좁으면 위아래로 */}
      {(!tableMode || step > 0) && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
        {/* ── 왼쪽: 법인 › 폴더 › VM ── (폴더 표 보기에서는 표가 대신한다) */}
        {!tableMode && <div className="card" data-bareos-restore-tree="" style={{ padding: 12, minWidth: 0, flex: '1 1 300px', maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 8, boxSizing: 'border-box' }}>
          <div style={ROW}>
            <b style={{ fontSize: 13.5 }}>복원할 VM 고르기</b>
            <span className="muted" style={{ fontSize: 12 }}>백업 대상만 · 한 번에 한 법인 · {RESTORE_MAX}대까지</span>
          </div>
          <input className="input" style={INP} placeholder="VM · 폴더 이름" value={q} onChange={(e) => setQ(e.target.value)} aria-label="VM 찾기" />
          <div style={{ maxHeight: '58vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            {!tree.length && <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>{jobs.length ? '찾는 VM 이 없습니다.' : '백업 대상이 없습니다 — 백업 대상에서 먼저 등록하세요.'}</div>}
            {tree.map((vc) => (
              <div key={vc.vcenterId} style={{ minWidth: 0 }}>
                <div className="muted" style={{ fontSize: 12, fontWeight: 700, padding: '4px 2px' }}>{vc.vcenterId} · {(d.directors || []).find((x) => x.id === vc.directorId)?.name || vc.directorId || '—'} · {vc.n}대</div>
                {vc.folders.map((f) => {
                  const free = f.vms.filter((j) => !pickBlock(j, { lockedDir }));
                  const allOn = free.length > 0 && free.every((j) => picked.includes(j.id));
                  return (
                    <div key={f.folder} style={{ marginLeft: 6, minWidth: 0 }}>
                      <label style={{ ...ROW, gap: 6, fontSize: 12.5, fontWeight: 600, padding: '3px 0', cursor: free.length ? 'pointer' : 'default' }}>
                        <input type="checkbox" checked={allOn} disabled={!free.length} onChange={(e) => toggle(free.map((j) => j.id), e.target.checked)} />
                        <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{f.folder}</span><span className="muted" style={{ fontWeight: 400 }}>{f.vms.length}</span>
                      </label>
                      {f.vms.map((j) => {
                        const why = pickBlock(j, { lockedDir });
                        const on = picked.includes(j.id);
                        const snap = snapshotChip(j.snapshotCount);
                        return (
                          <label key={j.id} title={why || undefined} style={{ ...ROW, gap: 6, marginLeft: 20, fontSize: 12.5, padding: '2px 0', cursor: why && !on ? 'default' : 'pointer', opacity: why && !on ? 0.55 : 1 }}>
                            <input type="checkbox" checked={on} disabled={!!why && !on} onChange={(e) => toggle([j.id], e.target.checked)} />
                            <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{j.vmName}</span>
                            {snap && <span className="badge amber" style={{ fontSize: 10.5 }} title={SNAPSHOT_TITLE}>{snap}</span>}
                            {why && <span className="muted" style={{ fontSize: 11 }}>{why}</span>}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>}

        {/* ── 오른쪽: 3단계 ── */}
        <div className="card" data-bareos-restore-wizard="" style={{ padding: 14, minWidth: 0, flex: '999 1 520px', display: 'flex', flexDirection: 'column', gap: 10, boxSizing: 'border-box' }}>
          <div className="flex gap wrap" role="list" aria-label="복원 단계" style={{ rowGap: 6 }}>
            {STEPS.map(([n, l]) => <FilterChip key={n} on={step === n} onClick={() => { if (n === 1 && picked.length) loadPoints(); else if (n === 2 && pts) setStep(2); else if (n === 3 && step >= 2 && !issue2) preview(); }}>{n}. {l}</FilterChip>)}
          </div>
          {!picked.length && <div className="muted" style={{ fontSize: 13 }}>왼쪽에서 VM 을 고르세요 — 폴더를 고르면 그 안의 VM 을 모두 고릅니다(백업처럼).</div>}
          {picked.length > 0 && (
            <div style={ROW}>
              <b style={{ fontSize: 13 }}>고른 VM {picked.length}대</b>
              <span className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }}>{pickedJobs.slice(0, 6).map((j) => j.vmName).join(' · ')}{picked.length > 6 ? ` 외 ${picked.length - 6}대` : ''}</span>
              <button type="button" className="tab" style={{ padding: '3px 10px', fontSize: 12, marginLeft: 'auto' }} onClick={() => { setPicked([]); resetWizard(); }}>모두 빼기</button>
              {step === 0 && <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px' }} onClick={loadPoints}>다음: 복원 지점 읽기</button>}
            </div>
          )}

          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              {ptsErr && <ErrorBox error={ptsErr} />}
              {!pts && !ptsErr && <Loading />}
              {pts && (
                <div className="table-wrap">
                  <STable minWidth={520} wrap={false}>
                    <thead><tr><th>VM</th><th>복원 지점</th><th data-nosort="">상태</th></tr></thead>
                    <tbody>
                      {pickedJobs.map((j) => {
                        const p = pts.get(j.id);
                        const it = items[j.id];
                        return (
                          <tr key={j.id}>
                            <td data-sort={j.vmName}><b>{j.vmName}</b>{j.drift && <div style={{ fontSize: 11, color: '#fcd34d', maxWidth: 240, whiteSpace: 'normal' }}>{driftText(j.drift)}</div>}</td>
                            <td style={{ minWidth: 220 }}>
                              {p?.ok ? (
                                <Select className="input" style={INP} value={it?.jobid ?? ''} onChange={(e) => setItem(j.id, { jobid: Number(e.target.value) || null })} aria-label={`${j.vmName} 복원 지점`}>
                                  {!p.points.length && <option value="">성공한 백업이 없습니다</option>}
                                  {p.points.map((x) => <option key={x.jobid} value={x.jobid} disabled={!x.chain}>{pointText(x)} · jobid {x.jobid}</option>)}
                                </Select>
                              ) : <span style={{ color: '#fca5a5', fontSize: 12, whiteSpace: 'normal' }}>{p?.reason || '읽지 못했습니다'}</span>}
                            </td>
                            <td className="muted" style={{ fontSize: 12 }}>{p?.ok ? `${p.points.length}개 지점 · 최근 ${p.scanned ?? '—'}회 중` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </STable>
                </div>
              )}
              {pts && (
                <div style={ROW}>
                  <span className="muted" style={{ fontSize: 12 }}>체인(Full 부터)은 서버가 이 잡의 카탈로그 이력으로 계산합니다 — 체인이 없는 지점은 고를 수 없습니다.</span>
                  <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', marginLeft: 'auto' }} disabled={!list.length || list.some((x) => !x.jobid)} onClick={() => setStep(2)}>다음: 위치 · 이름</button>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              {many && (
                <div style={ROW}>
                  <span className="muted" style={{ fontSize: 12 }}>모든 새 VM 에 같은 데이터스토어</span>
                  <Select className="input" style={{ minWidth: 0, maxWidth: 320 }} value="" onChange={(e) => { const v = e.target.value; setItems((m) => Object.fromEntries(Object.entries(m).map(([k, x]) => [k, picked.includes(k) && x.mode === 'newVm' ? { ...x, datastore: v === '-' ? '' : v } : x]))); }} aria-label="모든 VM 데이터스토어">
                    <option value="">고르기…</option>
                    <option value="-">백업 당시 그대로</option>
                    {(dss[pickedJobs[0]?.vcenterId] || []).map((x) => <option key={x.name} value={x.name}>{dsText(x)}</option>)}
                  </Select>
                </div>
              )}
              {/* VM 마다 한 줄 카드 — 칸이 좁으면 접힌다(표로 두면 1440 의 마법사 폭에서 오른쪽 칸이 가로 스크롤 뒤로 숨었다) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '56vh', overflow: 'auto', minWidth: 0 }}>
                {pickedJobs.map((j) => {
                  const it = items[j.id] || defaultItem(j);
                  const pt = pts?.get(j.id)?.points?.find((x) => x.jobid === it.jobid);
                  const FIELD = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, minWidth: 0 };
                  return (
                    <div key={j.id} data-restore-item="" style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: '10px 12px', background: 'var(--panel-deep)', minWidth: 0 }}>
                      <div style={{ ...ROW, marginBottom: 8 }}>
                        <b style={{ fontSize: 13, overflowWrap: 'anywhere', minWidth: 0 }}>{j.vmName}</b>
                        <span className="muted" style={{ fontSize: 11.5 }}>{pt ? `${levelLabel(pt.level)} · jobid ${pt.jobid}` : '—'}</span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: 8, minWidth: 0 }}>
                        <label className="muted" style={FIELD}>방식
                          <Select className="input" style={INP} value={it.mode} onChange={(e) => setItem(j.id, withMode(it, e.target.value))} aria-label={`${j.vmName} 방식`}>
                            <option value="newVm">{MODE_SHORT.newVm}</option>
                            <option value="localVmdk">{MODE_SHORT.localVmdk}</option>
                            {!many && <option value="original" disabled={!!j.drift}>{MODE_SHORT.original}</option>}
                          </Select>
                        </label>
                        {it.mode === 'newVm' && (
                          <label className="muted" style={FIELD}>새 VM 이름
                            <input className="input" style={INP} value={it.name} onChange={(e) => setItem(j.id, { name: e.target.value })} aria-label={`${j.vmName} 새 VM 이름`} />
                          </label>
                        )}
                        {it.mode === 'newVm' && (
                          <label className="muted" style={FIELD}>데이터스토어
                            <Select className="input" style={INP} value={it.datastore} onChange={(e) => setItem(j.id, { datastore: e.target.value })} aria-label={`${j.vmName} 데이터스토어`}>
                              <option value="">백업 당시 그대로</option>
                              {(dss[j.vcenterId] || []).map((x) => <option key={x.name} value={x.name}>{dsText(x)}</option>)}
                            </Select>
                          </label>
                        )}
                        {it.mode === 'original' && (
                          <label className="muted" style={FIELD}>덮어쓰기 확인 — ‘{j.vmName}’ 입력
                            <input className="input" style={INP} value={it.confirmName} onChange={(e) => setItem(j.id, { confirmName: e.target.value })} autoComplete="off" aria-label="덮어쓰기 확인" />
                          </label>
                        )}
                        {it.mode !== 'localVmdk' && (
                          <label className="muted" style={FIELD} title={it.mode === 'original' && it.nic === 'disconnect' ? '덮어쓴 원래 VM 의 네트워크 어댑터가 모두 끊깁니다(켤 때도 연결 안 함)' : undefined}>네트워크 어댑터{it.mode === 'original' && it.nic === 'disconnect' ? ' — 원래 VM 이 끊깁니다' : ''}
                            <Select className="input" style={INP} value={it.nic} onChange={(e) => setItem(j.id, { nic: e.target.value })} aria-label={`${j.vmName} 네트워크`}>
                              <option value="disconnect">{NIC_LABEL.disconnect}</option>
                              <option value="keep">{NIC_LABEL.keep}</option>
                            </Select>
                          </label>
                        )}
                        {it.mode === 'localVmdk' && <span className="muted" style={{ fontSize: 12, alignSelf: 'end' }}>FD 의 /tmp/bareos-restores/ 에 VMDK 로 풉니다(vCenter 는 바꾸지 않음)</span>}
                      </div>
                      {it.mode === 'original' && (
                        <label className="muted" style={{ ...ROW, gap: 6, fontSize: 11.5, marginTop: 6 }} title="Bareos 23.1 이상 — 지금 VM 의 디스크 수 · 크기가 백업 때와 달라도 덮어씁니다(vSAN). 옛 Director 는 이 옵션을 거부합니다.">
                          <input type="checkbox" checked={!!it.allowDisksMismatch} onChange={(e) => setItem(j.id, { allowDisksMismatch: e.target.checked })} />디스크 불일치 허용(고급 — vSAN · Bareos 23.1 이상)
                        </label>
                      )}
                      {j.drift && <div style={{ fontSize: 11.5, color: '#fcd34d', marginTop: 6 }}>{driftText(j.drift)}</div>}
                    </div>
                  );
                })}
              </div>
              <div style={ROW}>
                <span className="muted" style={{ fontSize: 12, minWidth: 0, flex: '1 1 320px' }}>새 VM 은 꺼진 채로 만들어집니다. 끊은 채로를 고르면 복원이 끝난 뒤 포탈이 그 VM 의 네트워크 어댑터를 모두 끊습니다(켤 때도 연결 안 함 — 원본과 같은 IP · 호스트명 충돌 방지).</span>
                {issue2 && <span style={{ fontSize: 12, color: '#fcd34d' }}>{issue2}</span>}
                <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 14px', marginLeft: 'auto' }} disabled={!!issue2} onClick={preview}>다음: 미리 보기</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              {checkErr && <ErrorBox error={checkErr} />}
              {!check && !checkErr && <Loading />}
              {check && (
                <>
                  <div className="table-wrap">
                    <STable minWidth={620} wrap={false}>
                      <thead><tr><th>VM</th><th>방식 · 대상</th><th data-nosort="">네트워크</th><th>판정</th></tr></thead>
                      <tbody>
                        {check.plan.items.map((x) => (
                          <tr key={x.id}>
                            <td data-sort={x.vmName}><b>{x.vmName || x.id}</b></td>
                            <td style={{ fontSize: 12.5 }}>{MODE_SHORT[x.mode] || '—'}{x.target?.name && x.mode === 'newVm' ? ` ‘${x.target.name}’` : ''}{x.target?.datastore ? ` · ${x.target.datastore}` : ''}{x.target?.allowDisksMismatch ? ' · 디스크 불일치 허용' : ''}</td>
                            <td style={{ fontSize: 12.5 }}>{x.nic ? NIC_LABEL[x.nic] : '—'}</td>
                            <td data-sort={x.ok ? 1 : 0} style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 360, color: x.ok ? '#86efac' : '#fca5a5' }}>{x.ok ? '복원할 수 있음' : x.issue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </STable>
                  </div>
                  {(check.plan.capacity || []).map((c) => <Note key={c.datastore} tone={c.verdict === 'short' ? 'bad' : c.verdict === 'unknown' ? 'warn' : 'info'}>{capacityText(c)}</Note>)}
                  {check.plan.issue && <Note tone="bad">{check.plan.issue}</Note>}
                  {check.needEnroll && <Note tone="bad">복원은 OTP 가 등록된 계정만 실행할 수 있습니다 — 사용자 관리에서 OTP 를 등록하세요.</Note>}
                  {err && <Note tone="bad">{err}</Note>}
                  <div style={ROW}>
                    <label className="muted" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, width: 200 }}>본인 OTP(6자리)
                      <input className="input" style={INP} inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!planOk} />
                    </label>
                    <span className="muted" style={{ fontSize: 12, minWidth: 0, flex: '1 1 260px' }}>OTP 는 묶음에 한 번 · 실행자 · 대상 · 원본 체인은 감사 로그에 남습니다. 한 법인 Director 에서 차례로 시작합니다.</span>
                    <button type="button" className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginLeft: 'auto' }} disabled={!planOk || !/^\d{6}$/.test(otp) || busy || check.needEnroll} onClick={run}>{busy ? '요청 중…' : `복원 시작 · ${picked.length}대`}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>}

      {/* ── 최근 묶음 진행 ── */}
      {batch.total > 0 && (
        <div className="card" data-bareos-restore-batch="" style={{ padding: 12, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={ROW}>
            <b style={{ fontSize: 13.5 }}>최근 묶음 복원</b>
            <span className="muted" style={{ fontSize: 12 }}>{batch.total}대 · 진행 {batch.open} · 성공 {batch.ok} · 실패 {batch.bad}{batch.nicFailed ? ` · 네트워크 끊기 실패 ${batch.nicFailed}` : ''}</span>
            <span className="muted" style={{ fontSize: 11.5, marginLeft: 'auto' }}>상태는 목록을 다시 읽을 때 바뀝니다(폴러)</span>
          </div>
          {batch.rows.some(({ r }) => r.nic === 'disconnect' && (!r.finish || r.finish.nic === 'pending')) && (
            <Note tone="warn">네트워크 끊기가 끝나기 전(끊음 표시 전)에는 새 VM 을 켜지 마세요 — 끊기는 복원이 끝난 뒤 그 vCenter 의 작업 순서대로 돕니다. 켜진 VM 은 포탈이 손대지 않습니다.</Note>
          )}
          <div className="table-wrap">
            <STable minWidth={640} wrap={false}>
              <thead><tr><th>VM</th><th>복원 jobid</th><th>대상</th><th>상태</th><th>네트워크</th></tr></thead>
              <tbody>
                {batch.rows.map(({ id, vmName, r }) => {
                  const b = stateBadge(r.state, r.status);
                  return (
                    <tr key={`${id}-${r.jobid}`}>
                      <td data-sort={vmName}><b>{vmName}</b></td>
                      <td data-sort={r.jobid}>{r.jobid}</td>
                      <td style={{ fontSize: 12.5 }}>{MODE_SHORT[r.mode] || '—'}{r.target?.name && r.mode === 'newVm' ? ` ‘${r.target.name}’` : ''}</td>
                      <td><span className={`badge ${b.cls}`}>{b.label}</span></td>
                      <td style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 360, color: FINISH_COLOR[finishTone(r)] }}>{finishText(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          </div>
        </div>
      )}
      {/* v2.862 복원 검증(리허설) — 정책 · 지금 검증 · 결과 */}
      <BareosRehearsal directors={d.directors || []} />
      <ReadGuide note="복원은 등록 때 vCenter 로만 됩니다(Bareos VMware 플러그인 제약). 덮어쓰기는 1대씩 — VM 이 꺼져 있고 스냅샷이 없어야 합니다.">
        <div>① 왼쪽 트리는 백업 대상으로 등록된 VM 만 보입니다. 한 번에 한 법인(그 법인의 Director)만 고를 수 있습니다 — 법인 · vCenter · Bareos 는 1:1:1 입니다.</div>
        <div>② 복원 지점은 성공한 백업(정상 · 경고)이고, 증분 · 차등은 Full 부터의 체인을 서버가 이 잡의 카탈로그 이력으로 계산합니다.</div>
        <div>③ 데이터스토어를 고르면 같은 데이터스토어로 가는 VM 의 사용량 합이 여유보다 작아야 합니다(가득 차면 그 위의 VM 이 멈춥니다). 값을 못 읽으면 판정하지 않고 알립니다.</div>
        <div>④ 네트워크 어댑터 끊기 — 복원이 성공으로 끝나면 그 vCenter 에 로그인하는 노드(중앙 또는 법인 엣지)가 새 VM 을 이름으로 찾아 끊습니다. 같은 이름이 둘이거나 이미 켜져 있으면 손대지 않고 사유를 남깁니다.</div>
      </ReadGuide>
    </div>
  );
}
