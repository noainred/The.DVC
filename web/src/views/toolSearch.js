/**
 * 도구 검색 매칭(v2.508, 순수) — 특수 기능 카드 그리드와 V4 커맨드 팔레트가 **같은 규칙**을 쓴다.
 *
 * 왜 따로 뺐나: v2.507 까지 검색은 `label` + `desc` 만 봤다(SpecialTools.jsx). 그래서
 *   · 키로 못 찾았다 — `gpu` · `ipam` · `rma` 는 사용자가 실제로 부르는 이름인데 라벨에 없다.
 *   · 분류명으로 못 찾았다 — '스토리지' 를 치면 스토리지 도구가 아니라 라벨에 그 글자가 든 것만 나왔다.
 *   · 이름을 바꾸면 옛 이름으로 못 찾았다 — v2.507 '낭비 리소스' → '자원 최적화' 가 실제 사례다.
 *
 * 그래서 `aka`(구 명칭·별칭 배열)를 도구 정의의 정식 필드로 두고, 여기서 k·label·desc·aka·
 * 분류명을 함께 본다. **`k` 값 자체는 절대 바꾸지 않는다** — permissions.json 의 toolsDenied
 * 값이자 딥링크(#/tools/<k>)이자 server/src/auth/toolAccess.js 의 집행 매핑이다.
 *
 * 정렬 규칙: 라벨 앞글자 일치 > 라벨 포함 > 키 > 별칭 > 분류명 > 설명. 같은 등급이면 원래 순서.
 */

const norm = (v) => String(v ?? '').toLowerCase();

/** 도구 1건의 검색 대상 필드. catLabels = 그 도구가 속한 분류명 배열(없으면 빈 배열). */
export function toolHaystack(t, catLabels = []) {
  return {
    label: norm(t?.label),
    k: norm(t?.k),
    desc: norm(t?.desc),
    aka: (t?.aka || []).map(norm),
    cats: (catLabels || []).map(norm),
  };
}

/**
 * 매칭 점수 — 일치하지 않으면 null(0 이 아니다: 0 은 '가장 좋은 점수'와 헷갈린다).
 * 낮을수록 먼저 나온다.
 */
export function matchScore(t, q, catLabels = []) {
  const needle = norm(q).trim();
  if (!needle) return 0;
  const h = toolHaystack(t, catLabels);
  if (h.label.startsWith(needle)) return 1;
  if (h.label.includes(needle)) return 2;
  if (h.k.includes(needle)) return 3;
  if (h.aka.some((a) => a.includes(needle))) return 4;
  if (h.cats.some((c) => c.includes(needle))) return 5;
  if (h.desc.includes(needle)) return 6;
  return null;
}

/**
 * 검색어로 거르고 점수순으로 정렬한다. 빈 검색어면 원본 순서 그대로 돌려준다(잘라내지 않는다).
 * catsOf(t) 는 그 도구의 분류명 배열을 주는 함수 — 분류 설정이 없으면 생략한다.
 */
export function searchTools(tools, q, { catsOf } = {}) {
  const list = tools || [];
  const needle = norm(q).trim();
  if (!needle) return [...list];
  const scored = [];
  list.forEach((t, i) => {
    const s = matchScore(t, needle, catsOf ? catsOf(t) : []);
    if (s != null) scored.push({ t, s, i });
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.map((x) => x.t);
}
