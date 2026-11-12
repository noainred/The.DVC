/**
 * bmfolders/build.js — 물리서버 폴더 판정 · 집계(순수 — DB · 네트워크 · 저장소를 읽지 않는다. v2.984).
 *
 * 입력 = 구성원(베어메탈 + ESXi 호스트 — 라우트가 서비스 인벤토리의 입력 수집에서 만든다) + 저장소 두 판(폴더 · 등록) + 범위.
 * 판정은 **구성원마다 한 번**(placeOf) — 트리 · 표 · 미분류 묶음 · 찾기 · 쓰기 미리보기가 같은 Map 을 쓴다(판정 코어 하나).
 *
 * 놓는 자리(place) 순서:
 *   ① 손 등록(assign[key]) — 그 법인이 지금 법인과 같을 때만. 다르면 **놓지 않고** 법인 불일치(mismatch)로 따로 센다
 *      (서버의 법인 귀속이 바뀌었다 — 다른 법인 폴더에 조용히 남기지 않는다).
 *   ② 자동 규칙(설정 autoRules 가 켜졌을 때만 · 베어메탈만) — 이름에 값이 들어가면(대소문자 무시 · 정규식 아님) 그 폴더.
 *      법인 규칙이 전 법인('*') 규칙보다 먼저 · 긴 값 먼저 · 그다음 등록 순.
 *   ③ 없음 = (미분류). 법인이 없는 서버는 폴더에 넣을 수 없다 = (법인 미지정) — 전체 범위 계정만 본다.
 * 등록은 남았는데 목록에 없는 서버: 출처를 다 읽었을 때만 '없어짐(ghost)', 못 읽은 출처 · 수집 전 법인이 있으면 '보류(held)' — 보류는 지우지 않는다.
 */
import { ruleNameOf } from '../util/ruleName.js';
import { ancestorsOf, underPath, LIMITS } from './store.js';

const t = (v) => (typeof v === 'string' ? v.trim() : '');
const lc = (v) => t(v).toLowerCase();

/** 구성원의 서버 목록 수집 경로 — 중앙(이 포탈의 iDRAC 스캔 · OME · vCenter) · 엣지 push · 수집 서버 pull. */
export function srcClassOf(m) {
  if (m?.source === 'edge') return 'edge';
  if (m?.source === 'remote') return 'collector';
  return 'central';
}

/** 규칙 적용 순서 — 법인 규칙 먼저 · 긴 값 먼저 · 그다음 등록 순(안정). */
export function sortRules(rules = []) {
  return rules.map((r, i) => ({ r, i }))
    .sort((a, b) => ((a.r.corp === '*') - (b.r.corp === '*')) || (b.r.value.length - a.r.value.length) || (a.i - b.i))
    .map((x) => x.r);
}
/** 규칙이 보는 이름 — 가린 뒤 이름(v2.987 · 1차 반증 5). 판정 코어는 `util/ruleName.js` 하나(서비스 인벤토리 이름 규칙도 같은 함수 — v2.989). */
export { ruleNameOf };
/** 규칙이 보는 이름(ruleNameOf)에 값이 들어간 첫 규칙 — 그 법인 규칙 또는 '*' 규칙만. */
export function ruleFor(m, sorted) {
  const n = ruleNameOf(m);
  if (!n || !m?.corp) return null;
  for (const r of sorted) {
    if (r.corp !== '*' && r.corp !== m.corp) continue;
    const v = lc(r.value);
    if (v && n.includes(v)) return r;
  }
  return null;
}

/**
 * 구성원 하나의 자리 — { path, src: 'manual'|'rule'|null, ruleId?, moved? }.
 * moved = 손 등록의 법인(지금 법인과 다르다 — 놓지 않는다).
 */
/**
 * 별칭으로 쓸 수 있는 키 — **다른 구성원의 지금 키가 아니고 한 구성원만 주장하는** 별칭(반증 3a A1 — 재현: ESXi 를 베어메탈로 강제한 행의 별칭은
 * 법인 없는 이름 해시라 두 법인의 같은 이름 호스트에서 A 의 지금 키 = B 의 별칭이었고, B 를 고치는 조작이 A 의 등록을 지웠다).
 * 서비스 인벤토리의 keyCorps 가드와 같은 뜻. members 전체로 만든다(범위와 무관).
 */
