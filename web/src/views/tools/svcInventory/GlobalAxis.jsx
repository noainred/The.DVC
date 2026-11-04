/**
 * 서비스별(전 법인) 축 — 사용자 선택 '시안 2: 정체성 A 카탈로그(globalId) × 첫 화면 A 커버리지 매트릭스'(v2.864).
 * 왼쪽: 전역 서비스 목록(+ 전체 범위 관리자의 전역 추가) · 법인 전용 서비스(전역 연결 제안 — 이름이 같으면 제안, 다르면 사람이 연결).
 * 오른쪽: 매트릭스(행 = 전역 서비스, 열 = 지역별 법인, 칸 = 구성원 수) — 칸·행을 누르면 그 서비스의 법인별 투입 자원 → 그 법인의 구성원.
 */
import React, { useState } from 'react';
import { STable } from '../../../components/STable.jsx';
import Select from '../../../components/Select.jsx';
import { Card } from '../shared.jsx';
import { TierBadge, UsagePair, BackupCell, MembersPanel } from './parts.jsx';
import { matrixColumns, numText, gbText, faultsView } from '../svcInventoryText.js';

const btn = { padding: '5px 10px', fontSize: 12, flex: 'none' };
const shortCorp = (n) => String(n || '').replace(/^vcenter-/, '');

function MatrixCell({ c, onClick, faultsOn }) {
  if (!c) return <td className="muted" style={{ textAlign: 'center' }}>–</td>;
  const f = faultsOn ? (c.faults || 0) : null;
  return (
    <td style={{ textAlign: 'center', cursor: 'pointer', fontWeight: 700 }} onClick={onClick} data-sort={c.n}
      title={`VM ${c.vm} · 베어메탈 ${c.bm}${c.stale ? ' · 이 법인을 지금 읽지 못해 사용률·장애가 지금 값이 아닙니다' : ''}${f ? ` · 부품 장애 ${f}` : ''}`}>
      {c.n}{c.stale ? <span className="muted" title="지금 읽지 못함">?</span> : null}
      {f ? <span className="badge red" style={{ marginLeft: 4 }}>{f}</span> : null}
    </td>
  );
}

