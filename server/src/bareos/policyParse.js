/**
 * bareos/policyParse.js — Director 정책 수집(v2.839 백업 메뉴 개편 2차-a) 응답 → 포탈 모양. 순수 함수.
 *
 * 모양은 **실측**(2026-11-01 · Director 25.1.2 · `.api json` — 고정값 test/fixtures/bareosPolicy2839/):
 *   · `status scheduler days=7` → { schedules:[{name, enabled, jobs:[{name, enabled}]}], preview:[{datetime, runtime(epoch 초 · 절대 시각), schedule, level}] }
 *   · `show schedules`  → { schedules:{ <Name>:{ name, description?, run:[문자열] } } }
 *   · `show jobdefs`    → { jobdefs:{ <Name>:{ name, type, level, fileset, storage:[…], pool, fullbackuppool, … } } } — **기본값인 칸은 키가 없다**
 *   · `show filesets`   → { filesets:{ <Name>:{ name, description?, include:[{ options:[{…}], file?:[], plugin?:[] }], exclude?:[…] } } }
 *   · `llist pools`     → { pools:[{ poolid, name, numvols, maxvols, volretention, maxvoljobs, maxvolbytes, autoprune, recycle, pooltype, … }] } — 값은 전부 문자열
 *   · `list volumes`    → { volumes:{ <풀 이름 소문자>:[{ mediaid, volumename, volstatus, volbytes, volretention, lastwritten, … }] } } — 값은 전부 문자열
 *   · v2.840 `llist clients` → { clients:[{ clientid, name, uname, autoprune, fileretention, jobretention }] } — **실측 아님(추정)**: 카탈로그 Client 표의 열
 *     (Bareos ListClientRecords 의 llist 열 — 그 FD 의 잡이 돌 때 설정 값으로 갱신된다). show clients 대신 고른 이유: show 권한이 없어도 되고 출력에 비밀번호 칸이 없다.
 *   · v2.840 `list volumes pool=X` → 풀 하나의 행 — 모양 추정(배열 또는 풀 이름 키의 객체 둘 다 받는다)
 *
 * 규칙: 외부 입력이다 — 아는 필드만 · 문자열은 자르고 제어문자를 지운다 · 수는 numOrNull(못 읽으면 null — 0 이 아니다) · 배열·행 수 상한.
 *   정규화 함수는 **멱등**이다(엣지 대행 회신을 중앙이 같은 함수로 다시 거른다 — edgeResult.VALUE.policy).
 */
import { numOrNull } from '../util/numOrNull.js';

