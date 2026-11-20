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
import { config, clampIntervalMs } from '../config.js';
import { isMockVcenter } from '../mock/generator.js';
import { atomicWriteFileSync, safeLoadText, corruptBackupPath } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { capStr } from '../util/capStr.js';
import { readJsonFile, READ_RETRY_MS } from '../util/jsonFileLoad.js'; // 87회차 ⓐ: 읽기 오류 ≠ 손상(공용 읽기 판정)
import { inRetryWindow } from '../util/jsonFileRead.js';   // 128회차: 재읽기 간격 판정은 공용(시계가 뒤로 가도 그 차만큼 굳지 않게)
import { envPositive } from '../util/envNumber.js';   // 55회차: 양수 env 는 하나로
import { logAudit } from '../audit.js';   // 결정(76~105 남긴 것 · 2026-11-20) A6: 읽기 오류 창의 TOFU 소유 기록

const FILE = path.join(config.configDir, 'central-inventory.json');

// null-proto 캐시: 에이전트가 제어하는 vcenterId가 '__proto__'/'constructor' 등이어도 프로토타입을
// 오염시키지 않고 일반 키로 저장된다(엔트리가 Object.keys에서 사라져 prune/persist 누락되는 것 방지).
let cache = Object.create(null); // vcenterId -> { at, agent, generatedAt, data:{...} }
// 87회차 ⓐ(84회차 남긴 것 ② — 권장안): 공용 읽기 판정(util/jsonFileLoad.js). 예전 catch 하나는 **읽기 오류**(EACCES · EIO)도 손상으로 보고 온전한 원본을
//   `.corrupt.*` 로 옮겼다(소유 엣지 지정 — 관리자 해제 · 지정 포함 — 까지 보존본에만 남는다). 이제 읽기 오류는 원본을 두고 빈 캐시로 시작하되 **저장하지 않는다**
//   (원자적 rename 이 원본을 덮는다). 저장 시점에 READ_RETRY_MS 간격으로 다시 읽어 읽히면 합친다 — 메모리에 없는 vCenter 는 파일 값, 둘 다 있으면
//   소유 엣지가 같을 때만 메모리(더 새 push), 다르면 파일(그동안 TOFU 로 다른 엣지가 가져간 소유를 되돌린다). 손상은 예전과 같다(보존 후 빈 캐시).
const parseInventoryFile = (text) => { const p = JSON.parse(text); return p && typeof p === 'object' ? Object.assign(Object.create(null), p.inventory || p || {}) : Object.create(null); };
let readBlocked = false; let readRetryAt = 0;
{
  const r = readJsonFile(FILE, { parse: parseInventoryFile, preserve: false });
  if (r.kind === 'ok') cache = r.value;
  else if (r.kind === 'read-error') {
    readBlocked = true; readRetryAt = Date.now() + READ_RETRY_MS;
    console.warn(`[central] ${path.basename(FILE)} 읽기 오류(${(capStr(r.error?.code, 32) || 'read-error')}) — 손상이 아니라 원본은 그대로 둡니다 · 읽힐 때까지 저장하지 않고 ${Math.round(READ_RETRY_MS / 1000)}초마다 다시 읽습니다(그동안 빈 인벤토리로 시작).`);
  } else if (r.kind === 'corrupt') {
    // 손상 파일 보존 — 조용히 비우면 다음 push의 persist가 손상본을 덮어써, 콜드 스타트에
    // 인벤토리가 비었던 원인을 사후에 알 수 없다. <file>.corrupt.<ts>로 옮기고 경고만 남긴다
    // (빈 캐시로 기동은 계속 — 다음 push가 오면 자동 복구되는 캐시이므로 기동 실패로 만들지 않는다).
    try {
      const bak = corruptBackupPath(FILE);   // v3.25.1: 같은 밀리초 보존본을 덮어쓰지 않게
      fs.renameSync(FILE, bak);
      // v2.744(최종 수정분 검토 RV2744F-LOAD-01): 사유는 요약(safeLoadText) — V8 JSON.parse 오류 원문은 파일 조각을 싣는다(콘솔 → /admin/logs·엣지 로그).
      console.warn(`[central] ${FILE} 파싱 실패(${safeLoadText(r.error) || '사유 미상'}) — ${bak}로 보존하고 빈 인벤토리로 시작합니다.`);
    } catch { /* 보존 실패가 기동을 막지 않게 */ }
  }
}
/** 87회차 ⓐ: 저장해도 되는가 — 읽기 오류였으면 간격마다 다시 읽어 합친다(위 규칙). 아직 못 읽으면 false. */
function inventoryWritable() {
  if (!readBlocked) return true;
  if (inRetryWindow(Date.now(), readRetryAt, READ_RETRY_MS)) return false;
  // 결정(76~105 남긴 것 · 2026-11-20) 반증: 창 동안 파일이 **손상**으로 바뀌었으면(디스크 복구 뒤 잘린 본문 등) 기동 때와 같이 보존본(.corrupt.*)으로 옮긴 뒤에만 연다 —
  //   예전에는 preserve:false 라 다음 저장이 손상본(관리자 소유 지정 포함)을 보존본 없이 덮었다(재현). 옮기지 못했으면 읽기 오류처럼 계속 막는다(간격마다 다시).
  const r = readJsonFile(FILE, { parse: parseInventoryFile, preserve: true });
  if (r.kind === 'read-error' || (r.kind === 'corrupt' && !r.backup)) { readRetryAt = Date.now() + READ_RETRY_MS; return false; }
  const reverted = []; let restored = 0;
  if (r.kind === 'ok') {
    for (const [id, f] of Object.entries(r.value)) {
      const m = cache[id];
      if (!m) { cache[id] = f; restored += 1; continue; }
      if (String(m.agent || '').toLowerCase() !== String(f?.agent || '').toLowerCase()) {
        reverted.push({ id, from: String(m.agent || ''), to: String(f?.agent || ''), admin: /^admin-/.test(String(m.ownerSetBy || '')) });   // 결정 A6: 되돌린 소유를 센다
        cache[id] = f;
      }
    }
  }
  readBlocked = false; readRetryAt = 0;
  noteUnreadWindowMerge(r, reverted, restored);   // 결정 A6: 감사 로그 · 콘솔 한 줄(창마다 한 번)
  return true;
}
/** 87회차 ⓐ: 테스트 · 진단 — 위임 인벤토리 파일을 읽지 못해 저장을 멈춘 상태인가. */
export function inventoryReadBlocked() { return readBlocked; }

