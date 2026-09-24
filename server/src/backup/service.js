/**
 * 포탈 백업 코어 — 중앙 포탈의 모든 설정(CONFIG_DIR의 *.json / *.env)과, 엣지 포탈(에이전트)이
 * push한 설정을 하나의 gzip 아카이브로 통합 저장한다. 수집 데이터(대용량 DB·스캔결과)는 제외.
 *
 * 아카이브 포맷(gzip JSON): { v, createdAt, reason, central:{version,files}, edges:{agent:{at,files}} }
 * 저장 위치: CONFIG_DIR/backups/portal-backup-<ISO>.json.gz
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, currentVersion } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { redactEnvSecrets, mergeRedactedEnv } from '../util/envRedact.js'; // v2.538: 번들의 .env 에서 키·토큰 제거
import { getAllAgentConfigs } from '../central/agentConfig.js';

/** 백업 아카이브(gzip JSON) 해제 출력 상한 — 설정 디렉터리 전체가 들어가도 수 MB 다(실측 2KB). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const CONFIG_DIR = config.configDir;
const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');

const ALLOW_EXT = new Set(['.json', '.env']);
// 설정이 아니라 '수집 데이터'라서 백업에서 제외(대용량/재생성 가능).
const DENY_NAMES = new Set(['central-inventory.json', 'central-agent-config.json', 'ipam-scan-history.json', 'ipam-scan-results.json']);
const FILE_SIZE_CAP = 8 * 1024 * 1024; // 파일당 8MB 상한(대용량 데이터 방지)

/**
 * v2.590 P1: 설정이 아니라 **폴러·엣지 push 가 스스로 다시 쓰는** 상태·캐시 파일.
 * '설정 변경 시 자동 백업' 감시는 이 파일들의 쓰기로 깨지 않는다. v2.589 까지는 `.json` 쓰기 전부가 'change' 백업을
 * 만들어, 엣지 1곳(60초 push)만 있어도 30분 만에 보관 슬롯이 같은 내용의 'change' 백업으로 채워져 정기·수동 백업이
 * 조용히 지워졌고, 엣지가 많으면 반대로 디바운스가 계속 초기화돼 **실제 설정 변경 백업이 한 번도 생기지 않았다**.
 * 백업 **내용**은 바꾸지 않는다(복원 의미 유지) — 트리거와 중복 판정에서만 뺀다.
 */
export const RUNTIME_STATE_NAMES = new Set([
  'backup.json', 'central-agent-config.json', 'central-inventory.json', 'central-fleet.json', 'central-pdu.json',
  'central-agent-storage.json', 'central-agent-sanswitch.json', 'central-agent-sanswitch-perf.json',
  'central-agent-gpu-guest.json', 'central-unsupported-servers.json', 'agent-results.json',
  'active-sessions.json', 'sanswitch-perf-push.json', 'ipam-scan-history.json', 'ipam-scan-results.json',
]);
// 이름 규약으로 드러나는 상태 파일(-latest·-activity·-history·-results·-runs·-log·-state·-usage·-stats·-stops·-inventory·-cache).
// ⚠ 'vcenter-logs.json'(설정)·'dirusage.json'(설정)은 하이픈 뒤 정확한 단어가 아니라 걸리지 않는다 — 테스트가 고정한다.
const RUNTIME_STATE_RE = /-(latest|activity|history|results|runs|log|state|usage|stats|stops|inventory|cache)\.json$/i;
/**
 * v2.591(3차 감사 R-B1): 이름 규약에 걸리지만 **사람이 편집하는 설정**인 파일 — 상태로 분류하면 편집해도 '변경 시 자동 백업' 이
 * 생기지 않았다(재현: 편집 후 change 백업 `skipped: unchanged`). `svcmon-log.json` 은 성능점검 로그 **정책**(-log 규약에 걸림),
 * `agent-assignments.json` 은 에이전트 스캔 할당(관리자 CRUD 로만 쓰인다 — 결과는 agent-results.json 이다) 이라 v2.590 목록에서 뺐다.
 * CONFIG-FILES.md 는 JSON 대부분을 '설정' 으로 묶어 기계 대조가 안 된다 — 이름 규약에 걸리는 파일 29개를 하나씩 보고 정했다.
 */
