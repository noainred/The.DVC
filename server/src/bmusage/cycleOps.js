/**
 * bmusage/cycleOps.js — 주기 수집 한 바퀴의 **점검 소모품 판정 · 변경 이벤트 전이**(v2.929 예정 · 5단계). 폴러가 적재 전에 부른다.
 *
 *  · 소모품: 이 노드 기준값(perfRules.health)으로 health.js judgeHealth → 행의 detail_json 에 `health`(칸 code · 값 · since)를 넣는다 — 엣지 봉투 · 주 조회 ·
 *    서버 상세가 같은 칸을 읽는다(중앙은 다시 판정하지 않는다). since(처음 그 code 가 된 시각)는 change_latest 의 직전 칸에서 이어 간다(함대 표 ‘며칠째’ = 전이 기록).
 *  · 변경: changes.js diffChangeFacts(직전 사실 · 이번 사실) → 전이만 change_event. 펌웨어는 이미 가진 iDRAC 인벤토리 캐시(Redfish 호출 0) ·
 *    CVP 는 수동 매핑 파일(portMap.js — 후보 매칭은 무겁고 매 주기 바뀔 수 있어 넣지 않았다: 정직 기록).
 *  · 쓰기는 한 트랜잭션(changeWriteBatch) — 서버 수만큼 문장을 따로 커밋하지 않는다(이벤트 루프 블로킹 규약).
 *  · 실패해도 수집은 실패가 아니다 — 사유를 돌려주고 폴러가 _last 에 싣는다(조용한 생략 금지).
 */
import { jsonCol } from './usage.js';
import { parseJsonCol } from './perfView.js';
import { judgeHealth, certForServer } from './health.js';
import { diffChangeFacts, healthSince, firmwareFactsOf, cvpFactsOf } from './changes.js';

/** 인증서 원천(svcmon) — 한 바퀴에 한 번. 못 읽으면 null(그 칸은 ‘못 읽음’). */
export async function certSource() {
  try {
    const [{ listTargets }, { getResults }, { certDaysOf }] = await Promise.all([import('../svcmon/store.js'), import('../svcmon/poller.js'), import('../svcmon/dash.js')]);
    return { targets: listTargets(), results: getResults(), certDaysOf };
  } catch { return null; }
}

/**
 * @param {Array<{target, built}>} okResults  이번 주기 성공 결과(built.row · built.changeFacts)
 * @param {{agent:string, rules:object, now:number, deps?:object}} o
 * @returns {Promise<{items:Array, health:number, events:number, error?:string}>}  items 는 changeWriteBatch 입력
 */
export async function prepareCycleOps(okResults = [], { agent = '', rules = {}, now = Date.now(), deps = {} } = {}) {
  const D = {
    latestAll: async (a) => (await import('./opsDb.js')).changeLatestAll({ agent: a }),
    inventoryOf: async (id) => (await import('../idrac/invCache.js')).getInventory(id),
    portMapOf: async (a, k) => (await import('./portMap.js')).listPortMap({ agent: a, key: k }),
    portMapError: async () => (await import('./portMap.js')).portMapLoadError(),
    certSource,
    ...deps,
  };
  let latest = null;
  try { latest = await D.latestAll(agent); } catch (e) { return { items: [], health: 0, events: 0, error: `변경 사실 최신값을 읽지 못했습니다: ${String(e?.message || e).slice(0, 160)}` }; }
  if (!latest) return { items: [], health: 0, events: 0, error: '보관 DB 를 열 수 없어 소모품 · 변경 이벤트를 건너뛰었습니다.' };
  const cert = await D.certSource().catch(() => null);
  const pmErr = await D.portMapError().catch(() => null);
  const items = []; let health = 0; let events = 0;
  for (const r of okResults) {
    const tg = r?.target; const row = r?.built?.row;
    if (!tg?.key || !row) continue;
    const prev = latest.get(tg.key)?.facts || null;
    // ── 소모품(리눅스 성능 상세가 있는 행만) ──
    let healthMap = null;
    const detail = parseJsonCol(row.detail_json);
    if (detail && detail.osKind === 'linux' && detail.hfacts) {
      const tuning = parseJsonCol(row.tuning_json);
      const c = cert ? certForServer(tg, cert) : { error: true };
      // needs-restarting 은 하루 몇 번 · 바뀔 때만 실행한다(반증 L1 — parse/linuxHealth.js) — 건너뛴 주기는 직전에 읽은 값을 이어 쓴다(지어내지 않는다: 직전 값이 없으면 확인 불가).
      if (detail.hfacts.needsRestart == null && detail.hfacts.nrSkipped && typeof prev?.needsRestart === 'boolean') detail.hfacts = { ...detail.hfacts, needsRestart: prev.needsRestart, nrCarried: true };
      const h = judgeHealth({ hfacts: detail.hfacts, tuning, row, cert: c, th: rules.health, now });
      healthMap = healthSince(prev?.health || null, h.cells, now);
      h.since = Object.fromEntries(Object.entries(healthMap).map(([k, v]) => [k, v.since]));
      detail.health = h;
      row.detail_json = jsonCol(detail);
      health += 1;
    }
    // ── 변경 사실(전이만) ──
    let fw = null;
    try { fw = tg.idrac?.regId ? firmwareFactsOf(await D.inventoryOf(tg.idrac.regId)) : null; } catch { fw = null; }
    let cvp = null;
    if (!pmErr) { try { cvp = cvpFactsOf(await D.portMapOf(agent, tg.key)); } catch { cvp = null; } }
    const d = diffChangeFacts(prev, { os: r.built.changeFacts || null, fw, cvp, health: healthMap }, { now });
    events += d.events.length;
    items.push({ key: tg.key, at: now, facts: d.facts, events: d.events });
  }
  return { items, health, events };
}
