/**
 * 외부 연동 API 키 저장소 (v2.562) — 다른 포탈이 이 포탈의 조회 API 를 읽을 수 있게 하는 인증.
 *
 * ⚠⚠ **왜 기존 토큰을 재사용하지 않는가**(설계의 중심):
 *  · 세션 토큰은 TTL 8시간(`config.js:282` `AUTH_TOKEN_TTL`)이고 admin·operator 는 OTP 전용이라
 *    `passwordHash` 가 삭제된다(`auth/auth.js:478`) — **비밀번호로 프로그램 로그인이 구조적으로
 *    불가능**하고 OTP 코드는 사람이 앱에서 봐야 하므로 자동화가 안 된다.
 *  · `CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 은 엣지↔중앙 프로토콜 전용이고 **범위를 좁힐 축이 없다** —
 *    재사용하면 외부 포탈이 전 법인 수집 데이터와 설정 배포 경로를 얻는다.
 *  그래서 **별도 이름공간의 키**를 둔다. 이 키는 조회만 하고, 허용 목록 밖은 무엇도 못 본다.
 *
 * ⚠⚠ **평문을 저장하지 않는다.** 저장하는 것은 `sha256(키)` 와 앞 8자 지문(`tokenFingerprint`)
 * 뿐이다. 발급 순간 **1회만** 평문을 돌려주고 그 뒤에는 어떤 API·화면·로그에도 나오지 않는다
 * (v2.560 토큰 점검과 같은 규약 — 전체 해시를 돌려주는 export 도 만들지 않는다).
 * ⚠ 그래서 **키를 잃으면 재발급밖에 없다** — 화면이 그 사실을 먼저 말한다.
 *
 * ⚠ 파일은 `SECRET_FILES` 등록 + `.gitignore` **둘 다** 해야 한다(v2.500 M4 · v2.535 규약).
 *   봉인해도 이름·지문·허용목록은 평문으로 남으므로 두 조치가 별개다.
 *
 * 범위 축 셋을 **모두** 갖는다(하나라도 빠지면 '전부 열림' 이 된다):
 *   ① `groups` — 허용 분류(거부 기본값. `allowlist.js` 가 소유)
 *   ② `vcenters` — vCenter scope(빈 배열 = 전체. 기존 `scopedVcenterIds` 와 같은 의미)
 *   ③ `expiresAt` — 만료(없으면 무기한이고 화면이 경고한다)
 * 추가로 `rpm`(분당 상한)과 `lastUsedAt`·`useCount` 를 둔다 — 쓰지 않는 키를 찾아 지우게.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { tokenFingerprint } from '../util/tokenFingerprint.js';
import { GROUP_KEYS } from './allowlist.js';

const FILE = () => path.join(config.configDir, 'api-keys.json');

/** 키 접두 — 로그·붙여넣기에서 '이게 무슨 값인지' 바로 보이게 한다(v2.560 지문 규약의 연장). */
export const KEY_PREFIX = 'dvcapi_';
/** 분당 요청 상한 기본값. 조회 전용이라 넉넉하지만 무제한은 아니다. */
export const DEFAULT_RPM = 120;
const RPM_MAX = 6000;

function sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/* ── 파일 ─────────────────────────────────────────────────────────────────── */

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const j = JSON.parse(raw);
    _cache = Array.isArray(j?.keys) ? { keys: j.keys } : { keys: [] };
  } catch (e) {
    // ⚠ 손상은 조용히 `[]` 로 넘기지 않는다 — 다음 저장이 온전했던 원본을 덮어쓴다(v2.190 규약).
    if (e?.code !== 'ENOENT') preserveCorrupt(FILE(), String(e?.message || e));
    _cache = { keys: [] };
  }
  return _cache;
}

function persist() {
  atomicWriteFileSync(FILE(), JSON.stringify({ keys: load().keys }, null, 2), { mode: 0o600 });
}

