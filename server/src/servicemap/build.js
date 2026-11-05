/**
 * servicemap/build.js — 서비스 인벤토리 집계(순수, v2.887). 입력은 라우트(inputs.js)가 모은 구성원·파생 호스트와 저장소.
 *
 * ⚠ CPU·메모리 합산은 `corpusage/build.js` 의 emptyAgg/addAgg/finishAgg 를 **그대로 부른다**(4차 반증 15 — 복제 금지).
 *   못 읽음(unread)·오래됨(stale)·용량 모름(noCap)은 합계에 넣지 않고 따로 센다. 분모 0 이면 null('—').
 * ⚠ 꺼진 VM 은 사용률 합산에 넣지 않는다(꺼진 VM 의 0% 가 서비스 평균을 끌어내리지 않게) — off 로 센다.
 * ⚠ 부품 장애는 구성원 장애와 **영향 호스트 장애를 나눠** 센다(호스트 장애는 서비스 여럿이 공유 — 4차 반증 19).
 *   장애 DB 를 못 읽으면 구성원 faults 가 null 이고 faultsUnknown 으로 센다(0 이 아니다 — 4차 반증 10).
 * ⚠ 할당 합계(vCPU·메모리·스토리지)는 '투입된 자원' 이다 — 사용률을 못 읽은 서버도 들어간다(할당은 스냅샷 값).
 *
 * 구성원(입력):
 *   { key, keyKind, kind:'vm'|'bm', corp, name, folderPath, tags, scan, host, powered:true|false|null,
 *     cores, memGB, storageGB, usage:{state,cpuPct,memPct,src}, faults:number|null|undefined, backup:'ok'|'fail'|'none'|null|undefined,
 *     ip, serviceTag, source, remoteAgent }
 * 파생 호스트(입력): Map(`${corp}|${소문자 이름}` → { name, corp, serviceTag, usage, faults })
 */
import { emptyAgg, addAgg, finishAgg } from '../corpusage/build.js';
import { buildIndex, resolveMember, sortNameRules } from './resolve.js';

const lc = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
export const hostKeyOf = (corp, name) => `${corp}|${lc(name)}`;

