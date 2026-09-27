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
 * @param {{ label?:string, confirm?:() => any }} [opts]
 *   v2.633: `label` 은 서비스 점검 화면에 보이는 이름, `confirm` 은 **지금 적용 중인 기본값을 파일로 저장**하는 함수다(그 모듈의
 *   저장 함수 — 저장 성공이 곧 `ok()` 다). 관리자가 '기본값으로 확정' 을 눌렀을 때만 부른다(`confirmSettingsDefault`).
 *   ⚠ 보존본의 나이로 자동 해제하지 않는다 — 해제는 곧 기본값(대개 꺼짐)을 전 엣지에 배포하는 것이라 v2.631 EDGE2631-01 사고를
 *   시간차로 되살린다. 사람이 '이 기본값을 배포해도 된다' 고 정할 때만 풀린다.
 * @returns {{ get:() => (null|{at:number, reason:string}), ok:() => void, corrupt:(e:any) => void, missing:() => void }}
 */
export function makeSettingsLoadError(fileOf, opts = {}) {
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
  _registry.push({ fileOf, api, label: String(opts.label || ''), confirm: typeof opts.confirm === 'function' ? opts.confirm : null });
  return api;
}

/**
 * 등록된 설정 파일 중 지금 '못 읽음' 인 것 — 서비스 점검용. 모듈을 다시 로드하지 않는다(파싱 오류는 그 모듈이 로드할 때 세운다).
 *   다만 **파일이 없는** 경우는 여기서 손상 보존본 판정을 다시 한다(아직 한 번도 로드되지 않은 설정도 보이게 — 값싼 readdir 1회).
 * @returns {{ file:string, label:string, at:number, reason:string, confirmable:boolean }[]}
 */
export function listSettingsLoadErrors() {
  const out = [];
  for (const ent of _registry) {
    const { label, confirm } = ent;
    const file = fileNameOf(ent);
    const e = currentError(ent);
    if (e) out.push({ file: file || '(경로 미상)', label, at: e.at, reason: e.reason, confirmable: !!(confirm && file) });
  }
  return out;
}

function fullPathOf({ fileOf }) {
  try { return String(fileOf() || ''); } catch { return ''; }
}
function fileNameOf(ent) { const f = fullPathOf(ent); return f ? path.basename(f) : ''; }
function currentError(ent) {
  const file = fullPathOf(ent);
  try { if (file && !ent.api.get() && !fs.existsSync(file)) ent.api.missing(); } catch { /* 판정 실패는 오류로 세우지 않는다 */ }
  return ent.api.get();
}

/**
 * v2.633: 관리자가 '기본값으로 확정' 을 눌렀을 때 — 그 설정 모듈의 저장 함수로 **지금 적용 중인 기본값**을 파일에 쓴다.
 *   그러면 로드 오류가 풀리고 설정 pull 이 다시 200 으로 답한다(= 이 기본값이 엣지에 배포된다 — 화면이 확인을 받는다).
 *   손상 보존본(.corrupt.*)은 **지우지 않는다**(원인 분석·수동 복구용).
 * @param {string} fileName  `listSettingsLoadErrors()` 가 준 file(베이스 이름)
 * @returns {{ ok:true, file:string, label:string } | { ok:false, code:'unknown-file'|'not-in-error'|'not-confirmable'|'confirm-failed'|'still-error', file:string, detail?:string }}
 */
export function confirmSettingsDefault(fileName, { by = '' } = {}) {
  const want = String(fileName || '');
  const ent = want ? _registry.find((x) => fileNameOf(x) === want) : null;
  if (!ent) return { ok: false, code: 'unknown-file', file: want };
  if (!currentError(ent)) return { ok: false, code: 'not-in-error', file: want };
  if (!ent.confirm) return { ok: false, code: 'not-confirmable', file: want };
  try { ent.confirm({ by: String(by || '').slice(0, 64) }); } catch (e) { return { ok: false, code: 'confirm-failed', file: want, detail: String(e?.message || e).slice(0, 200) }; }
  if (currentError(ent)) return { ok: false, code: 'still-error', file: want };
  return { ok: true, file: want, label: ent.label };
}
