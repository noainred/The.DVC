/**
 * issues/store.js — 이슈 트래커 저장소(v2.864). 포탈 공용 이슈(장애·작업·요청·개선)를 등록하고 담당자에게 할당해 끝날 때까지 추적한다.
 *
 * 파일 하나 — `issues.json` `{ v:1, nextSeq, issues:[…] }`. 사용자가 손으로 쓴 값이라 bulletin/store.js(v2.722·v2.727) 와 같은 규칙:
 *   · 캐시(메모리)가 진실이고 파일 쓰기는 `WRITE_DELAY_MS` 안의 변경을 묶어 비동기로 쓴다(tmp 0600 → fsync → rename). 종료 때는
 *     `util/exitFlush.js` 에 등록한 동기 flush 가 대기분을 쓴다(자체 process.on 금지 — v2.582 규약).
 *   · 쓰기 실패는 **조용히 지나가지 않는다** — 상태(`issuesPersist()` state saved|pending|failed · 사유 코드 · 단계)와 콘솔에 남기고 제한된
 *     지수 backoff(5초 → … 최대 6회·상한 5분)로 다시 쓴다. 6회를 넘기면 멈추고 다음 변경·종료 flush 가 다시 쓴다(무한 루프 금지).
 *     오류 원문은 tmp 파일 절대 경로를 담으므로 코드·syscall 만 남긴다.
 *   · 손상본은 `preserveCorrupt` 로 옆에 보존하고 빈 목록으로 시작한다(손상본을 빈 목록으로 덮어쓰지 않는다).
 *   · 상한은 **거부**다(조용히 자르지 않는다): 이슈 2,000건 · 제목 200자 · 본문 10,000자 · 이슈당 댓글 200개 · 댓글 2,000자 · 라벨 10개(30자) ·
 *     관찰자 50명 · 이력 300건(넘치면 오래된 것부터 지우고 `historyDropped` 로 지운 수를 밝힌다) · 합계 `ISSUES_MAX_BYTES`(기본 16MB —
 *     이슈마다 직렬화 바이트를 따로 들고 합을 유지한다: 변경마다 전체를 다시 직렬화하지 않는다 — v2.727 B-01 과 같은 이유).
 *
 * 도메인 규칙(기획 v0.1 — docs/rules/web.md 게시판 항목과 같은 자리에 요약):
 *   · 키 `ISS-<n>` 은 파일의 `nextSeq` 로 매긴다 — 지운 번호는 다시 쓰지 않는다.
 *   · 상태 backlog → todo → progress → review → done. **progress 로 옮기려면 담당자가 있어야 한다**(400). done 은 `closedAt` 을 적고
 *     done 에서 나오면 지운다. 보류(`blocked`)는 상태와 별개의 표지이고 **사유가 있어야** 들어간다(400).
 *   · 담당자는 1명(책임 명확). 함께 보는 사람은 관찰자. 재할당은 이력에 남고 라우트가 감사 로그를 적는다.
 *   · 수정 권한은 라우트가 정한다(쓰기 계정 전부 — 협업 도구). 삭제는 보고자 본인 또는 관리자(라우트가 `isMod` 로 넘긴다).
 *   · 시각은 epoch ms 숫자 하나. 문자열 값은 `capStr` 로 평탄화한다(원문 SlicedString 을 붙잡지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { registerExitFlush } from '../util/exitFlush.js';

export const KEY_PREFIX = 'ISS';
export const KEY_RE = /^ISS-\d{1,9}$/;
export const ID_RE = /^[a-f0-9]{16}$/;

export const STATUSES = Object.freeze(['backlog', 'todo', 'progress', 'review', 'done']);
export const TYPES = Object.freeze(['incident', 'task', 'request', 'improve']);
export const PRIORITIES = Object.freeze(['p0', 'p1', 'p2', 'p3']);
export const LIMITS = Object.freeze({
  issueMax: 2000, title: 200, body: 10000, commentMax: 200, commentBody: 2000,
  labelMax: 10, label: 30, component: 60, watcherMax: 50, historyMax: 300, name: 64, blockReason: 500,
  bulkMax: 200,
});
/** 최근 완료로 보여 주는 기간(ms) — 보드의 '완료' 열. */
export const RECENT_DONE_MS = 14 * 24 * 3600_000;
export const ISSUES_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
export const WRITE_DELAY_MS = 300;
export const PERSIST_WAIT_MS = 3000;
export const RETRY_DEFAULTS = Object.freeze({ max: 6, baseMs: 5000, capMs: 300000 });
let RETRY = { ...RETRY_DEFAULTS };

