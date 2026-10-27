/**
 * vcenter/vmExportPrefs.js — 'VM 전체 정보 내보내기' 내 저장값(계정별 기본값 + 1~5칸, v2.799).
 * 저장소 규칙은 util/exportPrefs.js(공장) 머리말 — 파일 CONFIG_DIR/vm-export-prefs.json · 비밀 없음.
 * 선택값(사람이 '저장할 내용' 에서 고른 것만 실린다): fmt(형식) · disk·tagCols(표기 방식) · live(실시간 보강) · target·folder·tmpl(대상).
 */
import { createExportPrefs } from '../util/exportPrefs.js';
import { resolveCols, knownKeys } from './vmExportCatalog.js';

export const FMTS = Object.freeze(['csv', 'xlsx']);
export const DISK_MODES = Object.freeze(['slots', 'join']);
export const TARGETS = Object.freeze(['all', 'on', 'folder']);
export const FOLDER_MAX = 512;

/** 선택값 검증 — 있으면 형식만 본다(없는 것은 싣지 않는다). */
export function normalizeVmExportOpts(v) {
  const out = {};
  if (v.fmt !== undefined) { if (!FMTS.includes(v.fmt)) return { ok: false, reason: '형식은 CSV 또는 엑셀입니다.' }; out.fmt = v.fmt; }
  if (v.disk !== undefined) { if (!DISK_MODES.includes(v.disk)) return { ok: false, reason: '디스크 표기 방식이 잘못됐습니다.' }; out.disk = v.disk; }
  if (v.tagCols !== undefined) out.tagCols = v.tagCols === true;
  if (v.live !== undefined) out.live = v.live === true;
  if (v.target !== undefined) { if (!TARGETS.includes(v.target)) return { ok: false, reason: '대상이 잘못됐습니다.' }; out.target = v.target; }
  if (v.folder !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (typeof v.folder !== 'string' || v.folder.length > FOLDER_MAX || /[\x00-\x1f\x7f]/.test(v.folder)) return { ok: false, reason: '폴더 경로 형식이 잘못됐습니다.' };
    out.folder = v.folder;
  }
  if (v.tmpl !== undefined) out.tmpl = v.tmpl !== false;
  return { ok: true, value: out };
}

const P = createExportPrefs({ fileName: 'vm-export-prefs.json', resolveCols, knownKeys, normalizeOpts: normalizeVmExportOpts });
export const { getPrefs, setPref, clearPref, prefsUnreadable } = P;
export const _resetVmExportPrefsForTest = P._resetForTest;
