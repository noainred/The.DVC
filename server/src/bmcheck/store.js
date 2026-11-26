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

/**
 * @param L 공용 로더(makeJsonFileLoader — 아래에서 파일마다 **글자 그대로의 label · confirm 과 함께** 만든다: 서비스 점검 등재 스윕 audit2633 이 그 줄을 본다)
 */
function docStore({ file, L, what, empty, shape, maxBytes = null }) {
  let cache = null; let rev = 0;
  // 들여쓰기 없이 쓴다 — 케이스 5,000건이 들여쓰기로 25MB · 한 건 저장 0.3~0.46초였다(v3.52 디버깅 1회차 성능 P8). 읽는 쪽은 JSON.parse 라 같다
  const write = (doc, text = JSON.stringify(doc)) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); atomicWriteFileSync(file(), text); };
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
    save(doc, { shrinking = false } = {}) {
      const refused = this.refusal();
      if (refused) return { ok: false, status: 409, ...refused };
      const next = shape(doc);
      const text = JSON.stringify(next);
      // 파일 크기 상한(있으면) — 넘으면 쓰지 않는다(백업 파일 상한 안에 머물게 · 성능 P8)
      // 상한은 **커지는 쓰기**만 막는다 — 지우기 · ‘끝남’ 으로 바꾸기 · 줄이는 편집은 상한을 넘은 파일에서도 된다(자리를 만드는 길 — 디버깅 2회차 판정 #10)
      const lim = !shrinking && typeof maxBytes === 'function' ? maxBytes() : null;
      const bytes = lim ? Buffer.byteLength(text, 'utf8') : 0;
      const curBytes = lim && bytes > lim ? (() => { try { return fs.statSync(file()).size; } catch { return 0; } })() : 0;
      if (lim && bytes > lim && bytes > curBytes) return { ok: false, status: 413, reason: `${what} 파일이 상한(${Math.round(lim / 1048576)}MB)에 닿았습니다 — 끝난 항목을 지워 자리를 만든 뒤 다시 하십시오.` };
      try { write(next, text); } catch (e) { return { ok: false, status: 500, reason: `${what} 파일을 쓰지 못했습니다 — ${String(e?.code || e?.message || e).slice(0, 120)}` }; }
      cache = next; rev += 1; L.saved();
      return { ok: true };
    },
    /** 서비스 점검의 ‘기본값으로 확정’ — 손상 보존본을 두고 빈 값으로 시작한다. */
    _confirm() { write(empty()); cache = null; L.saved(); rev += 1; },
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

/**
 * 파일 꼴 검사 — **모르는 꼴은 손상**이다(빈 값으로 읽지 않는다). 첫 판본은 `null` · `{"rows":[…]}` · `{"v":2,"assets":{…}}` 를 오류 없이 빈 원장으로 읽어
 *   전 서버가 ‘원장에 없음’ 이 되고 다음 올리기가 그 위에 덮어썼다(반증 A18).
 */
const parseDoc = (field) => (text) => {
  const v = JSON.parse(text);
  if (!isObj(v) || !isObj(v[field])) throw new Error(`형식이 아닙니다(객체 · ${field} 객체가 있어야 합니다)`);
  if (v.v !== undefined && v.v !== 1) throw new Error('이 판이 모르는 파일 판 번호입니다');
  return v;
};
const _assetFile = makeJsonFileLoader(ASSET_FILE, { label: '물리서버 자산 원장(보증 · 계약)', tag: 'bm-assets', parse: parseDoc('rows'), confirm: () => assetStore._confirm() });
const _baselineFile = makeJsonFileLoader(BASELINE_FILE, { label: '물리서버 펌웨어 기준(관리자 지정)', tag: 'bm-fw-baseline', parse: parseDoc('models'), confirm: () => fwBaselineStore._confirm() });
/** 자산 원장(보증 · 계약). */
export const assetStore = docStore({ file: ASSET_FILE, L: _assetFile, what: '물리서버 자산 원장', empty: () => assetShape(null), shape: assetShape });
/** 관리자 지정 펌웨어 기준. */
export const fwBaselineStore = docStore({ file: BASELINE_FILE, L: _baselineFile, what: '물리서버 펌웨어 기준', empty: () => baselineShape(null), shape: baselineShape });

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

