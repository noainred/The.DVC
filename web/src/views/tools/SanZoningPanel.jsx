/**
 * SanZoningPanel.jsx — SAN 스위치 조닝 그림(v2.511). 포트 상세 모달의 `🔗 조닝` 탭.
 *
 * 사용자 요청: "포트 속도 측정하는 파트에 조닝 정보를 그림으로 예쁘게" + "둘 다"(그래프·매트릭스).
 *
 * 두 그림을 전환한다:
 *  · **패브릭 맵**(이분/3열 그래프) — 왼쪽 이니시에이터, 오른쪽 타깃, 선 = zone. 조닝의 본질.
 *  · **매트릭스** — 행 × 열 격자. 수백 개에서도 '누가 누구를 못 보는지'(빈 칸)가 한눈에 보인다.
 *
 * 차트 라이브러리를 쓰지 않고 **SVG 를 직접 그린다** — recharts 는 카테고리 축 차트용이고,
 * 이 그림은 임의 좌표의 선·격자라 맞지 않는다(억지로 맞추면 상호작용이 불가능해진다).
 * 좌표·문구·상한 표기는 전부 `sanZoningView.js`(순수)가 만들고 여기서는 그리기만 한다.
 *
 * 정직 규약(화면):
 *  · 역할 판정이 추정이면 배지로 **추정**이라 적고, `좌우 바꾸기` 로 뒤집을 수 있게 한다.
 *  · 상한으로 잘린 노드·행·열은 **개수를 적는다**.
 *  · 같은 장비가 양쪽 열에 나타날 수 있음을 각주로 설명한다(VPLEX FE/BE — 오류가 아니다).
 *  · 포트 목록이 온전할 때만 '로그인 안 함' 판정을 쓴다(엣지 위임은 문제 포트만 올라온다).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';   // 순수 모듈 문구의 **강조** 별표 노출 방지(v2.447 규약)
import { Loading, ErrorBox } from '../../components/ui.jsx';
import {
  shortLabel, SIDE_LABEL, CONFIDENCE_LABEL, sourceText, truncationText, confidenceSummary,
  layoutGraph, layoutMatrix, cellColor, matchNode, SEVERITY_BADGE, labelMap, MATRIX_DEFAULTS,
} from './sanZoningView.js';

const SIDE_COLOR = { initiator: '#60a5fa', target: '#4ade80', middle: '#a855f7', unknown: '#94a3b8' };
const CONF_MARK = { confirmed: '●', inferred: '◐', guess: '◔', none: '○' };

function NodeBox({ n, w, labels, onHover, onFocus, focused, hovered, dim }) {
  const c = SIDE_COLOR[n.side] || SIDE_COLOR.unknown;
  const active = focused || hovered;
  return (
    <g transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer', opacity: dim ? 0.3 : 1 }}
      onMouseEnter={() => onHover(n.wwn)} onMouseLeave={() => onHover(null)} onClick={() => onFocus(n.wwn)}>
      <title>{`${shortLabel(n, labels)}\nWWN ${n.wwn}\n역할 ${SIDE_LABEL[n.side]} (${CONFIDENCE_LABEL[n.confidence]})\n${n.basis || ''}${n.hint ? `\n단서 ${n.hint}` : ''}\nzone ${n.degree}개${n.port ? `\n포트 ${n.port}${n.online === false ? ' (링크 다운)' : ''}` : ''}`}</title>
      <rect x={0} y={-9} width={w} height={18} rx={4}
        fill={active ? 'rgba(148,163,184,.22)' : 'rgba(148,163,184,.08)'} stroke={c} strokeWidth={active ? 1.4 : 0.8} />
      <text x={6} y={4} fontSize={10.5} fill="var(--text,#e2e8f0)">{shortLabel(n, labels).slice(0, 26)}</text>
      <text x={w - 6} y={4} fontSize={9} textAnchor="end" fill={c}>
        {CONF_MARK[n.confidence]} {n.degree}
      </text>
    </g>
  );
}

function FabricMap({ graph, flip, q, labels }) {
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const filtered = useMemo(() => {
    if (!q.trim()) return graph;
    const keep = new Set(graph.nodes.filter((n) => matchNode(n, q)).map((n) => n.wwn));
    // 검색 결과와 **직접 연결된 것**도 남긴다 — 상대가 없으면 선이 안 보여 쓸모가 없다.
    for (const l of graph.links) { if (keep.has(l.a)) keep.add(l.b); if (keep.has(l.b)) keep.add(l.a); }
    return { ...graph, nodes: graph.nodes.filter((n) => keep.has(n.wwn)), links: graph.links.filter((l) => keep.has(l.a) && keep.has(l.b)) };
  }, [graph, q]);
  const L = useMemo(() => layoutGraph(filtered, { flip, hover, focus }), [filtered, flip, hover, focus]);
  const omitted = Object.entries(L.omitted);

  if (!L.cols.some((c) => c.nodes.length)) {
    return <div className="muted" style={{ padding: 24, textAlign: 'center', fontSize: 13 }}>표시할 엔드포인트가 없습니다{q ? ' — 검색어를 지워 보세요.' : '.'}</div>;
  }
  return (
    <>
      <div className="flex gap wrap" style={{ alignItems: 'center', gap: 12, marginBottom: 4, fontSize: 11.5 }}>
        {L.cols.map((c) => <span key={c.key} className="muted">{c.title} <b style={{ color: 'var(--text)' }}>{c.nodes.length}</b></span>)}
        <span className="muted">선 = zone <b style={{ color: 'var(--text)' }}>{L.edges.length}</b></span>
        {focus && <button className="tab" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => setFocus(null)}>전체 보기</button>}
      </div>
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 520, border: '1px solid rgba(148,163,184,.18)', borderRadius: 8, padding: 8 }}>
        <svg width={L.width} height={L.height} style={{ display: 'block', minWidth: '100%' }}>
          {L.edges.map((e, i) => (
            <path key={i} d={`M${e.x1},${e.y1} C${e.x1 + 60},${e.y1} ${e.x2 - 60},${e.y2} ${e.x2},${e.y2}`}
              fill="none" stroke={e.dim ? 'rgba(148,163,184,.14)' : 'rgba(96,165,250,.5)'} strokeWidth={e.dim ? 0.7 : 1.2}>
              <title>{e.zone}</title>
            </path>
          ))}
          {L.cols.map((c) => c.nodes.map((n) => (
            <NodeBox key={n.wwn} n={n} w={210} labels={labels} onHover={setHover} onFocus={(w) => setFocus(focus === w ? null : w)}
              focused={focus === n.wwn} hovered={hover === n.wwn}
              dim={!!(hover && hover !== n.wwn && !L.edges.some((e) => !e.dim && (e.a === n.wwn || e.b === n.wwn)))} />
          )))}
        </svg>
      </div>
      {omitted.length > 0 && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          ⚠ 화면 상한으로 {omitted.map(([k, v]) => `${k === 'left' ? '왼쪽' : k === 'right' ? '오른쪽' : '가운데'} ${v}개`).join(' · ')}를 그리지 않았습니다(zone 수가 많은 순으로 남깁니다). 검색으로 좁히거나 노드를 눌러 그 노드만 보세요.
        </div>
      )}
    </>
  );
}

function MatrixView({ matrix, flip, q, labels }) {
  const [hover, setHover] = useState(null);
  const filtered = useMemo(() => {
    if (!q.trim()) return matrix;
    const rk = matrix.rows.map((r, i) => (matchNode(r, q) ? i : -1)).filter((i) => i >= 0);
    const ck = matrix.cols.map((c, i) => (matchNode(c, q) ? i : -1)).filter((i) => i >= 0);
    // 행·열 중 한쪽만 맞아도 그 줄은 남긴다(교차점을 보려면 반대편이 필요하다).
    const rows = rk.length ? rk : matrix.rows.map((_, i) => i);
    const cols = ck.length ? ck : matrix.cols.map((_, i) => i);
    const rMap = new Map(rows.map((i, j) => [i, j])); const cMap = new Map(cols.map((i, j) => [i, j]));
    return {
      rows: rows.map((i) => matrix.rows[i]), cols: cols.map((i) => matrix.cols[i]),
      cells: matrix.cells.filter((x) => rMap.has(x.r) && cMap.has(x.c)).map((x) => ({ ...x, r: rMap.get(x.r), c: cMap.get(x.c) })),
    };
  }, [matrix, q]);
  // 작은 패브릭(수십 개)에서는 18px 칸이 너무 작아 읽히지 않는다 — 칸을 키운다.
  // 상한(80×80)에 가까운 대형 패브릭은 그대로 둔다(키우면 화면 밖으로 나간다).
  const cell = Math.max(filtered.rows.length, filtered.cols.length) <= 24 ? 30 : MATRIX_DEFAULTS.cell;
  const M = useMemo(() => layoutMatrix(filtered, { flip, cell }), [filtered, flip, cell]);
  const om = Object.entries(M.omitted);
  if (!M.rows.length || !M.cols.length) {
    return <div className="muted" style={{ padding: 24, textAlign: 'center', fontSize: 13 }}>표시할 조합이 없습니다.</div>;
  }
  return (
    <>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>
        행 {M.rows.length} × 열 {M.cols.length} · 칠해진 칸 = 그 조합을 잇는 zone 이 있음(색 진할수록 여러 개) · <b>빈 칸 = 경로 없음</b>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 520, border: '1px solid rgba(148,163,184,.18)', borderRadius: 8, padding: 8 }}>
        {/* 열 라벨은 -60° 로 **오른쪽 위로** 뻗는다 — 폭을 M.width 로 두면 마지막 열 라벨이
            SVG 밖으로 나가 잘린다(스크린샷을 읽다가 발견). 그 넘침만큼 오른쪽을 비워 둔다. */}
        <svg width={M.width + 72} height={M.height + 8} style={{ display: 'block' }}>
          {/* 열 라벨 — 세로쓰기(가로로 쓰면 18px 칸에 안 들어간다) */}
          {M.cols.map((c) => (
            <text key={c.wwn} x={c.x + M.cell / 2} y={M.labelH - 6} fontSize={9.5} textAnchor="start"
              fill={hover?.c === c.wwn ? 'var(--text,#e2e8f0)' : 'var(--muted,#94a3b8)'}
              transform={`rotate(-60 ${c.x + M.cell / 2} ${M.labelH - 6})`}>
              <title>{`${shortLabel(c, labels)}\n${c.wwn}\n${SIDE_LABEL[c.side]}`}</title>
              {shortLabel(c, labels).slice(0, 20)}
            </text>
          ))}
          {M.rows.map((r) => (
            <text key={r.wwn} x={M.labelW - 6} y={r.y + M.cell / 2 + 3} fontSize={9.5} textAnchor="end"
              fill={hover?.r === r.wwn ? 'var(--text,#e2e8f0)' : 'var(--muted,#94a3b8)'}>
              <title>{`${shortLabel(r, labels)}\n${r.wwn}\n${SIDE_LABEL[r.side]}`}</title>
              {shortLabel(r, labels).slice(0, 24)}
            </text>
          ))}
          {/* 격자(빈 칸이 '경로 없음' 임을 보이게 옅은 선을 깐다) */}
          {M.rows.map((r) => M.cols.map((c) => (
            <rect key={`${r.wwn}|${c.wwn}`} x={c.x} y={r.y - M.cell / 2 + M.cell / 2} width={M.cell - 1} height={M.cell - 1}
              fill="rgba(148,163,184,.05)" />
          )))}
          {M.cells.map((cell, i) => (
            <rect key={i} x={cell.x} y={cell.y} width={M.cell - 1} height={M.cell - 1} rx={2} fill={cellColor(cell.n)}
              onMouseEnter={() => setHover({ r: cell.row.wwn, c: cell.col.wwn })} onMouseLeave={() => setHover(null)}>
              <title>{`${shortLabel(cell.row, labels)} ↔ ${shortLabel(cell.col, labels)}\nzone ${cell.n}개\n${cell.zones.join('\n')}`}</title>
            </rect>
          ))}
        </svg>
      </div>
      {om.length > 0 && (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          ⚠ 화면 상한으로 {om.map(([k, v]) => `${k === 'rows' ? '행' : '열'} ${v}개`).join(' · ')}를 그리지 않았습니다. 검색으로 좁히세요.
        </div>
      )}
    </>
  );
}

