/**
 * 법인별 Bareos 설정 · 중앙 계정 통합(v2.845) 화면 문구 · 판정(순수 — vitest 가 고정).
 * 리소스 미리 보기 본문은 서버 `bareos/manage/apply.js` 의 consoleText · sdDeviceText · dirStorageText 와 **글자까지 같다**
 * (`server/test/bareosManage2845.test.js` 가 같은 입력으로 대조 — 한쪽만 고치지 말 것). 비밀번호 자리는 화면이 자리 표시 글자를 넣는다.
 */
import { bytesText } from './bareosInstallText.js';

export const MARKER = '# managed-by: vmware-portal bareos auto-setup (rewritten on re-run)';
export const SECRET_SLOT = '…(이 요청에서만 전달 · 포탈 미보관)';
export const PW_MIN = 12;
const PW_RE = /^[\x21\x23-\x5b\x5d-\x7e]{12,128}$/;
export const RESERVED_CONSOLES = Object.freeze(['bareos-mon']);

export function consoleText({ name, password, profile }) {
  return [MARKER, 'Console {', `  Name = "${name}"`, `  Password = "${password}"`, `  Profile = "${profile}"`,
    '  # bareos-webui (php) cannot use TLS-PSK - same as the package example admin.conf.example', '  TLS Enable = No', '}', ''].join('\n');
}
export function sdDeviceText({ device, mediaType, archiveDevice, count, description }) {
  return [MARKER, 'Device {', `  Name = ${device}`, `  Media Type = ${mediaType}`, `  Archive Device = ${archiveDevice}`, '  Label Media = yes', '  Random Access = yes',
    '  Automatic Mount = yes', '  Removable Media = no', '  Always Open = no', `  Description = "${description || 'vmware-portal storage'}"`, `  Count = ${count}`, '}', ''].join('\n');
}
export function dirStorageText({ name, address, sdPassword, device, mediaType, count, description }) {
  return [MARKER, 'Storage {', `  Name = ${name}`, `  Address = ${address}`, `  Password = "${sdPassword}"`, `  Device = ${device}`, `  Media Type = ${mediaType}`,
    `  Maximum Concurrent Jobs = ${count}`, ...(description ? [`  Description = "${description}"`] : []), '}', ''].join('\n');
}

/** 서버 passwordIssue 와 같은 판정(시험이 대조). */
export function passwordIssue(pw) {
  if (typeof pw !== 'string' || !pw) return '비밀번호를 입력하거나 생성하세요.';
  if (pw.length < PW_MIN) return `비밀번호는 ${PW_MIN}자 이상이어야 합니다.`;
  if (!PW_RE.test(pw)) return '비밀번호에 큰따옴표 · 역슬래시 · 공백 · 제어문자는 쓸 수 없습니다(설정 파일 안에 그대로 들어갑니다).';
  return '';
}
/** 두 번 입력 확인까지. */
export function pwPairIssue(a, b) { return passwordIssue(a) || (a !== b ? '두 번 입력한 비밀번호가 다릅니다.' : ''); }

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const nameIssue = (n, what = '이름') => (NAME_RE.test(String(n || '').trim()) ? '' : `${what}은 영문 · 숫자 · ._- 64자 이하로 적습니다.`);

/** 서버 읽기(스캔)에서 그 리소스 파일의 주인: true 포탈 · false 사람 · null 모름(스캔 전 · 바꾼 뒤 오래된 스캔에 없는 이름). */
export function portalOf(scan, type, name) {
  if (!scan) return null;
  const f = (scan.files || []).find((x) => x.type === type && x.name === name);
  if (f) return f.portal;
  return scan.stale ? null : false;
}

/* ───────── 백업 스토리지 ───────── */
/**
 * 설정 조회(콘솔) + 서버 읽기(SSH 스캔 — 없으면 null)를 합친 행. 만든 곳 · 경로 · 여유는 스캔이 있어야 안다(없으면 null — '모름' · 0 이 아니다).
 * @returns {{ name, device, mediaType, mcj, description, address, path, portal, disk, files, mapped, delIssue }[]}
 */
