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
import { safeLoadText } from './atomicWrite.js'; // v2.744(회귀 검토 리드): 손상 사유의 원문 조각 요약

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
      // v2.744(회귀 검토 리드): 괄호 안은 원문(JSON.parse 오류 = 그 파일의 조각 — 배정 설정의 iDRAC 비밀번호, GPU 게스트 배포의 게스트 비밀번호)이
      //   아니라 요약이다 — 이 사유는 엣지 설정 pull 503·콘솔·서비스 점검 화면에 실린다. 원문은 보존본 파일에 그대로 있다.
      set(`설정 파일을 읽지 못했습니다(${safeLoadText(msg, 120) || '사유 미상'}) — 손상 보존본으로 옮겼습니다`);
    },
    /**
     * 20회차 반증 F4: **읽기 오류**(EACCES · EISDIR — 원본을 옮기지 않았다). 사유가 '보존본으로 옮겼습니다' 가 아니고, '기본값으로 확정' 할 수 없다
     *   (파일이 그대로 있어 확정은 file-present 로 막히고, 재시작해도 같은 오류다 — 사람이 권한 · 소유자를 고쳐야 한다).
     */
    readError(e) {
      const code = String((e && typeof e === 'object' ? e.code : '') || 'read-error').slice(0, 32);
      err = { at: Date.now(), reason: `설정 파일을 읽지 못했습니다(${code}) — 원본은 그대로 두었습니다. 파일 권한 · 소유자(포탈 서비스 계정)를 고치고 재시작하세요`, readError: true };
    },
    missing() {
      let why = null;
      try { why = corruptOnlyReason(fileOf()); } catch { why = null; }
      if (!why) { err = null; return; }
      // 37회차 R3: 읽기 오류 표지는 덮는다 — 파일을 지웠고 예전 손상 보존본이 남았으면 이제 '손상 보존본만 있음'(확정 가능)이다. 그 밖의 이미 세운 오류는 시각(since)을 유지한다.
      if (!err || err.readError) set(why.replace('등록부 파일', '설정 파일'));
    },
  };
  _registry.push({ fileOf, api, label: String(opts.label || ''), confirm: typeof opts.confirm === 'function' ? opts.confirm : null, ownerOnly: opts.ownerOnly === true, superOnly: opts.superOnly === true });
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
    const { label, confirm, ownerOnly } = ent;
    const file = fileNameOf(ent);
    const e = currentError(ent);
    if (e) out.push({ file: file || '(경로 미상)', label, at: e.at, reason: e.reason, confirmable: !!(confirm && file && !e.readError), ...(ownerOnly ? { ownerOnly: true } : {}), ...(e.readError ? { readError: true } : {}) });
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
 * @returns {{ ok:true, file:string, label:string } | { ok:false, code:'unknown-file'|'not-in-error'|'not-confirmable'|'file-present'|'confirm-failed'|'still-error', file:string, detail?:string }}
 */
/**
 * 전체 점검 18회차 반증 B-2: 확정이 그 설정의 쓰기 라우트보다 약한 게이트가 되지 않게 — `ownerOnly` 로 등록한 파일(예: 엣지 배포 사용자 —
 *   쓰기 라우트가 requireSettingsOwner)은 확정 라우트도 설정 소유자 등급을 요구한다(routes/api/checksLogs.js).
 */
export function settingsFileOwnerOnly(fileName) {
  const want = String(fileName || '');
  const ent = want ? _registry.find((x) => fileNameOf(x) === want) : null;
  return !!ent?.ownerOnly;
}
/** 20회차 반증 F8: 쓰기 라우트가 super_admin 전용인 파일(예: 아이실론 디렉터리 사용량 설정)은 확정도 super_admin. */
export function settingsFileSuperOnly(fileName) {
  const want = String(fileName || '');
  const ent = want ? _registry.find((x) => fileNameOf(x) === want) : null;
  return !!ent?.superOnly;
}

export function confirmSettingsDefault(fileName, { by = '' } = {}) {
  const want = String(fileName || '');
  const ent = want ? _registry.find((x) => fileNameOf(x) === want) : null;
  if (!ent) return { ok: false, code: 'unknown-file', file: want };
  if (!currentError(ent)) return { ok: false, code: 'not-in-error', file: want };
  if (!ent.confirm) return { ok: false, code: 'not-confirmable', file: want };
  if (currentError(ent)?.readError) return { ok: false, code: 'not-confirmable', file: want, detail: '읽기 오류(권한 · 소유자)라 확정으로 풀 수 없습니다 — 파일 권한을 고치고 재시작하세요.' };   // 20회차 F4
  // 전체 점검 18회차 반증 B-1(재현): 오류가 서 있는데 **파일이 다시 있으면**(운영자가 보존본을 되돌림) 기본값으로 덮지 않는다 — 로드는 기동 때 한 번이라
  //   메모리는 여전히 빈 기본값이고, 확정이 되돌린 파일을 그 값으로 덮어 복구본을 잃고 기본값(빈 배포 목록 등)을 전 엣지에 내렸다.
  //   손상되면 원본은 preserveCorrupt 로 옮겨지므로, 오류 중 파일이 있다는 것은 사람이 놓았다는 뜻이다 — 재시작이 그 파일을 읽는다.
  try {
    const full = fullPathOf(ent);
    if (full && fs.existsSync(full)) return { ok: false, code: 'file-present', file: want, detail: '설정 파일이 다시 있습니다(되돌린 보존본으로 보입니다) — 기본값으로 덮지 않았습니다. 포탈을 재시작하면 그 파일을 읽습니다.' };
  } catch { /* 판정 실패는 예전 동작(확정 진행) */ }
  try { ent.confirm({ by: String(by || '').slice(0, 64) }); } catch (e) { return { ok: false, code: 'confirm-failed', file: want, detail: String(e?.message || e).slice(0, 200) }; }
  if (currentError(ent)) return { ok: false, code: 'still-error', file: want };
  return { ok: true, file: want, label: ent.label };
}
