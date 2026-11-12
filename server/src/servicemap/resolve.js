/**
 * servicemap/resolve.js — 서비스 소속 판정 코어(순수, v2.887). **판정은 여기 하나다** — 웹·다른 모듈에 복제하지 않는다.
 *
 * 순서(위가 이긴다):
 *   1. 고정(수동, pins)      — 자동 판정과 다르면 drift(검토 큐). 고정의 법인이 구성원의 법인과 다르면 무시하고 pinMismatch(4차 반증 16).
 *                              '고정 유지'(reviewed)는 **그때의 자동 판정(reviewedAuto)과 같은 드리프트만** 다시 묻지 않는다 — 자동 판정이 다른 서비스로
 *                              바뀌면 다시 드리프트(5차 반증 R8). reviewedAuto 가 없는 옛 검토 표지는 한 번 다시 묻는다(모르는 것을 '같다' 로 보지 않는다).
 *   2. vCenter 폴더 규칙(VM)  — vmPlacement.folderPath('/ERP/prod') 의 '/' 경계 접두, 가장 긴 접두. folderPath null(vApp 등)은 'placement-unknown'.
 *   2b. 물리서버 폴더 규칙(베어메탈, v2.986) — 물리서버 폴더(bm-folders) 경로의 '\\' 경계 접두, 가장 긴 접두. VM 의 2번과 같은 자리.
 *                              구성원의 폴더는 ctx.bmFolderOf(키 → 경로 — 미분류 '' · 모름 undefined)로 받는다. 모르면(물리서버 폴더 저장소 손상) 이 규칙을 건너뛴다.
 *                              이 규칙으로 정해졌는데 스캔 라벨 · 이름 규칙이 다른 서비스를 가리키면 `ruleOverlap` 으로 검토 큐에 올린다(규칙을 만든 순간 옮겨 간 구성원이 드러나게).
 *   3. 스캔 엔트리 라벨(베어메탈) — 등록부 scanRangeId → idrac-scan-ranges.json 엔트리 service 라벨. 라벨 = 서비스명 또는 별칭.
 *   4. vSphere 태그(선택, VM) — 전역 카테고리가 정해지고 그 법인이 켰을 때만. 태그를 못 읽었으면 'unchecked'(미지정과 다르다).
 *                              태그가 여럿이면 **서비스(이름·별칭)에 걸리는 값**을 고른다(5차 M5·R14 — 예전에는 첫 값만 봤다). 값은 소문자 정렬 순으로 본다
 *                              (수집 순서가 바뀌어도 판정이 흔들리지 않게). 둘 이상의 다른 서비스에 걸리면 첫 값을 쓰되 `tagAmbiguous` 로 검토 큐에 올린다(조용히 이기지 않는다).
 *   5. 이름 규칙(선택)        — 접두/접미/포함 3종(정규식 아님 — 4차 반증 14 ReDoS). **적용 순서는 등록 순이 아니다**(5차 M4·R13):
 *                              접두·접미가 포함보다 먼저, 같은 등급 안에서는 긴 값 먼저, 그다음 등록 순(`sortNameRules` — 화면 '적용 순서' 열도 이것).
 *   6. 없음 → (미지정). reason 으로 왜인지 밝히고, 사람이 묶어 연결할 값은 unmapped 로 싣는다.
 * 서비스를 **자동으로 만드는 경로는 없다** — 규칙·별칭은 기존 서비스에만 붙는다.
 * 비교는 소문자(4차 반증 20) — **단 vCenter 폴더 규칙은 대소문자를 구분한다**(vSphere 폴더 이름이 대소문자를 구분하므로 '/ERP' 와 '/erp' 는 다른 폴더다 — 5차 R12 머리말 정정).
 *
 * 구성원 입력 모양:
 *   { key, kind:'vm'|'bm', corp, name, folderPath?:string|null, tags?:string[]|null, scan?:{entryId,label}|null, scanWhy?:'unknown-entry'|'old-source'|'not-reported', corpWhy? }
 *   베어메탈의 물리서버 폴더는 구성원이 아니라 ctx.bmFolderOf(키 → 경로)로 받는다 — 입력 수집(스냅샷 세대)과 물리서버 폴더 저장소(rev)의 세대가 달라서다.
 *   scanWhy(5차 R18): scan 이 없는 이유 — 보고된 엔트리 id 가 중앙 등록부에 없음 · 보고한 엣지·수집 서버가 엔트리 id 를 보내지 않는 구버전.
 *   tags: undefined = 태그 규칙 꺼짐 · null = 그 vCenter 태그를 못 읽음(unchecked) · [] = 읽었고 카테고리 태그 없음.
 */
