/**
 * 리눅스 성능 5단계(v2.929) 조각 — 서버 상세 요약 탭의 **점검 소모품 카드**(아트보드 Health ⑧) · 보드의 **‘집중 n 건 진행 중’ · ‘소모품 주의 n대’ 줄**과 함대 표.
 * ⚠ 판정은 서버(health.js — 수집 노드가 판정 · 중앙은 그대로 전한다) · 문구는 bmPerfOpsText.js. 이 파일은 그리기만.
 * ⚠ 보드 줄의 집중 목록은 보드를 열 때 1회 + 칩을 다시 누를 때(폴링 없음).
 */
import React, { useEffect, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { STable } from '../../components/STable.jsx';
import BoldText from '../../components/boldText.jsx';
import { toneVar } from './toneVar.js';
import { shortStamp } from './bmOpsText.js';
import { verdictView } from './bmPerfText.js';
import {
  HEALTH_CELL_TEXT, HEALTH_CODE_TEXT, healthValueText, healthLimitText, daysSinceText, healthAttentionRows, HEALTH_HONEST, focusStatusView,
} from './bmPerfOpsText.js';
import './bmOps.css';
import './bmPerfOps.css';

const CELLS = ['chrony', 'units', 'oom', 'dmesg', 'uptime', 'fdct', 'cert', 'tuned'];

/** 요약 탭 카드 — 8칸(값 · 읽는 곳 · 기준(설정) · 근거 등급) + 세는 줄. health 가 없으면 이유 한 줄. */
export function HealthCard({ health = null, now = Date.now() }) {
  if (!health?.cells) {
    return (
      <section className="bmo-card">
        <h5 className="bmo-h">점검 소모품</h5>
        <p className="bmo-note">소모품 칸이 없습니다 — 리눅스 OS 경로로 읽은 적이 없거나 수집 노드가 이 판(점검 소모품 구획) 이전입니다.</p>
      </section>
    );
  }
  const c = health.counts || {};
  return (
    <section className="bmo-card">
      <h5 className="bmo-h">점검 소모품 — 8칸 <span className="bmo-sub">주의 {(c.warn || 0) + (c.bad || 0)} · 정상 {c.ok || 0} · 확인 불가 {(c.missing || 0) + (c.perm || 0)} · 없음 · 해당 없음 {(c.absent || 0) + (c.na || 0)}{health.at ? ` · ${shortStamp(health.at)} 판정` : ''}</span></h5>
      <div className="bmh-grid">
        {CELLS.map((id) => {
          const cell = health.cells[id] || { code: 'missing' };
          const ct = HEALTH_CODE_TEXT[cell.code] || HEALTH_CODE_TEXT.missing;
          const t = HEALTH_CELL_TEXT[id];
          const lim = healthLimitText(id, cell);
          const since = health.since?.[id];
          return (
            <div key={id} className="bmh-cell" style={{ borderLeftColor: toneVar(ct.tone) }}>
              <div className="bmh-head"><span style={{ fontSize: 12.5 }}>{t.label}</span><span className="bmp-chip" style={{ color: toneVar(ct.tone) }}>{ct.label}</span></div>
              <div className="bmh-v" style={{ color: ['warn', 'bad'].includes(cell.code) ? toneVar(ct.tone) : undefined }}>{healthValueText(id, cell)}</div>
              <div className="bmo-sub">{t.reads}</div>
              {lim && <div className="bmo-sub">{lim}</div>}
              <div className="bmo-sub"><span className="bmo-g">{t.grade}</span>{t.basis}{['warn', 'bad'].includes(cell.code) && since ? ` · ${daysSinceText(since, now)}` : ''}</div>
            </div>
          );
        })}
      </div>
      <p className="bmo-note" style={{ marginTop: 6 }}>{HEALTH_HONEST}</p>
    </section>
  );
}

/** 함대 ‘소모품 주의 서버’ 표(그리기만) — 보드 항목의 목록용 health. */
export function HealthFleetTable({ items = [], onOpen = () => {}, now = Date.now() }) {
  const rows = healthAttentionRows(items, now);
  if (!rows.length) return <p className="bmo-note">주의 · 이상 칸이 있는 서버가 없습니다(못 읽은 칸은 세지 않습니다).</p>;
  return (
    <STable minWidth={600} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>서버</th><th>법인</th><th>주의 칸</th><th className="right">며칠째</th><th data-nosort /></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.agent}|${r.key}`}>
            <td data-sort={r.name}>{r.name}</td>
            <td data-sort={r.vcenterId}>{r.vcenterId || '귀속 없음'}</td>
            <td data-sort={r.cells.length} className="bmo-wrap">{r.cells.map((c, i) => <React.Fragment key={c.id}>{i > 0 && ' · '}<span style={{ color: toneVar(c.code === 'bad' ? 'bad' : 'warn') }}>{HEALTH_CELL_TEXT[c.id]?.label || c.id}</span></React.Fragment>)}</td>
            <td className="right" data-sort={r.since}>{daysSinceText(r.since, now)}</td>
            <td data-nosort><button className="btn btn-sm bmp-touch" onClick={() => onOpen(r.key, 'summary')}>상세</button></td>
          </tr>
        ))}
      </tbody>
    </STable>
  );
}

/** 함대 집중 세션 표(그리기만). */
export function FocusFleetTable({ sessions = [], onOpen = () => {} }) {
  if (!sessions.length) return <p className="bmo-note">진행 중이거나 최근 24시간에 끝난 집중 모니터링이 없습니다.</p>;
  return (
    <STable minWidth={640} className="bmo-t" style={{ fontSize: 12 }}>
      <thead><tr><th>서버</th><th>법인</th><th>시작</th><th>트리거</th><th>상태</th><th>판정 변화</th><th data-nosort /></tr></thead>
      <tbody>
        {sessions.map((x) => {
          const st = focusStatusView(x.status);
          return (
            <tr key={`${x.agent}|${x.id}`}>
              <td data-sort={x.name || x.key}>{x.name || x.key}{x.via === 'edge' ? <span className="bmo-sub"> · 엣지 {x.agent}</span> : null}</td>
              <td data-sort={x.vcenterId}>{x.vcenterId || '귀속 없음'}</td>
              <td data-sort={x.start || x.created}>{shortStamp(x.start || x.created)}</td>
              <td data-sort={x.trigger}>{x.trigger === 'auto' ? '자동' : '수동'}</td>
              <td data-sort={x.status}><span style={{ color: toneVar(st.tone) }}>{st.label}{x.status === 'running' ? ` ${x.done}/${x.count}` : ''}{x.status === 'queued' && x.queuePos ? ` · 대기 ${x.queuePos}번째` : ''}</span></td>
              <td data-sort={x.verdictTo || ''}>{x.verdictFrom ? `${verdictView(x.verdictFrom).label} → ${verdictView(x.verdictTo).label}` : '—'}</td>
              <td data-nosort><button className="btn btn-sm bmp-touch" onClick={() => onOpen(x.key, 'focus')}>보기</button></td>
            </tr>
          );
        })}
      </tbody>
    </STable>
  );
}

/** 보드 줄 — ‘집중 n 건 진행 중’ · ‘소모품 주의 n대’ 칩(누르면 함대 표). 집중 목록은 보드를 열 때 1회(폴링 없음). */
export function BoardOpsStrip({ items = [], onOpen = () => {}, now = Date.now() }) {
  const [focus, setFocus] = useState({ resp: null, err: null });
  const [open, setOpen] = useState('');
  const gen = useRef(0);
  const load = async () => {
    const g = ++gen.current;
    try { const r = await fetchJson('/tools/bm-usage/focus', {}, undefined, { timeoutMs: 60_000 }); if (g === gen.current) setFocus({ resp: r, err: null }); }
    catch (e) { if (g === gen.current) setFocus({ resp: null, err: e }); }
  };
  useEffect(() => { load(); }, []);
  const health = healthAttentionRows(items, now).length;
  const running = focus.resp?.running ?? null; const queued = focus.resp?.queued ?? 0;
  const toggle = (k) => { setOpen((p) => (p === k ? '' : k)); if (k === 'focus') load(); };
  return (
    <div className="card" style={{ minWidth: 0, display: 'grid', gap: 8 }}>
      <div className="bmb-strip">
        <button type="button" className="bmb-chip" aria-pressed={open === 'focus'} onClick={() => toggle('focus')} title="진행 중 · 대기 · 최근 24시간 집중 모니터링(누르면 목록 — 다시 읽기)">
          집중 <b style={{ color: running ? toneVar('warn') : undefined }}>{running == null ? '—' : running}</b>{running == null ? '' : '건'} 진행 중{queued ? ` · 대기 ${queued}` : ''}
        </button>
        <button type="button" className="bmb-chip" aria-pressed={open === 'health'} onClick={() => toggle('health')} title="점검 소모품 칸이 주의 · 이상인 서버(못 읽은 칸은 세지 않는다)">
          소모품 주의 <b style={{ color: health ? toneVar('warn') : undefined }}>{health}</b>대
        </button>
        {focus.err && <span className="bmo-sub">집중 목록을 읽지 못했습니다({focus.err.status || focus.err.message})</span>}
      </div>
      {open === 'focus' && <FocusFleetTable sessions={focus.resp?.sessions || []} onOpen={onOpen} />}
      {open === 'health' && (
        <>
          <HealthFleetTable items={items} onOpen={onOpen} now={now} />
          <p className="bmo-note"><BoldText text={'‘며칠째’ 는 처음 그 칸이 주의가 된 수집부터(전이 기록) 셉니다. 정상이 되면 행이 사라지고 이력은 서버 상세 › 추이의 **변경 이벤트**(소모품 칸)에 남습니다.'} /></p>
        </>
      )}
    </div>
  );
}
