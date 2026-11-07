import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import './techView.css';
import { stackedBars, fmtMs, fmtAge } from './syncLogic.js';

/**
 * Monitoring › **개요(기술 뷰)**(v2.915 · 시안 ⑦ · Datadog 대시보드 참고) — 모니터 요약 · 출처별 체크 상태 · ALERT/WARN 추이 · 엣지 보고 ·
 * 호스트 맵 · 느린 점검 · 연속 실패 · 인증서 임박 · 상태 전이. 데이터는 `GET /svcmon/overview` 하나(서버 svcmon/dash.js — 상태 판정은
 * status.js · edgeState 그대로). 60초마다 다시 읽고(서버 30초 memo) 늦게 온 이전 응답은 버린다.
 */

const TILES = [
  { k: 'total', label: 'TOTAL TESTS', cls: 'tot' },
  { k: 'ok', label: 'OK', cls: 'ok' },
  { k: 'warn', label: 'WARN', cls: 'warn' },
  { k: 'bad', label: 'ALERT', cls: 'bad' },
  { k: 'nodata', label: 'NO DATA', cls: 'nodata' },
  { k: 'pending', label: 'PENDING', cls: 'pend' },
  { k: 'disabled', label: 'DISABLED', cls: 'off' },
];
const STATE_PILL = { ok: 'OK', warn: 'WARN', bad: 'ALERT', stale: 'STALE', unknown: 'UNKNOWN', pending: 'PENDING', disabled: 'OFF' };
const hhmm = (at) => (at ? new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

function TrendChart({ hourly }) {
  const W = 600; const H = 150; const base = H - 18;
  const { bars, max } = stackedBars(hourly, ['bad', 'warn'], { w: W, h: base, left: 34, right: 40, top: 8 });
  const msVals = hourly.map((h) => h.avgMs).filter((v) => v != null);
  const msMax = msVals.length ? Math.max(...msVals) : 0;
  const plotW = W - 34 - 40; const n = hourly.length || 1;
  const pts = hourly.map((h, i) => (h.avgMs == null || !msMax ? null : `${34 + (i + 0.5) * (plotW / n)},${base - (h.avgMs / msMax) * (base - 8)}`));
  // 결측(그 시간 결과 없음)은 선을 끊는다 — 0 으로 잇지 않는다.
  const segs = []; let cur = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  if (!hourly.some((h) => h.n > 0)) return <div className="tv-empty">이 포탈이 기동한 뒤 들어온 결과가 아직 없습니다.</div>;
  return (
    <svg className="tv-chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="지난 24시간 시간별 ALERT·WARN 결과 수와 평균 응답 시간">
      <line x1="34" y1={base} x2={W - 40} y2={base} stroke="var(--border)" />
      <text x="2" y="14">{max}</text><text x="2" y={base - 2}>0</text>
      {msMax > 0 && <text x={W - 38} y="14">{fmtMs(msMax)}</text>}
      {bars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.k === 'bad' ? '#ef4444' : '#f59e0b'}><title>{`${hhmm(b.at)} ${b.k === 'bad' ? 'ALERT' : 'WARN'} ${b.v}`}</title></rect>)}
      {segs.map((s, i) => (s.length > 1 ? <polyline key={i} fill="none" stroke="#3b82f6" strokeWidth="1.5" points={s.join(' ')} /> : null))}
      <text x="34" y={H - 4}>{hhmm(hourly[0]?.at)}</text>
      <text x={W / 2 - 14} y={H - 4}>{hhmm(hourly[Math.floor(hourly.length / 2)]?.at)}</text>
      <text x={W - 74} y={H - 4}>{hhmm(hourly[hourly.length - 1]?.at)}</text>
    </svg>
  );
}

