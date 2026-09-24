/**
 * VmSeriesSettings.jsx — 설정 › VM 실시간 스파이크 수집(v2.510).
 *
 * 사용자 요구: 50분마다 모든 VM 의 CPU/메모리를 수집해 보관하되 **vCenter 별 DB 분리**, 전체/특정 vCenter
 * 선택, 특정 vCenter 는 클러스터·폴더·호스트·VM 을 **복수 선택**. 저장은 임계 이상 순간만(50% 결정).
 *
 * 화면 규약(CLAUDE.md): 훅은 조기 return 위 · 표는 STable · 주기/버퍼/임계 숫자는 서버 값으로 문구 생성 ·
 * 예상 크기는 지어내지 않고 **실측 DB 크기와 마지막 수집 결과**만 보인다(임계 이상 표본 수는 워크로드 의존).
 */
import { blankOr } from './blankOr.js';
import { scopeSaveSuffix } from './scopeSaveText.js';
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson, putJson, postJson, sendJson } from '../api.js';
import { STable } from '../components/STable.jsx';
import { Loading, ErrorBox } from '../components/ui.jsx';
import { fmtBytes, intervalWarning, thresholdText, scopeSummaryText, lastRunText } from './vmSeriesText.js';
import BoldText from '../components/boldText.jsx';
import { vcAuthSkipNote } from './authSkipText.js'; // v2.591(감사 F1): vCenter 인증 정지로 건너뛴 vCenter

const EMPTY_T = () => ({ clusters: [], folders: [], hosts: [], vms: [] });

/** VM 이 상위 선택(클러스터·호스트·폴더)으로 이미 덮이는가 — 서버 scope.js 와 같은 규칙. */
function coveredVm(vm, t, hostNameById) {
  if (!t || t.all) return !!t?.all;
  if ((t.clusters || []).includes(vm.cluster)) return true;
  if ((t.hosts || []).some((hid) => hostNameById.get(hid) === vm.host)) return true;
  return (t.folders || []).some((f) => f && (vm.folder === f || vm.folder.startsWith(`${f}/`)));
}

function buildFolders(vms) {
  const root = { name: '', path: '', folders: {}, vms: [], count: 0 };
  for (const vm of vms) {
    const parts = String(vm.folder || '').split('/').filter(Boolean);
    let node = root; root.count++;
    let acc = '';
    for (const p of parts) { acc = acc ? `${acc}/${p}` : p; if (!node.folders[p]) node.folders[p] = { name: p, path: acc, folders: {}, vms: [], count: 0 }; node = node.folders[p]; node.count++; }
    node.vms.push(vm);
  }
  return root;
}

function FolderNode({ node, t, setT, open, toggleOpen, hostNameById, filter }) {
  const kids = Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name));
  const folderOn = (t.folders || []).includes(node.path);
  const flip = (key, val) => setT((cur) => { const arr = new Set(cur[key] || []); if (arr.has(val)) arr.delete(val); else arr.add(val); return { ...cur, [key]: [...arr] }; });
  const vms = node.vms.filter((v) => !filter || v.name.toLowerCase().includes(filter));
  const show = !filter || vms.length || kids.length;
  if (!show) return null;
  return (
    <div style={{ marginLeft: node.path ? 14 : 0 }}>
      {node.path && (
        <div className="flex gap" style={{ alignItems: 'center', fontSize: 12.5, padding: '2px 0' }}>
          <span className="vcd-caret" style={{ cursor: 'pointer', width: 12 }} onClick={() => toggleOpen(node.path)}>{open[node.path] ? '▾' : '▸'}</span>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={folderOn} onChange={() => flip('folders', node.path)} /> 📁 {node.name} <span className="muted" style={{ fontSize: 11 }}>{node.count} VM</span>
          </label>
        </div>
      )}
      {(open[node.path] || !node.path || filter) && (
        <>
          {kids.map((k) => <FolderNode key={k.path} node={k} t={t} setT={setT} open={open} toggleOpen={toggleOpen} hostNameById={hostNameById} filter={filter} />)}
          {vms.map((vm) => {
            const covered = coveredVm(vm, t, hostNameById) || folderOn;
            const on = (t.vms || []).includes(vm.id);
            return (
              <label key={vm.id} className="flex gap" style={{ alignItems: 'center', fontSize: 12, marginLeft: 26, padding: '1px 0', cursor: 'pointer', opacity: vm.on ? 1 : 0.55 }} title={vm.on ? '' : '전원 꺼짐 — 실시간 표본이 없어 수집되지 않습니다(켜지면 자동 포함)'}>
                <input type="checkbox" checked={on || covered} disabled={covered} onChange={() => flip('vms', vm.id)} /> 🧊 {vm.name}
                <span className="muted" style={{ fontSize: 11 }}>{vm.vcpu}vCPU · {Math.round(vm.memMB / 1024)}GB{vm.on ? '' : ' · OFF'}</span>
              </label>
            );
          })}
        </>
      )}
    </div>
  );
}

