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
export function directorPrepBlock({ defaults = {}, consoleName = 'portal', anyClient = 'kr-fd', anyStorage = 'File', anyPool = 'VMwarePool' } = {}) {
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
    `  Storage = ${anyStorage}`,
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
  // v2.822.1(현장 실측 — 작업 로그 'Python 3.10 or newer is required (found 3.9)'): FD 의 Python 플러그인은 OS 기본 Python 으로 돈다.
  'Rocky·RHEL 9 FD(Python 3.9)는 pyVmomi 8.x 를 씁니다 — python3 -m pip install ‘pyvmomi>=8,<9’ · 9.x 는 Python 3.10 이상이 필요해 플러그인이 시작하지 못합니다(바꾼 뒤 bareos-fd 재시작).',
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

/* ───────── 자동 설정(v2.821 — 서버 bareos/autoSetup.js) ───────── */
const FILE_ACTION_LABEL = Object.freeze({ created: '새로 만듦', updated: '덮어씀(포탈 파일)', unchanged: '그대로' });

/** Director 자동 설정 성공 요약(한 줄). */
export function autoSetupDirectorText(r) {
  if (!r) return '';
  const files = (r.files || []).map((f) => `${f.path}(${FILE_ACTION_LABEL[f.action] || f.action || '—'})`).join(' · ');
  const ver = r.probe?.version ? ` ${r.probe.version}` : '';
  return `**Director 자동 설정 완료** — 새 콘솔 ‘${r.settings?.director?.consoleName || '—'}’ 로 접속 확인(Director${ver}) · 포탈 설정을 이 콘솔로 바꿨습니다. 파일: ${files || '—'}`;
}

/** FD INI 자동 설정 성공 요약(한 줄). 플러그인 패키지 판정은 참고값이다(rpm·dpkg 조회). */
export function autoSetupFdText(r) {
  if (!r) return '';
  const pk = r.plugin === 'installed' ? '플러그인 패키지 설치됨' : '플러그인 패키지를 찾지 못했습니다(bareos-vmware-plugin 설치 확인)';
  return `**FD INI 자동 설정 완료** — ${r.path || '—'}(${FILE_ACTION_LABEL[r.action] || r.action || '—'} · bareos 소유 0600) · ${pk}${r.note ? ` · ${r.note}` : ''}`;
}

/** 지문 읽기 결과(관리자가 vCenter 화면 값과 대조할 수 있게 주체·만료를 함께). */
export function thumbprintText(r) {
  if (!r?.thumbprint) return '';
  return `FD 에서 읽은 ${r.vcserver || '—'}:443 인증서 — SHA1 **${r.thumbprint}** · ${r.subject || '주체 —'} · 만료 ${r.notAfter || '—'}. vCenter 화면(또는 브라우저 인증서 정보)의 값과 같은지 확인한 뒤 실행하세요.`;
}

/* ───────── 작업 결과 요약(v2.822.3 — 작업 로그 끝의 Bareos 보고 블록을 읽는다) ───────── */
/** 보고 블록의 키 → 화면 이름. 백업·복원 보고 둘 다(Bareos dird backup.cc·restore.cc 의 보고 줄). */
export const REPORT_KEYS = Object.freeze({
  'JobId': 'jobid', 'Job': '잡', 'Backup Level': '레벨', 'Client': 'FD 클라이언트', 'FileSet': 'FileSet', 'Pool': '풀', 'Storage': '스토리지',
  'Start time': '시작', 'End time': '종료', 'Elapsed time': '소요',
  'FD Files Written': '파일(FD)', 'SD Files Written': '파일(SD)', 'FD Bytes Read': '읽은 양', 'FD Bytes Written': '보낸 양', 'SD Bytes Written': '저장한 양',
  'Files Expected': '복원 예정 파일', 'Files Restored': '복원 파일', 'Bytes Restored': '복원 양',
  'Rate': '속도', 'Software Compression': '압축', 'Encryption': '암호화', 'Volume name(s)': '볼륨', 'Last Volume Bytes': '볼륨 크기',
  'Non-fatal FD errors': 'FD 오류(비치명)', 'FD Errors': 'FD 오류', 'SD Errors': 'SD 오류',
  'FD termination status': 'FD 종료 상태', 'SD termination status': 'SD 종료 상태', 'Job triggered by': '실행 주체', 'Termination': '결과',
});
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /;
// 보고 줄은 들여쓰기 + '키:' + 공백 + 값. 키 길이를 묶어 두고 줄 길이를 먼저 자른다(외부 입력 정규식 규칙 — 선형).
const KV_RE = /^\s+([A-Za-z][A-Za-z0-9 ()/.-]{0,39}):\s+(.*)$/;
const ISSUE_RE = /\b(Warning|Error|Fatal error|ERR=)/;
const MAX_ISSUES = 30;

/** '10,223,626,211 (10.22 GB)' → 10223626211. 못 읽으면 null(0 으로 만들지 않는다). */
export function reportBytes(v) {
  const m = /^([\d,]+)/.exec(String(v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 작업 로그 줄(서버 jobLog 의 'YYYY-MM-DD HH:MM:SS 본문') → 마지막 보고 블록 요약. 순수.
 * @returns {{ found: boolean, fields: Record<string,string>, verdict: {cls:string,label:string}|null, issues: {text:string,count:number}[], issuesMore: number }}
 */
export function parseJobReport(lines = []) {
  const texts = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? '').slice(0, 600).replace(TS_RE, ''));
  let end = -1;
  for (let i = texts.length - 1; i >= 0; i--) { const m = KV_RE.exec(texts[i]); if (m && m[1] === 'Termination') { end = i; break; } }
  const fields = {};
  if (end >= 0) {
    let start = 0;
    for (let i = end; i >= 0; i--) { const m = KV_RE.exec(texts[i]); if (m && (m[1] === 'JobId' || m[1] === 'Build OS')) { start = i; break; } }
    for (let i = start; i <= end; i++) {
      const m = KV_RE.exec(texts[i]);
      if (m && Object.prototype.hasOwnProperty.call(REPORT_KEYS, m[1])) fields[m[1]] = m[2].trim();
    }
  }
  // 경고·오류 줄 — 같은 글(앞의 'bareos-sd JobId N:' 포함)은 한 번만, 몇 번 나왔는지 센다.
  const seen = new Map();
  for (const t of texts) {
    if (!ISSUE_RE.test(t)) continue;
    const kv = KV_RE.exec(t);   // 보고 블록의 'SD Errors: 0' 같은 줄은 경고가 아니다(수치는 상태 칩이 보여 준다)
    if (kv && Object.prototype.hasOwnProperty.call(REPORT_KEYS, kv[1])) continue;
    const key = t.trim();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const all = [...seen.entries()].map(([text, count]) => ({ text, count }));
  return { found: end >= 0, fields, verdict: end >= 0 ? reportVerdict(fields.Termination) : null, issues: all.slice(0, MAX_ISSUES), issuesMore: Math.max(0, all.length - MAX_ISSUES) };
}

/** 'Backup OK' · 'Backup OK -- with warnings' · 'Backup Error' · '*** Backup Error ***' · 'Backup Canceled' … → 배지. */
export function reportVerdict(t) {
  const s = String(t ?? '');
  if (!s) return { cls: 'gray', label: '—' };
  if (/cancel/i.test(s)) return { cls: 'gray', label: '취소' };
  if (/error|fatal|fail/i.test(s)) return { cls: 'red', label: '오류' };
  if (/warning/i.test(s)) return { cls: 'amber', label: '경고와 함께 성공' };
  if (/\bOK\b/.test(s)) return { cls: 'green', label: '성공' };
  return { cls: 'gray', label: '확인 불가' };
}

/** 요약 카드 — 백업은 읽은 양·저장한 양·압축·속도·소요·볼륨, 복원은 복원 양·복원 파일·속도·소요. 값이 없으면 '—'. */
export function reportCards(f = {}) {
  if (f['Bytes Restored'] !== undefined || f['Files Restored'] !== undefined) {
    return [
      { k: 'rbytes', label: '복원 양', value: bytesText(reportBytes(f['Bytes Restored'])) },
      { k: 'rfiles', label: '복원 파일', value: f['Files Restored'] || '—' },
      { k: 'rate', label: '속도', value: f.Rate || '—' },
      { k: 'elapsed', label: '소요', value: f['Elapsed time'] || '—' },
    ];
  }
  return [
    { k: 'read', label: '읽은 양(VM 디스크)', value: bytesText(reportBytes(f['FD Bytes Read'])) },
    { k: 'stored', label: '저장한 양(볼륨)', value: bytesText(reportBytes(f['SD Bytes Written'])) },
    { k: 'comp', label: '압축', value: f['Software Compression'] || '—' },
    { k: 'rate', label: '속도', value: f.Rate || '—' },
    { k: 'elapsed', label: '소요', value: f['Elapsed time'] || '—' },
    { k: 'vol', label: '볼륨', value: f['Volume name(s)'] || '—' },
  ];
}

/**
 * 자주 보는 경고·오류 줄의 뜻과 조치(현장 로그 실측 — 2026-10-30). 처음 맞는 규칙 하나만 쓴다. 모르는 줄은 해석하지 않는다(지어내지 않는다).
 */
const ISSUE_HINTS = Object.freeze([
  [/Python 3\.10 or newer is required/i, 'FD 의 pyVmomi 가 9.x 입니다 — Python 3.9 FD 는 pyVmomi 8.x 로 바꾸고 bareos-fd 를 재시작하세요.'],
  [/Permission denied/i, '저장 경로에 bareos 계정이 쓸 수 없습니다 — 폴더 소유자·NFS 권한·SELinux 를 확인하세요.'],
  [/Please mount|label a new one/i, 'SD 가 쓸 볼륨을 열지 못해 기다렸습니다 — 바로 위 줄(열기 실패 원인)을 먼저 보세요.'],
  [/Could not open|Open device .* fail/i, 'SD 가 볼륨 파일을 열지 못했습니다 — 같은 이름의 디렉터리·권한·디스크 여유를 확인하세요.'],
  [/authenticate|Authorization failed/i, '데몬 사이 인증이 실패했습니다 — 앞선 치명 오류로 잡이 취소된 연쇄일 수 있으니 첫 오류부터 보세요.'],
  [/No space left on device/i, '디스크가 가득 찼습니다 — 저장 경로와 루트(/) 여유 공간을 확인하세요.'],
  [/Overriding plugin option/i, '잡의 플러그인 옵션이 FileSet·INI 값을 덮어썼다는 안내입니다(정상 동작).'],
]);

/** 줄 → 해석 한 줄('' 이면 모름). */
export function issueHint(text) {
  const s = String(text ?? '').slice(0, 600);
  for (const [re, hint] of ISSUE_HINTS) if (re.test(s)) return hint;
  return '';
}

/** 저장 효율 — 저장한 양 / 읽은 양(0~1). 둘 중 하나라도 못 읽었으면 null. */
export function storeRatio(f = {}) {
  const read = reportBytes(f['FD Bytes Read']);
  const stored = reportBytes(f['SD Bytes Written']);
  if (read === null || stored === null || read <= 0) return null;
  return Math.max(0, Math.min(1, stored / read));
}

/** 복사용 글(메신저·티켓에 붙이기) — 값이 없으면 '—'. */
export function reportText(rep, { vmName = '', jobid = '' } = {}) {
  if (!rep?.found) return '';
  const f = rep.fields;
  const lines = [
    `[Bareos] ${vmName || '—'} · jobid ${jobid || f.JobId || '—'} · ${rep.verdict.label}`,
    `결과: ${f.Termination || '—'}`,
    `레벨: ${f['Backup Level'] || '—'} · 시작 ${f['Start time'] || '—'} · 소요 ${f['Elapsed time'] || '—'}`,
    ...reportCards(f).map((c) => `${c.label}: ${c.value}`),
    `오류: FD ${f['Non-fatal FD errors'] ?? f['FD Errors'] ?? '—'} · SD ${f['SD Errors'] ?? '—'}`,
  ];
  return lines.join('\n');
}

/** 보고 값의 장식 걷기 — '"Full" (From Job resource)' → 'Full'. 화면 표시용(복사 글·원문은 그대로). */
export function reportValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return '—';
  return s.replace(/\s*\(From [A-Za-z ]{1,40}\)$/, '').replace(/^"([^"]*)"$/, '$1') || '—';
}
