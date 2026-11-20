// ScanRangeAdd.jsx — 스캔 대역 · 설정의 '사용 중인 대역에서 추가'(v3.6.0 재설계 묶음 다 — 시안 ⑪ ScanAdd.dc.html).
// 그 에이전트가 수집하는 vCenter 의 VM · ESXi 호스트(vmk 전체) 주소와 그 에이전트 담당 iDRAC 주소를 /24 로 묶은 후보를 사설 · 공인 두 묶음으로
// 보이고, 줄을 누르면 오른쪽 '담은 대역' 에 담긴다(다시 누르면 빠짐). 넣기는 가져오기 창과 같은 applyImport(새 대역은 스캔 대역 칸 ·
// 겹치는 대역은 '중복 대역' 칸) — 판정 코어는 vcRangeImportText.classifySubnets 하나(저장하지 않은 입력 기준). v2.638 '/24 고르기' 표를 바꾼 것이다.
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { classifySubnets } from './vcRangeImportText.js';
import { ignoredText, partialIgnoreText } from './scanRangeImportText.js';
import { suggestEmptyText, suggestSummaryText } from './ipScanDcText.js';
import { ADD_STATE, basketOf, canPick, groupCandidates, pickAllNew, srcParts } from './ipamServerText.js';

const GROUPS = [['private', '사설 대역'], ['public', '공인 대역'], ['unknown', '분류하지 못한 대역']];

