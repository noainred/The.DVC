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
export function serversByCorp(servers = [], hosts = []) {
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
    matchedBy: { explicit: 0, hostName: 0, serviceTag: 0, none: 0 },
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

    if (vc) bump(out.byVcenter, vc); else { out.unassigned += 1; out.matchedBy.none += 1; }

    if (hostHit) {
      out.matchedCount += 1;
      // 중복은 **호스트가 속한 vCenter** 기준으로 센다(그 호스트가 그 법인에서 세어지므로).
      bump(out.byVcenterMatched, hostHit);
    } else {
      out.physicalOnly += 1;
      if (vc) bump(out.byVcenterPhysicalOnly, vc); else out.physicalOnlyUnassigned += 1;
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
