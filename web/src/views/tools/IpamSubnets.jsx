// IpamSubnets.jsx — 대역 탭의 대역 목록(왼쪽)과 주소 맵(v3.4.0 재설계 묶음 가 · 시안 docs/design/ipam-redesign ② Subnets.dc.html).
// 예전 '서브넷 대장' 은 /24 칩을 전부(수백 개) 늘어놓고 같은 목록의 드롭다운을 또 그렸다 — 찾을 수 있는 목록 하나로 바꾼다.
// 맵 칸 종류는 ipamHomeText.mapCellKind 하나(표의 행 색과 같은 뜻).
import React, { useMemo, useState } from 'react';
import { MAP_KINDS, filterSubnets, mapCellKind, mapCounts, pctText } from './ipamHomeText.js';
import { Meter } from './IpamHome.jsx';

const SORTS = [['used', '사용률 높은 순'], ['base', '대역 순']];

/** 왼쪽 대역 목록 — 찾기 · 정렬 · 고른 대역 표시. 한 번에 그리는 줄은 limit(정렬 뒤 자른다). */
export function SubnetList({ subnets, base, onPick, err, limit = 300 }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('used');
  const list = useMemo(() => {
    const f = filterSubnets(subnets, q).map((s, i) => ({ ...s, i, pct: (Math.min(254, Number(s.used) || 0) / 254) * 100 }));
    if (sort === 'used') f.sort((a, b) => (b.pct - a.pct) || (a.i - b.i));
    return f;
  }, [subnets, q, sort]);
  const shown = list.slice(0, limit);
  return (
    <section className="card ipam-netlist" aria-label="대역 목록">
      <div className="ipam-netlist-top">
        <input className="input" type="search" aria-label="대역 찾기" placeholder="대역 찾기 — 10.20.30" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap" style={{ alignItems: 'center', fontSize: 12, flexWrap: 'wrap' }}>
          {SORTS.map(([k, l]) => (
            <button key={k} type="button" className={`tab${sort === k ? ' active' : ''}`} style={{ padding: '3px 9px', fontSize: 11.5 }} onClick={() => setSort(k)}>{l}</button>
          ))}
          <span className="muted" style={{ marginLeft: 'auto' }}>{list.length.toLocaleString()}개{list.length > shown.length ? ` 중 ${shown.length}` : ''}</span>
        </div>
      </div>
      {err && <div className="banner warn" style={{ margin: '0 10px 8px' }}>대역 목록을 읽지 못했습니다(0개라는 뜻이 아닙니다){(subnets || []).length ? ' — 아래는 직전에 받은 목록입니다' : ''}: {err}</div>}
      <div className="ipam-netlist-rows">
        {shown.length === 0 && <div className="muted" style={{ padding: 12, fontSize: 12 }}>{q ? '찾는 대역이 없습니다.' : '대역이 없습니다.'}</div>}
        {shown.map((s) => (
          <button key={s.base} type="button" className={`ipam-net${s.base === base ? ' on' : ''}`} aria-current={s.base === base ? 'true' : undefined} onClick={() => onPick(s.base)}>
            <span className="mono" style={{ fontWeight: 600 }}>{s.subnet}</span>
            <span className="mono muted" style={{ fontSize: 11.5 }}>{s.used}/254 · {pctText(s.pct)}</span>
            <span style={{ gridColumn: '1 / 3' }}><Meter pct={s.pct} /></span>
          </button>
        ))}
        {list.length > shown.length && <div className="muted" style={{ padding: '8px 12px', fontSize: 12 }}>나머지 {(list.length - shown.length).toLocaleString()}개는 찾기로 좁히면 보입니다.</div>}
      </div>
    </section>
  );
}

/** 주소 맵 — 칸 하나가 주소 하나(.0 ~ .255). 칸을 누르면 그 주소의 이력 창(표의 IP 를 누른 것과 같다). */
export function SubnetMap({ rows, base, onPickRow }) {
  const counts = useMemo(() => mapCounts(rows), [rows]);
  if (!(rows || []).length) return null;
  return (
    <div className="ipam-map-wrap">
      <div className="ipam-map-lg">
        {MAP_KINDS.map(([k, l]) => <span key={k}><i className={`ipam-mc ${k}`} />{l} <b>{counts[k].toLocaleString()}</b></span>)}
      </div>
      <div className="ipam-map" role="group" aria-label={`${base}.0/24 주소 맵 — 칸 하나가 주소 하나`}>
        {rows.map((r) => {
          const kind = mapCellKind(r);
          const tip = `${r.ip} · ${(MAP_KINDS.find(([k]) => k === kind) || ['', kind === 'nw' ? '네트워크 주소' : kind])[1]}${r.hostname ? ` · ${r.hostname}` : ''}`;
          return (
            <button key={r.ip} type="button" className={`ipam-mc ${kind}`} title={tip} aria-label={tip}
              disabled={kind === 'nw'} onClick={() => onPickRow(r)}>{r.last}</button>
          );
        })}
      </div>
    </div>
  );
}
