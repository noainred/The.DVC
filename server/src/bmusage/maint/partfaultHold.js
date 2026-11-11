/**
 * bmusage/maint/partfaultHold.js — 8a단계 ② **파트 장애 전이 보류**(HOLD_REASON maintenance)의 입력: ‘지금 보류할 장비’ 집합(중앙 전용).
 *
 * 파트 장애 판정은 중앙 한 곳(partfault/poller.js — 엣지는 push 만)이라 이 집합도 중앙의 창(maintenance-windows.json)으로 만든다.
 *   ⚠ 엣지 로컬 창은 여기 들어오지 않는다(중앙이 모른다 — 정직 기록). 엣지에 배포된 창은 원본이 중앙이라 같은 창이다.
 * 장비 ↔ 베어메탈 서버 대응(4단계 hwFacts · opsView 와 같은 규칙 — 복제가 아니라 같은 키): iDRAC 장비(scope 'idrac')의 서비스 태그(deviceKey) = 서버 서비스 태그 ·
 *   중앙 로컬(agent '')은 iDRAC 등록 id(deviceId) = 대상의 idrac.regId 도 본다. 맞는 서버가 없는 장비는 보류하지 않는다(모르는 장비를 억제하지 않는다).
 * 판정은 maint/judge.js 하나(② hold 를 켠 창 · 발생 끝까지 · 지금 끝내기 · 만료) — 여기서 다시 판정하지 않는다.
 * ⚠ v2.954(점검 D-2): 엣지 장비의 대응 표는 엣지 봉투(central/bmUsageEdgePull — 인메모리 · 사람이 인출할 때만)에서 온다. 중앙 재시작 뒤 · 첫 인출 전에는
 *   그 엣지 대상을 **모른다** — 그 장비는 여전히 보류하지 않지만(모르는 장비를 억제하지 않는다) 조용히 빠뜨리지 않고 ‘대상 모름’ 으로 센다
 *   (targetsUnknown: 엣지 · 장비 수 — 그 엣지 법인에 hold 창이 있을 때만 · 법인을 모르면 센다). 폴러가 상태 · 콘솔에 싣는다.
 */
import { maintJudge, countSuppression, noteApplied, localTargets, sinceOf, auditCycle } from './runtime.js';
import { windowStatus } from './judge.js';

const t = (v) => String(v ?? '').trim();
const _counted = new Set();   // `${창}|${장비}` — 창마다 장비 한 번만 센다(인메모리 · 상한)
const dkey = (agent, deviceId) => `${t(agent)}|${t(deviceId)}`;

/**
 * 순수 — 장비 목록 + 대상 목록 + 판정기 → 보류 집합.
 * @param {Array<{agent,deviceId,deviceKey,scope}>} devices  관측 · 열린 장애에서 뽑은 장비(중복 허용)
 * @param {Array<{agent,key,serviceTag,vcenterId,regId}>} targets  중앙 로컬(agent '') + 엣지 보관분(agent = 그 엣지)
 * @param {{stateFor:(target,now)=>object}} judge
 * @returns {{ hold:Set<string>, byDevice:Map<string,{ids:string[],until:number,key:string}> }}
 */
export function holdSetFor(devices = [], targets = [], judge, now = Date.now(), { knownAgents = null, blindAgent = null } = {}) {
  const byTag = new Map(); const byReg = new Map();
  for (const x of targets) {
    const tag = t(x.serviceTag).toUpperCase();
    if (tag && !byTag.has(tag)) byTag.set(tag, x);
    if (!t(x.agent) && t(x.regId) && !byReg.has(t(x.regId))) byReg.set(t(x.regId), x);
  }
  const hold = new Set(); const byDevice = new Map(); const seen = new Set();
  const unknown = new Map();   // v2.954(점검 D-2): 엣지(소문자) → 대상을 몰라 판정하지 못한 장비 수
  for (const d of devices) {
    if (!d || t(d.scope) !== 'idrac') continue;
    const ag = String(d.agent || '').trim().toLowerCase();
    const k = dkey(ag, d.deviceId);
    if (seen.has(k)) continue;
    seen.add(k);
    const tg = byTag.get(t(d.deviceKey).toUpperCase()) || (!t(d.agent) ? byReg.get(t(d.deviceId)) : null);
    if (!tg) {
      if (ag && knownAgents && !knownAgents.has(ag) && (!blindAgent || blindAgent(ag))) unknown.set(ag, (unknown.get(ag) || 0) + 1);
      continue;
    }
    const s = judge.stateFor(tg, now);
    if (!s?.scopes?.hold) continue;
    hold.add(k);
    byDevice.set(k, { ids: s.windows.filter((w) => w.scopes.includes('hold')).map((w) => w.id), until: s.until.hold, since: sinceOf(s, 'hold'), key: t(tg.key) });
  }
  return { hold, byDevice, ...(unknown.size ? { targetsUnknown: { agents: [...unknown.keys()].sort().slice(0, 64), devices: [...unknown.values()].reduce((a, b) => a + b, 0) } } : {}) };
}

