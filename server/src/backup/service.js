/**
 * 포탈 백업 코어 — 중앙 포탈의 모든 설정(CONFIG_DIR의 *.json / *.env)과, 엣지 포탈(에이전트)이
 * push한 설정을 하나의 gzip 아카이브로 통합 저장한다. 수집 데이터(대용량 DB·스캔결과)는 제외.
 *
 * 아카이브 포맷(gzip JSON): { v, createdAt, reason, central:{version,files}, edges:{agent:{at,files}} }
 * 저장 위치: CONFIG_DIR/backups/portal-backup-<ISO>.json.gz
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config, currentVersion } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { getAllAgentConfigs } from '../central/agentConfig.js';

const CONFIG_DIR = config.configDir;
const BACKUP_DIR = path.join(CONFIG_DIR, 'backups');

const ALLOW_EXT = new Set(['.json', '.env']);
// 설정이 아니라 '수집 데이터'라서 백업에서 제외(대용량/재생성 가능).
const DENY_NAMES = new Set(['central-inventory.json', 'central-agent-config.json', 'ipam-scan-history.json', 'ipam-scan-results.json']);
const FILE_SIZE_CAP = 8 * 1024 * 1024; // 파일당 8MB 상한(대용량 데이터 방지)

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }

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
      if (st.size > FILE_SIZE_CAP) continue;
      out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch { /* skip */ }
  }
  return out;
}

/** 백업 아카이브 1개 생성. reason: 'manual'|'schedule'|'change'|'startup'. */
export function createBackup(reason = 'manual', { retention = 30 } = {}) {
  ensureDir();
  const central = { version: currentVersion(), files: collectConfigDir() };
  const edges = getAllAgentConfigs();
  const archive = { v: 1, createdAt: Date.now(), reason, central, edges };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(archive)));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `portal-backup-${stamp}.json.gz`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), gz, { mode: 0o600 });
  pruneBackups(retention);
  const edgeAgents = Object.keys(edges);
  return { name, size: gz.length, createdAt: archive.createdAt, reason, centralFiles: Object.keys(central.files).length, edges: edgeAgents.length, edgeAgents };
}

/** 보관 개수 초과분(오래된 것)을 삭제. */
export function pruneBackups(keep = 30) {
  const list = listBackups();
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
    return { name, size, at };
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
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); } catch { return null; }
}

/**
 * 중앙 설정 복원 — 복원 전 현재 설정을 안전 백업(reason=pre-restore)한 뒤, 아카이브의
 * central.files 를 CONFIG_DIR에 덮어쓴다. 적용에는 보통 재시작이 필요하다.
 * @param archive readBackup 결과 또는 업로드 파싱 결과
 */
export function restoreCentral(archive) {
  if (!archive || !archive.central || typeof archive.central.files !== 'object') throw new Error('유효하지 않은 백업 아카이브');
  createBackup('pre-restore');
  ensureDir();
  let restored = 0;
  for (const [name, content] of Object.entries(archive.central.files)) {
    const base = path.basename(name);
    if (DENY_NAMES.has(base) || !ALLOW_EXT.has(path.extname(base).toLowerCase())) continue;
    // 원자적 쓰기 — 복원 도중 정전/디스크풀이면 users.json 같은 핵심 설정이 부분기록으로
    // 손상된 채 남는다(복원이 오히려 파손 유발). tmp+rename으로 온전본만 남긴다.
    try { atomicWriteFileSync(path.join(CONFIG_DIR, base), String(content)); restored++; } catch { /* */ }
  }
  return { restored, edges: Object.keys(archive.edges || {}).length };
}

/** 업로드된 gzip 아카이브 버퍼를 파싱. */
export function parseUploadedArchive(buf) {
  try { return JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch (e) { throw new Error(`백업 파일 해석 실패: ${e.message}`); }
}