export function aliasGuardOf(members = []) {
  const own = new Set(); const claims = new Map();
  for (const m of members) {
    if (!m?.key) continue;
    own.add(m.key);
    for (const k of new Set(m.aliasKeys || [])) if (k !== m.key) claims.set(k, (claims.get(k) || 0) + 1);
  }
  const ok = new Set();
  for (const [k, n] of claims) if (n === 1 && !own.has(k)) ok.add(k);
  return ok;
}
/** 이 구성원의 별칭 등록 키 — 쓸 수 있는 별칭(aliasOk) · **같은 법인 등록만**(다른 법인 것은 이 서버의 것이라 단정하지 않는다 — 없어짐 · 보류로 남겨 그 법인이 정리). */
export function aliasRegsOf(m, assign, aliasOk) {
  const out = [];
  if (!m?.corp) return out;
  for (const k of m.aliasKeys || []) { const a = assign?.[k]; if (a && a.corp === m.corp && aliasOk?.has?.(k)) out.push(k); }
  return out;
}
/**
 * 이 구성원의 손 등록 — 지금 키 먼저, 없으면 같은 법인 별칭 등록(키 등급이 오르기 전 fl: — v2.989 ③-가). { a, k } 또는 null.
 * 예전에는 지금 키만 봐서 태그를 나중에 읽은 서버의 등록이 '없어짐' 이 되고 서버는 (미분류)로 돌아갔다.
 */
export function assignOf(m, assign, aliasOk = null) {
  const own = assign?.[m?.key];
  if (own) return { a: own, k: m.key };
  const al = aliasRegsOf(m, assign, aliasOk);
  return al.length ? { a: assign[al[0]], k: al[0] } : null;
}
export function placeMember(m, assign, sortedRules, autoRules, aliasOk = null) {
  const hitA = assignOf(m, assign, aliasOk);
  const a = hitA?.a;
  if (a && a.corp === m.corp && m.corp) return { path: a.path, src: 'manual', ...(hitA.k !== m.key ? { aliasKey: hitA.k } : {}) };
  if (a && a.corp !== m.corp) return { path: '', src: null, moved: a.corp };
  if (autoRules && m.kind === 'bm') {
    const r = ruleFor(m, sortedRules);
    if (r) return { path: r.path, src: 'rule', ruleId: r.id };
  }
  return { path: '', src: null };
}

/**
 * 이름 앞부분(미분류 묶음용) — FQDN 앞 · 끝의 숫자와 구분자('-' '_')를 걷어 낸 나머지. 3자 미만이면 ''.
 * 'use-web-01' → 'use-web' · 'kr-gpu-12.corp.local' → 'kr-gpu'. 정규식 없이 선형(외부 입력).
 */
export function namePrefix(name) {
  const n = lc(name).slice(0, 128);
  const d = n.indexOf('.');
  const base = d > 0 ? n.slice(0, d) : n;
  let i = base.length;
  while (i > 0 && base[i - 1] >= '0' && base[i - 1] <= '9') i -= 1;
  while (i > 0 && (base[i - 1] === '-' || base[i - 1] === '_')) i -= 1;
  const core = base.slice(0, i);
  return core.length >= 3 && i < base.length ? core : '';   // 걷어 낸 것이 없으면(번호 없는 이름) 묶음 근거가 아니다
}

/**
 * 트리 · 집계 전부.
 * @param {object} o
 * @param {object[]} o.members   [{ key, kind:'bm'|'esxi', corp, name, serviceTag, model, source, faults, nameIsAddr, … }]
 * @param {object} o.main        bm-folders.json(동결 참조)
 * @param {object} o.assign      { key → { corp, path, name } }(동결 참조)
 * @param {Set<string>|null} o.allowed  범위(null = 전체)
 * @param {boolean} o.bmBlocked  베어메탈 출처 중 못 읽은 것이 있다(없어짐 판정을 미룬다)
 * @param {Set<string>} o.holdCorps  수집 전 · 꺼진 법인(그 법인 등록은 보류)
 * @param {boolean} o.snapInitial 수집 전 골격 스냅샷(모든 등록 보류)
 * @param {Set<string>|null} [o.heldKeys] 출처(수집 서버)가 지금 보고하지만 분류 목록에서 빠진 키 — 그 등록은 보류(v2.989 ③-나)
 * @param {(m:object)=>string} [o.nameFn] 화면에 보이는 이름(가린 이름) — 이름 앞부분 묶음은 이 이름으로만 만든다(가린 태그 · 주소 조각이 묶음 이름으로 새지 않게)
 */
