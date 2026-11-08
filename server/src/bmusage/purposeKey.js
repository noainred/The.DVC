/**
 * bmusage/purposeKey.js — 수동 용도 태그(insights/fleetTags.js purposes)의 **저장 · 조회 키 규칙 하나**(다음 점검 ① 2차 · 반증 F2).
 *
 * 왜: 용도 태그는 키 단독(서비스태그 또는 서버 키 — 소문자)으로 저장됐다. 서비스태그가 아닌 키(IP 로 등록한 iDRAC 은 키 = IP)는 법인끼리 겹치므로,
 *   범위 관리자 A 가 자기 서버에 단 태그가 같은 키의 **쓰기 범위 밖 법인 B 서버**의 용도 · 튜닝 판정을 바꾸고, B 가 해제하면 A 의 태그가 사라졌으며,
 *   B 관리자에게 A 관리자 계정명이 보였다(반증 F2 재현).
 * 규칙:
 *   · 키가 서비스태그(keyKind 'serviceTag')면 그대로 서비스태그(하드웨어 전역 유일 — 예전 행과 같은 열쇠).
 *   · 아니면(fleetId · serverId · 식별 키 겹침 결정의 별도 키 'decided') **`<법인>|<키>` 쌍** — 새 쓰기는 쌍으로만 · 읽기는 쌍 → 예전(키 단독) 순.
 *     예전 행(legacy)은 그대로 둔다(저장 이전 없음) — 쓰기 라우트가 그 키의 서버가 모두 쓰기 범위 안일 때만 쌍으로 나눠 옮기고, 아니면 409.
 *   · 공통 태그 서버(‘To Be Filled By O.E.M.’)를 별도 키로 수집하면 keyKind 'decided' — 서비스태그로 찾지 않는다(같은 공통 태그 서버끼리 섞인다).
 */
const t = (v) => String(v ?? '').trim();

/** 조회 순서(순수) — [{ k, source:'tag'|'pair'|'legacy' }]. */
export function purposeKeysOf(target, realKey = target?.key) {
  const key = t(realKey || target?.key);
  const tag = t(target?.serviceTag);
  const kind = t(target?.keyKind);
  const tagKeyed = kind ? kind === 'serviceTag' : (!!tag && key.toUpperCase() === tag.toUpperCase());
  if (tagKeyed && tag) return [{ k: tag, source: 'tag' }];
  if (!key) return [];
  return [{ k: `${t(target?.vcenterId)}|${key}`, source: 'pair' }, { k: key, source: 'legacy' }];
}
/** 저장 키(순수) — 조회 순서의 첫 열쇠. */
export const purposeWriteKeyOf = (target, realKey) => purposeKeysOf(target, realKey)[0] || null;
/** 한 서버의 용도 태그 — lookup(k) 은 fleetPurposeOf(동기 · 비동기 둘 다). 돌려주는 값에 source(어느 열쇠에서 왔나)를 붙인다. */
export async function purposeOfTarget(lookup, target, realKey) {
  for (const { k, source } of purposeKeysOf(target, realKey)) {
    let v = null;
    try { v = await lookup(k); } catch { v = null; }
    if (v) return { ...v, source };
  }
  return null;
}
/** 동기판(폴러 · 정비 판정기 — fleetPurposeOf 가 동기다). */
export function purposeOfTargetSync(lookup, target, realKey) {
  for (const { k, source } of purposeKeysOf(target, realKey)) {
    let v = null;
    try { v = lookup(k); } catch { v = null; }
    if (v) return { ...v, source };
  }
  return null;
}
