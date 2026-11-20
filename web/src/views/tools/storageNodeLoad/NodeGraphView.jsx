/**
 * NodeGraphView — '연결 그래프' 보기(v2.951 · 설계 docs/design/isilon-node-clients-viz/README.md ① 현 그래프 · ③ 노드 카드 — 사용자 선택).
 *  · `/client-dist` 하나(서버 DB 만 · 장비 호출 0 · 폴링 없음) — 클라이언트 분포 보기와 같은 숫자(창 평균 ops/s). 늦게 온 이전 응답은 버린다(seq).
 *  · 좌표 · 순서 · 글자는 nodeLoadViz.js(순수 — vitest). 쏠림 · 고정 · 노드 집합은 서버 값만 쓴다(여기서 다시 판정하지 않는다).
 *  · 노드(호 · 카드 머리)를 누르면 기존 드로어, 클라이언트(호 · 칩)를 누르면 드로어의 그 줄(onPick). 훅은 조기 return 위에 둔다(React #310).
 *  · 400px(폭 560 미만)은 현 그래프를 압축(클라이언트 글자 → 툴팁) · 노드가 많으면(CARDS_AUTO_NODES 초과) 카드로 시작한다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../../api.js';
import { sampleText, windowRangeText, distNotes, opsText } from './nodeLoadText.js';
import {
  vizDataOf, chordLayout, ribbonOpacity, cardsOf, defaultShape, protoLegend, graphSummary, fmtOps, clientLabel,
  COMPACT_WIDTH, CARDS_AUTO_NODES, SKEW_COLOR, IDLE_COLOR, NODE_COLOR,
} from './nodeLoadViz.js';

const RANGES = [{ key: '24h', label: '24시간' }, { key: '7d', label: '7일' }, { key: '30d', label: '30일' }];
const SHAPES = [{ key: 'chord', label: '현 그래프' }, { key: 'cards', label: '노드 카드' }];
const EMPHASIS = [{ key: 'skew', label: '쏠린 노드' }, { key: 'fixed', label: '고정 클라이언트' }, { key: 'none', label: '없음' }];

function Seg({ label, items, value, onPick }) {
  return (
    <div className="nl-segwrap">
      <span className="nl-seglabel">{label}</span>
      <div className="nl-seg" role="group" aria-label={label}>
        {items.map((it) => <button key={it.key} type="button" className={value === it.key ? 'on' : ''} aria-pressed={value === it.key} onClick={() => onPick(it.key)}>{it.label}</button>)}
      </div>
    </div>
  );
}
/** 그릇의 폭 — 400px 에서 현 그래프를 압축하려고 잰다(ResizeObserver 가 없으면 처음 한 번만). */
function useWidth(ref) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setW(el.clientWidth || 0);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
const keyActivate = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

