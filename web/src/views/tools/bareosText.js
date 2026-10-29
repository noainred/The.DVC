/**
 * views/tools/bareosText.js — Bareos VM 백업 화면 문구·판정(순수 함수, v2.820). 화면(BareosBackupTool.jsx)은 이 모듈만 본다.
 * 규칙(docs/rules/web.md): 문구에 백틱 금지(값 인용은 ‘ ’) · 값이 없으면 '—'(0 으로 보이지 않게) · 주기·상한 숫자는 API 값.
 */
import { numOrNull } from '../../numOrNull.js';

export const STATE_LABEL = Object.freeze({
  ok: '성공', warning: '경고', error: '오류', canceled: '취소', running: '실행 중', queued: '대기', waiting: '대기', unknown: '확인 불가',
});
const STATE_BADGE = Object.freeze({ ok: 'green', warning: 'amber', error: 'red', canceled: 'gray', running: 'blue', queued: 'blue', waiting: 'blue', unknown: 'gray' });

/** 상태 배지 { label, cls } — 상태 코드 글자(T·W·f…)를 함께 보인다(운영자가 Bareos 로그와 대조). */
export function stateBadge(state, status = '') {
  const s = STATE_LABEL[state] ? state : 'unknown';
  const code = typeof status === 'string' && /^[A-Za-z]$/.test(status) ? ` · ${status}` : '';
  return { label: `${STATE_LABEL[s]}${code}`, cls: STATE_BADGE[s] };
}

const LEVELS = { F: 'Full', I: 'Incremental', D: 'Differential', Full: 'Full', Incremental: 'Incremental', Differential: 'Differential' };
export const levelLabel = (v) => LEVELS[v] || '—';

/** W13(v2.822): 복원 지점 목록이 잘렸으면 밝힌다 — 서버가 본 최근 실행 수(scanned)와 화면에 보이는 수. */
export function restorePointsNote(pts, shown) {
  const n = (pts?.items || []).length;
  const scanned = numOrNull(pts?.scanned);
  const head = n > shown ? `성공한 백업 ${n}건 중 최근 ${shown}건을 보입니다.` : `성공한 백업 ${n}건.`;
  return `${head}${scanned !== null ? ` Director 카탈로그의 최근 실행 ${scanned}건에서 골랐습니다 — 더 오래된 지점은 Director 에서 복원하세요.` : ''}`;
}

/**
 * v2.822(S3·I5): 등록 뒤 VM 이 바뀐 대상의 안내 — 잡은 등록 때의 이름·위치를 가리키므로 백업이 실패하고 덮어쓰기 복원은 막힌다.
 * @param {'missing'|string[]|null|undefined} drift  서버 placementDrift 결과
 */
export function driftText(drift) {
  if (!drift) return '';
  if (drift === 'missing') return '인벤토리에서 이 VM 을 찾지 못했습니다(지워졌거나 다른 vCenter 로 옮겨졌을 수 있습니다) — 백업이 실패할 수 있습니다.';
  const what = Array.isArray(drift) ? drift.join('·') : String(drift);
  return `등록 뒤 VM 의 ${what}이(가) 바뀌었습니다 — Bareos 잡은 등록 때의 값을 쓰므로 백업이 실패할 수 있고 덮어쓰기 복원은 막힙니다. 대상을 지우고 다시 등록하세요.`;
}

/** 바이트 → 사람이 읽는 크기. 못 읽은 값은 '—'(0 이 아니다). */
export function bytesText(v) {
  const n = numOrNull(v);
  if (n === null || n < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let x = n; let i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i === 0 ? x : x.toFixed(x >= 100 ? 0 : 1)} ${u[i]}`;
}

/** 시각(ms) → 'MM-DD HH:mm'(브라우저 시각). 없으면 '—'. */
export function whenText(ms) {
  const n = numOrNull(ms);
  if (n === null || n <= 0) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 경과 시간(분 단위 글자). */
export function elapsedText(fromMs, now = Date.now()) {
  const n = numOrNull(fromMs);
  if (n === null) return '';
  const m = Math.max(0, Math.round((now - n) / 60_000));
  return m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간 ${m % 60}분째`;
}

/**
 * 표의 '최근 실행' 칸: 진행 중이면 그 실행, 아니면 lastRun. 없으면 '아직 실행 없음'.
 * @returns {{ when: string, badge: {label,cls}|null, note: string, bytes: string, jobid: number|null }}
 */
export function runCell(job, now = Date.now()) {
  if (job?.pending?.jobid) {
    const st = job.pending.state || 'queued';
    return { when: whenText(job.pending.since), badge: stateBadge(st, job.pending.status || ''), note: `jobid ${job.pending.jobid} · ${elapsedText(job.pending.since, now)}`, bytes: '—', jobid: job.pending.jobid };
  }
  const r = job?.lastRun;
  if (!r) return { when: '—', badge: null, note: '아직 실행 없음', bytes: '—', jobid: null };
  return { when: whenText(r.startedAt ?? r.checkedAt), badge: stateBadge(r.state, r.status), note: `jobid ${r.jobid}${r.level ? ` · ${levelLabel(r.level)}` : ''}`, bytes: bytesText(r.bytes), jobid: r.jobid };
}