/*
 * 결정(76~105 남긴 것 · 2026-11-20) A6(권장안 — 동작은 현행 유지 + 기록): 읽기 오류 창(readBlocked — 기동 때 파일을 읽지 못해 빈 캐시로 시작) 동안은
 *   소유(TOFU)가 비어 **첫 push 엣지가 소유를 잡는다**(routes/central.js /inventory — 소유가 비면 통과). 막지 않는다 — 개별 토큰 push 를 503 으로 막으면
 *   디스크 장애 한 번에 위임 법인 화면이 통째로 빈다(빈 캐시라 화면도 빈다). vCenter 등록부에는 담당 엣지 칸이 없어 대조할 다른 원천도 없다.
 *   대신 투명성: 그 창에서 잡힌 소유를 **감사 로그**(건마다 — 창마다 상한 WINDOW_CLAIM_AUDIT_MAX) · **콘솔**(창마다 첫 건 한 줄)에 남기고,
 *   다시 읽혀 합칠 때(inventoryWritable) 되돌린 수 · 되살린 수 · 파일과 같았던 수 · 파일에 없어 그대로 둔 수를 감사 로그 · 콘솔에 한 줄 남긴다.
 *   감사 로그의 주체는 **인증된 이름**만 엣지 이름으로 쓴다(개별 토큰 — routes/central.js 가 verified 로 넘긴다). 공유 토큰은 'edge:(공유 토큰)' 이고 이름은 본문 주장으로만 적는다.
 */
