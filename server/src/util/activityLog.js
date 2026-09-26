/**
 * util/activityLog.js — 수집 '작업 로그' 링버퍼 **공용 팩토리**(v2.516).
 *
 * 왜 공용인가: 스토리지가 v2.315 에 먼저 가졌던 `storage/activityLog.js` 를 SAN 스위치도
 * 요구받았다(사용자: "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그 보여주는 기능 추가").
 * 파일을 복사하면 로그 포맷·상한·손상 처리가 두 갈래로 갈라진다 — 이 저장소는 그 유형의 사고를
 * 겪었다(`console/`↔`version_3/` 중복으로 v2.506 svcmon 권한 버그를 두 곳에 고쳐야 했다).
 * 그래서 링버퍼·영속·절단은 여기 하나가 갖고, **도메인마다 다른 것은 파일명과 수치 필드뿐**이다.
 *
 * ── 설계 근거 ────────────────────────────────────────────────────────────────
 * · 스냅샷 저장소(store.js)는 장비별 **최신 1건만** 보관한다 — '언제 수집했고 성공/실패였나' 는
 *   남지 않는다. 이 로그가 화면 '완료' 구획의 원천이고, '진행중' 은 폴러의 in-flight 가 담당한다.
 * · 인메모리 + 파일 영속(0600). **손상 시 preserveCorrupt 를 쓰지 않는다** — 자격증명이 아니라
 *   재생성 가능한 캐시이고, 여기서 원본을 보존하면 쓸모없는 파일만 쌓인다(자격증명 스토어와
 *   의도적으로 다른 취급이다. server/CLAUDE.md 의 '로드 손상 보존' 규칙 대상이 아니다).
 * · **상한(MAX)을 반드시 유지할 것** — 매 주기마다 장비 수만큼 쌓인다(28대 × 10분 주기 = 하루
 *   4,032건). 상한이 없으면 파일이 무한히 커지고 매 기록마다 전량을 다시 직렬화한다.
 * · 오류 문구는 300자로 자른다(SSH 추적·스택이 통째로 들어와 로그가 비대해지는 것을 막는다).
 *
 * ⚠ 비밀을 기록하지 말 것 — `error` 는 수집기가 만든 사람용 사유만 담는다. 비밀번호가 섞일 수
 *   있는 원문(undici 헤더 오류 등)은 수집기 쪽에서 이미 마스킹한다(`restCommon.httpFailMessage`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerStateFile } from './stateFiles.js'; // v2.613 PERSIST2613-08
import { registerExitFlush } from './exitFlush.js'; // v2.621 LIFE-03

/**
 * 도메인 하나의 작업 로그를 만든다.
 *
 * @param {object} p
 * @param {string} p.fileName   `config.configDir` 안의 파일명(예: 'storage-activity.json')
 * @param {number} [p.max]      링버퍼 상한(기본 500, 최소 50)
 * @param {string[]} [p.numFields] 도메인 전용 **수치** 필드 이름들. 유한수가 아니면 null 로 굳힌다
 *   (0 과 '미수집' 을 구분해야 하므로 0 으로 채우지 않는다 — types.js 정직 표기 규칙과 같은 이유).
 * @returns {{recordActivity:Function, listActivity:Function, _resetForTest:Function}}
 */
