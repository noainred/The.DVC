// v2.669 SAN 스위치 화면(시안 'SAN Switch v2') — 포트 용량 카드 · 스토리지 트래픽 카드 · 법인 카드 격자.
// 판정·문구는 sanSwitchViewText.js(순수 — 테스트가 고정)가 소유하고, 여기는 그리기만 한다.
import React, { useRef, useState } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from 'recharts';
import { usePolling } from '../../api.js';
import { capacityLevel, usedPctText, aggregate, switchesMeta, alertsMeta } from './sanSwitchPorts.js';
import { trafficSummary, trafficChartRows, dcShare, collectBadgeText, bpsText, toGbps, TRAFFIC_RANGES } from './sanSwitchViewText.js';
import { numOrNull } from '../../numOrNull.js';
import { trackFetch, echoMatches, freshState, freshNote, badgeFor } from './sanFreshText.js'; // 검토 I-04: 갱신 실패를 숨기지 않는다
import { FreshNote } from './SanFreshNote.jsx';

const LVL_COLOR = { bad: 'var(--red)', warn: 'var(--amber)', ok: 'var(--green)', unknown: 'var(--text-dim)' };
const levelColor = (pct) => LVL_COLOR[capacityLevel(pct)] || 'var(--text-dim)';

/** 포트 용량 — aggregate(shown) 값을 그대로 쓴다(서버 판정 규칙 불변). */
export function CapacityCard({ agg, scopeLabel }) {
  const lic = agg.licensed || 0;
  const w = (n) => (lic > 0 ? `${Math.max(0, Math.min(100, (n / lic) * 100))}%` : '0%');
  const usedW = w(agg.online); const disW = w(Math.min(agg.disabled, Math.max(0, lic - agg.online)));
  const side = [
    { lab: '스위치', val: agg.switches, meta: switchesMeta(agg), color: agg.failed ? 'var(--red)' : undefined },
    { lab: '물리 포트', val: agg.total.toLocaleString(), meta: `라이선스 ${lic.toLocaleString()}` },
    { lab: '여유 포트', val: agg.free.toLocaleString(), meta: '라이선스 − 사용 중(증설 가능분)',
      color: capacityLevel(agg.usedPct) === 'bad' ? 'var(--red)' : capacityLevel(agg.usedPct) === 'warn' ? 'var(--amber)' : undefined },
    { lab: '장애 · 비활성', val: `${agg.faulty} / ${agg.disabled}`, meta: alertsMeta(agg), color: agg.faulty ? 'var(--red)' : undefined },
  ];
  return (
    <div className="san2-card san2-cap">
      <div className="san2-cap-main">
        <div className="flex wrap" style={{ justifyContent: 'space-between', gap: 8 }}>
          <div className="san2-title">포트 사용률 · {scopeLabel}</div>
          <span className="muted" style={{ fontSize: 12 }}>사용 중 / 라이선스 포트 · 라이선스 없는 포트는 분모에서 뺍니다</span>
        </div>
        <div className="flex wrap" style={{ alignItems: 'baseline', gap: 12, marginTop: 10 }}>
          <span className="san2-big" style={{ color: levelColor(agg.usedPct) }}>{usedPctText(agg.usedPct)}</span>
          <span style={{ fontSize: 15 }}><b>{agg.online.toLocaleString()}</b><span className="muted"> / {lic.toLocaleString()} 포트</span></span>
        </div>
        <div className="san2-bar" role="img" aria-label={`사용 중 ${agg.online} · 비활성 ${agg.disabled} · 라이선스 ${lic}`}>
          <span style={{ width: usedW, background: 'linear-gradient(90deg, var(--accent), var(--accent-2))' }} />
          <span style={{ width: disW, background: 'var(--amber)' }} />
        </div>
        <div className="san2-legend">
          <span><i style={{ background: 'var(--accent)' }} />사용 중 {agg.online.toLocaleString()}</span>
          <span><i style={{ background: 'var(--amber)' }} />비활성 {agg.disabled.toLocaleString()}</span>
          <span><i style={{ background: 'var(--panel-deep)', border: '1px solid var(--border)' }} />여유 {agg.free.toLocaleString()}</span>
          {agg.failed ? <span style={{ color: 'var(--red)' }}>수집 실패 {agg.failed}대는 합계에서 뺐습니다</span> : null}
        </div>
      </div>
      <div className="san2-cap-side">
        {side.map((s) => (
          <div key={s.lab}>
            <div className="lab">{s.lab}</div>
            <div className="val" style={s.color ? { color: s.color } : undefined}>{s.val}</div>
            <div className="meta">{s.meta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const TRAFFIC_POLL_MS = 60_000;      // 수집은 수 분 주기라 1분 폴링으로 충분하다
const TRAFFIC_TIMEOUT_MS = 90_000;   // v2.715: 서버 감시 60초보다 길게 기다린다
// 실패 중 배지 — 실시간(●·민트) 표시를 쓰지 않는다(검토 I-04).
const STALE_BADGE = { background: 'rgba(245,158,11,.12)', color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 9px', borderRadius: 999, whiteSpace: 'nowrap', letterSpacing: 0 };

const tick = (hours) => (ts) => {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hours > 24 ? `${d.getMonth() + 1}/${d.getDate()}` : hm;
};

/**
 * 스토리지 트래픽 카드 — 60초 폴링(수집은 수 분 주기라 충분하다). 선택 법인을 datacenterId 로 넘긴다.
 * null 버킷은 선을 끊는다(connectNulls=false) — 부분 합을 그리지 않는다는 서버 규칙을 화면도 지킨다.
 */
export function TrafficCard({ datacenterIds = [], selected = 0, isAdmin = false }) {
  const [hours, setHours] = useState(24);
  const params = { hours };
  if (datacenterIds.length) params.datacenterId = datacenterIds.join(',');
  // v2.715: 이 조회는 오래 걸릴 수 있다(서버 감시 60초 — 넘기면 조회 엔진을 재시작하고 사유를 돌려준다). 화면은 그보다 길게 기다리고
  //   재시도하지 않는다(재시도하면 같은 무거운 조회를 다시 줄 세운다).
  const { data: polled, error, errorInfo } = usePolling('/tools/sanswitch/perf/traffic-total', params, TRAFFIC_POLL_MS, { timeoutMs: TRAFFIC_TIMEOUT_MS, retries: 0 });
  // 검토 I-04: 직전 값은 남기되(차트를 지우지 않는다) 실패는 이 카드 안에 말한다 — 마지막 성공·실패 시작 시각을 구분한다.
  //   추적기는 전이 때만 시각을 바꾸는 순수 함수라 렌더마다 불러도 같다(StrictMode 이중 렌더 안전). 선택(법인·기간)이 바뀐 직후
  //   usePolling 이 아직 비우지 않은 이전 조건의 data 는 carried 로 걸러지고, 응답이 되돌려 준 조건(hours·datacenterIds)과도 대조한다.
  const reqKey = JSON.stringify(params);
  const trRef = useRef(null);
  trRef.current = trackFetch(trRef.current, { data: polled, error, key: reqKey }, Date.now());
  const fs = freshState(trRef.current, { matches: echoMatches(polled, { hours, datacenterIds: datacenterIds.length ? datacenterIds : [] }) });
  const data = fs.usable ? polled : null;
  const note = freshNote(fs, { what: '트래픽 합계', pollMs: TRAFFIC_POLL_MS, timeoutMs: TRAFFIC_TIMEOUT_MS, stopped: !!errorInfo });
  const s = trafficSummary(data, { selected });
  const rows = trafficChartRows(data);
  const avgG = toGbps(data?.avg);
  const share = dcShare(data, 5);
  const badge = badgeFor(fs, data ? collectBadgeText(data) : '');
  const hasLine = rows.some((r) => r.gbps != null);
  return (
    <div className="san2-card san2-traffic">
      <div className="flex wrap" style={{ alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
        <div className="san2-title">
          스토리지 트래픽 · {selected ? '선택 법인' : '전체'}
          {badge.text && badge.live ? <span className="san2-badge-live">● {badge.text}</span> : null}
          {badge.text && !badge.live ? <span style={STALE_BADGE} title="지금 조회가 실패하고 있습니다 — 아래 값은 마지막 성공 시점의 것입니다">{badge.text}</span> : null}
        </div>
        <div className="san2-seg" role="group" aria-label="조회 기간">
          {TRAFFIC_RANGES.map(([h, l]) => (
            <button key={h} type="button" className={hours === h ? 'on' : ''} aria-pressed={hours === h} onClick={() => setHours(h)}>{l}</button>
          ))}
        </div>
      </div>
      <FreshNote note={note} />
      {fs.state === 'loading' ? (
        <div className="san2-loading-alert" role="status">
          SAN 스위치 사용량을 불러오는 중입니다 — <b>최소 1분 이상</b> 기다려야 할 수 있습니다.
          <span className="san2-loading-sub">1분을 넘기면 서버가 조회 엔진을 스스로 재시작하고 이 자리에 사유를 알려 드립니다. 그동안 다른 화면은 계속 쓸 수 있습니다.</span>
        </div>
      ) : null}
      {data && (s.state === 'off' || s.state === 'unavailable') ? (
        <div style={{ fontSize: 14 }}>
          {s.sub}
          {s.state === 'off' && isAdmin ? <> <a href="#/settings/sansw-perf" style={{ color: 'var(--mint)' }}>설정 열기 →</a></> : null}
        </div>
      ) : null}
      {data && (s.state === 'ok' || s.state === 'empty') ? (
        <>
          <div>
            <div className="san2-msg">{s.lead}<b>{s.now}</b>{s.tail}</div>
            {s.sub ? <div className="san2-sub">{s.sub}</div> : null}
            {s.notes.map((n) => <div key={n} className="san2-sub" style={{ color: 'var(--amber)', fontSize: 12.5 }}>⚠ {n}</div>)}
          </div>
          <div className="san2-tbody">
            <div className="san2-chart">
              {hasLine ? (
                <div style={{ height: 180 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="var(--border-soft)" vertical={false} />
                      <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} tickFormatter={tick(hours)} tick={{ fill: 'var(--text-dim)', fontSize: 11 }} stroke="var(--border)" />
                      <YAxis tickCount={4} width={40} tick={{ fill: 'var(--text-dim)', fontSize: 11 }} stroke="var(--border)"
                        tickFormatter={(v) => Number(v).toFixed(v >= 10 ? 0 : 1)} />
                      <Tooltip contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--border)', fontSize: 12 }}
                        labelFormatter={(ts) => new Date(ts).toLocaleString()} formatter={(v) => [v == null ? '—' : `${Number(v).toFixed(2)} Gbps`, '합계']} />
                      {avgG != null ? <ReferenceLine y={avgG} stroke="var(--text-dim)" strokeDasharray="4 4" /> : null}
                      <Area type="monotone" dataKey="gbps" stroke="var(--mint)" strokeWidth={1.6} fill="var(--mint)" fillOpacity={0.12} connectNulls={false} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : <div className="muted" style={{ height: 120, display: 'grid', placeItems: 'center', fontSize: 13 }}>그릴 값이 없습니다</div>}
              <div className="san2-legend" style={{ marginTop: 6 }}>
                <span><i style={{ background: 'var(--mint)' }} />전체 합계(수신+송신)</span>
                <span>┄ 기간 평균 {bpsText(data.avg)}</span>
                <span>세로축 단위 Gbps</span>
              </div>
            </div>
            <div className="san2-tside">
              <div className="san2-sum3">
                <div><div className="lab">지금</div><div className="val" style={{ color: 'var(--mint)' }}>{bpsText(data.now?.bps)}</div></div>
                <div><div className="lab">평균</div><div className="val">{bpsText(data.avg)}</div></div>
                <div><div className="lab">최고</div><div className="val">{bpsText(data.peak?.bps)}</div>
                  <div className="meta">{data.peak ? tick(hours)(data.peak.ts) : ''}</div></div>
              </div>
              <div>
                <div className="san2-title" style={{ fontSize: 11, marginBottom: 8 }}>법인별 비중 · 지금</div>
                {share.rows.length ? (
                  <div className="san2-share">
                    {share.rows.map((r) => (
                      <React.Fragment key={r.datacenterId}>
                        <span className="code" title={r.name}>{r.name}</span>
                        <span className="track"><span style={{ width: `${r.pct ?? 0}%` }} /></span>
                        <span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, whiteSpace: 'nowrap' }}>{bpsText(r.bps)}{r.pct != null ? ` · ${r.pct}%` : ''}</span>
                      </React.Fragment>
                    ))}
                  </div>
                ) : <div className="muted" style={{ fontSize: 12 }}>—</div>}
                {share.omitted ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>그 밖 {share.omitted}개 법인</div> : null}
              </div>
            </div>
          </div>
          <div className="san2-foot">
            스위치가 portperfshow 로 보고한 포트 바이트/초를 bps 로 환산해, 팹 A/B 스위치를 합쳐 스토리지 어레이가 물린 포트만 더한 값입니다.
            서버 HBA 포트는 같은 트래픽의 반대편이라 더하지 않습니다. 스위치마다 캡처 시각이 어긋난 칸은 직전 표본을 수집 주기의 2배 안에서만 이어 쓰고,
            그보다 오래 빠진 구간은 부분 합을 그리지 않습니다.
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * 법인 카드 격자(기존 칩 대체) — 다중 선택. 카드는 **등록 전체**에서 파생한다(검색으로 법인이 걸러져도
 * 선택을 해제할 수 있게 — v2.416). 수치는 검색 결과 기준(예전 칩과 같다).
 */
export function DcGrid({ chips, searched, dcName, dcSel, setDcSel, onAnalyze }) {
  const toggle = (dc) => setDcSel((p) => { const n = new Set(p); n.has(dc) ? n.delete(dc) : n.add(dc); return n; });
  return (
    <>
      <div className="san2-dchead">
        <div className="san2-title">법인별 포트 사용률 · 눌러서 거르기(여러 개 선택)</div>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {dcSel.size ? <button type="button" className="san2-link plain" onClick={() => setDcSel(new Set())}>선택 해제</button> : null}
          <button type="button" className="san2-link" onClick={onAnalyze}
            title="어레이는 팹 A/B 두 스위치에 나눠 물리므로 법인의 모든 스위치를 합산해야 실제 사용량이 나옵니다. 법인을 2곳 이상 고르면 법인별로 나눠 보여줍니다.">
            스토리지 사용량 분석 — {dcSel.size ? [...dcSel].join(', ') : '전체'} →
          </button>
        </span>
      </div>
      <div className="san2-dcgrid">
        {chips.map((dc) => {
          const on = dcSel.has(dc);
          const list = searched.filter((r) => dcName(r.datacenterId) === dc);
          const a = aggregate(list);
          const pct = numOrNull(a.usedPct);
          return (
            <button key={dc} type="button" className={`san2-dc${on ? ' on' : ''}${a.failed ? ' down' : ''}`} aria-pressed={on} onClick={() => toggle(dc)}
              title={`${dc} — 스위치 ${a.switches}대 · 포트 ${a.online}/${a.licensed} (${usedPctText(a.usedPct)}) · 여유 ${a.free}${a.failed ? ` · 수집 실패 ${a.failed}대` : ''}`}>
              <div className="top"><span>{dc}</span><span>{list.length}대</span></div>
              <div className="mini"><span style={{ width: `${pct == null ? 0 : Math.min(100, pct)}%`, background: levelColor(pct) }} /></div>
              <div className="bot"><span style={{ color: levelColor(pct) }}>{usedPctText(a.usedPct)}</span><span>여유 {a.free}</span></div>
            </button>
          );
        })}
      </div>
    </>
  );
}
