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
/** v2.825.1 버그 점검(G12): 쓰기 범위(수정 가능 vCenter)가 지정된 계정 — 서버는 403 으로 막는다. 화면은 미리 잠그고 이 사유를 말한다. */
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

/**
 * 바이트 → 사람이 읽는 크기. 못 읽은 값은 '—'(0 이 아니다).
 * v2.828: Bareos 보고서와 같은 10진 단위(decBytesText 하나로) — 예전에는 1024 로 나누고 'GB' 를 붙여 목록·이력·복원 지점은 177 GB,
 *   Bareos 보고서는 190.4 GB 로 같은 실행이 다르게 보였다(현장 JobId 13).
 */
export function bytesText(v) {
  return decBytesText(v);
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
    `  Command ACL = .api, .jobs, .clients, .storages, .pools, .schedules, .jobdefs, .filesets, .bvfs_get_jobids, configure, run, restore, llist, list, cancel, enable, disable, delete, status, version, !*all*`,
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
  'Scheduled time': '예약', 'Start time': '시작', 'End time': '종료', 'Elapsed time': '소요',
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
/** 실패 보고 블록의 머리줄 'Error: Bareos bareos-dir 25.1.2 (…):' — 보고 블록의 제목이지 오류 한 건이 아니다(버그 점검 W5 — 오류 목록에 한 건 더 셌다). */
const REPORT_HEAD_RE = /^(?:\S{1,80} JobId \d{1,12}: )?(?:Error|Warning): Bareos \S{1,80} \d/;
const MAX_ISSUES = 30;

/** '10,223,626,211 (10.22 GB)' → 10223626211. 못 읽으면 null(0 으로 만들지 않는다). */
export function reportBytes(v) {
  const m = /^(\d[\d,]{0,30})/.exec(String(v ?? '').trim());   // v2.828: 숫자로 시작해야 한다 — ',' 만 있으면 Number('') 가 0 이 되던 함정
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
    if (REPORT_HEAD_RE.test(t.slice(0, 200))) continue;
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
  // v2.828: 크기는 Bareos 보고서와 같은 10진 단위(예전 bytesText 는 1024 로 나누고 'GB' 를 붙여 622.5 GB 가 580 GB 로 보였다).
  const read = reportBytes(f['FD Bytes Read']);
  const stored = reportBytes(f['SD Bytes Written']);
  const vols = volumeNames(f['Volume name(s)']);
  const ratio = storeRatio(f);
  const rate = rateText(f.Rate);
  const from = clockOf(f['Start time']);
  const to = clockOf(f['End time']);
  return [
    { k: 'read', label: '읽은 양(VM 디스크)', value: reportSizeText(f['FD Bytes Read']), meta: read === null ? '' : `${read.toLocaleString('en-US')} B` },
    { k: 'stored', label: '저장한 양(볼륨)', value: reportSizeText(f['SD Bytes Written']), meta: stored === null ? '' : `${stored.toLocaleString('en-US')} B${vols.length ? ` · 볼륨 ${vols.length}개` : ''}` },
    { k: 'comp', label: '압축', value: f['Software Compression'] || '—', meta: ratio === null ? '' : `저장 ${pctText(ratio)} · 절감 ${decBytesText(read - stored)}` },
    { k: 'rate', label: '속도', value: rate, meta: f.Rate && rate !== f.Rate ? f.Rate : '' },
    { k: 'elapsed', label: '소요', value: elapsedKo(f['Elapsed time']), meta: from && to ? `${from} → ${to}` : '' },
    { k: 'vol', label: '볼륨', value: vols.length ? `${vols.length}개` : '—', meta: vols.join(' · ') },
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
  [/is not CBT enabled, enabling it now/i, 'VM 에 CBT(변경 블록 추적)가 꺼져 있어 플러그인이 켰습니다 — 문구는 Error 지만 작업은 계속됩니다. 다음 실행부터 바뀐 블록만 읽을 수 있습니다.'],
]);

/**
 * v2.828 경고·오류 줄의 색 — 'info'(문구에 Error 가 있어도 플러그인이 스스로 처리하고 계속한 안내) · 'err' · 'warn'.
 * 안내로 내리는 것은 아는 줄만(INFO_ISSUES). 모르는 Error 줄은 오류 그대로 둔다(낮춰 단정하지 않는다).
 */
const INFO_ISSUES = Object.freeze([/is not CBT enabled, enabling it now/i]);
export function issueTone(text) {
  const s = String(text ?? '').slice(0, 600);
  if (INFO_ISSUES.some((re) => re.test(s))) return 'info';
  if (/Fatal error|\bError\b|ERR=/i.test(s) && !/^.{0,80}Warning/i.test(s)) return 'err';
  return 'warn';
}
export const ISSUE_TONE_LABEL = Object.freeze({ info: '안내', warn: '경고', err: '오류' });

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

/* ───────── v2.828 작업 결과 상세 — 크기·속도·소요 표기 · 로그 줄 분류 · 세부(TLS·장치·볼륨·백업 항목) · 타임라인 ─────────
 * 모두 순수 함수. 입력은 서버 jobLog 의 줄('YYYY-MM-DD HH:MM:SS 본문') — 외부 입력이라 줄마다 길이를 먼저 자르고 정규식은 선형만 쓴다.
 * 로그 시각은 Director 현지 시각(시간대 없음)이다 — 빼기(소요·대기)에만 쓰고 KST 로 바꾸지 않는다. */

const DEC_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
/**
 * 바이트 → 10진 단위(1 GB = 10^9 B) · 앞 4자리에서 **버림**(622.5 GB · 31.93 GB · 5.833 GB). 못 읽으면 '—'.
 * Bareos 보고서 괄호 값(edit_uint64_with_suffix — 쉼표 표기의 앞 5글자)과 같은 규칙이다: 190,492,305,747 → 190.4 GB.
 * 반올림하면 190.5 GB 가 되어 같은 창의 카드(보고서 괄호 값 그대로)와 0.1 씩 어긋났다(v2.828 Chromium 확인).
 * 정수 나눗셈만 쓴다 — 버림이라 1000 으로 올라가는 경우도 없다.
 */
export function decBytesText(v) {
  const n0 = numOrNull(v);
  if (n0 === null || n0 < 0) return '—';
  const n = Math.floor(n0);
  let p = 1; let i = 0;
  while (n >= p * 1000 && i < DEC_UNITS.length - 1) { p *= 1000; i++; }
  if (i === 0) return `${n} B`;
  const whole = Math.floor(n / p);
  const d = whole >= 100 ? 1 : whole >= 10 ? 2 : 3;
  const scale = 10 ** d;
  const kept = Math.floor(n / (p / scale));   // p/scale 는 정수(p ≥ 1000 · scale ≤ 1000)
  return `${Math.floor(kept / scale)}.${String(kept % scale).padStart(d, '0')} ${DEC_UNITS[i]}`;
}

/**
 * 보고서 크기 값 '622,513,630,072 (622.5 GB)' → '622.5 GB'. 바이트 수에서 decBytesText 로 계산한다 — Bareos 괄호 값과 같은 규칙이라
 * 실제 보고서에서는 괄호 값과 같고(테스트가 JobId 13 원본의 모든 크기 줄로 대조), 같은 창의 효율 막대·이력 표와 한 함수로 맞물린다. 못 읽으면 '—'.
 */
export function reportSizeText(v) {
  return decBytesText(reportBytes(String(v ?? '').trim().slice(0, 120)));
}

/** 보고서 Rate '124342.2 KB/s' → '124.3 MB/s'(Bareos 의 KB 는 1000 B). 모르는 모양은 원문 그대로, 없으면 '—'. */
export function rateText(v) {
  const s = String(v ?? '').trim().slice(0, 40);
  if (!s) return '—';
  const m = /^(\d{1,12}(?:\.\d{1,3})?) KB\/s$/.exec(s);
  if (!m) return s;
  const kb = Number(m[1]);
  // 10GbE 백업(초당 1.2 GB 등)이 '1200.0 MB/s' 로 보이지 않게 · 버그 점검 W6: 반올림 뒤 1000 이 되면(999,950 KB/s → '1000.0 MB/s') 다음 단위로
  if (kb >= 1e6 || Number((kb / 1000).toFixed(1)) >= 1000) return `${(kb / 1e6).toFixed(2)} GB/s`;
  return kb >= 1000 ? `${(kb / 1000).toFixed(1)} MB/s` : `${kb} KB/s`;
}

/** 보고서 Elapsed time '1 hour 12 mins 24 secs' → '1시간 12분 24초'. 모르는 모양은 원문, 없으면 '—'. */
export function elapsedKo(v) {
  const s = String(v ?? '').trim().slice(0, 80);
  if (!s) return '—';
  const unit = { year: '년', month: '개월', day: '일', hour: '시간', min: '분', sec: '초' };   // 버그 점검 W6: 30일 넘는 잡의 month·year 를 버렸다
  const parts = [];
  for (const m of s.matchAll(/(\d{1,6}) (year|month|day|hour|min|sec)s?\b/g)) parts.push(`${Number(m[1])}${unit[m[2]]}`);
  return parts.length ? parts.join(' ') : s;
}

/** 초 → '15분 46초' · '41초' · '1시간 2분' · '2일 3시간'. 못 읽거나 음수면 '—'. */
export function durKo(sec) {
  const n = numOrNull(sec);
  if (n === null || n < 0) return '—';
  const t = Math.round(n);
  const d = Math.floor(t / 86400); const h = Math.floor((t % 86400) / 3600); const m = Math.floor((t % 3600) / 60); const s = t % 60;
  if (d) return `${d}일${h ? ` ${h}시간` : ''}`;
  if (h) return `${h}시간${m ? ` ${m}분` : ''}`;
  if (m) return `${m}분${s ? ` ${s}초` : ''}`;
  return `${s}초`;
}

/** 0~1 → '30.6%'. 못 읽으면 '—'. */
export function pctText(r) {
  const n = numOrNull(r);
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** 'Full-0010|Full-0011' → ['Full-0010', 'Full-0011']. 없으면 []. */
export function volumeNames(v) {
  return String(v ?? '').slice(0, 600).split('|').map((x) => x.trim()).filter(Boolean).slice(0, 100);
}

/** '30-Oct-2026 22:30:21' · '2026-10-30 22:30:21' → '22:30:21'. 없으면 ''. */
export function clockOf(v) {
  const m = /(\d{2}:\d{2}:\d{2})/.exec(String(v ?? '').slice(0, 60));
  return m ? m[1] : '';
}

const MON = Object.freeze({ Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 });
/**
 * Director 현지 시각 글 → 초(시간대 없는 값끼리 빼기 전용 — 절대 시각으로 쓰지 말 것). 못 읽으면 null.
 * 받는 모양: '2026-10-30 22:30:21'(로그 줄) · '30-Oct-2026 22:30:21'(보고 블록).
 */
export function clockSec(v) {
  const s = String(v ?? '').trim().slice(0, 40);
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  m = /^(\d{1,2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (m && MON[m[2]] !== undefined) return Date.UTC(+m[3], MON[m[2]], +m[1], +m[4], +m[5], +m[6]) / 1000;
  return null;
}

const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /;
const LOG_WHO_RE = /^([A-Za-z0-9._-]{1,80})-(dir|sd|fd) JobId \d{1,12}: /;
// 버그 점검 W4: Bareos 는 데몬 이름에 -dir/-sd/-fd 를 강제하지 않는다(패키지 기본 이름만 따른다) — 관례를 안 따르는 이름이면 종류를 'dmn'(데몬)으로 두고
//   데몬 줄로는 읽는다(예전에는 who 가 비어 세부·타임라인이 통째로 비었다). 종류 거르기는 관례 이름에만 맞는다.
const LOG_DAEMON_RE = /^([A-Za-z0-9._-]{1,80}) JobId \d{1,12}: /;
const ERR_KEYS = new Set(['Non-fatal FD errors', 'FD Errors', 'SD Errors']);
export const LOG_WHO_LABEL = Object.freeze({ dir: 'Director', sd: 'SD', fd: 'FD', dmn: '데몬', rep: '보고' });

/**
 * 로그 한 줄 → { date, time, who: 'dir'|'sd'|'fd'|'rep'|'', host, text, level: 'plain'|'info'|'warn'|'err'|'ok' }.
 * who: 'xxx-dir JobId N:' 머리말의 데몬, 머리말 없이 들여쓴 '키: 값' 은 보고 블록('rep').
 * level: 경고·오류 문구는 issueTone · 보고 블록은 Termination 판정과 오류 수(>0 이면 경고) · 그 밖은 'plain'.
 */
export function classifyLogLine(line) {
  const raw = String(line ?? '').slice(0, 2000);
  const tm = LOG_TS_RE.exec(raw);
  const body = tm ? raw.slice(tm[0].length) : raw;
  const wm0 = LOG_WHO_RE.exec(body);
  const wm = wm0 || LOG_DAEMON_RE.exec(body);
  const head = body.slice(0, 600);
  const kv = wm ? null : KV_RE.exec(head);
  const who = wm0 ? wm0[2] : wm ? 'dmn' : (kv ? 'rep' : '');
  const text = wm ? body.slice(wm[0].length) : body;
  let level = 'plain';
  if (kv) {
    if (kv[1] === 'Termination') {
      const cls = reportVerdict(kv[2].trim()).cls;
      level = cls === 'green' ? 'ok' : cls === 'red' ? 'err' : cls === 'amber' ? 'warn' : 'plain';
    } else if (ERR_KEYS.has(kv[1])) {
      const n = reportBytes(kv[2]);
      level = n !== null && n > 0 ? 'warn' : 'plain';
    } else if (/termination status$/.test(kv[1]) && /Fatal|Error/i.test(kv[2])) {
      level = 'err';   // 버그 점검 W5: 'FD termination status: Fatal Error' 를 색 없이 두었다
    }
  } else if (ISSUE_RE.test(text.slice(0, 600))) {
    level = issueTone(text);
  }
  return { date: tm ? tm[1] : '', time: tm ? tm[2] : '', who, host: wm ? wm[1] : '', text, level };
}

/** 검색어 강조 — 처음 맞는 곳 하나를 [앞, 맞은 글, 뒤] 로(대소문자 무시). 검색어가 없거나 안 맞으면 [글, '', '']. */
export function splitHit(text, q) {
  const s = String(text ?? '');
  const k = String(q ?? '').trim().slice(0, 100);
  if (!k) return [s, '', ''];
  const i = s.toLowerCase().indexOf(k.toLowerCase());
  return i < 0 ? [s, '', ''] : [s.slice(0, i), s.slice(i, i + k.length), s.slice(i + k.length)];
}

/** 원문 로그 거르기 — who('all'|'dir'|'sd'|'fd'|'rep') · 경고·오류만 · 검색어(대소문자 무시). 줄 번호(n)는 원래 순서. */
export function filterLogLines(rows, { who = 'all', issuesOnly = false, q = '' } = {}) {
  const k = String(q ?? '').trim().slice(0, 100).toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (who === 'all' || r.who === who)
    && (!issuesOnly || r.level === 'warn' || r.level === 'err' || r.level === 'info')
    && (!k || r.text.toLowerCase().includes(k)));
}

const ITEM_RE = /^python3-fd-mod: Starting backup of (\/\S.{0,500})$/;
const VOL_RE = Object.freeze({
  created: /^(?:Created new Volume|Labeled new Volume) "([^"]{1,128})"/,
  moving: /^Moving to end of data on volume "([^"]{1,128})"/,
  mounted: /^New volume "([^"]{1,128})" mounted/,
  full: /^End of medium on Volume "([^"]{1,128})" Bytes=([\d,]{1,25})/,
});

