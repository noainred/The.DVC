/**
 * partfault/scan.js — 이 노드가 가진 스냅샷 전체를 훑어 **파트 상태를 판정**한다(v2.548).
 *
 * ⚠ **이 모듈은 장비에 접속하지 않는다.** 이미 수집된 스냅샷·인벤토리만 읽는다 —
 * 파트 장애를 보려고 965대에 새로 SSH/Redfish 를 여는 것이 곧 운영 사고다
 * (`sanswitch/healthCheck.js` 가 "전체 점검이 28대에 동시 SSH 를 열면 그게 운영 사고다" 라고
 *  적어 둔 것과 같은 판단). 최신 데이터가 필요하면 각 수집기의 '지금 수집' 을 먼저 누른다.
 *
 * ── 판정 지점은 **전 장비군 엣지**다(사용자 선택, v2.548) ─────────────────────────
 * 조사(v2.548)는 스토리지·SAN 을 중앙 판정으로 권했지만(엣지 스냅샷이 이미 중앙에 온전히 온다)
 * 사용자가 "전부 엣지에서" 를 골랐다. 그래서 이 파일은 엣지에서 iDRAC·스토리지·SAN 을 전부
 * 판정하고, 중앙은 **자기 직접 수집 장비만** 판정한다(`devicesForThisNode()` — 위임 장비는 엣지 몫).
 * 중앙이 위임 장비를 다시 판정하면 같은 부품이 두 번 열린다 — 하지 말 것.
 * ⚠ 그 대가: 판정 규칙을 고치면 **전 엣지 업그레이드**가 필요하고 구버전 엣지 법인은 화면이 빈다.
 *   화면이 그 사실을 버전 단위로 밝힌다(`central/partFaultEdge.js` + `routes/api/partFaults.js`).
 *
 * ── 장비 단위 결과(`devices[]`)가 1급이다(v2.548 F1·F6) ─────────────────────────────
 * v2.547 은 평면 `parts[]` 와 `deviceOk` 만 냈다. 이제 장비마다 `{ ok, reason, failedKinds, parts }`
 * 를 내고, push 는 이것을 **'장애 + 판정한 전체 요약'** 으로 보낸다(프로토콜 2). 컬렉션이 실패한
 * 종류(`failedKinds`)는 파트를 만들지 않고 전이가 그 종류의 열린 장애를 **보류**한다 — 빈 배열을
 * '부품 0개 = 정상' 으로 읽던 결함이 여기서 막힌다.
 *
 * ⚠ **`deviceOk`·`kindFailed` 의 키는 `agent|deviceId`** 다(F2). iDRAC id 는 IP 라 법인 간에 겹칠 수
 *   있어 deviceId 만으로 맵을 만들면 한 법인의 성공이 다른 법인의 실패를 덮는다.
 *
 * ⚠ **PDU 는 범위 밖**(types.js SCOPES_OUT_OF_RANGE) — 스냅샷에 부품 상태 필드가 없다.
 */

import { summarize, isBad, PART_STATE, COLLECTION_KINDS } from './types.js';
import { extractIdracParts } from './extract/idrac.js';
import { extractStorageParts } from './extract/storage.js';

const t = (v) => String(v ?? '').trim();
export const devKeyOf = (agent, deviceId) => `${t(agent)}|${t(deviceId)}`;

/**
 * @param {object} deps 주입(테스트 가능하게) — 실제 배선은 `runScan()` 이 한다.
 * @returns {{devices:Array, parts:Array, open:Array, scanned:object, deviceOk:Record<string,boolean>, kindFailed:Record<string,string[]>}}
 */
