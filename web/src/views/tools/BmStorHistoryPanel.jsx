/**
 * views/tools/BmStorHistoryPanel.jsx — 베어메탈 스토리지 디스크 사용량 추이(v2.635 → v2.688 시안 'BM Storage v2').
 *
 * 보기 셋: 전체 합계 / 그룹별 합산 / 전체 서버. 판정·좌표·문구는 `bmStorHistoryText.js`(순수, 테스트 고정)가
 * 소유하고 이 파일은 **그리기만** 한다.
 * ⚠ **폴링하지 않는다** — 기간을 바꿀 때만 1회 조회한다(12시간마다 쌓이는 이력이다. v2.508 규약).
 *   보기·단위·강조는 화면 상태라 바꿔도 다시 부르지 않는다(응답 하나에 세 종류 계열이 다 들어 있다 — kind 생략).
 * ⚠ 그룹 목록은 **사용량 많은 순**이다(사용자 선택 2026-10-03 — `sortGroupsByUsed`).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import BoldText from '../../components/boldText.jsx';
import { errorBoxInput } from '../../components/accessDeniedText.js';
import { ErrorBox } from '../../components/ui.jsx';
import {
  MODES, FALLBACK_PERIODS, bytesText, changeText, summaryOf, pathFor, dotsFor, gapMsFor, xTicksFor,
  partialNote, emptyNote, spanNote, pctOf, changeOf, lastOf, headline, yRange, yTicks, contributions,
  sortGroupsByUsed, groupColors, groupKeyOf, pctText, NO_GROUP, WARN_PCT,
} from './bmStorHistoryText.js';

const H = 260; const PAD_L = 62; const PAD_B = 22; const PAD_T = 10; const PAD_R = 10;
/** 점이 이보다 많으면 온전한 점은 찍지 않는다(선만) — 반기 360점이 굵은 띠가 된다. 부분 합 점은 항상 찍는다. */
const DOTS_MAX = 90;
const USED = '#60a5fa'; const CAP = 'rgba(148,163,184,0.7)'; const PART = '#fbbf24';
const MINT = 'var(--mint)'; const BLUE = 'var(--accent)';

/* 화면 옵션(브라우저 저장) — 처음 여는 보기 · 기본 단위 · 전체 합계 세로축. 저장소가 막혀 있으면 기본값(try/catch). */
const OPT_KEY = 'bmStorage.trend';
function loadOpts() {
  try {
    const o = JSON.parse(localStorage.getItem(OPT_KEY) || '{}') || {};
    return {
      mode: ['total', 'group', 'server'].includes(o.mode) ? o.mode : 'total',
      unit: o.unit === 'tb' ? 'tb' : 'pct',
      scale: o.scale === 'capacity' ? 'capacity' : 'zoom',
    };
  } catch { return { mode: 'total', unit: 'pct', scale: 'zoom' }; }
}
function saveOpts(o) { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* 사생활 보호 모드 등 — 무시 */ } }

/*
 * ⚠ viewBox 폭을 **실제 폭**에 맞춘다 — 고정 폭으로 두면 넓은 칸에서 글자·선이 커지고 좁은 칸에서 작아진다
 *   (v2.635 스크린샷 판독에서 발견). ResizeObserver 로 잰 폭을 그대로 쓴다.
 */