export function storageRows(cfgStorages = [], scan = null, mapped = []) {
  return cfgStorages.map((s) => {
    const device = (s.device || [])[0] || '';
    const dev = scan ? (scan.devices || []).find((d) => d.name === device) || null : null;
    const path = dev?.archiveDevice || '';
    const disk = path && scan ? (scan.disks || []).find((x) => x.path === path) || null : null;
    const portal = portalOf(scan, 'storage', s.name);
    const isMapped = mapped.includes(s.name);
    let delIssue = '';
    if (portal === false) delIssue = '사람이 만든 설정 — 읽기만';
    else if (portal === null) delIssue = scan?.stale ? '서버 파일을 다시 읽은 뒤 판단' : '서버 파일을 읽은 뒤 판단(디스크 읽기)';
    else if (isMapped) delIssue = '포탈 매핑(백업 대상 등록)이 쓰는 스토리지';
    else if (cfgStorages.length <= 1) delIssue = '마지막 스토리지';
    else if (disk && disk.files > 0) delIssue = `볼륨 파일 ${disk.files}개`;
    return { name: s.name, device, mediaType: (s.mediaType || [])[0] || '', mcj: s.maxConcurrentJobs ?? null, description: s.description || '', address: s.address || '', path, portal, disk, files: disk?.files ?? null, mapped: isMapped, delIssue };
  });
}
export const portalText = (p) => (p === true ? '포탈' : p === false ? '사람이 만든 파일' : '모름');
export function diskText(disk) {
  if (!disk) return '—';
  if (disk.missing) return '경로 없음';
  if (disk.availBytes == null || disk.sizeBytes == null) return '—';
  return `${bytesText(disk.availBytes)} / ${bytesText(disk.sizeBytes)}`;
}
/** 경로 점검 결과 → 줄들(ok: true · false · null=확인 필요). */
export function pathCheckLines(pc, path) {
  if (!pc) return [];
  const out = [];
  out.push(pc.kind === 'dir' ? { ok: true, label: '경로', text: `있음(${path})${pc.files != null ? ` · 파일 ${pc.files}개` : ''}` }
    : pc.kind === 'none' ? { ok: null, label: '경로', text: `없음 — 추가할 때 만듭니다(bareos:bareos 0750 · 가장 가까운 상위 ${pc.parent || '?'})` }
      : pc.kind === 'link' ? { ok: false, label: '경로', text: '심링크입니다 — 실제 경로로 적으세요(포탈이 거부합니다).' }
        : pc.kind === 'other' ? { ok: false, label: '경로', text: '디렉터리가 아닌 파일이 있습니다.' } : { ok: null, label: '경로', text: '확인하지 못했습니다.' });
  if (!pc.canonical && pc.kind !== 'none') out.push({ ok: false, label: '정규 경로', text: '경로 중간에 심링크가 있습니다 — 실제 경로로 적으세요.' });
  out.push(pc.availBytes == null ? { ok: null, label: '디스크', text: '여유를 읽지 못했습니다(—).' }
    : { ok: true, label: '디스크', text: `${pc.fsType || '?'} · 마운트 ${pc.mount || '?'} · 여유 ${bytesText(pc.availBytes)} / ${bytesText(pc.sizeBytes)}` });
  const se = String(pc.selinux || '').toLowerCase();
  out.push(se === 'enforcing' ? { ok: null, label: 'SELinux', text: 'Enforcing — 추가할 때 패키지 기본 저장 경로와 같은 문맥(semanage fcontext -e)을 넣고 bareos 계정 쓰기 시험을 합니다.' }
    : { ok: true, label: 'SELinux', text: se ? `${pc.selinux}` : '없음' });
  out.push({ ok: null, label: '쓰기 시험', text: '추가할 때 bareos 계정으로 임시 파일 하나를 쓰고 지웁니다(실패하면 아무것도 바꾸지 않습니다).' });
  return out;
}

