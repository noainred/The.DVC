/**
 * 성능점검 CSV 로그 분석 엔진 — 기간·버킷 집계(svcmon/loganalyze.js).
 *
 * 화면이 "이 점검의 지난 분기 기록"을 시간/일/주/월/분기/반기/연간 버킷으로 보는 조회 경로.
 * 규모 가정은 csvlog.js 와 같다(일 2GB+, 90일 × 파트 = 수백 파일). 그래서:
 *
 * - **스트리밍**: fs.createReadStream + readline. 파일을 통째로 메모리에 올리지 않는다.
 *   util/csv.js parseCsvRows 는 전체 문자열용이라 여기서 쓰지 않는다(GB 파일 통읽기 금지).
 *   자체 경량 파서로 인용부호 안 쉼표를 처리한다('응답' 필드에 쉼표·따옴표가 들어간다).
 *   인용부호가 닫히지 않은 물리행은 파서 상태(inQ)를 유지한 채 다음 행을 **이어서** 파싱한다
 *   ('응답'에 줄바꿈이 든 행). 이어 붙인 문자열을 처음부터 재파싱하면 손상 파일(미종결
 *   인용부호 + 뒤따르는 무따옴표 행 다수)에서 O(L²) 로 이벤트 루프가 초 단위 정지한다
 *   (실측 7.5MB 파일 18초) — 증분 파싱은 O(L) 이다(회귀 방지).
 * - **파일 사전 선별**: 파일명 results-<periodKey>[-pNN].csv 에서 기간을 복원해 from~to 와
 *   겹치지 않으면 열지 않는다. **회전 설정은 바뀔 수 있으므로** 디렉터리에 여러 형식이 섞여
 *   있어도 각 파일명을 개별 파싱한다. 파싱 불가 파일명은 mtime(마지막 기록 시각)으로만
 *   판단하고, 그래도 모르면 스캔 대상에 넣는다(제외하면 침묵 누락).
 *   파일 경계 유예(FILE_SLACK_MS): 라이터는 200ms 배치 flush 라 구간 경계의 행이 다음
 *   구간 파일에 실릴 수 있다 — 경계 파일을 60초 여유로 포함한다.
 * - **예산**: maxRows(기본 200만)·maxMs(기본 10초) 초과 시 중단하고 truncated:true +
 *   scannedRows + files.skipped 로 어디까지 봤는지 알린다(조용한 절단 금지).
 * - **비동기 양보**: line 핸들러는 O(1) 누적만. 물리행 2,000행마다 setImmediate 로 이벤트
 *   루프에 양보하고 시간 예산을 확인한다(CLAUDE.md 블로킹 금지 불변조건). 카운터는 **물리행**
 *   기준이다 — 완성 레코드만 세면 인용부호 미종결 이어붙임 구간에서 양보·예산이 전혀 안 돈다.
 * - **p95 는 근사**: 버킷당 ms 전량 보관은 메모리가 터진다(버킷 하나에 수백만 행 가능).
 *   고정 경계 히스토그램(0-1,…,10,20,50,…,10000+ ms)으로 근사하고 approx:true 를 명시한다.
 *
 * 시간대 주의: csvlog.periodKey 는 **로컬 시간** 기준이므로 파일명 기간 복원·버킷 경계도
 * 로컬 시간 Date 생성자로 계산한다(행의 시각 필드는 ISO/UTC — Date.parse 로 ms epoch 비교).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logDir } from './logsettings.js';
import { periodKey } from './csvlog.js';

const BOM = '﻿';
const HEADER_FIRST = '시각';        // 헤더 행 식별(파트 파일마다 헤더가 붙는다)
const NCOLS = 10;                   // csvlog HEADER 컬럼 수
const DEFAULT_MAX_ROWS = 2_000_000;
const DEFAULT_MAX_MS = 10_000;
const YIELD_EVERY = 2_000;          // N행마다 setImmediate 양보 + 시간 예산 확인
const PENDING_MAX = 1024 * 1024;    // 인용부호 미종결 이어붙임 상한(손상 파일 메모리 폭주 방지)
const FILE_SLACK_MS = 60_000;       // 파일 경계 유예(배치 flush 로 경계 행이 옆 파일에 실림)
const LIST_MAX = 50;                // files.list 상한

export const ANALYZE_BUCKETS = ['hour', 'day', 'week', 'month', 'quarter', 'half', 'year'];

/** p95 근사용 고정 경계(ms). 마지막 빈은 10000+ — 그 빈에 걸리면 관측 maxMs 로 근사. */
const HIST_EDGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const HIST_BINS = HIST_EDGES.length + 1;

