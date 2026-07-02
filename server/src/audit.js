/**
 * Audit log — records security/operational actions (who did what, when) so the
 * portal's write operations (VM 생성, 원격접속, 설정 변경 등)이 추적된다. Appended
 * to CONFIG_DIR/audit.ndjson (one JSON per line), capped to the most recent
 * AUDIT_MAX lines. Read-only viewing via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.configDir, 'audit.ndjson');
const MAX = Number(process.env.AUDIT_MAX) || 20000;

// Human labels for the auto-logged admin/remote write routes (method + path).
function describe(method, urlPath) {
  const p = urlPath.replace(/^\/api/, '');
  const rules = [
    [/^\/admin\/vcenters\/.+$/, { PUT: 'vCenter 수정', DELETE: 'vCenter 삭제' }],
    [/^\/admin\/vcenters$/, { POST: 'vCenter 추가' }],
    [/^\/admin\/vcenter-order$/, { PUT: 'vCenter 순서 변경' }],
    [/^\/admin\/nsx\/managers/, { POST: 'NSX Manager 추가', PUT: 'NSX Manager 수정', DELETE: 'NSX Manager 삭제' }],
    [/^\/admin\/data-source$/, { PUT: '데이터 소스 변경' }],
    [/^\/admin\/provision\/jobs$/, { POST: 'VM 생성 작업 시작' }],
    [/^\/admin\/provision\/saved/, { PUT: '저장작업 메모/태그 수정', DELETE: '저장작업 삭제' }],
    [/^\/admin\/users/, { POST: '사용자 추가', PUT: '사용자 수정', DELETE: '사용자 삭제' }],
    [/^\/admin\/ipam\/settings$/, { PUT: 'IPMS 설정 변경' }],
    [/^\/admin\/packages\/settings$/, { PUT: '패키지 저장소 설정 변경' }],
    [/^\/admin\/packages\/download$/, { POST: '패키지 다운로드' }],
    [/^\/remote\/mappings/, { POST: '원격접속 매핑 생성', DELETE: '원격접속 매핑 삭제' }],
    [/^\/remote\/proxies/, { POST: '중계서버 저장', DELETE: '중계서버 삭제' }],
    [/^\/remote\/config$/, { PUT: '중계서버 설정 변경' }],
    [/^\/remote\/deploy$/, { POST: 'HAProxy 배포' }],
    [/^\/tools\/ipam\/annotation$/, { PUT: 'IP 메모/태그 저장' }],
  ];
  for (const [re, map] of rules) if (re.test(p) && map[method]) return map[method];
  return `${method} ${p}`;
}

export function logAudit({ user = 'unknown', action, target = '', detail = '', ip = '' } = {}) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), user, action, target, detail, ip }) + '\n';
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, line, { mode: 0o600 });
    ensurePerms();
    maybeTrim();
  } catch { /* best effort */ }
}

// mode 옵션은 신규 생성 시에만 적용되므로, 프로세스당 1회 0600을 보장한다(append 핫패스 보호).
let permsEnsured = false;
function ensurePerms() {
  if (permsEnsured) return;
  permsEnsured = true;
  try { fs.chmodSync(FILE, 0o600); } catch { /* */ }
}

// 카운터는 프로세스 메모리라, 자동 업그레이드로 재시작이 잦은 환경에서 재시작 사이 500건 미만이면
// 트림이 영영 안 돌아 파일이 MAX를 넘어 계속 자란다 — 첫 append 시 1회는 무조건 트림을 시도한다.
let appendsSinceTrim = 499;
function maybeTrim() {
  if (++appendsSinceTrim < 500) return;
  appendsSinceTrim = 0;
  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX) { fs.writeFileSync(FILE, lines.slice(lines.length - MAX).join('\n') + '\n', { mode: 0o600 }); try { fs.chmodSync(FILE, 0o600); } catch { /* */ } }
  } catch { /* ignore */ }
}

/** Express middleware: auto-logs successful mutating requests on a router. */
export function auditMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  const urlPath = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    logAudit({
      user: req.user?.username || 'anonymous',
      action: describe(req.method, urlPath),
      target: urlPath,
      ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0],
    });
  });
  next();
}

/** Read audit entries (newest first) with optional filters. */
export function listAudit({ limit = 100, offset = 0, user = '', q = '' } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
  let items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  if (user) items = items.filter((e) => e.user === user);
  if (q) { const t = q.toLowerCase(); items = items.filter((e) => `${e.user} ${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(t)); }
  const total = items.length;
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return { total, items: items.slice(off, off + lim), users: [...new Set(items.map((e) => e.user))].sort() };
}
