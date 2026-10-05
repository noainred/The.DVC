/**
 * vmdns/policy.js — VM DNS 승인 정책(`vm-dns-policy.json`, v2.696). 사람이 손으로 정하는 **설정** 파일이다(상태 파일 아님 —
 * 백업 '설정 변경' 감시 대상). 비밀 값이 없어 봉인 대상이 아니다.
 *
 * 모양: `{ corps: { <vcenterId>: ['10.20.0.53', '10.20.0.0/24', …] }, publicUnapproved: true }`
 *  · 항목은 **정규형 IPv4**(`strictIpv4Num`) 또는 **CIDR**(정규형 기준 주소 + /8~/32, 네트워크 경계). `010.0.0.1`·`10.0.0.0/`·
 *    `10.0.0.5/24` 는 받지 않는다 — 비정규 표기는 해석이 갈리고(v2.589), 빈 마스크는 `Number('')===0` 으로 /0 이 된다(v2.637).
 *  · 빈 목록은 저장하지 않는다(그 법인은 '판정 안 함').
 *  · 손상 파일은 `preserveCorrupt` 로 보존하고 기본값으로 시작한다(다음 저장이 온전했던 원본을 덮지 않게 — 조용한 빈값 금지).
 *  · `rev` 는 파일 내용의 짧은 해시다 — 재시작해도 같은 내용이면 같고(화면의 '다른 사람이 바꿨다' 판정·응답 캐시 키), 바뀌면 다르다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { strictIpv4Num, numToIp } from '../util/ipv4.js';

export const POLICY_FILE_NAME = 'vm-dns-policy.json';
const FILE = () => path.join(config.configDir, 'vm-dns-policy.json');

export const POLICY_CORPS_MAX = 512;       // vCenter 키 수 상한
export const POLICY_ENTRIES_MAX = 256;     // 법인 하나의 항목 수 상한
const ENTRY_LEN_MAX = 64;
const KEY_LEN_MAX = 128;
const MIN_MASK = 8;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

let cache = null;   // { corps, publicUnapproved, rev, invalid, updatedAt, updatedBy }

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const revOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 10);

/**
 * 항목 한 줄 판정(순수). 반환 `{ ok:true, value }` 또는 `{ ok:false, reason }`.
 * value 는 정규형(앞뒤 공백 제거) — 같은 주소를 두 표기로 저장하지 않는다.
 */
export function checkPolicyEntry(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '글자가 아닙니다' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: '빈 항목' };
  if (s.length > ENTRY_LEN_MAX) return { ok: false, reason: `${ENTRY_LEN_MAX}자를 넘습니다` };
  if (s.includes('/')) {
    const parts = s.split('/');
    if (parts.length !== 2) return { ok: false, reason: '‘/’ 가 두 번 이상 있습니다' };
    const [b, m] = parts;
    const n = strictIpv4Num(b);
    if (typeof n !== 'number') return { ok: false, reason: n === false ? `‘${b}’ 는 정규형 IPv4 가 아닙니다(앞자리 0·빈 칸 없이)` : `‘${b || '(비어 있음)'}’ 는 IPv4 주소가 아닙니다` };
    if (!m) return { ok: false, reason: '‘/’ 뒤 마스크가 비어 있습니다' };
    if (!/^\d{1,2}$/.test(m) || (m.length === 2 && m[0] === '0')) return { ok: false, reason: `마스크 ‘${m}’ 는 숫자(8~32)가 아닙니다` };
    const k = Number(m);
    if (k > 32) return { ok: false, reason: `마스크 /${k} 는 32 를 넘습니다` };
    if (k < MIN_MASK) return { ok: false, reason: `마스크 /${k} 는 너무 넓습니다(/${MIN_MASK} 이상만 받습니다)` };
    const size = 2 ** (32 - k);
    const lo = Math.floor(n / size) * size;
    if (lo !== n) return { ok: false, reason: `네트워크 경계가 아닙니다 — ${numToIp(lo)}/${k} 로 적으세요` };
    return { ok: true, value: `${b}/${k}` };
  }
  const n = strictIpv4Num(s);
  if (typeof n === 'number') return { ok: true, value: s };
  return { ok: false, reason: n === false ? `‘${s}’ 는 정규형 IPv4 가 아닙니다(앞자리 0·빈 칸 없이)` : `‘${s}’ 는 IPv4 주소나 CIDR 이 아닙니다` };
}

/**
 * corps 객체 검증(순수). 반환 `{ corps, invalid:[{vcenterId, value, reason}] }`.
 * strict 면(저장) 형식 오류가 하나라도 있으면 호출부가 거부한다. 로드(느슨)는 틀린 항목만 빼고 invalid 로 밝힌다.
 */