const round2 = (v) => Math.round(v * 100) / 100;

/** 수식가드 해제 — csvlog.cell 이 `= + - @` 앞에 붙인 ' 를 벗겨서 비교한다. */
const unguard = (s) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

/* ── 파일명 → 기간 복원 ─────────────────────────────────────────────── */

/**
 * results-<periodKey>[-pNN].csv 파일명에서 기간을 복원한다.
 * 회전 설정이 바뀌었을 수 있으므로 모든 형식(hour/day/week/month/quarter)을 시도한다.
 * @returns {{rotate:string,key:string,from:number,to:number}|null} 파싱 불가면 null.
 */
export function parseLogFileName(name) {
  const m = /^results-(.+?)(-p\d{2,})?\.csv$/.exec(String(name || ''));
  if (!m) return null;
  const key = m[1];
  let g;
  if ((g = /^(\d{4})(\d{2})(\d{2})-(\d{2})$/.exec(key))) {           // hour: YYYYMMDD-HH
    const [y, mo, d, h] = g.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) return null;
    return { rotate: 'hour', key, from: new Date(y, mo - 1, d, h).getTime(), to: new Date(y, mo - 1, d, h + 1).getTime() };
  }
  if ((g = /^(\d{4})(\d{2})(\d{2})$/.exec(key))) {                    // day: YYYYMMDD
    const [y, mo, d] = g.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { rotate: 'day', key, from: new Date(y, mo - 1, d).getTime(), to: new Date(y, mo - 1, d + 1).getTime() };
  }
  if ((g = /^(\d{4})-W(\d{2})$/.exec(key))) {                         // week: YYYY-Www (ISO)
    const y = Number(g[1]); const w = Number(g[2]);
    if (w < 1 || w > 53) return null;
    // ISO 주 1 = 1월 4일이 속한 주. 그 주의 월요일부터 7일.
    const jan4 = new Date(y, 0, 4);
    const dow = jan4.getDay() || 7;
    const start = new Date(y, 0, 4 - (dow - 1) + (w - 1) * 7);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    return { rotate: 'week', key, from: start.getTime(), to: end.getTime() };
  }
  if ((g = /^(\d{4})(\d{2})$/.exec(key))) {                           // month: YYYYMM
    const y = Number(g[1]); const mo = Number(g[2]);
    if (mo < 1 || mo > 12) return null;
    return { rotate: 'month', key, from: new Date(y, mo - 1, 1).getTime(), to: new Date(y, mo, 1).getTime() };
  }
  if ((g = /^(\d{4})Q([1-4])$/.exec(key))) {                          // quarter: YYYYQn
    const y = Number(g[1]); const q = Number(g[2]) - 1;
    return { rotate: 'quarter', key, from: new Date(y, q * 3, 1).getTime(), to: new Date(y, q * 3 + 3, 1).getTime() };
  }
  return null;
}

/**
 * 디렉터리의 로그 파일 목록 + 파일명 기반 기간 추정(화면의 조회 가능 범위 표시용).
 * 파싱 불가 파일명은 from/to 가 null 이다(modifiedAt 으로 최근 여부만 판단 가능).
 * @returns {{name:string,sizeBytes:number,from:number|null,to:number|null,modifiedAt:number}[]}
 */
export function listLogWindows() {
  const dir = logDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort();
  } catch { return []; }
  const out = [];
  for (const name of names) {
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    const p = parseLogFileName(name);
    out.push({ name, sizeBytes: st.size, from: p ? p.from : null, to: p ? p.to : null, modifiedAt: st.mtimeMs });
  }
  return out;
}

/* ── CSV 파서(경량·증분) ───────────────────────────────────────────── */

/**
 * RFC 4180 증분 파서 상태. 인용부호가 물리행 경계를 넘는 행('응답'에 줄바꿈)은 이 상태를
 * 유지한 채 다음 행을 이어서 파싱한다 — 이어 붙인 전체 문자열을 재파싱하면 손상 파일
 * (미종결 인용부호)에서 PENDING_MAX 까지 O(L²) 문자 연산이 되어 이벤트 루프가 초 단위로
 * 멈춘다(회귀 방지). len 은 누적 논리 행 길이(PENDING_MAX 상한 판단용).
 */
function csvStateCreate() {
  return { cells: [], field: '', inQ: false, len: 0 };
}