const lc = (s) => String(s ?? '').trim().toLowerCase();
const NAME_INPUT_MAX = 128;   // 이름 규칙 입력 상한(선형 비교라 길이만 자른다)
const FOLDER_INPUT_MAX = 256;

/** 저장소(map) → 법인별 판정 색인. 요청(세대)당 한 번 만든다(4차 반증 9 — 구성원마다 전 법인 규칙을 훑지 않는다). */
export function buildIndex(map) {
  const idx = new Map();
  for (const [vc, c] of Object.entries(map?.corps || {})) {
    const svcById = new Map(); const svcByName = new Map();
    for (const s of c.services || []) { svcById.set(s.id, s); if (!svcByName.has(lc(s.name))) svcByName.set(lc(s.name), s); }
    const rules = (c.folderRules || []).filter((r) => svcById.has(r.serviceId)).slice().sort((a, b) => b.prefix.length - a.prefix.length);
    const aliasScan = new Map(); const aliasTag = new Map();
    for (const a of c.aliases || []) { if (!svcById.has(a.serviceId)) continue; (a.kind === 'scan' ? aliasScan : aliasTag).set(lc(a.value), a.serviceId); }
    const nameRules = sortNameRules((c.nameRules || []).filter((r) => svcById.has(r.serviceId))).map((r) => ({ ...r, v: lc(r.value) }));
    const bmRules = (c.bmFolderRules || []).filter((r) => svcById.has(r.serviceId)).slice().sort((a, b) => b.prefix.length - a.prefix.length);
    idx.set(vc, { svcById, svcByName, rules, aliasScan, aliasTag, nameRules, bmRules, tagEnabled: c.tagEnabled === true });
  }
  return idx;
}

/** 이름 규칙 적용 순서(순수 — 5차 M4·R13). 접두·접미(앵커) > 포함 · 같은 등급이면 긴 값 먼저 · 그다음 등록 순(안정 정렬). */
const MATCH_RANK = { prefix: 0, suffix: 0, contains: 1 };
export function sortNameRules(rules = []) {
  return (rules || []).map((r, i) => ({ r, i, n: lc(r?.value).length, k: MATCH_RANK[r?.match] ?? 2 }))
    .sort((a, b) => a.k - b.k || b.n - a.n || a.i - b.i).map((x) => x.r);
}

/** 폴더 접두 일치 — '/' 경계. 루트 규칙('/')은 루트 VM('/')만(모든 VM 을 삼키지 않게). */
export function folderMatches(prefix, folderPath) {
  if (typeof folderPath !== 'string' || !prefix) return false;
  if (prefix === '/') return folderPath === '/';
  return folderPath === prefix || folderPath.startsWith(`${prefix}/`);
}
/**
 * 이름 규칙 — 적용 순서(sortNameRules) 첫 일치가 이긴다. **다른 서비스를 가리키는 규칙도 걸리면 `overlap`** 으로 밝힌다(3차 반증 1:
 * 판정 순서를 바꾼 업그레이드에서 소속이 조용히 옮겨 간 구성원이 바로 이것이다 — 순서에 결과가 달린 구성원을 검토 큐에 올린다).
 */
