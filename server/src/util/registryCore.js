/**
 * util/registryCore.js — 장비 등록부(storage·sanswitch·pdu·cvp·bmstor)의 **공용 판정**(v2.613 PERSIST2613-04 · DEPS2613-04).
 *
 * 왜: 등록부 5벌이 같은 12줄(`load → openSecretsDeep → preserveCorrupt → corruptOnlyReason → 빈 목록`)을 복사해 들고 있었고
 *   이미 갈라져 있었다 — cvp 만 원소를 거르고(`s && typeof s === 'object'`), sanswitch·storage 는 원소 `null` 하나에
 *   `listDevices()` 가 **매 호출 TypeError**, bmstor 는 원소 변형(`s.groups`)에서 던져 **파일 전체를 손상으로 보존하고
 *   목록을 비웠다**(정상 서버까지 소실 — 스크래치 CONFIG_DIR 재현). `corruptOnlyReason` 은 4벌이 글자 그대로 같았다.
 *   CLAUDE.md '코어는 하나다'(v2.513)의 등록부 판이다.
 *
 * 범위: 손상 보존본 판정 · 로드 오류 상태 · 원소 형태 필터 · 법인 축(agent) 판정 **만**. 로드·저장 파이프라인 전체
 *   (`load/persist/secretCarry`)는 옮기지 않는다 — 비밀 승계(`accessMoved`)는 도구마다 접속 필드가 달라 한 벌로 묶으면
 *   회귀 위험이 이득보다 크다(verify-deps DEPS2613-04 판정). 각 등록부는 여기서 판정만 가져다 쓴다.
 *
 * ⚠ util/ 규약(arch2579): 도메인 모듈을 import 하지 않는다(fs·path 만).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * v2.612 LEFT2612-01: 파일이 없는데 손상 보존본(<파일>.corrupt.<시각>)만 있으면 재시작 뒤에도 '못 읽음' 이다 — 빈 목록으로
 *   출발하면 재시작 한 번으로 엣지 목록 삭제가 되살아난다. 관리자가 한 번 저장하면(파일이 생기면) 풀린다.
 * @returns {string|null} 사유 문구(가장 최근 보존본 이름 포함) 또는 null
 */
export function corruptOnlyReason(file) {
  try {
    const dir = path.dirname(file); const base = path.basename(file) + '.corrupt.';
    const hit = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort().pop();
    return hit ? `등록부 파일이 없고 손상 보존본(${hit})만 있습니다` : null;
  } catch { return null; }
}

/**
 * 로드 오류 상태(`registryLoadError()` 의 원천). 설정 pull 라우트(routes/central.js)가 이 값을 보고 503 으로 답한다 —
 *   빈 목록을 ok:true 로 내려보내면 엣지가 장비 목록·스냅샷을 통째로 지운다. 저장이 성공하면 `clear()`.
 * @returns {{ get:() => (null|{at:number, reason:string}), set:(reason:any) => object, clear:() => void, checkCorruptOnly:(file:string) => void }}
 */
export function makeLoadError() {
  let err = null;
  const api = {
    get: () => err,
    set(reason) {
      const msg = reason && typeof reason === 'object' && 'message' in reason ? reason.message : reason;
      err = { at: Date.now(), reason: String(msg ?? '').slice(0, 200) };
      return err;
    },
    clear() { err = null; },
    /** 오류가 없고 파일도 없을 때 손상 보존본만 남아 있으면 그 사유를 오류로 세운다(load() 끝에서 부른다). */
    checkCorruptOnly(file) {
      if (err) return;
      let exists = false;
      try { exists = fs.existsSync(file); } catch { exists = false; }
      if (exists) return;
      const why = corruptOnlyReason(file);
      if (why) api.set(why);
    },
  };
  return api;
}