export function buildFolders({ members = [], main, assign = {}, allowed = null, bmBlocked = false, holdCorps = new Set(), snapInitial = false, nameFn = null, heldKeys = null } = {}) {
  const inScope = (vc) => (allowed ? !!vc && allowed.has(vc) : true);
  const sorted = sortRules(main?.rules || []);
  const autoRules = main?.settings?.autoRules === true;

  const placeOf = new Map();
  const byKey = new Map();
  const corpAgg = new Map();   // vc → 집계
  const aggOf = (vc) => {
    let a = corpAgg.get(vc);
    if (!a) {
      a = { vcenterId: vc, total: 0, bm: 0, esxiPlaced: 0, registered: 0, unassigned: 0, byRule: 0, faults: 0, faultsUnknown: 0,
        sources: { central: 0, edge: 0, collector: 0 }, agents: new Set(), paths: new Map(), held: 0, ghosts: 0, mismatch: 0 };
      corpAgg.set(vc, a);
    }
    return a;
  };
  let noCorp = 0;
  const mismatch = [];
  const unassignedBm = [];

  const aliasOk = aliasGuardOf(members);
  const aliasUsed = new Set();   // 배치에 실제로 쓴 별칭 등록 — 이것만 '지금 있는 서버의 것'(없어짐에서 뺀다)
  for (const m of members) {
    if (!m || !m.key) continue;
    byKey.set(m.key, m);
    const p = placeMember(m, assign, sorted, autoRules, aliasOk);
    if (p.aliasKey) aliasUsed.add(p.aliasKey);
    placeOf.set(m.key, p);
    if (!m.corp) {
      if (!allowed && m.kind === 'bm') noCorp += 1;
      // 법인 귀속이 빠진 서버의 예전 등록은 전체 범위에만 싣는다(법인 미지정 데이터는 범위 계정에 없다 — 반증 7)
      if (p.moved && !allowed) mismatch.push({ key: m.key, corp: '', was: p.moved, path: assign[m.key]?.path || '' });
      continue;
    }
    if (p.moved && (inScope(p.moved) || inScope(m.corp))) mismatch.push({ key: m.key, corp: inScope(m.corp) ? m.corp : '', was: inScope(p.moved) ? p.moved : '', path: inScope(p.moved) ? (assign[m.key]?.path || '') : '' });
    if (!inScope(m.corp)) continue;
    // ESXi 호스트는 폴더에 들어 있을 때만 이 화면의 서버다(기본은 베어메탈 — 찾기에서 고른 것만 들어온다)
    if (m.kind !== 'bm' && !p.src) continue;
    const a = aggOf(m.corp);
    a.total += 1;
    if (m.kind === 'bm') a.bm += 1; else a.esxiPlaced += 1;
    a.sources[srcClassOf(m)] += 1;
    if (m.source === 'edge' && t(m.remoteAgent)) a.agents.add(t(m.remoteAgent));
    if (m.source === 'remote' && t(m.collectorId)) a.agents.add(`collector:${t(m.collectorId)}`);
    if (m.faults == null) a.faultsUnknown += 1; else if (m.faults > 0) a.faults += 1;
    if (p.moved) a.mismatch += 1;
    if (p.src) {
      a.registered += 1;
      if (p.src === 'rule') a.byRule += 1;
      const s = a.paths.get(p.path) || { direct: 0, faults: 0 };
      s.direct += 1; if (m.faults > 0) s.faults += 1;
      a.paths.set(p.path, s);
    } else {
      a.unassigned += 1;
      unassignedBm.push(m);
    }
  }

  // 목록에 없는 등록(보류 · 없어짐)
  const missing = [];
  // 배치에 쓴 별칭 등록(키 등급이 오르기 전 키)은 지금 있는 서버의 것이다 — 없어짐으로 세지 않는다(v2.989 ③-가).
  //   쓰지 않은 별칭 등록(다른 법인 · 같은 서버의 지금 키 등록이 따로 있음 · 겹친 별칭)은 예전처럼 없어짐 · 보류로 보인다(반증 3a A2 · A3 — 정리할 수 있게)
  for (const [k, a] of Object.entries(assign || {})) {
    if (byKey.has(k) || aliasUsed.has(k) || !inScope(a.corp)) continue;
    // 수집 서버가 지금 보고하는 서버인데 분류 목록에서만 빠졌다(전력 미보고 · 오래됨 — v2.989 ③-나) → 보류(시한은 만드는 쪽 `bmHeldKeys` 가 진다)
    const listed = !!heldKeys?.has?.(k);
    const held = snapInitial || bmBlocked || holdCorps.has(a.corp) || listed;
    missing.push({ key: k, corp: a.corp, path: a.path, name: a.name || '', addr: a.addr === true, state: held ? 'held' : 'ghost',
      why: snapInitial ? 'snapshot-initial' : holdCorps.has(a.corp) ? 'corp-hold' : bmBlocked ? 'source-unread' : listed ? 'collector-listed' : '' });
    const g = aggOf(a.corp);
    if (held) g.held += 1; else g.ghosts += 1;
  }

  // 법인별 폴더 트리 — 명시 폴더 ∪ 서버가 놓인 경로 ∪ 조상
  const explicit = main?.corps || {};
  const corpIds = new Set([...corpAgg.keys(), ...Object.keys(explicit).filter((vc) => inScope(vc))]);
  const corps = [];
  for (const vc of corpIds) {
    const a = aggOf(vc);
    const set = new Set(explicit[vc]?.folders || []);
    for (const p of a.paths.keys()) { set.add(p); for (const x of ancestorsOf(p)) set.add(x); }
    for (const x of missing) if (x.corp === vc) { set.add(x.path); for (const y of ancestorsOf(x.path)) set.add(y); }
    const paths = [...set].sort((x, y) => x.localeCompare(y, 'ko'));
    const ex = new Set(explicit[vc]?.folders || []);
    // 폴더 삭제 확인(expect)은 서버가 세는 것(그 법인 등록 중 경로 아래 — 목록에 없는 등록 · 별칭 등록 포함)과 같은 셈이어야 한다(반증 3a 별건 — 화면이 손 등록 서버 행만 세서 늘 409)
    const regPaths = Object.values(assign || {}).filter((x) => x && x.corp === vc).map((x) => x.path);
    const folders = paths.map((p) => {
      let total = 0; let faults = 0;
      for (const [q, s] of a.paths) if (underPath(q, p)) { total += s.direct; faults += s.faults; }
      const segs = p.split('\\');
      let regs = 0; for (const q of regPaths) if (underPath(q, p)) regs += 1;
      return { path: p, name: segs[segs.length - 1], depth: segs.length, direct: a.paths.get(p)?.direct || 0, total, faults, regs, explicit: ex.has(p) };
    });
    corps.push({
      vcenterId: vc, total: a.total, bm: a.bm, esxiPlaced: a.esxiPlaced, registered: a.registered, unassigned: a.unassigned, byRule: a.byRule,
      faults: a.faults, faultsUnknown: a.faultsUnknown, sources: a.sources, agents: [...a.agents].sort(), held: a.held, ghosts: a.ghosts, mismatch: a.mismatch, folders,
    });
  }

  // 이름 앞부분이 같은 미분류 베어메탈(3대 이상 · 상위 8개) — 주소처럼 보이는 이름 · 이름이 곧 태그인 서버는 뺀다(가림 대상)
  const groups = new Map();
  for (const m of unassignedBm) {
    if (m.kind !== 'bm' || m.nameIsAddr || (m.serviceTag && lc(m.name) === lc(m.serviceTag))) continue;
    const pf = namePrefix(nameFn ? nameFn(m) : m.name);
    if (!pf) continue;
    const g = groups.get(pf) || { prefix: pf, n: 0, corps: new Set() };
    g.n += 1; g.corps.add(m.corp);
    groups.set(pf, g);
  }
  const prefixGroups = [...groups.values()].filter((g) => g.n >= 3)
    .sort((a, b) => (b.n - a.n) || a.prefix.localeCompare(b.prefix))
    .slice(0, 8).map((g) => ({ prefix: g.prefix, n: g.n, corps: [...g.corps].sort() }));

  return { placeOf, byKey, corps, noCorp, missing, mismatch, prefixGroups, autoRules, aliasOk };
}