/** ① 현 그래프 — SVG 1장. 노드 호(왼쪽) · 클라이언트 호(오른쪽) · 리본. 호버 · 포커스로 연결된 리본만 진하게. (export 는 렌더 스모크 테스트용) */
export function ChordGraph({ layout: L, emphasis, onPick }) {
  const [hot, setHot] = useState(null);
  const fs = L.compact ? 10 : L.labelFont;
  return (
    <svg className="nl-chord" viewBox={`0 0 ${L.size} ${L.size}`} role="img" aria-label="노드와 클라이언트를 잇는 현 그래프 — 왼쪽 호가 노드, 오른쪽 호가 클라이언트, 리본 굵기가 창 평균 ops/s" style={{ maxWidth: L.size }}>
      <g>
        {L.ribbons.map((r) => (
          <path key={r.key} d={r.path} fill="none" stroke={r.color} strokeWidth={r.width} strokeOpacity={ribbonOpacity(r, { emphasis, hot })} strokeLinecap="round">
            <title>{`${r.client} → 노드 ${r.node} · ${fmtOps(r.ops)} ops/s${r.proto ? ` · ${r.proto}` : ''}${r.fixed ? ' · 고정' : ''}`}</title>
          </path>
        ))}
      </g>
      {L.nodes.map((n) => {
        const go = () => onPick?.(n.id, null);
        return (
          <g key={n.id} className="nl-arc" tabIndex={0} role="button" aria-label={`${n.title} — 눌러서 이 노드의 클라이언트 드로어`}
            onMouseEnter={() => setHot({ kind: 'node', id: n.id })} onMouseLeave={() => setHot(null)} onFocus={() => setHot({ kind: 'node', id: n.id })} onBlur={() => setHot(null)}
            onClick={go} onKeyDown={keyActivate(go)}>
            <path d={n.path} fill={n.color}><title>{n.title}</title></path>
            <text x={n.label.x} y={n.label.sub ? n.label.y - 1 : n.label.y} textAnchor="end" dominantBaseline="middle" fontSize={L.compact ? 11 : 13} fontWeight="600" fill={n.label.fill || 'currentColor'}>{n.label.name}</text>
            {n.label.sub && <text x={n.label.x} y={n.label.y + 14} textAnchor="end" dominantBaseline="middle" fontSize={11} className="nl-svgmuted nl-svgmono">{n.label.sub}</text>}
          </g>
        );
      })}
      {L.clients.map((c) => {
        const go = () => onPick?.(c.top, c.client);
        const tip = `${clientLabel(c)}${c.name ? ` (${c.client})` : ''} · ${fmtOps(c.total)} ops/s${c.proto ? ` · ${c.proto}` : ''}${c.top != null ? ` · 주 노드 ${c.top}` : ''}${c.fixed ? ' · 고정' : ''}`;
        return (
          <g key={c.key} className="nl-arc" tabIndex={0} role="button" aria-label={`${tip} — 눌러서 드로어의 이 줄`}
            onMouseEnter={() => setHot({ kind: 'client', id: c.client })} onMouseLeave={() => setHot(null)} onFocus={() => setHot({ kind: 'client', id: c.client })} onBlur={() => setHot(null)}
            onClick={go} onKeyDown={keyActivate(go)}>
            <path d={c.path} fill={c.color}><title>{tip}</title></path>
            {c.label && (
              <text x={c.label.x} y={c.label.y} textAnchor="start" dominantBaseline="middle" fontSize={fs} fill="currentColor">
                {c.label.name} <tspan className="nl-svgmuted nl-svgmono" fontSize={fs - 1}>{c.label.sub}</tspan>
              </text>
            )}
          </g>
        );
      })}
      <text x={L.cx} y={L.cy - 8} textAnchor="middle" fontSize={11} className="nl-svgmuted nl-halo">클러스터 합</text>
      <text x={L.cx} y={L.cy + 14} textAnchor="middle" fontSize={L.compact ? 15 : 20} fontWeight="600" fill="currentColor" className="nl-svgmono nl-halo">{fmtOps(L.sum)} ops/s</text>
    </svg>
  );
}

