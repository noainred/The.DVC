import React from 'react';
import BoldText from '../../../components/boldText.jsx';
import { LEVELS, GAP_BG, levelColor, stateBadge, pctText, speedText, timeText, WHY_TEXT } from './ifaceText.js';

/** 인터페이스 화면(전 장비 · 장비 한 대) 공용 조각(v3.35.0). */
export function Seg({ items, value, onPick, label }) {
  return (
    <div className="flex gap" role="group" aria-label={label} style={{ flexWrap: 'wrap' }}>
      {items.map(([k, t]) => (
        <button key={k} type="button" className={value === k ? 'login-btn' : 'tab'} style={{ flex: 'none', padding: '4px 12px' }} aria-pressed={value === k} onClick={() => onPick(k)}>{t}</button>
      ))}
    </div>
  );
}
export function Legend() {
  return (
    <div className="flex gap" style={{ flexWrap: 'wrap', fontSize: 11, alignItems: 'center' }}>
      {LEVELS.map((l) => (
        <span key={l.min} className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: l.color, borderRadius: 2, display: 'inline-block' }} />{l.label}</span>
      ))}
      <span className="flex gap" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 12, height: 10, background: GAP_BG, display: 'inline-block' }} />값 없음</span>
    </div>
  );
}
export function Strip({ cells, label, width = 168 }) {
  if (!Array.isArray(cells)) return <span className="muted">—</span>;
  return (
    <div role="img" aria-label={label} style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`, gap: 1, width }}>
      {cells.map((c, i) => <span key={i} title={c == null ? '값 없음' : pctText(c)} style={{ height: 14, borderRadius: 2, background: c == null ? GAP_BG : levelColor(Math.min(100, c)) }} />)}
    </div>
  );
}
export function UtilBar({ pct, width = 90 }) {
  const c = levelColor(pct);
  return (
    <div className="flex gap" style={{ alignItems: 'center', gap: 6 }}>
      <div style={{ position: 'relative', width, height: 8, borderRadius: 4, background: 'var(--panel-deep, #0f1626)', overflow: 'hidden', flex: 'none' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct == null ? '100%' : `${Math.max(1.5, Math.min(100, pct))}%`, background: pct == null ? GAP_BG : c, borderRadius: 4 }} />
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, minWidth: 38, textAlign: 'right' }}>{pctText(pct)}</span>
    </div>
  );
}
export function StateCell({ r }) {
  const b = stateBadge(r.state);
  return (
    <span className="flex gap" style={{ gap: 4, flexWrap: 'nowrap', whiteSpace: 'nowrap' }}>
      <span className={`badge ${b.cls}`}>{b.text}</span>
      {r.state !== 'slow' && (r.flags || []).includes('slow') && <span className="badge amber">속도 저하</span>}
      {r.state !== 'busy' && (r.flags || []).includes('busy') && <span className="badge amber">포화 근접</span>}
      {r.linkUp === true && r.unread && <span className="badge gray" title="사용량을 읽지 못했습니다 — 정상에도 이상에도 넣지 않고 따로 셉니다">사용량 못 읽음</span>}
      {r.stale && <span className="badge gray" title={`마지막 표본 ${timeText(r.lastTs)}`}>오래된 표본</span>}
    </span>
  );
}
export function SpeedCell({ r }) {
  const slow = (r.flags || []).includes('slow');
  return (
    <span>
      <span style={{ fontFamily: 'var(--mono)', color: slow ? 'var(--amber)' : undefined, fontWeight: slow ? 600 : undefined }}>{r.linkUp === false ? '—' : speedText(r.speedGbps)}</span>
      <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
        {r.linkUp === false ? '' : slow ? `최대 ${speedText(r.maxGbps)}` : typeof r.requested === 'number' ? `고정 ${speedText(r.requested)}` : ''}
      </span>
    </span>
  );
}

/** v3.36.1 — 사용량이 비는 이유 + 근거(서버 throughputDetail). 단정하지 않고 받은 사실만 보인다. */
export function WhyDetail({ why, detail }) {
  if (!why) return null;
  const d = detail || {};
  const dg = d.diag;
  const paths = dg?.paths ? Object.entries(dg.paths) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span><BoldText text={WHY_TEXT[why] || why} /></span>
      {dg && (
        <span className="muted">
          마지막 표본 시도 {timeText(dg.at)} · {dg.source === 'edge' ? '엣지가 올린 표본' : '이 포탈에서 수집'} · {dg.ok ? '성공' : '실패'}
          {dg.via ? ` · 읽은 경로 ${dg.via === 'rest' ? 'REST' : 'SSH(uemcli)'}` : ''}
          {dg.fcPath ? ` · FC 경로 ${dg.fcPath}` : ''}
          {Object.keys(dg.kinds || {}).length > 0 && ` · 단위 ${Object.entries(dg.kinds).map(([k, n]) => `${k} ${n}`).join(' · ')}`}
        </span>
      )}
      {paths.length > 0 && <span className="muted" style={{ fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>경로별 항목 수: {paths.map(([k, n]) => `${k} ${n}`).join(' · ')}</span>}
      {dg?.error && <span style={{ color: 'var(--amber)', overflowWrap: 'anywhere' }}>오류: {dg.error}</span>}
      {dg?.restSkip && <span className="muted" style={{ overflowWrap: 'anywhere' }}>REST 를 쓰지 않은 이유: {dg.restSkip === 'auth' ? '이 계정으로 REST 로그인이 거절돼 멈췄습니다(계정 잠금 방지 — 장비 등록의 계정 · 비밀번호를 바꾸면 다시 시도합니다)' : 'REST 가 실패해 1시간 동안 SSH 로 읽습니다'}{dg.restError ? ` — ${dg.restError}` : ''}</span>}
      {(dg?.errors || []).map((e, i) => <span key={i} className="muted" style={{ overflowWrap: 'anywhere' }}>· {e}</span>)}
      {dg?.counterNote && <span className="muted">{dg.counterNote}</span>}
      {why === 'no-match' && (
        <>
          <span className="muted" style={{ fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>표본 쪽 포트 이름: {(d.unitNames || []).join(' · ') || '—'}</span>
          <span className="muted" style={{ fontFamily: 'var(--mono)', overflowWrap: 'anywhere' }}>구성 쪽 포트 id(짝 없음 {d.unmatched ?? 0}개 중): {(d.unmatchedPorts || []).join(' · ') || '—'}</span>
        </>
      )}
      {why === 'no-port-units' && d.unitKinds && <span className="muted">이 포탈에 저장된 단위: {Object.entries(d.unitKinds).map(([k, n]) => `${k} ${n}`).join(' · ') || '없음'}</span>}
      {!dg && ['no-samples', 'no-port-units', 'no-match', 'no-recent'].includes(why) && <span className="muted">이 포탈은 아직 이 장비의 표본 시도 기록이 없습니다(재시작 뒤 첫 주기 전이거나, 엣지에서 실패한 표본은 중앙에 오지 않습니다).</span>}
    </div>
  );
}
