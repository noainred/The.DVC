/**
 * bmusage/purposeKey.js — 수동 용도 태그(insights/fleetTags.js purposes)의 **저장 · 조회 키 규칙 하나**(다음 점검 ① 2차 · 반증 F2 · 2차 재확인 G1 · G2).
 *
 * 왜: 용도 태그는 키 단독(서비스태그 또는 서버 키 — 소문자)으로 저장됐다. 서비스태그가 아닌 키(IP 로 등록한 iDRAC 은 키 = IP)는 법인끼리 겹치므로,
 *   범위 관리자 A 가 자기 서버에 단 태그가 같은 키의 **쓰기 범위 밖 법인 B 서버**의 용도 · 튜닝 판정을 바꾸고, B 가 해제하면 A 의 태그가 사라졌으며,
 *   B 관리자에게 A 관리자 계정명이 보였다(반증 F2 재현). 2차 재확인 G1: 서비스 태그도 공통 기본값(‘To Be Filled By O.E.M.’)이면 같은 일이 난다.
 * 규칙:
 *   · 읽기는 늘 **`<법인>|<키>` 쌍 → 기본 열쇠**(서비스태그 키면 그 태그 · 아니면 키) 순이다(쌍 행이 있으면 그것이 그 서버 것).
 *   · 쓰기: 서비스태그 키이고 그 태그를 **전역 열쇠로 써도 될 때만**(bmusage/commonTag.js tagKeyOk — 공통 기본값 아님 · 둘 이상 법인에 없음 ·
 *     이 노드가 같은 저장소를 쓰는 서버를 다 앎) 그 태그로 쓰고, 이 서버의 쌍 행이 있으면 지운다(쌍 행이 새 값을 가리지 않게).
 *     그 밖에는(fleetId · serverId · 식별 키 겹침 결정의 별도 키 'decided' · 공통 태그 · 모름) **쌍 키**로 쓴다.
 *   · 기본 열쇠의 예전 행(legacy — 법인 구분 없이 저장된 것)은 범위 계정이 지우지 않는다(G2 — 보이는 대상만 세면 엣지 보관분이 없을 때 다른 법인
 *     서버의 태그를 지웠다). 나눠 옮기기 · 정리는 전체 범위 계정이 판정기가 complete 일 때만(쓰기 라우트).
 *   · ctx 가 없으면(판정기를 모름) 서비스태그도 전역 열쇠로 쓰지 않는다 — 읽기의 출처 표시도 'legacy'(범위 계정에 계정명을 싣지 않는 쪽).
 */
const t = (v) => String(v ?? '').trim();

function parts(target, realKey, ctx) {
  const key = t(realKey || target?.key);
  const tag = t(target?.serviceTag);
  const kind = t(target?.keyKind);
  const tagKeyed = !!tag && (kind ? kind === 'serviceTag' : key.toUpperCase() === tag.toUpperCase());
  const base = tagKeyed ? tag : key;
  const ok = tagKeyed && typeof ctx?.tagKeyOk === 'function' ? !!ctx.tagKeyOk(tag) : false;
  return { key, tag, tagKeyed, base, tagOk: ok, pair: key ? `${t(target?.vcenterId)}|${key}` : '' };
}

/** 조회 순서(순수) — [{ k, source:'pair'|'tag'|'legacy' }]. 'tag' = 전역 열쇠로 써도 되는 서비스 태그(그 서버 것) · 'legacy' = 법인 구분 없는 예전 행. */
export function purposeKeysOf(target, realKey = target?.key, ctx = {}) {
  const p = parts(target, realKey, ctx);
  if (!p.base) return [];
  return [...(p.pair ? [{ k: p.pair, source: 'pair' }] : []), { k: p.base, source: p.tagOk ? 'tag' : 'legacy' }];
}
/**
 * 저장 키(순수) — { k, source:'tag'|'pair', clearPair?: 쌍 키(전역 태그로 쓸 때 지울 이 서버의 쌍 행), legacy?: 기본 열쇠(쌍으로 쓸 때 남는 예전 행) }.
 */
export function purposeWriteKeyOf(target, realKey, ctx = {}) {
  const p = parts(target, realKey, ctx);
  if (!p.base) return null;
  if (p.tagOk) return { k: p.tag, source: 'tag', ...(p.pair ? { clearPair: p.pair } : {}) };
  if (!p.pair) return null;
  return { k: p.pair, source: 'pair', legacy: p.base };
}
/** 한 서버의 용도 태그 — lookup(k) 은 fleetPurposeOf(동기 · 비동기 둘 다). 돌려주는 값에 source(어느 열쇠에서 왔나)를 붙인다. */
export async function purposeOfTarget(lookup, target, realKey, ctx = {}) {
  for (const { k, source } of purposeKeysOf(target, realKey, ctx)) {
    let v = null;
    try { v = await lookup(k); } catch { v = null; }
    if (v) return { ...v, source };
  }
  return null;
}
/** 동기판(폴러 · 정비 판정기 — fleetPurposeOf 가 동기다). */
export function purposeOfTargetSync(lookup, target, realKey, ctx = {}) {
  for (const { k, source } of purposeKeysOf(target, realKey, ctx)) {
    let v = null;
    try { v = lookup(k); } catch { v = null; }
    if (v) return { ...v, source };
  }
  return null;
}

/**
 * 7b 일괄 등록(중앙 라우트 · 엣지 배포 적용 둘 다 — 3차 재확인 H1)의 서비스 태그 → 대상 · 저장 키(순수).
 *   rows = 그 노드의 대상 · 대상이 아닌 서버 · judge = commonTag.js 판정기. 같은 태그가 둘 이상 · 판정기가 공통이라 하거나 판정기가 없으면 common.
 * @returns {Map<string, {vcenterId:string, common:boolean, purposeKey:string, clearPair:string}>}  열쇠 = 서비스 태그 소문자
 */
export function tagTargetsOf(rows = [], judge = null) {
  const seen = new Map();
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || typeof x !== 'object' || !t(x.serviceTag)) continue;
    const k = t(x.serviceTag).toLowerCase();
    const prev = seen.get(k);
    seen.set(k, prev ? { ...prev, n: prev.n + 1 } : { x, n: 1 });
  }
  const out = new Map();
  for (const [k, { x, n }] of seen) {
    const common = n > 1 || !judge || judge.isCommon(k);
    const wk = common ? null : purposeWriteKeyOf(x, t(x.key), judge);
    out.set(k, { vcenterId: t(x.vcenterId), common: common || !wk, purposeKey: wk?.k || '', clearPair: wk?.clearPair || '' });
  }
  return out;
}
