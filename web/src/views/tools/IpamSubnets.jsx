// IpamSubnets.jsx — 대역 탭의 대역 목록(왼쪽)과 주소 맵(v3.4.0 재설계 묶음 가 · 시안 docs/design/ipam-redesign ② Subnets.dc.html).
// 예전 '서브넷 대장' 은 /24 칩을 전부(수백 개) 늘어놓고 같은 목록의 드롭다운을 또 그렸다 — 찾을 수 있는 목록 하나로 바꾼다.
// 맵 칸 종류는 ipamHomeText.mapCellKind 하나(표의 행 색과 같은 뜻).
import React, { useMemo, useState } from 'react';
import { putJson } from '../../api.js';
import { MAP_KINDS, filterSubnets, mapCellKind, mapCounts, occOf, pctText } from './ipamHomeText.js';
import { Meter } from './IpamHome.jsx';

const SORTS = [['used', '사용률 높은 순'], ['base', '대역 순']];

/** 왼쪽 대역 목록 — 찾기 · 정렬 · 고른 대역 표시. 한 번에 그리는 줄은 limit(정렬 뒤 자른다). */
export function SubnetList({ subnets, base, onPick, err, limit = 300 }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('used');
  const list = useMemo(() => {
    const f = filterSubnets(subnets, q).map((s, i) => ({ ...s, i, occ: occOf(s), pct: (occOf(s) / 254) * 100 })); // v3.5.0: 점유 = 대장 + 예약 + DHCP
    if (sort === 'used') f.sort((a, b) => (b.pct - a.pct) || (a.i - b.i));
    return f;
  }, [subnets, q, sort]);
  const shown = list.slice(0, limit);
  return (
    <section className="card ipam-netlist" aria-label="대역 목록">
      <div className="ipam-netlist-top">
        <input className="input" type="search" aria-label="대역 · 용도 찾기" placeholder="대역 · 용도 찾기 — 10.20.30" value={q} onChange={(e) => setQ(e.target.value)} />
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
            {s.purpose ? <span className="ipam-net-pur">{s.purpose}</span> : <span className="mono" style={{ fontWeight: 600 }}>{s.subnet}</span>}
            <span className="mono muted" style={{ fontSize: 11.5 }}>{s.occ}/254 · {pctText(s.pct)}</span>
            {s.purpose ? <span className="mono muted" style={{ gridColumn: '1 / 3', fontSize: 11.5 }}>{s.subnet}</span> : null}
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

/**
 * v3.5.0(재설계 묶음 나 — 시안 ② 대역 용도): 고른 대역의 용도 · 설명 편집. 운영자 이상 + 전체 범위만 저장된다(서버 PUT /tools/ipam/subnet-note —
 * 범위 계정은 403 을 받고 그 사유를 그대로 보인다). 400(길이 초과 등)은 putJson 이 본문으로 돌려준다.
 */
export function SubnetPurposeEdit({ base, note, onSaved }) {
  const [purpose, setPurpose] = useState(note?.purpose || '');
  const [desc, setDesc] = useState(note?.desc || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // 대역을 바꾸면 그 대역의 값으로(이전 대역의 입력을 새 대역에 남기지 않는다).
  React.useEffect(() => { setPurpose(note?.purpose || ''); setDesc(note?.desc || ''); setMsg(null); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = purpose !== (note?.purpose || '') || desc !== (note?.desc || '');
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await putJson('/tools/ipam/subnet-note', { base, purpose, desc });
      if (r?.ok) { setMsg({ ok: true, text: '저장했습니다.' }); onSaved?.(base, r.note || { purpose: '', desc: '' }); }
      else setMsg({ ok: false, text: r?.error || '저장하지 못했습니다.' });
    } catch (e) { setMsg({ ok: false, text: e?.message || '저장하지 못했습니다.' }); }
    setBusy(false);
  };
  return (
    <div className="ipam-purpose-edit" role="group" aria-label={`${base}.0/24 대역 용도`}>
      <label style={{ flex: '1 1 160px', maxWidth: 240 }}>대역 용도<input className="input" value={purpose} maxLength={80} onChange={(e) => setPurpose(e.target.value)} placeholder="예: 웹 서비스망" style={{ fontWeight: 700 }} /></label>
      <label style={{ flex: '3 1 240px' }}>설명<input className="input" value={desc} maxLength={500} onChange={(e) => setDesc(e.target.value)} placeholder="이 대역을 무엇에 쓰는지 · 할당 규칙" /></label>
      <button type="button" className="login-btn" style={{ flex: 'none', padding: '7px 14px' }} disabled={busy || !dirty} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      {note?.noteBy || note?.noteAt ? <span className="muted" style={{ fontSize: 11.5, paddingBottom: 8 }}>마지막 수정 {note.noteBy || '—'}{note.noteAt ? ` · ${String(note.noteAt).slice(0, 10)}` : ''}</span> : null}
      {msg && <span style={{ fontSize: 12, paddingBottom: 8, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</span>}
    </div>
  );
}