/** 쓰기 실패 사유 코드 → 짧은 문구(bulletin/store.js WRITE_ERROR_TEXT 와 같은 표). */
export const WRITE_ERROR_TEXT = Object.freeze({
  ENOSPC: '디스크 공간이 부족합니다', EDQUOT: '디스크 할당량(quota)을 넘었습니다', EACCES: '저장 폴더·파일에 쓰기 권한이 없습니다',
  EPERM: '저장 폴더·파일에 대한 작업이 허용되지 않습니다', EROFS: '읽기 전용 파일 시스템입니다', EISDIR: '저장 파일 자리에 폴더가 있습니다',
  ENOTDIR: '설정 폴더 경로의 일부가 폴더가 아닙니다', ENOENT: '설정 폴더를 찾지 못했습니다', EMFILE: '열린 파일이 너무 많습니다',
  ENFILE: '시스템 전체의 열린 파일이 너무 많습니다', EIO: '디스크 입출력 오류입니다', EBUSY: '파일이 사용 중입니다',
  EUNKNOWN: '파일을 쓰지 못했습니다(서버 로그에서 원인을 확인하세요)',
});

/** 합계 상한 — env ISSUES_MAX_BYTES(바이트). 빈 값·비수치·0 이하는 기본값(numOrNull — `KEY=` 한 줄이 상한을 0 으로 만들지 않게), 하한 64KB. */
export function issuesMaxBytes() {
  const n = numOrNull(process.env.ISSUES_MAX_BYTES);
  if (n == null || n <= 0) return ISSUES_MAX_BYTES_DEFAULT;
  return Math.max(65_536, Math.trunc(n));
}

export const issuesFile = () => path.join(config.configDir, 'issues.json');

/* ───── 파일 입출력(테스트가 바꿔 끼운다 — 실패 주입) ───── */
const realIo = Object.freeze({
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  writeTmp: async (tmp, body) => {
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
  },
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  syncDir: async (dir) => { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } },
  writeFileAtomicSync: (file, body) => atomicWriteFileSync(file, body, { mode: 0o600 }),
  unlinkSync: (p) => fs.unlinkSync(p),
});
let io = realIo;
/** 테스트 전용 — 파일 입출력 일부를 바꾸고(실패 주입) 재시도 상수를 줄인다. 인자 없이 부르면 원래대로. */
export function _setIssuesIoForTest(over = null, retry = null) {
  io = over ? { ...realIo, ...over } : realIo;
  RETRY = retry ? { ...RETRY_DEFAULTS, ...retry } : { ...RETRY_DEFAULTS };
}

/* ───── 캐시·쓰기 상태(파일 하나) ───── */
let cache = null; // { issues: [], nextSeq, sizes: Map(id → bytes), bytes }
let w = null;     // 쓰기 상태
function writer() {
  if (!w) {
    w = {
      timer: null, writing: false, dirty: false, gen: 0, writes: 0, lastWriteAt: null, lastWriteError: null,
      seq: 0, savedSeq: 0, attemptSeq: 0, lastFailSeq: 0, unsavedSince: null, nextUnsavedAt: null,
      failCount: 0, retryTimer: null, retryAt: null, expedite: false, tmp: null, waiters: [],
    };
  }
  return w;
}

const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

function load() {
  if (cache) return cache;
  writer();
  const file = issuesFile();
  let issues = []; let nextSeq = 1;
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.issues)) throw new Error('issues 배열이 없습니다');
      issues = j.issues.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.key === 'string');
      const n = numOrNull(j.nextSeq);
      const maxNum = issues.reduce((m, x) => Math.max(m, Number(x.num) || 0), 0);
      nextSeq = Math.max(n != null && n >= 1 ? Math.trunc(n) : 1, maxNum + 1);
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[issues] issues.json 을 읽지 못해 빈 목록으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
    issues = []; nextSeq = 1;
  }
  const sizes = new Map(issues.map((x) => [x.id, jsonBytes(x)]));
  let bytes = 0; for (const b of sizes.values()) bytes += b;
  cache = { issues, nextSeq, sizes, bytes };
  return cache;
}

/** 캐시를 바꾸고 쓰기를 예약한다. changed = 바뀐 이슈(크기 재계산) · removedId = 지운 이슈 id. */
function commit(issues, { changed = null, removedId = null, nextSeq = null } = {}) {
  const c = load();
  c.issues = issues;
  if (nextSeq != null) c.nextSeq = nextSeq;
  if (removedId) { c.bytes -= c.sizes.get(removedId) || 0; c.sizes.delete(removedId); }
  if (changed) { const b = jsonBytes(changed); c.bytes += b - (c.sizes.get(changed.id) || 0); c.sizes.set(changed.id, b); }
  c.bytes = Math.max(0, c.bytes);
  const ww = writer();
  const now = Date.now();
  if (ww.seq === ww.savedSeq) ww.unsavedSince = now;
  if (ww.writing && ww.seq === ww.attemptSeq) ww.nextUnsavedAt = now;
  ww.seq += 1;
  scheduleWrite();
}

