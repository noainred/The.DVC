/**
 * insights/dbGuide.js — '특수 기능 › 포탈 DB' 의 '자세히' 팝업 설명(v2.674).
 *
 * 사용자 요청: "각각의 DB 의 용도를 처음 사용하는 사람이 이해할 수 있는 수준으로 최대한 자세하게 · 자세히 버튼을 누르면 팝업".
 * 파일마다 코드를 읽어 확인한 내용으로 썼다(근거 파일은 sources). 확인하지 못한 것은 '(추정)' 으로 밝혔다.
 * 표의 한 줄 설명(portalDb.js PURPOSES)과 달리 화면 폴링 응답에 싣지 않는다 — 팝업을 열 때 한 파일만 가져간다.
 *
 * ⚠ 문구에 백틱·별표 두 개를 쓰지 말 것(화면에 글자로 샌다). 파일·키 인용은 ‘ ’.
 * ⚠ 새 데이터 파일을 PURPOSES 에 더하면 여기에도 더할 것 — test/portalDbGuide2674.test.js 가 빠진 것을 잡는다.
 */
import { DB_GUIDE_DATA } from './dbGuideData.js';

export const GUIDE_FIELDS = ['title', 'summary', 'stores', 'writer', 'usedBy', 'retention', 'growth', 'shrink', 'ifDeleted', 'cautions', 'settings', 'sources'];
const LIST_FIELDS = new Set(['stores', 'usedBy', 'cautions', 'settings', 'sources']);

/** 파일명 하나의 설명(없으면 null). 모르는 필드는 버리고 모양을 고정한다. */
export function guideFor(name) {
  const key = String(name || '');
  if (!Object.hasOwn(DB_GUIDE_DATA, key)) return null;
  const g = DB_GUIDE_DATA[key];
  const out = { file: key };
  for (const f of GUIDE_FIELDS) {
    const v = g?.[f];
    if (LIST_FIELDS.has(f)) out[f] = Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : (typeof v === 'string' && v.trim() ? [v] : []);
    else out[f] = typeof v === 'string' ? v : '';
  }
  return out;
}

/** 설명이 있는 파일 목록(정렬). */
export function guideFiles() { return Object.keys(DB_GUIDE_DATA).sort(); }
