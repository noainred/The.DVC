/**
 * serverTemp/parts.jsx — '서버 온도' 히트맵 보드의 표시 부품(v2.556).
 *
 * 계산은 전부 `board.js`(순수·vitest 고정)에 있다. 이 파일은 **그린다**. 색·간격은 시안
 * (`docs/design/server-temp/README.md`)의 최종값이고, 색은 기존 CSS 변수와 시안이 지정한
 * 강조색(#4ade80 #fbbf24 #f87171 #dbeafe #bfdbfe #7dd3fc #fecaca)만 쓴다.
 */
import React from 'react';
import { tempColor } from '../shared.jsx';
import { sparkCellState, sparkCellText } from '../sparkBatch.js';
import {
  TEMP_WARN_C, TEMP_HOT_C, tempNum, tempBuckets, thresholdLeftPct, showBucketLabel, bucketTitle,
  barPct1530, heatPct, tileFill, layoutGroup, sparkPath, sparkDeltaText, sparkSeriesLabel, densityMetrics,
} from './board.js';

const MONO = { fontFamily: 'var(--font-mono)' };
const num1 = (v) => { const n = tempNum(v); return n == null ? '—' : n.toFixed(1); };
const numRaw = (v) => { const n = tempNum(v); return n == null ? '—' : String(n); };

/** 모노 라벨(대문자·자간) — 카드·툴바 제목. */
export function MonoLabel({ children, size = 10.5, spacing = '.14em', color = 'var(--text-dim)', style }) {
  return (
    <div style={{ ...MONO, fontSize: size, letterSpacing: spacing, textTransform: 'uppercase', color, ...style }}>{children}</div>
  );
}

/** 세그먼트(뷰·구분 전환). 활성은 파란 채움 — 시안 §1. */
export function Segment({ items, value, onPick, pad = '5px 12px', size = 12.5 }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--panel-deep)', border: '1px solid var(--border)', borderRadius: 9, padding: 3 }}>
      {items.map(([k, label]) => (
        <button key={k} onClick={() => onPick(k)}
          style={{
            padding: pad, borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: size, fontWeight: 600, whiteSpace: 'nowrap',
            background: value === k ? 'rgba(59,130,246,.22)' : 'transparent',
            color: value === k ? '#dbeafe' : 'var(--text-dim)',
            transition: 'background-color .12s, color .12s',
          }}>{label}</button>
      ))}
    </div>
  );
}

/** 밀도 토글(여유/촘촘히). */
export function DensityToggle({ dense, onChange }) {
  const btn = (active) => ({
    padding: '6px 11px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
    background: active ? 'rgba(59,130,246,.18)' : 'transparent',
    color: active ? '#bfdbfe' : 'var(--text-dim)',
  });
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' }}
      title="표·타일·목록의 간격을 줄여 한 화면에 더 많이 봅니다(브라우저에 저장됩니다).">
      <button style={btn(!dense)} onClick={() => onChange(false)}>여유</button>
      <button style={{ ...btn(dense), borderLeft: '1px solid var(--border)' }} onClick={() => onChange(true)}>촘촘히</button>
    </div>
  );
}

/** 섹션 카드(헤더 + 본문). */
/**
 * 섹션 카드(헤더 + 본문).
 * ⚠⚠ **`minWidth: 0` 을 지우지 말 것** — flex/grid 자식의 기본 `min-width: auto` 때문에 안쪽
 *   표(열 11개, 400px 에서 실측 975px)가 카드를 **밀어 늘려** 페이지 전체가 가로로 넘친다
 *   (v2.556 Chromium 실측 628px → 수정 후 400px). 자식 쪽 `overflow: auto` 만으로는 부족하다 —
 *   루트 CLAUDE.md v2.520 이 기록한 함정이고 여기서 다시 밟았다.
 */