export const CAP = Object.freeze({ schedules: 500, jobsPerSchedule: 5000, jobsTotal: 20_000, preview: 5000, run: 40, jobdefs: 500, filesets: 500, pools: 500, volumes: 50_000, errorVols: 20, clients: 2000, volumeRows: 2000 });
export const LEVEL_NAMES = Object.freeze(['Full', 'Incremental', 'Differential', 'VirtualFull', 'Base', 'Since', 'Consolidate']);
/** 볼륨 상태(Bareos VolStatus) — 화면 표 칸 순서. 그 밖은 other. */
export const VOL_STATUSES = Object.freeze(['Append', 'Full', 'Used', 'Purged', 'Recycle', 'Error', 'Archive', 'Disabled', 'Busy', 'Read-Only', 'Cleaning']);

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
// 제어문자 → 공백 · 앞뒤 공백 정리 · 길이 상한(길이를 먼저 자른다 — 선형)
export const str = (v, n = 128) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n * 2).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const nonNeg = (v) => { const x = numOrNull(v); return x !== null && x >= 0 ? x : null; };
/** '1'·'0'·true·false → 불리언 · 그 밖 null(모름). */
export const flag = (v) => (v === true || v === '1' || v === 1 ? true : v === false || v === '0' || v === 0 ? false : null);
/** 레벨 이름 정규화 — 알려진 이름(대소문자 무시) 그대로, 한 글자(F·I·D·V)는 이름으로, 그 밖 ''(모름). */
export function levelOf(v) {
  const s = str(v, 20);
  if (!s) return '';
  const hit = LEVEL_NAMES.find((x) => x.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  return { F: 'Full', I: 'Incremental', D: 'Differential', V: 'VirtualFull' }[s] || '';
}
const RUN_TIME_RE = /\bat\s{1,4}(\d{1,2}):(\d{2})\b/i;
const RUN_POOL_RE = /\b(?:pool|fullpool|incrementalpool|differentialpool)\s{0,2}=\s{0,2}([A-Za-z0-9._-]{1,64})/i;

/**
 * Run 줄 1개('Full 1st Sat at 21:00' · 'Level=Incremental Pool=X mon-fri at 02:00') → 가볍게 뽑은 값. 못 뽑은 칸은 null — 화면은 원문(text)을 늘 보인다.
 * 입력은 200자로 먼저 자르고 상한 있는 반복만 쓴다(ReDoS — 외부 입력).
 */
export function parseRunLine(line) {
  const text = str(line, 200);
  const first = (/^(?:level\s{0,2}=\s{0,2})?([A-Za-z]{1,16})/i.exec(text) || [])[1] || '';
  const level = levelOf(first);
  const tm = RUN_TIME_RE.exec(text);
  const hh = tm ? Number(tm[1]) : null;
  const at = tm && hh <= 23 ? `${String(hh).padStart(2, '0')}:${tm[2]}` : null;
  const pm = RUN_POOL_RE.exec(text);
  return { text, level: level || null, at, pool: pm ? pm[1] : null };
}

/** `status scheduler days=N` 결과(또는 이미 정규화한 값) → { schedules, preview }. preview 는 시각(ms) 순 · 시각을 모르면 버린다(어느 칸에 둘지 모른다). */
export function normScheduler(v) {
  const r = isObj(v) ? v : {};
  let jobsTotal = 0;
  const schedules = [];
  for (const s of arr(r.schedules).slice(0, CAP.schedules)) {
    if (!isObj(s)) continue;
    const name = str(s.name, 128);
    if (!name) continue;
    const jobs = [];
    for (const j of arr(s.jobs).slice(0, CAP.jobsPerSchedule)) {
      if (jobsTotal >= CAP.jobsTotal) break;
      const jn = isObj(j) ? str(j.name, 128) : str(j, 128);
      if (!jn) continue;
      jobs.push({ name: jn, enabled: isObj(j) ? flag(j.enabled) : null });
      jobsTotal++;
    }
    schedules.push({ name, enabled: flag(s.enabled), jobs });
  }
  const preview = [];
  for (const p of arr(r.preview).slice(0, CAP.preview)) {
    if (!isObj(p)) continue;
    // 실측: runtime = epoch 초(datetime 문자열은 Director 현지 시각 — 쓰지 않는다). 이미 정규화한 값은 at(ms).
    const at = Number.isFinite(p.at) ? p.at : (() => { const s = nonNeg(p.runtime); return s !== null && s > 946_684_800 && s < 4_102_444_800 ? s * 1000 : null; })();
    const schedule = str(p.schedule, 128);
    if (at === null || !schedule) continue;
    preview.push({ at, schedule, level: levelOf(p.level) || '' });
  }
  preview.sort((a, b) => a.at - b.at || a.schedule.localeCompare(b.schedule));
  return { schedules, preview };
}

/** 객체 맵(`{ <Name>: {…} }`) 또는 배열 → 항목 배열(이름이 있는 것만 · 상한). 이미 정규화한 배열도 받는다. */
const entries = (v, key, cap) => {
  const src = isObj(v) && key in v ? v[key] : v;
  const list = Array.isArray(src) ? src : isObj(src) ? Object.entries(src).map(([k, x]) => (isObj(x) ? { name: k, ...x } : null)) : [];
  return list.filter(isObj).slice(0, cap);
};

/** `show schedules` → [{ name, description, run:[{text, level, at, pool}] }]. */
export function normShowSchedules(v) {
  return entries(v, 'schedules', CAP.schedules).map((s) => ({
    name: str(s.name, 128),
    description: str(s.description, 200),
    run: arr(s.run).slice(0, CAP.run).map((x) => (isObj(x) ? parseRunLine(x.text) : parseRunLine(x))).filter((x) => x.text),
  })).filter((s) => s.name);
}

/** 문자열 또는 문자열 배열 → 문자열(배열이면 앞 것들을 '·' 로) — Storage 처럼 배열로 오는 칸. 없으면 ''(기본값). */
const oneOrList = (v, n = 64) => (Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, 4).join(' · ') : str(v, n));

