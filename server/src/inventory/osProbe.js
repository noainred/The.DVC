// inventory/osProbe.js — '실제 OS 수집 점검'(v3.54 · 실제 OS 1단계 실측) — 순수 집계.
//
// 목적: VMware Tools 보고(vm.gos — inventory/guestDetail.js)가 현장에서 **얼마나 채워지는지**와 **실제로 어떤 글자로 오는지**를 법인별로 센다.
//   이 결과(JSON)로 다음 단계의 판정 코어(종류 · 버전 분류)를 실측 문자열에 맞춰 고정한다(docs/design/real-os/README.md §7 1단계).
// 원칙: VM 이름은 싣지 않는다(내려받아 밖으로 보내는 파일이다 — 종류 · 버전 · 개수만). 못 읽은 값은 0 이 아니라 따로 센다(사유별).
//   O(N) 한 번 순회 · 목록마다 상한 + 잘라낸 개수(조용히 자르지 않는다).
import { toolsAtLeast } from './guestDetail.js';

// 2: 점검 1회차 — samples 의 distroAddlVersion · cpeString · buildNumber 가 값별 개수 목록으로 · architecture 가 묶음 키 · vCenter 행 collectSource.
// 3: 점검 2회차 — 값별 개수 목록마다 <칸>Omitted · appliances[].fullVersions(값별 개수) · total.cfgRead · unparsedVms · 엣지 수집 행 status 없음.
// 4: 점검 4회차 — 사유 emptyValues · total.extraDropped · status.osErrorAt.
export const PROBE_SCHEMA = 4;
const SAMPLE_MAX = 300;
const RAW_MAX = 50;
const VAPP_MAX = 100;
const MANAGED_MAX = 50;
const TOP_MAX = 5;

/** 보고가 없는 VM 의 사유 — 앞의 것부터 처음 맞는 하나. 화면 문구는 웹 realOsProbeText.js 가 같은 키로 소유한다. */
export const NO_DETAIL_REASONS = Object.freeze(['notRead', 'notAsked', 'emptyValues', 'unparsed', 'template', 'toolsOld', 'toolsNotRunning', 'poweredOff', 'toolsUnknown', 'other']);

export function noDetailReason(vm) {
  const g = vm?.gos;
  if (!g || typeof g !== 'object') return 'notRead';
  if (!g.asked) return 'notAsked';
  if (g.emptyValues === true) return 'emptyValues';   // 점검 4회차: 형식은 맞고 값만 빈 보고 — 파서 결함(unparsed)과 섞지 않는다
  // 보고는 왔는데 아는 키를 못 읽었다(raw) · 모르는 키만 왔다(extra) — 'Tools 미보고' 가 아니라 파서가 틀린 것이다(점검의 목적이 이것을 가르는 것).
  if ((typeof g.raw === 'string' && g.raw) || (g.extra && typeof g.extra === 'object' && Object.keys(g.extra).length)) return 'unparsed';
  if (vm.template) return 'template';
  const t = toolsAtLeast(vm.toolsVersion, 11, 2);
  if (t === false) return 'toolsOld';
  const on = vm.powerState === 'POWERED_ON';
  if (on && vm.toolsStatus !== 'RUNNING') return 'toolsNotRunning';
  if (!on) return 'poweredOff';
  if (t == null) return 'toolsUnknown';
  return 'other';
}