/** 중앙의 대상 목록(로컬 + 엣지 보관분) — 장비 대응용 최소 필드. out.knownAgents = 봉투(대상 목록)를 가진 엣지(소문자 — v2.954 D-2). */
async function centralTargets() {
  const out = []; const knownAgents = new Set();
  out.knownAgents = knownAgents;
  // 로컬 대상은 폴러가 등록한 공급자(runtime.localTargets)로 — 모르면 로컬 장비는 보류하지 않는다.
  for (const x of await localTargets()) out.push({ agent: '', key: x.key, serviceTag: x.serviceTag, vcenterId: x.vcenterId, regId: x.idrac?.regId || '' });
  try {
    for (const rec of (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()) {
      if (rec?.snap && Array.isArray(rec.snap.targets)) knownAgents.add(String(rec.agent || '').trim().toLowerCase());
      for (const x of rec?.snap?.targets || []) out.push({ agent: String(rec.agent || '').toLowerCase(), key: x.key, serviceTag: x.serviceTag, vcenterId: x.vcenterId, regId: '' });
    }
  } catch { out.knownAgents = null; /* 보관소를 못 읽으면 ‘모름’ 계수도 하지 않는다(판정 못 함 — 빈 집합과 같다) */ }
  return out;
}

/**
 * 파트 장애 폴러가 부른다 — 보류 집합 + 계수 · 점검 기록. 실패하면 빈 집합(보류하지 않는다 — 평소대로 전이).
 * @returns {Promise<{hold:Set<string>, byDevice:Map, error?:string}>}
 */
export async function partfaultMaintHold(devices = [], { now = Date.now(), deps = {} } = {}) {
  try {
    const judge = deps.judge || await maintJudge({ now });
    if (!judge.windows.some((w) => w.scopes?.hold && !w.deleted)) { await (deps.audit || auditCycle)({ now }).catch(() => null); return { hold: new Set(), byDevice: new Map() }; }
    const targets = deps.targets || await centralTargets();
    // v2.954(점검 D-2): 대상을 모르는 엣지의 장비 — 그 엣지 법인에 진행 중인 hold 창이 있을 때만 ‘모름’ 으로 센다(법인 매핑을 모르면 센다)
    const holdCorps = new Set(judge.windows.filter((w) => w.scopes?.hold && !w.deleted && windowStatus(w, now).status === 'active').map((w) => t(w.vcenterId)));
    let corpsOf = deps.corpsOf || null;
    if (!corpsOf) { try { corpsOf = (await import('../edgeCorps.js')).edgeCorpsSource(); } catch { corpsOf = null; } }
    const blindAgent = (ag) => { let cs = []; try { cs = corpsOf ? corpsOf(ag) || [] : []; } catch { cs = []; } return !cs.length || cs.some((c) => holdCorps.has(t(c))); };
    const r = holdSetFor(devices, targets, judge, now, { knownAgents: deps.knownAgents !== undefined ? deps.knownAgents : (targets.knownAgents || null), blindAgent });
    for (const [k, v] of r.byDevice) {
      noteApplied('hold', v.key, v.until, v.ids, now, { since: v.since });
      // 계수는 장비마다 창 한 번(주기마다 세지 않는다 — 화면 ‘전이 보류 n대’).
      const fresh = v.ids.filter((id) => !_counted.has(`${id}|${k}`));
      for (const id of fresh) { _counted.add(`${id}|${k}`); if (_counted.size > 20_000) _counted.clear(); }
      if (fresh.length) countSuppression('hold', fresh, { now });
    }
    // 점검 · 계수 저장(중앙 — 로컬 bmusage 대상이 0대여도 남게: 반증 의심 항목 ‘flushMaintStats 호출처 0’)
    const audit = await (deps.audit || auditCycle)({ now }).catch(() => null);
    return { ...r, ...(audit ? { audit: { checked: audit.checked, leak: audit.leak } } : {}) };
  } catch (e) { return { hold: new Set(), byDevice: new Map(), error: String(e?.message || e).slice(0, 160) }; }
}