/**
 * `show jobdefs` → [{ name, type, level, schedule, fileset, storage, pool, fullPool, incPool, diffPool, client, priority, maxJobs, ai:{…}|null }].
 * **기본값인 칸은 Director 가 키를 싣지 않는다**(실측) — 빈 문자열 / null 로 두고 화면이 '기본' 으로 보인다(지어내지 않는다).
 */
export function normJobdefs(v) {
  return entries(v, 'jobdefs', CAP.jobdefs).map((d) => {
    const aiOn = flag(d.alwaysincremental ?? d.ai?.on);   // 이미 정규화한 값은 ai.on(멱등)
    const aiKeep = nonNeg(d.alwaysincrementalkeepnumber ?? d.ai?.keep);
    const aiRet = str(d.alwaysincrementaljobretention ?? d.ai?.retention, 40);
    const aiMax = str(d.alwaysincrementalmaxfullage ?? d.ai?.maxFullAge, 40);
    return {
      name: str(d.name, 128), type: str(d.type, 20), level: levelOf(d.level) || str(d.level, 20),
      schedule: str(d.schedule, 128), fileset: str(d.fileset, 128), storage: oneOrList(d.storage), pool: str(d.pool, 64),
      fullPool: str(d.fullbackuppool ?? d.fullPool, 64), incPool: str(d.incrementalbackuppool ?? d.incPool, 64), diffPool: str(d.differentialbackuppool ?? d.diffPool, 64),
      client: str(d.client, 128), priority: nonNeg(d.priority), maxJobs: nonNeg(d.maximumconcurrentjobs ?? d.maxJobs),
      ai: aiOn === true || aiKeep !== null || aiRet || aiMax ? { on: aiOn === true, keep: aiKeep, retention: aiRet, maxFullAge: aiMax } : null,
    };
  }).filter((d) => d.name);
}

/** `show filesets` → [{ name, description, include, files:[…앞 5], plugins:[…], exclude, signature, compression }] — 표에 쓰는 요약만(원문 전체는 싣지 않는다). */
export function normFilesets(v) {
  return entries(v, 'filesets', CAP.filesets).map((f) => {
    if (Array.isArray(f.files) || Array.isArray(f.plugins)) {   // 이미 정규화한 값(멱등)
      return { name: str(f.name, 128), description: str(f.description, 200), include: nonNeg(f.include) ?? 0, files: arr(f.files).map((x) => str(x, 200)).filter(Boolean).slice(0, 5),
        plugins: arr(f.plugins).map((x) => str(x, 300)).filter(Boolean).slice(0, 5), exclude: nonNeg(f.exclude) ?? 0, signature: str(f.signature, 20), compression: str(f.compression, 20) };
    }
    const inc = arr(f.include).filter(isObj);
    const files = []; const plugins = []; let signature = ''; let compression = '';
    for (const i of inc) {
      for (const x of arr(i.file)) if (files.length < 5) files.push(str(x, 200));
      for (const x of arr(i.plugin)) if (plugins.length < 5) plugins.push(str(x, 300));
      for (const o of arr(i.options).filter(isObj)) { if (!signature) signature = str(o.signature, 20); if (!compression) compression = str(o.compression, 20); }
    }
    return { name: str(f.name, 128), description: str(f.description, 200), include: inc.length, files: files.filter(Boolean), plugins: plugins.filter(Boolean), exclude: arr(f.exclude).length, signature, compression };
  }).filter((f) => f.name);
}

/**
 * `llist pools`(또는 짧은 `list pools`) → [{ id, name, type, numVols, maxVols, volRetentionSec, maxVolJobs, maxVolBytes, autoPrune, recycle, enabled, recyclePoolId, scratchPoolId }].
 * 짧은 목록에는 보존·상한 칸이 없다 — null(모름). 0 은 Bareos 에서 '제한 없음' 이다(maxvols·maxvolbytes·maxvoljobs).
 */
