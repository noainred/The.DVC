/**
 * cost/settings.js — 비용 배분(쇼백) 단가 설정(`cost-rates.json`, v2.707 — C11). 사람이 정하는 **설정** 파일이다
 * (백업 '설정 변경' 감시 대상 · 비밀 없음). 손상이면 보존하고 기본값으로 시작한다(조용한 빈값 금지 — v2.580 규약).
 *
 * 모양: { currency, vcpu, ramGB, storageGB, storageBasis:'used'|'provisioned', offPolicy:'full'|'storage'|'none' }
 *  · 단가는 **월 단가**다. 비어 있으면(null) 그 항목의 비용을 계산하지 않는다 — 화면은 할당량만 보여 준다(사용자 선택).
 *    0 은 '무료' 라는 값이다(빈 칸과 다르다). 빈 문자열은 미지정(null) — `Number('')===0` 이 '무료' 가 되지 않게(v2.583 규약).
 *  · storageBasis: used = VM 이 실제로 쓴 용량(committed) · provisioned = 할당 용량(committed + thin 여유).
 *  · offPolicy: 꺼진 VM 을 어떻게 셀지 — full(전부) · storage(스토리지만 — 꺼져도 디스크는 자리를 차지한다) · none(빼기).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { numOrNull } from '../util/numOrNull.js';

export const SETTINGS_FILE_NAME = 'cost-rates.json';
const FILE = () => path.join(config.configDir, 'cost-rates.json');
export const DEFAULTS = Object.freeze({ currency: 'KRW', vcpu: null, ramGB: null, storageGB: null, storageBasis: 'used', offPolicy: 'storage' });
export const RATE_KEYS = Object.freeze(['vcpu', 'ramGB', 'storageGB']);
export const RATE_MAX = 1e9;
export const STORAGE_BASES = Object.freeze(['used', 'provisioned']);
export const OFF_POLICIES = Object.freeze(['full', 'storage', 'none']);

let cache = null;
let _readWarned = false;   // 69회차 F4: 읽기 오류 경고는 상태가 바뀔 때 한 번(요청마다 부르는 경로라 콘솔을 채우지 않게)
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const revOf = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10);

/** 단가 한 칸 — 빈 값·null 은 '지정 안 함'(null), 음수·범위 밖·글자는 이전 값 유지. */
function rateOf(raw, prev) {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  const n = numOrNull(raw);
  if (n == null || n < 0 || n > RATE_MAX) return prev;
  return Math.round(n * 10_000) / 10_000;
}

/** 패치 적용(순수) — 모르는 키는 버린다. 키가 없으면 그 값을 건드리지 않는다. */
export function applyPatch(cur, body = {}) {
  const b = isObj(body) ? body : {};
  const next = { ...cur };
  for (const k of RATE_KEYS) if (Object.hasOwn(b, k)) next[k] = rateOf(b[k], cur[k]);
  if (typeof b.currency === 'string') {
    const c = b.currency.trim().slice(0, 8);
    if (/^[A-Za-z₩$€¥£]{1,8}$/.test(c)) next.currency = c;
  }
  if (STORAGE_BASES.includes(b.storageBasis)) next.storageBasis = b.storageBasis;
  if (OFF_POLICIES.includes(b.offPolicy)) next.offPolicy = b.offPolicy;
  return next;
}

export function loadCostSettings() {
  if (cache) return cache;
  let base = { ...DEFAULTS };
  const file = FILE();
  let updatedAt = null; let updatedBy = null;
  // 69회차 F4(재현): 읽기 오류(EIO · EACCES · EISDIR …)는 손상이 아니다 — 예전에는 파싱 실패와 같은 catch 에서 preserveCorrupt 로 온전한
  //   원본을 .corrupt 로 옮겨, 오류가 지나간 뒤에도 단가가 영구히 비었다(수동 복구 전까지). 이제 원본을 두고 기본값을 **캐시하지 않고**
  //   (다음 호출에서 다시 읽는다) unreadable 로 밝히며, 저장은 거절한다(saveCostSettings — 읽지 못한 값 위에 덮어쓰지 않게).
  let raw = null;
  if (fs.existsSync(file)) {
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (!_readWarned) { _readWarned = true; console.warn(`[cost] 단가 설정 파일을 읽지 못했습니다(파일은 그대로 둡니다 — 다시 읽을 때까지 단가 없음 · 저장 거절): ${safeLoadText(e) || '사유 미상'}`); }
      return { ...base, updatedAt: null, updatedBy: null, unreadable: true, rev: 'unreadable' };
    }
  }
  _readWarned = false;
  try {
    if (raw != null) {
      const p = JSON.parse(raw);
      if (!isObj(p)) throw new Error('객체가 아닙니다');
      base = applyPatch(base, p);
      if (typeof p.updatedAt === 'number') updatedAt = p.updatedAt;
      if (typeof p.updatedBy === 'string') updatedBy = p.updatedBy.slice(0, 128);
    }
  } catch (e) {
    preserveCorrupt(file, e?.message);
    console.warn(`[cost] 단가 설정 파일을 읽지 못했습니다 — 원본을 .corrupt 로 보존하고 기본값(단가 없음)으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
  }
  cache = { ...base, updatedAt, updatedBy, rev: revOf(base) };
  return cache;
}

export function saveCostSettings(body, user) {
  const cur = loadCostSettings();
  if (cur.unreadable) throw new Error('단가 설정 파일을 읽지 못해 저장하지 않습니다 — 파일을 확인한 뒤 다시 저장하세요(읽지 못한 값 위에 덮어쓰지 않습니다)');
  const { rev, updatedAt, updatedBy, unreadable, ...core } = cur;
  const next = applyPatch(core, body);
  atomicWriteFileSync(FILE(), JSON.stringify({ ...next, updatedAt: Date.now(), updatedBy: user ? String(user).slice(0, 128) : null }, null, 2));
  cache = null;
  return loadCostSettings();
}

export function _resetCostSettings() { cache = null; }
