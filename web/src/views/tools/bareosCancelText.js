/**
 * Bareos 실행 취소 · 그룹 회차 중단의 화면 문구 · 판정(v2.867 · 시안 docs/design/bareos-cancel/ · 승인 2026-11-03).
 *   '멈추는 중' · '멈추지 않음' 판정 자체는 서버 cancelState.cancelInfo 가 한다(cancel = { jobid, at, by, via, stuck }) — 여기서는 그 값을 문구로만 바꾼다.
 *   백업 대상 패널 · 진행 현황판 · 그룹 카드가 같은 함수를 쓴다(같은 상태가 화면마다 다르게 보이지 않게).
 * ⚠ 문구에 백틱 금지(BoldText) — 값 인용은 ‘ ’.
 */

/** '1분 12초' · '8초' · '1시간 3분'(음수·모름은 '—'). */
export function ageText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${String(s % 60).padStart(2, '0')}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
/** 분 단위 기준(서버 cancelWaitMs) → '10분'. 모르면 ''. */
export const waitMinText = (ms) => (typeof ms === 'number' && ms > 0 ? `${Math.round(ms / 60_000)}분` : '');

/**
 * 판정 칩 — 취소를 보낸 실행이면 { text, tone, title }, 아니면 null.
 * @param {{ at:number, by:string, via:string, stuck:boolean }|null} cancel  서버 cancelInfo
 */
export function cancelChip(cancel, { now = Date.now(), waitMs = null } = {}) {
  if (!cancel) return null;
  const who = `${cancel.by || '?'}${cancel.via === 'group' ? ' · 그룹 중단' : ''}`;
  if (cancel.stuck) {
    return { text: '멈추지 않음', tone: 'warn', title: `취소를 보낸 지 ${ageText(now - cancel.at)} 지났는데 아직 돕니다(${who}) — Director 에서 확인하세요. 취소를 다시 보낼 수 있습니다.` };
  }
  const lim = waitMinText(waitMs);
  return { text: `멈추는 중 ${ageText(now - cancel.at)}`, tone: 'stop', title: `취소를 보냈습니다(${who}) — FD 가 멈추기까지 수 초~수 분 걸립니다${lim ? `. ${lim} 넘게 돌면 ‘멈추지 않음’ 으로 바뀝니다` : ''}.` };
}

/**
 * 취소 버튼 — 실행 중이 아니면 null(버튼 없음). 이미 보냈으면 잠긴 '취소 보냄', 멈추지 않으면 '다시 보내기…'.
 * @param {string} lockReason  쓰기 범위 · 처리 중 잠금 사유(targetLocks.cancel) — 있으면 잠근다
 */
export function cancelButton({ running, cancel, lockReason = '' }) {
  if (!running) return null;
  if (cancel && !cancel.stuck) return { label: '취소 보냄', disabled: true, title: '취소를 이미 보냈습니다 — Director 가 멈추기를 기다리는 중입니다.' };
  if (lockReason) return { label: cancel?.stuck ? '다시 보내기…' : '취소…', disabled: true, title: lockReason };
  return { label: cancel?.stuck ? '다시 보내기…' : '취소…', disabled: false, title: cancel?.stuck ? '멈추지 않은 실행에 취소를 다시 보냅니다.' : '이 실행을 취소합니다(확인 창).' };
}

/** 단일 취소 확인 창의 '알아 둘 것' 줄(서버 동작과 같은 말 — 스냅샷 잔류는 실환경 미확인 · 추정). */
export function jobCancelNotes({ group = '', waitMs = null } = {}) {
  const lim = waitMinText(waitMs);
  return [
    '이 실행이 만든 VMware 스냅샷이 남을 수 있습니다 — 끝난 뒤 백업 대상의 ‘스냅샷 n개’ 칩으로 확인하세요(실환경 미확인 · 추정).',
    group ? `그룹 ‘${group}’ 의 다른 VM 은 계속 돕니다 — 회차 전체를 멈추려면 그룹의 ‘회차 중단…’ 을 쓰세요.` : '다른 대상의 실행에는 손대지 않습니다.',
    `취소는 삭제가 아닙니다 — 이미 쓴 볼륨 · 카탈로그는 지우지 않습니다. OTP 는 묻지 않습니다${lim ? ` · ${lim} 넘게 돌면 ‘멈추지 않음’ 으로 알립니다` : ''}.`,
  ];
}

