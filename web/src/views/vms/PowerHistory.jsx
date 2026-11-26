// views/vms/PowerHistory.jsx — VM 전원 이력 화면(v3.39.0 · 시안 docs/design/vm-power-calendar A안 · ⑤).
//   ① PowerCard   : VM 드로어 '한눈에' 아래 카드 — 지금 상태 · 처음/마지막 Power On · 마지막 Power Off · 켜짐 비율 · 월별 띠. 누르면 ②.
//   ② PowerDetail : 드로어 본문이 바뀌는 상세(← VM 상세로 돌아감) — 날짜 · 월별 띠 · 전원 전환 목록 · '전원 달력 열기'.
//   ③ PowerCalendarTab : 개체 보기 '전원 이력' 탭(A안) — 요약 타일 · 12개월 달력(칸 가로 = 0시→24시) · 선택한 날 · 전환 기록 표.
//   데이터는 GET /vms/:id/power-history 를 **열 때 1회**(useOnce — 늦게 온 이전 VM 응답은 버린다 · 15초 폴링 없음).
//   판정은 서버(vmpower/spans.js) 하나 — 여기는 받은 조각을 날짜로 자르고 글로 바꾼다(powerHistText.js).
import React, { useMemo, useState } from 'react';
import { ErrorBox, Loading } from '../../components/primitives.jsx';
import { STable } from '../../components/STable.jsx';
import { useOnce } from '../vcd/useOnce.js';
import { vcHash } from '../vcd/vcdRoute.js';
import {
  STATE_LABEL, durText, durRangeText, stampText, dayKey, whenText, srcText, clipSegs, sumsOf, onRatio, pctText, dayBarStyle, ratioBarStyle,
  monthsBack, monthCells, sumsText, factText, currentText, selectedDayKey, windowOf, lastOffSub, lastOnSub,
} from './powerHistText.js';
import './powerHist.css';

const DOT = { on: 'var(--pwh-on)', off: 'var(--pwh-off)' };

