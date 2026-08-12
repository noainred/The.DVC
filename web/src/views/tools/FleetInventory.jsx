// FleetInventory.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState, useRef } from 'react';
import { fetchJson, postJson, putJson } from '../../api.js';
import { Loading, ErrorBox, ResultCount, SearchBox } from '../../components/ui.jsx';
import { Card, fmtWatts } from './shared.jsx';


/** Generic on-demand fetch hook (runs when params change). */
// 통합 서버 인벤토리 — iDRAC/OME 물리 서버 + vCenter 호스트를 가상화/베어메탈로 분류.
function TagSelect({ value, onChange, disabled }) {
  return (
    <select className="select" value={value} disabled={disabled} style={{ padding: '3px 6px', fontSize: 12 }}
      onChange={(e) => onChange(e.target.value)}>
      <option value="auto">자동</option>
      <option value="baremetal">베어메탈</option>
      <option value="virtualization">가상화</option>
      <option value="exclude">제외</option>
    </select>
  );
}

const MODE_BADGE = { edge: ['엣지(현장)', 'teal'], central: ['중앙', 'blue'], standalone: ['단독', 'purple'] };
// 소속 법인 출처 라벨 [짧은표시, 툴팁].
const VC_SRC = {
  assigned: ['수동', '관리자가 직접 등록'],
  registry: ['레지스트리', 'iDRAC 레지스트리의 소속 vCenter'],
  host: ['호스트', '호스팅 vCenter'],
  collector: ['수집기', '원격 수집기 귀속'],
  inferred: ['자동(OME)', 'OME 연결의 법인을 상속(자동 추론)'],
  edge: ['엣지', '엣지(현장) 포탈이 보고한 소속'],
};

