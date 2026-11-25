/**
 * routes/publicApiRows.js — 공개 조회 API(`/api/v1`) 2차 경로의 **행 만들기**(v3.42.0 — 사용자 요청 '없는 API 추가해줘' ·
 *   선택 '1차 핵심 조회' · 쓰기는 설계부터 · 전체 검증).
 *
 * 왜 따로 있나: `scripts/api-doc.mjs` 는 `guarded(...)` 인자를 3000자까지만 읽는다 — 핸들러 본문이 길면 문서 생성이 실패한다.
 *   그래서 `routes/publicApi.js` 의 핸들러는 '게이트 → 이 파일의 함수 → 투사(project/projectAll) → 봉투' 만 하고, 행을 만드는 일은 여기서 한다.
 *   이 파일은 **routes/ 안**에 둔다 — 원천 중 셋(GPU · 백업 · 전력)이 라우트 파일에 살고, 도메인 모듈이 routes/ 를 import 하면
 *   의존 방향 규칙(`test/arch2579.test.js` ①)에 걸린다.
 *
 * ⚠⚠ 판정을 새로 만들지 않는다 — 내부 화면과 **같은 함수**를 부른다(사본이면 두 경로가 다른 수를 말한다):
 *   · 클러스터 = `clustercfg/analyze.js analyzeClusters`(특수 기능 '클러스터 HA·DRS 점검' 과 같은 행)
 *   · 라이선스 = `corelicense/analyze.js vcenterLicenseRows`('라이선스 만료일 확인' 과 같은 행 — 키 값은 투사에서 뺀다)
 *   · 스냅샷 = `snaphist/view.js snapshotToolView`('스냅샷 있는 VM' 과 같은 판정 — 나이 기준은 'VM 구성 점검' 설정)
 *   · GPU = `routes/api/hardwareGpu.js buildGpuInventory`('GPU 인벤토리' 와 같은 행)
 *   · 백업 = `routes/api/veeam.js backupSummaryRowsFor`(Backup › Summary 의 법인 줄과 같은 집계)
 *   · 전력 = `routes/api/overviewCards.js powerTotal · powerSummaryOf`(Overview 카드 · '전체 소비 전력' 과 같은 합)
 *
 * ⚠ 못 읽은 값은 0 이 아니라 null 이다(`util/numOrNull.js`). 내부 객체를 펼치지(`{...row}`) 않는다 — 필드를 하나씩 고른다.
 * ⚠ 라우트 파일을 원천으로 쓰는 셋은 **동적 import** 다 — 공개 API 하니스(test/publicApi2562)가 /api/v1 만 띄울 때 그 라우트 파일들의
 *   전체 의존(폴러 · 원격 모듈)을 끌어오지 않게 하려는 것이다(스토리지 경로가 이미 같은 방식이다).
 */
import { usageReadable } from '../store.js';
import { numOrNull } from '../util/numOrNull.js';
import { msOrNull } from '../publicapi/time.js';
import { analyzeClusters } from '../clustercfg/analyze.js';
import { vcenterLicenseRows } from '../corelicense/analyze.js';
import { snapshotToolView } from '../snaphist/view.js';
import { snapMemo } from '../util/snapCache.js';
import { scopeSlice, scopeKey } from './api/shared.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { loadVmHygieneSettings } from '../vmhygiene/settings.js';
import { listDatacenters, datacenterOfVcenter } from '../datacenter/store.js';

const IP_MAX = 32;        // VM 한 대의 IP 목록 상한(NIC 여럿 · IPv6 — 그 이상은 잘랐다고 밝힌다)
const ID_MAX = 200;       // ?vcenterId 값 길이 상한(등록부 id 형식보다 넉넉하게 — 그 이상은 400)

const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);

/* ── 요청 해석 ────────────────────────────────────────────────────────────── */

/**
 * `?offset=&limit=` — 정수만 받는다(형식이 틀리면 400 · 조용히 기본값으로 바꾸지 않는다).
 *   값이 배열 · 객체(맨 express 는 `?limit=1&limit=2` 를 배열로 준다)면 형식 오류다. 운영은 index.js 의 queryNormalizer 가 먼저 글자로 바꾼다.
 * @returns {{ok:true, offset:number, limit:number} | {ok:false, field:string}}
 */