/** 전원 이력 조회(열 때 1회). offset = 몇 개월 앞 창(0 = 최근 12개월). */
export function usePowerHistory(vmId, enabled = true, offset = 0) {
  // 기준 시각은 창(offset)을 바꿀 때마다 새로 — 탭을 연 채 달이 바뀌어도 요청 범위와 달력이 한 달 어긋나지 않게(재검토 #13).
  //   달력은 응답 시각(d.now)이 아니라 이 기준으로 그린다(요청한 범위와 같은 달들).
  const base = useMemo(() => Date.now(), [offset, vmId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const range = useMemo(() => {
    const ms = monthsBack(base, 12, offset);
    return offset > 0 ? { from: ms[0].start, to: ms[ms.length - 1].end } : { from: ms[0].start };
  }, [base, offset]);
  const q = useOnce(vmId ? `/vms/${encodeURIComponent(vmId)}/power-history` : null, range, enabled && !!vmId);
  return { ...q, base };
}

/** 현재 상태 점 색 — 관측이 끊겼으면(지금 상태 모름) 흐린 색. */
const dotOf = (f) => (f?.current?.stale ? 'var(--text-faint)' : DOT[f?.current?.state] || 'var(--text-faint)');

/** 응답이 밝히는 제한 — 계정 가림 · 엣지 위임 · 이름 중복 · 전환 잘림 · 데모. */
function limitNotes(d) {
  const out = [];
  if (d.userMasked) out.push('수행 계정 이름은 관리자에게만 보입니다.');
  if (d.eventsNote === 'site') out.push('이 vCenter 는 법인 엣지가 수집해 이벤트 로그가 중앙에 없습니다 — 전환 시각을 이벤트로 좁히지 못했습니다(관측 창으로만 압니다).');
  if (d.eventsNote === 'duplicate-name') out.push('같은 vCenter 에 같은 이름 VM 이 있어 vCenter 이벤트로 시각을 좁히지 않았습니다(이벤트는 이름으로만 찾을 수 있습니다).');
  if (d.eventsNote === 'unavailable') out.push('이벤트 로그 DB 를 읽지 못해 전환 시각을 좁히지 못했습니다.');
  if (d.transitionsTruncated) out.push(`이 기간 전환 ${d.transitionsInRange}건 중 최근 ${(d.transitions || []).length}건만 실었습니다.`);
  if (d.demo) out.push('데모 데이터입니다.');
  return out;
}

export function PowerLegend({ withNone = false }) {
  return (
    <div className="pwh-legend" aria-label="범례">
      <span><i className="pwh-sw on" />켜짐</span>
      <span><i className="pwh-sw off" />꺼짐</span>
      <span><i className="pwh-sw est" />경계 불확실</span>
      <span><i className="pwh-sw unk" />기록 없음</span>
      {withNone && <span><i className="pwh-sw none" />기록 전</span>}
    </div>
  );
}

function MonthStrip({ data, tall = false }) {
  const months = monthsBack(data.now, 12);
  const all = sumsOf(data.segments);
  return (
    <span className={`pwh-mstrip${tall ? ' tall' : ''}`} role="img" aria-label={`최근 12개월 월별 켜짐 비율 — 전체 ${pctText(onRatio(all))}`}>
      {months.map((m) => {
        const s = sumsOf(clipSegs(data.segments, m.start, m.end));
        const st = ratioBarStyle(s);
        return <span key={m.start} title={`${m.title} — ${sumsText(s)}`}><i className={st ? undefined : 'none'} style={st || undefined} /><em>{m.m}월</em></span>;
      })}
    </span>
  );
}

function stateNote(q) {
  if (q.error && !q.data) return { error: q.error };
  if (!q.data) return { loading: true };
  if (q.data.available === false) return { text: q.data.reason || '전원 기록을 쓸 수 없습니다.' };
  return null;
}


/** ① 드로어 카드 */
export function PowerCard({ q, onOpen }) {
  const n = stateNote(q);
  if (n?.loading) return <div className="pwh"><Loading label="전원 기록" /></div>;
  if (n?.error) return <div className="pwh"><ErrorBox error={n.error} /></div>;
  if (n?.text) return <div className="pwh muted" style={{ fontSize: 12 }}>{n.text}</div>;
  const d = q.data;
  const f = d.facts || {};
  const cur = currentText(f, d.now);
  const first = factText(f.firstOn, d.precision);
  const lastOn = factText(f.lastOn, d.precision);
  const lastOff = f.lastOff ? factText(f.lastOff, d.precision) : { main: '기록 없음' };
  return (
    <div className="pwh">
      <button type="button" className="pwh-card" onClick={onOpen} aria-label={`전원 상태 — ${cur.head} · 자세히 보기`}>
        <span className="pwh-now">
          <span className="pwh-dot" style={{ width: 11, height: 11, background: dotOf(f) }} aria-hidden="true" />
          <b>{cur.head}</b>
          <span className="muted" style={{ fontSize: 12 }}>{cur.since}</span>
          <span className="go">자세히 ›</span>
        </span>
        <span className="pwh-kv4">
          <span><i>처음 Power On</i><b>{first.main}</b><small>{f.firstOn ? first.sub : '기록된 기간에 켜진 적 없음'}</small></span>
          <span><i>마지막 Power On</i><b>{lastOn.main}</b><small>{lastOnSub(f, lastOn, d.now)}</small></span>
          <span><i>마지막 Power Off</i><b>{lastOff.main}</b><small>{lastOffSub(f, d.now)}</small></span>
          <span><i>최근 12개월 켜짐 비율</i><b>{pctText(onRatio(d.sums))}</b><small>{`꺼짐 ${f.offCount ?? 0}번${f.recordStart ? ` · 기록 시작 ${stampText(f.recordStart).slice(0, 10)}` : ''}`}</small></span>
        </span>
        <MonthStrip data={d} />
      </button>
    </div>
  );
}

/** 이 기간에서 가장 길게 꺼짐 — 범위에 잘린 구간은 '범위 안 길이 이상'. */
function longestText(L) {
  if (!L) return '—';
  if (L.clipped || (L.fromStart && L.maxMs == null)) return `${durText(L.ms)} 이상`;
  return durRangeText(L.ms, L.maxMs);
}
function longestSub(L, empty) {
  if (!L) return empty;
  return `${stampText(L.a).slice(0, 10)} ~ ${L.open ? '지금' : stampText(L.b).slice(0, 10)}${L.clipped ? ' · 기간 경계에서 잘림' : ''}`;
}

/** 전환 한 줄의 글 */
function transitionRow(t, precision) {
  const by = t.exact ? `vCenter 이벤트${t.user ? ` · ${t.user}` : ''}` : srcText(t.src, precision, windowOf(t));
  const hole = t.prevHoleMs > 0 ? `(목록에 없던 ${durText(t.prevHoleMs)} 포함)` : '';
  const prev = `${STATE_LABEL[t.prevState]} ${t.prevFromStart ? `${durText(t.prevMs)} 이상` : durRangeText(t.prevMs, t.prevMaxMs)}${hole}`;
  return { when: whenText(t), to: STATE_LABEL[t.to], by: t.unknownWindow ? `${by} · 그 사이 기록 없음` : by, prev };
}

/** ② 드로어 상세 */
export function PowerDetail({ vm, q, onBack, onClose }) {
  const n = stateNote(q);
  const d = q.data;
  const f = d?.facts || {};
  const [more, setMore] = useState(false);
  const head = (
    <div className="pwh-sub">
      <button type="button" className="tab" style={{ flex: 'none', padding: '6px 12px' }} onClick={onBack}>← VM 상세</button>
      <b style={{ fontSize: 13 }}>전원 상태</b>
      <span style={{ flex: 1 }} />
      <a className="tab" style={{ flex: 'none', padding: '6px 12px' }} href={vcHash(vm.vcenterId, { type: 'vm', id: vm.id, tab: 'power' })} onClick={onClose}>전원 달력 열기 →</a>
    </div>
  );
  if (n) return <div className="pwh" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{head}{n.loading ? <Loading label="전원 기록" /> : n.error ? <ErrorBox error={n.error} /> : <div className="muted" style={{ fontSize: 12 }}>{n.text}</div>}</div>;
  const cur = currentText(f, d.now);
  const s = d.sums || {};
  const first = factText(f.firstOn, d.precision);
  const lastOn = factText(f.lastOn, d.precision);
  const lastOff = f.lastOff ? factText(f.lastOff, d.precision) : null;
  const rows = [
    ['처음 Power On', first.main, f.firstOn ? first.sub : '기록된 기간에 켜진 적 없음'],
    ['마지막 Power On', lastOn.main, lastOn.sub],
    ['마지막 Power Off', lastOff ? lastOff.main : '기록 없음', [lastOffSub(f, d.now), lastOff?.sub].filter(Boolean).join(' · ')],
    ['가장 길게 꺼짐', longestText(f.longestOffInRange), longestSub(f.longestOffInRange, '최근 12개월에 꺼진 구간이 없습니다')],
    ['전원 전환', `${d.transitionsTotal ?? 0}회`, f.recordStart ? `기록 시작 ${stampText(f.recordStart).slice(0, 10)} 부터` : ''],
    ['켜진 시간 합', durText(s.on || 0), `최근 12개월 · 판정된 시간의 ${pctText(onRatio(s))}`],
    ['꺼진 시간 합', durText(s.off || 0), onRatio(s) == null ? '' : `판정된 시간의 ${pctText(1 - onRatio(s))}`],
    ['판정하지 못한 시간', (s.est || 0) + (s.unk || 0) ? durText((s.est || 0) + (s.unk || 0)) : '없음', (s.est || 0) + (s.unk || 0) ? `경계 불확실 ${durText(s.est || 0)} · 기록 없음 ${durText(s.unk || 0)} — 비율에서 뺐습니다` : ''],
    f.backfill ? ['소급한 기간', `${stampText(f.backfill.from).slice(0, 10)} ~ ${f.backfill.to ? stampText(f.backfill.to).slice(0, 10) : '—'}`, `VM 추적 기록에서 채웠습니다 — 시각은 ${durText(d.precision?.backfillMs)} 간격으로만 압니다`] : null,
  ].filter(Boolean);
  const list = d.transitions || [];
  const shown = more ? list.slice(0, 60) : list.slice(0, 8);
  return (
    <div className="pwh" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {head}
      <div className="pwh-banner">
        <span className="pwh-dot" style={{ width: 11, height: 11, background: dotOf(f) }} aria-hidden="true" />
        <b>{cur.head}</b>
        <span className="muted" style={{ fontSize: 12 }}>{cur.since}</span>
      </div>
      <section className="vmh-sec" aria-label="전원 날짜">
        <div className="sh"><h3>날짜</h3></div>
        <div className="pwh-rows">
          {rows.map(([k, v, sub]) => <div key={k}><span>{k}</span><b>{v}{sub ? <small>{sub}</small> : null}</b></div>)}
        </div>
      </section>
      <section className="vmh-sec" aria-label="월별 켜짐 비율">
        <div className="sh"><h3>최근 12개월 · 월별 켜짐 비율</h3></div>
        <div style={{ padding: '12px 14px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <MonthStrip data={d} tall />
          <PowerLegend withNone />
        </div>
      </section>
      <section className="vmh-sec" aria-label="전원 전환">
        <div className="sh"><h3>{`전원 전환 · 최신 ${shown.length}건 / 전체 ${d.transitionsTotal ?? list.length}건`}</h3></div>
        {!list.length ? <div className="muted" style={{ fontSize: 12 }}>기록된 기간에 전원이 바뀐 적이 없습니다.</div> : (
          <div className="pwh-rows pwh-spans pwh-trans">
            {shown.map((t) => {
              const r = transitionRow(t, d.precision);
              return (
                <div key={`${t.ts}-${t.to}`}>
                  <span className="pwh-dot" style={{ background: DOT[t.to] }} aria-hidden="true" />
                  <b>{`${r.to}으로 바뀜 · ${r.when}`}</b>
                  <small>{`직전 ${r.prev} · ${r.by}`}</small>
                </div>
              );
            })}
          </div>
        )}
        {list.length > 8 && <button type="button" className="tab" style={{ alignSelf: 'flex-start', padding: '5px 12px' }} onClick={() => setMore((x) => !x)}>{more ? '접기' : '이전 전환 더 보기'}</button>}
        {limitNotes(d).map((t) => <div key={t} className="muted" style={{ fontSize: 11.5 }}>{t}</div>)}
      </section>
    </div>
  );
}

/** ③ 개체 보기 '전원 이력' 탭(A안) */
export function PowerCalendarTab({ vm }) {
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState(null);
  const q = usePowerHistory(vm?.id, !!vm, offset);
  const d = q.data;
  const months = useMemo(() => (d && d.available !== false ? monthsBack(q.base, 12, offset).map((m) => ({ ...m, ...monthCells(m, d.segments || [], d.now) })) : []), [d, offset, q.base]);
  const n = stateNote(q);
  if (n) return <div className="pwh card" style={{ padding: 14 }}>{n.loading ? <Loading label="전원 기록" /> : n.error ? <ErrorBox error={n.error} /> : <span className="muted">{n.text}</span>}</div>;
  const f = d.facts || {};
  const s = d.sums || {};
  const r = onRatio(s);
  const inRange = (d.transitions || []).filter((t) => t.ts >= d.from && t.ts <= d.to);   // 응답이 이미 범위 안만 싣는다(재검토 #1) — 한 번 더 거른다
  const inRangeTotal = d.transitionsInRange ?? inRange.length;
  const selKey = selectedDayKey(sel, inRange, d);
  const day = months.flatMap((m) => m.days).find((x) => x.key === selKey) || null;
  const dayTrans = (d.transitions || []).filter((t) => dayKey(t.ts) === selKey).slice().reverse();
  const cur = currentText(f, d.now);
  const label = `${stampText(months[0]?.start).slice(0, 7)} ~ ${stampText(months[months.length - 1]?.start).slice(0, 7)}`;
  return (
    <div className="pwh" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="pwh-bar">
        <button type="button" className="tab" style={{ flex: 'none', padding: '6px 12px' }} aria-label="이전 12개월" onClick={() => { setOffset((o) => o + 12); setSel(null); }}>‹</button>
        <b className="tabular">{label}</b>
        <button type="button" className="tab" style={{ flex: 'none', padding: '6px 12px' }} aria-label="다음 12개월" disabled={offset === 0} onClick={() => { setOffset((o) => Math.max(0, o - 12)); setSel(null); }}>›</button>
        <span className="muted" style={{ fontSize: 12 }}>{`${offset ? '' : '최근 12개월 · '}기준 ${stampText(d.now)}`}</span>
        <span style={{ flex: 1 }} />
        <PowerLegend withNone />
      </div>

      <section className="pwh-tiles" aria-label="기간 요약">
        <div className="card pwh-tile"><span className="lb">지금</span><span className="v">{cur.head}</span><span className="s">{cur.since || '—'}</span></div>
        <div className="card pwh-tile"><span className="lb"><i className="pwh-sw on" />켜진 시간</span><span className="v">{durText(s.on || 0)}</span><span className="s">{`판정된 시간의 ${pctText(r)}`}</span></div>
        <div className="card pwh-tile"><span className="lb"><i className="pwh-sw off" />꺼진 시간</span><span className="v">{durText(s.off || 0)}</span><span className="s">{`판정된 시간의 ${r == null ? '—' : pctText(1 - r)}`}</span></div>
        <div className="card pwh-tile"><span className="lb">전원 전환</span><span className="v">{`${inRangeTotal}회`}</span><span className="s">{`꺼짐 ${d.transitionsInRangeBy?.off ?? inRange.filter((t) => t.to === 'off').length} · 켜짐 ${d.transitionsInRangeBy?.on ?? inRange.filter((t) => t.to === 'on').length}`}</span></div>
        <div className="card pwh-tile"><span className="lb">가장 길게 꺼짐</span><span className="v">{longestText(f.longestOffInRange)}</span><span className="s">{longestSub(f.longestOffInRange, '이 기간에 꺼진 구간 없음')}</span></div>
        <div className="card pwh-tile"><span className="lb">판정하지 못한 시간</span><span className="v">{(s.est || 0) + (s.unk || 0) ? durText((s.est || 0) + (s.unk || 0)) : '없음'}</span><span className="s">{`경계 불확실 ${durText(s.est || 0)} · 기록 없음 ${durText(s.unk || 0)} — 비율에서 뺐습니다`}</span></div>
      </section>

      <section className="card" style={{ padding: 0 }} aria-label="전원 달력">
        <div className="vcd-card-h"><b style={{ fontSize: 13.5 }}>전원 달력</b><span className="muted" style={{ fontSize: 11.5 }}>날짜 칸의 가로 = 그 날 0시 → 24시 · 숫자가 밝은 날 = 전원이 바뀐 날 · 누르면 아래에 그 날의 기록</span></div>
        <div className="pwh-months">
          {months.map((m) => {
            const known = onRatio(m.sums);
            const sub = (m.sums.on + m.sums.off + m.sums.est + m.sums.unk) ? `켜짐 ${pctText(known)}${m.sums.off ? ` · 꺼짐 ${durText(m.sums.off)}` : ''}` : '기록 전';
            return (
              <div key={m.start} style={{ minWidth: 0 }}>
                <div className="pwh-mh"><b>{m.title}</b><span title={sumsText(m.sums)}>{sub}</span></div>
                <div className="pwh-wk" aria-hidden="true">{['일', '월', '화', '수', '목', '금', '토'].map((w) => <i key={w}>{w}</i>)}</div>
                <div className="pwh-wk">
                  {Array.from({ length: m.blanks }, (_, i) => <span key={`b${i}`} className="pwh-blank" />)}
                  {m.days.map((x) => (
                    <button key={x.key} type="button" className={`pwh-d${x.changed ? ' chg' : ''}`} disabled={x.future || x.none}
                      aria-pressed={x.key === selKey} aria-label={x.aria} title={x.aria} onClick={() => setSel(x.key)}>
                      <span>{x.n}</span>
                      <span className="bar" style={dayBarStyle(x.parts, x.start, x.end) || undefined} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {f.backfill && <div className="vcd-note muted">{`${stampText(f.backfill.from).slice(0, 10)} ~ ${f.backfill.to ? stampText(f.backfill.to).slice(0, 10) : ''} 은(는) VM 추적 기록에서 소급한 구간입니다 — 시각은 ${durText(d.precision?.backfillMs)} 간격으로만 알아서, 그보다 짧게 꺼졌다 켜진 것은 보이지 않습니다.`}</div>}
      </section>

      <div className="pwh-split">
        <section className="card" style={{ padding: 0, flex: '1 1 340px' }} aria-label="선택한 날">
          <div className="vcd-card-h"><b style={{ fontSize: 13.5 }}>{day ? `${day.key} (${day.wd})` : selKey}</b><span className="muted" style={{ fontSize: 11.5 }}>{day ? sumsText(day.sums) : '이 기간 밖의 날입니다'}</span></div>
          {day && (
            <div style={{ padding: '12px 14px' }}>
              <div className="pwh-dayline" style={dayBarStyle(day.parts, day.start, day.end) || undefined} role="img" aria-label={sumsText(day.sums)} />
              <div className="pwh-axis tabular" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
              <div className="pwh-rows pwh-spans" style={{ marginTop: 10 }}>
                {day.parts.map((p) => (
                  <div key={p.a}>
                    <i className={`pwh-sw ${p.st}`} />
                    <b>{`${stampText(p.a).slice(11)} – ${p.b >= day.end ? '24:00' : stampText(p.b).slice(11)} · ${STATE_LABEL[p.st]}`}</b>
                    <span className="tabular" style={{ fontSize: 11.5 }}>{durText(p.b - p.a)}</span>
                    {p.src === 'backfill' ? <small>VM 추적 소급</small> : null}
                  </div>
                ))}
              </div>
              {dayTrans.length > 0 && (
                <div className="pwh-rows pwh-spans pwh-trans" style={{ marginTop: 10 }}>
                  {dayTrans.map((t) => { const x = transitionRow(t, d.precision); return <div key={`${t.ts}-${t.to}`}><span className="pwh-dot" style={{ background: DOT[t.to] }} /><b>{`${x.to}으로 바뀜 · ${x.when}`}</b><small>{`직전 ${x.prev} · ${x.by}`}</small></div>; })}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 0, flex: '1 1 100%' }} aria-label="전원 전환 기록">
          <div className="vcd-card-h"><b style={{ fontSize: 13.5 }}>전원 전환 기록</b><span className="muted" style={{ fontSize: 11.5 }}>{`이 기간 ${inRangeTotal}건${d.transitionsTruncated ? `(최근 ${inRange.length}건 표시)` : ''} · 제목을 누르면 정렬 · 시각을 누르면 그 날`}</span></div>
          {!inRange.length ? <div className="muted" style={{ padding: '10px 14px', fontSize: 12.5 }}>이 기간에 전원이 바뀐 적이 없습니다.</div> : (
            <STable className="v3-table" minWidth={640} limit={60}>
              <thead><tr><th>시각</th><th>전환</th><th>직전 상태가 이어진 시간</th><th>출처</th></tr></thead>
              <tbody>
                {inRange.map((t) => {
                  const x = transitionRow(t, d.precision);
                  return (
                    <tr key={`${t.ts}-${t.to}`}>
                      <td data-sort={String(t.ts).padStart(15, '0')}><button type="button" className="linklike" style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }} onClick={() => setSel(dayKey(t.ts))}>{x.when}</button></td>
                      <td><span className="pwh-dot" style={{ background: DOT[t.to] }} aria-hidden="true" /> {`${t.prevState === 'on' ? '켜짐' : '꺼짐'} → ${x.to}`}</td>
                      <td data-sort={String(t.prevMs).padStart(15, '0')}>{x.prev}</td>
                      <td className="muted" style={{ overflowWrap: 'anywhere' }}>{x.by}</td>
                    </tr>
                  );
                })}
              </tbody>
            </STable>
          )}
          <div className="vcd-note muted">{`정밀도는 출처마다 다릅니다 — vCenter 이벤트는 그 시각 그대로, 포탈 관측은 ${durText(d.precision?.watchMs)} · 추적 소급은 ${durText(d.precision?.backfillMs)} 간격의 '두 관측 사이' 로만 압니다. 경계 불확실 · 기록 없음은 켜짐 · 꺼짐 합에 넣지 않습니다.`}{limitNotes(d).map((t) => ` ${t}`).join('')}</div>
        </section>
      </div>
    </div>
  );
}