/** 한 vCenter 의 범위 편집기 — 호스트/클러스터 · VM/폴더 두 트리, 복수 선택. */
function ScopePicker({ vcenterId, t, setT }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState({});
  const [q, setQ] = useState('');
  useEffect(() => { let alive = true; setD(null); setErr(null); fetchJson('/tools/vmseries/scope-data', { vcenterId }).then((r) => alive && setD(r)).catch((e) => alive && setErr(e.message)); return () => { alive = false; }; }, [vcenterId]);
  const hostNameById = useMemo(() => new Map((d?.hosts || []).map((h) => [h.id, h.name])), [d]);
  const tree = useMemo(() => buildFolders(d?.vms || []), [d]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const flip = (key, val) => setT((cur) => { const arr = new Set(cur[key] || []); if (arr.has(val)) arr.delete(val); else arr.add(val); return { ...cur, [key]: [...arr] }; });
  const filter = q.trim().toLowerCase();
  const byCluster = new Map();
  for (const h of d.hosts) { if (!byCluster.has(h.cluster)) byCluster.set(h.cluster, []); byCluster.get(h.cluster).push(h); }
  return (
    <div className="flex gap wrap" style={{ gap: 14, marginTop: 8, alignItems: 'flex-start' }}>
      <div className="card" style={{ flex: '1 1 300px', minWidth: 260, padding: 10, maxHeight: 360, overflowY: 'auto' }}>
        <b style={{ fontSize: 12.5 }}>호스트/클러스터</b> <span className="muted" style={{ fontSize: 11 }}>— 클러스터·호스트를 고르면 그 위의 VM 도 대상</span>
        {[...byCluster.keys()].sort().map((cl) => {
          const clOn = (t.clusters || []).includes(cl);
          return (
            <div key={cl} style={{ marginTop: 6 }}>
              <label className="flex gap" style={{ alignItems: 'center', fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={clOn} onChange={() => flip('clusters', cl)} /> 🧩 {cl} <span className="muted" style={{ fontSize: 11 }}>{byCluster.get(cl).length} 호스트</span>
              </label>
              {byCluster.get(cl).map((h) => (
                <label key={h.id} className="flex gap" style={{ alignItems: 'center', fontSize: 12, marginLeft: 22, padding: '1px 0', cursor: 'pointer', opacity: h.state === 'DISCONNECTED' ? 0.55 : 1 }}>
                  <input type="checkbox" checked={clOn || (t.hosts || []).includes(h.id)} disabled={clOn} onChange={() => flip('hosts', h.id)} /> 🖥️ {h.name}{h.state === 'DISCONNECTED' ? <span className="muted"> · 연결 끊김</span> : null}
                </label>
              ))}
            </div>
          );
        })}
        {d.hosts.length === 0 && <div className="muted" style={{ fontSize: 12 }}>호스트가 없습니다.</div>}
      </div>
      <div className="card" style={{ flex: '1 1 340px', minWidth: 280, padding: 10, maxHeight: 360, overflowY: 'auto' }}>
        <div className="flex between" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span><b style={{ fontSize: 12.5 }}>VM/폴더</b> <span className="muted" style={{ fontSize: 11 }}>— 폴더는 하위 폴더까지</span></span>
          <input className="input" style={{ width: 160, padding: '3px 8px', fontSize: 12 }} placeholder="VM 이름 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <FolderNode node={tree} t={t} setT={setT} open={open} toggleOpen={(p) => setOpen((o) => ({ ...o, [p]: !o[p] }))} hostNameById={hostNameById} filter={filter} />
        {d.vms.length === 0 && <div className="muted" style={{ fontSize: 12 }}>VM 이 없습니다.</div>}
      </div>
    </div>
  );
}

export default function VmSeriesSettings() {
  // ⚠ 훅은 전부 조기 return 위(CLAUDE.md — React #310).
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(50);
  const [retentionDays, setRetentionDays] = useState(60);
  const [thr, setThr] = useState({ cpuPct: 50, memPct: 50, readyPct: 5 });
  const [scope, setScope] = useState('all');
  const [targets, setTargets] = useState({});
  const [editing, setEditing] = useState(null);   // 범위 편집 중인 vCenter id
  const [dropExcluded, setDropExcluded] = useState(false);

  const load = async () => {
    try {
      const r = await fetchJson('/tools/vmseries/settings');
      setD(r); setErr(null);
      const s = r.settings;
      setEnabled(!!s.enabled); setIntervalMin(s.intervalMin); setRetentionDays(s.retentionDays); setThr(s.thresholds || {}); setScope(s.scope || 'all'); setTargets(s.targets || {});
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/vmseries/settings', { enabled, intervalMin: blankOr(intervalMin), retentionDays: blankOr(retentionDays), thresholds: { cpuPct: blankOr(thr.cpuPct), memPct: blankOr(thr.memPct), readyPct: blankOr(thr.readyPct) }, scope, targets, dropExcluded });
      if (r && r.ok === false) throw new Error(r.reason || '저장 실패');
      setMsg(`저장되었습니다.${(r.dropped || []).length ? ` 제외된 ${r.dropped.length}개 vCenter 의 DB 파일을 삭제했습니다.` : ''} 주기·범위 변경은 다음 틱부터 즉시 반영됩니다.${scopeSaveSuffix(r)}`);
      await load();
    } catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setMsg('수집 중… (vCenter 수·대상 수에 따라 수십 초~수 분)');
    try { const r = await postJson('/tools/vmseries/run', {}); setMsg(r.skipped ? r.reason : r.ok ? `수집 완료 — ${lastRunText(r)}` : `수집 결과: ${r.reason || lastRunText(r)}`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };
  const dropOne = async (vcId) => {
    if (!window.confirm(`${vcId} 의 스파이크 데이터 파일을 삭제합니다(복구 불가). 계속할까요?`)) return;
    setBusy(true);
    try { await sendJson(`/tools/vmseries/data?vcenterId=${encodeURIComponent(vcId)}`, 'DELETE', {}); setMsg(`${vcId} 데이터를 삭제했습니다.`); await load(); }
    catch (e) { setMsg(`오류: ${e.message}`); }
    finally { setBusy(false); }
  };

  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const L = d.limits || {};
  const usage = d.usage || [];
  const resolvedBy = new Map((d.resolved || []).map((r) => [r.vcenterId, r]));
  const st = d.status || {};
  const toggleVc = (id) => setTargets((cur) => { const next = { ...cur }; if (next[id]) delete next[id]; else next[id] = { all: true }; return next; });
  const setVcMode = (id, all) => setTargets((cur) => ({ ...cur, [id]: all ? { all: true } : EMPTY_T() }));
  const setT = (id) => (fn) => setTargets((cur) => ({ ...cur, [id]: typeof fn === 'function' ? fn(cur[id] || EMPTY_T()) : fn }));
  const countSel = (t) => (!t ? 0 : t.all ? null : (t.clusters?.length || 0) + (t.folders?.length || 0) + (t.hosts?.length || 0) + (t.vms?.length || 0));

  return (
    <div>
      <div className="card" style={{ padding: 16 }}>
        <div className="flex between wrap" style={{ alignItems: 'center', marginBottom: 6 }}>
          <b style={{ fontSize: 14 }}>VM 실시간 스파이크 수집 (20초 표본 · 임계 이상 순간만 저장)</b>
          <span className="muted" style={{ fontSize: 12 }}>DB 합계 <b style={{ color: 'var(--text)' }}>{fmtBytes(d.totalBytes)}</b>{d.freeBytes != null ? <> · 디스크 여유 <b style={{ color: 'var(--text)' }}>{fmtBytes(d.freeBytes)}</b></> : null}</span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.65, whiteSpace: 'normal' }}>
          ESXi 가 보관하는 <b>20초 실시간 표본</b>을 주기마다 받아, 임계 이상인 순간의 <b>모든 카운터 값</b>(CPU 사용률/MHz/Ready · 메모리 usage/active/consumed/벌룬/스왑 · 디스크·네트워크 처리량)을 남깁니다.
          평균·p95 는 vCenter 롤업이 맡고(롤업은 평균을 보존), 이 수집은 롤업이 없애는 <b>피크·스파이크 빈도·지속시간</b>을 남깁니다. 자원 축소 근거 리포트의 <b>Local + vCenter</b> 템플릿에서 봅니다.
          <br />DB 는 <b>vCenter 마다 독립 파일</b>(<code>vmseries/&lt;id&gt;.db</code>)이라 대상에서 빼면 파일째 지워 용량을 즉시 회수합니다. 크기는 임계 이상 표본 수에 비례해 워크로드마다 다르므로 예측값 대신 아래 <b>실측 크기</b>를 보세요.
          {d.mock && <><br /><span className="badge gray">데모(mock)</span> 실시간 표본이 없어 수집하지 않습니다(리포트는 합성값을 배지와 함께 표시).</>}
        </div>

        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 16, marginBottom: 8 }}>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <b>수집 사용</b></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">주기</span>
            <input className="input" type="number" min={L.minIntervalMin || 20} max={L.maxIntervalMin || 60} style={{ width: 80 }} value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} /> <span className="muted">분</span></label>
          <label className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">보존</span>
            <input className="input" type="number" min={0} max={L.maxRetentionDays || 1830} style={{ width: 90 }} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} /> <span className="muted">일 (0 = 무제한)</span></label>
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10, whiteSpace: 'normal' }}>⚠ {intervalWarning(Number(intervalMin))}</div>

        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 16, marginBottom: 4 }}>
          <span className="muted" style={{ fontSize: 13 }}>저장 임계</span>
          {[['cpuPct', 'CPU 사용률 ≥', '%'], ['memPct', '메모리(active) ≥', '%'], ['readyPct', 'Ready ≥', '%/vCPU']].map(([k, label, unit]) => (
            <label key={k} className="flex gap" style={{ alignItems: 'center', fontSize: 13 }}><span className="muted">{label}</span>
              <input className="input" type="number" min={0} max={100} step={1} style={{ width: 70 }} value={thr[k] ?? ''} onChange={(e) => setThr((c) => ({ ...c, [k]: e.target.value }))} /> <span className="muted">{unit}</span></label>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12, whiteSpace: 'normal' }}>저장 기준: {thresholdText({ cpuPct: Number(thr.cpuPct), memPct: Number(thr.memPct), readyPct: Number(thr.readyPct) })} — 0 은 그 트리거를 끕니다. 임계를 바꿔도 과거 표본은 재계산되지 않습니다(버린 표본은 없고, 그 시점부터 새 임계로 저장).</div>

        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 16, marginBottom: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>수집 범위</span>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', fontSize: 13 }}><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> 모든 vCenter (전원 ON VM 전부 + 호스트 전부)</label>
          <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', fontSize: 13 }}><input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} /> 특정 vCenter 선택</label>
          <span className="muted" style={{ fontSize: 12 }}>{scopeSummaryText({ scope }, scope === 'all' ? d.resolved : (d.resolved || []).filter((r) => targets[r.vcenterId]))}</span>
        </div>

        {scope === 'selected' && (
          <div style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>vCenter 를 고르고, 각 vCenter 는 <b>전체</b> 또는 <b>범위 선택</b>(클러스터·폴더·호스트·VM 복수 선택). 위임(엣지) vCenter 는 중앙 설정이 엣지로 내려가 엣지가 수집해 올립니다.</div>
            <div className="table-wrap">
              <STable>
                <thead><tr><th data-nosort>대상</th><th>vCenter</th><th>수집</th><th>범위</th><th style={{ textAlign: 'right' }}>해석된 대상</th><th data-nosort>편집</th></tr></thead>
                <tbody>
                  {(d.vcenters || []).map((v) => {
                    const t = targets[v.id]; const on = !!t; const res = resolvedBy.get(v.id);
                    const n = countSel(t);
                    return (
                      <React.Fragment key={v.id}>
                        <tr>
                          <td data-nosort><input type="checkbox" checked={on} onChange={() => toggleVc(v.id)} /></td>
                          <td><b>{v.name}</b> <span className="muted" style={{ fontSize: 11 }}>{v.id}</span></td>
                          <td>{v.collectSource === 'site' ? <span className="badge gray">엣지 위임</span> : <span className="badge blue">중앙</span>}</td>
                          <td>{!on ? <span className="muted">—</span> : (
                            <span className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
                              <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', fontSize: 12 }}><input type="radio" checked={!!t.all} onChange={() => setVcMode(v.id, true)} /> 전체</label>
                              <label className="flex gap" style={{ alignItems: 'center', cursor: 'pointer', fontSize: 12 }}><input type="radio" checked={!t.all} onChange={() => setVcMode(v.id, false)} /> 범위 선택{n != null ? ` (${n}개 항목)` : ''}</label>
                            </span>) }</td>
                          <td style={{ textAlign: 'right' }} data-sort={res ? res.vms + res.hosts : 0}>{on && res ? `VM ${res.vms} · 호스트 ${res.hosts}` : <span className="muted">—</span>}</td>
                          <td data-nosort>{on && !t.all && <button className="tab" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setEditing(editing === v.id ? null : v.id)}>{editing === v.id ? '닫기' : '범위 편집'}</button>}</td>
                        </tr>
                        {editing === v.id && on && !t.all && (
                          <tr><td colSpan={6} style={{ background: 'rgba(148,163,184,.05)' }}><ScopePicker vcenterId={v.id} t={t} setT={setT(v.id)} /></td></tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </STable>
            </div>
            <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12, marginTop: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={dropExcluded} onChange={(e) => setDropExcluded(e.target.checked)} /> 저장 시 선택에서 빠진 vCenter 의 DB 파일을 삭제해 용량 회수(복구 불가)
            </label>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>※ 해석된 대상은 지금 스냅샷 기준입니다. 선택한 폴더·클러스터에 VM 이 새로 생기면 다음 주기에 자동 포함됩니다.</div>
          </div>
        )}

        <div className="flex gap wrap" style={{ alignItems: 'center', gap: 10 }}>
          <button className="login-btn" style={{ padding: '8px 18px' }} disabled={busy} onClick={save}>{busy ? '처리 중…' : '저장'}</button>
          <button className="logout-btn" disabled={busy || d.mock} title={d.mock ? '데모 모드에서는 수집하지 않습니다' : '설정된 범위로 지금 1회 수집(진행 중이면 건너뜀)'} onClick={runNow}>지금 수집</button>
          {msg && <span className="muted" style={{ fontSize: 13, whiteSpace: 'normal' }}>{msg}</span>}
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>수집 상태</b>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {st.running ? '🔄 지금 수집 중… ' : ''}마지막 수집: {lastRunText(st.lastResult)}
          <br />적용 주기 <b style={{ color: 'var(--text)' }}>{Math.round((st.intervalMs || 0) / 60_000)}분</b> · 동시 vCenter <b style={{ color: 'var(--text)' }}>{st.concurrency}</b> · 디스크 여유 가드 <b style={{ color: 'var(--text)' }}>{fmtBytes(st.minFreeBytes)}</b>
          {vcAuthSkipNote(st.lastResult?.skipped, { what: '실시간 스파이크 수집', manual: '지금 수집' })
            && <><br /><span style={{ color: 'var(--red)' }}><BoldText text={vcAuthSkipNote(st.lastResult?.skipped, { what: '실시간 스파이크 수집', manual: '지금 수집' })} /></span></>}
          {d.push?.enabled && <><br />엣지 → 중앙 push: 켜짐 ({d.push.centralUrl}){d.push.last ? ` · 마지막 ${new Date(d.push.last.at).toLocaleString('ko-KR')} ${d.push.last.error ? `실패: ${d.push.last.error}` : `${d.push.last.chunks}청크 ${fmtBytes(d.push.last.gzBytes)}`}` : ''}</>}
        </div>
        {(st.lastResult?.errors || []).length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: 180 }}>
            <STable>
              <thead><tr><th>실패 vCenter</th><th>오류</th></tr></thead>
              <tbody>{st.lastResult.errors.map((e, i) => <tr key={i}><td>{e.vcenterId}</td><td style={{ whiteSpace: 'normal' }}>{e.error}{e.hint ? ` — ${e.hint}` : ''}</td></tr>)}</tbody>
            </STable>
          </div>
        )}
        {(st.lastResult?.per || []).length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: 260 }}>
            <STable>
              <thead><tr><th>vCenter</th><th style={{ textAlign: 'right' }}>대상 VM</th><th style={{ textAlign: 'right' }}>호스트</th><th style={{ textAlign: 'right' }}>표본</th><th style={{ textAlign: 'right' }}>스파이크 순간</th><th style={{ textAlign: 'right' }}>저장 행</th><th>비고</th></tr></thead>
              <tbody>{st.lastResult.per.map((p) => (
                <tr key={p.vcenterId}><td>{p.vcenterId}</td><td style={{ textAlign: 'right' }}>{p.vms ?? 0}/{p.targetVms ?? 0}</td><td style={{ textAlign: 'right' }}>{p.hosts ?? 0}/{p.targetHosts ?? 0}</td><td style={{ textAlign: 'right' }}>{(p.samples ?? 0).toLocaleString()}</td><td style={{ textAlign: 'right' }}>{(p.moments ?? 0).toLocaleString()}</td><td style={{ textAlign: 'right' }}>{p.spikeRows ?? 0}</td>
                  <td className="muted" style={{ whiteSpace: 'normal' }}>{p.skipped ? `건너뜀(${p.skipped})` : ''}{(p.missing || []).length ? `카탈로그 없음: ${p.missing.join(', ')}` : ''}{p.pushed ? (p.pushed.ok ? ` · push ${p.pushed.chunks}청크` : ` · push 실패: ${p.pushed.error}`) : ''}</td></tr>
              ))}</tbody>
            </STable>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16, marginTop: 14 }}>
        <b style={{ fontSize: 13.5 }}>저장된 데이터 (vCenter 별 독립 파일 · 실측)</b>
        {usage.length === 0 ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>아직 저장된 파일이 없습니다.</div> : (
          <div className="table-wrap" style={{ marginTop: 8, maxHeight: 300 }}>
            <STable>
              <thead><tr><th>vCenter</th><th>파일</th><th style={{ textAlign: 'right' }}>크기</th><th data-nosort>삭제</th></tr></thead>
              <tbody>{usage.map((u) => (
                <tr key={u.file}><td>{u.vcenterId}</td><td className="muted" style={{ fontSize: 11 }}>{u.file}</td><td style={{ textAlign: 'right' }} data-sort={u.bytes}>{fmtBytes(u.bytes)}</td>
                  <td data-nosort><button className="tab" style={{ padding: '2px 8px', fontSize: 11 }} disabled={busy} onClick={() => dropOne(u.vcenterId)}>삭제</button></td></tr>
              ))}</tbody>
            </STable>
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6, whiteSpace: 'normal' }}>보존일을 줄여도 파일 크기는 즉시 줄지 않습니다(SQLite DELETE 특성 — 특수 기능 › 포탈 DB 의 VACUUM 참조). 대상 제외 + 파일 삭제만 즉시 회수됩니다.</div>
      </div>
    </div>
  );
}
