/**
 * clustercfg/n1.js — 클러스터 N+1 판정(가장 큰 호스트 1대 장애 시 남은 용량으로 지금 사용량을 받을 수 있는가, 순수).
 *   v2.810: '인사이트'(routes/api/toolsAnalytics.js ④)의 판정을 그대로 옮겼다 — 법인별 호스트 보기(vcenter/hostCorp.js)가 같은 함수를 쓴다
 *   (판정 코어는 하나 — 두 화면이 같은 클러스터에 다른 N+1 을 말하지 않게). 규칙·주석은 옮기기 전과 같다.
 * ⚠ store 를 import 하지 않는다 — readable(h)(store.usageReadable)을 호출부가 넘긴다.
 * @returns {{key:string, row:object}[]} key = 클러스터 묶음 키(clusterGroupKeyOf, 독립 호스트는 `${vc}\u0000standalone`), row = 인사이트 응답 한 줄
 */
import { clusterRefMode, clusterGroupKeyOf } from './analyze.js';

const r0 = (n, d = 0) => Number((n || 0).toFixed(d));

export function n1Groups(hosts, usageReadable) {
  // v2.733(점검 3회차 C2-04 — 재현): ① 유지보수(MAINTENANCE) 호스트는 VM 을 받을 수 없다 — 사용률(usageReadable)에는 읽힌 값으로 남기되
  //   '장애 후 잔여 용량' 에서는 뺀다(3대 중 1대 유지보수: 예전 80%·여유 → 실제 160%·위험). 그 호스트가 아직 들고 있는 부하는 남은 호스트가
  //   받아야 하므로 사용량에는 넣는다. vSphere HA 수용 제어도 유지보수 호스트를 용량에 넣지 않는다.
  //   ② 클러스터가 없는 독립 호스트(SOAP 'standalone', REST 폴백은 소속 미상 null)는 서로 장애를 받아 줄 수 없다(HA 없음) — 한 그룹으로
  //   묶어 '여유' 라 말하지 않는다. 그룹 행은 남기되(호스트 수·현재 사용률) N+1 은 판정하지 않는다(n1Ok null · standalone true).
  //   ③ v2.742(감사 VC-05): 클러스터 이름은 데이터센터 안에서만 유일하다 — (vCenter, 이름) 으로 묶으면 다른 데이터센터의 같은 이름
  //   클러스터 호스트가 한 그룹이 되어 N+1 이 엉뚱하게 판정된다. 묶음 키는 clustercfg 의 clusterGroupKeyOf 하나(ref 우선 ·
  //   clusterRef 를 싣지 않는 구버전 엣지 스냅샷 vCenter 는 예전 이름 키).
  const isStandalone = (c) => !c || c === 'standalone';
  const cmode = clusterRefMode(hosts);
  const cmap = new Map();
  for (const h of hosts) {
    const k = clusterGroupKeyOf(h, cmode) ?? `${h.vcenterId}\u0000standalone`;
    const g = cmap.get(k) || { vcenterId: h.vcenterId, cluster: h.cluster || 'standalone', standalone: isStandalone(h.cluster), hosts: 0, readable: 0, excluded: 0, maintenance: 0, clusterUnknown: 0,
      clusterRef: cmode.get(h.vcenterId) === true && !isStandalone(h.cluster) ? (h.clusterRef ?? null) : null,
      vcDatacenter: !isStandalone(h.cluster) && typeof h.vcDatacenter === 'string' && h.vcDatacenter ? h.vcDatacenter : null,
      cpuMhz: 0, cpuUsed: 0, memMB: 0, memUsed: 0, active: 0, actCpu: 0, actMem: 0, maxCpu: 0, maxMem: 0 };
    g.hosts++;
    if (!h.cluster) g.clusterUnknown++;   // 빈 값 = 소속을 모른다(REST 폴백) — '독립' 으로 단정하지 않고 센다
    cmap.set(k, g);
    // v2.606(감사 WEB2606-02): 연결 끊긴·무응답 호스트는 사용량을 읽지 못했고(SOAP 이 0 을 싣는다) 부하를 받아 줄 수도
    // 없다 — '장애 후 잔여' 용량에 넣으면 N+1 이 여유라고 거짓 판정한다. 판정은 store.usageReadable 하나(v2.594).
    if (!usageReadable(h)) { g.excluded++; continue; }
    g.readable++; g.cpuMhz += h.cpuTotalMhz || 0; g.cpuUsed += h.cpuUsageMhz || 0; g.memMB += h.memTotalMB || 0; g.memUsed += h.memUsageMB || 0;
    if (h.connectionState === 'MAINTENANCE') { g.maintenance++; continue; }   // ① 사용량은 넣고 받아 줄 용량에서는 뺀다
    g.active++; g.actCpu += h.cpuTotalMhz || 0; g.actMem += h.memTotalMB || 0;
    g.maxCpu = Math.max(g.maxCpu, h.cpuTotalMhz || 0); g.maxMem = Math.max(g.maxMem, h.memTotalMB || 0);
  }
  // 같은 vCenter 의 같은 이름 그룹 수 — 2 이상이면 화면이 이름만으로 구분할 수 없다(데이터센터·ref 를 함께 보인다).
  const sameNameN = new Map();
  for (const g of cmap.values()) { const nk = `${g.vcenterId}\u0000${String(g.cluster).toLowerCase()}`; sameNameN.set(nk, (sameNameN.get(nk) || 0) + 1); }
  const out = [...cmap.entries()].map(([key, g]) => {
    let cpuOkPct = null, memOkPct = null, n1Ok = null;
    if (!g.standalone) {
      const remCpu = g.actCpu - g.maxCpu, remMem = g.actMem - g.maxMem;
      cpuOkPct = remCpu > 0 ? r0((g.cpuUsed / remCpu) * 100) : 999;
      memOkPct = remMem > 0 ? r0((g.memUsed / remMem) * 100) : 999;
      n1Ok = g.active >= 2 && cpuOkPct <= 90 && memOkPct <= 90;
    }
    return { key, row: { vcenterId: g.vcenterId, cluster: g.cluster, clusterRef: g.clusterRef, vcDatacenter: g.vcDatacenter, sameName: sameNameN.get(`${g.vcenterId}\u0000${String(g.cluster).toLowerCase()}`) || 1, standalone: g.standalone, hosts: g.hosts, hostsUsageExcluded: g.excluded, maintenance: g.maintenance, clusterUnknown: g.clusterUnknown,
      n1Ok, cpuAfterFailPct: cpuOkPct, memAfterFailPct: memOkPct,
      // 읽을 수 있는 호스트가 없으면 사용률은 null('—') — 0% 는 '부하 없음' 이라는 거짓이다.
      cpuUsagePct: g.cpuMhz ? r0((g.cpuUsed / g.cpuMhz) * 100) : null, memUsagePct: g.memMB ? r0((g.memUsed / g.memMB) * 100) : null } };
  });
  // 위험(false) → 여유(true) → 판정 안 함(null). 같은 등급은 장애 후 CPU 높은 순.
  const n1Rank = (v) => (v === false ? 0 : v === true ? 1 : 2);
  out.sort((x, y) => { const a = x.row, b = y.row; return (n1Rank(a.n1Ok) - n1Rank(b.n1Ok)) || ((b.cpuAfterFailPct ?? -1) - (a.cpuAfterFailPct ?? -1)); });
  return out;
}
