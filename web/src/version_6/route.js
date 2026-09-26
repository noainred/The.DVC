/**
 * version_6/route.js — V6 셸 진입·이탈·메뉴 주소 판정(순수, v2.623).
 *
 * V6 도 V5 처럼 **새 라우터가 아니라 기존 라우터 위의 새 틀**이다(주소는 개발 포탈과 같다 — #/vms, #/tools/<k>).
 * '지금 V6 로 그리는가' 는 브라우저에 저장한 셸 플래그(`ui.shell = 'v6'`)가 정한다. V5 와 **같은 키**를 쓰므로
 * 두 셸은 동시에 켜질 수 없다(한쪽을 켜면 다른 쪽 값이 덮인다).
 * V6 에만 있는 것은 **메뉴 페이지 주소** `#/m/<메뉴>`(서버 메뉴는 `#/m/server/<구분>`)다. 이 주소는 기존 탭이 아니므로
 * App 의 해시 동기화가 덮어쓰지 않게 `isMenuHash` 로 따로 판정한다.
 * ⚠ localStorage 는 프라이빗 창·저장 차단에서 throw 한다 — 전부 try/catch. 못 읽으면 V6 가 아니다.
 */
import { SHELL_KEY } from '../version_5/route.js';

export const SHELL_V6 = 'v6';
export const SERVER_SEGS = Object.freeze(['phys', 'host', 'vm']);

const segsOf = (hash) => String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);

/** 해시가 V6 진입 신호(#/v6, #/v6/<탭>)인가. */
export const isV6Hash = (hash) => segsOf(hash)[0] === 'v6';

/** 진입 신호 → 실제 주소. `#/v6` → `#/overview`, `#/v6/m/server` → `#/m/server`. */
export function v6EntryTarget(hash) {
  const rest = String(hash || '').replace(/^#\/?v6\/?/, '');
  return rest ? `#/${rest}` : '#/overview';
}

/** 메뉴 페이지 주소인가 — 맞으면 {menuId, seg}, 아니면 null. 모르는 구분 값은 '' 로 본다(전체). */
export function parseMenuHash(hash) {
  const s = segsOf(hash);
  if (s[0] !== 'm' || !s[1]) return null;
  const menuId = s[1];
  const seg = menuId === 'server' && SERVER_SEGS.includes(s[2]) ? s[2] : '';
  return { menuId, seg };
}
export const isMenuHash = (hash) => parseMenuHash(hash) != null;
export const menuHash = (menuId, seg = '') => (seg ? `#/m/${menuId}/${seg}` : `#/m/${menuId}`);

const store = (s) => {
  if (s) return s;
  try { return globalThis.localStorage || null; } catch { return null; }
};

/** 저장된 셸이 V6 인가. 못 읽으면 false. */
export function readShellV6(storage) {
  try { return store(storage)?.getItem(SHELL_KEY) === SHELL_V6; } catch { return false; }
}

/** V6 플래그 쓰기. 끌 때는 V6 값일 때만 지운다(V5 로 바꾼 뒤 V6 를 끄는 경로가 V5 까지 끄지 않게). */
export function writeShellV6(on, storage) {
  try {
    const s = store(storage);
    if (!s) return false;
    if (on) s.setItem(SHELL_KEY, SHELL_V6);
    else if (s.getItem(SHELL_KEY) === SHELL_V6) s.removeItem(SHELL_KEY);
    return true;
  } catch { return false; }
}