/** Map<key, {count, …}> 를 개수 내림차순 상한 목록으로 — 잘라낸 개수를 함께. */
function topList(map, max, shape) {
  const all = [...map.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
  return { items: all.slice(0, max).map(shape), omitted: Math.max(0, all.length - max) };
}
function bump(map, key, val) { map.set(key, (map.get(key) || 0) + val); }
// 점검 2회차: 값별 개수 목록도 상위 TOP_MAX 개에서 자른다 — 잘라낸 종류 수를 함께 돌려준다(조용히 자르지 않는다). 받는 쪽이 `<칸>Omitted` 로 싣는다.
function topCountsOf(map) {
  const all = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return { items: all.slice(0, TOP_MAX).map(([value, count]) => ({ value, count })), omitted: Math.max(0, all.length - TOP_MAX) };
}
/** obj 에 field(목록)와 fieldOmitted(잘라낸 종류 수)를 싣는다. */
function putTop(obj, field, map) { const t = topCountsOf(map); obj[field] = t.items; obj[`${field}Omitted`] = t.omitted; return obj; }

/**
 * @param {object[]} vms       스냅샷 VM(이미 범위 · 요청 필터 적용)
 * @param {object[]} vcenters  스냅샷 vCenter(같은 범위)
 * @param {object[]} statuses  vmcfg/cache.js vmCfgStatus().vcenters(이 포탈이 직접 수집하는 vCenter 만 있다 — 엣지 수집분은 없다)
 */
export function buildOsProbe(vms, vcenters = [], statuses = [], { now = Date.now() } = {}) {
  const stBy = new Map((Array.isArray(statuses) ? statuses : []).map((s) => [s?.vcenterId, s]));
  const rowBy = new Map();
  const vcRow = (id) => {
    let r = rowBy.get(id);
    if (!r) {
      r = {
        id, name: null, version: null, build: null, collectSource: null,
        vms: 0, templates: 0, poweredOn: 0, toolsRunning: 0, toolsKnown: 0, tools112: 0,
        read: 0, asked: 0, detailed: 0, detailedOff: 0, vapp: 0, managed: 0, cfgRead: 0,
        noDetail: Object.fromEntries(NO_DETAIL_REASONS.map((k) => [k, 0])),
        status: null,
      };
      rowBy.set(id, r);
    }
    return r;
  };
  for (const vc of Array.isArray(vcenters) ? vcenters : []) {
    if (!vc || typeof vc.id !== 'string') continue;
    const r = vcRow(vc.id);
    r.name = typeof vc.name === 'string' ? vc.name : null;
    r.version = typeof vc.version === 'string' ? vc.version : null;
    r.build = typeof vc.build === 'string' ? vc.build : null;
    // 점검 1회차: 수집 상태가 없는 이유를 단정하지 않게 경로를 싣는다 — 'site'(엣지 수집) · 'direct'(이 포탈이 수집).
    r.collectSource = vc.collectSource === 'site' ? 'site' : 'direct';
  }
  const samples = new Map();
  const raws = new Map();
  const extras = new Map();
  const vapps = new Map();
  const managed = new Map();
  // cfgRead(점검 2회차): 시스템 VM(managedBy)은 vm.cfg 를 읽은 VM 에서만 셀 수 있다 — 못 읽은 VM 을 0 으로 섞지 않게 분모를 함께 싣는다.
  // unparsedVms: 형식을 못 읽은 원문(raw)이 있는 VM 수(가짓수 상한과 무관한 전체 — 화면이 목록 합으로 세지 않게).
  const total = { vms: 0, templates: 0, poweredOn: 0, toolsRunning: 0, toolsKnown: 0, tools112: 0, read: 0, asked: 0, detailed: 0, detailedOff: 0, vapp: 0, managed: 0, cfgRead: 0, unparsedVms: 0, extraDropped: 0 };
  const noDetail = Object.fromEntries(NO_DETAIL_REASONS.map((k) => [k, 0]));

  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!vm || typeof vm !== 'object') continue;
    const r = vcRow(String(vm.vcenterId ?? ''));
    const add = (k) => { r[k] += 1; total[k] += 1; };
    const on = vm.powerState === 'POWERED_ON';
    if (vm.template) add('templates'); else add('vms');
    if (on) add('poweredOn');
    if (vm.toolsStatus === 'RUNNING') add('toolsRunning');
    const t = toolsAtLeast(vm.toolsVersion, 11, 2);
    if (t != null) add('toolsKnown');
    if (t === true) add('tools112');
    const g = vm.gos && typeof vm.gos === 'object' ? vm.gos : null;
    const cfgOk = vm.cfg != null && typeof vm.cfg === 'object' && !Array.isArray(vm.cfg);
    if (cfgOk) add('cfgRead');
    const mb = cfgOk ? vm.cfg.managedBy : null;
    if (mb && (mb.extensionKey || mb.type)) {
      add('managed');
      const key = JSON.stringify([mb.extensionKey || '', mb.type || '']);   // 값에 구분자가 들어가도 다른 항목이 합쳐지지 않게
      const e = managed.get(key) || { key, extensionKey: mb.extensionKey || null, type: mb.type || null, count: 0 };
      e.count += 1; managed.set(key, e);
    }
    if (g) {
      add('read');
      if (g.asked) add('asked');
      if (g.vapp) {
        add('vapp');
        const v = g.vapp;
        const key = JSON.stringify([v.name || '', v.vendor || '', v.version || '']);
        // 점검 2회차: fullVersion 은 묶음 키가 아니라 갈릴 수 있다 — 첫 VM 값으로 덮지 않고 값별 개수로.
        const e = vapps.get(key) || { key, name: v.name || null, vendor: v.vendor || null, version: v.version || null, full: new Map(), count: 0, os: new Map() };
        e.count += 1;
        if (v.fullVersion) bump(e.full, v.fullVersion, 1);
        if (g.detailed?.prettyName) bump(e.os, g.detailed.prettyName, 1);
        vapps.set(key, e);
      }
      if (Number.isSafeInteger(g.extraDropped) && g.extraDropped > 0) total.extraDropped += g.extraDropped;
      if (g.extra && typeof g.extra === 'object') {
        for (const [k, v] of Object.entries(g.extra)) {
          const e = extras.get(k) || { key: k, count: 0, example: typeof v === 'string' ? v : null };
          e.count += 1; extras.set(k, e);
        }
      }
      if (typeof g.raw === 'string' && g.raw) {
        const e = raws.get(g.raw) || { key: g.raw, raw: g.raw, count: 0 };
        e.count += 1; raws.set(g.raw, e);
        total.unparsedVms += 1;
      }
    }
    const d = g?.detailed && typeof g.detailed === 'object' ? g.detailed : null;
    if (d) {
      add('detailed');
      if (!on) add('detailedOff');
      // 점검 1회차: 아키텍처도 묶음 키에(같은 이름 · 다른 아키텍처를 한 줄로 합치지 않는다). 묶음 안에서 갈릴 수 있는 칸(addl · cpe · build)은
      //   첫 VM 값 하나로 덮지 않고 값별 개수로 센다(kernels 와 같은 방식).
      const key = JSON.stringify([d.familyName, d.distroName, d.distroVersion, d.prettyName, d.bitness, d.architecture].map((x) => x || ''));
      let e = samples.get(key);
      if (!e) {
        e = {
          key, familyName: d.familyName || null, distroName: d.distroName || null, distroVersion: d.distroVersion || null,
          prettyName: d.prettyName || null, bitness: d.bitness || null, architecture: d.architecture || null,
          addl: new Map(), cpe: new Map(), build: new Map(),
          count: 0, poweredOn: 0, vcenters: new Set(), kernels: new Map(), configOs: new Map(), toolsGuestId: new Map(), appliance: 0, managed: 0,
        };
        samples.set(key, e);
      }
      e.count += 1;
      if (on) e.poweredOn += 1;
      e.vcenters.add(String(vm.vcenterId ?? ''));
      if (d.kernelVersion) bump(e.kernels, d.kernelVersion, 1);
      if (d.distroAddlVersion) bump(e.addl, d.distroAddlVersion, 1);
      if (d.cpeString) bump(e.cpe, d.cpeString, 1);
      if (d.buildNumber) bump(e.build, d.buildNumber, 1);
      bump(e.configOs, typeof vm.guestOS === 'string' && vm.guestOS ? vm.guestOS : '—', 1);
      if (vm.cfg?.guestIdTools) bump(e.toolsGuestId, vm.cfg.guestIdTools, 1);
      // 어플라이언스 = 제품 정보(OVF)가 있는 VM 만. 확장이 관리하는 VM(managedBy — 복제본 · vCLS 등)은 따로 센다(복제본을 어플라이언스라 부르지 않는다).
      if (g.vapp) e.appliance += 1;
      if (mb && (mb.extensionKey || mb.type)) e.managed += 1;
    } else {
      const why = noDetailReason(vm);
      r.noDetail[why] += 1; noDetail[why] += 1;
    }
  }

  for (const r of rowBy.values()) {
    // 점검 2회차: 엣지 수집(site) vCenter 에는 이 포탈의 상태를 붙이지 않는다 — 직접 수집하다 엣지로 바꾸면 낡은 오류 · 시각이 '지금 상태' 처럼 보였다.
    const s = r.collectSource === 'site' ? null : stBy.get(r.id);
    r.status = s ? {
      osAt: Number.isFinite(s.osAt) ? s.osAt : null, osError: typeof s.osError === 'string' ? s.osError : null,
      osErrorAt: Number.isFinite(s.osErrorAt) ? s.osErrorAt : null,
      osAsked: typeof s.osAsked === 'boolean' ? s.osAsked : null, apiVersion: typeof s.osApiVersion === 'string' ? s.osApiVersion : null,
      osFetched: Number.isFinite(s.osFetched) ? s.osFetched : null, osCut: Number.isFinite(s.osCut) ? s.osCut : null,
      osSkippedAt: Number.isFinite(s.osSkippedAt) ? s.osSkippedAt : null, osSkipReason: typeof s.osSkipReason === 'string' ? s.osSkipReason : null,
      osBackoffUntil: Number.isFinite(s.osBackoffUntil) && s.osBackoffUntil > now ? s.osBackoffUntil : null,
    } : null;
  }

  const sampleList = topList(samples, SAMPLE_MAX, (e) => {
    const o = {
      familyName: e.familyName, distroName: e.distroName, distroVersion: e.distroVersion,
      prettyName: e.prettyName, bitness: e.bitness, architecture: e.architecture,
      count: e.count, poweredOn: e.poweredOn, vcenters: e.vcenters.size, appliance: e.appliance, managed: e.managed,
    };
    putTop(o, 'distroAddlVersion', e.addl); putTop(o, 'cpeString', e.cpe); putTop(o, 'buildNumber', e.build);
    putTop(o, 'kernels', e.kernels); putTop(o, 'configOs', e.configOs); putTop(o, 'toolsGuestId', e.toolsGuestId);
    return o;
  });
  const vappList = topList(vapps, VAPP_MAX, (e) => putTop(putTop({ name: e.name, vendor: e.vendor, version: e.version, count: e.count }, 'fullVersions', e.full), 'os', e.os));
  const rawList = topList(raws, RAW_MAX, (e) => ({ raw: e.raw, count: e.count }));
  const extraList = topList(extras, 50, (e) => ({ key: e.key, count: e.count, example: e.example }));
  const managedList = topList(managed, MANAGED_MAX, (e) => ({ extensionKey: e.extensionKey, type: e.type, count: e.count }));
  return {
    schema: PROBE_SCHEMA,
    generatedAt: now,
    total, noDetail,
    vcenters: [...rowBy.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))),
    samples: sampleList.items, samplesOmitted: sampleList.omitted,
    unparsed: rawList.items, unparsedOmitted: rawList.omitted,
    extraKeys: extraList.items, extraKeysOmitted: extraList.omitted,
    appliances: vappList.items, appliancesOmitted: vappList.omitted,
    managedBy: managedList.items, managedByOmitted: managedList.omitted,
  };
}
