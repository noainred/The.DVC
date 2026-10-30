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

/**
 * W13(v2.822): 복원 지점 목록이 잘렸으면 밝힌다. v2.822.3(W2-6): scanned 는 서버가 **실제로 본** 실행 수, limit 는 상한 —
 * '더 오래된 지점' 문장은 상한에 닿았을 때만(예전에는 상수 60 을 보내 이력이 13건뿐이어도 그렇게 말했다).
 */
export function restorePointsNote(pts, shown) {
  const n = (pts?.items || []).length;
  const scanned = numOrNull(pts?.scanned);
  const limit = numOrNull(pts?.limit);
  const head = n > shown ? `성공한 백업 ${n}건 중 최근 ${shown}건을 보입니다.` : `성공한 백업 ${n}건.`;
  if (scanned === null) return head;
  const cut = limit !== null && scanned >= limit;
  return `${head} Director 카탈로그의 이 잡 실행 ${cut ? `최근 ${scanned}건` : `${scanned}건 전부`}에서 골랐습니다${cut ? ' — 더 오래된 지점은 Director 에서 복원하세요' : ''}.`;
}

/**
 * v2.822.3(W2-1·P2-1·P2-2·W2-4 — 반증 재현): 설정 저장은 Director 연결 중 **화면이 읽어 온 값과 달라진 칸만**(+ 입력한 비밀번호) 보낸다.
 * 예전에는 마지막으로 읽은 사본을 통째로 보내, 자동 설정이 콘솔을 바꾼 뒤(다시 읽기 실패·180초 시한·탭 이동·다른 탭) 옛 값이 되돌아가고
 * 서버 accessMoved 가 방금 만든 콘솔 비밀번호를 폐기했다. 사용자가 칸을 직접 고친 경우는 의도이므로 지금처럼 보낸다(순수 함수).
 * @param {object} formDir  화면 폼의 director(문자열 칸)
 * @param {object} snapDir  서버에서 읽어 온 director(GET /settings)
 * @returns {object|null}  보낼 칸(없으면 null — director 를 보내지 않는다)
 */
export function directorPatch(formDir = {}, snapDir = {}) {
  const cur = {
    host: String(formDir.host ?? ''), port: Number(formDir.port) || 9101, consoleName: String(formDir.consoleName ?? ''),
    timeoutMs: Number(formDir.timeoutMs) || undefined, tlsMax: formDir.tlsMax,
  };
  const out = {};
  for (const k of ['host', 'port', 'consoleName', 'timeoutMs', 'tlsMax']) {
    if (cur[k] === undefined) continue;
    if (cur[k] !== snapDir[k]) out[k] = cur[k];
  }
  // v2.824 담당 엣지('' = 중앙 직접) — 폼에 칸이 있을 때만 비교한다
  if (formDir.agent !== undefined && String(formDir.agent || '') !== String(snapDir.agent || '')) out.agent = String(formDir.agent || '');
  if (typeof formDir.password === 'string' && formDir.password) out.password = formDir.password;
  return Object.keys(out).length ? out : null;
}

/** HTTP 상태가 없는 실패(연결 끊김·브라우저 시한) — 서버는 끝까지 돌았을 수 있다(W2-2·P2-1). */
// v2.823 검토(W7): 서버가 본문으로 거부한 것(requireChanged — 409 진행 중·남의 파일 등)은 결과가 **확정**이다 — '결과 모름' 으로 감싸지 않는다.
// v2.824 검토(W5): 서버가 '결과 모름'(504 — 엣지가 가져갔지만 회신 없음)으로 답한 것도 결과 모름이다(실패로 단정하지 않는다).
export const outcomeUnknown = (e) => !e?.changeRejected && (!(Number.isInteger(e?.status) && e.status > 0) || e.status === 504);

/** 엣지 대행 Director 인가(목록 항목 — 전체 범위는 agent, 가린 목록은 relay 불리언). */
export const isRelayDir = (x) => !!(x?.agent || x?.relay);

/**
 * v2.824 검토(W3·W4): 엣지 대행 작업의 화면 시한 — 서버가 기다리는 시간(인출 대기 + 그 작업의 회신 시한, API 값) + 여유.
 * 이보다 짧으면 서버의 '보내지 않음'·'결과 모름' 사유가 화면에 오지 못하고 브라우저 시한 문구만 보였다. 값을 못 받으면 null(기본 시한).
 */
