/**
 * v2.733(점검 3회차 C5-02): 조회 실패 문구 — 순수 모듈(화면·테스트가 같이 쓴다).
 *
 * 예전에는 Edge 설치(배포 대상·설치 패키지)·수집 서버(수신 통계·개별 토큰)·GPU 게스트(vCenter 목록)·VM 생성(원본 목록)이
 * 조회 실패를 catch 에서 빈 기본값으로 바꿔 **'0개'·'없음'·'패키지를 찾을 수 없습니다'** 로 그렸다(재현). 관리자는 그것을 보고
 * 대상 재등록·tarball 재배치·토큰 재발급 같은 **틀린 조치**를 한다. 실패는 '읽지 못했습니다 + 사유' 로 따로 말한다.
 * 사유는 ErrorBox 와 같은 정규화(errorBoxInput)를 거친다 — 403 은 '권한이 없다' 로 말한다(권한 안내 규약).
 */
import { errorBoxInput } from '../components/accessDeniedText.js';

/** 목적격 조사 — 마지막 글자가 한글이면 받침으로 고르고, 아니면 '을(를)'(영문 끝은 받침을 알 수 없다). */
export function objParticle(word) {
  const s = String(word ?? '').trim();
  const c = s ? s.charCodeAt(s.length - 1) : 0;
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? '을' : '를';
  return '을(를)';
}

/** 실패 사유 한 줄(빈 값이면 '사유 미상'). */
export function readFailReason(err) {
  const t = errorBoxInput(err).text;
  return t && t.trim() ? t.trim() : '사유 미상';
}

/** 403(권한 거부)인가 — errorBoxInput 이 HttpError 의 status 로 판정한다. */
export function readFailDenied(err) {
  return !!errorBoxInput(err).perm;
}

/**
 * 조회 실패 → 화면 문장.
 * @param {string} what  읽으려던 것('저장된 배포 대상 목록' 처럼 조사 없이)
 * @param {*} err         오류(Error·HttpError·문자열)
 * @param {{ notMeaning?: string, stale?: boolean }} opt
 *   notMeaning — 빈 값으로 읽히면 안 되는 뜻('대상이 없다는 뜻이 아닙니다')
 *   stale      — 직전에 읽은 값이 화면에 남아 있다(다시 읽기만 실패)
 * @returns {string|null} err 가 없으면 null
 */
export function readFailText(what, err, { notMeaning = '0개라는 뜻이 아닙니다', stale = false } = {}) {
  if (err == null || err === '') return null;
  const why = readFailReason(err);
  const p = objParticle(what);
  if (readFailDenied(err)) return `${what}${p} 볼 권한이 없습니다(${why}) — ${notMeaning}.`;
  if (stale) return `${what}${p} 다시 읽지 못했습니다(${why}) — 아래는 직전에 읽은 값입니다.`;
  return `${what}${p} 읽지 못했습니다(${why}) — ${notMeaning}.`;
}

/**
 * Edge 설치 › 설치 패키지 상태(순수). 예전에는 조회 실패를 `{ available:false }` 로 지어내
 * '설치 패키지를 찾을 수 없습니다 — download/ 에 offline tarball 을 두세요'(틀린 원인)를 말하고 배포 버튼을 잠갔다.
 * 실패면 'unknown' 이고 배포는 막지 않는다 — 서버(deployAgent)가 패키지를 다시 찾고 없으면 사유와 함께 거부한다.
 * @returns {{ kind:'loading'|'ok'|'missing'|'unknown', canDeploy:boolean, text:string|null }}
 */
export function installerState(installer, err) {
  if (installer && typeof installer === 'object' && installer.available === true) return { kind: 'ok', canDeploy: true, text: null };
  if (installer && typeof installer === 'object' && installer.available === false) return { kind: 'missing', canDeploy: false, text: null };
  if (err != null && err !== '') {
    return {
      kind: 'unknown', canDeploy: true,
      text: `${readFailText('설치 패키지 상태', err, { notMeaning: '패키지가 없다는 뜻이 아닙니다' })} 배포를 누르면 서버가 패키지를 다시 확인합니다(없으면 사유와 함께 거부합니다).`,
    };
  }
  return { kind: 'loading', canDeploy: false, text: null };
}

/**
 * 수집 서버 › 엣지별 개별 central 토큰 요약(순수). 예전에는 조회 실패를 `setAgentTok(null)` 로 비워 '(0개 발급)' 이라 했다.
 * 직전에 읽은 값이 있으면 그것을 쓰고 다시 읽기 실패를 덧붙인다.
 */
export function agentTokSummary(agentTok, err) {
  const ok = agentTok && typeof agentTok === 'object';
  const failed = err != null && err !== '';
  if (!ok) return failed ? '발급 현황을 읽지 못함' : '불러오는 중…';
  const n = Array.isArray(agentTok.tokens) ? agentTok.tokens.length : 0;
  const uses = Number(agentTok.auth?.uses);
  return `${n}개 발급${Number.isFinite(uses) && uses > 0 ? ` · 공유 토큰 사용 ${uses}회` : ''}${failed ? ' · 다시 읽지 못함(직전 값)' : ''}`;
}