/** 머리 상태 줄(Director 연결·폴러). */
export function directorLine(d) {
  if (!d) return '';
  if (d.demo) return '데모 Director(합성 응답 — 어디에도 접속하지 않습니다). 설정 탭에서 실제 Director 를 등록하면 그쪽으로 바뀝니다.';
  if (!d.configured) return 'Director 가 설정되지 않았습니다 — 설정 탭에서 주소·콘솔 이름·비밀번호를 등록하세요.';
  const p = d.poller || {};
  const base = d.director?.masked
    ? 'Director(주소·콘솔 이름은 전체 범위 관리자만 봅니다)'
    : `Director ‘${d.director?.host || '?'}:${d.director?.port || 9101}’ · 콘솔 ‘${d.director?.consoleName || '?'}’`;
  if (d.authStopped) return `${base} · 인증 실패로 주기 조회를 멈췄습니다(${d.authStopped.reason}) — 설정을 고치면 다시 시작합니다.`;
  if (p.ok === false) return `${base} · 마지막 상태 조회 실패: ${p.error || '사유 미상'}`;
  if (p.at) return `${base} · 상태 조회 ${whenText(p.at)}${p.idle ? '(진행 중 실행 없음)' : ''} · ${d.defaults?.pollIntervalSec || '—'}초 주기`;
  return `${base} · 상태 조회 대기 중`;
}

export const RESTORE_MODE_LABEL = Object.freeze({ original: '원래 VM 에 덮어쓰기', newVm: '새 VM 으로', localVmdk: 'FD 로컬 VMDK 파일로' });

/** 복원 이력 한 줄. */
export function restoreLine(r) {
  if (!r) return '';
  const tgt = r.mode === 'newVm' ? `새 VM ‘${r.target?.name || '?'}’${r.target?.datastore ? ` · ${r.target.datastore}` : ''}` : r.mode === 'original' ? '원래 VM 덮어쓰기' : 'FD 로컬 VMDK';
  return `${tgt} · 원본 ${(r.fromJobids || []).join(',') || '—'} · ${r.by || '—'}`;
}

/** 등록 후보 요약. */
export function candidateSummary(c) {
  if (!c) return '';
  const items = c.items || [];
  const ok = items.filter((x) => x.eligible && !x.registered).length;
  const bad = items.filter((x) => !x.eligible).length;
  const reg = items.filter((x) => x.registered).length;
  const cut = c.total > c.returned ? ` · 전체 ${c.total}대 중 앞 ${c.returned}대(이름순)` : '';
  return `등록 가능 ${ok}대 · 이미 대상 ${reg}대 · 등록 불가 ${bad}대${cut}`;
}

/** Director 에 1회 넣을 사전 준비 블록(설정 화면 복사용). */
export function directorPrepBlock({ defaults = {}, consoleName = 'portal', anyClient = 'kr-fd', anyPool = 'VMwarePool' } = {}) {
  const fs = defaults.fileSet || 'PortalVmwareGeneric';
  const jd = defaults.jobDefs || 'PortalVmwareDefaults';
  const rj = defaults.restoreJob || 'PortalVmwareRestore';
  const plugin = defaults.pluginName || 'python3';
  return [
    `FileSet {`,
    `  Name = "${fs}"`,
    `  Include {`,
    `    Options { Signature = XXH128; Compression = LZ4 }`,
    `    Plugin = "${plugin}:module_name=bareos-fd-vmware"`,
    `  }`,
    `}`,
    `JobDefs {`,
    `  Name = "${jd}"`,
    `  Type = Backup`,
    `  Level = Incremental`,
    `  FileSet = "${fs}"`,
    `  Messages = Standard`,
    `  Priority = 10`,
    `  Write Bootstrap = "/var/lib/bareos/%c.bsr"`,
    `}`,
    `Job {`,
    `  Name = "${rj}"`,
    `  Type = Restore`,
    `  FileSet = "${fs}"`,
    `  Client = ${anyClient}`,
    `  Pool = ${anyPool}`,
    `  Where = /`,
    `  Messages = Standard`,
    `}`,
    `Console {`,
    `  Name = "${consoleName || 'portal'}"`,
    `  Password = "<생성한 비밀번호>"`,
    `  Profile = "portal"`,
    `}`,
    `Profile {`,
    `  Name = "portal"`,
    `  Command ACL = .api, .jobs, .clients, .storages, .pools, .schedules, .jobdefs, .filesets, .bvfs_get_jobids, configure, run, restore, llist, list, cancel, enable, disable, status, version, !*all*`,
    `  Job ACL = *all*`,
    `  Client ACL = *all*`,
    `  Storage ACL = *all*`,
    `  Pool ACL = *all*`,
    `  Schedule ACL = *all*`,
    `  FileSet ACL = *all*`,
    `  Catalog ACL = *all*`,
    `  Where ACL = *all*`,
    `  Plugin Options ACL = *all*`,
    `}`,
  ].join('\n');
}

