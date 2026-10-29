// vCenter 화면 '호스트 및 클러스터' 탭의 '호스트 · 클러스터 엑셀' 라우트(v2.802 — 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX).
//
// 게이트: data.csv(관리자 이상 — 웹 canCsv 와 같은 판정) · vCenter 단위 조회 범위 밖은 404(존재 여부 미노출 — v2.207 규칙).
//   묶음별로 그 기능의 권한을 따로 본다(파일 한 장이 다른 화면의 권한을 우회하지 않게) — 없으면 넣지 않고 그 자리와 '읽는 법' 에 사유를 적는다:
//     · 구성 · 보안 점검 · 최근 재부팅 · 가상 스위치 · 멀티패스 = 'ESXi 호스트 구성 점검'(tools 권한 + 도구 키 host-hygiene)
//     · HA · DRS · EVC = '클러스터 점검'(tools 권한 + 도구 키 cluster-check)
//     · iDRAC 하드웨어 = 관리자 판본(isAdminDetailUser — iDRAC API 가 관리자 전용이다)
//   내려받기는 동시 1건(exportBusy) + 감사 한 줄(라우트가 직접 — audit.js AUDIT_SKIP 에 등재해 두 줄을 막는다). 끊긴 요청은 멈춘다.
//   · GET  /tools/host-export/status  창에 그릴 것 — 클러스터 목록(열쇠 · 이름 · 호스트 수) · 출처 상태 · 넣을 수 있는 묶음
//   · POST /tools/host-export.xlsx    { clusters?:string[], parts?:string[] } → 엑셀(요약 · 클러스터 · 호스트 목록 · 호스트마다 1장 · 읽는 법)
// ⚠ 이 세그먼트(host-export)는 특수 기능 카드 키가 아니다 — auth/toolAccess.js UNMAPPED_TOOL_SEGMENTS 에 사유와 함께 선언했다.
import { requirePerm, toolActorOf } from '../../auth/auth.js';
import { inUserScope } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { issueFor } from '../../auth/toolAccess.js';
import { userHasPermission } from '../../auth/permissions.js';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { acquireExport } from '../../util/exportBusy.js';
import { fileStamp, DAY_OFFSET_MIN } from '../../util/dayKey.js';
import { tzName } from '../../vcenter/vmExportCatalog.js';
import { buildHostExport, clusterChoices, clusterKeys, HOST_EXPORT_PARTS, HOSTS_MAX } from '../../vcenter/hostExport.js';
import { renderHostExportWorkbook, XLSX_MIME } from '../../vcenter/hostExportXlsx.js';
import { analyzeReboots } from '../../hostcfg/reboots.js';
import { HOSTOPS_TYPES } from '../../vmchanges/eventDetail.js';
import { getLogsDb } from '../../logs/db.js';
import { eventNotCollectedMap } from '../../logs/coverage.js';
import { listRegistry } from '../../idrac/registry.js';
import { getInventory } from '../../idrac/invCache.js';
import { inventoryView } from '../../idrac/invView.js';
import { allRemoteServers } from '../../collector/remoteInventory.js';
import { veeamVmViews } from '../../veeam/vmViewProvider.js';

const csvPerm = requirePerm('data.csv');
export const BOOT_DAYS = 30;
const READ_MAX = 20_000;          // 재부팅 근거 이벤트 읽기 상한(hostHygiene.js 와 같다 — 넘으면 readFrom 으로 절단을 밝힌다)
const CLUSTER_KEY_MAX = 300;
const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** vCenter 단위 사용자 scope 를 먼저 강제하고, 범위 밖은 404(존재 여부 미노출). */
function vcOf(req, res) {
  const vcenterId = String(req.query.vcenterId || '');
  const snap = store.get();
  const vc = vcenterId ? (snap.vcenters || []).find((v) => v.id === vcenterId) : null;
  if (!vc || !inUserScope(req.user, snap, vcenterId)) {
    res.status(404).json({ ok: false, error: 'vCenter를 찾을 수 없습니다.', reason: 'vCenter를 찾을 수 없습니다.' });
    return null;
  }
  return { snap, vc };
}

/** 묶음별 권한 — 그 기능 화면과 같은 판정(권한 + 도구 키 · 관리자 판본). */
export function accessOf(req) {
  const actor = toolActorOf(req);
  const who = !config.auth.enabled ? { role: actor.role } : req.user;
  const tools = userHasPermission(who, 'tools');
  return {
    hygiene: tools && !issueFor(actor, 'host-hygiene'),
    cluster: tools && !issueFor(actor, 'cluster-check'),
    hw: isAdminDetailUser(req.user),
  };
}