export function normPools(v) {
  return entries(v, 'pools', CAP.pools).map((p) => ({
    id: nonNeg(p.poolid ?? p.id), name: str(p.name, 64), type: str(p.pooltype ?? p.type, 20),
    numVols: nonNeg(p.numvols ?? p.numVols), maxVols: nonNeg(p.maxvols ?? p.maxVols),
    volRetentionSec: nonNeg(p.volretention ?? p.volRetentionSec), maxVolJobs: nonNeg(p.maxvoljobs ?? p.maxVolJobs), maxVolBytes: nonNeg(p.maxvolbytes ?? p.maxVolBytes),
    autoPrune: flag(p.autoprune ?? p.autoPrune), recycle: flag(p.recycle), enabled: flag(p.enabled),
    recyclePoolId: nonNeg(p.recyclepoolid ?? p.recyclePoolId), scratchPoolId: nonNeg(p.scratchpoolid ?? p.scratchPoolId),
  })).filter((p) => p.name);
}

/** 볼륨 lastwritten — 카탈로그 시각은 **Director 현지**(시간대 없음)라 포탈 서버 현지로 읽는다(director.normalizeJobRow 와 같은 규칙 — bareos/CLAUDE.md). */
const catTime = (v) => { if (!v || typeof v !== 'string') return null; const t = Date.parse(v.slice(0, 19).replace(' ', 'T')); return Number.isFinite(t) && t > 0 ? t : null; };

/**
 * `list volumes` → 풀(소문자 이름)마다 요약 { pool, n, status:{Append:…}, other, bytes, bytesN, oldest, newest, retentionSec(최빈), errors:[이름 ≤20] }.
 * 행 목록은 저장하지 않는다(법인당 수천 개 — 2차-b 의 볼륨 목록은 그때 즉시 조회). 처리 행 상한 CAP.volumes(넘으면 truncated).
 */
export function normVolumes(v) {
  if (isObj(v) && Array.isArray(v.pools) && v.pools.every((x) => isObj(x) && 'status' in x)) {   // 이미 정규화한 값(멱등)
    return { pools: v.pools.slice(0, CAP.pools).map((p) => ({ ...summaryOut(p) })), truncated: v.truncated === true, total: nonNeg(v.total) ?? 0 };
  }
  const src = isObj(v) && isObj(v.volumes) ? v.volumes : isObj(v) && Array.isArray(v.volumes) ? { '': v.volumes } : {};
  const by = new Map(); let seen = 0; let truncated = false;
  for (const [k, rows] of Object.entries(src)) {
    for (const r of arr(rows)) {
      if (seen >= CAP.volumes) { truncated = true; break; }
      if (!isObj(r)) continue;
      seen++;
      const pool = str(r.pool ?? r.poolname ?? k, 64).toLowerCase();
      const x = by.get(pool) || { pool, n: 0, status: {}, other: 0, bytes: 0, bytesN: 0, oldest: null, newest: null, ret: new Map(), errors: [] };
      x.n++;
      const st = str(r.volstatus, 20);
      const known = VOL_STATUSES.find((s) => s.toLowerCase() === st.toLowerCase());
      if (known) x.status[known] = (x.status[known] || 0) + 1; else x.other++;
      const b = nonNeg(r.volbytes);
      if (b !== null) { x.bytes += b; x.bytesN++; }
      const t = catTime(r.lastwritten);
      if (t !== null) { if (x.oldest === null || t < x.oldest) x.oldest = t; if (x.newest === null || t > x.newest) x.newest = t; }
      const ret = nonNeg(r.volretention);
      if (ret !== null) x.ret.set(ret, (x.ret.get(ret) || 0) + 1);
      if (known === 'Error' && x.errors.length < CAP.errorVols) x.errors.push(str(r.volumename, 128));
      by.set(pool, x);
    }
    if (truncated) break;
  }
  const pools = [...by.values()].slice(0, CAP.pools).map((x) => {
    let retentionSec = null; let best = -1;
    for (const [ret, c] of x.ret) if (c > best || (c === best && ret > retentionSec)) { best = c; retentionSec = ret; }
    return summaryOut({ ...x, retentionSec });
  });
  return { pools, truncated, total: seen };
}
function summaryOut(x) {
  const status = {};
  for (const s of VOL_STATUSES) { const c = nonNeg(x.status?.[s]); if (c) status[s] = c; }
  return { pool: str(x.pool, 64).toLowerCase(), n: nonNeg(x.n) ?? 0, status, other: nonNeg(x.other) ?? 0, bytes: nonNeg(x.bytes) ?? 0, bytesN: nonNeg(x.bytesN) ?? 0,
    oldest: Number.isFinite(x.oldest) ? x.oldest : null, newest: Number.isFinite(x.newest) ? x.newest : null, retentionSec: nonNeg(x.retentionSec),
    errors: arr(x.errors).map((e) => str(e, 128)).filter(Boolean).slice(0, CAP.errorVols) };
}