export function pageQueryOf(q, listMax) {
  const read = (name, def, min, max) => {
    const v = q?.[name];
    if (v == null || v === '') return { ok: true, n: def };
    if (typeof v !== 'string' || !/^\d{1,9}$/.test(v)) return { ok: false };
    const n = Number(v);
    return n < min || n > max ? { ok: false } : { ok: true, n };
  };
  const off = read('offset', 0, 0, 999_999_999);
  if (!off.ok) return { ok: false, field: 'offset' };
  const lim = read('limit', listMax, 1, listMax);
  if (!lim.ok) return { ok: false, field: 'limit' };
  return { ok: true, offset: off.n, limit: lim.n };
}

/**
 * 한 쪽 자르기 + 표기 — 기존 `capped()` 의 meta 키(count · truncated · omitted · limit)를 그대로 두고 offset · total · nextOffset 을 더한다.
 *   truncated = 이 쪽 뒤에 행이 더 있다(다음 쪽을 받아야 한다). omitted = 이 쪽 뒤에 남은 행 수(앞쪽 offset 은 세지 않는다).
 */
export function pageOf(rows, { offset, limit }) {
  const all = Array.isArray(rows) ? rows : [];
  const page = all.slice(offset, offset + limit);
  const after = Math.max(0, all.length - offset - page.length);
  return {
    rows: page,
    meta: { count: page.length, total: all.length, offset, limit, truncated: after > 0, omitted: after, nextOffset: after > 0 ? offset + page.length : null },
  };
}

/**
 * `?vcenterId=` — 키의 범위 안 · 지금 존재하는 vCenter 만. 범위 밖과 없는 id 는 **같은 404**(존재를 흘리지 않는다 — server/CLAUDE.md '범위 밖은 404').
 * @param {(id:string)=>boolean} inScope
 * @param {Set<string>|null} known  등록부 ∪ 스냅샷 id(모르면 null — 그때는 범위만 본다)
 * @returns {{ok:true, id:string|null} | {ok:false, status:number, code:string, reason:string}}
 */
export function vcenterPickOf(q, inScope, known) {
  const v = q?.vcenterId;
  if (v == null || v === '') return { ok: true, id: null };
  if (typeof v !== 'string' || v.length > ID_MAX) return { ok: false, status: 400, code: 'bad-query', reason: 'vcenterId 는 글자 하나여야 합니다.' };
  if (!inScope(v) || (known && !known.has(v))) {
    return { ok: false, status: 404, code: 'unknown-vcenter', reason: '이 키로 볼 수 있는 vCenter 가 아닙니다(없는 id 이거나 키의 범위 밖입니다).' };
  }
  return { ok: true, id: v };
}

/* ── 자원 목록(objects) ───────────────────────────────────────────────────── */

/**
 * 호스트 행 — 끊긴 호스트(DISCONNECTED · NOT_RESPONDING)의 사용률은 0 이 아니라 null(`store.usageReadable` — /metrics · 요약과 같은 판정).
 */
export function hostRows(snap, inScope, vcId = null) {
  const out = [];
  for (const h of snap?.hosts || []) {
    if (!h || !inScope(h.vcenterId) || (vcId && h.vcenterId !== vcId)) continue;
    const readable = usageReadable(h);
    out.push({
      id: h.id, vcenterId: h.vcenterId, name: strOrNull(h.name), cluster: strOrNull(h.cluster),
      connectionState: strOrNull(h.connectionState), powerState: strOrNull(h.powerState),
      version: strOrNull(h.version), vendor: strOrNull(h.vendor), model: strOrNull(h.model), cpuModel: strOrNull(h.cpuModel),
      serviceTag: strOrNull(h.serviceTag),
      cpuSockets: numOrNull(h.cpuSockets), cpuCores: numOrNull(h.cpuCores), cpuThreads: numOrNull(h.cpuThreads), memTotalMB: numOrNull(h.memTotalMB),
      cpuUsagePct: readable ? numOrNull(h.cpuUsagePct) : null, memUsagePct: readable ? numOrNull(h.memUsagePct) : null,
      vmCount: numOrNull(h.vmCount), usageUnknown: !readable || numOrNull(h.cpuUsagePct) == null,
      bootTime: msOrNull(h.bootTime),
    });
  }
  return out;
}