/**
 * 본문 → 선택. 모르는 묶음·형식은 400(조용히 버리지 않는다). 고른 클러스터가 이 vCenter 에 없으면 400.
 * @returns {{ok:true, clusters:string[]|null, parts:Set<string>} | {ok:false, reason:string}}
 */
export function hostExportSelOf(body, validKeys) {
  const b = objOf(body);
  let parts = null;
  if (b.parts !== undefined) {
    if (!Array.isArray(b.parts) || b.parts.length > HOST_EXPORT_PARTS.length * 2 || b.parts.some((p) => !HOST_EXPORT_PARTS.includes(p))) return { ok: false, reason: '넣을 내용이 잘못됐습니다.' };
    parts = new Set(b.parts);
  } else parts = new Set(HOST_EXPORT_PARTS.filter((p) => p !== 'vmVeeam'));
  if (parts.has('vmVeeam') && !parts.has('vm')) parts.delete('vmVeeam');   // Veeam 은 VM 목록의 칸이다
  let clusters = null;
  if (b.clusters !== undefined && b.clusters !== null) {
    if (!Array.isArray(b.clusters) || b.clusters.length > CLUSTER_KEY_MAX || b.clusters.some((k) => typeof k !== 'string' || !k || k.length > 300)) return { ok: false, reason: '클러스터 선택이 잘못됐습니다.' };
    if (b.clusters.length === 0) return { ok: false, reason: '클러스터를 하나 이상 고르세요.' };
    if (b.clusters.some((k) => !validKeys.has(k))) return { ok: false, reason: '고른 클러스터를 이 vCenter 에서 찾을 수 없습니다 — 창을 닫았다 다시 여세요.' };
    clusters = [...new Set(b.clusters)];
  }
  return { ok: true, clusters, parts };
}

/** iDRAC 찾기 — 서비스 태그가 같은 등록부 항목(이 포탈) → 엣지가 보낸 원격 서버. null = 등록 안 됨 · undefined = 등록됐지만 인벤토리 없음. */
export function makeIdracFor({ registry = [], remote = [], getInv = getInventory } = {}) {
  const norm = (t) => String(t || '').trim().toLowerCase();
  const local = new Map(); for (const r of registry) if (norm(r?.serviceTag) && !local.has(norm(r.serviceTag))) local.set(norm(r.serviceTag), r);
  const rem = new Map(); for (const s of remote) if (norm(s?.serviceTag) && !rem.has(norm(s.serviceTag))) rem.set(norm(s.serviceTag), s);
  return (host) => {
    const tag = norm(host?.serviceTag);
    if (!tag) return null;
    const r = local.get(tag);
    if (r) {
      let raw = null;
      try { raw = getInv(String(r.id)); } catch { raw = null; }
      const inv = raw?.data || raw || null;
      return inv ? inventoryView(inv) : undefined;
    }
    const s = rem.get(tag);
    if (s) return s.inv ? inventoryView(s.inv) : undefined;
    return null;
  };
}

/** 재부팅 판정(hostHygiene.js /reboots 와 같은 입력 — 이 vCenter 만). */
async function rebootsOf(vc, hosts) {
  const db = await getLogsDb();
  const now = Date.now();
  const since = now - BOOT_DAYS * 86_400_000 - 86_400_000;
  const got = await db.opsEventsAsync({ vcenterIds: [vc.id], since, types: [...HOSTOPS_TYPES] }, READ_MAX + 1);
  const truncated = got.length > READ_MAX;
  const events = truncated ? got.slice(0, READ_MAX) : got;
  const readFrom = truncated && events.length ? events[events.length - 1].ts : null;
  const why = eventNotCollectedMap().get(vc.id) || null;
  const cov = { firstTs: db.firstTs(vc.id) || null, lastTs: db.lastTs(vc.id) || null, why };
  const r = analyzeReboots(hosts, events, { now, days: BOOT_DAYS, vcName: new Map([[vc.id, vc.name || vc.id]]), coverageOf: () => cov, readFrom });
  return new Map(r.rows.map((x) => [x.id, x]));
}

const fileBase = (vcenterId, target) => `hosts-${String(vcenterId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}-${target}-${fileStamp()}`;

