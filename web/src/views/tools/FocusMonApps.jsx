/**
 * views/tools/FocusMonApps.jsx — 프로세스 탭 ‘앱 단위’ 보기(v3.14.0 ⑮ — 시안 Apps · 사용자 "기본값대로 모두 구현해줘").
 *  · 묶는 기준: 서비스(systemd · 기본) | 프로그램 이름(숫자 덩어리는 *) — 고른 기준은 브라우저가 기억한다.
 *  · 서버마다 표(▸ 를 누르면 그 묶음의 상위 30 안 프로세스) + 앱별 CPU 쌓은 영역(위 5개 + 나머지 · 색은 이름을 따른다).
 *  · 합에는 상위 30 밖의 프로세스도 모두 들어간다(원격은 이미 모든 프로세스의 stat 줄과 서비스 이름을 보낸다).
 */
import React, { useMemo, useState } from 'react';
import { Loading, ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { yScale, niceMax, stackedAreas } from './focusMonChart.js';
import { DASH, pctText, clockText, agoShort, nameTitle } from './focusMonText.js';
import { APP_BY_TEXT, APP_REST_COLOR, appColor, appIoText, appIoTitle, appMemText, appUserText, appMembersNote } from './focusMonAppsText.js';
import { usePoll } from './focusMonPoll.js';
import { Seg } from './FocusMonBulk.jsx';

const ls = () => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };
const lsGet = (k, d) => { try { const v = ls()?.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { ls()?.setItem(k, JSON.stringify(v)); } catch { /* */ } };

function AppChart({ s, from, to }) {
  const se = s.series;
  if (!se) return <div className="fm-note fm-pad">이 구간에는 앱 묶음 표본이 없습니다.</div>;
  const X0 = 40; const X1 = 632; const top = 10; const bottom = 150;
  const layers = [...se.vals, se.rest];
  const sums = se.rest.map((_, k) => { let t = 0; let any = false; for (const l of layers) { if (l[k] != null) { t += l[k]; any = true; } } return any ? t : null; });
  const max = niceMax(Math.max(1, ...sums.filter((v) => v != null)));
  const y = yScale({ max, top, bottom });
  const paths = stackedAreas(layers, { x0: X0, x1: X1, y });
  const lastIdx = (() => { for (let k = sums.length - 1; k >= 0; k--) if (sums[k] != null) return k; return -1; })();
  return (
    <div className="fm-pad fm-col">
      <div className="fm-row fm-between"><span className="fm-h3 fm-sm">앱별 CPU — 위 {se.keys.length}개 + 나머지(쌓은 영역)</span><span className="fm-dim">코어 1개 = 100% · 색은 묶음 이름을 따릅니다</span></div>
      <div className="fm-chart-box fm-appchart">
        <svg viewBox="0 0 640 172" role="img" aria-label={`앱별 CPU 쌓은 영역 — ${se.keys.join(', ')} 와 나머지`} className="fm-chart">
          {[0, max / 2, max].map((v) => <g key={v}><line x1={X0} x2={X1} y1={y(v)} y2={y(v)} stroke="var(--fm-grid)" /><text x={X0 - 6} y={y(v) + 4} className="fm-axis" textAnchor="end">{Math.round(v)}</text></g>)}
          {paths.map((d, i) => <path key={i} d={d} fill={i < se.keys.length ? appColor(se.keys[i], se.keys) : APP_REST_COLOR} fillOpacity="0.55" stroke={i < se.keys.length ? appColor(se.keys[i], se.keys) : APP_REST_COLOR} strokeWidth="1" />)}
          <text x={X0} y={168} className="fm-axis">{clockText(from)}</text><text x={X1} y={168} className="fm-axis" textAnchor="end">{clockText(to)}</text>
        </svg>
      </div>
      <div className="fm-row fm-flexwrap">
        {se.keys.map((k, i) => <span key={k} className="fm-lg"><i style={{ background: appColor(k, se.keys) }} /><span className="fm-ell fm-appk" title={k}>{k}</span> <b>{lastIdx >= 0 ? pctText(se.vals[i][lastIdx], 0) : DASH}</b></span>)}
        <span className="fm-lg"><i style={{ background: APP_REST_COLOR }} />나머지 <b>{lastIdx >= 0 ? pctText(se.rest[lastIdx], 0) : DASH}</b></span>
      </div>
    </div>
  );
}

function AppServer({ s, tById, onOpen, find }) {
  const [open, setOpen] = useState(() => new Set());
  const keys = s.series?.keys || [];
  const f = find.trim().toLowerCase();
  const rows = s.apps.filter((a) => !f || a.k.toLowerCase().includes(f) || String(a.u || '').toLowerCase().includes(f));
  const topCpu = Math.max(1, ...s.apps.map((a) => a.cpu ?? 0));
  const toggle = (k) => setOpen((o) => { const x = new Set(o); if (x.has(k)) x.delete(k); else x.add(k); return x; });
  return (
    <div className="fm-card fm-flush">
      <div className="fm-pad fm-row fm-between">
        <h3 className="fm-h3"><button type="button" className="fm-linkbtn" onClick={() => onOpen(s.id)} title={nameTitle(tById.get(s.id), '눌러서 서버 상세')}>{tById.get(s.id)?.name || s.id}</button></h3>
        <span className="fm-dim">프로세스 {s.total ?? DASH}개 · 묶음 표본 {s.snaps}개 · {s.lastAt ? agoShort(s.lastAt, Date.now()) : DASH}</span>
      </div>
      {s.noUnits ? <div className="fm-note fm-pad">이 서버의 서비스 이름을 아직 받지 못했습니다(30초마다 받습니다) — ‘프로그램 이름’ 으로 보거나 잠시 뒤 다시 보세요.</div> : null}
      {rows.length ? (
        <div className="fm-tblbox">
          <STable className="fm-table" minWidth={820}>
            <thead><tr><th>묶음</th><th>계정</th><th className="fm-r">프로세스</th><th className="fm-r">스레드</th><th>CPU(코어 1개 = 100%)</th><th className="fm-r">메모리(RSS 합)</th><th>디스크 읽기 · 쓰기</th></tr></thead>
            <tbody>{rows.map((a) => {
              const on = open.has(a.k); const mem = s.members?.[a.k] || [];
              return (
                <React.Fragment key={a.k}>
                  <tr className={`fm-click ${on ? 'fm-editing' : ''}`} onClick={() => toggle(a.k)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(a.k); } }} tabIndex={0} aria-expanded={on} title="누르면 이 묶음의 프로세스(상위 30 안)">
                    <td data-sort={a.k}><span className="fm-appname"><span className="fm-dim">{on ? '▾' : '▸'}</span><i className="fm-appdot" style={{ background: appColor(a.k, keys) }} /><span className="fm-mono fm-ell" title={a.k}>{a.k}</span></span></td>
                    <td className="fm-mono" data-sort={a.u || ''}>{appUserText(a)}</td>
                    <td className="fm-r fm-num" data-sort={a.n ?? null}>{a.n ?? DASH}</td>
                    <td className="fm-r fm-num" data-sort={a.th ?? null}>{a.th ?? DASH}</td>
                    <td data-sort={a.cpu ?? null}><span className="fm-meter"><span className="t"><span className="f" style={{ width: `${Math.min(100, ((a.cpu ?? 0) / topCpu) * 100)}%`, background: appColor(a.k, keys) }} /></span><span className="fm-num">{pctText(a.cpu, 1)}</span></span></td>
                    <td className="fm-r fm-num" data-sort={a.rss ?? null}>{appMemText(a.rss)}</td>
                    <td className="fm-num" data-sort={a.rb ?? null} title={appIoTitle(a)}>{appIoText(a)}</td>
                  </tr>
                  {on ? (
                    <tr className="fm-editrow"><td colSpan={7}><div className="fm-edbox">
                      {mem.length ? (
                        <STable className="fm-table" minWidth={520}>
                          <thead><tr><th className="fm-r">PID</th><th>명령(comm)</th><th>계정</th><th>CPU</th><th className="fm-r">메모리</th><th className="fm-r">스레드</th></tr></thead>
                          <tbody>{mem.map((p) => <tr key={p.pid}><td className="fm-r fm-mono fm-num">{p.pid}</td><td className="fm-mono">{p.c}</td><td className="fm-mono">{p.u || DASH}</td><td className="fm-num" data-sort={p.cpu ?? null}>{pctText(p.cpu, 1)}</td><td className="fm-r fm-num" data-sort={p.rss ?? null}>{appMemText(p.rss)}</td><td className="fm-r fm-num">{p.th ?? DASH}</td></tr>)}</tbody>
                        </STable>
                      ) : <div className="fm-note">이 묶음의 프로세스는 마지막 표본의 CPU 상위 30 에 없습니다.</div>}
                      {appMembersNote(a, mem.length) ? <div className="fm-note">{appMembersNote(a, mem.length)}</div> : null}
                    </div></td></tr>
                  ) : null}
                </React.Fragment>
              );
            })}</tbody>
          </STable>
        </div>
      ) : <div className="fm-note fm-pad">{s.apps.length ? '찾는 묶음이 없습니다.' : '이 구간에는 앱 묶음 표본이 없습니다(이 판보다 오래된 기록이거나 수집 전).'}</div>}
      {s.series ? <AppChart s={s} from={s.from} to={s.to} /> : null}
    </div>
  );
}

