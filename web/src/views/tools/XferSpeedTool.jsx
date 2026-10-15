/**
 * 특수 기능 '법인 간 전송 속도'(v2.735) — 메인 ↔ 엣지 사이에 무작위 N MB 를 주기적으로 주고받아 잰 속도와 이력.
 *
 * 사용자 요청(2026-10-13): "main 서버와 edge 포탈간에 30분에 1번씩 10MB 파일을 전송해서 법인간 전송 속도를 테스트해서
 * 기록 … DB 로 저장해서 히스토리 보는 기능을 특수기능에 만들고, 클로드 디자인으로 멋있게".
 * 배치는 시안(Claude Design 'xfer-speed' — 메인·상세·설정·모바일 4장)을 따른다.
 *
 * 설계:
 *  · 판정은 서버(`/tools/xfer-speed` — analyze.js)가 하고 화면은 문구·좌표만(`xferSpeedText.js`) 만든다.
 *  · 폴링은 30초(측정 중에는 4초 — 진행을 보인다). 조회는 DB·등록부만 읽어 엣지 왕복이 0 이다. 실패해도 직전 값을 지우지 않는다(v2.729 I-04).
 *  · 히트맵은 마운트 1회 + 새로고침(14일 원시를 읽으므로 폴링하지 않는다).
 *  · 상세는 주소 `#/tools/xfer-speed/edge/<id>` — 공유·새로고침해도 같은 엣지가 열린다.
 *  · 측정 없음·오래됨은 정상으로 칠하지 않는다(회색). 값이 없으면 '—'(단위를 붙이지 않는다).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, postJson, putJson, downloadFile, canCsv, CSV_DENIED_NOTE } from '../../api.js';
import { Loading, ErrorBox, Modal } from '../../components/ui.jsx';
import { STable } from '../../components/STable.jsx';
import Select from '../../components/Select.jsx';
import { requireChanged } from '../changeResult.js';
import { hashSegments } from '../../hooks/hashTab.js';
import { agoText } from './relTime.js';
import {
  DIR_TEXT, DIR_COLOR, DIR_TEXT_COLOR, STATE_TEXT, FAIL_TEXT, BASIS_TEXT, mbpsText, logWidth, spanText, bytesText, clockText,
  vsBadge, rowReasonText, sortRows, sparkPath, heatColor, heatTitle, trafficLines, statusLine, lastRunNote,
  chartModel, statCells, PERIODS, DEFAULT_PERIOD_DAYS, SETTING_FIELDS, rangeHint, settingsPatch,
  settingsIssues, NO_CHANGE_TEXT, shouldStopPolling, heatReloadNote,
  hoverAt, maxBackOf, windowEndOf, windowLabel, windowRangeText,
  SCHEDULE_KINDS, SCHEDULE_KIND_TEXT, WEEKDAYS, INTERVAL_PRESETS, intervalText, scheduleText, checkScheduleForm,
  newSchedule, nextOccurrence, runsPerDayPreview, scheduleStateText, countText, planSummary, LATENCY_NOTE,
} from './xferSpeedText.js';
import './xferSpeed.css';

const BASE = ['tools', 'xfer-speed'];
const HOUR = 3_600_000;

function useHashEdge() {
  const read = () => {
    const s = hashSegments(typeof window === 'undefined' ? '' : window.location.hash);
    return s[0] === BASE[0] && s[1] === BASE[1] && s[2] === 'edge' && s[3] ? decodeURIComponent(s[3]) : '';
  };
  const [edge, setEdge] = useState(read);
  useEffect(() => {
    const on = () => setEdge(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const open = useCallback((id) => { window.location.hash = id ? `#/${BASE.join('/')}/edge/${encodeURIComponent(id)}` : `#/${BASE.join('/')}`; }, []);
  return [edge, open];
}

/**
 * 메인 응답 폴링 — 측정 중에는 4초, 아니면 30초. 실패해도 직전 값을 지우지 않는다.
 * v2.740 D-05: 403(권한)·404(경로 없음)는 다시 물어도 같다 — 다음 틱을 걸지 않는다('새로고침' 은 그대로 다시 묻는다).
 */
function useMainData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [failedAt, setFailedAt] = useState(null);
  const runningRef = useRef(false);
  const stopRef = useRef(false);
  const tickRef = useRef(null);
  // 세대 번호(v2.735.3) — '새로고침' 이 진행 중인 조회 위에 새 루프를 열면 예전엔 두 루프가 각자 타이머를 걸어 폴링이 늘어났고,
  // 늦게 온 옛 응답이 새 응답을 덮었다. 지금 세대의 응답만 반영하고 지금 세대만 타이머를 다시 건다.
  const genRef = useRef(0);
  const load = useCallback(async (gen) => {
    try {
      const d = await fetchJson('/tools/xfer-speed');
      if (gen !== genRef.current) return;
      setData(d); setError(null); setFailedAt(null);
      runningRef.current = !!d?.status?.running;
      stopRef.current = false;
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(e); setFailedAt((x) => x || Date.now());
      stopRef.current = shouldStopPolling(e);
    }
  }, []);
  useEffect(() => {
    let alive = true; let timer = null;
    const loop = async (gen) => {
      if (!alive || gen !== genRef.current) return;
      if (typeof document === 'undefined' || !document.hidden) await load(gen);
      if (alive && gen === genRef.current && !stopRef.current) timer = setTimeout(() => loop(gen), runningRef.current ? 4_000 : 30_000);
    };
    tickRef.current = () => { if (timer) clearTimeout(timer); loop(++genRef.current); };
    loop(++genRef.current);
    return () => { alive = false; genRef.current += 1; if (timer) clearTimeout(timer); };
  }, [load]);
  return { data, error, failedAt, refresh: () => tickRef.current?.() };
}

function Kpi({ label, value, unit, sub, color }) {
  return (
    <div className="xs-kpi">
      <div className="xs-kpi-label">{label}</div>
      <div className="xs-kpi-val"><span style={color ? { color } : undefined}>{value}</span>{unit ? <span className="xs-kpi-unit">{unit}</span> : null}</div>
      {sub ? <div className="xs-kpi-sub">{sub}</div> : null}
    </div>
  );
}

