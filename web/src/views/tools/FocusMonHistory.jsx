/**
 * views/tools/FocusMonHistory.jsx — 서버 집중 모니터링 ‘긴 구간 · 사건 · 가장 변했나 · 링크’(v3.13.0 ⑭ — 시안 History · 사용자 "기본값대로 모두 구현해줘").
 *
 *  · CPU 차트 위 겹(띠 · 겹쳐 보기 · 사건 번호) — 좌표는 순수 함수(focusMonChart.bandPath · focusMonHistoryText.eventMarks).
 *  · 사건 카드 — 목록(번호 · 시각 · 종류 · 내용 · 적은 사람) + 직접 적기(관리자 · 전체 쓰기 범위 — 서버가 다시 막는다) + 직접 적은 것만 지우기.
 *  · 가장 변했나 카드 — 단추로만 묻는다(무거운 계산 — 폴링하지 않는다 · 서버가 60초 기억).
 *  · 링크 복사 — 해시 끝에 ‘@’ 칸(구간 · 끝 시각 · 겹쳐 보기 · 서버 id 만).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson, postJson, delJson } from '../../api.js';
import { ErrorBox } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import { bandPath, linePath } from './focusMonChart.js';
import { DASH, clockText, winText } from './focusMonText.js';
import {
  CMP_TEXT, EVENT_KIND_TEXT, EVENT_SCOPE_TEXT, eventMarks, localInputValue, fromLocalInput,
  changeValText, changeRatioText, overlapText, changesCaption, linkHash,
} from './focusMonHistoryText.js';
import { Seg, copyText } from './FocusMonBulk.jsx';

const TONE_FILL = { warn: '#f59e0b', crit: '#ef4444', ok: '#22c55e', off: '#8b9bb4' };

/** CPU 차트 위 겹 — 띠(긴 구간만) · 겹쳐 보기(점선) · 사건 번호(세로 점선 + 동그라미). svg 안에 둔다. */
export function CpuHistoryLayers({ d, x0, x1, y, top, bottom, showBand }) {
  if (!d) return null;
  const band = showBand && d.charts?.band ? bandPath(d.charts.band.min, d.charts.band.max, { x0, x1, y }) : '';
  const ov = d.overlay?.cpu ? linePath(d.overlay.cpu, { x0, x1, y }) : '';
  const marks = eventMarks(d.events, d.from, d.to);
  return (
    <g>
      {band ? <path d={band} fill="#93c5fd" fillOpacity="0.16" stroke="none"><title>칸 안 최저 ~ 최고(CPU 사용률)</title></path> : null}
      {ov ? <path d={ov} fill="none" stroke="#e2e8f0" strokeOpacity="0.75" strokeWidth="1.5" strokeDasharray="5 4"><title>{CMP_TEXT[d.overlay.cmp]} — CPU 사용률 평균</title></path> : null}
      {marks.map((m) => {
        const x = x0 + m.x * (x1 - x0); const cy = top + 7 + m.row * 15;
        return (
          <g key={`${m.n}-${m.kind}`}>
            <line x1={x} x2={x} y1={cy + 7} y2={bottom} stroke={TONE_FILL[m.tone]} strokeOpacity="0.6" strokeDasharray="2 3" />
            <circle cx={x} cy={cy} r="7" fill={TONE_FILL[m.tone]} />
            <text x={x} y={cy + 3.5} className="fm-evn" textAnchor="middle">{m.n}</text>
          </g>
        );
      })}
    </g>
  );
}

/** 겹쳐 보기 단추. */
export function CmpSeg({ value, onChange }) {
  return <Seg label="겹쳐 보기" value={value || ''} onChange={(v) => onChange(v || '')} options={[['', '겹쳐 보기 없음'], ['1d', '어제'], ['7d', '지난주']]} />;
}