/**
 * 청크 하나를 증분 파싱한다. 물리행 사이에는 '\n' 을 별도 청크로 먹인다 — 청크 경계의
 * 직전 문자가 항상 '\n' 삽입 지점이므로 이스케이프 따옴표("") 의 2문자 lookahead 가
 * 경계에 걸치는 경우는 없다(따옴표 뒤 다음 문자는 언제나 '\n').
 */
function csvStateFeed(st, s) {
  let { field, inQ } = st;
  const cells = st.cells;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } // "" → 리터럴 따옴표
        else inQ = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      inQ = true; // 필드 시작 위치의 따옴표만 인용 필드로 인식(util/csv.js 와 동일 규칙)
    } else if (c === ',') {
      cells.push(field); field = '';
    } else field += c;
  }
  st.field = field;
  st.inQ = inQ;
  st.len += s.length;
}

/** 논리 행 종결 — 마지막 필드를 확정하고 셀 배열을 돌려준다(inQ=false 일 때만 호출). */
function csvStateFinish(st) {
  st.cells.push(st.field);
  return st.cells;
}

/* ── 버킷 경계 ──────────────────────────────────────────────────────── */

/** ts 가 속한 버킷의 key/from/to(로컬 시간 경계). hour~quarter 표기는 periodKey 와 동일. */
function bucketRange(ts, bucket) {
  const d = new Date(ts);
  const y = d.getFullYear();
  switch (bucket) {
    case 'hour':
      return {
        key: periodKey(ts, 'hour'),
        from: new Date(y, d.getMonth(), d.getDate(), d.getHours()).getTime(),
        to: new Date(y, d.getMonth(), d.getDate(), d.getHours() + 1).getTime(),
      };
    case 'week': {
      const dow = d.getDay() || 7;
      const start = new Date(y, d.getMonth(), d.getDate() - (dow - 1));
      return {
        key: periodKey(ts, 'week'),
        from: start.getTime(),
        to: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).getTime(),
      };
    }
    case 'month':
      return { key: periodKey(ts, 'month'), from: new Date(y, d.getMonth(), 1).getTime(), to: new Date(y, d.getMonth() + 1, 1).getTime() };
    case 'quarter': {
      const q = Math.floor(d.getMonth() / 3);
      return { key: periodKey(ts, 'quarter'), from: new Date(y, q * 3, 1).getTime(), to: new Date(y, q * 3 + 3, 1).getTime() };
    }
    case 'half': {
      const h = d.getMonth() < 6 ? 0 : 1;
      return { key: `${y}-H${h + 1}`, from: new Date(y, h * 6, 1).getTime(), to: new Date(y, h * 6 + 6, 1).getTime() };
    }
    case 'year':
      return { key: String(y), from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
    case 'day':
    default:
      return { key: periodKey(ts, 'day'), from: new Date(y, d.getMonth(), d.getDate()).getTime(), to: new Date(y, d.getMonth(), d.getDate() + 1).getTime() };
  }
}

function bucketFor(ctx, ts) {
  const m = ctx.memo; // 로그는 대체로 시간 순 — 직전 버킷 재사용으로 Date 생성을 줄인다
  if (m && ts >= m.from && ts < m.to) return m;
  const r = bucketRange(ts, ctx.bucket);
  let b = ctx.buckets.get(r.from);
  if (!b) {
    b = {
      key: r.key, from: r.from, to: r.to,
      ok: 0, warn: 0, bad: 0, other: 0, rows: 0,
      sumMs: 0, cntMs: 0, maxMs: -Infinity, hist: new Array(HIST_BINS).fill(0),
    };
    ctx.buckets.set(r.from, b);
  }
  ctx.memo = b;
  return b;
}

function histIdx(ms) {
  for (let i = 0; i < HIST_EDGES.length; i += 1) if (ms < HIST_EDGES[i]) return i;
  return HIST_EDGES.length; // 10000+ ms
}

/** 히스토그램 근사 p95 — 95번째 백분위가 속한 빈의 상한 경계(마지막 빈은 관측 maxMs). */
function p95FromHist(b) {
  if (!b.cntMs) return null;
  const need = Math.ceil(b.cntMs * 0.95);
  let acc = 0;
  for (let i = 0; i < HIST_BINS; i += 1) {
    acc += b.hist[i];
    if (acc >= need) return i < HIST_EDGES.length ? HIST_EDGES[i] : b.maxMs;
  }
  return b.maxMs;
}

/* ── 행 처리(O(1) 누적만 — 무거운 일 금지) ─────────────────────────── */