function Spark({ row, now }) {
  const from = now - 24 * HOUR;
  const vals = [...(row.down?.spark || []), ...(row.up?.spark || [])].map((p) => p[1]).filter((v) => v != null);
  const max = vals.length ? Math.max(...vals) : 1;
  const d = sparkPath(row.down?.spark, { from, to: now, max });
  const u = sparkPath(row.up?.spark, { from, to: now, max });
  // 선을 그을 수 없을 때 실제 측정 횟수를 말한다(v2.735.3 — 예전엔 몇 번이든 '측정 1회' 였다).
  const n = Math.max((row.down?.spark || []).filter((p) => p[1] != null).length, (row.up?.spark || []).filter((p) => p[1] != null).length);
  if (!d && !u) return <span className="xs-note">{n ? `측정 ${n}회` : '—'}</span>;
  return (
    <svg width="150" height="34" viewBox="0 0 150 34" aria-label="최근 24시간 속도" role="img">
      {d ? <path d={d} fill="none" stroke={DIR_COLOR.down} strokeWidth="1.6" strokeLinejoin="round" /> : null}
      {u ? <path d={u} fill="none" stroke={DIR_COLOR.up} strokeWidth="1.6" strokeLinejoin="round" opacity=".85" /> : null}
    </svg>
  );
}

function BarLine({ dir, lat }) {
  const ok = lat?.ok;
  const v = ok ? lat.mbps : null;
  const failText = lat && !lat.ok ? (FAIL_TEXT[lat.kind]?.label || '실패') : null;
  return (
    <div className="xs-barline">
      <div className="xs-track"><div className={`xs-fill ${dir}`} style={{ width: `${logWidth(v)}%` }} /></div>
      <span className="xs-val" style={{ color: failText ? '#fca5a5' : DIR_TEXT_COLOR[dir] }} title={DIR_TEXT[dir]}>
        {dir === 'down' ? '↓' : '↑'} {failText || mbpsText(v)}
      </span>
    </div>
  );
}

function EdgeRow({ r, now, slowPct, minEdgeVersion, onOpen, offsetMin }) {
  const st = STATE_TEXT[r.state] || STATE_TEXT['no-data'];
  const has = !!(r.down?.latest || r.up?.latest);
  const vs = vsBadge(r, slowPct);
  const why = rowReasonText(r, minEdgeVersion);
  const showWhy = r.state !== 'ok';   // 정상 행은 막대만 — 기준 부족 같은 참고 사유는 배지 툴팁이 말한다
  const open = () => onOpen(r.id);
  return (
    <div
      className={`xs-row click ${r.state === 'fail' ? 'fail' : r.state === 'slow' ? 'slow' : ''}`}
      role="button" tabIndex={0} onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      title={`${r.name} — 눌러서 추이 보기`}
    >
      <div className="xs-name">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span className="xs-dot" style={{ background: st.color }} title={st.label} />
          <b>{r.name}</b>
        </div>
        <span title={r.origin || ''}>{[r.datacenter, r.origin].filter(Boolean).join(' · ') || (r.registered ? '' : '등록부에 없음')}</span>
      </div>
      <div className="xs-bars">
        {has ? (<><BarLine dir="down" lat={r.down?.latest} /><BarLine dir="up" lat={r.up?.latest} /></>) : null}
        {showWhy && why ? <div className={`xs-why${r.state === 'fail' ? ' red' : ''}`}>{why}</div> : null}
      </div>
      <Spark row={r} now={now} />
      <div><span className={`xs-badge ${vs.tone}`} title={vs.title || ''}>{vs.text}</span></div>
      <span className="xs-age" title={r.newestTs ? clockText(r.newestTs, offsetMin) : ''}>{r.newestTs ? agoText(r.newestTs, now, r.reason === 'clock-skew' ? { future: '시계 어긋남' } : {}) : '—'}</span>
    </div>
  );
}

function Heatmap({ rows, nameOf, truncated, onReload, reloadNote = '' }) {
  const [dir, setDir] = useState('down');
  const list = (rows || []).filter((h) => h.dir === dir);
  return (
    <section className="xs-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h3>시간대별 속도</h3>
        <div className="xs-seg" role="tablist" aria-label="방향">
          <button type="button" className={dir === 'down' ? 'on' : ''} onClick={() => setDir('down')}>↓ 엣지→메인</button>
          <button type="button" className={dir === 'up' ? 'on' : ''} onClick={() => setDir('up')}>↑ 메인→엣지</button>
        </div>
      </div>
      <div className="xs-note">최근 14일 · 포탈 시각 · 칸 색은 그 법인 평소(기간 중앙값) 대비 — 법인끼리의 절대 속도 비교가 아닙니다{truncated ? ' · 측정이 많아 상한을 넘은 오래된 측정은 빼고 그렸습니다' : ''}
        {onReload ? <> · <button type="button" className="xs-linkbtn" onClick={onReload}>새로고침</button></> : null}</div>
      {reloadNote ? <div className="xs-note" role="status" style={{ color: 'var(--amber, #f59e0b)' }}>{reloadNote}</div> : null}
      {list.length ? (
        <div className="xs-heat">
          <div className="xs-heatrow hours"><span />{Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}</div>
          {list.map((e) => (
            <div key={`${e.agent}|${e.dir}`} className="xs-heatrow">
              <span className="xs-heatname" title={nameOf(e.agent)}>{nameOf(e.agent)}</span>
              {e.hours.map((c, h) => {
                const color = heatColor(c?.ratio);
                return <span key={h} className={`xs-cell${color ? '' : ' none'}`} style={color ? { background: color } : undefined} title={heatTitle(nameOf(e.agent), h, c)} />;
              })}
            </div>
          ))}
        </div>
      ) : <div className="xs-note">이 기간에 성공한 측정이 없습니다.</div>}
      <div className="xs-ramp"><span>느림</span><i /><span>평소 이상</span><em /><span>측정 없음</span></div>
    </section>
  );
}

