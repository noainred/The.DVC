// ESXi 호스트 화면(#/hosts)의 '점검' 열과 호스트 상세 페이지(v2.805 — 승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1).
//
//   · GET /hosts/checks   호스트별 iDRAC 부품 상태 · 최근 재부팅 판정 · Veeam 최근 백업 수 — /hosts 와 같은 범위·필터(applyFilters + state).
//                         무거운 집계(로그 DB · iDRAC 등록부 · Veeam 대조)라 화면은 마운트 1회 + 버튼으로만 부르고, 서버는 60초 캐시(범위 · 판본 키).
//                         묶음 권한은 호스트·클러스터 엑셀과 같은 accessOf(구성 점검 도구 → 재부팅 · 관리자 판본 → iDRAC). 권한 없는 묶음은 키를 싣지 않는다.
//   · GET /hosts/:id      호스트 한 대(상세 페이지가 새로고침·북마크로 열릴 때) — 범위 밖은 404(존재 여부 미노출 — v2.207 규칙).
// ⚠ /hosts/checks 를 /hosts/:id 보다 먼저 등록한다('checks' 가 id 로 잡히지 않게).
import { requirePerm } from '../../auth/auth.js';
import { inUserScope } from '../../auth/scope.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { memoJson, applyFilters, scopeKey } from './shared.js';
import { accessOf, makeIdracFor, BOOT_DAYS } from './hostExport.js';
import { analyzeReboots } from '../../hostcfg/reboots.js';
import { HOSTOPS_TYPES } from '../../vmchanges/eventDetail.js';
import { getLogsDb } from '../../logs/db.js';
import { eventNotCollectedMap } from '../../logs/coverage.js';
import { listRegistry } from '../../idrac/registry.js';
import { allRemoteServers } from '../../collector/remoteInventory.js';
import { veeamVmViews } from '../../veeam/vmViewProvider.js';
import { hostChecksOf, vmsByHostOf } from '../../vcenter/hostChecks.js';

const invHosts = requirePerm('inv.hosts');
const READ_MAX = 20_000;   // 재부팅 근거 이벤트 읽기 상한(hostHygiene.js /reboots 와 같다)

/** 범위 안 vCenter 의 재부팅 판정(hostHygiene.js /reboots 와 같은 입력). */
async function rebootsOf(snap, hosts, vcIds, now) {
  const db = await getLogsDb();
  const since = now - BOOT_DAYS * 86_400_000 - 86_400_000;
  const got = vcIds.length ? await db.opsEventsAsync({ vcenterIds: vcIds, since, types: [...HOSTOPS_TYPES] }, READ_MAX + 1) : [];
  const truncated = got.length > READ_MAX;
  const events = truncated ? got.slice(0, READ_MAX) : got;
  const readFrom = truncated && events.length ? events[events.length - 1].ts : null;
  const ncMap = eventNotCollectedMap();
  const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
  const cov = new Map(vcIds.map((id) => [id, { firstTs: db.firstTs(id) || null, lastTs: db.lastTs(id) || null, why: ncMap.get(id) || null }]));
  const r = analyzeReboots(hosts, events, { now, days: BOOT_DAYS, vcName, coverageOf: (id) => cov.get(id) || null, readFrom });
  return new Map(r.rows.map((x) => [x.id, x]));
}

export function registerHostChecks(api) {
  api.get('/hosts/checks', invHosts, (req, res) => {
    const access = accessOf(req);
    const accessKey = `${access.hygiene ? 'h' : '-'}${access.hw ? 'a' : '-'}`;
    return memoJson(req, res, 'host-checks', async (snap) => {
      const now = Date.now();
      let hosts = applyFilters(snap.hosts || [], req.query, snap, ['name', 'cluster'], req.user);
      if (req.query.state) hosts = hosts.filter((h) => h.connectionState === req.query.state);
      const vcIds = [...new Set(hosts.map((h) => h.vcenterId))];
      let reboots = null;
      if (access.hygiene) { try { reboots = await rebootsOf(snap, hosts, vcIds, now); } catch { reboots = new Map(); } }
      let idracFor = null;
      if (access.hw) { try { idracFor = makeIdracFor({ registry: listRegistry(), remote: allRemoteServers() }); } catch { idracFor = null; } }
      const veeamByVc = new Map();
      for (const vc of (snap.vcenters || []).filter((v) => vcIds.includes(v.id))) {
        const vms = (snap.vms || []).filter((v) => v.vcenterId === vc.id);
        let r = null;
        try { r = await veeamVmViews(vc, vms, req, { now }); } catch { r = null; }
        veeamByVc.set(vc.id, r);
      }
      const r = hostChecksOf(hosts, { access, idracFor, reboots, veeamOf: (id) => veeamByVc.get(id) || null, vmsByHost: vmsByHostOf(snap.vms), now });
      return { ok: true, ...r, bootDays: BOOT_DAYS, at: now, initial: snap.initial === true, hosts: hosts.length };
    }, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, store.get())}|${accessKey}` });
  });

  api.get('/hosts/:id', invHosts, (req, res) => {
    const snap = store.get();
    const id = String(req.params.id || '');
    const h = id ? (snap.hosts || []).find((x) => x.id === id) : null;
    if (!h || !inUserScope(req.user, snap, h.vcenterId)) return res.status(404).json({ ok: false, error: '호스트를 찾을 수 없습니다.', reason: '호스트를 찾을 수 없습니다.' });
    const vc = (snap.vcenters || []).find((v) => v.id === h.vcenterId) || null;
    res.set('Cache-Control', 'no-store').json({
      ok: true, item: h, generatedAt: snap.generatedAt || null,
      vcenter: vc ? { id: vc.id, name: vc.name || vc.id, version: vc.version || '', location: vc.location || null } : null,
      admin: isAdminDetailUser(req.user),
    });
  });
}