export function registerHostExport(api) {
  api.get('/tools/host-export/status', csvPerm, (req, res) => {
    const got = vcOf(req, res);
    if (!got) return;
    const { snap, vc } = got;
    const access = accessOf(req);
    const hosts = (snap.hosts || []).filter((h) => h.vcenterId === vc.id);
    const clusters = clusterChoices(hosts, vc.id);
    const src = { inventory: { hosts: hosts.length, at: snap.generatedAt || null } };
    if (access.hygiene) src.hcfg = { read: hosts.filter((h) => h.hcfg).length, total: hosts.length };
    if (access.cluster) {
      const inCl = clusters.filter((c) => c.key !== 'standalone').length;
      const ats = (vc.clusterCfg || []).map((c) => c.at).filter((t) => Number.isFinite(t));
      src.clusterCfg = { read: Math.min(inCl, (vc.clusterCfg || []).length), total: inCl, at: ats.length ? Math.max(...ats) : null };
    }
    if (access.hw) {
      let idracFor = null;
      try { idracFor = makeIdracFor({ registry: listRegistry(), remote: allRemoteServers() }); } catch { idracFor = null; }
      src.idrac = idracFor ? { matched: hosts.filter((h) => idracFor(h) != null).length, registered: hosts.filter((h) => idracFor(h) !== null).length, total: hosts.length } : { error: true, total: hosts.length };
    }
    res.set('Cache-Control', 'no-store').json({
      ok: true, vcenter: { id: vc.id, name: vc.name || vc.id }, hosts: hosts.length, clusters, access, sources: src,
      parts: HOST_EXPORT_PARTS, max: HOSTS_MAX, bootDays: BOOT_DAYS, initial: snap.initial === true,
    });
  });

  api.post('/tools/host-export.xlsx', csvPerm, async (req, res) => {
    const got = vcOf(req, res);
    if (!got) return;
    const { snap, vc } = got;
    const allHosts = (snap.hosts || []).filter((h) => h.vcenterId === vc.id);
    const { keyOf } = clusterKeys(allHosts, vc.id);
    const s = hostExportSelOf(req.body, new Set(allHosts.map(keyOf)));
    if (!s.ok) return res.status(400).json({ ok: false, reason: s.reason });
    const want = s.clusters ? new Set(s.clusters) : null;
    const target = want ? allHosts.filter((h) => want.has(keyOf(h))) : allHosts;
    if (!target.length) return res.status(400).json({ ok: false, reason: '내보낼 호스트가 없습니다.' });
    if (target.length > HOSTS_MAX) return res.status(400).json({ ok: false, reason: `호스트가 ${target.length}대라 한 파일(최대 ${HOSTS_MAX}대)에 담지 않습니다 — 클러스터를 골라 나눠 내려받으세요.`, tooMany: true });
    const lock = acquireExport('host-export.xlsx', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    try {
      const access = accessOf(req);
      const parts = s.parts;
      let reboots = null;
      if (parts.has('boot') && access.hygiene) {
        try { reboots = await rebootsOf(vc, target); } catch { reboots = new Map(); }
      }
      let idracFor = null;
      if (parts.has('hw') && access.hw) {
        try { idracFor = makeIdracFor({ registry: listRegistry(), remote: allRemoteServers() }); } catch { idracFor = () => undefined; }
      }
      let veeam = null;
      if (parts.has('vmVeeam')) {
        const vms = (snap.vms || []).filter((v) => v.vcenterId === vc.id);
        try { veeam = await veeamVmViews(vc, vms, req, { now: Date.now() }); } catch { veeam = null; }
      }
      if (ac.signal.aborted) return;
      const offsetMin = DAY_OFFSET_MIN;
      const payload = buildHostExport({ vc, hosts: snap.hosts, vms: snap.vms, datastores: snap.datastores }, {
        clusters: s.clusters, parts, access, idracFor, reboots, veeam, offsetMin, bootDays: BOOT_DAYS,
      });
      payload.meta.offsetLabel = tzName(offsetMin);
      const out = await renderHostExportWorkbook(payload, { signal: ac.signal });
      if (ac.signal.aborted) return;
      logAudit({
        user: req.user?.username, action: 'host-export.xlsx', target: vc.id,
        detail: `호스트 ${payload.hosts.length}대 · ${payload.meta.target} · 넣은 것 ${payload.meta.parts.join(',') || '기본'}${Object.keys(payload.meta.omitted).length ? ` · 권한으로 뺀 것 ${Object.keys(payload.meta.omitted).join(',')}` : ''}`.slice(0, 500),
        ip: req.ip,
      });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', `attachment; filename="${fileBase(vc.id, want ? 'clusters' : 'all')}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(out.buffer);
    } catch (e) {
      if (ac.signal.aborted || e?.code === 'aborted') return;
      if (!res.headersSent) res.status(500).json({ ok: false, error: '엑셀을 만들지 못했습니다.', reason: `엑셀을 만들지 못했습니다(${String(e?.message || e).slice(0, 200)}).` });
    } finally { lock.release(); }
  });
}
