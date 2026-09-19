/**
 * Audit log — records security/operational actions (who did what, when) so the
 * portal's write operations (VM 생성, 원격접속, 설정 변경 등)이 추적된다. Appended
 * to CONFIG_DIR/audit.ndjson (one JSON per line), capped to the most recent
 * AUDIT_MAX lines. Read-only viewing via the admin API.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync } from './util/atomicWrite.js';
import { clientIp } from './util/rateLimit.js'; // v2.479(감사 코어 B-4): XFF 는 TRUST_PROXY 일 때만

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
    [/^\/alarm-mutes$/, { POST: '알람 음소거 규칙 추가' }],
    [/^\/alarm-mutes\/.+$/, { DELETE: '알람 음소거 규칙 삭제' }],
    [/^\/vms\/upgrade-tools$/, { POST: 'VMware Tools 업그레이드(게스트 재부팅 가능)' }],
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
    [/^\/upgrade\/apply$/, { POST: '업그레이드 적용' }],
    [/^\/upgrade\/restart$/, { POST: '서비스 재시작' }],
    [/^\/upgrade\/settings$/, { PUT: '자동 업그레이드 설정 변경' }],
    [/^\/upgrade\/bundle$/, { POST: '업그레이드 번들 업로드' }],
    [/^\/upgrade\/check$/, { POST: '업그레이드 확인' }],
    [/^\/ping\/targets/, { POST: 'Ping 대상 추가', PUT: 'Ping 대상 수정', DELETE: 'Ping 대상 삭제' }],
    [/^\/ping\/seed-vcenters$/, { POST: 'Ping 대상 vCenter 시드' }],
    [/^\/ping\/vcport\/ports$/, { PUT: 'vCenter 포트 점검 설정 변경' }],
  ];
  for (const [re, map] of rules) if (re.test(p) && map[method]) return map[method];
  return `${method} ${p}`;
}

/**
 * 감사 필드는 **무조건 문자열**이다(v2.569).
 *
 * ⚠⚠ 왜 강제하는가 — 실제 사고: 라우트 11곳이 `logAudit(req, '액션', {...})` 로 불러
 * **express `req` 를 옵션 객체 자리에** 넘겼다. 이 함수는 첫 인자를 구조분해하므로
 * `user = req.user` 가 되어 `{username, role, name, scope, mustEnrollOtp}` **객체가 그대로**
 * 파일에 저장됐고, 감사 로그 화면이 그것을 React 자식으로 렌더하다
 * **Minified React error #31 로 설정 탭 전체가 죽었다**(사용자 신고, v2.568 실화면).
 * 같은 호출이 `action` 도 잃어(= `req.action` 이 undefined) 기록이 무의미해졌다.
 *
 * 그래서 방어선을 두 개 둔다 — 여기(쓰기)와 `listAudit`(읽기). 쓰기만 고치면 **이미 저장된
 * 줄**이 계속 화면을 죽이고, 읽기만 고치면 새 줄이 계속 오염된다. 둘 다 유지할 것.
 */
function auditStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 객체가 왔다 — 잘못된 호출이다. 값을 **지어내지 않고** 아는 이름만 되살린다.
  if (typeof v === 'object') {
    const name = typeof v.username === 'string' ? v.username : '';
    return name || '(형식 오류)';
  }
  return String(v);
}

export function logAudit(opts = {}, ...rest) {
  // ⚠ `logAudit(req, '액션', {...})` 오용 감지 — 조용히 넘기면 위 사고가 반복된다.
  //   express req 는 `method`·`headers` 를 갖는다(감사 옵션 객체에는 없다).
  if (opts && typeof opts === 'object' && opts.headers && opts.method && rest.length) {
    console.warn(`[audit] logAudit(req, …) 오용 — 옵션 객체로 호출할 것 (action=${String(rest[0]).slice(0, 60)})`);
    const [action, extra] = rest;
    opts = {
      user: opts.user?.username || 'unknown', action,
      detail: extra && typeof extra === 'object' ? JSON.stringify(extra).slice(0, 300) : String(extra ?? ''),
      ip: opts.ip || '',
    };
  }
  const { user = 'unknown', action, target = '', detail = '', ip = '' } = opts || {};
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      user: auditStr(user) || 'unknown',
      action: auditStr(action),
      target: auditStr(target),
      detail: auditStr(detail),
      ip: auditStr(ip),
    }) + '\n';
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
    // 감사 로그 트림도 원자적으로 — 대량 재작성 중 크래시/정전 시 보안 감사 기록이 통째로
    // 잘리거나 비는 것을 방지(atomicWrite: 온전한 이전본 또는 새본만 남음).
    if (lines.length > MAX) atomicWriteFileSync(FILE, lines.slice(lines.length - MAX).join('\n') + '\n', { mode: 0o600 });
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
      ip: clientIp(req), // 프록시 없는 배포에서 임의 클라이언트가 헤더로 감사 IP 를 위조하던 경로 차단
    });
  });
  next();
}

/** Read audit entries (newest first) with optional filters. */
export function listAudit({ limit = 100, offset = 0, user = '', q = '' } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
  // ⚠ 읽기 소독 — 이미 저장된 오염 줄(위 주석의 사고)이 화면을 죽이지 않게 한다.
  //   과거 줄은 고칠 수 없으므로 **여기서 문자열로 되돌린다**(값은 지어내지 않는다).
  const clean = (e) => ({
    ...e,
    user: auditStr(e.user) || 'unknown',
    action: auditStr(e.action),
    target: auditStr(e.target),
    detail: auditStr(e.detail),
    ip: auditStr(e.ip),
  });
  let items = lines.map((l) => { try { return clean(JSON.parse(l)); } catch { return null; } }).filter(Boolean).reverse();
  if (user) items = items.filter((e) => e.user === user);
  if (q) { const t = q.toLowerCase(); items = items.filter((e) => `${e.user} ${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(t)); }
  const total = items.length;
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return { total, items: items.slice(off, off + lim), users: [...new Set(items.map((e) => e.user))].sort() };
}