export function relayWaitMs(limits, kind, { setup = false } = {}) {
  const r = Number(limits?.resultMs?.[kind]);
  const p = Number(setup ? limits?.secretPickupMs : limits?.pickupMs);
  return Number.isFinite(r) && r > 0 && Number.isFinite(p) && p > 0 ? p + r + 15_000 : null;
}
/** 밀리초 → '2분' · '45초' · '1분 30초'(API 값을 문구로 — 숫자를 화면에 박지 않는다 · W9). 못 읽으면 '—'. */
export function secText(ms) {
  const n = numOrNull(ms);   // Number(null)===0 함정 — 못 읽은 값은 '0초' 가 아니라 '—'
  if (n === null || n < 0) return '—';
  const sec = Math.round(n / 1000);
  const m = Math.floor(sec / 60); const r = sec % 60;
  return m ? `${m}분${r ? ` ${r}초` : ''}` : `${r}초`;
}
/** v2.824.1 버그 점검(G12): 쓰기 범위(수정 가능 vCenter)가 지정된 계정 — 서버는 403 으로 막는다. 화면은 미리 잠그고 이 사유를 말한다. */
export const READ_ONLY_TARGET = '이 대상의 vCenter 는 이 계정의 쓰기 범위 밖입니다 — 조회만 할 수 있습니다.';
export const SETTINGS_READ_ONLY = '이 계정은 쓰기 범위(수정 가능 vCenter)가 지정돼 Bareos 설정(전 법인 공용)을 바꿀 수 없습니다 — 조회만 합니다.';

/**
 * 백업 대상 행 버튼의 잠금 사유(G12·G13 — 잠긴 버튼은 사유를 말한다). 빈 문자열이면 잠기지 않았다.
 * @param {{ writable?: boolean, enabled?: boolean }} j 목록 응답의 대상(writable 은 서버가 준다 — 없으면 막지 않는다)
 * @param {{ busy?: boolean, running?: boolean, hasRun?: boolean }} o
 */
export function targetLocks(j, { busy = false, running = false, hasRun = false } = {}) {
  const ro = j?.writable === false ? READ_ONLY_TARGET : '';
  const b = busy ? '이 대상의 다른 요청을 처리 중입니다.' : '';
  const r = running ? '실행 중에는 바꿀 수 없습니다 — 끝나거나 취소한 뒤에 하세요.' : '';
  return {
    run: ro || b || (j?.enabled ? '' : '비활성 대상은 실행할 수 없습니다 — 먼저 활성으로 바꾸세요.'),
    cancel: ro || b,
    view: hasRun ? '' : '아직 실행 기록이 없습니다.',
    restore: ro || b,
    toggle: ro || b || r,
    remove: ro || b || r,
  };
}

/** 엣지 대행 작업 종류 → 화면 이름(영문 키를 그대로 보이지 않게 · Chromium 확인). 모르는 종류는 '작업'. */
const RELAY_KIND_LABEL = Object.freeze({
  probe: '연결 시험', catalog: '카탈로그', addJobs: '대상 등록', disableJobs: '잡 끄기', runJob: '백업 실행', setEnabled: '켜기·끄기', history: '이력',
  cancel: '취소', log: '로그', restore: '복원', poll: '상태 조회', 'setup.preflight': '자동 설정 점검', 'setup.director': '자동 설정 2단계',
  'setup.fdPlugin': '자동 설정 FD 플러그인', 'setup.fdIni': '자동 설정 FD INI', 'setup.thumbprint': '자동 설정 지문 읽기',
});
export const relayKindLabel = (k) => RELAY_KIND_LABEL[k] || '작업';
/** 기본 요청 옵션에 엣지 대행 시한을 얹는다(더 길 때만). */
export function withRelayWait(opts, dir, limits, kind, o) {
  const t = isRelayDir(dir) ? relayWaitMs(limits, kind, o) : null;
  return t && t > (opts?.timeoutMs || 0) ? { ...opts, timeoutMs: t } : opts;
}
/** 결과를 모르는 변경(브라우저 시한·504)의 문구 — 실패로 단정하지 않고 확인 뒤 다시 하라고 말한다. */
export const unknownOutcomeText = (what, e) => `${what} 결과를 확인하지 못했습니다 — 이미 시작됐을 수 있습니다. 목록·이력(또는 Director)에서 확인한 뒤 다시 시도하세요.${e?.message ? ` (${String(e.message).slice(0, 300)})` : ''}`;

