/**
 * version_5/route.js — V5 셸 진입·이탈 판정(순수, v2.616).
 *
 * V5 는 **새 라우터가 아니라 기존 라우터 위의 새 틀(chrome)** 이다 — 주소는 개발 포탈과 같다
 * (#/vms, #/tools/<k>, #/settings/…). 그래서 '지금 V5 로 그리는가' 는 해시가 아니라 **브라우저에
 * 저장한 셸 플래그**가 정한다. `#/v5` 는 그 플래그를 켜는 진입 신호일 뿐이고, App 이 소비한 뒤
 * `#/overview`(또는 `#/v5/<탭>` 이면 그 탭)로 바꾼다.
 *
 * ⚠ localStorage 는 프라이빗 창·저장 차단에서 **throw** 한다 — 전부 try/catch(V4 mode.js 와 같은 규약).
 *   못 읽으면 V5 가 아니다(기존 화면이 안전한 기본값이다).
 * ⚠ V4(#/v4)·관제 콘솔(#/console) 판정이 먼저다 — 그 셸은 자체 라우팅을 갖는다.
 */

export const SHELL_KEY = 'ui.shell';
export const SHELL_V5 = 'v5';

const firstSeg = (hash) => String(hash || '').replace(/^#\/?/, '').split('/')[0];

/** 해시가 V5 진입 신호(#/v5, #/v5/<탭>)인가. */
export const isV5Hash = (hash) => firstSeg(hash) === 'v5';

/**
 * 진입 신호 → 실제로 보여 줄 기존 주소. `#/v5` → `#/overview`, `#/v5/vms` → `#/vms`,
 * `#/v5/tools/storage-mon` → `#/tools/storage-mon`.
 */
export function v5EntryTarget(hash) {
  const rest = String(hash || '').replace(/^#\/?v5\/?/, '');
  return rest ? `#/${rest}` : '#/overview';
}

const store = (s) => {
  if (s) return s;
  try { return globalThis.localStorage || null; } catch { return null; }
};

/** 저장된 셸이 V5 인가. 못 읽으면 false. */
export function readShell(storage) {
  try { return store(storage)?.getItem(SHELL_KEY) === SHELL_V5; } catch { return false; }
}

/** 셸 플래그 쓰기. 실패해도 조용히 넘기되 결과를 돌려준다(호출자가 이번 세션 상태로만 쓴다). */
export function writeShell(on, storage) {
  try {
    const s = store(storage);
    if (!s) return false;
    if (on) s.setItem(SHELL_KEY, SHELL_V5); else s.removeItem(SHELL_KEY);
    return true;
  } catch { return false; }
}
