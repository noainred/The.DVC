/**
 * bareos/director.js — Director 콘솔 명령 **용례 함수**(세션은 호출부가 연다 — console.js withConsole).
 *
 * 응답 모양: API 모드 2(JSON)에서 키는 소문자이고 결과는 `{ <종류>: [...] }` 꼴이다(DeveloperGuide/api.rst).
 * 명령마다 정확한 키가 문서에 다 있지는 않아(실제 Director 에서 PoC 로 확인할 항목 — 계획서 R8) 목록은
 * **첫 배열 값**을, 이름은 `name` 을 읽는 관대한 해석을 쓴다. 해석 실패는 지어내지 않고 오류로 올린다.
 *
 * 명령 조립: 값은 전부 names.js 관문을 지난 것만 넣고 `consoleQuote` 로 인용한다(next_arg 규칙의 역).
 */
import { consoleQuote, isResourceName, normLevel, statusOf, isFinalStatus } from './names.js';
import { BareosConsoleError } from './console.js';
import { numOrNull } from '../util/numOrNull.js';

const bad = (msg) => new BareosConsoleError('invalid', msg);

/** 결과 객체의 첫 배열 값(없으면 []). */
export function firstArray(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  for (const v of Object.values(result)) if (Array.isArray(v)) return v;
  for (const v of Object.values(result)) if (v && typeof v === 'object') { const a = firstArray(v); if (a.length) return a; }
  return [];
}

/** 이름 목록(.clients 등) — 항목이 문자열이거나 {name} 이다. 리소스 이름 규칙에 맞는 것만(화면 드롭다운 원천). */
export function namesOf(result, cap = 2000) {
  const out = new Set();   // v2.822(P6): includes 는 잡 수천 개에서 O(n²)
  for (const it of firstArray(result)) {
    const n = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : '');
    if (n && isResourceName(n)) out.add(n);
    if (out.size >= cap) break;
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

const boolOrNull = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' ? true
  : v === false || v === 0 || v === '0' || v === 'false' || v === 'no' ? false : null);

/**
 * `.jobs` → Map(잡 이름 → enabled: true|false|null). enabled 는 Director 메모리의 현재 값이다(`{name, enabled}` — ua_dotcmds.cc DotJobsCmd).
 * 그 칸이 없는 Director 면 null(모른다 — 호출부가 아무것도 하지 않는다).
 */
export async function jobStates(session) {
  const m = new Map();
  for (const it of firstArray(await session.call('.jobs', { maxBytes: 16 * 1024 * 1024 }))) {
    const n = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : '');
    if (!n || !isResourceName(n) || m.has(n)) continue;
    m.set(n, it && typeof it === 'object' ? boolOrNull(it.enabled) : null);
    if (m.size >= 100_000) break;
  }
  return m;
}

/** 접속 배너(`OK: bareos-dir Version: 25.0.4 (…)`)에서 Director 이름·버전. */
export function parseBanner(banner) {
  const s = String(banner || '');
  const m = /OK:\s*(\S+)\s+Version:?\s*([0-9][0-9A-Za-z.~+-]{0,40})/.exec(s);
  return { director: m ? m[1].slice(0, 64) : '', version: m ? m[2] : '' };
}

/** 연결 시험: 인증 + JSON 모드 + `.clients`(콘솔 ACL 로 막혀 있으면 그 사실을 밝힌다). */
export async function probe(session) {
  const { director, version } = parseBanner(session.info.banner);
  let clients = null; let clientsError = '';
  try { clients = namesOf(await session.call('.clients')); } catch (e) { clientsError = e?.message || String(e); }
  return { director, version, tls: session.info.tls, clients, clientsError };
}

// v2.841(사용자 화면 '카탈로그 일부를 읽지 못했습니다(schedules)' — Bareos 소스 확인): 스케줄 목록 명령은 `.schedule`(단수)이다
//   (ua_cmds.cc 명령 표 — 21.1·22.1·23.0·master 같음). `.schedules` 는 '없는 명령' 이라 Schedule 칸이 늘 비었다. 결과 키는 'schedules'(DotScheduleCmd).
const LIST_CMDS = Object.freeze({ clients: '.clients', storages: '.storages', pools: '.pools', schedules: '.schedule', jobdefs: '.jobdefs', filesets: '.filesets' });

/** 사이트 매핑 드롭다운 원천. 하나가 실패해도 나머지는 돌려준다(실패한 것은 errors 에 — 빈 목록으로 꾸미지 않는다). */
export async function catalogLists(session) {
  const out = {}; const errors = {};
  for (const [k, cmd] of Object.entries(LIST_CMDS)) {
    try { out[k] = namesOf(await session.call(cmd)); } catch (e) { out[k] = null; errors[k] = e?.message || String(e); }
  }
  return { ...out, errors };
}

