/**
 * bmcheck/state.js — 물리서버 점검(보증 · 펌웨어 기준선 · BIOS 편차)의 입력 모으기 + 판정 호출(v3.45).
 *
 *  · 입력은 물리서버 폴더 목록과 **같은 것**(같은 구성원 · 같은 배치 · 같은 하드웨어 찾기 `hwLookupFactory`) — 판정용 수집을 따로 만들지 않는다.
 *  · 판정 묶음은 법인을 넘지 않는다(fw: 법인 · 모델 / bios: 법인 · 폴더 · 모델) — 그래서 **그 계정에 보이는 구성원만 넣어도 결과가 같다**.
 *    범위 계정의 판정에 다른 법인 서버의 값이 들어가지 않는다(가림).
 *  · 서버(kind 'bm')만 펌웨어 · BIOS 를 본다. 보증은 서비스 태그가 있는 모든 행(ESXi 호스트 포함 — 같은 물리 박스다).
 */
import { fwComponentsOf, judgeFirmware } from './fw.js';
import { biosAttrsOf, judgeBios } from './bios.js';
import { warrantyOf } from './warranty.js';

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * @param {{ members: object[], placeOf: Map<string, {path?:string, src?:string}>|null, hxOf: ((m:object)=>object|null)|null,
 *           assets: Record<string, object>|null, adminBase: ((model:string,key:string)=>string)|null, today: string }} input
 *        hxOf 가 null 이면(찾기를 만들지 못함) 펌웨어 · BIOS 는 판정하지 않는다(fw · bios = undefined — 화면이 '판정하지 못함' 으로).
 *        assets 가 null 이면(원장을 읽지 못함) 보증도 판정하지 않는다(warranty = undefined).
 * @returns {{ of: (key:string) => { warranty?:object, fw?:object, bios?:object } }}
 */
export function bmCheckFor({ members, placeOf, hxOf, assets, adminBase, today } = {}) {
  const list = Array.isArray(members) ? members : [];
  const fwIn = []; const biosIn = [];
  if (typeof hxOf === 'function') {
    for (const m of list) {
      if (m?.kind !== 'bm') continue;
      let hx = null;
      try { hx = hxOf(m); } catch { hx = null; }
      const p = placeOf?.get?.(m.key);
      const path = p?.src ? String(p.path || '') : '';
      let fw; let bios;
      if (hx?.via === 'edge') { fw = hx.fw; bios = hx.bios; }   // 정제본 그대로 — 없으면 undefined(보내지 않음)
      else if (hx?.inv) { fw = fwComponentsOf(hx.inv.firmware); bios = biosAttrsOf(hx.inv.bios?.attributes); }
      else { fw = null; bios = null; }                           // 인벤토리 없음 = 못 읽음
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
      return out;
    },
  };
}

/** 목록 행에 싣는 작은 요약 — { w, wd, fw, fwn, bios, biosn }. 판정하지 못한 것은 키를 만들지 않는다. */
export function chkRowOf(c) {
  if (!c) return undefined;
  const o = {};
  if (c.warranty) { o.w = c.warranty.state; if (c.warranty.daysLeft != null) o.wd = c.warranty.daysLeft; }
  if (c.fw) { o.fw = c.fw.state; if (c.fw.behind) o.fwn = c.fw.behind; }
  if (c.bios) { o.bios = c.bios.state; if (c.bios.diff) o.biosn = c.bios.diff; }
  return Object.keys(o).length ? o : undefined;
}
