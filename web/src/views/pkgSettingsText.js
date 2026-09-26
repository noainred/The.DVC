/**
 * pkgSettingsText.js — 설정 › 에이전트 배포 › 패키지 탭의 저장소 설정 폼(순수 모듈).
 *
 * v2.621(감사 WEB-07): 폼을 서버의 **유효값**(웹 지정 || 환경변수 기본)으로 채우고 두 칸을 모두 보냈다 —
 *   저장 경로만 바꿔 저장해도 환경변수 기본 URL 이 웹 지정값으로 굳어, 그 뒤 portal.env 를 바꿔도 먹지 않았다
 *   (화면은 '비워두면 환경변수 기본값을 사용합니다' 라고 말하면서). 그래서:
 *   · 폼은 **웹 지정값만** 채운다(지정 안 됨 = 빈 칸). 기본값은 placeholder 로 보인다.
 *   · 서버가 지정 여부(`settings.overridden`)를 주지 않으면 유효값으로 채우되 **바뀐 칸만** 보낸다(모르는 것을 굳히지 않는다).
 */

const FIELDS = ['baseUrl', 'dir'];

/** GET /admin/packages 응답 → 폼 { baseUrl, dir, _init, _known }. */
export function pkgFormFromResponse(p) {
  const s = p && typeof p.settings === 'object' && p.settings ? p.settings : null;
  const ov = s && s.overridden && typeof s.overridden === 'object' ? s.overridden : null;
  const form = {};
  for (const k of FIELDS) {
    if (ov) form[k] = ov[k] ? String((s[k] ?? p[k]) || '') : '';
    else form[k] = String((p && p[k]) || '');
  }
  return { ...form, _init: { ...form }, _known: !!ov };
}

/** 폼 → PUT 본문. 지정 여부를 알면 두 칸 모두(빈 칸 = 지정 해제), 모르면 바뀐 칸만. */
export function pkgSavePayload(form) {
  const f = form || {};
  const out = {};
  for (const k of FIELDS) {
    const v = String(f[k] ?? '');
    if (f._known || !f._init || v !== String(f._init[k] ?? '')) out[k] = v;
  }
  return out;
}

/** 칸의 placeholder — 환경변수 기본값(없으면 예시). */
export function pkgPlaceholder(p, key, fallback) {
  const d = p && p.settings && p.settings.defaults ? p.settings.defaults[key] : '';
  return d ? `기본값: ${d}` : fallback;
}