function emptyStat() {
  return {
    n: { vm: 0, bm: 0, total: 0 }, power: { on: 0, off: 0, unknown: 0 }, agg: emptyAgg(),
    alloc: { vcpu: 0, vmMemGB: 0, storageGB: 0, storageUnknown: 0, bmCores: 0, bmMemGB: 0, bmCapUnknown: 0 },
    faults: { member: 0, memberUnknown: 0, host: 0, hostUnknown: 0 },
    backup: { ok: 0, fail: 0, none: 0, unknown: 0, na: 0 },
    src: { pin: 0, folder: 0, scan: 0, tag: 0, rule: 0, none: 0 }, drift: 0, unchecked: 0,
    byName: { scan: 0, tag: 0 },   // 서비스 이름 그대로(별칭 아님)로 걸린 스캔 라벨·태그 값 — 개명하면 끊기는 대수(5차 반증 R3)
    hosts: new Set(),
  };
}
function addMember(st, m, r) {
  st.n.total += 1;
  if (m.kind === 'vm') st.n.vm += 1; else st.n.bm += 1;
  if (m.powered === true) st.power.on += 1; else if (m.powered === false) st.power.off += 1; else st.power.unknown += 1;
  if (m.kind === 'vm') {
    if (num(m.cores) != null) st.alloc.vcpu += m.cores;
    if (num(m.memGB) != null) st.alloc.vmMemGB += m.memGB;
    if (num(m.storageGB) != null) st.alloc.storageGB += m.storageGB; else st.alloc.storageUnknown += 1;
    if (m.host) st.hosts.add(hostKeyOf(m.corp, m.host));
    // undefined = 이 법인에 Bareos Director 매핑이 없다(해당 없음 — 5차 검토 M1) · null = 원장을 못 읽음(모름)
    if (m.backup === 'ok') st.backup.ok += 1; else if (m.backup === 'fail') st.backup.fail += 1; else if (m.backup === 'none') st.backup.none += 1; else if (m.backup === null) st.backup.unknown += 1; else st.backup.na += 1;
  } else {
    if (num(m.cores) != null) st.alloc.bmCores += m.cores; else st.alloc.bmCapUnknown += 1;
    if (num(m.memGB) != null) st.alloc.bmMemGB += m.memGB;
    if (m.faults === null) st.faults.memberUnknown += 1; else if (num(m.faults) != null) st.faults.member += m.faults;
  }
  // 사용률: 꺼진 VM 은 넣지 않는다. 나머지는 corpusage addAgg 그대로(state ok/stale/unread · 용량 없으면 noCap).
  if (!(m.kind === 'vm' && m.powered === false)) addAgg(st.agg, { cores: num(m.cores), memGB: num(m.memGB), ...(m.usage || { state: 'unread' }) });
  st.src[r.src] = (st.src[r.src] || 0) + 1;
  if (r.drift) st.drift += 1;
  if (r.unchecked) st.unchecked += 1;
}
function finishStat(st, hostByKey) {
  for (const hk of st.hosts) {
    const h = hostByKey.get(hk);
    if (!h || h.faults === null) st.faults.hostUnknown += 1; else if (num(h.faults) != null) st.faults.host += h.faults;
  }
  const u = finishAgg(st.agg);
  return {
    n: st.n, power: st.power, hosts: st.hosts.size,
    // cpuUsed·cpuTotal 은 반올림 전 값(소수 3자리) — 지역 합계가 0.1코어 반올림을 수십 번 더해 '0%' 가 되지 않게(3차 반증 8)
    usage: { cpu: u.cpu.pct, mem: u.mem.pct, cpuN: u.cpu.n, memN: u.mem.n, unread: u.unread, stale: u.stale, noCap: u.noCap, src: u.src,
      cpuUsed: r3(st.agg?.cpu?.used), cpuTotal: r3(st.agg?.cpu?.total) },
    alloc: { ...st.alloc, vmMemGB: r1(st.alloc.vmMemGB), storageGB: r1(st.alloc.storageGB), bmMemGB: r1(st.alloc.bmMemGB) },
    faults: st.faults, backup: st.backup, src: st.src, drift: st.drift, unchecked: st.unchecked, byName: st.byName,
  };
}

/**
 * 전부 한 번에 — 판정은 구성원당 1회(결과 Map 을 표·큐·전역이 공유 — 4차 반증 9).
 * @param {{members:object[], map:object, pins:object, hostByKey:Map, allowed:Set|null, unreadCorps:Set, bmBlocked:boolean,
 *          corpNames:Map, scanEntries?:Map, adminView?:boolean}} input
 */
