/**
 * util/exportPrefs.js — 내보내기 화면의 '내 저장값'(계정별 기본값 + 1~5칸) 저장소 공장(v2.799).
 *
 * 처음 쓰는 곳: 특수 기능 'VM 전체 정보 내보내기'(vcenter/vmExportPrefs.js — CONFIG_DIR/vm-export-prefs.json).
 * 규칙은 v2.798 VM 목록 내보내기 저장값(veeam/vmListPrefs.js)과 같다 — 그 모듈도 이 공장으로 옮길 수 있게 일반화했다(별건):
 *  · 파일 = { v:1, users: { 'u:<계정>': { def, slots:[5], at } } } — 키 앞의 'u:' 는 계정 이름이 '__proto__' 같아도 객체 키가 되지 않게.
 *  · 값 = { name, cols(필수 — 고른 항목과 순서), …도구 선택값 } — 사람이 '저장할 내용' 에서 고르지 않은 선택값은 아예 싣지 않는다
 *    (불러올 때 그 선택값은 지금 화면 값을 그대로 둔다). def 는 값 그대로 + from(그 값을 가져온 칸 번호 — 화면 표시용).
 *  · 계정은 **인증된 req.user.username** 으로만 고른다(라우트) — 본문의 이름을 믿지 않는다(남의 저장값을 읽거나 덮지 못하게).
 *  · 원자적 쓰기(0600) · 로드 손상은 옆에 보존하고 쓰기를 거부한다(503 — 빈 값 위에 덮어 전 계정 저장값을 잃지 않게) · 상한(계정 2,000 · 이름 30자).
 *  · 비밀은 없다(항목 key·폴더 경로뿐).
 * 도메인을 모른다(util 의존 방향 — docs/rules/common.md): 항목 검증(resolveCols·knownKeys)·선택값 검증(normalizeOpts)은 부르는 쪽이 준다.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from './atomicWrite.js';
import { readJsonFile, nowMs, READ_RETRY_MS } from './jsonFileRead.js';   // 113회차 R4: 읽기 오류 ≠ 손상

export const SLOT_COUNT = 5;
export const MAX_USERS = 2000;
export const NAME_MAX = 30;

const ukey = (username) => `u:${String(username || '').slice(0, 128)}`;
// eslint-disable-next-line no-control-regex
const cleanName = (v) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, NAME_MAX);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{ fileName:string,
 *   resolveCols:(cols:any)=>({ok:true, keys:string[]}|{ok:false, reason:string}),
 *   knownKeys:(cols:any)=>({keys:string[], dropped:number}),
 *   normalizeOpts:(v:object)=>({ok:true, value:object}|{ok:false, reason:string}) }} spec
 */
