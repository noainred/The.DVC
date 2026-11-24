/**
 * util/jsonFileLoad.js — 설정 · 저장소 JSON 파일 읽기의 공용 판정(결정(56~75 남긴 것) G2 — 57 · 58 · 60 · 62 · 65 · 69 · 70 · 73 · 74 회차가 모듈마다 따로 고친 꼴).
 *
 * 왜: '읽기 → JSON.parse → 실패면 preserveCorrupt' 를 catch 하나로 받은 모듈이 **읽기 오류**(EACCES · EIO · EISDIR · EMFILE)도 손상으로 보고
 *   온전한 원본을 `<file>.corrupt.<시각>` 으로 옮긴 뒤 빈 값으로 돌았다 — 다음 저장이 그 빈 값 위에 한 건만 든 파일을 썼다(원본은 보존본에만).
 *
 * 판정(넷) — **어느 단계에서 실패했는가** 로 가른다(e.code 유무가 아니다 — parse 가 code 붙은 오류를 던져도 손상이다):
 *  - `missing`    파일 없음(ENOENT). 손상 보존본만 남았으면 여전히 못 읽은 것이다(settingsLoadError.missing — 재시작 뒤에도).
 *  - `read-error` 읽기 단계의 그 밖의 실패. 원본을 **옮기지 않는다** · 호출부는 값을 **캐시하지 않는다** · 쓰기는 거절한다.
 *                 다시 읽기는 `READ_RETRY_MS`(30초) 간격 — 죽어 가는 디스크의 EIO 는 읽기마다 수 초 걸릴 수 있어, 요청마다 다시 읽으면
 *                 이벤트 루프를 거듭 막는다(71회차 추정). 간격 안의 호출은 디스크를 건드리지 않고 같은 결과(`deferred:true`)를 돌려준다.
 *  - `corrupt`    읽었는데 parse(형식 검사 포함)가 던졌다 → preserveCorrupt 로 원본을 보존본으로 옮긴다(예전과 같다).
 *  - `ok`         `{ value, text }`.
 *
 * 둘로 나눴다:
 *  - `makeJsonFileReader(fileOf, opts)` — 위 판정 + 재읽기 간격만(서비스 점검에 등재하지 않는 설정 — cost · vmhygiene · tags 처럼 손상이면 기본값으로 도는 것).
 *  - `makeJsonFileLoader(fileOf, { label, confirm, … })` — 위에 `makeSettingsLoadError` 상태를 묶은 것(서비스 점검 등재 · '기본값으로 확정' ·
 *    `refusal(what)` 쓰기 거절 응답). 로드 오류가 서 있는 동안 저장은 409 `settings-unreadable` 이 규약이다(rangeStore · annotations 와 같다).
 *
 * 결정 G2 반증 후속 ③: 오류가 서 있는 동안 모듈은 캐시를 믿지 않고 `recheckDue()` 가 참일 때(30초 간격) 다시 load() 한다 — 보존본을 되돌리거나
 *   보존본을 지우면(파일 없음 = 기본값이 곧 관리자 값) 재시작 없이 풀린다. 쓰는 모듈은 `if (cache && !L.recheckDue()) return cache` 꼴이다.
 *
 * 결정(반증 G2 · G3 남긴 것): 그 모듈이 불리지 않으면 서비스 점검 목록의 줄이 남았다 — 서비스 점검 조회가 등록부를 거쳐 `probe()` 를 부른다
 *   (settingsLoadError.recheckSettingsFiles — 간격 규칙 · 판정은 load() 와 같은 judge 하나). 회복을 보면 등록부(서비스 점검)의 오류는 지우고,
 *   **모듈 쪽에는 그 모듈이 다시 load() 할 때까지 이전 오류를 그대로 보인다**(`held` — loadError · refusal · marker) · 그동안 recheckDue() 는 늘 참.
 *   왜 모듈 쪽을 같이 지우지 않나: 캐시는 모듈이 들고 있다 — 오류만 지우면 '오류가 없으면 캐시를 믿는' 모듈(bulletin)이 오류 중에 캐시한 빈 목록을
 *   정상값으로 보고 그 위에 써서 되돌린 파일을 덮는다 · 회복 전이(hadErr → ok)로 rev 를 올리는 모듈(IPAM · fleet)이 전이를 놓친다.
 *
 * ⚠ util/ 규약(arch2579): 도메인 모듈을 import 하지 않는다.
 */
import path from 'node:path';
import { makeSettingsLoadError } from './settingsLoadError.js';
import { READ_RETRY_MS, makeJsonFileReader, inRetryWindow, nowMs as _now } from './jsonFileRead.js';

// 읽기 판정(READ_RETRY_MS · readJsonFile · makeJsonFileReader · 시계)은 util/jsonFileRead.js 하나다 — 등록부 공용 판정(registryCore)이 순환 없이 쓰게 떼어 냈다.
export { READ_RETRY_MS, readJsonFile, makeJsonFileReader, _setJsonFileLoadClockForTest } from './jsonFileRead.js';

/**
 * 서비스 점검에 등재되는 로더 — reader + makeSettingsLoadError.
 * @param {() => string} fileOf
 * @param {{ label:string, confirm:Function, ownerOnly?:boolean, superOnly?:boolean, parse?:Function, preserve?:boolean, retryMs?:number, tag?:string }} opts
 */
