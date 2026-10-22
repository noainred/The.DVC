// Veeam 백업 VM 배지(v2.751) — vCenter › VM 및 폴더의 'Veeam 백업 VM 표시' 체크박스가 부른다.
// 조회 전용·로그인 사용자(트리를 볼 수 있는 계정이면 배지도 본다 — 어떤 VM 이 백업 대상인지·작업 이름뿐, 계정 없음 · 오류 원문(주소)은 관리자만).
// scope: id 를 직접 받는 단건 라우트라 범위 밖 vCenter 는 404(존재 은닉 — server/CLAUDE.md). 체크박스를 켰을 때만 60초 폴링한다.
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { serversForVcenter } from '../../veeam/registry.js';
import { getRecord, usableResult } from '../../veeam/store.js';
import { matchToVcenter, withoutStaleRunning, buildVmDetail } from '../../veeam/parse.js';
import { pollMs } from '../../veeam/poller.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { demoVeeamMatch, demoVeeamDetail } from '../../mock/demo/veeam.js';
import { memoJson, scopeKey } from './shared.js';
import { getLogsDb } from '../../logs/db.js';
import { loadLogSettings } from '../../logs/settings.js';
import { eventNotCollectedMap } from '../../logs/coverage.js';
import { localSnapSummary, edgeSnapFor, LOOKBACK_DAYS } from '../../veeam/snapEvents.js';
import { logCollectOkAt } from '../../logs/poller.js';
import { veeamCount, snapCount } from '../../veeam/backupCounts.js';
import { createYielder } from '../../util/timeSlice.js';

/** 실패 사유의 일반 문구(관리자가 아닌 계정용) — 원문에는 Veeam 주소·포트가 들어간다(전송 오류·리다이렉트·TLS 문구). v2.751 검토 #7. */
function genericError(r) {
  if (r?.authStop || r?.kind === 'auth' || r?.kind === 'auth-stopped') return 'Veeam 인증 실패 — 관리자가 설정 › Veeam 백업 서버에서 계정을 확인해야 합니다';
  return 'Veeam 서버를 읽지 못했습니다 — 자세한 사유는 관리자 화면(설정 › Veeam 백업 서버)에 있습니다';
}

/** 서버별 상태(화면 안내용 — 계정 없음. 오류 원문(주소 포함)은 관리자에게만). */
function serverView(d, rec, admin) {
  const r = rec?.result || null;
  const use = usableResult(rec);
  return {
    name: d.name, ok: r ? r.ok === true : null, ts: r?.ts ?? null, lastOkTs: use?.ts ?? null,
    error: r && !r.ok ? (admin ? String(r.error || '').slice(0, 300) : genericError(r)) : '', authStopped: !!r?.authStop,
    via: rec?.via || '', notes: Array.isArray(use?.notes) ? use.notes.slice(0, 5) : [],
    counts: use?.counts || null,
  };
}

const DEMO_SERVER_VIEW = () => ({ name: '데모 Veeam', ok: true, ts: Date.now(), lastOkTs: Date.now(), error: '', authStopped: false, via: 'demo', notes: [], counts: null });

/** 요청 vCenter 의 범위·존재 판정 — 밖이면 null(호출부가 404). */
function vcOf(req) {
  const vcenterId = String(req.query.vcenterId || '').slice(0, 128);
  const snap = store.get();
  const allowed = scopedVcenterIds(req.user, snap);
  const vc = (snap?.vcenters || []).find((v) => v.id === vcenterId);
  if (!vcenterId || !vc || (allowed && !allowed.has(vcenterId))) return null;
  return { vcenterId, vms: (snap?.vms || []).filter((v) => v.vcenterId === vcenterId) };
}

/** 그 vCenter 에 연결된 서버들의 상태(화면용)와 대조할 결과(낡은 '백업 중' 을 지운 것). */
function resultsFor(vcenterId, req) {
  const admin = isAdminDetailUser(req.user);
  const now = Date.now();
  const results = []; const views = [];
  for (const d of serversForVcenter(vcenterId)) {
    const rec = getRecord(d.id);
    views.push(serverView(d, rec, admin));
    const use = usableResult(rec);
    // v2.751 검토 #6: 실패해 마지막 성공분을 쓰거나 주기의 2배보다 오래된 결과의 '백업 중' 은 지금 사실이 아니다 — 지우고 대조한다.
    if (use) results.push({ server: { id: d.id, name: d.name }, result: withoutStaleRunning(use, { failed: rec?.result?.ok !== true, now, maxAgeMs: pollMs() * 2 + 120_000 }) });
  }
  return { results, views, host: listVcenters().find((v) => v.id === vcenterId)?.host || '' };
}

/**
 * 그 vCenter 의 'Veeam 계정이 만든 스냅샷 생성 이벤트' 요약(/veeam/snap-events 본문 — v2.757 에 카드 수량이 같이 쓰도록 함수로 뺐다).
 * 로그 DB(직접 수집) 또는 엣지가 보낸 요약만 읽는다(vCenter 왕복 없음).
 */
