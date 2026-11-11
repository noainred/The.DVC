/**
 * insights/hwExport/prefs.js — '서버 하드웨어 정보 내보내기' 창의 계정별 기억(v2.966 · 사용자 승인 기본안 6 '계정마다 기억').
 * 저장소 규칙은 util/exportPrefs.js(공장) 머리말 — 파일 CONFIG_DIR/hw-export-prefs.json · 비밀 없음(값 key · 선택값뿐).
 * 이 창은 '기본값'(default) 하나만 쓴다(1~5칸 UI 없음). 기억하는 것: 값(cols) · 형식(fmt) · 법인 표시(band) · 사양서(spec).
 * 대상(물리/가상화)은 창을 연 탭을, 법인은 '모두' 를 늘 기본으로 한다(기억하지 않는다 — 설계 §6-1).
 */
import { createExportPrefs } from '../../util/exportPrefs.js';
import { HW_FIELDS, resolveFields } from './catalog.js';

export const FMTS = Object.freeze(['xlsx', 'csv']);
export const BANDS = Object.freeze(['band', 'sheet', 'col']);

/** 값 목록 검증 — 모르는 key 는 버리고(화이트리스트) 남은 것이 잠긴 값뿐이어도 받는다. */
function resolveCols(cols) {
  if (!Array.isArray(cols)) return { ok: false, reason: '값 목록 형식이 잘못됐습니다.' };
  // 권한(관리자 전용 값)은 내려받을 때 다시 거른다 — 저장은 관리자 판본 기준 목록으로 받는다(관리자가 저장한 값을 잃지 않게).
  return { ok: true, keys: resolveFields(cols, { admin: true }) };
}
function knownKeys(cols) {
  const list = Array.isArray(cols) ? cols : [];
  const keys = list.filter((k) => HW_FIELDS.has(k));
  return { keys, dropped: list.length - keys.length };
}
export function normalizeHwExportOpts(v) {
  const out = {};
  if (v.fmt !== undefined) { if (!FMTS.includes(v.fmt)) return { ok: false, reason: '형식은 엑셀 또는 CSV 입니다.' }; out.fmt = v.fmt; }
  if (v.band !== undefined) { if (!BANDS.includes(v.band)) return { ok: false, reason: '법인 표시 방식이 잘못됐습니다.' }; out.band = v.band; }
  if (v.spec !== undefined) out.spec = v.spec === true;
  return { ok: true, value: out };
}

const P = createExportPrefs({ fileName: 'hw-export-prefs.json', resolveCols, knownKeys, normalizeOpts: normalizeHwExportOpts });
export const { getPrefs, setPref, prefsUnreadable } = P;
export const _resetHwExportPrefsForTest = P._resetForTest;