/** 테스트용 — 캐시를 버린다(파일은 건드리지 않는다). */
export function _resetApiKeyCache() { _cache = null; _rate.clear(); }

/* ── 정규화 ───────────────────────────────────────────────────────────────── */

const clampRpm = (v) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RPM;
  return Math.max(1, Math.min(RPM_MAX, n));
};

/**
 * 입력 정규화(순수). **아는 키만** 남긴다 — 스키마 밖 값이 파일로 유입되지 않게.
 * @returns {{values:object, issues:string[]}}
 */
/*
 * v2.601 WEB2601-04 — 등록된 vCenter id 집합의 출처(주입). 이 모듈은 `security/secretVault.js` 가 import 하므로
 * vCenter 등록부(→ secretVault)를 정적으로 import 하면 순환이 된다. 공개 API 라우트가 기동 시 공급자를 넣는다.
 * 공급자가 없거나 실패하면 `null`(= 모른다) — 그때는 경고하지 않는다(모르는 것을 '삭제됐다' 고 말하지 않는다).
 */
let _knownVcenterSource = null;
export function setKnownVcenterSource(fn) { _knownVcenterSource = typeof fn === 'function' ? fn : null; }
export function knownVcenterIds() {
  if (!_knownVcenterSource) return null;
  try {
    const ids = _knownVcenterSource();
    return ids instanceof Set ? ids : (Array.isArray(ids) ? new Set(ids.map(String)) : null);
  } catch { return null; }
}
/** 키 범위 중 지금 등록부·스냅샷에 없는 vCenter id(모르면 null). */
export function unknownScopeVcenters(vcenters, known = knownVcenterIds()) {
  if (!(known instanceof Set)) return null;
  return (vcenters || []).map(String).filter((id) => !known.has(id));
}

export function normalizeKeyInput(input = {}, { knownVcenters = undefined } = {}) {
  const issues = [];
  const name = String(input.name ?? '').trim().slice(0, 80);
  if (!name) issues.push('이름은 필수입니다 — 어느 포탈이 쓰는 키인지 나중에 알 수 없습니다.');

  // ⚠ 모르는 분류는 **버리고 개수를 밝힌다**(조용히 통과시키면 허용목록이 뜻을 잃는다).
  const rawGroups = Array.isArray(input.groups) ? input.groups.map((s) => String(s)) : [];
  const groups = rawGroups.filter((g) => GROUP_KEYS.includes(g));
  const unknown = rawGroups.filter((g) => !GROUP_KEYS.includes(g));
  if (unknown.length) issues.push(`모르는 분류 ${unknown.length}개를 무시했습니다: ${unknown.slice(0, 5).join(', ')}`);
  /*
   * ⚠⚠ **빈 허용목록을 '전부 허용' 으로 해석하지 말 것** — 거부 기본값이다.
   * 빈 목록은 정당한 설정("아직 아무것도 주지 않는다")이고 그대로 저장한다(v2.555 규약).
   */
  if (!groups.length) issues.push('허용 분류를 고르지 않았습니다 — 이 키로는 아무것도 조회할 수 없습니다(거부 기본값).');

  const vcenters = Array.isArray(input.vcenters)
    ? [...new Set(input.vcenters.map((s) => String(s).trim()).filter(Boolean))].slice(0, 200)
    : [];
  /*
   * v2.601 WEB2601-04: 존재하지 않는(오타·삭제된) vCenter 로 범위를 두면 그 키는 **아무것도 보지 못하는데**
   *   공개 API 는 합계 0 을 ok:true 로 줬다('자원이 0개' 라는 거짓). 저장은 막지 않되(곧 등록할 수도 있다) 경고한다.
   */
  const unknownVc = unknownScopeVcenters(vcenters, knownVcenters === undefined ? knownVcenterIds() : knownVcenters);
  if (unknownVc && unknownVc.length) {
    issues.push(unknownVc.length === vcenters.length
      ? `범위의 vCenter ${unknownVc.length}곳이 전부 등록돼 있지 않습니다(${unknownVc.slice(0, 5).join(', ')}) — 이 키로는 아무것도 조회할 수 없고 공개 API 가 scope-empty 로 거절합니다.`
      : `범위의 vCenter ${unknownVc.length}곳이 등록돼 있지 않습니다(${unknownVc.slice(0, 5).join(', ')}) — 그 곳의 자원은 보이지 않습니다.`);
  }

  let expiresAt = null;
  if (input.expiresAt != null && input.expiresAt !== '') {
    const t = Number(input.expiresAt);
    if (Number.isFinite(t) && t > 0) expiresAt = Math.floor(t);
    else issues.push('만료일을 읽지 못해 무기한으로 뒀습니다.');
  }
  if (expiresAt == null) issues.push('만료일이 없습니다 — 무기한 키입니다. 기한을 두는 것을 권합니다.');

  return { values: { name, groups, vcenters, expiresAt, rpm: clampRpm(input.rpm), note: String(input.note ?? '').trim().slice(0, 300) }, issues };
}