export function createActivityLog({ fileName, max = 500, numFields = [] }) {
  const FILE = path.join(config.configDir, fileName);
  registerStateFile(fileName); // v2.613 PERSIST2613-08: 링버퍼 캐시 — 상태 파일로 스스로 등록(이름 규약 -activity 와 이중)
  const MAX = Math.max(50, Number(max) || 500);
  let buf = null;
  /*
   * v2.621(감사 LIFE-03 — 재현): 예전에는 기록 1건마다 링버퍼 전량(500건 ≈ 120KB)을 직렬화하고 atomicWriteFileSync
   *   (파일·디렉터리 fsync + rename)로 **동기** 저장했다. 중앙 push 수신은 장비마다 이 함수를 한 루프에서 부르므로
   *   (central/sanSwitchEdge·storageEdge·sanSwitchPerfEdge, routes/central.js curuser) 장비 60대 push 한 번이
   *   이벤트 루프를 약 105ms 멈췄다(1건당 1.7ms × 60). 이제 **같은 틱의 기록을 묶는다**:
   *   · 그 틱의 첫 기록은 예전처럼 곧바로 쓴다(따로 떨어진 기록 — 폴러의 장비별 완료 — 는 동작이 같다).
   *   · 같은 틱의 나머지는 메모리에만 넣고 틱 끝(마이크로태스크)에서 **한 번** 쓴다 → 루프 N건이 쓰기 2번이 된다.
   *   · 조회(listActivity)는 메모리를 보므로 방금 기록이 **즉시** 보이고, 조회·테스트 초기화 전에는 대기분을 먼저 쓴다
   *     (메모리와 파일이 다른 시점을 말하지 않게). `process.exit` 가 같은 틱에 오면 exit 훅이 대기분을 쓴다.
   *   상한(MAX)·손상 시 새로 시작·0600·원자 쓰기는 그대로다.
   */
  let tickOpen = false; // 이 틱에 이미 한 번 썼다 — 나머지는 틱 끝에서
  let dirty = false;    // 메모리에만 있고 아직 파일에 없는 기록이 있다
  function writeNow() {
    if (!buf) return;
    dirty = false;
    try { atomicWriteFileSync(FILE, JSON.stringify(buf), { mode: 0o600 }); }
    catch { dirty = true; /* 영속 실패는 무시 — 인메모리 로그는 유지(다음 기록·조회에서 재시도) */ }
  }
  function flush() { if (dirty) writeNow(); }
  registerExitFlush(`activity/${fileName}`, flush);

  function load() {
    if (buf) return buf;
    try {
      const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      buf = Array.isArray(a) ? a.slice(-MAX) : [];   // 과거 파일이 상한을 넘겨도 로드 시 절단
    } catch { buf = []; }                            // 없거나 손상 — 새로 시작(재생성 가능)
    return buf;
  }

  /**
   * 수집 완료 이벤트 1건 기록.
   * 공통 필드: at · deviceId · name · host · source · ok · durationMs · error
   * `source`: 'central'(중앙 직접) 또는 엣지 이름. `at` 미지정 시 현재 시각.
   */
  function recordActivity(evt = {}) {
    const b = load();
    const e = {
      at: Number(evt.at) || Date.now(),
      deviceId: String(evt.deviceId || ''),
      name: String(evt.name || evt.deviceId || ''),
      host: String(evt.host || ''),
      source: String(evt.source || 'central'),
      ok: !!evt.ok,
      durationMs: Number.isFinite(evt.durationMs) ? evt.durationMs : null,
      error: evt.error ? String(evt.error).slice(0, 300) : null,
    };
    for (const f of numFields) e[f] = Number.isFinite(evt[f]) ? evt[f] : null;
    b.push(e);
    if (b.length > MAX) b.splice(0, b.length - MAX);  // 오래된 것부터 폐기(링버퍼)
    if (tickOpen) { dirty = true; return e; }         // v2.621 LIFE-03: 같은 틱의 나머지 — 틱 끝에서 한 번에
    tickOpen = true;
    writeNow();
    queueMicrotask(() => { tickOpen = false; flush(); });
    return e;
  }

  /** 최근 이벤트 newest-first (limit 상한, 기본 100). */
  function listActivity(limit = 100) {
    const n = Math.max(1, Math.min(MAX, Number(limit) || 100));
    flush(); // v2.621 LIFE-03: 같은 틱에 쌓인 대기분이 있으면 먼저 쓴다(없으면 아무것도 하지 않는다)
    return load().slice(-n).reverse();
  }

  // _resetForTest: 대기분을 먼저 쓰고 비운다 — 다음 load() 가 파일에서 다시 읽으므로 대기분을 버리면 사라진다.
  return { recordActivity, listActivity, flush, _resetForTest: () => { flush(); buf = null; }, MAX, FILE };
}