// ───────── v3.50 — 제조사 케이스(⑫) · 보안 권고 표(④) ─────────
//   CONFIG_DIR/bm-cases.json       케이스 기록 — { v:1, cases: { <id>: { id, tag, part, caseNo, status, note, by, at, created, hist:[…] } } }
//   CONFIG_DIR/bm-advisories.json  보안 권고 표(사람이 확인해 올린 것) — { v:1, at, by, rows: [ { id, sev, type, model, comp, fixed, title, url } ] }
//   같은 공용 로더 규약(손상이면 쓰기 거절 · 서비스 점검 등재). 권고 표는 포탈이 인터넷에서 가져오지 않는다 — 비어 있으면 대조하지 않는다.
const CASES_FILE = () => path.join(config.configDir, 'bm-cases.json');
const ADVISORY_FILE = () => path.join(config.configDir, 'bm-advisories.json');
export const CASE_STATUSES = Object.freeze(['open', 'parts', 'replaced', 'closed']);
export const CASES_MAX = 5_000;
export const CASE_HIST_MAX = 20;
export const ADVISORY_ROWS_MAX = 2_000;
export const ADVISORY_SEVS = Object.freeze(['critical', 'high', 'medium', 'low']);
const caseShape = (d) => {
  const cases = {};
  if (isObj(d) && isObj(d.cases)) {
    for (const [k, c] of Object.entries(d.cases)) {
      const id = String(k).slice(0, 40);
      if (!isObj(c) || isReservedKey(id) || !/^[a-z0-9-]{4,40}$/.test(id) || !str(c.tag, 64)) continue;
      const hist = Array.isArray(c.hist) ? c.hist.filter(isObj).slice(-CASE_HIST_MAX).map((h) => ({ at: Number.isFinite(h.at) ? h.at : null, by: str(h.by, 80), status: CASE_STATUSES.includes(h.status) ? h.status : '', caseNo: str(h.caseNo, 64) })) : [];
      cases[id] = { id, tag: str(c.tag, 64).toLowerCase(), corp: str(c.corp, 128), part: str(c.part, 120), caseNo: str(c.caseNo, 64), status: CASE_STATUSES.includes(c.status) ? c.status : 'open', note: str(c.note, 500),
        by: str(c.by, 80), at: Number.isFinite(c.at) ? c.at : null, created: Number.isFinite(c.created) ? c.created : null, hist };
    }
  }
  return { v: 1, cases };
};
const advisoryShape = (d) => {
  const rows = [];
  if (isObj(d) && Array.isArray(d.rows)) {
    for (const r of d.rows.slice(0, ADVISORY_ROWS_MAX)) {
      if (!isObj(r) || !str(r.id, 64).trim() || !str(r.fixed, 48).trim() || !str(r.type, 16)) continue;
      rows.push({ id: str(r.id, 64).trim(), sev: ADVISORY_SEVS.includes(r.sev) ? r.sev : 'medium', type: str(r.type, 16), model: str(r.model, 120).trim().toLowerCase(), comp: str(r.comp, 120).trim().toLowerCase(),
        fixed: str(r.fixed, 48).trim(), title: str(r.title, 200), url: /^https?:\/\//i.test(str(r.url, 300)) ? str(r.url, 300) : '' });
    }
  }
  return { v: 1, at: isObj(d) && Number.isFinite(d.at) ? d.at : null, by: isObj(d) ? str(d.by, 80) : '', rows };
};
const parseList = (field) => (text) => {
  const v = JSON.parse(text);
  if (!isObj(v) || !Array.isArray(v[field])) throw new Error(`형식이 아닙니다(객체 · ${field} 목록이 있어야 합니다)`);
  if (v.v !== undefined && v.v !== 1) throw new Error('이 판이 모르는 파일 판 번호입니다');
  return v;
};
const _casesFile = makeJsonFileLoader(CASES_FILE, { label: '물리서버 제조사 케이스 기록', tag: 'bm-cases', parse: parseDoc('cases'), confirm: () => caseStore._confirm() });
const _advisoryFile = makeJsonFileLoader(ADVISORY_FILE, { label: '물리서버 펌웨어 보안 권고 표', tag: 'bm-advisories', parse: parseList('rows'), confirm: () => advisoryStore._confirm() });
/**
 * 케이스 기록 파일이 가질 수 있는 가장 큰 크기(바이트) — 백업 파일 상한(backup/service.js fileCapFor)이 이 값을 쓴다(v3.52 디버깅 1회차 성능 P8:
 * 메모 · 이력을 채운 케이스가 약 1,700건을 넘으면 8MB 를 넘어 백업에서 빠졌다 — v2.901 이슈 · 게시판 · 위키와 같은 꼴). 꼴의 글자 상한 × 3바이트(한글)로 센다.
 */
export const CASES_FILE_MAX_BYTES = 16 * 1024 * 1024;   // 건수 상한(5,000)으로는 글자를 꽉 채우면 60MB 를 넘을 수 있다 — 파일 크기로도 묶는다(이슈 · 게시판과 같은 16MB)
export const casesMaxBytes = () => CASES_FILE_MAX_BYTES;
/** 제조사 케이스 기록(⑫). */
export const caseStore = docStore({ file: CASES_FILE, L: _casesFile, what: '물리서버 제조사 케이스 기록', empty: () => caseShape(null), shape: caseShape, maxBytes: casesMaxBytes });
/** 펌웨어 보안 권고 표(④). */
export const advisoryStore = docStore({ file: ADVISORY_FILE, L: _advisoryFile, what: '물리서버 펌웨어 보안 권고 표', empty: () => advisoryShape(null), shape: advisoryShape });

/**
 * 케이스 하나를 더하거나 고친다(id 가 없으면 새로). 상태 · 번호가 바뀌면 이력에 한 줄. 넘침은 거절.
 * 케이스는 **서비스 태그 + 법인**으로 묶는다(v3.50 반증 A2 — 같은 태그가 다른 법인 서버로 나타나도 그 법인 계정이 남의 법인 케이스를 읽거나 고치지 못하게).
 * 다른 법인 · 다른 서버의 케이스 id 는 ‘찾지 못함’(404 — 있음을 드러내지 않는다).
 * @returns {{ ok:boolean, status?:number, reason?:string, id?:string, changed?:boolean }}
 */
export function upsertCase({ id = '', tag, corp = '', part = '', caseNo = '', status = 'open', note = '', by = '', now = Date.now(), newId = null } = {}) {
  const tg = String(tag || '').trim().toLowerCase().slice(0, 64);
  const cp = String(corp || '').slice(0, 128);
  if (!tg) return { ok: false, status: 400, reason: '서비스 태그를 모르는 서버에는 케이스를 적을 수 없습니다.' };
  if (!CASE_STATUSES.includes(status)) return { ok: false, status: 400, reason: '모르는 상태입니다.' };
  const doc = caseStore.get();
  const cases = { ...doc.cases };
  const cid = String(id || '').trim();
  const cur = cid ? (Object.hasOwn(cases, cid) ? cases[cid] : null) : null;
  if ((cid && !cur) || (cur && (cur.tag !== tg || cur.corp !== cp))) return { ok: false, status: 404, reason: '케이스를 찾지 못했습니다(다른 사람이 지웠을 수 있습니다).' };
  if (!cur && Object.keys(cases).length >= CASES_MAX) return { ok: false, status: 400, reason: `케이스 기록이 너무 많습니다(최대 ${CASES_MAX}건) — 끝난 케이스를 지워 자리를 만드십시오(서버 상세 › 제조사 케이스 › 지우기).` };
  const nid = cur ? cid : (newId || `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const next = { id: nid, tag: tg, corp: cp, part: String(part).slice(0, 120), caseNo: String(caseNo).trim().slice(0, 64), status, note: String(note).slice(0, 500), by: String(by).slice(0, 80), at: now,
    created: cur?.created ?? now, hist: [...(cur?.hist || [])] };
  if (!cur || cur.status !== next.status || cur.caseNo !== next.caseNo) next.hist = [...next.hist, { at: now, by: next.by, status: next.status, caseNo: next.caseNo }].slice(-CASE_HIST_MAX);
  if (cur && cur.part === next.part && cur.caseNo === next.caseNo && cur.status === next.status && cur.note === next.note) return { ok: true, id: nid, changed: false };
  cases[nid] = next;
  const r = caseStore.save({ v: 1, cases });
  return r.ok ? { ok: true, id: nid, changed: true } : r;
}
/**
 * 끝난(closed) 케이스 하나를 지운다(v3.50 — 상한 5,000 건이 차면 새 케이스를 막는데 지울 길이 없었다: 반증 A11). 진행 중인 케이스는 지우지 않는다.
 * 다른 서버(태그) · 다른 법인의 id 는 ‘찾지 못함’(404 — 있음을 드러내지 않는다).
 */
export function removeCase({ id = '', tag, corp = '' } = {}) {
  const tg = String(tag || '').trim().toLowerCase().slice(0, 64); const cp = String(corp || '').slice(0, 128); const cid = String(id || '').trim();
  const doc = caseStore.get();
  const cur = cid && Object.hasOwn(doc.cases, cid) ? doc.cases[cid] : null;
  if (!cur || cur.tag !== tg || cur.corp !== cp) return { ok: false, status: 404, reason: '케이스를 찾지 못했습니다(다른 사람이 지웠을 수 있습니다).' };
  if (cur.status !== 'closed') return { ok: false, status: 400, reason: '끝난 케이스만 지울 수 있습니다(상태를 ‘끝남’ 으로 바꾼 뒤 지우십시오).' };
  const cases = { ...doc.cases }; delete cases[cid];
  const r = caseStore.save({ v: 1, cases }, { shrinking: true });
  return r.ok ? { ok: true, removed: cur } : r;
}
/** 서버(태그 + 법인)의 케이스 — 새로 고친 것부터. 법인이 다른 케이스는 싣지 않는다(반증 A2). */
export function casesOfTag(tag, { corp = '', doc = caseStore.get() } = {}) {
  const tg = String(tag || '').trim().toLowerCase();
  const cp = String(corp || '').slice(0, 128);
  if (!tg) return [];
  return Object.values(doc?.cases || {}).filter((c) => c.tag === tg && c.corp === cp).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