export const SETTINGS_NOT_STATE = new Set(['svcmon-log.json', 'agent-assignments.json']);
export function isRuntimeStateFile(name) {
  const b = path.basename(String(name || ''));
  if (SETTINGS_NOT_STATE.has(b)) return false;
  return DENY_NAMES.has(b) || RUNTIME_STATE_NAMES.has(b) || RUNTIME_STATE_RE.test(b);
}

/** 설정 파일 묶음의 지문 — 상태·캐시 파일은 뺀다. 'change' 백업이 직전 백업과 같은 내용이면 만들지 않는 데 쓴다. */
/**
 * 설정과 실행 결과가 한 파일에 섞인 스토어(v2.595, 감사 FS-1): 폴러가 매 실행마다 `last*` 를 써서 '변경 시 자동 백업' 이
 * 주기마다 생기고 자동 사유 보관 슬롯(10)의 실제 설정 변경 백업을 밀어냈다. 파일째 상태로 분류하면 설정 편집도 백업되지 않으므로
 * **지문에서만** `last*` 키를 빼고 본다(번들 내용은 그대로 — 복원 가능).
 */
export const MIXED_STATE_FILES = new Set(['capture-monitors.json', 'os-scan.json', 'guest-scans.json', 'vm-clone.json',
  // v2.596(감사 R2596-03 — 재현): 엣지 pull 마다 lastUsedAt(엣지당 60초) · 연동 키 useCount · 일일 보고 lastRunTs 를 쓴다.
  'central-agent-tokens.json', 'api-keys.json', 'daily-report.json',
  // v2.601(감사 LO2601-03 — 재현): iDRAC 대역 스캔 폴러가 엔트리마다 lastRun 을, 원격 접속 게이트웨이가 매 접속마다 매핑의
  // lastUsedAt 을 쓴다(idrac/scanRanges.js recordRun · proxy/registry.js touchMapping) — 실행·사용마다 change 백업이 생겼다.
  'idrac-scan-ranges.json', 'remote-access.json',
  // v2.602(감사 LEFT2602-01 — 재현): 엣지 배포 대상도 '상태 확인'·배포 결과마다 lastResult 를 쓴다(agent/deployRegistry.js recordResult).
  'agent-deploy-targets.json']);
// 실행 필드 — last* 와 사용 횟수(useCount). 설정이 아니다.
const RUN_FIELD_RE = /^(last[A-Z]|useCount$)/;
function stripRunFields(v) {
  if (Array.isArray(v)) return v.map(stripRunFields);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!RUN_FIELD_RE.test(k)) o[k] = stripRunFields(x);
    return o;
  }
  return v;
}
/*
 * v2.596(감사 R2596-02 — 재현): 암호화 모드에서는 저장할 때마다 봉인 값의 salt·iv 가 새로 뽑혀 **내용이 같아도 암호문이
 * 달라졌다** — 그래서 v2.596·v2.597 은 봉인을 열어(v2.597 부터는 파생키가 캐시에 있을 때만) 평문 기준으로 지문을 냈다.
 * v2.598(감사 RECENT2598-01 — 재현): 그 방식은 지문이 **파생키 캐시 상태**에 따라 달라졌다 — 기동 백업은 레지스트리를
 * 읽기 전이라 봉인 값이 전부 '캐시 없음' 표식이고, 레지스트리가 로드된 뒤에는 평문이 되어 내용 변화 없이 change 백업이 생겼다
 * (kdfCache 가 넘쳐 비워질 때도 같다). 이제 secretVault.sealSecretsDeep 이 **평문이 같은 값은 기존 암호문을 재사용**하므로
 * (L2598-01) 설정을 안 바꾼 저장은 봉인 값이 글자 그대로 같다 → 지문은 봉인 원문을 그대로 쓴다. 봉인을 열지 않으므로
 * scrypt 도, 캐시 의존도 없다(v2.597 RECENT-01 규약). 재사용 기억이 밀려 새로 봉인되면 지문이 한 번 달라질 뿐이다(백업을
 * 더 만드는 쪽 — 안전).
 */
