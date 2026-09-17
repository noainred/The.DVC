/**
 * partfault/scan.js — 이 노드가 가진 스냅샷 전체를 훑어 **파트 상태를 판정**한다(v2.547).
 *
 * ⚠ **이 모듈은 장비에 접속하지 않는다.** 이미 수집된 스냅샷·인벤토리만 읽는다 —
 * 파트 장애를 보려고 965대에 새로 SSH/Redfish 를 여는 것이 곧 운영 사고다
 * (`sanswitch/healthCheck.js` 가 "전체 점검이 28대에 동시 SSH 를 열면 그게 운영 사고다" 라고
 *  적어 둔 것과 같은 판단). 최신 데이터가 필요하면 각 수집기의 '지금 수집' 을 먼저 누른다.
 *
 * ── 엣지/중앙 어디서나 같은 코드가 돈다 ────────────────────────────────────────
 * 사용자 지시(2026-09-17): "엣지에서 수집해서 **로컬에서 처리**하고 **장애만** 중앙으로 보내라".
 * 그래서 추출·판정은 **이 파일이 양쪽에서 똑같이** 수행하고, 엣지는 결과(열린 장애 + 요약)만
 * 올린다. 전이·DB·알림은 중앙이 소유한다 —
 *  · 엣지가 전이만 올리면 push 1회 유실로 중앙·엣지 상태가 **영구히 어긋난다**.
 *  · 알림 채널 설정을 법인마다 따로 두지 않아도 된다.
 *
 * ⚠ **`scanned`(요약)를 반드시 함께 낸다.** 장애만 보내면 중앙은 '정상' 과 '수집 안 됨' 을
 *   구분할 수 없다. v2.517 이 SAN 포트 사용량에서 고친 바로 그 결함
 *   (`perfPush.js sendStatusOnly` — "엣지는 표본이 0건이어도 상태를 올린다")이고,
 *   `storage/push.js:30` 에는 **아직 그 결함이 남아 있다**(장비 0대면 POST 자체를 안 한다).
 */

import { summarize, isBad, PART_STATE } from './types.js';
import { extractIdracParts } from './extract/idrac.js';
import { extractStorageParts } from './extract/storage.js';

const t = (v) => String(v ?? '').trim();

/**
 * @param {object} deps 주입(테스트 가능하게) — 실제 배선은 `runScan()` 이 한다.
 * @returns {{parts:Array, open:Array, scanned:object, deviceOk:Record<string,boolean>}}
 */
export function scanFrom({ idracServers = [], invOf = () => null, invFresh = () => true,
  storageDevices = [], storageSnapOf = () => null } = {}) {
  const parts = [];
  const deviceOk = {};
  const scanned = {
    at: Date.now(),
    idrac: { devices: 0, ok: 0, failed: 0, parts: 0, capped: 0 },
    storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} },
  };

  // ── 물리 서버(iDRAC) ────────────────────────────────────────────────────────
  for (const s of idracServers) {
    const id = t(s?.id);
    if (!id) continue;
    scanned.idrac.devices += 1;
    const inv = invOf(id);
    /*
     * ⚠ **인벤토리가 없거나 낡았으면 `deviceOk=false`** — 전이 판정이 이 장비의 열린 장애를
     *   건드리지 않는다. 이걸 true 로 두면 iDRAC 무응답 1회가 **전 파트 '복구'** 로 기록된다.
     */
    const fresh = !!inv && invFresh(id);
    deviceOk[id] = fresh;
    if (!fresh) { scanned.idrac.failed += 1; continue; }
    scanned.idrac.ok += 1;
    const r = extractIdracParts(s, inv);
    if (r.capped) scanned.idrac.capped += 1;
    scanned.idrac.parts += r.parts.length;
    parts.push(...r.parts);
  }

  // ── 스토리지 ────────────────────────────────────────────────────────────────
  for (const d of storageDevices) {
    const id = t(d?.id);
    if (!id) continue;
    scanned.storage.devices += 1;
    const snap = storageSnapOf(id);
    // ⚠ `snap.ok` 는 '용량을 읽었다' 가 아니다(v2.531) — 여기서는 '스냅샷이 있고 수집이
    //   성공으로 표시됐는가' 만 본다. 파트 판정 자체는 원소 배열이 하므로 그것으로 충분하다.
    const ok = !!snap && snap.ok !== false;
    deviceOk[id] = ok;
    if (!ok) { scanned.storage.failed += 1; continue; }
    scanned.storage.ok += 1;
    const r = extractStorageParts(d, snap);
    scanned.storage.parts += r.parts.length;
    for (const k of r.notCollected) scanned.storage.notCollected[k] = (scanned.storage.notCollected[k] || 0) + 1;
    parts.push(...r.parts);
  }

  scanned.summary = summarize(parts);
  // '장애만 중앙으로' — 여기서 거른다. ⚠ `unknown`·`absent` 는 장애가 아니므로 보내지 않고,
  //   **개수는 요약이 전한다**(그래야 중앙이 '정상' 과 '못 읽음' 을 구분할 수 있다).
  const open = parts.filter((p) => isBad(p.state));
  /*
   * ⚠⚠ **`unknown` 인 파트의 키는 따로 보낸다**(값이 아니라 키만 — 파트당 ~40바이트).
   *   왜 필요한가: 엣지는 '지금 열린 장애 전량' 만 보내므로, 열려 있던 장애가 이번에
   *   `unknown` 이 되면 그 파트가 목록에서 **사라진다**. 중앙이 그것을 '목록에 없으니 해소'
   *   로 읽으면 **전이 규칙 ②(`unknown` 은 열지도 닫지도 않는다)가 위임 장비에서만 깨진다** —
   *   상태를 못 읽었을 뿐인데 '정상으로 복귀' 라는 거짓 이력이 남는다.
   *   그래서 키만 실어 보내고 중앙이 그 파트를 **보류**로 처리한다.
   *   상한을 두되 **자른 개수를 밝힌다**(조용한 상한 금지).
   */
  /*
   * 상한을 **작게** 잡는 이유(행 수가 아니라 **파일 크기**를 먼저 계산했다): 이 키 목록은 중앙의
   * `partfault-edge.json` 에 엣지별로 보관되고 **push 마다 맵 전체가 다시 직렬화**된다.
   * 키 1개 ≈ 40바이트 × 1,000개 × 엣지 28곳 ≈ 1.1MB — 여기까지가 감당할 크기다.
   * ⚠ 상한을 넘겨 잘리면 `unknownOmitted` 로 밝히고, 중앙은 **그 엣지에 대해 아무것도 닫지
   *   않는다**(안전한 쪽으로 실패 — `poller.js` 참조). 조용히 자르고 계속 닫으면 그 순간
   *   거짓 '복구' 가 다시 생긴다.
   */
  const UNKNOWN_MAX = Math.max(100, Number(process.env.PARTFAULT_UNKNOWN_MAX) || 1_000);
  const unknownAll = parts.filter((p) => p.state === PART_STATE.unknown);
  const unknownKeys = unknownAll.slice(0, UNKNOWN_MAX).map((p) => p.partKey);
  scanned.unknownOmitted = unknownAll.length - unknownKeys.length;
  return { parts, open, unknownKeys, scanned, deviceOk };
}

