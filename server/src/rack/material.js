/**
 * rack/material.js — 랙 실장도 조회 계정 가림의 **재료**(등록 서버의 관리 주소 · 서비스 태그): 모으기 · 기록에 흡수 · 세대별 색인 · 주기 흡수.
 *
 * 설계 docs/design/rack-mask-redesign(J4 '재료는 줄지 않는다') · 2026-11-27 6회차 점검 반영:
 *  · 재료는 원장 옆 기록(`rack/db.js maskAbsorb` · 표 rack_mask_seen)에 한 번이라도 본 값을 남기고, 가림은 **기록** 으로 만든다 — 엣지가 올린 서버 목록은 메모리뿐이라
 *    재시작 직후 · 수집 서버를 끈 뒤에도 가림이 풀리지 않게.
 *  · **흡수는 모든 길에서**: 조회(관리자 포함 — 등록부 칸은 매번 · 인벤토리 태그는 `INV_EVERY_MS` 에 한 번) · 쓰기(장비를 놓을 때 이름이 등록부 이름으로 채워진다) ·
 *    주기(`startMaterialWatch` — 아무도 랙 도구를 열지 않아도 · 원장 파일이 있을 때만). 6회차 정확성 D3 · 보안 1 · 반증 R2: 관리자 요청이 60초에 한 번만 기록해
 *    등록부에서 지워진 · 엣지 목록이 비워진 서버의 이름이 원문으로 나갔다.
 *  · **색인은 세대마다 한 번**(`materialIndex`): 기록이 바뀔 때만 다시 만들고 요청끼리 나눠 쓴다. 만들 때는 조각으로 나눠 양보하고(`createYielder`),
 *    진행 중인 빌드는 함께 기다린다(6회차 성능 1 · 2: 요청마다 기록 전체로 만들어 범위 30법인 목록이 1.4 → 335ms · 기록 20만에서 17초).
 *  · 법인 원장의 시리얼(`rack/db.js corpSerials`)은 작은 색인으로 따로 — 함대 색인과 함께 `stripTags` 에 넘긴다(여러 색인을 한 번에 훑는다).
 * ⚠ 재료를 요청 판본 · 범위로 줄이는 최적화를 넣지 말 것(범위 밖 서버의 주소가 든 이름이 범위 계정에게 나갔던 2회차 점검 1).
 * ⚠ 이 모듈의 값(기록 · 색인)은 **응답에 싣지 말 것** — 관리 화면(전체 범위 관리자)만 `rack/db.js maskSeenRows` 로 본다.
 */
import fs from 'node:fs';
import { analysisServersWithRemote, invForServer } from '../insights/analysisServers.js';
import { isPlaceholderTag } from '../bmusage/commonTag.js';
import { hostVariants } from '../auth/addressMask.js';
import { createYielder } from '../util/timeSlice.js';
import { HOST_MAX_LEN } from '../idrac/registry.js';
import { dropInvisible, foldWidth } from './layout.js';
import { tagIndexOf, tagIndexOfAsync, needleIndexOf, needleIndexOfAsync } from './textMask.js';
import * as R from './db.js';

/**
 * 식별자로 쓸 수 있는 서비스 태그 · 시리얼인가 — 자리표시 값('To Be Filled By O.E.M.' · 'None' · '0000000' · 영숫자 4자 미만 — `bmusage/commonTag.js isPlaceholderTag` ·
 * 다른 기능이 '서비스 태그를 열쇠로 써도 되는가' 에 쓰는 그 판정)이 아니어야 한다. **가림 재료**(2회차 반증 C2 — 'phone-01 none' 이 지워졌다)와 **연결 키**(라우트 corpServers)가 같이 쓴다.
 * 그 판정은 ASCII 영숫자만 남겨서 보므로 **비 ASCII 글자 · 숫자가 든 값은 자리표시로 보지 않는다**(4회차 점검 보안 1 · 정확성 2: 시리얼 '자산1234' · '본사-0000' 이
 * '1234' · '0000' 으로 읽혀 가림 재료에서 빠졌다). 예외는 **호환 정규화(NFKC) 뒤에도 남는 글자 · 숫자**에만 준다 — 전각('Ｎｏｎｅ' · '０００００００') · NBSP 가 낀
 * 'Default string' · 기호가 낀 값은 그 판정이 이미 자리표시로 잡는 변형이다(4회차 반증 B-2 · C-2: 그런 값이 진짜 태그가 되어 'spare default string unit' 이 지워졌다).
 */
