/**
 * perf/hangLog.js — hang(이벤트 루프 정체·화면 장기 로딩) 이벤트를 `perf-hangs.ndjson` 에 남긴다(v2.498).
 *
 * 사용자 요청: "이런 hang 현상이 발생할 때 로그 찍어서 나중에 튜닝할 때 사용하게 하자" — 재시작해도
 * 남아야 하므로 파일이다. 한 줄 = 한 이벤트(NDJSON)로 **append 만** 한다:
 *  · JSON 배열 파일은 append 마다 전량 재기록 + fsync 라(util/atomicWrite) 정체 직후 버스트에서
 *    오히려 루프를 더 막는다. append 는 O(1) 이고 비동기다.
 *  · 쓰기는 `fs.appendFile`(비동기, 실패 무시) — 계측이 서비스를 방해하지 않는다는 원칙(loopLag.js).
 * 유량 방어: 분당 상한 + 파일 줄 수 상한(초과 시 뒤쪽 N줄만 남겨 1회 재기록) + 보존일 지난 줄 제거.
 * 비밀은 담지 않는다 — 경로(쿼리 제거)·사용자명·수치만.
 *
 * **쓰기는 직렬화한다**(v2.498 개발 중 실측으로 확정): `fs.appendFile` 을 동시에 여러 번 부르면
 * 스레드풀에서 처리 순서가 보장되지 않아 파일의 줄 순서가 호출 순서와 달라진다(테스트에서 1004
 * 다음에 1003 이 오는 것을 실제로 관측). 더 나쁜 것은, 그 사이에 트림(동기 읽기+전량 재기록)이
 * 끼면 읽은 뒤 도착한 줄이 재기록으로 사라진다. 그래서 메모리 큐에 모아 **동시 1건만** append 하고,
 * 트림은 큐가 비고 쓰기가 없을 때만 돌린다. 조회는 그래도 `at` 기준으로 정렬해 돌려준다
 * (외부에서 파일을 편집·병합한 경우에도 최신 먼저를 보장).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = path.join(config.configDir, 'perf-hangs.ndjson');
const MAX_LINES = Math.max(500, Math.min(200_000, Number(process.env.PERF_HANG_LOG_MAX_LINES) || 20_000));
const MAX_PER_MIN = Math.max(1, Math.min(600, Number(process.env.PERF_HANG_LOG_MAX_PER_MIN) || 60));
const MAX_READ_BYTES = 8 * 1024 * 1024; // tail 읽기 상한 — 큰 파일 전체를 메모리로 올리지 않는다
// 파일 크기 상한. **줄 수만으로 판정하면 트림이 무력해진다**: 트림은 꼬리 MAX_READ_BYTES 만 읽어
// 줄을 세므로, 이벤트 1건이 ~1KB 인 이 로그에서는 꼬리에 8,600줄밖에 안 담기고 MAX_LINES(기본
// 20,000)에 영원히 도달하지 못해 파일이 무한히 자란다(개발 중 20.8MB 파일로 실측: trimmed 0).
// 상한은 **읽기 창을 넘을 수 없다** — 트림이 보는 범위가 꼬리 MAX_READ_BYTES 이므로, 그보다 큰
// 값을 설정하면 '32MB 까지 남긴다' 고 믿는데 실제로는 8MB 로 잘리고 잘린 부분이 보존일과 무관하게
// 사라진다(리뷰에서 26.2MB → 8.0MB, 8,341줄 파기를 실측). 실효값을 status 로 그대로 내려준다.
const MAX_BYTES = Math.max(512 * 1024, Math.min(MAX_READ_BYTES, Number(process.env.PERF_HANG_LOG_MAX_BYTES) || 8 * 1024 * 1024));
// 재기록 목표는 상한의 70% — 상한 바로 아래로 깎으면 다음 한 건에 다시 문턱을 넘어 200건마다
// 8MB 읽기+fsync 를 반복한다(리뷰 실측: 회수 0.04MB 에 루프 62ms 정지). 계측기가 서비스를
// 방해하지 않는다는 원칙을 지키려면 여유를 두고 깎아야 한다.
const MIN_RECLAIM_BYTES = 1024 * 1024;   // 이만큼도 못 줄이면 재기록하지 않는다

let minuteBucket = 0;
let minuteCount = 0;
// 종류별 분당 사용량 — 'client'(브라우저 보고)가 전역 예산을 먹어 'loop'(서버 정체) 기록을
// 막지 못하게 한다. client 는 전체 예산의 절반까지만 쓴다(적대적 리뷰 지적).
let minuteByKind = new Map();
let dropped = 0;      // 분당 상한으로 버린 줄 수(정직 표기용)
let appended = 0;
let lastError = '';
let sinceTrim = 0;
let queue = [];       // 대기 중인 줄(동시 append 금지 — 위 주석 참조)
let writing = false;
const MAX_QUEUE = 1_000;
// 분당 상한은 모듈 로드 시 env 로 굳는다(문서 스캐너가 그 형태를 읽는다). 테스트에서만 바꿀 수
// 있게 오버라이드를 둔다 — 운영 코드에서는 절대 호출하지 않는다.
let maxPerMinOverride = 0;
let maxBytesOverride = 0;
let trimPending = false;          // 쓰기 중에 들어온 트림 요청(끝난 뒤 처리)
let pendingRetentionDays = 0;
let generation = 0;               // clearHangs 세대 — 진행 중 쓰기의 잔여 큐가 파일을 되살리지 못하게
/*
 * 쓰기 중에 들어온 '비우기' — **그 쓰기의 콜백이** 수행한다(v2.560, 세 부분 수정의 ①).
 * clearHangs() 가 직접 rmSync 만 하면, 이미 커널에 넘긴 `fs.appendFile` 은 `O_CREAT|O_APPEND`
 * 라 unlink **뒤에** 도착하면 **파일을 되살린다**. `generation` 검사는 *잔여 큐* 의 재기록만
 * 막고 이미 넘긴 write 는 못 막는다(v2.527 에 확정한 제품 결함).
 */
