/**
 * bareos/install/plan.js — Bareos 완전 설치 계획(순수 · v2.844): 입력 판정 · 엣지 노드 러너에 넘길 plan.env · 단계 표.
 *
 * 규칙(bareos/CLAUDE.md '완전 설치'):
 *  - 러너(runner.sh)에 들어가는 값은 **전부 여기 화이트리스트를 지난 것**이다(셸이 그대로 읽는다 — 따옴표·$·백틱·공백 허용 범위를 좁힌다).
 *  - plan.env 에 비밀을 싣지 않는다(SD 비밀번호는 러너가 서버 안에서 읽는다 · 콘솔 비밀번호는 4단계가 SFTP 임시 파일로).
 *  - pyVmomi 는 번들에 든 8.x 판 중에서만(Rocky 9 의 Python 3.9 에서 9.x 는 플러그인이 시작하지 못한다 — 현장 실측).
 *  - 볼륨 디렉터리는 시스템 경로·얕은 경로·'..' 를 거부한다(초기화의 볼륨 삭제도 같은 판정 — 러너 safe_voldir 와 맞춘다).
 */
import { isResourceName } from '../names.js';
import { normVmwareExtras } from '../autoSetup.js';
import { PYVMOMI_RE } from './bundleDoc.js';

export const REMOTE_ROOT = '/var/lib/portal-bareos-install';
export const RUN_DIR = `${REMOTE_ROOT}/run`;
export const BUNDLES_DIR = `${REMOTE_ROOT}/bundles`;
export const UNIT = 'portal-bareos-install';
export const SD_DEVICE = 'PortalFileStorage';
export const SD_MEDIA = 'PortalFile';
export const DIR_STORAGE = 'PortalFile';
export const FD_CLIENT = 'bareos-fd';          // 패키지 기본 Client 리소스 이름(같은 서버의 FD)
export const DEFAULT_VOLUME_DIR = '/var/lib/bareos/storage';
export const DEFAULT_CONSOLE = 'portal';
/** SD 장치 수 = 동시 백업 수(패키지 기본 FileStorage Count = 10 · Director Storage Maximum Concurrent Jobs = 10 — 번들 RPM 실측 · v2.845). */
export const SD_COUNT = 10;

/** 화면·감사가 쓰는 단계 표. remote = 엣지 노드 러너가 하는 단계. */
export const STEPS = Object.freeze([
  { n: 0, key: 'reset', label: '기존 제거(초기화)', remote: true },
  { n: 1, key: 'bundle', label: '번들 전송·풀기', remote: true },
  { n: 2, key: 'packages', label: '패키지 · pyVmomi · 카탈로그 DB', remote: true },
  { n: 3, key: 'services', label: '볼륨 · SD 장치 · 서비스 · WebUI', remote: true },
  { n: 4, key: 'director', label: 'Director 리소스 · 포탈 등록', remote: false },
  { n: 5, key: 'fdPlugin', label: 'FD 플러그인', remote: false },
  { n: 6, key: 'edgeProbe', label: '엣지 경유 연결 확인', remote: false },
  { n: 7, key: 'mapping', label: '매핑 저장', remote: false },
]);
export const LAST_REMOTE_STEP = 3;
export const LAST_STEP = 7;

const SYSTEM_DIRS = new Set(['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/root', '/home', '/var', '/var/lib', '/opt', '/tmp', '/srv', '/mnt', '/media']);
const SYSTEM_PREFIX = ['/etc/', '/usr/', '/bin/', '/sbin/', '/lib/', '/lib64/', '/boot/', '/dev/', '/proc/', '/sys/', '/run/'];
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const HOST_ADDR_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f:]{2,39}|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const BV_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const JOB_ID_RE = /^bi_[a-z0-9]{6,40}$/;