function nameRuleOf(c, name) {
  const n = lc(String(name ?? '').slice(0, NAME_INPUT_MAX));
  if (!n) return null;
  let first = null; const others = [];
  for (const r of c.nameRules) {
    if (!((r.match === 'prefix' && n.startsWith(r.v)) || (r.match === 'suffix' && n.endsWith(r.v)) || (r.match === 'contains' && n.includes(r.v)))) continue;
    if (!first) first = r;
    else if (r.serviceId !== first.serviceId && others.length < 4) others.push(`${r.match}:${r.value}`);
  }
  return first ? { r: first, others } : null;
}
const hit = (serviceId, src, via) => ({ serviceId, src, via: String(via ?? '') });
/** 물리서버 폴더 경로 접두 일치 — '\\' 경계(‘DB’ 는 ‘DB2’ 의 접두가 아니다). 대소문자를 구분한다(폴더는 포탈이 만든 이름 그대로). */
export function bmFolderMatches(prefix, path) {
  if (typeof path !== 'string' || !path || !prefix) return false;
  return path === prefix || path.startsWith(`${prefix}\\`);
}
/** 베어메탈의 스캔 라벨 · 이름 규칙 판정(물리서버 폴더 규칙 아래 순위) — 겹침 판정과 본 판정이 같은 함수를 쓴다. */
function bmLowerResolve(m, c) {
  const scan = m.scan || null;
  if (scan && scan.label && c) {
    const s = c.svcByName.get(lc(scan.label)) || null;
    if (s) return hit(s.id, 'scan', scan.label);
    const a = c.aliasScan.get(lc(scan.label));
    if (a) return hit(a, 'scan', scan.label);
  }
  const nr = c ? nameRuleOf(c, m.name) : null;
  if (nr) return { ...hit(nr.r.serviceId, 'rule', `${nr.r.match}:${nr.r.value}`), ...(nr.others.length ? { ruleOverlap: nr.others } : {}) };
  return null;
}

/** 자동 판정(고정 제외). 순수. */
export function autoResolve(m, idx, { tagCategory = '', bmFolderOf = null } = {}) {
  if (!m || !m.corp) return { serviceId: null, src: 'none', reason: m?.corpWhy === 'attr-error' ? 'no-corp-error' : m?.corpWhy === 'tag-conflict' ? 'no-corp-conflict' : 'no-corp' };
  const c = idx.get(m.corp);
  if (m.kind === 'vm') {
    const f = typeof m.folderPath === 'string' ? m.folderPath.slice(0, FOLDER_INPUT_MAX) : null;
    if (c && f != null) for (const r of c.rules) if (folderMatches(r.prefix, f)) return hit(r.serviceId, 'folder', r.prefix);
    let unchecked = false; let tagUnmapped = null;
    if (c && tagCategory && c.tagEnabled) {
      if (m.tags === null) unchecked = true;
      else if (Array.isArray(m.tags) && m.tags.length) {
        // 대소문자만 다른 값은 한 값이다('DB'·'db' 가 '태그 2' 로 보이지 않게 — 3차 반증 10). 정렬은 소문자 → 원문 순(결정적).
        const seen = new Set(); const vals = [];
        for (const x of m.tags) { const v = String(x ?? '').slice(0, NAME_INPUT_MAX); if (!v.trim() || seen.has(lc(v))) continue; seen.add(lc(v)); vals.push(v); }
        vals.sort((a, b) => (lc(a) < lc(b) ? -1 : lc(a) > lc(b) ? 1 : (a < b ? -1 : a > b ? 1 : 0)));
        const hits = [];
        for (const v of vals) { const id = c.svcByName.get(lc(v))?.id || c.aliasTag.get(lc(v)); if (id) hits.push({ v, id }); }
        // 보이는 값(최대 8)은 서비스에 걸린 값을 먼저 — 잘려서 '왜 모호한지' 가 안 보이지 않게(3차 반증 7)
        const shown = [...hits.map((x) => x.v), ...vals.filter((v) => !hits.some((x) => x.v === v))].slice(0, 8);
        const multi = vals.length > 1 ? { multi: true, tagValues: shown } : {};
        if (hits.length) {
          const ambiguous = new Set(hits.map((x) => x.id)).size > 1;
          return { ...hit(hits[0].id, 'tag', hits[0].v), ...multi, ...(ambiguous ? { tagAmbiguous: true } : {}) };
        }
        if (vals.length) tagUnmapped = vals[0];
      }
    }
    const nr = c ? nameRuleOf(c, m.name) : null;
    if (nr) return { ...hit(nr.r.serviceId, 'rule', `${nr.r.match}:${nr.r.value}`), ...(nr.others.length ? { ruleOverlap: nr.others } : {}) };
    if (tagUnmapped != null) return { serviceId: null, src: 'none', reason: 'tag-unmapped', unmapped: { kind: 'tag', value: tagUnmapped }, ...(unchecked ? { unchecked } : {}) };
    if (f == null) return { serviceId: null, src: 'none', reason: 'placement-unknown', ...(unchecked ? { unchecked } : {}) };
    return { serviceId: null, src: 'none', reason: unchecked ? 'tags-unchecked' : 'no-folder-rule', unmapped: { kind: 'folder', value: f }, ...(unchecked ? { unchecked } : {}) };
  }
  // 베어메탈 — 2b. 물리서버 폴더 규칙(가장 긴 접두)
  const lower = bmLowerResolve(m, c);
  const folder = bmFolderOf && typeof bmFolderOf.get === 'function' ? bmFolderOf.get(m.key) : undefined;
  if (c && c.bmRules.length && typeof folder === 'string' && folder) {
    for (const r of c.bmRules) {
      if (!bmFolderMatches(r.prefix, folder)) continue;
      // 아래 순위(스캔 라벨 · 이름 규칙)가 다른 서비스를 가리키면 겹침으로 밝힌다 — 규칙을 만든 순간 옮겨 간 구성원을 검토 큐에서 보이게
      const shadow = lower && lower.serviceId !== r.serviceId ? [`${lower.src === 'scan' ? 'scan' : 'name'}:${lower.via}`] : null;
      return { ...hit(r.serviceId, 'bmfolder', r.prefix), ...(shadow ? { ruleOverlap: shadow } : {}) };
    }
  }
  const scan = m.scan || null;
  if (lower) return lower;
  if (!scan) return { serviceId: null, src: 'none', reason: m.scanWhy === 'unknown-entry' ? 'scan-entry-unknown' : m.scanWhy === 'old-source' ? 'source-old' : m.scanWhy === 'not-reported' ? 'source-unreported' : 'no-scan-entry' };
  if (!scan.label) return { serviceId: null, src: 'none', reason: 'scan-label-empty', unmapped: { kind: 'entry', value: String(scan.entryId || '') } };
  return { serviceId: null, src: 'none', reason: 'scan-label-unmapped', unmapped: { kind: 'scan', value: scan.label } };
}