/** VM 한 대의 IP — 배열이 없으면(못 읽음) null, 있으면 글자만 · 상한 IP_MAX. 예전 단일 필드(ipAddress)만 있으면 그것 하나. */
function ipsOf(v) {
  if (Array.isArray(v.ipAddresses)) return v.ipAddresses.filter((x) => typeof x === 'string' && x).slice(0, IP_MAX);
  if (typeof v.ipAddress === 'string' && v.ipAddress) return [v.ipAddress];
  return null;
}

/**
 * VM 행 — id 로 정렬한다(쪽 나누기가 같은 스냅샷 안에서 겹치거나 빠지지 않게). 메모 · 태그 · 폴더 · 구성 세부는 싣지 않는다(자유 글 · 내부 모양).
 * ⚠ storageGB 가 null 이면 못 읽은 것이다(v2.727 C-01 — /inventory/summary 의 vmStorageUnknown 과 같은 판정).
 */
export function vmRows(snap, inScope, vcId = null) {
  const out = [];
  for (const v of snap?.vms || []) {
    if (!v || !inScope(v.vcenterId) || (vcId && v.vcenterId !== vcId)) continue;
    out.push({
      id: v.id, vcenterId: v.vcenterId, name: strOrNull(v.name), instanceUuid: strOrNull(v.instanceUuid),
      powerState: strOrNull(v.powerState), template: v.template === true, guestOS: strOrNull(v.guestOS),
      cpuCount: numOrNull(v.cpuCount), memMB: numOrNull(v.memMB), storageGB: numOrNull(v.storageGB),
      host: strOrNull(v.host), cluster: strOrNull(v.cluster), ipAddresses: ipsOf(v),
      toolsStatus: strOrNull(v.toolsStatus),
      cpuUsagePct: numOrNull(v.cpuUsagePct), memUsagePct: numOrNull(v.memUsagePct),
      snapshotCount: numOrNull(v.snapshotCount),
    });
  }
  out.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return out;
}

export function networkRows(snap, inScope, vcId = null) {
  const out = [];
  for (const n of snap?.networks || []) {
    if (!n || !inScope(n.vcenterId) || (vcId && n.vcenterId !== vcId)) continue;
    out.push({
      id: n.id, vcenterId: n.vcenterId, name: strOrNull(n.name), type: strOrNull(n.type),
      vlanId: n.vlanId == null || n.vlanId === '' ? null : (numOrNull(n.vlanId) ?? strOrNull(String(n.vlanId))),
      hostCount: numOrNull(n.hostCount), vmCount: numOrNull(n.vmCount),
    });
  }
  return out;
}

/**
 * 클러스터 행 — `analyzeClusters` 의 행(구성 수집 · 호스트 묶음)에서 고른다. 범위는 `scopeSlice`(내부 /tools/cluster-check 와 같은 절단)가 먼저다.
 *   구성을 아직 못 읽은 클러스터(collected:false)의 HA · DRS 는 false 가 아니라 null 이다.
 * @returns {{rows:object[], omitted:number, coverage:object}}
 */
export function clusterRows(snap, user, vcId = null) {
  const scoped = scopeSlice(snap, user, vcId || undefined);
  const r = analyzeClusters(scoped.vcenters, scoped.hosts, {});
  const rows = (r.rows || []).map((c) => ({
    vcenterId: c.vcenterId, name: strOrNull(c.name), ref: strOrNull(c.ref), vcDatacenter: strOrNull(c.vcDatacenter),
    sameName: numOrNull(c.sameName), hosts: numOrNull(c.hosts), hostsDisconnected: numOrNull(c.hostsDisconnected),
    collected: c.collected === true, collectedAt: msOrNull(c.at),
    haEnabled: boolOrNull(c.ha?.enabled), drsEnabled: boolOrNull(c.drs?.enabled), drsBehavior: strOrNull(c.drs?.behavior),
    evcMode: c.collected ? (typeof c.evc === 'string' ? c.evc : null) : null,
    rulesTotal: numOrNull(c.rulesTotal), severity: strOrNull(c.sev), findings: Array.isArray(c.findings) ? c.findings.length : null,
  }));
  return { rows, omitted: numOrNull(r.omitted) ?? 0, coverage: r.coverage || null };
}

