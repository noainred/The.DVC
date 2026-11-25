/**
 * svcmon/easyRegister.js — 쉬운 등록(v2.960 · 시안 3차 A+B+C)의 **순수 판정**(화면 · vitest 가 같이 쓴다).
 *
 *  - `idsByFolder`  : 폴더 경로 → 그 아래(하위 포함) 대상 id — 트리 선택 모드가 폴더 체크를 대상 id 로 펼친다(대상 × 깊이 — 폴더마다 전 대상을 훑지 않는다).
 *  - `selectionInfo`: 고른 대상의 수 · 점검 수 · 지금 중지 수(일괄 막대 문구).
 *  - `corpPlan`     : 설정 연동 카탈로그 행 → 법인별 추천 등록 묶음(법인 = 서버 corpKey · 법인을 모르면 '법인 미상' 으로 따로).
 *  - `pickedPlan`   : 고른 법인 · 뺀 종류 → 등록할 키(미등록)와 켤 대상 id(등록됐지만 중지).
 * 상태 판정은 서버 값 그대로 쓴다(카탈로그 state · targetEnabled) — 여기서 다시 판정하지 않는다.
 */

/** @returns {Map<string, string[]>} 폴더 경로 → 하위 포함 대상 id. 경로 '' (Root) 는 전체. */
export function idsByFolder(targets = []) {
  const m = new Map([['', []]]);
  for (const t of targets) {
    m.get('').push(t.id);
    let acc = '';
    for (const seg of String(t.path || '').split('\\').filter(Boolean)) {
      acc = acc ? `${acc}\\${seg}` : seg;
      if (!m.has(acc)) m.set(acc, []);
      m.get(acc).push(t.id);
    }
  }
  return m;
}

/** 폴더 체크 상태 — 'all' | 'some' | 'none'. */
export function folderCheck(ids = [], picked = new Set()) {
  if (!ids.length) return 'none';
  let n = 0;
  for (const id of ids) if (picked.has(id)) n += 1;
  return n === 0 ? 'none' : (n === ids.length ? 'all' : 'some');
}

/** 폴더 체크를 누르면 — 전부 골라져 있으면 빼고, 아니면 더한다. 새 Set 을 돌려준다. */
export function toggleIds(picked = new Set(), ids = []) {
  const next = new Set(picked);
  const all = ids.length && ids.every((id) => next.has(id));
  for (const id of ids) { if (all) next.delete(id); else next.add(id); }
  return next;
}

/** 고른 대상 요약. */
export function selectionInfo(picked = new Set(), targets = []) {
  let n = 0; let tests = 0; let off = 0; let edge = 0;
  for (const t of targets) {
    if (!picked.has(t.id)) continue;
    n += 1; tests += (t.tests || []).length;
    if (t.enabled === false) off += 1;
    if (t.agent) edge += 1;
  }
  return { targets: n, tests, off, on: n - off, edge };
}

const PLAN_STATES = new Set(['new', 'linked', 'changed']);
export const UNKNOWN_CORP = '';

/**
 * 법인별 추천 등록 묶음.
 * @param {object[]} rows 설정 연동 카탈로그 행(GET /svcmon/settings-sync/catalog)
 * @returns {{key:string,label:string,agent:string,total:number,unmonitored:number,newN:number,offN:number,problem:number,kinds:object[]}[]}
 *   kinds[] = { kind, label, n, newN, offN, checks } — 미감시가 많은 법인 먼저, 법인 미상은 맨 뒤.
 */
export function corpPlan(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    if (r.state === 'problem') {
      const k = r.corpKey || UNKNOWN_CORP;
      const g = groups.get(k) || null;
      if (g) g.problem += 1; else groups.set(k, { ...blank(k, r), problem: 1 });
      continue;
    }
    if (!PLAN_STATES.has(r.state)) continue;
    const k = r.corpKey || UNKNOWN_CORP;
    if (!groups.has(k)) groups.set(k, blank(k, r));
    const g = groups.get(k);
    if (!g.agent && r.corpAgent) g.agent = r.corpAgent;
    const kk = g.kindMap.get(r.kind) || { kind: r.kind, label: r.kindLabel || r.kind, n: 0, newN: 0, offN: 0, checks: '', keys: [], offIds: [] };
    g.kindMap.set(r.kind, kk);
    kk.n += 1; g.total += 1;
    if (!kk.checks && Array.isArray(r.checks) && r.checks.length) kk.checks = r.checks.map((c) => c.name).join(' · ');
    if (r.state === 'new') { kk.newN += 1; g.newN += 1; kk.keys.push(r.key); }
    else if (r.targetEnabled === false && r.targetId) { kk.offN += 1; g.offN += 1; kk.offIds.push(r.targetId); }
  }
  const out = [];
  for (const g of groups.values()) {
    const { kindMap, ...rest } = g;
    if (!rest.total && !rest.problem) continue;
    out.push({ ...rest, unmonitored: rest.newN + rest.offN, kinds: [...kindMap.values()].sort((a, b) => (b.newN + b.offN) - (a.newN + a.offN) || a.label.localeCompare(b.label, 'ko')) });
  }
  return out.sort((a, b) => (a.key === UNKNOWN_CORP) - (b.key === UNKNOWN_CORP) || b.unmonitored - a.unmonitored || a.label.localeCompare(b.label, 'ko'));
}
function blank(key, r) {
  return { key, label: key === UNKNOWN_CORP ? '법인 미상' : (r.corp || key), agent: '', total: 0, newN: 0, offN: 0, problem: 0, kindMap: new Map() };
}

/**
 * 고른 법인 · 뺀 종류('<법인 key>|<종류>') → 등록할 키 · 켤 대상 id.
 * @returns {{keys:string[], offIds:string[], corps:number, newN:number, offN:number}}
 */
export function pickedPlan(groups = [], pickedCorps = new Set(), excluded = new Set()) {
  const keys = []; const offIds = []; let corps = 0;
  for (const g of groups) {
    if (!pickedCorps.has(g.key)) continue;
    let any = false;
    for (const k of g.kinds) {
      if (excluded.has(`${g.key}|${k.kind}`)) continue;
      keys.push(...k.keys); offIds.push(...k.offIds);
      if (k.keys.length || k.offIds.length) any = true;
    }
    if (any) corps += 1;
  }
  return { keys, offIds, corps, newN: keys.length, offN: offIds.length };
}

/** 시험 작업 요약 문구(창 머리). */
export function trialHeadline(job) {
  const c = job?.counts || {};
  const parts = [];
  if (c.running) parts.push(`진행 ${c.running}`);
  if (c.pass) parts.push(`통과 ${c.pass}`);
  if (c.fail) parts.push(`실패 ${c.fail}`);
  if (c.wait) parts.push(`엣지 보고 대기 ${c.wait}`);
  if (c.skip) parts.push(`건너뜀 ${c.skip}`);
  return parts.join(' · ') || '대상 없음';
}
