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
import { localSnapSummary, edgeSnapFor, LOOKBACK_DAYS, snapCovered } from '../../veeam/snapEvents.js';
import { getSnapDb } from '../../veeam/snapDb.js';
import { kickSnapBackfill } from '../../veeam/snapWarm.js';
import { logCollectOkAt, logPollerRanOnce } from '../../logs/poller.js';
import { veeamCount, snapCount, snapVerdict } from '../../veeam/backupCounts.js';
import { veeamEdgeStatus } from '../../central/veeamEdge.js';
import { createYielder } from '../../util/timeSlice.js';

/** 실패 사유의 일반 문구(관리자가 아닌 계정용) — 원문에는 Veeam 주소·포트가 들어간다(전송 오류·리다이렉트·TLS 문구). v2.751 검토 #7. */
function genericError(r) {
  if (r?.authStop || r?.kind === 'auth' || r?.kind === 'auth-stopped') return 'Veeam 인증 실패 — 관리자가 설정 › Veeam 백업 서버에서 계정을 확인해야 합니다';
  return 'Veeam 서버를 읽지 못했습니다 — 자세한 사유는 관리자 화면(설정 › Veeam 백업 서버)에 있습니다';
}

/*
 * v2.761(B1): 비고(notes)의 '…을(를) 읽지 못했습니다: <원문>' 원문에는 Veeam 주소·포트·TLS 지문이 들어간다(describeFetchError) —
 *   error 와 같이 관리자에게만 원문, 그 밖에는 '읽지 못했습니다' 까지만. 다른 비고에도 주소 꼴(host:port · URL)이 있으면 일반 문구로.
 */
const NOTE_CUT = '읽지 못했습니다';
const ADDR_LIKE = /:\/\/|[A-Za-z0-9-]\.[A-Za-z0-9-]+:\d{2,5}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|fingerprint|지문/i;
function publicNote(n) {
  const t = String(n || '').slice(0, 300);   // 정제 상한(300)과 같다 — 정규식 입력 길이를 먼저 자른다
  const i = t.indexOf(`${NOTE_CUT}:`);
  const cut = i >= 0 ? `${t.slice(0, i + NOTE_CUT.length)} — 자세한 사유는 관리자 화면에 있습니다` : t;
  return ADDR_LIKE.test(cut) ? 'Veeam 서버를 읽는 중 일부 항목에 문제가 있었습니다 — 자세한 사유는 관리자 화면에 있습니다' : cut;
}

/**
 * v2.761(B2·B5): 결과가 '지금' 이라고 볼 수 있는 한도 — 그 결과를 만든 노드의 수집 주기 × 2 + 2분.
 *   엣지가 읽은 결과는 그 엣지가 보고한 주기(veeamEdge status.poller.intervalMs), 없으면 중앙 주기.
 */
function resultMaxAgeMs(via, agent) {
  const i = via === 'edge' ? veeamEdgeStatus(agent)?.status?.poller?.intervalMs : null;
  return (Number.isFinite(i) && i > 0 ? i : pollMs()) * 2 + 120_000;
}

/** 서버별 상태(화면 안내용 — 계정 없음. 오류 원문(주소 포함)·서버 전체 집계는 관리자에게만). */
function serverView(d, rec, admin, now = Date.now()) {
  const r = rec?.result || null;
  const use = usableResult(rec);
  const notes = Array.isArray(use?.notes) ? use.notes.slice(0, 5) : [];
  return {
    name: d.name, ok: r ? r.ok === true : null, ts: r?.ts ?? null, lastOkTs: use?.ts ?? null,
    // v2.761(B2): 쓸 수 있는 결과가 한도보다 오래됐다(엣지가 멈춤·담당 변경 등) — 숫자는 그대로, 표지만.
    stale: !!use && (!(Number(use.ts) > 0) || now - Number(use.ts) > resultMaxAgeMs(rec?.via, rec?.agent)),
    error: r && !r.ok ? (admin ? String(r.error || '').slice(0, 300) : genericError(r)) : '', authStopped: !!r?.authStop,
    via: rec?.via || '', notes: admin ? notes : notes.map(publicNote),
    // v2.761(B7): 서버 전체(다른 법인 vCenter 포함) 집계 — 범위 계정에 새지 않게 관리자만(화면은 이 값을 쓰지 않는다).
    counts: admin ? (use?.counts || null) : null,
  };
}