/* ── 발급·폐기·조회 ───────────────────────────────────────────────────────── */

/**
 * 키 발급. **평문은 이 반환값에만 있다** — 저장하지 않는다.
 * @returns {{key:object, plaintext:string, issues:string[]}}
 */
export function issueApiKey(input = {}, by = '') {
  const { values, issues } = normalizeKeyInput(input);
  if (!values.name) return { key: null, plaintext: '', issues };

  // 32바이트 난수 → base64url(43자). 접두를 붙여 총 50자.
  const plaintext = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const rec = {
    id: crypto.randomUUID(),
    ...values,
    hash: sha256(plaintext),
    fp: tokenFingerprint(plaintext),
    createdAt: Date.now(),
    createdBy: String(by || ''),
    revokedAt: null,
    lastUsedAt: null,
    useCount: 0,
  };
  load().keys.push(rec);
  persist();
  return { key: publicKey(rec), plaintext, issues };
}

/** 폐기 — 행을 지우지 않고 `revokedAt` 을 찍는다(감사 흔적을 남긴다). */
export function revokeApiKey(id, by = '') {
  const rec = load().keys.find((k) => k.id === String(id));
  if (!rec) return { ok: false, reason: '없는 키입니다.' };
  if (rec.revokedAt) return { ok: false, reason: '이미 폐기된 키입니다.' };
  rec.revokedAt = Date.now();
  rec.revokedBy = String(by || '');
  persist();
  return { ok: true, key: publicKey(rec) };
}

/** 이미 폐기된 키의 행을 완전히 지운다(목록 정리용 — 산 키는 지울 수 없다). */
export function deleteApiKey(id) {
  const ks = load().keys;
  const i = ks.findIndex((k) => k.id === String(id));
  if (i < 0) return { ok: false, reason: '없는 키입니다.' };
  if (!ks[i].revokedAt) return { ok: false, reason: '먼저 폐기해야 지울 수 있습니다.' };
  ks.splice(i, 1);
  persist();
  return { ok: true };
}

/** 수정 — 허용 분류·범위·만료·상한만 바꾼다. **해시는 바꾸지 않는다**(키 값은 그대로). */
export function updateApiKey(id, input = {}) {
  const rec = load().keys.find((k) => k.id === String(id));
  if (!rec) return { ok: false, reason: '없는 키입니다.' };
  if (rec.revokedAt) return { ok: false, reason: '폐기된 키는 수정할 수 없습니다.' };
  const { values, issues } = normalizeKeyInput({ ...publicKey(rec), ...input });
  if (!values.name) return { ok: false, reason: '이름은 필수입니다.', issues };
  Object.assign(rec, values, { updatedAt: Date.now() });
  persist();
  return { ok: true, key: publicKey(rec), issues };
}

/**
 * 응답·화면에 나가는 형태. ⚠ **`hash` 를 절대 싣지 않는다** — 전체 해시가 곧 저장값이고,
 * 사람이 정한 값이 아니어도 유출되면 검증을 우회할 수 있다(v2.560 규약).
 */