/* ───────── WebUI 계정 ───────── */
export function accountRows(consoles = [], scan = null, portalConsole = '') {
  return consoles.map((c) => {
    const low = String(c.name).toLowerCase();
    const reserved = RESERVED_CONSOLES.includes(low);
    const own = !!portalConsole && low === String(portalConsole).toLowerCase();
    const portal = reserved ? false : portalOf(scan, 'console', c.name);
    let lock = '';
    if (own) lock = '포탈이 Director 에 붙는 전용 콘솔 — 여기서 바꾸지 않습니다(Director 연결 · 자동 설정).';
    else if (reserved) lock = '패키지 콘솔(트레이 모니터용) — 바꾸지 않습니다.';
    else if (portal === false) lock = '사람이 만든 파일 — 읽기만(비밀번호 · 삭제는 서버에서 직접).';
    return { name: c.name, profile: (c.profile || []).join(', ') || (c.commandAcl?.length ? `(콘솔 ACL ${c.commandAcl.length}개)` : '—'), tls: c.tlsEnable, own, reserved, portal, lock };
  });
}
export const tlsText = (v) => (v === false ? '끔(WebUI 용)' : v === true ? '켬' : '기본');
export function profileOptions(profiles = []) {
  const known = { 'webui-admin': '관리자', 'webui-readonly': '읽기 전용', 'webui-limited': '제한', operator: '운영자' };
  return profiles.filter((p) => p.name !== 'portal').map((p) => ({ value: p.name, label: known[p.name] ? `${p.name} — ${known[p.name]}` : p.name }));
}
export const DEFAULT_PROFILE = 'webui-readonly';

/* ───────── 풀 · 스케줄 ───────── */
export const PORTAL_POOLS = Object.freeze(['PortalVmwareFull', 'PortalVmwareIncr']);
export const PORTAL_SCHEDULE = 'PortalVmwareNightly';
const DAY = 86400;
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** 지금 Director 의 포탈 풀 · 스케줄 → 편집 칸 초기값(못 읽은 칸은 '' — 지어내지 않는다). */
export function poolFormOf(pools = [], schedules = []) {
  const f = pools.find((p) => p.name === 'PortalVmwareFull');
  const i = pools.find((p) => p.name === 'PortalVmwareIncr');
  const days = (p) => (p && Number.isFinite(p.volRetentionSec) && p.volRetentionSec > 0 ? String(Math.round(p.volRetentionSec / DAY)) : '');
  const gb = (p) => (p && Number.isFinite(p.maxVolBytes) && p.maxVolBytes > 0 ? String(Math.round(p.maxVolBytes / 1024 ** 3)) : '');
  const sch = schedules.find((s) => s.name === PORTAL_SCHEDULE);
  const full = sch?.run?.find((r) => r.level === 'Full');
  const m = /^Full\s+([A-Za-z]{3})[a-z]*\s+at\s+(\d{1,2}):(\d{2})/i.exec(full?.text || '');
  const fullDay = m ? WD.find((d) => d === m[1].toLowerCase().slice(0, 3)) || '' : '';
  const time = m ? `${m[2].padStart(2, '0')}:${m[3]}` : '';
  return { fullDays: days(f), incrDays: days(i), maxVolumeGB: gb(f) || gb(i), fullDay, time, hasPools: !!(f && i), hasSchedule: !!sch };
}
export function retentionText(sec) { return Number.isFinite(sec) && sec > 0 ? `${Math.round(sec / DAY)}일` : '—'; }