const DEMO_SERVER_VIEW = () => ({ name: '데모 Veeam', ok: true, ts: Date.now(), lastOkTs: Date.now(), stale: false, error: '', authStopped: false, via: 'demo', notes: [], counts: null });

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
    views.push(serverView(d, rec, admin, now));
    const use = usableResult(rec);
    // v2.751 검토 #6: 실패해 마지막 성공분을 쓰거나 주기의 2배보다 오래된 결과의 '백업 중' 은 지금 사실이 아니다 — 지우고 대조한다.
    //   v2.761(B5): 엣지 결과는 그 엣지의 주기로.
    if (use) results.push({ server: { id: d.id, name: d.name }, result: withoutStaleRunning(use, { failed: rec?.result?.ok !== true, now, maxAgeMs: resultMaxAgeMs(rec?.via, rec?.agent) }) });
  }
  return { results, views, host: listVcenters().find((v) => v.id === vcenterId)?.host || '' };
}

/**
 * 그 vCenter 의 'Veeam 계정이 만든 스냅샷 생성 이벤트' 요약(/veeam/snap-events 본문 — v2.757 에 카드 수량이 같이 쓰도록 함수로 뺐다).
 * 로그 DB(직접 수집) 또는 엣지가 보낸 요약만 읽는다(vCenter 왕복 없음).
 */

/**
 * @param {{ initial?: boolean, wait?: boolean }} o  wait=false(카드): 전용 DB 가 아직 준비 전이면 기다리지 않고 'preparing'.
 *   wait=true(VM 화면 · vCenter 하나): 준비 전이면 예전처럼 로그 DB 에서 계산한다(느리지만 그 화면은 값이 바로 필요하다).
 */
async function snapEventsFor(vcenterId, vms, { initial = false, wait = true } = {}) {
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
    //   v2.761(B5): 그 엣지가 보고한 주기로(없으면 중앙 주기) · e.at 은 중앙 수신 시각이다(C8 — 엣지 시계와 무관).
    const ei = veeamEdgeStatus(e.agent)?.status?.poller?.intervalMs;
    if (Date.now() - e.at > (Number.isFinite(ei) && ei > 0 ? ei : pollMs()) * 2 + 600_000) return { ...base, status: 'stale-edge', source: 'edge', at: e.at };
    if (e.status && e.status !== 'ok') return { ...base, status: e.status, source: 'edge', at: e.at };
    // v2.761(C2): 엣지 로그 폴러의 마지막 온전한 수집 시각(옛 엣지는 없다 — null = 모름, 막지 않는다)과 '그 엣지 폴러가 돌았는가'.
    return { ...base, status: 'ok', source: 'edge', days: e.days, byVm: onlyKnown(e.byVm), events: e.events, ambiguous: e.ambiguous, unmatched: e.unmatched, unpaired: e.unpaired, truncated: e.truncated, accounts: e.accounts, at: e.at,
      collectedAt: Number.isFinite(e.collectedAt) ? e.collectedAt : null, ...(e.collectRan === true ? { collectRan: true } : {}) };
  }
  if (why) return { ...base, status: 'not-collected', why };
  const ls = loadLogSettings();
  if (ls?.enabled === false) return { ...base, status: 'log-off' };
  if (ls?.minSeverity && ls.minSeverity !== 'info') return { ...base, status: 'severity-filter' };
  const snapDb = await getSnapDb();
  if (snapDb && !snapCovered(snapDb, vcenterId, Date.now() - LOOKBACK_DAYS * 86_400_000)) {
    kickSnapBackfill();
    if (!wait) return { ...base, status: 'preparing', source: 'local' };
  }
  const r = await localSnapSummary(await getLogsDb(), vcenterId, vms, { snapDb });
  // 검토 #6: 이벤트를 마지막으로 온전히 수집한 시각(인메모리 — 재시작 직후 null). 화면이 오래됐으면 말한다.
  //   v2.761(C1): collectRan = 이 프로세스에서 로그 폴러가 한 주기를 끝냈다(그 뒤에도 null 이면 '아직 못 모음' — 기동 직후는 아니다).
  return { ...base, status: 'ok', source: 'local', byVm: onlyKnown(r.byVm), events: r.events, ambiguous: r.ambiguous, unmatched: r.unmatched, unpaired: r.unpaired, truncated: r.truncated, accounts: r.accounts, at: r.at,
    collectedAt: logCollectOkAt(vcenterId), ...(logPollerRanOnce() ? { collectRan: true } : {}) };
}