let clearPending = false;
let permsFixed = false;
// 보존일을 알려주는 주입 함수 — hangLog 가 settings 를 직접 import 하면 순환이 생긴다.
// 주입이 없으면 0(보존일 미적용, 크기·줄 수만)으로 동작한다.
let retentionProvider = null;
export function setHangRetentionProvider(fn) { retentionProvider = typeof fn === 'function' ? fn : null; }
const retentionDaysNow = () => {
  try { return Math.max(0, Number(retentionProvider?.()) || 0); } catch { return 0; }
};
const perMinLimit = () => maxPerMinOverride || MAX_PER_MIN;
const maxBytesLimit = () => maxBytesOverride || MAX_BYTES;

export function hangLogFile() { return FILE; }

/** 큐를 한 번의 append 로 흘린다. 쓰기가 끝난 뒤에만 다음 쓰기·트림을 한다. */
function flushQueue() {
  if (writing || !queue.length) return;
  writing = true;
  const lines = queue;
  const gen = generation;
  queue = [];
  const chunk = lines.join('');
  try {
    // 형제 스토어(audit.js·atomicWrite.js)와 같이 쓰기 직전 디렉터리를 보장한다 — CONFIG_DIR 이
    // 아직 없으면 append 가 ENOENT 로 조용히 버려진다.
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch { /* 이미 있거나 권한 문제 */ }
    fs.appendFile(FILE, chunk, { mode: 0o600 }, (err) => {
      writing = false;
      // 이 write 가 **지금 세대**의 것인가. 아니면 '비우기(또는 테스트 리셋) 이전' 의 write 다.
      const mine = gen === generation;
      if (err) lastError = err.message;
      else {
        if (mine) appended += lines.length;
        // mode 는 **신규 생성 때만** 적용된다 — 파일이 0644 로 이미 있으면 그대로다. 이 파일에는
        // 사용자명·IP·User-Agent·요청 경로가 담기므로 audit.js ensurePerms 패턴으로 1회 교정한다.
        if (!permsFixed) { permsFixed = true; try { fs.chmodSync(FILE, 0o600); } catch { /* 무시 */ } }
      }
      /*
       * ② **미룬 삭제는 '자기 세대가 아닌' write 의 콜백만 수행한다**(v2.560).
       *   `mine` 이면 방금 쓴 줄이 유효하므로 지우면 안 된다 — v2.527 이 그 조건 없이 지워
       *   **60회 중 60회** '유실 없음 19 !== 20' 으로 실패했다. `!mine` 이면 이 write 는 비우기
       *   **이전** 의 것이고, 그것이 되살린 파일을 여기서 확실히 없앤다.
       */
      if (!mine && clearPending) {
        clearPending = false;
        try { if (fs.existsSync(FILE)) fs.rmSync(FILE); } catch { /* 이미 없음·권한 */ }
        permsFixed = false;
      }
      /*
       * ⚠ 큐 배수는 **세대와 무관하게** 계속한다. 예전에는 여기 앞에서 `return` 했는데, 그러면
       *   세대가 바뀐 콜백이 대기 줄을 남겨 두고 끝나 **이후 append 가 영원히 밀린다**(단일비행
       *   잠금은 이 콜백만 내린다). 비우기가 버려야 할 줄은 clearHangs 가 이미 큐에서 비웠다.
       */
      if (queue.length) { flushQueue(); return; }
      if (!mine) return;                          // 트림은 지금 세대의 쓰기 뒤에만
      // 트림은 쓰기가 없을 때만 — 동시에 하면 읽은 뒤 도착한 줄이 재기록으로 사라진다.
      // 보존일은 주입된 provider 에서 읽는다(예전에는 인자 없이 불러 보존일이 자동 경로에서
      // 아예 적용되지 않았다 — 사용자명·IP 가 설정 기간을 넘겨 남았다).
      if (trimPending) { trimPending = false; trimHangLog(pendingRetentionDays || retentionDaysNow()); pendingRetentionDays = 0; return; }
      if (sinceTrim >= 200) { sinceTrim = 0; trimHangLog(retentionDaysNow()); }
    });
  } catch (e) {
    writing = false;
    lastError = e.message;
  }
}