/* ───────── 중앙 계정 통합 ───────── */
/** 매트릭스 칸: profile 문자열 · 'none'(그 법인에 없음) · 'unknown'(그 법인 조회 실패) · 'locked'(포탈 전용 · 패키지 콘솔). */
export function matrixCell(dir, name) {
  if (!dir.ok) return { kind: 'unknown', text: '○ 확인 불가' };
  const c = (dir.consoles || []).find((x) => x.name === name);
  if (!c) return { kind: 'none', text: '— 없음' };
  if (c.reserved || c.portalConsole) return { kind: 'locked', text: '잠김' };
  return { kind: 'has', text: (c.profile || []).join(', ') || '(ACL)' };
}
export function matrixTotals(dirs, name) {
  let has = 0; let unknown = 0;
  for (const d of dirs) { const k = matrixCell(d, name).kind; if (k === 'has' || k === 'locked') has += 1; else if (k === 'unknown') unknown += 1; }
  return { has, unknown, total: dirs.length, text: `${has} / ${dirs.length}${unknown ? ` · 확인 불가 ${unknown}` : ''}` };
}
export const BULK_LABEL = Object.freeze({ 'console.add': '일괄 추가', 'console.password': '일괄 비밀번호 변경', 'console.delete': '일괄 삭제' });
/** 그 작업에 맞는 법인(추가 = 없는 법인 · 변경/삭제 = 있는 법인). 조회 실패 법인은 고를 수 있다(서버가 다시 판정한다). */
export function bulkEligible(dirs, action, name) {
  const n = String(name || '').trim();
  return dirs.map((d) => {
    const c = matrixCell(d, n);
    if (!n) return { id: d.id, ok: false, why: '계정 이름을 먼저 적으세요' };
    if (c.kind === 'locked') return { id: d.id, ok: false, why: '포탈 전용 · 패키지 콘솔' };
    if (action === 'console.add' && c.kind === 'has') return { id: d.id, ok: false, why: '이미 있음' };
    if (action !== 'console.add' && c.kind === 'none') return { id: d.id, ok: false, why: '없음' };
    return { id: d.id, ok: true, why: c.kind === 'unknown' ? '조회 실패 — 실행 때 서버가 판정' : '' };
  });
}
export const RESULT_TEXT = Object.freeze({ done: '✓ 성공', failed: '✗ 실패', skipped: '○ 보내지 않음', unknown: '? 결과 모름' });
export const RESULT_CLS = Object.freeze({ done: 'green', failed: 'red', skipped: 'gray', unknown: 'amber' });
export function bulkCounts(results = []) {
  const c = { done: 0, failed: 0, skipped: 0, unknown: 0 };
  for (const r of results) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}
export function bulkSummaryText(results = []) {
  const c = bulkCounts(results);
  const parts = [`성공 ${c.done}`, `실패 ${c.failed}`, `보내지 않음 ${c.skipped}`, ...(c.unknown ? [`결과 모름 ${c.unknown}`] : [])];
  const partial = c.done && (c.failed || c.skipped || c.unknown);
  return `${partial ? '**부분 성공** — ' : ''}${parts.join(' · ')}`;
}
/** 생성 비밀번호 CSV(법인 · 계정 · 비밀번호) — 화면이 한 번만 내려받게 한다. 쉼표 · 따옴표는 따옴표로 감싼다. */
export function passwordCsv(results = [], account = '') {
  const q = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = results.filter((r) => r.generatedPassword).map((r) => [r.name, account, r.generatedPassword].map(q).join(','));
  return rows.length ? `corp,account,password\n${rows.join('\n')}\n` : '';
}
export const maskPw = (pw) => (pw && pw.length > 8 ? `${pw.slice(0, 4)}${'•'.repeat(Math.max(4, pw.length - 8))}${pw.slice(-4)}` : '••••');
/** SSH 칸이 필요 없는 출처(배포 등록부 · 데모). */
export const noSshNeeded = (ssh) => ssh?.source === 'registry' || ssh?.source === 'demo';
export const sshSourceText = (ssh) => (ssh?.source === 'registry' ? `SSH: 배포 등록부(${ssh.username || 'root'}@${ssh.host || '가림'})` : ssh?.source === 'demo' ? 'SSH: 데모(접속 안 함)' : 'SSH: 실행할 때마다 비밀번호 입력(저장하지 않음)');
