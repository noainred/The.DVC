/**
 * idrac/serverByCorp.js — **법인별 물리 서버 수** 집계(v2.526, 순수 모듈).
 *
 * 사용자 요청(2026-09-16): "overview 화면에 전체 물리 서버 수량(iDRAC 에서 찾은 수량),
 * 가상화 호스트 수량, 법인별 서버 수량과 guestos 수량 표시해줘".
 *
 * ── 왜 별도 모듈인가 ───────────────────────────────────────────────────────────
 * 전력 귀속(`idrac/service.js allMeasuredPower`)은 같은 신호를 쓰지만 **전력 DB·OME 캐시·원격
 * 수집기까지 읽는 비동기 경로**다. Overview 는 15초 폴링이라 그 경로를 태울 수 없다. 그래서
 * **개수만** 세는 동기 집계를 따로 둔다 — 단, **귀속 신호의 순서는 같게** 한다(명시 지정 →
 * 호스트명 → 서비스태그). 순서가 다르면 같은 서버가 전력 화면과 다른 법인에 잡힌다.
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
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
 *   matchedBy:{explicit:number, hostName:number, serviceTag:number, none:number}
 * }}
 */
export function serversByCorp(servers = [], hosts = []) {
  // 호스트 이름·서비스태그 → vCenter id 색인(한 번만 만든다 — 서버마다 전체 순회하면 O(N×M)).
  const byName = new Map();
  const byTag = new Map();
  for (const h of hosts || []) {
    const vc = String(h?.vcenterId || '');
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
  };
  const bump = (obj, key) => { if (key) obj[key] = (obj[key] || 0) + 1; };

  for (const s of servers || []) {
    if (!s || s.type === 'ome') continue;      // 규칙 2 — OME 는 물리 서버가 아니다
    out.total += 1;
    if (s.enabled === false) out.disabled += 1;

    // 귀속 신호 순서는 전력 귀속과 **같다**(머리말).
    let vc = String(s.vcenterId || '').trim();
    if (vc) out.matchedBy.explicit += 1;
    if (!vc) {
      const names = [s.name, s.host, ...(Array.isArray(s.hostNames) ? s.hostNames : [])];
      for (const n of names) {
        const k = norm(n);
        const hit = byName.get(k) || byName.get(shortOf(k));
        if (hit) { vc = hit; out.matchedBy.hostName += 1; break; }
      }
    }
    if (!vc) {
      const t = norm(s.serviceTag);
      const hit = t && byTag.get(t);
      if (hit) { vc = hit; out.matchedBy.serviceTag += 1; }
    }
    if (vc) bump(out.byVcenter, vc); else { out.unassigned += 1; out.matchedBy.none += 1; }

    // 법인(DataCenter)은 별도 축이다 — vCenter 귀속과 독립적으로 센다(둘을 합치지 않는다).
    bump(out.byDatacenter, String(s.datacenterId || '').trim());
  }
  return out;
}