/** 이벤트 1건 기록(비동기·실패 무시). 반환: 큐에 넣었는지(분당 상한 초과면 false). */
export function appendHang(ev) {
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  if (bucket !== minuteBucket) { minuteBucket = bucket; minuteCount = 0; minuteByKind = new Map(); }
  const kind = String(ev?.kind || 'other');
  const limit = perMinLimit();
  const kindUsed = minuteByKind.get(kind) || 0;
  const kindLimit = kind === 'client' ? Math.max(1, Math.floor(limit / 2)) : limit;
  if (minuteCount >= limit || kindUsed >= kindLimit) { dropped += 1; return false; }
  if (queue.length >= MAX_QUEUE) { dropped += 1; return false; }
  minuteCount += 1;
  minuteByKind.set(kind, kindUsed + 1);
  let line;
  try { line = `${JSON.stringify({ ...ev, at: ev?.at || now })}\n`; }
  catch { return false; }
  queue.push(line);
  sinceTrim += 1;
  flushQueue();
  return true;
}

/** 대기 중인 줄이 모두 파일에 들어갈 때까지 기다린다(테스트·종료 시). */
export async function flushHangLog({ timeoutMs = 2_000 } = {}) {
  const t0 = Date.now();
  while ((queue.length || writing) && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { pending: queue.length, writing };
}

/**
 * 파일을 보존일·줄 수·**바이트** 상한으로 정리(동기 1회, 드묾). retentionDays 0 이면 크기·줄 수만 본다.
 * 반환에 tailOnly 를 실어 '꼬리만 검사했다' 는 사실을 숨기지 않는다(보존일 정리가 꼬리 밖 줄에는
 * 닿지 않는다 — 대신 바이트 상한이 그 줄들을 밀어낸다).
 */
export function trimHangLog(retentionDays = 0) {
  // 규약을 호출부가 아니라 **함수가 강제한다**: 진행 중 append 가 있는데 재기록(rename)을 하면
  // 그 append 는 unlink 된 옛 inode 에 써져 사라진다(리뷰에서 20건 중 1건 유실을 5회 재현).
  // 관리자 설정 저장·기동 경로가 이 검사 없이 부르고 있었다.
  if (writing || queue.length) {
    trimPending = true;
    pendingRetentionDays = Math.max(pendingRetentionDays, Number(retentionDays) || 0);
    return { trimmed: 0, deferred: true };
  }
  try {
    if (!fs.existsSync(FILE)) return { trimmed: 0 };
    const sizeBefore = fs.statSync(FILE).size;
    const tailOnly = sizeBefore > MAX_READ_BYTES;
    const raw = tailRaw();
    let lines = raw.split('\n').filter(Boolean);
    const before = lines.length;
    const days = Number(retentionDays) || 0;
    if (days > 0) {
      const cut = Date.now() - days * 86_400_000;
      lines = lines.filter((l) => {
        const i = l.indexOf('"at":');
        if (i < 0) return true;              // at 이 없으면 판단하지 않고 남긴다(추정 금지)
        const n = Number(/"at":\s*(\d+)/.exec(l)?.[1]);
        return !Number.isFinite(n) || n >= cut;
      });
    }
    if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
    // 바이트 상한 — 꼬리부터 남기고 앞을 버린다(줄 수 상한보다 먼저 걸리는 실질 상한).
    // 목표는 상한이 아니라 그 70%: 상한 바로 아래로 깎으면 한 건만 더 들어와도
    // 다시 문턱을 넘어 200건마다 전량 재기록이 반복된다.
    let bytes = Buffer.byteLength(`${lines.join('\n')}\n`);
    const limit = maxBytesLimit();
    const target = Math.floor(limit * 0.7);
    if (bytes > limit) {
      while (lines.length > 1 && bytes > target) {
        const drop = Math.max(1, Math.floor(lines.length * 0.1));
        lines = lines.slice(drop);
        bytes = Buffer.byteLength(`${lines.join('\n')}\n`);
      }
    }
    // 트림은 전량 재기록이다 — 원자적으로 써서 중간에 죽어도 로그가 잘리지 않게 한다.
    // 호출 시점 보장: flushQueue 콜백에서 쓰기가 없고 큐가 빈 순간에만 부른다(같은 틱에 append 가
    // 끼어들 수 없으므로 rename 으로 줄이 유실되지 않는다).
    // 꼬리만 읽었을 때도 그 꼬리로 파일을 대체한다 — 그래야 8MB 를 넘긴 파일이 실제로 줄어든다.
    // 회수량이 미미하면 재기록하지 않는다(8MB fsync 를 반복하는 것이 더 해롭다). 단 꼬리만 읽은
    // 경우(파일이 읽기 창보다 큼)에는 그 꼬리로 대체해야 파일이 실제로 줄어든다.
    const reclaim = sizeBefore - bytes;
    const rewrite = (lines.length !== before && reclaim >= MIN_RECLAIM_BYTES) || (tailOnly && reclaim >= MIN_RECLAIM_BYTES) || (lines.length !== before && sizeBefore <= limit);
    if (rewrite) atomicWriteFileSync(FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
    return {
      trimmed: rewrite ? before - lines.length : 0,
      lines: rewrite ? lines.length : before,
      tailOnly, skipped: !rewrite, bytesBefore: sizeBefore, bytesAfter: rewrite ? bytes : sizeBefore,
      // 꼬리만 읽어 파일을 대체했다면 앞부분은 보존일과 무관하게 폐기된다 — 숨기지 않고 밝힌다.
      discardedTailOnlyBytes: rewrite && tailOnly ? sizeBefore - bytes : 0,
    };
  } catch (e) { lastError = e.message; return { trimmed: 0, error: e.message }; }
}

/** 파일 끝 MAX_READ_BYTES 만 문자열로 읽는다(첫 줄이 잘릴 수 있어 호출부가 파싱 실패를 버린다). */
function tailRaw() {
  const st = fs.statSync(FILE);
  if (st.size <= MAX_READ_BYTES) return fs.readFileSync(FILE, 'utf8');
  const fd = fs.openSync(FILE, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ_BYTES);
    fs.readSync(fd, buf, 0, MAX_READ_BYTES, st.size - MAX_READ_BYTES);
    const s = buf.toString('utf8');
    return s.slice(s.indexOf('\n') + 1); // 잘린 첫 줄 버림
  } finally { fs.closeSync(fd); }
}

/** 최근 limit 건(최신 먼저). kind 로 필터 가능. 파싱 실패 줄은 건너뛴다. */
/**
 * 조회. **보존일이 지난 줄은 돌려주지 않는다**(v2.500 감사 M-1).
 *
 * 왜 조회에서도 거르는가: 파일 정리는 ①기동 ②설정 저장 ③append 200건마다 만 돌기 때문에, hang 이
 * 드문 정상 운영(하루 몇 건)에서는 200건이 쌓이는 데 수십 일이 걸린다. 그 동안 '14일 보존' 설정이
 * 무의미해지고 사용자명·클라이언트 IP·User-Agent·요청 경로가 그대로 조회된다 — 공격이 아니라
 * 통제 미이행이다. 파일 정리 시점에 의존하지 않게 조회 자체에서 컷오프를 적용하고, 거른 건수를
 * `staleHidden` 으로 **밝힌다**(조용히 줄이면 '기록이 왜 없지?' 가 된다).
 */
export function readHangs({ limit = 200, kind = '' } = {}) {
  const out = [];
  const days = retentionDaysNow();
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  let staleHidden = 0;
  try {
    if (!fs.existsSync(FILE)) return { rows: [], total: 0, file: FILE, exists: false };
    // total 은 '읽은 꼬리의 줄 수' 다 — 파일이 읽기 상한을 넘었으면 그 사실을 함께 알린다
    // (앞부분을 세지 않고 '총 N건' 이라고 말하면 거짓이 된다).
    const tailOnly = fs.statSync(FILE).size > MAX_READ_BYTES;
    const lines = tailRaw().split('\n').filter(Boolean);
    const want = Math.max(1, Math.min(2000, Number(limit) || 200));
    let bad = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (kind && o?.kind !== kind) continue;
        // at 이 없거나 숫자가 아닌 줄은 나이를 알 수 없다 — 버리지 않고 보여준다(모르는 것을 지우지 않는다).
        if (cutoff && Number(o?.at) > 0 && Number(o.at) < cutoff) { staleHidden += 1; continue; }
        out.push(o);
      } catch { bad += 1; }
      // 정렬을 위해 want 보다 조금 더 모은다(뒤쪽 줄이 항상 최신이라는 보장이 없다 — 위 주석).
      if (out.length >= want * 2 + 50) break;
    }
    out.sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
    return { rows: out.slice(0, want), total: lines.length, tailOnly, badLines: bad, staleHidden, retentionDays: days, file: FILE, exists: true };
  } catch (e) {
    return { rows: [], total: 0, file: FILE, exists: true, error: e.message };
  }
}