export default function OverviewDash({ onPickTarget = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setBusy(true);
    try {
      const r = await fetchJson('/svcmon/overview');
      if (my !== seq.current) return;
      setD(r); setErr(null);
    } catch (e) { if (my === seq.current) setErr(e); }
    finally { if (my === seq.current) setBusy(false); }
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);   // 무거운 집계(서버 30초 memo) — 15초 폴링 금지 규약
    return () => clearInterval(id);
  }, [load]);

  if (err && !d) return <ErrorBox error={err} />;
  if (!d) return <Loading label="Monitoring 개요" />;

  const s = d.summary || {};
  const val = { ...s, nodata: (s.stale || 0) + (s.unknown || 0) };
  const pct = (n) => (s.total ? `${Math.round((n / s.total) * 1000) / 10}%` : '—');
  const note = {
    total: `${(d.hexTotal ?? 0).toLocaleString()} 대상${d.executes ? '' : ' · 중앙은 엣지 보고만'}`,
    ok: pct(s.ok || 0), warn: '인증서 임박 · 응답 지연', bad: 'no answer · error',
    nodata: s.unknown ? `무보고 엣지 ${s.unknown} 포함` : '주기 3배 초과', pending: '아직 실행 안 됨', disabled: '중지(설정 연동 신규 포함)',
  };
  const nameOf = (k) => (k === 'manual' ? '수동 등록' : (d.kindLabels?.[k] || k.replace(/^set:/, '')));

  return (
    <div className="tv-root">
      <div className="card tv-top">
        <h3>Monitoring · 개요</h3>
        <span className="tv-var"><span>time</span><b>{`최근 ${Number.isInteger(d.limits?.hours) && d.limits.hours > 0 ? `${d.limits.hours}시간` : ''}(재시작 이후)`}</b></span>
        <span className="tv-var"><span>live</span><b className="tv-ok">60s</b></span>
        <span className="tv-var"><span>alerts</span><b className={d.alerts?.enabled ? 'tv-ok' : ''}>{d.alerts?.enabled ? `on · 알림 중 ${d.alerts.alerted}` : 'off'}</b></span>
        <span className="tv-spacer"><button type="button" className="btn" disabled={busy} onClick={load}>{busy ? '읽는 중…' : '새로고침'}</button></span>
      </div>

      <div className="tv-ms">
        {TILES.map((t) => (
          <div key={t.k} className={`t ${t.cls}`}><span>{t.label}</span><b>{(val[t.k] || 0).toLocaleString()}</b><small>{note[t.k]}</small></div>
        ))}
      </div>

      <div className="tv-row3">
        <div className="tv-w">
          <div className="tv-wh">체크 상태 · 출처(종류)별<em>대상 묶음의 최악 상태</em></div>
          <div className="tv-cs">
            {(d.byOrigin || []).map((o) => (
              <div key={o.kind} className={o.worst}>
                <span title={nameOf(o.kind)}>{nameOf(o.kind)}</span><b>{o.total.toLocaleString()}</b>
                <i>{Object.entries(o.counts).filter(([k]) => k !== 'ok').map(([k, n]) => `${STATE_PILL[k] || k} ${n}`).join(' · ') || `OK ${o.counts.ok || 0}`}</i>
              </div>
            ))}
            {!(d.byOrigin || []).length && <div className="tv-empty" style={{ gridColumn: '1 / -1' }}>등록된 점검이 없습니다.</div>}
          </div>
        </div>
        <div className="tv-w">
          <div className="tv-wh">ALERT · WARN 결과 수 + 평균 응답 · 1시간<em>since {hhmm(d.since)}</em></div>
          <TrendChart hourly={d.hourly || []} />
          <div className="tv-legend">
            <span><i style={{ background: '#ef4444' }} />ALERT</span><span><i style={{ background: '#f59e0b' }} />WARN</span><span><i style={{ background: '#3b82f6' }} />평균 응답(우축)</span>
            <span style={{ marginLeft: 'auto' }}>그 시간에 들어온 점검 결과 기준 · 메모리(재시작하면 비어 있음)</span>
          </div>
        </div>
        <div className="tv-w">
          <div className="tv-wh">엣지 보고 · 지연<em>edge-state</em></div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="tv-table" minWidth={320}>
              <thead><tr><th>EDGE</th><th>ROWS</th><th>AGE</th><th>STATE</th></tr></thead>
              <tbody>
                {d.executes && <tr><td className="mono">이 포탈(직접)</td><td className="mono">—</td><td className="mono">live</td><td><span className="tv-pill ok">OK</span></td></tr>}
                {(d.edges || []).map((e) => (
                  <tr key={e.agent}>
                    <td className="mono">{e.agent}</td>
                    <td className="mono" data-sort={e.rows}>{e.rows}{e.items && e.items > e.rows ? ` / ${e.items}` : ''}</td>
                    <td className="mono" data-sort={e.ageMs ?? ''}>{fmtAge(e.ageMs)}</td>
                    <td>{e.noReport ? <span className="tv-pill gone">보고 없음</span> : e.silent ? <span className="tv-pill bad">무보고</span> : <span className="tv-pill ok">OK</span>}</td>
                  </tr>
                ))}
                {!d.executes && !(d.edges || []).length && <tr><td colSpan={4} className="tv-empty">보고하는 엣지가 없습니다.</td></tr>}
              </tbody>
            </STable>
          </div>
          <div className="tv-note">무보고 엣지의 항목은 ‘알 수 없음’(UNKNOWN)으로 셉니다 — 정상도 장애도 아닙니다.</div>
        </div>
      </div>

      <div className="tv-row3">
        <div className="tv-w">
          <div className="tv-wh">호스트 맵 · 대상 {(d.hexTotal ?? 0).toLocaleString()} · 법인/폴더별<em>최악 상태</em></div>
          <div className="tv-hexwrap">
            {(d.groups || []).map((g) => (
              <div key={g.group} className="tv-hexgrp">
                <span title={g.group}>{`${g.group} ${g.total}`}</span>
                <div className="tv-hexes">
                  {(d.hexes || []).filter((h) => h.group === g.group).map((h, i) => (
                    <button key={i} type="button" className={`tv-hex ${h.state}`} style={{ border: 0, padding: 0, cursor: onPickTarget ? 'pointer' : 'default' }}
                      title={`${h.name}${h.where ? ` · 엣지 ${h.where}` : ''} · ${STATE_PILL[h.state] || h.state}`} aria-label={`${h.name} ${STATE_PILL[h.state] || h.state}`}
                      onClick={() => onPickTarget?.(h)} />
                  ))}
                </div>
              </div>
            ))}
            {!(d.groups || []).length && <div className="tv-empty">대상이 없습니다.</div>}
          </div>
          {d.hexTruncated && <div className="tv-note">{`대상이 많아 앞 ${(d.hexes || []).length}개만 그렸습니다(전체 ${d.hexTotal}).`}</div>}
          <div className="tv-legend"><span><i style={{ background: 'var(--green)' }} />ok</span><span><i style={{ background: 'var(--amber)' }} />warn</span><span><i style={{ background: 'var(--red)' }} />alert</span><span><i style={{ background: '#475569' }} />unknown</span><span><i style={{ background: '#334155' }} />off</span></div>
        </div>
        <div className="tv-w">
          <div className="tv-wh">응답 느린 점검 TOP 8<em>최근 결과 · 인증서·도메인 제외</em></div>
          <div className="tv-tl">
            {(d.slow || []).map((x, i) => {
              const top = d.slow[0]?.ms || 1;
              return (
                <div key={i}>
                  <span className="k" title={`${x.target} · ${x.test}${x.where ? ` · 엣지 ${x.where}` : ''}`}>{`${x.target} · ${x.test}`}</span>
                  <span className="bar"><i style={{ width: `${Math.max(2, Math.round((x.ms / top) * 100))}%`, background: x.state === 'warn' ? 'var(--amber)' : undefined }} /></span>
                  <span className="n">{fmtMs(x.ms)}</span>
                </div>
              );
            })}
            {!(d.slow || []).length && <div className="tv-empty">응답 시간이 있는 결과가 없습니다.</div>}
          </div>
          <div className="tv-note">엣지 배정 없이 중앙이 재는 고RTT 법인은 회선 왕복이 값에 섞입니다 — 담당 엣지에 배정하면 현지 값이 됩니다.</div>
        </div>
        <div className="tv-w">
          <div className="tv-wh">연속 실패 · 인증서 만료 임박<em>streak · D-일</em></div>
          <div style={{ overflowX: 'auto' }}>
            <STable className="tv-table" minWidth={320}>
              <thead><tr><th>TEST</th><th>STATE</th><th>VALUE</th></tr></thead>
              <tbody>
                {(d.streaks || []).map((x, i) => (
                  <tr key={`s${i}`}><td title={x.reply} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{`${x.target} · ${x.test}`}</td><td><span className="tv-pill bad">ALERT</span></td><td className="mono" data-sort={x.streak}>{`×${x.streak}`}</td></tr>
                ))}
                {(d.certs || []).map((x, i) => (
                  <tr key={`c${i}`}><td style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{`${x.target} · ${x.test}`}</td><td><span className={`tv-pill ${x.days < 0 ? 'bad' : 'warn'}`}>{x.days < 0 ? 'EXPIRED' : 'CERT'}</span></td><td className="mono" data-sort={x.days}>{x.days < 0 ? `+${-x.days}일` : `D-${x.days}`}</td></tr>
                ))}
                {!(d.streaks || []).length && !(d.certs || []).length && <tr><td colSpan={3} className="tv-empty">연속 실패·만료 임박(60일 안) 점검이 없습니다.</td></tr>}
              </tbody>
            </STable>
          </div>
        </div>
      </div>

      <div className="tv-w">
        <div className="tv-wh">상태 전이 이벤트<em>{`결과 상태가 바뀐 것만 · ${Number.isInteger(d.limits?.transitions) && d.limits.transitions > 0 ? `최근 ${d.limits.transitions}건` : '최근'} · 재시작 이후`}</em></div>
        {(d.transitions || []).slice(0, 20).map((e, i) => (
          <div key={i} className="tv-ev">
            <span className="t">{hhmm(e.at)}</span>
            <span><span className={`tv-pill ${e.to}`}>{`${e.from}→${e.to}`}</span></span>
            <span className="x">{`${e.target || e.host} · ${e.test}${e.reply ? ` — ${e.reply}` : ''}${e.scope ? ` · 엣지 ${e.scope}` : ''}${e.path ? ` · ${e.path}` : ''}`}</span>
          </div>
        ))}
        {!(d.transitions || []).length && <div className="tv-empty">아직 상태가 바뀐 점검이 없습니다.</div>}
      </div>
    </div>
  );
}