export function scanFrom({
  idracServers = [], invOf = () => null, invFresh = () => true,
  storageDevices = [], storageSnapOf = () => null,
  sanDevices = [], sanSnapOf = () => null, extractSan = null,
  agent = '',
} = {}) {
  const devices = [];
  const deviceOk = {};
  const kindFailed = {};
  const scanned = {
    at: Date.now(), agent: t(agent),
    idrac: { devices: 0, ok: 0, failed: 0, stale: 0, unreachable: 0, legacy: 0, partial: 0, parts: 0, capped: 0 },
    storage: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {} },
    sanswitch: { devices: 0, ok: 0, failed: 0, parts: 0, notCollected: {}, notJudged: 0, extractor: !!extractSan },
  };
  const put = (d) => {
    devices.push(d);
    const k = devKeyOf(d.agent, d.deviceId);
    deviceOk[k] = !!d.ok;
    if (d.failedKinds?.length) kindFailed[k] = [...d.failedKinds];
  };

  // ── 물리 서버(iDRAC) ────────────────────────────────────────────────────────
  for (const s of idracServers) {
    const id = t(s?.id);
    if (!id) continue;
    scanned.idrac.devices += 1;
    const inv = invOf(id);
    const base = { scope: 'idrac', deviceId: id, deviceName: t(s.name) || t(s.host) || id, agent: t(s.agent) || t(agent) };
    if (!inv) { scanned.idrac.failed += 1; put({ ...base, ok: false, reason: 'no-inventory', failedKinds: Object.values(COLLECTION_KINDS), parts: [] }); continue; }
    /*
     * ⚠ 낡은 인벤토리는 판정에 쓰지 않는다 — 죽은 서버의 마지막 값으로 '정상' 을 매 주기 다시 쓰면
     *   그 사이 고장난 부품을 영원히 못 본다(v2.387 온도 계열과 같은 이유).
     */
    if (!invFresh(id)) { scanned.idrac.failed += 1; scanned.idrac.stale += 1; put({ ...base, ok: false, reason: 'stale', failedKinds: Object.values(COLLECTION_KINDS), parts: [] }); continue; }
    const r = extractIdracParts({ ...s, agent: base.agent }, inv);
    if (!r.reachable) {
      // v2.548 F1 — 빈 인벤토리는 '부품 0개' 가 아니라 '닿지 못함' 이다.
      scanned.idrac.failed += 1; scanned.idrac.unreachable += 1;
      put({ ...base, deviceKey: r.deviceKey, deviceKeyKind: r.deviceKeyKind, ok: false, reason: r.legacy ? 'legacy-empty' : 'unreachable', failedKinds: r.failedKinds, parts: [] });
      continue;
    }
    if (r.keyUnstable) {
      // v2.548 리뷰 C3 — Systems 만 실패해 장비 키가 낮아질 주기: 파트를 내지 않고 장비 실패로 보류한다(IP 키 중복 행 방지).
      scanned.idrac.failed += 1; scanned.idrac.keyUnstable = (scanned.idrac.keyUnstable || 0) + 1;
      put({ ...base, deviceKey: r.deviceKey, deviceKeyKind: r.deviceKeyKind, ok: false, reason: 'system-failed', failedKinds: r.failedKinds, parts: [] });
      continue;
    }
    scanned.idrac.ok += 1;
    if (r.legacy) scanned.idrac.legacy += 1;
    if (r.failedKinds.length) scanned.idrac.partial += 1;
    if (r.capped) scanned.idrac.capped += 1;
    scanned.idrac.parts += r.parts.length;
    put({ ...base, deviceKey: r.deviceKey, deviceKeyKind: r.deviceKeyKind, ok: true, reason: '', failedKinds: r.failedKinds, capped: r.capped, legacy: r.legacy, parts: r.parts });
  }

  // ── 스토리지 ────────────────────────────────────────────────────────────────
  for (const d of storageDevices) {
    const id = t(d?.id);
    if (!id) continue;
    scanned.storage.devices += 1;
    const snap = storageSnapOf(id);
    const base = { scope: 'storage', deviceId: id, deviceName: t(snap?.name) || t(d.name) || t(d.host) || id, agent: t(d.agent) || t(agent), deviceKey: id, deviceKeyKind: 'centralId' };
    // ⚠ `snap.ok` 는 '용량을 읽었다' 가 아니다(v2.531) — 여기서는 '스냅샷이 있고 수집이 성공으로
    //   표시됐는가' 만 본다. 파트 판정 자체는 원소 배열이 하므로 그것으로 충분하다.
    const ok = !!snap && snap.ok !== false;
    if (!ok) { scanned.storage.failed += 1; put({ ...base, ok: false, reason: snap ? 'collect-failed' : 'no-snapshot', failedKinds: [], parts: [] }); continue; }
    scanned.storage.ok += 1;
    const r = extractStorageParts({ ...d, agent: base.agent }, snap);
    scanned.storage.parts += r.parts.length;
    for (const k of r.notCollected || []) scanned.storage.notCollected[k] = (scanned.storage.notCollected[k] || 0) + 1;
    put({ ...base, ok: true, reason: '', failedKinds: [], notCollected: r.notCollected || [], parts: r.parts });
  }

  // ── SAN 스위치(v2.548 F9) ─────────────────────────────────────────────────────
  for (const d of sanDevices) {
    const id = t(d?.id);
    if (!id) continue;
    scanned.sanswitch.devices += 1;
    const snap = sanSnapOf(id);
    const base = { scope: 'sanswitch', deviceId: id, deviceName: t(snap?.name) || t(d.name) || t(d.host) || id, agent: t(d.agent) || t(agent), deviceKey: id, deviceKeyKind: 'centralId' };
    const ok = !!snap && snap.ok !== false;
    if (!ok || !extractSan) {
      scanned.sanswitch.failed += 1;
      put({ ...base, ok: false, reason: !extractSan ? 'no-extractor' : (snap ? 'collect-failed' : 'no-snapshot'), failedKinds: [], parts: [] });
      continue;
    }
    scanned.sanswitch.ok += 1;
    const r = extractSan({ ...d, agent: base.agent }, snap);
    scanned.sanswitch.parts += r.parts.length;
    scanned.sanswitch.notJudged += Number(r.notJudged?.ports) || 0;
    for (const k of r.notCollected || []) scanned.sanswitch.notCollected[k] = (scanned.sanswitch.notCollected[k] || 0) + 1;
    put({ ...base, ok: true, reason: '', failedKinds: [], notCollected: r.notCollected || [], notJudged: r.notJudged || null, parts: r.parts });
  }

  const parts = devices.flatMap((d) => d.parts);
  scanned.summary = summarize(parts);
  scanned.devicesFailed = devices.filter((d) => !d.ok).length;
  const open = parts.filter((p) => isBad(p.state));
  void PART_STATE;
  return { devices, parts, open, scanned, deviceOk, kindFailed };
}