/** 파일 삭제(관리자 '로그 비우기'). */
/**
 * 로그 비우기. **대기 중인 줄도 버린다** — 예전에는 큐를 그대로 둬서, 진행 중 쓰기의 콜백이
 * 남은 줄을 appendFile 로 **파일을 다시 만들어** 기록했다(리뷰 실측: 삭제 직후 29줄 잔존).
 * 이 파일에는 사용자명·IP·User-Agent 가 담기므로 '비웠다' 는 보고가 거짓이면 안 된다.
 */
export function clearHangs() {
  try {
    generation += 1;      // 진행 중 쓰기의 후속 flush 가 잔여 큐를 쓰지 않게
    queue = [];
    /*
     * ① **쓰기 중이면 삭제를 콜백에 미룬다**(v2.560). 지금 지워도 이미 커널에 넘긴
     *   `fs.appendFile` 은 `O_CREAT|O_APPEND` 라 unlink 뒤에 도착하면 **파일을 되살린다** —
     *   그래서 관리자가 '로그 비우기' 를 눌렀는데 사용자명·IP·User-Agent 가 담긴 줄이 남고
     *   API 는 `{ok:true}` 를 보고했다(v2.527 에 재현·확정한 제품 결함).
     *   여기서 **한 번 지우고**(동기 확인이 바로 사라진 것을 보게) 콜백이 **한 번 더** 지운다.
     */
    if (writing) clearPending = true;
    if (fs.existsSync(FILE)) fs.rmSync(FILE);
    appended = 0; dropped = 0; sinceTrim = 0; lastError = ''; trimPending = false; permsFixed = false;
    // 미룬 삭제가 남아 있다는 사실을 숨기지 않는다(화면·테스트가 확인할 수 있게).
    return { ok: true, ...(clearPending ? { deferred: true } : {}) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export function hangLogStatus() {
  let bytes = null; let mtime = null;
  try { const st = fs.statSync(FILE); bytes = st.size; mtime = st.mtimeMs; } catch { /* 파일 없음 */ }
  return { file: FILE, bytes, mtime, appended, dropped, pending: queue.length, maxLines: MAX_LINES, maxBytes: maxBytesLimit(), maxPerMin: perMinLimit(), lastError: lastError || null };
}

/** 테스트 전용 — 분당 상한·바이트 상한 오버라이드(0 이면 env/기본값). */
export function _setHangLogMaxPerMinForTest(n) { maxPerMinOverride = Math.max(0, Number(n) || 0); }
export function _setHangLogMaxBytesForTest(n) { maxBytesOverride = Math.max(0, Number(n) || 0); }
/**
 * 테스트 전용 카운터 초기화.
 *
 * ⚠⚠ ③ **`writing` 을 강제로 내리지 않는다**(v2.560 — v2.527 실패의 진짜 원인):
 *   내리면 이전 테스트의 in-flight 콜백과 이번 테스트의 write 가 **동시에 존재**해 단일비행
 *   잠금이 무의미해지고, 그 상태에서 미룬 삭제가 **방금 쓴 줄을 지웠다**(60회 중 60회 실패).
 *   대신 **세대를 올려** 이전 콜백을 무해하게 만든다 — 그 콜백은 `mine=false` 라 카운터를
 *   건드리지도, 트림을 돌리지도 않고, 대기 줄만 흘려보낸 뒤 잠금을 스스로 내린다.
 */
export function _resetHangLogCounters() {
  generation += 1;
  minuteBucket = 0; minuteCount = 0; minuteByKind = new Map(); dropped = 0; appended = 0;
  lastError = ''; sinceTrim = 0; queue = []; trimPending = false; pendingRetentionDays = 0; permsFixed = false;
  clearPending = false;
}