/**
 * v2.744(감사 EDGE-03): 등록부를 **읽지 못한 상태**에서 사람이 아닌 경로(엣지 현지 스캔·할당 스캐너·주기 스캔의 자동 등록)가 저장하려 할 때의 거절(순수).
 *   ⚠ v2.744(회귀 검토 GD-R3): 중앙 화면 '등록' 이 만든 위임 등록 잡은 사람 요청이다 — 그 경로는 `manualRemoteWriteRefusal`(아래)을 쓴다.
 *   그 저장이 성공하면 '읽지 못함' 표지가 지워지고(`loadErr.clear()`) 보존본(`.corrupt.<시각>`)에만 남은 등록이 조용히 사라진다 —
 *   v2.743 엣지 export 503 보호도 다음 자동 저장에서 풀려 중앙이 그 엣지의 다른 서버를 지웠다(재현). 표지를 지우는 것은
 *   관리자 저장(화면)뿐이다(`seedDevicesIfEmpty` 가 이미 같은 판단을 한다 — 손상이면 자동으로 쓰지 않는다).
 * @param {null|{at:number, reason:string}} err  그 등록부의 `registryLoadError()` 값
 * @param {string} what  사람에게 보일 등록부 이름(예: 'iDRAC 등록부(idrac.json)')
 * @returns {null|{ok:false, code:'registry-unreadable', reason:string, registryUnreadable:{at:(number|null), reason:string}}}
 *   읽을 수 있으면 null. `reason` 은 기존 호출부가 그대로 화면·회신에 싣는 사람 말이고 판정은 `code` 로 한다.
 */
export function autoWriteRefusal(err, what = '등록부') {
  if (!err) return null;
  // v2.744(회귀 검토 GD-R1): 사유는 원문(JSON.parse 오류 조각 — 자격증명 파일 내용 일부)이 아니라 요약이다 — 이 문구는 위임 결과·스캔 회신으로
  //   중앙에 올라간다(summarizeRegistryError 머리말). 원문은 그 노드의 콘솔(preserveCorrupt 줄)에 있다.
  const why = summarizeRegistryError(err)?.text || '사유 미상';
  return {
    ok: false, code: 'registry-unreadable',
    reason: `${what} 읽기 실패(${why}) — 자동으로 저장하지 않았습니다. 손상 보존본(.corrupt.*)을 되돌리거나 등록 화면에서 저장하면 다시 등록합니다`,
    registryUnreadable: { at: Number.isFinite(err.at) ? err.at : null, reason: why },
  };
}

/**
 * v2.744(회귀 검토 GD-R3): **사람이 다른 노드에서** 요청한 저장(중앙 화면의 '등록' → 엣지 위임 등록 잡)을 읽지 못한 등록부에서 받았을 때의 거절(순수).
 *   그 잡은 관리자 라우트(routes/admin/idracScan.js register-scanned 의 위임 분기)에서만 만들어진다 — 자동 경로가 아니다. 예전에는 워커가
 *   auto:true 로 불러 거절 문구가 '자동으로 저장하지 않았습니다 … 등록 화면에서 저장하면 다시 등록합니다' 였다. 사람이 방금 등록을 눌렀는데
 *   '자동' 이라 말하고 같은 동작을 다시 하라고 안내했다(조언이 틀리면 무음 실패보다 나쁘다 — v2.553).
 *   ⚠ 저장하지 않는 원칙은 그대로다 — 요청한 사람은 그 노드의 등록부를 보지 못했고, 손상된 빈 목록 위에 발견분만 저장하면 손상 보존본에만 남은
 *     그 노드의 기존 등록이 조용히 사라진다(autoWriteRefusal 과 같은 판단). 바뀌는 것은 사유와 조치(어느 노드에서 무엇을 할지)뿐이다.
 * @param {null|{at:number, reason:string}} err  그 노드 등록부의 `registryLoadError()` 값
 * @param {string} what  사람에게 보일 등록부 이름
 * @param {{node?:string}} [o]  등록부가 있는 노드 이름(엣지 이름). 비면 '이 노드'.
 * @returns {null|{ok:false, code:'registry-unreadable', manual:true, reason:string, registryUnreadable:{at:(number|null), reason:string}}}
 */
export function manualRemoteWriteRefusal(err, what = '등록부', { node = '' } = {}) {
  if (!err) return null;
  const why = summarizeRegistryError(err)?.text || '사유 미상';
  const n = String(node ?? '').trim().slice(0, 64);
  const where = n ? `엣지 ‘${n}’ 의 포탈` : '이 노드의 포탈';
  return {
    ok: false, code: 'registry-unreadable', manual: true,
    reason: `${where}에서 ${what} 읽기 실패(${why}) — 요청한 등록을 저장하지 않았습니다. 손상된 등록부에 저장하면 손상 보존본(.corrupt.*)에만 남은 기존 등록이 사라집니다. ${where}에서 보존본을 되돌리거나 iDRAC 등록 화면에서 등록부를 다시 저장한 뒤 다시 등록하세요`,
    registryUnreadable: { at: Number.isFinite(err.at) ? err.at : null, reason: why },
  };
}

