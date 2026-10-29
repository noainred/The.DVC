/**
 * bareos/director.js — Director 콘솔 명령 **용례 함수**(세션은 호출부가 연다 — console.js withConsole).
 *
 * 응답 모양: API 모드 2(JSON)에서 키는 소문자이고 결과는 `{ <종류>: [...] }` 꼴이다(DeveloperGuide/api.rst).
 * 명령마다 정확한 키가 문서에 다 있지는 않아(실제 Director 에서 PoC 로 확인할 항목 — 계획서 R8) 목록은
 * **첫 배열 값**을, 이름은 `name` 을 읽는 관대한 해석을 쓴다. 해석 실패는 지어내지 않고 오류로 올린다.
 *
 * 명령 조립: 값은 전부 names.js 관문을 지난 것만 넣고 `consoleQuote` 로 인용한다(next_arg 규칙의 역).
 */
import { consoleQuote, isResourceName, normLevel, statusOf } from './names.js';
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
  const out = [];
  for (const it of firstArray(result)) {
    const n = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : '');
    if (n && isResourceName(n) && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out.sort((a, b) => a.localeCompare(b));
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

const LIST_CMDS = Object.freeze({ clients: '.clients', storages: '.storages', pools: '.pools', schedules: '.schedules', jobdefs: '.jobdefs', filesets: '.filesets' });

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

/** 지금 실행 — `run job=… level=… yes`. @returns jobid */
export async function runJob(session, { job, level }) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  return jobIdOf(await session.call(`run job=${job} level=${normLevel(level, 'Incremental')} yes`));
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
    bytes: nonNeg(r.jobbytes),
    files: nonNeg(r.jobfiles),
    errors: nonNeg(r.joberrors),
    client: String(r.client ?? r.clientname ?? '').slice(0, 128),
  };
}

/** 잡 이름의 최근 실행(`list jobs job=… limit=…`). */
export async function jobHistory(session, job, limit = 30) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 30));
  return firstArray(await session.call(`list jobs job=${job} limit=${n}`)).map(normalizeJobRow).filter((x) => x.jobid);
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
  const rows = firstArray(await session.call(`list joblog jobid=${asId(jobid)}`, { maxBytes: Math.max(maxBytes * 4, 1024 * 1024) }));
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

/** 잡 활성/비활성(`enable job=` · `disable job=`). Bareos 에는 리소스 삭제 명령이 없다 — 포탈의 '삭제' 는 비활성화다. */
export async function setJobEnabled(session, job, enabled) {
  if (!isResourceName(job)) throw bad('잡 이름이 올바르지 않습니다.');
  return session.call(`${enabled ? 'enable' : 'disable'} job=${job}`);
}

/**
 * 복원 체인(`.bvfs_get_jobids jobid=N`) — 그 백업을 복원하는 데 필요한 jobid 목록(Full → Diff → Incr).
 * 응답 모양이 문서에 없어(계획서 R8) 숫자 jobid 를 모으고, 못 읽으면 null(호출부가 카탈로그로 계산 — restore.js).
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
 * 복원 실행 — `restore client=… jobid=a,b restorejob=… pluginoptions="…" select all done yes`.
 * jobid 목록으로만 고른다(범용 FileSet 공유 → 'select current' 는 다른 VM 이 섞인다 — 계획서 R10).
 * @returns jobid(복원 잡)
 */
export async function runRestore(session, { client, jobids, restoreJob, pluginOptions }) {
  if (!isResourceName(client)) throw bad('복원 FD 이름이 올바르지 않습니다.');
  if (!isResourceName(restoreJob)) throw bad('복원 잡 이름이 올바르지 않습니다.');
  const ids = (Array.isArray(jobids) ? jobids : []).map(asId);
  if (!ids.length || ids.length > 400) throw bad('복원할 백업 jobid 목록이 올바르지 않습니다.');
  if (typeof pluginOptions !== 'string' || !pluginOptions || /["\\;@\r\n\0]/.test(pluginOptions)) throw bad('복원 플러그인 옵션이 올바르지 않습니다.');
  const cmd = `restore client=${client} restoreclient=${client} jobid=${ids.join(',')} restorejob=${restoreJob} pluginoptions=${consoleQuote(pluginOptions)} select all done yes`;
  return jobIdOf(await session.call(cmd, { timeoutMs: 120_000 }));
}
