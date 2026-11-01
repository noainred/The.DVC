/**
 * bareos/manage/apply.js — 법인별 Bareos 설정 쓰기(v2.845): 백업 스토리지 추가·편집·삭제 · WebUI 계정 추가·비밀번호·삭제 · 포탈 풀·스케줄 편집 · 디스크 읽기.
 *
 * 규칙(autoSetup 과 같은 원격 파일 규칙 — `autoSetup._remote` 를 그대로 쓴다 · 복제하지 않는다):
 *  - root SSH 만 · **포탈 표지(MARKER) 파일만** 바꾸거나 지운다(남의 파일·심링크면 아무것도 쓰기 전에 멈춤) · 비밀(SSH · 계정 · SD 비밀번호)은 명령 인자에 싣지 않는다
 *    (SFTP 0600 임시 파일 → install) · 출력은 비밀을 가린다 · 검사(bareos-dir -t / bareos-sd -t) · reload / SD 재시작 — 실패하면 넣은 파일을 되돌리고 다시 검사·reload.
 *  - SD 재시작은 **실행 중 작업이 0 일 때만**(bconsole 로 확인 — 확인하지 못하면 멈춘다: 백업을 끊지 않는다).
 *  - WebUI 계정: Profile 은 Director 에 있는 것만 · 포탈 전용 콘솔 · 패키지 콘솔(bareos-mon)은 바꾸지 않는다 ·
 *    **TLS Enable = No** — bareos-webui(php)는 TLS-PSK 를 쓰지 못한다(패키지 admin.conf.example 와 같다 · 번들 RPM 실측 2026-11-01).
 *  - 스토리지: 경로는 시스템 경로·얕은 경로·'..' 거부(install/plan volumeDirIssue 하나) · 없으면 bareos 0750 으로 만들고 SELinux 문맥(패키지 기본 저장 경로와 같게) · bareos 계정 쓰기 시험 ·
 *    장치 수(Count)와 Director 스토리지 Maximum Concurrent Jobs 를 같게(패키지 기본 FileStorage 와 같은 모양) · 삭제는 볼륨 파일 0 · 쓰는 풀·잡·JobDefs 0 일 때만(디렉터리는 비었을 때만 지운다).
 * ctx = { ssh, signal?, consoleName?(포탈 전용 콘솔 이름), mask? } — 엣지 대행(edgeSetup 'setup.manage')과 중앙 직접이 같은 함수를 부른다.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { _remote as R, MARKER, DIR_CONF_ROOT, BUDGET, normSsh, maskSecrets, directorResources, VMWARE_POOL_FULL, VMWARE_POOL_INCR, VMWARE_SCHEDULE, normVmwareExtras } from '../autoSetup.js';
import { remoteTmpDir } from '../../agent/deploy.js';
import { isResourceName } from '../names.js';
import { volumeDirIssue } from '../install/plan.js';
import { numOrNull } from '../../util/numOrNull.js';

export const SD_CONF_ROOT = '/etc/bareos/bareos-sd.d';
export const RESERVED_CONSOLES = Object.freeze(['bareos-mon']);
export const PORTAL_POOLS = Object.freeze([VMWARE_POOL_FULL, VMWARE_POOL_INCR]);
export const PW_MIN = 12;
const PW_RE = /^[\x21\x23-\x5b\x5d-\x7e]{12,128}$/;   // 출력 가능한 ASCII — 따옴표(")·역슬래시·공백·제어문자 없음(설정 파일 따옴표 안에 그대로 들어간다)
const DESC_RE = /^[^"\\\r\n\x00-\x1f]{0,120}$/;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
/**
 * v2.845 반증 F2: 다른 프로그램의 데이터 경로는 볼륨 경로로 받지 않는다(install/plan volumeDirIssue 는 시스템 경로만 막는다 —
 * 그 아래에 스토리지를 만들면 SELinux 문맥을 바꿔 PostgreSQL · 로그 데몬이 다음 재시작부터 막힐 수 있다). 비어 있지 않은 디렉터리는 원격에서 다시 거부한다.
 */
export const DATA_DIRS = Object.freeze(['/var/lib/bareos', '/var/log', '/var/lib/pgsql', '/var/lib/postgresql', '/var/lib/mysql', '/var/lib/mariadb', '/var/spool', '/var/www', '/var/cache',
  '/var/lib/rpm', '/var/lib/dnf', '/var/lib/selinux', '/var/lib/systemd', '/var/lib/containers', '/var/lib/docker']);
export function dataDirIssue(p) {
  const s = String(p || '');
  for (const d of DATA_DIRS) {
    if (s === d) return `${d} 는 다른 프로그램(또는 Bareos 자신)의 데이터 경로라 볼륨 경로로 쓰지 않습니다.`;
    if (s.startsWith(`${d}/`) && d !== '/var/lib/bareos') return `${d} 아래는 다른 프로그램의 데이터 경로라 볼륨 경로로 쓰지 않습니다.`;
  }
  return '';
}
const reEsc = (x) => String(x).replace(/[.]/g, '\\.');   // grep -E 에 넣는 이름 · 경로(정규식을 지난 [A-Za-z0-9._/-] 만) — 점만 문자 그대로
const ARCHIVE_RE = /^\s*Archive\s+Device\s*=\s*"?([^"\n#]+?)"?\s*(?:#.*)?$/mi;

/** 생성 비밀번호 — base64url 24자(따옴표·역슬래시 없음). */
export const newAccountPassword = () => crypto.randomBytes(18).toString('base64url');
export function passwordIssue(pw) {
  if (typeof pw !== 'string' || !pw) return '비밀번호를 입력하거나 생성하세요.';
  if (pw.length < PW_MIN) return `비밀번호는 ${PW_MIN}자 이상이어야 합니다.`;
  if (!PW_RE.test(pw)) return '비밀번호에 큰따옴표 · 역슬래시 · 공백 · 제어문자는 쓸 수 없습니다(설정 파일 안에 그대로 들어갑니다).';
  return '';
}

