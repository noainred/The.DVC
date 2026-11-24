/**
 * remote/windowGeo.js — 원격 콘솔 창의 위치 · 크기(순수 — RemoteConsoleWindow 가 쓴다).
 *
 * 릴리스 전 Chromium 검증(132~135회차 묶음 · 400px): 창은 기본 x=140 · 폭 860px 이라 휴대폰 폭에서는 오른쪽 절반 이상이 화면 밖이었다 —
 *   '재시도' · 탭 닫기 · 최대화 버튼을 누를 수 없었다(페이지 가로 넘침은 0 — position:fixed 라 수치로는 안 잡힌다). 화면보다 큰 창은 화면에 맞춘다.
 *   · 최대화 · 좁은 화면(NARROW_PX 미만 — 창 모드가 의미 없는 폭)은 화면 전체(여백 8px).
 *   · 그 밖에는 저장된 위치 · 크기를 화면 안으로 당긴다(크기는 화면 − 16px 를 넘지 않고, 위치는 창 전체가 보이게).
 *   저장된 값(win.x · y · w · h)은 바꾸지 않는다 — 화면이 다시 넓어지면 원래 자리로 돌아온다.
 */
export const NARROW_PX = 640;
const MARGIN = 8;
const FULL = Object.freeze({ left: MARGIN, top: MARGIN, width: `calc(100vw - ${MARGIN * 2}px)`, height: `calc(100vh - ${MARGIN * 2}px)` });

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * @param {{maximized?:boolean, x?:number, y?:number, w?:number, h?:number}} win
 * @param {number} vw 뷰포트 폭(모르면 넓은 화면으로 본다)
 * @param {number} vh 뷰포트 높이
 * @returns {{left:number, top:number, width:number|string, height:number|string}}
 */
export function remoteWindowGeo(win, vw, vh) {
  const W = num(vw, 1440); const H = num(vh, 900);
  if (win?.maximized || W < NARROW_PX) return { ...FULL };
  const w = Math.max(1, Math.min(num(win?.w, 860), W - MARGIN * 2));
  const h = Math.max(1, Math.min(num(win?.h, 560), H - MARGIN * 2));
  const left = Math.max(MARGIN, Math.min(num(win?.x, 140), W - w - MARGIN));
  const top = Math.max(MARGIN, Math.min(num(win?.y, 88), H - h - MARGIN));
  return { left, top, width: w, height: h };
}

/** 창 모드(끌기 · 크기 조절 손잡이)를 쓸 수 있는 화면인가 — 좁은 화면은 늘 화면 전체다. */
export const windowModeAvailable = (vw) => num(vw, 1440) >= NARROW_PX;
