/**
 * bulletin/store.js — 접속 공지(팝업)와 게시판 글 저장소(v2.722).
 *
 * 두 파일로 나눈다 — `notices.json`(관리자가 쓰는 공지 · 로그인 뒤 팝업으로 보인다) ·
 * `board.json`(로그인 사용자가 쓰는 게시판 글 · 댓글). 둘 다 사용자가 손으로 쓴 값이라
 * 원자적 쓰기 + 손상 보존(손상본을 빈 목록으로 덮어쓰지 않는다 — v2.580 ping/store.js 와 같은 규칙).
 *
 * 상한(조용히 버리지 않는다 — 넘으면 저장을 거부하고 사유를 돌려준다):
 *   공지 200개 · 제목 200자 · 본문 5,000자
 *   글 2,000개 · 제목 200자 · 본문 10,000자 · 글당 댓글 300개(답글·삭제 표시 포함) · 댓글 2,000자 · 항목당 공감 2,000명
 * 시각은 epoch ms 숫자 하나다. 문자열 값은 `capStr` 로 평탄화해 원문(SlicedString)을 붙잡지 않는다.
 *
 * v2.723 — 답글(대댓글)과 공감:
 *  · 답글은 댓글 배열에 그대로 두고 `parentId`(최상위 댓글 id)로 묶는다 — 한 단계만이다. 답글에 답글을 달면 같은 최상위 댓글
 *    아래에 붙고 `replyTo`(답하는 사람)를 남긴다. 저장 모양이 예전 댓글과 같아 옛 board.json 을 그대로 읽는다.
 *  · 답글이 달린 댓글을 지우면 내용만 지우고 자리('삭제된 댓글')를 남긴다 — 통째로 지우면 답글이 무엇에 대한 것인지 사라진다.
 *    그 자리의 마지막 답글까지 지워지면 자리도 지운다.
 *  · 공감은 누른 사람 이름 목록(`likes`)이다 — 한 사람당 한 번, 다시 누르면 취소. 요청은 상태를 명시한다(`on: true|false`)라
 *    연타·재전송이 두 번 세지 않는다. 화면에는 개수·내가 눌렀는지·앞 30명 이름만 내보낸다.
 *
 * v2.727(감사 B-01/F-02) — 쓰기는 디바운스·비동기, 합계에 상한:
 *  · 예전에는 공감 한 번도 파일 **전체**를 동기로 다시 직렬화(들여쓰기 1)하고 fsync 했다 — 13MB 에서 공감 1회 145~306ms,
 *    상한 곱(약 1.2GB) 근처에서는 클릭당 초 단위의 이벤트 루프 정지였다(합성 글 500·댓글 20 실측은 fix-G2.md).
 *  · 이제 캐시(메모리)가 진실이고 파일 쓰기는 `WRITE_DELAY_MS`(300ms) 안의 변경을 묶어 **한 번** 비동기로 쓴다(tmp → fsync →
 *    rename). 쓰는 중에 또 바뀌면 끝난 뒤 한 번 더 쓴다. 종료 때는 `util/exitFlush.js` 에 등록한 동기 flush 가 대기분을 쓴다
 *    (v2.582 규약 — 자체 process.on 금지).
 *  · `central/edgeRecord.js createDebouncedWriter` 를 쓰지 않은 이유: 그 헬퍼는 파일을 **상태 파일**로 등록해(`registerStateFile`)
 *    백업 변경 감시·엣지 설정 push 가 그 파일을 설정이 아닌 것으로 본다. 게시판·공지는 사용자 데이터라 백업 번들에는 들어가야
 *    하고(변경 감시 지문에서만 뺀다 — backup/service.js CHANGE_WATCH_EXCLUDE), 그 헬퍼는 fsync·실패 상태도 없다.
 *  · 합계 상한 `boardMaxBytes()`(env BOARD_MAX_BYTES, 기본 16MB): 항목 상한의 곱이 1.2GB 라 파일 총량을 막는 것이 없었다.
 *    글 작성·수정·댓글 추가가 상한을 넘기게 되면 **409 `board-full`**(bytes·max 동봉)로 거부한다 — 조용히 자르지 않는다.
 *    공감·고정·삭제는 상한과 무관하다(정리가 막히면 안 된다). 크기는 마지막 실제 쓰기의 바이트 + 그 뒤 변경분의 추정 합이고
 *    실제 쓰기마다 다시 맞춘다(전체를 다시 직렬화해 재지 않는다 — 그것이 바로 없애려는 비용이다).
 *
 * 리뷰 I-05(그룹 D) — '수용됨' 과 '저장 완료' 를 나눈다:
 *  · 변경마다 파일별 순번(`seq`)을 올리고, 디스크에 실제로 쓴 마지막 순번을 `savedSeq` 로 든다. 한 변경의 상태는 셋이다 —
 *    `saved`(savedSeq ≥ 그 순번) · `failed`(아직 안 썼고 가장 최근 쓰기 시도가 실패했다) · `pending`(아직 안 썼고 실패 기록 없음 —
 *    정상 묶음 창). 화면·점검은 이 판정 하나(`persistOf`)를 쓴다.
 *  · 글·댓글 작성·수정·삭제와 공지는 라우트가 `waitBulletinPersist` 로 **상한 있는 확인**(PERSIST_WAIT_MS)을 한다 — 묶음 창을
 *    앞당겨(expedite) 곧바로 쓰고 그 결과를 응답에 싣는다. 공감은 기다리지 않는다(연타 묶음이 v2.727 의 목적이다).
 *  · 실패하면 **제한된 지수 backoff** 로 다시 쓴다(`RETRY` — 기본 5초부터 두 배씩 최대 6회·상한 5분). 6회를 넘기면 멈추고
 *    다음 변경·관리자 '지금 다시 저장'(`retryBulletinWrites`)·종료 flush 가 다시 시도한다(무한 루프 금지 — 디스크가 계속 거부하면
 *    루프가 곧 부하다). 실패 상태는 저장될 때까지 남는다.
 *  · 실패 기록(`lastWriteError`)은 **사유 코드(ENOSPC 등) + 단계(write·rename …) + 짧은 문구**다 — 오류 원문은 tmp 파일의 절대
 *    경로를 담으므로 상태에도 콘솔에도 싣지 않는다(코드·syscall 만).
 *  · ✅ 예전 머리말의 '남는 창'(동기 flush 와 진행 중 비동기 rename 이 겹치면 옛 본문이 새 본문을 덮는다 — 그때 상태는 '저장됨'
 *    이라 말했다, 재현 확인)을 닫았다: 동기 flush 가 진행 중인 비동기 쓰기의 **tmp 파일을 먼저 지운다**. 아직 커널에 닿지 않은
 *    rename 은 ENOENT 로 실패하고(대체됨 — 실패로 세지 않는다), 이미 끝난 rename 은 그 뒤 동기 쓰기가 덮는다. rename(2) 는 원자라
 *    둘 중 하나다.
 *  · 테스트는 `_setBulletinIoForTest` 로 파일 입출력(mkdir·tmp 쓰기·rename·동기 원자 쓰기)을 바꿔 ENOSPC·EACCES·rename 실패를 주입한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { registerExitFlush } from '../util/exitFlush.js';

export const LIMITS = Object.freeze({
  noticeMax: 200, noticeTitle: 200, noticeBody: 5000,
  postMax: 2000, postTitle: 200, postBody: 10000, commentMax: 300, commentBody: 2000, likeMax: 2000,
});
/** 화면에 싣는 공감한 사람 이름 수(개수는 전부 센다). */
export const LIKERS_SHOWN = 30;
export const NOTICE_LEVELS = Object.freeze(['info', 'warn', 'crit']);

