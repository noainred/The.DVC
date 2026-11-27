/**
 * Runtime-editable auto-upgrade settings. Env vars provide the defaults; values
 * saved from the admin UI are persisted to config/upgrade.json (gitignored,
 * 0600 because it may hold a token) and take precedence. The manager reloads
 * these whenever they change.
 */

import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 103회차 F5: 읽기 오류 ≠ 손상(손상 보존은 공용 읽기가 한다)
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)
import { accessMoved, secretProvided } from '../util/secretCarry.js';
import { trimTrailingSlashes } from '../util/trimSlashes.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

// Persisted in CONFIG_DIR (default app/server/config; set to e.g.
// /etc/vmware-portal to survive upgrades).
const FILE = path.join(config.configDir, 'upgrade.json');

// Fields editable from the portal (others, e.g. downloadDir, stay env-only).
// v2.859: edgeAutoUpgrade — 중앙이 업그레이드되면 등록된 엣지도 모두 자동 업그레이드(기본 켬 — config.js UPGRADE_EDGE_AUTO).
const FIELDS = ['enabled', 'watchDir', 'installDir', 'packageName', 'remoteBase', 'token', 'pollIntervalMs', 'autoApply', 'edgeAutoUpgrade'];

/*
 * 103회차 F5(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**도 손상으로 보고 원본(원격 소스 · 봉인된 토큰 · 엣지 목록)을 `.corrupt.*` 로 옮겼다 —
 *   이 파일은 호출마다 읽어 다음 확인부터 env 기본값(다른 원격 · 토큰 없음 · 자동 적용 여부)으로 돌았고, 다음 저장이 그 기본값 위에 토큰 없는 파일을 썼다.
 *   읽기 단계는 공용 읽기(util/jsonFileRead.js — 30초 간격 재읽기): 읽기 오류는 원본을 두고 · **마지막으로 읽은 값**으로 돌며(없으면 env 기본값) ·
 *   저장을 409 로 거절한다. parse · 형식 · 복호 실패는 예전과 같이 손상(보존본으로 옮김).
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => openSecretsDeep(parseJsonObject(t)), tag: 'upgrade' });
let _readErr = null;   // { at, code }
let _lastGood = null;  // 마지막으로 읽은 저장값(읽기 오류 동안 이 값으로 돈다 — 기본값으로 뒤집히지 않게)
function readFile() {
  const r = _reader.read();
  if (r.kind === 'read-error') {
    if (!_readErr) _readErr = { at: Date.now(), code: String(r.error?.code || 'read-error').slice(0, 32) };
    return _lastGood ? { ..._lastGood } : {};
  }
  _readErr = null;
  if (r.kind !== 'ok') { _lastGood = null; return {}; }
  _lastGood = r.value;
  return { ...r.value };
}
/** 103회차 F5: upgrade.json 읽기 오류 중의 쓰기 거절(라우트 409) 또는 null. */
export function upgradeSettingsWriteRefusal() {
  readFile();
  if (!_readErr) return null;
  return { ok: false, status: 409, code: 'settings-unreadable', readError: true,
    reason: `업그레이드 설정 파일(upgrade.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류(${_readErr.code})이고 원본(토큰 포함)은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` };
}
/** 테스트 전용. */
export function _resetUpgradeSettingsForTest() { _readErr = null; _lastGood = null; _reader.reset(); }

/** Effective settings = env defaults overlaid with persisted overrides. */
export function loadSettings() {
  const eff = { ...config.upgrade };
  const persisted = readFile();
  for (const f of FIELDS) if (persisted[f] !== undefined) eff[f] = persisted[f];
  if (Array.isArray(persisted.edges)) eff.edges = persisted.edges;
  return eff;
}

export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 7 * 86_400_000;
export function clampPollMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round(n)));
}

