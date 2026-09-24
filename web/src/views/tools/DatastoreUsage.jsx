// DatastoreUsage.jsx — SpecialTools.jsx(구 5,070줄)에서 분리(v2.282 대형 파일 분할). 본문은 원본 그대로 이동.
import React, { useEffect, useState } from 'react';
import { useHashTab } from '../../hooks/useHashTab.js';
import { fetchJson, usePolling } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { Card, itemsOf } from './shared.jsx';
import { STable } from '../../components/STable.jsx';
import { dsAgg, dsRowPct, dsUsageColor } from './dsUsageCalc.js';


// vCenter별/DataCenter별 데이터스토어(스토리지) 용량 현황. 각 vCenter에 어떤 스토리지가
// 연결돼 있고 전체/여유 용량이 얼마인지 한눈에. 1차 DataCenter → 2차 vCenter(스토리지는
// baremetal 개념이 없어 vCenter 하위만). /datastores(스냅샷)를 vCenter/DataCenter로 그룹핑.
function dsFmtGB(gb) {
  if (gb == null || gb === '' || !Number.isFinite(Number(gb))) return '—'; // v2.601: 못 읽은 값에 단위를 붙이지 않는다
  const g = Number(gb);
  if (g >= 1000) { const t = g / 1000; return `${t % 1 === 0 ? t : t.toFixed(1)} TB`; } // 1000GB=1TB(사용자 선호)
  return `${Math.round(g)} GB`;
}
function dsSum(arr, k) { return arr.reduce((a, d) => a + (Number(d[k]) || 0), 0); }
// 사용률 판정·합계는 dsUsageCalc.js(v2.601 LO2601-04) — 사용량을 모르는 DS 를 0% 로도 사용량으로도 세지 않는다.

// 한 그룹(vCenter 또는 DataCenter 소계)의 용량 바 + 요약.
function DsCapBar({ agg }) {
  // 사용·여유·사용률은 사용량을 읽은 DS 끼리(v2.601 LO2601-04). 뺀 DS 는 개수로 밝힌다.
  const { knownCapGB, usedGB, freeGB, pct, unknown } = agg;
  return (
    <div style={{ minWidth: 220 }}>
      <div className="flex between" style={{ fontSize: 12, marginBottom: 3 }}>
        <span className="muted">사용 {pct == null ? '—' : dsFmtGB(usedGB)} / 전체 {pct == null ? '—' : dsFmtGB(knownCapGB)}</span>
        <b style={{ color: dsUsageColor(pct) }}>{pct == null ? '—' : `${pct}%`}</b>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: 'rgba(148,163,184,.15)', overflow: 'hidden' }}>
        {pct != null && <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: dsUsageColor(pct) }} />}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>여유 {pct == null ? '—' : dsFmtGB(freeGB)}{unknown ? ` · 사용량 모름 ${unknown}개 제외` : ''}</div>
    </div>
  );
}

// 한 vCenter의 데이터스토어 표(이름 정렬).
function DsVcTable({ items }) {
  const sorted = items.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }));
  // ⚠ minWidth 를 지우지 말 것(v2.576 실측): 6열 + 사용률 칸 최소폭 120px 이라 감싸지 않으면
  //   400px 에서 이 표들이 페이지를 **201px** 밀어낸다(한 화면에 11개가 뜬다). STable 은
  //   minWidth 를 받으면 가로 스크롤 래퍼까지 함께 만든다(v2.575 규약).
  return (
    <STable minWidth={560} className="data-table" style={{ width: '100%', fontSize: 12.5, marginTop: 8 }}>
      <thead><tr>
        <th style={{ textAlign: 'left' }}>데이터스토어</th><th>유형</th>
        <th style={{ textAlign: 'right' }}>전체</th><th style={{ textAlign: 'right' }}>사용</th>
        <th style={{ textAlign: 'right' }}>여유</th><th style={{ minWidth: 120 }}>사용률</th>
      </tr></thead>
      <tbody>{sorted.map((d) => {
        const pct = dsRowPct(d); // 모르면 null → '—'(0% 초록 막대가 아니다)
        return (
          <tr key={d.id || `${d.vcenterId}:${d.name}`}>
            <td><b>{d.name}</b></td>
            <td className="center"><span className="badge gray" style={{ fontSize: 11 }}>{d.type || '—'}</span></td>
            <td style={{ textAlign: 'right' }}>{dsFmtGB(d.capacityGB)}</td>
            <td style={{ textAlign: 'right' }}>{dsFmtGB(d.usedGB)}</td>
            <td style={{ textAlign: 'right', ...(pct != null ? { color: dsUsageColor(pct) } : {}) }}>{dsFmtGB(d.freeGB)}</td>
            <td data-sort={pct == null ? '' : pct}>
              {pct == null
                ? <span className="muted" title="사용량을 읽지 못함(여유 공간 미보고 — 접근 불가 데이터스토어 등)">—</span>
                : (
                  <div style={{ height: 6, borderRadius: 4, background: 'rgba(148,163,184,.15)', overflow: 'hidden' }} title={`${pct}%`}>
                    <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: dsUsageColor(pct) }} />
                  </div>
                )}
            </td>
          </tr>
        );
      })}</tbody>
    </STable>
  );
}