export const PHASE_TEXT = Object.freeze({ queued: '줄 대기', sending: '보내는 중', running: 'Director 실행 중' });

/**
 * 그룹 회차 중단 확인 창의 단계별 설명 — 서버 cancelPlan({ phase, fire, extra, sent, stuck, progress }) 을 문구로.
 * @returns {{ phase: string, head: string, lines: string[], canStop: boolean }}
 */
export function groupPlanView(plan) {
  const p = plan || {};
  const pr = p.progress || null;
  const lines = [];
  if (p.phase === 'queued') lines.push('Director 차례를 기다리는 중입니다 — 줄에서 빼고 아무것도 보내지 않습니다(전부 ‘시작 전 멈춤’).');
  if (p.phase === 'sending') {
    const left = pr && Number.isFinite(pr.toSend) ? Math.max(0, pr.toSend - (pr.sent || 0)) : null;
    lines.push(`보내는 중입니다${pr ? `(보냄 ${pr.sent ?? 0} / ${pr.toSend ?? 0})` : ''} — 다음 덩어리를 보내지 않습니다${left !== null ? `(시작 전 멈춤 약 ${left}대)` : ''}.`);
    lines.push('보내는 중이던 덩어리는 끊지 않고 회신을 받은 뒤 그 실행을 취소합니다(도중에 끊으면 시작됐는지 알 수 없게 됩니다).');
  }
  if (p.phase === 'running') lines.push(`이번 회차가 시작해 아직 도는 실행 ${p.fire ?? 0}대에 취소를 한 번에 보냅니다(법인 쪽에서 묶어서).`);
  if (p.sent > 0) lines.push(`이미 취소를 보내 멈추는 중인 실행 ${p.sent}대${p.stuck ? `(멈추지 않음 ${p.stuck})` : ''}는 ${p.stuck ? '멈추지 않은 것만 다시 보냅니다' : '다시 보내지 않습니다'}.`);
  const canStop = !!p.phase || (p.extra ?? 0) > 0;
  return { phase: PHASE_TEXT[p.phase] || (p.extra ? '그 밖 실행만' : '멈출 실행 없음'), head: p.phase ? `단계 — ${PHASE_TEXT[p.phase]}` : '이번 회차에 멈출 실행이 없습니다', lines, canStop };
}

/** 그룹 중단 확인 창의 '알아 둘 것'(서버 동작과 같은 말). */
export function groupCancelNotes({ waitMs = null } = {}) {
  const lim = waitMinText(waitMs);
  return [
    '취소된 실행은 결과 ‘취소’ 로 남고 복원 지점이 되지 않습니다. 이미 끝난 실행의 백업은 그대로 쓸 수 있습니다.',
    '이 회차로는 보관 정리를 하지 않습니다 — 다음 정상 회차가 끝난 뒤에 돕니다.',
    '취소한 VM 에 VMware 스냅샷이 남을 수 있습니다 — 끝난 뒤 백업 대상의 ‘스냅샷 n개’ 칩으로 확인하세요(실환경 미확인 · 추정).',
    `FD 가 멈추기까지 수 초~수 분 걸립니다${lim ? ` · ${lim} 넘게 돌면 ‘멈추지 않음’ 으로 알립니다` : ''}.`,
  ];
}

/** 확인 창의 이름 재입력이 맞는가(앞뒤 공백만 무시 — 서버와 같은 비교). */
export const nameMatches = (typed, name) => String(typed ?? '').trim() === String(name ?? '');

/** 중단 요청 응답(202) → 한 줄 안내. */
export function cancelAcceptedText(r, name) {
  if (!r) return '';
  const parts = [`‘${name}’ 회차 중단을 시작했습니다(${PHASE_TEXT[r.phase] || r.phase})`];
  if (r.fire) parts.push(`취소 대상 ${r.fire}대`);
  if (r.extra) parts.push(`그 밖 실행 ${r.extra}대`);
  if (r.halted) parts.push(`시작 전 멈춤 ${r.halted}대`);
  if (r.skipKey) parts.push(`다음 회차 ${r.skipKey} 건너뜀`);
  return `${parts.join(' · ')} — 결과는 이 화면에 곧 반영됩니다.`;
}