/**
 * v2.744(회귀 검토 GD-R1): 등록부 로드 오류를 **노드 밖으로 보내거나 화면에 실을 수 있는 요약**으로 바꾼다(순수).
 *   `registryLoadError().reason` 은 V8 JSON.parse 오류 원문이라 오류 위치 앞뒤 원문 약 10자를 싣는다 — 등록부가 자격증명 파일이라
 *   그 조각이 주소·평문 비밀번호 일부일 수 있다(재현: `"password": SuperSecret123!` → `..."assword": SuperSecre"... is not valid JSON`,
 *   짧은 파일은 내용 **전부**가 실린다). 엣지 fleet 상태 전용 보고가 그 원문을 중앙에 보내고 중앙이 fleetPartials 로 operator·viewer 에게
 *   실었다. 원문 글자를 **하나도 옮기지 않는다** — 분류 코드 + 숫자(줄·칸·위치) + 시스템 오류 코드(EACCES 같은 대문자 토큰)만 남기고
 *   문장은 고정 문구로 다시 만든다. 원문은 그 노드의 콘솔(preserveCorrupt 줄 — 서버 로그)에만 남는다.
 *   입력은 `registryLoadError()` 값이거나, 엣지가 보낸 `{code, line, column, position, sysCode, reason}` 이다. 알려진 `code` 가 오면
 *   글자(reason)는 **보지 않는다**(받은 글자를 믿지 않는다) · 코드가 없으면(원문을 보낸 엣지) 원문에서 분류만 한다.
 * @returns {null|{code:'parse-error'|'corrupt-only'|'read-error', line:(number|null), column:(number|null), position:(number|null),
 *   sysCode:(string|null), text:string, label:string}}  text = 분류 + 위치(관리자용) · label = 분류 고정 문구만(그 밖의 계정용)
 */
export const REGISTRY_ERROR_CODES = Object.freeze(['parse-error', 'corrupt-only', 'read-error']);
export const REGISTRY_ERROR_LABEL = Object.freeze({
  'parse-error': 'JSON 형식 오류',
  'corrupt-only': '등록부 파일이 없고 손상 보존본만 있음',
  'read-error': '등록부 읽기 오류',
});
const posInt = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1e9 ? n : null;
};
export function summarizeRegistryError(err) {
  if (!err || typeof err !== 'object') return null;
  // 원문은 길이를 먼저 자른다(정규식 입력 상한 — 엣지가 보낸 글자도 지나간다).
  const raw = typeof err.reason === 'string' ? err.reason.slice(0, 400) : '';
  const given = REGISTRY_ERROR_CODES.includes(err.code) ? err.code : null;
  let code = given; let line = null; let column = null; let position = null; let sysCode = null;
  if (given) {
    line = posInt(err.line); column = posInt(err.column); position = posInt(err.position);
    sysCode = typeof err.sysCode === 'string' && /^E[A-Z]{2,15}$/.test(err.sysCode) ? err.sysCode : null;
  } else {
    if (raw.startsWith('등록부 파일이 없고 손상 보존본')) code = 'corrupt-only';
    else if (/JSON|Unexpected (token|end|non-whitespace)|Bad (control|escaped|Unicode)|Expected /.test(raw)) code = 'parse-error';
    else code = 'read-error';
    if (code === 'parse-error') {
      const lc = /\(line (\d{1,9}) column (\d{1,9})\)/.exec(raw);
      if (lc) { line = posInt(lc[1]); column = posInt(lc[2]); }
      const p = /at position (\d{1,9})/.exec(raw);
      if (p) position = posInt(p[1]);
    }
    if (code === 'read-error') {
      const s = /(?:^|[^A-Z])(E[A-Z]{2,15})(?![A-Za-z])/.exec(raw);
      if (s) sysCode = s[1];
    }
  }
  const label = REGISTRY_ERROR_LABEL[code];
  const where = line != null && column != null ? `${line}번째 줄 ${column}번째 칸` : position != null ? `위치 ${position}` : '';
  const text = `${label}${where ? `(${where})` : ''}${sysCode ? `(${sysCode})` : ''}`;
  return { code, line, column, position, sysCode, text, label };
}

