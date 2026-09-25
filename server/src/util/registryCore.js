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