/** 사건 카드 — 목록 + 직접 적기 + 지우기. */
export function EventsCard({ id, t, d, main, onChanged, setMsg }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState('server');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const events = d?.events || [];
  const max = main.limits?.eventTextMax || 300;
  const scopes = (main.limits?.eventScopes || ['server', 'group', 'session']).filter((s) => s !== 'group' || t?.group);
  const save = () => {
    setBusy(true); setErr('');
    postJson('/tools/focus-mon/events', { target: id, text, scope, at: fromLocalInput(at) ?? '' })
      .then((r) => { setText(''); setAt(''); setMsg?.({ tone: 'ok', text: `사건을 적었습니다(${r.targets}대).` }); onChanged?.(); })
      .catch((e) => setErr(e?.body?.reason || e?.message || '적지 못했습니다.'))
      .finally(() => setBusy(false));
  };
  const remove = (e) => {
    if (!window.confirm(`${e.n}번 사건(${e.text.slice(0, 40)})을 지울까요? 같이 적힌 다른 서버의 줄도 지워집니다.`)) return;
    setBusy(true); setErr('');
    delJson(`/tools/focus-mon/events/${encodeURIComponent(e.id)}`).then(() => onChanged?.()).catch((x) => setErr(x?.body?.reason || x?.message || '지우지 못했습니다.')).finally(() => setBusy(false));
  };
  return (
    <div className="fm-card fm-flush">
      <div className="fm-col fm-pad">
        <h3 className="fm-h3">사건 — 이 구간 {events.length}건</h3>
        <span className="fm-dim">번호는 CPU 차트 위 동그라미와 같습니다 · 자동으로 적는 것: 재부팅(가동 시간이 줄어듦) · 키 로그인 거부 · 호스트키 승인 필요 · 수집 시작 · 끝</span>
      </div>
      {d?.eventsPartial ? <div className="fm-note fm-pad">기록 DB 를 읽지 못해 사건 목록이 빠졌을 수 있습니다.</div> : null}
      {events.length ? (
        <div className="fm-tblbox">
          <STable className="fm-table" minWidth={640}>
            <thead><tr><th>번호</th><th>시각</th><th>종류</th><th>내용</th><th>적은 사람</th><th data-nosort="1" /></tr></thead>
            <tbody>{events.map((e) => {
              const k = EVENT_KIND_TEXT[e.kind] || { label: e.label || e.kind, tone: 'off' };
              return (
                <tr key={`${e.id}-${e.n}`}>
                  <td className="fm-num" data-sort={e.n}><span className="fm-evdot" style={{ background: TONE_FILL[k.tone] }}>{e.n}</span></td>
                  <td className="fm-mono" data-sort={e.at}>{clockText(e.at, true)}</td>
                  <td><span className={`fm-badge ${k.tone}`}>{k.label}</span>{e.user && e.scope !== 'server' ? <small className="fm-dim"> {EVENT_SCOPE_TEXT[e.scope] || ''}</small> : null}</td>
                  <td className="fm-brk">{e.text || DASH}</td>
                  <td className="fm-mono">{e.by || DASH}</td>
                  <td>{e.user ? <button type="button" className="fm-btn sm" disabled={busy} onClick={() => remove(e)}>지우기</button> : null}</td>
                </tr>
              );
            })}</tbody>
          </STable>
        </div>
      ) : <div className="fm-note fm-pad">이 구간에는 사건이 없습니다.</div>}
      <div className="fm-pad fm-col">
        <div className="fm-row fm-evform">
          <span className="fm-lbl">직접 적기</span>
          <input className="fm-input fm-grow" value={text} maxLength={max} onChange={(e) => setText(e.target.value.slice(0, max))} placeholder="예: 14:20 애플리케이션 배포 v2.3 · 백업 작업 시작" aria-label="사건 내용" />
          <input className="fm-input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} max={localInputValue(Date.now() + 3_600_000)} aria-label="사건 시각(비우면 지금)" title="비우면 지금 · 30일 앞까지" />
          <Seg label="적을 범위" value={scope} onChange={setScope} options={scopes.map((s) => [s, EVENT_SCOPE_TEXT[s] || s])} />
          <button type="button" className="fm-btn pri" disabled={busy || !text.trim()} onClick={save}>적기</button>
        </div>
        <span className="fm-dim">{max}자까지 · 시각을 비우면 지금 · 관리자이고 조회 · 쓰기 범위가 모두 전체인 계정만 적고 지울 수 있습니다 · 보관 {main.settings?.retentionDays ?? DASH}일 · 감사 기록에 남습니다</span>
        {err ? <div className="fm-why">{err}</div> : null}
      </div>
    </div>
  );
}

