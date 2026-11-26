/**
 * bmcheck/state.js — 물리서버 점검(보증 · 펌웨어 기준선 · BIOS 편차)의 입력 모으기 + 판정 호출(v3.45).
 *
 *  · 입력은 물리서버 폴더 목록과 **같은 것**(같은 구성원 · 같은 배치 · 같은 하드웨어 찾기 `hwLookupFactory`) — 판정용 수집을 따로 만들지 않는다.
 *  · 판정 묶음은 법인을 넘지 않는다(fw: 법인 · 모델 / bios: 법인 · 폴더 · 모델) — 그래서 **그 계정에 보이는 구성원만 넣어도 결과가 같다**.
 *    범위 계정의 판정에 다른 법인 서버의 값이 들어가지 않는다(가림).
 *  · 서버(kind 'bm')만 펌웨어 · BIOS 를 본다. 보증은 서비스 태그가 있는 모든 행(ESXi 호스트 포함 — 같은 물리 박스다).
 */
import { fwComponentsOfInv, fwStoredOf, judgeFirmware } from './fw.js';
import { biosAttrsOf, judgeBios } from './bios.js';
import { numOrNull } from '../util/numOrNull.js';
import { warrantyOf } from './warranty.js';
import { advisoriesFor } from './advisory.js';   // v3.50 펌웨어 보안 권고 대조(④)

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const _biosMemo = new WeakMap();   // 인벤토리 · 정제본 객체 → BIOS 설정(요청마다 같은 객체를 다시 훑지 않는다 — 반증 A6)
function biosOfObj(owner, attrs) {
  if (!owner || typeof owner !== 'object') return biosAttrsOf(attrs);
  let b = _biosMemo.get(owner);
  if (b === undefined) { b = biosAttrsOf(attrs); _biosMemo.set(owner, b); }
  return b;
}

/**
 * @param {{ members: object[], placeOf: Map<string, {path?:string, src?:string}>|null, hxOf: ((m:object)=>object|null)|null,
 *           assets: Record<string, object>|null, adminBase: ((model:string,key:string)=>string)|null, today: string }} input
 *        hxOf 가 null 이면(찾기를 만들지 못함) 펌웨어 · BIOS 는 판정하지 않는다(fw · bios = undefined — 화면이 '판정하지 못함' 으로).
 *        assets 가 null 이면(원장을 읽지 못함) 보증도 판정하지 않는다(warranty = undefined).
 *        advisories(v3.50) 가 null 이면(권고 표를 읽지 못함) 권고 대조를 하지 않는다(adv = undefined) · 빈 목록이면 adv.state = 'no-table'.
 * @returns {{ of: (key:string) => { warranty?:object, fw?:object, bios?:object } }}
 */
