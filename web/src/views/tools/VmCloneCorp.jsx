import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, delJson } from '../../api.js';
import Select from '../../components/Select.jsx';
import { STable } from '../../components/STable.jsx';
import { requireChanged } from '../changeResult.js';
import { mountLabel } from './vmCloneMountText.js';
import { corpCards, agoText, fmtBytes } from './vmCloneView.js';

/**
 * VM 백업 센터 › 법인 저장소(시안 ⑤, v2.793).
 *  - 법인 = vCenter 를 수집하는 엣지(중앙 직접 수집은 '중앙'). 백업은 그 엣지가 실행한다.
 *  - ESXi NFS 데이터스토어: NFS 를 그 법인 ESXi 호스트에 데이터스토어로 붙인다(호스트 설정 변경 — 호스트별 결과·실패만 다시 시도).
 *    v2.794 떼어 내기: 연결 기록이 있는 호스트에서 뗀다(그 데이터스토어를 쓰는 잡이 있으면 서버가 거부, 호스트의 VM 이 쓰면 그 호스트는 실행 노드가 거부).
 *    '목록에서 삭제' 는 정의만 지운다(ESXi 데이터스토어는 그대로).
 *  - 엣지 NFS 마운트: 그 엣지가 보고한 목록(등록·해제는 그 노드의 설정 › NFS 마운트). 범위 계정·데모 계정에는 주소를 가린다.
 *    v2.794 '백업에 사용' 지정: 켠 마운트만 잡 마법사에 보이고 서버도 그 마운트만 받는다(지정이 없으면 전부 — 이전 판 동작).
 */
