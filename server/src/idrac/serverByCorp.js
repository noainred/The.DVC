/**
 * idrac/serverByCorp.js — **법인별 서버 수량** 집계(v2.526, 순수 모듈. v2.527 에 중복 제거 추가).
 *
 * 사용자 요청(2026-09-16): "overview 화면에 전체 물리 서버 수량(iDRAC 에서 찾은 수량),
 * 가상화 호스트 수량, 법인별 서버 수량과 guestos 수량 표시해줘" →
 * (v2.527) "서버의 합/물리서버/가상화 호스트 이렇게 구분해서 전체 서버의 수량을 볼 수 있게".
 *
 * ── 왜 별도 모듈인가 ───────────────────────────────────────────────────────────
 * 전력 귀속(`idrac/service.js allMeasuredPower`)은 같은 신호를 쓰지만 **전력 DB·OME 캐시·원격
 * 수집기까지 읽는 비동기 경로**다. Overview 는 15초 폴링이라 그 경로를 태울 수 없다. 그래서
 * **개수만** 세는 동기 집계를 따로 둔다 — 단, **귀속 신호의 순서는 같게** 한다(명시 지정 →
 * 호스트명 → 서비스태그). 순서가 다르면 같은 서버가 전력 화면과 다른 법인에 잡힌다.
 *
 * ── ★ v2.527 — '서버의 합' 은 **중복을 제거한 실제 대수**다 ────────────────────
 * 이 현장에서 **iDRAC 에 등록된 물리 서버 대부분이 곧 ESXi 호스트**다(사용자 화면 실측:
 * SN 27/27 · HB 32/32 · AS 20/20 · GM2 30/30 · HM 38/38 …). 그래서 `물리 서버 + 가상화 호스트`
 * 를 그냥 더하면 **같은 장비를 두 번 센다**. 사용자 선택은 '중복 제거한 실제 대수' 다.
 *
 *   합계(union) = 가상화 호스트 전체 + **가상화 호스트로 확인되지 않은** 물리 서버(`physicalOnly`)
 *
 * 세 수가 서로 겹치지 않으므로 `합 = 물리 전용 + 가상화 호스트` 가 항상 성립한다.
 *
 * ⚠ **정직성 한계 — 반드시 화면이 밝힐 것**: 중복 판정은 **이름·서비스태그 일치**로만 한다.
 *   iDRAC 쪽 이름이 ESXi 호스트명과 다르고 서비스태그도 비어 있으면 **같은 장비인데 중복을
 *   못 걸러** 합계가 실제보다 커진다. 그래서 `matchedCount`(확인된 중복)를 함께 내보내
 *   화면이 근거를 보이게 한다. '중복 0건' 을 '중복이 없다' 로 읽지 말 것 — '못 찾았다' 일 수 있다.
 *
 * ── 그 밖의 정직성 규칙 ────────────────────────────────────────────────────────
 * 1. **귀속되지 않은 서버를 아무 법인에나 넣지 않는다.** `unassigned` 로 따로 센다 —
 *    합계가 법인별 합보다 큰 이유를 화면이 말할 수 있어야 한다.
 * 2. **OME 항목은 물리 서버가 아니다**(`type === 'ome'` 는 관리 콘솔 등록이다) — 제외한다.
 *    `idrac/physicalCapacity.js` 를 쓰는 `/overview` 의 `physical.servers` 와 같은 기준이다.
 * 3. **비활성(enabled:false) 서버도 센다** — 등록돼 있고 물리적으로 존재하기 때문이다.
 *    다만 개수를 따로 밝혀(`disabled`) 화면이 구분할 수 있게 한다.
 *
 * ── ★ v2.583 — '물리 전용' 이 법인별 표에서 전부 0 이던 결함 ─────────────────────
 * 사용자 신고(스크린샷): "서버 합계에 물리서버 수량 안나오는거 수정해줘". 실측 화면은
 * `물리 전용 503` 인데 **법인별 표의 물리 전용 열이 전 행 0** 이었고, 503대가 전부 '법인 미귀속'
 * 이었다. 원인: 귀속 신호가 ① 등록부 `vcenterId` ② ESXi 호스트 이름 ③ 서비스태그 셋뿐인데,
 * **물리 전용 서버는 정의상 ESXi 호스트가 아니라 ②③ 이 절대 맞지 않는다**. 그러면 ① 이 비어 있는
 * 서버(엣지가 스캔으로 등록한 베어메탈 — 엣지 등록부에 vCenter 가 없다)는 전부 미귀속이 된다.
 * 그런데 포탈은 이미 두 가지를 알고 있었다:
 *   ④ 관리자가 특수 기능 › 통합 서버 인벤토리(베어메탈 행의 '법인(vCenter)')에서 지정한 귀속(`fleet-assign.json` — 서비스태그/서버 id → vCenter)
 *   ⑤ 서버의 **법인(DataCenter)** — 스캔 등록분은 직접, 원격은 보고한 수집기의 법인
 *      (`analysisServers.remoteServersResolved`). DataCenter ↔ vCenter 할당(`datacenters.json`)에서
 *      **그 법인의 vCenter 가 정확히 하나면** 그 vCenter 행이 곧 그 법인이다.
 * ④⑤ 는 ①②③ **뒤에만** 본다 — 기존에 귀속되던 서버의 귀속은 바뀌지 않는다(전력 화면과 어긋나지 않게).
 * ⑤ 에서 법인의 vCenter 가 **둘 이상이거나 없으면 추측하지 않는다** — 어느 vCenter 행에 넣을지
 * 근거가 없다. 그 서버는 `unplacedByDatacenter`(법인별 개수)로 따로 내보내 화면이 '법인 · vCenter 미지정'
 * 행으로 보인다. 법인조차 모르는 것만 `physicalOnlyNoDatacenter` 다. 합계 항등식은 그대로다.
 */