/** v2.727 — board.json 합계 상한 기본값(바이트). */
export const BOARD_MAX_BYTES_DEFAULT = 16 * 1024 * 1024;
/** v2.727 — 변경을 묶어 쓰는 창(ms). 테스트가 이 값으로 기다린다. */
export const WRITE_DELAY_MS = 300;
/** 리뷰 I-05 — 중요한 쓰기(글·댓글·공지)의 라우트가 디스크 저장 결과를 기다리는 상한(ms). 넘기면 'pending' 으로 응답한다. */
export const PERSIST_WAIT_MS = 3000;
/** 리뷰 I-05 — 쓰기 실패 뒤 자동 재시도(지수 backoff, 횟수 상한). 기본값만 — 테스트는 `_setBulletinIoForTest` 로 줄인다. */
export const RETRY_DEFAULTS = Object.freeze({ max: 6, baseMs: 5000, capMs: 300000 });
let RETRY = { ...RETRY_DEFAULTS };

/**
 * 쓰기 실패 사유 코드 → 짧은 문구(화면용). 오류 원문(e.message)은 tmp 파일의 절대 경로를 담으므로 상태·응답에 싣지 않는다.
 * 모르는 코드는 일반 문구 — 코드 자체는 그대로 보인다.
 */
export const WRITE_ERROR_TEXT = Object.freeze({
  ENOSPC: '디스크 공간이 부족합니다',
  EDQUOT: '디스크 할당량(quota)을 넘었습니다',
  EACCES: '저장 폴더·파일에 쓰기 권한이 없습니다',
  EPERM: '저장 폴더·파일에 대한 작업이 허용되지 않습니다',
  EROFS: '읽기 전용 파일 시스템입니다',
  EISDIR: '저장 파일 자리에 폴더가 있습니다',
  ENOTDIR: '설정 폴더 경로의 일부가 폴더가 아닙니다',
  ENOENT: '설정 폴더를 찾지 못했습니다',
  EMFILE: '열린 파일이 너무 많습니다',
  ENFILE: '시스템 전체의 열린 파일이 너무 많습니다',
  EIO: '디스크 입출력 오류입니다',
  EBUSY: '파일이 사용 중입니다',
  EUNKNOWN: '파일을 쓰지 못했습니다(서버 로그에서 원인을 확인하세요)',
});
/** 실패 단계 — 화면 문구는 웹이 만든다. */
export const WRITE_PHASES = Object.freeze(['mkdir', 'write', 'rename', 'flush']);

/**
 * 합계 상한 — env `BOARD_MAX_BYTES`(바이트). 빈 값·비수치는 미지정(= 기본값, v2.618 BUG-1 규약 — `KEY=` 한 줄이 상한을 0 으로
 * 만들지 않게 numOrNull), 0 이하도 기본값, 하한 64KB(그 아래는 글 한 개도 못 쓴다). 매 호출 읽는다(문자열 하나 — 테스트가 바꾼다).
 */
export function boardMaxBytes() {
  const n = numOrNull(process.env.BOARD_MAX_BYTES);
  if (n == null || n <= 0) return BOARD_MAX_BYTES_DEFAULT;
  return Math.max(65_536, Math.trunc(n));
}

const noticesFile = () => path.join(config.configDir, 'notices.json');
const boardFile = () => path.join(config.configDir, 'board.json');
/** 라우트가 쓰는 저장소 이름 → 파일·배열 키. */
const KINDS = Object.freeze({ board: { fileOf: boardFile, key: 'posts' }, notices: { fileOf: noticesFile, key: 'notices' } });

/* ───── 파일 입출력(테스트가 바꿔 끼운다 — 실패 주입) ───── */
const realIo = Object.freeze({
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  /** tmp 파일을 0600 으로 만들어 쓰고 fsync 한다. */
  writeTmp: async (tmp, body) => {
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(body, 'utf8'); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
  },
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  syncDir: async (dir) => { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } },
  /** 동기 원자 쓰기(종료 flush) — util/atomicWrite.js. */
  writeFileAtomicSync: (file, body) => atomicWriteFileSync(file, body, { mode: 0o600 }),
  unlinkSync: (p) => fs.unlinkSync(p),
});
let io = realIo;

/**
 * 테스트 전용 — 파일 입출력의 일부를 바꾸고(실패·지연 주입) 재시도 상수를 줄인다. 인자 없이 부르면 원래대로.
 * @param {Partial<typeof realIo>|null} over
 * @param {{ max?: number, baseMs?: number, capMs?: number }} [retry]
 */