/**
 * v2.840 `llist clients` → [{ name, fileRetentionSec, jobRetentionSec, autoPrune }] — 카탈로그 값(초 · 문자열로 온다). 아는 칸만(주소 · uname 은 싣지 않는다). 멱등.
 */
export function normClients(v) {
  return entries(v, 'clients', CAP.clients).map((c) => ({
    name: str(c.name, 128),
    fileRetentionSec: nonNeg(c.fileretention ?? c.fileRetentionSec), jobRetentionSec: nonNeg(c.jobretention ?? c.jobRetentionSec),
    autoPrune: flag(c.autoprune ?? c.autoPrune),
  })).filter((c) => c.name);
}

/**
 * v2.840 볼륨 목록 즉시 조회(`list volumes pool=X`) → { rows:[{ id, name, status, enabled, bytes, files, retentionSec, recycle, slot, inChanger, mediaType, lastWritten, storage }], total, truncated }.
 * 행 상한 CAP.volumeRows(넘으면 truncated · total 은 본 행 수). 이미 정규화한 값(rows 배열)도 받는다(멱등 — 엣지 회신 재정제).
 */
export function normVolumeRows(v) {
  const done = isObj(v) && Array.isArray(v.rows);
  let src = []; let total = 0;
  if (done) { src = v.rows; total = nonNeg(v.total) ?? src.length; }
  else if (isObj(v) && Array.isArray(v.volumes)) { src = v.volumes; total = src.length; }
  else if (isObj(v) && isObj(v.volumes)) for (const rows of Object.values(v.volumes)) { const a = arr(rows); total += a.length; for (const r of a) { if (src.length > CAP.volumeRows) break; src.push(r); } }
  const rows = [];
  for (const r of src) {
    if (rows.length >= CAP.volumeRows) break;
    if (!isObj(r)) continue;
    const name = str(r.volumename ?? r.name, 128);
    if (!name) continue;
    const st = str(r.volstatus ?? r.status, 20);
    rows.push({
      id: nonNeg(r.mediaid ?? r.id), name, status: VOL_STATUSES.find((x) => x.toLowerCase() === st.toLowerCase()) || st,
      enabled: flag(r.enabled), bytes: nonNeg(r.volbytes ?? r.bytes), files: nonNeg(r.volfiles ?? r.files), retentionSec: nonNeg(r.volretention ?? r.retentionSec),
      recycle: flag(r.recycle), slot: nonNeg(r.slot), inChanger: flag(r.inchanger ?? r.inChanger), mediaType: str(r.mediatype ?? r.mediaType, 64),
      lastWritten: done ? (Number.isFinite(r.lastWritten) ? r.lastWritten : null) : catTime(r.lastwritten), storage: str(r.storage, 64),
    });
  }
  return { rows, total: Math.max(total, rows.length), truncated: (done && v.truncated === true) || total > CAP.volumeRows };
}

/** 수집 명령(키 → Director 명령 · 선택 여부). show 계열은 포탈 콘솔 Profile 에 show 가 있어야 한다(v2.839 자동 설정에 추가 — 옛 설정은 '권한 없음'). */
export const POLICY_CMDS = Object.freeze([
  { key: 'scheduler', cmd: 'status scheduler days=7', optional: false, label: '스케줄 · 7일 예정' },
  { key: 'pools', cmd: 'llist pools', fallback: 'list pools', optional: false, label: '풀(보존 · 상한)' },
  { key: 'volumes', cmd: 'list volumes', optional: false, label: '볼륨 상태' },
  { key: 'schedules', cmd: 'show schedules', optional: true, label: '스케줄 Run 줄' },
  { key: 'jobdefs', cmd: 'show jobdefs', optional: true, label: 'JobDefs' },
  { key: 'filesets', cmd: 'show filesets', optional: true, label: 'FileSet' },
  // v2.840 클라이언트 보존(File · Job Retention) — 카탈로그 Client 행(show 권한 불필요 · 비밀번호 칸 없음)
  { key: 'clients', cmd: 'llist clients', optional: true, label: '클라이언트 보존' },
]);
export const POLICY_KEYS = Object.freeze(POLICY_CMDS.map((c) => c.key));
export const NORMALIZE = Object.freeze({ scheduler: normScheduler, pools: normPools, volumes: normVolumes, schedules: normShowSchedules, jobdefs: normJobdefs, filesets: normFilesets, clients: normClients });