function handleRecord(cells, ctx) {
  if (cells.length < NCOLS) { ctx.badRows += 1; return; }           // 컬럼 수 부족
  const ts = Date.parse(cells[0]);
  if (!Number.isFinite(ts)) { ctx.badRows += 1; return; }           // 시각 파싱 실패
  if (ts < ctx.from || ts >= ctx.to) return;                        // 기간 밖(파일 경계 행)
  if (ctx.pathPrefix && !unguard(cells[1]).startsWith(ctx.pathPrefix)) return;
  if (ctx.target && unguard(cells[2]) !== ctx.target) return;
  if (ctx.test && unguard(cells[4]) !== ctx.test) return;
  if (ctx.type && unguard(cells[5]) !== ctx.type) return;
  const status = unguard(cells[6]);
  if (ctx.statusFilter && status !== ctx.statusFilter) return;

  const b = bucketFor(ctx, ts);
  const t = ctx.totals;
  b.rows += 1; t.rows += 1;
  const slot = status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : status === 'bad' ? 'bad' : 'other';
  b[slot] += 1; t[slot] += 1;

  const msRaw = unguard(cells[8]); // 음수 ms 는 수식가드('-…)가 붙어 기록된다
  if (msRaw !== '') {
    const ms = Number(msRaw);
    if (Number.isFinite(ms)) {
      b.sumMs += ms; b.cntMs += 1; if (ms > b.maxMs) b.maxMs = ms;
      b.hist[histIdx(ms)] += 1;
      t.sumMs += ms; t.cntMs += 1; if (ms > t.maxMs) t.maxMs = ms;
    }
  }
}

/* ── 파일 스캔(스트리밍) ────────────────────────────────────────────── */

async function scanFile(file, ctx) {
  let input = null;
  try { input = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return; }
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let st = null; // 진행 중 논리 행의 증분 파서 상태(null = 다음 raw 가 새 논리 행)
  let n = 0;     // **물리행** 카운터 — 미종결 이어붙임 중에도 양보·예산 체크가 돌아야 한다
  try {
    for await (const raw of rl) {
      let cells = null;
      if (st) {
        // 인용부호 미종결 이어붙임 — 새 물리행만 이어서 파싱(전체 재파싱 O(L²) 금지)
        csvStateFeed(st, '\n');
        csvStateFeed(st, raw);
      } else {
        let line = raw;
        if (line.startsWith(BOM)) line = line.slice(BOM.length);
        if (line !== '') {
          st = csvStateCreate();
          csvStateFeed(st, line);
        }
      }
      if (st) {
        if (!st.inQ) {
          cells = csvStateFinish(st);
          st = null;
        } else if (st.len > PENDING_MAX) {
          ctx.badRows += 1; st = null; // 손상 파일 방어 — 이어붙임 상한 초과 시 폐기
        }
      }
      if (cells && cells[0] !== HEADER_FIRST) { // 파트 파일마다 헤더가 붙는다
        if (ctx.scannedRows >= ctx.maxRows) { ctx.truncated = true; ctx.stop = true; break; }
        ctx.scannedRows += 1;
        handleRecord(cells, ctx);
      }
      n += 1;
      if (n % YIELD_EVERY === 0) {
        if (Date.now() - ctx.started >= ctx.maxMs) { ctx.truncated = true; ctx.stop = true; break; }
        await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보
      }
    }
  } catch {
    ctx.badRows += 1; // 읽기 오류 — 조용히 넘기지 않고 불완전 표시(남은 파일은 계속 본다)
  } finally {
    rl.close();
    input.destroy?.();
  }
  // 파일 끝까지 인용부호가 닫히지 않은 행. 예산 중단(stop)으로 읽다 만 행은 손상이 아니다.
  if (st && !ctx.stop) ctx.badRows += 1;
}

/* ── 공개 API ───────────────────────────────────────────────────────── */

/**
 * 성능점검 CSV 로그를 기간·버킷으로 집계한다.
 *
 * @param {object} opts
 * @param {number} opts.from      조회 시작(ms epoch, 필수)
 * @param {number} opts.to        조회 끝(ms epoch, 배타, 필수)
 * @param {string} [opts.bucket='day']  'hour'|'day'|'week'|'month'|'quarter'|'half'|'year'
 * @param {string} [opts.path='']       경로 prefix 필터(대상 트리 경로)
 * @param {string} [opts.target='']     대상 이름 정확 일치
 * @param {string} [opts.test='']       점검명 정확 일치
 * @param {string} [opts.type='']       유형(ping/tcp/…) 정확 일치
 * @param {string} [opts.status='']     'ok'|'warn'|'bad' 만 카운트하고 싶을 때
 * @param {number} [opts.maxRows=2000000] 스캔 행 예산
 * @param {number} [opts.maxMs=10000]     스캔 시간 예산(ms)
 * @returns {Promise<{buckets:Array, totals:object, files:{scanned:number,skipped:number,list:string[]},
 *   scannedRows:number, badRows:number, truncated:boolean, approx:true, elapsedMs:number}>}
 */