function scheduleWrite() {
  const ww = writer();
  ww.dirty = true;
  if (ww.timer) return;
  ww.timer = setTimeout(runWrite, WRITE_DELAY_MS);
  ww.timer.unref?.();
}
function clearRetry(ww) { if (ww.retryTimer) { clearTimeout(ww.retryTimer); ww.retryTimer = null; } ww.retryAt = null; }
const serialize = () => JSON.stringify({ v: 1, nextSeq: cache?.nextSeq ?? 1, issues: cache?.issues || [] });
const tmpPathOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
function errCodeOf(e) { const c = typeof e?.code === 'string' ? e.code : ''; return /^E[A-Z0-9]{2,15}$/.test(c) ? c : 'EUNKNOWN'; }

function noteWriteFail(ww, e, phase, seq) {
  const code = errCodeOf(e);
  ww.lastWriteError = { at: Date.now(), code, phase, message: WRITE_ERROR_TEXT[code] || WRITE_ERROR_TEXT.EUNKNOWN };
  ww.lastFailSeq = Math.max(ww.lastFailSeq, seq);
  ww.dirty = true; ww.failCount += 1;
  clearRetry(ww);
  let next;
  if (ww.failCount <= RETRY.max) {
    const delay = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** (ww.failCount - 1));
    ww.retryAt = Date.now() + delay;
    ww.retryTimer = setTimeout(() => {
      ww.retryTimer = null; ww.retryAt = null;
      if (w !== ww) return;
      if (ww.seq <= ww.savedSeq || ww.writing || ww.timer) return;
      runWrite();
    }, delay);
    ww.retryTimer.unref?.();
    next = `${Math.round(delay / 1000)}초 뒤 다시 씁니다(${ww.failCount}/${RETRY.max})`;
  } else next = `자동 재시도 ${RETRY.max}회를 다 써서 멈춥니다 — 다음 변경·종료 때 다시 씁니다`;
  const sys = typeof e?.syscall === 'string' ? ` ${e.syscall}` : '';
  console.warn(`[issues] issues.json 저장 실패(${code}${sys} · ${phase}) — 미저장 변경 ${Math.max(0, ww.seq - ww.savedSeq)}건 · ${next}`);
}
function noteWriteOk(ww, seq) {
  ww.savedSeq = Math.max(ww.savedSeq, seq);
  ww.writes += 1; ww.lastWriteAt = Date.now(); ww.lastWriteError = null; ww.failCount = 0;
  clearRetry(ww);
  ww.unsavedSince = ww.seq > ww.savedSeq ? (ww.nextUnsavedAt ?? Date.now()) : null;
}
function persistOfWriter(ww, seq) {
  const state = ww.savedSeq >= seq ? 'saved' : (ww.lastWriteError ? 'failed' : 'pending');
  return { state, seq, savedSeq: ww.savedSeq };
}
function settleWaiters(ww) {
  if (!ww.waiters.length) return;
  const keep = [];
  for (const x of ww.waiters) {
    if (ww.savedSeq >= x.seq || (ww.lastWriteError && ww.lastFailSeq >= x.seq)) { clearTimeout(x.t); x.resolve(persistOfWriter(ww, x.seq)); } else keep.push(x);
  }
  ww.waiters = keep;
}

function runWrite() {
  const ww = writer();
  if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
  if (ww.writing) { scheduleWrite(); return; }
  clearRetry(ww);
  if (!cache) { ww.dirty = false; return; }
  const file = issuesFile();
  const body = serialize();
  const seq = ww.seq;
  const gen = ++ww.gen;
  ww.dirty = false; ww.writing = true; ww.attemptSeq = seq; ww.nextUnsavedAt = null;
  const tmp = tmpPathOf(file);
  ww.tmp = tmp;
  let failed = false;
  let phase = 'mkdir';
  (async () => {
    try {
      await io.mkdir(path.dirname(file));
      phase = 'write';
      await io.writeTmp(tmp, body);
      if (gen !== ww.gen) { await io.unlink(tmp).catch(() => {}); return; } // 그 사이 동기 flush 가 더 새 본문을 썼다
      phase = 'rename';
      await io.rename(tmp, file);
      try { await io.syncDir(path.dirname(file)); } catch { /* 디렉터리 fsync 미지원 */ }
      if (gen === ww.gen) noteWriteOk(ww, seq);
    } catch (e) {
      if (gen === ww.gen) { failed = true; noteWriteFail(ww, e, phase, seq); }
      await io.unlink(tmp).catch(() => {});
    } finally {
      ww.writing = false; ww.tmp = null;
      const urgent = ww.expedite; ww.expedite = false;
      settleWaiters(ww);
      if (ww.dirty && (urgent || !failed)) { if (urgent) runWrite(); else scheduleWrite(); }
    }
  })();
}

