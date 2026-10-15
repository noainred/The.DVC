/**
 * upgrade/versionsDoc.js — 업그레이드 메타데이터(versions.json) 상한·형식 검사(검토 I-08, v2.730).
 *
 * 왜: `upgrade.js fetchRemoteVersions` 는 원격 응답을 `res.json()` 으로 **통째로** 읽었다(같은 파일의 번들
 * 다운로드는 readBytesCapped 로 읽는 중에 자른다 — 경로별 보호가 비대칭이었다). 재현: 8,388,651바이트 JSON 을
 * 그대로 받아 파싱했다. 메타데이터는 작은 문서다(공식 릴리스 15개 버전 ≈ 10KB) — 아래 상한 안에서만 받는다.
 *
 * 규칙(호출부 두 곳 — upgrade.js 원격 확인 · fetchPackage.js 패키지 저장소 — 가 같은 함수를 쓴다):
 *  · 바이트 상한(`VERSIONS_MAX_BYTES`, 기본 1MiB)은 **읽는 중에** 건다(util/readCapped.js readJsonCapped —
 *    Content-Length 가 없거나 거짓이어도 스트림 실측으로 멈춘다). 읽기까지 포함한 **전체 시한**은 호출부가
 *    AbortSignal 로 건다(`deadlineSignal`) — 시한이 지나면 undici 가 본문 스트림을 끊고 소켓을 닫는다.
 *  · 항목 수 상한(`VERSIONS_MAX_ENTRIES`) · 문자열 길이 상한 · 필드 타입 검사. 모르는 필드는 **버린다**(싣지 않는다).
 *    선언한 필드의 타입이 틀리면 문서 전체를 거부한다(fail-closed — 공식 릴리스는 항상 형식을 지킨다).
 *  · 사유 문구에 주소의 계정·비밀번호·쿼리(토큰)를 싣지 않는다(`scrubUrlSecrets`).
 *  · 직전 정상 확인 결과 유지 계약(`rememberRemoteCheck`): 확인이 실패하면 **직전 정상값을 참고로만** 싣는다
 *    (`lastGood`). `available` 은 언제나 이번 확인 기준이고, 설치는 항상 **방금 받은** 정상 메타데이터로만 한다
 *    (upgradeFromRemote 가 매번 새로 확인한다) — 낡은 값으로 설치를 진행하지 않는다.
 */

import { numOrNull } from '../util/numOrNull.js';

/** 바이트 상한 — 빈 값·비숫자는 기본(1MiB), [4KiB, 16MiB] 로 가둔다. */
export const VERSIONS_MAX_BYTES = (() => {
  const n = numOrNull(process.env.UPGRADE_VERSIONS_MAX_BYTES) ?? 1048576;
  return Math.min(16777216, Math.max(4096, Math.floor(n > 0 ? n : 1048576)));
})();
/**
 * 업그레이드 메타데이터(versions.json · 서명 manifest) 받기 **전체 시한**(재시도·본문 읽기 포함).
 * v2.736.3: v2.730(I-08)이 전체 시한을 **10초 하나**로 묶은 뒤, 사내 미러(Nexus 등 — 원본을 받아 오는 동안 첫 응답이 늦다)에서
 *   첫 응답이 10초를 넘기면 **재시도 없이** 확인이 실패했다(사용자 신고 v2.735.3 '전체 시한(10초) 안에 다 받지 못해 중단' ·
 *   재현: 첫 응답 12초 서버에서 새 코드는 10.0초에 실패·요청 1번, v2.729 방식은 두 번째 시도로 10.7초에 성공).
 *   v2.729 까지는 시도마다 10초 × 3번이라 최장 약 31초를 기다렸다. 이제 전체 60초 안에서 시도마다 그 1/3(20초)로 재시도한다.
 *   빈 값·비숫자 = 기본값, [5초, 120초]로 가둔다(웹 '새 버전 확인' 요청 시한 180초 안에 들어가야 한다).
 */