async function snapEventsFor(vcenterId, vms, { initial = false } = {}) {
  const base = { ok: true, vcenterId, days: LOOKBACK_DAYS, byVm: {} };
  // v2.758: VM 목록이 없으면(재시작 직후 골격 · 아직 수집 전) 대조할 대상이 없다 — '0대' 가 아니라 모름.
  if (initial || !vms.length) return { ...base, status: 'no-inventory' };
  // 검토 #8: 지금 인벤토리에 있는 VM 만 싣는다(엣지가 보낸 접두사만 맞는 id·지운 VM 이 'N대' 를 부풀리지 않게).
  const known = new Set(vms.map((v) => v.id));
  const onlyKnown = (m) => { const o = {}; for (const [k, v] of Object.entries(m || {})) if (known.has(k)) o[k] = v; return o; };
  const why = eventNotCollectedMap().get(vcenterId); // mock 이면 빈 맵(로그 폴러가 전부 모은다)
  if (why === 'site') {
    const e = edgeSnapFor(vcenterId);
    if (!e) return { ...base, status: 'no-edge-data', source: 'edge' };
    // 검토 #7: 엣지가 멈췄거나 담당이 바뀌면 마지막 요약을 '지금' 처럼 보이지 않는다(push 주기 2배 + 여유).
    if (Date.now() - e.at > pollMs() * 2 + 600_000) return { ...base, status: 'stale-edge', source: 'edge', at: e.at };
    if (e.status && e.status !== 'ok') return { ...base, status: e.status, source: 'edge', at: e.at };
    return { ...base, status: 'ok', source: 'edge', days: e.days, byVm: onlyKnown(e.byVm), events: e.events, ambiguous: e.ambiguous, unmatched: e.unmatched, unpaired: e.unpaired, truncated: e.truncated, accounts: e.accounts, at: e.at };
  }
  if (why) return { ...base, status: 'not-collected', why };
  const ls = loadLogSettings();
  if (ls?.enabled === false) return { ...base, status: 'log-off' };
  if (ls?.minSeverity && ls.minSeverity !== 'info') return { ...base, status: 'severity-filter' };
  const r = await localSnapSummary(await getLogsDb(), vcenterId, vms);
  // 검토 #6: 이벤트를 마지막으로 온전히 수집한 시각(인메모리 — 재시작 직후 null). 화면이 오래됐으면 말한다.
  return { ...base, status: 'ok', source: 'local', byVm: onlyKnown(r.byVm), events: r.events, ambiguous: r.ambiguous, unmatched: r.unmatched, unpaired: r.unpaired, truncated: r.truncated, accounts: r.accounts, at: r.at, collectedAt: logCollectOkAt(vcenterId) };
}

/*
 * 스냅샷 요약 캐시 — vCenter 별·계정과 무관(범위는 응답에서 거른다). 카드(/backup-counts)와 VM 화면(/snap-events)이 **같은 값**을 쓴다.
 * v2.758: 5분 → 60초, 로그 DB 를 읽은 결과(source local)만 담는다 — 엣지 요약은 메모리라 읽는 비용이 없고, 담아 두면 다음 push 의
 *   새 값이 늦게 보인다(실서버: 카드 0/340 · VM 화면 54대). 세대: 시각만 — 등록부에 없는 vCenter 항목은 다음 카드 계산 때 지운다.
 *   같은 vCenter 를 동시에 두 번 읽지 않는다(진행 중 약속 공유).
 */
const SNAP_CACHE_MS = 60_000;
const _snapCache = new Map(); // vcenterId → { at, p }
function cachedSnapEvents(vcenterId, vms, { initial = false, now = Date.now() } = {}) {
  const c = _snapCache.get(vcenterId);
  if (c && now - c.at < SNAP_CACHE_MS) return c.p;
  const entry = { at: now, p: null };
  const drop = () => { if (_snapCache.get(vcenterId) === entry) _snapCache.delete(vcenterId); }; // 그 사이 새로 담긴 항목은 지우지 않는다
  entry.p = snapEventsFor(vcenterId, vms, { initial })
    .then((r) => { if (r?.source !== 'local') drop(); return r; })
    .catch((e) => { drop(); return { status: 'error', error: String(e?.message || e) }; });
  _snapCache.set(vcenterId, entry);
  return entry.p;
}