export function _setBulletinIoForTest(over = null, retry = null) {
  io = over ? { ...realIo, ...over } : realIo;
  RETRY = retry ? { ...RETRY_DEFAULTS, ...retry } : { ...RETRY_DEFAULTS };
}

const caches = new Map(); // file → { list }
/**
 * file → 쓰기 상태(v2.727 + 리뷰 I-05).
 *  bytes = 마지막 실제 쓰기(또는 로드) 바이트 + 그 뒤 변경분 추정 · seq = 변경 순번 · savedSeq = 디스크에 쓴 마지막 순번 ·
 *  attemptSeq = 진행 중 쓰기가 담은 순번 · lastFailSeq = 마지막으로 실패한 쓰기가 담은 순번 · unsavedSince = 저장 안 된 가장 오래된 변경 시각.
 */
const writers = new Map();

function writerOf(file, key) {
  let w = writers.get(file);
  if (!w) {
    w = {
      key, timer: null, writing: false, dirty: false, gen: 0, bytes: null, writes: 0, lastWriteAt: null, lastWriteError: null,
      seq: 0, savedSeq: 0, attemptSeq: 0, lastFailSeq: 0, unsavedSince: null, nextUnsavedAt: null,
      attempts: 0, failCount: 0, failTotal: 0, retryTimer: null, retryAt: null, expedite: false, tmp: null, inflight: null, waiters: [],
    };
    writers.set(file, w);
  }
  return w;
}

