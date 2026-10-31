/**
 * bareos/liveParse.js — 실행 중 잡의 진행량·속도 읽기(순수 · v2.833 진행 현황판 · 사용자 결정 'Director 상태 조회').
 *
 * 카탈로그(`list jobs`·`llist`)는 백업이 **끝나야** JobBytes 를 채운다(실행 중에는 0 — normalizeJobRow 가 null 로 바꾼다).
 * 실행 중 값은 FD 가 들고 있어 Director 콘솔의 `status client=<FD>` 로 읽는다(Director 가 FD 에 물어 원문을 돌려준다).
 * Bareos filed/status.cc 의 실행 중 잡 블록(평문 — 실환경 출력 모양은 미확인 · 추정):
 *   JobId 123 Job pv-xxx.2026-10-31_02.00.00_05 is running.
 *       Full Backup Job started: 31-Oct-26 02:00
 *       Files=3 Bytes=12,345,678,912 AveBytes/sec=123,456,789 LastBytes/sec=130,000,000 Errors=0
 * `.api json` 모드에서 Director 가 이 원문을 JSON 문자열로 감싸 줄 수도, 구조화해 줄 수도 있어(버전마다 다름 — 추정) 셋 다 받는다:
 *   ① JSON 이 아니면 원문 그대로 ② JSON 이면 그 안의 문자열을 모아 같은 파서로 ③ jobid·바이트 칸이 있는 객체는 그대로.
 * 규칙: 못 읽은 값은 null(0 이 아니다 — util/numOrNull) · 외부 입력이라 길이를 먼저 자르고 정규식은 앵커 + 상한 반복만(ReDoS — 루트 CLAUDE.md).
 */
export const MAX_TEXT = 512 * 1024;
export const MAX_JOBS = 300;

const num = (s) => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const LEVELS = { full: 'F', incremental: 'I', differential: 'D', virtualfull: 'F', base: 'F' };

/** 고유 잡 이름(`pv-x.2026-10-31_02.00.00_05`) → 잡 리소스 이름(`pv-x`). */
export function jobNameOf(unique) {
  const s = String(unique || '').slice(0, 200);
  const m = /^(\S{1,128}?)\.\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}_\d{1,6}$/.exec(s);
  return m ? m[1] : s;
}

/**
 * FD 상태 원문 → 실행 중 잡들. 'Terminated Jobs' 절부터는 끝난 잡이라 보지 않는다.
 * @returns {{ jobid:number, job:string, name:string, level:string, bytes:number|null, files:number|null, aveRate:number|null, lastRate:number|null }[]}
 */
export function parseFdStatus(text) {
  const t = String(text ?? '').slice(0, MAX_TEXT);
  const out = [];
  let cur = null;
  for (const raw of t.split('\n')) {
    const ln = raw.length > 2000 ? raw.slice(0, 2000) : raw;
    if (/^\s{0,8}Terminated Jobs:/i.test(ln)) break;
    const m = /^\s{0,8}JobId\s{1,4}(\d{1,10})\s{1,4}Job\s{1,4}(\S{1,200})\s{1,4}is running/.exec(ln);
    if (m) {
      if (out.length >= MAX_JOBS) break;
      cur = { jobid: Number(m[1]), job: m[2], name: jobNameOf(m[2]), level: '', bytes: null, files: null, aveRate: null, lastRate: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const lv = /^\s{0,12}(Full|Incremental|Differential|VirtualFull|Base)\s{1,4}Backup Job started/i.exec(ln);
    if (lv) { cur.level = LEVELS[lv[1].toLowerCase()] || ''; continue; }
    const f = /^\s{0,12}Files=([\d,]{1,24})\s{1,4}Bytes=([\d,]{1,30})\s{1,4}AveBytes\/sec=([\d,]{1,24})\s{1,4}LastBytes\/sec=([\d,]{1,24})/.exec(ln);
    if (f) { cur.files = num(f[1]); cur.bytes = num(f[2]); cur.aveRate = num(f[3]); cur.lastRate = num(f[4]); }
  }
  return out;
}

/** JSON 결과에서 문자열을 모은다(깊이·개수 상한). */
function stringsOf(v, acc, depth = 0) {
  if (acc.n > 5000 || depth > 8 || v === null || v === undefined) return;
  if (typeof v === 'string') { acc.parts.push(v); acc.n += 1; return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 2000)) stringsOf(x, acc, depth + 1); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, acc, depth + 1);
}
/** JSON 결과의 구조화된 잡 객체(jobid + 바이트 칸) — Bareos 버전에 따라 이 모양일 수 있다(추정). */
function structuredOf(v, out, depth = 0) {
  if (out.length >= MAX_JOBS || depth > 8 || !v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 2000)) structuredOf(x, out, depth + 1); return; }
  const jobid = num(v.jobid ?? v.JobId ?? v.job_id);
  const bytes = num(v.jobbytes ?? v.bytes ?? v.JobBytes);
  if (Number.isInteger(jobid) && jobid > 0 && bytes !== null) {
    const job = String(v.job ?? v.Job ?? v.name ?? '').slice(0, 200);
    out.push({
      jobid, job, name: jobNameOf(job), level: String(v.level ?? '').slice(0, 1).toUpperCase(),
      bytes, files: num(v.jobfiles ?? v.files ?? v.JobFiles), aveRate: num(v.avebytes_sec ?? v.bytespersec ?? v.aveRate), lastRate: num(v.lastbytes_sec ?? v.lastRate),
    });
    return;
  }
  for (const x of Object.values(v)) structuredOf(x, out, depth + 1);
}

/** `status client=` 응답 원문(JSON 이든 평문이든) → 실행 중 잡들(jobid 하나에 한 줄). */
export function parseStatusRaw(raw) {
  const s = String(raw ?? '').slice(0, MAX_TEXT * 2).trim();
  if (!s) return [];
  let j = null;
  if (s[0] === '{' || s[0] === '[') { try { j = JSON.parse(s); } catch { j = null; } }
  if (j === null) return parseFdStatus(s);
  const body = j && typeof j === 'object' && 'result' in j ? j.result : j;
  const got = [];
  structuredOf(body, got);
  const acc = { parts: [], n: 0 };
  stringsOf(body, acc);
  const fromText = parseFdStatus(acc.parts.join('\n'));
  const seen = new Map();
  for (const x of [...got, ...fromText]) if (!seen.has(x.jobid)) seen.set(x.jobid, x);
  return [...seen.values()].slice(0, MAX_JOBS);
}

/** 지금 속도 — LastBytes/sec, 없으면 AveBytes/sec, 둘 다 없으면 null. */
export const rateNowOf = (x) => (x?.lastRate ?? x?.aveRate ?? null);