function expediteWrite() {
  const ww = writer();
  if (ww.seq <= ww.savedSeq) return;
  if (ww.writing) { ww.expedite = true; ww.dirty = true; return; }
  runWrite();
}

/** 대기·진행 중인 쓰기를 동기로 끝낸다(종료 훅·테스트). @returns 썼는가 */
export function flushIssuesNow() {
  const ww = writer();
  if (ww.timer) { clearTimeout(ww.timer); ww.timer = null; }
  if (!cache) { ww.dirty = false; return false; }
  if (!ww.dirty && !ww.writing && ww.seq <= ww.savedSeq) return false;
  const body = serialize();
  const seq = ww.seq;
  ww.gen += 1; // 진행 중인 비동기 쓰기를 무효화한다(옛 본문으로 덮지 않게)
  if (ww.writing && ww.tmp) { try { io.unlinkSync(ww.tmp); } catch { /* 이미 rename 됐거나 아직 없다 */ } }
  try {
    io.writeFileAtomicSync(issuesFile(), body);
    ww.dirty = false;
    noteWriteOk(ww, seq);
    settleWaiters(ww);
    return true;
  } catch (e) { noteWriteFail(ww, e, 'flush', seq); settleWaiters(ww); return false; }
}
registerExitFlush('issues/store', () => { flushIssuesNow(); });