export const META_FETCH_TIMEOUT_MS = (() => {
  const n = numOrNull(process.env.UPGRADE_CHECK_TIMEOUT_MS) ?? 60000;
  return Math.min(120_000, Math.max(5_000, Math.floor(n > 0 ? n : 60000)));
})();
/** 시도 횟수(첫 시도 + 재시도 2회) — resilientFetch `retries: 2` 와 짝이다. */
export const META_FETCH_ATTEMPTS = 3;
/** 전체 시한 → 시도별 시한. 시도 3번이 전체 시한 안에 들어가게 1/3(하한 5초 — 그보다 짧으면 정상 미러도 끊는다). */
export function attemptTimeoutMs(totalMs) {
  const t = Number(totalMs) > 0 ? Number(totalMs) : META_FETCH_TIMEOUT_MS;
  return Math.max(5_000, Math.ceil(t / META_FETCH_ATTEMPTS));
}
/**
 * 시한 초과 사유 — 어디서 멈췄는지(응답 헤더를 기다리다 / 본문을 받다가)와 시도 횟수를 밝힌다(조치가 다르다:
 * 헤더 대기 = 저장소가 아직 응답을 시작하지 않음(사내 미러가 원본을 받아 오는 중일 수 있다) · 본문 = 회선이 느리거나 전송이 멈춤).
 * 앞머리 `<what> 을 전체 시한(N초) 안에 다 받지 못해 중단했습니다` 는 그대로 둔다(기존 화면·로그가 그 문구로 찾는다).
 */
export function metaTimeoutReason(what, { totalMs, attemptMs, attempts, phase }) {
  const head = `${what} 을 전체 시한(${Math.round(totalMs / 1000)}초) 안에 다 받지 못해 중단했습니다`;
  const tries = `시도 ${Math.max(1, attempts || 1)}번 · 시도당 최대 ${Math.round(attemptMs / 1000)}초`;
  if (phase === 'body') {
    return `${head} — 응답은 시작했지만 본문을 끝까지 받지 못했습니다(${tries}). 회선이 느리거나 저장소가 전송을 멈췄습니다.`;
  }
  return `${head} — 저장소가 응답(헤더)을 시작하지 않았습니다(${tries}). 사내 미러(Nexus 등)가 원본에서 받아 오는 중이면 첫 요청이 오래 걸릴 수 있습니다 — `
    + `잠시 뒤 '새 버전 확인' 을 다시 누르거나 portal.env 의 UPGRADE_CHECK_TIMEOUT_MS(밀리초 · 최대 120000)를 늘리세요.`;
}

/** versions[] 항목 수 상한 — 공식 릴리스는 15개(VERSIONS_KEEP)만 싣는다. */
export const VERSIONS_MAX_ENTRIES = 200;
/** 문자열 필드 길이 상한(파일 이름·버전·해시). */
export const VERSIONS_STR_MAX = 256;

const VERSION_RE = /^v?\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,64})?$/;
// 원격 소스 기준 상대 경로 — 세그먼트는 영문·숫자·._+- 만, '..'·빈 세그먼트·절대경로·쿼리·스킴 금지.
const REL_FILE_RE = /^[A-Za-z0-9._+-]{1,128}(?:\/[A-Za-z0-9._+-]{1,128}){0,4}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;

const FILE_FIELDS = ['tar_gz', 'installer', 'installer_cent9', 'windows', 'manifest'];
const SHA_FIELDS = ['sha256', 'tar_gz_sha256', 'installer_sha256', 'installer_cent9_sha256', 'windows_sha256'];
const SIZE_FIELDS = ['size_bytes', 'installer_size_bytes', 'installer_cent9_size_bytes', 'windows_size_bytes'];

function bad(reason) { return { ok: false, reason: `versions.json 형식 오류 — ${reason}` }; }

/**
 * 파싱된 versions.json 을 검사하고 **선언한 필드만** 담은 사본을 돌려준다(순수).
 * @returns {{ok:true, doc:{latest:string, versions:object[]}} | {ok:false, reason:string}}
 */