/**
 * 로그 → 세부. 못 읽은 것은 null·빈 배열(0·'없음' 으로 단정하지 않는다).
 * @returns {{ tls: {text:string,n:number}[], device: {name:string,path:string}|null, capacity: number|null,
 *   volumes: {name:string,created:boolean,firstAt:string,mountedAt:string,fullAt:string,fullBytes:number|null}[],
 *   items: {path:string,name:string,kind:'disk'|'config'|'other'}[], itemDir: string, vsphere: string, cbt: boolean, snapshotAt: string }}
 */
export function parseJobDetail(lines = []) {
  const tls = new Map();
  const vols = new Map();
  const items = new Map();
  const out = { tls: [], device: null, capacity: null, volumes: [], items: [], itemDir: '', vsphere: '', cbt: false, snapshotAt: '' };
  const vol = (name, at) => { if (!vols.has(name)) vols.set(name, { name, created: false, firstAt: at, mountedAt: '', fullAt: '', fullBytes: null }); return vols.get(name); };
  for (const line of Array.isArray(lines) ? lines : []) {
    const c = classifyLogLine(line);
    if (!c.who || c.who === 'rep') continue;
    const t = c.text.slice(0, 600);
    let m;
    if ((m = /encryption: ([A-Z0-9_]{3,80}) (TLSv[0-9.]{1,6})/.exec(t))) { const k = `${m[1]} · ${m[2]}`; tls.set(k, (tls.get(k) || 0) + 1); }
    if (!out.device && (m = /^Using Device "([^"]{1,120})" \(([^()]{1,200})\) to write/.exec(t))) out.device = { name: m[1], path: m[2] };
    if ((m = /maximum volume capacity ([\d,]{1,25}) exceeded/.exec(t))) out.capacity = reportBytes(m[1]);
    if ((m = VOL_RE.created.exec(t))) vol(m[1], c.time).created = true;
    else if ((m = VOL_RE.moving.exec(t))) vol(m[1], c.time);
    else if ((m = VOL_RE.mounted.exec(t))) { const v = vol(m[1], c.time); if (!v.mountedAt) v.mountedAt = c.time; }
    else if ((m = VOL_RE.full.exec(t))) { const v = vol(m[1], c.time); v.fullAt = c.time; v.fullBytes = reportBytes(m[2]); }
    if ((m = ITEM_RE.exec(t)) && items.size < 200) {
      const p = m[1].trim();
      if (!items.has(p)) items.set(p, p);
    }
    if (!out.vsphere && (m = /Successfully connected to VSphere API on host ([A-Za-z0-9.:_-]{1,253})/.exec(t))) out.vsphere = m[1];
    if (/is not CBT enabled, enabling it now/i.test(t)) out.cbt = true;
    if (!out.snapshotAt && /^python3-fd-mod: Cleaning up snapshot /.test(t)) out.snapshotAt = c.time;
  }
  out.tls = [...tls.entries()].map(([text, n]) => ({ text, n }));
  out.volumes = [...vols.values()];
  const paths = [...items.values()];
  if (paths.length) {
    // 항목들의 공통 앞부분(VM 폴더)을 떼어 이름만 보인다 — 디스크 경로에는 '[데이터스토어] VM/디스크' 처럼 '/' 가 더 있으므로 마지막 '/' 기준이 아니다.
    let pre = paths[0];
    for (const p of paths.slice(1)) { let i = 0; while (i < pre.length && i < p.length && pre[i] === p[i]) i++; pre = pre.slice(0, i); }
    const cut = pre.lastIndexOf('/');
    out.itemDir = cut >= 0 ? pre.slice(0, cut + 1) : '';
    out.items = paths.map((p) => {
      const name = p.slice(out.itemDir.length) || p;
      const kind = /^vm_(config|info|meta)/i.test(name) ? 'config' : (/^\[|\.vmdk$/i.test(name) ? 'disk' : 'other');
      return { path: p, name, kind };
    });
  }
  return out;
}

/**
 * 타임라인 — 보고 블록(예약·시작·종료)과 로그 줄(연결·vSphere·CBT·첫 항목·볼륨 가득 참·오류·스냅샷 정리·장치 해제).
 * 시각은 Director 현지 그대로(HH:MM:SS) · 간격은 clockSec 끼리 뺀다(날짜를 넘겨도 맞다). 못 읽은 단계는 넣지 않는다.
 * @returns {{ steps: {at:string,sec:number,title:string,sub:string,tone:string}[], segs: {k:string,label:string,sec:number}[],
 *   waitSec: number|null, runSec: number|null }}
 */
export function jobTimeline(lines = [], fields = {}) {
  const steps = [];
  const add = (sec, at, title, sub, tone = 'plain') => { if (sec !== null) steps.push({ sec, at, title, sub: String(sub || '').slice(0, 300), tone }); };
  const schedSec = clockSec(fields['Scheduled time']);
  const startRep = clockSec(fields['Start time']);
  const endRep = clockSec(fields['End time']);
  add(schedSec, clockOf(fields['Scheduled time']), '예약', fields.Job ? `잡 ${fields.Job}` : '');
  let startSec = null; let firstItem = null; let snapSec = null; let releaseSec = null; let lastSec = null;
  let pendingFull = null; let errs = 0; let nItems = 0; let connected = false; let vsphere = false;
  for (const line of Array.isArray(lines) ? lines : []) {
    const c = classifyLogLine(line);
    if (!c.who || c.who === 'rep') continue;
    const sec = clockSec(`${c.date} ${c.time}`);
    if (sec === null) continue;
    lastSec = sec;
    const t = c.text.slice(0, 600);
    let m;
    if (startSec === null && (m = /^Start (Backup|Restore|Verify|Copy|Migrat\w{0,6})\b(?: JobId \d{1,12},?)?(?: Job=(\S{1,200}))?/.exec(t))) {
      startSec = sec; add(sec, c.time, '시작', m[2] ? `${m[1]} · ${m[2]}` : m[1], 'blue');
    } else if (!connected && /^Connected Client: /.test(t)) {
      connected = true;
      const tls = /encryption: ([A-Z0-9_]{3,80} TLSv[0-9.]{1,6})/.exec(t);
      add(sec, c.time, 'FD 연결', `${t.replace(/, encryption: .*$/, '').replace(/^Connected Client: /, '')}${tls ? ` · ${tls[1]}` : ''}`);
    } else if (!vsphere && (m = /Successfully connected to VSphere API on host ([A-Za-z0-9.:_-]{1,253})/.exec(t))) {
      vsphere = true; add(sec, c.time, 'vSphere 접속', m[1]);
    } else if (/is not CBT enabled, enabling it now/i.test(t)) {
      add(sec, c.time, 'CBT 켬', 'VM 의 변경 블록 추적이 꺼져 있어 플러그인이 켰습니다', 'info');
    } else if (ITEM_RE.test(t)) {
      nItems++;
      if (firstItem === null) { firstItem = sec; add(sec, c.time, '데이터 백업 시작', '', 'cyan'); }
    } else if ((m = VOL_RE.full.exec(t))) {
      pendingFull = { sec, at: c.time, name: m[1], bytes: reportBytes(m[2]) };
    } else if (pendingFull && (m = VOL_RE.mounted.exec(t))) {
      add(pendingFull.sec, pendingFull.at, `볼륨 ${pendingFull.name} 가득 참 → ${m[1]}`, `${decBytesText(pendingFull.bytes)} · 교체 ${durKo(sec - pendingFull.sec)}`);
      pendingFull = null;
    } else if (c.level === 'err' && errs < 5) {
      errs++; add(sec, c.time, '오류', t, 'err');
    } else if (snapSec === null && /^python3-fd-mod: Cleaning up snapshot /.test(t)) {
      snapSec = sec; add(sec, c.time, '임시 스냅샷 정리', t.replace(/^python3-fd-mod: /, ''), 'green');
    } else if (releaseSec === null && /^Releasing device /.test(t)) {
      releaseSec = sec; add(sec, c.time, '장치 해제', t.replace(/^Releasing device /, ''));
    }
  }
  if (pendingFull) add(pendingFull.sec, pendingFull.at, `볼륨 ${pendingFull.name} 가득 참`, decBytesText(pendingFull.bytes));
  const first = steps.find((s) => s.title === '데이터 백업 시작');
  if (first) first.sub = `항목 ${nItems}개`;
  const start = startRep ?? startSec;
  const end = endRep ?? lastSec;
  const verdict = reportVerdict(fields.Termination);
  if (end !== null && fields.Termination) add(end, clockOf(fields['End time']) || '', '종료', fields.Termination, verdict.cls === 'green' ? 'green' : verdict.cls === 'red' ? 'err' : verdict.cls === 'amber' ? 'warn' : 'plain');
  steps.sort((a, b) => a.sec - b.sec);
  const span = (a, b) => (a !== null && b !== null && b >= a ? b - a : null);
  const tail = snapSec ?? releaseSec;
  const segs = [
    { k: 'wait', label: '대기', sec: span(schedSec, start) },
    { k: 'prep', label: '준비', sec: span(start, firstItem) },
    // 버그 점검 W5: 백업 항목이 하나도 시작되지 않았으면(실패 잡) 데이터 전송 구간은 없다 — 실행 전체를 '데이터 전송' 으로 그렸다
    { k: 'data', label: '데이터 전송', sec: firstItem === null ? null : span(firstItem, tail ?? end) },
    { k: 'tail', label: '정리', sec: tail !== null ? span(tail, end) : null },
  ].filter((s) => s.sec !== null && s.sec > 0);
  return { steps, segs, waitSec: span(schedSec, start), runSec: span(start, end) };
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
