/**
 * Runtime-editable auto-upgrade settings. Env vars provide the defaults; values
 * saved from the admin UI are persisted to config/upgrade.json (gitignored,
 * 0600 because it may hold a token) and take precedence. The manager reloads
 * these whenever they change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // v2.538: 이 파일은 v2.537 까지 봉인 대상 미등록이었다(감사 M4 계열)
import { accessMoved, secretProvided } from '../util/secretCarry.js';
import { trimTrailingSlashes } from '../util/trimSlashes.js';

// Persisted in CONFIG_DIR (default app/server/config; set to e.g.
// /etc/vmware-portal to survive upgrades).
const FILE = path.join(config.configDir, 'upgrade.json');

// Fields editable from the portal (others, e.g. downloadDir, stay env-only).
const FIELDS = ['enabled', 'watchDir', 'installDir', 'packageName', 'remoteBase', 'token', 'pollIntervalMs', 'autoApply'];

function readFile() {
  if (!fs.existsSync(FILE)) return {};
  try { return openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch (e) { if (fs.existsSync(FILE)) preserveCorrupt(FILE, e.message); return {}; }
}

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
  if (field === 'enabled' || field === 'autoApply') return Boolean(v);
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
    hasToken: Boolean(s.token),
    edges: (s.edges || []).map((e) => e.url),
  };
}
