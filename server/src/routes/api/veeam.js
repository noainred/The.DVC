// Veeam 백업 VM 배지(v2.751) — vCenter › VM 및 폴더의 'Veeam 백업 VM 표시' 체크박스가 부른다.
// 조회 전용·로그인 사용자(트리를 볼 수 있는 계정이면 배지도 본다 — 어떤 VM 이 백업 대상인지·작업 이름뿐, 계정 없음 · 오류 원문(주소)은 관리자만).
// scope: id 를 직접 받는 단건 라우트라 범위 밖 vCenter 는 404(존재 은닉 — server/CLAUDE.md). 체크박스를 켰을 때만 60초 폴링한다.
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { serversForVcenter, registryLoadError } from '../../veeam/registry.js';
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
import { logPollerRanOnce } from '../../logs/poller.js';
import { snapEventsOkAt, snapCollectorReason } from '../../veeam/snapCollector.js';   // v2.765: 로그 폴러 ok 시각과 Veeam 계정 전용 수집기 ok 시각 중 늦은 것(결합 함수 하나)
import { veeamCount, snapCount, snapVerdict, snapStaleMs } from '../../veeam/backupCounts.js';
import { veeamEdgeStatus } from '../../central/veeamEdge.js';
import { createYielder } from '../../util/timeSlice.js';
import { requirePerm } from '../../auth/auth.js';
import { backupRow, backupTotals, vmBackupView, vmScope, POWER_VALUES, RPO_DAYS, VIEW_FILTERS, vmViewMatches } from '../../veeam/backupStatus.js';   // v2.779 백업 메뉴 · v2.780 범위·CSV
import { logAudit } from '../../audit.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';   // v2.781(점검 G3 B-I2): 백업 CSV 2종 동시 1건

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
/*
 * v2.763(V5-5): 비고의 수(에이전트 백업 N대·컨테이너 N개·N건 버림·세션 N개 …)는 **서버 전체** 기준이다 — 다른 법인 vCenter 쪽 수가 섞인다
 *   (B7 counts · F5 otherVcenter 를 관리자만 싣는 것과 같은 이유). 관리자가 아니면 'N개 중 M개' 는 지우고 'N개·대·건' 은 '일부' 로(조사도 맞춘다).
 */
const COUNT_OF = /\d[\d,]*\s*(?:개|대|건)\s*중\s*/g;
const COUNT = /\d[\d,]*\s*(?:개|대|건)(을|이|은|과)?/g;
const PARTICLE_AFTER_VOWEL = { 을: '를', 이: '가', 은: '는', 과: '와' };
const CAP_AT = /\d[\d,]*\s*개(를 넘어|에서 잘려)/g;   // 'N개를 넘어'·'N개에서 잘려' 의 N 은 상한이다 — '상한' 으로
export function maskCounts(t) {
  return String(t || '').replace(CAP_AT, (_m, tail) => `상한${tail.startsWith('를') ? `을${tail.slice(1)}` : tail}`).replace(COUNT_OF, '').replace(COUNT, (_m, p) => `일부${p ? PARTICLE_AFTER_VOWEL[p] : ''}`);
}
function publicNote(n) {
  const t = String(n || '').slice(0, 300);   // 정제 상한(300)과 같다 — 정규식 입력 길이를 먼저 자른다
  const i = t.indexOf(`${NOTE_CUT}:`);
  const cut = i >= 0 ? `${t.slice(0, i + NOTE_CUT.length)} — 자세한 사유는 관리자 화면에 있습니다` : t;
  return ADDR_LIKE.test(cut) ? 'Veeam 서버를 읽는 중 일부 항목에 문제가 있었습니다 — 자세한 사유는 관리자 화면에 있습니다' : maskCounts(cut);
}

/**
 * v2.761(B2·B5): 결과가 '지금' 이라고 볼 수 있는 한도 — 그 결과를 만든 노드의 수집 주기 × 2 + 2분.
 *   엣지가 읽은 결과는 그 엣지가 보고한 주기(veeamEdge status.poller.intervalMs), 없으면 중앙 주기.
 */
