/**
 * Web-editable package source settings — lets an admin change the package
 * repository URL (PACKAGE_BASE_URL), download directory, and optional token
 * from the portal UI instead of environment variables. Persisted in
 * CONFIG_DIR/packages.json; falls back to config.packages (env) when unset.
 */

import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 103회차 F6: 읽기 오류 ≠ 손상(손상 보존은 공용 읽기가 한다)
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로
import { accessMoved } from '../util/secretCarry.js';   // 133회차: 저장소 주소가 바뀌면 저장된 토큰을 승계하지 않는다(공용 판정)
import { trimTrailingSlashes } from '../util/trimSlashes.js';

const FILE = path.join(config.configDir, 'packages.json');

let cache = null;
/*
 * 103회차 F6(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**도 손상으로 보고 원본(저장소 주소 · 봉인된 토큰)을 `.corrupt.*` 로 옮긴 뒤 {} 를 캐시했다 —
 *   다음 저장(주소만 바꿔도)이 토큰 없는 파일로 원본 자리를 채웠다. 읽기 단계는 공용 읽기(30초 간격 재읽기): 읽기 오류는 원본을 두고 ·
 *   캐시하지 않고(env 기본값으로 돈다) · 저장을 409 로 거절한다. v2.583 손상 보존(parse · 형식 · 복호 실패)은 공용 읽기가 그대로 한다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => openSecretsDeep(parseJsonObject(t)), tag: 'packages' });
let _readErr = null;   // { at, code }
function load() {
  if (cache) return cache;
  const r = _reader.read();
  if (r.kind === 'read-error') {
    if (!_readErr) _readErr = { at: Date.now(), code: String(r.error?.code || 'read-error').slice(0, 32) };
    return {};   // 캐시하지 않는다 — 저장은 savePackageSettings 가 거절한다
  }
  _readErr = null;
  cache = r.kind === 'ok' ? r.value : {};
  return cache;
}
/** 103회차 F6: packages.json 읽기 오류 중의 쓰기 거절(라우트 409) 또는 null. */
export function packageSettingsWriteRefusal() {
  load();
  if (!_readErr) return null;
  return { ok: false, status: 409, code: 'settings-unreadable', readError: true,
    reason: `패키지 저장소 설정 파일(packages.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류(${_readErr.code})이고 원본(토큰 포함)은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` };
}
/** 테스트 전용. */
export function _resetPackageSettingsForTest() { cache = null; _readErr = null; _reader.reset(); }

/** Effective values: stored override > env/config default. */
export function getPackageBaseUrl() { return (load().baseUrl || '').trim() || config.packages.baseUrl; }
export function getPackageDir() { return (load().dir || '').trim() || config.packages.dir; }
export function getPackageToken() { return (load().token || '') || ''; }

export function getPackageSettings() {
  const s = load();
  return {
    baseUrl: getPackageBaseUrl(),
    dir: getPackageDir(),
    hasToken: Boolean(s.token),
    overridden: { baseUrl: Boolean(s.baseUrl), dir: Boolean(s.dir) },
    defaults: { baseUrl: config.packages.baseUrl, dir: config.packages.dir },
  };
}

/** 저장소 주소 비교용 — **유효 주소**(웹 지정 || env 기본)에서 앞뒤 공백 · 끝 '/' 를 뗀 것(대소문자는 accessMoved 가 무시한다). */
const baseKey = (v) => trimTrailingSlashes(String(v ?? '').trim() || String(config.packages.baseUrl ?? '').trim());

/**
 * 133회차(128회차 추정 E7 → 결정 · 예방 조치): 이 저장이 저장소 주소(baseUrl)를 바꾸는데 본문이 토큰을 정하지 않았는가 — 그러면 저장된 토큰을 새 주소로
 * 승계하지 않는다(server/CLAUDE.md '접속처가 바뀌면 저장 비밀을 승계하지 않는다' — util/secretCarry.js · upgrade/settings.js upgradeTokenDropped 와 같은 판정).
 *   ⚠ 정직 기록: 지금 이 토큰을 **보내는 코드는 없다**(fetchPackage · 번들 받기는 토큰을 싣지 않는다 — getPackageToken 호출부 0곳) — 그래서 '옛 토큰이 새 주소로
 *   나간다' 는 재현되지 않았다. 다만 저장 · 봉인되고 `hasToken` 으로 보이는 비밀이라, 받기 경로가 이 토큰을 쓰게 되는 날 곧바로 그 결함이 된다 → 저장 시점에 버린다.
 *   비교는 유효 주소끼리(웹 지정을 비워 env 기본으로 돌아가는 것도 주소 변경이다). 본문이 토큰을 정했으면(새 값 · 빈 값 = 지움) 폐기가 아니다.
 * @param {object} body  PUT /admin/packages/settings 본문
 */
export function packageTokenDropped(body = {}) {
  if (!body || typeof body !== 'object' || body.baseUrl === undefined) return false;   // 주소를 건드리지 않은 저장
  if (body.token !== undefined && body.token !== '********') return false;               // 본문이 토큰을 정했다
  const prev = load();
  if (!prev.token) return false;                                                         // 버릴 토큰이 없다(거짓 안내 금지)
  return accessMoved({ baseUrl: baseKey(prev.baseUrl) }, { baseUrl: baseKey(body.baseUrl) }, ['baseUrl']);
}

export function savePackageSettings(body = {}) {
  const ref = packageSettingsWriteRefusal();   // 103회차 F6
  if (ref) throw Object.assign(new Error(ref.reason), { status: 409, code: ref.code, readError: true });
  const drop = packageTokenDropped(body);      // 133회차: 주소가 바뀌었는데 새 토큰이 없으면 버린다(아래 delete — 빈 값으로 덮지 않는다)
  const next = { ...load() };
  if (body.baseUrl !== undefined) next.baseUrl = String(body.baseUrl || '').trim();
  if (body.dir !== undefined) next.dir = String(body.dir || '').trim();
  if (body.token !== undefined && body.token !== '********') next.token = String(body.token || '');
  if (drop) delete next.token;
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 }); // sealSecretsDeep 는 복제본을 봉인한다 — 메모리(cache)는 평문 유지
  cache = next;
  return getPackageSettings();
}
