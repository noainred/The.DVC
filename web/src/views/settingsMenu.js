/**
 * views/settingsMenu.js — 설정 화면 왼쪽 목록의 순수 로직(v2.916, 설계 docs/design/settings-menu §4 — A안 + 상태 요약).
 *
 * Settings.jsx 는 화면만 그리고, 검색 · 묶음 접기 · 상태 배지 문구 · 최근/즐겨찾기 정리는 여기서 한다(vitest 로 고정).
 * 상태 등급은 서버 settingsStatus/grade.js 가 정한다 — 여기서 새로 판정하지 않는다(판정 코어는 하나).
 */

/** 서버 등급 → 배지 모양. 등급이 없으면(정상) 배지를 그리지 않는다. */
export const BADGE = Object.freeze({
  unset: { tone: 'unset', short: '미설정' },
  warn: { tone: 'warn', short: '주의' },
  new: { tone: 'new', short: '새 버전' },
  off: { tone: 'off', short: '꺼짐' },
  unknown: { tone: 'unknown', short: '?' },
});

/** 요약 칩 순서(B안 '상태 요약'). 꺼짐은 장애가 아니라 맨 뒤 · 흐리게. */
export const SUMMARY_ORDER = Object.freeze(['unset', 'warn', 'new', 'unknown', 'off']);
export const SUMMARY_LABEL = Object.freeze({ unset: '미설정', warn: '주의', new: '새 버전', unknown: '못 읽음', off: '꺼짐' });

/** 항목 하나의 배지(없으면 null). 주의는 수가 있으면 수를 붙인다. */
export function badgeOf(st) {
  if (!st || !BADGE[st.grade]) return null;
  const b = BADGE[st.grade];
  const short = st.grade === 'warn' && Number.isFinite(st.count) && st.count > 0 ? `주의 ${st.count}` : b.short;
  return { tone: b.tone, short, text: String(st.text || b.short) };
}

/** 등급별 항목 수(보이는 항목만). */
export function summarize(items, statusItems) {
  const out = { unset: 0, warn: 0, new: 0, unknown: 0, off: 0 };
  if (!statusItems) return out;
  for (const it of items) {
    const g = statusItems[it.k]?.grade;
    if (g && g in out) out[g] += 1;
  }
  return out;
}

/** 묶음 하나의 표지 — 목록 머리 점(주의 > 미설정 > 새 버전). */
export function groupTone(groupItems, statusItems) {
  const s = summarize(groupItems, statusItems);
  if (s.warn) return 'warn';
  if (s.unset) return 'unset';
  if (s.new) return 'new';
  if (s.unknown) return 'unknown';
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * 검색 — 항목 이름 · 설명 · 묶음 이름 · 키(주소)에서 찾는다. 낱말을 공백으로 나눠 **모두** 들어 있어야 맞다.
 * 이름이 맞는 항목을 설명만 맞는 항목보다 앞에 둔다(같으면 원래 순서).
 */
export function searchItems(items, query, groupLabel = {}) {
  const words = norm(query).split(' ').filter(Boolean).slice(0, 8);
  if (!words.length) return items;
  const scored = [];
  items.forEach((it, i) => {
    const label = norm(it.label); const hay = `${label} ${norm(it.desc)} ${norm(groupLabel[it.group])} ${it.k}`;
    if (!words.every((w) => hay.includes(w))) return;
    scored.push({ it, i, rank: words.every((w) => label.includes(w)) ? 0 : 1 });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.it);
}

/** 상태 칩으로 거른 목록. grade 가 없으면 그대로. */
export function filterByGrade(items, statusItems, grade) {
  if (!grade) return items;
  if (!statusItems) return [];
  return items.filter((it) => statusItems[it.k]?.grade === grade);
}

/** 최근 연 항목 — 맨 앞에 넣고 중복 제거 · 보이는 키만 · 최대 n 개. */
export function pushRecent(list, k, valid, n = 5) {
  const ok = new Set(valid);
  return [k, ...(Array.isArray(list) ? list : []).filter((x) => x !== k)].filter((x) => ok.has(x)).slice(0, n);
}

/** 즐겨찾기 토글(최대 12개 — 목록 머리가 길어지지 않게). */
export function toggleFav(list, k, max = 12) {
  const cur = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  return cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k].slice(-max);
}

/** 저장된 목록 읽기 — 깨진 값 · 모르는 키는 버린다(브라우저 저장소는 사람이 고칠 수 있다). */
export function readKeyList(raw, valid, max = 12) {
  let v = null;
  try { v = JSON.parse(raw); } catch { v = null; }
  if (!Array.isArray(v)) return [];
  const ok = new Set(valid);
  return [...new Set(v.filter((x) => typeof x === 'string' && ok.has(x)))].slice(0, max);
}

/** '/' 단축키를 받을 것인가 — 입력 중이거나 조합 키면 받지 않는다. */
export function isSearchHotkey(e) {
  if (!e || e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  const t = e.target;
  const tag = String(t?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable) return false;
  return true;
}