/** Director 의 잡 이름 목록(`.jobs`) — 원장 대조용. */
export async function jobNames(session) { return namesOf(await session.call('.jobs'), 100_000); }

/**
 * 백업 잡 생성(`configure add job`). 이미 있으면 { exists:true }(Director 가 '이미 있음' 으로 거부 — 덮어쓰지 않는다).
 * @param {{ name, jobDefs, client, storage, pool, schedule?, level?, pluginOptions, description? }} d
 */
export async function addJob(session, d) {
  for (const [k, v] of [['잡 이름', d.name], ['JobDefs', d.jobDefs], ['FD 클라이언트', d.client], ['스토리지', d.storage], ['풀', d.pool]]) {
    if (!isResourceName(v)) throw bad(`${k} 이름이 Bareos 리소스 규칙에 맞지 않습니다.`);
  }
  if (d.schedule && !isResourceName(d.schedule)) throw bad('스케줄 이름이 Bareos 리소스 규칙에 맞지 않습니다.');
  if (typeof d.pluginOptions !== 'string' || !d.pluginOptions || /["\\;@\r\n\0]/.test(d.pluginOptions)) throw bad('플러그인 옵션이 올바르지 않습니다.');
  const desc = String(d.description || '').replace(/["\\;@\r\n\0]/g, ' ').slice(0, 120);
  const parts = [
    'configure add job', `name=${d.name}`, `jobdefs=${d.jobDefs}`, `client=${d.client}`, `storage=${d.storage}`, `pool=${d.pool}`,
    ...(d.schedule ? [`schedule=${d.schedule}`] : []),
    `level=${normLevel(d.level)}`,
    // FdPluginOptions 는 ALIST_STR(따옴표 없이 기록) — 값에 따옴표를 남겨 `FdPluginOptions = "…"` 로 쓰이게 한다(names.js 머리말).
    `fdpluginoptions=${consoleQuote(d.pluginOptions, { literalQuotes: true })}`,
    ...(desc ? [`description=${consoleQuote(desc)}`] : []),
  ];
  try {
    const r = await session.call(parts.join(' '));
    const add = r?.add || {};
    return { exists: false, name: String(add.name || d.name), filename: String(add.filename || '').slice(0, 300) };
  } catch (e) {
    if (e?.code === 'jsonrpc' && /already exists/i.test(e.message)) return { exists: true, name: d.name };
    throw e;
  }
}

/** 실행 결과에서 jobid(`{ run: { jobid } }`). 없으면 오류(지어내지 않는다). */
export function jobIdOf(result) {
  const id = numOrNull(result?.run?.jobid ?? result?.jobid);
  if (!Number.isInteger(id) || id <= 0) throw new BareosConsoleError('protocol', 'Director 가 실행한 잡 번호(jobid)를 돌려주지 않았습니다.');
  return id;
}

/**
 * 지금 실행 — `run job=… level=… [storage=… pool=…] yes`. @returns jobid
 * v2.830 백업 그룹: storage·pool 은 **그 실행에만** 쓰는 지정이다(Bareos run 의 storage=·pool= — 잡 정의는 바뀌지 않는다). 비면 잡 기본값.
 */
export async function runJob(session, { job, level, storage = '', pool = '' }) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  if (storage && !isResourceName(storage)) throw bad('스토리지 이름이 올바르지 않습니다.');
  if (pool && !isResourceName(pool)) throw bad('풀 이름이 올바르지 않습니다.');
  const extra = `${storage ? ` storage=${storage}` : ''}${pool ? ` pool=${pool}` : ''}`;
  return jobIdOf(await session.call(`run job=${job} level=${normLevel(level, 'Incremental')}${extra} yes`));
}

const asId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 2 ** 31) throw bad('jobid 가 올바르지 않습니다.'); return n; };

/** 잡 1건 상세(`llist jobid=`) → 정규화한 레코드(없으면 null). */
export async function jobStatus(session, jobid) {
  const rows = firstArray(await session.call(`llist jobid=${asId(jobid)}`));
  return rows.length ? normalizeJobRow(rows[0]) : null;
}

/** 개수·바이트 — 음수는 읽을 수 없는 값(null)이다(0 으로도 음수로도 보이지 않게 — util/numOrNull 규칙). */
const nonNeg = (v) => { const n = numOrNull(v); return n !== null && n >= 0 ? n : null; };

/** 카탈로그 잡 행 → 포탈 레코드. 못 읽은 수치는 null(0 아님 — numOrNull). */
export function normalizeJobRow(r = {}) {
  const ts = (v) => { if (!v) return null; const t = Date.parse(String(v).replace(' ', 'T')); return Number.isFinite(t) ? t : null; };
  const code = String(r.jobstatus ?? r.status ?? '').slice(0, 1);
  // 끝나지 않은 실행의 카탈로그 바이트·파일 수는 끝날 때 채워진다(실행 중에는 0 — 추정) — 0 B 로 보이지 않게 null(C9-5 · 못 읽은 값은 0 이 아니다)
  const fin = isFinalStatus(code);
  return {
    jobid: numOrNull(r.jobid),
    job: String(r.job ?? '').slice(0, 200),
    name: String(r.name ?? '').slice(0, 128),
    type: String(r.type ?? '').slice(0, 1),
    level: String(r.level ?? '').slice(0, 1),
    status: code,
    state: statusOf(code),
    startedAt: ts(r.starttime),
    endedAt: ts(r.endtime),
    bytes: fin ? nonNeg(r.jobbytes) : null,
    files: fin ? nonNeg(r.jobfiles) : null,
    errors: nonNeg(r.joberrors),
    client: String(r.client ?? r.clientname ?? '').slice(0, 128),
  };
}

/**
 * 잡 이름의 실행 전부(`list jobs job=…`) — jobid 내림차순(최신 먼저).
 * Bareos 는 `ORDER BY StartTime` **오름차순** + LIMIT 이라 `limit=N` 을 주면 **가장 오래된** N건이 온다(v2.822 W1 — sql_list.cc).
 * 그래서 limit 없이 받아 여기서 정렬한다. VM 하나의 실행 행이라 수천 건이어도 수 MB 다(상한 16MB — 넘으면 too-large).
 */
export async function jobRuns(session, job) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  return firstArray(await session.call(`list jobs job=${job}`, { maxBytes: 16 * 1024 * 1024 }))
    .map(normalizeJobRow).filter((x) => x.jobid).sort((a, b) => b.jobid - a.jobid);
}

