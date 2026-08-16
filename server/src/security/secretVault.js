/**
 * secretVault.js — 설정 파일 자격증명(비밀번호·SSH 키·토큰)의 저장 방식(평문/암호화) 중앙 모듈(v2.296).
 *
 * 사용자 요구사항(2026-08-15): 프로그램이 쓰는 모든 계정 비밀번호(vCenter·NSX·엣지/수집기·
 * iDRAC·스캔대역·GPU/게스트 OS·Horizon·원격접속·캡처·에이전트 배포)를 ① 평문 또는 ② 암호화로
 * 저장할 수 있고, 암호화는 보안 레벨 1/2/3 또는 알고리즘을 직접 골라 쓸 수 있으며,
 * ③ 운영 중 평문↔암호화 전환(기존 저장분 일괄 마이그레이션)이 가능해야 한다.
 *
 * 설계(각 결정의 이유):
 * - **로드 시 복호 · 저장 시 봉인**: 모든 대상 레지스트리가 'readFileSync+parse / atomicWrite'
 *   의 균일 패턴이라, 그 경계에 openSecretsDeep/sealSecretsDeep 를 끼우면 **비밀번호를 소비하는
 *   코드(restClient·guestops·redfish 등)는 한 줄도 바꾸지 않는다**(메모리는 항상 평문).
 *   모드 전환도 재시작 없이 안전하다 — 실행 중 프로세스는 이미 평문을 들고 있고, 다음 save 가
 *   현재 정책대로 봉인한다.
 * - **자기서술(self-describing) 암호문**: `enc$1$<alg>$<logN>$<salt>$<iv>$<tag>$<ct>`(base64url).
 *   복호에 현재 정책이 필요 없어, 레벨/알고리즘을 바꿔도 기존 암호문이 그대로 읽히고(혼재 허용)
 *   마이그레이션 도중 크래시가 나도 파일이 절반 평문/절반 암호문인 상태에서 정상 동작한다.
 * - **AEAD 만 사용**(GCM/Poly1305): 변조되면 복호가 실패한다(무결성 내장). CBC 등 비인증 모드는
 *   제공하지 않는다 — '알고리즘 선택'은 안전한 선택지 안에서만.
 * - **키 관리**: env SECRETS_KEY 우선, 없으면 CONFIG_DIR/secrets-key 1회 생성(0600, 원자적) 후
 *   재사용(auth-secret v2.289 와 같은 패턴). ⚠ 정직한 한계: 키 파일이 설정 파일과 같은 호스트에
 *   있으므로 이 암호화는 '백업/사본/저장소 유출 시 평문 노출'을 막는 저장 시점(at-rest) 보호다 —
 *   호스트 자체가 완전히 장악되면 키도 함께 노출된다(그건 어떤 로컬 암호화도 못 막는다).
 *   그 이상이 필요하면 SECRETS_KEY 를 외부 비밀관리(환경변수 주입)로 옮길 것.
 * - **필드 선택은 정확 일치**: SECRET_FIELDS(password·privateKey·token)와 키 이름이 정확히 같은
 *   문자열 값만 봉인한다. users.json 의 passwordHash(이미 해시)는 이름이 달라 절대 걸리지 않고,
 *   봉인은 이 모듈에 **등록된 파일**(SECRET_FILES)에서만 일어난다 — 외부 프로그램이 직접 읽는
 *   공유 파일(ipam.db 등)은 등록하지 않는다.
 * - **복호 실패는 빈 문자열 + 경고**(throw 금지): 폴링 루프가 자격증명 하나 때문에 죽으면 안
 *   된다. 키 분실 시 비밀번호는 복구 불가이므로(설계상 당연) 사용자는 해당 계정 비번을 재입력
 *   해야 한다 — UI 가 이 한계를 고지한다.
 *
 * 컴팩트 후 이어받기 메모: 대상 파일 추가 시 ① 그 레지스트리 load 에 openSecretsDeep, save 에
 * sealSecretsDeep 를 끼우고 ② 아래 SECRET_FILES 에 파일명을 추가할 것(마이그레이션 대상 등록).
 * 한쪽만 하면 '전환 시 그 파일만 안 바뀌는' 반쪽 상태가 된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

// ⚠ 경로는 지연 평가(함수) — config.js 가 이 모듈을 import 하므로(loadVcenterConfig 복호 배선)
// 모듈 평가 시점에 config.configDir 를 읽으면 순환 import TDZ 로 기동이 죽는다. 함수 호출
// 시점에는 양쪽 모듈 평가가 끝나 있어 안전하다(ESM 순환의 표준 해법).
const policyFile = () => path.join(config.configDir, 'secrets-policy.json');
const keyFile = () => path.join(config.configDir, 'secrets-key');

// 봉인 대상 필드(정확 일치). token = 엣지/수집기 접속 토큰(collectors.json — 사용자 요구의
// 'edge 접속에 사용하는 계정'). vcenterPass/guestPass/centralToken/collectorToken 은
// agent-deploy-targets.json(에이전트 배포 대상)의 시크릿 필드명. passwordHash 등 유사 이름은
// 걸리지 않는다(정확 일치 — users.json 해시 오봉인 방지).
export const SECRET_FIELDS = new Set(['password', 'privateKey', 'token', 'vcenterPass', 'guestPass', 'centralToken', 'collectorToken']);

// 마이그레이션(모드 전환) 대상 파일 — 각 레지스트리 load/save 에 open/seal 이 끼워진 파일만.
// (uagmon 데스크톱 앱은 별도 배포물이라 서버 스코프 밖 — 여기 등록하지 않는다.)
export const SECRET_FILES = [
  'vcenters.json',                 // vCenter 접속 계정
  'nsx.json',                      // NSX 매니저 접속 계정
  'collectors.json',               // 엣지/수집 서버 접속 토큰
  'storage-devices.json',          // 스토리지 장비(Isilon 등) 접속 비밀번호(v2.302)
  'idrac.json',                    // iDRAC/OME 계정
  'idrac-scan-ranges.json',        // 법인별 iDRAC 스캔 계정
  'gpu-guest.json',                // GPU 게스트 OS 공용/VM별 계정
  'gpu-physical.json',             // 물리 GPU 서버 SSH 계정
  'horizon.json',                  // Horizon 접속 계정
  'remote-access.json',            // 원격접속(HAProxy dataplane·SSH 프록시) 계정/키
  'capture-monitors.json',         // 네트워크 캡처 호스트 SSH 계정/키
  'agent-deploy-targets.json',     // 에이전트 배포 대상 SSH 계정/키
  'central-agent-gpu-guest.json',  // 엣지 배포용 GPU 게스트 설정 사본(계정 포함)
];

/* ── 정책(모드·레벨·알고리즘) ─────────────────────────────────────────────── */