/** 사이트 FD 의 자격증명 INI 템플릿(비밀번호 칸은 비워 둔다 — 포탈은 vCenter 비밀번호를 갖지 않는다). */
export function fdIniTemplate(site) {
  return [
    `# ${site?.configFile || '/etc/bareos/vmware/<vCenter>.ini'}  (FD ‘${site?.client || '?'}’ 에 두고 bareos 소유 · 0600)`,
    '[vmware_plugin_options]',
    `vcserver=${site?.vcserver || '<vCenter 주소>'}`,
    'vcuser=<백업 전용 vCenter 계정>',
    'vcpass=<여기에 직접 입력 — 포탈은 저장하지 않습니다>',
    'vcthumbprint=<vCenter 인증서 SHA1 지문, 콜론 없이>',
  ].join('\n');
}

/** 사전 준비 체크리스트(설정 탭). */
export const PREP_CHECKLIST = Object.freeze([
  '사이트 FD 에 bareos-vmware-plugin(VDDK 포함)과 pyVmomi(vSphere 메이저 버전과 맞춤)를 설치합니다.',
  'FD 의 Client 리소스에 Plugin Names = python3 · Plugin Directory 를 지정합니다.',
  'vCenter 에 백업 전용 관리자 계정을 만들고 VADP 를 쓰는 라이선스(Essentials 이상)인지 확인합니다.',
  '포탈 서버에서 Director 9101 포트로 TLS-PSK 접속이 되는지 bareos-probe 도구로 먼저 확인합니다.',
]);

/* ───────────── v2.822 여러 VM 한 번에 등록(폴더 단위 포함) ───────────── */

export const NO_FOLDER = '\u0000none';   // 폴더 정보가 없는 VM(vApp 안·SOAP 수집 전) — 드롭다운 값으로만 쓴다

/** 후보의 폴더 목록(정렬·중복 없음). 폴더 정보가 없는 VM 이 있으면 마지막에 그 항목. */
export function folderOptions(items) {
  const set = new Set();
  let none = false;
  for (const x of items || []) { if (typeof x?.folder === 'string' && x.folder) set.add(x.folder); else none = true; }
  const list = [...set].sort((a, b) => a.localeCompare(b)).map((f) => ({ value: f, label: f }));
  if (none) list.push({ value: NO_FOLDER, label: '(폴더 정보 없음)' });
  return list;
}

/** 폴더 필터 — 하위 폴더 포함('/app' 은 '/app/web' 도). '' 은 전체. */
export function inFolder(x, f) {
  if (!f) return true;
  if (f === NO_FOLDER) return !(typeof x?.folder === 'string' && x.folder);
  const p = typeof x?.folder === 'string' ? x.folder : '';
  if (f === '/') return p.startsWith('/');
  return p === f || p.startsWith(`${f}/`);
}

/** 한 번에 고를 수 있는 수 — API 의 일괄 상한과 원장 남은 자리 중 작은 값(모르면 상한). */
export function pickCap(cand) {
  const max = Number.isInteger(cand?.maxBulk) && cand.maxBulk > 0 ? cand.maxBulk : 0;
  const left = Number.isInteger(cand?.jobsLeft) && cand.jobsLeft >= 0 ? cand.jobsLeft : max;
  return Math.min(max, left);
}

/** 일괄 등록 결과 한 줄. */
export function bulkSummary(r) {
  if (!r) return '';
  const ok = Number(r.created) || 0;
  const bad = Number(r.failed) || 0;
  if (!ok) return `한 대도 등록하지 못했습니다 — 아래 사유를 보세요(${bad}대).`;
  return `${ok}대를 백업 대상으로 등록했습니다${bad ? ` · ${bad}대는 등록하지 못했습니다(아래 사유)` : ''}. Director 에 VM 마다 잡을 만들고 사이트 매핑의 스케줄을 배정했습니다.`;
}

/* ───────────── v2.822 단계별 연결 진단 ───────────── */

/** 진단 단계 한 줄의 표시(배지 글자·색·시간). 시도하지 않은 단계는 실패가 아니다(회색). */
export function diagView(st) {
  if (!st || st.skipped) return { mark: '시도 안 함', cls: 'gray', ms: '' };
  const ms = Number.isFinite(st.ms) && st.ms >= 0 ? `${st.ms < 1000 ? `${Math.round(st.ms)}ms` : `${(st.ms / 1000).toFixed(1)}초`}` : '';
  return st.ok ? { mark: '✓ 통과', cls: 'green', ms } : { mark: '✗ 실패', cls: 'red', ms };
}