/** 잡 이름의 최근 실행 N건(최신 먼저 — jobRuns 를 자른다). */
export async function jobHistory(session, job, limit = 30) {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 30));
  return (await jobRuns(session, job)).slice(0, n);
}

/** 최근 N일의 모든 잡 실행(`list jobs days=N`) — 폴러 대조용(Bareos 스케줄이 돌린 실행도 원장 lastRun 에 반영). */
export async function recentJobs(session, days = 2) {
  const d = Math.max(1, Math.min(14, Math.floor(Number(days)) || 2));
  return firstArray(await session.call(`list jobs days=${d}`, { maxBytes: 16 * 1024 * 1024 })).map(normalizeJobRow).filter((x) => x.jobid);
}

/**
 * 작업 로그(`list joblog jobid=`) → 줄 배열. 상한을 넘으면 **뒤쪽**을 남긴다(끝의 요약·오류가 중요하다).
 * @returns {{ lines: string[], truncated: boolean, total: number }}
 */
export async function jobLog(session, jobid, { maxBytes = 256 * 1024, maxLines = 4000 } = {}) {
  // 원문 상한은 넉넉히(16MB) — 예전 1MB 는 로그가 길면 too-large 502 가 나서 '뒤쪽 보존' 이 동작하지 않았다(C9-3 — 재현). 자르기는 아래에서.
  const rows = firstArray(await session.call(`list joblog jobid=${asId(jobid)}`, { maxBytes: Math.max(maxBytes * 4, 16 * 1024 * 1024) }));
  const lines = [];
  for (const r of rows) {
    const t = typeof r === 'string' ? r : String(r?.logtext ?? r?.text ?? '');
    const at = typeof r === 'object' && r?.time ? `${String(r.time).slice(0, 19)} ` : '';
    for (const ln of t.split('\n')) if (ln.trim()) lines.push(`${at}${ln}`.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' '));
  }
  const total = lines.length;
  let keep = lines.slice(-maxLines);
  let size = keep.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
  while (keep.length && size > maxBytes) { size -= Buffer.byteLength(keep[0]) + 1; keep = keep.slice(1); }
  return { lines: keep, truncated: keep.length < total, total };
}

/** 실행 중 잡 취소. */
export async function cancelJob(session, jobid) { return session.call(`cancel jobid=${asId(jobid)}`); }