function fingerprintContent(name, content) {
  if (!/\.json$/i.test(name)) return String(content);
  if (!MIXED_STATE_FILES.has(name)) return String(content);
  let obj;
  try { obj = JSON.parse(String(content)); } catch { return String(content); }
  return JSON.stringify(stripRunFields(obj));
}
export function settingsFingerprint(files) {
  const h = crypto.createHash('sha1');
  for (const name of Object.keys(files || {}).filter((n) => n !== REDACTED_META && n !== SKIPPED_META && !isRuntimeStateFile(n)).sort()) {
    h.update(name); h.update('\0'); h.update(fingerprintContent(name, files[name])); h.update('\0');
  }
  return h.digest('hex');
}
let _lastFingerprint = null;
export function _resetBackupFingerprint() { _lastFingerprint = null; }

/** 사유별 보관 상한 — 자동 사유('change'·'startup')는 전체 보관 개수 중 이 개수까지만 차지한다(정기·수동을 밀어내지 않게). */
export const AUTO_REASON_KEEP = 10;
const AUTO_REASONS = new Set(['change', 'startup']);
/** 파일명에서 사유를 읽는다 — v2.590 이전 이름(사유 없음)은 null(= 보호 대상, 자동 사유로 치지 않는다). */
export function reasonOfName(name) {
  const m = /^portal-backup-.+-(manual|schedule|change|startup|pre-restore)\.json\.gz$/.exec(String(name || ''));
  return m ? m[1] : null;
}

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }

/** 번들 파일 맵 안의 메타 키 — 가린 env 키 목록 `{ 'portal.env': ['AUTH_SECRET', …] }`. 파일이 아니다. */
export const REDACTED_META = '__redacted__';
/** 크기 상한으로 뺀 파일 `[{name,size}]`(v2.590 D5). 메타 키이고 파일이 아니다. */
export const SKIPPED_META = '__skipped__';
/** CONFIG_DIR(비재귀)에서 설정 파일들을 { name: content(utf8) }로 수집. */
export function collectConfigDir(dir = CONFIG_DIR) {
  const out = {};
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isFile()) continue; // backups/ 등 하위 디렉터리 제외
    const name = e.name;
    if (DENY_NAMES.has(name)) continue;
    if (!ALLOW_EXT.has(path.extname(name).toLowerCase())) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      // v2.590 D5: 상한 초과 파일을 **조용히** 빼지 않는다 — 대규모 svcmon.json(실측 16.4MB)이 빠진 채 '백업 완료' 로
      // 보고되어 그 백업으로 복원하면 성능점검 대상 전량이 사라졌다. 뺀 파일을 결과·번들에 싣고 화면이 말한다.
      if (st.size > FILE_SIZE_CAP) { (out[SKIPPED_META] ||= []).push({ name, size: st.size }); continue; }
      let content = fs.readFileSync(path.join(dir, name), 'utf8');
      // v2.538: .env 의 서명 키·봉인 키·토큰은 번들에 싣지 않는다(util/envRedact.js 머리말). 가린 개수는
      // `out[REDACTED_META]` 로 돌려 화면·결과가 말한다 — 조용히 빼면 복원 뒤 '왜 키가 사라졌나' 를 모른다.
      if (path.extname(name).toLowerCase() === '.env') {
        const r = redactEnvSecrets(content);
        content = r.text;
        if (r.redacted) (out[REDACTED_META] ||= {})[name] = r.keys;
      }
      out[name] = content;
    } catch { /* skip */ }
  }
  return out;
}