export function makeJsonFileLoader(fileOf, opts = {}) {
  const { label = '', confirm = null, ownerOnly = false, superOnly = false, retryMs = READ_RETRY_MS } = opts;
  // 결정 G2 반증 후속 ③: 다시 판정하는 로더라는 사실(recheckMs)을 등록부에 남긴다 — 확정 · 읽기 오류 안내 문구가 '재시작' 대신 '간격 안에 다시 읽음' 을 말한다.
  const err = makeSettingsLoadError(fileOf, { label, confirm, ownerOnly, superOnly, recheckMs: retryMs });
  const reader = makeJsonFileReader(fileOf, opts);
  let recheckAt = 0;   // 오류 상태에서 다음 재판정 시각(캐시를 쓰는 모듈이 recheckDue() 로 본다)
  let held = null;     // 서비스 점검 조회(probe)가 회복을 봤지만 모듈이 아직 다시 load() 하지 않았다 — 모듈 쪽에 보이는 이전 오류
  /** 읽기 + 판정(load · probe 공용 — 판정은 여기 하나). */
  const judge = () => {
    const r = reader.read();
    if (r.kind === 'ok') err.ok();
    else if (r.kind === 'missing') err.missing();
    else if (r.kind === 'corrupt') err.corrupt(r.error);
    else if (!r.deferred) err.readError(r.error, { retryMs });
    recheckAt = err.get() ? _now() + retryMs : 0;
    return r;
  };
  /** 모듈 쪽에 보이는 오류 — probe 가 회복을 봤어도 모듈이 다시 읽기 전까지는 이전 오류. */
  const visible = () => held || err.get();
  /**
   * 결정(반증 G2 · G3 남긴 것): 서비스 점검 조회 때(등록부 recheck) — 오류가 서 있고 간격(retryMs)이 지났으면 한 번 다시 판정한다.
   *   회복이면 등록부의 오류가 지워지고(서비스 점검 목록에서 빠짐) 모듈 쪽은 held 로 이전 오류를 유지한다. @returns 이번에 회복을 봤는가
   */
  const probe = () => {
    if (held) return false;
    const before = err.get();
    if (!before || inRetryWindow(_now(), recheckAt, retryMs)) return false;   // 125회차 F2: 시계가 뒤로 갔으면 기다리지 않는다
    judge();
    if (err.get()) return false;
    held = before;
    return true;
  };
  err.recheckWith(probe);
  return {
    /** 읽기 + 로드 오류 상태 갱신. 결과 모양은 makeJsonFileReader.read() 와 같다. */
    load() {
      held = null;
      return judge();
    },
    /**
     * 결정 G2 반증 후속 ③: 오류(손상 · 보존본만 남음 · 읽기 오류)가 서 있는 동안 캐시를 믿지 말고 **다시 load() 할 때인가**(간격 retryMs — 30초).
     *   예전에는 손상 상태의 기본값을 캐시해 보존본을 되돌려도 재시작 전까지 409 였다. 오류가 없으면 늘 false(정상 경로는 그대로 캐시).
     *   다시 판정은 파일 읽기 한 번(없으면 보존본 판정 readdir 한 번)이다 — 간격이 상한을 정한다.
     */
    recheckDue() {
      if (held) return true;   // 서비스 점검이 회복을 봤다 — 모듈이 곧바로 다시 읽어 캐시를 바꾸게
      if (!err.get()) return false;
      const t = _now();
      if (inRetryWindow(t, recheckAt, retryMs)) return false;   // 125회차 F2: 시계가 뒤로 갔으면 기다리지 않는다(간격이 그 차만큼 늘어났다)
      recheckAt = t + retryMs;
      return true;
    },
    /** 지금 로드 오류({ at, reason, readError? }) 또는 null. 읽지 않는다 — 호출부가 먼저 load() 한다. */
    loadError: () => visible(),
    /** 저장 성공 — 오류 해제 · 재읽기 간격 초기화. */
    saved() { err.ok(); reader.reset(); recheckAt = 0; held = null; },
    /** 테스트 전용 — 재읽기 간격만 초기화(오류 상태는 다음 load() 가 다시 판정한다). */
    resetRetry() { reader.reset(); recheckAt = 0; },
    /**
     * 로드 오류가 서 있으면 쓰기 거절 응답(라우트 409), 아니면 null. 사유는 읽기 오류 · 손상을 가른다(조치가 다르다).
     * @param {string} what  사람이 읽는 이름(예 'IP 관리 메모')
     */
    refusal(what) {
      const e = visible();
      if (!e) return null;
      const base = path.basename(String(fileOf() || ''));
      const reason = e.readError
        ? `${what} 파일(${base})을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(${Math.round(retryMs / 1000)}초마다 다시 읽고, 읽히면 저장이 다시 열립니다).`
        : `${what} 파일(${base})을 읽지 못한 상태라 저장하지 않았습니다 — 손상돼 보존본으로 옮겼습니다. 지금 저장하면 그 한 건만 든 파일이 됩니다. 서비스 점검에서 기본값으로 확정하거나 손상 보존본을 되돌리세요(되돌린 파일은 ${Math.round(retryMs / 1000)}초 안에 다시 읽어 재시작 없이 풀립니다).`;
      return { ok: false, code: 'settings-unreadable', reason, ...(e.readError ? { readError: true } : {}) };
    },
    /** 응답 표지 — `{ reason, at, readError }` 또는 null(사유는 settingsLoadError 의 요약 — 파일 조각 없음). */
    marker() {
      const e = visible();
      return e ? { reason: String(e.reason || '').slice(0, 300), at: Number.isFinite(e.at) ? e.at : null, readError: !!e.readError } : null;
    },
  };
}