export function publicKey(rec) {
  if (!rec) return null;
  return {
    id: rec.id, name: rec.name, groups: [...(rec.groups || [])], vcenters: [...(rec.vcenters || [])],
    expiresAt: rec.expiresAt ?? null, rpm: rec.rpm ?? DEFAULT_RPM, note: rec.note || '',
    fp: rec.fp || '', createdAt: rec.createdAt ?? null, createdBy: rec.createdBy || '',
    revokedAt: rec.revokedAt ?? null, revokedBy: rec.revokedBy || '',
    lastUsedAt: rec.lastUsedAt ?? null, useCount: rec.useCount ?? 0,
    updatedAt: rec.updatedAt ?? null,
  };
}

export function listApiKeys() { return load().keys.map(publicKey); }

/* ── 검증 ─────────────────────────────────────────────────────────────────── */

/** 키 상태 — 화면·응답이 **원인을 구분해** 말할 수 있게 나눈다(한 문구로 덮지 않는다). */
export const KEY_STATE = Object.freeze({
  OK: 'ok', UNKNOWN: 'unknown', REVOKED: 'revoked', EXPIRED: 'expired', NO_GROUPS: 'no-groups',
});

/**
 * 평문 키 → 레코드. **상수시간 비교**를 쓴다(해시 문자열 비교의 조기 종료로 값을 탐색하지 못하게).
 * @returns {{state:string, rec?:object}}
 */
export function verifyApiKey(plaintext) {
  if (plaintext == null || plaintext === '') return { state: KEY_STATE.UNKNOWN };
  const want = Buffer.from(sha256(plaintext), 'utf8');
  let hit = null;
  for (const rec of load().keys) {
    const got = Buffer.from(String(rec.hash || ''), 'utf8');
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) { hit = rec; break; }
  }
  if (!hit) return { state: KEY_STATE.UNKNOWN };
  if (hit.revokedAt) return { state: KEY_STATE.REVOKED, rec: hit };
  if (hit.expiresAt != null && Date.now() > hit.expiresAt) return { state: KEY_STATE.EXPIRED, rec: hit };
  if (!(hit.groups || []).length) return { state: KEY_STATE.NO_GROUPS, rec: hit };
  return { state: KEY_STATE.OK, rec: hit };
}

/** 사용 기록 — 파일 쓰기를 매 요청마다 하지 않는다(60초 디바운스). */
let _dirtyAt = 0;
export function markUsed(rec) {
  if (!rec) return;
  rec.lastUsedAt = Date.now();
  rec.useCount = (rec.useCount || 0) + 1;
  // ⚠ 매 요청 persist 는 조회 API 의 처리량을 파일 I/O 에 묶는다 — 60초마다 한 번만 쓴다.
  if (Date.now() - _dirtyAt > 60_000) { _dirtyAt = Date.now(); try { persist(); } catch { /* 통계는 유실돼도 된다 */ } }
}

/* ── 레이트리밋 ───────────────────────────────────────────────────────────── */

const _rate = new Map();   // keyId -> { windowStart, count }

/**
 * 분당 상한. 초과면 `{ok:false, retryAfterSec}`.
 * ⚠ 인메모리다 — 재시작하면 창이 초기화된다. 남용 방지가 목적이고 과금이 아니므로 충분하다.
 */
export function rateAllow(rec, now = Date.now()) {
  if (!rec) return { ok: false, retryAfterSec: 60 };
  const limit = clampRpm(rec.rpm);
  const w = _rate.get(rec.id);
  if (!w || now - w.windowStart >= 60_000) { _rate.set(rec.id, { windowStart: now, count: 1 }); return { ok: true, remaining: limit - 1, limit }; }
  if (w.count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.windowStart + 60_000 - now) / 1000)), limit };
  w.count += 1;
  return { ok: true, remaining: limit - w.count, limit };
}