/**
 * 이 노드의 실제 소스를 물려 스캔한다. 엣지·중앙 모두 이 함수를 쓴다.
 *
 * ⚠ **정직 기록 — 위임 장비는 이 스캔에 들어오지 않는다.** 중앙의 `loadRegistry()` 에는 위임 법인
 * 서버가 없고(v2.493: 엣지가 export 로 **최신 스냅샷만** 올린다 — `collector/remoteInventory.js`),
 * `devicesForThisNode()` 도 agent 없는 스토리지만 준다. 그래서 위임 장비의 파트 상태는
 * **그 엣지가 v2.547 이상일 때만** 중앙에 보인다. 구버전 엣지는 보고가 없고, 화면은 그것을
 * '장애 없음' 이 아니라 **'보고가 없는 엣지 N곳'** 이라고 말한다(`partFaultText.edgeNote`).
 * ⚠ 중앙이 `remoteInventory` 를 직접 판정하게 만들지 말 것 — 엣지가 push 를 시작하는 순간
 *   같은 부품이 **두 번** 열린다(id 체계가 다르다). 판정은 한 곳에서만 한다.
 */
export async function runScan() {
  const [{ loadRegistry }, { getInventory, inventoryStale }, idracCfg, stReg, stStore] = await Promise.all([
    import('../idrac/registry.js'),
    import('../idrac/invCache.js'),
    import('../config.js'),
    import('../storage/registry.js'),
    import('../storage/store.js'),
  ]);
  // 인벤토리 신선도 기준 — iDRAC 인벤토리는 30분 주기라(poller.js) 그 두 배까지는 유효로 본다.
  const MAX_AGE = Math.max(60_000, Number(process.env.PARTFAULT_INV_MAX_AGE_MS) || 90 * 60_000);
  const servers = (() => { try { return loadRegistry(); } catch { return []; } })();
  const snaps = new Map();
  try { for (const s of stStore.localSnapshots()) snaps.set(s.deviceId, s); } catch { /* 스냅샷 없음 */ }
  const devices = (() => { try { return stReg.devicesForThisNode(); } catch { return []; } })();
  void idracCfg;
  return scanFrom({
    idracServers: servers.filter((s) => t(s?.type) !== 'ome'),   // 관리 콘솔 등록은 물리 서버가 아니다
    invOf: (id) => { try { return getInventory(id); } catch { return null; } },
    invFresh: (id) => { try { return !inventoryStale(id, MAX_AGE); } catch { return false; } },
    storageDevices: devices,
    storageSnapOf: (id) => snaps.get(id) || null,
  });
}