/** 찾기 글자 목록 — 소문자 · 앞뒤 공백 제거 · 제어 문자 제거 · 64자 · 중복 제거 · 최대 10개. */
export function parseTokens(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const x of raw) {
    // eslint-disable-next-line no-control-regex
    const s = lc(String(x ?? '').slice(0, 256).replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, LIMITS.ruleValue);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= LIMITS.includeTokens) break;
  }
  return out;
}

/**
 * 서버 찾기(일괄 등록) — 포함 글자 중 **하나라도** 찾는 곳 중 하나에 들어가면 일치 · 제외 글자가 하나라도 들어가면 뺀다.
 * 포함 글자가 없으면 아무것도 맞지 않는다(전체를 돌려주지 않는다).
 * @param {object} o  { include[], exclude[], fields:{name,tag,model,addr}, kinds:{bm,esxi}, corp, allowed, unassignedOnly, hideTag, showAddr, nameFn }
 *   addr(관리 주소)는 showAddr(관리자 판본)일 때만 찾는다 — 비관리자가 주소를 맞혀 보는 길이 되지 않게.
 *   nameFn = 화면에 보이는 이름(가린 이름) — 주어지면 그 이름으로만 맞춘다(가린 주소 · 태그로 맞혀 보는 길을 막는다).
 * @returns {{ rows:{m,place,on}[], total:number, facets:object }}
 */