export function buildInventory({ members = [], map, pins = {}, hostByKey = new Map(), allowed = null, unreadCorps = new Set(), bmBlocked = false, corpNames = new Map(), scanEntries = new Map(), adminView = true, knownCorps = null } = {}) {
  const idx = buildIndex(map);
  const ctx = { tagCategory: map?.settings?.tagCategory || '' };
  const inScope = (vc) => (allowed ? !!vc && allowed.has(vc) : true);
  const resolved = new Map();          // key → r (전 구성원 — 유령 판정은 범위와 무관한 전체 집합으로)
  for (const m of members) resolved.set(m.key, resolveMember(m, idx, ctx, pins));

  const svcStat = new Map();           // serviceId → stat
  const unStat = new Map();            // corp → stat (미지정)
  const scoped = members.filter((m) => inScope(m.corp));
  for (const m of scoped) {
    const r = resolved.get(m.key);
    const k = r.serviceId || null;
    const bucket = k ? svcStat : unStat;
    const id = k || m.corp || '';
    if (!bucket.has(id)) bucket.set(id, emptyStat());
    addMember(bucket.get(id), m, r);
    if (k && (r.src === 'scan' || r.src === 'tag') && lc(r.via) === lc(idx.get(m.corp)?.svcById.get(k)?.name)) bucket.get(id).byName[r.src] += 1;
  }

  // ── 법인별 서비스 행 ──
  const corps = [];
  const services = [];
  const corpIds = new Set([...Object.keys(map?.corps || {}), ...scoped.map((m) => m.corp).filter(Boolean)]);
  for (const vc of [...corpIds].filter(inScope).sort()) {
    const c = map?.corps?.[vc] || { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false };
    corps.push({
      vcenterId: vc, name: corpNames.get(vc) || vc, folders: c.folders, tagEnabled: !!c.tagEnabled,
      // 이름 규칙은 **적용 순서대로** 싣고 순번을 붙인다(5차 M4 — 화면이 순서를 다시 계산하지 않게 · 판정 코어는 resolve.js 하나)
      folderRules: c.folderRules, aliases: c.aliases, nameRules: sortNameRules(c.nameRules || []).map((r, i) => ({ ...r, order: i + 1 })),
      unassigned: unStat.has(vc) ? finishStat(unStat.get(vc), hostByKey) : null,
      stale: unreadCorps.has(vc),
      // 등록 해제된 vCenter — 저장소에만 남은 법인 항목(5차 반증 R2). knownCorps 가 null(스냅샷 vCenter 0개 — 기동 직후 등)이면 판단하지 않는다.
      orphan: knownCorps ? !knownCorps.has(vc) : false,
    });
    for (const s of c.services) {
      services.push({ ...s, corp: vc, stat: finishStat(svcStat.get(s.id) || emptyStat(), hostByKey) });
    }
  }
  const noCorp = !allowed && unStat.has('') ? finishStat(unStat.get(''), hostByKey) : null;

  // ── 전역 축(카탈로그 + globalId) — 결정 1 A · 결정 2 A ──
  const globalById = new Map((map?.globals || []).map((g) => [g.id, g]));
  const gStat = new Map(); const gCells = new Map();
  for (const m of scoped) {
    const r = resolved.get(m.key);
    if (!r.serviceId) continue;
    const s = idx.get(m.corp)?.svcById.get(r.serviceId);
    if (!s || !s.globalId || !globalById.has(s.globalId)) continue;
    if (!gStat.has(s.globalId)) gStat.set(s.globalId, emptyStat());
    addMember(gStat.get(s.globalId), m, r);
    const ck = `${s.globalId}|${m.corp}`;
    if (!gCells.has(ck)) gCells.set(ck, emptyStat());
    addMember(gCells.get(ck), m, r);
  }
  const globals = (map?.globals || []).map((g) => {
    const linked = services.filter((s) => s.globalId === g.id);
    return { ...g, corps: [...new Set(linked.map((s) => s.corp))].sort(), services: linked.map((s) => ({ id: s.id, corp: s.corp, name: s.name, owner: s.owner })), stat: finishStat(gStat.get(g.id) || emptyStat(), hostByKey) };
  });
  const cells = {};
  for (const [ck, st] of gCells) {
    const [gid, vc] = [ck.slice(0, ck.indexOf('|')), ck.slice(ck.indexOf('|') + 1)];
    const f = finishStat(st, hostByKey);
    (cells[gid] ||= {})[vc] = { n: f.n.total, vm: f.n.vm, bm: f.n.bm, faults: f.faults.member + f.faults.host, faultsUnknown: f.faults.memberUnknown + f.faults.hostUnknown, stale: unreadCorps.has(vc), alloc: f.alloc, usage: { cpu: f.usage.cpu, mem: f.usage.mem, unread: f.usage.unread, stale: f.usage.stale, cpuUsed: f.usage.cpuUsed, cpuTotal: f.usage.cpuTotal }, backup: f.backup, hosts: f.hosts };
  }
  const globalNames = new Map((map?.globals || []).map((g) => [lc(g.name), g.id]));
  const unlinked = services.filter((s) => !s.globalId || !globalById.has(s.globalId))
    .map((s) => ({ id: s.id, corp: s.corp, name: s.name, suggest: globalNames.get(lc(s.name)) || null, n: s.stat.n.total }));

  return { resolved, corps, services, noCorp, global: { globals, cells, unlinked }, queues: buildQueues({ members, resolved, pins, allowed, unreadCorps, bmBlocked, idx, scanEntries, adminView, knownCorps }) };
}

