/**
 * bmusage/maint/partfaultHold.js — 8a단계 ② **파트 장애 전이 보류**(HOLD_REASON maintenance)의 입력: ‘지금 보류할 장비’ 집합(중앙 전용).
 *
 * 파트 장애 판정은 중앙 한 곳(partfault/poller.js — 엣지는 push 만)이라 이 집합도 중앙의 창(maintenance-windows.json)으로 만든다.
 *   ⚠ 엣지 로컬 창은 여기 들어오지 않는다(중앙이 모른다 — 정직 기록). 엣지에 배포된 창은 원본이 중앙이라 같은 창이다.
 * 장비 ↔ 베어메탈 서버 대응(4단계 hwFacts · opsView 와 같은 규칙 — 복제가 아니라 같은 키): iDRAC 장비(scope 'idrac')의 서비스 태그(deviceKey) = 서버 서비스 태그 ·
 *   중앙 로컬(agent '')은 iDRAC 등록 id(deviceId) = 대상의 idrac.regId 도 본다. 맞는 서버가 없는 장비는 보류하지 않는다(모르는 장비를 억제하지 않는다).
 * 판정은 maint/judge.js 하나(② hold 를 켠 창 · 발생 끝까지 · 지금 끝내기 · 만료) — 여기서 다시 판정하지 않는다.
 */
import { maintJudge, countSuppression, noteApplied, localTargets } from './runtime.js';

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
export function holdSetFor(devices = [], targets = [], judge, now = Date.now()) {
  const byTag = new Map(); const byReg = new Map();
  for (const x of targets) {
    const tag = t(x.serviceTag).toUpperCase();
    if (tag && !byTag.has(tag)) byTag.set(tag, x);
    if (!t(x.agent) && t(x.regId) && !byReg.has(t(x.regId))) byReg.set(t(x.regId), x);
  }
  const hold = new Set(); const byDevice = new Map(); const seen = new Set();
  for (const d of devices) {
    if (!d || t(d.scope) !== 'idrac') continue;
    const k = dkey(String(d.agent || '').toLowerCase(), d.deviceId);
    if (seen.has(k)) continue;
    seen.add(k);
    const tg = byTag.get(t(d.deviceKey).toUpperCase()) || (!t(d.agent) ? byReg.get(t(d.deviceId)) : null);
    if (!tg) continue;
    const s = judge.stateFor(tg, now);
    if (!s?.scopes?.hold) continue;
    hold.add(k);
    byDevice.set(k, { ids: s.windows.filter((w) => w.scopes.includes('hold')).map((w) => w.id), until: s.until.hold, key: t(tg.key) });
  }
  return { hold, byDevice };
}

/** 중앙의 대상 목록(로컬 + 엣지 보관분) — 장비 대응용 최소 필드. */
async function centralTargets() {
  const out = [];
  // 로컬 대상은 폴러가 등록한 공급자(runtime.localTargets)로 — 모르면 로컬 장비는 보류하지 않는다.
  for (const x of await localTargets()) out.push({ agent: '', key: x.key, serviceTag: x.serviceTag, vcenterId: x.vcenterId, regId: x.idrac?.regId || '' });
  try {
    for (const rec of (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()) {
      for (const x of rec?.snap?.targets || []) out.push({ agent: String(rec.agent || '').toLowerCase(), key: x.key, serviceTag: x.serviceTag, vcenterId: x.vcenterId, regId: '' });
    }
  } catch { /* */ }
  return out;
}

/**
 * 파트 장애 폴러가 부른다 — 보류 집합 + 계수 · 점검 기록. 실패하면 빈 집합(보류하지 않는다 — 평소대로 전이).
 * @returns {Promise<{hold:Set<string>, byDevice:Map, error?:string}>}
 */
export async function partfaultMaintHold(devices = [], { now = Date.now(), deps = {} } = {}) {
  try {
    const judge = deps.judge || await maintJudge({ now });
    if (!judge.windows.some((w) => w.scopes?.hold)) return { hold: new Set(), byDevice: new Map() };
    const targets = deps.targets || await centralTargets();
    const r = holdSetFor(devices, targets, judge, now);
    for (const [k, v] of r.byDevice) {
      noteApplied('hold', v.key, v.until, v.ids, now);
      // 계수는 장비마다 창 한 번(주기마다 세지 않는다 — 화면 ‘전이 보류 n대’).
      const fresh = v.ids.filter((id) => !_counted.has(`${id}|${k}`));
      for (const id of fresh) { _counted.add(`${id}|${k}`); if (_counted.size > 20_000) _counted.clear(); }
      if (fresh.length) countSuppression('hold', fresh, { now });
    }
    return r;
  } catch (e) { return { hold: new Set(), byDevice: new Map(), error: String(e?.message || e).slice(0, 160) }; }
}
