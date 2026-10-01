import { gridIntro } from './toolVisibility.js';

/**
 * views/toolSections.js — 특수 기능 카드를 카테고리 섹션으로 나눈다 (순수, v2.455).
 *
 * 요구: "특수기능에 기능이 너무 많아서 카테고리로 묶어 보여줄 수 있게. **1개 기능을 중복해서
 * 여러 카테고리에 넣을 수 있게.**" — 도구 목록은 specialToolsList.js 의 전부다(개수를 여기 적지 않는다 — v2.613 CATALOG2613-11:
 * 주석의 숫자는 매 릴리스 낡는다. '몇 개' 는 산문이 아니라 TOOLS.length 다).
 *
 * 화면 배치 계산이라 웹에 둔다(서버 `toolcats/` 는 저장·검증·프리셋만 소유한다 — 같은 로직을
 * 양쪽에 두면 어긋나는 날이 온다). 순수 함수라 `toolSections.test.js` 로 회귀를 고정한다.
 */

/**
 * @param {{enabled?:boolean, categories?:{id,label,icon,enabled,tools:string[]}[], showUncategorized?:boolean}} cfg
 * @param {string[]} visibleKeys 이 사용자에게 실제로 보이는 도구 키(권한·검색 필터를 이미 통과한 것)
 * @returns {{id:string,label:string,icon:string,tools:string[]}[]} 빈 배열이면 기존 단일 그리드를 그린다
 *
 * 규칙:
 *  - 카테고리 미사용(enabled=false)이거나 정의가 없으면 **빈 배열** → 화면은 켜기 전과 똑같이 동작.
 *  - **중복 소속을 유지한다** — 같은 도구가 여러 섹션에 나오는 것이 요구사항이다.
 *  - 안 보이는 도구는 섹션에서 빠지고, 그래서 빈 카테고리는 통째로 숨긴다(제목만 남으면 오해를 만든다).
 *  - 어느 카테고리에도 없는 도구는 마지막 '기타' 로 모은다 — 새 도구가 분류되기 전까지
 *    화면에서 사라지면 기능이 죽은 것처럼 보인다(가용성 우선).
 *  - 입력 순서를 보존한다(호출부가 이미 '많이 쓴 순' 으로 정렬해 넘긴다).
 */
export function buildSections(cfg, visibleKeys) {
  const keys = (visibleKeys || []).map(String);
  if (!cfg?.enabled) return [];
  const cats = (Array.isArray(cfg.categories) ? cfg.categories : []).filter((c) => c && c.enabled !== false);
  if (!cats.length) return [];

  const visible = new Set(keys);
  const out = [];
  const placed = new Set();
  for (const c of cats) {
    const want = new Set((c.tools || []).map(String));
    // 카테고리 안의 순서는 호출부가 준 순서를 따른다(사용 빈도 정렬을 섹션 안에서도 유지).
    const tools = keys.filter((k) => want.has(k) && visible.has(k));
    for (const k of tools) placed.add(k);
    if (!tools.length) continue;
    out.push({ id: String(c.id || ''), label: c.label || c.id || '', icon: c.icon || '', tools });
  }
  if (cfg.showUncategorized !== false) {
    const rest = keys.filter((k) => !placed.has(k));
    if (rest.length) out.push({ id: '_uncategorized', label: '기타', icon: '📦', tools: rest });
  }
  return out;
}

/** 이 도구가 속한 카테고리 이름들 — 카드에 소속 배지를 달거나 설정 화면에서 중복을 보여줄 때. */
export function categoriesOf(cfg, toolKey) {
  const k = String(toolKey);
  return (cfg?.categories || [])
    .filter((c) => (c?.tools || []).some((t) => String(t) === k))
    .map((c) => c.label || c.id);
}

/** 어느 카테고리에도 없는 도구 키 — 설정 화면의 "분류 안 됨 N개". */
export function uncategorizedKeys(cfg, allKeys) {
  const placed = new Set();
  for (const c of cfg?.categories || []) for (const t of c?.tools || []) placed.add(String(t));
  return (allKeys || []).map(String).filter((k) => !placed.has(k));
}

/* ───────────────────────────────────────────────────────────────────────────
 * v2.679 — 기능별 표시 이름·설명 덮어쓰기 + '개발 단계' 축(핸드오프 '특수 기능 화면 재구성').
 * 서버 `toolcats/catalog.js` 가 저장·검증하고, 화면 계산은 여기(웹)가 한다(같은 판정을 두 곳에 두지 않는다).
 * ⚠ 기능 키(k)는 절대 바꾸지 않는다 — 딥링크·권한 키·사용 횟수가 키 기준이다.
 * ─────────────────────────────────────────────────────────────────────────── */

/** 단계 목록 — 없거나 비면 null(= 단계 축을 쓰지 않음 · 화면이 지금과 똑같다). */
export function stagesOf(cfg) {
  const st = Array.isArray(cfg?.stages) ? cfg.stages.filter((s) => s && s.id) : [];
  return st.length ? st : null;
}

/** 기능의 단계 id — 덮어쓰기가 없거나 없는 단계를 가리키면 첫 단계(기본값). 단계 축이 없으면 null. */
export function stageIdOf(cfg, toolKey) {
  const st = stagesOf(cfg);
  if (!st) return null;
  const want = cfg?.overrides?.[String(toolKey)]?.stage;
  return want && st.some((s) => s.id === want) ? want : st[0].id;
}