/* ── 점검 · 준수(compliance) ──────────────────────────────────────────────── */

/**
 * vCenter 라이선스 행 — 키 값(`key`)은 **싣지 않는다**(자산 · 비밀). NSX · Horizon 라이선스는 이 경로에 없다(meta 가 밝힌다).
 * @returns {{rows:object[], unread:{vcenterId:string, why:string}[]}}
 */
export function licenseRows(snap, inScope, vcId = null) {
  const vcs = (snap?.vcenters || []).filter((v) => v && inScope(v.id) && (!vcId || v.id === vcId));
  const r = vcenterLicenseRows(vcs);
  const rows = r.items.map((l) => ({
    vcenterId: l.vcenterId, name: l.name, family: strOrNull(l.family), edition: strOrNull(l.edition), product: strOrNull(l.product),
    productVersion: strOrNull(l.productVersion), total: numOrNull(l.total), used: numOrNull(l.used),
    expires: strOrNull(l.expires), status: strOrNull(l.status), daysLeft: numOrNull(l.daysLeft),
  }));
  // 못 읽은 까닭(why)만 — 오류 원문(error)은 관리 주소를 담을 수 있어 싣지 않는다(내부 라우트도 관리자 판본에만 싣는다).
  return { rows, unread: r.unread.map((u) => ({ vcenterId: u.vcenterId, why: u.why })) };
}

/**
 * 스냅샷 판정 문맥 — 내부 /tools/snapshots(routes/api/vcTools.js)와 같은 입력(범위 · 'VM 구성 점검' 설정 · 법인 이름).
 *   설정 · 법인 목록을 못 읽으면 판정하지 않음(hygiene null — 행의 judged:false · skip 'no-settings') · vCenter 이름으로 묶음 — 내부와 같은 폴백.
 */
export function snapshotContext(user, snap, vcId = null) {
  let dcNames = new Map();
  try { dcNames = new Map(listDatacenters().map((d) => [d.id, d.name || d.id])); } catch { /* vCenter 이름으로 묶는다 */ }
  let hygiene = null;
  try { hygiene = loadVmHygieneSettings(); } catch { hygiene = null; }
  return { allowed: scopedVcenterIds(user, snap), vcId, now: Date.now(), hygiene, dcOf: (id) => datacenterOfVcenter(id), dcNames };
}

/**
 * 스냅샷이 있는 VM 행 — 판정은 `snapshotToolView` 하나(나이 기준 = 'VM 구성 점검' 설정 · 예외 · 보류 반영). 스냅샷 이름 · 설명(자유 글)은 싣지 않는다.
 *   스냅샷 개수를 못 읽은 VM 은 행이 없다 — 그 수는 meta(snapshotUnknownVms)가 밝힌다('없음' 이 아니다).
 * @param {{allowed:Set<string>|null, vcId:string|null, now:number, hygiene:object|null, dcOf:Function, dcNames:Map}} o
 */
