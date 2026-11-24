/**
 * util/fileMissing.js — 그 파일이 **정말 없는가**(134회차 — `fs.existsSync` 를 대신하는 판정 하나).
 *
 * 왜: `fs.existsSync(file)` 은 stat 이 **어떤 이유로든** 실패하면 false 다 — 설정 폴더 탐색 권한(EACCES) · 디스크(EIO) · NFS(ESTALE) · 링크 고리(ELOOP) ·
 *   이름 길이(ENAMETOOLONG). 그 false 로 '파일 없음' 을 가른 로더는 읽기 오류 갈래(97 · 107 · 119회차 — readFileSync 의 오류 코드로 가른다)에 닿기도 전에
 *   기본값 · 빈 목록 · 새 키로 떨어졌다: 권한 매트릭스가 최소 권한이 아니라 기본 매트릭스로(저장된 도구 거부가 풀림) · 사용자 파일이 '없음' 이라 기본 관리자를
 *   새로 만듦 · 세션 폐기 목록이 빈 채 · 암호화 키를 새로 만들어 덮음 · 수집 서버 등록부의 읽기 오류 표지를 지움. 121회차가 config.js 에 넣은 판정
 *   (`vcFileMissing`)을 공용으로 올린 것이다.
 *
 * 판정은 `util/jsonFileRead.js readJsonFile` 과 같다 — **ENOENT 만 없음**. 그 밖의 실패는 '모름(읽기 오류)' 이고 없음이 아니다.
 *   ENOTDIR(경로 중간이 폴더가 아님)도 없음으로 보지 않는다 — 뒤따르는 읽기(readJsonFile)가 그것을 읽기 오류로 가르므로 두 판정이 어긋나지 않게 한다(닫는 쪽).
 *
 * 쓰는 법: 가장 단순한 수정은 **가드를 없애고 곧바로 읽어 오류 코드로 가르는 것**이다(`catch (e) { if (e?.code === 'ENOENT') 없음; else 읽기 오류; }`).
 *   읽기 전에 유무를 알아야 하는 자리(표지 지우기 · 덮어쓰기 앞)에서만 이 함수를 쓴다. 새 `fs.existsSync` 는 `server/test/existsSyncSweep134.test.js` 분류표에 올려야 한다.
 *
 * ⚠ util/ 규약(arch2579): 도메인 모듈을 import 하지 않는다 — fs 만(config.js 가 가져다 쓰는 leaf).
 */
import fs from 'node:fs';

/**
 * @param {string} file
 * @returns {boolean} ENOENT 일 때만 true. 있거나 · **확인하지 못했으면**(stat 이 다른 이유로 실패) false — 호출부는 그대로 읽어 오류 코드로 가른다.
 */
export function fileMissing(file) {
  try { fs.statSync(file); return false; } catch (e) { return e?.code === 'ENOENT'; }
}
