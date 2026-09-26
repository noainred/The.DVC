/**
 * 사이트 위임 수집 — 중앙(OC2) 측 인벤토리 캐시.
 *
 * 고RTT 원격 사이트의 vCenter는 그 사이트의 단독 서버(에이전트)가 로컬에서 수집해
 * /api/central/inventory 로 push 한다. 중앙은 그 vCenter를 직접 폴링하지 않고(=RTT 제거)
 * 여기 캐시된 스냅샷 조각을 글로벌 스냅샷에 병합한다.
 *
 * 캐시는 메모리 + 디스크(CONFIG_DIR/central-inventory.json)에 보관해 재시작 시에도
 * 다음 push 전까지 마지막 데이터를 서빙한다(콜드 스타트 공백 최소화).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { isMockVcenter } from '../mock/generator.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';

const FILE = path.join(config.configDir, 'central-inventory.json');

// null-proto 캐시: 에이전트가 제어하는 vcenterId가 '__proto__'/'constructor' 등이어도 프로토타입을
// 오염시키지 않고 일반 키로 저장된다(엔트리가 Object.keys에서 사라져 prune/persist 누락되는 것 방지).
let cache = Object.create(null); // vcenterId -> { at, agent, generatedAt, data:{...} }
try {
  if (fs.existsSync(FILE)) { const p = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (p && typeof p === 'object') cache = Object.assign(Object.create(null), p.inventory || p || {}); }
} catch (e) {
  cache = Object.create(null);
  // 손상 파일 보존 — 조용히 비우면 다음 push의 persist가 손상본을 덮어써, 콜드 스타트에
  // 인벤토리가 비었던 원인을 사후에 알 수 없다. <file>.corrupt.<ts>로 옮기고 경고만 남긴다
  // (빈 캐시로 기동은 계속 — 다음 push가 오면 자동 복구되는 캐시이므로 기동 실패로 만들지 않는다).
  try {
    const bak = `${FILE}.corrupt.${Date.now()}`;
    fs.renameSync(FILE, bak);
    console.warn(`[central] ${FILE} 파싱 실패(${e?.message || e}) — ${bak}로 보존하고 빈 인벤토리로 시작합니다.`);
  } catch { /* 보존 실패가 기동을 막지 않게 */ }
}

let writeTimer = null;
let writing = false; // 쓰기 중 재진입 방지 — tmp 충돌 및 늦게 끝난 이전 본문이 최신본을 덮는 것 차단
// v2.600(감사 T2600-03): 동기 저장 세대 — 비동기 쓰기가 도는 사이 동기 저장(소유권 변경·종료 flush)이 끼면, 늦게 끝난
//   비동기 rename 이 **더 오래된 본문**으로 동기 저장본을 덮는다. 세대가 바뀌었으면 그 rename 을 버린다.
let syncGen = 0;

/**
 * 즉시 동기 원자 저장(v2.600 T2600-03). 관리자 소유권 해제·지정은 **다음 push 가 재구축하지 않는 의도**라 디바운스 5초 창에
 * 재시작이 끼면 사라졌다(해제한 소유권이 되살아나 새 엣지가 계속 403). 대기 중 디바운스는 이 저장이 흡수한다.
 */
function persistNowSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  syncGen += 1;
  atomicWriteFileSync(FILE, JSON.stringify({ inventory: cache }), { mode: 0o600 });
}
// 종료 시 대기 중(또는 진행 중)인 디바운스 저장을 동기로 끝낸다 — 캐시 본문도 마지막 5초 창을 잃지 않는다.
registerExitFlush('central/inventory', () => { if (writeTimer || writing) persistNowSync(); });
// v2.617: 5초 → 기본 30초. 매 저장이 위임 vCenter 전체 캐시(수 MB~수십 MB)를 JSON.stringify 하는데, 엣지 28곳이 1분마다
//   push 하면 거의 5초마다 돌아 그 문자열 사본이 계속 힙에 생겼다. 캐시는 다음 push 로 복구되고 종료 시 동기 flush 가
//   있으므로(registerExitFlush) 창을 늘려도 정상 재시작에서 잃는 것은 없다. 비정상 종료 시 최대 이 창만큼 잃는다.
const PERSIST_DEBOUNCE_MS = Math.min(300_000, Math.max(5_000, Number(process.env.CENTRAL_INVENTORY_PERSIST_MS) || 30_000));
function persistSoon() {
  // 인벤토리는 수MB가 될 수 있으므로 디스크 쓰기를 비동기 + 디바운스(이벤트 루프 비차단).
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writing) { persistSoon(); return; } // 이전 쓰기 진행 중 — 다음 디바운스 주기로 미룸
    // 타이머 콜백의 동기 예외(stringify 문자열 길이 상한 초과·mkdir 실패 등)는 uncaught가 되어
    // 프로세스를 죽이므로 반드시 격리한다.
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const body = JSON.stringify({ inventory: cache });
      // 원자성 확보: tmp에 쓰고 rename으로 교체 — 대상 파일에 직접 쓰면 수MB 기록 중 크래시/
      // 정전 시 잘린 JSON이 남아 다음 기동이 인벤토리를 통째로 잃는다(rename은 같은 FS에서
      // 원자적이라 '온전한 이전본' 또는 '온전한 새본'만 남는다).
      // util/atomicWriteFileSync(동기)를 쓰지 않는 이유: 수MB write+fsync가 push마다 이벤트
      // 루프를 수백ms 블로킹해 28개 vCenter 수집·API 응답을 함께 지연시킨다. fsync를 생략한
      // 비동기 write→rename으로 '원자성만' 확보한다(정전 시 최근 push 1회 유실 가능하나,
      // 다음 push로 즉시 복구되는 캐시라 허용).
      const tmp = `${FILE}.tmp-${process.pid}`;
      writing = true;
      const gen = syncGen;
      fs.promises.writeFile(tmp, body, { mode: 0o600 })
        .then(() => (gen === syncGen ? fs.promises.rename(tmp, FILE) : fs.promises.unlink(tmp))) // 그 사이 동기 저장이 더 새 본문을 썼다
        .catch(() => fs.promises.unlink(tmp).catch(() => {}))
        .finally(() => { writing = false; });
    } catch { /* best effort — 쓰기 실패가 수집을 막지 않게 */ }
  }, PERSIST_DEBOUNCE_MS);
  writeTimer.unref?.();
}

/** 마지막 정상 목록 보존 창 — store.js LASTGOOD_HOLD_MS 와 같은 값·같은 env(순환 import 를 피해 여기서 읽는다). */
const HOLD_MS = Number(process.env.LASTGOOD_HOLD_MS) || 6 * 3_600_000;
// v2.601(감사 EDGE2601-03): maintenance 추가 — 엣지 agent/inventoryPush.js UNREAD_STATUSES 와 같은 집합(한 기준). 캐시 없는
//   점검중 vCenter(엣지 재시작 직후)의 빈 조각이 마지막 정상 목록을 지우지 않게 상태만 갱신한다(보존은 HOLD_MS 까지).
const UNREAD = new Set(['unreachable', 'pending', 'maintenance']);
const hasRows = (a) => Array.isArray(a) && a.length > 0;

/**
 * 사이트가 push한 한 vCenter의 스냅샷 조각을 저장.
 *
 * v2.600(감사 EDGE2600-04 중앙쪽): **인벤토리를 읽지 못한 빈 조각**(vcenter.status 가 unreachable/pending 이고 호스트·VM 0)은
 * 마지막 정상 목록을 지우지 않는다. 엣지가 재시작 직후 첫 수집에 실패하면 lastGood 이 메모리에 없어 빈 unreachable 조각을
 * 보냈고(구버전 엣지 — v2.600 엣지는 보내지 않는다), 통째로 교체하던 이 함수가 중앙의 정상 호스트·VM 을 즉시 지웠다.
 * 이제 목록은 두고 **vcenter 상태만** 갱신하며, `at`(데이터 시각)은 그대로 둬 store 가 '낡음(stale)' 으로 표시한다 —
 * 모르는 것을 0 대로도, 지금 값으로도 칠하지 않는다. 보존은 LASTGOOD_HOLD 창(기본 6시간)까지이고 넘으면 빈 조각을 받는다.
 * @returns {{ held: boolean }}
 */
