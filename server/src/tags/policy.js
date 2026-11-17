/**
 * tags/policy.js — 태그 점검 정책(`tag-policy.json`, v2.703 — A15). 사람이 정하는 **설정** 파일이다(비밀 없음).
 * 모양: `{ requiredCategories: ['Environment', …], corpCategory: 'Corp' }`
 *  · 카테고리는 **이름**으로 둔다(vCenter 마다 카테고리 id 가 다르다). 비교는 대소문자를 무시한다.
 *  · 손상 파일은 `preserveCorrupt` 로 보존하고 기본값(정책 없음)으로 시작한다(조용한 빈값 금지).
 *  · rev 는 내용 해시 — 다른 관리자 변경을 조용히 덮지 않는다(stale).
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileLoad.js';   // 결정(56~75 남긴 것) 71
import { isMockMode } from '../mock/demo/flags.js';

const FILE = () => path.join(config.configDir, 'tag-policy.json');
export const REQUIRED_MAX = 20;
const NAME_MAX = 128;
let cache = null;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const revOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);

/** 카테고리 이름 하나 — 앞뒤 공백 제거 · 제어 문자 거부 · 길이 상한. */
export function checkCategoryName(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '글자가 아닙니다' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: '빈 이름' };
  if (s.length > NAME_MAX) return { ok: false, reason: `${NAME_MAX}자를 넘습니다` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return { ok: false, reason: '제어 문자가 있습니다' };
  return { ok: true, value: s };
}

export function normalizePolicy(p) {
  const invalid = [];
  const req = [];
  const seen = new Set();
  for (const raw of Array.isArray(p?.requiredCategories) ? p.requiredCategories : []) {
    const c = checkCategoryName(raw);
    if (!c.ok) { invalid.push({ field: 'requiredCategories', value: String(raw).slice(0, 64), reason: c.reason }); continue; }
    const k = c.value.toLowerCase();
    if (seen.has(k)) continue;
    if (req.length >= REQUIRED_MAX) { invalid.push({ field: 'requiredCategories', value: c.value, reason: `${REQUIRED_MAX}개까지만 받습니다` }); continue; }
    seen.add(k); req.push(c.value);
  }
  let corp = '';
  if (p?.corpCategory != null && p.corpCategory !== '') {
    const c = checkCategoryName(p.corpCategory);
    if (c.ok) corp = c.value; else invalid.push({ field: 'corpCategory', value: String(p.corpCategory).slice(0, 64), reason: c.reason });
  }
  return { policy: { requiredCategories: req, corpCategory: corp }, invalid };
}

// 결정(56~75 남긴 것) 71: 읽기 오류 뒤 다시 읽기는 공용 리더의 재읽기 간격(30초) — 요청마다 동기로 다시 읽지 않는다(cost/settings.js 와 같은 판단).
const _reader = makeJsonFileReader(FILE, { parse: (t) => { const p = JSON.parse(t); if (!isObj(p)) throw new Error('객체가 아닙니다'); return p; }, tag: 'tags' });
export function loadTagPolicy() {
  if (cache) return cache;
  const base = { requiredCategories: [], corpCategory: '', updatedAt: null, updatedBy: null };
  // 69회차 F4(재현 — cost/settings.js 와 같은 꼴): 읽기 오류는 손상이 아니다 — 원본을 옮기지 않고 정책 없음을 캐시하지 않으며(71: 간격이 지난 다음 호출에서 다시 읽는다)
  //   unreadable 로 밝힌다. 저장은 거절한다(예전에는 원본을 .corrupt 로 옮겨 필수 카테고리가 영구히 비었다).
  const r = _reader.read();
  if (r.kind === 'read-error') return { ...base, unreadable: true, rev: 'unreadable' };
  // v2.710 데모(mock): 정책 파일이 없으면 목 데이터의 카테고리로 만든 데모 정책을 쓴다 — 정책이 비어 있으면 '누락' 판정이
  //   하나도 보이지 않는다. 파일은 만들지 않고(demo:true 로 밝힌다) 관리자가 저장하면 그 값이 이긴다.
  if (r.kind === 'missing' && isMockMode()) {
    Object.assign(base, { requiredCategories: ['Environment', 'Owner-Team', 'Corp'], corpCategory: 'Corp', demo: true });
  } else if (r.kind === 'ok') {
    const p = r.value;
    const n = normalizePolicy(p);
    Object.assign(base, n.policy);
    if (typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt)) base.updatedAt = p.updatedAt;
    if (typeof p.updatedBy === 'string') base.updatedBy = p.updatedBy.slice(0, 128);
  } else if (r.kind === 'corrupt') {
    console.warn(`[tags] 태그 정책 파일을 읽지 못했습니다 — 원본을 .corrupt 로 보존하고 정책 없음으로 시작합니다: ${safeLoadText(r.error) || '사유 미상'}`);
  }
  cache = { ...base, rev: revOf({ r: base.requiredCategories, c: base.corpCategory }) };
  return cache;
}

export function saveTagPolicy(body = {}, user = '') {
  const cur = loadTagPolicy();
  if (cur.unreadable) return { ok: false, code: 'unreadable', reason: '태그 정책 파일을 읽지 못해 저장하지 않습니다 — 파일을 확인한 뒤 다시 저장하세요(읽지 못한 값 위에 덮어쓰지 않습니다)' };
  if (!isObj(body)) return { ok: false, code: 'bad-request', reason: '본문이 객체가 아닙니다' };
  if (body.rev != null && String(body.rev) !== cur.rev) return { ok: false, code: 'stale', reason: '그 사이에 다른 관리자가 정책을 바꿨습니다 — 새로 불러온 뒤 다시 저장하세요', rev: cur.rev };
  const merged = {
    requiredCategories: Object.hasOwn(body, 'requiredCategories') ? body.requiredCategories : cur.requiredCategories,
    corpCategory: Object.hasOwn(body, 'corpCategory') ? body.corpCategory : cur.corpCategory,
  };
  const n = normalizePolicy(merged);
  if (n.invalid.length) return { ok: false, code: 'invalid', invalid: n.invalid };
  const doc = { ...n.policy, updatedAt: Date.now(), updatedBy: String(user || '').slice(0, 128) };
  atomicWriteFileSync(FILE(), JSON.stringify(doc, null, 2), { mode: 0o600 });
  _reader.reset();
  cache = { ...doc, rev: revOf({ r: doc.requiredCategories, c: doc.corpCategory }) };
  return { ok: true, policy: cache, changed: cache.rev !== cur.rev };
}
export function _resetTagPolicy() { cache = null; }