export function ScanRangeAdd({ agent, text, saved, local = false, onConfirm }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    let alive = true; // 늦게 온 이전 에이전트의 응답을 버린다
    setData(null); setErr(null); setPicked(new Set()); setNote('');
    fetchJson('/admin/ipam/scan/suggest', { agent }).then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, [agent]);
  const rows = useMemo(() => classifySubnets(data?.subnets || [], { text, saved, vc: 'svc' }), [data, text, saved]);
  const g = groupCandidates(rows, q);
  const b = basketOf(rows, picked);
  const toggle = (r) => { if (!canPick(r)) return; setPicked((p) => { const x = new Set(p); if (x.has(r.cidr)) x.delete(r.cidr); else x.add(r.cidr); return x; }); };
  const put = () => {
    const sel = new Set(b.all.map((r) => r.cidr));
    onConfirm?.(rows, sel);
    setNote(`${sel.size}개를 넣었습니다 — 아직 저장하지 않았습니다. 아래 ‘저장’ 을 누르세요.`);
    setPicked(new Set());
  };
  const ignoredLine = ignoredText(data?.ignored, data?.ignoreSources);
  if (err) return <div style={{ marginTop: 8 }}><ErrorBox message={err} /></div>;
  if (!data) return <div style={{ marginTop: 8 }}><Loading /></div>;
  return (
    <div style={{ marginTop: 8, minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
        {suggestSummaryText(data)}{data.totals?.hostVmkIps ? ` · ESXi vMotion · vSAN 등 vmk 주소 ${data.totals.hostVmkIps}개 포함` : ''}
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
        대상: {(data.vcenters || []).length ? `vCenter ${(data.vcenters || []).map((v) => v.name).join(', ')}` : 'vCenter 없음'}
        {` · iDRAC ${data.idracServers ?? 0}대(${data.idracSource === 'central-registry' ? '이 포탈 등록' : '엣지가 마지막으로 보고한 목록'})`}
      </div>
      {data.inputErrors && <div style={{ fontSize: 11.5, color: 'var(--amber)' }}>일부 등록부를 읽지 못했습니다({Object.keys(data.inputErrors).join(', ')}) — 목록이 빠졌을 수 있습니다.</div>}
      {ignoredLine && <div className="muted" style={{ fontSize: 11.5 }}>{ignoredLine}</div>}
      {rows.length === 0 ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{suggestEmptyText(data, local)}</div> : (
        <div className="ipam-add">
          <div style={{ minWidth: 0 }}>
            <input className="input" type="search" aria-label="대역 · 용도 · vCenter 찾기" placeholder="대역 · 용도 · vCenter 찾기" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260, maxWidth: '100%', minWidth: 0, marginBottom: 8 }} />
            <div className="ipam-add-list">
            {GROUPS.map(([k, label]) => (g[k].length ? (
              <section key={k} className="ipam-add-group" aria-label={label}>
                <div className="ipam-add-ghead">
                  <b>{label}</b><span className="muted">{g[k].length}개 · 새 대역 {g[k].filter((r) => r.kind === 'new').length}</span>
                  <button type="button" className="tab" style={{ flex: 'none', padding: '2px 9px', fontSize: 11.5 }} onClick={() => setPicked((p) => pickAllNew(p, g[k]))}>새 대역 모두 담기</button>
                  {k === 'public' && <span style={{ fontSize: 11.5, color: 'var(--amber)' }}>우리 것이 아닌 공인 대역은 스캔하지 마세요.</span>}
                </div>
                {g[k].map((r) => {
                  const on = picked.has(r.cidr);
                  const st = ADD_STATE[r.kind] || { label: r.kind, tone: 'gray' };
                  return (
                    <button key={r.cidr} type="button" className="ipam-add-row" aria-pressed={on} disabled={!canPick(r)} onClick={() => toggle(r)}
                      title={canPick(r) ? (on ? '눌러서 빼기' : '눌러서 담기') : st.label}>
                      <span><b className="mono">{r.cidr}</b>{r.purpose ? <span className="ipam-net-pur" style={{ marginLeft: 8 }}>{r.purpose}</span> : null}</span>
                      <span style={{ fontWeight: 700, color: on ? 'var(--accent)' : 'var(--text-dim)' }}>{on ? '✓ 담김' : canPick(r) ? '+ 담기' : ''}</span>
                      <span className="muted" style={{ gridColumn: '1 / 3', fontSize: 11.5 }}>
                        {srcParts(r).join(' · ')}{(r.vcenters || []).length ? ` · ${r.vcenters.join(', ')}` : ''}
                        {' · '}<span style={{ color: st.tone === 'green' ? 'var(--green)' : st.tone === 'amber' ? 'var(--amber)' : undefined }}>{st.label}{r.kind === 'other' && r.with?.length ? `(${r.with.join(', ')})` : ''}</span>
                        {r.ignore === 'partial' ? <span style={{ color: 'var(--amber)' }}> · △ {partialIgnoreText(r, data.ignoreSources)}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </section>
            ) : null))}
            {!g.private.length && !g.public.length && !g.unknown.length && <div className="muted" style={{ fontSize: 12 }}>찾는 대역이 없습니다.</div>}
            </div>
          </div>
          <aside className="card ipam-add-basket" aria-label="담은 대역">
            <b>담은 대역 {b.all.length}개</b>
            <div className="muted" style={{ fontSize: 11.5 }}>주소 {b.addrs.toLocaleString()}개(/24 하나 = 254)</div>
            {[['사설', b.pri], ['공인', b.pub]].map(([l, list]) => (list.length ? (
              <div key={l} style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12 }}>{l} {list.length}개</div>
                <ul>{list.map((r) => <li key={r.cidr}><span className="mono">{r.cidr}</span><button type="button" className="tab" aria-label={`${r.cidr} 빼기`} style={{ padding: '0 7px', fontSize: 11 }} onClick={() => toggle(r)}>×</button></li>)}</ul>
              </div>
            ) : null))}
            {b.pub.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginBottom: 6 }}>공인 대역 {b.pub.length}개를 담았습니다 — 회사가 쓰는 대역인지 확인하세요(남의 대역을 스캔하면 공격으로 보일 수 있습니다).</div>}
            {b.overlap > 0 && <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>이미 일부 스캔 중이거나 다른 에이전트와 겹치는 {b.overlap}개는 ‘중복 대역’ 칸에 들어갑니다.</div>}
            <div className="flex gap" style={{ flexWrap: 'wrap' }}>
              <button type="button" className="login-btn" style={{ flex: 'none', padding: '6px 12px', fontSize: 12 }} disabled={!b.all.length} onClick={put}>스캔 대역 칸에 넣기 ({b.all.length}개)</button>
              <button type="button" className="logout-btn" style={{ padding: '6px 10px', fontSize: 12 }} disabled={!picked.size} onClick={() => setPicked(new Set())}>비우기</button>
            </div>
          </aside>
        </div>
      )}
      {note && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--green)' }}>{note}</div>}
    </div>
  );
}