/*
 * 스냅샷 요약 캐시 — vCenter 별·계정과 무관(범위는 응답에서 거른다). 카드(/backup-counts)와 VM 화면(/snap-events)이 **같은 값**을 쓴다.
 * v2.758: 5분 → 60초, 로그 DB 를 읽은 결과(source local)만 담는다 — 엣지 요약은 메모리라 읽는 비용이 없고, 담아 두면 다음 push 의
 *   새 값이 늦게 보인다(실서버: 카드 0/340 · VM 화면 54대). 세대: 시각만 — 등록부에 없는 vCenter 항목은 다음 카드 계산 때 지운다.
 *   같은 vCenter 를 동시에 두 번 읽지 않는다(진행 중 약속 공유).
 */
const SNAP_CACHE_MS = 60_000;
const _snapCache = new Map(); // vcenterId → { at, p }
function cachedSnapEvents(vcenterId, vms, { initial = false, wait = true, now = Date.now() } = {}) {
  const c = _snapCache.get(vcenterId);
  if (c && now - c.at < SNAP_CACHE_MS && (wait || !c.wait)) return c.p;   // 기다리지 않는 쪽(카드)은 기다리는 계산(옛 경로)에 묶이지 않는다
  const entry = { at: now, p: null, wait };
  const drop = () => { if (_snapCache.get(vcenterId) === entry) _snapCache.delete(vcenterId); }; // 그 사이 새로 담긴 항목은 지우지 않는다
  entry.p = snapEventsFor(vcenterId, vms, { initial, wait })
    .then((r) => { if (r?.source !== 'local' || r?.status !== 'ok') drop(); else entry.wait = false; return r; })
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
    // v2.761(D5): 실패·오래된 결과라 '백업 중' 을 지운 서버가 있으면 실행 중·대기 수는 0 이 아니라 모름.
    res.json({ ok: true, configured: true, servers: views, ...m, runningStale: results.some((x) => x.result?.runningStale === true), at: Date.now() });
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
      // v2.761(D4): 카드(snapCount)와 같은 판정 — 칩은 verdict.ok 일 때만 숫자를 보인다(판정 코어 하나).
      return { ok: true, vcenterId: t.vcenterId, days: LOOKBACK_DAYS, byVm: {}, ...rest, verdict: snapVerdict(r) };
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
          const m = results.length ? matchToVcenter({ id: vc.id, host }, vms, results) : null;
          byVc[vc.id] = veeamCount({ views, byVm: m ? m.byVm : null, vmTotal: vms.length, otherVcenter: m?.otherVcenter || 0 });
        } else if (isMockMode()) {
          byVc[vc.id] = { ...veeamCount({ views: [DEMO_SERVER_VIEW()], byVm: demoVeeamMatch(vc.id, vms).byVm, vmTotal: vms.length }), demo: true };
        } else {
          byVc[vc.id] = snapCount({ ev: await cachedSnapEvents(vc.id, vms, { initial: snap?.initial === true, wait: false }), vms });
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
