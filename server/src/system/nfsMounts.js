/**
 * system/nfsMounts.js — Edge 노드 NFS 마운트 관리(v2.299).
 *
 * 사용자 요구사항: VM 복제(백업)의 NFS 대상을 위해, 포탈이 도는 Edge 노드에 NFS 를
 * **웹 UI 에서** 마운트/해제하고 결과·로그·트러블슈팅을 볼 수 있게 한다(설정 메뉴).
 *
 * 보안(server/CLAUDE.md '셸 명령 조립' 규칙 — 절대 완화 금지):
 *  - mount/umount 인자는 전부 **화이트리스트 정규식 검증 후에만** execFile 배열 인자로 전달
 *    (셸 미경유 — 인젝션 원천 차단). 선행 '-' 차단 포함.
 *  - 마운트 지점은 BASE(기본 /mnt/portal-nfs) 아래 자동 생성 id 디렉터리로 **고정** — 사용자가
 *    임의 경로(/etc 등)에 마운트해 시스템을 덮는 사고를 구조적으로 차단.
 *  - mount 는 보통 root 권한이 필요하다. 포탈이 서비스 계정으로 돌면 sudo -n(비밀번호 없는
 *    sudoers 항목 필요)으로 1회 재시도하고, 실패 시 트러블슈팅 안내(정확한 sudoers 줄)를
 *    로그에 남긴다 — 조용히 성공한 척하지 않는다(정직 원칙).
 *
 * 설정 파일: CONFIG_DIR/nfs-mounts.json → { version:1, mounts:[{id,server,exportPath,options,createdAt}] }
 * 실행 로그: 인메모리 링(최근 200) — 재시작하면 사라진다(마운트 상태 자체는 /proc/mounts 가 진실).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'nfs-mounts.json');
const BASE = process.env.NFS_MOUNT_BASE || '/mnt/portal-nfs';
const MAX_MOUNTS = 20;

// 화이트리스트 — server: 호스트명/IPv4(선행 '-' 불가), exportPath: 절대경로·'..' 금지,
// options: nfs 마운트 옵션 문자셋만(콤마 구분 key=value).
const RE_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;
const RE_EXPORT = /^\/[A-Za-z0-9._/-]*$/;
const RE_OPTIONS = /^[A-Za-z0-9=,._:-]*$/;

let _db = null;
const _log = []; // { at, mountId, action, ok, detail(stderr 요약) }
function addLog(entry) { _log.push({ at: Date.now(), ...entry }); if (_log.length > 200) _log.shift(); }

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) { _db = { mounts: JSON.parse(fs.readFileSync(FILE, 'utf8')).mounts || [] }; return _db; }
  } catch { preserveCorrupt(FILE); }
  _db = { mounts: [] };
  return _db;
}
function persist() { atomicWriteFileSync(FILE, JSON.stringify({ version: 1, mounts: load().mounts }, null, 2), { mode: 0o600 }); }

/** 마운트 스펙 검증(순수 — nfsMounts.test.js 로 고정). 통과 시 정규화 값, 실패 시 throw. */
export function validateMountSpec({ server, exportPath, options } = {}) {
  const s = String(server || '').trim();
  const e = String(exportPath || '').trim();
  const o = String(options || '').trim();
  if (!RE_SERVER.test(s)) throw new Error('NFS 서버 형식 오류 — 호스트명/IP 만(공백·특수문자 불가, 선행 - 불가)');
  if (!RE_EXPORT.test(e) || e.includes('..')) throw new Error("export 경로 형식 오류 — '/'로 시작하는 절대경로, '..' 금지");
  if (!RE_OPTIONS.test(o)) throw new Error('마운트 옵션 형식 오류 — 영숫자·=,.:-_ 만 허용');
  if (o.split(',').some((t) => t.startsWith('-'))) throw new Error("마운트 옵션에 '-' 로 시작하는 토큰 금지");
  return { server: s, exportPath: e, options: o };
}

export function mountPointOf(id) { return path.join(BASE, String(id).replace(/[^A-Za-z0-9_-]/g, '')); }

export function listMounts() {
  const mounted = mountedSet();
  return load().mounts.map((m) => ({ ...m, mountPoint: mountPointOf(m.id), mounted: mounted.has(mountPointOf(m.id)) }));
}
export function getMount(id) { return listMounts().find((m) => m.id === id) || null; }

