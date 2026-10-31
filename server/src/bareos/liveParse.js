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

/* ── v2.833.1 Director 상태(`status director`) — 잡마다 Director 가 보는 상태 문구(실행 중 · 마운트 대기 · 동시 실행 상한 …) ── */

/**
 * Director 상태 문구 → 사유 키(화면이 우리말로 바꾼다). Bareos dird ua_status.cc 의 실행 중 잡 문구(추정 — 실환경 원문은 진단으로 확인).
 * 'running' 만 실제로 도는 것이고 나머지는 기다리는 이유다. 모르는 문구는 'other'(원문을 함께 보인다).
 */
const DIR_REASONS = [
  ['running', /\bis running\b/i],
  ['mount', /mount request|waiting for (a )?mount|waiting to mount/i],
  ['volume', /appendable volume|waiting for (a )?(new )?volume|media/i],
  ['maxjobs', /waiting on max|max(imum)? (concurrent|total|client|storage|job)/i],
  ['storage', /waiting (on|for) storage|storage daemon/i],
  ['client', /waiting (on|for) client|waiting for client/i],
  ['priority', /higher priority/i],
  ['starttime', /start time/i],
  ['created', /waiting execution|is waiting to start|has not started/i],
  ['blocked', /\bblocked\b/i],
  ['done', /\bhas (terminated|erred|errors|a fatal|been canceled)|verify differences/i],
];
export function dirReasonOf(text) {
  const s = String(text || '').slice(0, 300);
  for (const [k, re] of DIR_REASONS) if (re.test(s)) return k;
  return s ? 'other' : '';
}

/**
 * Director 상태 평문 → 실행 중 잡 표의 행. 형식은 버전마다 조금 다르다(추정) — 줄이 jobid 로 시작하고 'is …' 또는 'has …' 문구가 있으면 그 행으로 본다.
 *  예: '    62  Back Incr          0         0  pv-oc2-x.2026-10-31_08.08.00_05 is waiting for a mount request'
 * 'Running Jobs:' 절만 본다(그 앞뒤의 끝난 잡 표·예약 표를 섞지 않는다 — 절 표지가 없으면 전체를 본다).
 * @returns {{ jobid:number, name:string, status:string, reason:string }[]}
 */
export function parseDirStatus(text) {
  const t = String(text ?? '').slice(0, MAX_TEXT);
  const lines = t.split('\n');
  let start = lines.findIndex((l) => /^\s{0,8}Running Jobs:/i.test(l));
  const scoped = start >= 0;
  if (!scoped) start = -1;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
    if (scoped && /^\s{0,8}(Terminated Jobs|Scheduled Jobs|No Jobs running|====\s*$)/i.test(ln) && out.length) break;
    if (scoped && /^\s{0,8}(Terminated Jobs|Scheduled Jobs):/i.test(ln)) break;
    // 선형으로 — jobid 머리만 정규식(앵커·상한), 문구 위치는 indexOf(줄은 2,000자로 잘랐다 · ReDoS 규칙)
    const h = /^\s{0,10}(\d{1,10})\s/.exec(ln);
    if (!h) continue;
    const rest = ln.slice(h[0].length);
    const iIs = rest.indexOf(' is '); const iHas = rest.indexOf(' has ');
    const at = iIs < 0 ? iHas : iHas < 0 ? iIs : Math.min(iIs, iHas);
    if (at < 0) continue;
    const words = rest.slice(0, at).trim().split(/\s+/).filter(Boolean);
    const uniq = words.find((w) => /\.\d{4}-\d{2}-\d{2}_/.test(w)) || words[words.length - 1] || '';
    const status = rest.slice(at + 1).trim().slice(0, 200);
    const m = [null, h[1]];
    out.push({ jobid: Number(m[1]), name: jobNameOf(uniq), status, reason: dirReasonOf(status) });
    if (out.length >= MAX_JOBS * 2) break;
  }
  return out;
}

/** `status director` 응답 원문(JSON 이든 평문이든) → 행들(jobid 하나에 하나). JSON 의 구조화 행은 status·jobstatuslong 칸을 쓴다(추정). */
export function parseDirStatusRaw(raw) {
  const s = String(raw ?? '').slice(0, MAX_TEXT * 2).trim();
  if (!s) return [];
  let j = null;
  if (s[0] === '{' || s[0] === '[') { try { j = JSON.parse(s); } catch { j = null; } }
  if (j === null) return parseDirStatus(s);
  const body = j && typeof j === 'object' && 'result' in j ? j.result : j;
  const got = [];
  const walk = (v, d = 0) => {
    if (got.length >= MAX_JOBS * 2 || d > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 4000)) walk(x, d + 1); return; }
    const jobid = num(v.jobid ?? v.JobId);
    const st = v.status ?? v.jobstatuslong ?? v.JobStatusLong ?? v.statustext;
    if (Number.isInteger(jobid) && jobid > 0 && typeof st === 'string' && st) {
      const status = st.slice(0, 200);
      got.push({ jobid, name: jobNameOf(String(v.job ?? v.name ?? '')), status, reason: dirReasonOf(status) });
      return;
    }
    for (const x of Object.values(v)) walk(x, d + 1);
  };
  walk(body);
  const acc = { parts: [], n: 0 };
  stringsOf(body, acc);
  const seen = new Map();
  for (const x of [...got, ...parseDirStatus(acc.parts.join('\n'))]) if (!seen.has(x.jobid)) seen.set(x.jobid, x);
  return [...seen.values()];
}

/** 진단 원문 머리(앞 RAW_HEAD 자) — 제어 문자는 공백으로(화면·JSON 안전). 비밀은 없다(상태 출력 — 포탈은 콘솔 비밀번호를 출력에 넣지 않는다). */
export const RAW_HEAD = 4096;
// eslint-disable-next-line no-control-regex
export const rawHead = (raw) => String(raw ?? '').slice(0, RAW_HEAD).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