/**
 * 이 노드의 실제 소스를 물려 스캔한다. 엣지·중앙 모두 이 함수를 쓴다.
 *
 * ⚠ **위임 장비는 중앙의 스캔에 들어오지 않는다.** 중앙 `loadRegistry()` 에는 위임 법인 서버가 없고
 * (v2.493: 엣지가 export 로 최신 스냅샷만 올리는데 그 `compactInv` 는 부품 health·serial 을 **전부
 * 뺀다** — collector/agent.js:47-57. 즉 중앙은 판정할 데이터 자체가 없다), `devicesForThisNode()` 도
 * agent 없는 스토리지·SAN 만 준다. 그래서 위임 장비의 파트 상태는 **그 엣지가 v2.548 이상일 때만**
 * 중앙에 보이고, 그 전까지 화면은 '장애 없음' 이 아니라 **'구버전 엣지 N곳'** 이라고 말한다.
 */
export async function runScan() {
  const [{ loadRegistry }, { getInventory, inventoryStale }, cfg, stReg, stStore, swReg, swStore] = await Promise.all([
    import('../idrac/registry.js'),
    import('../idrac/invCache.js'),
    import('../config.js'),
    import('../storage/registry.js'),
    import('../storage/store.js'),
    import('../sanswitch/registry.js'),
    import('../sanswitch/store.js'),
  ]);
  // SAN 추출기는 v2.548 에 추가됐다 — 없으면(부분 배포) 'no-extractor' 로 밝히고 멈추지 않는다.
  let extractSan = null;
  try { ({ extractSanSwitchParts: extractSan } = await import('./extract/sanswitch.js')); } catch { extractSan = null; }
  // 인벤토리 신선도 기준 — iDRAC 인벤토리는 30분 주기라(poller.js) 그 두 배까지는 유효로 본다.
  const MAX_AGE = Math.max(60_000, Number(process.env.PARTFAULT_INV_MAX_AGE_MS) || 90 * 60_000);
  const servers = (() => { try { return loadRegistry(); } catch { return []; } })();
  const snaps = new Map();
  try { for (const s of stStore.localSnapshots()) snaps.set(s.deviceId, s); } catch { /* 스냅샷 없음 */ }
  const swSnaps = new Map();
  try { for (const s of swStore.localSnapshots()) swSnaps.set(s.deviceId, s); } catch { /* 스냅샷 없음 */ }
  const devices = (() => { try { return stReg.devicesForThisNode(); } catch { return []; } })();
  const switches = (() => { try { return swReg.devicesForThisNode(); } catch { return []; } })();
  const isEdge = !!cfg.config.agent.centralUrl;
  return scanFrom({
    idracServers: servers.filter((s) => t(s?.type) !== 'ome'),   // 관리 콘솔 등록은 물리 서버가 아니다
    invOf: (id) => { try { return getInventory(id); } catch { return null; } },
    invFresh: (id) => { try { return !inventoryStale(id, MAX_AGE); } catch { return false; } },
    storageDevices: devices,
    storageSnapOf: (id) => snaps.get(id) || null,
    sanDevices: switches,
    sanSnapOf: (id) => swSnaps.get(id) || null,
    extractSan,
    agent: isEdge ? cfg.config.agent.name : '',
  });
}