export function DatastoreUsage({ scope }) {
  const { loading, data, error } = usePolling('/datastores', {}, 15_000);
  const { data: vcList } = usePolling('/vcenters', {}, 60_000);
  const [dc, setDc] = useState({ datacenters: [], assign: {} });
  // v2.590 W3: 법인 목록 조회는 관리자 전용이다. 실패를 삼키면 assign 이 비어 **전부 '⚠ 법인 미지정'** 으로 묶여
  //   관리자가 정상 지정해 둔 현장에서 operator 화면이 '설정 결함' 처럼 읽혔다. 실패는 따로 들고 그렇게 말한다.
  const [dcErr, setDcErr] = useState(null);
  // 하위 탭을 URL 에 실어 새로고침·북마크·뒤로가기에서 유지한다(v2.438, hooks/useHashTab.js).
  const [view, setView] = useHashTab({ base: ['tools', 'dsusage'], valid: ['dc', 'vc'], fallback: 'dc' });
  const [q, setQ] = useState('');
  useEffect(() => { fetchJson('/admin/datacenters').then((r) => { setDc({ datacenters: r.datacenters || [], assign: r.assign || {} }); setDcErr(null); }).catch((e) => setDcErr(e)); }, []);
  if (loading && !data) return <Loading />;
  // 데이터 보유 중 일시 폴링 오류로 화면 전체를 오류 박스로 갈아치우지 않는다(CLAUDE.md 회귀
  // 방지, 고RTT 깜빡임) — 데이터가 없을 때만 전체 오류, 있으면 아래 배너로만 알린다.
  if (error && !data) return <ErrorBox message={error} />;
  const vcName = new Map((vcList || []).map((v) => [v.id, v.name || v.id]));
  const dcName = new Map((dc.datacenters || []).map((x) => [x.id, x.name || x.id]));
  const assign = dc.assign || {};
  const dcOfVc = (vcId) => assign[String(vcId || '')] || '';
  const ql = q.trim().toLowerCase();
  // /datastores 응답은 배열이 아니라 { total, items } 객체다 — 다른 소비 뷰(Datastores.jsx,
  // VCenterDetail.jsx)는 모두 ?.items 로 언랩하는데 이 화면만 배열로 오인해
  // '(data||[]).filter is not a function' 으로 화면 전체가 오류 박스로 떨어졌다(v2.349 수정).
  // 공용 itemsOf 로 통일 — 배열/객체/null 어느 형태든 안전하게 배열을 얻는다.
  let list = itemsOf(data).filter((d) => !scope || d.vcenterId === scope);
  if (ql) list = list.filter((d) => [d.name, d.type, d.vcenterId].some((x) => String(x || '').toLowerCase().includes(ql)));

  const tot = dsAgg(list);
  const vcIds = new Set(list.map((d) => d.vcenterId));

  // vCenter 단위 그룹.
  const byVc = new Map();
  for (const d of list) { const k = d.vcenterId || '(미지정)'; if (!byVc.has(k)) byVc.set(k, []); byVc.get(k).push(d); }
  const vcBlocks = [...byVc.entries()].map(([id, items]) => ({
    id, name: vcName.get(id) || id, items,
    agg: dsAgg(items),
  })).sort((a, b) => b.agg.capacityGB - a.agg.capacityGB);

  return (
    <div>
      {error && <div className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>업데이트 실패(이전 데이터 표시 중): {String(error)}</div>}
      <div className="kpis" style={{ marginBottom: 14 }}>
        <Card label="전체 용량" value={dsFmtGB(tot.capacityGB)} accent="var(--accent)" />
        <Card label="사용" value={tot.pct == null ? '—' : `${dsFmtGB(tot.usedGB)} (${tot.pct}%)`} accent={dsUsageColor(tot.pct)}
          meta={tot.unknown ? `사용량 모름 ${tot.unknown}개 제외(용량 ${dsFmtGB(tot.capacityGB - tot.knownCapGB)})` : undefined} />
        <Card label="여유" value={tot.pct == null ? '—' : dsFmtGB(tot.freeGB)} accent="var(--green)" />
        <Card label="데이터스토어" value={list.length} meta={`${vcIds.size} vCenter`} />
      </div>

      <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 12 }}>
        <div className="flex gap">
          <button className={view === 'dc' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('dc')}>🏢 DataCenter별</button>
          <button className={view === 'vc' ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '7px 14px' }} onClick={() => setView('vc')}>🖥 vCenter별</button>
        </div>
        <input className="input" placeholder="데이터스토어/유형/vCenter 검색" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>

      {list.length === 0 && <div className="card" style={{ padding: 16 }}><span className="muted">표시할 데이터스토어가 없습니다.</span></div>}

      {view === 'vc' && vcBlocks.map((vc) => (
        <div key={vc.id} className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>🖥 {vc.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {vc.items.length}개 · {dcName.get(dcOfVc(vc.id)) || dcOfVc(vc.id) || (dcErr ? '법인 정보 없음' : '법인 미지정')}</span></div>
            <DsCapBar agg={vc.agg} />
          </div>
          <DsVcTable items={vc.items} />
        </div>
      ))}

      {view === 'dc' && (() => {
        // 1차: DataCenter(vCenter의 소속 법인). 2차: vCenter.
        const byDc = new Map();
        for (const vc of vcBlocks) { const k = dcOfVc(vc.id) || '__unassigned__'; if (!byDc.has(k)) byDc.set(k, []); byDc.get(k).push(vc); }
        const dcBlocks = [...byDc.entries()].map(([id, vcs]) => ({
          id, name: id === '__unassigned__' ? (dcErr ? '법인 정보를 읽지 못함' : '⚠ 법인 미지정') : (dcName.get(id) || id), vcs,
          agg: dsAgg(vcs.flatMap((v) => v.items)),
        })).sort((a, b) => (a.id === '__unassigned__' ? 1 : 0) - (b.id === '__unassigned__' ? 1 : 0) || b.agg.capacityGB - a.agg.capacityGB);
        const dcNote = dcErr ? (
          <div key="__dcerr" className="card" style={{ padding: 12, marginBottom: 12, borderLeft: '3px solid var(--amber)', fontSize: 13, whiteSpace: 'normal' }}>
            법인(DataCenter) 정보를 읽지 못했습니다{dcErr?.status === 403 ? ' — 이 계정에는 법인 목록 조회 권한(관리자)이 없습니다' : ` — ${dcErr?.message || dcErr}`}.
            아래는 법인으로 묶지 못한 목록이며, <b>법인이 지정되지 않았다는 뜻이 아닙니다</b>. vCenter별 보기를 쓰세요.
          </div>
        ) : null;
        return [dcNote, ...dcBlocks.map((d) => (
          <div key={d.id} className="card" style={{ padding: 14, marginBottom: 16, borderLeft: '3px solid var(--accent, #60a5fa)' }}>
            <div className="flex between wrap gap" style={{ alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>🏢 {d.name} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {d.vcs.length} vCenter · {dsSum(d.vcs.flatMap((v) => v.items), 'capacityGB') ? d.vcs.reduce((a, v) => a + v.items.length, 0) : 0}개 데이터스토어</span></div>
              <DsCapBar agg={d.agg} />
            </div>
            {d.vcs.map((vc) => (
              <div key={vc.id} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(148,163,184,.15)' }}>
                <div className="flex between wrap gap" style={{ alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>🖥 {vc.name} <span className="muted" style={{ fontWeight: 400 }}>· {vc.items.length}개</span></div>
                  <DsCapBar agg={vc.agg} />
                </div>
                <DsVcTable items={vc.items} />
              </div>
            ))}
          </div>
        ))];
      })()}
    </div>
  );
}