export function searchMembers(members, placeOf, o = {}) {
  const inc = parseTokens(o.include); const exc = parseTokens(o.exclude);
  const fields = { name: o.fields?.name !== false, tag: !o.hideTag && o.fields?.tag === true, model: o.fields?.model === true, addr: o.showAddr === true && o.fields?.addr === true };
  const kinds = { bm: o.kinds?.bm !== false, esxi: o.kinds?.esxi === true };
  const facets = { corp: {}, src: {}, state: { unassigned: 0, foldered: 0 }, model: {}, on: { name: 0, tag: 0, model: 0, addr: 0 } };
  const rows = [];
  if (!inc.length) return { rows, total: 0, facets };
  const bump = (o2, k) => { o2[k] = (o2[k] || 0) + 1; };
  for (const m of members) {
    if (!m?.corp) continue;   // 법인이 없는 서버는 폴더에 넣을 수 없다
    if (o.allowed && !o.allowed.has(m.corp)) continue;
    if (o.corp && m.corp !== o.corp) continue;
    if (m.kind === 'bm' ? !kinds.bm : !kinds.esxi) continue;
    const place = placeOf.get(m.key) || { path: '', src: null };
    if (o.unassignedOnly && place.src) continue;
    const name = lc(o.nameFn ? o.nameFn(m) : m.name).slice(0, 256); const tag = fields.tag ? lc(m.serviceTag) : ''; const model = fields.model ? lc(m.model).slice(0, 128) : '';
    const addr = fields.addr ? lc(m.mgmtHost).slice(0, 300) : '';
    let on = '';
    for (const v of inc) {
      if (fields.name && name.includes(v)) { on = 'name'; break; }
      if (fields.tag && tag && tag.includes(v)) { on = 'tag'; break; }
      if (fields.model && model.includes(v)) { on = 'model'; break; }
      if (fields.addr && addr && addr.includes(v)) { on = 'addr'; break; }
    }
    if (!on) continue;
    if (exc.some((v) => name.includes(v) || (fields.model && model.includes(v)) || (fields.tag && tag && tag.includes(v)))) continue;
    bump(facets.corp, m.corp); bump(facets.src, srcClassOf(m)); bump(facets.state, place.src ? 'foldered' : 'unassigned');
    bump(facets.model, t(m.model) || '(모름)'); bump(facets.on, on);
    rows.push({ m, place, on });
  }
  // 모델 패싯은 상위 12개만(나머지는 '그 밖' 으로 합친다 — 조용히 버리지 않는다)
  const models = Object.entries(facets.model).sort((a, b) => b[1] - a[1]);
  if (models.length > 12) {
    facets.model = Object.fromEntries(models.slice(0, 12));
    facets.model['(그 밖)'] = models.slice(12).reduce((s, [, n]) => s + n, 0);
  }
  rows.sort((a, b) => a.m.name.localeCompare(b.m.name, 'ko'));
  return { rows, total: rows.length, facets };
}