/** 볼륨 디렉터리 판정 — 문제가 있으면 사유. */
export function volumeDirIssue(p) {
  const s = String(p ?? '').trim();
  if (!PATH_RE.test(s)) return '볼륨 경로는 / 로 시작하는 절대 경로(영문·숫자·._-/)로 적습니다.';
  if (s.includes('..') || s.includes('//') || (s.length > 1 && s.endsWith('/'))) return '볼륨 경로에 .. · // · 끝의 / 를 쓰지 않습니다.';
  if (SYSTEM_DIRS.has(s) || SYSTEM_PREFIX.some((x) => s.startsWith(x))) return `시스템 경로(${s})는 볼륨 경로로 쓸 수 없습니다.`;
  if (s.split('/').filter(Boolean).length < 2) return '볼륨 경로는 두 단계 이상이어야 합니다(예: /var/lib/bareos/storage · /mnt/bareos).';
  return '';
}

const fail = (message) => Object.assign(new Error(message), { code: 'invalid' });

/**
 * 화면 입력 → 계획(던짐: code 'invalid'). contents = 번들 내용 목록(normContents). mode 'install' | 'reinstall'.
 * @returns {{ mode, pyvmomi, pyvmomiFix, volumeDir, pools, schedule, consoleName, directorName, reset }}
 */
export function normPlan(b = {}, { contents, mode, corpName = '' } = {}) {
  if (!contents) throw fail('설치할 번들이 없습니다 — 먼저 번들을 받으세요.');
  const m = mode === 'reinstall' ? 'reinstall' : 'install';
  const pyvmomi = String(b.pyvmomi ?? contents.pyvmomi.default);
  if (!PYVMOMI_RE.test(pyvmomi) || !contents.pyvmomi.versions.includes(pyvmomi)) {
    throw fail(`pyVmomi 판은 번들에 든 8.x 중에서 고릅니다(${contents.pyvmomi.versions.join(' · ')}). 9.x 는 Rocky 9 의 Python 3.9 에서 플러그인이 시작하지 못합니다.`);
  }
  const volumeDir = String(b.volumeDir ?? DEFAULT_VOLUME_DIR).trim() || DEFAULT_VOLUME_DIR;
  const vi = volumeDirIssue(volumeDir);
  if (vi) throw fail(vi);
  const ex = normVmwareExtras({ pools: b.pools ?? { fullDays: 35, incrDays: 14, maxVolumeGB: 50 }, schedule: b.schedule ?? { fullDay: 'sun', time: '02:00' } });
  if (ex.issue) throw fail(ex.issue);
  const consoleName = String(b.consoleName ?? '').trim() || DEFAULT_CONSOLE;
  if (!isResourceName(consoleName)) throw fail('콘솔 이름은 영문·숫자·._- 64자 이하로 적습니다.');
  const directorName = (String(b.directorName ?? '').trim() || `${corpName || '법인'} Bareos`).slice(0, 64);
  let reset = null;
  if (m === 'reinstall') {
    const r = b.reset && typeof b.reset === 'object' ? b.reset : {};
    if (r.ack !== true) throw fail('지울 항목을 확인했다는 표시(체크)가 필요합니다.');
    reset = { catalog: r.catalog !== false, volumes: r.volumes === true };
    if (reset.volumes && String(r.confirmName ?? '').trim() !== String(corpName || '').trim()) {
      throw fail('백업 볼륨까지 지우려면 법인 이름을 정확히 입력해야 합니다.');
    }
  }
  // WebUI 는 기본 설치(사용자 결정) — 끄는 값(false)만 받는다
  return { mode: m, pyvmomi, pyvmomiFix: b.pyvmomiFix === true, volumeDir, pools: ex.pools, schedule: ex.schedule, consoleName, directorName, reset, webui: b.webui !== false };
}