/** 프로세스 탭 ‘앱 단위’ 보기. */
export function AppsView({ ids, tb, tById, onOpen, at, find }) {
  const [by, setByRaw] = useState(() => (lsGet('fm.apps.by', 'sv') === 'cm' ? 'cm' : 'sv'));
  const setBy = (v) => { const x = v === 'cm' ? 'cm' : 'sv'; setByRaw(x); lsSet('fm.apps.by', x); };
  const params = useMemo(() => ({ targets: ids.join(','), win: tb.win, end: tb.end ?? '', at, by }), [ids, tb.win, tb.end, at, by]);
  const q = usePoll('/tools/focus-mon/apps', params, tb.end == null ? 5_000 : 0, ids.length > 0);
  const d = q.data;
  return (
    <>
      <div className="fm-row"><span className="fm-lbl">묶는 기준</span><Seg label="묶는 기준" value={by} onChange={setBy} options={[['sv', APP_BY_TEXT.sv], ['cm', APP_BY_TEXT.cm]]} />
        <span className="fm-dim">{by === 'sv' ? '서비스가 없는 프로세스는 ‘커널 스레드’ · ‘사용자 세션’ · ‘서비스 없음’ 으로 묶습니다' : '프로그램 이름(comm)의 숫자 덩어리는 * 로 묶습니다(ora_p001 · ora_p007 → ora_p*)'}</span></div>
      {q.error && !d ? <ErrorBox error={q.error} /> : null}
      {!d ? <Loading /> : d.per.map((s) => <AppServer key={`${s.id}-${d.by}`} s={{ ...s, from: d.from, to: d.to }} tById={tById} onOpen={onOpen} find={find} />)}
      <div className="fm-note">합에는 상위 30 밖의 프로세스도 모두 들어갑니다(원격은 이미 모든 프로세스의 stat 줄과 서비스 이름을 보냅니다 — 원격 명령 추가 없음). CPU 는 두 표본에 다 있던 프로세스만 셉니다. 디스크 읽기 · 쓰기는 수집 계정 · root 의 프로세스만 읽혀, 다른 계정 프로세스만 있는 묶음은 ‘—’, 일부만 읽힌 묶음은 ‘(부분)’ 입니다(0 으로 채우지 않습니다). 메모리 RSS 합은 공유 메모리를 여러 번 센 값이라 실제보다 큽니다. 기록은 분마다 상위 20개를 보관 기간 동안 남깁니다.{d?.usersMasked ? ' 계정 이름은 관리자에게만 보입니다.' : ''}</div>
    </>
  );
}