export function Section({ title, sub, right, children, bodyStyle }) {
  return (
    <div className="card" style={{ padding: 0, borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>{title}</div>
          {sub && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>}
        </div>
        {right}
      </div>
      <div style={{ minWidth: 0, ...bodyStyle }}>{children}</div>
    </div>
  );
}

/* ── 2. 온도 분포(1℃ 히스토그램) ─────────────────────────────────────────── */

export function TempHistogram({ rows, total, maxC, avgInletC }) {
  const buckets = tempBuckets(rows);
  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <div className="card" style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <MonoLabel>현재 온도 분포 · 서버 {Number(total || 0).toLocaleString()}대 · 1℃ 구간</MonoLabel>
        <div className="muted" style={{ fontSize: 12 }}>
          최고 센서 <b style={{ color: '#f87171' }}>{numRaw(maxC)}℃</b> · 흡기 평균 <b style={{ color: 'var(--text)' }}>{num1(avgInletC)}℃</b>
        </div>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 104, marginTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: '100%' }}>
          {buckets.map((b) => (
            <div key={b.t} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
              {showBucketLabel(b, maxN) && <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1 }}>{b.n}</div>}
              {/*
                ⚠⚠ **개수가 0 인 칸을 온도색으로 칠하지 말 것**(v2.556 스크린샷 판독에서 잡은 결함):
                  시안의 `height: max(2%, …)` 를 그대로 쓰면 빈 칸도 2px 막대가 남는데, 40℃ 이상
                  구간에서는 그것이 **빨간 선**이 되어 KPI 가 `40℃↑ 0` 이라고 말하는 동시에 분포는
                  '고온 서버가 있다' 고 말한다. 수치로는 안 잡히고 **그림을 읽어야** 보인다.
                  0 인 칸은 온도가 아니라 **축 눈금**이므로 중립색 1px 로 둔다.
              */}
              <div title={bucketTitle(b)}
                style={b.n === 0
                  ? { width: '100%', height: 1, background: 'var(--border-soft)', marginTop: 2 }
                  : {
                    width: '100%', height: `${Math.max(2, (b.n / maxN) * 100)}%`, minHeight: 2,
                    background: tempColor(b.t), borderRadius: '3px 3px 0 0', opacity: 0.85, marginTop: 2,
                  }} />
            </div>
          ))}
        </div>
        {[[TEMP_WARN_C, 'rgba(245,158,11,.6)', '#fbbf24'], [TEMP_HOT_C, 'rgba(239,68,68,.65)', '#f87171']].map(([c, line, text]) => (
          <div key={c} style={{ position: 'absolute', left: `${thresholdLeftPct(c)}%`, top: -6, bottom: 0, borderLeft: `1px dashed ${line}`, pointerEvents: 'none' }}>
            <span style={{ ...MONO, position: 'absolute', top: -4, left: 3, fontSize: 10, color: text, whiteSpace: 'nowrap' }}>{c}℃</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-faint)', borderTop: '1px solid var(--border-soft)', paddingTop: 6, marginTop: 6 }}>
        {['14℃', '18', '22', '26', '30', '34', '38', '42', '46+'].map((t) => <span key={t}>{t}</span>)}
      </div>
    </div>
  );
}

/* ── 3. 법인 비교 ─────────────────────────────────────────────────────────── */