// 레벨 → 기본 알고리즘 + scrypt 비용(logN). 레벨이 높을수록 키 유도(KDF)가 느려져 키 파일
// 없이 암호문만 유출된 경우의 무차별 대입 비용이 커진다. 알고리즘을 명시하면 그 알고리즘을
// 쓰되 KDF 강도는 레벨을 따른다.
const LEVELS = {
  1: { alg: 'aes-128-gcm', logN: 14 },   // 빠름 — 대량 항목/저사양
  2: { alg: 'aes-256-gcm', logN: 15 },   // 기본 권장
  3: { alg: 'aes-256-gcm', logN: 16 },   // 최고 강도(KDF 2^16)
};
const ALGOS = { 'aes-128-gcm': 16, 'aes-192-gcm': 24, 'aes-256-gcm': 32, 'chacha20-poly1305': 32 }; // alg → key bytes
const MODES = ['plain', 'encrypted'];

function normPolicy(p = {}) {
  return {
    mode: MODES.includes(p.mode) ? p.mode : 'plain',                      // 기본 평문(하위호환 — 기존 동작 유지)
    level: [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 2,
    algorithm: Object.prototype.hasOwnProperty.call(ALGOS, p.algorithm) ? p.algorithm : '', // ''=레벨 기본
  };
}

// 마지막으로 성공 로드한 정책(v2.322 보안 감사): 정책 파일이 손상되면 normPolicy()=plain 으로
// 조용히 폴백하던 것을, 직전 유효 정책으로 유지한다. mode='encrypted' 운영 중 파일이 손상되면
// plain 폴백은 이후 자격증명 저장을 **조용히 평문으로 다운그레이드**(at-rest 암호화 무음 해제)한다.
let _lastGoodPolicy = null;
export function loadSecretsPolicy() {
  try {
    if (fs.existsSync(policyFile())) { _lastGoodPolicy = normPolicy(JSON.parse(fs.readFileSync(policyFile(), 'utf8'))); return _lastGoodPolicy; }
  } catch (e) {
    preserveCorrupt(policyFile(), e.message);
    // 손상 시 plain 으로 내려가지 않고 직전 유효 정책 유지 — 암호화였다면 보안 경고를 명시 출력
    // (preserveCorrupt 의 '데이터 유실' 메시지만으론 보안 다운그레이드를 운영자가 인지 못 함).
    if (_lastGoodPolicy) {
      if (_lastGoodPolicy.mode === 'encrypted') console.error('[secrets] ⚠ 정책 파일 손상 — 암호화가 조용히 해제되지 않도록 직전 유효 정책(encrypted) 유지. 정책 파일을 복구하세요.');
      return _lastGoodPolicy;
    }
  }
  return normPolicy();
}

// 핫패스 캐시(3초) — 모든 save 경로가 정책을 읽으므로 파일 IO 를 매 저장마다 하지 않는다.
let _polAt = 0, _polCache = null;
function policy() {
  const now = Date.now();
  if (_polAt && now - _polAt < 3000) return _polCache;
  _polCache = loadSecretsPolicy(); _polAt = now;
  return _polCache;
}

export function saveSecretsPolicy(partial = {}) {
  const next = normPolicy({ ...loadSecretsPolicy(), ...partial });
  atomicWriteFileSync(policyFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _polAt = 0; // 캐시 즉시 무효화 — 이후 save 부터 새 정책으로 봉인
  return next;
}

/* ── 마스터 키 ────────────────────────────────────────────────────────────── */

let _key = null;
function masterKey() {
  if (_key) return _key;
  const env = process.env.SECRETS_KEY;
  if (env && env.length >= 16) { _key = Buffer.from(env, 'utf8'); return _key; }
  try {
    const cur = fs.existsSync(keyFile()) ? fs.readFileSync(keyFile(), 'utf8').trim() : '';
    if (cur.length >= 32) { _key = Buffer.from(cur, 'utf8'); return _key; }
    const gen = crypto.randomBytes(32).toString('base64url');
    atomicWriteFileSync(keyFile(), gen, { mode: 0o600 });
    console.log(`[secrets] 암호화 키가 없어 ${keyFile()} 에 생성·영속했습니다(0600). 멀티노드/외부 비밀관리가 필요하면 SECRETS_KEY env 를 설정하세요.`);
    _key = Buffer.from(gen, 'utf8');
  } catch (e) {
    // 키 파일 쓰기 실패 — 프로세스 메모리 키로 폴백(재시작 시 기존 암호문 복호 불가).
    // 이 상태로 '암호화' 모드를 켜면 위험하므로 경고를 명확히 남긴다.
    console.warn(`[secrets] ⚠ 키 파일 쓰기 실패(${e.message}) — 임시 메모리 키 사용. 이 상태로 암호화 저장 시 재시작 후 복호가 불가능합니다. CONFIG_DIR 권한 또는 SECRETS_KEY env 를 확인하세요.`);
    _key = crypto.randomBytes(32);
  }
  return _key;
}

/* ── 봉인/복호(단일 값) ───────────────────────────────────────────────────── */

const PREFIX = 'enc$1$';
export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// scrypt 파생키 캐시 — salt 가 값마다 달라 캐시 키는 (alg|logN|salt). 마이그레이션처럼 수백
// 값을 한 번에 봉인/복호할 때 같은 salt 재사용은 없지만(봉인마다 새 salt), 복호는 값별 1회라
// 캐시 이득이 제한적 — 상한을 둬 메모리 누수를 막는다.
const kdfCache = new Map();
function deriveKey(alg, logN, salt) {
  const ck = `${alg}|${logN}|${salt.toString('base64url')}`;
  let k = kdfCache.get(ck);
  if (!k) {
    k = crypto.scryptSync(masterKey(), salt, ALGOS[alg], { N: 2 ** logN, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    if (kdfCache.size > 2000) kdfCache.clear();
    kdfCache.set(ck, k);
  }
  return k;
}

/** 평문 → 암호문(현재 정책). mode=plain 이면 평문 그대로, 이미 봉인된 값은 그대로(이중 봉인 방지). */
export function sealSecret(plain, pol = policy()) {
  if (typeof plain !== 'string' || plain === '' || isSealed(plain)) return plain;
  if (pol.mode !== 'encrypted') return plain;
  const lv = LEVELS[pol.level] || LEVELS[2];
  const alg = pol.algorithm || lv.alg;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);                       // GCM/ChaCha20-Poly1305 표준 96-bit nonce
  const key = deriveKey(alg, lv.logN, salt);
  const cipher = crypto.createCipheriv(alg, key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b = (x) => x.toString('base64url');
  return `${PREFIX}${alg}$${lv.logN}$${b(salt)}$${b(iv)}$${b(tag)}$${b(ct)}`;
}

const warned = new Set(); // 같은 사유 경고 1회(폴링 루프 로그 폭주 방지)
/** 암호문 → 평문. 봉인 포맷이 아니면 그대로 반환(평문 혼재 허용). 복호 실패는 ''(throw 금지). */
export function openSecret(v) {
  if (!isSealed(v)) return v;
  try {
    const [alg, logN, salt, iv, tag, ct] = v.slice(PREFIX.length).split('$');
    if (!Object.prototype.hasOwnProperty.call(ALGOS, alg)) throw new Error(`unknown alg ${alg}`);
    const key = deriveKey(alg, Number(logN), Buffer.from(salt, 'base64url'));
    const d = crypto.createDecipheriv(alg, key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    const k = String(e.message).slice(0, 60);
    if (!warned.has(k)) { warned.add(k); console.warn(`[secrets] ⚠ 자격증명 복호 실패(${k}) — 빈 값으로 대체. 키(secrets-key/SECRETS_KEY) 변경·유실 여부를 확인하고 해당 계정 비밀번호를 재입력하세요.`); }
    return '';
  }
}

/* ── 봉인/복호(객체 깊은 순회) ────────────────────────────────────────────── */

function walk(obj, fn) {
  if (Array.isArray(obj)) { obj.forEach((v, i) => { const r = fn(null, v); if (r !== undefined) obj[i] = r; else walk(v, fn); }); return obj; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = fn(k, obj[k]);
      if (r !== undefined) obj[k] = r; else walk(obj[k], fn);
    }
  }
  return obj;
}

/** 로드 경계용 — 봉인 포맷인 문자열을 **키 이름과 무관하게** 전부 복호(과거 필드 개명에도 안전). in-place. */
export function openSecretsDeep(obj) {
  return walk(obj, (_k, v) => (isSealed(v) ? openSecret(v) : undefined));
}

/**
 * 저장 경계용 — SECRET_FIELDS 이름의 비어있지 않은 문자열 값을 현재 정책대로 봉인.
 * ⚠ 깊은 복제 후 변환(원본 불변): save 는 메모리 상태를 직렬화하므로 in-place 로 봉인하면
 * 실행 중 메모리가 암호문으로 오염돼 다음 vCenter 로그인부터 전부 실패한다.
 */
export function sealSecretsDeep(obj, pol = policy()) {
  if (pol.mode !== 'encrypted') return obj;               // 평문 모드 — 복제 비용도 생략
  const clone = structuredClone(obj);
  return walk(clone, (k, v) => (k && SECRET_FIELDS.has(k) && typeof v === 'string' && v !== '' ? sealSecret(v, pol) : undefined));
}

/* ── 모드 전환 마이그레이션 ───────────────────────────────────────────────── */

/**
 * 등록된 전 파일을 새 정책으로 일괄 재저장(평문→암호화 / 암호화→평문 / 레벨·알고리즘 변경).
 * 파일별로: 파스 → 전부 복호(자기서술 포맷이라 이전 정책 불요) → 새 정책이 encrypted 면 봉인 →
 * 원자적 재기록. 실행 중 프로세스는 영향 없음(메모리는 평문 유지, 다음 save 는 새 정책).
 * @returns {{ files: Array<{file, changed, secrets}>, errors: Array<{file, error}> }}
 */
export function migrateSecretFiles(newPolicy) {
  const pol = normPolicy(newPolicy);
  const out = { files: [], errors: [] };
  for (const name of SECRET_FILES) {
    const fp = path.join(config.configDir, name);
    try {
      if (!fs.existsSync(fp)) { out.files.push({ file: name, changed: false, secrets: 0 }); continue; }
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      openSecretsDeep(data);                               // ① 전부 평문으로
      let count = 0;
      walk(data, (k, v) => {                               // ② 대상 필드 수 집계(보고용)
        if (k && SECRET_FIELDS.has(k) && typeof v === 'string' && v !== '') count += 1;
        return undefined;
      });
      const next = pol.mode === 'encrypted' ? sealSecretsDeep(data, pol) : data;
      const nextRaw = JSON.stringify(next, null, 2);
      const changed = nextRaw !== raw;
      // 평문→평문 재기록도 무해하지만, 무변경이면 파일 mtime 을 건드리지 않는다(mtime 캐시 스토어 배려).
      if (changed) atomicWriteFileSync(fp, nextRaw, { mode: 0o600 });
      out.files.push({ file: name, changed, secrets: count });
    } catch (e) {
      // 한 파일 실패가 전체 전환을 막지 않는다 — 자기서술 포맷이라 혼재 상태로도 동작하며,
      // 실패 파일은 보고돼 사용자가 원인(손상·권한)을 고치고 재시도할 수 있다.
      out.errors.push({ file: name, error: e.message });
    }
  }
  return out;
}