/** Director 가 명령을 거부한 사유가 권한(ACL)인가 — 화면 '권한 없음(Profile Command ACL 에 show 추가)'. 문구는 판마다 다르다(추정 — 넓게). */
export function deniedText(message) {
  const m = String(message || '').slice(0, 400);
  return /not authori|permission|access denied|acl|is an invalid command|unknown command|command not allowed/i.test(m);
}

/**
 * 수집 결과 1개(ops.policy 반환 · 엣지 회신) 정규화 — { results:{ <key>:{ ok, code?, message?, ms?, value? } }, version? }. 멱등.
 * 모르는 키는 버리고, 값은 NORMALIZE 로 다시 거른다(엣지가 보낸 것은 정제 — CLAUDE.md '엣지가 보낸 것은 정제한다').
 */
export function normPolicyResult(v) {
  const r = isObj(v) ? v : {};
  const src = isObj(r.results) ? r.results : {};
  const results = {};
  for (const k of POLICY_KEYS) {
    if (!Object.hasOwn(src, k) || !isObj(src[k])) continue;
    const x = src[k];
    const ok = x.ok === true;
    results[k] = ok
      ? { ok: true, ms: nonNeg(x.ms), value: NORMALIZE[k](x.value), ...(x.fallback === true ? { fallback: true } : {}) }
      : { ok: false, code: str(x.code, 32) || 'error', message: str(x.message, 300), ms: nonNeg(x.ms) };
  }
  return { results, version: str(r.version, 60) };
}

/* ── 판정(서버 하나 — 웹은 받은 값만 그린다) ── */

/**
 * 풀 사용 % — 용량 = MaxVols × MaxVolBytes(둘 다 0 보다 클 때만 — 0 은 '제한 없음'), 사용 = 볼륨 바이트 합. 모르면 null(지어내지 않는다 — SD 디스크 여유는 카탈로그에 없다).
 */
export function poolUsagePct(pool, vol) {
  const cap = pool?.maxVols > 0 && pool?.maxVolBytes > 0 ? pool.maxVols * pool.maxVolBytes : null;
  if (cap === null || !vol || !(vol.bytesN > 0)) return null;
  return Math.round((vol.bytes / cap) * 1000) / 10;
}

/**
 * 풀 가득 참(계획 D3) — 새 잡을 받을 볼륨이 없는 상태: MaxVols > 0 이고 NumVols ≥ MaxVols 이고, 쓸 수 있는 볼륨(Append · Recycle · Purged)이 0 이고,
 * Scratch 풀에서 가져올 볼륨도 없다. 볼륨 요약을 모르면 null(모름). Scratch 풀 행이 없으면 빈 것으로 본다.
 * @param {{numVols, maxVols, type}} pool @param {object|null} vol 그 풀의 볼륨 요약 @param {number|null} scratchVols Scratch 풀 볼륨 수(풀 행이 없으면 0)
 */
export function poolFull(pool, vol, scratchVols = 0) {
  if (!pool || pool.type === 'Scratch') return false;
  if (!(pool.maxVols > 0) || pool.numVols === null) return pool?.maxVols === 0 ? false : null;
  if (pool.numVols < pool.maxVols) return false;
  if (!vol) return pool.numVols === 0 ? false : null;
  const usable = (vol.status?.Append || 0) + (vol.status?.Recycle || 0) + (vol.status?.Purged || 0);
  if (usable > 0) return false;
  if (scratchVols === null) return null;
  return scratchVols === 0;
}