const WINDOW_CLAIM_AUDIT_MAX = 64;     // 창 하나에서 건마다 남기는 감사 로그 상한(위임 vCenter 30여 개 — 등록부 밖 id 를 바꿔 가며 감사 로그를 밀어내지 못하게)
const WINDOW_CLAIM_TRACK_MAX = 1_000;  // 창 하나에서 추적하는 소유 수 상한(넘으면 수만 센다)
const windowClaims = new Map();        // vcenterId → { agent, verified }
let windowClaimOverflow = 0; let windowClaimAudits = 0; let windowClaimConsoled = false;
function noteUnreadWindowClaim(vcenterId, agent, { verified = false, ip = '' } = {}) {
  const id = String(vcenterId);
  if (windowClaims.size < WINDOW_CLAIM_TRACK_MAX) windowClaims.set(id, { agent: capStr(String(agent), 64), verified: !!verified });
  else windowClaimOverflow += 1;
  const who = verified ? `edge:${capStr(String(agent), 64)}` : 'edge:(공유 토큰)';
  if (!windowClaimConsoled) {
    windowClaimConsoled = true;
    console.warn(`[central] ${path.basename(FILE)} 읽기 오류 중 — 첫 push 로 소유를 잡은 vCenter 가 생겼습니다(vc=${capStr(id, 128)} · ${who}${verified ? '' : ` · 이름 ‘${capStr(String(agent), 64)}’`}). 파일과 대조하기 전의 소유입니다 — 이후 건은 감사 로그(central-inventory.owner-claim-unread)에만 남기고, 파일이 다시 읽히면 합친 결과를 한 줄 남깁니다.`);
  }
  if (windowClaimAudits >= WINDOW_CLAIM_AUDIT_MAX) return;
  windowClaimAudits += 1;
  try {
    logAudit({ user: who, action: 'central-inventory.owner-claim-unread', target: capStr(id, 128),
      detail: `위임 인벤토리 파일(${path.basename(FILE)})을 읽지 못한 동안 첫 push 로 소유를 잡았습니다(TOFU — 파일 소유와 대조 전)${verified ? '' : ` · 공유 토큰 · 이름 ‘${capStr(String(agent), 64)}’(미검증)`}. 파일이 다시 읽히면 소유가 다른 것은 파일 쪽으로 되돌립니다${windowClaimAudits === WINDOW_CLAIM_AUDIT_MAX ? ` — 이 창의 건별 기록 상한(${WINDOW_CLAIM_AUDIT_MAX})에 닿았습니다(나머지는 합칠 때의 합계에)` : ''}`,
      ip: capStr(String(ip || ''), 64) });
  } catch { /* 감사 실패가 수신을 막지 않게 */ }
}
function noteUnreadWindowMerge(r, reverted, restored) {
  const claims = windowClaims.size + windowClaimOverflow;
  let same = 0; let notInFile = 0;
  for (const [id, c] of windowClaims) {
    const f = r.kind === 'ok' ? r.value[id] : null;
    if (!f) notInFile += 1;
    else if (String(f.agent || '').toLowerCase() === c.agent.toLowerCase()) same += 1;
  }
  const list = reverted.slice(0, 10).map((x) => `${capStr(x.id, 128)}: ${capStr(x.from, 64) || '(없음)'} → ${capStr(x.to, 64) || '(없음)'}${x.admin ? '(창 동안 관리자 지정)' : ''}`).join(', ');
  const head = r.kind === 'ok' ? '다시 읽었습니다(읽기 오류 풀림 — 파일의 인벤토리 · 소유 엣지를 합쳤습니다)' : `다시 읽었지만 ${r.kind === 'missing' ? '파일이 없어' : `파일이 손상돼(손상본은 ${path.basename(String(r.backup || ''))} 로 보존 — 관리자 소유 지정은 그 안에 있습니다)`} 대조하지 못했습니다(읽기 오류 풀림 — 지금 메모리 소유를 그대로 둡니다)`;
  const detail = `${head} — 창 동안 첫 push 로 잡힌 소유 ${claims}건(파일과 같음 ${same} · 파일에 없어 그대로 ${notInFile + windowClaimOverflow}) · 파일 쪽으로 되돌린 소유 ${reverted.length}건${list ? `(${list}${reverted.length > 10 ? ` 외 ${reverted.length - 10}건` : ''})` : ''} · 파일에서 되살린 vCenter ${restored}`;
  console.warn(`[central] ${path.basename(FILE)} ${detail}`);
  try { logAudit({ user: 'system', action: 'central-inventory.unread-window-merge', target: path.basename(FILE), detail }); } catch { /* 감사 실패가 저장을 막지 않게 */ }
  windowClaims.clear(); windowClaimOverflow = 0; windowClaimAudits = 0; windowClaimConsoled = false;
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
  if (!inventoryWritable()) throw new Error(`${path.basename(FILE)} 를 읽지 못한 상태라 저장하지 않았습니다(읽기 오류 — 원본은 그대로) — 파일 권한 · 소유자를 확인하세요(읽히면 다음 저장이 반영합니다).`);   // 87회차 ⓐ
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  syncGen += 1;
  atomicWriteFileSync(FILE, JSON.stringify({ inventory: cache }), { mode: 0o600 });
}
// 종료 시 대기 중(또는 진행 중)인 디바운스 저장을 동기로 끝낸다 — 캐시 본문도 마지막 5초 창을 잃지 않는다.
registerExitFlush('central/inventory', () => { if ((writeTimer || writing) && inventoryWritable()) persistNowSync(); });   // 87회차 ⓐ: 읽기 오류 중에는 원본을 덮지 않는다
// v2.617: 5초 → 기본 30초. 매 저장이 위임 vCenter 전체 캐시(수 MB~수십 MB)를 JSON.stringify 하는데, 엣지 28곳이 1분마다
//   push 하면 거의 5초마다 돌아 그 문자열 사본이 계속 힙에 생겼다. 캐시는 다음 push 로 복구되고 종료 시 동기 flush 가
//   있으므로(registerExitFlush) 창을 늘려도 정상 재시작에서 잃는 것은 없다. 비정상 종료 시 최대 이 창만큼 잃는다.
const PERSIST_DEBOUNCE_MS = Math.min(300_000, clampIntervalMs(process.env.CENTRAL_INVENTORY_PERSIST_MS, 30_000, 1_000));
function persistSoon() {
  // 인벤토리는 수MB가 될 수 있으므로 디스크 쓰기를 비동기 + 디바운스(이벤트 루프 비차단).
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writing) { persistSoon(); return; } // 이전 쓰기 진행 중 — 다음 디바운스 주기로 미룸
    if (!inventoryWritable()) { persistSoon(); return; } // 87회차 ⓐ: 읽기 오류 중 — 원본을 덮지 않고 다음 주기에 다시 본다
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
const HOLD_MS = envPositive(process.env.LASTGOOD_HOLD_MS, 21_600_000);   // 6시간 · 55회차 #4: store.js 와 같은 판정(음수 · Infinity 를 통과시키지 않는다 — 한 기준)
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
 * @param {{ verified?:boolean, ip?:string }} [o]  결정 A6: 감사 로그의 주체 — verified 는 개별 토큰으로 **인증된** 이름인가(routes/central.js 가 넘긴다)
 * @returns {{ held: boolean, claimedWhileUnread?: true }}  claimedWhileUnread = 읽기 오류 창 동안 이 push 가 빈 소유를 잡았다(결정 A6 — 기록만)
 */