/**
 * 도구 목록에 덮어쓰기를 입힌다 — `{ ...t, label, desc, origLabel, origDesc, stage, stageLabel, stageColor, renamed }`.
 * 비운 값은 원래 값으로 돌아간다(서버가 빈 문자열을 저장하지 않지만, 화면 미리보기도 같은 규칙).
 * 이름을 바꾼 기능은 원래 이름을 `aka` 에 더한다 — 옛 이름으로도 검색된다(toolSearch 가 aka 를 본다).
 */
export function applyOverrides(tools, cfg) {
  const ov = cfg?.overrides || {};
  const st = stagesOf(cfg);
  const byId = new Map((st || []).map((s) => [s.id, s]));
  return (tools || []).map((t) => {
    const o = ov[t.k] || {};
    const label = String(o.label || '').trim() || t.label;
    const desc = String(o.desc || '').trim() || t.desc;
    const sid = st ? stageIdOf(cfg, t.k) : null;
    const s = sid ? byId.get(sid) : null;
    const renamed = label !== t.label;
    return {
      ...t, label, desc, origLabel: t.label, origDesc: t.desc, renamed, redescribed: desc !== t.desc,
      stage: sid, stageLabel: s?.label || '', stageColor: s?.color || '',
      aka: renamed ? [...(t.aka || []), t.label] : t.aka,
    };
  });
}

/** 기본 단계(첫 단계)가 아닌가 — 배지는 이런 기능에만 붙인다(운영 배지까지 붙이면 화면이 시끄럽다). */
export function isNonDefaultStage(cfg, t) {
  const st = stagesOf(cfg);
  return !!(st && t?.stage && t.stage !== st[0].id);
}

/** 화면에 보일 이름 — stageDisplay 가 suffix 면 기본 단계가 아닌 기능에 '(개발중)' 을 붙인다. */
export function displayLabel(cfg, t) {
  if (cfg?.stageDisplay === 'suffix' && isNonDefaultStage(cfg, t) && t.stageLabel) return `${t.label}(${t.stageLabel})`;
  return t.label;
}

/**
 * 단계별 섹션 — buildSections 와 같은 모양(id,label,icon,tools,color). 입력 순서를 보존하고 빈 단계는 뺀다.
 * 단계 축이 없으면 빈 배열(화면은 업무 분류만 쓴다).
 */
export function buildStageSections(cfg, visibleKeys) {
  const st = stagesOf(cfg);
  if (!st) return [];
  const keys = (visibleKeys || []).map(String);
  const out = [];
  for (const s of st) {
    const tools = keys.filter((k) => stageIdOf(cfg, k) === s.id);
    if (tools.length) out.push({ id: s.id, label: s.label || s.id, icon: '●', color: s.color || '', tools });
  }
  return out;
}

/** 덮어쓰기 개수(이름·설명 중 하나라도 바꾼 기능) — 드로어 하단 요약·필터 칩. */
export function changedToolCount(cfg) {
  return Object.values(cfg?.overrides || {}).filter((o) => o && (String(o.label || '').trim() || String(o.desc || '').trim())).length;
}

/**
 * 단계를 지울 때의 결과 — 그 단계를 가리키던 덮어쓰기의 stage 를 지운다(기본 단계로 간다).
 * 첫 단계(기본값)는 지울 수 없다 → { ok:false }.
 */
export function removeStage(cfg, stageId) {
  const st = stagesOf(cfg) || [];
  const idx = st.findIndex((s) => s.id === stageId);
  if (idx <= 0) return { ok: false, cfg, moved: 0 };
  const overrides = {};
  let moved = 0;
  for (const [k, o] of Object.entries(cfg?.overrides || {})) {
    if (o?.stage === stageId) {
      const { stage: _s, ...rest } = o;
      moved++;
      if (Object.keys(rest).length) overrides[k] = rest;
    } else overrides[k] = o;
  }
  return { ok: true, moved, cfg: { ...cfg, stages: st.filter((s) => s.id !== stageId), overrides } };
}

/** 단계별 기능 수(덮어쓰기 기준 · 전체 키 목록 대상) — 단계 목록 탭의 '기능 n개'. */
export function stageCounts(cfg, allKeys) {
  const out = {};
  for (const s of stagesOf(cfg) || []) out[s.id] = 0;
  for (const k of allKeys || []) { const id = stageIdOf(cfg, k); if (id != null) out[id] = (out[id] || 0) + 1; }
  return out;
}

/** 새 단계 id — 기존과 겹치지 않는 `stage<n>`. */
export function nextStageId(stages) {
  const ids = new Set((stages || []).map((s) => s.id));
  let n = (stages || []).length + 1;
  while (ids.has(`stage${n}`)) n++;
  return `stage${n}`;
}

/**
 * 특수 기능 머리 안내 줄 — `{n}개 기능 · 업무 분류 {a}개 · 개발 단계 {b}개 · 🔒 …`.
 * 허용 목록 모드(관리자 아님 + 허용 배열)는 gridIntro 규칙을 그대로 따른다 — 회색 카드가 하나도 없으므로
 * '🔒 회색 카드' 안내가 거짓이 된다(v2.555 Chromium 판독).
 */
export function introLine({ isAdmin = false, toolsAllowed = null, shownCount = 0, catCount = 0, stageCount = 0 } = {}) {
  if (!isAdmin && Array.isArray(toolsAllowed)) return gridIntro({ isAdmin, toolsAllowed, shownCount });
  const parts = [`**${shownCount}개** 기능`];
  if (catCount > 0) parts.push(`업무 분류 ${catCount}개`);
  if (stageCount > 0) parts.push(`개발 단계 ${stageCount}개`);
  parts.push('🔒 표시는 접근 권한 없음(클릭할 수 없습니다)');
  return parts.join(' · ');
}