function load(file, key) {
  const hit = caches.get(file);
  if (hit) return hit.list;
  const w = writerOf(file, key);
  let list = [];
  let bytes = 0;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || !Array.isArray(j[key])) throw new Error(`${key} 배열이 없습니다`);
      list = j[key].filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
      bytes = Buffer.byteLength(raw, 'utf8');
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[bulletin] ${path.basename(file)} 를 읽지 못해 빈 목록으로 시작합니다: ${e.message}`);
    list = []; bytes = 0;
  }
  caches.set(file, { list });
  if (w.bytes == null) w.bytes = bytes;
  return list;
}

/** 캐시를 바꾸고 쓰기를 예약한다(v2.727). deltaBytes 는 이 변경이 파일 크기에 주는 추정 변화(바이트). */
function save(file, key, list, deltaBytes = 0) {
  const w = writerOf(file, key);
  caches.set(file, { list });
  w.bytes = Math.max(0, (w.bytes ?? 0) + (Number.isFinite(deltaBytes) ? deltaBytes : 0));
  const now = Date.now();
  if (w.seq === w.savedSeq) w.unsavedSince = now;          // 저장 안 된 변경이 이것부터 시작한다
  if (w.writing && w.seq === w.attemptSeq) w.nextUnsavedAt = now; // 진행 중 쓰기가 담지 못한 첫 변경
  w.seq += 1;
  scheduleWrite(file);
}

function scheduleWrite(file) {
  const w = writers.get(file);
  if (!w) return;
  w.dirty = true;
  if (w.timer) return;
  w.timer = setTimeout(() => runWrite(file), WRITE_DELAY_MS);
  w.timer.unref?.();
}

function clearRetry(w) {
  if (w.retryTimer) { clearTimeout(w.retryTimer); w.retryTimer = null; }
  w.retryAt = null;
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const serialize = (w, file) => JSON.stringify({ [w.key]: caches.get(file)?.list || [] });
const tmpPathOf = (file) => path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);

/** 오류 → 사유 코드(절대 경로가 든 원문은 쓰지 않는다). */
function errCodeOf(e) {
  const c = typeof e?.code === 'string' ? e.code : '';
  return /^E[A-Z0-9]{2,15}$/.test(c) ? c : 'EUNKNOWN';
}

/** 실패 기록 + 제한된 지수 backoff 재시도 예약. seq = 실패한 쓰기가 담은 순번. */
function noteWriteFail(w, file, e, phase, seq) {
  const code = errCodeOf(e);
  w.lastWriteError = { at: Date.now(), code, phase, message: WRITE_ERROR_TEXT[code] || WRITE_ERROR_TEXT.EUNKNOWN };
  w.lastFailSeq = Math.max(w.lastFailSeq, seq);
  w.dirty = true; // 캐시는 그대로 — 재시도·다음 변경·종료 flush 가 다시 쓴다
  w.failCount += 1; w.failTotal += 1;
  clearRetry(w);
  let next = '';
  if (w.failCount <= RETRY.max) {
    const delay = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** (w.failCount - 1));
    w.retryAt = Date.now() + delay;
    w.retryTimer = setTimeout(() => {
      w.retryTimer = null; w.retryAt = null;
      if (writers.get(file) !== w) return;             // 테스트 reset
      if (w.seq <= w.savedSeq || w.writing || w.timer) return; // 이미 저장됐거나 다른 쓰기가 맡았다
      runWrite(file);
    }, delay);
    w.retryTimer.unref?.();
    next = `${Math.round(delay / 1000)}초 뒤 다시 씁니다(${w.failCount}/${RETRY.max})`;
  } else {
    next = `자동 재시도 ${RETRY.max}회를 다 써서 멈춥니다 — 다음 변경·관리자 '지금 다시 저장'·종료 때 다시 씁니다`;
  }
  // 원문(e.message)에는 tmp 파일 절대 경로가 들어 있다 — 코드·syscall 만 남긴다.
  const sys = typeof e?.syscall === 'string' ? ` ${e.syscall}` : '';
  console.warn(`[bulletin] ${path.basename(file)} 저장 실패(${code}${sys} · ${phase}) — 미저장 변경 ${Math.max(0, w.seq - w.savedSeq)}건 · ${next}`);
}

function noteWriteOk(w, seq, body) {
  w.savedSeq = Math.max(w.savedSeq, seq);
  w.bytes = Buffer.byteLength(body, 'utf8'); w.writes += 1; w.lastWriteAt = Date.now();
  w.lastWriteError = null; w.failCount = 0;
  clearRetry(w);
  w.unsavedSince = w.seq > w.savedSeq ? (w.nextUnsavedAt ?? Date.now()) : null;
}

/** 대기자 정리 — 저장됐으면 saved, 그 순번을 담은 쓰기가 실패했으면 failed 로 끝낸다. */
function settleWaiters(w) {
  if (!w.waiters.length) return;
  const keep = [];
  for (const x of w.waiters) {
    if (w.savedSeq >= x.seq || (w.lastWriteError && w.lastFailSeq >= x.seq)) { clearTimeout(x.t); x.resolve(persistOfWriter(w, x.seq)); } else keep.push(x);
  }
  w.waiters = keep;
}

function runWrite(file) {
  const w = writers.get(file);
  if (!w) return;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  if (w.writing) { scheduleWrite(file); return; } // 이전 쓰기 진행 중 — 끝난 뒤 한 번 더(늦게 끝난 옛 본문이 새 본문을 덮지 않게)
  clearRetry(w);
  if (!caches.has(file)) { w.dirty = false; return; } // 캐시가 비었으면(테스트 reset) 쓸 것이 없다
  const body = serialize(w, file);
  const seq = w.seq;
  const gen = ++w.gen;
  w.dirty = false; w.writing = true; w.attemptSeq = seq; w.nextUnsavedAt = null; w.attempts += 1;
  const tmp = tmpPathOf(file);
  w.tmp = tmp;
  let failed = false;
  let phase = 'mkdir';
  w.inflight = (async () => {
    try {
      await io.mkdir(path.dirname(file));
      phase = 'write';
      await io.writeTmp(tmp, body);
      if (gen !== w.gen) { await io.unlink(tmp).catch(() => {}); return; } // 그 사이 동기 flush 가 더 새 본문을 썼다
      phase = 'rename';
      await io.rename(tmp, file);
      try { await io.syncDir(path.dirname(file)); } catch { /* 디렉터리 fsync 미지원 */ }
      if (gen === w.gen) noteWriteOk(w, seq, body);
    } catch (e) {
      // 동기 flush 가 이 쓰기를 대체했다(그 flush 가 tmp 를 지워 rename 이 ENOENT 가 된다) — 실패로 세지 않는다.
      if (gen === w.gen) { failed = true; noteWriteFail(w, file, e, phase, seq); }
      await io.unlink(tmp).catch(() => {});
    } finally {
      w.writing = false; w.tmp = null; w.inflight = null;
      const urgent = w.expedite; w.expedite = false;
      settleWaiters(w);
      // 쓰는 동안 바뀐 것은 한 번 더. 실패했으면 backoff 가 맡는다 — 단 중요한 쓰기가 기다리고 있으면(urgent, 사람의 동작) 지금 한 번 더 시도해
      // 그 쓰기가 자기 결과를 받게 한다(루프가 아니다 — urgent 는 매번 지운다).
      if (w.dirty && (urgent || !failed)) { if (urgent) runWrite(file); else scheduleWrite(file); }
    }
  })();
}

/**
 * 이 파일의 대기분을 묶음 창을 기다리지 않고 지금 쓰게 한다(중요한 쓰기·관리자 재시도). 쓰는 중이면 끝난 뒤 곧바로 한 번 더.
 * 재시도 backoff 를 기다리고 있던 대기분도 지금 다시 쓴다(사람의 동작 — 루프가 아니다).
 */
function expediteWrite(file) {
  const w = writers.get(file);
  if (!w || w.seq <= w.savedSeq) return;
  if (w.writing) { w.expedite = true; w.dirty = true; return; }
  runWrite(file);
}

/** 대기·진행 중인 쓰기를 동기로 끝낸다(종료 훅·테스트). 실패는 상태·콘솔에 남긴다. @returns 썼는가 */
function flushSync(file) {
  const w = writers.get(file);
  if (!w) return false;
  if (w.timer) { clearTimeout(w.timer); w.timer = null; }
  if (!w.dirty && !w.writing && w.seq <= w.savedSeq) return false;
  if (!caches.has(file)) { w.dirty = false; return false; }
  const body = serialize(w, file);
  const seq = w.seq;
  w.gen += 1; // 진행 중인 비동기 쓰기를 무효화한다(옛 본문으로 덮지 않게)
  // 진행 중인 비동기 쓰기의 tmp 를 먼저 지운다 — 아직 커널에 닿지 않은 rename 은 ENOENT 로 실패하고(대체됨),
  // 이미 끝난 rename 은 아래 동기 쓰기가 덮는다(rename(2) 는 원자라 둘 중 하나다). 이것이 '옛 본문이 새 본문을 덮는' 창을 닫는다.
  if (w.writing && w.tmp) { try { io.unlinkSync(w.tmp); } catch { /* 이미 rename 됐거나 아직 만들어지지 않았다 */ } }
  try {
    io.writeFileAtomicSync(file, body);
    w.dirty = false;
    noteWriteOk(w, seq, body);
    settleWaiters(w);
    return true;
  } catch (e) { noteWriteFail(w, file, e, 'flush', seq); settleWaiters(w); return false; }
}

/** 두 파일의 대기분을 지금 동기로 쓴다(테스트·종료). @returns {{ flushed: number }} */
export function flushBulletinNow() {
  let flushed = 0;
  for (const file of [...writers.keys()]) if (flushSync(file)) flushed += 1;
  return { flushed };
}
registerExitFlush('bulletin/store', () => { flushBulletinNow(); });

/** 테스트 전용 — 예약·진행 중인 쓰기가 전부 끝날 때까지 기다린다(상한 안에서). 실패해 대기분(dirty)·backoff 재시도만 남은 상태는 '끝난 것' 이다. */
export async function bulletinIdle({ maxMs = 5_000 } = {}) {
  const t0 = Date.now();
  while ([...writers.values()].some((w) => w.writing || w.timer)) {
    if (Date.now() - t0 > maxMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

/* ───── 저장 상태 판정(하나) ───── */

/** 한 변경(순번 seq)의 저장 상태 — saved / failed / pending. 판정 단일 소스. */
function persistOfWriter(w, seq) {
  const state = w.savedSeq >= seq ? 'saved' : (w.lastWriteError ? 'failed' : 'pending');
  return { state, seq, savedSeq: w.savedSeq };
}

/** 저장소 이름(board·notices) → 쓰기 상태(아직 읽은 적 없으면 null — 이 프로세스에서 바뀐 것이 없다). */
function writerOfKind(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`알 수 없는 저장소: ${kind}`);
  return writers.get(k.fileOf()) || null;
}

/** 지금까지 받은 마지막 변경 순번(라우트가 쓰기 직후 불러 그 변경의 순번으로 쓴다 — 쓰기는 동기라 사이에 다른 변경이 끼지 않는다). */
export function bulletinSeq(kind) { return writerOfKind(kind)?.seq ?? 0; }

/** 한 변경의 저장 상태(기다리지 않는다). */
export function bulletinPersistOf(kind, seq) {
  const w = writerOfKind(kind);
  if (!w) return { state: 'saved', seq: 0, savedSeq: 0 };
  return persistOfWriter(w, seq);
}

/**
 * 한 변경이 디스크에 닿을 때까지(또는 그 변경을 담은 쓰기가 실패할 때까지) 기다린다 — 상한 maxMs. 묶음 창을 앞당긴다.
 * 상한을 넘기면 그때의 상태(대개 pending)를 돌려준다 — 거부하지 않는다(변경은 이미 받아들여졌다).
 */
export function waitBulletinPersist(kind, seq, { maxMs = PERSIST_WAIT_MS, expedite = true } = {}) {
  const w = writerOfKind(kind);
  if (!w || w.savedSeq >= seq) return Promise.resolve(w ? persistOfWriter(w, seq) : { state: 'saved', seq: 0, savedSeq: 0 });
  if (expedite) expediteWrite(KINDS[kind].fileOf());
  if (w.savedSeq >= seq || (w.lastWriteError && w.lastFailSeq >= seq && !w.writing)) return Promise.resolve(persistOfWriter(w, seq));
  return new Promise((resolve) => {
    const x = { seq, resolve, t: null };
    x.t = setTimeout(() => {
      w.waiters = w.waiters.filter((y) => y !== x);
      resolve(persistOfWriter(w, seq));
    }, Math.max(0, Math.trunc(Number(maxMs) || 0)));
    x.t.unref?.();
    w.waiters.push(x);
  });
}

/**
 * 저장소 건강 — 화면 배너·관리자 상세가 쓴다. `admin:false` 면 상태·시각만(사유 코드·횟수는 관리자 상세다).
 * 경로·파일 내용·계정명은 싣지 않는다.
 */
function healthOfWriter(w, { admin = false, now = Date.now() } = {}) {
  if (!w) return { state: 'saved', loaded: false, unsavedSince: null, retrying: false, retryExhausted: false };
  const p = persistOfWriter(w, w.seq);
  const retrying = !!w.retryTimer;
  const out = {
    state: p.state, loaded: true, unsavedSince: p.state === 'saved' ? null : w.unsavedSince,
    retrying, retryExhausted: p.state === 'failed' && !retrying && w.failCount > RETRY.max,
    writing: w.writing,
  };
  if (!admin) return out;
  return {
    ...out,
    unsaved: Math.max(0, w.seq - w.savedSeq),
    lastSavedAt: w.lastWriteAt, lastWriteError: w.lastWriteError ? { ...w.lastWriteError } : null,
    failCount: w.failCount, failTotal: w.failTotal, attempts: w.attempts, writes: w.writes,
    nextRetryAt: retrying ? w.retryAt : null, retryMax: RETRY.max,
    unsavedForMs: out.unsavedSince ? Math.max(0, now - out.unsavedSince) : null,
  };
}

/** 두 저장소의 건강(라우트용). */
export function bulletinHealth({ admin = false } = {}) {
  return { board: healthOfWriter(writerOfKind('board'), { admin }), notices: healthOfWriter(writerOfKind('notices'), { admin }) };
}

/**
 * 관리자 '지금 다시 저장' — 저장 안 된 변경이 있는 파일마다 backoff 를 초기화하고 지금 다시 쓴 뒤 결과를 기다린다(상한 maxMs).
 * 진행 중인 쓰기가 있으면 그것이 끝난 뒤 곧바로 한 번 더 쓴다(동시에 두 번 쓰지 않는다 — 단일 비행 보존).
 * @returns {{ kind, attempted, state, code? }[]}
 */
export async function retryBulletinWrites({ maxMs = PERSIST_WAIT_MS } = {}) {
  const out = [];
  for (const kind of Object.keys(KINDS)) {
    const w = writerOfKind(kind);
    if (!w || w.seq <= w.savedSeq) { out.push({ kind, attempted: false, state: 'saved' }); continue; }
    w.failCount = 0; clearRetry(w);
    const target = w.seq;
    const deadline = Date.now() + maxMs;
    // 진행 중인 쓰기는 버튼을 누르기 전에 시작된 것이다 — 끝나기를 기다린 뒤 **한 번** 새로 쓴다(동시에 두 번 쓰지 않는다 — 단일 비행).
    while (w.writing && Date.now() < deadline) {
      const left = Math.max(1, deadline - Date.now());
      await Promise.race([w.inflight || sleep(10), sleep(left)]);
    }
    if (w.seq > w.savedSeq && !w.writing) runWrite(KINDS[kind].fileOf());
    const r = await waitBulletinPersist(kind, target, { maxMs: Math.max(1, deadline - Date.now()), expedite: false });
    out.push({ kind, attempted: true, state: r.state, ...(w.lastWriteError && r.state !== 'saved' ? { code: w.lastWriteError.code } : {}) });
  }
  return out;
}

/**
 * 저장소 상태(v2.727 + 리뷰 I-05) — 파일별 추정 크기·상한·대기/진행·실제 쓰기 횟수·마지막 실패·미저장 변경 수·재시도.
 * `lastWriteError` 는 가장 최근 실패(어느 파일이든) — 사유 코드·단계·짧은 문구만이고 절대 경로·원문은 없다.
 * 화면·점검이 '저장이 안 되고 있다' 를 볼 수 있게 — 조용한 실패 금지.
 */
export function bulletinStoreStatus() {
  const files = {};
  let lastWriteError = null;
  for (const [file, w] of writers) {
    const name = path.basename(file);
    const h = healthOfWriter(w, { admin: true });
    files[name] = {
      bytes: w.bytes, max: w.key === 'posts' ? boardMaxBytes() : null,
      state: h.state, unsaved: h.unsaved, unsavedSince: h.unsavedSince,
      pending: !!(w.dirty || w.timer || h.unsaved > 0), writing: w.writing, writes: w.writes, lastWriteAt: w.lastWriteAt, lastSavedAt: w.lastWriteAt,
      lastWriteError: h.lastWriteError, failCount: w.failCount, attempts: w.attempts,
      retry: { scheduled: h.retrying, nextAt: h.nextRetryAt, exhausted: h.retryExhausted, max: RETRY.max },
    };
    if (w.lastWriteError && (!lastWriteError || w.lastWriteError.at > lastWriteError.at)) lastWriteError = { file: name, ...w.lastWriteError };
  }
  return { delayMs: WRITE_DELAY_MS, persistWaitMs: PERSIST_WAIT_MS, retry: { ...RETRY }, files, lastWriteError };
}

/** 테스트 전용 — 대기분을 쓰고 캐시를 비운다(CONFIG_DIR 를 바꾼 뒤 다시 읽게). */
export function _resetBulletinCache() {
  flushBulletinNow();
  for (const w of writers.values()) {
    clearRetry(w);
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    for (const x of w.waiters) { clearTimeout(x.t); x.resolve(persistOfWriter(w, x.seq)); }
    w.waiters = [];
  }
  caches.clear(); writers.clear();
}

/** JSON 으로 쓰였을 때의 바이트(추정 변화량 계산용). */
const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
function boardFullError(bytes, max) {
  const e = new Error('board-full');
  e.status = 409; e.extra = { bytes, max };
  return e;
}
/** 이 변경(deltaBytes)으로 board.json 이 상한을 넘기면 409 board-full. 합계는 추정(머리말). */
function assertBoardRoom(deltaBytes) {
  const w = writerOf(boardFile(), 'posts');
  const max = boardMaxBytes();
  const cur = w.bytes ?? 0;
  if (cur + deltaBytes > max) throw boardFullError(cur, max);
}

const newId = () => crypto.randomBytes(8).toString('hex');
/** 문자열 칸: 앞뒤 공백 제거 · 제어 문자(줄바꿈·탭 제외) 제거 · 상한 초과는 오류. */
function text(v, max, field, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !s) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자를 넘습니다(${s.length}자)`);
  return capStr(s, max);
}
function fieldError(field, msg) {
  const e = new Error(`${field}: ${msg}`);
  e.status = 400; e.field = field;
  return e;
}
function limitError(msg) { const e = new Error(msg); e.status = 409; return e; }
function notFound() { const e = new Error('없는 항목입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }

/* ───────────────────────── 공지 ───────────────────────── */

/** 노출 시각: 빈 값 = 제한 없음(null). 숫자 또는 날짜 문자열을 받는다. 못 읽으면 오류. */
function timeField(v, field) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
  if (!Number.isFinite(n) || n <= 0) throw fieldError(field, '시각을 읽지 못했습니다');
  return n;
}

function cleanNotice(body, prev = {}) {
  const level = body.level == null ? (prev.level || 'info') : String(body.level);
  if (!NOTICE_LEVELS.includes(level)) throw fieldError('level', `${NOTICE_LEVELS.join('·')} 중 하나여야 합니다`);
  const startAt = Object.hasOwn(body, 'startAt') ? timeField(body.startAt, 'startAt') : (prev.startAt ?? null);
  const endAt = Object.hasOwn(body, 'endAt') ? timeField(body.endAt, 'endAt') : (prev.endAt ?? null);
  if (startAt != null && endAt != null && endAt <= startAt) throw fieldError('endAt', '종료 시각이 시작 시각보다 앞입니다');
  return {
    title: text(Object.hasOwn(body, 'title') ? body.title : prev.title, LIMITS.noticeTitle, 'title', { required: true }),
    body: text(Object.hasOwn(body, 'body') ? body.body : prev.body, LIMITS.noticeBody, 'body'),
    level,
    enabled: Object.hasOwn(body, 'enabled') ? body.enabled !== false : (prev.enabled ?? true),
    startAt, endAt,
  };
}

const sortNotices = (a) => [...a].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));