/**
 * 운영 큐(순수): 미지정 출처별 묶음 · 매핑 안 된 값 · 드리프트 · 고정 법인 불일치 · 불필요한 고정 · 유령 키(판정 보류 포함).
 * ⚠ 유령 판정은 **읽지 못한 출처를 막는다**(4차 반증 5): 그 법인 vCenter 를 지금 못 읽거나(unreadCorps) 베어메탈 출처를 못 읽으면
 *   (bmBlocked — 등록부 손상·엣지 만료 등) 그 고정은 유령이 아니라 '판정 보류' 다. v2.783 P-B3 와 같은 사고 유형.
 */
export function buildQueues({ members = [], resolved, pins = {}, allowed = null, unreadCorps = new Set(), bmBlocked = false, idx, scanEntries = new Map(), adminView = true, knownCorps = null }) {
  const inScope = (vc) => (allowed ? !!vc && allowed.has(vc) : true);
  const groups = new Map();
  const unmapped = new Map();
  const drift = []; const mismatch = []; const redundant = []; const tagAmbiguous = []; const ruleOverlap = [];
  const NAME_CAP = 40;
  for (const m of members) {
    if (!inScope(m.corp)) continue;
    const r = resolved.get(m.key);
    if (r.pinMismatch) mismatch.push({ key: m.key, name: m.name, kind: m.kind, corp: m.corp, pinCorp: r.pinMismatch.corp, serviceId: r.pinMismatch.serviceId });
    if (r.drift) drift.push({ key: m.key, name: m.name, kind: m.kind, corp: m.corp, pin: { serviceId: r.serviceId, by: pins[m.key]?.by || '', at: pins[m.key]?.at || 0 }, auto: { serviceId: r.auto.serviceId, src: r.auto.src, via: r.auto.via || '' },
      ...(r.driftChanged ? { changed: r.driftChanged.legacy ? { legacy: true } : { reviewedAuto: r.driftChanged.reviewedAuto } } : {}) });
    // 불필요한 고정 — 단 '모호한 자동 판정을 사람이 확인한 고정'(태그 모호·규칙 겹침)은 불필요하지 않다: 지우면 다시 모호로 돌아간다(3차 반증 4 — 순환)
    if (r.src === 'pin' && r.redundant && !r.auto?.tagAmbiguous && !r.auto?.ruleOverlap) redundant.push({ key: m.key, name: m.name, kind: m.kind, corp: m.corp, serviceId: r.serviceId, via: r.auto.src });
    // 태그가 둘 이상의 서비스에 걸림(5차 M5·R14) — 첫 값으로 정했지만 사람이 봐야 한다. 고정한 구성원은 사람이 이미 정했다.
    if (r.src === 'tag' && r.tagAmbiguous) tagAmbiguous.push({ key: m.key, name: m.name, kind: m.kind, corp: m.corp, serviceId: r.serviceId, tags: r.tagValues || [] });
    // 이름 규칙 둘 이상(다른 서비스)이 걸림 — 결과가 적용 순서에 달렸다(3차 반증 1: 순서를 바꾼 업그레이드에서 조용히 옮겨 간 구성원).
    if (r.src === 'rule' && r.ruleOverlap) ruleOverlap.push({ key: m.key, name: m.name, kind: m.kind, corp: m.corp, serviceId: r.serviceId, via: r.via, others: r.ruleOverlap });
    if (r.serviceId) continue;
    let gk; let kind; let value = '';
    if (!m.corp) {   // 이유별로 나눈다(5차 R18 둘째 절) — 귀속 판정 실패 · 서비스 태그가 두 법인에 걸림 · 어느 규칙에도 맞지 않음
      kind = 'nocorp'; value = r.reason === 'no-corp-error' ? 'attr-error' : r.reason === 'no-corp-conflict' ? 'tag-conflict' : '';
      gk = value ? `nocorp|${value}` : 'nocorp';
    }
    else if (r.unmapped?.kind === 'folder') { kind = 'folder'; value = r.unmapped.value; gk = `folder|${m.corp}|${value}`; }
    else if (r.unmapped?.kind === 'tag') { kind = 'tag'; value = r.unmapped.value; gk = `tag|${m.corp}|${lc(value)}`; }
    else if (r.unmapped?.kind === 'entry') { kind = 'entry'; value = r.unmapped.value; gk = `entry|${m.corp}|${value}`; }
    else if (r.unmapped?.kind === 'scan') { kind = 'scan'; value = r.unmapped.value; gk = `scan|${m.corp}|${lc(value)}`; }
    else if (r.reason === 'placement-unknown') { kind = 'placement'; gk = `placement|${m.corp}`; }
    else {
      // 묶을 출처 없음 — 이유별로 나눈다(5차 R18: 예전에는 수동 등록·구버전 엣지·모르는 엔트리를 한 묶음으로 뭉뚱그렸다)
      kind = 'manual'; value = r.reason === 'scan-entry-unknown' ? 'unknown-entry' : r.reason === 'source-old' ? 'old-source' : r.reason === 'source-unreported' ? 'not-reported' : '';
      gk = `manual|${m.corp}|${value}`;
    }
    if (!groups.has(gk)) {
      const e = kind === 'entry' ? scanEntries.get(value) : null;
      groups.set(gk, { key: gk, kind, corp: m.corp, value, n: 0, vm: 0, bm: 0, unchecked: 0, names: [], keys: [],
        ...(kind === 'entry' ? { entry: { id: value, ...(adminView && e ? { range: e.range || '' } : {}), service: e?.service || '' } } : {}) });
    }
    const g = groups.get(gk);
    g.n += 1; if (m.kind === 'vm') g.vm += 1; else g.bm += 1; if (r.unchecked) g.unchecked += 1;
    if (g.names.length < NAME_CAP) g.names.push({ key: m.key, name: m.name, kind: m.kind });
    g.keys.push(m.key);
    if (kind === 'scan' || kind === 'tag') {
      const uk = `${m.corp}|${kind}|${lc(value)}`;
      if (!unmapped.has(uk)) unmapped.set(uk, { corp: m.corp, kind, value, n: 0 });
      unmapped.get(uk).n += 1;
    }
  }
  for (const g of groups.values()) { g.namesOmitted = Math.max(0, g.n - g.names.length); if (g.keys.length > 500) g.keys = g.keys.slice(0, 500); }

  // 유령 키 — 범위 안 법인의 고정 중 지금 구성원 전체 집합에 없는 키.
  const live = new Set(members.map((m) => m.key));
  const ghosts = []; const held = []; const orphaned = [];
  for (const [k, p] of Object.entries(pins || {})) {
    if (live.has(k) || !inScope(p.corp)) continue;
    // 등록 해제된 vCenter 의 고정 — 유령 정리(법인 쓰기 404)로는 못 지운다. '법인 항목 정리'(corp.purge) 대상으로 따로 센다(5차 반증 R2).
    if (knownCorps && !knownCorps.has(p.corp)) { orphaned.push({ key: k, serviceId: p.serviceId, corp: p.corp }); continue; }
    const svcName = idx?.get(p.corp)?.svcById.get(p.serviceId)?.name || '';
    const isBm = k.startsWith('st:') || k.startsWith('fl:');
    const why = unreadCorps.has(p.corp) ? 'corp-unread' : (isBm && bmBlocked ? 'bm-source-unread' : '');
    (why ? held : ghosts).push({ key: k, serviceId: p.serviceId, serviceName: svcName, corp: p.corp, by: p.by, at: p.at, ...(why ? { held: why } : {}) });
  }
  return {
    unassigned: [...groups.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)),
    unmapped: [...unmapped.values()].sort((a, b) => b.n - a.n),
    drift, mismatch, redundant, ghosts, ghostsHeld: held, orphaned, tagAmbiguous, ruleOverlap,
  };
}