/** 자동 설정 버튼이 잠긴 사유(W2-8 — 잠긴 버튼은 사유를 말한다). 비어 있으면 잠기지 않았다. */
export function missingText(pairs) {
  const miss = pairs.filter(([ok]) => !ok).map(([, label]) => label);
  return miss.length ? `필요: ${miss.join(' · ')}` : '';
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

/**
 * Director 하나의 상태 배지(v2.823 법인별 Director) — 설정 덜 됨 · 인증 정지 · 조회 실패 · 정상 · 조회 전.
 * @param {{ configured?, authStopped?, poll? }} dir  목록 응답의 directors[] 한 항목
 */
export function directorStatus(dir) {
  if (!dir) return { cls: 'gray', label: '—' };
  if (!dir.configured) return { cls: 'gray', label: '설정 덜 됨' };
  if (dir.authStopped) return { cls: 'red', label: '인증 정지' };
  // v2.824 엣지 대행: 회신을 기다리는 동안(한 번도 결과가 없으면) '엣지 대행 중' — 지난 결과가 있으면 그것을 보인다
  if ((dir.poll?.relay === 'sent' || dir.poll?.relay === 'pending') && dir.poll?.ok == null) return { cls: 'blue', label: '엣지 대행 중' };
  if (dir.poll?.ok === false) return { cls: 'red', label: '조회 실패' };
  if (dir.poll?.ok) return { cls: 'green', label: '정상' };
  return { cls: 'gray', label: '조회 전' };
}

/** Director 칩 설명(title) — 조회 실패 사유 · 인증 정지 · 엣지 대행 대기(W7). 없으면 ''. */
export function directorChipTitle(x) {
  if (x?.poll?.error) return x.poll.error;
  if (x?.authStopped) return `인증 정지 — ${x.authStopped.reason || ''}`;
  if (directorStatus(x).label === '엣지 대행 중') return x.agent ? `법인 엣지 ‘${x.agent}’ 가 대신 조회하고 있습니다 — 회신을 기다리는 중` : '법인 엣지가 대신 조회하고 있습니다 — 회신을 기다리는 중';
  return '';
}

/** 머리 상태 줄(법인별 Director 요약 · 폴러). */
export function directorLine(d) {
  if (!d) return '';
  if (d.demo) return '데모 Director(합성 응답 — 어디에도 접속하지 않습니다). 설정 › 법인별 Director 에서 실제 Director 를 추가하면 그쪽으로 바뀝니다.';
  if (!d.configured) {
    const n = Array.isArray(d.directors) ? d.directors.length : 0;
    // Chromium 확인: Director 를 추가한 뒤에도 '추가하고' 라고 말했다 — 있으면 '접속값이 덜 됐다' 로
    return n
      ? `법인 Director ${n}개 — 아직 콘솔 접속값(콘솔 이름·비밀번호)을 갖춘 Director 가 없습니다. 설정 › 법인별 Director 편집에서 자동 설정 2단계(또는 연결 저장)로 채우세요.`
      : 'Director 가 설정되지 않았습니다 — 설정 › 법인별 Director 에서 법인 Director 를 추가하고 주소·콘솔 이름·비밀번호를 등록하세요.';
  }
  const list = Array.isArray(d.directors) ? d.directors : [];
  const st = list.map(directorStatus);
  const n = (label) => st.filter((x) => x.label === label).length;
  const parts = [`법인 Director ${list.length}개`];
  if (n('정상')) parts.push(`정상 ${n('정상')}`);
  if (n('조회 실패')) parts.push(`**조회 실패 ${n('조회 실패')}**`);
  if (n('인증 정지')) parts.push(`**인증 정지 ${n('인증 정지')}**(주기 조회를 멈췄습니다 — 설정을 고치면 다시 시작합니다)`);
  if (n('설정 덜 됨')) parts.push(`설정 덜 됨 ${n('설정 덜 됨')}`);
  // v2.824 검토(W6): 회신을 기다리는 대행·아직 조회 전도 센다(요약 칸의 합이 Director 수와 맞게)
  if (n('엣지 대행 중')) parts.push(`엣지 대행 중 ${n('엣지 대행 중')}`);
  if (n('조회 전')) parts.push(`조회 전 ${n('조회 전')}`);
  const masked = list.some((x) => x.masked) ? ' · 주소·콘솔 이름은 전체 범위 관리자만 봅니다' : '';
  const p = d.poller || {};
  const when = p.at ? ` · 상태 조회 ${whenText(p.at)}${p.idle ? '(진행 중 실행 없음)' : ''} · ${d.defaults?.pollIntervalSec || '—'}초 주기` : ' · 상태 조회 대기 중';
  return `${parts.join(' · ')}${when}${masked}`;
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
export const VMWARE_POOL_FULL = 'PortalVmwareFull';
export const VMWARE_POOL_INCR = 'PortalVmwareIncr';
export const VMWARE_SCHEDULE = 'PortalVmwareNightly';
export const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
export const WEEKDAY_LABEL = Object.freeze({ sun: '일요일', mon: '월요일', tue: '화요일', wed: '수요일', thu: '목요일', fri: '금요일', sat: '토요일' });

/**
 * Director 에 1회 넣을 사전 준비 블록(설정 화면 복사용). v2.823: 풀(pools)·스케줄(schedule)을 고르면 그 블록도 — 서버 autoSetup.directorResources 와
 * 글자까지 같다(bareosAutoSetup·bareosCorp2823 시험이 대조 — 한쪽만 고치지 말 것).
 */
export function directorPrepBlock({ defaults = {}, consoleName = 'portal', anyClient = 'kr-fd', anyStorage = 'File', anyPool = 'VMwarePool', pools = null, schedule = null } = {}) {
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
    ...(pools ? [`  Full Backup Pool = "${VMWARE_POOL_FULL}"`, `  Differential Backup Pool = "${VMWARE_POOL_INCR}"`, `  Incremental Backup Pool = "${VMWARE_POOL_INCR}"`] : []),
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
    ...(pools ? [VMWARE_POOL_FULL, VMWARE_POOL_INCR].flatMap((name) => [
      `Pool {`, `  Name = "${name}"`, `  Pool Type = Backup`, `  Recycle = yes`, `  AutoPrune = yes`,
      `  Volume Retention = ${name === VMWARE_POOL_FULL ? pools.fullDays : pools.incrDays} days`, `  Maximum Volume Bytes = ${pools.maxVolumeGB}G`, `  Label Format = "${name}-"`, `}`,
    ]) : []),
    ...(schedule ? [`Schedule {`, `  Name = "${VMWARE_SCHEDULE}"`, `  Run = Full ${schedule.fullDay} at ${schedule.time}`,
      ...WEEKDAYS.filter((x) => x !== schedule.fullDay).map((x) => `  Run = Incremental ${x} at ${schedule.time}`), `}`] : []),
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
  // v2.822.3(S2-3 — 반증 확인): 잡을 만들려면 configure 가 필요하고 Bareos 에는 그 하위 명령·리소스 단위 ACL 이 없다 — 숨기지 않고 알린다
  '포탈 콘솔(Profile portal)은 잡을 만들려고 configure 를 쓰므로 사실상 Director 관리자 등급입니다(모든 FD 에 root 로 닿는다) — 콘솔 비밀번호를 그 등급으로 지키세요.',
  // v2.822.3(W2-7): 셸에 붙여 넣는 명령은 ASCII 작은따옴표 — 굽은 따옴표(‘ ’)는 셸이 따옴표로 보지 않아 > · < 가 리다이렉트가 됐다
  "Rocky·RHEL 9 FD(Python 3.9)는 pyVmomi 8.x 를 씁니다 — python3 -m pip install 'pyvmomi>=8,<9' · 9.x 는 Python 3.10 이상이 필요해 플러그인이 시작하지 못합니다(바꾼 뒤 bareos-fd 재시작).",
  'FD 의 Client 리소스에 Plugin Names = python3 · Plugin Directory 가 있어야 합니다 — 편집 화면 자동 설정 3단계 ‘FD 플러그인 켜기’ 가 넣습니다(다른 값이 이미 있으면 덮지 않습니다).',
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
  return `**Director 자동 설정 완료** — 새 콘솔 ‘${r.director?.consoleName || r.settings?.director?.consoleName || '—'}’ 로 접속 확인(Director${ver}) · 이 법인 Director 의 포탈 설정을 이 콘솔로 바꿨습니다. 파일: ${files || '—'}`;
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

/* ───────── v2.823 법인별 Director — 자동 설정 단계 · 매핑 채움 ───────── */

/** 사전 점검 항목의 표시(서버 autoSetup.parsePreflight 의 status). 못 읽은 것은 '확인 불가'(없음으로 단정하지 않는다). */
export const PREFLIGHT_LABEL = Object.freeze({ ok: { mark: '✓', cls: 'green' }, missing: { mark: '✗ 없음', cls: 'red' }, warn: { mark: '! 확인', cls: 'amber' }, unknown: { mark: '? 확인 불가', cls: 'gray' } });
export const preflightView = (st) => PREFLIGHT_LABEL[st] || PREFLIGHT_LABEL.unknown;

/** 사전 점검 요약 한 줄. */
export function preflightSummary(r) {
  const items = Array.isArray(r?.items) ? r.items : [];
  if (!items.length) return '';
  const c = (k) => items.filter((x) => x.status === k).length;
  return `점검 ${items.length}항목 — 정상 ${c('ok')} · 없음 ${c('missing')} · 확인 필요 ${c('warn')} · 확인 불가 ${c('unknown')}`;
}

/** FD 플러그인 켜기 결과 한 줄. */
export function autoSetupFdPluginText(r) {
  if (!r) return '';
  if (r.action === 'unchanged') return `**FD 플러그인은 이미 켜져 있습니다** — 바꾸지 않았습니다(플러그인 경로 ${r.pluginDir || '—'}).`;
  return `**FD 플러그인 켜기 완료** — ${(r.added || []).join(' · ') || '—'} 를 넣고 bareos-fd 를 다시 시작했습니다. 쓰기 전 사본: ${r.backup || '—'}`;
}

/** 매핑 칸 → 화면 이름(제안 표시). */
export const MAPPING_FIELDS = Object.freeze([['vcserver', 'vcserver'], ['client', 'FD client'], ['storage', 'SD storage'], ['pool', 'Pool'], ['schedule', 'Schedule'], ['configFile', 'FD INI 경로']]);

/**
 * 매핑 채움 — 서버 제안(suggestions[].fields[k].value)으로 **빈 칸만** 채운다(순수). 사람이 넣은 값은 덮지 않는다.
 * @returns {{ sites: object[], filled: number, left: string[] }} left = 제안이 없어 비어 남은 칸(화면 이름 'vCenter · 칸')
 */
export function fillEmptyMapping(sites = [], suggestions = [], vcName = (id) => id) {
  const by = new Map((suggestions || []).map((x) => [x.vcenterId, x.fields || {}]));
  let filled = 0;
  const left = [];
  const out = sites.map((s) => {
    const f = by.get(s.vcenterId);
    if (!f) {
      // v2.823 검토(W2): 제안은 **저장된** 매핑에만 온다 — 체크만 하고 저장하지 않은 vCenter 는 이유와 함께 남긴다('0개 채움' 만 말하지 않게)
      if (MAPPING_FIELDS.some(([k]) => k !== 'schedule' && !s[k])) left.push(`${vcName(s.vcenterId)}(저장 전 — 매핑을 저장한 뒤 다시 채우세요)`);
      return s;
    }
    const next = { ...s };
    for (const [k, label] of MAPPING_FIELDS) {
      if (next[k]) continue;
      const v = f[k]?.value;
      if (typeof v === 'string' && v) { next[k] = v; filled += 1; } else if (k !== 'schedule') left.push(`${vcName(s.vcenterId)} · ${label}`);
    }
    return next;
  });
  return { sites: out, filled, left };
}

/** INI 경로·잡 이름에 쓰는 vCenter 조각(서버 bareosBackup.js suggestMapping 과 같은 규칙). */
export const vcSlug = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vcenter';

/**
 * 새로 묶는 vCenter 의 매핑 행(v2.823 검토 W2 — 순수). vcserver 는 vCenter 등록부 주소, INI 경로는 vCenter 조각 —
 * 같은 경로가 이미 있으면(다른 vCenter 가 같은 조각) 접미사를 붙인다(FD INI 가 서로 덮지 않게 — 검토 C7).
 */
export function newMappingRow(vcenterId, directorId, host = '', taken = []) {
  const used = new Set(taken.filter(Boolean));
  const stem = `/etc/bareos/vmware/${vcSlug(vcenterId)}`;
  let configFile = `${stem}.ini`;
  for (let i = 2; used.has(configFile) && i < 100; i++) configFile = `${stem}-${i}.ini`;
  return { vcenterId, directorId, vcserver: /^[A-Za-z0-9.-]+$/.test(host) ? host : '', client: '', storage: '', pool: '', schedule: '', configFile };
}

/**
 * Director 하나의 접속 폼에서 달라진 칸(이름 포함). directorPatch 와 같은 규칙에 법인 이름을 더한다(순수).
 * @returns {object|null}
 */
export function directorFormPatch(form = {}, snap = {}) {
  const p = directorPatch(form, snap) || {};
  const name = String(form.name ?? '').trim();
  if (name && name !== snap.name) p.name = name;
  return Object.keys(p).length ? p : null;
}