/**
 * 고정까지 포함한 최종 판정. 순수.
 * @returns {{serviceId, src, via?, reason?, unmapped?, unchecked?, auto, drift?, redundant?, pinMismatch?, pinDangling?}}
 */
export function resolveMember(m, idx, ctx = {}, pins = {}) {
  const auto = autoResolve(m, idx, ctx);
  let pin = pins && m ? pins[m.key] : null;
  let pinKey;
  // 키 등급이 올라 새 키에 고정이 없으면 낮은 등급 키(별칭)의 고정을 쓴다 — 같은 법인 것만(5차 R15: 예전에는 옛 고정이 '정리 대상 유령' 이 됐다)
  if (!pin && pins && Array.isArray(m?.aliasKeys)) {
    for (const a of m.aliasKeys) { const p = pins[a]; if (p && p.corp === m.corp) { pin = p; pinKey = a; break; } }
  }
  if (!pin) return { ...auto, auto };
  if (pin.corp !== m.corp) return { ...auto, auto, pinMismatch: { serviceId: pin.serviceId, corp: pin.corp } };
  const c = idx.get(m.corp);
  if (!c || !c.svcById.has(pin.serviceId)) return { ...auto, auto, pinDangling: true };
  const differs = !!auto.serviceId && auto.serviceId !== pin.serviceId;
  const sameAsReviewed = pin.reviewed === true && pin.reviewedAuto !== undefined && (pin.reviewedAuto ?? null) === (auto.serviceId ?? null);
  return { serviceId: pin.serviceId, src: 'pin', via: pin.by || '', auto, drift: differs && !sameAsReviewed, redundant: auto.serviceId === pin.serviceId, ...(pinKey ? { pinKey } : {}),
    // legacy = 검토 당시 자동 판정을 기록하지 않은 옛 표지(바뀌었는지 모른다 — '바뀜' 이 아니라 '다시 확인')
    ...(differs && pin.reviewed === true && !sameAsReviewed ? { driftChanged: pin.reviewedAuto === undefined ? { legacy: true } : { reviewedAuto: pin.reviewedAuto } } : {}) };
}
