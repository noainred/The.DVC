/**
 * views/authSkipText.js — v2.591(감사 F1·F2·F4·F5) 인증 실패 정지를 **보조 수집기·게스트 계정·메일·네트워크 모니터**
 * 화면이 말하게 하는 문구(순수). 규칙은 `tools/storageAuthText.js authStopInfo` 와 같다:
 *  · 조용히 멈추지 않는다 — 무엇을 왜 건너뛰었는지 개수와 함께 말한다.
 *  · 원인을 단정하지 않는다 — '인증 실패로 멈춘 상태' 까지만 말하고 조치(계정 수정·연결 테스트)를 적는다.
 *  · 수동 실행은 막지 않는다는 사실을 말한다(버튼이 있는 화면만).
 * 문구는 BoldText 로 그린다(강조는 별표 두 개). ⚠ 백틱 금지 — BoldText 는 강조만 해석한다(값 인용은 ‘ ’).
 * 판정·문구를 여기 모아 vitest 로 고정한다(웹 테스트는 node 환경이라 컴포넌트 렌더 불가 — CLAUDE.md 규약).
 */
import { authStopInfo, topicOf } from './tools/storageAuthText.js';

const n0 = (v) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : 0);

/** 이름 목록 요약 — 앞 4개 + '외 N곳'. */
function names(list, unit = '곳') {
  const arr = (list || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!arr.length) return '';
  const head = arr.slice(0, 4);
  return `(${head.join(' · ')}${arr.length > head.length ? ` 외 ${arr.length - head.length}${unit}` : ''})`;
}

/**
 * vCenter 계정이 인증 실패로 멈춰 **이 보조 수집도 로그인하지 않은** vCenter 들(F1).
 * 입력은 도구마다 모양이 달라 둘 다 받는다 — ① `{vcenterId, why:'auth-stopped'}` 가 섞인 건너뜀 목록
 * (curuser `skippedVcenters`·vmseries `skipped`) ② 정지된 것만 담긴 목록(guestdisk `authStopped`).
 * @param {Array<object>} list
 * @param {{what?: string, manual?: string}} [opts] what — 무엇이 로그인하지 않았나('현재 사용자 수집' …)
 * @returns {string} 해당 없으면 ''
 */
export function vcAuthSkipNote(list, { what = '이 수집', manual = '' } = {}) {
  const arr = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object' && (x.why === undefined || x.why === 'auth-stopped'));
  if (!arr.length) return '';
  const manualNote = manual ? ` '${manual}'${topicOf(manual)} 막지 않습니다(1회 시도 — 성공하면 풀립니다).` : '';
  return `**vCenter ${arr.length}곳은 인증 실패로 수집이 멈춘 상태라 ${what}도 로그인하지 않았습니다**${names(arr.map((x) => x.name || x.vcenterId))}.`
    + ' 같은 vCenter 계정을 쓰기 때문입니다(반복 로그인은 **계정을 잠급니다**). 설정 › vCenter 에서 비밀번호를 고치거나 연결 테스트가 성공하면 다시 시작합니다.'
    + manualNote;
}

/**
 * 게스트 계정 조사(OS 판별 스캐너 `lastAuth` · 게스트 스캔 작업 `lastAuth`)의 인증 관련 결과(F2).
 * 두 모양을 다 받는다 — vcStopped 가 배열(OS 스캐너)이거나 객체(게스트 스캔), 차단기가 `breakerTripped`/`breakerSkipped`
 * (OS 스캐너)이거나 `breaker:{threshold,tripped,skipped}`(게스트 스캔).
 * @param {object|null} a lastAuth
 * @param {{manual?: string}} [opts]
 * @returns {string[]} 문장 목록(없으면 빈 배열) — 화면이 줄마다 BoldText 로 그린다
 */
export function guestAuthLines(a, { manual = '' } = {}) {
  if (!a || typeof a !== 'object') return [];
  const out = [];
  const vcs = Array.isArray(a.vcStopped) ? a.vcStopped : (a.vcStopped ? [a.vcStopped] : []);
  if (vcs.length) {
    out.push(`**vCenter 인증 실패로 로그인하지 않았습니다**${names(vcs.map((x) => x.vcenterId).filter(Boolean))} — 같은 vCenter 계정을 쓰므로 주 수집이 멈추면 이 조사도 멈춥니다. 설정 › vCenter 에서 고치면 다시 시작합니다.`);
  }
  if (a.jobStopped) {
    const st = a.jobStopped;
    out.push(`**작업 계정이 인증 실패로 주기 실행을 멈췄습니다**${n0(st.attempts) ? `(실패 ${n0(st.attempts)}회)` : ''} — 게스트 계정·비밀번호를 고치면 자동으로 다시 시작합니다.${manual ? ` '${manual}'${topicOf(manual)} 막지 않습니다.` : ''}`);
  }
  const trippedN = Array.isArray(a.breakerTripped) ? a.breakerTripped.length : (a.breaker?.tripped?.length || 0);
  const breakerSkipped = n0(a.breakerSkipped ?? a.breaker?.skipped);
  const threshold = n0(a.breaker?.threshold) || 3;
  if (trippedN || breakerSkipped) {
    out.push(`**같은 게스트 계정의 거부가 연속 ${threshold}회라 남은 VM ${breakerSkipped}대를 시작하지 않았습니다** — 한 실행에서 수백 대에 같은 틀린 비밀번호로 로그인하면 계정이 잠깁니다.`);
  }
  if (n0(a.vmStopped)) out.push(`게스트 로그인 거부 ${n0(a.vmStopped)}대 — 그 VM 은 계정을 고칠 때까지 다음 주기부터 건너뜁니다.`);
  if (n0(a.vmSkipped)) out.push(`직전 거부로 이번 주기에 건너뛴 VM ${n0(a.vmSkipped)}대(계정을 고치면 자동 재개).`);
  return out;
}

/** 메일 자동 발송 정지(F4) — 설정 › 메일 발송. 없으면 ''. */
export function mailAuthStopText(stop, now = Date.now()) {
  return authStopInfo(stop, { what: '메일', activity: '자동 발송', manual: '메일 테스트', now })?.text || '';
}

/**
 * 네트워크 연속 모니터의 정지 표지(F5). `authStopped` 는 `{A?:stop, B?:stop}`.
 * @returns {null | {label:string, title:string}}
 */
export function netmonStopBadge(authStopped, now = Date.now()) {
  if (!authStopped || typeof authStopped !== 'object') return null;
  const sides = ['A', 'B'].filter((k) => authStopped[k]);
  if (!sides.length) return null;
  const title = sides.map((k) => authStopInfo(authStopped[k], { what: `${k} 서버`, activity: '주기 실행', manual: '지금', now })?.text || '')
    .join(' ').replace(/\*\*/g, '');   // title 속성은 BoldText 를 거치지 않는다 — 별표를 뺀다
  return { label: `인증 실패 정지(${sides.join('·')})`, title };
}

/**
 * VM 복제 최근 실행 표시(F1) — 인증 정지로 **건너뛴** 실행은 실패(⛔)도 성공(✅)도 아니다.
 * @returns {{icon:string, tone:'green'|'red'|'amber'}}
 */
export function cloneRunMark(lastRun) {
  if (!lastRun) return { icon: '', tone: 'green' };
  if (lastRun.skipped) return { icon: '⏸', tone: 'amber' };
  return lastRun.ok ? { icon: '✅', tone: 'green' } : { icon: '⛔', tone: 'red' };
}
