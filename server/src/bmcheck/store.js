/**
 * bmcheck/store.js — 물리서버 점검의 저장소 둘(v3.45).
 *   CONFIG_DIR/bm-assets.json       자산 원장(보증 · 계약) — { v:1, at, by, rows: { <태그 소문자>: { tag, end, type, purchase, contract, eos, note } } }
 *   CONFIG_DIR/bm-fw-baseline.json  관리자가 지정한 펌웨어 기준 — { v:1, models: { <모델 소문자>: { model, comps: { <구성요소 열쇠>: { label, type, version, by, at } } } } }
 *
 * 규약(ipam/annotations.js 와 같은 공용 로더 util/jsonFileLoad.js):
 *  · 손상이면 빈 값으로 시작하지 않는다 — 로드 오류 표지 · 서비스 점검 등재 · **쓰기 거절**(409). 읽기 오류는 원본을 두고 30초마다 다시 본다.
 *  · 쓰기는 원자적(임시 파일 → rename) · 성공한 뒤에만 캐시를 바꾼다 · 세대(rev)를 올린다(응답 캐시 열쇠).
 *  · 비밀이 아니다(서비스 태그 · 날짜 · 계약 번호 · 버전) — 봉인하지 않는다. 계약 번호는 관리자 판본 응답에만 싣는다(라우트).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { makeJsonFileLoader } from '../util/jsonFileLoad.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { isReservedKey } from './assetCsv.js';

// 파일 이름은 글자 그대로 둔다(scripts/config-doc.mjs 가 코드에서 설정 파일 목록을 뽑는다)
const ASSET_FILE = () => path.join(config.configDir, 'bm-assets.json');
const BASELINE_FILE = () => path.join(config.configDir, 'bm-fw-baseline.json');

function docStore({ file, label, what, empty, shape }) {
  const name = path.basename(file());
  let cache = null; let rev = 0;
  const write = (doc) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); atomicWriteFileSync(file(), JSON.stringify(doc, null, 2)); };
  const L = makeJsonFileLoader(file, { label, tag: name, confirm: () => { write(empty()); cache = null; L.saved(); rev += 1; } });
  const load = () => {
    if (cache && !L.recheckDue()) return cache;
    const hadErr = !!L.loadError();
    const r = L.load();
    if (r.kind === 'read-error') return empty();           // 원본을 두고 빈 값을 캐시하지 않는다(쓰기는 refusal 로 막힌다)
    const next = r.kind === 'ok' ? shape(r.value) : empty();
    if (hadErr || !cache) rev += 1;
    cache = next;
    return cache;
  };
  return {
    get: () => load(),
    rev: () => { load(); return rev; },
    loadError: () => { load(); return L.loadError(); },
    refusal: () => { load(); return L.refusal(what); },
    /** 통째로 바꾼다. 로드 오류면 { ok:false, status:409, ... }. */
    save(doc) {
      const refused = this.refusal();
      if (refused) return { ok: false, status: 409, ...refused };
      const next = shape(doc);
      try { write(next); } catch (e) { return { ok: false, status: 500, reason: `${what} 파일을 쓰지 못했습니다 — ${String(e?.code || e?.message || e).slice(0, 120)}` }; }
      cache = next; rev += 1; L.saved();
      return { ok: true };
    },
    _resetForTest() { cache = null; rev = 0; L.resetRetry(); },
  };
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

const assetShape = (d) => {
  const rows = {};
  if (isObj(d) && isObj(d.rows)) {
    for (const [k, e] of Object.entries(d.rows)) {
      if (!isObj(e) || !str(e.tag, 64) || isReservedKey(String(k).toLowerCase())) continue;   // `__proto__` 열쇠는 객체의 원형을 바꾼다 — 받지 않는다
      rows[String(k).toLowerCase().slice(0, 64)] = { tag: str(e.tag, 64), end: str(e.end, 10), type: str(e.type, 120), purchase: str(e.purchase, 10), contract: str(e.contract, 120), eos: str(e.eos, 10), note: str(e.note, 120) };
    }
  }
  return { v: 1, at: isObj(d) && Number.isFinite(d.at) ? d.at : null, by: isObj(d) ? str(d.by, 80) : '', rows };
};
const baselineShape = (d) => {
  const models = {};
  if (isObj(d) && isObj(d.models)) {
    for (const [mk, m] of Object.entries(d.models)) {
      if (!isObj(m) || !isObj(m.comps) || isReservedKey(String(mk).toLowerCase())) continue;
      const comps = {};
      for (const [ck, c] of Object.entries(m.comps)) {
        if (!isObj(c) || !str(c.version, 48) || isReservedKey(ck)) continue;
        comps[String(ck).slice(0, 160)] = { label: str(c.label, 96), type: str(c.type, 16), version: str(c.version, 48), by: str(c.by, 80), at: Number.isFinite(c.at) ? c.at : null };
      }
      if (Object.keys(comps).length) models[String(mk).toLowerCase().slice(0, 256)] = { model: str(m.model, 256), comps };
    }
  }
  return { v: 1, models };
};