const q = (k, v, re) => {
  const s = String(v ?? '');
  if (re && !re.test(s)) throw Object.assign(new Error(`러너 값 ${k} 이(가) 허용 형식이 아닙니다`), { code: 'invalid' });
  if (/['"$`\\\n\r]/.test(s)) throw Object.assign(new Error(`러너 값 ${k} 에 쓸 수 없는 글자가 있습니다`), { code: 'invalid' });
  return `${k}='${s}'`;
};

/**
 * 러너 입력(plan.env). 값마다 형식을 다시 본다(던짐 — 부른 쪽 버그를 원격에 보내지 않는다).
 * @param {{ jobId, bundle:{version,sha256}, install:string[], plan, startStep, runMode, hostAddr, resetVolumeDirs?:string[], runningUnknownOk?:boolean }} o
 *   runningUnknownOk(v2.846 D-2): 화면의 '확인했음 — 실행 중 작업 확인 없이 진행' 동의 — 그 회차에만(작업 기록의 시도 행) · 0단계가 실행 중 작업을 못 읽었을 때만 쓰인다.
 */
export function planEnv({ jobId, bundle, install, plan, startStep = 0, runMode = 'install', hostAddr, resetVolumeDirs = [], runningUnknownOk = false }) {
  if (!JOB_ID_RE.test(String(jobId))) throw Object.assign(new Error('작업 id 형식이 아닙니다'), { code: 'invalid' });
  if (!Array.isArray(install) || !install.length || !install.every((n) => PKG_NAME_RE.test(n))) throw Object.assign(new Error('설치 패키지 목록이 틀렸습니다'), { code: 'invalid' });
  const vols = (resetVolumeDirs || []).filter((d) => !volumeDirIssue(d));
  const lines = [
    '# vmware-portal Bareos 완전 설치 — 러너 입력(포탈이 만든 값 · 비밀 없음)',
    q('JOB_ID', jobId, JOB_ID_RE),
    q('RUN_MODE', runMode, /^(install|rollback-all)$/),
    q('START_STEP', startStep, /^[0-3]$/),
    q('BV', bundle.version, BV_RE),
    q('TAR_SHA256', bundle.sha256, SHA_RE),
    q('INSTALL_PKGS', install.join(' '), /^[A-Za-z0-9._+ -]{1,2000}$/),
    q('PYVMOMI', plan.pyvmomi, PYVMOMI_RE),
    q('PYVMOMI_FIX', plan.pyvmomiFix ? 1 : 0, /^[01]$/),
    q('VOLUME_DIR', plan.volumeDir, PATH_RE),
    q('HOST_ADDR', hostAddr, HOST_ADDR_RE),
    q('SD_DEVICE', SD_DEVICE), q('SD_MEDIA', SD_MEDIA), q('DIR_STORAGE', DIR_STORAGE), q('SD_COUNT', SD_COUNT, /^\d{1,3}$/),
    q('WEBUI', plan.webui === false ? 0 : 1, /^[01]$/),
    q('RESET', plan.mode === 'reinstall' ? 1 : 0, /^[01]$/),
    q('RESET_DB', plan.reset?.catalog ? 1 : 0, /^[01]$/),
    q('RESET_VOLUMES', plan.reset?.volumes ? 1 : 0, /^[01]$/),
    q('RESET_VOLUME_DIRS', plan.reset?.volumes ? vols.join(' ') : '', /^[A-Za-z0-9._/ -]{0,2000}$/),
    // 불리언 true 만 1(문자열 'true' · 1 은 0 — 동의는 화면의 체크 하나에서만 온다)
    q('RUNNING_UNKNOWN_OK', plan.mode === 'reinstall' && runningUnknownOk === true ? 1 : 0, /^[01]$/),
  ];
  if (volumeDirIssue(plan.volumeDir)) throw Object.assign(new Error('볼륨 경로가 허용 형식이 아닙니다'), { code: 'invalid' });
  return `${lines.join('\n')}\n`;
}

/** 감사·화면용 계획 요약(비밀 없음). */
export function planSummary(plan) {
  if (!plan) return '';
  const p = plan.pools ? `풀 Full ${plan.pools.fullDays}일 · Incr ${plan.pools.incrDays}일 · 볼륨 ${plan.pools.maxVolumeGB}GB` : '';
  const s = plan.schedule ? `전체 백업 ${plan.schedule.fullDay} ${plan.schedule.time}` : '';
  const r = plan.reset ? ` · 초기화(카탈로그 DB ${plan.reset.catalog ? '삭제' : '유지'} · 볼륨 ${plan.reset.volumes ? '삭제' : '보존'})` : '';
  return `pyVmomi ${plan.pyvmomi}${plan.pyvmomiFix ? '(플러그인 경로 사본 옮김)' : ''} · 볼륨 ${plan.volumeDir} · ${p} · ${s} · 콘솔 ${plan.consoleName}${r}`;
}
