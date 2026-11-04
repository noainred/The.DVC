/**
 * Bareos 실행 취소 · 그룹 회차 중단 확인 창(v2.867 · 시안 docs/design/bareos-cancel/ ② ③ · 승인 2026-11-03).
 *   백업 대상 패널 · 진행 현황판 · 그룹 카드가 같은 창을 쓴다(같은 동작이 화면마다 다르게 묻지 않게). 요청은 부르는 쪽이 보낸다(onConfirm — 엣지 대행 시한은 부르는 쪽이 안다).
 *   문구 · 판정은 bareosCancelText.js. ⚠ 문구에 백틱 금지 · 400px 에서 줄바꿈(버튼 줄 flexWrap).
 */
import React, { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { jobCancelNotes, groupPlanView, groupCancelNotes, nameMatches, ageText, sendLeft } from './bareosCancelText.js';
import { shortTs } from './bareosViewText.js';

const ROW = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };
const NOTE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 5, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(245,158,11,.4)', background: 'rgba(245,158,11,.08)', fontSize: 12.5, lineHeight: 1.5 };
const KV = { display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', gap: '6px 10px', fontSize: 12.5, margin: 0 };
const DANGER = { flex: 'none', padding: '8px 18px', background: 'var(--red)', borderColor: 'var(--red)', color: '#fff' };

/**
 * 단일 실행 취소 확인 창.
 * @param {{ vmName, jobid, level?, since?, bytesText?, group?, triggerText?, stuck?: boolean, waitMs?: number|null, busy?: boolean, error?: string, onConfirm: () => void, onClose: () => void }} p
 */
export function JobCancelModal({ vmName, jobid, level = '', since = null, bytesText = '', group = '', triggerText = '', stuck = false, waitMs = null, busy = false, error = '', onConfirm, onClose }) {
  const now = Date.now();
  return (
    <Modal title={`${stuck ? '취소 다시 보내기' : '실행 취소'} — ${vmName}`} onClose={busy ? () => {} : onClose} width={560}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>jobid {jobid}{group ? ` · 그룹 ${group}` : ''}{triggerText ? ` · ${triggerText}` : ''}</div>
        <dl style={KV}>
          <dt className="muted">지금</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{stuck ? '취소를 보냈지만 아직 돕니다' : '실행 중'}{level ? ` · ${level}` : ''}{Number.isFinite(since) ? ` · ${shortTs(since)} 시작 · ${ageText(now - since)} 경과` : ''}{bytesText ? ` · ${bytesText}` : ''}</dd>
          <dt className="muted">하는 일</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>Director 에 <b>cancel jobid={jobid}</b> 명령을 보냅니다. FD 가 멈추기까지 수 초~수 분 걸리고, 그동안 이 대상은 ‘멈추는 중’ 으로 보입니다.</dd>
          <dt className="muted">결과</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>끝나면 결과 <b>취소</b> 로 기록되고 <b>복원 지점이 되지 않습니다</b>. 다음 증분은 마지막 성공 백업 기준으로 돕니다.</dd>
        </dl>
        <div style={NOTE}>
          <b>알아 둘 것</b>
          {jobCancelNotes({ group, waitMs }).map((t) => <div key={t}>· {t}</div>)}
        </div>
        {error && <div className="banner bad" style={{ fontSize: 12.5 }}>{error}</div>}
        <div style={{ ...ROW, justifyContent: 'flex-end' }}>
          <button type="button" className="logout-btn" onClick={onClose} disabled={busy}>닫기</button>
          <button type="button" className="login-btn" style={DANGER} disabled={busy} onClick={onConfirm}>{busy ? '보내는 중…' : stuck ? '취소 다시 보내기' : '취소 보내기'}</button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 그룹 회차 중단 확인 창 — 단계별 수(서버 cancelPlan) · 범위 · 다음 회차 건너뛰기 · 그룹 이름 재입력.
 * @param {{ g: { name, vmIds?, stop, next?, lastFire? }, waitMs?: number|null, busy?: boolean, error?: string, onConfirm: (body: object) => void, onClose: () => void }} p
 */
export function GroupCancelModal({ g, waitMs = null, busy = false, error = '', onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  const [all, setAll] = useState(false);
  const [skip, setSkip] = useState(false);
  const plan = g.stop || {};
  const pv = groupPlanView(plan);
  const ok = nameMatches(typed, g.name) && !busy && (pv.canStop || all);
  const nameId = `bareos-stop-name-${g.id || 'g'}`;
  return (
    <Modal title={`회차 중단 — ${g.name}`} onClose={busy ? () => {} : onClose} width={640}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
        <div className="muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
          {Number.isFinite(g.vmIds?.length) ? `그룹 VM ${g.vmIds.length}대` : '그룹 VM 수 모름'}{g.lastFire?.at ? ` · 마지막 회차 ${shortTs(g.lastFire.at)}${g.lastFire.key ? `(${g.lastFire.key})` : ''}` : ''} · {pv.head}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 130px), 1fr))', gap: 8 }}>
          <Count label="이번 회차 실행 중" n={plan.phase === 'sending' ? (plan.progress?.started ?? 0) + (plan.progress?.inflight ?? 0) : plan.fire} hint={plan.progress?.inflight ? `회신 대기 ${plan.progress.inflight} 포함 — 시작한 뒤 취소` : '취소를 한 번에 보냄'} tone="#93c5fd" />
          <Count label="보낼 차례" n={plan.phase === 'queued' ? g.vmIds?.length : plan.phase === 'sending' ? sendLeft(plan.progress) : 0} hint="보내지 않음 → 시작 전 멈춤" />
          <Count label="그 밖 실행 중" n={plan.extra} hint="Bareos 스케줄 · 수동(아래에서 고르면)" />
          <Count label="멈추는 중" n={plan.sent} hint={plan.stuck ? `멈추지 않음 ${plan.stuck} — 다시 보냄` : '다시 보내지 않음'} tone="#fdba74" />
        </div>
        {pv.lines.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 12.5, lineHeight: 1.5 }}>{pv.lines.map((t) => <div key={t}>· {t}</div>)}</div>}
        <fieldset style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', margin: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, minWidth: 0 }}>
          <legend className="muted" style={{ fontSize: 12, padding: '0 4px' }}>범위 · 옵션</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
            <span style={{ minWidth: 0 }}><b>그룹 VM 의 실행 중 전부</b>{plan.extra ? ` (+${plan.extra}대)` : ''}<br /><span className="muted" style={{ fontSize: 12 }}>기본은 이번 회차가 시작한 실행만입니다. 고르면 Bareos 스케줄 · 수동 실행까지 함께 취소합니다.</span></span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: g.next?.at ? 'pointer' : 'not-allowed' }}>
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} disabled={busy || !g.next?.at} style={{ marginTop: 3 }} />
            <span style={{ minWidth: 0 }}><b>다음 예약 회차 1회 건너뛰기</b>{g.next?.at ? ` — ${shortTs(g.next.at)} ${g.next.level || ''}` : ' — 스케줄이 꺼져 있어 다음 회차가 없습니다'}<br /><span className="muted" style={{ fontSize: 12 }}>기본은 그대로 돕니다(중단이 예약을 바꾸지 않습니다).</span></span>
          </label>
        </fieldset>
        <div style={NOTE}>
          <b>알아 둘 것</b>
          {groupCancelNotes({ waitMs }).map((t) => <div key={t}>· {t}</div>)}
        </div>
        <label htmlFor={nameId} className="muted" style={{ fontSize: 12 }}>확인 — 그룹 이름 ‘{g.name}’ 을 그대로 입력하세요(OTP 는 묻지 않습니다 — 멈춤은 데이터를 지우지 않습니다)</label>
        <input id={nameId} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" style={{ minWidth: 0 }} />
        {!pv.canStop && !all && <div className="muted" style={{ fontSize: 12 }}>이번 회차에 멈출 실행이 없습니다 — 그 밖 실행을 멈추려면 위의 범위를 고르세요.</div>}
        {error && <div className="banner bad" style={{ fontSize: 12.5 }}>{error}</div>}
        <div style={{ ...ROW, justifyContent: 'flex-end' }}>
          <span className="muted" style={{ fontSize: 11.5, marginRight: 'auto', minWidth: 0 }}>멈추는 동안 이 그룹의 지금 백업 · 지우기는 잠깁니다</span>
          <button type="button" className="logout-btn" onClick={onClose} disabled={busy}>닫기</button>
          <button type="button" className="login-btn" style={DANGER} disabled={!ok} onClick={() => onConfirm({ confirmName: typed.trim(), includeScheduled: all, skipNext: skip })}>{busy ? '보내는 중…' : '회차 중단'}</button>
        </div>
      </div>
    </Modal>
  );
}

function Count({ label, n, hint, tone }) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : null;
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 10px', background: 'var(--panel-deep)', minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: v ? tone : undefined }}>{v ?? '—'}</div>
      <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{hint}</div>
    </div>
  );
}