export function resultMaxAgeMs(via, agent) {   // v2.763(V5-4): 관리 화면(routes/admin/veeam.js serverStatusView)도 같은 식을 쓴다
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

/*
 * v2.762(F4): Veeam 서버 등록부(veeam-servers.json)를 못 읽으면 '연결된 Veeam 서버 없음' 이 아니라 모름이다 — 예전에는 badges 가
 *   configured:false("등록하세요"), 카드는 조용히 스냅샷 기준으로 바뀌었다(중앙 /central/veeam-* 는 같은 상황에서 503 registryUnreadable).
 *   badges·vm-detail 은 503(사람이 읽는 일반 문구 + registryUnreadable 표지 — 원문은 파일 조각이라 싣지 않는다), backup-counts 는
 *   전 vCenter 를 n:null 'registry-unreadable'(어느 vCenter 가 연동인지 모르므로 vCenter 를 고를 수 없다).
 */
const REGISTRY_UNREADABLE_TEXT = 'Veeam 서버 등록부를 읽지 못해 이 vCenter 의 Veeam 연동 여부를 알 수 없습니다 — 관리자가 설정 › Veeam 백업 서버에서 확인해야 합니다(백업이 없다는 뜻이 아닙니다).';
function registryUnreadable503(res) {
  let e = null;
  try { e = registryLoadError(); } catch (x) { e = { at: Date.now(), reason: String(x?.message || x) }; }
  if (!e) return false;
  res.status(503).set('Cache-Control', 'no-store').json({ ok: false, reason: REGISTRY_UNREADABLE_TEXT, registryUnreadable: true, since: e.at || null });
  return true;
}
const registryBroken = () => { try { return !!registryLoadError(); } catch { return true; } };

/*
 * v2.762(F5): otherVcenter(Veeam 이 다른 vCenter 로 적은 VM 수)는 **서버 전체** 기준 — 다른 법인 vCenter 쪽 백업 VM 수가 섞인다(B7 counts 와 같은 이유).
 *   관리자 판본만 수를 싣고, 그 밖에는 수를 지우고(null) hostMismatch 불리언만(이 vCenter 와 맞은 VM 이 0대인데 다른 vCenter 로 적힌 VM 이 있다).
 *   badges·backup-counts 두 응답 경로 모두(vm-detail 은 이 값을 싣지 않는다). 판정은 isAdminDetailUser 하나. v2.766(점검 R1-A4-2): unmatched 도 서버 전체 기준(h 없는 에이전트 항목 — 다른 법인 것) → 같이 가림.
 */
function maskOtherVcenter(o, admin, matched) {
  if (!o || typeof o !== 'object' || !('otherVcenter' in o)) return o;
  const n = Number.isInteger(o.otherVcenter) && o.otherVcenter > 0 ? o.otherVcenter : 0;
  const hostMismatch = n > 0 && matched === 0;
  if (admin) return { ...o, otherVcenter: n, ...(hostMismatch ? { hostMismatch: true } : {}) };
  // v2.778: 배운 별칭(Veeam 이 적은 vCenter 이름 — 주소다)도 관리자 판본에만. 그 밖에는 '다른 이름으로 맞췄다' 는 불리언만.
  const { otherVcenter: _drop, aliasHosts: _al, ...rest } = o;
  return { ...rest, otherVcenter: null, ...('unmatched' in o ? { unmatched: null } : {}), ...(hostMismatch ? { hostMismatch: true } : {}), ...(Array.isArray(_al) && _al.length ? { hostAliased: true } : {}) };
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
    if (use) {
      const result = withoutStaleRunning(use, { failed: rec?.result?.ok !== true, now, maxAgeMs: resultMaxAgeMs(rec?.via, rec?.agent) });
      results.push({ server: { id: d.id, name: d.name }, result });
      // v2.778.1: 지금 도는 작업과 그 작업 전체 진행률(Veeam 콘솔 작업 목록의 %) — 작업 이름은 서버 전체(다른 법인 작업 포함)라 관리자 판본만(B7 counts 와 같은 이유).
      if (admin) views[views.length - 1].runningJobs = (Array.isArray(result.jobs) ? result.jobs : []).filter((j) => j && j.running === true).slice(0, 10).map((j) => ({ name: String(j.name || '').slice(0, 128), pg: Number.isFinite(j.pg) ? j.pg : null }));
    }
  }
  // v2.778: 다른 등록 vCenter 의 주소 — Veeam 이 적은 이름을 이 vCenter 의 별칭으로 배울 때 그 주소와 같은 이름은 배우지 않는다(parse.js learnHostAliases).
  const all = listVcenters();
  return { results, views, host: all.find((v) => v.id === vcenterId)?.host || '', otherHosts: all.filter((v) => v.id !== vcenterId).map((v) => v.host).filter(Boolean) };
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
  const viaSnapDb = !!snapDb && snapCovered(snapDb, vcenterId, Date.now() - LOOKBACK_DAYS * 86_400_000);
  if (snapDb && !viaSnapDb) {
    kickSnapBackfill();
    if (!wait) return { ...base, status: 'preparing', source: 'local' };
  }
  const r = await localSnapSummary(await getLogsDb(), vcenterId, vms, { snapDb });
  // 검토 #6: 이벤트를 마지막으로 온전히 수집한 시각(인메모리 — 재시작 직후 null). 화면이 오래됐으면 말한다.
  //   v2.761(C1): collectRan = 이 프로세스에서 로그 폴러가 한 주기를 끝냈다(그 뒤에도 null 이면 '아직 못 모음' — 기동 직후는 아니다).
  //   v2.762(F6): staleMs = 이 포탈 로그 수집 주기를 반영한 '오래됨' 한도(snapVerdict 가 쓴다 — 엣지 요약은 싣지 않아 6시간).
  //   v2.765: collectedAt = 로그 폴러와 Veeam 계정 전용 수집기(snapCollector) 중 늦은 완결 시각 — 전용 수집기의 행은 전용 DB 에만 있으므로
  //     이 요약이 전용 DB 를 읽었을 때만(viaSnapDb) 그 시각을 섞는다(백필 전 로그 DB 경로는 로그 폴러 값 그대로). v2.766(점검 R1-A1-1): 요약이 Veeam 으로 본 계정을 전용 수집기가 다 덮을 때만(summary).
  return { ...base, status: 'ok', source: 'local', byVm: onlyKnown(r.byVm), events: r.events, ambiguous: r.ambiguous, unmatched: r.unmatched, unpaired: r.unpaired, truncated: r.truncated, accounts: r.accounts, at: r.at,
    collectedAt: snapEventsOkAt(vcenterId, { dedicated: viaSnapDb, summary: r }), staleMs: snapStaleMs(ls?.pollIntervalMin), ...(logPollerRanOnce() ? { collectRan: true } : {}),
    ...snapCollectorField(vcenterId, viaSnapDb, r) };
}
/*
 * v2.772(Z3 I1): 전용 수집기가 이 vCenter 를 구제하지 못한 사유 **코드만**(snapCollectorReason — 계정 이름·주소·오류 원문·수 없음). 범위는 호출부가 이미 골랐다
 *   (vcOf 404 · backup-counts 는 allowed 안 vCenter 만). 사유 코드는 관리자 판본과 같다 — 계정 이름이 없고 그 vCenter 의 수집 상태뿐이라 가리지 않는다.
 */
