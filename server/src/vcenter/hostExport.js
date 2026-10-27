/**
 * vcenter/hostExport.js — '호스트 · 클러스터 엑셀' 의 내용(순수, v2.802 — 승인 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX).
 *
 * 사용자 요청(2026-10-27): "호스트 및 클러스터 정보로 VM 처럼 멋지게 · 호스트에는 정보가 많으니 호스트 1개에 엑셀 sheet 1개 ·
 *   최대한 자세하고 많은 정보" — 결정: 시안대로 · 표준 검증.
 *
 * 판정을 새로 하지 않는다 — 이미 있는 판정 함수를 부르고 글자·숫자만 모은다:
 *   · 구성·보안: hostcfg/parse.js hostCfgFindings + clusterDrift(ESXi 호스트 구성 점검과 같은 판정) · 글자는 hostcfg/text.js
 *   · 최근 재부팅: hostcfg/reboots.js analyzeReboots(라우트가 이벤트를 읽어 넘긴다)
 *   · 하드웨어: idrac/invView.js inventoryView 의 partState(파트 장애와 같은 판정 — 라우트가 iDRAC 등록부·인벤토리를 넘긴다)
 * 못 읽은 값은 0 이 아니다 — null 로 두고 칸은 '—' · '수집 안 됨'. 부분 합은 따로 센다(unknown).
 * 권한으로 뺀 묶음은 omitted[묶음] = 사유(엑셀 '읽는 법' 과 그 자리에 적는다 — 조용히 빼지 않는다).
 * ⚠ store·DB·등록부를 import 하지 않는다(라우트가 읽어 넘긴다 — 테스트가 순수 함수로 부른다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { hostCfgFindings, clusterDrift, HOST_CFG_CODES } from '../hostcfg/parse.js';
import { hostCfgTableRows, HOST_CFG_TITLE, DRIFT_LABEL, SEV_LABEL, REBOOT_LABEL } from '../hostcfg/text.js';
import { recentBackupYn } from '../veeam/backupStatus.js';
import { clusterRefMode } from '../clustercfg/analyze.js';   // 클러스터 묶음 규칙 한 벌(v2.742 VC-05 — 모든 클러스터 호스트가 ref 를 실었을 때만 ref 로 묶는다)

const DAY = 86_400_000;
export const HOST_EXPORT_PARTS = Object.freeze(['sec', 'net', 'st', 'hw', 'boot', 'vm', 'vmVeeam']);
export const RESERVED_SHEETS = Object.freeze(['요약', '클러스터', '호스트 목록', '읽는 법']);
export const SHEET_NAME_MAX = 31;
export const HOSTS_MAX = 300;   // 한 파일의 호스트 시트 상한(엑셀은 시트 수 제한이 없지만 파일이 커지고 만드는 시간이 늘어난다 — 넘으면 클러스터를 고르게 한다)
const SEV_ORDER = { crit: 0, warn: 1, info: 2 };
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const STATE_TEXT = Object.freeze({ CONNECTED: '연결됨', MAINTENANCE: '유지보수', DISCONNECTED: '연결 끊김' });

/**
 * 호스트 시트 이름 — 엑셀 규칙(31자 · \ / ? * [ ] : 금지 · 대소문자 무시 중복 금지 · 작은따옴표로 시작·끝 금지).
 * FQDN 이면 첫 마디(az-adm-esx01), 그 이름이 겹치면 전체 이름, 그래도 겹치면 '~2' 처럼 번호. 예약 시트 이름과도 겹치지 않는다.
 * @returns {Map<string,string>} host.id → 시트 이름
 */