function useWidth(ref, fallback = 640) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((es) => { const cw = Math.floor(es[0]?.contentRect?.width || 0); if (cw > 0) setW(cw); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** path d(M/L 세그먼트) → 영역 채움 d — 세그먼트마다 바닥까지 닫는다(끊긴 구간은 채우지 않는다). */
function areaOf(d, h) {
  return d.split('M').filter(Boolean).map((seg) => {
    const pts = seg.split('L').map((s) => s.trim()).filter(Boolean);
    if (pts.length < 2) return '';
    const x0 = pts[0].split(',')[0]; const xn = pts[pts.length - 1].split(',')[0];
    return `M${x0},${h} L${pts.join(' L')} L${xn},${h} Z`;
  }).join(' ');
}

const segBtn = (on, color) => ({
  fontSize: 12, padding: '4px 11px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
  background: on ? `color-mix(in srgb, ${color} 22%, transparent)` : 'transparent', color: on ? color : 'var(--text-dim)', fontWeight: on ? 700 : 500,
});
function Seg({ items, value, onChange, color, disabled }) {
  return (
    <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--panel-deep)' }}>
      {items.map((it) => <button key={it.key} type="button" disabled={disabled} style={segBtn(it.key === value, color)} onClick={() => onChange(it.key)}>{it.label}</button>)}
    </span>
  );
}

const pctPick = (p) => pctOf(p);

function Chart({ mode, list, colorOf, focus, unit, scale, from, to, days, intervalHours, firstAt }) {
  const box = useRef(null);
  const W = Math.max(200, useWidth(box) - PAD_L - PAD_R);
  const rng = yRange(mode, unit, scale, list);
  const pick = mode !== 'total' && unit === 'pct' ? pctPick : 'usedBytes';
  const geo = { t0: from, t1: to, w: W, h: H, yMin: rng.min, yMax: rng.max };
  const gapMs = gapMsFor(intervalHours);
  const ticksX = xTicksFor(from, to, days);
  const ticksY = yTicks(rng);
  const span = (to - from) || 1;
  const noRecW = firstAt != null && firstAt > from + 12 * 3_600_000 ? Math.min(W, ((firstAt - from) / span) * W) : 0;
  const yAt = (v) => H - ((Math.min(rng.max, Math.max(rng.min, v)) - rng.min) / ((rng.max - rng.min) || 1)) * H;
  const many = list.length > 10;
  const ordered = focus == null ? list : [...list.filter((s) => String(s.key) !== String(focus)), ...list.filter((s) => String(s.key) === String(focus))];
  const md = (ts) => { const d = new Date(ts + 9 * 3_600_000); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`; };
  return (
    <div ref={box} style={{ minWidth: 0 }}>
      <svg viewBox={`0 0 ${W + PAD_L + PAD_R} ${H + PAD_B + PAD_T}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="디스크 사용량 추이">
        <defs>
          <pattern id="bmNoRec" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeOpacity="0.14" strokeWidth="3" />
          </pattern>
        </defs>
        {ticksY.map((tk) => {
          const y = PAD_T + H - tk.at * H;
          return (
            <g key={tk.at}>
              <line x1={PAD_L} y1={y} x2={PAD_L + W} y2={y} stroke="currentColor" strokeOpacity="0.10" />
              <text x={PAD_L - 8} y={y + 3} textAnchor="end" fontSize="10" fill="currentColor" fillOpacity="0.55" fontFamily="var(--mono)">{tk.label}</text>
            </g>
          );
        })}
        {ticksX.map((tk, i) => (
          <text key={i} x={PAD_L + tk.at * W} y={H + PAD_T + 16} textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'} fontSize="10" fill="currentColor" fillOpacity="0.55" fontFamily="var(--mono)">{tk.label}</text>
        ))}
        <g transform={`translate(${PAD_L},${PAD_T})`}>
          {noRecW > 4 && (
            <g>
              <rect x={0} y={0} width={noRecW} height={H} fill="url(#bmNoRec)" />
              {noRecW > 90 && <text x={noRecW / 2} y={H / 2} textAnchor="middle" fontSize="10.5" fill="currentColor" fillOpacity="0.6">기록 없음 · {md(firstAt)} 이전</text>}
            </g>
          )}
          {rng.kind === 'pct' && <line x1={0} x2={W} y1={yAt(WARN_PCT)} y2={yAt(WARN_PCT)} stroke="var(--amber)" strokeOpacity="0.7" strokeDasharray="5 4" />}
          {mode === 'total' && list[0] && (() => {
            const s = list[0];
            const used = pathFor(s.points, { ...geo, gapMs });
            const cap = scale === 'capacity' ? pathFor(s.points, { ...geo, gapMs, pick: 'totalBytes' }) : null;
            const lastCap = lastOf(s)?.totalBytes;
            const all = dotsFor(s.points, geo);
            const dots = all.length > DOTS_MAX ? all.filter((d) => d.partial) : all;
            return (
              <>
                {used && <path d={areaOf(used.d, H)} fill={USED} fillOpacity="0.12" />}
                {cap && <path d={cap.d} fill="none" stroke={CAP} strokeWidth="1.2" strokeDasharray="4 3" />}
                {cap && lastCap != null && <text x={W - 4} y={yAt(lastCap) - 5} textAnchor="end" fontSize="10.5" fill="currentColor" fillOpacity="0.7">총 용량 {bytesText(lastCap)}</text>}
                {used && <path d={used.d} fill="none" stroke={USED} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />}
                {dots.map((d, i) => (
                  <circle key={i} cx={d.x} cy={d.y} r={d.partial ? 3.2 : 2.6} fill={d.partial ? 'none' : USED} stroke={d.partial ? PART : USED} strokeWidth="1.4">
                    <title>{`${new Date(d.p.ts).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 사용 ${bytesText(d.p.usedBytes)} / ${bytesText(d.p.totalBytes)}${d.partial ? ` · 부분 합(서버 ${d.p.read}/${d.p.servers}대)` : ''}`}</title>
                  </circle>
                ))}
              </>
            );
          })()}
          {mode !== 'total' && ordered.map((s) => {
            const isF = focus != null && String(s.key) === String(focus);
            const dim = focus != null && !isF;
            const p = pathFor(s.points, { ...geo, gapMs, pick });
            const part = dotsFor(s.points, { ...geo, pick }).filter((d) => d.partial);
            const col = colorOf(s);
            return (
              <g key={`${s.kind}|${s.key}`} opacity={dim ? 0.12 : many && !isF ? 0.8 : 1}>
                {p && <path d={p.d} fill="none" stroke={col} strokeWidth={isF ? 3 : many ? 1.2 : 1.8} strokeLinejoin="round" strokeLinecap="round"><title>{s.name}</title></path>}
                {/* 기록이 하나뿐인 계열은 선이 없다 — 점으로 보인다(한 점을 선으로 만들지 않는다). */}
                {!p && dotsFor(s.points, { ...geo, pick }).filter((d) => !d.partial).slice(-1).map((d, i) => <circle key={`o${i}`} cx={d.x} cy={d.y} r={2.6} fill={col}><title>{s.name}</title></circle>)}
                {part.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={3} fill="none" stroke={PART} strokeWidth="1.3"><title>{`${s.name} · 부분 합(서버 ${d.p.read}/${d.p.servers}대)`}</title></circle>)}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function Swatch({ color }) {
  return <span style={{ width: 10, height: 10, borderRadius: 3, background: color, display: 'inline-block', flex: 'none' }} />;
}

/**
 * @param groups   /tools/bm-storage 의 groups(색·서버 수)
 * @param servers  /tools/bm-storage 의 servers(서버 → 소속 그룹)
 * @param request  { mode, key, n } — 주의 카드 클릭 등 바깥에서 보기·강조를 바꿀 때(n 이 바뀌면 적용)
 * @param onSeven  7일 응답을 받으면 부른다 — 맨 위 요약·주의 카드가 같은 응답을 쓴다(따로 부르지 않게)
 */
export default function BmStorHistoryPanel({ groups = [], servers = [], request = null, onSeven = null }) {
  const init = useMemo(loadOpts, []);
  const [period, setPeriod] = useState('7d');
  const [mode, setModeRaw] = useState(init.mode);
  const [unit, setUnitRaw] = useState(init.unit);
  const [scale, setScaleRaw] = useState(init.scale);
  const [focus, setFocus] = useState(null);
  const [gfilter, setGfilter] = useState(null); // 전체 서버 보기의 그룹 필터(그룹 이름) | null
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const box = useRef(null);
  const onSevenRef = useRef(onSeven);
  onSevenRef.current = onSeven;

  const persist = (patch) => saveOpts({ mode, unit, scale, ...patch });
  const setMode = (m) => { setModeRaw(m); setFocus(null); persist({ mode: m }); };
  const setUnit = (u) => { setUnitRaw(u); persist({ unit: u }); };
  const setScale = (s) => { setScaleRaw(s); persist({ scale: s }); };

  useEffect(() => {
    const my = ++seq.current;              // 늦게 온 이전 응답은 버린다(기간을 빠르게 바꿀 때)
    setLoading(true);
    fetchJson(`/tools/bm-storage/history?period=${encodeURIComponent(period)}`)
      .then((d) => {
        if (my !== seq.current) return;
        setData(d); setErr(null);
        if (period === '7d' && onSevenRef.current) onSevenRef.current(d);
      })
      .catch((e) => { if (my === seq.current) setErr(e || new Error('조회 실패')); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [period]);

  // 바깥(주의 카드·그룹 카드)에서 보기·강조를 요청 — 추이 카드로 스크롤한다.
  useEffect(() => {
    if (!request) return;
    setModeRaw(request.mode); setFocus(request.key ?? null); setGfilter(null);
    try { box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* 구형 브라우저 */ }
  }, [request?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const periods = data?.periods?.length ? data.periods : FALLBACK_PERIODS;
  const per = periods.find((p) => p.key === period) || periods[1];
  const iv = data?.status?.intervalHours || 12;
  const all = useMemo(() => (Array.isArray(data?.series) ? data.series : []), [data]);
  const colors = useMemo(() => groupColors([...(groups || []).map((g) => g.name), ...all.filter((s) => s.kind === 'group').map((s) => s.name)]), [groups, all]);
  const groupsOfServer = useMemo(() => {
    const m = new Map();
    for (const s of servers || []) m.set(String(s.id), (s.groups || []).length ? s.groups : [NO_GROUP]);
    return m;
  }, [servers]);
  const serverCountOf = useMemo(() => new Map((groups || []).map((g) => [g.name, g.servers])), [groups]);
  const srvText = (nm) => { const c = serverCountOf.get(nm); return c == null ? '서버 수 —' : `서버 ${c}대`; };
  const colorOf = (s) => {
    if (s.kind === 'group') return colors.get(s.name) || USED;
    const g = groupsOfServer.get(String(s.key))?.[0];
    return g ? (colors.get(g) || USED) : 'var(--text-faint)';
  };

  const byKind = (k) => all.filter((s) => s.kind === k);
  const totalList = byKind('total');
  const groupList = byKind('group');
  const serverAll = byKind('server');
  const serverList = gfilter == null ? serverAll : serverAll.filter((s) => (groupsOfServer.get(String(s.key)) || []).includes(gfilter));
  const list = mode === 'total' ? totalList : mode === 'group' ? groupList : serverList;
  const head = headline(mode, { periodLabel: per.label, series: list, scopeLabel: mode === 'server' ? gfilter : null }, focus);
  const partialCount = list.reduce((a, s) => a + summaryOf(s).partial, 0);
  const empty = data ? emptyNote({ available: data.available, dbError: data.dbError, status: data.status, seriesCount: list.length, mode }) : '';

  // 오른쪽 목록 — 보기마다 정렬이 다르다. 그룹은 **사용량 많은 순**(사용자 선택).
  const rows = (() => {
    if (mode === 'total') {
      return contributions(groupList, totalList[0] ? changeOf(totalList[0]) : null).map((c) => ({
        key: c.key, name: c.name, color: colors.get(c.name) || USED, pct: c.pct, change: c.change,
        sub: `${c.share != null ? `증가분의 ${c.share}%` : '증가분 —'} · ${srvText(c.name)}`,
      }));
    }
    if (mode === 'group') {
      const withLast = groupList.map((s) => { const l = lastOf(s); return { s, l, name: s.name, usedBytes: l?.usedBytes ?? null, usedPct: l?.pct ?? null }; });
      return sortGroupsByUsed(withLast).map(({ s, l }) => ({
        key: String(s.key), name: s.name, color: colorOf(s), pct: l?.pct ?? null, change: changeOf(s),
        sub: `${srvText(s.name)} · ${l ? `${bytesText(l.usedBytes)} / ${bytesText(l.totalBytes)}` : '온전한 기록 없음'}`,
      }));
    }
    return serverList.map((s) => ({ s, l: lastOf(s), ch: changeOf(s) }))
      .sort((a, b) => ((b.ch ?? -Infinity) - (a.ch ?? -Infinity)) || String(a.s.name).localeCompare(String(b.s.name), 'ko', { numeric: true }))
      .map(({ s, l, ch }) => ({
        key: String(s.key), name: s.name, color: colorOf(s), pct: l?.pct ?? null, change: ch, deleted: s.deleted,
        sub: `${(groupsOfServer.get(String(s.key)) || ['—']).join(', ')} · ${l ? `${bytesText(l.usedBytes)} / ${bytesText(l.totalBytes)}` : '온전한 기록 없음'}`,
      }));
  })();
  const onRow = (r) => {
    if (mode === 'total') { setModeRaw('group'); persist({ mode: 'group' }); setFocus(r.key); return; }
    setFocus((f) => (String(f) === String(r.key) ? null : r.key));
  };
  const pctColorOf = (p) => (p == null ? 'var(--text-dim)' : p >= 90 ? 'var(--red)' : p >= WARN_PCT ? 'var(--amber)' : 'var(--text)');
  const listTitle = mode === 'total' ? '그룹별 기여' : mode === 'group' ? '그룹' : '서버';
  const listSort = mode === 'total' ? '기간 증가량 순' : mode === 'group' ? '사용량 많은 순' : '증가량 많은 순';

  return (
    <div ref={box} className="card bm2-card" style={{ marginBottom: 14, minWidth: 0, scrollMarginTop: 80 }}>
      <div className="flex between wrap" style={{ gap: 14, alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ minWidth: 0, flex: '1 1 380px' }}>
          <div className="bm2-label">▸ 디스크 사용량 추이{loading && <span style={{ marginLeft: 8, letterSpacing: 0 }}>· 불러오는 중…</span>}</div>
          <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4, marginTop: 6 }}><BoldText text={data ? head.main : '—'} /></div>
          {data && <div className="muted" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}><BoldText text={head.sub} /></div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <Seg items={MODES} value={mode} onChange={setMode} color={MINT} />
          <span className="flex wrap" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <Seg items={periods} value={period} onChange={setPeriod} color={BLUE} disabled={loading} />
            {mode === 'total'
              ? <Seg items={[{ key: 'zoom', label: '확대' }, { key: 'capacity', label: '0~총 용량' }]} value={scale} onChange={setScale} color={BLUE} />
              : <Seg items={[{ key: 'pct', label: '%' }, { key: 'tb', label: 'TB' }]} value={unit} onChange={setUnit} color={BLUE} />}
          </span>
        </div>
      </div>

      {mode === 'server' && serverAll.length > 0 && (
        <div className="flex wrap" style={{ gap: 6, marginBottom: 10 }}>
          <button type="button" className={`bm2-chip${gfilter == null ? ' on' : ''}`} onClick={() => { setGfilter(null); setFocus(null); }}>전체 {serverAll.length}</button>
          {sortGroupsByUsed(groups).map((g) => {
            const cnt = serverAll.filter((s) => (groupsOfServer.get(String(s.key)) || []).includes(g.name)).length;
            if (!cnt) return null;
            return (
              <button key={g.name} type="button" className={`bm2-chip${gfilter === g.name ? ' on' : ''}`} onClick={() => { setGfilter(gfilter === g.name ? null : g.name); setFocus(null); }}>
                <Swatch color={colors.get(g.name) || USED} /> {g.name} {cnt}
              </button>
            );
          })}
        </div>
      )}

      {err && !data && <ErrorBox error={errorBoxInput(err)} />}
      {err && data && <div className="muted" style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 6 }}>⚠ 조회 오류: {String(err?.message || err)}</div>}
      {empty && <p className="muted" style={{ fontSize: 12.5, margin: '8px 0' }}><BoldText text={empty} /></p>}

      {data && list.length > 0 && (
        <div className="flex wrap" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div style={{ flex: '3 1 560px', minWidth: 0 }}>
            <Chart mode={mode} list={list} colorOf={colorOf} focus={focus} unit={unit} scale={scale} from={data.from} to={data.to}
              days={per.days} intervalHours={iv} firstAt={data.span?.first ?? null} />
          </div>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div className="flex between" style={{ alignItems: 'baseline', marginBottom: 6 }}>
              <b style={{ fontSize: 13 }}>{listTitle} <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>· {listSort}</span></b>
              <span className="muted" style={{ fontSize: 11 }}>사용률 · {per.label} 변화</span>
            </div>
            <div className="bm2-list" style={mode === 'server' ? { maxHeight: 296, overflowY: 'auto' } : undefined}>
              {rows.map((r) => {
                const on = focus != null && String(focus) === String(r.key) && mode !== 'total';
                return (
                  <button key={r.key} type="button" className={`bm2-row${on ? ' on' : ''}`} onClick={() => onRow(r)}
                    title={mode === 'total' ? '그룹별 합산 보기에서 이 그룹을 강조합니다' : '누르면 이 선을 강조합니다(다시 누르면 해제)'}>
                    <Swatch color={r.color} />
                    <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
                      <span style={{ display: 'block', fontWeight: 600, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name}{r.deleted && <span className="badge gray" style={{ marginLeft: 6, fontSize: 10 }}>삭제된 서버</span>}
                      </span>
                      <span className="muted" style={{ display: 'block', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</span>
                    </span>
                    <span style={{ textAlign: 'right', flex: 'none', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      <span style={{ display: 'block', fontWeight: 700, color: pctColorOf(r.pct) }}>{pctText(r.pct)}</span>
                      <span style={{ display: 'block', fontSize: 11, color: r.change > 0 ? 'var(--amber)' : 'var(--text-dim)' }}>{r.change == null ? '—' : changeText(r.change)}</span>
                    </span>
                  </button>
                );
              })}
              {!rows.length && <div className="muted" style={{ fontSize: 12, padding: 8 }}>{mode === 'total' ? '그룹 기록이 없습니다 — 서버에 그룹을 지정하면 다음 기록부터 쌓입니다.' : '표시할 항목이 없습니다.'}</div>}
            </div>
            {focus != null && mode !== 'total' && <button type="button" className="tab" style={{ marginTop: 8, padding: '4px 10px', fontSize: 12 }} onClick={() => setFocus(null)}>강조 해제</button>}
          </div>
        </div>
      )}

      {data && (
        <div className="bm2-foot">
          {iv}시간마다 한 번 기록합니다(한국 시각 0시·12시 슬롯).
          {data.span?.first && !spanNote(data.span, data.from, data.status?.retentionDays) ? ` 가장 오래된 기록은 ${new Date(data.span.first).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}입니다.` : ''}
          {` 보존 기간 ${data.status?.retentionDays ? `${data.status.retentionDays}일` : '전부 보관'}.`}
          {' 서버가 여러 그룹에 속하면 각 그룹에 모두 더해지므로 그룹 합이 전체보다 클 수 있습니다.'}
          {mode !== 'total' && unit === 'pct' && ' 주황 점선은 75% 주의선입니다.'}
          {partialCount > 0 && <> <span style={{ color: PART }}><BoldText text={partialNote(partialCount)} /></span></>}
          {spanNote(data.span, data.from, data.status?.retentionDays) && <> <BoldText text={spanNote(data.span, data.from, data.status?.retentionDays)} /></>}
        </div>
      )}
    </div>
  );
}