export function bmCheckFor({ members, placeOf, hxOf, assets, adminBase, today, advisories = null } = {}) {
  const list = Array.isArray(members) ? members : [];
  const fwIn = []; const biosIn = []; const atOf = new Map();
  if (typeof hxOf === 'function') {
    for (const m of list) {
      if (m?.kind !== 'bm') continue;
      let hx = null;
      try { hx = hxOf(m); } catch { hx = null; }
      const p = placeOf?.get?.(m.key);
      const path = p?.src ? String(p.path || '') : '';
      let fw; let bios;
      if (hx?.via === 'edge') {
        // 정제본 — 쓰기 직전에 형식을 다시 본다(재시작 뒤 저장본은 다시 정제되지 않는다: 반증 A14). 없으면 undefined(받지 못함)
        fw = fwStoredOf(hx.fw);
        bios = hx.bios && typeof hx.bios === 'object' && !Array.isArray(hx.bios) ? (biosOfObj(hx.bios, hx.bios) || undefined) : undefined;
        atOf.set(m.key, numOrNull(hx.hw?.at));   // 엣지는 요약의 읽은 시각(같은 인벤토리)
      } else if (hx?.inv) {
        fw = fwComponentsOfInv(hx.inv); bios = biosOfObj(hx.inv, hx.inv.bios?.attributes);
        atOf.set(m.key, numOrNull(hx.inv.collectedAt));
      } else { fw = null; bios = null; }                         // 인벤토리 없음 = 못 읽음
      fwIn.push({ id: m.key, corp: m.corp, model: m.model, fw });
      biosIn.push({ id: m.key, corp: m.corp, path, model: m.model, bios });
    }
  }
  const fwOf = typeof hxOf === 'function' ? judgeFirmware(fwIn, { admin: adminBase }) : null;
  const biosOf = typeof hxOf === 'function' ? judgeBios(biosIn) : null;
  return {
    of(key) {
      const m = list.find((x) => x.key === key);
      return { ...(m ? this.ofMember(m) : {}) };
    },
    ofMember(m) {
      const out = {};
      // 원장은 { 태그: 줄 } 객체다 — 자기 열쇠만 본다(태그가 'constructor' 인 서버가 Object 의 것을 줄로 읽지 않게)
      if (assets && lc(m.serviceTag)) out.warranty = warrantyOf(Object.hasOwn(assets, lc(m.serviceTag)) ? assets[lc(m.serviceTag)] : null, today);
      else if (assets) out.warranty = warrantyOf(null, today);
      if (m.kind === 'bm' && fwOf) out.fw = fwOf.get(m.key);
      if (m.kind === 'bm' && biosOf) out.bios = biosOf.get(m.key);
      // 판정에 쓴 인벤토리를 읽은 시각(없으면 null) — 화면이 ‘언제 값인가’ 를 보인다. 오래된 값을 지금 값처럼 말하지 않게(반증 A7)
      if (m.kind === 'bm' && fwOf) out.invAt = atOf.get(m.key) ?? null;
      // v3.50 권고 대조 — 펌웨어 판정 줄(설치 버전)과 권고 표. 펌웨어를 못 읽었으면 no-fw(걸린 것 없음이 아니다)
      if (m.kind === 'bm' && fwOf && Array.isArray(advisories)) {
        const f = out.fw;
        out.adv = advisoriesFor({ model: m.model, rows: f && Array.isArray(f.rows) && !['unread', 'unsent'].includes(f.state) ? f.rows : null }, advisories);
      }
      return out;
    },
  };
}

/** 목록 행에 싣는 작은 요약 — { w, wd, fw, fwn, bios, biosn }. 판정하지 못한 것은 키를 만들지 않는다. */
export function chkRowOf(c) {
  if (!c) return undefined;
  const o = {};
  if (c.warranty) { o.w = c.warranty.state; if (c.warranty.daysLeft != null) o.wd = c.warranty.daysLeft; }
  // 갈림(split)은 견준 줄 수(fwj · biosj)를 함께 싣는다 — 견준 줄이 0 인 갈림(구성요소가 모두 섞임 · 1:1 갈림)은 건강 점수에서 ‘모름’ 이다(v3.50 반증 A1)
  if (c.fw) { o.fw = c.fw.state; if (c.fw.behind) o.fwn = c.fw.behind; if (c.fw.differ) o.fwd = c.fw.differ; if (c.fw.state === 'split') o.fwj = Number(c.fw.judged) || 0; }
  if (c.bios) { o.bios = c.bios.state; if (c.bios.diff) o.biosn = c.bios.diff; if (c.bios.state === 'split') o.biosj = Number(c.bios.judged) || 0; }
  // v3.50 권고: 걸림 수(adv) · 가장 높은 심각도(advs). 표가 비었거나 펌웨어를 못 읽었으면 상태 글자만(adv 수 없음 — 0 으로 읽히지 않게)
  if (c.adv) { o.adva = c.adv.state; if (c.adv.state === 'hit') { o.adv = Number.isFinite(c.adv.total) ? c.adv.total : c.adv.hits.length; o.advs = c.adv.hits[0]?.sev || ''; } }
  return Object.keys(o).length ? o : undefined;
}
