/**
 * usageTracker.js — 기능 사용 추적(화면 쪽, v2.913 · 설계 docs/design/feature-usage §4.2·§4.6).
 *
 * 무엇을 보내나: 주소(#/…)가 가리키는 **화면 키** 하나와, 그 화면을 보고 있던 시간.
 *   · 열람(hit) — 키가 바뀌고 **1초 이상 머물면** 1회(메뉴를 훑으며 지나간 화면은 세지 않는다). 같은 화면 새로고침은 서버가 2초 안 중복을 한 번으로 센다.
 *   · 머문 시간(ms) — 창이 보이고(visibilityState) **마지막 입력 뒤 idleMs 이내**인 시간만 1초 단위로 더해 30초마다 보낸다(전역 요청 상한이 IP 기준이라 — 프록시 뒤 50명이면 10초 주기는 분당 300회를 더한다). 창이 가려지면 그때까지 보낸다.
 *   검색어 · 입력 값 · 조회한 장비 · 화면 안 버튼은 보내지 않는다(사용자 선택 '열람 횟수 + 머문 시간').
 * 주소를 1초마다 읽는다 — 하위 탭이 `history.replaceState` 로 주소를 채우면 hashchange 가 오지 않기 때문이다(useHashTab 진입 규칙).
 * 전송은 조용히(api.js 헬퍼를 쓰지 않는다 — 401 전역 처리 · 진행 표시에 올리지 않는다 · sessionActivity.js 와 같은 판단). 실패는 버린다(재시도 폭주 금지).
 * 입력 사건 목록은 sessionActivity.js ACTIVITY_EVENTS 하나(유휴 로그아웃 · 서버 활동 신호와 같은 판정).
 *
 * 키(서버 usage/keys.js 가 아는 것만 받는다 — 모르면 서버가 버리고 센다):
 *   tab:<id> · tool:<k>[/baremetal] · settings:<k> · console:<page>
 */

export const POLL_MS = 1_000;
export const STABLE_MS = 1_000;
export const BEAT_MS = 30_000;
/** 한 번의 틱에 더할 수 있는 최대 시간 — 노트북 절전 · 탭 일시정지 뒤 깨어난 첫 틱이 몇 시간을 더하지 않게. */
export const MAX_TICK_MS = 3_000;

/** 셋째 조각까지 키로 남기는 도구(topMenu.js 의 seg 항목 — 서버 usage/keys.js TOOL_SEGS 와 같다). */
export const TOOL_SEGS = Object.freeze({ serveranalysis: ['baremetal'] });

const SEG_RE = /^[a-z0-9-]{1,40}$/;

/**
 * 주소 → 화면 키. 모르면 null(보내지 않는다).
 * @param {string} hash  예: '#/tools/vmfinder' · '#/settings/audit' · '#/vms' · '#/console/compute'
 */
export function usageKeyFromHash(hash) {
  const segs = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [a, b, c] = segs;
  if (!a || !SEG_RE.test(a)) return null;
  if (a === 'console') return `console:${b && SEG_RE.test(b) ? b : 'overview'}`;
  if (a === 'tools') {
    if (!b) return 'tab:tools';
    if (!SEG_RE.test(b)) return null;
    return c && (TOOL_SEGS[b] || []).includes(c) ? `tool:${b}/${c}` : `tool:${b}`;
  }
  if (a === 'settings') return b && SEG_RE.test(b) ? `settings:${b}` : 'tab:settings';
  return `tab:${a}`;
}

/**
 * 추적기(순수 — 시계 · 주소 · 보임 · 전송을 주입받는다. 웹 테스트는 node 환경이다).
 * @param {{ send:(body:{k:string,hit?:boolean,ms?:number}, opts?:{final?:boolean})=>void, now?:()=>number, getHash?:()=>string,
 *           isVisible?:()=>boolean, idleMs?:number }} o
 */
export function createUsageTracker({ send, now = () => Date.now(), getHash = () => window.location.hash, isVisible = () => true, idleMs = 5 * 60_000 } = {}) {
  const t0 = now();
  let committed = null;      // 지금 세고 있는 화면
  let candidate = null;      // 바뀐 주소(아직 1초 머물지 않음)
  let candidateSince = 0;
  let lastInput = t0;
  let lastTick = t0;
  let acc = 0;               // 아직 보내지 않은 머문 시간

  const flush = (final = false) => {
    if (!committed || acc < 1) { acc = 0; return; }
    const ms = Math.round(acc);
    acc = 0;
    send({ k: committed, ms }, { final });
  };

  return {
    /** POLL_MS 마다 부른다. */
    tick() {
      const t = now();
      const dt = Math.max(0, Math.min(t - lastTick, MAX_TICK_MS));
      lastTick = t;
      if (committed && isVisible() && t - lastInput <= idleMs) acc += dt;
      const key = usageKeyFromHash(getHash());
      if (key !== committed) {
        if (key && key === candidate) {
          if (t - candidateSince >= STABLE_MS) {
            flush();
            committed = key; candidate = null;
            send({ k: key, hit: true });
          }
        } else { candidate = key; candidateSince = t; }
      } else candidate = null;
      if (acc >= BEAT_MS) flush();
    },
    /** 키 · 마우스 · 스크롤 · 터치 입력. */
    input() { lastInput = now(); },
    /** 창이 가려지거나(visibilitychange) 페이지를 떠날 때 — 모아 둔 시간을 지금 보낸다. */
    hidden() { flush(true); },
    stop() { flush(true); },
    /** 테스트용 상태. */
    _state: () => ({ committed, candidate, acc }),
  };
}

/** 서버로 조용히 보낸다(응답을 보지 않는다). 토큰이 없으면(인증 꺼짐) 헤더 없이 — 서버가 인증 상태를 판정한다. */
export function sendUsage(token, body, { final = false } = {}, fetchImpl = globalThis.fetch) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    Promise.resolve(fetchImpl('/api/usage/track', { method: 'POST', headers, body: JSON.stringify(body), keepalive: final }))
      .catch(() => { /* 버린다 — 다음 신호가 이어서 센다 */ });
  } catch { /* fetch 자체가 없거나 던짐 — 버린다 */ }
}