function snapCollectorField(vcenterId, dedicated, summary) {
  let code = null;
  try { code = snapCollectorReason(vcenterId, { dedicated, summary }); } catch { code = null; }
  return code ? { snapCollector: code } : {};
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
    if (registryUnreadable503(res)) return;   // v2.762(F4)
    const admin = isAdminDetailUser(req.user);
    if (!serversForVcenter(vcenterId).length) {
      if (isMockMode()) { const dm = demoVeeamMatch(vcenterId, vms); return res.json({ ok: true, configured: true, demo: true, servers: [DEMO_SERVER_VIEW()], ...maskOtherVcenter(dm, admin, Object.keys(dm.byVm || {}).length), at: Date.now() }); }
      return res.json({ ok: true, configured: false, servers: [], byVm: {}, unmatched: 0, ...maskOtherVcenter({ otherVcenter: 0 }, admin, 0), ambiguous: 0 });
    }
    const { results, views, host, otherHosts } = resultsFor(vcenterId, req);
    const m = matchToVcenter({ id: vcenterId, host }, vms, results, { otherHosts });
    // v2.761(D5): 실패·오래된 결과라 '백업 중' 을 지운 서버가 있으면 실행 중·대기 수는 0 이 아니라 모름.
    res.json({ ok: true, configured: true, servers: views, ...maskOtherVcenter(m, admin, Object.keys(m.byVm || {}).length), runningStale: results.some((x) => x.result?.runningStale === true), at: Date.now() });
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
  //   모르면 n=null + 이유 코드(0 으로 쓰지 않는다). 오류 원문·계정 이름은 싣지 않는다. 화면은 마운트 1회 + 60초마다(v2.759).
  api.get('/veeam/backup-counts', (req, res) => {
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const admin = isAdminDetailUser(req.user);
    return memoJson(req, res, 'veeam-backup-counts', async () => {
      const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
      // v2.762(F4): 등록부를 못 읽으면 어느 vCenter 가 연동인지 모른다 — 전부 모름(스냅샷 기준으로 조용히 바꾸지 않는다).
      if (registryBroken()) {
        const byVc = {};
        for (const vc of vcs) byVc[vc.id] = { src: 'veeam', n: null, vmTotal: snap?.initial === true ? null : (snap?.vms || []).filter((v) => v.vcenterId === vc.id).length, reason: 'registry-unreadable' };
        return { ok: true, at: Date.now(), byVc, registryUnreadable: true };
      }
      const live = new Set((snap?.vcenters || []).map((v) => v.id));
      for (const k of _snapCache.keys()) if (!live.has(k)) _snapCache.delete(k);
      const vmsBy = new Map();
      for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
      const maybeYield = createYielder(15);
      // v2.778.1(사용자 요청: 카드에 'veeam/snapshot' — Veeam 으로 백업 받는 수와 스냅샷 수를 함께): Veeam 이 연동된 vCenter 도 스냅샷 기준 수를 낸다.
      //   같은 캐시(cachedSnapEvents · 기다리지 않음)·같은 판정(snapCount)이라 연동 없는 vCenter 의 값과 기준이 같다.
      const snapCell = async (vcId, vms) => {
        const ev = await cachedSnapEvents(vcId, vms, { initial: snap?.initial === true, wait: false });
        const cnt = snapCount({ ev, vms });
        return cnt.n == null && ev?.source === 'local' && ev?.snapCollector ? { ...cnt, snapCollector: ev.snapCollector } : cnt;
      };
      const byVc = {};
      for (const vc of vcs) {
        await maybeYield();
        const vms = vmsBy.get(vc.id) || [];
        if (serversForVcenter(vc.id).length) {
          const { results, views, host, otherHosts } = resultsFor(vc.id, req);
          // v2.758: VM 목록이 없으면(재시작 직후 · 수집 전) 대조 결과 0 은 사실이 아니다 — 모름.
          if (snap?.initial === true || !vms.length) { byVc[vc.id] = { src: 'veeam', n: null, vmTotal: null, reason: 'no-inventory' }; continue; }
          const m = results.length ? matchToVcenter({ id: vc.id, host }, vms, results, { otherHosts }) : null;
          const vcnt = veeamCount({ views, byVm: m ? m.byVm : null, vmTotal: vms.length, otherVcenter: m?.otherVcenter || 0 });
          byVc[vc.id] = { ...maskOtherVcenter(vcnt, admin, vcnt.n), snap: await snapCell(vc.id, vms) };   // v2.762(F5): 수는 관리자만 · v2.778.1: 스냅샷 수도 같이
        } else if (isMockMode()) {
          const vcnt = veeamCount({ views: [DEMO_SERVER_VIEW()], byVm: demoVeeamMatch(vc.id, vms).byVm, vmTotal: vms.length });
          byVc[vc.id] = { ...maskOtherVcenter(vcnt, admin, vcnt.n), demo: true, snap: await snapCell(vc.id, vms) };
        } else {
          // v2.772(Z3 I1): 수를 못 낸(n null) 로컬 vCenter 에만 전용 수집기 사유 코드를 싣는다(카드 stale 문구 한 줄) — snapCell 안.
          byVc[vc.id] = await snapCell(vc.id, vms);
        }
      }
      return { ok: true, at: Date.now(), byVc };
    }, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}` });   // v2.762(F5): 판본이 역할로 갈린다 — 키에 역할
  });

  // VM 1대의 백업 상세(v2.751 사용자 요청: 'Veeam 배지를 누르면 백업 세부 정보 창' — 복원 지점·용량·마지막 백업 등).
  // 주기 수집해 둔 값만 쓴다(Veeam 왕복 없음 — 사용자 선택 '주기 수집에 포함'). 범위 밖 vCenter·없는 VM 은 404.
  api.get('/veeam/vm-detail', (req, res) => {
    const t = vcOf(req);
    const vmId = String(req.query.vmId || '').slice(0, 300);
    const vm = t ? t.vms.find((v) => v.id === vmId) : null;
    if (!t || !vm) return res.status(404).json({ ok: false, reason: 'VM 을 찾을 수 없습니다.' });
    const { vcenterId } = t;
    if (registryUnreadable503(res)) return;   // v2.762(F4)
    if (!serversForVcenter(vcenterId).length) {
      if (isMockMode()) return res.json({ ok: true, demo: true, vm: { id: vm.id, name: vm.name }, detail: demoVeeamDetail(vcenterId, vm), servers: [DEMO_SERVER_VIEW()], at: Date.now() });
      return res.json({ ok: true, configured: false, vm: { id: vm.id, name: vm.name }, detail: null, servers: [] });
    }
    const { results, views, host, otherHosts } = resultsFor(vcenterId, req);
    const m = matchToVcenter({ id: vcenterId, host }, t.vms, results, { refsFor: vmId, otherHosts });
    res.json({ ok: true, configured: true, vm: { id: vm.id, name: vm.name }, detail: maskDetail(buildVmDetail(m.byVm[vmId]), isAdminDetailUser(req.user), vm.name), servers: views, at: Date.now() });
  });
}

/*
 * v2.766(점검 R1-A4-3, 판독): VM 상세의 lastTask.message 는 Veeam 작업 결과 원문(≤300자)이다 — 실패 문구에 프록시·저장소·호스트 주소가 들어갈 수 있다(추정 —
 *   실서버 표본 없음). 비고(publicNote)와 같은 주소 꼴(ADDR_LIKE)이 보이면 관리자가 아닌 계정에는 일반 문구로. 수는 이 VM 의 작업 것이라 가리지 않는다.
 */
/*
 * v2.767(점검 R2-B1-3): ADDR_LIKE 의 호스트 규칙은 ':포트' 가 있어야 해서 포트 없는 FQDN('vbr-proxy01.corp.local')·UNC 경로('\\nas01\veeam')를
 *   그대로 내보냈다(실제 Veeam 실패 문구에 들어가는지는 표본 없음 — 추정). 점 2개 이상 + 영문 끝 라벨인 호스트명과 UNC·'//host' 를 주소 꼴로 본다.
 *   ⚠ VM 이름에 점이 든 경우(db01.corp.local)는 작업 메시지에 그 이름이 늘 들어가므로 **VM 이름을 먼저 빼고** 판정한다(과잉 가림 방지).
 *   숫자뿐인 버전(12.1.2)은 끝 라벨이 영문이 아니라 걸리지 않는다. 입력은 300자로 먼저 자른다(라벨 길이도 상한 — 선형).
 */
const FQDN_LIKE_G = /\b(?:[a-z0-9-]{1,63}\.){2,}[a-z]{2,24}\b/gi;
const UNC_LIKE = /\\\\[A-Za-z0-9._-]|(?:^|[\s'"(])\/\/[A-Za-z0-9]/;
/*
 * v2.768(점검 R3-C1-2): ① VM 이름은 **단어 경계**(앞뒤 글자가 [a-z0-9.-] 가 아닌 자리)에서만 뺀다 — 부분 문자열로 빼면 vmName='corp' 가
 *   'vbr01.corp.local' 을 'vbr01. .local' 로 쪼개 FQDN 판정을 통과시켰다(원문 주소 노출). ② 대문자로 시작하는 라벨만으로 된 .NET 점 구분 식별자
 *   (Veeam.Backup.Core.CVmRestoreException — 소문자가 섞인 PascalCase)는 호스트명이 아니다(과잉 가림). 전부 대문자인 'VBR01.CORP.LOCAL'·흔한 내부 끝 라벨은 그대로 주소.
 *   300자 선절단은 그대로 — 이름 탐색은 indexOf 순방향(선형), 정규식은 상한 있는 반복만.
 */
const NAME_BOUND = /[a-z0-9.-]/;
const NAME_AFTER_BAD = /[a-z0-9]/;
const HOST_TLD = new Set(['local', 'lan', 'corp', 'internal', 'intra', 'home', 'localdomain', 'com', 'net', 'org', 'io', 'kr', 'jp', 'cn', 'de', 'pl', 'us', 'uk', 'eu', 'biz', 'info', 'co']);
function stripVmName(orig, name) {
  const lower = orig.toLowerCase();
  // 소문자화로 길이가 바뀌는 문자(드묾)가 있으면 위치가 어긋난다 — 그때는 소문자 사본에서 뺀다(.NET 판정을 못 해 가리는 쪽 = 보수).
  const src = lower.length === orig.length ? orig : lower;
  if (name.length < 3) return src;
  let out = ''; let from = 0; let i = lower.indexOf(name);
  while (i >= 0) {
    const before = i > 0 ? lower[i - 1] : '';
    const after = lower[i + name.length] || '';
    const after2 = lower[i + name.length + 1] || '';
    // v2.769(점검 R4-D1-4): 오른쪽 경계 — '.' 은 뒤에 영숫자가 이어질 때(이름이 더 긴 라벨의 앞부분)만 위반이고, 문장 마침표('… db01.corp.local.')·
    //   '-'(디스크 접미 'db01.corp.local-flat.vmdk')는 허용한다. 예전엔 둘 다 위반이라 이름이 안 빠져 FQDN 으로 걸려 가렸다(과잉 가림).
    //   왼쪽은 그대로 [a-z0-9.-] — vmName='corp' 가 'vbr01.corp.local' 을 쪼개 주소를 내보내던 v2.768 R3-C1-2 를 다시 열지 않는다.
    const rightBad = !!after && (NAME_AFTER_BAD.test(after) || (after === '.' && NAME_AFTER_BAD.test(after2)));
    if (!(before && NAME_BOUND.test(before)) && !rightBad) {
      out += `${src.slice(from, i)} `; from = i + name.length;
      i = lower.indexOf(name, from);
    } else i = lower.indexOf(name, i + 1);
  }
  return out + src.slice(from);
}
function isDotNetIdent(tok) {
  const labels = tok.split('.');
  if (HOST_TLD.has(labels[labels.length - 1].toLowerCase())) return false;
  return /[a-z]/.test(tok) && labels.every((l) => /^[A-Z][A-Za-z0-9]*$/.test(l));
}
function hasFqdn(text) {
  for (const m of text.matchAll(FQDN_LIKE_G)) if (!isDotNetIdent(m[0])) return true;
  return false;
}
export function publicTaskMessage(m, { vmName = '' } = {}) {
  const t = String(m || '').slice(0, 300);
  const name = String(vmName || '').trim().toLowerCase().slice(0, 300);
  // 판정용 사본에서만 VM 이름을 뺀다(돌려주는 문구는 원문 그대로). 대소문자는 원문 위치를 지키며 본다(.NET 판정이 대문자를 쓴다).
  const probe = name.length >= 3 ? stripVmName(t, name) : t;
  return ADDR_LIKE.test(probe) || hasFqdn(probe) || UNC_LIKE.test(probe) ? '작업 메시지에 주소가 들어 있어 관리자 화면에서만 보입니다' : t;
}
function maskDetail(detail, admin, vmName = '') {
  if (admin || !detail?.lastTask?.message) return detail;
  return { ...detail, lastTask: { ...detail.lastTask, message: publicTaskMessage(detail.lastTask.message, { vmName }) } };
}

/*
 * v2.779 — '백업' 메뉴(사용자 요청: 백업 서머리 = 전체 vCenter · 백업 세부내용 = vCenter 하나의 폴더 › VM · Veeam 과 스냅샷 둘 다).
 *   도구 키 backup-summary · backup-detail(auth/toolAccess.js) + tools 권한. 판정은 새로 만들지 않는다 — 위의 resultsFor·matchToVcenter·veeamCount
 *   (Veeam)와 cachedSnapEvents·snapCount(스냅샷)를 그대로 쓰고 veeam/backupStatus.js 가 VM 단위로 합친다(카드·VM 화면과 같은 수).
 *   범위: 서머리는 scope 교집합, 세부내용은 vcOf(범위 밖 404). 응답 캐시는 범위·역할 키(관리자 판본: 실행 중 작업 이름·otherVcenter 수).
 */
async function vcBackup(vc, vms, req, { initial = false, scope = null } = {}) {
  const admin = isAdminDetailUser(req.user);
  const linked = !registryBroken() && serversForVcenter(vc.id).length > 0;
  // v2.781(점검 G3 C-B1): VM 목록이 없으면(재시작 직후 골격 · 아직 수집 전 · 그 vCenter 인벤토리 0대) 대조 결과 0 은 사실이 아니다 — 모름.
  //   /veeam/backup-counts(v2.758)와 같은 규칙. ⚠ 판정은 vCenter **전체** 목록(vms)으로 — 전원·제외로 거른 목록(sv.vms)이 비었다고('꺼진 VM 0대') 모름이 아니다.
  const noInventory = initial || !vms.length;
  let vcnt = null; let match = null; let views = []; let runningStale = false;
  if (registryBroken()) {
    vcnt = { src: 'veeam', n: null, reason: 'registry-unreadable' };
  } else if (linked) {
    const r = resultsFor(vc.id, req);
    views = r.views;
    if (noInventory) vcnt = { src: 'veeam', n: null, reason: 'no-inventory' };
    else {
      match = r.results.length ? matchToVcenter({ id: vc.id, host: r.host }, vms, r.results, { otherHosts: r.otherHosts }) : null;
      vcnt = maskOtherVcenter(veeamCount({ views, byVm: match ? match.byVm : null, vmTotal: vms.length, otherVcenter: match?.otherVcenter || 0 }), admin, match ? Object.keys(match.byVm).length : 0);
      // v2.781(점검 G3 B-B1): 실패·오래된 결과라 '백업 중' 을 지운 서버가 있으면 실행 중·대기 수는 확정이 아니다(badges v2.761 D5 와 같은 판정).
      runningStale = r.results.some((x) => x.result?.runningStale === true);
    }
  } else if (isMockMode()) {
    match = demoVeeamMatch(vc.id, vms);
    views = [DEMO_SERVER_VIEW()];
    vcnt = veeamCount({ views, byVm: match.byVm, vmTotal: vms.length });
  }
  const isLinked = linked || (isMockMode() && !!match) || registryBroken();
  // ⚠ v2.780: 매칭·스냅샷 요약은 늘 vCenter **전체** VM 으로 — cachedSnapEvents 는 vCenter 별 캐시라 부분 목록으로 부르면 다른 화면의 값이 바뀐다.
  //   범위(전원·템플릿 제외)는 backupRow 에 넘기는 목록으로만 정한다.
  const ev = await cachedSnapEvents(vc.id, vms, { initial, wait: false });
  const sc = snapCount({ ev, vms });
  const sv = vmScope(vms, scope || {});
  const row = { ...backupRow({ vms: sv.vms, linked: isLinked, vcnt, match, sc, ev, runningStale, noInventory }), excluded: sv.excluded, powerUnknown: sv.powerUnknown };
  return { row, match, ev, vcnt, sc, views, linked: isLinked, scopedVms: sv.vms };
}

/** ?power=all|on|off & excl=1|0(기본 1 — 템플릿·vCLS 제외). 모르는 값은 기본. */
function scopeOf(req) {
  const power = POWER_VALUES.includes(String(req.query.power || '')) ? String(req.query.power) : 'all';
  return { power, excl: String(req.query.excl ?? '1') !== '0' };
}

async function summaryData(req, snap, scope) {
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const maybeYield = createYielder(15);
  const rows = []; const jobs = [];
  for (const vc of vcs) {
    await maybeYield();
    const vms = vmsBy.get(vc.id) || [];
    const b = await vcBackup(vc, vms, req, { initial: snap?.initial === true, scope });
    rows.push({ id: vc.id, name: vc.name || vc.id, ...b.row,
      veeamReason: b.vcnt?.reason || '', veeamServers: b.views.length, veeamFailed: b.vcnt?.failed || 0, veeamStale: b.vcnt?.stale || 0,
      ...(b.vcnt?.hostMismatch ? { hostMismatch: true } : {}), snapReason: b.sc?.reason || '', ...(isMockMode() && b.linked && !serversForVcenter(vc.id).length ? { demo: true } : {}) });
    // 지금 도는 작업(작업 전체 진행률) — 작업 이름은 서버 전체 기준이라 관리자 판본만(v2.778.1 과 같은 이유). 범위(전원)와 무관한 작업 단위 값이다.
    if (admin) for (const v of b.views) for (const j of v.runningJobs || []) if (jobs.length < 30) jobs.push({ vcenter: vc.name || vc.id, server: v.name, name: j.name, pg: j.pg });
  }
  return { ok: true, at: Date.now(), scope, rows, totals: backupTotals(rows), ...(admin ? { runningJobs: jobs } : {}), registryUnreadable: registryBroken() || undefined };
}

async function detailData(req, snap, t, scope) {
  const admin = isAdminDetailUser(req.user);
  const vc = (snap?.vcenters || []).find((v) => v.id === t.vcenterId) || { id: t.vcenterId };
  const b = await vcBackup(vc, t.vms, req, { initial: snap?.initial === true, scope });
  const veeamKnown = b.row.veeam != null;
  const snapKnown = b.row.snap != null;
  const now = Date.now();
  const vms = b.scopedVms.map((vm) => vmBackupView(vm, b.match?.byVm?.[vm.id], b.ev?.byVm?.[vm.id], { veeamKnown: veeamKnown || !b.linked, snapKnown, absentKnown: !b.row.veeamAbsentUnknown, now }));   // v2.782(점검 K4 B-B3)
  const views = b.views.map((v) => ({ name: v.name, ok: v.ok, lastOkTs: v.lastOkTs, stale: v.stale, error: v.error, authStopped: v.authStopped, via: v.via, ...(admin && v.runningJobs ? { runningJobs: v.runningJobs } : {}) }));
  return { ok: true, at: now, scope, vcenter: { id: vc.id, name: vc.name || vc.id }, row: { ...b.row, veeamReason: b.vcnt?.reason || '', snapReason: b.sc?.reason || '', ...(b.vcnt?.hostMismatch ? { hostMismatch: true } : {}) },
    linked: b.linked, servers: views, snapDays: b.ev?.days ?? null, snapSource: b.ev?.source || '', vms, ...(b.match?.aliasHosts && admin ? { aliasHosts: b.match.aliasHosts } : {}) };
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '');
const scopeText = (sc) => `${sc.power === 'on' ? '켜진 VM' : sc.power === 'off' ? '꺼진 VM' : '전체 VM'}${sc.excl ? ' · 템플릿·vCLS 제외' : ''}`;

export function registerBackupStatus(api) {
  const toolsPerm = requirePerm('tools');
  const csvPerm = requirePerm('data.csv');

  api.get('/tools/backup-summary', toolsPerm, (req, res) => {
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, 'backup-summary', async () => summaryData(req, snap, scope),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}` });   // 키에 req.originalUrl(전원·제외)도 든다(shared.js)
  });

  api.get('/tools/backup-detail', toolsPerm, async (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, `backup-detail:${t.vcenterId}`, async () => detailData(req, snap, t, scope),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}` });
  });

  // v2.780(사용자 선택 'CSV 내보내기'): 화면과 같은 조건 그대로 — 데이터 내보내기 권한(data.csv) + 감사 로그(다른 도구 CSV 와 같은 규칙).
  // v2.781(점검 G3 B-I2): CSV 2종은 누를 때마다 서머리(vCenter 전부의 대조·스냅샷 요약)를 다시 계산한다 — 동시 1건(util/exportBusy · v2.575 규약).
  //   잠금은 범위·존재 판정(404) 뒤에 잡고 release 는 finally(예외로 빠져나가도 이름이 잠기지 않게). 넘으면 409 export_busy.
  api.get('/tools/backup-summary.csv', csvPerm, toolsPerm, async (req, res) => {
    const lock = acquireExport('backup-summary.csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const scope = scopeOf(req);
      const d = await summaryData(req, store.get(), scope);
      const lines = [CSV_BOM + csvLine(['vCenter', '범위', 'VM', 'Veeam 백업', '스냅샷 기준', '둘 다', 'Veeam 만', '스냅샷만', '확인 안 됨', '백업 중', '대기',
        '오래된 백업 1일+', '오래된 백업 3일+', '오래된 백업 7일+', '완료 시각 모름', '실패', '경고', '마지막 백업 완료(UTC)', 'Veeam 상태', '스냅샷 잔존', '제외(템플릿·vCLS)', '전원 모름'])];
      const n = (v) => (Number.isFinite(v) ? v : '');
      // v2.781(B-B1): '백업 중' 을 지운 서버가 있으면 0 은 모름(빈칸) · 0 이 아니면 하한(≥N) — 화면과 같은 규칙.
      const run = (r, v) => (r.runningStale && Number.isFinite(v) ? (v > 0 ? `≥${v}` : '') : n(v));
      for (const r of d.rows) {
        lines.push(csvLine([r.name, scopeText(scope), n(r.vm), n(r.veeam), n(r.snap), n(r.split?.both), n(r.split?.vOnly), n(r.split?.sOnly), n(r.split?.none), run(r, r.running), run(r, r.pending),
          n(r.rpo?.d1), n(r.rpo?.d3), n(r.rpo?.d7), n(r.rpo?.unknown), n(r.results?.failed), n(r.results?.warning), iso(r.lastBackup), r.veeamState || '', n(r.snapStale), n(r.excluded), n(r.powerUnknown)]));
      }
      logAudit({ user: req.user?.username, action: 'backup-summary.csv', target: 'backup-summary', detail: `${d.rows.length} rows · ${scopeText(scope)}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backup-summary-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });

  api.get('/tools/backup-detail.csv', csvPerm, toolsPerm, async (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const lock = acquireExport('backup-detail.csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const scope = scopeOf(req);
      const filter = VIEW_FILTERS.includes(String(req.query.filter || '')) ? String(req.query.filter) : 'all';
      const rpoDays = RPO_DAYS.includes(Number(req.query.rpoDays)) ? Number(req.query.rpoDays) : 1;
      const d = await detailData(req, store.get(), t, scope);
      const now = Date.now();
      const st = (v) => (v === undefined ? '모름' : !v ? '없음' : v.state === 'run' ? '백업 중' : v.state === 'wait' ? '대기' : '백업 대상');
      const lines = [CSV_BOM + csvLine(['vCenter', '폴더', 'VM', '전원', 'Veeam', '진행률(%)', '작업', '복원 지점', '마지막 백업 완료(UTC)', '마지막 결과',
        `스냅샷 최근 ${d.snapDays || 7}일 횟수`, '스냅샷 마지막(UTC)', '지금 스냅샷', '스냅샷 잔존'])];
      let n = 0;
      for (const vm of d.vms) {
        if (!vmViewMatches(vm, filter, { rpoDays, now })) continue;
        n++;
        const v = vm.v; const s = vm.s || {};
        lines.push(csvLine([d.vcenter.name, vm.folder, vm.name, vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '', st(v), v && Number.isFinite(v.pg) ? v.pg : '',
          v?.jobs?.join(' | ') || '', v && Number.isFinite(v.rp) && v.rp >= 0 ? v.rp : '', iso(v?.lb), v ? (v.lr || v.lastResult || '') : '',
          s.ev === undefined ? '모름' : s.ev ? (s.ev.n ?? '') : 0, iso(s.ev?.ts), s.now && !s.now.stale ? s.now.n : '', s.now?.stale ? '예' : '']));
      }
      logAudit({ user: req.user?.username, action: 'backup-detail.csv', target: t.vcenterId, detail: `${n} rows · ${scopeText(scope)} · 보기 ${filter}${filter === 'rpo' ? ` ${rpoDays}일` : ''}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backup-detail-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });
}