/* ───────── 본문(순수 — 시험이 고정) ───────── */
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

/* ───────── 입력 판정(순수 — 라우트가 OTP 전에 부른다 · 엣지는 다시 부른다) ───────── */
/**
 * @param {string} action 'storage.add'|'storage.edit'|'storage.delete'|'console.add'|'console.password'|'console.delete'|'pools.edit'|'scan'
 * @param {object} a 화면 입력(비밀 없음 — 계정 비밀번호는 secret 으로 따로)
 * @param {{ config?: { storages, consoles, profiles }, portalConsole?: string, address?: string }} known 그 Director 의 지금 설정(조회 결과 — 중앙이 준다)
 */
export function planManage(action, a = {}, known = {}) {
  const cfg = known.config || {};
  const storages = Array.isArray(cfg.storages) ? cfg.storages : [];
  const consoles = Array.isArray(cfg.consoles) ? cfg.consoles : [];
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  const name = String(a.name ?? '').trim();
  switch (action) {
    case 'scan': {
      // 선택: 추가하려는 볼륨 경로 점검(읽기만 — 있는지 · 심링크 · 상위 마운트 · 여유 · SELinux). 값은 volumeDirIssue 를 지난 것만 명령에 넣는다.
      const p = String(a.path ?? '').trim();
      if (!p) return { action };
      const vi = volumeDirIssue(p);
      if (vi) throw fail('invalid', vi);
      return { action, path: p };
    }
    case 'storage.add': {
      if (!isResourceName(name)) throw fail('invalid', '스토리지 이름은 영문 · 숫자 · ._- 64자 이하로 적습니다.');
      if (storages.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw fail('invalid', `‘${name}’ 스토리지가 이미 있습니다.`);
      const device = String(a.device ?? '').trim() || `${name}Storage`;
      if (!isResourceName(device)) throw fail('invalid', 'SD 장치 이름은 영문 · 숫자 · ._- 로 적습니다.');
      const mediaType = String(a.mediaType ?? '').trim() || name;
      if (!isResourceName(mediaType)) throw fail('invalid', 'Media Type 은 영문 · 숫자 · ._- 로 적습니다.');
      if (storages.some((s) => (s.mediaType || []).some((m) => m.toLowerCase() === mediaType.toLowerCase()))) throw fail('invalid', `Media Type ‘${mediaType}’ 를 다른 스토리지가 씁니다 — 스토리지마다 다르게 적습니다(같으면 볼륨이 엉뚱한 장치로 갑니다).`);
      const archiveDevice = String(a.path ?? '').trim();
      const vi = volumeDirIssue(archiveDevice) || dataDirIssue(archiveDevice);
      if (vi) throw fail('invalid', vi);
      const count = numOrNull(a.count ?? 10);
      if (!Number.isInteger(count) || count < 1 || count > 50) throw fail('invalid', '동시 작업 수(장치 수)는 1~50 으로 적습니다.');
      const description = String(a.description ?? '').trim();
      if (!DESC_RE.test(description)) throw fail('invalid', '설명에 큰따옴표 · 역슬래시 · 줄바꿈은 쓸 수 없습니다(120자 이하).');
      const address = String(known.address || '').trim();
      if (!R.HOST_RE.test(address)) throw fail('invalid', '이 Director 의 SD 주소를 알 수 없습니다(기존 스토리지 주소를 읽지 못함).');
      return { action, name, device, mediaType, archiveDevice, count, description, address };
    }
    case 'storage.edit': {
      if (!isResourceName(name)) throw fail('invalid', '스토리지를 고르세요.');
      const count = numOrNull(a.count);
      if (!Number.isInteger(count) || count < 1 || count > 50) throw fail('invalid', '동시 작업 수(장치 수)는 1~50 으로 적습니다.');
      const description = String(a.description ?? '').trim();
      if (!DESC_RE.test(description)) throw fail('invalid', '설명에 큰따옴표 · 역슬래시 · 줄바꿈은 쓸 수 없습니다(120자 이하).');
      return { action, name, count, description };
    }
    case 'storage.delete': {
      if (!isResourceName(name)) throw fail('invalid', '스토리지를 고르세요.');
      if (known.mappedStorages && known.mappedStorages.includes(name)) throw fail('conflict', `‘${name}’ 은 포탈 매핑(백업 대상 등록에 쓰는 스토리지)에 들어 있습니다 — 매핑을 먼저 바꾸세요.`);
      if (storages.length && storages.length <= 1) throw fail('conflict', '마지막 스토리지는 지우지 않습니다.');
      return { action, name };
    }
    case 'console.add':
    case 'console.password':
    case 'console.delete': {
      if (!isResourceName(name)) throw fail('invalid', '계정 이름은 영문 · 숫자 · ._- 64자 이하로 적습니다.');
      const low = name.toLowerCase();
      if (RESERVED_CONSOLES.includes(low)) throw fail('invalid', `‘${name}’ 은 패키지 콘솔(트레이 모니터용)이라 바꾸지 않습니다.`);
      if (known.portalConsole && low === String(known.portalConsole).toLowerCase()) throw fail('invalid', `‘${name}’ 은 포탈이 Director 에 붙는 전용 콘솔이라 여기서 바꾸지 않습니다.`);
      const exists = consoles.some((c) => c.name.toLowerCase() === low);
      if (action === 'console.add') {
        if (exists) throw fail('invalid', `‘${name}’ 계정이 이미 있습니다 — 비밀번호를 바꾸려면 ‘비밀번호 변경’ 을 쓰세요.`);
        const profile = String(a.profile ?? '').trim();
        if (!isResourceName(profile)) throw fail('invalid', '권한(Profile)을 고르세요.');
        if (profiles.length && !profiles.some((p) => p.name === profile)) throw fail('invalid', `Director 에 ‘${profile}’ Profile 이 없습니다.`);
        return { action, name, profile };
      }
      if (!exists && consoles.length) throw fail('invalid', `‘${name}’ 계정이 Director 에 없습니다.`);
      return { action, name };
    }
    case 'pools.edit': {
      const ex = normVmwareExtras({ pools: a.pools, schedule: a.schedule });
      if (ex.issue) throw fail('invalid', ex.issue);
      if (!ex.pools && !ex.schedule) throw fail('invalid', '바꿀 풀 · 스케줄 값을 적으세요.');
      return { action, pools: ex.pools, schedule: ex.schedule };
    }
    default: throw fail('invalid', `알 수 없는 작업(${action})`);
  }
}

/* ───────── 원격 ───────── */
const RUNNING_CMD = "o=$(printf 'llist jobs jobstatus=R\\n' | timeout 30 bconsole 2>&1); rc=$?; if [ $rc -eq 0 ] && printf '%s\\n' \"$o\" | grep -q 'Connecting to Director' && ! printf '%s\\n' \"$o\" | grep -qiE 'Authorization failed|Failed to connect|ERR='; then echo \"RUN=$(printf '%s\\n' \"$o\" | grep -cE '^[[:space:]]*jobid:[[:space:]]*[0-9]+')\"; else echo RUN=unknown; fi";
/** v2.845 반증 F4: 재시작 직전 **같은 셸**에서 실행 중 작업을 다시 세고 0 일 때만 재시작한다(쓰기 전 확인과 재시작 사이 검사 · SELinux 가 수 분 걸릴 수 있다). */
const SD_RESTART_CMD = `r=$(${RUNNING_CMD}); echo "$r"; case "$r" in RUN=0) o2=$(systemctl restart bareos-sd 2>&1); echo "RESTART=$?"; printf '%s\\n' "$o2";; esac`;
const SD_PW_CMD = `sed -n 's/^[[:space:]]*Password[[:space:]]*=[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${SD_CONF_ROOT}/director/bareos-dir.conf 2>/dev/null | head -n 1`;
const TEST = {
  dir: "if command -v runuser >/dev/null 2>&1; then runuser -u bareos -- bareos-dir -t 2>&1; else bareos-dir -t 2>&1; fi",
  sd: "if command -v runuser >/dev/null 2>&1; then runuser -u bareos -- bareos-sd -t 2>&1; else bareos-sd -t 2>&1; fi",
};
const tail = (t, n = 600) => String(t ?? '').slice(-n);

/** 디스크 · 볼륨 · 표지 읽기(쓰기 없음) — 출력 섹션. 경로는 정규식을 지난 것만 명령에 넣는다. */
export function scanScript(checkPath = '') {
  const p = checkPath && !volumeDirIssue(checkPath) ? checkPath : '';
  return [
    'export LC_ALL=C',
    `echo @@sd; for f in ${SD_CONF_ROOT}/device/*.conf; do [ -f "$f" ] || continue; m=$(head -n 1 "$f" | grep -c 'managed-by: vmware-portal'); n=$(sed -n 's/^[[:space:]]*Name[[:space:]]*=[[:space:]]*"\\{0,1\\}\\([A-Za-z0-9._-]*\\).*/\\1/Ip' "$f" | head -n 1); a=$(sed -n 's/^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*"\\{0,1\\}\\([^"]*\\)"\\{0,1\\}[[:space:]]*$/\\1/Ip' "$f" | head -n 1); c=$(sed -n 's/^[[:space:]]*Count[[:space:]]*=[[:space:]]*\\([0-9]*\\).*/\\1/Ip' "$f" | head -n 1); echo "$(basename "$f")|$m|$n|$a|$c"; done`,
    `echo @@files; for d in console storage pool schedule; do for f in ${DIR_CONF_ROOT}/$d/*.conf; do [ -f "$f" ] || continue; echo "$d|$(basename "$f" .conf)|$(head -n 1 "$f" | grep -c 'managed-by: vmware-portal')"; done; done`,
    'echo @@disk',
    `for f in ${SD_CONF_ROOT}/device/*.conf; do sed -n 's/^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*"\\{0,1\\}\\([^"]*\\)"\\{0,1\\}[[:space:]]*$/\\1/Ip' "$f" 2>/dev/null; done | sort -u | while read -r d; do case "$d" in (/*) ;; (*) continue;; esac; if [ -d "$d" ]; then n=$(find "$d" -maxdepth 1 -type f 2>/dev/null | wc -l); u=$(du -sk "$d" 2>/dev/null | cut -f1); df -Pk "$d" 2>/dev/null | awk -v d="$d" -v n="$n" -v u="$u" 'NR==2{print d"|"n"|"u"|"$4"|"$2"|"$6}'; else echo "$d|missing"; fi; done`,
    ...(p ? [
      'echo @@path',
      `if [ -L ${p} ]; then echo KIND=LINK; elif [ -d ${p} ]; then echo KIND=DIR; elif [ -e ${p} ]; then echo KIND=OTHER; else echo KIND=NONE; fi; [ "$(realpath -m -- ${p})" = "${p}" ] && echo CANON=1`,
      `q=${p}; while [ ! -e "$q" ] && [ "$q" != / ]; do q=$(dirname "$q"); done; echo "PARENT=$q"; df -Pk "$q" 2>/dev/null | awk 'NR==2{print "DF="$4"|"$2"|"$6}'; t=$(findmnt -n -o FSTYPE --target "$q" 2>/dev/null | head -n 1); echo "FS=$t"`,
      `if [ -d ${p} ]; then echo "FILES=$(find ${p} -maxdepth 1 -type f 2>/dev/null | wc -l)"; fi; if command -v getenforce >/dev/null 2>&1; then echo "SE=$(getenforce 2>/dev/null)"; else echo SE=none; fi`,
    ] : []),
    'echo @@end',
  ].join('\n');
}
export function parseScan(text) {
  const sec = {}; let cur = null;
  for (const l of String(text || '').split('\n')) { const m = /^@@([a-z]+)$/.exec(l.trim()); if (m) { cur = m[1]; sec[cur] = []; continue; } if (cur && l.trim()) sec[cur].push(l.trim()); }
  const devices = (sec.sd || []).slice(0, 200).map((l) => { const [file, m, name, archive, count] = l.split('|'); return { file, portal: m === '1', name: name || '', archiveDevice: archive || '', count: numOrNull(count) }; });
  const files = (sec.files || []).slice(0, 2000).map((l) => { const [type, name, m] = l.split('|'); return { type, name, portal: m === '1' }; });
  const disks = (sec.disk || []).slice(0, 200).map((l) => {
    const [p, n, u, av, sz, mnt] = l.split('|');
    if (n === 'missing') return { path: p, missing: true };
    const kb = (x) => { const v = numOrNull(x); return v === null ? null : v * 1024; };
    return { path: p, files: numOrNull(n), usedBytes: kb(u), availBytes: kb(av), sizeBytes: kb(sz), mount: mnt || '' };
  });
  let pathCheck = null;
  if (sec.path) {
    const kv = Object.fromEntries(sec.path.map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, '']; }));
    const [av, sz, mnt] = String(kv.DF || '').split('|');
    const kb = (x) => { const v = numOrNull(x); return v === null ? null : v * 1024; };
    pathCheck = {
      kind: ['DIR', 'NONE', 'LINK', 'OTHER'].includes(kv.KIND) ? kv.KIND.toLowerCase() : 'unknown', canonical: kv.CANON === '1',
      parent: kv.PARENT || '', availBytes: kb(av), sizeBytes: kb(sz), mount: mnt || '', fsType: kv.FS || '', files: numOrNull(kv.FILES), selinux: kv.SE || '',
    };
  }
  return { complete: Object.prototype.hasOwnProperty.call(sec, 'end'), devices, files, disks, ...(pathCheck ? { pathCheck } : {}) };
}