export async function analyzeLog(opts = {}) {
  const started = Date.now();
  const from = Number(opts.from);
  const to = Number(opts.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) {
    throw new Error('from/to 는 ms epoch 로 필수이며 from < to 여야 합니다.');
  }
  const bucket = opts.bucket || 'day';
  if (!ANALYZE_BUCKETS.includes(bucket)) {
    throw new Error(`bucket 은 ${ANALYZE_BUCKETS.join('/')} 중 하나여야 합니다.`);
  }
  const nMaxRows = Number(opts.maxRows);
  const nMaxMs = Number(opts.maxMs);
  const ctx = {
    from, to, bucket,
    pathPrefix: String(opts.path ?? ''),
    target: String(opts.target ?? ''),
    test: String(opts.test ?? ''),
    type: String(opts.type ?? ''),
    statusFilter: String(opts.status ?? ''),
    maxRows: Number.isFinite(nMaxRows) && nMaxRows >= 0 ? nMaxRows : DEFAULT_MAX_ROWS,
    maxMs: Number.isFinite(nMaxMs) && nMaxMs >= 0 ? nMaxMs : DEFAULT_MAX_MS,
    started,
    scannedRows: 0, badRows: 0, truncated: false, stop: false,
    buckets: new Map(), memo: null,
    totals: { rows: 0, ok: 0, warn: 0, bad: 0, other: 0, sumMs: 0, cntMs: 0, maxMs: -Infinity },
  };

  const dir = logDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^results-.*\.csv$/.test(f)).sort();
  } catch { names = []; }

  // 파일 사전 선별 — 기간과 겹치지 않는 파일은 열지 않는다(수백 파일 대비).
  const chosen = [];
  let skipped = 0;
  for (const name of names) {
    const p = parseLogFileName(name);
    if (p) {
      if (p.to + FILE_SLACK_MS <= from || p.from - FILE_SLACK_MS >= to) { skipped += 1; continue; }
    } else {
      // 파싱 불가 파일명 — mtime(마지막 기록 시각)이 from 이전이면 전 행이 기간 밖.
      // 그 외에는 스캔 대상에 넣는다(제외하면 침묵 누락).
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { skipped += 1; continue; }
      if (st.mtimeMs + FILE_SLACK_MS < from) { skipped += 1; continue; }
    }
    chosen.push(name);
  }

  const list = [];
  let scanned = 0;
  for (let i = 0; i < chosen.length; i += 1) {
    if (!ctx.stop && Date.now() - started >= ctx.maxMs) { ctx.truncated = true; ctx.stop = true; }
    if (ctx.stop) { skipped += chosen.length - i; break; } // 예산 소진 — 남은 파일은 skipped 로 보고
    scanned += 1;
    if (list.length < LIST_MAX) list.push(chosen[i]);
    await scanFile(path.join(dir, chosen[i]), ctx); // eslint-disable-line no-await-in-loop
  }

  const buckets = [...ctx.buckets.values()].sort((a, b) => a.from - b.from).map((b) => ({
    key: b.key,
    from: b.from,
    ok: b.ok, warn: b.warn, bad: b.bad, other: b.other, rows: b.rows,
    avgMs: b.cntMs ? round2(b.sumMs / b.cntMs) : null,
    maxMs: b.cntMs ? b.maxMs : null,
    p95Ms: p95FromHist(b),
  }));
  const t = ctx.totals;
  return {
    buckets,
    totals: {
      rows: t.rows, ok: t.ok, warn: t.warn, bad: t.bad, other: t.other,
      avgMs: t.cntMs ? round2(t.sumMs / t.cntMs) : null,
      maxMs: t.cntMs ? t.maxMs : null,
    },
    files: { scanned, skipped, list },
    scannedRows: ctx.scannedRows,
    badRows: ctx.badRows,
    truncated: ctx.truncated,
    approx: true, // p95 는 고정 경계 히스토그램 근사값
    elapsedMs: Date.now() - started,
  };
}