const NON_ASCII_WORD = /(?![\u0000-\u007f])[\p{L}\p{N}]/u;
const NON_ASCII = { test: (t) => NON_ASCII_WORD.test(t.normalize('NFKC')) };
// 판정은 글자만으로 정해진다 — 같은 태그를 다시 판정하지 않는다(태그 2만여 개 · 약 10ms 실측 — 4회차 점검 성능). 상한을 넘으면 통째로 비운다.
const TAG_OK = new Map(); const TAG_OK_MAX = 200_000; const TAG_OK_KEY_MAX = 64;
export const usableTag = (t) => {
  if (typeof t !== 'string' || !t) return false;
  // 긴 값은 기억하지 않는다 — 엣지가 올린 과대 serviceTag 는 잘린 문자열이 원문(수십 KB)을 붙든 채 키가 되어 Map 이 그 원문을 놓지 않았다
  //   (5회차 점검 성능 2 재현: 서버 1,000대 × 50KB 태그가 수집마다 다르면 5회에 239MB). 진짜 태그는 이보다 훨씬 짧다(가림 색인의 키 상한도 64).
  if (t.length > TAG_OK_KEY_MAX) return NON_ASCII.test(t) || !isPlaceholderTag(t);
  let ok = TAG_OK.get(t);
  if (ok === undefined) { ok = NON_ASCII.test(t) || !isPlaceholderTag(t); if (TAG_OK.size >= TAG_OK_MAX) TAG_OK.clear(); TAG_OK.set(t, ok); }
  return ok;
};

// 가림 재료도 판정 대상 글과 **같은 눈으로** 본다 — 글에서만 보이지 않는 글자를 지우면, 그런 글자가 시리얼과 이름 양쪽에 든 옛 값이 서로 어긋나 가려지지 않았다(5회차 점검 정확성 1 · 재현).
export const cleanTag = (t) => (typeof t === 'string' ? foldWidth(dropInvisible(t)).trim() : t);
/** 가림 재료로 쓸 태그만(자리표시 제외 · 정리한 값). */
export const realTags = (arr) => (arr || []).map(cleanTag).filter(usableTag);

/** 등록부(중앙 + 엣지가 올린 서버) 전체 — 범위로 자르지 않는다. 요청 하나 · 주기 한 번에 한 번 읽는다. */
export const fleetServers = (user = null) => analysisServersWithRemote({ user, query: {} });

/**
 * 가림 재료(주소 · 태그) — 등록부 **전체**에서 모은다(범위로 자르지 않는다 — 2회차 점검 1: 원장은 법인 단위로 보이는데 재료를 조회자 범위 안 서버로만 만들면,
 *   같은 법인의 다른 vCenter 서버 · 귀속 없는 베어메탈의 관리 주소가 든 표시 이름이 범위 계정에게만 원문으로 나갔다).
 * `invTags` = 인벤토리에서만 읽힌 태그도 넣는다(2회차 반증 B-1 — 인벤토리 조회는 메모리 캐시 한 번이다 · `invCache.getInventory`).
 * 돌려주는 값은 정리한(`cleanTag`) 글이다.
 */
export function fleetMaterial(all, { invTags = false } = {}) {
  const hosts = []; const tags = [];
  for (const s of all || []) {
    if (typeof s.host === 'string' && s.host) hosts.push(cleanTag(s.host));
    // host 없이 올라온 원격 서버는 id 가 관리 주소일 수 있다(2회차 점검 6) — 주소처럼 보이는 id(점 · 콜론이 든 것)만 넣는다.
    //   서비스 태그 같은 id 까지 '주소' 로 넣으면 시리얼을 볼 수 있는 계정에게도 그 태그가 가려진다(3회차 점검 5).
    else if (s.id != null && /[.:]/.test(String(s.id))) hosts.push(cleanTag(String(s.id)));
    if (typeof s.serviceTag === 'string' && s.serviceTag) tags.push(cleanTag(s.serviceTag));
    if (invTags) {   // 등록부 칸이 있어도 인벤토리 값이 다를 수 있다(손으로 적은 태그 ≠ 장비가 답한 태그) — 둘 다 재료로
      let t = ''; try { t = invForServer(s)?.system?.serviceTag; } catch { t = ''; }
      if (typeof t === 'string' && t && t !== s.serviceTag) tags.push(cleanTag(t));
    }
  }
  return { hosts: hosts.filter(Boolean), tags: tags.filter(Boolean) };
}