export function setInventory(vcenterId, slice, agent, generatedAt) {
  const now = Date.now();
  const prev = cache[vcenterId];
  const st = slice?.vcenter?.status;
  if (prev && UNREAD.has(st) && !hasRows(slice?.hosts) && !hasRows(slice?.vms)
    && (hasRows(prev.data?.hosts) || hasRows(prev.data?.vms)) && now - (Number(prev.at) || 0) <= HOLD_MS) {
    const pv0 = prev.data?.vcenter && typeof prev.data.vcenter === 'object' ? prev.data.vcenter : {};
    const { maintenance: _prevMaint, ...pv } = pv0;   // 점검중 표시는 이번 상태로만 정한다(해제 뒤 남지 않게)
    cache[vcenterId] = {
      ...prev, agent: agent || prev.agent || '', pushAt: now, heldSince: prev.heldSince || now,
      data: { ...prev.data, vcenter: { ...pv, status: st, ...(st === 'maintenance' ? { maintenance: true } : {}), ...(typeof slice.vcenter.error === 'string' ? { error: slice.vcenter.error.slice(0, 500) } : {}), held: true } },
    };
    persistSoon();
    return { held: true };
  }
  cache[vcenterId] = { at: now, pushAt: now, agent: agent || '', generatedAt: generatedAt || null, data: slice };
  persistSoon();
  return { held: false };
}

export function getInventory(vcenterId) { return cache[vcenterId] || null; }

/**
 * v2.599(EDGE2599-03): 관리자 명시 소유 엣지 해제/지정. 인벤토리 소유권은 TOFU(첫 push 한 엣지)이고 만료되지 않아,
 * 담당 엣지를 교체하면 새 엣지의 push 가 영구 403 이었다. 관리자가 해제(`agent=''`)하면 **다음 개별 토큰 push 가 새 소유**가
 * 되고, 지정하면 그 엣지만 쓸 수 있다. 저장된 스냅샷(data)은 지우지 않는다 — 새 엣지가 보낼 때까지 마지막 값을 보인다.
 * @returns {{ ok:boolean, reason?:string, from?:string, to?:string }}
 */
export function setInventoryOwner(vcenterId, agent) {
  const e = cache[vcenterId];
  if (!e) return { ok: false, reason: 'not-found' };
  const from = e.agent || '';
  e.agent = String(agent || '');
  e.ownerSetAt = Date.now();
  e.ownerSetBy = e.agent ? 'admin-assign' : 'admin-release';
  // v2.600(T2600-03): 관리자 의도는 즉시 디스크에 — 실패하면 호출자에게 밝힌다(메모리에는 반영됐고 다음 저장이 다시 시도한다).
  try { persistNowSync(); } catch (err) { persistSoon(); return { ok: true, from, to: e.agent, persisted: false, persistError: String(err?.message || err) }; }
  return { ok: true, from, to: e.agent, persisted: true };
}

/** 운영 화면용 요약(데이터 본문 제외). */
export function listInventory() {
  return Object.entries(cache).map(([vcenterId, e]) => ({
    vcenterId, agent: e.agent, at: e.at, generatedAt: e.generatedAt,
    ...(e.pushAt ? { pushAt: e.pushAt } : {}), ...(e.heldSince ? { heldSince: e.heldSince } : {}),   // v2.600 EDGE2600-04
    hosts: e.data?.hosts?.length || 0, vms: e.data?.vms?.length || 0,
    datastores: e.data?.datastores?.length || 0,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * 이미 저장돼 있는 **목(가짜) 인벤토리**를 지운다(v2.443).
 *
 * 차단이 들어오기 전(또는 DATA_SOURCE=auto 폴백으로) 저장된 데모 사이트가 중앙 화면에 남아
 * 실데이터와 섞여 보였다(사용자 신고: live 로 바꿨는데 'east us' 가 올라옴). 기동 시 1회 훑어
 * 생성기의 id·이름이 둘 다 일치하는 항목만 제거한다 — 둘 다 같을 일은 없어 실데이터는 안 지운다.
 * @returns {string[]} 제거한 vCenter id 목록
 */
export function pruneMockInventory() {
  const removed = [];
  for (const [id, e] of Object.entries(cache)) {
    const vc = e?.data?.vcenter || { id, name: e?.data?.vcenter?.name };
    if (isMockVcenter({ id, name: vc?.name })) { delete cache[id]; removed.push(id); }
  }
  if (removed.length) {
    console.warn(`[central] 저장돼 있던 목(가짜) 인벤토리 ${removed.length}건 제거: ${removed.join(', ')} — 엣지가 DATA_SOURCE=auto 로 폴백했거나 구버전이라 올라온 데이터입니다.`);
    persistSoon();
  }
  return removed;
}

/** 레지스트리에서 제거된 vCenter의 캐시 정리. */
export function pruneInventory(validIds) {
  let changed = false;
  for (const id of Object.keys(cache)) if (!validIds.has(id)) { delete cache[id]; changed = true; }
  if (changed) persistSoon();
}