// 베어메탈 서버의 소속 법인(vCenter) 등록 드롭다운. 목록에 없는 값(삭제된 vCenter 등)도 표시.
function VcAssignSelect({ value, vcenters, onChange, disabled }) {
  const known = vcenters.some((v) => v.id === value);
  return (
    <select className="select" value={value} disabled={disabled} style={{ padding: '3px 6px', fontSize: 12, maxWidth: 180 }}
      onChange={(e) => onChange(e.target.value)} title="소속 법인(vCenter) 등록">
      <option value="">미지정</option>
      {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      {value && !known && <option value={value}>{value} (알 수 없음)</option>}
    </select>
  );
}

export function FleetInventory({ isAdmin }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('baremetal'); // baremetal | virt
  const [q, setQ] = useState('');
  const [fvc, setFvc] = useState('');             // 법인(vCenter)/DC 필터: '' 전체, '__none__' 미지정
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');        // 성공 안내(에러와 분리 — 성공이 에러를 덮지 않게)
  const [sel, setSel] = useState(() => new Set()); // 일괄 등록용 선택(fleetId)
  const [bulkVc, setBulkVc] = useState('');        // 일괄 등록 대상 법인('' = 미지정으로 해제)
  const seqRef = React.useRef(0);                  // load 응답 경합 가드(오래된 응답이 최신을 덮어쓰지 않게)

  const load = () => {
    const my = ++seqRef.current;
    return fetchJson('/insights/fleet')
      .then((r) => { if (my === seqRef.current) { setD(r); setErr(null); } })
      .catch((e) => { if (my === seqRef.current) setErr(e.message); });
  };
  useEffect(() => { load(); }, []);

  // 분류/소속 변경 키: 서버가 내려준 안정 키(tagKey) 우선. 백엔드 저장/조회 키와 정확히 일치.
  const tagKeyOf = (row) => row.tagKey || (row.serviceTag || '').toLowerCase() || String(row.serverId || '');
  const rowKey = (row) => String(row.serverId || row.tagKey || row.serviceTag || ''); // busy 표시용 단일 키
  const setTag = async (row, tag) => {
    const key = tagKeyOf(row);
    if (!key) { setErr('이 항목은 식별 키가 없어 분류를 바꿀 수 없습니다(서비스태그/호스트명 필요).'); return; }
    setBusy(rowKey(row));
    try { await putJson('/insights/fleet/tag', { key, tag }); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  // 베어메탈 행의 소속 법인(vCenter) 등록/해제. tagKey를 함께 보내 백엔드 저장 키를 일치시킨다.
  const setVc = async (row, vcenterId) => {
    setBusy(rowKey(row));
    try { await putJson('/insights/fleet/assign', { serverId: row.serverId, serviceTag: row.serviceTag, key: tagKeyOf(row), vcenterId }); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const toggleSel = (id) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // 유령(교체·삭제된 서버의 잔재) 분류/소속 키 정리. 등록된 서버는 보호되며, 삭제 전 확인한다.
  const prune = async () => {
    const ghost = d?.summary?.ghostKeys ?? 0;
    if (!window.confirm(`현재 어느 등록 서버/호스트와도 매칭되지 않는 유령 키 ${ghost}개를 제거합니다.\n(등록된 서버는 전원오프여도 보호됩니다.) 진행할까요?`)) return;
    setBusy('__prune__');
    setNotice('');
    try { const r = await postJson('/insights/fleet/prune', {}); await load(); setErr(null); setNotice(`유령 키 정리 완료 — 태그 ${r.removedTags}개 · 소속 ${r.removedAssign}개 제거`); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  if (err && !d) return <ErrorBox message={err} />;
  if (!d) return <Loading />;
  const s = d.summary || {};
  const vcenters = d.vcenters || [];
  const term = q.trim().toLowerCase();
  const match = (...fields) => !term || fields.some((f) => (f || '').toLowerCase().includes(term));
  const inVc = (vid) => !fvc || (fvc === '__none__' ? !vid : vid === fvc);
  const bm = (d.bareMetal || []).filter((b) => inVc(b.vcenterId) && match(b.name, b.model, b.serviceTag, b.vcenter, b.remoteAgent));
  const vh = (d.virtualizationHosts || []).filter((h) => inVc(h.vcenterId) && match(h.name, h.model, h.serviceTag, h.vcenter));
  const modeBadge = MODE_BADGE[d.mode];
  const selKey = (b) => b.fleetId || rowKey(b);
  // 선택은 '전체 베어메탈' 기준으로 유지 — 필터를 바꿔도 숨은 선택이 조용히 누락되지 않게.
  const selectedItems = (d.bareMetal || []).filter((b) => sel.has(selKey(b)));
  const allShownSelected = bm.length > 0 && bm.every((b) => sel.has(selKey(b)));
  const toggleAllShown = () => setSel((prev) => {
    const n = new Set(prev);
    if (allShownSelected) bm.forEach((b) => n.delete(selKey(b)));
    else bm.forEach((b) => n.add(selKey(b)));
    return n;
  });
  const bulkAssign = async () => {
    const items = selectedItems.map((b) => ({ serverId: b.serverId, serviceTag: b.serviceTag, key: tagKeyOf(b) }));
    if (!items.length) return;
    const dest = bulkVc ? (vcenters.find((v) => v.id === bulkVc)?.name || bulkVc) : '미지정(해제)';
    if (!window.confirm(`선택한 ${items.length}대를 '${dest}'(으)로 일괄 등록할까요?`)) return;
    setBusy('__bulk__');
    setNotice('');
    try {
      const r = await putJson('/insights/fleet/assign-bulk', { items, vcenterId: bulkVc });
      setSel(new Set());
      await load();
      setErr(null);
      setNotice(`${r.assigned}/${r.total}대 일괄 등록 완료`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const csv = () => {
    const isBm = view === 'baremetal';
    const head = isBm ? ['서버', '모델', '서비스태그', '법인(vCenter)', '법인출처', '수집원', 'W'] : ['호스트', 'vCenter', '지역', '모델', '서비스태그', 'iDRAC받침', 'W'];
    const rows = isBm
      ? bm.map((b) => [b.name, b.model, b.serviceTag, b.vcenter || '미지정', b.vcSource || '', b.source, b.watts ?? ''])
      : vh.map((h) => [h.name, h.vcenter, h.region, h.model, h.serviceTag, h.idracBacked ? 'O' : 'X', h.watts ?? '']);
    const body = [head, ...rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `fleet-${view}-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="가상화 호스트" value={s.virtualizationHosts ?? 0} accent="var(--accent-2,#22d3ee)" meta={`iDRAC 받침 ${s.idracBackedHosts ?? 0}대`} onClick={() => setView('virt')} active={view === 'virt'} />
        <Card label="베어메탈 서버" value={s.bareMetal ?? 0} accent="var(--amber)" meta={`전력 측정 ${s.bareMetalMeasured ?? 0}대${s.forcedBareMetal ? ` · 수동 ${s.forcedBareMetal}` : ''}`} onClick={() => setView('baremetal')} active={view === 'baremetal'} />
        <Card label="베어메탈 총전력" value={fmtWatts(s.bareMetalWatts || 0)} accent="#fbbf24" meta={`${s.bareMetalKw ?? 0} kW · 현재 측정 합계`} />
        <Card label="법인 미지정" value={s.bareMetalUnassigned ?? 0} accent={s.bareMetalUnassigned ? 'var(--amber)' : 'var(--green)'} meta={s.excluded ? `제외(수동) ${s.excluded}대` : '베어메탈 중 소속 법인 없음'} />
      </div>

      <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderLeft: '3px solid var(--accent-2,#22d3ee)' }}>
        <div style={{ fontSize: 13 }}>
          {modeBadge && <span className={`badge ${modeBadge[1]}`} style={{ marginRight: 6 }} title="이 포탈 인스턴스 역할">{modeBadge[0]} 포탈</span>}
          iDRAC/OME가 수집한 물리 서버를 <b>Dell 서비스태그</b>로 vCenter ESXi 호스트와 대조합니다. 호스트에 매칭되면 <b>가상화 호스트</b>, 매칭이 없으면 <b>베어메탈</b>입니다.
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {d.mode === 'edge' ? '이 엣지 포탈은 자기 데이터센터에 등록된 서버만 보여줍니다(로컬 검색). 중앙으로 베어메탈을 보고합니다. ' : (d.mode === 'central' ? `중앙 포탈 — 법인(vCenter) 필터로 데이터센터별 검색이 가능합니다. ${s.edgeReported ? `🛰 엣지 ${s.edgeAgents}곳에서 ${s.edgeReported}대 집계. ` : ''}` : '')}
          베어메탈 행에서 소속 <b>법인(vCenter)</b>을 바로 등록할 수 있고, 자동 분류가 틀리면 분류도 직접 바꿀 수 있습니다(서비스태그 기준 저장). 베어메탈 총전력은 이미 수집 중인 iDRAC/OME 측정값을 합산합니다.
        </div>
      </div>

      <div className="flex between wrap gap" style={{ marginBottom: 10, alignItems: 'center' }}>
        <div className="flex gap" style={{ flexWrap: 'wrap' }}>
          <button className={view === 'baremetal' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('baremetal')}>베어메탈 ({(d.bareMetal || []).length})</button>
          <button className={view === 'virt' ? 'login-btn' : 'logout-btn'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('virt')}>가상화 호스트 ({(d.virtualizationHosts || []).length})</button>
        </div>
        <div className="flex gap" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="select" value={fvc} onChange={(e) => setFvc(e.target.value)} style={{ maxWidth: 220 }} title="법인(vCenter)/데이터센터 필터">
            <option value="">전체 법인(vCenter)</option>
            {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name}{v.region ? ` · ${v.region}` : ''}</option>)}
            <option value="__none__">(미지정)</option>
          </select>
          <SearchBox className="input" style={{ maxWidth: 240 }} placeholder="서버/모델/서비스태그 검색" value={q} onChange={setQ} />
          <button className="logout-btn" style={{ padding: '9px 14px' }} onClick={csv}>CSV</button>
        </div>
      </div>

      {err && d && <div className="card flex between gap" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: '3px solid var(--red)', fontSize: 13, alignItems: 'center' }}><span>⚠ {err}</span><button className="logout-btn" style={{ padding: '2px 8px' }} onClick={() => setErr(null)}>✕</button></div>}
      {notice && <div className="card flex between gap" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: '3px solid var(--green)', fontSize: 13, alignItems: 'center' }}><span>✓ {notice}</span><button className="logout-btn" style={{ padding: '2px 8px' }} onClick={() => setNotice('')}>✕</button></div>}
      {isAdmin && s.ghostKeys > 0 && (
        <div className="card flex between wrap gap" style={{ padding: '8px 12px', marginBottom: 10, borderLeft: '3px solid var(--amber)', alignItems: 'center' }}>
          <span style={{ fontSize: 13 }}>⚠ 유령 분류/소속 키 <b>{s.ghostKeys}</b>개 — 교체·삭제된 서버의 잔재가 남아 있습니다.</span>
          <button className="logout-btn" style={{ padding: '6px 12px' }} disabled={busy === '__prune__'} onClick={prune}>{busy === '__prune__' ? '정리 중…' : '유령 키 정리'}</button>
        </div>
      )}

      {view === 'baremetal' && (
        <>
          {isAdmin && (
            <div className="flex wrap gap" style={{ alignItems: 'center', marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>일괄 등록: <b>{selectedItems.length}</b>대 선택</span>
              <select className="select" value={bulkVc} onChange={(e) => setBulkVc(e.target.value)} style={{ maxWidth: 200, padding: '5px 8px', fontSize: 12 }}>
                <option value="">미지정(해제)</option>
                {vcenters.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <button className="login-btn" style={{ flex: 'none', padding: '6px 12px' }} disabled={!selectedItems.length || busy === '__bulk__'} onClick={bulkAssign}>{busy === '__bulk__' ? '등록 중…' : '선택 일괄 등록'}</button>
              {sel.size > 0 && <button className="logout-btn" style={{ padding: '6px 10px' }} onClick={() => setSel(new Set())}>선택 해제</button>}
            </div>
          )}
          <ResultCount total={(d.bareMetal || []).length} shown={bm.length} label="베어메탈" filtered={!!term || !!fvc} />
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table>
              <thead><tr>{isAdmin && <th style={{ width: 28 }}><input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} title="현재 목록 전체 선택" /></th>}<th>서버</th><th>모델</th><th>서비스태그</th><th>법인(vCenter)</th><th>수집</th><th style={{ textAlign: 'right' }}>현재 전력</th>{isAdmin && <th>분류</th>}</tr></thead>
              <tbody>
                {bm.map((b, i) => (
                  <tr key={b.serverId || b.fleetId || i}>
                    {isAdmin && <td><input type="checkbox" checked={sel.has(selKey(b))} onChange={() => toggleSel(selKey(b))} /></td>}
                    <td><b>{b.name}</b>{b.forced && <span className="badge purple" style={{ marginLeft: 6 }}>수동</span>}{b.remoteAgent && <span className="badge teal" style={{ marginLeft: 6 }} title="엣지(현장) 포탈이 보고한 베어메탈">🛰 {b.remoteAgent}</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{b.model || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{b.serviceTag || '—'}</td>
                    <td>
                      {isAdmin
                        ? <VcAssignSelect value={b.vcenterId || ''} vcenters={vcenters} disabled={busy === rowKey(b)} onChange={(vid) => setVc(b, vid)} />
                        : (b.vcenter ? <span>{b.vcenter}</span> : <span className="badge purple">미지정</span>)}
                      {b.vcenterId && VC_SRC[b.vcSource] && <span className="muted" style={{ fontSize: 11, marginLeft: 4 }} title={VC_SRC[b.vcSource][1]}>· {VC_SRC[b.vcSource][0]}</span>}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{b.source}</td>
                    <td style={{ textAlign: 'right' }}>{b.watts != null ? <b>{fmtWatts(b.watts)}</b> : <span className="muted">미측정</span>}</td>
                    {isAdmin && <td><TagSelect value={b.tag || 'auto'} disabled={busy === rowKey(b)} onChange={(t) => setTag(b, t)} /></td>}
                  </tr>
                ))}
                {!bm.length && <tr><td colSpan={isAdmin ? 8 : 6} className="center muted" style={{ padding: 20 }}>베어메탈 서버가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === 'virt' && (
        <>
          <ResultCount total={(d.virtualizationHosts || []).length} shown={vh.length} label="호스트" filtered={!!term || !!fvc} />
          <div className="table-wrap" style={{ maxHeight: '60vh' }}>
            <table>
              <thead><tr><th>호스트</th><th>vCenter</th><th>지역</th><th>모델</th><th>서비스태그</th><th style={{ textAlign: 'right' }}>코어</th><th style={{ textAlign: 'right' }}>메모리</th><th>전력원</th><th style={{ textAlign: 'right' }}>현재 전력</th>{isAdmin && <th>분류</th>}</tr></thead>
              <tbody>
                {vh.map((h, i) => (
                  <tr key={`${h.vcenterId}-${h.name}-${i}`}>
                    <td><b>{h.name}</b>{h.synthetic && <span className="badge teal" style={{ marginLeft: 6 }} title="ESXi 호스트와 자동 매칭되진 않았지만 관리자가 가상화로 지정">발견</span>}</td>
                    <td>{h.vcenter}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.region || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.model || '—'}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{h.serviceTag || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{h.cpuCores || '—'}</td>
                    <td style={{ textAlign: 'right' }} className="muted">{h.memGB ? `${h.memGB} GB` : '—'}</td>
                    <td>{h.idracBacked ? <span className="badge green" title={h.via === 'tag' ? '서비스태그 매칭' : (h.via === 'name' ? '호스트명 매칭' : '')}>iDRAC</span> : (h.powerSource === 'vcenter' ? <span className="badge blue">vCenter</span> : <span className="muted">—</span>)}</td>
                    <td style={{ textAlign: 'right' }}>{h.watts != null ? <b>{fmtWatts(h.watts)}</b> : <span className="muted">—</span>}</td>
                    {isAdmin && <td><TagSelect value={h.tag || 'auto'} disabled={busy === rowKey(h)} onChange={(t) => setTag(h, t)} /></td>}
                  </tr>
                ))}
                {!vh.length && <tr><td colSpan={isAdmin ? 10 : 9} className="center muted" style={{ padding: 20 }}>가상화 호스트가 없습니다.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