/**
 * 회차 기록의 중단 요약(lastFire.canceled) → 한 줄. 없으면 ''.
 *   '중단됨 11-01 23:48 kim.ys · 취소 14 · 시작 전 멈춤 9' (0 인 칸은 뺀다)
 */
export function canceledText(c, tsText = (x) => String(x)) {
  if (!c) return '';
  const parts = [`중단됨 ${tsText(c.at)}${c.by ? ` ${c.by}` : ''}`];
  for (const [k, t] of [['canceled', '취소'], ['finished', '이미 끝남'], ['cleared', '추적만 해제'], ['halted', '시작 전 멈춤'], ['failed', '취소 실패'], ['unknown', '취소 결과 모름'], ['busy', '다른 요청 중']]) if (c[k] > 0) parts.push(`${t} ${c[k]}`);
  if (c.extra && (c.extra.canceled || c.extra.failed || c.extra.unknown || c.extra.busy)) parts.push(`그 밖 실행 취소 ${c.extra.canceled}`);
  if (c.scope === 'all') parts.push('범위 그룹 VM 전부');
  if (c.skipKey) parts.push(`${c.skipKey} 회차 건너뜀`);
  return parts.join(' · ');
}

/**
 * 그룹 카드 · 상세의 중단 상태(서버 tree 그룹 한 줄 — canceling · stop(cancelPlan) · lastFire.canceled · running).
 * @returns {{ kind: 'stopping'|'cancelable'|'stopped'|null, text: string, tone: string, canStop: boolean }}
 *   stopping   = 중단 처리 중이거나, 회차 중단으로 취소를 보낸 실행이 아직 돈다(멈추지 않음이 아닌 것)
 *   cancelable = 멈출 수 있는 회차가 있다(줄 대기 · 보내는 중 · 이번 회차 실행 중) — '회차 중단…'
 *   stopped    = 마지막 회차가 중단됐다(다 멈췄다)
 *   canStop    = '회차 중단…' 을 열 수 있나 — 중단 처리 중이 아니고 이번 회차에 멈출 것(줄 대기 · 보내는 중 · 도는 실행)이 있다.
 *                그 밖 실행(Bareos 스케줄)만 도는 그룹에는 열지 않는다 — 그 실행은 진행 현황판의 행마다 '취소…' 로(확인 창의 범위 확대는 회차가 있을 때만).
 */
export function groupStopState(g) {
  const st = g?.stop || {};
  const canStop = !g?.canceling && !st.pruning && !!st.phase;
  if (g?.canceling || ((st.sent ?? 0) > (st.stuck ?? 0) && g?.lastFire?.canceled)) {
    return { kind: 'stopping', text: st.stuck ? `멈추는 중 · 멈추지 않음 ${st.stuck}` : '멈추는 중', tone: 'stop', canStop };
  }
  if (st.phase) return { kind: 'cancelable', text: st.phase === 'queued' ? '차례 대기' : st.phase === 'sending' ? '보내는 중' : '실행 중', tone: 'run', canStop };
  if (g?.lastFire?.canceled) return { kind: 'stopped', text: '중단됨', tone: 'muted', canStop };
  return { kind: null, text: '', tone: 'muted', canStop };
}

/** 그룹 이번 회차 진행 막대(서버 progress · stop) → [{ n, tone, label }] (0 인 칸은 뺀다). progress 가 없으면 []. */
export function progressSegments(g) {
  const p = g?.progress;
  if (!p || p.queued || !Number.isFinite(p.toSend)) return [];
  const started = p.started ?? 0;
  const failedOrSkipped = Math.max(0, (p.sent ?? 0) - started);
  const left = Math.max(0, p.toSend - (p.sent ?? 0));
  return [
    { n: started, tone: 'run', label: `시작 ${started}` },
    { n: failedOrSkipped, tone: 'bad', label: `보냈지만 시작 못 함 ${failedOrSkipped}` },
    { n: left, tone: 'muted', label: `보낼 차례 ${left}` },
  ].filter((x) => x.n > 0);
}