/**
 * 관리 목록(전부). v2.727(감사 B-04): `by:false` 면 작성·수정자 계정명(createdBy·updatedBy)을 뺀다 — 공지 작성자는 정의상
 * 전체 범위 관리자라 모든 로그인 사용자(데모 계정 포함)에게 그 계정명을 주면 관리자 계정 열거 단서가 된다. 라우트가 admin 에게만 싣는다.
 */
export function listNotices({ by = true } = {}) {
  const list = sortNotices(load(noticesFile(), 'notices'));
  if (by) return list;
  return list.map(({ createdBy: _c, updatedBy: _u, ...rest }) => rest);
}

/**
 * 지금 보여 줄 공지 — 켜져 있고 노출 기간 안. 심각도(crit → warn → info) 다음 최신순.
 * `rev` 는 화면의 '다시 보지 않기' 키에 쓴다 — 내용을 고치면 다시 보인다.
 * v2.727(감사 B-04): `by:false` 면 게시자 계정명(`by`)을 빈 값으로 — 팝업은 모든 로그인 사용자가 받는다.
 */
export function activeNotices(now = Date.now(), { by = true } = {}) {
  const rank = { crit: 0, warn: 1, info: 2 };
  return load(noticesFile(), 'notices')
    .filter((n) => n.enabled !== false && (n.startAt == null || n.startAt <= now) && (n.endAt == null || n.endAt > now))
    .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((n) => ({ id: n.id, rev: `${n.id}:${n.updatedAt || 0}`, title: n.title, body: n.body, level: n.level, startAt: n.startAt ?? null, endAt: n.endAt ?? null, updatedAt: n.updatedAt || null, by: by ? (n.updatedBy || n.createdBy || '') : '' }));
}