export function validateVersionsDoc(raw, { maxEntries = VERSIONS_MAX_ENTRIES } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('최상위가 객체가 아닙니다');
  const latest = raw.latest == null ? '' : raw.latest;
  if (typeof latest !== 'string' || latest.length > 64 || (latest !== '' && !VERSION_RE.test(latest))) return bad('latest 가 버전 문자열이 아닙니다');
  const list = raw.versions == null ? [] : raw.versions;
  if (!Array.isArray(list)) return bad('versions 가 배열이 아닙니다');
  if (list.length > maxEntries) return bad(`versions 항목이 ${list.length}개로 상한(${maxEntries}개)을 넘었습니다`);
  const versions = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return bad(`versions[${i}] 가 객체가 아닙니다`);
    const out = {};
    if (typeof e.version !== 'string' || e.version.length > 64 || !VERSION_RE.test(e.version)) return bad(`versions[${i}].version 이 버전 문자열이 아닙니다`);
    out.version = e.version;
    for (const f of FILE_FIELDS) {
      if (e[f] == null || e[f] === '') continue;
      if (typeof e[f] !== 'string' || e[f].length > VERSIONS_STR_MAX || !REL_FILE_RE.test(e[f]) || e[f].split('/').some((p) => p === '.' || p === '..')) {
        return bad(`versions[${i}].${f} 가 안전한 파일 이름이 아닙니다`);
      }
      out[f] = e[f];
    }
    for (const f of SHA_FIELDS) {
      if (e[f] == null || e[f] === '') continue;
      if (typeof e[f] !== 'string' || !SHA_RE.test(e[f])) return bad(`versions[${i}].${f} 가 sha256(64자리 16진수)이 아닙니다`);
      out[f] = e[f].toLowerCase();
    }
    for (const f of SIZE_FIELDS) {
      if (e[f] == null) continue;
      const n = e[f];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return bad(`versions[${i}].${f} 가 0 이상의 정수가 아닙니다`);
      out[f] = n;
    }
    versions.push(out);
  }
  return { ok: true, doc: { latest, versions } };
}

/**
 * 전체 시한 신호 — fetch 와 본문 읽기를 한 시한으로 묶는다. 시한이 지나면 abort 사유가 `code:'ETIMEOUT_TOTAL'`.
 * 끝나면 `clear()` 로 타이머를 지운다(남기면 프로세스 종료를 붙잡는다).
 */
export function deadlineSignal(ms) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(Object.assign(new Error(`전체 시한(${Math.round(ms / 1000)}초) 초과`), { code: 'ETIMEOUT_TOTAL' })), ms);
  return { signal: ac.signal, clear: () => clearTimeout(tm), aborted: () => ac.signal.aborted };
}

/**
 * 글 안의 URL 에서 계정·비밀번호·쿼리를 지운다(사유 문구 전용). 선형 정규식만 쓴다(입력 4KB 로 자른다).
 * `secrets` 에 준 문자열(토큰 등)은 그대로 나타나면 가린다.
 */
export function scrubUrlSecrets(text, secrets = []) {
  let s = String(text ?? '').slice(0, 4096);
  s = s.replace(/(\b[a-z][a-z0-9+.-]{0,15}:\/\/)[^\s/@]{0,256}@/gi, '$1');
  s = s.replace(/(\b[a-z][a-z0-9+.-]{0,15}:\/\/[^\s?#]{0,2048})[?#][^\s]{0,2048}/gi, '$1');
  for (const sec of secrets) {
    const v = String(sec || '');
    if (v.length >= 4) s = s.split(v).join('***');
  }
  return s;
}

/**
 * 직전 정상 확인 결과 유지(검토 I-08 계약). `state` 는 호출부가 들고 있는 객체(매니저 인스턴스 필드).
 * 성공하면 그 값을 기억하고, 실패하면 직전 정상값을 `lastGood` 로 **참고만** 싣는다(available 은 false 그대로).
 */
export function rememberRemoteCheck(state, result) {
  if (!state || !result || typeof result !== 'object') return result;
  if (result.ok) {
    state.lastGoodRemote = { checkedAt: result.checkedAt, latest: result.latest || '', available: !!result.available };
    return result;
  }
  if (state.lastGoodRemote) result.lastGood = { ...state.lastGoodRemote };
  result.available = false;
  return result;
}