// 인벤토리 태그까지 모으는 간격 — 등록부 칸(주소 · 등록 태그)은 매번 흡수한다(싸다 — 집합 대조뿐). 인벤토리 훑기는 서버마다 캐시를 한 번 보므로 간격을 둔다.
export const INV_EVERY_MS = 60_000;
let _invAt = 0;
/** 테스트 전용 — 다음 흡수가 인벤토리 태그까지 모으게 한다. */
export function _resetAbsorbForTest() { _invAt = 0; }
/**
 * 등록부의 지금 재료를 기록에 흡수한다(새 값만 — `rack/db.js maskAbsorb`). 기록을 읽지 못하면 던진다(`R.MaskUnavailable`).
 * @param {object[]} all  `fleetServers()` 결과   @param {{ forceInv?: boolean }} [o]
 */
export async function absorbFleet(all, { forceInv = false, out = null } = {}) {
  const inv = forceInv || Date.now() - _invAt >= INV_EVERY_MS;
  const m = fleetMaterial(all, { invTags: inv });
  const gen = await R.maskAbsorb(m.hosts, m.tags, { out });   // out.short = 메모리 상한 때문에 담지 못한 지금 값의 수(라우트가 조회 계정에 503)
  if (inv) _invAt = Date.now();   // 흡수를 마친 뒤에 간격을 시작한다(못 마친 흡수가 간격만 먹지 않게)
  return gen;
}

/**
 * 세대별 색인 — { gen, addrSet(주소 변형 · 소문자), hostIdx(글 속 주소 찾기), fleetTagIdx(함대 태그 · 기록 태그), hosts, tags }.
 * 기록이 바뀌지 않았으면 같은 객체를 돌려준다. 만드는 중이면 그 빌드를 함께 기다린다. 기록을 읽지 못하면 던진다(`R.MaskUnavailable`).
 */
let _ix = null;
let _ixBuild = null;
export async function materialIndex() {
  const st = await R.maskState();
  if (_ix && _ix.gen === st.gen) return _ix;
  if (_ixBuild && _ixBuild.gen === st.gen) return _ixBuild.p;
  const gen = st.gen;
  // 값은 지금 베껴 둔다 — 만드는 동안 다른 요청이 흡수해도 이 세대의 색인은 이 세대의 값으로(더 많은 값이 섞여도 해롭지 않지만 세대 표가 거짓말을 하지 않게)
  const hosts = [...st.hosts, ...st.overHosts];
  const tags = [...st.tags, ...st.overTags];
  const p = buildIndex(gen, hosts, tags).then((ix) => { if (!_ix || _ix.gen <= gen) _ix = ix; return ix; })
    .finally(() => { if (_ixBuild && _ixBuild.p === p) _ixBuild = null; });
  _ixBuild = { gen, p };
  return p;
}
// 글 속 주소 찾기 색인의 길이 — 상한은 등록부 host 상한(`idrac/registry.js HOST_MAX_LEN` 2,048)과 같게: 255자 넘는 주소(경로가 붙은 URL)도 글 속에서 찾는다
//   (7회차 C5: 예전 상한 255 라 그런 주소는 이름 통째가 같을 때만 가렸다. 파일에는 255자까지만 남긴다 — `rack/db.js` ⓓ).
const HOST_NEEDLE = Object.freeze({ min: 3, max: HOST_MAX_LEN });
async function buildIndex(gen, hosts, tags) {
  const pause = createYielder(15);
  const addrSet = new Set(); const variants = [];
  let i = 0;
  for (const h of hosts) {
    for (const v of hostVariants(h)) { addrSet.add(v.toLowerCase()); variants.push(v); }
    if ((++i & 511) === 0) await pause();
  }
  const hostIdx = await needleIndexOfAsync(variants, HOST_NEEDLE, pause);
  const usable = []; i = 0;
  for (const t of tags) { if (usableTag(t)) usable.push(t); if ((++i & 1023) === 0) await pause(); }
  const fleetTagIdx = await tagIndexOfAsync(usable, pause);
  return { gen, addrSet, hostIdx, fleetTagIdx, hosts: hosts.length, tags: tags.length };
}
/**
 * 주소 목록(정리한 글) 하나로 만든 작은 주소 색인 — `materialIndex` 의 주소 칸과 같은 꼴({ addrSet, hostIdx }). 동기라 작은 목록에만.
 * 시리얼 칸 입력 검사가 **쓰는 사람의 조회 범위 안 서버**로만 판정할 때 쓴다(7회차 S7-1: 함대 색인으로 거절하면 범위 관리자가 후보 이름을 넣어
 *   400 · 200 차이로 다른 법인 서버가 등록돼 있는지 알아냈다 — 설계 5.5 · 반증 2-2 가 막기로 한 길).
 */