/**
 * 실행. plan = planManage 결과 · b = { host, sshPort, username, password }(SSH) · secret = { accountPassword? } · ctx = { signal?, portalConsole? }
 * @returns {Promise<object>} 작업별 결과(비밀 없음 — 생성 비밀번호는 부른 쪽이 따로 화면에 한 번만)
 */
export async function applyManage(plan, b = {}, secret = {}, ctx = {}) {
  const { ssh, issue } = normSsh(b);
  if (issue) throw fail('invalid', issue);
  const ri = await R.resolvedHostIssue(ssh.host);
  if (ri) throw fail('invalid', ri);
  const secrets = [ssh.password, secret.accountPassword].filter(Boolean);
  const mask = (t) => maskSecrets(String(t ?? '').split('\n').map((l) => (secrets.some((s) => s.length >= 4 && l.includes(s)) ? '(비밀과 같은 글자가 있어 이 줄을 싣지 않습니다)' : l)).join('\n'), secrets)
    .replace(/(password\s*=\s*)("[^"]*"|\S+)/gi, '$1(가림)');
  if (plan.action === 'scan') {
    const r = await R.runSsh(ssh, async (api) => { await R.requireRoot(api.exec); return { text: String((await api.exec(scanScript(plan.path || ''), 90_000))?.stdout || '') }; }, ctx.signal);
    return parseScan(r.text);
  }
  const placed = []; const madeDirs = []; let settled = false; let restarted = false; let reloaded = false;
  try {
    const out = await R.runSsh(ssh, async (api) => {
      await R.requireRoot(api.exec);
      const env = String((await api.exec(`test -d ${DIR_CONF_ROOT} && echo D; test -d ${SD_CONF_ROOT} && echo S; test -e /etc/bareos/bareos-dir.conf && echo X; command -v bconsole >/dev/null 2>&1 && echo C; id -u bareos >/dev/null 2>&1 && echo U`))?.stdout || '').split(/\s+/);
      if (env.includes('X')) throw fail('invalid', '이 Director 는 단일 설정 파일(/etc/bareos/bareos-dir.conf)을 씁니다 — 포탈이 리소스 파일을 넣지 않습니다.');
      if (!env.includes('D') || !env.includes('U') || !env.includes('C')) throw fail('invalid', '이 서버에 Bareos Director(bareos-dir.d · bareos 계정 · bconsole)가 없습니다.');
      const needsSd = plan.action.startsWith('storage.');
      if (needsSd && !env.includes('S')) throw fail('invalid', '이 서버에 Bareos SD(bareos-sd.d)가 없습니다 — 스토리지는 SD 가 있는 서버(법인 · vCenter · Bareos 1:1:1 의 한 서버)에서만 바꿉니다.');
      // 1) 쓸 파일 목록 — 전부 살펴본 뒤(남의 파일 · 심링크면 아무것도 쓰지 않는다)
      const files = await buildFiles(api, plan, secret);
      for (const f of files) {
        const st = await R.pathState(api, f.path);
        if (st.state === 'notfile') throw fail('conflict', `${f.path} 가 일반 파일이 아닙니다(심링크 · 디렉터리) — 아무것도 바꾸지 않았습니다.`);
        if (st.state === 'foreign') throw fail('conflict', `${f.path} 는 포탈이 만든 파일이 아닙니다 — 사람이 만든 설정은 바꾸지 않습니다(아무것도 바꾸지 않았습니다).`, { paths: [f.path] });
        if (f.content == null && st.state === 'none') throw fail('conflict', `${f.path} 가 없습니다 — 포탈이 만든 리소스가 아닙니다(지우지 않았습니다).`);
        if (f.mustBeNew && st.state !== 'none') throw fail('conflict', `${f.path} 가 이미 있습니다 — 아무것도 바꾸지 않았습니다.`);
        if (f.mustExist && st.state !== 'managed') throw fail('conflict', `${f.path} 가 없거나 포탈 파일이 아닙니다 — 아무것도 바꾸지 않았습니다.`);
        f.old = st.old ?? null;
      }
      if (plan.action === 'storage.edit') fillEdit(plan, files);
      // 2) 스토리지 삭제 전제 — 볼륨 파일 0 · 참조 0
      if (plan.action === 'storage.delete') await deletePrecheck(api, plan, files);
      // 3) SD 를 다시 띄우는 작업은 실행 중 작업이 0 일 때만(확인 못 하면 멈춘다) — 쓰기 전에 한 번 · 재시작 직전 같은 셸에서 한 번 더(F4)
      const runText = (run) => (run === 'unknown' || !run ? '실행 중인 작업이 있는지 확인하지 못했습니다' : `실행 중인 작업이 ${run}개 있습니다`);
      if (needsSd) {
        const run = /RUN=(\S+)/.exec(String((await api.exec(RUNNING_CMD, 45_000))?.stdout || ''))?.[1];
        if (run !== '0') throw fail('conflict', `Director 에 ${runText(run)} — SD 를 다시 띄우면 백업이 끊기므로 멈췄습니다(아무것도 바꾸지 않았습니다).`);
      }
      // 4) 경로 준비 · 놓기 · 검사 · 적용 — 어디서 실패해도 이번에 만든 디렉터리 · SELinux 규칙까지 되돌린다(F5)
      const made = { dirs: madeDirs, seRule: '' };
      let tmp = '';
      try {
        if (plan.action === 'storage.add') await prepareDir(api, plan, made, mask);
        tmp = await remoteTmpDir(api.exec, R.TMP_PREFIX);
        for (const [i, f] of files.entries()) {
          if (f.content == null) {
            placed.push({ path: f.path, old: f.old, mode: f.mode || '0640' });
            const r = await api.exec(`${R.canonDir(f.path)} && rm -f ${f.path}`);
            if (r?.code !== 0) throw fail('remote', `${f.path} 를 지우지 못했습니다.`);
            continue;
          }
          if (f.old === f.content) continue;
          await api.exec(`test -d ${path.posix.dirname(f.path)} || install -d -o bareos -g bareos -m 0750 ${path.posix.dirname(f.path)}`);
          placed.push({ path: f.path, old: f.old, mode: f.mode || '0640' });
          await R.placeFile(api, tmp, i, f.content, f.path, f.mode || '0640');
        }
        // 5) 검사
        for (const t of needsSd ? ['sd', 'dir'] : ['dir']) {
          const r = await api.exec(TEST[t], BUDGET.testMs);
          if (r?.code !== 0) throw fail('config-test', `${t === 'sd' ? 'SD' : 'Director'} 설정 검사(bareos-${t} -t)가 실패했습니다: ${tail(mask(r?.stdout || r?.stderr), 500)}`);
        }
        // 6) 적용 — SD 재시작(스토리지 · 같은 셸에서 실행 중 작업 0 을 다시 확인한 뒤에만) · Director reload
        if (needsSd) {
          const r = await api.exec(SD_RESTART_CMD, BUDGET.reloadMs + 45_000);
          const o = String(r?.stdout || '');
          const run = /RUN=(\S+)/.exec(o)?.[1];
          if (run !== '0') throw fail('conflict', `파일을 놓는 사이 Director 에 ${runText(run)} — SD 를 다시 띄우지 않았습니다(작업이 끝난 뒤 다시 하세요).`);
          restarted = true;
          if (!/^RESTART=0$/m.test(o)) throw fail('remote', `bareos-sd 를 다시 시작하지 못했습니다: ${tail(mask(o.replace(/^RUN=.*$/m, '')), 300)}`);
        }
        reloaded = true;
        const rl = await api.exec(R.RELOAD_CMD, BUDGET.reloadMs);
        if (rl?.code !== 0) throw fail('remote', `Director reload(bconsole)가 실패했습니다: ${tail(mask(rl?.stdout || rl?.stderr), 300) || '출력 없음'}`);
        // 7) 계정 확인 — 새 비밀번호로 bconsole 이 실제로 붙는가(TLS 끔 · 서버 안)
        if (plan.action === 'console.add' || plan.action === 'console.password') await verifyConsoleLogin(api, plan.name, secret.accountPassword, mask, ctx.dirPort);
        // 스토리지 삭제: 볼륨 디렉터리는 지우지 않는다(F6 — 원래 있던 빈 디렉터리 · 다른 장치와 나눠 쓰는 디렉터리일 수 있다)
        settled = true;
        return { files: files.map((f) => ({ path: f.path, action: f.content == null ? 'deleted' : f.old == null ? 'created' : f.old === f.content ? 'unchanged' : 'updated' })), restarted, reloaded };
      } catch (e) {
        if (placed.length) {
          const left = await R.rollback(api, tmp, placed).catch(() => placed.map((x) => x.path));
          settled = !left.length;
          let again = '';
          if (settled) {
            if (restarted) again += (await api.exec('systemctl restart bareos-sd 2>&1', BUDGET.reloadMs).catch(() => null))?.code === 0 ? ' · SD 를 다시 시작했습니다' : ' · SD 를 다시 시작하지 못했습니다(직접 확인하세요)';
            if (reloaded) again += (await api.exec(R.RELOAD_CMD, BUDGET.reloadMs).catch(() => null))?.code === 0 ? ' · Director 를 다시 읽혔습니다' : ' · Director 를 다시 읽히지 못했습니다(직접 reload 하세요)';
            e.message = `${e.message} — 바꾼 파일을 되돌렸습니다${again}.`;
          } else e.message = `${e.message} — 되돌리지 못한 파일: ${left.join(', ')}(직접 확인하세요).`;
        } else settled = true;
        const undo = await undoMade(api, made);
        if (undo) e.message = `${e.message} ${undo}`;
        throw e;
      } finally { if (tmp) await api.exec(`rm -rf ${tmp}`).catch(() => {}); }
    }, ctx.signal);
    return { ok: true, ...out };
  } catch (e) {
    if (!settled && placed.length) {
      const rb = await R.rollbackInNewSession(ssh, placed, { reload: true });
      e.message = `${mask(String(e?.message || e))} — 세션이 끊겨 새 세션으로 ${rb.left.length ? `되돌리려 했지만 남은 파일이 있습니다: ${rb.left.join(', ')}` : '바꾼 파일을 되돌렸습니다'}${restarted ? '(SD 는 직접 다시 시작하세요)' : ''}.`;
    } else e.message = mask(String(e?.message || e));
    throw e;
  }
}

/** 작업 → 파일 목록(내용 · 지우기). SD 비밀번호는 서버에서 읽어 Director 스토리지 파일 안에만(명령 인자 · 응답 · 로그에 없음). */
async function buildFiles(api, plan, secret) {
  const cp = (n) => `${DIR_CONF_ROOT}/console/${n}.conf`;
  switch (plan.action) {
    case 'console.add': {
      const pi = passwordIssue(secret.accountPassword);
      if (pi) throw fail('invalid', pi);
      return [{ path: cp(plan.name), content: consoleText({ name: plan.name, password: secret.accountPassword, profile: plan.profile }), mustBeNew: true, mode: '0640' }];
    }
    case 'console.password': {
      const pi = passwordIssue(secret.accountPassword);
      if (pi) throw fail('invalid', pi);
      const st = await R.pathState(api, cp(plan.name));
      if (st.state !== 'managed') throw fail('conflict', st.state === 'none' ? `‘${plan.name}’ 계정 파일(${cp(plan.name)})이 없습니다 — 포탈이 만든 계정이 아닙니다.` : `‘${plan.name}’ 계정은 포탈이 만든 파일이 아닙니다 — 사람이 만든 계정은 바꾸지 않습니다.`);
      const profile = /^\s*Profile\s*=\s*"([A-Za-z0-9._-]{1,64})"/m.exec(st.old || '')?.[1];
      if (!profile) throw fail('conflict', '계정 파일의 Profile 을 읽지 못했습니다 — 바꾸지 않았습니다.');
      return [{ path: cp(plan.name), content: consoleText({ name: plan.name, password: secret.accountPassword, profile }), mustExist: true, mode: '0640' }];
    }
    case 'console.delete': return [{ path: cp(plan.name), content: null }];
    case 'storage.add': {
      const sdPw = String((await api.exec(SD_PW_CMD))?.stdout || '').trim();
      if (!sdPw || /["\\\r\n]/.test(sdPw)) throw fail('invalid', `${SD_CONF_ROOT}/director/bareos-dir.conf 에서 SD 비밀번호를 읽지 못했습니다(패키지 기본 구성이 아닙니다) — 아무것도 바꾸지 않았습니다.`);
      return [
        { path: `${SD_CONF_ROOT}/device/${plan.device}.conf`, content: sdDeviceText(plan), mustBeNew: true, mode: '0640' },
        { path: `${DIR_CONF_ROOT}/storage/${plan.name}.conf`, content: dirStorageText({ ...plan, sdPassword: sdPw }), mustBeNew: true, mode: '0640', secretInside: true },
      ];
    }
    case 'storage.edit': {
      // Director 스토리지 파일(포탈 것)에서 장치 이름을 읽고 그 장치 파일도 함께 바꾼다
      const dp = `${DIR_CONF_ROOT}/storage/${plan.name}.conf`;
      const st = await R.pathState(api, dp);
      if (st.state !== 'managed') throw fail('conflict', `‘${plan.name}’ 은 포탈이 만든 스토리지가 아닙니다 — 사람이 만든 설정은 바꾸지 않습니다.`);
      const device = /^\s*Device\s*=\s*"?([A-Za-z0-9._-]{1,64})"?\s*$/m.exec(st.old || '')?.[1];
      if (!device) throw fail('conflict', '스토리지 파일에서 장치 이름을 읽지 못했습니다 — 바꾸지 않았습니다.');
      return [
        { path: `${SD_CONF_ROOT}/device/${device}.conf`, content: '', mustExist: true, kind: 'sd', mode: '0640' },
        { path: dp, content: '', mustExist: true, kind: 'dir', mode: '0640', secretInside: true },
      ];
    }
    case 'storage.delete': {
      const dp = `${DIR_CONF_ROOT}/storage/${plan.name}.conf`;
      const st = await R.pathState(api, dp);
      if (st.state !== 'managed') throw fail('conflict', `‘${plan.name}’ 은 포탈이 만든 스토리지가 아닙니다 — 사람이 만든 설정은 지우지 않습니다.`);
      const device = /^\s*Device\s*=\s*"?([A-Za-z0-9._-]{1,64})"?\s*$/m.exec(st.old || '')?.[1];
      if (!device) throw fail('conflict', '스토리지 파일에서 장치 이름을 읽지 못했습니다 — 지우지 않았습니다.');
      const sp = `${SD_CONF_ROOT}/device/${device}.conf`;
      const sst = await R.pathState(api, sp);
      const archiveDevice = sst.state === 'managed' ? ARCHIVE_RE.exec(sst.old || '')?.[1]?.trim() || '' : '';
      return [{ path: sp, content: null, archiveDevice }, { path: dp, content: null, device }];
    }
    case 'pools.edit': {
      const res = directorResources({ defaults: {}, consoleName: 'x', consolePassword: 'x', restoreClient: 'x', restoreStorage: 'x', restorePool: 'x', pools: plan.pools, schedule: plan.schedule })
        .filter((r) => (plan.pools && r.type === 'pool' && PORTAL_POOLS.includes(r.name)) || (plan.schedule && r.type === 'schedule' && r.name === VMWARE_SCHEDULE));
      return res.map((r) => ({ path: `${DIR_CONF_ROOT}/${r.type}/${r.name}.conf`, content: `${MARKER}\n${r.text}\n`, mustExist: true, mode: '0640' }));
    }
    default: throw fail('invalid', `알 수 없는 작업(${plan.action})`);
  }
}

/** 편집: 옛 표지 파일에서 값을 읽어 바꾼 칸만 다시 쓴다(SD 비밀번호는 옛 파일에 있던 것을 그대로 — 다시 읽지 않는다). */
function fillEdit(plan, files) {
  const sd = files.find((f) => f.kind === 'sd'); const dir = files.find((f) => f.kind === 'dir');
  const get = (t, re) => re.exec(t || '')?.[1] || '';
  const device = get(sd.old, /^\s*Name\s*=\s*"?([A-Za-z0-9._-]{1,64})"?\s*$/m);
  const mediaType = get(sd.old, /^\s*Media\s+Type\s*=\s*"?([A-Za-z0-9._-]{1,64})"?\s*$/mi);
  const archiveDevice = get(sd.old, ARCHIVE_RE).trim();
  const address = get(dir.old, /^\s*Address\s*=\s*"?([A-Za-z0-9.:-]{1,253})"?\s*$/mi);
  const sdPassword = get(dir.old, /^\s*Password\s*=\s*"([^"\n]*)"/mi);
  if (!device || !mediaType || volumeDirIssue(archiveDevice) || !address || !sdPassword) throw fail('conflict', '포탈 스토리지 파일에서 기존 값을 읽지 못했습니다 — 바꾸지 않았습니다.');
  sd.content = sdDeviceText({ device, mediaType, archiveDevice, count: plan.count, description: plan.description });
  dir.content = dirStorageText({ name: plan.name, address, sdPassword, device, mediaType, count: plan.count, description: plan.description });
}

async function deletePrecheck(api, plan, files) {
  const sdFile = files[0]; const dev = files[1]?.device;
  const p = sdFile.archiveDevice;
  // F3: 경로를 못 읽었으면 멈춘다(못 읽은 값은 0 이 아니다) · 심링크면 따라가 세지 않고 멈춘다
  if (!p || volumeDirIssue(p)) throw fail('conflict', `SD 장치 파일에서 볼륨 경로를 읽지 못했습니다${p ? `(${p})` : ''} — 볼륨 파일이 없는지 확인할 수 없어 지우지 않았습니다.`);
  const o = String((await api.exec(`if [ -L ${p} ]; then echo LINK; elif [ -d ${p} ]; then echo "N=$(find ${p} -maxdepth 1 -type f 2>/dev/null | wc -l)"; elif [ -e ${p} ]; then echo OTHER; else echo MISSING; fi`))?.stdout || '');
  if (/LINK|OTHER/.test(o)) throw fail('conflict', `볼륨 경로(${p})가 심링크이거나 디렉터리가 아닙니다 — 볼륨 파일 수를 확인할 수 없어 지우지 않았습니다.`);
  // v2.846 D-5 ②: 경로가 없으면(마운트가 빠졌을 수 있다) 볼륨이 0 이라고 보지 않는다
  if (/MISSING/.test(o)) throw fail('conflict', `볼륨 경로(${p})가 없습니다 — 디스크 · 마운트가 빠졌을 수 있어 볼륨 파일이 없는지 확인할 수 없습니다(지우지 않았습니다). 경로를 복구하거나 서버에서 직접 정리하세요.`);
  const n = Number(/N=\s*(\d+)/.exec(o)?.[1]);
  if (!Number.isInteger(n)) throw fail('conflict', '볼륨 디렉터리의 파일 수를 읽지 못했습니다 — 지우지 않았습니다.');
  if (n > 0) throw fail('conflict', `볼륨 디렉터리(${p})에 볼륨 파일이 ${n}개 있습니다 — 백업 데이터가 있는 스토리지는 지우지 않습니다.`);
  // 이 스토리지 이름을 쓰는 설정(Storage = X — 대소문자 · 한 줄 리소스 · ; 끝) · 이 장치를 가리키는 다른 Director Storage(Device = Y)
  const own = `${DIR_CONF_ROOT}/storage/${plan.name}.conf`;
  const refRe = (k, v) => `(^|[;{[:space:]])${k}[[:space:]]*=[[:space:]]*"?${reEsc(v)}"?([[:space:];}#]|$)`;
  const grep = async (re, dir) => String((await api.exec(`grep -rliE '${re}' ${dir} 2>/dev/null | grep -vxF ${own} | head -n 5`))?.stdout || '').trim();
  const ref = await grep(refRe('storage', plan.name), DIR_CONF_ROOT);
  if (ref) throw fail('conflict', `이 스토리지를 쓰는 설정이 있습니다(${ref.split('\n').map((x) => path.posix.basename(x)).join(', ')}) — 먼저 그 설정을 바꾸세요.`);
  if (dev) {
    const dref = await grep(refRe('device', dev), `${DIR_CONF_ROOT}/storage`);
    if (dref) throw fail('conflict', `다른 Director Storage 가 이 SD 장치(${dev})를 가리킵니다(${dref.split('\n').map((x) => path.posix.basename(x)).join(', ')}) — 먼저 그 설정을 바꾸세요.`);
  }
}

async function prepareDir(api, plan, made, mask) {
  const p = plan.archiveDevice;
  // F6: 다른 SD 장치가 같은 경로를 쓰면 거부(볼륨이 섞이고 지울 때 판정이 틀린다)
  const used = String((await api.exec(`grep -rliE '^[[:space:]]*Archive[[:space:]]*Device[[:space:]]*=[[:space:]]*"?${reEsc(p)}"?[[:space:]]*(#.*)?$' ${SD_CONF_ROOT}/device 2>/dev/null | head -n 3`))?.stdout || '').trim();
  if (used) throw fail('conflict', `다른 SD 장치가 이 경로를 씁니다(${used.split('\n').map((x) => path.posix.basename(x)).join(', ')}) — 스토리지마다 다른 디렉터리를 쓰세요(아무것도 바꾸지 않았습니다).`);
  const st = String((await api.exec(`if [ -L ${p} ]; then echo LINK; elif [ -d ${p} ]; then echo DIR; echo "ENTRIES=$(find ${p} -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1 | wc -l)"; elif [ -e ${p} ]; then echo OTHER; else echo NONE; fi; rp=$(realpath -m -- ${p}); [ "$rp" = "${p}" ] && echo CANON`))?.stdout || '');
  if (!/CANON/.test(st)) throw fail('invalid', `${p} 경로에 심링크가 섞여 있습니다 — 실제 경로로 적으세요.`);
  if (/LINK|OTHER/.test(st)) throw fail('invalid', `${p} 가 디렉터리가 아닙니다.`);
  // F2: 이미 있는 디렉터리는 비어 있을 때만(다른 프로그램의 데이터 디렉터리를 재라벨하지 않게)
  if (/DIR/.test(st) && !/ENTRIES=0/.test(st)) throw fail('invalid', `${p} 에 이미 파일 · 디렉터리가 있습니다 — 새 스토리지는 없는 경로나 빈 디렉터리에만 만듭니다(다른 프로그램의 데이터 디렉터리의 권한 · SELinux 문맥을 바꾸지 않게 · 아무것도 바꾸지 않았습니다).`);
  if (/NONE/.test(st)) {
    const r = await api.exec(`install -d -o bareos -g bareos -m 0750 ${p}`);
    if (r?.code !== 0) throw fail('remote', `볼륨 디렉터리를 만들지 못했습니다: ${tail(mask(r?.stderr || r?.stdout), 200)}`);
    made.dirs.push(p);
  }
  // SELinux: 패키지 기본 저장 경로와 같은 문맥(설치 문서 3.3 · 완전 설치 러너와 같다) — 이번에 넣은 규칙만 기록해 실패하면 지운다(F2)
  const se = String((await api.exec(`if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" != Disabled ]; then if semanage fcontext -l -C 2>/dev/null | grep -Fq '${p} = '; then echo SE=had; elif semanage fcontext -a -e /var/lib/bareos/storage ${p} >/dev/null 2>&1; then echo SE=added; else echo SE=fail; fi; restorecon -R ${p} >/dev/null 2>&1; else echo SE=off; fi`, 60_000))?.stdout || '');
  if (/SE=added/.test(se)) made.seRule = p;
  const w = await api.exec(`runuser -u bareos -- sh -c 'touch ${p}/.portal-write-test && rm -f ${p}/.portal-write-test' 2>&1`);
  if (w?.code !== 0) throw fail('remote', `bareos 계정으로 ${p} 에 쓰지 못했습니다(권한 · SELinux · 마운트): ${tail(mask(w?.stdout || w?.stderr), 200)}`);
}

/** 이번에 만든 것 되돌리기(SELinux 규칙 → 디렉터리 — 비었을 때만 rmdir). 문제가 있으면 사람이 읽을 문장. */
async function undoMade(api, made) {
  const notes = [];
  if (made.seRule) {
    const r = await api.exec(`semanage fcontext -d ${made.seRule} >/dev/null 2>&1 && { [ -d ${made.seRule} ] && restorecon -R ${made.seRule} >/dev/null 2>&1; true; }`, 60_000).catch(() => null);
    if (r?.code !== 0) notes.push(`이번에 넣은 SELinux 규칙(${made.seRule})을 지우지 못했습니다 — semanage fcontext -d ${made.seRule} 로 직접 지우세요.`);
  }
  for (const d of [...made.dirs].reverse()) await api.exec(`[ -d ${d} ] && [ ! -L ${d} ] && rmdir ${d} 2>/dev/null; true`).catch(() => {});
  return notes.join(' ');
}

/** 새 계정 비밀번호로 서버 안 bconsole 접속(TLS 끔 — WebUI 와 같은 조건). */
async function verifyConsoleLogin(api, name, password, mask, dirPort) {
  const port = Number.isInteger(Number(dirPort)) && Number(dirPort) >= 1 && Number(dirPort) <= 65535 ? Number(dirPort) : 9101;
  const tmp = await remoteTmpDir(api.exec, R.TMP_PREFIX);
  try {
    const dn = String((await api.exec(`sed -n 's/^[[:space:]]*Name[[:space:]]*=[[:space:]]*"\\{0,1\\}\\([A-Za-z0-9._-]*\\).*/\\1/p' ${DIR_CONF_ROOT}/director/*.conf 2>/dev/null | head -n 1`))?.stdout || '').trim() || 'bareos-dir';
    if (!isResourceName(dn)) throw fail('invalid', 'Director 이름을 읽지 못했습니다.');
    const conf = `Director {\n  Name = ${dn}\n  Address = localhost\n  DirPort = ${port}\n  Password = "unused-${crypto.randomBytes(6).toString('hex')}"\n}\nConsole {\n  Name = "${name}"\n  Password = "${password}"\n  Director = ${dn}\n  TLS Enable = No\n}\n`;
    await api.writeFile(`${tmp}/bconsole.conf`, conf, 0o600);
    const x = await api.exec(`printf 'version\\n' | timeout 30 bconsole -c ${tmp}/bconsole.conf 2>&1`, 45_000);
    if (x?.code !== 0 || !/Version/.test(String(x?.stdout || ''))) throw fail('console-login', `새 계정으로 Director 에 붙지 못했습니다: ${tail(mask(x?.stdout), 300)}`);
  } finally { await api.exec(`rm -rf ${tmp}`).catch(() => {}); }
}