function SettingsModal({ data, onClose, onSaved }) {
  const s = data.settings;
  const [form, setForm] = useState(() => {
    const f = {
      enabled: !!s.enabled, intervalOn: s.intervalOn !== false, excluded: [...(s.excluded || [])],
      schedules: (s.schedules || []).map((x) => ({ ...newSchedule(data.now, data.offsetMin), ...x })),
    };
    for (const fd of SETTING_FIELDS) f[fd.key] = String(fd.toUi(s[fd.key]));
    return f;
  });
  const offsetMin = data.offsetMin ?? 540;
  const maxSched = data.scheduleRules?.max ?? 20;
  const setSched = (i, patch) => setForm((f) => ({ ...f, schedules: f.schedules.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v].sort((a, b) => a - b));
  const stateById = new Map((data.status?.schedules || []).map((x) => [x.id, x]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const exSet = new Set(form.excluded.map((x) => x.toLowerCase()));
  const edges = (data.rows || []).filter((r) => r.registered);
  const toggleEdge = (id) => setForm((f) => {
    const has = f.excluded.some((x) => x.toLowerCase() === id.toLowerCase());
    return { ...f, excluded: has ? f.excluded.filter((x) => x.toLowerCase() !== id.toLowerCase()) : [...f.excluded, id] };
  });
  const save = async () => {
    const bad = form.schedules.map((x, i) => [i, checkScheduleForm(x)]).find(([, why]) => why);
    if (bad) { setErr(`예약 ${bad[0] + 1}: ${bad[1]}`); return; }
    // v2.740 D-03·D-04: 숫자가 아닌 칸·범위 밖 칸은 저장하지 않고 칸 이름과 함께 말한다(예전엔 조용히 버리거나 서버가 잘랐다).
    const issues = settingsIssues(form, data.ranges || undefined);
    if (issues.length) { setNote(''); setErr(issues.map((x) => `${x.label}: ${x.reason}`).join(' · ')); return; }
    setBusy(true); setErr(''); setNote('');
    try {
      const patch = settingsPatch(form, s);
      if (!Object.keys(patch).length) { setNote(NO_CHANGE_TEXT); return; }   // 아무 말 없이 닫지 않는다
      requireChanged(await putJson('/tools/xfer-speed/settings', patch));
      onSaved();
    } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  // 저장 전 산수 — 서버 trafficOf 와 같은 식(화면 미리보기). 저장 뒤에는 서버 값이 보인다.
  const sizeMB = Number(form.sizeMB) || s.sizeMB;
  const ivMin = Number(form.intervalMs) || Math.round(s.intervalMs / 60_000);
  const targets = edges.filter((r) => r.enabled && r.origin && !exSet.has(String(r.id).toLowerCase())).length;
  const cycles = runsPerDayPreview({ intervalOn: form.intervalOn, intervalMin: ivMin, schedules: form.schedules });
  const onceN = form.schedules.filter((x) => x.enabled && x.kind === 'once').length;
  const ivRange = data.ranges?.intervalMs;
  const perEdge = sizeMB * 1_048_576 * 2;
  return (
    <Modal title="측정 설정" onClose={onClose} width={640}>
      <div className="xs-set">
        <label className="xs-switch">
          <span><b>자동 측정 켜기</b><small>아래 간격 실행과 예약 실행을 켭니다. 꺼져 있으면 '지금 측정' 버튼으로만 잽니다. 켜면 회선을 실제로 씁니다.</small></span>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} aria-label="자동 측정 켜기" />
        </label>
        <div className={`xs-plan${form.enabled ? '' : ' off'}`}>
          <div className="xs-plan-head">
            <label className="xs-check"><input type="checkbox" checked={form.intervalOn} onChange={(e) => setForm((f) => ({ ...f, intervalOn: e.target.checked }))} /> <b>간격 실행</b></label>
            <span className="xs-note">마지막 측정을 시작한 때부터 이 간격마다 잽니다(예약으로 잰 것도 마지막 측정입니다)</span>
          </div>
          <div className="xs-ivrow">
            {INTERVAL_PRESETS.map((m) => (
              <button key={m} type="button" className={`xs-pchip${Number(form.intervalMs) === m ? ' on' : ''}`} disabled={!form.intervalOn} onClick={() => setForm((f) => ({ ...f, intervalMs: String(m) }))}>{intervalText(m)}</button>
            ))}
            <span className="xs-inrow xs-ivcustom">
              <span>직접</span>
              <input inputMode="numeric" value={form.intervalMs} disabled={!form.intervalOn} onChange={(e) => setForm((f) => ({ ...f, intervalMs: e.target.value }))} aria-label="간격(분)" />
              <span className="xs-note">분{ivRange ? ` · ${Math.round(ivRange.min / 60_000)}~${Math.round(ivRange.max / 60_000)}분` : ''}</span>
            </span>
          </div>
          <div className="xs-plan-head" style={{ marginTop: 6 }}>
            <b>예약 실행</b>
            <span className="xs-note">정한 시각에 잽니다(포탈 시각 · 1회·매일·매주·매월). 포탈이 꺼져 있다가 {Math.round((data.scheduleRules?.graceMs ?? 1_800_000) / 60_000)}분 안에 켜지면 실행하고, 더 늦으면 놓침으로 기록합니다.</span>
          </div>
          {form.schedules.length ? form.schedules.map((x, i) => {
            const why = checkScheduleForm(x);
            const st = x.id ? stateById.get(x.id) : null;
            const preview = !why && x.enabled ? nextOccurrence(x, (data.now || Date.now()) - 1, offsetMin) : null;
            const lastTxt = st ? scheduleStateText({ last: st.last }, offsetMin, data.now) : '';
            return (
              <div key={x.id || `new-${i}`} className={`xs-sched${x.enabled ? '' : ' off'}${why ? ' bad' : ''}`}>
                <div className="xs-sched-row">
                  <Select sort={false} value={x.kind} onChange={(e) => setSched(i, { kind: e.target.value })} aria-label={`예약 ${i + 1} 종류`}>
                    {SCHEDULE_KINDS.map((k) => <option key={k} value={k}>{SCHEDULE_KIND_TEXT[k]}</option>)}
                  </Select>
                  {x.kind === 'once' ? <input type="date" value={x.date || ''} onChange={(e) => setSched(i, { date: e.target.value })} aria-label={`예약 ${i + 1} 날짜`} /> : null}
                  <input type="time" value={x.time || ''} onChange={(e) => setSched(i, { time: e.target.value })} aria-label={`예약 ${i + 1} 시각`} />
                  <label className="xs-check"><input type="checkbox" checked={x.enabled} onChange={(e) => setSched(i, { enabled: e.target.checked })} /> 사용</label>
                  <button type="button" className="xs-btn ghost" onClick={() => setForm((f) => ({ ...f, schedules: f.schedules.filter((_, j) => j !== i) }))}>삭제</button>
                </div>
                {x.kind === 'weekly' ? (
                  <div className="xs-daychips" role="group" aria-label={`예약 ${i + 1} 요일`}>
                    {WEEKDAYS.map((w, d) => <button key={w} type="button" className={`xs-pchip${(x.days || []).includes(d) ? ' on' : ''}`} onClick={() => setSched(i, { days: toggleIn(x.days || [], d) })}>{w}</button>)}
                  </div>
                ) : null}
                {x.kind === 'monthly' ? (
                  <div className="xs-mdays" role="group" aria-label={`예약 ${i + 1} 날짜`}>
                    {Array.from({ length: 31 }, (_, k) => k + 1).map((d) => <button key={d} type="button" className={`xs-pchip${(x.monthDays || []).includes(d) ? ' on' : ''}`} onClick={() => setSched(i, { monthDays: toggleIn(x.monthDays || [], d) })}>{d}</button>)}
                  </div>
                ) : null}
                <small className="xs-sched-note">
                  {why ? <span className="xs-err">{why}</span> : <>{scheduleText(x)}{preview ? ` · 다음 ${clockText(preview, offsetMin)}` : x.enabled ? ' · 다음 실행 없음(지난 시각)' : ' · 사용 안 함'}</>}
                  {x.kind === 'monthly' && (x.monthDays || []).some((d) => d > 28) ? ' · 그 달에 없는 날은 그 달 마지막 날에 실행합니다' : ''}
                  {lastTxt ? <span className="xs-sched-last"> · 마지막 {lastTxt}</span> : null}
                </small>
              </div>
            );
          }) : <div className="xs-note">예약이 없습니다 — 간격 실행만 씁니다.</div>}
          <div>
            <button type="button" className="xs-btn" disabled={form.schedules.length >= maxSched} onClick={() => setForm((f) => ({ ...f, schedules: [...f.schedules, newSchedule(data.now, offsetMin)] }))}>＋ 예약 추가</button>
            {form.schedules.length >= maxSched ? <span className="xs-note"> 예약은 {maxSched}개까지입니다</span> : null}
          </div>
        </div>
        <div className="xs-fields">
          {SETTING_FIELDS.filter((fd) => fd.key !== 'intervalMs').map((fd) => (
            <label key={fd.key} className="xs-field">
              <span>{fd.label}</span>
              <span className="xs-inrow">
                <input inputMode="numeric" value={form[fd.key]} onChange={(e) => setForm((f) => ({ ...f, [fd.key]: e.target.value }))} />
                <span className="xs-note">{fd.unit}</span>
              </span>
              <small>{rangeHint(fd, data.ranges)}</small>
            </label>
          ))}
        </div>
        <div className="xs-traffic">
          <b style={{ color: 'var(--text)' }}>이 설정이 쓰는 회선</b>
          <span>메인: 하루 {form.schedules.some((x) => x.enabled) ? '최대 ' : ''}약 <b>{bytesText(perEdge * targets * cycles)}</b> ({targets}곳 × {sizeMB}MB × 2방향 × 하루 {countText(cycles)}회)</span>
          <span>엣지 한 곳: 하루 약 <b>{bytesText(perEdge * cycles)}</b></span>
          {onceN ? <span>1회 예약 {onceN}개는 하루 평균에 넣지 않았습니다(실행할 때마다 {bytesText(perEdge * targets)})</span> : null}
          {data.status?.last?.ms ? <span>직전 측정 소요 {spanText(data.status.last.ms)} — 간격의 80%(예약은 60분)를 넘기면 남은 법인은 다음 번으로 미룹니다</span> : null}
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <b>측정할 법인</b><span className="xs-note">빼면 그 엣지와는 주고받지 않습니다(지금 측정에서 고르면 1회 잽니다)</span>
          </div>
          {edges.length ? (
            <div className="xs-edges">
              {edges.map((r) => {
                const on = !exSet.has(String(r.id).toLowerCase()) && !exSet.has(String(r.name).toLowerCase());
                const note = !r.enabled ? '등록 꺼짐' : !r.origin ? 'URL 없음' : r.edgeOld ? `엣지 ${r.edgeVersion}` : '';
                return (
                  <label key={r.id} title={r.name}>
                    <input type="checkbox" checked={on} onChange={() => toggleEdge(r.id)} />
                    <span>{r.name}</span>
                    {note ? <small>{note}</small> : null}
                  </label>
                );
              })}
            </div>
          ) : <div className="xs-note">등록된 수집 서버(엣지)가 없습니다 — 설정 › 수집 서버에서 등록하세요.</div>}
        </div>
        <div className="xs-setfoot">
          {err ? <span className="xs-err">{err}</span> : note ? <span className="xs-note">{note}</span> : null}
          <button type="button" className="xs-btn" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="xs-btn primary" onClick={save} disabled={busy}>{busy ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Main({ onOpen }) {
  const { data, error, failedAt, refresh } = useMainData();
  const [heat, setHeat] = useState(null);
  const [heatErr, setHeatErr] = useState(null);
  const [sort, setSort] = useState('slow');
  const [setOpen, setSetOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);
  const loadHeat = useCallback(async () => {
    try { setHeat(await fetchJson('/tools/xfer-speed/heat', { days: 14 })); setHeatErr(null); } catch (e) { setHeatErr(e); }
  }, []);
  useEffect(() => { loadHeat(); }, [loadHeat]);
  const now = data?.now || Date.now();
  const names = useMemo(() => new Map((data?.rows || []).map((r) => [String(r.id).toLowerCase(), r.name])), [data]);
  const nameOf = (id) => names.get(String(id).toLowerCase()) || id;
  const rows = useMemo(() => sortRows(data?.rows || [], sort), [data, sort]);

  if (!data && error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const s = data.settings || {};
  const k = data.kpis || {};
  const st = statusLine(data.status, now);
  const running = !!data.status?.running;
  const runNow = async () => {
    setMsg('');
    try {
      const r = await postJson('/tools/xfer-speed/run', {});
      if (r?.ok === false) { setMsg(r.reason || '시작하지 못했습니다'); return; }
      setMsg('측정을 시작했습니다 — 한 곳에 수십 초씩 걸립니다. 진행은 위 상태에 보입니다.');
      refresh();
    } catch (e) { setMsg(e?.message || String(e)); }
  };
  const csv = async () => {
    setCsvBusy(true); setMsg('');
    try { await downloadFile('/tools/xfer-speed/export.csv?days=30'); } catch (e) { setMsg(e?.message || String(e)); } finally { setCsvBusy(false); }
  };
  const slowest = k.slowest;
  const measured = k.measured ?? 0;
  const noData = (k['no-data'] ?? 0) + (k.stale ?? 0);
  const traffic = trafficLines(data.traffic);
  const lastNote = lastRunNote(data.status?.last);

  return (
    <div className="xs">
      <div className="xs-head">
        <div className="xs-title">
          <div className="xs-crumb">특수 기능 · 네트워크</div>
          <h2>법인 간 전송 속도</h2>
          <div className="xs-sub">메인 ↔ 엣지 사이에 무작위 {s.sizeMB}MB 를 주고받아 실제 전송 속도를 잽니다 · {planSummary(s)} · 한 번에 {s.concurrency}곳씩</div>
        </div>
        <div className="xs-actions">
          <span className="xs-pill" role="status"><span className={`xs-dot ${st.tone === 'live' ? 'live' : st.tone === 'ok' ? 'ok' : 'muted'}`} /><span>{st.text}</span></span>
          {canCsv() ? <button type="button" className="xs-btn" onClick={csv} disabled={csvBusy} title="최근 30일 측정 기록(원본)">{csvBusy ? '내보내는 중…' : 'CSV'}</button> : null}
          <button type="button" className="xs-btn" onClick={() => setSetOpen(true)}>설정</button>
          <button type="button" className="xs-btn primary" onClick={runNow} disabled={running || data.status?.role === 'edge'} title={running ? '측정 중입니다' : '전체 법인을 지금 1회 잽니다(자동 측정이 꺼져 있어도)'}>{running ? '측정 중…' : '지금 측정'}</button>
        </div>
      </div>

      {error ? <div className="xs-banner amber">조회가 {agoText(failedAt, Date.now())}부터 실패하고 있어 아래는 직전 값입니다 — {String(error?.message || error)}</div> : null}
      {msg ? <div className="xs-banner">{msg}</div> : null}
      {data.settingsLoadError ? <div className="xs-banner red">설정 파일을 읽지 못해 기본값(자동 측정 꺼짐)으로 동작 중입니다 — {data.settingsLoadError.reason}. 설정을 한 번 저장하면 풀립니다.</div> : null}
      {!data.enabled && data.status?.role !== 'edge' ? (
        <div className="xs-banner">자동 측정이 꺼져 있습니다 — 켜면 {traffic[0] || '회선을 씁니다'}. 끈 채로도 '지금 측정' 은 1회 잽니다.</div>
      ) : null}

      <div className="xs-kpis">
        <Kpi label="측정한 법인" value={measured} unit={`/ ${k.total ?? 0}곳`} sub={noData ? `${noData}곳 측정 없음·오래됨${k.excluded ? ` · 제외 ${k.excluded}곳` : ''}` : (k.excluded ? `제외 ${k.excluded}곳` : '최근 측정이 있는 법인')} />
        <Kpi label="↓ 엣지 → 메인 중앙값" value={mbpsText(k.downMedian, { unit: false })} unit={k.downMedian == null ? '' : 'Mbps'} sub="마지막 측정이 성공한 법인들의 중앙값" color={DIR_TEXT_COLOR.down} />
        <Kpi label="↑ 메인 → 엣지 중앙값" value={mbpsText(k.upMedian, { unit: false })} unit={k.upMedian == null ? '' : 'Mbps'} sub="마지막 측정이 성공한 법인들의 중앙값" color={DIR_TEXT_COLOR.up} />
        <Kpi label="가장 느린 법인" value={slowest ? mbpsText(slowest.mbps, { unit: false }) : '—'} unit={slowest ? 'Mbps' : ''} sub={slowest ? `${slowest.name} · ${DIR_TEXT[slowest.dir]}` : '측정 없음'} />
        <Kpi label="실패 · 평소보다 느림" value={`${k.fail ?? 0} · ${k.slow ?? 0}`} unit="곳" sub={`평소 = 그 법인의 7일 중앙값 · 느림 기준 ${s.slowPct}% 미만`} color={(k.fail || k.slow) ? '#fca5a5' : undefined} />
      </div>

      <div className="xs-body">
        <section className="xs-main">
          <div className="xs-sechead">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h3>법인별 전송 속도</h3>
              <div className="xs-note">막대는 로그 눈금입니다 — 1·10·100·1000 Mbps 가 같은 간격입니다 · 행을 누르면 추이가 열립니다</div>
            </div>
            <div className="xs-legend">
              <span><i style={{ background: DIR_COLOR.down }} />↓ 엣지 → 메인</span>
              <span><i style={{ background: DIR_COLOR.up }} />↑ 메인 → 엣지</span>
              <div className="xs-seg" role="tablist" aria-label="정렬">
                {[['slow', '문제 먼저'], ['name', '이름 순'], ['vs', '평소 대비']].map(([key, label]) => (
                  <button key={key} type="button" className={sort === key ? 'on' : ''} onClick={() => setSort(key)}>{label}</button>
                ))}
              </div>
            </div>
          </div>
          {rows.length ? (
            <div className="xs-scroll">
              <div className="xs-grid">
                <div className="xs-row head">
                  <span>법인 · 엣지</span>
                  <div className="xs-scale"><span>1</span><span>10</span><span>100</span><span>1000 Mbps</span></div>
                  <span>최근 24시간</span>
                  <span>평소 대비</span>
                  <span style={{ textAlign: 'right' }}>마지막 측정</span>
                </div>
                {rows.map((r) => <EdgeRow key={r.id} r={r} now={now} slowPct={s.slowPct} minEdgeVersion={data.minEdgeVersion} onOpen={onOpen} offsetMin={data.offsetMin} />)}
              </div>
            </div>
          ) : <div className="xs-note" style={{ padding: 16 }}>등록된 수집 서버(엣지)가 없습니다 — 설정 › 수집 서버에서 엣지를 등록하면 여기에 나옵니다.</div>}
          <div className="xs-foot">
            <span>{rows.length}곳 · {data.staleMs == null ? '반복 측정 일정이 없어 오래됨을 판정하지 않습니다' : `오래됨 기준 ${spanText(data.staleMs)} 넘게 측정 없음`}{data.recentTruncated ? ' · 최근 7일 측정이 상한을 넘어 오래된 측정은 평소 대비·스파크라인 계산에서 뺐습니다' : ''}</span>
            <span>Mbps = 받은 바이트 × 8 ÷ 받는 쪽에서 첫 바이트부터 마지막 바이트까지 걸린 시간</span>
          </div>
        </section>

        <aside className="xs-aside">
          {heat ? <Heatmap rows={heat.rows} nameOf={nameOf} truncated={!!heat.truncated} onReload={loadHeat} reloadNote={heatReloadNote(heatErr)} /> : heatErr ? <section className="xs-card"><h3>시간대별 속도</h3><div className="xs-note">히트맵을 불러오지 못했습니다 — {String(heatErr?.message || heatErr)}</div></section> : <section className="xs-card"><h3>시간대별 속도</h3><Loading /></section>}

          <section className="xs-card">
            <h3>최근 실패</h3>
            {(data.failures || []).length ? (data.failures || []).slice(0, 6).map((f) => (
              <div key={`${f.agent}|${f.dir}|${f.ts}`} className="xs-fail">
                <span className="xs-dot" />
                <div>
                  <div className="xs-fail-head"><b>{f.name}</b><span>{DIR_TEXT[f.dir]} · {clockText(f.ts, data.offsetMin)}</span></div>
                  <span className="xs-fail-why">{FAIL_TEXT[f.kind]?.label || f.kind || '실패'} — {f.error || FAIL_TEXT[f.kind]?.fix || ''}</span>
                </div>
              </div>
            )) : <div className="xs-note">최근 7일 실패가 없습니다.</div>}
          </section>

          <section className="xs-card" style={{ background: 'var(--panel-deep)' }}>
            <b>이 측정이 쓰는 회선</b>
            {traffic.map((l) => <span key={l} className="xs-line">{l}</span>)}
            {lastNote ? <span className="xs-line">{lastNote}</span> : null}
            {(data.skippedTargets || []).length ? <span className="xs-line">대상에서 빠진 수집 서버 {data.skippedTargets.length}곳(제외·꺼짐·URL 없음)</span> : null}
            {data.db && data.db.available === false ? <span className="xs-line" style={{ color: '#fca5a5' }}>기록 DB 를 열지 못했습니다{data.db.note ? ` — ${data.db.note}` : ''} · 측정해도 이력이 남지 않습니다</span> : null}
            {data.status?.demo ? <span className="xs-line">데모 모드 — 데모 엣지는 접속하지 않고 합성값을 기록합니다</span> : null}
          </section>
        </aside>
      </div>
      {setOpen ? <SettingsModal data={data} onClose={() => setSetOpen(false)} onSaved={() => { setSetOpen(false); setMsg('저장했습니다 — 간격·예약 변경은 바로 적용됩니다(30초 안에 다시 판정합니다).'); refresh(); }} /> : null}
    </div>
  );
}

function useWidth(ref) {
  const [w, setW] = useState(1000);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((ents) => { const cw = ents[0]?.contentRect?.width; if (cw) setW(Math.max(280, Math.round(cw))); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Chart({ hist }) {
  const wrap = useRef(null);
  const svgRef = useRef(null);
  const w = useWidth(wrap);
  const h = w < 600 ? 220 : 280;
  const [hoverPx, setHoverPx] = useState(null);
  const m = chartModel(hist, { w, h, now: Date.now() });
  if (!m) return null;
  const empty = !m.points.down && !m.points.up;
  const bd = m.baseline('down'); const bu = m.baseline('up');
  // v2.735.3: 마우스 오버 — 화면 좌표를 viewBox 좌표로 바꿔 가장 가까운 측정을 보인다(판정·문구는 hoverAt).
  const hv = hoverPx == null ? null : hoverAt(m, hoverPx, hist.offsetMin);
  const onMove = (e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    setHoverPx(((e.clientX - r.left) / r.width) * m.w);
  };
  const tipLeftPct = hv ? (hv.x / m.w) * 100 : 0;
  return (
    <div className="xs-chartwrap" ref={wrap}>
      {empty ? <div className="xs-note" style={{ padding: '30px 0', textAlign: 'center' }}>이 기간에 성공한 측정이 없습니다.</div> : (
        <svg ref={svgRef} viewBox={`0 0 ${m.w} ${m.h}`} role="img" aria-label="전송 속도 추이" onPointerMove={onMove} onPointerLeave={() => setHoverPx(null)}>
          {m.grid.map((g) => (
            <g key={g.y}>
              <line x1={m.padL} x2={m.w - m.padR} y1={g.y} y2={g.y} stroke="#1f2a40" />
              <text x={m.padL - 6} y={g.y + 4} fill="#5d6b85" fontSize="11" textAnchor="end" fontFamily="JetBrains Mono, monospace">{g.label}</text>
            </g>
          ))}
          {m.xticks.map((t) => (
            <g key={t.ts}>
              <line x1={t.x} x2={t.x} y1={m.padT} y2={m.h - m.padB} stroke="#1a2236" />
              <text x={t.x} y={m.h - 8} fill="#5d6b85" fontSize="11" textAnchor="middle">{clockText(t.ts, hist.offsetMin, { date: !(m.to - m.from <= 2 * 86_400_000) }).replace(/ 00:00$/, '')}</text>
            </g>
          ))}
          {m.band.map((b) => <path key={b.dir} d={b.d} fill={DIR_COLOR[b.dir]} opacity=".10" />)}
          {bd != null ? <line x1={m.padL} x2={m.w - m.padR} y1={bd} y2={bd} stroke={DIR_COLOR.down} strokeDasharray="4 4" opacity=".5" /> : null}
          {bu != null ? <line x1={m.padL} x2={m.w - m.padR} y1={bu} y2={bu} stroke={DIR_COLOR.up} strokeDasharray="4 4" opacity=".5" /> : null}
          {m.down ? <path d={m.down} fill="none" stroke={DIR_COLOR.down} strokeWidth="1.8" strokeLinejoin="round" /> : null}
          {m.up ? <path d={m.up} fill="none" stroke={DIR_COLOR.up} strokeWidth="1.8" strokeLinejoin="round" /> : null}
          {/* 앞뒤 측정과 이어지지 못한 점 — 선 대신 점으로(v2.735.3) */}
          {['down', 'up'].flatMap((dir) => (m.singles?.[dir] || []).map((p) => <circle key={`${dir}${p.x}`} cx={p.x} cy={p.y} r="2.6" fill={DIR_COLOR[dir]} />))}
          {m.fails.map((f) => <text key={`${f.dir}${f.ts}`} x={f.x} y={f.y} fill="#ef4444" fontSize="12" textAnchor="middle" fontWeight="700"><title>{`${DIR_TEXT[f.dir]} 실패 · ${clockText(f.ts, hist.offsetMin)}`}</title>✕</text>)}
          {hv ? (
            <g pointerEvents="none">
              <line x1={hv.x} x2={hv.x} y1={m.padT} y2={m.h - m.padB} stroke="#8b9bb4" strokeDasharray="3 3" />
              {hv.dots.map((d) => <circle key={d.dir} cx={d.x} cy={d.y} r="4" fill={DIR_COLOR[d.dir]} stroke="#0b1220" strokeWidth="1.5" />)}
            </g>
          ) : null}
          {/* 차트 영역 전체에서 마우스를 받는다(선 위가 아니어도) — 투명 사각형 */}
          <rect x={m.padL} y={m.padT} width={Math.max(0, m.w - m.padL - m.padR)} height={Math.max(0, m.h - m.padT - m.padB)} fill="transparent" />
        </svg>
      )}
      {hv ? (
        <div className={`xs-tip${tipLeftPct > 62 ? ' left' : ''}`} style={{ left: `${tipLeftPct}%` }} role="status">
          <div className="xs-tip-head">{hv.head}</div>
          {hv.lines.map((l) => (
            <div key={l.dir} className="xs-tip-line">
              <span style={{ color: DIR_TEXT_COLOR[l.dir] }}>{l.dir === 'down' ? '↓' : '↑'}</span>
              <span style={{ color: l.ok === false ? '#fca5a5' : l.ok == null ? 'var(--text-faint)' : 'var(--text)' }}>{l.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * v2.735.3 차트 아래 '이전 구간' 스크롤 — ◀ 이전 · 슬라이더(오른쪽 끝 = 최근) · 다음 ▶ · 최신. iDRAC 통합 추이(v2.666)와 같은 모양.
 * 기록이 없어 갈 곳이 없으면(maxBack 0) 그리지 않는다. 슬라이더는 놓을 때만 조회한다(끄는 동안 수십 번 조회하지 않게).
 */
function WindowScroll({ hist, days, back, dragBack, anchor, onDrag, onGo }) {
  if (hist.days !== days) return null;
  const a = anchor ?? hist.end;
  const maxB = maxBackOf(hist, a);
  if (!maxB) return null;
  const cur = Math.min(maxB, dragBack ?? back);
  const lbl = PERIODS.find((p) => p.days === days)?.label || `${days}일`;
  const { end } = windowEndOf(a, cur, days, maxB);
  return (
    <div className="xs-winscroll">
      <div className="xs-winrow">
        <button type="button" className="xs-btn sm" disabled={cur >= maxB} onClick={() => onGo(cur + 1, maxB)}>◀ 이전 {lbl}</button>
        <input type="range" min={0} max={maxB} step={1} value={maxB - cur} aria-label="조회 구간 스크롤(오른쪽 끝 = 최근)"
          onChange={(e) => onDrag(maxB - Number(e.target.value))}
          onPointerUp={(e) => onGo(maxB - Number(e.currentTarget.value), maxB)}
          onKeyUp={(e) => onGo(maxB - Number(e.currentTarget.value), maxB)} />
        <button type="button" className="xs-btn sm" disabled={cur <= 0} onClick={() => onGo(cur - 1, maxB)}>다음 {lbl} ▶</button>
        <button type="button" className={`xs-btn sm${cur === 0 ? ' primary' : ''}`} disabled={cur === 0} onClick={() => onGo(0, maxB)}>최신</button>
      </div>
      <div className="xs-note xs-wintext">
        {windowLabel(cur, days)} · {windowRangeText(end, days, hist.offsetMin)}{cur > 0 ? ' · 과거 구간은 자동 갱신하지 않습니다' : ''}{dragBack != null ? ' · 놓으면 조회합니다' : ''}
      </div>
    </div>
  );
}

function Detail({ agent, onBack }) {
  const [days, setDays] = useState(DEFAULT_PERIOD_DAYS);
  // v2.735.3 '이전 구간' — back 칸 과거(0 = 최근). anchor = 스크롤을 시작할 때의 창 끝(한 번만 잡는다). dragBack = 슬라이더를 끄는 중.
  //   법인·기간마다 따로 둔다(key) — 바꾸면 곧바로 최근 구간이다(effect 로 되돌리면 옛 back 으로 한 번 더 조회한다).
  const key = `${agent}|${days}`;
  const [scroll, setScroll] = useState({ key, back: 0, anchor: null });
  const [dragBack, setDragBack] = useState(null);
  const back = scroll.key === key ? scroll.back : 0;
  const anchor = scroll.key === key ? scroll.anchor : null;
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const seq = useRef(0);
  const past = back > 0 && anchor != null;
  const end = past ? windowEndOf(anchor, back, days).end : null;
  // 실패한 요청의 키 — 그 구간을 못 불러왔으면 '불러오는 중' 대신 실패와 다시 시도를 보인다(v2.735.3: 과거 구간은 자동 재시도가 없다).
  const reqKey = `${agent}|${days}|${end ?? ''}`;
  const [errKey, setErrKey] = useState(null);
  const load = useCallback(async () => {
    const my = ++seq.current;
    const key = `${agent}|${days}|${end ?? ''}`;
    try {
      const d = await fetchJson('/tools/xfer-speed/history', end == null ? { agent, days } : { agent, days, end });
      if (my === seq.current) { setHist(d); setErr(null); setErrKey(null); }
      return null;
    } catch (e) { if (my === seq.current) { setErr(e); setErrKey(key); } return e; }
  }, [agent, days, end]);
  useEffect(() => {
    setHist((h) => (h && h.agent?.toLowerCase() === agent.toLowerCase() ? h : null));
    let alive = true; let timer = null;
    const loop = async () => {
      if (!alive) return;
      const e = (typeof document === 'undefined' || !document.hidden) ? await load() : null;
      // 과거 구간은 바뀌지 않는다 — 1분 갱신은 최근 구간만(v2.735.3).
      // v2.740 D-05: 403(권한)·404(엣지·경로 없음)는 다시 물어도 같다 — 다음 틱을 걸지 않는다.
      if (alive && end == null && !shouldStopPolling(e)) timer = setTimeout(loop, 60_000);
    };
    loop();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load, agent, end]);
  const runOne = async () => {
    setMsg('');
    try {
      const r = await postJson('/tools/xfer-speed/run', { agent });
      setMsg(r?.ok === false ? (r.reason || '시작하지 못했습니다') : '이 법인만 지금 잽니다 — 끝나면 1분 안에 추이에 나옵니다.');
    } catch (e) { setMsg(e?.message || String(e)); }
  };
  const csv = async () => {
    // 보고 있는 구간을 내보낸다(v2.735.3 — 과거 구간이면 end).
    try { await downloadFile(`/tools/xfer-speed/export.csv?days=${Math.min(730, days)}&agent=${encodeURIComponent(agent)}${end != null ? `&end=${end}` : ''}`); } catch (e) { setMsg(e?.message || String(e)); }
  };
  if (!hist && err) return <div className="xs"><button type="button" className="xs-back" onClick={onBack}>← 법인별 전송 속도</button><ErrorBox error={err} /></div>;
  if (!hist) return <div className="xs"><button type="button" className="xs-back" onClick={onBack}>← 법인별 전송 속도</button><Loading /></div>;
  const shown = hist;
  const cells = statCells(shown.stats);
  return (
    <div className="xs">
      <div className="xs-head">
        <div className="xs-title">
          <button type="button" className="xs-back" onClick={onBack}>← 법인별 전송 속도</button>
          <div className="xs-dtitle"><h2>{shown.name}</h2>{!shown.registered ? <span className="xs-badge">등록부에 없음</span> : null}</div>
          <div className="xs-sub">{[shown.datacenter, shown.origin].filter(Boolean).join(' · ') || '—'}</div>
        </div>
        <div className="xs-actions">
          <div className="xs-seg" role="tablist" aria-label="기간">
            {PERIODS.map((p) => <button key={p.days} type="button" className={days === p.days ? 'on' : ''} onClick={() => setDays(p.days)}>{p.label}</button>)}
          </div>
          {canCsv() ? <button type="button" className="xs-btn" onClick={csv}>CSV</button> : null}
          {shown.registered ? <button type="button" className="xs-btn primary" onClick={runOne}>이 법인만 지금 측정</button> : null}
        </div>
      </div>
      {err && errKey === reqKey && (hist.days !== days || (end == null ? !!hist.past : hist.end !== end))
        ? <div className="xs-banner amber">이 구간을 불러오지 못했습니다 — {String(err?.message || err)} · <button type="button" className="xs-linkbtn" onClick={load}>다시 시도</button></div>
        : err ? <div className="xs-banner amber">최근 조회가 실패해 직전 값을 보여 줍니다 — {String(err?.message || err)}</div> : null}
      {msg ? <div className="xs-banner">{msg}</div> : null}
      {(hist.days !== days || (end == null ? !!hist.past : hist.end !== end)) && errKey !== reqKey
        ? <div className="xs-note">불러오는 중… (아래는 {windowRangeText(hist.end, hist.days, hist.offsetMin) || `${hist.days}일 기준`})</div> : null}
      <div className="xs-stats">
        {cells.map((c) => (
          <div key={c.label} className="xs-stat">
            <span>{c.label}</span>
            <b style={{ color: DIR_TEXT_COLOR.down }} title={`${DIR_TEXT.down} ${c.down}`}>↓ {c.down}</b>
            <b style={{ color: DIR_TEXT_COLOR.up }} title={`${DIR_TEXT.up} ${c.up}`}>↑ {c.up}</b>
          </div>
        ))}
      </div>
      <section className="xs-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
          <h3>{PERIODS.find((p) => p.days === shown.days)?.label || `${shown.days}일`} 추이{shown.past ? <span className="xs-pastbadge">과거 구간</span> : null}</h3>
          <div className="xs-legend">
            <span><i style={{ background: DIR_COLOR.down, height: 2 }} />↓ 엣지 → 메인</span>
            <span><i style={{ background: DIR_COLOR.up, height: 2 }} />↑ 메인 → 엣지</span>
            {shown.source === 'raw' ? <span><i style={{ borderTop: '1px dashed #8b9bb4', background: 'none', height: 0 }} />기간 중앙값</span> : <span><i style={{ background: 'rgba(34,211,238,.25)' }} />하루 최저~최고</span>}
          </div>
        </div>
        <div className="xs-note">
          {shown.source === 'raw'
            ? `측정 1회 = 1점 · 실패는 ✕ · 측정이 없던 구간은 선을 잇지 않습니다${shown.truncated ? ' · 점이 많아 앞부분을 잘랐습니다' : ''}`
            : `${shown.rawMaxDays}일보다 긴 기간은 하루 요약(성공 측정의 하루 평균·최저·최고)으로 그립니다 — 분위수는 만들 수 없어 '—' 입니다`}
        </div>
        <Chart hist={shown} />
        <WindowScroll hist={shown} days={days} back={back} dragBack={dragBack} anchor={anchor}
          onDrag={setDragBack}
          onGo={(b, maxB) => {
            const nb = Math.max(0, Math.min(maxB, b));
            setDragBack(null);
            // 기준 끝은 처음 스크롤할 때의 '지금 보이는 창의 끝' 하나 — 이후 칸은 거기에 이어 붙인다.
            setScroll(nb === 0 ? { key, back: 0, anchor: null }
              : { key, back: nb, anchor: anchor ?? (Number.isFinite(shown.end) && !shown.past ? shown.end : Date.now()) });
          }} />
      </section>
      <section className="xs-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="xs-sechead"><h3>측정 기록</h3><span className="xs-note">{shown.past ? `${clockText(shown.end, shown.offsetMin)} 이전` : '최근'} {shown.log.length}건(14일 안) · 시각은 포탈 시각</span></div>
        {shown.log.length ? (
          <STable minWidth={760}>
            <thead><tr><th>시각</th><th>방향</th><th>속도</th><th title={LATENCY_NOTE}>지연</th><th>전송</th><th>전체</th><th>바이트</th><th>결과</th></tr></thead>
            <tbody>
              {shown.log.map((l) => (
                <tr key={`${l.dir}${l.ts}`}>
                  <td data-sort={l.ts} style={{ fontFamily: 'var(--mono)' }}>{clockText(l.ts, shown.offsetMin)}</td>
                  <td style={{ color: DIR_TEXT_COLOR[l.dir] }}>{DIR_TEXT[l.dir]}</td>
                  <td data-sort={l.mbps ?? ''} style={{ fontFamily: 'var(--mono)' }}>{mbpsText(l.mbps)}</td>
                  <td data-sort={l.ttfbMs ?? ''}>{l.ttfbMs == null ? '—' : `${l.ttfbMs}ms`}</td>
                  <td data-sort={l.xferMs ?? ''} title={l.basis ? BASIS_TEXT[l.basis] || l.basis : ''}>{spanText(l.xferMs)}{l.basis === 'sender-total' ? ' *' : ''}</td>
                  <td data-sort={l.totalMs ?? ''}>{spanText(l.totalMs)}</td>
                  <td data-sort={l.bytes ?? ''}>{bytesText(l.bytes)}</td>
                  <td style={{ color: l.ok ? '#6ee7c8' : '#fca5a5', whiteSpace: 'normal' }}>{l.ok ? '성공' : `${FAIL_TEXT[l.kind]?.label || '실패'}${l.error ? ` — ${l.error}` : ''}`}</td>
                </tr>
              ))}
            </tbody>
          </STable>
        ) : <div className="xs-note" style={{ padding: 16 }}>{shown.past ? `${clockText(shown.end, shown.offsetMin)} 이전 14일` : '최근 14일'} 측정 기록이 없습니다.</div>}
        {shown.log.length ? <div className="xs-note" style={{ padding: '8px 16px 0', whiteSpace: 'normal' }}>{LATENCY_NOTE}</div> : null}
        {shown.log.some((l) => l.basis === 'sender-total') ? <div className="xs-note" style={{ padding: '8px 16px 12px' }}>* {BASIS_TEXT['sender-total']}</div> : null}
      </section>
      {!canCsv() ? <div className="xs-note">{CSV_DENIED_NOTE}</div> : null}
    </div>
  );
}

export default function XferSpeedTool() {
  const [edge, open] = useHashEdge();
  return edge ? <Detail agent={edge} onBack={() => open('')} /> : <Main onOpen={open} />;
}