export function addMount(spec) {
  const v = validateMountSpec(spec);
  const db = load();
  if (db.mounts.length >= MAX_MOUNTS) throw new Error(`NFS 마운트는 최대 ${MAX_MOUNTS}개까지 등록할 수 있습니다.`);
  if (db.mounts.some((m) => m.server === v.server && m.exportPath === v.exportPath)) throw new Error('같은 서버:경로 마운트가 이미 있습니다.');
  const m = { id: `nfs-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...v, createdAt: Date.now() };
  db.mounts.push(m); persist();
  return { ...m, mountPoint: mountPointOf(m.id), mounted: false };
}

export function deleteMount(id) {
  const db = load();
  const i = db.mounts.findIndex((m) => m.id === id);
  if (i < 0) return false;
  if (mountedSet().has(mountPointOf(id))) throw new Error('마운트 중입니다 — 먼저 해제하세요.');
  db.mounts.splice(i, 1); persist();
  return true;
}

/** 현재 마운트된 지점 집합 — Linux 는 /proc/mounts 가 진실의 원천(mac 개발환경은 mount 출력 폴백). */
export function mountedSet() {
  try {
    if (process.platform === 'linux') {
      return new Set(fs.readFileSync('/proc/mounts', 'utf8').split('\n').map((l) => l.split(' ')[1]).filter(Boolean));
    }
  } catch { /* 폴백 아래 */ }
  return new Set(); // 비 Linux(개발): 마운트 불가 환경 — 상태만 '미지원'으로 흐른다
}

const run = (cmd, args, timeoutMs = 30_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
  });
});

/** 마운트 실행 — 직접 → 실패 시 sudo -n 재시도. 결과·표준에러를 로그로 남긴다. */
export async function mountNow(id) {
  const m = load().mounts.find((x) => x.id === id);
  if (!m) throw new Error('마운트 항목이 없습니다.');
  if (process.platform !== 'linux') { addLog({ mountId: id, action: 'mount', ok: false, detail: '이 OS 에서는 마운트 미지원(Linux Edge 노드 전용)' }); return { ok: false, reason: 'Linux Edge 노드에서만 마운트할 수 있습니다.' }; }
  const mp = mountPointOf(id);
  try { fs.mkdirSync(mp, { recursive: true }); } catch (e) {
    // BASE(/mnt/portal-nfs) 생성 권한이 없으면 여기서 먼저 막힌다 — 트러블슈팅에 안내
    addLog({ mountId: id, action: 'mount', ok: false, detail: `마운트 지점 생성 실패: ${e.message}` });
    return { ok: false, reason: `마운트 지점 생성 실패(${e.message}) — 트러블슈팅 참조(BASE 디렉터리 권한)` };
  }
  if (mountedSet().has(mp)) return { ok: true, already: true };
  // 검증된 값만 배열 인자로(셸 미경유). 옵션이 비면 -o 자체를 생략.
  const args = ['-t', 'nfs', ...(m.options ? ['-o', m.options] : []), `${m.server}:${m.exportPath}`, mp];
  let r = await run('mount', args);
  if (!r.ok && /permission|only root|not permitted/i.test(r.stderr)) r = await run('sudo', ['-n', 'mount', ...args]);
  addLog({ mountId: id, action: 'mount', ok: r.ok, detail: r.ok ? `${m.server}:${m.exportPath} → ${mp}` : r.stderr.slice(0, 300) });
  return r.ok ? { ok: true, mountPoint: mp } : { ok: false, reason: r.stderr.slice(0, 300) || `mount 실패(code ${r.code})` };
}

export async function umountNow(id) {
  const mp = mountPointOf(id);
  if (!mountedSet().has(mp)) return { ok: true, already: true };
  let r = await run('umount', [mp]);
  if (!r.ok && /permission|only root|not permitted/i.test(r.stderr)) r = await run('sudo', ['-n', 'umount', mp]);
  addLog({ mountId: id, action: 'umount', ok: r.ok, detail: r.ok ? mp : r.stderr.slice(0, 300) });
  return r.ok ? { ok: true } : { ok: false, reason: r.stderr.slice(0, 300) || `umount 실패(code ${r.code})` };
}

export function mountLogs() { return [..._log].reverse(); }

/** 트러블슈팅 안내(정적) — UI 가 그대로 표시. 실제 명령·설정 줄을 구체적으로. */
export function troubleshooting() {
  const user = os.userInfo().username;
  return [
    { t: '권한(가장 흔함)', d: `mount 는 root 권한이 필요합니다. 포탈 서비스 계정(${user})으로 비밀번호 없이 실행하려면 visudo 로 다음 한 줄을 추가하세요:\n${user} ALL=(root) NOPASSWD: /usr/bin/mount, /usr/bin/umount` },
    { t: '마운트 지점 권한', d: `마운트 지점 베이스(${BASE})가 없거나 서비스 계정이 만들 수 없으면 실패합니다:\nsudo mkdir -p ${BASE} && sudo chown ${user} ${BASE}` },
    { t: 'NFS 클라이언트 미설치', d: 'Rocky/RHEL: sudo dnf install -y nfs-utils · Ubuntu: sudo apt install -y nfs-common' },
    { t: '네트워크/방화벽', d: 'NAS 로 TCP 2049(NFS)·111(rpcbind, v3) 이 열려 있어야 합니다. 확인: showmount -e <NFS서버> (v3) 또는 mount 시도 로그의 timeout 여부' },
    { t: 'NFS 버전 불일치', d: "NAS 가 v3 만 지원하면 옵션에 vers=3 을, v4 전용이면 vers=4.1 등을 지정하세요(옵션 예: vers=3,nolock)" },
    { t: 'export 접근 제어', d: 'NAS 의 export 설정(허용 IP 목록)에 이 Edge 노드 IP 가 포함돼야 합니다. 로그에 access denied 가 보이면 이 경우입니다.' },
  ];
}

export function _resetForTest() { _db = null; _log.length = 0; }