export default function SanZoningPanel({ deviceId }) {
  // ⚠ 훅은 전부 조기 return 위(CLAUDE.md — React #310).
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('map');     // 'map' | 'matrix'
  const [flip, setFlip] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    // 폴링하지 않는다 — 조닝은 거의 바뀌지 않고, 분석이 zone 수에 비례한다(탭 열 때 1회).
    fetchJson(`/tools/sanswitch/devices/${encodeURIComponent(deviceId)}/zoning`)
      .then((r) => { if (alive) setD(r); })
      .catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [deviceId]);

  const conf = useMemo(() => confidenceSummary(d?.graph?.nodes || []), [d]);
  // 뒤 4바이트가 겹치는 WWN 은 같은 라벨로 보인다 — 충돌한 것만 늘려 구분한다(labelMap 주석).
  const labels = useMemo(() => labelMap(d?.graph?.nodes || []), [d]);
  if (err) return <ErrorBox message={err} />;
  if (!d) return <Loading />;

  const z = d.zoning;
  const trunc = truncationText(z);
  if (!z?.available) {
    return (
      <div className="card" style={{ padding: 16 }}>
        <b style={{ fontSize: 13.5 }}>조닝 정보가 없습니다</b>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.7, whiteSpace: 'normal' }}>
          {z?.reason || '이 스위치에서 조닝을 수집하지 못했습니다.'}
          <br />수집 상태: <b style={{ color: 'var(--text)' }}>{d.section}</b>
          {d.section !== 'ok' && <> — SSH 수집은 <code>cfgshow</code>, REST 수집은 <code>brocade-zone</code> 모듈이 필요합니다. 계정 권한이 낮으면 그 명령이 막힐 수 있습니다(스위치가 명령을 갖고 있지 않으면 시도 자체를 하지 않고 사유를 남깁니다).</>}
          {z?.effectiveConfig && <><br />활성 설정 이름은 <b style={{ color: 'var(--text)' }}>{z.effectiveConfig}</b> 로 확인됩니다(이름만 있고 멤버는 없습니다).</>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex between wrap" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div className="flex gap" style={{ gap: 6 }}>
          {[['map', '🗺 패브릭 맵'], ['matrix', '▦ 매트릭스']].map(([k, label]) => (
            <button key={k} className={view === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '5px 14px', fontSize: 12 }}
              onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        <div className="flex gap" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 200, padding: '4px 8px', fontSize: 12 }} placeholder="이름·별칭·WWN·포트 검색"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex gap muted" style={{ alignItems: 'center', fontSize: 12, cursor: 'pointer' }}
            title="역할 판정이 추정일 때 좌우가 뒤집혀 보일 수 있습니다. 이 토글로 바꿔 확인하세요(데이터는 바뀌지 않습니다).">
            <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> 좌우 바꾸기
          </label>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11.5, marginBottom: 6, lineHeight: 1.7, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
        {sourceText(z)} · 수집 {new Date(d.collectedAt).toLocaleString('ko-KR')} · {d.source}
        {trunc && <><br /><span style={{ color: 'var(--amber,#fbbf24)' }}>⚠ {trunc}</span></>}
        {conf.text && <><br /><BoldText text={conf.text} /></>}
        {d.graph.unresolvedTotal > 0 && <><br />미해석 멤버 {d.graph.unresolvedTotal}개 — 별칭 정의가 출력에 없거나 Domain,Port 표기입니다(그림에서 빠집니다).</>}
      </div>

      {view === 'map'
        ? <FabricMap graph={d.graph} flip={flip} q={q} labels={labels} />
        : <MatrixView matrix={d.matrix} flip={flip} q={q} labels={labels} />}

      {d.findings.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <b style={{ fontSize: 12.5 }}>점검 결과 {d.findings.length}건</b>
          <div className="muted" style={{ fontSize: 11, margin: '2px 0 6px' }}>
            판단 근거를 제시할 뿐 <b>설정을 바꾸라고 말하지 않습니다</b> — 역할 판정이 추정인 항목은 확인 후 판단하세요.
          </div>
          <div className="table-wrap" style={{ maxHeight: 220 }}>
            <STable>
              <thead><tr><th>Zone</th><th>종류</th><th data-nosort>내용</th></tr></thead>
              <tbody>
                {d.findings.map((f, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{f.zone}</td>
                    <td><span className={`badge ${SEVERITY_BADGE[f.severity] || 'gray'}`}>{f.kind}</span></td>
                    <td className="muted" style={{ whiteSpace: 'normal' }} data-nosort>{f.text}</td>
                  </tr>
                ))}
              </tbody>
            </STable>
          </div>
        </div>
      )}

      <div className="muted" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.7, whiteSpace: 'normal' }}>
        ※ 역할(이니시에이터/타깃)은 스위치 네임서버가 알려주면 <b>확정</b>(●), 아니면 zone 연결 구조를 2분할하고 WWN 단서로 방향을 정한 <b>추정</b>(◐)입니다.
        같은 장비가 <b>양쪽 열에 모두</b> 나타날 수 있습니다 — 예: VPLEX 는 프론트엔드 포트가 호스트의 타깃, 백엔드 포트가 어레이의 이니시에이터라 정상입니다.
        {d.portsComplete === false && <> 이 장비는 포트 목록이 일부만 올라와 있어(엣지 위임: 정상 포트 {d.portsOmitted}개 제외) <b>로그인 여부 판정은 하지 않았습니다</b>.</>}
        <br />조닝은 <b>패브릭 단위</b>라 같은 패브릭의 다른 스위치에서도 같은 zone 이 보입니다(스위치별 설정이 아닙니다). 이 화면은 조회 전용이며 설정을 바꾸지 않습니다.
      </div>
    </div>
  );
}