export function createNotice(body, user) {
  const list = load(noticesFile(), 'notices');
  if (list.length >= LIMITS.noticeMax) throw limitError(`공지는 ${LIMITS.noticeMax}개까지입니다 — 지난 공지를 지운 뒤 다시 하세요`);
  const now = Date.now();
  const n = { id: newId(), ...cleanNotice(body || {}), createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
  save(noticesFile(), 'notices', [...list, n]);
  return n;
}

export function updateNotice(id, body, user) {
  const list = load(noticesFile(), 'notices');
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) throw notFound();
  const n = { ...list[i], ...cleanNotice(body || {}, list[i]), updatedAt: Math.max(Date.now(), (list[i].updatedAt || 0) + 1), updatedBy: user };
  const next = [...list]; next[i] = n;
  save(noticesFile(), 'notices', next);
  return n;
}

export function deleteNotice(id) {
  const list = load(noticesFile(), 'notices');
  const n = list.find((x) => x.id === id);
  if (!n) throw notFound();
  save(noticesFile(), 'notices', list.filter((x) => x.id !== id));
  return n;
}

/* ───────────────────────── 게시판 ───────────────────────── */

const likesOf = (x) => (Array.isArray(x?.likes) ? x.likes.filter((u) => typeof u === 'string') : []);
const commentsOf = (p) => (Array.isArray(p?.comments) ? p.comments.filter((c) => c && typeof c === 'object' && typeof c.id === 'string') : []);
/** 화면에 세는 댓글 수 — 삭제 자리는 세지 않는다. */
const liveComments = (p) => commentsOf(p).filter((c) => !c.deleted).length;