const norm = (s) => String(s || '').trim().toLowerCase();

/** 호스트 이름의 짧은 형태(FQDN 앞부분) — vCenter 는 짧은 이름, iDRAC 은 FQDN 인 경우가 흔하다. */
const shortOf = (s) => norm(s).split('.')[0];

/**
 * @param {object[]} servers  iDRAC 레지스트리 항목(비밀 제외 가능)
 * @param {object[]} hosts    인벤토리 스냅샷의 ESXi 호스트(`{name, vcenterId, serviceTag}`)
 * @returns {{
 *   total:number, disabled:number, unassigned:number,
 *   byVcenter:Record<string,number>, byDatacenter:Record<string,number>,
 *   matchedBy:{explicit:number, hostName:number, serviceTag:number, none:number},
 *   hostsTotal:number, matchedCount:number, physicalOnly:number, union:number,
 *   physicalOnlyUnassigned:number,
 *   byVcenterPhysicalOnly:Record<string,number>,
 *   byVcenterMatched:Record<string,number>,
 *   byVcenterHosts:Record<string,number>,
 *   byVcenterUnion:Record<string,number>
 * }}
 */
export function serversByCorp(servers = [], hosts = [], opts = {}) {
  // v2.583 보조 귀속 재료(선택 — 없으면 예전과 같다).
  const fleetAssign = opts && typeof opts.fleetAssign === 'object' && opts.fleetAssign ? opts.fleetAssign : {};
  const dcVcenters = opts?.dcVcenters instanceof Map ? opts.dcVcenters : new Map();
  const knownVc = opts?.knownVcenters instanceof Set ? opts.knownVcenters : null;
  const isKnown = (id) => !!id && (!knownVc || knownVc.has(id));
  // v2.591 C4: 서버별 귀속 결과를 호출부가 받을 수 있게 한다(범위 계정의 물리 용량 재집계용).
  //   귀속 판정을 호출부가 다시 구현하면 두 판정이 갈라진다 — 판정은 여기 하나다.
  const onAttributed = typeof opts?.onAttributed === 'function' ? opts.onAttributed : null;
  // 호스트 이름·서비스태그 → vCenter id 색인(한 번만 만든다 — 서버마다 전체 순회하면 O(N×M)).
  const byName = new Map();
  const byTag = new Map();
  const byVcenterHosts = {};
  let hostsTotal = 0;
  for (const h of hosts || []) {
    hostsTotal += 1;
    const vc = String(h?.vcenterId || '');
    if (vc) byVcenterHosts[vc] = (byVcenterHosts[vc] || 0) + 1;
    if (!vc) continue;
    const n = norm(h?.name);
    if (n) { byName.set(n, vc); byName.set(shortOf(n), vc); }
    const t = norm(h?.serviceTag);
    if (t) byTag.set(t, vc);
  }

  const out = {
    total: 0, disabled: 0, unassigned: 0,
    byVcenter: {}, byDatacenter: {},
    matchedBy: { explicit: 0, hostName: 0, serviceTag: 0, assigned: 0, datacenter: 0, none: 0 },
    // v2.527 — 중복 제거 합계의 재료
    hostsTotal,
    matchedCount: 0,            // ESXi 호스트와 **같은 장비로 확인된** iDRAC 등록 서버 수
    physicalOnly: 0,            // 가상화 호스트로 확인되지 않은 물리 서버(전 법인 + 미귀속)
    physicalOnlyUnassigned: 0,  // 그중 법인 귀속조차 없는 것
    union: 0,
    byVcenterPhysicalOnly: {},
    byVcenterMatched: {},
    byVcenterHosts,
    byVcenterUnion: {},
    // v2.583 — 법인은 알지만 vCenter 행을 정할 수 없는 물리 전용 서버(법인 id → 대수)와 법인도 모르는 것
    unplacedByDatacenter: {},
    physicalOnlyNoDatacenter: 0,
  };
  const bump = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };

  for (const s of servers || []) {
    if (!s || s.type === 'ome') continue;      // 규칙 2 — OME 는 물리 서버가 아니다
    out.total += 1;
    if (s.enabled === false) out.disabled += 1;

    // ── ① ESXi 호스트와 같은 장비인가(중복 판정) ──
    // 귀속(`vcenterId`)과 **독립적으로** 본다. 명시 지정된 서버도 그 실체가 ESXi 호스트일 수
    // 있으므로, 명시 지정을 만나면 이름·태그 조회를 건너뛰던 방식으로는 중복을 못 찾는다.
    const names = [s.name, s.host, ...(Array.isArray(s.hostNames) ? s.hostNames : [])];
    let hostHit = '';
    for (const n of names) {
      const k = norm(n);
      const hit = byName.get(k) || byName.get(shortOf(k));
      if (hit) { hostHit = hit; break; }
    }
    if (!hostHit) {
      const t = norm(s.serviceTag);
      const hit = t && byTag.get(t);
      if (hit) hostHit = hit;
    }

    // ── ② 법인 귀속(신호 순서는 전력 귀속과 같다: 명시 → 호스트명 → 서비스태그) ──
    let vc = String(s.vcenterId || '').trim();
    // v2.589: 삭제된 vCenter 를 가리키는 명시 지정은 귀속이 아니다 — 그대로 두면 어느 표 행에도 없는
    //   키로 세어 'KPI 합계 = 표 합계' 가 깨졌다(지정·DataCenter 단계는 이미 isKnown 으로 거른다).
    if (vc && !isKnown(vc)) { vc = ''; out.matchedBy.explicitStale = (out.matchedBy.explicitStale || 0) + 1; }
    if (vc) out.matchedBy.explicit += 1;
    if (!vc && hostHit) {
      // 이름으로 찾았는지 태그로 찾았는지는 위 루프가 이미 결정했다 — 어느 쪽이었는지만 센다.
      const byNameHit = names.some((n) => {
        const k = norm(n);
        return !!(byName.get(k) || byName.get(shortOf(k)));
      });
      vc = hostHit;
      if (byNameHit) out.matchedBy.hostName += 1; else out.matchedBy.serviceTag += 1;
    }

    // ── ④ 관리자 지정 귀속(특수 기능 › 통합 서버 인벤토리) — 서비스태그 → 서버 id 순 ──
    if (!vc) {
      const a = String(fleetAssign[norm(s.serviceTag)] || fleetAssign[norm(s.id)] || '').trim();
      if (isKnown(a)) { vc = a; out.matchedBy.assigned += 1; }
    }
    // ── ⑤ 법인(DataCenter)의 vCenter 가 하나뿐이면 그 vCenter ──
    const dcId = String(s.datacenterId || '').trim();
    let dcAmbiguous = false;
    if (!vc && dcId) {
      const list = (dcVcenters.get(norm(dcId)) || []).filter(isKnown);
      if (list.length === 1) { vc = list[0]; out.matchedBy.datacenter += 1; } else dcAmbiguous = true;
    }

    if (vc) bump(out.byVcenter, vc); else { out.unassigned += 1; out.matchedBy.none += 1; }
    if (onAttributed) onAttributed(s, vc);

    if (hostHit) {
      out.matchedCount += 1;
      // 중복은 **호스트가 속한 vCenter** 기준으로 센다(그 호스트가 그 법인에서 세어지므로).
      bump(out.byVcenterMatched, hostHit);
    } else {
      out.physicalOnly += 1;
      if (vc) bump(out.byVcenterPhysicalOnly, vc);
      else {
        out.physicalOnlyUnassigned += 1;
        if (dcAmbiguous) bump(out.unplacedByDatacenter, dcId); else out.physicalOnlyNoDatacenter += 1;
      }
    }

    // 법인(DataCenter)은 별도 축이다 — vCenter 귀속과 독립적으로 센다(둘을 합치지 않는다).
    bump(out.byDatacenter, String(s.datacenterId || '').trim());
  }

  // ── ③ 합계 — 세 수가 겹치지 않으므로 그냥 더한다 ──
  out.union = hostsTotal + out.physicalOnly;
  for (const vc of new Set([...Object.keys(byVcenterHosts), ...Object.keys(out.byVcenterPhysicalOnly)])) {
    out.byVcenterUnion[vc] = (byVcenterHosts[vc] || 0) + (out.byVcenterPhysicalOnly[vc] || 0);
  }
  return out;
}