export function hostSheetNames(hosts) {
  const clean = (s) => String(s || '').replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim() || '호스트';
  const short = (h) => clean(String(h.name || '').split('.')[0]);
  const shortCount = new Map();
  for (const h of hosts) { const k = short(h).toLowerCase(); shortCount.set(k, (shortCount.get(k) || 0) + 1); }
  const used = new Set(RESERVED_SHEETS.map((x) => x.toLowerCase()));
  const out = new Map();
  for (const h of hosts) {
    let base = shortCount.get(short(h).toLowerCase()) > 1 ? clean(h.name) : short(h);
    base = base.slice(0, SHEET_NAME_MAX);
    let name = base; let n = 2;
    while (used.has(name.toLowerCase())) { const tail = `~${n++}`; name = base.slice(0, SHEET_NAME_MAX - tail.length) + tail; }
    used.add(name.toLowerCase());
    out.set(h.id, name);
  }
  return out;
}

/**
 * 한 vCenter 안의 클러스터 열쇠 — 'r:<moref>'(그 vCenter 의 클러스터 호스트가 전부 ref 를 실었을 때) · 'n:<이름>' · 'standalone'.
 * 화면 창이 이 열쇠로 클러스터를 고른다(상태 응답이 열쇠·이름을 준다). 같은 이름이 둘 이상이면 이름 뒤에 데이터센터를 붙인다.
 */
export function clusterKeys(hosts, vcId) {
  const refMode = clusterRefMode(hosts).get(vcId) === true;
  const keyOf = (h) => (!h.cluster || h.cluster === 'standalone' ? 'standalone' : refMode && h.clusterRef ? `r:${h.clusterRef}` : `n:${h.cluster}`);
  const keysByName = new Map();
  for (const h of hosts) {
    if (h.vcenterId !== vcId) continue;
    const k = keyOf(h); const n = String(h.cluster || '').toLowerCase();
    if (!keysByName.has(n)) keysByName.set(n, new Set());
    keysByName.get(n).add(k);
  }
  const labelOf = (h) => (keyOf(h) === 'standalone' ? '독립 호스트' : keysByName.get(String(h.cluster).toLowerCase())?.size > 1 ? `${h.cluster} · ${h.vcDatacenter || h.clusterRef || '?'}` : h.cluster);
  return { keyOf, labelOf, refMode };
}

