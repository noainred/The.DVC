/**
 * routes/settingsUnreadMark.js — 설정 **조회(GET)** 응답의 읽기 오류 표지(112회차 — 106회차 R3 · R4 와 같은 꼴의 스윕).
 *
 * 왜: 107회차는 설정 파일을 읽지 못한 동안(읽기 오류 — EACCES · EIO · EISDIR)의 **쓰기**를 503 `settingsUnreadable` 로 닫았지만, 조회는 여전히 기본값 · 빈 목록을
 *   표지 없이 줬다. 화면이 그 값으로 편집 폼을 채우고, 파일이 다시 읽힌 뒤(쓰기 거절은 읽기 오류가 이어지는 동안만 막는다) ‘저장’ 한 번이
 *   저장돼 있던 설정을 그 기본값으로 덮었다(원본이 제자리에 있었으므로 보존본도 없다). 조회가 표지를 실으면 화면이 저장을 잠그고 폼을 다시 채운다.
 *
 * 모양: `{ loadError: { readError:true, code?, reason } }` — 사유는 요약(오류 코드)만 싣는다. **파일 경로 · 파일 원문 조각은 싣지 않는다.**
 *   쓰기 거절 본문(`<모듈>WriteRefusal()` — 107회차)을 그대로 받아 만든다(판정은 그 함수 하나 — 조회와 쓰기가 같은 상태를 본다).
 */
import { READ_RETRY_MS } from '../util/jsonFileRead.js';
import { summarizeRegistryError } from '../util/registryCore.js';

// 쓰기 거절 사유의 '읽기 오류(EISDIR)' 에서 코드만 꺼낸다(우리 모듈이 만든 글 · 길이를 먼저 자른다 · 반복은 상한 32).
const CODE_RE = /읽기 오류\(([A-Za-z0-9_-]{1,32})\)/;

/**
 * @param {null|{ readError?:boolean, reason?:string }} refusal  `<모듈>WriteRefusal()` 의 반환(읽기 오류가 아니면 null)
 * @param {string} [key]  응답 필드 이름 — 한 응답에 여러 파일의 값이 섞이는 조회는 `settingsLoadError` 로(화면 도우미 unreadMarkOf 가 둘 다 읽는다)
 * @returns {{}|{ loadError:{ readError:true, code?:string, reason:string } }}  응답 객체에 펼쳐 넣는다(`...unreadMark(x)`)
 */
export function unreadMark(refusal, key = 'loadError') {
  if (!refusal || refusal.readError !== true) return {};
  const code = CODE_RE.exec(String(refusal.reason ?? '').slice(0, 600))?.[1] || '';
  return {
    [key === 'settingsLoadError' ? 'settingsLoadError' : 'loadError']: {
      readError: true,
      ...(code ? { code } : {}),
      reason: `설정 파일을 읽지 못했습니다${code ? `(${code})` : ''} — 읽기 오류이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽습니다)`,
    },
  };
}

/**
 * 128회차(112 · 123회차가 'out' 으로 남긴 등록부): **장비 등록부** 조회(GET)의 표지. 등록부를 못 읽는 동안 목록은 빈 채로(마지막 값을 주는 등록부는 그 값으로) 나가는데
 *   표지가 없으면 화면이 '등록된 장비가 없습니다 · 추가하세요' 라고 말한다 — 운영자가 전부 새로 등록하게 만든다(118회차 vCenter 관리 화면의 꼴).
 *   읽기 오류면 unreadMark 와 같은 모양(`readError:true` — 다시 읽히면 풀린다), 손상(보존본으로 옮김 · 보존본만 남음)이면 사유 요약만 싣는다
 *   (요약은 summarizeRegistryError — 파일 조각 · 경로 · 파일 이름 없음).
 * @param {null|{reason?:string, readError?:boolean}} le  그 등록부의 `registryLoadError()`
 * @returns {{}|{ loadError:{ readError?:true, code?:string, reason:string } }}
 */
export function registryMark(le) {
  if (!le || typeof le !== 'object') return {};
  if (le.readError === true) return unreadMark({ readError: true, reason: le.reason });
  const why = summarizeRegistryError(le)?.text || '손상';
  return { loadError: { reason: `등록부 파일을 읽지 못했습니다(${why}) — 손상본은 설정 폴더에 보존돼 있습니다` } };
}