export function hostIndexOf(hosts) {
  const addrSet = new Set(); const variants = [];
  for (const h of hosts || []) for (const v of hostVariants(h)) { addrSet.add(v.toLowerCase()); variants.push(v); }
  return { addrSet, hostIdx: needleIndexOf(variants, HOST_NEEDLE) };
}
/** 법인 원장 시리얼의 작은 색인(요청 안에서 법인마다 한 번). */
export const corpTagIndexOf = (serials) => tagIndexOf(realTags(serials));
/** 같은 색인을 조각으로(가림 집계처럼 법인 원장 전부를 훑는 긴 작업 — 7회차 P7-5). 결과는 `corpTagIndexOf` 와 같다. */
export async function corpTagIndexOfAsync(serials, pause) {
  const usable = []; let i = 0;
  for (const s of serials || []) { const t = cleanTag(s); if (usableTag(t)) usable.push(t); if ((++i & 1023) === 0) await pause(); }
  return tagIndexOfAsync(usable, pause);
}
/** 테스트 전용 — 색인 캐시를 버린다. */
export function _dropIndexForTest() { _ix = null; _ixBuild = null; }

// ───────────────────────── 주기 흡수 ─────────────────────────
/**
 * 아무도 랙 도구를 열지 않아도 등록부의 재료를 기록에 남긴다 — 서버가 등록부에 있는 동안 한 번이라도 흡수되면, 뒤에 지워지거나 엣지 목록이 비어도 가린다.
 *  · 원장 파일(rack.db)이 **있을 때만** 돈다 — 랙 실장도를 쓰지 않는 포탈(엣지 등)에 파일을 만들지 않는다(없음은 ENOENT 로만 판정 — 134회차 규약).
 *  · 재진입하지 않는다 · 한 번이 `WATCH_DEADLINE_MS` 를 넘으면 그 회차의 표식을 풀어 다음 회차가 돌 수 있게 한다(끝나지 않는 회차가 표식을 영원히 붙잡지 않게).
 *  · 실패는 경고만(같은 사유는 한 번) — 조회 요청이 그 자리에서 다시 흡수하므로 가림이 이 작업에 기대지 않는다.
 */
export const WATCH_EVERY_MS = 60_000;
const WATCH_DEADLINE_MS = 5 * 60_000;
let _watchTimer = null;
let _watchRunning = 0;
let _watchLastWarn = '';
export async function materialWatchTick({ fileExists = defaultFileExists } = {}) {
  if (_watchRunning && Date.now() - _watchRunning < WATCH_DEADLINE_MS) return { skipped: 'running' };
  _watchRunning = Date.now();
  const mine = _watchRunning;
  try {
    if (!(await fileExists(R.rackDbFile()))) return { skipped: 'no-ledger' };
    const gen = await absorbFleet(fleetServers(), { forceInv: true });
    _watchLastWarn = '';
    return { gen };
  } catch (e) {
    const why = String(e?.message || e).slice(0, 200);
    if (why !== _watchLastWarn) { _watchLastWarn = why; console.warn('[rack-material] 가림 재료를 주기적으로 흡수하지 못했습니다(조회 때 다시 흡수합니다):', why); }
    return { error: why };
  } finally { if (_watchRunning === mine) _watchRunning = 0; }
}
async function defaultFileExists(file) {
  try { await fs.promises.stat(file); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
}
/** 포탈 시작 때 한 번 부른다(index.js). 두 번 불러도 하나만 돈다. */
export function startMaterialWatch() {
  if (_watchTimer) return;
  _watchTimer = setInterval(() => { materialWatchTick().catch(() => {}); }, WATCH_EVERY_MS);
  _watchTimer.unref?.();
  setTimeout(() => { materialWatchTick().catch(() => {}); }, 15_000).unref?.();   // 첫 회차 — 시작 직후의 부하를 피해 조금 뒤
}
export function stopMaterialWatch() { if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; } }