export default function GlobalAxis({ d, regionOf, corpName, writableOf, op, busy, gsel, setGsel, gcorp, setGcorp, reloadKey }) {
  const [first, setFirst] = useState('matrix');
  const [ng, setNg] = useState({ name: '', tier: '2', owner: '' });
  const [linkPick, setLinkPick] = useState({});
  const globals = d.global?.globals || [];
  const cells = d.global?.cells || {};
  const unlinked = d.global?.unlinked || [];
  const faultsOn = !!d.meta?.faults?.available;
  const cols = matrixColumns(d.corps, regionOf);
  const sel = globals.find((g) => g.id === gsel) || null;
  const pick = (gid, corp = '') => { setGsel(gid); setGcorp(corp); };

  return (
    <div className="svcinv-layout">
        {/* 왼쪽: 전역 서비스 목록 */}
        <div className="card" style={{ alignSelf: 'start', minWidth: 0 }}>
          <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
            <b>전역 서비스</b><span className="muted" style={{ fontSize: 12 }}>{globals.length}개{unlinked.length ? ` · 법인 전용 ${unlinked.length}` : ''}</span>
          </div>
          {!globals.length ? <div className="muted" style={{ padding: 12, fontSize: 13 }}>전역 서비스가 아직 없습니다. {d.canFleet ? '아래에서 만들고, 법인 서비스를 연결하십시오.' : '전체 범위 관리자가 만듭니다.'}</div> : null}
          {globals.map((g) => (
            <div key={g.id} onClick={() => pick(gsel === g.id ? '' : g.id)} title={g.name} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 12px', cursor: 'pointer', minWidth: 0, background: gsel === g.id ? 'rgba(59,130,246,.18)' : undefined }}>
              <TierBadge tier={g.tier} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ display: 'block', overflowWrap: 'anywhere' }}>{g.name}</b>
                <span className="muted" style={{ fontSize: 11 }}>{g.corps.length}법인 · {g.stat.n.total}대{faultsOn && (g.stat.faults.member + g.stat.faults.host) ? <span style={{ color: 'var(--red)' }}> · 장애 {g.stat.faults.member + g.stat.faults.host}</span> : null}</span>
              </span>
            </div>
          ))}
          {d.canFleet ? (
            <div className="flex wrap gap" style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', alignItems: 'center' }}>
              <input className="input" value={ng.name} onChange={(e) => setNg({ ...ng, name: e.target.value })} placeholder="새 전역 서비스(예: DB)" style={{ minWidth: 0, flex: '1 1 140px' }} />
              <Select className="select" sort={false} value={ng.tier} onChange={(e) => setNg({ ...ng, tier: e.target.value })} style={{ maxWidth: 90 }} aria-label="등급"><option value="1">등급 1</option><option value="2">등급 2</option><option value="3">등급 3</option></Select>
              <input className="input" value={ng.owner} onChange={(e) => setNg({ ...ng, owner: e.target.value })} placeholder="전역 담당자" style={{ minWidth: 0, flex: '1 1 140px' }} />
              <button type="button" className="login-btn" style={btn} disabled={busy || !ng.name.trim()} onClick={async () => { const r = await op({ op: 'global.add', name: ng.name, tier: Number(ng.tier), owner: ng.owner }, `전역 서비스 ‘${ng.name}’ 을 만들었습니다.`); if (r) setNg({ name: '', tier: '2', owner: '' }); }}>추가</button>
            </div>
          ) : null}
          {unlinked.length ? (
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <div className="muted" style={{ padding: '8px 12px 4px', fontSize: 12 }}>그 법인에만 있는 서비스(전역 연결 없음){unlinked.some((u) => u.suggest) ? ' · 이름이 같은 전역이 있으면 제안합니다' : ''}</div>
              {unlinked.slice(0, 200).map((u) => {
                const can = writableOf(u.corp);
                const k = u.id; const v = linkPick[k] ?? (u.suggest || '');
                return (
                  <div key={k} className="flex wrap gap" style={{ padding: '5px 12px', alignItems: 'center', fontSize: 12 }}>
                    <span style={{ flex: 1, minWidth: 120 }}><b>{u.name}</b> <span className="muted">· {corpName(u.corp)} · {u.n}대</span></span>
                    {can && globals.length ? (
                      <>
                        <Select className="select" value={v} onChange={(e) => setLinkPick((p) => ({ ...p, [k]: e.target.value }))} style={{ maxWidth: 150, padding: '3px 6px', fontSize: 12 }} aria-label="전역 서비스">
                          <option value="">전역에 연결…</option>{globals.map((g) => <option key={g.id} value={g.id}>{g.name}{u.suggest === g.id ? ' (제안)' : ''}</option>)}
                        </Select>
                        <button type="button" className="logout-btn" style={btn} disabled={busy || !v} onClick={() => op({ op: 'service.update', corp: u.corp, id: u.id, globalId: v }, `‘${u.name}’(${corpName(u.corp)}) 을 전역 ‘${globals.find((g) => g.id === v)?.name}’ 에 연결했습니다.`)}>연결</button>
                      </>
                    ) : null}
                  </div>
                );
              })}
              {unlinked.length > 200 ? <div className="muted" style={{ padding: '4px 12px 8px', fontSize: 12 }}>… 외 {unlinked.length - 200}개(법인별 인프라 축의 서비스 속성에서도 연결할 수 있습니다)</div> : null}
            </div>
          ) : null}
        </div>

        {/* 오른쪽: 매트릭스 / 목록 / 선택한 서비스 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="card flex wrap gap" style={{ padding: '10px 14px', alignItems: 'center' }}>
            <b>서비스별(전 법인)</b>{sel ? <><span className="muted">›</span><b>{sel.name}</b>{gcorp ? <><span className="muted">›</span><span>{corpName(gcorp)}</span></> : null}</> : null}
            <span style={{ flex: 1 }} />
            {!sel ? (
              <div className="tabs" style={{ marginLeft: 0 }}>
                <button type="button" className={`tab${first === 'matrix' ? ' active' : ''}`} onClick={() => setFirst('matrix')}>커버리지 매트릭스</button>
                <button type="button" className={`tab${first === 'list' ? ' active' : ''}`} onClick={() => setFirst('list')}>목록</button>
              </div>
            ) : <button type="button" className="logout-btn" style={btn} onClick={() => pick('')}>← 전체</button>}
          </div>

          {!sel && first === 'matrix' ? (
            <div className="card" style={{ minWidth: 0 }}>
              <div className="muted" style={{ padding: '8px 14px', fontSize: 12, borderBottom: '1px solid var(--border)' }}>행 = 전역 서비스 · 열 = 법인(지역별) · 칸 = 구성원 수(붉은 배지 = 열린 부품 장애, ? = 지금 읽지 못한 법인, – = 없음) · 칸을 누르면 그 법인의 구성원</div>
              {!globals.length ? <div className="muted" style={{ padding: 16 }}>전역 서비스를 만들고 법인 서비스를 연결하면 여기에 행이 생깁니다.</div> : (
                <STable className="table svcinv-t" minWidth={Math.max(560, 200 + d.corps.length * 56)} sortable={false}>
                  <thead>
                    {/* 법인 수·합계는 등급 바로 뒤 — 28열 매트릭스 끝에 두면 1440px 에서 가로 스크롤 뒤로 숨는다(실측). */}
                    <tr><th rowSpan={2} className="svcinv-stick">서비스</th><th rowSpan={2}>등급</th><th rowSpan={2} title="이 전역 서비스가 연결된 법인 수">법인</th><th rowSpan={2}>합계</th>{cols.map((g) => <th key={g.region} colSpan={g.corps.length} style={{ textAlign: 'center', background: 'var(--panel-2)' }}>{g.region}</th>)}</tr>
                    <tr>{cols.flatMap((g) => g.corps.map((c) => <th key={c.vcenterId} title={c.name} style={{ textAlign: 'center', fontSize: 11 }}>{shortCorp(c.name).replace(/-0?1$/, '')}</th>))}</tr>
                  </thead>
                  <tbody>{globals.map((g) => (
                    <tr key={g.id}>
                      <td className="svcinv-stick"><b style={{ cursor: 'pointer' }} onClick={() => pick(g.id)}>{g.name}</b></td><td><TierBadge tier={g.tier} /></td>
                      <td style={{ textAlign: 'center' }}>{g.corps.length}</td><td style={{ textAlign: 'center', borderRight: '1px solid var(--border)' }}><b>{g.stat.n.total}</b></td>
                      {cols.flatMap((col) => col.corps.map((c) => <MatrixCell key={c.vcenterId} c={cells[g.id]?.[c.vcenterId]} faultsOn={faultsOn} onClick={() => pick(g.id, c.vcenterId)} />))}
                    </tr>
                  ))}</tbody>
                </STable>
              )}
            </div>
          ) : null}

          {!sel && first === 'list' ? (
            <div className="card" style={{ minWidth: 0 }}>
              <STable className="table svcinv-t" minWidth={760}>
                <thead><tr><th>서비스</th><th>등급</th><th>법인</th><th>구성원</th><th>vCPU</th><th>VM 메모리</th><th>스토리지</th><th>BM 코어</th><th>부품 장애</th><th>못 읽음</th></tr></thead>
                <tbody>{globals.map((g) => { const s = g.stat; const fv = faultsView(s.faults, faultsOn); return (
                  <tr key={g.id} onClick={() => pick(g.id)} style={{ cursor: 'pointer' }}>
                    <td data-sort={g.name}><b>{g.name}</b><div className="svcinv-sub">{g.owner ? `담당 ${g.owner}` : '전역 담당자 미지정'}</div></td><td data-sort={g.tier}><TierBadge tier={g.tier} /></td>
                    <td data-sort={g.corps.length}>{g.corps.length}</td><td data-sort={s.n.total} style={{ whiteSpace: 'nowrap' }}><b>{s.n.total}</b><div className="svcinv-sub">VM {s.n.vm} · BM {s.n.bm}</div></td>
                    <td data-sort={s.alloc.vcpu}>{numText(s.alloc.vcpu)}</td><td data-sort={s.alloc.vmMemGB}>{gbText(s.alloc.vmMemGB)}</td><td data-sort={s.alloc.storageGB}>{gbText(s.alloc.storageGB)}</td><td data-sort={s.alloc.bmCores}>{numText(s.alloc.bmCores)}</td>
                    <td data-sort={fv ? fv.total : -1}>{fv ? (fv.total ? <span className="badge red">{fv.total}</span> : <span className="muted">0</span>) : <span className="muted">—</span>}</td>
                    <td data-sort={s.usage.unread + s.usage.stale}>{s.usage.unread + s.usage.stale ? <span className="badge amber">{s.usage.unread + s.usage.stale}</span> : <span className="muted">0</span>}</td>
                  </tr>); })}</tbody>
              </STable>
              <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>vCPU·메모리·스토리지 = 할당 합계(투입된 자원). 사용률을 못 읽은 서버도 할당에는 들어갑니다(할당은 스냅샷 값).</div>
            </div>
          ) : null}

          {sel ? <GlobalDetail g={sel} d={d} corpName={corpName} gcorp={gcorp} setGcorp={setGcorp} faultsOn={faultsOn} reloadKey={reloadKey} /> : null}
        </div>
    </div>
  );
}