/** 백업 아카이브 1개 생성. reason: 'manual'|'schedule'|'change'|'startup'. */
export function createBackup(reason = 'manual', { retention = 30, skipIfUnchanged = false } = {}) {
  ensureDir();
  const files = collectConfigDir();
  const redactedMeta = files[REDACTED_META] || null; delete files[REDACTED_META];
  const skippedFiles = files[SKIPPED_META] || []; delete files[SKIPPED_META];
  const fp = settingsFingerprint(files);
  // v2.590 P1: 변경 감시가 깨웠는데 설정 내용이 직전 백업과 같으면(상태 파일만 바뀜) 만들지 않는다 — 사유를 돌려 호출부가 기록한다.
  if (skipIfUnchanged && _lastFingerprint && fp === _lastFingerprint) return { skipped: true, reason, why: 'unchanged' };
  const central = { version: currentVersion(), files, redacted: redactedMeta, skipped: skippedFiles.length ? skippedFiles : undefined };
  const edges = getAllAgentConfigs();
  const archive = { v: 1, createdAt: Date.now(), reason, central, edges };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(archive)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = /^[a-z-]{1,20}$/.test(String(reason)) ? reason : 'manual';
  const name = `portal-backup-${stamp}-${safeReason}.json.gz`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), gz, { mode: 0o600 });
  _lastFingerprint = fp;
  pruneBackups(retention);
  const edgeAgents = Object.keys(edges);
  const redacted = redactedMeta ? Object.values(redactedMeta).reduce((n, ks) => n + ks.length, 0) : 0;
  return { name, size: gz.length, createdAt: archive.createdAt, reason, centralFiles: Object.keys(central.files).length, edges: edgeAgents.length, edgeAgents, redacted, skipped: skippedFiles, sizeCapBytes: FILE_SIZE_CAP };
}

/** 보관 개수 초과분(오래된 것)을 삭제. */
export function pruneBackups(keep = 30) {
  let list = listBackups();
  // v2.590 P1: 자동 사유(change·startup)는 최신 AUTO_REASON_KEEP 개까지만 — 그 이상은 정기·수동보다 먼저 지운다.
  // 보관 개수가 그보다 작으면 자동 사유 상한도 그만큼(보관 개수를 넘는 상한은 뜻이 없다).
  const autoKeep = Math.min(AUTO_REASON_KEEP, Math.max(1, keep));
  let auto = 0;
  const kept = [];
  for (const b of list) {
    if (AUTO_REASONS.has(reasonOfName(b.name)) && ++auto > autoKeep) { try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* */ } continue; }
    kept.push(b);
  }
  list = kept;
  for (const b of list.slice(keep)) { try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch { /* */ } }
}

/** 백업 목록(최신순) — { name, size, at }. */
export function listBackups() {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json.gz')); } catch { return []; }
  return files.map((name) => {
    let size = 0, at = 0;
    try { const st = fs.statSync(path.join(BACKUP_DIR, name)); size = st.size; at = st.mtimeMs; } catch { /* */ }
    return { name, size, at, reason: reasonOfName(name) };
  }).sort((a, b) => b.at - a.at);
}

function safeName(name) {
  // 경로 조작 방지: 파일명만 허용.
  const base = path.basename(String(name || ''));
  if (!/^portal-backup-[\w.-]+\.json\.gz$/.test(base)) return null;
  return base;
}

/** 백업 파일의 절대경로(다운로드용). 없으면 null. */
export function backupPath(name) {
  const n = safeName(name);
  if (!n) return null;
  const p = path.join(BACKUP_DIR, n);
  return fs.existsSync(p) ? p : null;
}

export function deleteBackup(name) {
  const p = backupPath(name);
  if (!p) return false;
  fs.unlinkSync(p);
  return true;
}

