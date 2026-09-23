/**
 * 종료 시 flush 레지스트리(v2.582 ARCH-4) — 하나다.
 *
 * 이 서버는 파일 스토어 여러 곳이 **디바운스 저장**(3~10초 뒤 쓰기)을 쓴다. 업그레이드 재시작이 잦은 배포라
 * 그 창에 든 변경은 재시작 때 사라진다. v2.447(감사 I3)이 `central/fleet.js`·`ipam/scanStore.js` 두 곳에
 * 'exit 훅에서 동기 flush' 를 넣었지만 규약이 아니라 **각자 구현**이라 v2.581 시점에 디바운스 저장 8곳 중
 * 훅이 있는 곳은 그 둘뿐이었다 — `security/loginStore.js`(로그인 실패 이력 · 보안 화면 근거) · `central/agentConfig.js`
 * (엣지 설정 사본) · `central/assignments.js`(위임 스캔 결과) · `idrac/invCache.js`(iDRAC 인벤토리 · 파트 장애
 * 판정 입력) · `tool-usage.js` · `security/netIssueStore.js` · `inventory/osStore.js` 는 마지막 창을 잃었다.
 *
 * 규약: 디바운스 저장을 만드는 모듈은 `registerExitFlush(name, fn)` 으로 **동기 flush 함수**를 등록한다
 * (타이머를 지우고 즉시 쓴다). 레지스트리가 `exit` 훅 하나를 건다 — index.js 의 정상 종료(SIGTERM →
 * server.close → process.exit)와 `process.exit` 전부가 `exit` 를 낸다. SIGKILL·정전은 어떤 훅도 못 막는다
 * (그 경우는 원자 쓰기 규약이 '절단본' 을 막을 뿐이다).
 * ⚠ 시그널 핸들러를 여기서 만들지 말 것 — 종료 결정은 index.js gracefulExit 한 곳이다(v2.447).
 * ⚠ flush 는 **동기**여야 한다 — `exit` 훅에서 비동기 작업은 실행되지 않는다.
 */
const _reg = new Map(); // name -> fn
let _hooked = false; let _ran = false;

export function registerExitFlush(name, fn) {
  if (typeof fn !== 'function') throw new TypeError('registerExitFlush: fn 은 함수여야 한다');
  _reg.set(String(name), fn);
  if (!_hooked) {
    _hooked = true;
    try { process.once('exit', () => { runExitFlush('exit'); }); } catch { /* */ }
  }
  return () => { _reg.delete(String(name)); };
}

/** 등록된 flush 를 전부(순서대로) 1회 실행한다. 실패는 이름과 함께 경고하고 다음으로 넘어간다. */
export function runExitFlush(reason = 'manual') {
  if (_ran) return { ran: 0, skipped: true };
  _ran = true;
  let ran = 0;
  for (const [name, fn] of _reg) {
    try { fn(); ran++; } catch (e) { try { console.warn(`[exit-flush] ${name} 실패(${reason}): ${e?.message || e}`); } catch { /* */ } }
  }
  return { ran, skipped: false };
}

export function exitFlushNames() { return [..._reg.keys()]; }
/** 테스트 전용 — 등록·실행 상태 초기화(훅은 그대로 둔다). */
export function _resetExitFlushForTest() { _reg.clear(); _ran = false; }