/** 상태 응답용 — 이 vCenter 의 클러스터 목록(열쇠 · 이름 · 호스트 수 · 이름 순). */
export function clusterChoices(hosts, vcId) {
  const { keyOf, labelOf } = clusterKeys(hosts, vcId);
  const m = new Map();
  for (const h of hosts) {
    if (h.vcenterId !== vcId) continue;
    const k = keyOf(h);
    if (!m.has(k)) m.set(k, { key: k, name: labelOf(h), hosts: 0 });
    m.get(k).hosts += 1;
  }
  return [...m.values()].sort((a, b) => (a.key === 'standalone') - (b.key === 'standalone') || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** 호스트 VM 들의 vCPU·메모리(GB) 합 — 못 읽은 VM 은 unknown 으로 따로. 템플릿은 세지 않는다(켤 수 없는 VM — 표에는 '템플릿' 으로 싣는다). */
function vmSums(vms) {
  let vcpu = 0; let mem = 0; let vcpuUnknown = 0; let memUnknown = 0; let on = 0; let n = 0;
  for (const v of vms) {
    if (v.template === true) continue;
    n++;
    const c = numOrNull(v.cpuCount); if (c == null) vcpuUnknown++; else vcpu += c;
    const m = numOrNull(v.memMB); if (m == null) memUnknown++; else mem += m / 1024;
    if (v.powerState === 'POWERED_ON') on++;
  }
  return { n, vcpu, mem: r1(mem), vcpuUnknown, memUnknown, on };
}
const ratio = (a, b) => (fin(a) && fin(b) && b > 0 ? r1(a / b) : null);

/** iDRAC 인벤토리(inventoryView 결과) → 묶음별 상태 셈. partState: ok|warn|fault|unknown|absent. */
export const HW_GROUPS = Object.freeze([['psus', '전원 공급'], ['fans', '팬'], ['disks', '디스크'], ['memoryDimms', '메모리 DIMM'], ['cpus', 'CPU'], ['storageControllers', '컨트롤러'], ['gpus', 'GPU']]);
export function hwSummary(view) {
  if (!view || typeof view !== 'object') return null;
  const groups = [];
  for (const [k, label] of HW_GROUPS) {
    if (!Array.isArray(view[k]) || !view[k].length) continue;
    const c = { ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0 };
    for (const x of view[k]) { const s = x?.partState; if (Object.hasOwn(c, s)) c[s] += 1; else c.unknown += 1; }
    const present = c.ok + c.warn + c.fault + c.unknown;
    groups.push({ key: k, label, ...c, present, state: c.fault ? 'fault' : c.warn ? 'warn' : c.unknown ? 'unknown' : present ? 'ok' : '' });
  }
  const bad = [];
  for (const [k, label] of HW_GROUPS) {
    for (const x of Array.isArray(view[k]) ? view[k] : []) {
      if (x?.partState === 'warn' || x?.partState === 'fault') bad.push({ group: label, name: String(x.name || x.id || x.model || '').slice(0, 80), state: x.partState, health: String(x.health || '').slice(0, 32) });
    }
  }
  return {
    bios: view.system?.biosVersion || '', idracFw: view.idrac?.firmwareVersion || '', health: view.system?.health || '',
    model: view.system?.model || '', serial: view.system?.serialNumber || '', groups, bad: bad.slice(0, 40),
  };
}

/**
 * 한 vCenter 의 호스트·클러스터 엑셀 내용.
 * @param {{ vc:object, hosts:object[], vms:object[], datastores:object[] }} src  라우트가 범위를 확인한 그 vCenter 의 스냅샷 조각
 * @param {{ clusters?:string[]|null, parts?:Set<string>, access?:{hygiene:boolean, cluster:boolean, hw:boolean},
 *           idracFor?:(host)=>object|null|undefined, reboots?:Map<string,object>|null, veeam?:{linked:boolean, byId:Map}|null,
 *           now?:number, offsetMin?:number }} o
 *   idracFor: host → inventoryView(inv) · null(등록 안 됨) · undefined(등록됐는데 인벤토리를 아직 못 읽음)
 */
export function buildHostExport(src, o = {}) {
  const now = o.now ?? Date.now();
  const parts = o.parts instanceof Set ? o.parts : new Set(HOST_EXPORT_PARTS.filter((p) => p !== 'vmVeeam'));
  const access = { hygiene: true, cluster: true, hw: true, ...(o.access || {}) };
  const vc = src.vc || {};
  const allHosts = (src.hosts || []).filter((h) => h.vcenterId === vc.id);
  const { keyOf: clusterKey, labelOf: clusterLabel, refMode } = clusterKeys(allHosts, vc.id);
  const want = Array.isArray(o.clusters) && o.clusters.length ? new Set(o.clusters) : null;
  const hosts = allHosts.filter((h) => !want || want.has(clusterKey(h)))
    .sort((a, b) => (clusterKey(a) === 'standalone') - (clusterKey(b) === 'standalone') || clusterLabel(a).localeCompare(clusterLabel(b), 'en', { numeric: true })
      || String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
  const omitted = {};
  if (!access.hygiene) { if (parts.has('sec')) omitted.sec = '이 계정은 ‘ESXi 호스트 구성 점검’ 도구 권한이 없어 넣지 않았습니다.'; if (parts.has('boot')) omitted.boot = omitted.sec || '이 계정은 ‘ESXi 호스트 구성 점검’ 도구 권한이 없어 넣지 않았습니다.'; }
  if (!access.cluster) omitted.cluster = '이 계정은 ‘클러스터 점검’ 도구 권한이 없어 HA · DRS · EVC 를 넣지 않았습니다.';
  if (!access.hw && parts.has('hw')) omitted.hw = 'iDRAC 하드웨어 정보는 관리자 판본에만 넣습니다.';
  const use = (p) => parts.has(p) && !omitted[p];

  const vmsByHost = new Map();
  for (const v of src.vms || []) {
    if (v.vcenterId !== vc.id || !v.host) continue;
    if (!vmsByHost.has(v.host)) vmsByHost.set(v.host, []);
    vmsByHost.get(v.host).push(v);
  }
  const dsByName = new Map((src.datastores || []).filter((d) => d.vcenterId === vc.id).map((d) => [d.name, d]));
  const cfgByRef = new Map((vc.clusterCfg || []).map((c) => [c.ref, c]));
  const cfgByName = new Map((vc.clusterCfg || []).map((c) => [c.name, c]));
  // 구성 찾기 — ref 모드면 ref 로만(같은 이름 다른 데이터센터를 섞지 않는다), 이름 모드면 이름으로. 독립 호스트는 구성이 없다.
  const cfgOf = (h) => (!access.cluster || clusterKey(h) === 'standalone' ? null : (refMode ? cfgByRef.get(h.clusterRef) : cfgByName.get(h.cluster)) || null);
  const { perHost: drift } = clusterDrift(allHosts);
  const names = hostSheetNames(hosts);

  const outHosts = [];
  for (const h of hosts) {
    const vms = (vmsByHost.get(h.name) || []).slice().sort((a, b) => (a.template === true) - (b.template === true) || String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
    const s = vmSums(vms);
    const cores = numOrNull(h.cpuCores); const memGB = fin(h.memTotalMB) && h.memTotalMB > 0 ? r1(h.memTotalMB / 1024) : null;
    const connected = h.connectionState !== 'DISCONNECTED';
    const ccfg = cfgOf(h);
    // 구성·보안 — 판정 코드(ESXi 호스트 구성 점검과 같은 함수) + 행 글자
    // 판정은 한 번(구성 점검 권한이 있을 때) — '구성 · 보안' 표와 '업링크 끊김' 칸이 같은 판정을 쓴다.
    const base = access.hygiene && connected ? hostCfgFindings(h, now) : null;
    const upDown = base ? base.find((f) => f.code === 'net-uplink-down') : null;
    const uplinkDown = !base || !h.hcfg?.net ? null : upDown ? upDown.facts.count : 0;
    let sec = null;
    if (use('sec')) {
      const findings = base ? [...base] : [];
      for (const d of drift.get(h.id) || []) findings.push({ code: 'drift', sev: 'info', facts: d });
      findings.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
      const t = hostCfgTableRows(h, { now, offsetMin: o.offsetMin });
      const rows = t.rows.map((r) => {
        const hit = findings.filter((f) => r.codes.includes(f.code));
        const top = hit[0] || null;
        return { label: r.label, value: r.value, sev: top ? top.sev : '', verdict: top ? `${top.sev === 'crit' ? '✕' : top.sev === 'warn' ? '⚠' : 'ⓘ'} ${HOST_CFG_TITLE[top.code] || top.code}` : r.value === '—' || !r.codes.length ? '' : '✓' };
      });
      for (const f of findings.filter((x) => x.code === 'drift')) {
        rows.push({ label: `클러스터와 다름: ${DRIFT_LABEL[f.facts?.field] || f.facts?.field || ''}`, value: `이 호스트 ${f.facts?.value ?? '—'} · 다수 ${f.facts?.majority ?? '—'}`, sev: 'info', verdict: `ⓘ ${HOST_CFG_TITLE.drift}` });
      }
      sec = {
        state: !connected ? 'disconnected' : t.state, at: h.hcfg?.at ?? null, rows,
        counts: { crit: findings.filter((f) => f.sev === 'crit').length, warn: findings.filter((f) => f.sev === 'warn').length, info: findings.filter((f) => f.sev === 'info').length },
        findings: findings.map((f) => ({ code: f.code, sev: f.sev, sevText: SEV_LABEL[f.sev], title: HOST_CFG_TITLE[f.code] || f.code })),
      };
    }
    // 네트워크 — 물리 NIC(인벤토리) + 스위치·포트그룹(구성 캐시: 구성 점검 권한)
    const swOfNic = new Map();
    const net = use('net') ? {
      nics: (Array.isArray(h.nics) ? h.nics : []).map((n) => ({ device: n.device || '', model: [n.vendor, n.model].filter(Boolean).join(' ') || '', speedMb: fin(n.speedMb) ? n.speedMb : null, maxSpeedMb: fin(n.maxSpeedMb) && n.maxSpeedMb > 0 ? n.maxSpeedMb : null, link: n.link === true ? true : n.link === false ? false : null, mac: n.mac || '', driver: n.driver || '' })),
      switches: null, pgs: null, pgsTotal: null,
    } : null;
    if (net && access.hygiene && h.hcfg?.net) {
      net.switches = (h.hcfg.net.switches || []).map((x) => ({ name: x.name, kind: x.kind === 'dvs' ? '분산' : '표준', uplinks: Array.isArray(x.uplinks) ? x.uplinks : [], pgs: fin(x.pgs) ? x.pgs : null }));
      for (const x of net.switches) for (const u of x.uplinks) swOfNic.set(u, x.name);
      net.pgs = (h.hcfg.net.pgs || []).slice(0, 200).map((p) => ({ name: p.name, vlan: p.vlan ?? null, sw: p.sw || '', promisc: p.promisc === true ? true : p.promisc === false ? false : null }));
      net.pgsTotal = fin(h.hcfg.net.pgsTotal) ? h.hcfg.net.pgsTotal : net.pgs.length;
      for (const n of net.nics) n.sw = swOfNic.get(n.device) || '';
    }
    // 스토리지 — HBA(인벤토리) · 멀티패스(구성 캐시) · 이 호스트 VM 이 쓰는 데이터스토어(VM 장치 캐시)
    let st = null;
    if (use('st')) {
      const dsUse = new Map(); let vmNoDev = 0;
      for (const v of vms) {
        const disks = v.dev?.disks;
        if (!Array.isArray(disks)) { vmNoDev++; continue; }
        for (const n of new Set(disks.map((d) => d.datastore).filter(Boolean))) dsUse.set(n, (dsUse.get(n) || 0) + 1);
      }
      st = {
        hbas: (Array.isArray(h.hbas) ? h.hbas : []).map((b) => ({ name: b.name || '', model: b.model || '', type: b.type || '', speedGbps: fin(b.speedGbps) ? b.speedGbps : null, wwn: b.wwn || '', status: b.status || '' })),
        mp: access.hygiene && h.hcfg?.mp ? { ...h.hcfg.mp } : null,
        datastores: [...dsUse.entries()].map(([name, n]) => { const d = dsByName.get(name); return { name, vms: n, type: d?.type || '', capGB: d ? numOrNull(d.capacityGB) : null, freeGB: d ? d.freeGB ?? null : null, pct: d ? d.usagePct ?? null : null, accessible: d ? d.accessible !== false : null }; })
          .sort((a, b) => b.vms - a.vms || a.name.localeCompare(b.name)),
        vmNoDev,
      };
    }
    // 하드웨어(iDRAC — 관리자 판본)
    let hw = null;
    if (use('hw')) {
      const v = typeof o.idracFor === 'function' ? o.idracFor(h) : null;
      hw = v === undefined ? { state: 'pending' } : v ? { state: 'ok', ...hwSummary(v) } : { state: 'none' };
    }
    // 최근 재부팅
    let boot = null;
    if (use('boot')) {
      const r = o.reboots ? o.reboots.get(h.id) : null;
      boot = r ? { kind: r.kind, label: REBOOT_LABEL[r.kind] || r.kind, bootTime: r.bootTime, evidence: r.evidence || null, notCollected: r.notCollected || null } : null;
    }
    // VM 목록
    const vmRows = use('vm') ? vms.map((v) => {
      const disks = Array.isArray(v.dev?.disks) ? v.dev.disks : null;
      const row = {
        name: v.name || '', power: v.template === true ? '템플릿' : v.powerState || '', vcpu: numOrNull(v.cpuCount), memGB: fin(v.memMB) ? r1(v.memMB / 1024) : null,
        cpuPct: numOrNull(v.cpuUsagePct), memPct: numOrNull(v.memUsagePct), storGB: numOrNull(v.storageGB),
        ds: disks ? [...new Set(disks.map((d) => d.datastore).filter(Boolean))].join(', ') : null, folder: String(v.folder || '').split('/').filter((x) => x && x !== 'vm').join('/'),
        guestOS: v.guestOS || '', ip: v.ipAddress || '', snapshots: numOrNull(v.snapshotCount), tools: v.toolsStatus || '',
      };
      if (parts.has('vmVeeam')) {
        const view = o.veeam ? o.veeam.byId?.get(v.id) : undefined;
        row.veeamYn = o.veeam ? recentBackupYn(view, { linked: o.veeam.linked !== false, days: 1, now }) : null;
        row.veeamLast = view?.v && fin(view.v.lb) && view.v.lb > 0 ? view.v.lb : null;
      }
      return row;
    }) : null;

    outHosts.push({
      id: h.id, name: h.name, sheet: names.get(h.id), cluster: clusterLabel(h), clusterKey: clusterKey(h), dc: h.vcDatacenter || '',
      state: STATE_TEXT[h.connectionState] || h.connectionState || '', stateCode: h.connectionState || '', power: h.powerState === 'POWERED_ON' ? '켜짐' : h.powerState ? '꺼짐' : '',
      vendor: h.vendor || '', model: h.model || '', serviceTag: h.serviceTag || '', cpuModel: h.cpuModel || '',
      sockets: numOrNull(h.cpuSockets), cores, threads: numOrNull(h.cpuThreads), mhz: fin(h.cpuTotalMhz) && cores ? Math.round(h.cpuTotalMhz / cores) : null,
      memGB, version: h.version || '', build: h.build || '', mgmtIp: h.mgmtIp || '', mgmtServerIp: h.mgmtServerIp || '',
      gpus: (Array.isArray(h.gpus) ? h.gpus : []).map((g) => ({ model: g.model || '', memGB: g.memGB ?? null, mode: g.mode || '' })),
      cpuPct: connected ? numOrNull(h.cpuUsagePct) : null, memPct: connected ? numOrNull(h.memUsagePct) : null,
      cpuUsedMhz: connected ? numOrNull(h.cpuUsageMhz) : null, cpuTotalMhz: numOrNull(h.cpuTotalMhz),
      memUsedGB: connected && fin(h.memUsageMB) ? r1(h.memUsageMB / 1024) : null,
      vms: s.n, vmOn: s.on, templates: vms.length - s.n, vcpu: s.vcpuUnknown === s.n && s.n ? null : s.vcpu, vcpuUnknown: s.vcpuUnknown, vmMemGB: s.memUnknown === s.n && s.n ? null : s.mem, vmMemUnknown: s.memUnknown,
      cpuRatio: s.vcpuUnknown ? null : ratio(s.vcpu, cores), memRatio: s.memUnknown ? null : ratio(s.mem, memGB),
      bootTime: fin(h.bootTime) ? h.bootTime : null, uptimeDays: fin(h.bootTime) && connected ? Math.max(0, Math.floor((now - h.bootTime) / DAY)) : null,
      tempC: numOrNull(h.tempC), tempMaxC: numOrNull(h.tempMaxC), temps: (Array.isArray(h.temps) ? h.temps : []).slice(0, 12).map((t) => ({ name: t.name, c: t.c })),
      powerW: numOrNull(h.powerWatts ?? h.vcPowerWatts),
      clusterCfg: ccfg ? { ha: ccfg.ha, drs: ccfg.drs, evc: ccfg.evc, rulesTotal: ccfg.rulesTotal ?? (Array.isArray(ccfg.rules) ? ccfg.rules.length : null), rulesOk: Array.isArray(ccfg.rules) ? ccfg.rules.filter((r) => r.inCompliance !== false).length : null, numHosts: ccfg.numHosts ?? null, numEffectiveHosts: ccfg.numEffectiveHosts ?? null } : null,
      sec, net, st, hw, boot, vmRows,
      // 링크 내려간 물리 NIC(쓰지 않는 포트도 센다 — 사실) · 그중 쓰는 스위치의 업링크(구성 점검 net-uplink-down 판정 — 모르면 null)
      nicLinkDown: Array.isArray(h.nics) && h.nics.length ? h.nics.filter((n) => n.link === false).length : null, uplinkDown,
    });
  }
  // 클러스터 표
  const byCl = new Map();
  for (const h of outHosts) {
    let c = byCl.get(h.clusterKey);
    if (!c) {
      const ccfg = cfgOf(hosts.find((x) => x.id === h.id));
      c = { key: h.clusterKey, name: h.cluster, hosts: 0, connected: 0, vms: 0, vmOn: 0, cores: 0, coresUnknown: 0, memGB: 0, memUnknown: 0, cpuUsed: 0, cpuTotal: 0, memUsed: 0, memTotal: 0, vcpu: 0, vmMem: 0, vcpuUnknown: 0, vmMemUnknown: 0, builds: new Set(), firstSheet: h.sheet, cfg: ccfg };
      byCl.set(h.clusterKey, c);
    }
    c.hosts++; if (h.stateCode !== 'DISCONNECTED') c.connected++;
    c.vms += h.vms; c.vmOn += h.vmOn;
    if (h.cores == null) c.coresUnknown++; else c.cores += h.cores;
    if (h.memGB == null) c.memUnknown++; else c.memGB += h.memGB;
    if (h.cpuUsedMhz != null && h.cpuTotalMhz) { c.cpuUsed += h.cpuUsedMhz; c.cpuTotal += h.cpuTotalMhz; }
    if (h.memUsedGB != null && h.memGB) { c.memUsed += h.memUsedGB; c.memTotal += h.memGB; }
    c.vcpuUnknown += h.vcpuUnknown; c.vmMemUnknown += h.vmMemUnknown; c.vcpu += h.vcpu || 0; c.vmMem += h.vmMemGB || 0;
    if (h.build) c.builds.add(h.build);
  }
  const clusters = [...byCl.values()].map((c) => ({
    key: c.key, name: c.name, hosts: c.hosts, connected: c.connected, vms: c.vms, vmOn: c.vmOn, cores: c.coresUnknown ? null : c.cores, memGB: c.memUnknown ? null : r1(c.memGB),
    cpuPct: c.cpuTotal ? Math.round((c.cpuUsed / c.cpuTotal) * 100) : null, memPct: c.memTotal ? Math.round((c.memUsed / c.memTotal) * 100) : null,
    cpuRatio: c.coresUnknown || c.vcpuUnknown ? null : ratio(c.vcpu, c.cores), memRatio: c.memUnknown || c.vmMemUnknown ? null : ratio(c.vmMem, c.memGB),
    builds: [...c.builds], firstSheet: c.firstSheet,
    cfg: c.cfg ? { ha: c.cfg.ha, drs: c.cfg.drs, evc: c.cfg.evc, rulesTotal: c.cfg.rulesTotal ?? (Array.isArray(c.cfg.rules) ? c.cfg.rules.length : null), rulesOk: Array.isArray(c.cfg.rules) ? c.cfg.rules.filter((r) => r.inCompliance !== false).length : null, numHosts: c.cfg.numHosts ?? null, numEffectiveHosts: c.cfg.numEffectiveHosts ?? null, at: c.cfg.at ?? null } : null,
  }));
  // 확인할 것(요약) — 호스트별 사실을 센다(판정은 위에서 끝났다)
  const pick = (f) => outHosts.filter(f).map((h) => ({ name: h.name, sheet: h.sheet }));
  const checks = [
    { id: 'disc', label: '연결 끊김', hosts: pick((h) => h.stateCode === 'DISCONNECTED') },
    { id: 'maint', label: '유지보수 모드', hosts: pick((h) => h.stateCode === 'MAINTENANCE') },
    { id: 'uplinkDown', label: '쓰는 스위치의 업링크 링크 끊김', hosts: pick((h) => h.uplinkDown > 0) },
  ];
  if (use('sec')) {
    for (const code of ['cert-expired', 'cert-expiring', 'reboot-required', 'ssh-running', 'mp-dead', 'logs-lost', 'drift']) {
      checks.push({ id: code, label: HOST_CFG_TITLE[code], sev: HOST_CFG_CODES[code], hosts: pick((h) => h.sec?.findings.some((f) => f.code === code)) });
    }
  }
  if (use('hw')) checks.push({ id: 'hw', label: 'iDRAC 부품 경고 · 장애', hosts: pick((h) => h.hw?.state === 'ok' && h.hw.groups.some((g) => g.warn || g.fault)) });
  if (use('boot')) checks.push({ id: 'unexpected', label: REBOOT_LABEL.unexpected, hosts: pick((h) => h.boot?.kind === 'unexpected') });

  const sum = (k) => { let v = 0; let u = 0; for (const h of outHosts) { if (h[k] == null) u++; else v += h[k]; } return { sum: r1(v), unknown: u }; };
  return {
    meta: {
      clusterSel: want ? [...want] : null,
      vcenterId: vc.id, vcenterName: vc.name || vc.id, vcVersion: vc.version || '', location: vc.location ? [vc.location.city, vc.location.country].filter(Boolean).join(', ') : '',
      at: now, offsetMin: o.offsetMin, parts: [...parts].filter((p) => !omitted[p]), omitted, access, target: want ? `클러스터 ${want.size}개` : '전체', hostsTotal: allHosts.length,
      hcfgHosts: hosts.filter((h) => h.hcfg).length, clusterCfg: (vc.clusterCfg || []).length, bootDays: o.bootDays ?? 30,
      veeam: parts.has('vmVeeam') ? (o.veeam ? (o.veeam.linked === false ? 'unlinked' : 'ok') : 'unread') : '',
    },
    summary: {
      hosts: outHosts.length, connected: outHosts.filter((h) => h.stateCode === 'CONNECTED').length, maint: outHosts.filter((h) => h.stateCode === 'MAINTENANCE').length, disc: outHosts.filter((h) => h.stateCode === 'DISCONNECTED').length,
      clusters: clusters.length, cores: sum('cores'), sockets: sum('sockets'), threads: sum('threads'), memGB: sum('memGB'), memUsedGB: sum('memUsedGB'), vms: outHosts.reduce((s, h) => s + h.vms, 0), vmOn: outHosts.reduce((s, h) => s + h.vmOn, 0), templates: outHosts.reduce((s, h) => s + h.templates, 0),
      vcpu: sum('vcpu'), powerW: sum('powerW'), secWarn: outHosts.reduce((s, h) => s + (h.sec ? h.sec.counts.crit + h.sec.counts.warn : 0), 0), secHosts: outHosts.filter((h) => h.sec && h.sec.counts.crit + h.sec.counts.warn > 0).length,
    },
    clusters, checks, hosts: outHosts,
  };
}