/** 가장 변했나 — 단추로만 묻는다. */
export function ChangesCard({ ids, tb, tById, onOpen, retentionDays }) {
  const [state, setState] = useState({ busy: false, data: null, error: null, key: '' });
  const gen = useRef(0);
  const key = `${ids.join(',')}|${tb.win}|${tb.end ?? ''}`;
  useEffect(() => { gen.current += 1; setState({ busy: false, data: null, error: null, key: '' }); }, [key]);
  const run = () => {
    const my = ++gen.current;
    setState((s) => ({ ...s, busy: true, error: null }));
    fetchJson('/tools/focus-mon/changes', { targets: ids.join(','), win: tb.win, end: tb.end ?? '' })
      .then((d) => { if (my === gen.current) setState({ busy: false, data: d, error: null, key }); })
      .catch((e) => { if (my === gen.current) setState({ busy: false, data: null, error: e, key }); });
  };
  const d = state.data;
  // 앞 구간(4배)이 통째로 보관 기간 밖이면 견줄 수 없다(반증 F7 — 30일 구간은 늘 빈 결과였다)
  const beyond = retentionDays > 0 && tb.win >= retentionDays * 1440;
  return (
    <div className="fm-card fm-flush">
      <div className="fm-row fm-between fm-pad">
        <div className="fm-col"><h3 className="fm-h3">무엇이 가장 변했나 — 최근 {winText(tb.win)} vs 그 앞 {winText(tb.win * 4)}</h3>
          <span className="fm-dim">서버 × 지표마다 두 구간의 중앙값 비와 분포가 겹치는 정도로 점수를 매깁니다 · 순위는 어디부터 볼지의 안내이고 원인을 단정하지 않습니다</span></div>
        <button type="button" className="fm-btn pri" disabled={state.busy || !ids.length || beyond} onClick={run}>{state.busy ? '계산 중…' : d ? '다시 계산' : '계산'}</button>
      </div>
      {state.error ? <div className="fm-pad"><ErrorBox error={state.error} /></div> : null}
      {d ? (
        <>
          <div className="fm-note fm-pad">{changesCaption(d)}{d.partial ? ' · 기록 DB 를 일부 읽지 못했습니다' : ''}{d.skipped ? ` · 칸이 모자라 뺀 서버 × 지표 ${d.skipped}개(앞 구간에 기록이 적음)` : ''}{d.aBeyond ? ' · 앞 구간이 보관 기간 밖이라 견줄 수 없습니다' : d.aPartly ? ' · 앞 구간의 일부가 보관 기간 밖입니다(남은 기록으로만 견줍니다)' : ''}</div>
          {d.rows.length ? (
            <div className="fm-tblbox">
              <STable className="fm-table" minWidth={760}>
                <thead><tr><th>순위</th><th>서버</th><th>지표</th><th>앞 구간</th><th>고른 구간</th><th>바뀐 정도</th><th>분포</th><th>점수</th><th>칸 수</th></tr></thead>
                <tbody>{d.rows.map((r, i) => (
                  <tr key={`${r.id}-${r.key}`}>
                    <td className="fm-num" data-sort={i + 1}>{i + 1}</td>
                    <td data-sort={tById.get(r.id)?.name || r.name}><button type="button" className="fm-linkbtn" onClick={() => onOpen(r.id)}>{tById.get(r.id)?.name || r.name}</button></td>
                    <td>{r.label}</td>
                    <td className="fm-num" data-sort={r.a}>{changeValText(r.a, r.unit)}</td>
                    <td className="fm-num" data-sort={r.b}><b>{changeValText(r.b, r.unit)}</b></td>
                    <td data-sort={r.ratio}>{changeRatioText(r.ratio)}</td>
                    <td data-sort={r.overlap}>{overlapText(r.overlap)}</td>
                    <td className="fm-num" data-sort={r.score}>{r.score}</td>
                    <td className="fm-num fm-dim" data-sort={r.nB}>{r.nA} · {r.nB}</td>
                  </tr>
                ))}</tbody>
              </STable>
            </div>
          ) : <div className="fm-note fm-pad">두 구간 사이에 눈에 띄게 바뀐 지표가 없습니다(또는 앞 구간 기록이 모자랍니다).</div>}
        </>
      ) : beyond ? <div className="fm-note fm-pad">이 구간의 앞 4배 길이는 보관 기간({retentionDays}일) 밖이라 견줄 수 없습니다 — 더 짧은 구간을 고르세요.</div>
        : !state.busy ? <div className="fm-note fm-pad">‘계산’ 을 누르면 지금 보는 서버 {ids.length}대를 견줍니다.</div> : null}
    </div>
  );
}

/** 링크 복사 단추 — 지금 탭 · 서버 · 구간 · 겹쳐 보기를 해시에 담는다. */
export function LinkCopy({ route, tb }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const hash = linkHash({ tab: route.tab, server: route.server, win: tb.win, end: tb.end, cmp: route.tab === 'server' ? tb.cmp : '' });
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}${hash}`;
    Promise.resolve(copyText(url)).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }).catch(() => window.prompt('이 주소를 복사하세요', url));
  };
  return <button type="button" className="fm-btn" onClick={copy} title="지금 보는 탭 · 서버 · 구간을 주소로 복사합니다(서버 이름 · IP 는 담지 않습니다)">{done ? '복사했습니다' : '링크 복사'}</button>;
}