/** 테스트 전용 — 예약·진행 중인 쓰기가 끝날 때까지(상한 안에서). */
export async function issuesIdle({ maxMs = 5_000 } = {}) {
  const t0 = Date.now();
  while (w && (w.writing || w.timer)) {
    if (Date.now() - t0 > maxMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}
/** 테스트 전용 — 대기분을 쓰고 캐시를 비운다(CONFIG_DIR 를 바꾼 뒤 다시 읽게). */
export function _resetIssuesCache() {
  flushIssuesNow();
  if (w) {
    clearRetry(w);
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    for (const x of w.waiters) { clearTimeout(x.t); x.resolve(persistOfWriter(w, x.seq)); }
    w.waiters = [];
  }
  cache = null; w = null;
}

/** 지금까지 받은 마지막 변경 순번(라우트가 쓰기 직후 부른다 — 쓰기는 동기라 사이에 다른 변경이 끼지 않는다). */
export function issuesSeq() { return w?.seq ?? 0; }
/** 한 변경이 디스크에 닿을 때까지(또는 그 변경을 담은 쓰기가 실패할 때까지) 기다린다 — 상한 maxMs. 넘기면 그때의 상태(대개 pending). */
export function waitIssuesPersist(seq, { maxMs = PERSIST_WAIT_MS } = {}) {
  const ww = writer();
  if (ww.savedSeq >= seq) return Promise.resolve(persistOfWriter(ww, seq));
  expediteWrite();
  if (ww.savedSeq >= seq || (ww.lastWriteError && ww.lastFailSeq >= seq && !ww.writing)) return Promise.resolve(persistOfWriter(ww, seq));
  return new Promise((resolve) => {
    const x = { seq, resolve, t: null };
    x.t = setTimeout(() => { ww.waiters = ww.waiters.filter((y) => y !== x); resolve(persistOfWriter(ww, seq)); }, Math.max(0, Math.trunc(Number(maxMs) || 0)));
    x.t.unref?.();
    ww.waiters.push(x);
  });
}
/**
 * 저장소 건강 — 화면 배너가 쓴다. admin:false 면 상태·시각만(사유 코드·횟수는 관리자 상세). 경로·내용·계정명은 싣지 않는다.
 */
export function issuesPersist({ admin = false, now = Date.now() } = {}) {
  if (!w) return { state: 'saved', loaded: false, unsavedSince: null, retrying: false, retryExhausted: false };
  const p = persistOfWriter(w, w.seq);
  const retrying = !!w.retryTimer;
  const out = { state: p.state, loaded: true, unsavedSince: p.state === 'saved' ? null : w.unsavedSince, retrying, retryExhausted: p.state === 'failed' && !retrying && w.failCount > RETRY.max, writing: w.writing };
  if (!admin) return out;
  return {
    ...out, unsaved: Math.max(0, w.seq - w.savedSeq), lastSavedAt: w.lastWriteAt,
    lastWriteError: w.lastWriteError ? { ...w.lastWriteError } : null, failCount: w.failCount, writes: w.writes,
    nextRetryAt: retrying ? w.retryAt : null, retryMax: RETRY.max, unsavedForMs: out.unsavedSince ? Math.max(0, now - out.unsavedSince) : null,
    bytes: cache?.bytes ?? null, maxBytes: issuesMaxBytes(),
  };
}

/* ───── 검증 ───── */
const newId = () => crypto.randomBytes(8).toString('hex');
function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
function limitError(msg, extra) { const e = new Error(msg); e.status = 409; if (extra) e.extra = extra; return e; }
function notFound() { const e = new Error('없는 이슈입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }

/** 문자열 칸: 제어 문자(줄바꿈·탭 제외) 제거 · 앞뒤 공백 제거 · 상한 초과는 오류. */
function text(v, max, field, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !s) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자를 넘습니다(${s.length}자)`);
  return capStr(s, max);
}
/** 계정명(담당자·관찰자): 공백·제어 문자 없는 1~64자. 빈 값은 '' (미할당). AD 계정(DOMAIN\user)도 받는다. */
function nameField(v, field) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  const s = v.trim();
  if (!s) return '';
  // eslint-disable-next-line no-control-regex
  if (s.length > LIMITS.name || /[\s\u0000-\u001f\u007f]/.test(s)) throw fieldError(field, `공백 없는 ${LIMITS.name}자 이하의 계정명이어야 합니다`);
  return capStr(s, LIMITS.name);
}
function enumField(v, list, field, def) {
  if (v == null || v === '') { if (def !== undefined) return def; throw fieldError(field, `${list.join('·')} 중 하나여야 합니다`); }
  if (!list.includes(v)) throw fieldError(field, `${list.join('·')} 중 하나여야 합니다`);
  return v;
}
/** 기한: 빈 값 = 없음(null). 숫자(epoch ms) 또는 날짜 문자열. 못 읽으면 오류. */
function timeField(v, field) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
  if (!Number.isFinite(n) || n <= 0) throw fieldError(field, '시각을 읽지 못했습니다');
  return Math.trunc(n);
}
function labelsField(v) {
  if (v == null) return [];
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) throw fieldError('labels', '배열이어야 합니다');
  const out = [];
  for (const x of v) {
    const s = text(x, LIMITS.label, 'labels').toLowerCase().replace(/\s+/g, '-');
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > LIMITS.labelMax) throw fieldError('labels', `라벨은 ${LIMITS.labelMax}개까지입니다`);
  return out;
}
function watchersField(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw fieldError('watchers', '배열이어야 합니다');
  const out = [];
  for (const x of v) { const s = nameField(x, 'watchers'); if (s && !out.includes(s)) out.push(s); }
  if (out.length > LIMITS.watcherMax) throw fieldError('watchers', `관찰자는 ${LIMITS.watcherMax}명까지입니다`);
  return out;
}

/* ───── 조회 ───── */
const commentsOf = (x) => (Array.isArray(x?.comments) ? x.comments.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : []);
const historyOf = (x) => (Array.isArray(x?.history) ? x.history.filter((h) => h && typeof h === 'object') : []);
const isOpen = (x) => x.status !== 'done';

/** 목록용 요약(본문·댓글·이력 제외). */
export function summary(x) {
  return {
    id: x.id, key: x.key, num: x.num, type: x.type, title: x.title, status: x.status, priority: x.priority,
    blocked: x.blocked ? { reason: x.blocked.reason, at: x.blocked.at, by: x.blocked.by } : null,
    assignee: x.assignee || '', reporter: x.reporter || '', labels: Array.isArray(x.labels) ? x.labels : [], component: x.component || '',
    dueAt: x.dueAt ?? null, createdAt: x.createdAt, updatedAt: x.updatedAt || x.createdAt, closedAt: x.closedAt ?? null,
    comments: commentsOf(x).length, watchers: Array.isArray(x.watchers) ? x.watchers.length : 0,
  };
}
/** 상세 — 댓글·이력 포함. `me` 는 보는 사람(관찰 여부). */
export function viewIssue(x, me = '') {
  return {
    ...summary(x), body: x.body || '', watcherNames: Array.isArray(x.watchers) ? x.watchers : [], watching: !!me && Array.isArray(x.watchers) && x.watchers.includes(me),
    createdBy: x.createdBy || x.reporter || '', updatedBy: x.updatedBy || '',
    comments: commentsOf(x).map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
    history: historyOf(x), historyDropped: Number(x.historyDropped) || 0,
  };
}

const PRIO_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
const needleOf = (q) => (typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '');

/**
 * 목록 — 필터는 서버가 건다. `done`: 'open'(기본 — 완료 제외) · 'recent'(최근 RECENT_DONE_MS 안의 완료 포함) · 'all'.
 * 정렬: 우선순위 → 기한(없는 것은 뒤) → 갱신 최신. 페이지 인자는 호출부가 pageArgs 로 좁혀 넘긴다.
 */
export function listIssues({ q = '', status = '', assignee = null, priority = '', type = '', label = '', done = 'open', offset = 0, limit = 200, now = Date.now() } = {}) {
  const all = load().issues;
  const needle = needleOf(q);
  const hit = all.filter((x) => {
    if (status) { if (x.status !== status) return false; } else if (done === 'open') { if (!isOpen(x)) return false; } else if (done === 'recent') { if (!isOpen(x) && !(x.closedAt && now - x.closedAt <= RECENT_DONE_MS)) return false; }
    if (assignee != null && assignee !== '*' && (x.assignee || '') !== assignee) return false;
    if (priority && x.priority !== priority) return false;
    if (type && x.type !== type) return false;
    if (label && !(Array.isArray(x.labels) && x.labels.includes(label))) return false;
    if (needle && !`${x.key}\n${x.title}\n${x.body || ''}\n${x.assignee || ''}\n${x.reporter || ''}\n${(x.labels || []).join(' ')}\n${x.component || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const rows = hit.map(summary).sort((a, b) => (PRIO_RANK[a.priority] ?? 9) - (PRIO_RANK[b.priority] ?? 9)
    || ((a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)) || (b.updatedAt - a.updatedAt));
  return { total: rows.length, all: all.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

export function getIssue(key, me = '') {
  const x = load().issues.find((i) => i.key === key);
  if (!x) throw notFound();
  return viewIssue(x, me);
}

/**
 * 통계 — 상태별·우선순위별 열린 건수, 미할당·기한 초과·오늘/내일 마감, 담당자별 부하(열린·진행·검토·초과), 최근 7일 완료.
 * 전부 '열린 이슈' 기준이다(완료는 세지 않는다).
 */
export function issueStats({ now = Date.now() } = {}) {
  const all = load().issues;
  const open = all.filter(isOpen);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
  const byAssignee = new Map();
  let unassigned = 0; let overdue = 0; let dueSoon = 0; let blocked = 0;
  const soonEnd = now + 2 * 24 * 3600_000;
  for (const x of open) {
    byStatus[x.status] = (byStatus[x.status] || 0) + 1;
    byPriority[x.priority] = (byPriority[x.priority] || 0) + 1;
    const late = x.dueAt != null && x.dueAt < now;
    if (late) overdue += 1; else if (x.dueAt != null && x.dueAt <= soonEnd) dueSoon += 1;
    if (x.blocked) blocked += 1;
    if (!x.assignee) { unassigned += 1; continue; }
    let a = byAssignee.get(x.assignee);
    if (!a) { a = { assignee: x.assignee, open: 0, progress: 0, review: 0, overdue: 0, p0: 0 }; byAssignee.set(x.assignee, a); }
    a.open += 1; if (x.status === 'progress') a.progress += 1; if (x.status === 'review') a.review += 1; if (late) a.overdue += 1; if (x.priority === 'p0') a.p0 += 1;
  }
  byStatus.done = all.filter((x) => !isOpen(x) && x.closedAt && now - x.closedAt <= 7 * 24 * 3600_000).length;
  return {
    open: open.length, total: all.length, byStatus, byPriority, unassigned, overdue, dueSoon, blocked,
    byAssignee: [...byAssignee.values()].sort((a, b) => b.open - a.open || a.assignee.localeCompare(b.assignee)),
    doneLast7d: byStatus.done,
  };
}

/** 담당자 후보에 더할 이름 — 이슈에 이미 보이는 담당자·보고자·관찰자(AD 계정처럼 목록에 없는 사람도 다시 고를 수 있게). */
export function knownNames() {
  const s = new Set();
  for (const x of load().issues) {
    if (x.assignee) s.add(x.assignee); if (x.reporter) s.add(x.reporter);
    for (const n of Array.isArray(x.watchers) ? x.watchers : []) s.add(n);
  }
  return [...s].sort();
}

/* ───── 변경 ───── */
const HIST_VAL = 80;
const hv = (v) => (v == null || v === '' ? '' : capStr(typeof v === 'string' ? v : JSON.stringify(v), HIST_VAL));
/** 이력 한 줄을 더한다 — 상한을 넘으면 오래된 것부터 지우고 지운 수를 센다(조용히 사라지지 않게). */
function withHistory(x, entries) {
  if (!entries.length) return x;
  let history = [...historyOf(x), ...entries];
  let dropped = Number(x.historyDropped) || 0;
  if (history.length > LIMITS.historyMax) { dropped += history.length - LIMITS.historyMax; history = history.slice(history.length - LIMITS.historyMax); }
  return { ...x, history, ...(dropped ? { historyDropped: dropped } : {}) };
}
function assertRoom(c, nextIssue, prevId = null) {
  const max = issuesMaxBytes();
  const next = c.bytes - (prevId ? (c.sizes.get(prevId) || 0) : 0) + jsonBytes(nextIssue);
  if (next > max) throw limitError('issues-full', { bytes: c.bytes, max });
}
function replace(c, x, entries, user, { touch = true } = {}) {
  const i = c.issues.findIndex((y) => y.id === x.id);
  if (i < 0) throw notFound();
  const now = Date.now();
  const y = withHistory({ ...x, ...(touch ? { updatedAt: Math.max(now, (x.updatedAt || 0) + 1), updatedBy: user } : {}) }, entries);
  assertRoom(c, y, x.id);
  const issues = [...c.issues]; issues[i] = y;
  commit(issues, { changed: y });
  return y;
}
const findRaw = (key) => { const x = load().issues.find((i) => i.key === key); if (!x) throw notFound(); return x; };

export function createIssue(body, user) {
  const c = load();
  if (c.issues.length >= LIMITS.issueMax) throw limitError(`이슈는 ${LIMITS.issueMax}건까지 보관합니다 — 관리자에게 지난 이슈 정리를 요청하세요`);
  const now = Date.now();
  const b = body || {};
  const assignee = nameField(b.assignee, 'assignee');
  const status = enumField(b.status, STATUSES, 'status', 'backlog');
  if (status === 'progress' && !assignee) throw fieldError('status', '진행 중으로 두려면 담당자가 있어야 합니다');
  const num = c.nextSeq;
  const x = {
    id: newId(), key: `${KEY_PREFIX}-${num}`, num,
    type: enumField(b.type, TYPES, 'type', 'task'),
    title: text(b.title, LIMITS.title, 'title', { required: true }),
    body: text(b.body, LIMITS.body, 'body'),
    status, blocked: null,
    priority: enumField(b.priority, PRIORITIES, 'priority', 'p2'),
    assignee, reporter: user,
    watchers: watchersField(b.watchers), labels: labelsField(b.labels), component: text(b.component, LIMITS.component, 'component'),
    dueAt: timeField(b.dueAt, 'dueAt'),
    createdAt: now, createdBy: user, updatedAt: now, updatedBy: user, closedAt: status === 'done' ? now : null,
    comments: [],
    history: [{ at: now, by: user, field: 'created', from: '', to: `${KEY_PREFIX}-${num}` }, ...(assignee ? [{ at: now, by: user, field: 'assignee', from: '', to: assignee }] : [])],
  };
  assertRoom(c, x);
  commit([...c.issues, x], { changed: x, nextSeq: num + 1 });
  return viewIssue(x, user);
}

/** 제목·본문·유형·우선순위·기한·라벨·컴포넌트·관찰자 — 보낸 칸만 바꾼다. 상태·담당자·보류는 전용 함수로. */
export function updateIssue(key, body, user) {
  const c = load();
  const x = findRaw(key);
  const b = body || {};
  const has = (k) => Object.hasOwn(b, k);
  const entries = [];
  const now = Date.now();
  const next = { ...x };
  const set = (field, val, { hist = true } = {}) => {
    const before = x[field]; const same = JSON.stringify(before ?? null) === JSON.stringify(val ?? null);
    if (same) return;
    next[field] = val;
    if (hist) entries.push({ at: now, by: user, field, from: hv(before), to: hv(val) });
  };
  if (has('title')) set('title', text(b.title, LIMITS.title, 'title', { required: true }));
  if (has('body')) set('body', text(b.body, LIMITS.body, 'body'), { hist: false });
  if (has('type')) set('type', enumField(b.type, TYPES, 'type'));
  if (has('priority')) set('priority', enumField(b.priority, PRIORITIES, 'priority'));
  if (has('dueAt')) set('dueAt', timeField(b.dueAt, 'dueAt'));
  if (has('labels')) set('labels', labelsField(b.labels));
  if (has('component')) set('component', text(b.component, LIMITS.component, 'component'));
  if (has('watchers')) set('watchers', watchersField(b.watchers));
  if (has('body') && x.body !== next.body) entries.push({ at: now, by: user, field: 'body', from: '', to: '(본문 수정)' });
  const changed = entries.length > 0 || (has('body') && x.body !== next.body);
  if (!changed) return viewIssue(x, user);
  return viewIssue(replace(c, next, entries, user), user);
}

/** 상태 전이. progress 는 담당자 필수 · done 은 closedAt · done 에서 나오면 closedAt 해제. 같은 상태면 그대로. */
export function setStatus(key, status, user) {
  const c = load();
  const x = findRaw(key);
  const s = enumField(status, STATUSES, 'status');
  if (s === x.status) return viewIssue(x, user);
  if (s === 'progress' && !x.assignee) throw fieldError('status', '진행 중으로 옮기려면 담당자가 있어야 합니다 — 먼저 할당하세요');
  const now = Date.now();
  const next = { ...x, status: s, closedAt: s === 'done' ? now : null };
  return viewIssue(replace(c, next, [{ at: now, by: user, field: 'status', from: x.status, to: s }], user), user);
}

/** 담당자 변경('' = 할당 해제). 재할당 이력 + 선택 사유. 같은 담당자면 그대로. */
export function assignIssue(key, assignee, user, { reason = '' } = {}) {
  const c = load();
  const x = findRaw(key);
  const a = nameField(assignee, 'assignee');
  if (a === (x.assignee || '')) return viewIssue(x, user);
  const why = text(reason, LIMITS.blockReason, 'reason');
  const now = Date.now();
  const next = { ...x, assignee: a };
  return viewIssue(replace(c, next, [{ at: now, by: user, field: 'assignee', from: x.assignee || '', to: a, ...(why ? { note: why } : {}) }], user), user);
}

/** 여러 이슈에 같은 담당자 — 결과는 키마다 밝힌다(없는 키·오류는 건너뛰고 사유를 적는다 — 조용히 넘기지 않는다). */
export function bulkAssign(keys, assignee, user) {
  if (!Array.isArray(keys)) throw fieldError('keys', '배열이어야 합니다');
  if (keys.length > LIMITS.bulkMax) throw fieldError('keys', `한 번에 ${LIMITS.bulkMax}건까지입니다`);
  const a = nameField(assignee, 'assignee');
  const results = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) { results.push({ key: String(k).slice(0, 20), ok: false, reason: '키 형식이 아닙니다' }); continue; }
    try { assignIssue(k, a, user); results.push({ key: k, ok: true }); } catch (e) { results.push({ key: k, ok: false, reason: e.message }); }
  }
  return { assignee: a, results, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** 보류 표지 — on 이면 사유 필수. off 면 해제. */
export function setBlocked(key, on, user, { reason = '' } = {}) {
  const c = load();
  const x = findRaw(key);
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const now = Date.now();
  if (on) {
    const why = text(reason, LIMITS.blockReason, 'reason', { required: true });
    const next = { ...x, blocked: { reason: why, at: now, by: user } };
    return viewIssue(replace(c, next, [{ at: now, by: user, field: 'blocked', from: x.blocked ? x.blocked.reason : '', to: why }], user), user);
  }
  if (!x.blocked) return viewIssue(x, user);
  const next = { ...x, blocked: null };
  return viewIssue(replace(c, next, [{ at: now, by: user, field: 'blocked', from: x.blocked.reason, to: '' }], user), user);
}

/** 관찰 켜기/끄기(본인). 상태를 명시한다(재전송이 두 번 바꾸지 않게). 이력·갱신 시각은 건드리지 않는다. */
export function setWatch(key, user, on) {
  if (!user) throw forbidden('로그인한 사용자만 관찰할 수 있습니다');
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const c = load();
  const x = findRaw(key);
  const cur = Array.isArray(x.watchers) ? x.watchers : [];
  if (cur.includes(user) === on) return viewIssue(x, user);
  if (on && cur.length >= LIMITS.watcherMax) throw limitError(`관찰자는 ${LIMITS.watcherMax}명까지입니다`);
  const next = { ...x, watchers: on ? [...cur, user] : cur.filter((n) => n !== user) };
  return viewIssue(replace(c, next, [], user, { touch: false }), user);
}

export function addComment(key, body, user) {
  const c = load();
  const x = findRaw(key);
  const comments = commentsOf(x);
  if (comments.length >= LIMITS.commentMax) throw limitError(`댓글은 이슈마다 ${LIMITS.commentMax}개까지입니다`);
  const cm = { id: newId(), author: user, body: text(body?.body, LIMITS.commentBody, 'body', { required: true }), createdAt: Date.now() };
  const next = { ...x, comments: [...comments, cm] };
  replace(c, next, [], user);
  return cm;
}

/** 댓글 삭제 — 작성자 본인 또는 관리자(isMod). */
export function deleteComment(key, commentId, user, { isMod = false } = {}) {
  const c = load();
  const x = findRaw(key);
  const comments = commentsOf(x);
  const cm = comments.find((y) => y.id === commentId);
  if (!cm) throw notFound();
  if (!isMod && cm.author !== user) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  replace(c, { ...x, comments: comments.filter((y) => y.id !== commentId) }, [], user, { touch: false });
  return cm;
}

/** 이슈 삭제 — 보고자 본인 또는 관리자(isMod). 댓글·이력이 함께 사라진다. */
export function deleteIssue(key, user, { isMod = false } = {}) {
  const c = load();
  const x = findRaw(key);
  if (!isMod && x.reporter !== user) throw forbidden('보고자 본인이나 관리자만 지울 수 있습니다');
  commit(c.issues.filter((y) => y.id !== x.id), { removedId: x.id });
  return summary(x);
}
