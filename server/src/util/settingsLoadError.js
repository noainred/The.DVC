/**
 * util/settingsLoadError.js — **중앙 설정 파일**의 로드 오류 상태(v2.631 EDGE2631-01).
 *
 * 왜: 등록부(v2.612 LEFT2612-01 `registryLoadError`)만 손상 판정을 들고 있었고, 엣지에 **배포되는 설정**(bmusage 배포·로컬,
 *   vmseries, curuser, partfault, cvp 수집 설정, rma 스케줄)은 손상 → preserveCorrupt → 기본값(꺼짐·빈 범위)으로 떨어진 뒤
 *   그 기본값을 설정 pull 라우트가 **200 으로** 내려보냈다. 엣지는 그것을 '중앙이 명시한 값' 으로 보고 사본을 덮거나 지웠다 —
 *   28곳의 수집이 한 번에 꺼지고, 중앙 원본은 이미 .corrupt 로 치워져 **유일한 정상 사본이 사라졌다**.
 *
 * 규칙(등록부와 같다):
 *  - 파싱 실패 → `corrupt(e)` (오류 세움). 호출부가 preserveCorrupt 로 원본을 옮긴다.
 *  - 파일이 없음 → `missing()` : 손상 보존본(<파일>.corrupt.<시각>)만 남아 있으면 **여전히 못 읽은 것**이다(재시작 뒤에도).
 *    보존본이 없으면(처음부터 없던 설정) 오류가 아니다 — 기본값이 곧 관리자가 정한 값이다.
 *  - 읽기 성공·저장 성공 → `ok()` (오류 해제). 관리자가 한 번 저장하면 풀린다.
 *  중앙 자신의 로컬 동작(꺼짐 표시)은 바꾸지 않는다 — 이 값은 **배포 라우트가 503 으로 답할지** 만 정한다.
 *
 * ⚠ util/ 규약(arch2579): 도메인 모듈을 import 하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { corruptOnlyReason } from './registryCore.js';

/**
 * v2.632(감사 AX1-2632-02): 만든 로드 오류 상태를 모듈 안에 등록해 둔다 — 예전에는 *LoadError() 의 소비처가 설정 pull 라우트뿐이라
 *   503 이 나가는 동안 **중앙 화면·로그 어디에도** 그 사실이 없었다(엣지는 직전 설정을 유지하므로 조용히 멈춘 것처럼 보인다).
 *   서비스 점검(`health/services.js`)이 `listSettingsLoadErrors()` 로 한 줄에 모아 보여 준다.
 */
const _registry = [];

/**
 * @param {() => string} fileOf  설정 파일 경로(호출 시점에 계산 — CONFIG_DIR 를 테스트가 바꿀 수 있다)
 * @returns {{ get:() => (null|{at:number, reason:string}), ok:() => void, corrupt:(e:any) => void, missing:() => void }}
 */
export function makeSettingsLoadError(fileOf) {
  let err = null;
  const set = (reason) => { err = { at: Date.now(), reason: String(reason ?? '').slice(0, 200) }; };
  const api = {
    get: () => err,
    ok() { err = null; },
    corrupt(e) {
      const msg = e && typeof e === 'object' && 'message' in e ? e.message : e;
      set(`설정 파일을 읽지 못했습니다(${String(msg ?? '사유 미상').slice(0, 120)}) — 손상 보존본으로 옮겼습니다`);
    },
    missing() {
      let why = null;
      try { why = corruptOnlyReason(fileOf()); } catch { why = null; }
      if (!why) { err = null; return; }
      if (!err) set(why.replace('등록부 파일', '설정 파일'));   // 이미 세운 오류의 시각(since)은 유지한다
    },
  };
  _registry.push({ fileOf, api });
  return api;
}

/**
 * 등록된 설정 파일 중 지금 '못 읽음' 인 것 — 서비스 점검용. 모듈을 다시 로드하지 않는다(파싱 오류는 그 모듈이 로드할 때 세운다).
 *   다만 **파일이 없는** 경우는 여기서 손상 보존본 판정을 다시 한다(아직 한 번도 로드되지 않은 설정도 보이게 — 값싼 readdir 1회).
 * @returns {{ file:string, at:number, reason:string }[]}
 */
export function listSettingsLoadErrors() {
  const out = [];
  for (const { fileOf, api } of _registry) {
    let file = '';
    try { file = String(fileOf() || ''); } catch { file = ''; }
    try { if (file && !api.get() && !fs.existsSync(file)) api.missing(); } catch { /* 판정 실패는 오류로 세우지 않는다 */ }
    const e = api.get();
    if (e) out.push({ file: file ? path.basename(file) : '(경로 미상)', at: e.at, reason: e.reason });
  }
  return out;
}