/**
 * v2.831 백업 그룹 보관 개수 — 카탈로그에서 실행 기록 지우기(`delete jobid=a,b,c`). 볼륨의 데이터는 그 볼륨이 재활용될 때 비워진다.
 * jobid 는 숫자만(asId) · 한 명령에 DELETE_IDS_PER_CMD 개씩. 응답 모양에 기대지 않는다 — 부르는 쪽이 다시 읽어 실제로 사라졌는지 본다
 * (실환경 미확인(추정): 쉼표 목록 구문 · 확인 질문 없음 — Bareos ua_cmds.cc DeleteJob 기준).
 */
export const DELETE_IDS_PER_CMD = 50;
export async function deleteJobIds(session, jobids) {
  const ids = (Array.isArray(jobids) ? jobids : []).map(asId);
  for (let i = 0; i < ids.length; i += DELETE_IDS_PER_CMD) await session.call(`delete jobid=${ids.slice(i, i + DELETE_IDS_PER_CMD).join(',')}`);
}

/** 잡 활성/비활성(`enable job=` · `disable job=`). Bareos 에는 리소스 삭제 명령이 없다 — 포탈의 '삭제' 는 비활성화다. */
export async function setJobEnabled(session, job, enabled) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  return session.call(`${enabled ? 'enable' : 'disable'} job=${job}`);
}

/**
 * `.bvfs_get_jobids jobid=N` 의 jobid 목록 — **probe 진단용이다. 복원 라우트는 쓰지 않는다**(v2.822 S1).
 * Director 는 이 목록을 ClientId + FileSet 으로만 고른다(AccurateGetJobids — 잡 이름을 보지 않는다). 범용 FileSet 하나를
 * 같은 사이트 FD 의 여러 VM 이 공유하므로 다른 VM 의 Full·Incr 가 섞인다. 복원 체인은 이 잡의 이력으로만 계산한다(restore.js chainFromHistory).
 * 응답 모양이 문서에 없어(계획서 R8) 숫자 jobid 를 모으고, 못 읽으면 null.
 */
export async function restoreChain(session, jobid) {
  const r = await session.call(`.bvfs_get_jobids jobid=${asId(jobid)}`);
  const ids = [];
  const take = (v) => { const n = numOrNull(typeof v === 'object' && v ? (v.id ?? v.jobid) : v); if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n); };
  if (Array.isArray(r)) r.forEach(take);
  else if (r && typeof r === 'object') {
    for (const v of Object.values(r)) {
      if (Array.isArray(v)) v.forEach(take);
      else if (typeof v === 'string' && /^[\d,\s]+$/.test(v)) v.split(',').forEach(take);
    }
  }
  return ids.length ? ids.sort((a, b) => a - b) : null;
}

/**
 * 복원 실행 — `restore client=… jobid=a,b restorejob=… pluginoptions="…" all done yes`.
 * jobid 목록으로만 고른다(범용 FileSet 공유 → 'select current' 는 다른 VM 이 섞인다 — 계획서 R10).
 * v2.827.1: **`select` 키워드를 넣지 않는다**. Bareos 22~25 의 ua_restore.cc 는 `select` 가 있으면 jobid 를 무시하고
 *   SelectBackupsBeforeDate(현재 시각 = 'select current' 와 같은 경로)로 들어가 FileSet 을 묻는다 — 비대화형이라
 *   'No FileSet found for client' 로 복원이 거부됐다(실환경 재현). jobid= 는 그 자체로 선택을 끝내고, all = 전부 표시, done = 트리 대화 생략.
 * @returns jobid(복원 잡)
 */
export async function runRestore(session, { client, jobids, restoreJob, pluginOptions }) {
  if (!isResourceName(client)) throw bad('복원 FD 이름이 올바르지 않습니다.');
  if (!isResourceName(restoreJob)) throw bad('복원 잡 이름이 올바르지 않습니다.');
  const ids = (Array.isArray(jobids) ? jobids : []).map(asId);
  if (!ids.length || ids.length > 400) throw bad('복원할 백업 jobid 목록이 올바르지 않습니다.');
  if (typeof pluginOptions !== 'string' || !pluginOptions || /["\\;@\r\n\0]/.test(pluginOptions)) throw bad('복원 플러그인 옵션이 올바르지 않습니다.');
  const cmd = `restore client=${client} restoreclient=${client} jobid=${ids.join(',')} restorejob=${restoreJob} pluginoptions=${consoleQuote(pluginOptions)} all done yes`;
  return jobIdOf(await session.call(cmd, { timeoutMs: 120_000 }));
}