export function createExportPrefs({ fileName, resolveCols, knownKeys, normalizeOpts }) {
  const FILE = () => path.join(config.configDir, fileName);
  let cache = null;
  let unreadable = false;
  let readErr = '';     // 읽기 오류 코드(EACCES · EIO · EMFILE …) — 손상과 다르다: 원본은 그대로이고 간격을 두고 다시 읽는다
  let retryAt = 0;

  /*
   * 113회차 R4(재현 — 108회차가 남긴 것 E5): **읽기 오류**(권한 · 디스크 · fd 고갈 — 파일은 멀쩡하다)도 손상과 같은 catch 로 받아
   *   preserveCorrupt 가 온전한 원본을 `.corrupt.<시각>` 으로 **옮겼다** → 그 기동 동안은 쓰기 503, 재시작하면 '파일 없음' 이라 전 계정 저장값이 빈 채로
   *   시작했다(되살리려면 관리자가 보존본 이름을 손으로 되돌려야 했다). 이제 읽기 오류는 원본을 두고(옮기지 않는다) 그동안 '못 읽음' + 쓰기 503,
   *   30초 뒤 다시 읽어 풀리면 원본 값으로 돌아온다(97 · 103 · 107회차와 같은 판정 — util/jsonFileRead.js). 손상(JSON · 모양)은 예전 그대로다.
   */
  function load() {
    if (cache && !(readErr && nowMs() >= retryAt)) return cache;
    const r = readJsonFile(FILE(), { parse: (text) => { const d = JSON.parse(text); if (!isObj(d) || !isObj(d.users)) throw new Error('형식 오류'); return d.users; } });
    if (r.kind === 'read-error') {
      readErr = String(r.error?.code || 'read-error').slice(0, 32); retryAt = nowMs() + READ_RETRY_MS;
      cache = {}; unreadable = true;
      return cache;
    }
    readErr = ''; retryAt = 0;
    cache = r.kind === 'ok' ? r.value : {};
    unreadable = r.kind === 'corrupt';   // 손상본은 readJsonFile 이 옆에 보존했다(예전과 같다 — 이 기동 동안 쓰기 거절)
    return cache;
  }

  /** 값 하나 검증·정리 — cols 는 필수(빈 목록 거절), 선택값은 도구가 검증한다. */
  function normalizeValue(v, { slotNo = null } = {}) {
    if (!isObj(v)) return { ok: false, reason: '저장할 값 형식이 잘못됐습니다.' };
    const c = resolveCols(v.cols);
    if (!c.ok) return c;
    const o = normalizeOpts(v);
    if (!o.ok) return o;
    return { ok: true, value: { name: cleanName(v.name) || (slotNo ? `이름${slotNo}` : '기본값'), cols: c.keys, ...o.value } };
  }

  /** 저장된 값을 내보낼 때 — 사라진 항목은 빼고 그 수를 알린다(조용히 바꾸지 않는다). */
  function viewValue(v) {
    if (!isObj(v)) return null;
    const k = knownKeys(v.cols);
    return { ...v, cols: k.keys, ...(k.dropped ? { droppedCols: k.dropped } : {}) };
  }

  /** 이 계정의 저장값 — { def, slots[5], at }. 없으면 빈 칸들. */
  function getPrefs(username) {
    const e = load()[ukey(username)] || null;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => viewValue(e?.slots?.[i]));
    return { def: viewValue(e?.def), slots, at: e?.at || null, ...(unreadable ? { unreadable: true } : {}) };
  }

  function write(next) {
    atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, users: next }, null, 2), { mode: 0o600 });
    cache = next;
  }

  const slotIssue = (slot) => {
    const n = Number(slot);
    return slot === 'default' || (Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT) ? null : `저장 칸은 1~${SLOT_COUNT} 또는 기본값입니다.`;
  };
  const UNREADABLE_CORRUPT = { ok: false, status: 503, code: 'prefsUnreadable', reason: '저장값 파일을 읽지 못해 바꾸지 않습니다(손상 사본은 설정 폴더에 남았습니다).' };
  // 113회차 R4: 읽기 오류는 보존본이 없다 — 같은 꼴(503 · prefsUnreadable)에 사유만 사실대로.
  const unreadableReply = () => (readErr
    ? { ok: false, status: 503, code: 'prefsUnreadable', reason: `저장값 파일을 읽지 못해 바꾸지 않습니다(읽기 오류 ${readErr} — 원본은 그대로 두었습니다. 파일 소유자 · 권한을 확인하세요).` }
    : UNREADABLE_CORRUPT);

  /**
   * 저장 — slot: 1~5 또는 'default'. alsoDefault(칸에 저장할 때 기본값으로도) · 칸 값의 이름은 비면 '이름N'.
   * @returns {{ok:true, prefs:object} | {ok:false, status:number, reason:string, code?:string}}
   */
  function setPref(username, slot, value, { alsoDefault = false, now = Date.now() } = {}) {
    if (!username) return { ok: false, status: 400, reason: '계정을 알 수 없습니다.' };
    const si = slotIssue(slot);
    if (si) return { ok: false, status: 400, reason: si };
    const isDef = slot === 'default';
    const n = Number(slot);
    const nv = normalizeValue(value, { slotNo: isDef ? null : n });
    if (!nv.ok) return { ok: false, status: 400, reason: nv.reason };
    load();
    if (unreadable) return unreadableReply();
    const k = ukey(username);
    const next = { ...cache };
    if (!next[k] && Object.keys(next).length >= MAX_USERS) return { ok: false, status: 400, reason: `저장값을 가진 계정이 ${MAX_USERS}개를 넘었습니다.` };
    const cur = isObj(next[k]) ? next[k] : {};
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => (Array.isArray(cur.slots) ? cur.slots[i] || null : null));
    let def = cur.def || null;
    if (isDef) def = { ...nv.value };
    else {
      slots[n - 1] = nv.value;
      if (alsoDefault) def = { ...nv.value, from: n };
      else if (def?.from === n) def = { ...nv.value, from: n };   // 그 칸에서 온 기본값은 칸과 같이 바뀐다(칸 번호로 묶였다)
    }
    next[k] = { def, slots, at: new Date(now).toISOString() };
    write(next);
    return { ok: true, prefs: getPrefs(username) };
  }

  /** 칸 비우기(1~5) 또는 기본값 지우기('default' — 화면은 포탈 기본 조합으로 시작). */
  function clearPref(username, slot) {
    if (!username) return { ok: false, status: 400, reason: '계정을 알 수 없습니다.' };
    const si = slotIssue(slot);
    if (si) return { ok: false, status: 400, reason: si };
    load();
    if (unreadable) return unreadableReply();
    const k = ukey(username);
    if (!cache[k]) return { ok: true, prefs: getPrefs(username) };
    const next = { ...cache };
    const cur = { ...next[k], slots: [...(Array.isArray(next[k].slots) ? next[k].slots : [])] };
    if (slot === 'default') cur.def = null;
    else {
      const n = Number(slot);
      cur.slots[n - 1] = null;
      if (cur.def?.from === n) { const { from, ...rest } = cur.def; void from; cur.def = rest; }   // 기본값 내용은 남기고 칸과의 연결만 끊는다
    }
    next[k] = cur;
    write(next);
    return { ok: true, prefs: getPrefs(username) };
  }

  return {
    getPrefs, setPref, clearPref, normalizeValue,
    prefsUnreadable: () => { load(); return unreadable; },
    _resetForTest: () => { cache = null; unreadable = false; readErr = ''; retryAt = 0; },
  };
}