/** 아카이브 내용 파싱(요약/복원용). */
export function readBackup(name) {
  const p = backupPath(name);
  if (!p) return null;
  // 상한은 위 parseUploadedArchive 와 같은 이유(손상·조작된 백업 파일도 프로세스를 밀지 못하게).
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p), { maxOutputLength: MAX_ARCHIVE_BYTES }).toString('utf8')); } catch { return null; }
}

/**
 * 중앙 설정 복원 — 복원 전 현재 설정을 안전 백업(reason=pre-restore)한 뒤, 아카이브의
 * central.files 를 CONFIG_DIR에 덮어쓴다. 적용에는 보통 재시작이 필요하다.
 * @param archive readBackup 결과 또는 업로드 파싱 결과
 */
export function restoreCentral(archive, { retention = 30 } = {}) {
  if (!archive || !archive.central || typeof archive.central.files !== 'object') throw new Error('유효하지 않은 백업 아카이브');
  // v2.590 P2: 사전 백업도 **설정된 보관 개수**로 정리한다 — 기본값 30 으로 잘라 보관 100 인 현장에서 오래된 백업
  // (방금 복원한 원본 포함)이 조용히 지워졌다.
  createBackup('pre-restore', { retention });
  ensureDir();
  let restored = 0;
  let envRestored = 0; const envDropped = [];
  for (const [name, content0] of Object.entries(archive.central.files)) {
    const base = path.basename(name);
    if (base === REDACTED_META || base === SKIPPED_META) continue; // 메타 키는 파일이 아니다
    if (DENY_NAMES.has(base) || !ALLOW_EXT.has(path.extname(base).toLowerCase())) continue;
    let content = content0;
    // v2.538: 번들의 .env 는 키·토큰이 가려져 있다 — 현재 파일의 값으로 되살리고, 없으면 그 줄을 버린다
    // (빈 값으로 덮어써 AUTH_SECRET 을 지우면 전 세션이 무효가 된다).
    if (path.extname(base).toLowerCase() === '.env') {
      let cur = ''; try { cur = fs.readFileSync(path.join(CONFIG_DIR, base), 'utf8'); } catch { /* 없음 */ }
      const m = mergeRedactedEnv(String(content0), cur);
      content = m.text; envRestored += m.restored; envDropped.push(...m.dropped.map((k) => `${base}:${k}`));
    }
    // 원자적 쓰기 — 복원 도중 정전/디스크풀이면 users.json 같은 핵심 설정이 부분기록으로
    // 손상된 채 남는다(복원이 오히려 파손 유발). tmp+rename으로 온전본만 남긴다.
    try { atomicWriteFileSync(path.join(CONFIG_DIR, base), String(content)); restored++; } catch { /* */ }
  }
  return { restored, edges: Object.keys(archive.edges || {}).length, envKeysRestored: envRestored, envKeysDropped: envDropped };
}

/** 업로드된 gzip 아카이브 버퍼를 파싱. */
/**
 * ⚠⚠ `maxOutputLength` 를 지우지 말 것(v2.577). gzip 은 증폭비가 1000:1 을 넘길 수 있어
 * 상한 없는 `gunzipSync` 는 작은 입력으로 프로세스 메모리를 밀어 올린다(zip bomb).
 * 형제 파일 `upgrade/archive.js:66,106` 은 v2.488(L-1)에 이미 상한을 받았는데 여기만 빠져
 * 있었다 — CLAUDE.md 가 반복해 경고하는 '형제 경로 누락' 패턴이다.
 * ⚠ **정직 기록**: v2.577 시점에 `parseUploadedArchive` 를 부르는 라우트는 **없다**(전수 확인) —
 * 즉 지금 도달 가능한 취약점이 아니라 **잠재**다. 그래도 막는 이유는 이름이 'Uploaded' 이고,
 * 업로드 라우트를 붙이는 순간 상한 없는 경로가 되기 때문이다.
 */
export function parseUploadedArchive(buf) {
  try { return JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: MAX_ARCHIVE_BYTES }).toString('utf8')); }
  catch (e) { throw new Error(`백업 파일 해석 실패: ${e.message}`); }
}