export function DcCompare({ rows, sel, onPick, allAvgC, dense, regionOf }) {
  const M = densityMetrics(dense);
  const barTrack = { position: 'relative', height: 6, borderRadius: 3, background: 'rgba(255,255,255,.05)', overflow: 'hidden' };
  return (
    <div style={{ padding: '6px 8px 8px', overflow: 'auto', maxHeight: M.listMaxH }}>
      {rows.length === 0 && <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>표시할 법인이 없습니다.</div>}
      {rows.map((d) => {
        const region = regionOf ? regionOf(d.key) : '';
        const on = sel === d.key;
        return (
          <div key={d.key} role="button" tabIndex={0} onClick={() => onPick(d.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(d.key); } }}
            title={`${d.name} — 누르면 아래 히트맵·표를 이 법인으로 좁힙니다`}
            style={{
              display: 'grid', gridTemplateColumns: '120px minmax(0,1fr) 52px 74px', alignItems: 'center', gap: 12,
              padding: M.cmpPad, borderRadius: 8, cursor: 'pointer',
              border: `1px solid ${on ? 'rgba(59,130,246,.5)' : 'transparent'}`,
              background: on ? 'rgba(59,130,246,.14)' : 'transparent',
              transition: 'background-color .12s, border-color .12s',
            }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: sel && !on ? 'var(--text-dim)' : 'var(--text)' }}>{d.name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {[region, `물리 ${d.physical?.servers ?? 0}`, `가상화 ${d.virtual?.servers ?? 0}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {[['physical', d.physical?.avgC], ['virtual', d.virtual?.avgC]].map(([k, v]) => (
                <div key={k} style={barTrack}>
                  <span style={{ display: 'block', height: '100%', width: `${barPct1530(v)}%`, background: tempNum(v) == null ? 'rgba(255,255,255,.1)' : tempColor(v) }} />
                </div>
              ))}
              {tempNum(allAvgC) != null && (
                <div title={`전체 평균 ${num1(allAvgC)}℃`}
                  style={{ position: 'absolute', left: `${barPct1530(allAvgC)}%`, top: 0, bottom: 0, borderLeft: '1px dashed rgba(245,158,11,.35)' }} />
              )}
              {tempNum(d.all?.avgC) != null && (
                <span style={{ position: 'absolute', left: `calc(${barPct1530(d.all.avgC)}% - 3.5px)`, top: 'calc(50% - 3.5px)', width: 7, height: 7, borderRadius: '50%', background: 'var(--text)', boxShadow: '0 0 0 2px var(--panel)' }} />
              )}
            </div>
            <div style={{ fontSize: 11, textAlign: 'right', lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' }}>
              <div style={{ color: tempColor(d.physical?.avgC) }}>{num1(d.physical?.avgC)}</div>
              <div style={{ color: tempColor(d.virtual?.avgC) }}>{num1(d.virtual?.avgC)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: tempColor(d.all?.avgC), fontVariantNumeric: 'tabular-nums' }}>{num1(d.all?.avgC)}</div>
              {(d.hot || d.warm) ? (
                <span style={{
                  display: 'inline-block', marginTop: 2, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                  background: d.hot ? 'rgba(239,68,68,.16)' : 'rgba(245,158,11,.16)', color: d.hot ? '#f87171' : '#fbbf24',
                }}>{d.hot ? `${TEMP_HOT_C}℃↑ ${d.hot}` : `${TEMP_WARN_C}℃↑ ${d.warm}`}</span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 3. 이상 서버 ─────────────────────────────────────────────────────────── */

export function HotList({ rows, dense, spark, onOpen }) {
  const M = densityMetrics(dense);
  if (!rows.length) {
    return <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>이상 없음</div>;
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: M.listMaxH, padding: '4px 8px 8px' }}>
      {rows.map((r, i) => {
        const pts = spark?.map?.[r.key];
        const sp = sparkPath(pts, { width: 84, height: 24 });
        const st = sparkCellState(pts, spark?.asked?.has(r.key));
        const delta = sparkDeltaText(pts, r.curC);
        const hot = tempNum(r.curC) != null && tempNum(r.curC) >= TEMP_HOT_C;
        return (
          <div key={r.key} style={{
            display: 'grid', gridTemplateColumns: '20px minmax(0,1fr) 84px 54px', gap: 10, alignItems: 'center',
            padding: M.hotPad, borderBottom: '1px solid rgba(36,48,73,.5)', transition: 'background-color .12s',
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', textAlign: 'right' }}>{i + 1}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {onOpen && r.level
                  ? <button className="cell-link" style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => onOpen(r.level, r.key)}>{r.name}</button>
                  : <span style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>}
                {r.kind && (
                  <span style={{
                    flex: 'none', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                    background: r.kind === 'physical' ? 'rgba(245,158,11,.15)' : 'rgba(34,197,94,.15)',
                    color: r.kind === 'physical' ? '#fbbf24' : '#4ade80',
                  }}>{r.kind === 'physical' ? '물리' : '가상화'}</span>
                )}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {st === 'ok' && sp ? (
                <svg width="84" height="24" style={{ display: 'block', marginLeft: 'auto' }}
                  role="img" aria-label={sparkSeriesLabel(spark?.metric?.[r.key])}>
                  <title>{`${sparkSeriesLabel(spark?.metric?.[r.key])} · 최저 ${sp.lo.toFixed(1)}℃ · 최고 ${sp.hi.toFixed(1)}℃ · ${sp.n}점`}</title>
                  <path d={sp.area} fill={hot ? 'rgba(239,68,68,.16)' : 'rgba(245,158,11,.14)'} />
                  <path d={sp.d} fill="none" stroke={tempColor(r.curC)} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              ) : (
                <span className="muted" style={{ fontSize: 11 }} title={sparkCellText(st)?.title}>{sparkCellText(st)?.text ?? '—'}</span>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: tempColor(r.curC), fontVariantNumeric: 'tabular-nums' }}>{num1(r.curC)}</div>
              {delta && <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{delta}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 4. 히트맵 ───────────────────────────────────────────────────────────── */

export function TempHeatmap({ groups, view, dense, sel, onPick }) {
  const M = densityMetrics(dense);
  if (!groups.length) {
    return <div className="muted" style={{ fontSize: 12, padding: '18px 16px' }}>표시할 서버가 없습니다.</div>;
  }
  return (
    <div style={{ padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: M.groupGap, alignItems: 'flex-start' }}>
      {groups.map((g) => {
        const L = layoutGroup(g.items, g.valOf, { view, dense });
        const on = sel && sel === g.key;
        return (
          <div key={g.key || g.name} role={g.key ? 'button' : undefined} tabIndex={g.key ? 0 : undefined}
            onClick={g.key ? () => onPick(g.key) : undefined}
            onKeyDown={g.key ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(g.key); } } : undefined}
            style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 10,
              border: `1px solid ${on ? 'rgba(59,130,246,.55)' : 'rgba(36,48,73,.8)'}`,
              background: on ? 'rgba(59,130,246,.08)' : 'rgba(10,14,23,.35)',
              cursor: g.key ? 'pointer' : 'default', transition: 'border-color .12s, background-color .12s',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, whiteSpace: 'nowrap' }}>
              <span style={{ fontWeight: 700 }}>{g.name}</span>
              <span style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{L.n}</span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: tempColor(L.avg), fontVariantNumeric: 'tabular-nums' }}>{num1(L.avg)}℃</span>
            </div>
            <svg width={L.width} height={L.height} style={{ display: 'block' }} aria-hidden="true">
              {L.items.map(({ item, x, y, v }, i) => {
                const isHot = tempNum(v) != null && tempNum(v) >= TEMP_HOT_C;
                return (
                  <rect key={g.idOf ? g.idOf(item) : i} x={x} y={y} width={L.tile} height={L.tile} rx="2"
                    fill={tileFill(v)} {...(isHot ? { stroke: '#fecaca', strokeWidth: 1.5 } : {})}>
                    <title>{g.titleOf(item)}</title>
                  </rect>
                );
              })}
            </svg>
            {L.unreadable > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-faint)' }} title="온도를 읽지 못한 항목입니다. 정상이라는 뜻도, 이상이라는 뜻도 아닙니다.">
                상태 미확인 {L.unreadable}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 히트맵 범례 — 그라디언트 + 40℃↑ 사각(맥동은 이 사각에만 — 타일 수백 개에 걸면 GPU 낭비). */
export function HeatLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, color: 'var(--text-faint)', flexWrap: 'wrap' }}>
      <span>15℃</span>
      <span style={{ width: 120, height: 8, borderRadius: 4, background: 'linear-gradient(90deg, rgba(34,197,94,.25), #22c55e 55%, #f59e0b 62%, #ef4444 86%)' }} />
      <span>45℃</span>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--red)', animation: 'hotglow 1.6s infinite', marginLeft: 6 }} />
      <span>{TEMP_HOT_C}℃↑</span>
    </div>
  );
}

/* ── 5. 표 셀 ───────────────────────────────────────────────────────────── */

/** 히트셀 — 막대 + 값. 값이 없으면 막대 없이 '—'(0% 막대를 그리면 '아주 낮다' 로 읽힌다). */
export function HeatCell({ v, bold = false, dense = false }) {
  const n = tempNum(v);
  if (n == null) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  const M = densityMetrics(dense);
  return (
    <>
      <span style={{ display: 'inline-block', width: M.barW, height: 4, borderRadius: 2, background: 'rgba(255,255,255,.07)', overflow: 'hidden', marginRight: 8, verticalAlign: 'middle' }}>
        <span style={{ display: 'block', height: '100%', width: `${heatPct(n)}%`, background: tempColor(n) }} />
      </span>
      <span style={{ display: 'inline-block', minWidth: 34, color: tempColor(n), fontWeight: bold ? 700 : 500, verticalAlign: 'middle' }}>{n}</span>
    </>
  );
}

/**
 * 피크셀(최고/최대) — 막대 없이 값만, 옅게.
 * 이유: 최고 센서는 거의 항상 40℃↑ 라 막대까지 붉히면 **경보색이 희석된다**(README §5).
 */
export function PeakCell({ v }) {
  const n = tempNum(v);
  if (n == null) return <span style={{ color: 'var(--text-faint)' }}>—</span>;
  return <span style={{ color: tempColor(n), fontWeight: 400, opacity: 0.75 }}>{n}</span>;
}

/** 표의 스파크셀 — 선만. 대기(…)와 없음(—)을 구분한다(sparkBatch.js 규약). */
export function TempSpark({ points, requested, curC, metric, width = 84, height = 22 }) {
  const st = sparkCellState(points, requested);
  if (st !== 'ok') {
    const t = sparkCellText(st);
    return <span className="muted" style={{ fontSize: 11 }} title={t?.title}>{t?.text ?? '—'}</span>;
  }
  const sp = sparkPath(points, { width, height });
  if (!sp) return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  return (
    <svg width={width} height={height} style={{ display: 'block', marginLeft: 'auto' }} role="img" aria-label={sparkSeriesLabel(metric)}>
      <title>{`${sparkSeriesLabel(metric)} · 최저 ${sp.lo.toFixed(1)}℃ · 최고 ${sp.hi.toFixed(1)}℃ · ${sp.n}점`}</title>
      <path d={sp.d} fill="none" stroke={tempColor(curC)} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