/** 공감 표시용 — 저장된 이름 목록을 그대로 내보내지 않는다. */
function likeView(x, me) {
  const l = likesOf(x);
  return { likeCount: l.length, liked: !!me && l.includes(me), likers: l.slice(-LIKERS_SHOWN).reverse() };
}

const summary = (p) => ({
  id: p.id, title: p.title, author: p.author, pinned: !!p.pinned,
  createdAt: p.createdAt, updatedAt: p.updatedAt || p.createdAt,
  comments: liveComments(p),
  likes: likesOf(p).length,
  lastActivityAt: Math.max(p.updatedAt || 0, p.createdAt || 0, ...commentsOf(p).map((c) => c.createdAt || 0)),
});

/**
 * 글 목록 — 고정 글 먼저, 다음 최근 활동(글·댓글) 순. 검색어는 제목·본문·작성자(대소문자 무시).
 * 페이지 인자는 호출부가 pageArgs 로 좁혀 넘긴다.
 */
export function listPosts({ q = '', offset = 0, limit = 50 } = {}) {
  const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '';
  const all = load(boardFile(), 'posts');
  const hit = needle
    ? all.filter((p) => `${p.title}\n${p.body}\n${p.author}`.toLowerCase().includes(needle))
    : all;
  const rows = hit.map(summary).sort((a, b) => (b.pinned - a.pinned) || (b.lastActivityAt - a.lastActivityAt));
  return { total: rows.length, all: all.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

/** 글 한 건 — 공감은 개수·내 공감 여부·이름 일부로 바꿔 내보낸다(`me` = 보는 사람). */
export function getPost(id, me = '') {
  const p = load(boardFile(), 'posts').find((x) => x.id === id);
  if (!p) throw notFound();
  return viewPost(p, me);
}

function viewPost(p, me) {
  const { likes: _l, comments: _c, ...rest } = p;
  return {
    ...rest,
    ...likeView(p, me),
    commentCount: liveComments(p),
    comments: commentsOf(p).map((c) => {
      const { likes: _cl, ...cr } = c;
      return { ...cr, parentId: c.parentId || null, replyTo: c.replyTo || null, ...likeView(c, me) };
    }),
  };
}

/** 수정·삭제 권한: 작성자 본인 또는 관리자. */
const canModify = (item, user, isAdmin) => isAdmin || (!!user && item.author === user);

export function createPost(body, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  if (list.length >= LIMITS.postMax) throw limitError(`게시글은 ${LIMITS.postMax}개까지입니다 — 관리자에게 정리를 요청하세요`);
  const now = Date.now();
  const p = {
    id: newId(),
    title: text(body?.title, LIMITS.postTitle, 'title', { required: true }),
    body: text(body?.body, LIMITS.postBody, 'body', { required: true }),
    pinned: isAdmin && body?.pinned === true,
    author: user, createdAt: now, updatedAt: now, comments: [], likes: [],
  };
  const delta = jsonBytes(p) + 1; // v2.727: 이 글이 파일에 더하는 바이트(쉼표 포함)
  assertBoardRoom(delta);
  save(boardFile(), 'posts', [...list, p], delta);
  return viewPost(p, user);
}

export function updatePost(id, body, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw notFound();
  const cur = list[i];
  const editsContent = Object.hasOwn(body || {}, 'title') || Object.hasOwn(body || {}, 'body');
  if (editsContent && !canModify(cur, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 고칠 수 있습니다');
  if (Object.hasOwn(body || {}, 'pinned') && !isAdmin) throw forbidden('상단 고정은 관리자만 바꿀 수 있습니다');
  const p = {
    ...cur,
    title: Object.hasOwn(body, 'title') ? text(body.title, LIMITS.postTitle, 'title', { required: true }) : cur.title,
    body: Object.hasOwn(body, 'body') ? text(body.body, LIMITS.postBody, 'body', { required: true }) : cur.body,
    pinned: Object.hasOwn(body, 'pinned') ? body.pinned === true : !!cur.pinned,
    updatedAt: editsContent ? Math.max(Date.now(), (cur.updatedAt || 0) + 1) : cur.updatedAt,
    ...(editsContent ? { editedBy: user } : {}),
  };
  // v2.727: 제목·본문이 커지는 수정만 상한을 본다(고정 토글·줄이는 수정은 막지 않는다). 댓글은 그대로라 글 본문 차이만 센다.
  const delta = (jsonBytes(p.title) - jsonBytes(cur.title)) + (jsonBytes(p.body) - jsonBytes(cur.body)) + (editsContent && !cur.editedBy ? jsonBytes(user) + 14 : 0);
  if (editsContent && delta > 0) assertBoardRoom(delta);
  const next = [...list]; next[i] = p;
  save(boardFile(), 'posts', next, delta);
  return viewPost(p, user);
}

export function deletePost(id, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const p = list.find((x) => x.id === id);
  if (!p) throw notFound();
  if (!canModify(p, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  save(boardFile(), 'posts', list.filter((x) => x.id !== id), -(jsonBytes(p) + 1));
  return p;
}

/**
 * 댓글·답글 쓰기. `body.parentId` 가 있으면 답글이다 — 답글에 단 답글은 그 최상위 댓글 아래로 옮기고 `replyTo` 를 남긴다.
 * 답할 댓글이 없거나(지워짐) 삭제 자리면 거부한다(사라진 대화에 답글이 붙지 않게).
 */
export function addComment(postId, body, user) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === postId);
  if (i < 0) throw notFound();
  const cur = list[i];
  const comments = commentsOf(cur);
  if (comments.length >= LIMITS.commentMax) throw limitError(`댓글은 글마다 ${LIMITS.commentMax}개까지입니다(답글·삭제 표시 포함)`);
  let parentId = null; let replyTo = null;
  if (body?.parentId != null && body.parentId !== '') {
    const target = comments.find((c) => c.id === body.parentId);
    if (!target || target.deleted) { const e = new Error('답글을 달 댓글이 없습니다 — 지워졌을 수 있습니다. 글을 다시 열어 주세요'); e.status = 404; throw e; }
    parentId = target.parentId || target.id;
    if (target.parentId) replyTo = target.author || null;
  }
  const c = {
    id: newId(), author: user, body: text(body?.body, LIMITS.commentBody, 'body', { required: true }), createdAt: Date.now(),
    ...(parentId ? { parentId } : {}), ...(replyTo ? { replyTo } : {}), likes: [],
  };
  const delta = jsonBytes(c) + 1; // v2.727
  assertBoardRoom(delta);
  const next = [...list]; next[i] = { ...cur, comments: [...comments, c] };
  save(boardFile(), 'posts', next, delta);
  return viewPost({ id: '', comments: [c] }, user).comments[0];
}

/**
 * 댓글 지우기 — 답글이 달린 최상위 댓글은 내용만 지우고 자리를 남긴다(`deleted`). 마지막 답글이 지워지면 그 자리도 지운다.
 * @returns {{ comment, kept: boolean }} kept = 자리를 남겼는가
 */
export function deleteComment(postId, commentId, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === postId);
  if (i < 0) throw notFound();
  const comments = commentsOf(list[i]);
  const c = comments.find((x) => x.id === commentId);
  if (!c || c.deleted) throw notFound();
  if (!canModify(c, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  const hasReplies = !c.parentId && comments.some((x) => x.parentId === c.id);
  let rest;
  if (hasReplies) {
    rest = comments.map((x) => (x.id === c.id ? { id: c.id, author: '', body: '', createdAt: c.createdAt, deleted: true, deletedAt: Date.now(), likes: [] } : x));
  } else {
    rest = comments.filter((x) => x.id !== commentId);
    // 답글을 지워 그 최상위 삭제 자리에 남은 답글이 없으면 자리도 치운다.
    if (c.parentId) {
      const parent = rest.find((x) => x.id === c.parentId);
      if (parent?.deleted && !rest.some((x) => x.parentId === parent.id)) rest = rest.filter((x) => x.id !== parent.id);
    }
  }
  const next = [...list]; next[i] = { ...list[i], comments: rest };
  // v2.727: 자리를 남기면 본문만 빠진다(추정) · 통째로 빠지면 댓글 전체 바이트가 빠진다. 삭제는 상한을 보지 않는다.
  save(boardFile(), 'posts', next, hasReplies ? -jsonBytes(c.body || '') : -(jsonBytes(c) + 1));
  return { comment: c, kept: hasReplies };
}

/**
 * 공감 — 상태를 명시한다(`on` true 면 누름, false 면 취소). 이미 그 상태면 저장하지 않는다(재전송·연타가 두 번 세지 않는다).
 * `commentId` 를 주면 그 댓글, 없으면 글.
 * @returns {{ likeCount, liked, likers, changed }}
 */
export function setLike(postId, commentId, user, on) {
  if (!user) throw forbidden('로그인한 사용자만 공감할 수 있습니다');
  if (typeof on !== 'boolean') throw fieldError('on', 'true 또는 false 여야 합니다');
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === postId);
  if (i < 0) throw notFound();
  const post = list[i];
  let target = post; let ci = -1;
  const comments = commentsOf(post);
  if (commentId) {
    ci = comments.findIndex((c) => c.id === commentId);
    if (ci < 0 || comments[ci].deleted) throw notFound();
    target = comments[ci];
  }
  const cur = likesOf(target);
  const has = cur.includes(user);
  if (has === on) return { ...likeView(target, user), changed: false };
  if (on && cur.length >= LIMITS.likeMax) throw limitError(`공감은 항목마다 ${LIMITS.likeMax}명까지 셉니다`);
  const likes = on ? [...cur, user] : cur.filter((u) => u !== user);
  const updated = { ...target, likes };
  const nextPost = commentId
    ? { ...post, comments: comments.map((c, k) => (k === ci ? updated : c)) }
    : { ...post, likes };
  const next = [...list]; next[i] = nextPost;
  save(boardFile(), 'posts', next, (on ? 1 : -1) * (jsonBytes(user) + 1)); // v2.727: 공감은 상한과 무관(이름 하나 ±)
  return { ...likeView(updated, user), changed: true };
}