export function setInventory(vcenterId, slice, agent, generatedAt, { verified = false, ip = '' } = {}) {
  const now = Date.now();
  const prev = cache[vcenterId];
  const st = slice?.vcenter?.status;
  // 결정 A6: 읽기 오류 창 동안 소유가 빈 vCenter 를 이 push 가 잡는다 — 기록만 한다(받는 동작은 그대로 · 목록 보존 갈래도 소유를 채운다).
  const claimed = readBlocked && !String(prev?.agent || '') && !!agent;
  if (prev && UNREAD.has(st) && !hasRows(slice?.hosts) && !hasRows(slice?.vms)
    && (hasRows(prev.data?.hosts) || hasRows(prev.data?.vms)) && now - (Number(prev.at) || 0) <= HOLD_MS) {
    const pv0 = prev.data?.vcenter && typeof prev.data.vcenter === 'object' ? prev.data.vcenter : {};
    const { maintenance: _prevMaint, ...pv } = pv0;   // 점검중 표시는 이번 상태로만 정한다(해제 뒤 남지 않게)
    cache[vcenterId] = {
      ...prev, agent: agent || prev.agent || '', pushAt: now, heldSince: prev.heldSince || now,
      data: { ...prev.data, vcenter: { ...pv, status: st, ...(st === 'maintenance' ? { maintenance: true } : {}), ...(typeof slice.vcenter.error === 'string' ? { error: slice.vcenter.error.slice(0, 500) } : {}), held: true } },
    };
    if (claimed) noteUnreadWindowClaim(vcenterId, agent, { verified, ip });
    persistSoon();
    return { held: true, ...(claimed ? { claimedWhileUnread: true } : {}) };
  }
  cache[vcenterId] = { at: now, pushAt: now, agent: agent || '', generatedAt: generatedAt || null, data: slice };
  if (claimed) noteUnreadWindowClaim(vcenterId, agent, { verified, ip });
  persistSoon();
  return { held: false, ...(claimed ? { claimedWhileUnread: true } : {}) };
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
