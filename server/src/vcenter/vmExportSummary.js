/**
 * vcenter/vmExportSummary.js — 'VM 전체 정보' 엑셀 '요약' 시트의 숫자(순수, v2.801 — 승인 시안 ② https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h).
 *
 * 고른 항목과 상관없이 **대상 VM 의 인벤토리·구성 캐시**로 센다(열을 무엇을 골랐든 같은 요약). Veeam 은 라우트가 읽은 판정(vmBackupView)이 있을 때만.
 * 못 읽은 값은 0 이 아니다 — 합에 넣지 않고 `unknown` 으로 따로 세고(부분 합이면 화면이 '≥' 와 함께 쓴다), 출처가 하나도 없으면 null('—').
 * ⚠ 이 파일은 워커가 아니라 메인에서 돈다(결과만 워커로 간다) — 그래도 store·DB import 를 넣지 말 것(테스트가 순수 함수로 부른다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { recentBackupYn } from '../veeam/backupStatus.js';

const DAY = 86_400_000;
export const SNAP_OLD_DAYS = 7;
export const CLUSTER_TOP = 12;
export const OS_TOP = 8;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function acc() { return { sum: 0, unknown: 0 }; }
function add(a, v) { const n = numOrNull(v); if (n == null) a.unknown += 1; else a.sum += n; }
const r1 = (v) => Math.round(v * 10) / 10;
const done = (a) => ({ sum: r1(a.sum), unknown: a.unknown });

/**
 * @param {Array<object>} vms 대상 VM(인벤토리 — cfg·dev 캐시가 붙어 있을 수 있다)
 * @param {{ views?:{ linked:boolean, byId:Map }|null, ynDays?:number, now?:number }} o
 */
export function vmExportSummary(vms, { views = null, ynDays = 1, now = Date.now() } = {}) {
  const list = Array.isArray(vms) ? vms : [];
  let on = 0; let off = 0; let other = 0;
  const cpu = acc(); const mem = acc(); const used = acc(); const prov = acc();
  let snapVms = 0; let snapUnknown = 0; let snapOld = 0; let snapOldUnknown = 0;
  let toolsBad = 0; let toolsUnknown = 0;
  let cfgBase = 0; let cons = 0; let question = 0; let devBase = 0; let cdrom = 0;
  const cl = new Map(); const os = new Map();
  const veeam = views ? { days: ynDays, yes: 0, no: 0, unknown: 0 } : null;
  for (const vm of list) {
    const p = vm?.powerState;
    if (p === 'POWERED_ON') on += 1; else if (p === 'POWERED_OFF') off += 1; else other += 1;
    add(cpu, vm?.cpuCount);
    const memMB = numOrNull(vm?.memMB);
    if (memMB == null) mem.unknown += 1; else mem.sum += memMB / 1024;
    add(used, vm?.storageGB);
    const c = numOrNull(vm?.storageGB); const u = numOrNull(vm?.uncommittedGB);
    if (c == null || u == null) prov.unknown += 1; else prov.sum += c + u;
    const sc = numOrNull(vm?.snapshotCount);
    if (sc == null) snapUnknown += 1;
    else if (sc > 0) {
      snapVms += 1;
      const t = numOrNull(vm.snapshotOldestTs);
      if (t == null || t <= 0) snapOldUnknown += 1;
      else if (now - t > SNAP_OLD_DAYS * DAY) snapOld += 1;
    }
    if (p === 'POWERED_ON' && vm.template !== true) {
      if (vm.toolsStatus == null || vm.toolsStatus === '') toolsUnknown += 1;
      else if (vm.toolsStatus !== 'RUNNING') toolsBad += 1;
    }
    if (vm?.cfg) { cfgBase += 1; if (vm.cfg.consolidationNeeded === true) cons += 1; if (vm.cfg.question) question += 1; }
    if (vm?.dev) { devBase += 1; if ((vm.dev.cdroms || []).some((x) => x && x.connected === true)) cdrom += 1; }
    const ck = vm?.cluster || '';
    let k = cl.get(ck);
    if (!k) { k = { name: ck, vms: 0, on: 0, cpu: acc(), mem: acc(), prov: acc() }; cl.set(ck, k); }
    k.vms += 1; if (p === 'POWERED_ON') k.on += 1;
    add(k.cpu, vm?.cpuCount);
    if (memMB == null) k.mem.unknown += 1; else k.mem.sum += memMB / 1024;
    if (c == null || u == null) k.prov.unknown += 1; else k.prov.sum += c + u;
    const on2 = String(vm?.guestOS || '').trim();
    os.set(on2, (os.get(on2) || 0) + 1);
    if (veeam) {
      const yn = recentBackupYn(views.byId?.get(vm.id), { linked: views.linked, days: ynDays, now });
      if (yn === '예') veeam.yes += 1; else if (yn === '아니오') veeam.no += 1; else veeam.unknown += 1;
    }
  }
  const clusters = [...cl.values()].sort((a, b) => b.vms - a.vms || String(a.name).localeCompare(String(b.name)))
    .map((x) => ({ name: x.name, vms: x.vms, on: x.on, cpu: done(x.cpu), memGB: done(x.mem), provGB: done(x.prov) }));
  const clusterRest = clusters.slice(CLUSTER_TOP);
  const osAll = [...os.entries()].map(([name, n]) => ({ name, vms: n })).sort((a, b) => b.vms - a.vms || a.name.localeCompare(b.name));
  return {
    vms: list.length, on, off, other,
    cpu: done(cpu), memGB: done(mem), usedGB: done(used), provGB: done(prov),
    snap: { vms: snapVms, unknown: snapUnknown, old: snapOld, oldUnknown: snapOldUnknown, oldDays: SNAP_OLD_DAYS },
    tools: { bad: toolsBad, unknown: toolsUnknown },
    cache: { cfg: cfgBase, dev: devBase },
    consolidation: cfgBase ? cons : null, question: cfgBase ? question : null, cdrom: devBase ? cdrom : null,
    veeam,
    clusters: clusters.slice(0, CLUSTER_TOP),
    clusterRest: clusterRest.length ? { count: clusterRest.length, vms: clusterRest.reduce((s, x) => s + x.vms, 0) } : null,
    os: osAll.slice(0, OS_TOP),
    osRest: osAll.length > OS_TOP ? { count: osAll.length - OS_TOP, vms: osAll.slice(OS_TOP).reduce((s, x) => s + x.vms, 0) } : null,
  };
}

/** 합 + 못 읽은 수 → 칸 글자('1,234' · 부분이면 '≥1,234' · 하나도 모르면 '—'). */
export function sumText(a, { digits = 0, total = null } = {}) {
  if (!a || (total != null && a.unknown >= total)) return '—';
  const v = digits ? Math.round(a.sum * 10 ** digits) / 10 ** digits : Math.round(a.sum);
  const t = v.toLocaleString('en-US', { maximumFractionDigits: digits });
  return a.unknown ? `≥${t}` : t;
}
export const pctOf = (n, d) => (fin(n) && fin(d) && d > 0 ? Math.round((n / d) * 100) : null);