export function registerVeeamBadges(api) {
  api.get('/veeam/badges', (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const { vcenterId, vms } = t;
    if (!serversForVcenter(vcenterId).length) {
      if (isMockMode()) return res.json({ ok: true, configured: true, demo: true, servers: [DEMO_SERVER_VIEW()], ...demoVeeamMatch(vcenterId, vms), at: Date.now() });
      return res.json({ ok: true, configured: false, servers: [], byVm: {}, unmatched: 0, otherVcenter: 0, ambiguous: 0 });
    }
    const { results, views, host } = resultsFor(vcenterId, req);
    const m = matchToVcenter({ id: vcenterId, host }, vms, results);
    res.json({ ok: true, configured: true, servers: views, ...m, at: Date.now() });
  });

  // v2.754(사용자 요청 '지금 스냅샷이 없으면 확인 안 되는가' → vCenter 이벤트 방식): 최근 7일 'Veeam 계정이 만든 VM 스냅샷 생성 이벤트'.
  //   이 포탈이 직접 이벤트를 모으는 vCenter 는 로그 DB 에서 바로, 엣지 위임(site) vCenter 는 그 엣지가 Veeam push 로 보낸 요약(veeam/snapEvents.js).
  //   vCenter 왕복 없음(저장된 이벤트만). 화면은 체크했을 때만 5분마다 부른다 · 60초 캐시(범위 키) · 계정 이름은 싣지 않는다.
  api.get('/veeam/snap-events', (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    // v2.758: 카드와 같은 캐시(같은 순간 같은 값) · 오류 원문은 싣지 않는다.
    return memoJson(req, res, 'veeam-snap-events', async (snap) => {
      const r = await cachedSnapEvents(t.vcenterId, t.vms, { initial: snap?.initial === true });
      const { error: _e, ...rest } = r || {};
      return { ok: true, vcenterId: t.vcenterId, days: LOOKBACK_DAYS, byVm: {}, ...rest };
    }, { ttlMs: 60_000, extraKey: scopeKey(req.user, store.get()) });
  });

  // v2.757(사용자 요청 — vCenter 카드에 'VM 백업 수량', 182/195 형식): 범위 안 vCenter 마다 한 줄.
  //   Veeam 서버가 하나라도 연결돼 있으면 Veeam 기준만(스냅샷과 섞지 않는다), 없으면 스냅샷 기준(이벤트 7일 ∪ 지금 임시 스냅샷).
  //   모르면 n=null + 이유 코드(0 으로 쓰지 않는다). 오류 원문·계정 이름은 싣지 않는다. 화면은 마운트 1회 + 5분마다.
  api.get('/veeam/backup-counts', (req, res) => {
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    return memoJson(req, res, 'veeam-backup-counts', async () => {
      const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
      const live = new Set((snap?.vcenters || []).map((v) => v.id));
      for (const k of _snapCache.keys()) if (!live.has(k)) _snapCache.delete(k);
      const vmsBy = new Map();
      for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
      const maybeYield = createYielder(15);
      const byVc = {};
      for (const vc of vcs) {
        await maybeYield();
        const vms = vmsBy.get(vc.id) || [];
        if (serversForVcenter(vc.id).length) {
          const { results, views, host } = resultsFor(vc.id, req);
          // v2.758: VM 목록이 없으면(재시작 직후 · 수집 전) 대조 결과 0 은 사실이 아니다 — 모름.
          if (snap?.initial === true || !vms.length) { byVc[vc.id] = { src: 'veeam', n: null, vmTotal: null, reason: 'no-inventory' }; continue; }
          const byVm = results.length ? matchToVcenter({ id: vc.id, host }, vms, results).byVm : null;
          byVc[vc.id] = veeamCount({ views, byVm, vmTotal: vms.length });
        } else if (isMockMode()) {
          byVc[vc.id] = { ...veeamCount({ views: [DEMO_SERVER_VIEW()], byVm: demoVeeamMatch(vc.id, vms).byVm, vmTotal: vms.length }), demo: true };
        } else {
          byVc[vc.id] = snapCount({ ev: await cachedSnapEvents(vc.id, vms, { initial: snap?.initial === true }), vms });
        }
      }
      return { ok: true, at: Date.now(), byVc };
    }, { ttlMs: 60_000, extraKey: scopeKey(req.user, snap) });
  });

  // VM 1대의 백업 상세(v2.751 사용자 요청: 'Veeam 배지를 누르면 백업 세부 정보 창' — 복원 지점·용량·마지막 백업 등).
  // 주기 수집해 둔 값만 쓴다(Veeam 왕복 없음 — 사용자 선택 '주기 수집에 포함'). 범위 밖 vCenter·없는 VM 은 404.
  api.get('/veeam/vm-detail', (req, res) => {
    const t = vcOf(req);
    const vmId = String(req.query.vmId || '').slice(0, 300);
    const vm = t ? t.vms.find((v) => v.id === vmId) : null;
    if (!t || !vm) return res.status(404).json({ ok: false, reason: 'VM 을 찾을 수 없습니다.' });
    const { vcenterId } = t;
    if (!serversForVcenter(vcenterId).length) {
      if (isMockMode()) return res.json({ ok: true, demo: true, vm: { id: vm.id, name: vm.name }, detail: demoVeeamDetail(vcenterId, vm), servers: [DEMO_SERVER_VIEW()], at: Date.now() });
      return res.json({ ok: true, configured: false, vm: { id: vm.id, name: vm.name }, detail: null, servers: [] });
    }
    const { results, views, host } = resultsFor(vcenterId, req);
    const m = matchToVcenter({ id: vcenterId, host }, t.vms, results, { refsFor: vmId });
    res.json({ ok: true, configured: true, vm: { id: vm.id, name: vm.name }, detail: buildVmDetail(m.byVm[vmId]), servers: views, at: Date.now() });
  });
}