export function snapshotRows(snap, o) {
  const pick = o.vcId ? new Set([o.vcId]) : null;
  const view = snapshotToolView(snap, { allowed: o.allowed, pick, hygiene: o.hygiene, now: o.now, dcOf: o.dcOf, dcNames: o.dcNames });
  const rows = (view.items || []).map((x) => ({
    vmId: x.id, vcenterId: x.vcenterId, vmName: strOrNull(x.name), cluster: strOrNull(x.cluster), host: strOrNull(x.host),
    powerState: strOrNull(x.powerState), template: x.template === true, snapshotCount: numOrNull(x.snapshotCount),
    sizeGB: numOrNull(x.snapGB), oldestAt: msOrNull(x.oldestTs), ageDays: numOrNull(x.days), band: strOrNull(x.band),
    judged: x.judged === true, skip: strOrNull(x.skip),
    overAge: x.judged ? x.sig?.age === true : null, overCount: x.judged ? x.sig?.count === true : null, overSize: x.judged ? x.sig?.size === true : null,
    consolidationNeeded: boolOrNull(x.consolidationNeeded), stale: x.stale === true,
  }));
  const inPick = (id) => (!o.allowed || o.allowed.has(id)) && (!pick || pick.has(id));
  const unknown = (snap?.vms || []).filter((v) => v && inPick(String(v.vcenterId)) && numOrNull(v.snapshotCount) == null).length;
  return { rows, thresholds: view.thresholds || null, ghost: numOrNull(view.ghost), snapshotUnknownVms: unknown };
}

/* ── 전력 · GPU(resources) ────────────────────────────────────────────────── */

/** GPU 장착 호스트 행 — 할당 VM 이름 · 게스트 수집 세부(경로 · 엣지)는 싣지 않는다(개수만). */
export async function gpuRows(snap, allowed, vcId = null) {
  const { buildGpuInventory } = await import('./api/hardwareGpu.js');
  const inv = buildGpuInventory(snap, vcId || undefined, allowed);
  const rows = (inv.items || []).map((g) => ({
    hostId: g.id, host: strOrNull(g.host), vcenterId: g.vcenterId, cluster: strOrNull(g.cluster),
    gpuCount: numOrNull(g.count), model: strOrNull(g.model), memGB: numOrNull(g.memGB), mode: strOrNull(g.mode),
    utilPct: numOrNull(g.utilPct), utilSource: strOrNull(g.utilSource), assignedVms: numOrNull(g.assignedVms),
    allocPct: numOrNull(g.allocPct), memUsedPct: numOrNull(g.memUsedPct), tempC: numOrNull(g.tempC),
  }));
  return { rows };
}

/** 그 원천에서 값을 읽은 장비 수(완전 측정 + 일부 PSU 만 읽은 장비) — 웹 overviewCardsText.js powerCatKw 와 같은 규칙(테스트가 같은 입력으로 대조한다). */
const powerReadOf = (x) => (numOrNull(x?.measured) ?? 0) + (numOrNull(x?.partial) ?? 0);

/**
 * 전력 요약 행 — `powerSummaryOf`(Overview 카드와 같은 합)에서 필드를 **하나씩** 고른다(카드 모양에 필드가 늘어도 공개 계약으로 새지 않게).
 * ⚠ 읽은 장비가 하나도 없는 원천의 watts 는 0 이 아니라 null, 어느 원천도 못 읽었으면 totalWatts 도 null —
 *   화면은 같은 경우 '—' 를 보인다(웹 powerCatKw · powerTotalKw — v2.680 D-04 '0.0 kW 는 전력 0 으로 읽힌다'). 측정한 0 은 값이다.
 */
export function powerRowOf(sum) {
  const w = (x) => (powerReadOf(x) > 0 ? numOrNull(x?.watts) : null);
  const n = (v) => numOrNull(v);
  const s = sum?.servers || {}; const nw = sum?.network || {}; const st = sum?.storage || {};
  const anyRead = [s, nw, st].some((x) => powerReadOf(x) > 0);
  return {
    totalWatts: anyRead ? n(sum?.totalWatts) : null,
    servers: { watts: w(s), measured: n(s.measured), devices: n(s.devices), unread: n(s.unread), ome: n(s.ome), excludedVcenter: n(s.excludedVcenter) },
    network: { watts: w(nw), measured: n(nw.measured), partial: n(nw.partial), devices: n(nw.devices), unread: n(nw.unread), stale: n(nw.stale), noTime: n(nw.noTime), outputOnly: n(nw.outputOnly) },
    storage: { watts: w(st), measured: n(st.measured), partial: n(st.partial), devices: n(st.devices), unsupported: n(st.unsupported), unread: n(st.unread), stale: n(st.stale), noTime: n(st.noTime) },
  };
}