export function normalizeCorps(input) {
  const corps = {};
  const invalid = [];
  if (!isObj(input)) {
    if (input != null) invalid.push({ vcenterId: null, value: null, reason: 'corps 는 객체여야 합니다' });
    return { corps, invalid };
  }
  const keys = Object.keys(input);
  if (keys.length > POLICY_CORPS_MAX) invalid.push({ vcenterId: null, value: null, reason: `vCenter 키가 ${POLICY_CORPS_MAX}개를 넘습니다(${keys.length}개)` });
  for (const key of keys.slice(0, POLICY_CORPS_MAX)) {
    const id = key.trim();
    if (!id || id.length > KEY_LEN_MAX || BAD_KEYS.has(id)) { invalid.push({ vcenterId: key.slice(0, KEY_LEN_MAX), value: null, reason: 'vCenter id 가 올바르지 않습니다' }); continue; }
    const list = input[key];
    if (!Array.isArray(list)) { invalid.push({ vcenterId: id, value: null, reason: '목록(배열)이 아닙니다' }); continue; }
    if (list.length > POLICY_ENTRIES_MAX) invalid.push({ vcenterId: id, value: null, reason: `항목이 ${POLICY_ENTRIES_MAX}개를 넘습니다(${list.length}개)` });
    const out = [];
    for (const raw of list.slice(0, POLICY_ENTRIES_MAX)) {
      const r = checkPolicyEntry(raw);
      if (!r.ok) { invalid.push({ vcenterId: id, value: typeof raw === 'string' ? raw.slice(0, ENTRY_LEN_MAX) : null, reason: r.reason }); continue; }
      if (!out.includes(r.value)) out.push(r.value);
    }
    if (out.length) corps[id] = out;
  }
  return { corps, invalid };
}

/** 정책 읽기 — `{ corps, publicUnapproved, rev, invalid, updatedAt, updatedBy }`. 손상이면 보존하고 기본값. */
export function loadVmDnsPolicy() {
  if (cache) return cache;
  const base = { corps: {}, publicUnapproved: true, updatedAt: null, updatedBy: null };
  let invalid = [];
  const file = FILE();
  try {
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObj(p)) throw new Error('객체가 아닙니다');
      const n = normalizeCorps(p.corps ?? {});
      base.corps = n.corps; invalid = n.invalid;
      if (typeof p.publicUnapproved === 'boolean') base.publicUnapproved = p.publicUnapproved;
      if (typeof p.updatedAt === 'number' && Number.isFinite(p.updatedAt)) base.updatedAt = p.updatedAt;
      if (typeof p.updatedBy === 'string') base.updatedBy = p.updatedBy.slice(0, 128);
    }
  } catch (e) {
    preserveCorrupt(file, e?.message);
    console.warn(`[vm-dns] 정책 파일을 읽지 못했습니다 — 원본을 .corrupt 로 보존하고 기본값(공인 DNS 비승인 · 법인 목록 없음)으로 시작합니다: ${e?.message || e}`);
  }
  cache = { ...base, invalid, rev: revOf({ corps: base.corps, publicUnapproved: base.publicUnapproved }) };
  return cache;
}

/**
 * 정책 저장. body: `{ corps?, publicUnapproved?, rev? }`.
 *  · corps 를 주면 **통째로 교체**한다(전체 범위 관리자만 부르는 경로 — 범위 병합이 필요 없다).
 *  · rev 를 주고 지금 값과 다르면 `{ ok:false, code:'stale' }`(다른 관리자가 그 사이에 바꿨다 — 조용히 덮지 않는다).
 *  · 형식 오류가 하나라도 있으면 저장하지 않고 `{ ok:false, code:'invalid', invalid }`.
 */
export function saveVmDnsPolicy(body = {}, user = '') {
  const cur = loadVmDnsPolicy();
  if (!isObj(body)) return { ok: false, code: 'bad-request', reason: '본문이 객체가 아닙니다' };
  if (body.rev != null && String(body.rev) !== cur.rev) return { ok: false, code: 'stale', reason: '그 사이에 다른 관리자가 정책을 바꿨습니다 — 새로 불러온 뒤 다시 저장하세요', rev: cur.rev };
  const next = { corps: cur.corps, publicUnapproved: cur.publicUnapproved };
  if (Object.hasOwn(body, 'corps')) {
    const n = normalizeCorps(body.corps);
    if (n.invalid.length) return { ok: false, code: 'invalid', invalid: n.invalid };
    next.corps = n.corps;
  }
  if (Object.hasOwn(body, 'publicUnapproved')) {
    if (typeof body.publicUnapproved !== 'boolean') return { ok: false, code: 'invalid', invalid: [{ vcenterId: null, value: null, reason: 'publicUnapproved 는 true/false 여야 합니다' }] };
    next.publicUnapproved = body.publicUnapproved;
  }
  const doc = { corps: next.corps, publicUnapproved: next.publicUnapproved, updatedAt: Date.now(), updatedBy: String(user || '').slice(0, 128) };
  atomicWriteFileSync(FILE(), JSON.stringify(doc, null, 2), { mode: 0o600 });
  cache = { ...doc, invalid: [], rev: revOf({ corps: doc.corps, publicUnapproved: doc.publicUnapproved }) };
  return { ok: true, policy: cache, changed: cache.rev !== cur.rev };
}

/** 파일을 다시 읽게 한다(테스트·외부 편집 뒤). */
export function invalidateVmDnsPolicy() { cache = null; }