/**
 * v2.744(감사 EDGE-03): 엣지 설정 pull 이 **읽지 못한 등록부**를 중앙 배포분으로 다시 쓸 때 남기는 기록(순수).
 *   스토리지·SAN 스위치·PDU·CVP 의 pull 적용은 막지 않는다 — 그 엣지가 수집하는 장비는 전부 중앙 배포분이고
 *   (devicesForThisNode 가 agent 가 자기 이름인 항목만 고른다) 중앙이 진실의 원천이라, 막으면 손상된 동안 위임 수집이 통째로 멈춘다
 *   (push 도 v2.621 부터 손상이면 보내지 않는다). 대신 '읽지 못해 배포분으로 다시 썼다' 와 '배포분이 아닌 로컬 항목은
 *   손상 보존본에만 남는다' 를 상태·콘솔이 말한다 — 조용히 표지만 지우지 않는다.
 * @param {null|{at:number, reason:string}} err  적용 **직전**의 `registryLoadError()` 값
 * @param {{what?:string, restored?:number}} [o]
 * @returns {null|{at:number, lostAt:(number|null), reason:string, restored:(number|null), note:string}}
 */
export function pullRecoveryNote(err, { what = '등록부', restored = null } = {}) {
  if (!err) return null;
  const why = String(err.reason ?? '').slice(0, 200) || '사유 미상';
  const n = Number.isFinite(restored) ? restored : null;
  return {
    at: Date.now(), lostAt: Number.isFinite(err.at) ? err.at : null, reason: why, restored: n,
    note: `${what} 읽기 실패(${why}) — 중앙 배포분${n == null ? '' : ` ${n}건`}으로 다시 썼습니다. 배포분이 아닌 로컬 항목은 손상 보존본(.corrupt.*)에만 남습니다`,
  };
}

/**
 * 등록부 목록의 원소 형태 필터 — 객체만 남긴다(null·문자열·배열 원소는 손편집·손상 파일에서 온다). 배열이 아니면 빈 배열.
 *   ⚠ 파일 **전체**를 손상으로 보존하지 않는다 — 원소 하나 때문에 정상 장비까지 비우면 그것이 곧 소실이다(bmstor 재현).
 * @returns {{ list: object[], dropped: number }}
 */
export function filterObjectElements(list) {
  if (!Array.isArray(list)) return { list: [], dropped: 0 };
  const out = list.filter((s) => s && typeof s === 'object' && !Array.isArray(s));
  return { list: out, dropped: list.length - out.length };
}

const agentKey = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 이 노드가 수집할 장비(순수 판정). 중앙(isEdge=false)= agent 가 빈 장비 · 엣지 = agent 가 내 이름(대소문자·공백 무시)인 장비.
 *   ⚠ 엣지의 AGENT_NAME 기본값이 hostname 이라 중앙 여부는 이름이 아니라 centralUrl 로 가른다 — 호출부가 `isEdge` 로 넘긴다.
 *   이름이 빈 엣지는 아무것도 가져가지 않는다(빈 이름끼리 '같다' 로 중앙 직접 장비를 엣지가 가져가지 않게 — pdu 판정을 따랐다).
 * @param {object[]} list  등록부 원소 배열(`enabled === false` 는 제외)
 */
export function devicesForThisNode(list, { agentName = '', isEdge = false } = {}) {
  const me = agentKey(agentName);
  return (Array.isArray(list) ? list : []).filter((d) => {
    if (!d || d.enabled === false) return false;
    const a = agentKey(d.agent);
    return isEdge ? (!!a && a === me) : !a;
  });
}

/** 특정 엣지 몫 장비(중앙의 config 서빙용). 이름이 비면 빈 배열 — 빈 이름이 중앙 직접 장비(agent '')와 짝지어지지 않게. */
export function devicesForAgent(list, agentName) {
  const me = agentKey(agentName);
  if (!me) return [];
  return (Array.isArray(list) ? list : []).filter((d) => d && d.enabled !== false && agentKey(d.agent) === me);
}