function GlobalDetail({ g, d, corpName, gcorp, setGcorp, faultsOn, reloadKey }) {
  const s = g.stat;
  const cells = d.global.cells[g.id] || {};
  const unread = s.usage.unread + s.usage.stale;
  const staleCorps = g.corps.filter((c) => cells[c]?.stale).length;
  const fv = faultsView(s.faults, faultsOn);
  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Card label="법인" value={g.corps.length} meta={g.corps.length ? `${g.corps.slice(0, 4).map((c) => shortCorp(corpName(c))).join(' · ')}${g.corps.length > 4 ? ` 외 ${g.corps.length - 4}` : ''}` : '연결된 법인 없음'} />
        <Card label="구성원" value={s.n.total} meta={`VM ${s.n.vm} · 베어메탈 ${s.n.bm} · 영향 호스트 ${s.hosts}`} />
        <Card label="vCPU 합" value={numText(s.alloc.vcpu)} meta={`베어메탈 코어 ${numText(s.alloc.bmCores)} 별도`} />
        <Card label="메모리" value={gbText((s.alloc.vmMemGB || 0) + (s.alloc.bmMemGB || 0))} meta={`VM 할당 ${gbText(s.alloc.vmMemGB)} · 베어메탈 ${gbText(s.alloc.bmMemGB)}`} />
        <Card label="스토리지" value={gbText(s.alloc.storageGB)} meta={s.alloc.storageUnknown ? `VM 할당 · 모름 ${s.alloc.storageUnknown}대` : 'VM 할당(스냅샷)'} />
        <Card label="장애·백업 실패" value={fv ? fv.total + (s.backup.fail || 0) : '—'} accent={(fv?.total || s.backup.fail) ? 'var(--red)' : undefined} meta={fv ? `부품 장애 ${fv.member}+호스트 ${fv.host} · 백업 실패·지연 ${s.backup.fail || 0}` : '부품 장애 수를 모릅니다'} />
        <Card label="제외" value={unread + staleCorps} accent={unread + staleCorps ? 'var(--amber)' : undefined} meta={`사용률 못 읽음·오래됨 ${unread}대${staleCorps ? ` · 지금 못 읽는 법인 ${staleCorps}` : ''}`} />
      </div>
      <div className="card" style={{ minWidth: 0 }}>
        <div className="flex wrap gap" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <b>{g.name} — 법인별 투입 자원</b><span className="muted" style={{ fontSize: 12 }}>전역 담당자 {g.owner || '미지정'} · 행을 누르면 그 법인의 구성원·영향 호스트</span>
        </div>
        <STable className="table svcinv-t" minWidth={720}>
          <thead><tr><th>법인</th><th title="VM·베어메탈 · 호스트 = 구성원 VM 이 올라간 ESXi 호스트 수(파생)">구성원</th><th>vCPU</th><th>메모리 GB</th><th>스토리지 GB</th><th title="Σ(사용률×용량)÷Σ용량">사용률</th><th>부품 장애</th><th>백업 24h</th></tr></thead>
          <tbody>{g.corps.map((c) => {
            const x = cells[c]; const ls = g.services.find((y) => y.corp === c);
            const fx = x && faultsOn && !x.stale ? x.faults : null;
            return (
              <tr key={c} onClick={() => setGcorp(gcorp === c ? '' : c)} style={{ cursor: 'pointer', background: gcorp === c ? 'rgba(59,130,246,.10)' : undefined }}>
                <td data-sort={corpName(c)} title={corpName(c)}>
                  <b>{shortCorp(corpName(c))}</b>{ls && ls.name.toLowerCase() !== g.name.toLowerCase() ? <span className="badge purple" style={{ marginLeft: 4 }} title="전역 이름과 다름 — 사람이 연결">연결</span> : null}
                  <div className="svcinv-sub">{ls?.name || '—'} · {ls?.owner || '담당자 미지정'}</div>
                </td>
                <td data-sort={x ? x.vm + x.bm : 0} style={{ whiteSpace: 'nowrap' }}><b>VM {x?.vm ?? 0}</b><span className="muted"> · </span><b>BM {x?.bm ?? 0}</b><div className="svcinv-sub">호스트 {x?.hosts ?? 0}</div></td>
                <td data-sort={x?.alloc?.vcpu ?? 0}>{numText(x?.alloc?.vcpu)}</td><td data-sort={(x?.alloc?.vmMemGB || 0) + (x?.alloc?.bmMemGB || 0)}>{numText((x?.alloc?.vmMemGB || 0) + (x?.alloc?.bmMemGB || 0))}</td><td data-sort={x?.alloc?.storageGB ?? 0}>{numText(x?.alloc?.storageGB)}</td>
                <td data-sort={x?.stale ? -1 : (x?.usage?.cpu ?? -1)}>{x?.stale ? <span className="muted" title="지금 읽지 못함">—</span> : <UsagePair cpu={x?.usage?.cpu ?? null} mem={x?.usage?.mem ?? null} />}</td>
                <td data-sort={fx ?? -1}>{fx == null ? <span className="muted">—</span> : fx ? <span className="badge red">{fx}</span> : <span className="muted">0</span>}</td>
                <td><BackupCell b={x?.backup} meta={d.meta?.backup} /></td>
              </tr>
            );
          })}</tbody>
        </STable>
        <div className="muted" style={{ padding: '8px 14px', fontSize: 12 }}>vCPU·메모리·스토리지 = 할당 합계 · 사용률은 가중 평균(못 읽은 서버 제외) · 지금 읽지 못한 법인은 사용률·장애가 ‘—’.</div>
      </div>
      {gcorp ? <MembersPanel title={`${g.name} · ${corpName(gcorp)}`} sub="구성원" query={{ global: g.id, corp: gcorp }} reloadKey={reloadKey} /> : null}
    </>
  );
}