/**
 * 전체 소비 전력 합 — Overview 카드와 **같은 합**(`powerTotal` · `powerSummaryOf`). 원천 오류 원문은 싣지 않는다(어느 원천인지 키만 — cardErrorsFor 비관리자 판본).
 *   20초 메모(내부 /tools/power-total 과 같은 TTL) — 전력 원천(iDRAC · CVP DB · 스토리지)을 키마다 · 호출마다 다시 읽지 않게.
 */
export async function powerSummary() {
  return snapMemo('publicapi-power', 'all', 20_000, async () => {
    const { powerTotal, powerSummaryOf, cardErrorsFor } = await import('./api/overviewCards.js');
    const p = await powerTotal();
    return { row: powerRowOf(powerSummaryOf(p)), errors: cardErrorsFor(p.errors, false) };
  });
}

/* ── 백업(backup) ─────────────────────────────────────────────────────────── */

const RPO_KEYS = ['d1', 'd3', 'd7'];
const okMissUnk = (x) => ({ ok: numOrNull(x?.ok), miss: numOrNull(x?.miss), unknown: numOrNull(x?.unk) });

/** 법인(vCenter) 줄 하나 — Summary 의 `pa`(finishSiteAgg) 를 고른다. 정책을 하나도 모르면(표시 파일 손상) policy · backedUp 은 null. */
export function backupRowOf(r) {
  const pa = r?.pa || {};
  const pol = pa.pol && typeof pa.pol === 'object' ? pa.pol : null;
  return {
    vcenterId: r.id, name: strOrNull(r.name),
    vms: numOrNull(pa.n), poweredOn: numOrNull(pa.on),
    backedUp: pol ? (numOrNull(pol.veeam) ?? 0) + (numOrNull(pol.bareos) ?? 0) + (numOrNull(pol.ssh) ?? 0) : null,
    policy: pol ? { veeam: numOrNull(pol.veeam), bareos: numOrNull(pol.bareos), ssh: numOrNull(pol.ssh), none: numOrNull(pol.none), check: numOrNull(pol.check) } : null,
    policyUnknown: numOrNull(pa.polUnk), unprotected: numOrNull(pa.unprot), unverified: numOrNull(pa.unver),
    rpo: Object.fromEntries(RPO_KEYS.map((k) => [k, okMissUnk(pa.rpo?.[k])])),
    results24h: { ok: numOrNull(pa.r24?.ok), warn: numOrNull(pa.r24?.warn), fail: numOrNull(pa.r24?.fail) },
    success7d: { veeam: { ok: numOrNull(pa.v7?.ok), bad: numOrNull(pa.v7?.bad) }, bareos: { ok: numOrNull(pa.b7?.ok), bad: numOrNull(pa.b7?.bad) } },
    running: numOrNull(pa.run), lastSuccessAt: msOrNull(pa.lok), nextRunAt: msOrNull(pa.nx),
    veeamServers: numOrNull(r.veeamServers), veeamFailed: numOrNull(r.veeamFailed), veeamStale: numOrNull(r.veeamStale),
    bareosUnknown: r.bareosUnknown === true,
  };
}

/**
 * 법인별 백업 집계 — Backup › Summary 와 같은 함수(`backupSummaryRowsFor`)를 키의 합성 사용자로 돈다.
 *   60초 메모(내부 Summary 와 같은 TTL) · 열쇠 = 스냅샷 세대 | 범위 서명(scopeKey — 범위가 다른 키끼리 섞이지 않는다).
 */
export async function backupRows(user, snap) {
  const key = `${snap?.generatedAt ?? ''}|${scopeKey(user, snap)}`;
  return snapMemo('publicapi-backup', key, 60_000, async () => {
    const { backupSummaryRowsFor } = await import('./api/veeam.js');
    const s = await backupSummaryRowsFor(user, snap);
    return {
      rows: (s.rows || []).map(backupRowOf),
      registryUnreadable: s.registryUnreadable === true, marksUnreadable: s.marksUnreadable === true,
    };
  });
}