export default function VmCloneCorp({ d, now, initialKey, onBack, onReload }) {
  const corps = useMemo(() => d.corps || [], [d.corps]);
  const [key, setKey] = useState(initialKey || corps[0]?.key || '');
  const cards = useMemo(() => corpCards(corps, d.jobs, d.nfsDatastores, now), [corps, d, now]);
  const c = corps.find((x) => x.key === key) || corps[0] || null;
  const card = cards.find((x) => x.key === c?.key);
  const [msg, setMsg] = useState(null);
  const [busyId, setBusyId] = useState('');
  // v2.794 '백업에 사용' 초안 — null 이면 서버 값 그대로(지정 없음 = 전부).
  const [useDraft, setUseDraft] = useState(null);
  useEffect(() => { setUseDraft(null); }, [c?.key, c?.mountUse?.at]);

  if (!c) return (
    <div className="vbk"><div className="vbk-crumb"><button type="button" onClick={onBack}>VM 백업</button> › 법인 저장소</div><div className="muted">조회 범위에 vCenter 가 없습니다.</div></div>
  );
  const vcIds = new Set(c.vcenterIds || []);
  const items = (d.nfsDatastores || []).filter((x) => vcIds.has(String(x.vcenterId)));
  const mounts = c.agent ? (c.edge?.mounts || []) : (d.mounts || []);
  const nfsOps = (d.ops || []).filter((o) => (o.kind === 'nfsds-attach' || o.kind === 'nfsds-detach') && vcIds.has(String(o.vcenterId)));
  const writable = new Set(c.writable || []);
  const corpEditable = c.key !== 'unassigned' && (c.vcenterIds || []).length > 0 && (c.vcenterIds || []).every((id) => writable.has(String(id)));
  const savedUse = Array.isArray(c.mountUse?.mountIds) ? new Set(c.mountUse.mountIds) : null;
  const useSet = useDraft || savedUse || new Set(mounts.map((m) => m.id));
  const useDirty = !!useDraft;
  const saveUse = async (ids) => {
    setBusyId('mount-use'); setMsg(null);
    try {
      const r = await putJson('/tools/vm-clone/corps/mounts', { corpKey: c.key, mountIds: ids });
      if (r.ok === false) { setMsg(`저장 불가: ${r.reason}`); return; }
      setMsg(ids == null ? '지정을 해제했습니다 — 이 법인의 모든 마운트를 백업 대상으로 고를 수 있습니다.' : `백업에 쓸 마운트 ${ids.length}개를 저장했습니다. 이미 저장된 잡은 그대로 돕니다.`);
      setUseDraft(null);
      await onReload();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusyId(''); }
  };
  const detach = async (it) => {
    const attached = Object.entries(it.hosts || {}).filter(([, h]) => h.ok).length;
    if (!window.confirm(`'${it.name}' 을 ESXi 호스트 ${attached}대에서 떼어 낼까요?\n· 이 데이터스토어를 대상으로 쓰는 백업 잡이 있으면 거부합니다.\n· 그 호스트의 VM(백업 사본·복구 VM)이 쓰고 있으면 그 호스트는 떼지 않습니다.\n· NFS 서버의 파일은 지우지 않습니다.`)) return;
    setBusyId(it.id); setMsg(null);
    try {
      const r = await postJson(`/tools/vm-clone/nfs-datastores/${encodeURIComponent(it.id)}/detach`, {});
      setMsg(r.ok ? `떼어 내기를 ${r.where === 'edge' ? `담당 엣지(${r.agent})로 보냈습니다` : '실행 큐에 넣었습니다'} — 호스트별 결과는 표에 나옵니다.` : `떼어 낼 수 없습니다: ${r.reason}`);
      await onReload();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusyId(''); }
  };

  const retry = async (it) => {
    setBusyId(it.id); setMsg(null);
    try {
      const hosts = await fetchJson('/hosts', { vcenterId: it.vcenterId });
      const ids = (hosts.items || []).map((h) => h.id).filter((id) => !it.hosts?.[id]?.ok);
      if (!ids.length) { setMsg('연결되지 않은 호스트가 없습니다.'); return; }
      const r = await postJson(`/tools/vm-clone/nfs-datastores/${encodeURIComponent(it.id)}/attach`, { hostIds: ids });
      setMsg(r.ok ? `호스트 ${ids.length}대 연결을 ${r.where === 'edge' ? `담당 엣지(${r.agent})로 보냈습니다` : '실행 큐에 넣었습니다'}.` : `연결 불가: ${r.reason}`);
      await onReload();
    } catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusyId(''); }
  };
  const forget = async (it) => {
    if (!window.confirm(`'${it.name}' 정의를 목록에서 지울까요?\n(ESXi 호스트의 데이터스토어와 그 안의 사본은 그대로입니다 — 호스트에서 떼려면 먼저 '떼어 내기')`)) return;
    setBusyId(it.id); setMsg(null);
    try { requireChanged(await delJson(`/tools/vm-clone/nfs-datastores/${encodeURIComponent(it.id)}`)); await onReload(); }
    catch (e) { setMsg(`오류: ${e.message}`); } finally { setBusyId(''); }
  };

  return (
    <div className="vbk">
      <div className="vbk-head">
        <div>
          <div className="vbk-crumb"><button type="button" onClick={onBack}>VM 백업</button> › 법인 저장소</div>
          <h2 className="vbk-title">법인 백업 설정</h2>
          <div className="vbk-sub">법인마다 백업 저장소를 정합니다. 백업은 그 법인 vCenter 를 수집하는 엣지가 실행하고, 법인끼리는 동시에 돕니다(법인 안에서는 한 번에 1개).</div>
        </div>
      </div>
      {msg && <div className="vbk-note info">{msg}</div>}

      <div className="vbk-cols">
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <nav className="vbk-panel vbk-corpnav" aria-label="법인">
            {cards.map((x) => (
              <button type="button" key={x.key} className={x.key === c.key ? 'on' : ''} onClick={() => setKey(x.key)}>
                <span className="flex between" style={{ gap: 8 }}><b>{x.name}</b><span style={{ fontSize: 11.5, color: x.state === 'ok' || x.state === 'central' ? '#86efac' : x.state === 'sim' ? 'var(--text-dim)' : '#fcd34d' }}>{x.stateLabel}</span></span>
                <small>{x.sub}</small>
              </button>
            ))}
          </nav>
        </div>

        <div className="vbk-main">
          <div className="vbk-panel"><div className="bd flex wrap" style={{ gap: 18, alignItems: 'center' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{c.label}</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{[...vcIds].map((id) => d.vcenterNames?.[id] || id).join(' · ')}</div>
            </div>
            <div className="flex wrap" style={{ gap: 18, fontSize: 12.5 }}>
              <div><div className="muted">실행 위치</div><div style={{ fontWeight: 600, marginTop: 2 }}>{c.agent ? `엣지 ${c.agent}${c.edge?.version ? ` · v${c.edge.version}` : ''}` : c.simulated ? '데모(이 포탈이 시뮬레이션)' : c.key === 'central' ? '중앙(이 포탈)' : '담당 미확정'}</div></div>
              {c.agent && <div><div className="muted">백업 위임</div><div style={{ fontWeight: 600, marginTop: 2, color: c.edge ? '#86efac' : '#fcd34d' }}>{c.edge ? `보고 ${agoText(c.edge.at, now)}` : '아직 보고 없음'}</div></div>}
              <div><div className="muted">실행 상태</div><div style={{ fontWeight: 600, marginTop: 2 }}>{card?.running ? `실행 중 · ${card.running.phase || ''}` : '유휴'} · 대기 {card?.queued || 0}</div></div>
            </div>
            {c.problem && <div className="vbk-note" style={{ flexBasis: '100%' }}>{c.problem}</div>}
            {c.agent && !c.edge && <div className="vbk-note info" style={{ flexBasis: '100%' }}>엣지 {c.agent} 가 VM 백업 위임 보고를 아직 올리지 않았습니다 — 엣지를 이 판 이상으로 업그레이드하고, 엣지별 개별 토큰을 쓰는지 확인하세요(공유 토큰은 거부합니다).</div>}
            {c.edge?.sync && (() => {
              // 범위 계정에는 서버가 개수만 준다(다른 vCenter 의 VM 이름이 섞이므로) — 배열이면 내용, 수면 건수.
              const s = c.edge.sync;
              const list = [...(Array.isArray(s.conflicts) ? s.conflicts : []), ...(Array.isArray(s.invalid) ? s.invalid : [])];
              const n = Array.isArray(s.conflicts) || Array.isArray(s.invalid) ? list.length : (Number(s.conflicts) || 0) + (Number(s.invalid) || 0);
              return (
                <>
                  {n > 0 && <div className="vbk-note" style={{ flexBasis: '100%' }}>엣지가 받지 않은 위임 잡 {n}건{list.length ? `: ${list.join(' · ')}` : ''}</div>}
                  {s.suspended > 0 && <div className="vbk-note" style={{ flexBasis: '100%' }}>담당이 바뀐 vCenter 의 위임 잡 {s.suspended}개를 엣지가 멈췄습니다(원장·이력은 남김).</div>}
                  {s.error && <div className="vbk-note" style={{ flexBasis: '100%' }}>{s.error}</div>}
                </>
              );
            })()}
          </div></div>

          <div className="vbk-panel">
            <div className="hd">
              <div style={{ minWidth: 0 }}>
                <div className="vbk-sec">ESXi NFS 데이터스토어</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>NFS 를 이 법인 ESXi 호스트에 데이터스토어로 붙입니다. 클론이 vCenter 서버측 복사로 NFS 에 바로 써지고, 사본을 켜서 검증·복구할 수 있습니다.</div>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={780}>
                <thead><tr><th>데이터스토어</th><th>NFS</th><th>연결 호스트</th><th style={{ textAlign: 'right' }}>여유 / 전체</th><th className="right" data-nosort>작업</th></tr></thead>
                <tbody>
                  {items.length === 0 && <tr><td colSpan={5} className="center muted" style={{ padding: 18 }}>이 법인에 정의된 NFS 데이터스토어가 없습니다.</td></tr>}
                  {items.map((it) => {
                    const pct = it.hostsTotal ? Math.round((it.hostsOk / it.hostsTotal) * 100) : 0;
                    const failed = Object.values(it.hosts || {}).filter((h) => !h.ok);
                    const running = nfsOps.find((o) => o.state !== 'done' && o.target === it.name);
                    const usedBy = (d.jobs || []).filter((j) => j.dest?.nfsDsId === it.id).length;
                    return (
                      <tr key={it.id}>
                        <td data-sort={it.name}><div style={{ fontWeight: 600 }}>{it.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{d.vcenterNames?.[it.vcenterId] || it.vcenterId}{usedBy ? ` · 잡 ${usedBy}개가 사용` : ''}</div></td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{it.server}:{it.exportPath} · NFS {it.nfsVersion}</td>
                        <td data-sort={it.hostsOk}>
                          <div className="flex" style={{ alignItems: 'center', gap: 8 }}>
                            <div className="vbk-bar" style={{ width: 90 }}><b style={{ width: `${pct}%`, background: it.hostsOk === it.hostsTotal && it.hostsTotal ? 'var(--green)' : 'var(--amber)' }} /></div>
                            <span>{it.hostsOk} / {it.hostsTotal}</span>
                          </div>
                          {running && <div style={{ fontSize: 11.5, color: '#fcd34d', marginTop: 3 }}>{running.where === 'edge' && running.state === 'pending' ? `담당 엣지 ${running.agent} 가져가기 대기` : running.kind === 'nfsds-detach' ? '떼어 내는 중' : '연결 중'}</div>}
                          {!running && failed.length > 0 && <div style={{ fontSize: 11.5, color: '#fcd34d', marginTop: 3 }} title={failed.map((h) => h.detail).join('\n')}>실패 {failed.length}대 — {failed[0].detail}</div>}
                        </td>
                        <td style={{ textAlign: 'right' }} data-sort={it.freeGB ?? ''}>{it.freeGB != null && it.capacityGB != null ? `${fmtBytes(it.freeGB * 1024 ** 3)} / ${fmtBytes(it.capacityGB * 1024 ** 3)}` : '—'}</td>
                        <td className="right" style={{ whiteSpace: 'nowrap' }}>
                          <button type="button" className="vbk-btn sm" disabled={busyId === it.id || !!running || !writable.has(String(it.vcenterId))} onClick={() => retry(it)}>미연결 호스트에 연결</button>
                          {' '}<button type="button" className="vbk-btn sm" disabled={busyId === it.id || !!running || !writable.has(String(it.vcenterId)) || !it.hostsOk || usedBy > 0} title={usedBy > 0 ? `이 데이터스토어를 쓰는 잡 ${usedBy}개 — 대상을 바꾼 뒤 떼어 낼 수 있습니다` : !it.hostsOk ? '연결된 호스트가 없습니다' : ''} onClick={() => detach(it)}>떼어 내기</button>
                          {' '}<button type="button" className="vbk-btn sm danger" disabled={busyId === it.id || !writable.has(String(it.vcenterId))} onClick={() => forget(it)}>목록에서 삭제</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </STable>
            </div>
            <NfsDsForm d={d} corp={c} writable={writable} onDone={async (text) => { setMsg(text); await onReload(); }} />
          </div>

          <div className="vbk-panel">
            <div className="hd">
              <div style={{ minWidth: 0 }}>
                <div className="vbk-sec">엣지 NFS 마운트 <small>{c.agent ? `${c.agent} 가 보고한 목록` : '이 포탈의 마운트'}</small></div>
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>노드에 마운트된 NFS 로 vmx·vmdk 파일을 내려받습니다. 등록·해제는 그 노드의 설정 › NFS 마운트에서 합니다. 이 방식의 사본은 vCenter 에 등록되지 않아 검증·즉시 복구가 안 됩니다.{d.mountsMasked ? ' 주소는 가렸습니다.' : ''}</div>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <STable minWidth={560}>
                <thead><tr><th data-nosort style={{ width: 90 }}>백업에 사용</th><th>마운트</th><th>상태</th><th style={{ textAlign: 'right' }}>여유 / 전체</th></tr></thead>
                <tbody>
                  {mounts.length === 0 && <tr><td colSpan={4} className="center muted" style={{ padding: 18 }}>{c.agent && !c.edge ? '엣지 보고 없음' : '마운트가 없습니다'}</td></tr>}
                  {mounts.map((m) => (
                    <tr key={m.id}>
                      <td><label className="flex" style={{ alignItems: 'center', gap: 6 }}><input type="checkbox" aria-label={`${mountLabel(m) || m.label} 백업에 사용`} disabled={!corpEditable || busyId === 'mount-use'} checked={useSet.has(m.id)} onChange={(e) => { const n = new Set(useSet); if (e.target.checked) n.add(m.id); else n.delete(m.id); setUseDraft(n); }} />{useSet.has(m.id) ? '사용' : <span className="muted">안 씀</span>}</label></td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{mountLabel(m) || m.label}</td>
                      <td>{m.mounted ? <span className="vbk-chip ok">마운트됨</span> : <span className="vbk-chip warn">미마운트</span>}</td>
                      <td style={{ textAlign: 'right' }} data-sort={m.freeBytes ?? ''}>{m.freeBytes != null && m.totalBytes != null ? `${fmtBytes(m.freeBytes)} / ${fmtBytes(m.totalBytes)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </STable>
            </div>
            <div className="bd flex wrap" style={{ gap: 8, alignItems: 'center', borderTop: '1px solid var(--border-soft)' }}>
              <div className="muted" style={{ flex: '1 1 260px', minWidth: 0, fontSize: 12 }}>
                {d.corpMountsError ? <span style={{ color: 'var(--amber)' }}>⚠ {d.corpMountsError}</span>
                  : savedUse ? `지정됨 — ${savedUse.size}개만 잡 대상으로 고를 수 있습니다${c.mountUse?.by ? `(${c.mountUse.by}, ${agoText(c.mountUse.at, now)})` : ''}. 이미 저장된 잡은 그대로 돕니다.`
                    : '지정 없음 — 이 법인의 모든 마운트를 잡 대상으로 고를 수 있습니다.'}
                {!corpEditable && ' 이 법인의 vCenter 를 모두 수정할 수 있는 계정만 바꿀 수 있습니다.'}
              </div>
              {corpEditable && savedUse && <button type="button" className="vbk-btn sm" disabled={busyId === 'mount-use'} onClick={() => saveUse(null)}>지정 해제(전부 사용)</button>}
              {corpEditable && <button type="button" className="vbk-btn sm primary" disabled={busyId === 'mount-use' || !useDirty} onClick={() => saveUse([...useSet])}>사용 지정 저장</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 새 NFS 데이터스토어 — vCenter·이름·NFS·호스트(클러스터 단위 선택). */
function NfsDsForm({ d, corp, writable, onDone }) {
  const vcs = (corp.vcenterIds || []).filter((id) => writable.has(String(id)));
  const [vcenterId, setVc] = useState(vcs[0] || '');
  const [f, setF] = useState({ name: '', server: '', exportPath: '', nfsVersion: '3' });
  const [hosts, setHosts] = useState({ state: 'idle', items: [], err: null });
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const gen = useRef(0);
  useEffect(() => { setVc(vcs[0] || ''); }, [corp.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const g = ++gen.current;
    setPicked(new Set());
    if (!vcenterId) { setHosts({ state: 'idle', items: [], err: null }); return; }
    setHosts({ state: 'loading', items: [], err: null });
    fetchJson('/hosts', { vcenterId })
      .then((r) => { if (g === gen.current) setHosts({ state: 'ok', items: r.items || [], err: null }); })
      .catch((e) => { if (g === gen.current) setHosts({ state: 'error', items: [], err: e }); });
  }, [vcenterId]);
  const clusters = useMemo(() => {
    const m = new Map();
    for (const h of hosts.items) { const k = h.cluster || '(클러스터 없음)'; if (!m.has(k)) m.set(k, []); m.get(k).push(h); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [hosts.items]);
  if (!vcs.length) return <div className="bd muted" style={{ fontSize: 12.5, borderTop: '1px solid var(--border-soft)' }}>이 법인에서 쓰기 권한이 있는 vCenter 가 없어 추가할 수 없습니다.</div>;
  const toggle = (ids, on) => { const n = new Set(picked); for (const id of ids) (on ? n.add(id) : n.delete(id)); setPicked(n); };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await postJson('/tools/vm-clone/nfs-datastores', { vcenterId, ...f, hostIds: [...picked] });
      if (r.ok === false) { setErr(r.reason); return; }
      setF({ name: '', server: '', exportPath: '', nfsVersion: '3' }); setPicked(new Set());
      await onDone(`'${r.item?.name}' 정의를 저장하고 호스트 ${picked.size}대 연결을 ${r.where === 'edge' ? `담당 엣지(${r.agent})로 보냈습니다 — 엣지가 다음 동기화에 가져갑니다` : '실행 큐에 넣었습니다'}. 호스트별 결과는 표에 나옵니다.`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="bd" style={{ borderTop: '1px solid var(--border-soft)', background: 'var(--bg-soft)', display: 'flex', flexDirection: 'column', gap: 12, borderRadius: '0 0 var(--radius) var(--radius)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>새 NFS 데이터스토어</div>
      <div className="vbk-form">
        <label>vCenter
          <Select className="select" value={vcenterId} onChange={(e) => setVc(e.target.value)}>
            {vcs.map((id) => <option key={id} value={id}>{d.vcenterNames?.[id] || id}</option>)}
          </Select>
        </label>
        <label>데이터스토어 이름<input className="input" maxLength={42} placeholder="예: va-bk03" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>NFS 서버<input className="input" style={{ fontFamily: 'var(--mono)' }} placeholder="호스트명 또는 IP" value={f.server} onChange={(e) => setF({ ...f, server: e.target.value })} /></label>
        <label>export 경로<input className="input" style={{ fontFamily: 'var(--mono)' }} placeholder="/backup" value={f.exportPath} onChange={(e) => setF({ ...f, exportPath: e.target.value })} /></label>
        <label>버전
          <Select sort={false} className="select" value={f.nfsVersion} onChange={(e) => setF({ ...f, nfsVersion: e.target.value })}>
            <option value="3">NFS 3</option><option value="4.1">NFS 4.1</option>
          </Select>
        </label>
      </div>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>연결할 호스트 <span className="muted" style={{ fontWeight: 400 }}>{hosts.state === 'loading' ? '(불러오는 중…)' : `${picked.size}대 선택`}</span></div>
        {hosts.state === 'error' && <div style={{ color: 'var(--amber)', fontSize: 12.5 }}>⚠ 호스트 목록을 읽지 못했습니다({hosts.err?.message || '사유 미상'}) — 비어 있다는 뜻이 아닙니다.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {clusters.map(([name, list]) => {
            const ids = list.map((h) => h.id);
            const all = ids.every((id) => picked.has(id));
            return (
              <div key={name} style={{ fontSize: 12.5 }}>
                <label className="flex" style={{ alignItems: 'center', gap: 8, fontWeight: 600 }}>
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} /> {name} <span className="muted" style={{ fontWeight: 400 }}>· 호스트 {ids.length}대</span>
                </label>
                <div className="flex wrap" style={{ gap: '4px 12px', padding: '4px 0 0 24px' }}>
                  {list.map((h) => (
                    <label key={h.id} className="flex" style={{ alignItems: 'center', gap: 5 }}>
                      <input type="checkbox" checked={picked.has(h.id)} onChange={(e) => toggle([h.id], e.target.checked)} /> <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{h.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="vbk-note" role="note">ESXi 호스트 설정을 바꾸는 작업입니다. 고른 호스트마다 같은 이름의 NFS 데이터스토어를 붙입니다. 각 호스트 VMkernel 에서 NFS 서버로 통신(TCP 2049)이 열려 있고, NFS 서버가 그 호스트들에 root 쓰기를 허용해야 합니다. 호스트별 결과를 그대로 보여 드리며, 실패한 호스트만 다시 시도할 수 있습니다.</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12.5 }}>⚠ {err}</div>}
      <div className="flex wrap" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="vbk-btn primary" disabled={busy || !f.name.trim() || !f.server.trim() || !f.exportPath.trim() || !picked.size} onClick={submit}>{busy ? '요청 중…' : `호스트 ${picked.size}대에 연결`}</button>
      </div>
    </div>
  );
}