/** ③ 노드 카드 — 카드 머리(버튼) = 노드 · 칩(버튼) = 클라이언트. (export 는 렌더 스모크 테스트용) */
export function NodeCards({ cards, onPick }) {
  return (
    <div className="nl-cards">
      {cards.map((c) => (
        <div key={c.id} className={`nl-card${c.skew ? ' skew' : ''}${c.idle ? ' idle' : ''}`}>
          <button type="button" className="nl-cardhead" onClick={() => onPick?.(c.id, null)} title={`노드 ${c.id} — 눌러서 이 노드의 클라이언트 · 프로토콜 드로어`}>
            <span className="nl-cardname">노드 {c.id}
              {c.skew ? <span className="nl-badge amber">쏠림{c.ratio != null ? ` ${c.ratio}×` : ''}</span>
                : c.idle ? <span className="nl-badge">최근 작업 없음</span>
                  : c.ratio != null ? <span className="nl-badge">평균 {c.ratio}×</span> : null}
            </span>
            <span className="nl-cardops">{c.idle ? '—' : fmtOps(c.total)}{!c.idle && <small>ops/s</small>}</span>
          </button>
          <div className={`nl-load${c.idle ? ' idle' : ''}`} title={c.idle ? '이 창에 ops 가 없습니다' : `노드 합 ${fmtOps(c.total)} ops/s · 가장 바쁜 노드 대비 ${c.barPct}%`}>
            {!c.idle && <b style={{ width: `${Math.max(1, c.barPct)}%`, background: c.skew ? SKEW_COLOR : undefined }} />}
            {c.meanPct != null && <s style={{ left: `${c.meanPct}%` }} title="노드 평균" />}
          </div>
          <div className="nl-proto">{c.protoSplit.map((p) => <i key={p.proto} style={{ width: `${p.pct}%`, background: p.color }} title={`${p.proto} ${fmtOps(p.ops)} ops/s · ${p.pct}%`} />)}</div>
          <div className="nl-note nl-protoline">{c.protoSplit.length ? c.protoSplit.map((p) => <span key={p.proto}>{p.proto} <span className="nl-mono">{fmtOps(p.ops)}</span></span>) : <span>프로토콜 —</span>}</div>
          {c.idle ? (
            <div className="nl-cardempty">이 창의 표본에서 이 노드로 요청을 보낸 클라이언트가 없습니다 — ‘연결 없음’ 이 아니라 ‘최근 작업 없음’ 입니다(쉬는 마운트는 통계에 잡히지 않습니다).</div>
          ) : (
            <div className="nl-chips">
              {c.chips.map((ch) => (
                <button type="button" key={ch.client} className={`nl-chip ${ch.tier}`} style={{ '--w': `${ch.fillPct}%`, '--c': ch.color }} onClick={() => onPick?.(c.id, ch.client)}
                  title={`${ch.client}${ch.proto ? ` · ${ch.proto}` : ''} · ${fmtOps(ch.ops)} ops/s${ch.fixed ? ' · 고정' : ''}${ch.multi ? ' · 다른 노드도 씁니다' : ''} — 눌러서 드로어의 이 줄`}>
                  <span className="nl-chipname">{ch.label}</span><span className="nl-chipops">{fmtOps(ch.ops)}</span>{ch.multi && <span className="nl-chiptag">2노드+</span>}
                </button>
              ))}
              {c.more > 0 && <span className="nl-chipmore">외 {c.more} — 드로어에서 전부</span>}
            </div>
          )}
          <div className="nl-cardfoot">클라이언트 {c.clientCount}{c.clientCount ? ` · 고정 ${c.fixedCount}` : ''}{c.multiCount ? ` · 두 노드 이상 ${c.multiCount}` : ''}</div>
        </div>
      ))}
    </div>
  );
}