/** 자산 원장(보증 · 계약). */
export const assetStore = docStore({ file: ASSET_FILE, label: '물리서버 자산 원장(보증 · 계약)', what: '물리서버 자산 원장', empty: () => assetShape(null), shape: assetShape });
/** 관리자 지정 펌웨어 기준. */
export const fwBaselineStore = docStore({ file: BASELINE_FILE, label: '물리서버 펌웨어 기준(관리자 지정)', what: '물리서버 펌웨어 기준', empty: () => baselineShape(null), shape: baselineShape });

export const BASELINE_MODELS_MAX = 400;
export const BASELINE_COMPS_MAX = 60;
/** 판정 코어에 넘길 조회 함수 — (모델, 구성요소 열쇠) → 지정 버전 | ''. */
export function adminBaselineLookup(doc = fwBaselineStore.get()) {
  const models = doc?.models || {};
  return (model, key) => {
    const mk = String(model || '').trim().toLowerCase();
    const m = Object.hasOwn(models, mk) ? models[mk] : null;
    const c = m && m.comps && Object.hasOwn(m.comps, key) ? m.comps[key] : null;
    return (c && typeof c.version === 'string' && c.version) || '';
  };
}
/**
 * 기준 하나를 지정 · 해제(version '' = 해제). 넘침은 조용히 자르지 않고 거절.
 * @returns {{ ok:boolean, status?:number, reason?:string, changed?:boolean }}
 */
export function setAdminBaseline({ model, key, label = '', type = '', version = '', by = '', now = Date.now() } = {}) {
  const mk = String(model || '').trim().toLowerCase().slice(0, 256);
  const ck = String(key || '').slice(0, 160);
  const ver = String(version || '').trim().slice(0, 48);
  if (!mk || !ck) return { ok: false, status: 400, reason: '모델과 구성요소가 필요합니다.' };
  if (isReservedKey(mk) || isReservedKey(ck)) return { ok: false, status: 400, reason: '쓸 수 없는 모델 · 구성요소 이름입니다.' };
  const doc = fwBaselineStore.get();
  const models = { ...doc.models };
  const curM = Object.hasOwn(models, mk) ? models[mk] : null;
  const cur = curM ? { model: curM.model, comps: { ...curM.comps } } : { model: String(model).trim().slice(0, 256), comps: {} };
  const had = (Object.hasOwn(cur.comps, ck) && cur.comps[ck]?.version) || '';
  if (had === ver) return { ok: true, changed: false };
  if (!ver) delete cur.comps[ck];
  else {
    if (!curM && Object.keys(models).length >= BASELINE_MODELS_MAX) return { ok: false, status: 400, reason: `기준을 지정한 모델이 너무 많습니다(최대 ${BASELINE_MODELS_MAX}개).` };
    if (!Object.hasOwn(cur.comps, ck) && Object.keys(cur.comps).length >= BASELINE_COMPS_MAX) return { ok: false, status: 400, reason: `한 모델에 지정한 기준이 너무 많습니다(최대 ${BASELINE_COMPS_MAX}개).` };
    cur.comps[ck] = { label: String(label).slice(0, 96), type: String(type).slice(0, 16), version: ver, by: String(by).slice(0, 80), at: now };
  }
  if (Object.keys(cur.comps).length) models[mk] = cur; else delete models[mk];
  const r = fwBaselineStore.save({ v: 1, models });
  return r.ok ? { ok: true, changed: true } : r;
}