function coerce(field, v) {
  if (field === 'enabled' || field === 'autoApply' || field === 'edgeAutoUpgrade') return Boolean(v);
  // v2.591 L3: 0 = 끔. 그 밖은 1분~7일로 클램프한다 — 상한이 없어 24.8일(2^31−1ms)을 넘기면 setInterval 이 1ms 로 바뀌어
  //   원격 릴리스 소스에 초당 수백 요청이 나갔다(재현: 43,200분 저장 → 2초에 1,331회).
  if (field === 'pollIntervalMs') return clampPollMs(v);
  return typeof v === 'string' ? v.trim() : v;
}

/** 원격 소스 주소 비교용 — 앞뒤 공백·끝 '/' 만 다른 주소는 같은 접속처다(대소문자는 accessMoved 가 무시한다). */
const remoteBaseKey = (v) => trimTrailingSlashes(String(v ?? '').trim());

/**
 * v2.731(점검 A3-01 ①): 이 저장이 원격 소스 주소(remoteBase)를 바꾸는데 새 토큰을 주지 않았는가 — 그러면 지금 쓰는 토큰
 * (저장값이든 env UPGRADE_TOKEN 이든)을 새 주소로 승계하지 않는다(server/CLAUDE.md '접속처가 바뀌면 저장 비밀을 승계하지 않는다'
 * — util/secretCarry.js). 예전에는 토큰 칸을 비우고 주소만 바꿔 저장하면 다음 확인(주기 tick 포함)이 그 주소의 versions.json
 * 요청에 `Authorization: Bearer <토큰>` 을 실었다(재현). 비교 기준은 **지금 유효한 주소**(env 위에 저장값을 덮은 것)다.
 * 순수 — prevEffective 는 loadSettings() 의 값.
 */
export function upgradeTokenDropped(prevEffective, partial) {
  if (!partial || partial.remoteBase === undefined) return false;          // 주소를 건드리지 않은 저장
  if (secretProvided(partial.token)) return false;                         // 새 토큰을 함께 줬다
  if (!(prevEffective && prevEffective.token)) return false;               // 버릴 토큰이 없다(거짓 안내 금지)
  return accessMoved({ remoteBase: remoteBaseKey(prevEffective.remoteBase) }, { remoteBase: remoteBaseKey(partial.remoteBase) }, ['remoteBase']);
}

/** Persist a partial update and return the new effective settings. */
export function saveSettings(partial) {
  // 103회차 F5: 읽기 오류 중에는 저장하지 않는다 — 원본(토큰)이 그 자리에 있어 rename 이 보존본도 없이 덮는다.
  const ref = upgradeSettingsWriteRefusal();
  if (ref) throw Object.assign(new Error(ref.reason), { status: 409, code: ref.code, readError: true });
  const prevEffective = loadSettings();
  const next = readFile();
  for (const f of FIELDS) {
    if (partial[f] !== undefined) {
      // an empty token means "leave the saved token unchanged"
      if (f === 'token' && partial[f] === '') continue;
      next[f] = coerce(f, partial[f]);
    }
  }
  // v2.731(A3-01 ①): 주소가 바뀌었는데 새 토큰이 없으면 토큰을 버린다. ⚠ 키를 delete 하면 loadSettings 가 env
  //   UPGRADE_TOKEN 을 다시 깔아 같은 토큰이 새 주소로 나간다 — 저장값 '' (명시적 '토큰 없음')으로 env 를 덮는다.
  //   빈 문자열은 '기존 유지' 규칙(위 continue)을 타지 않는다 — 그 규칙은 요청 본문에만 적용된다.
  if (upgradeTokenDropped(prevEffective, partial)) next.token = '';
  if (Array.isArray(partial.edges)) next.edges = partial.edges;
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 });
  return loadSettings();
}

/** Strip the token before returning settings to the client. */
export function redactSettings(s) {
  return {
    enabled: s.enabled,
    watchDir: s.watchDir || '',
    installDir: s.installDir || '',
    packageName: s.packageName,
    remoteBase: s.remoteBase || '',
    pollIntervalMs: s.pollIntervalMs || 0,
    autoApply: s.autoApply,
    edgeAutoUpgrade: s.edgeAutoUpgrade !== false, // v2.859: 저장값이 없으면 기본 켬
    hasToken: Boolean(s.token),
    edges: (s.edges || []).map((e) => e.url),
  };
}