export default function NodeGraphView({ deviceId, end = null, offsetMin = 540, onPick }) {
  const [range, setRange] = useState('7d');
  const [proto, setProto] = useState('all');
  const [shape, setShape] = useState(null);        // null = 노드 수로 정한다(defaultShape)
  const [emphasis, setEmphasis] = useState('skew');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true); setErr(null);
    const q = `range=${encodeURIComponent(range)}&proto=${encodeURIComponent(proto)}${end != null ? `&end=${end}` : ''}`;
    fetchJson(`/tools/storage/devices/${encodeURIComponent(deviceId)}/client-dist?${q}`)
      .then((r) => { if (my === seq.current) { setD(r); setBusy(false); } })
      .catch((e) => { if (my === seq.current) { setErr(e); setBusy(false); } });
  }, [deviceId, range, proto, end]);
  // 다른 장비의 늦은 응답을 이 장비 값처럼 그리지 않는다.
  const ready = !!(d && d.ok !== false && d.deviceId === deviceId);
  const data = useMemo(() => (ready ? vizDataOf(d) : null), [d, ready]);
  const shapeNow = shape ?? (data ? defaultShape(data.nodes.length) : 'chord');
  const compact = width > 0 && width < COMPACT_WIDTH;
  const layout = useMemo(() => (data && shapeNow === 'chord' ? chordLayout(data, { size: compact ? 380 : 760, compact }) : null), [data, shapeNow, compact]);
  const cards = useMemo(() => (data && shapeNow === 'cards' ? cardsOf(data) : null), [data, shapeNow]);
  const legend = data ? protoLegend(data.protos) : [];
  const sum = data ? graphSummary(data) : null;
  const notes = ready ? distNotes(d).filter((n) => n.text !== d.note) : [];   // 재배치 안내(응답 note)는 분포 보기 것 — 여기서는 뺀다
  const protos = ['all', ...(ready ? (d.protos || []) : [])];
  const drawerRange = range === '24h' ? '24h' : '7d';
  const pick = (node, client) => { if (node == null) return; onPick?.(node, client, drawerRange); };
  const idleText = sum && sum.idle.length ? `노드 ${sum.idle.join(', ')}` : data && data.nodes.length ? `노드 ${[...data.nodes].sort((a, b) => a.total - b.total || a.id - b.id)[0].id}` : '—';
  const idleSub = sum && sum.idle.length ? '최근 작업한 클라이언트 없음(‘연결 없음’ 이 아님)' : data && data.nodes.length ? `${opsText([...data.nodes].sort((a, b) => a.total - b.total || a.id - b.id)[0].total)} — 재배치 받을 쪽` : '—';
  return (
    <div className="nl-graph" ref={wrapRef}>
      <div className="nl-controls">
        <Seg label="모양" items={SHAPES} value={shapeNow} onPick={setShape} />
        <Seg label="창" items={RANGES} value={range} onPick={setRange} />
        <div className="nl-segwrap"><span className="nl-seglabel">프로토콜</span>
          <div className="nl-seg" role="group" aria-label="프로토콜">{protos.map((p) => <button key={p} type="button" className={proto === p ? 'on' : ''} aria-pressed={proto === p} onClick={() => setProto(p)}>{p === 'all' ? '전체' : p}</button>)}</div></div>
        {shapeNow === 'chord' && <Seg label="강조" items={EMPHASIS} value={emphasis} onPick={setEmphasis} />}
        {busy && <span className="nl-muted">불러오는 중…</span>}
      </div>
      {err && <div className="nl-banner amber">연결 그래프 조회 오류: {String(err?.message || err)}</div>}
      {ready && <div className="nl-note">{windowRangeText(d.end, d.days, offsetMin)} · 값 = 창 평균 ops/s(클라이언트 분포 보기와 같은 숫자) · 표본 주기 {sampleText(d.sample?.sampleMs)} · 쏠림 기준 노드 평균 × {d.thresholds.skewFactor} · 고정 기준 {Math.round(d.thresholds.fixedShare * 100)}%{d.proto !== 'all' ? ` · ${d.proto} 만` : ''}</div>}
      {notes.map((n) => <div key={n.text} className={`nl-banner ${n.tone}`}>{n.text}</div>)}
      {shape == null && data && data.nodes.length > CARDS_AUTO_NODES && <div className="nl-note">노드가 {data.nodes.length}개라 카드로 시작합니다 — 현 그래프는 호가 좁아집니다(‘모양’ 에서 바꿀 수 있습니다).</div>}
      {ready && sum && (
        <div className="nl-tiles">
          <div className="nl-tile"><span className="nl-tlabel">쏠린 노드 · 창 평균 ops/s</span>
            <b style={sum.skewed.length ? { color: '#fcd34d' } : undefined}>{sum.skewed.length ? `노드 ${sum.skewed.join(', ')}` : '없음'}</b>
            <span className="nl-muted">{sum.skewed.length ? `노드 평균 ${opsText(data.mean)} 의 ${d.thresholds.skewFactor}배 이상` : `모든 노드가 노드 평균 ${opsText(data.mean)} 의 ${d.thresholds.skewFactor}배 미만`}</span></div>
          <div className="nl-tile"><span className="nl-tlabel">{sum.idle.length ? '최근 작업 없는 노드' : '가장 한가한 노드'}</span><b>{idleText}</b><span className="nl-muted">{idleSub}</span></div>
          <div className="nl-tile"><span className="nl-tlabel">클라이언트 · 창</span><b>{sum.clients}{d.clientsTotal > sum.clients ? <small className="nl-muted"> / {d.clientsTotal}</small> : null}</b>
            <span className="nl-muted">고정 {sum.fixed} · 두 노드 이상 {sum.multi}{d.clientsTotal > sum.clients ? ` · 상위 ${sum.clients}만 그림` : ''}</span></div>
          <div className="nl-tile"><span className="nl-tlabel">클러스터 합 · 창 평균</span><b>{opsText(data.sum)}</b><span className="nl-muted">노드 {sum.nodes} · 노드 평균 {opsText(data.mean)}</span></div>
        </div>
      )}
      {layout && (
        <div className="nl-chordwrap">
          <ChordGraph layout={layout} emphasis={emphasis} onPick={pick} />
          <div className="nl-legend">
            {legend.map((k) => <span key={k.proto} className="nl-key"><i style={{ background: k.color, height: 6, borderRadius: 3 }} />{k.proto}</span>)}
            <span className="nl-key"><i style={{ background: SKEW_COLOR, width: 10, height: 10, borderRadius: 2 }} />쏠린 노드</span>
            <span className="nl-key"><i style={{ background: NODE_COLOR, width: 10, height: 10, borderRadius: 2 }} />노드(호 길이 = 합)</span>
            <span className="nl-key"><i style={{ background: IDLE_COLOR, width: 10, height: 10, borderRadius: 2 }} />최근 작업 없음</span>
            <span>리본 굵기 = 창 평균 ops/s · 노드에 올리면 그 리본만 · 노드를 누르면 드로어 · 클라이언트를 누르면 그 줄{compact ? ' · 좁은 화면이라 클라이언트 이름은 툴팁으로' : layout.hiddenLabels > 0 ? ` · 이름은 ops 상위 ${layout.labelMax}개만(나머지 ${layout.hiddenLabels}개는 툴팁 · 드로어)` : ''}</span>
          </div>
        </div>
      )}
      {cards && (
        <>
          <NodeCards cards={cards} onPick={pick} />
          <div className="nl-legend">
            {legend.map((k) => <span key={k.proto} className="nl-key"><i style={{ background: k.color, height: 6, borderRadius: 3 }} />{k.proto}</span>)}
            <span>카드 막대 = 노드 합(흰 눈금 = 노드 평균) · 띠 = 프로토콜 비중 · 칩 크기 3단계와 채움 = 가장 큰 클라이언트 대비 ops/s · 칩 왼쪽 띠 = 프로토콜</span>
          </div>
        </>
      )}
      {ready && <div className="nl-note">읽는 법 — {shapeNow === 'chord' ? '왼쪽 호의 길이가 그 노드로 들어오는 창 평균 ops/s 합이고, 리본 하나가 클라이언트 하나입니다(두 노드를 쓰는 클라이언트는 리본 2개). 호의 길이에는 바닥값이 있어 아주 작은 노드·클라이언트도 보입니다(정확한 수치는 툴팁 · 드로어).' : '카드 하나가 노드 하나이고, 칩이 그 노드에 ops 를 낸 클라이언트입니다. 두 노드를 쓰는 클라이언트는 두 카드에 나오고 ‘2노드+’ 꼬리표가 붙습니다.'} 통계에는 그 순간 요청을 보낸 클라이언트만 잡힙니다. 이름은 포탈 인벤토리에서만 붙입니다(역방향 DNS 없음).</div>}
    </div>
  );
}
