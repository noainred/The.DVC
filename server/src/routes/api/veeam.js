// Veeam 백업 VM 배지(v2.751) — vCenter › VM 및 폴더의 'Veeam 백업 VM 표시' 체크박스가 부른다.
// 조회 전용·로그인 사용자(트리를 볼 수 있는 계정이면 배지도 본다 — 어떤 VM 이 백업 대상인지·작업 이름뿐, 계정 없음 · 오류 원문(주소)은 관리자만).
// scope: id 를 직접 받는 단건 라우트라 범위 밖 vCenter 는 404(존재 은닉 — server/CLAUDE.md). 체크박스를 켰을 때만 60초 폴링한다.
import { store } from '../../store.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { serversForVcenter, registryLoadError, listServers } from '../../veeam/registry.js';
import { getRecord, usableResult } from '../../veeam/store.js';
import { matchToVcenter, withoutStaleRunning, buildVmDetail, TASK_MSG } from '../../veeam/parse.js';
import { pollMs } from '../../veeam/poller.js';
import { isAdminDetailUser, isDemoGuest } from '../../auth/demoGuest.js';
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
import { requirePerm, requireRole, toolActorOf } from '../../auth/auth.js';
import { issueFor } from '../../auth/toolAccess.js';
import { backupRow, backupTotals, vmBackupView, cloneView, cloneResultText, METHOD_TEXT, vmScope, POWER_VALUES, RPO_DAYS, VIEW_FILTERS, vmViewMatches, priorityCandidates, priorityRank, PRIORITY_MAX, ynDaysOf } from '../../veeam/backupStatus.js';   // v2.779 백업 메뉴 · v2.780 범위·CSV
import { vmListCsvAsync, vmTreeCmp, VM_LIST_MAX_IDS, folderParts } from '../../veeam/vmListCsv.js';
import { resolveCols, needsOf, selectedColumns, catalogView } from '../../veeam/vmListCatalog.js';   // v2.798 필요한 항목만 고르기(v2.800 백업 현황 › Detail '백업 내보내기' 전용)
import { getPrefs, setPref, clearPref } from '../../veeam/vmListPrefs.js';   // v2.798 계정 저장값(기본값 · 5칸)
import { vmRefOf, vmTagsOf, tagStateOf } from '../../tags/analyze.js';
import { renderVmListWorkbook, XLSX_MIME } from '../../veeam/vmListXlsx.js';   // v2.792 같은 목록의 엑셀(폴더 트리 — 시안 승인)
import { setVeeamVmViewProvider } from '../../veeam/vmViewProvider.js';
import { cloneStateByVm } from '../../vmclone/jobState.js';   // v2.803 백업 현황 Detail 'Clone' 칸(복제 잡 마지막 실행 — 실행 노드 기준)
import { jobsRev } from '../../vmclone/store.js';
import { jobDigests as bareosJobDigests, registryLoadError as bareosRegistryLoadError, registryRev as bareosRegistryRev } from '../../bareos/registry.js';   // v2.828 Detail 'Bareos' 칸
import { bareosVmView } from '../../bareos/vmView.js';   // v2.801 VM 전체 정보 내보내기의 Veeam 묶음(같은 vcBackup → vmBackupView)
import { listGroups as bareosGroups, groupsLoadError as bareosGroupsLoadError, groupsRev as bareosGroupsRev } from '../../bareos/groups.js';   // v2.835 Detail '다음 예정'(Bareos 그룹 예약)
import { nextSlot as bareosNextSlot } from '../../bareos/groupSchedule.js';
import { policyFields } from '../../veeam/backupPolicy.js';   // v2.835 백업 정책 · 실제 · 정책≠실제 · 마지막 성공
import { newSiteAgg, addSiteVm, finishSiteAgg, sumSiteAggs, countVeeamWindow, staleQueryOf, newStaleAcc, addStaleRows, finishStaleRows } from '../../veeam/backupSummaryAgg.js';   // v2.836 Summary 법인 집계 · 전체 법인 찾기
import { corpView as bareosCorpView } from './bareosLive.js';   // v2.837 Summary '멈춤 의심'(진행 현황과 같은 판정 — 조회를 새로 일으키지 않는다)
import { effectiveSettings as bareosEffectiveSettings, isDemoActive as bareosIsDemoActive } from '../../bareos/service.js';
import { directorById as bareosDirectorById, jobDirectorId as bareosJobDirectorId } from '../../bareos/settings.js';
import { directorNextByJob, policySummary as bareosPolicySummary, directorScheduleItems, policyRev as bareosPolicyRev, errorVolumeItems as bareosErrorVolumeItems } from '../../bareos/policy.js';   // v2.839 Director 정책 수집본(접속하지 않는다)
import { pollerStatus as bareosPollerStatus } from '../../bareos/poller.js';
import { LIVE_IDLE_MS as BAREOS_LIVE_IDLE_MS } from '../../bareos/liveStatus.js';
import { veeamJobItems, jobsFromRows, groupItems, overlapOf, groupOverlaps, sevenDays, MAX_ITEMS_PER_SITE } from '../../veeam/backupSchedule.js';   // v2.838 '백업 스케줄 — 다음 24시간' · v2.840 그룹 카드 겹침
import { ERROR_DAYS, veeamVmRows, bareosRows, stuckRows, emSessionRows, collectRows, volumeRows, finishErrors } from '../../veeam/backupErrors.js';   // v2.838 통합 에러 로그
import { loadAlert, saveAlert, alertLoadError, alertStatus, sendNow as sendStaleAlertNow, setStaleProvider, MAIL_KIND as STALE_MAIL_KIND } from '../../veeam/staleAlert.js';   // v2.838 백업 안 된 VM 일일 메일
import { load as loadMailSettings } from '../../mail/settings.js';
import { dayIndex, dayStartMs } from '../../util/dayKey.js';
export { VM_LIST_MAX_IDS };
import { logAudit } from '../../audit.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';   // v2.781(점검 G3 B-I2): 백업 CSV 2종 동시 1건
import { getMarks, setMarks, markCounts, markView, marksRev, marksUnreadable, marksCorruptKept, MAX_IDS_PER_REQUEST } from '../../veeam/backupMarks.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { pushAll } from '../../util/pushAll.js';
import { listEms, getEmWithSecret } from '../../veeam/em/registry.js';
import { getEmRecord } from '../../veeam/em/store.js';
import { emPollMs, emAuthGuard } from '../../veeam/em/poller.js';
import { sessionDetail } from '../../veeam/em/client.js';
import { withDeadline } from '../../util/deadline.js';
import { emView, jobsView, licenseTotals, vcIndexOf } from '../../veeam/em/view.js';
import { getEmMap, emMapRev } from '../../veeam/em/mapping.js';
import { currentLicenses } from '../../veeam/licenseWatch.js';
import { licenseHistory, repoHistory } from '../../veeam/historyDb.js';
import { demoEmViews, demoLicenses, demoSessionDetail, DEMO_EM_IDS } from '../../mock/demo/veeamEm.js';
import { emSourcesForVcenter, emLinkedVcenter, emSourcesRev } from '../../veeam/em/sources.js';   // v2.795 EM 을 vCenter 화면의 Veeam 출처로(VM 단위)   // v2.784 백업 표시(중요도·백업 필요·메모)

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

/** v2.795: 그 B&R 등록이 이 vCenter 를 맡고 지금 정상인가(마지막 읽기 성공 · 그 결과를 만든 노드 주기로 오래되지 않음) — EM 출처를 뺄지 정한다. */
export function brHealthy(brId, vcenterId, now = Date.now()) {
  if (!serversForVcenter(vcenterId).some((d) => d.id === brId)) return false;
  const rec = getRecord(brId);
  return rec?.result?.ok === true && Number(rec.result.ts) > 0 && now - Number(rec.result.ts) <= resultMaxAgeMs(rec.via, rec.agent);
}
/** v2.795: 이 vCenter 에 Veeam 출처(B&R 등록 또는 매핑된 EM 백업 서버)가 있는가 — '연동 없음' 판정 하나. */
export function veeamLinked(vcenterId) {
  return serversForVcenter(vcenterId).length > 0 || emLinkedVcenter(vcenterId);
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
  // v2.795: Enterprise Manager 출처(매핑으로 이 vCenter 가 정해진 EM 백업 서버) — 짝지은 B&R 등록이 이 vCenter 를 맡고 지금 정상이면 빼고, 아니면 넣는다(사용자 결정 'B&R 우선, 실패 시 EM').
  const em = emSourcesForVcenter(vcenterId, { brHealthy: (id, vc) => brHealthy(id, vc, now), admin, maxAgeMs: emPollMs() * 2 + 120_000, now });
  for (const x of em.results) results.push(x);
  for (const v of em.views) views.push(v);
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
  setVeeamVmViewProvider(veeamViewsForExport);
  api.get('/veeam/badges', (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const { vcenterId, vms } = t;
    if (registryUnreadable503(res)) return;   // v2.762(F4)
    const admin = isAdminDetailUser(req.user);
    if (!veeamLinked(vcenterId)) {
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

  /*
   * v2.792(사용자 요청 "Vcenter 화면에서 vm 폴더에서 vm list export 할때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부 포함해서
   *   csv export" · 선택 '화면 기준 전체'): vCenter › VM 및 폴더의 VM 목록 CSV.
   *   · 대상 = 화면이 보낸 VM id(‘Off VM 포함’·검색 결과를 반영한 목록) ∩ 그 vCenter 의 지금 인벤토리. id 를 보내지 않으면 전체(power 'noOff' 면 꺼진 VM 제외 —
   *     화면 visibleVms 와 같은 조건). 남의 vCenter id 는 교집합에서 빠진다.
   *   · 판정은 '백업 세부내용' 과 같은 vcBackup → vmBackupView(판정 코어 하나) · 한 칸 판단은 backupStatus.backupVerdict. 사람이 정한 표시(중요도·메모)는
   *     백업 세부내용 도구 데이터라 싣지 않는다.
   *   · 읽기 POST(본문에 id 목록) — 게이트는 CSV 내보내기 권한(data.csv — 관리자 전용, 웹 canCsv 와 같은 판정) · 조회 범위 밖 vCenter 404(vcOf) ·
   *     동시 1건(exportBusy — vCenter 전체 대조·스냅샷 요약을 다시 계산한다) · 감사 로그.
   */
  api.post('/veeam/vm-list.csv', requirePerm('data.csv'), (req, res) => vmListExport(req, res, 'csv'));
  /*
   * v2.792(사용자 요청 "클로드 디자인 사용 · 멋지게 · 폴더구조 잘 나오게" · 선택 엑셀 추가 + CSV 유지 · 시안 https://claude.ai/artifact/MENTpVFxe9D4Y4XgAazpBg 승인):
   *   같은 대상·같은 판정·같은 게이트의 **엑셀**(요약 · 폴더 트리(행 그룹 접기) · 데이터(행 단위 = CSV 와 같은 열) · 읽는 법). 워커 스레드에서 만든다
   *   (상한 2만 대를 메인에서 만들면 5초 멈춘다 — 작성 중 실측. veeam/vmListXlsx.js renderVmListWorkbook).
   */
  api.post('/veeam/vm-list.xlsx', requirePerm('data.csv'), (req, res) => vmListExport(req, res, 'xlsx'));

  /*
   * v2.798(사용자 요청 "메모, TAG, 디스크 파티션 종류 등 구성 정보에서 내가 필요한 것만 선택해서 export" · 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW):
   *   · catalog — 고를 수 있는 항목·빠른 조합(veeam/vmListCatalog.js 하나 — 웹은 복제하지 않는다) + 그 vCenter 의 실제 수집 상태(태그) + 내 저장값.
   *   ⚠ v2.800(사용자 지시 '화면 분리'): 이 창은 **백업 현황 › Detail 의 CSV 버튼**(백업 내보내기)이다 — 전체 VM 구성 내보내기는 routes/api/vmExport.js(도구 vm-export).
   *   · preview — 고른 항목으로 화면이 보낸 VM 3대의 행(같은 표 함수 — 내려받기와 같은 값).
   *   · prefs — 내 저장값(기본값 · 1~5칸). 키는 인증된 계정 이름(본문 값을 믿지 않는다) · 바꾸기는 관리자·운영자 · 데모 손님 불가 · 감사.
   *   게이트는 내보내기와 같은 data.csv · 조회 범위 밖 vCenter 404(vcOf).
   */
  api.get('/veeam/vm-list/catalog', requirePerm('data.csv'), (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const vc = (store.get()?.vcenters || []).find((v) => v.id === t.vcenterId) || {};
    const inv = vc.tagInv || null;
    res.set('Cache-Control', 'no-store').json({
      ok: true, ...catalogView({ snapDays: LOOKBACK_DAYS }),
      status: {
        vmTotal: t.vms.length, tags: tagStateOf(inv), tagsAt: inv?.tagsAt ?? null, tagCategories: Array.isArray(inv?.categories) ? inv.categories.length : 0,
      },
      prefs: getPrefs(req.user?.username),
    });
  });
  api.post('/veeam/vm-list/preview', requirePerm('data.csv'), async (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const sel = selOf({ ...body, cols: body.cols ?? [] });
    if (!sel.ok) return res.status(400).json({ ok: false, reason: sel.reason });
    // v2.801: 크게 보기(전체 화면 팝업)는 100대까지 — 창 안 미리보기는 3대를 보낸다. 행은 트리 순서(vmTreeCmp)라 폴더별로 나눠 볼 수 있게 폴더 경로를 함께 싣는다.
    const want = new Set((Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string').slice(0, VM_LIST_PREVIEW_MAX));
    const list = t.vms.filter((vm) => want.has(vm.id)).sort(vmTreeCmp);
    try {
      const snap = store.get();
      const vc = (snap?.vcenters || []).find((v) => v.id === t.vcenterId) || { id: t.vcenterId };
      const now = Date.now();
      const b = needsOf(sel.keys).has('veeam') ? await vcBackup(vc, t.vms, req, { initial: snap?.initial === true, scope: { power: 'all', excl: false } }) : null;
      const rows = b ? list.map((vm) => ({ inv: vm, view: vmBackupView(vm, b.match?.byVm?.[vm.id], b.ev?.byVm?.[vm.id],
        { veeamKnown: b.row.veeam != null || !b.linked, snapKnown: b.row.snap != null, absentKnown: !b.row.veeamAbsentUnknown, now }) })) : [];
      const table = await vmListSelTable({ vc, vcName: vc.name || vc.id, list, rows, b, sel, snapDays: b?.ev?.days ?? LOOKBACK_DAYS, now, maybeYield: async () => {} });
      const n = Math.min(table.cells.length, VM_LIST_PREVIEW_MAX);
      res.set('Cache-Control', 'no-store').json({ ok: true, head: table.head, keys: table.keys, cells: table.cells.slice(0, n), folders: table.folders.slice(0, n), vms: list.length });
    } catch { res.status(500).json({ ok: false, reason: '미리보기를 만들지 못했습니다.' }); }
  });
  api.get('/veeam/vm-list/prefs', requirePerm('data.csv'), (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, prefs: getPrefs(req.user?.username) }));
  const prefsWrite = (fn) => (req, res) => {
    if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 저장할 수 없습니다.' });
    const r = fn(req);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason, ...(r.code ? { [r.code]: true } : {}) });
    logAudit({ user: req.user?.username, action: 'vm-list.prefs', target: String(req.body?.slot ?? req.query?.slot ?? ''), detail: req.method === 'DELETE' ? '지움' : `저장 · ${(req.body?.value?.cols || []).length}개 항목${req.body?.alsoDefault ? ' · 기본값으로도' : ''}`, ip: req.ip });
    res.json({ ok: true, prefs: r.prefs });
  };
  api.put('/veeam/vm-list/prefs', requirePerm('data.csv'), requireRole('admin', 'operator'), prefsWrite((req) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    return setPref(req.user?.username, b.slot === 'default' ? 'default' : Number(b.slot), b.value, { alsoDefault: b.alsoDefault === true });
  }));
  api.delete('/veeam/vm-list/prefs', requirePerm('data.csv'), requireRole('admin', 'operator'), prefsWrite((req) => clearPref(req.user?.username, req.query.slot === 'default' ? 'default' : Number(req.query.slot))));

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
        if (veeamLinked(vc.id)) {
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
    }, { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|em${emSourcesRev()}` });   // v2.762(F5): 판본이 역할로 갈린다 — 키에 역할
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
    if (!veeamLinked(vcenterId)) {
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
/**
 * v2.838 통합 에러 로그의 Veeam 메시지 — byVm 항목의 Symbol 키(parse.js TASK_MSG)에서 꺼내, 관리자 판본이 아니면 VM 상세와 같은 가림(publicTaskMessage).
 * @returns {(row:{id,name}) => string}
 */
export function taskMsgOf(byVm, admin) {
  return (r) => {
    const m = byVm?.[r?.id]?.[TASK_MSG];
    if (typeof m !== 'string' || !m) return '';
    return admin ? m : publicTaskMessage(m, { vmName: r?.name || '' });
  };
}
function maskDetail(detail, admin, vmName = '') {
  if (admin || !detail?.lastTask?.message) return detail;
  return { ...detail, lastTask: { ...detail.lastTask, message: publicTaskMessage(detail.lastTask.message, { vmName }) } };
}

/*
 * v2.792 — vCenter › VM 및 폴더 'VM 목록' 내보내기(CSV · 엑셀 공용).
 *   · 대상 = 화면이 보낸 VM id(‘Off VM 포함’·검색 결과를 반영한 목록) ∩ 그 vCenter 의 지금 인벤토리. id 를 보내지 않으면 전체(power 'noOff' 면 꺼진 VM 제외 —
 *     화면 visibleVms 와 같은 조건). 남의 vCenter id 는 교집합에서 빠진다. view(검색 · 전체 · 꺼진 VM 제외)는 **표시용 이름표**일 뿐 대상을 고르지 않는다.
 *   · 판정은 '백업 세부내용' 과 같은 vcBackup → vmBackupView(판정 코어 하나) · 한 칸 판단은 backupStatus.backupVerdict. 사람이 정한 표시(중요도·메모)는
 *     백업 세부내용 도구 데이터라 싣지 않는다.
 *   · 읽기 POST(본문에 id 목록) — 게이트는 CSV 내보내기 권한(data.csv — 관리자 전용, 웹 canCsv 와 같은 판정) · 조회 범위 밖 vCenter 404(vcOf) ·
 *     동시 1건(exportBusy — vCenter 전체 대조·스냅샷 요약을 다시 계산한다) · 감사 로그 · 파일 이름에 화면 조건(all · poweredon · search).
 */
/** v2.801 미리보기 '크게 보기' 상한(VM 수) — 창 안 미리보기는 3대. */
export const VM_LIST_PREVIEW_MAX = 100;
/**
 * v2.801 VM 전체 정보 내보내기의 Veeam 묶음(veeam/vmViewProvider.js 로 건다) — VM 목록 내보내기와 같은 vcBackup → vmBackupView(판정 코어 하나).
 * vms = 그 vCenter 의 **전체** VM(대조·스냅샷 요약은 vCenter 전체로 — vcBackup 주석). 범위 검사는 부르는 라우트가 끝냈다.
 */
async function veeamViewsForExport(vc, vms, req, { now = Date.now() } = {}) {
  const snap = store.get();
  const b = await vcBackup(vc, vms, req, { initial: snap?.initial === true, scope: { power: 'all', excl: false } });
  const veeamKnown = b.row.veeam != null || !b.linked;
  const snapKnown = b.row.snap != null;
  const byId = new Map();
  for (const vm of vms) {
    byId.set(vm.id, vmBackupView(vm, b.match?.byVm?.[vm.id], b.ev?.byVm?.[vm.id], { veeamKnown, snapKnown, absentKnown: !b.row.veeamAbsentUnknown, now }));
  }
  return { linked: b.linked, snapDays: b.ev?.days ?? LOOKBACK_DAYS, byId };
}
// v2.798 폴더 고르기 · v2.800 detail = 백업 현황 › Detail 화면에 보이는 VM(보기·검색 반영 — 창이 그 id 를 보낸다)
const VM_LIST_VIEWS = Object.freeze({ all: '전체 VM', noOff: '꺼진 VM 제외(‘Off VM 포함’ 해제)', search: '검색 결과', folder: '고른 폴더', detail: '백업 현황 화면' });
const VM_LIST_FILE_TAG = Object.freeze({ all: 'all', noOff: 'poweredon', search: 'search', folder: 'folder', detail: 'backup' });
/** v2.798 본문의 '고른 항목' — 없으면 null(v2.792 열). { ok, keys, tagCols } | { ok:false, reason }. */
function selOf(body) {
  if (body.cols == null) return null;
  const c = resolveCols(body.cols);
  if (!c.ok) return c;
  return { ok: true, keys: c.keys, tagCols: body.tagCols === true, ynDays: ynDaysOf(body.ynDays) };
}

/**
 * v2.798 고른 항목의 표(머리 + 칸) — 카탈로그(veeam/vmListCatalog.js) 하나로 CSV·엑셀 데이터 시트·미리보기가 같은 값을 쓴다.
 * 고른 항목에 필요한 소스만 읽는다: 태그(스냅샷 vcenter.tagInv — 못 읽은 vCenter 는 '수집 안 됨') · 백업 표시(파일을 못 읽으면 빈칸).
 * Veeam 열은 vmBackupView(rows — 위에서 만든 것) 그대로. (v2.800: 게스트 파티션·구성 열은 'VM 전체 정보 내보내기' 로 — 여기서 읽지 않는다)
 */
async function vmListSelTable({ vc, vcName, list, rows, b, sel, snapDays, now, maybeYield, limit = Infinity }) {
  const need = needsOf(sel.keys);
  const tagInv = need.has('tags') ? (vc?.tagInv || null) : null;
  const tagOk = !!tagInv && ['ok', 'stale'].includes(tagStateOf(tagInv));
  const marks = need.has('marks') ? getMarks() : null;
  const marksOk = need.has('marks') && !marksUnreadable();
  const clones = need.has('clone') ? cloneStatesOf(vc?.id) : null;   // v2.803 Clone 마지막 실행(백업 방식 Clone 인 VM 만)
  const viewOf = new Map(rows.map((r) => [r.inv.id, r.view]));
  const out = [];
  let levels = 1;
  for (const vm of list) {
    if (out.length >= limit) break;
    await maybeYield();
    levels = Math.max(levels, folderParts(vm.folder).length);
    const r = { vc: vcName, linked: b ? b.linked : false, inv: vm, view: viewOf.get(vm.id) };
    if (need.has('tags')) r.tg = tagOk ? vmTagsOf(tagInv, vmRefOf(vc.id, vm.id)) : undefined;
    if (need.has('marks')) { r.mark = markView(marks?.[vm.id]); r.marksOk = marksOk; }
    if (need.has('clone') && r.mark?.method === 'clone') r.clone = clones ? cloneView(clones.get(vm.id)) : null;
    out.push(r);
  }
  const cols = selectedColumns(sel.keys, { levels: Math.min(32, levels), tagCols: sel.tagCols, tagCategories: (tagInv?.categories || []).map((c) => c?.name), snapDays, now, ynDays: sel.ynDays });
  const cells = []; const folders = [];
  for (const r of out) { await maybeYield(); cells.push(cols.map((c) => c.get(r))); folders.push(folderParts(r.inv.folder).join('/')); }
  return { head: cols.map((c) => c.h), keys: cols.map((c) => c.key), folderCols: cols.map((c) => !!c.folderLevel), cells, folders, vms: out.length };
}

async function vmListExport(req, res, kind) {
  const t = vcOf(req);
  if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  let ids = null;
  if (body.ids != null) {
    if (!Array.isArray(body.ids)) return res.status(400).json({ ok: false, reason: 'VM 목록 형식이 잘못됐습니다.' });
    if (body.ids.length > VM_LIST_MAX_IDS) return res.status(400).json({ ok: false, reason: `VM 은 한 번에 ${VM_LIST_MAX_IDS}대까지입니다.` });
    ids = new Set(body.ids.filter((x) => typeof x === 'string' && x && x.length <= 300));
  }
  const noOff = body.power === 'noOff';
  const view = Object.hasOwn(VM_LIST_VIEWS, body.view) ? body.view : ids ? 'all' : noOff ? 'noOff' : 'all';
  // v2.798: cols 를 보내면 고른 항목·순서로(vmListCatalog) — 안 보내면 v2.792 열 그대로(예전 화면·기본 엑셀). 모르는 항목은 400(조용히 버리지 않는다).
  const sel = selOf(body);
  if (sel && !sel.ok) return res.status(400).json({ ok: false, reason: sel.reason });
  const lock = acquireExport(`vm-list.${kind}`, req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const snap = store.get();
    const vc = (snap?.vcenters || []).find((v) => v.id === t.vcenterId) || { id: t.vcenterId };
    const now = Date.now();
    const maybeYield = createYielder(15);
    // v2.798: Veeam 대조(vCenter 전체 · 스냅샷 요약)는 무겁다 — 고른 항목에 Veeam 열이 없고 CSV 면 건너뛴다(엑셀은 요약·트리 시트가 쓴다).
    const needVeeam = !sel || kind === 'xlsx' || needsOf(sel.keys).has('veeam');
    const b = needVeeam ? await vcBackup(vc, t.vms, req, { initial: snap?.initial === true, scope: { power: 'all', excl: false } }) : null;
    const scoped = b ? b.scopedVms : vmScope(t.vms, { power: 'all', excl: false }).vms;
    // 순서는 트리를 위에서부터 읽은 순서(vmTreeCmp — 엑셀 폴더 트리·데이터 시트와 같다)
    const list = scoped.filter((vm) => (ids ? ids.has(vm.id) : !(noOff && vm.powerState === 'POWERED_OFF'))).sort(vmTreeCmp);
    const rows = [];
    // v2.803: 엑셀 폴더 트리 시트의 '백업 방식'·'Clone' 칸 — 사람이 정한 표시와 복제 잡 상태를 view 에 싣는다(Detail 화면과 같은 vmBackupView)
    const xMarks = kind === 'xlsx' && !marksUnreadable() ? getMarks() : null;
    const xClones = kind === 'xlsx' ? cloneStatesOf(vc.id) : null;
    if (b) {
      const veeamKnown = b.row.veeam != null;
      const snapKnown = b.row.snap != null;
      for (const vm of list) {
        await maybeYield();
        rows.push({ inv: vm, view: vmBackupView(vm, b.match?.byVm?.[vm.id], b.ev?.byVm?.[vm.id],
          { veeamKnown: veeamKnown || !b.linked, snapKnown, absentKnown: !b.row.veeamAbsentUnknown, now,
            ...(xMarks ? { mark: markView(xMarks[vm.id]), clone: xClones ? cloneView(xClones.get(vm.id)) : null } : {}) }) });
      }
    }
    const vcName = vc.name || vc.id;
    const snapDays = b?.ev?.days ?? LOOKBACK_DAYS;
    const table = sel ? await vmListSelTable({ vc, vcName, list, rows, b, sel, snapDays, now, maybeYield }) : null;
    const fileBase = `vm-list-${String(t.vcenterId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}-${VM_LIST_FILE_TAG[view]}-${fileStamp()}`;
    let payload; let type;
    if (kind === 'xlsx') {
      const veeamText = !b.linked ? '연동 없음 — 스냅샷으로만 판단' : b.vcnt?.n == null ? '연결됨(이번 대조 결과 모름)' : `연결됨(서버 ${b.views.length}대)`;
      const out = await renderVmListWorkbook({ vcName, rows, linked: b.linked, snapDays, marksUnknown: marksUnreadable(), cond: `${VM_LIST_VIEWS[view]} ${rows.length}대`, veeamText, at: now,
        ...(table ? { dataTable: { head: table.head, keys: table.keys, cells: table.cells, folderCols: table.folderCols } } : {}) }, { signal: ac.signal });
      payload = out.buffer; type = XLSX_MIME;
    } else if (table) {
      const lines = [CSV_BOM + csvLine(table.head)];
      for (const c of table.cells) { await maybeYield(); lines.push(csvLine(c)); }
      payload = lines.join('\r\n'); type = 'text/csv; charset=utf-8';
    } else {
      payload = await vmListCsvAsync({ vcName, rows, linked: b.linked, snapDays }, maybeYield); type = 'text/csv; charset=utf-8';
    }
    if (ac.signal.aborted) return;
    logAudit({ user: req.user?.username, action: `vm-list.${kind}`, target: t.vcenterId, detail: `${list.length} rows · ${VM_LIST_FILE_TAG[view]}${ids ? ' · 화면 목록' : noOff ? ' · 꺼진 VM 제외' : ''}${table ? ` · 고른 항목 ${sel.keys.length}개` : ''}`, ip: req.ip });
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.${kind}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(payload);
  } catch (e) {
    if (e?.code === 'aborted') return;
    if (!res.headersSent) res.status(500).json({ ok: false, reason: kind === 'xlsx' ? '엑셀을 만들지 못했습니다.' : 'CSV 를 만들지 못했습니다.' });
  } finally { lock.release(); }
}

/*
 * v2.779 — '백업' 메뉴(사용자 요청: 백업 서머리 = 전체 vCenter · 백업 세부내용 = vCenter 하나의 폴더 › VM · Veeam 과 스냅샷 둘 다).
 *   도구 키 backup-summary · backup-detail(auth/toolAccess.js) + tools 권한. 판정은 새로 만들지 않는다 — 위의 resultsFor·matchToVcenter·veeamCount
 *   (Veeam)와 cachedSnapEvents·snapCount(스냅샷)를 그대로 쓰고 veeam/backupStatus.js 가 VM 단위로 합친다(카드·VM 화면과 같은 수).
 *   범위: 서머리는 scope 교집합, 세부내용은 vcOf(범위 밖 404). 응답 캐시는 범위·역할 키(관리자 판본: 실행 중 작업 이름·otherVcenter 수).
 */
/**
 * v2.818: 백업 실행(routes/api/backupRun.js)이 쓰는 대조 — vcBackup 의 Veeam 부분과 **같은 코어**(resultsFor → matchToVcenter)만, 스냅샷 이벤트 없이.
 * known 은 '이 vCenter 를 맡는 B&R 서버 전부의 쓸 수 있는 결과가 있다' 일 때만 true — 한 서버라도 결과가 없으면 그 서버가 백업하는 VM 이
 *   '미보호' 로 보이므로(거짓 미보호 → 포탈 전용 잡 중복 등록) 모름으로 둔다.
 * @returns {{ known:boolean, match:object|null, views:object[], host:string, results:number }}
 */
export function veeamMatchFor(vc, vms, req) {
  if (registryBroken()) return { known: false, match: null, views: [], host: '', results: 0, reason: 'registry-unreadable' };
  const brCount = serversForVcenter(vc.id).length;
  if (!brCount) return { known: false, match: null, views: [], host: '', results: 0 };
  const r = resultsFor(vc.id, req);
  const brIds = new Set(serversForVcenter(vc.id).map((d) => d.id));
  // 백업 실행 판정용 — 결과가 있어도 **오래됐으면 모름**이다(2차 반증 N4: 며칠 실패한 서버의 마지막 성공분으로 '미보호' 를 단정하면
  //   그 사이 사람이 잡에 넣은 VM 이 포탈 전용 잡에도 들어간다). 시한은 화면의 '백업 중' 신선도와 같은 식(resultMaxAgeMs).
  const now = Date.now();
  const fresh = (x) => { const rec = getRecord(x.server.id); const ts = Number(x.result?.ts); return ts > 0 && now - ts <= resultMaxAgeMs(rec?.via, rec?.agent); };
  const br = r.results.filter((x) => x.server?.src !== 'em' && brIds.has(x.server?.id) && fresh(x));
  const known = br.length >= brCount && Array.isArray(vms) && vms.length > 0;
  const match = known ? matchToVcenter({ id: vc.id, host: r.host }, vms, r.results, { otherHosts: r.otherHosts }) : null;
  return { known, match, views: r.views, host: r.host, results: br.length };
}

async function vcBackup(vc, vms, req, { initial = false, scope = null } = {}) {
  const admin = isAdminDetailUser(req.user);
  const linked = !registryBroken() && veeamLinked(vc.id);
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
  // v2.784: 사람이 정한 표시의 수 — 같은 범위(전원·제외) 목록. 연동 없는 vCenter 는 Veeam '없음' 확정이라 백업 필요 표시가 모두 미백업이다.
  // v2.785(GR R-B2): 표시 파일을 못 읽었으면 수는 0 이 아니라 모름(null) — 화면 '—' · CSV 빈칸 · 합계는 backupTotals 가 따로 센다.
  row.marks = marksUnreadable() ? null : markCounts(sv.vms, getMarks(), match?.byVm || null, { veeamKnown: row.veeam != null || !isLinked, absentKnown: !row.veeamAbsentUnknown });
  return { row, match, ev, vcnt, sc, views, linked: isLinked, scopedVms: sv.vms };
}

/** ?power=all|on|off & excl=1|0(기본 1 — 템플릿·vCLS 제외). 모르는 값은 기본. */
function scopeOf(req) {
  const power = POWER_VALUES.includes(String(req.query.power || '')) ? String(req.query.power) : 'all';
  return { power, excl: String(req.query.excl ?? '1') !== '0' };
}

/** v2.787: 우선순위 VM 목록은 VM 단위 백업 상태 = Detail 도구 데이터 — Detail 이 거부된 계정의 Summary 에는 싣지 않는다(도구별 접근 집행과 같은 판정). */
const detailToolOk = (req) => !issueFor(toolActorOf(req), 'backup-detail');

async function summaryData(req, snap, scope) {
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const maybeYield = createYielder(15);
  const rows = []; const jobs = [];
  const marks = getMarks(); const now = Date.now(); let prio = []; const prioOk = detailToolOk(req);
  const marksBad = marksUnreadable();
  let bset = null; try { bset = bareosEffectiveSettings(); } catch { bset = null; }   // v2.837 — 못 읽으면 Bareos 매핑·대행 표시는 모름(null)
  for (const vc of vcs) {
    await maybeYield();
    const vms = vmsBy.get(vc.id) || [];
    const b = await vcBackup(vc, vms, req, { initial: snap?.initial === true, scope });
    // v2.836(백업 메뉴 개편 1-b): 법인 줄 집계 — Detail 과 같은 VM 행(backupVmRows)을 세기만 한다(BackedUp · 백업 안함 · 확인 필요 · 실제 · 불일치 · RPO · 실패 · 다음 예정)
    const vr = backupVmRows(vc, b, { now, marks, unreadable: marksBad, withClone: false });
    const pa = newSiteAgg();
    for (const r of vr.vms) addSiteVm(pa, r, now);
    countVeeamWindow(pa, vr.vms, now);
    const bx = bareosSiteExtras(vc, vr, bset, now);   // v2.837 Bareos 매핑 · 엣지 대행 · 7일 결과 · 멈춤 의심(진행 현황 값이 신선할 때만)
    // v2.787(우선순위 VM): 같은 범위(scope 교집합 vCenter · 전원·제외 목록)에서만 — 다른 수와 같은 기준
    // v2.806: Clone 방식 VM 의 복제 잡 상태(Detail 과 같은 실행 노드 기준) — 못 읽으면 null(모름 — cloneBad 로 세지 않는다)
    const clones = prioOk ? cloneStatesOf(vc.id) : null;
    const cloneOf = (id) => (clones ? cloneView(clones.get(id)) : null);
    if (prioOk) for (const c of priorityCandidates(b.scopedVms, { byVm: b.match?.byVm || null, marks, veeamKnown: b.row.veeam != null || !b.linked, absentKnown: !b.row.veeamAbsentUnknown, now, cloneOf })) {
      prio.push({ ...c, vcenterId: vc.id, vcName: vc.name || vc.id });
    }
    rows.push({ id: vc.id, name: vc.name || vc.id, ...b.row, pa: finishSiteAgg(pa), ...(vr.bareosKnown ? {} : { bareosUnknown: true }), ...bx,
      w: marksWritable(req, snap, vc.id), veeamAuth: b.views.filter((v) => v.authStopped).length,
      veeamReason: b.vcnt?.reason || '', veeamServers: b.views.length, veeamFailed: b.vcnt?.failed || 0, veeamStale: b.vcnt?.stale || 0,
      ...(b.vcnt?.hostMismatch ? { hostMismatch: true } : {}), snapReason: b.sc?.reason || '', ...(isMockMode() && b.linked && !veeamLinked(vc.id) ? { demo: true } : {}) });
    // 지금 도는 작업(작업 전체 진행률) — 작업 이름은 서버 전체 기준이라 관리자 판본만(v2.778.1 과 같은 이유). 범위(전원)와 무관한 작업 단위 값이다.
    if (admin) for (const v of b.views) for (const j of v.runningJobs || []) if (jobs.length < 30) jobs.push({ vcenter: vc.name || vc.id, server: v.name, name: j.name, pg: j.pg });
  }
  // v2.785(GR R-B2): 재시작 뒤에는 손상 사본만 남아 '파일 없음'(빈 표시)으로 읽힌다 — 사본이 있으면 알린다(같은 프로세스 손상이면 위 안내 하나만)
  const unreadable = marksUnreadable();
  const prioTotal = prio.length;
  prio.sort(priorityRank);
  if (prio.length > PRIORITY_MAX) prio = prio.slice(0, PRIORITY_MAX);
  const totals = { ...backupTotals(rows), pa: sumSiteAggs(rows.map((r) => r.pa)), bareosUnknownSites: rows.filter((r) => r.bareosUnknown).length,
    stuck: rows.some((r) => Number.isFinite(r.stuck)) ? rows.reduce((n, r) => n + (Number.isFinite(r.stuck) ? r.stuck : 0), 0) : null };
  // v2.837 두 카드 — EM 은 전 법인 자료라 전체 범위 계정만(범위 계정은 null · 화면 '—' — /tools/backup-em 과 같은 게이트) · Director 조회 상태는 범위 안 법인의 Director 만
  const em = allowed ? null : await emSummary(now);
  // v2.839 Bareos 카드 '풀 사용' · '스케줄' · 용량 카드 'Full 풀 가득 참' — 범위 안 Director 의 정책 수집본(없으면 null — '수집 전')
  let bareosPolicy = null;
  try { if (bset) bareosPolicy = bareosPolicySummary(bset, allowed, bareosRegistryLoadError() ? [] : bareosJobDigests(), { now, demo: bareosIsDemoActive() }); } catch { bareosPolicy = null; }
  return { ok: true, at: Date.now(), scope, rows, totals, bareosGroups: bareosGroupCounts(new Set(vcs.map((v) => v.id)), now), bareosPolicy, directors: bareosDirectorHealth(rows, bset), em, priority: prioOk ? { items: prio, total: prioTotal, truncated: prioTotal > prio.length || undefined } : { withheld: 'detail-tool' }, ...(admin ? { runningJobs: jobs } : {}), registryUnreadable: registryBroken() || undefined,
    marksUnreadable: unreadable || undefined, marksCorruptKept: (!unreadable && marksCorruptKept()) || undefined };
}

async function detailData(req, snap, t, scope) {
  const admin = isAdminDetailUser(req.user);
  const vc = (snap?.vcenters || []).find((v) => v.id === t.vcenterId) || { id: t.vcenterId };
  const b = await vcBackup(vc, t.vms, req, { initial: snap?.initial === true, scope });
  const now = Date.now();
  const unreadable = marksUnreadable();   // v2.785(GR R-B2)
  const vr = backupVmRows(vc, b, { now, marks: getMarks(), unreadable });
  const vms = vr.vms;
  const views = b.views.map((v) => ({ name: v.name, ok: v.ok, lastOkTs: v.lastOkTs, stale: v.stale, error: v.error, authStopped: v.authStopped, via: v.via, ...(admin && v.runningJobs ? { runningJobs: v.runningJobs } : {}) }));
  return { ok: true, at: now, scope, vcenter: { id: vc.id, name: vc.name || vc.id }, row: { ...b.row, veeamReason: b.vcnt?.reason || '', snapReason: b.sc?.reason || '', ...(b.vcnt?.hostMismatch ? { hostMismatch: true } : {}) },
    linked: b.linked, servers: views, snapDays: b.ev?.days ?? null, snapSource: b.ev?.source || '', vms, ...(b.match?.aliasHosts && admin ? { aliasHosts: b.match.aliasHosts } : {}),
    writable: marksWritable(req, snap, vc.id), marksUnreadable: unreadable || undefined, marksCorruptKept: (!unreadable && marksCorruptKept()) || undefined,
    bareosUnreadable: !vr.bareosKnown || undefined };   // 버그 점검 W2: Bareos 원장을 못 읽었다 — 화면의 Bareos 칩은 '—'(0 이 아니다)
}

/**
 * v2.836: Detail · Summary · 전체 법인 찾기가 같은 VM 행을 쓴다(판정 코어 하나 — 따로 세지 않는다).
 *   vmBackupView(v2.782 Veeam 칸 · v2.784 표시 · v2.803 Clone 칸 — 방식 Clone 인 VM 만) → withBareos(v2.828 Bareos 칸) →
 *   policyFields(v2.835 정책 p · 실제 a · 정책≠실제 mm · 마지막 성공 lok · 최근 24시간 실패 e) + 다음 예정 nx(Bareos 그룹 예약만 — Veeam 잡 일정은 3차).
 *   withClone:false 면 복제 잡 상태를 읽지 않는다(Summary 집계에는 Clone 칸이 없다).
 * @returns {{ vms:object[], bareosKnown:boolean }}
 */
function backupVmRows(vc, b, { now = Date.now(), marks = getMarks(), unreadable = marksUnreadable(), withClone = true } = {}) {
  const veeamKnown = b.row.veeam != null;
  const snapKnown = b.row.snap != null;
  const clones = withClone ? cloneStatesOf(vc.id) : null;   // v2.803 — 못 읽으면 null(Clone 칸 '모름')
  const bareos = bareosStatesOf(vc.id);   // v2.828 — Bareos 잡(원장) · 못 읽으면 null(Bareos 칸 '모름')
  const groupNext = bareosGroupNext(vc.id, now, bareos);   // v2.835 — VM id → 다음 그룹 회차 { at, lv, g } · v2.839 Director 스케줄 { at, lv, s }(못 읽으면 빈 맵 — 칸 '—')
  const vms = b.scopedVms.map((vm) => vmBackupView(vm, b.match?.byVm?.[vm.id], b.ev?.byVm?.[vm.id], { veeamKnown: veeamKnown || !b.linked, snapKnown, absentKnown: !b.row.veeamAbsentUnknown, now, mark: markView(marks[vm.id]),
    clone: withClone ? (clones ? cloneView(clones.get(vm.id)) : null) : undefined })).map((row) => withBareos(row, bareos, unreadable))
    .map((row) => { const nx = groupNext.get(row.id); return { ...row, ...policyFields(row, { marksKnown: !unreadable, bareosKnown: bareos != null, now }), ...(nx ? { nx } : {}) }; });
  return { vms, bareosKnown: bareos != null, bareos };
}

/** v2.836 Summary 의 Bareos 카드 — 범위 안 법인의 백업 그룹 수 · 예약이 켜진 그룹 수. 그룹 파일을 못 읽으면 null(0 이 아니다). */
function bareosGroupCounts(vcIds, now = Date.now()) {
  try {
    if (bareosGroupsLoadError()) return null;
    let n = 0; let sched = 0; const slots = [];
    for (const g of bareosGroups()) {
      if (!vcIds.has(g.vcenterId)) continue;
      n++;
      if (g.schedule?.enabled !== true) continue;
      sched++;
      const sl = bareosNextSlot(g.schedule, now);
      if (sl && Number.isFinite(sl.at)) slots.push(sl.at);
    }
    // v2.837 다음 회차 = 가장 이른 회차 · 그 시각부터 1시간 안에 도는 그룹 수(시안 '23:00 그룹 19')
    const next = slots.length ? Math.min(...slots) : null;
    return { n, sched, next, nextN: next == null ? 0 : slots.filter((t) => t < next + 3_600_000).length };
  } catch { return null; }
}

/**
 * v2.837 법인 줄의 Bareos 부가 정보 — 순수 조합(Director 에 접속하지 않는다).
 *   bMapped: 그 vCenter 에 Bareos 매핑이 있나(설정을 못 읽으면 키 없음 — 모름) · bEdge: 그 Director 를 엣지가 대행 ·
 *   stuck: 멈춤 의심 수(진행 현황 조회가 신선할 때만 — 아니면 키 없음 = 모름)
 */
function bareosSiteExtras(vc, vr, bset, now) {
  const out = {};
  const site = bset?.sites?.find?.((x) => x.vcenterId === vc.id) || null;
  if (bset) out.bMapped = !!site;
  if (site) {
    const d = bareosDirectorById(site.directorId, bset);
    if (d?.agent) out.bEdge = true;
  }
  if (site && vr.bareos) {
    try {
      const cv = bareosCorpView(site, bset, [...vr.bareos.values()], { now });
      if (cv?.live?.ok && Number.isFinite(cv.live.at) && now - cv.live.at <= BAREOS_LIVE_IDLE_MS) out.stuck = cv.stuck || 0;
    } catch { /* 모름 — 키 없음 */ }
  }
  return out;
}

/** v2.837 Bareos 카드 'Director 조회 실패' — 범위 안 법인이 쓰는 Director 중 마지막 조회가 실패한 수(폴러 메모리 · 조회 전·대기는 세지 않는다). */
function bareosDirectorHealth(rows, bset) {
  if (!bset) return null;
  const ids = new Set();
  for (const r of rows) { const site = bset.sites?.find?.((x) => x.vcenterId === r.id); if (site) ids.add(site.directorId); }
  let byDir = {};
  try { byDir = bareosPollerStatus().directors || {}; } catch { byDir = {}; }
  let failed = 0;
  for (const id of ids) if (byDir[id] && byDir[id].ok === false) failed++;
  return { n: ids.size, failed };
}

/**
 * v2.837 Veeam 카드의 EM 요약(전체 범위 계정만 — summaryData 가 정한다). EM 탭(emData)의 값을 세기만 한다.
 *   jobs = EM 잡 수 · repo = 저장소 사용 합(사용률 · 90% 넘은 곳) · lic = 라이선스 사용 · auth = 인증 실패로 멈춘 EM 이름 · trend30 = 저장소 사용 30일 전 대비(이력이 있을 때만).
 *   못 읽으면 null(화면 '—').
 */
async function emSummary(now = Date.now()) {
  let d;
  try { d = await emData(false); } catch { return null; }
  const views = Array.isArray(d?.ems) ? d.ems : [];
  let jobs = null; let cap = 0; let used = 0; let repoN = 0; const over = [];
  for (const v of views) {
    const c = v?.data?.jobs?.counts?.all;
    if (Number.isFinite(c)) jobs = (jobs ?? 0) + c;
    for (const r of v?.data?.repositories || []) {
      if (!Number.isFinite(r.capacity) || r.capacity <= 0 || !Number.isFinite(r.free)) continue;
      repoN++; cap += r.capacity; used += r.capacity - r.free;
      if (Number.isFinite(r.usedPct) && r.usedPct >= 90) over.push({ name: String(r.name || '').slice(0, 64), pct: r.usedPct, vc: Array.isArray(r.vcNames) ? r.vcNames.slice(0, 3).map((x) => String(x).slice(0, 64)) : null, daysLeft: repoDaysLeft(d?.history?.repo?.[`em:${v.id}#${r.server || ''}|${r.name}`]) });   // v2.838 남은 일수(추정 — 최근 30일 사용 증가 기울기)
    }
  }
  over.sort((a, b) => b.pct - a.pct);
  const lt = d?.licenses?.totals || null;
  return {
    ems: views.length, jobs,
    repo: repoN ? { n: repoN, usedPct: Math.round((used / cap) * 1000) / 10, over: over.slice(0, 5), overN: over.length } : null,
    lic: lt && Number.isFinite(lt.used) && Number.isFinite(lt.licensed) && lt.licensed > 0 ? { used: lt.used, licensed: lt.licensed, pct: Math.round((lt.used / lt.licensed) * 1000) / 10 } : null,
    auth: views.filter((v) => v?.status?.authStop).map((v) => String(v.name || '').slice(0, 64)).slice(0, 5),
    trend30: repoTrend30(d?.history?.repo, now),
    series30: repoSeries30(d?.history?.repo),   // v2.838 '30일 추이' 선 — 저장소 사용 합(EM 이력)
  };
}
/**
 * v2.838 저장소 사용 합의 하루 점 — 마지막 날부터 30일 안에서, 그 창에 값이 있는 저장소가 **모두** 값을 가진 날만(일부만 있는 날은 합이 작아 보여 빼낸다 — 부분 합은 추이에 넣지 않는다).
 *   점이 둘보다 적으면 null(모름).
 * @returns {Array<[day:number, used:number]>|null}
 */
export function repoSeries30(hist) {
  if (!hist || typeof hist !== 'object') return null;
  const ss = Object.values(hist).map((x) => (Array.isArray(x) ? x.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) : []));
  let last = null;
  for (const s of ss) for (const p of s) if (last == null || p[0] > last) last = p[0];
  if (last == null) return null;
  const by = new Map(); let n = 0;
  for (const s of ss) {
    const win = s.filter((p) => p[0] > last - 30);
    if (!win.length) continue;
    n++;
    const seen = new Set();
    for (const p of win) {
      if (seen.has(p[0])) continue;
      seen.add(p[0]);
      const x = by.get(p[0]) || { used: 0, c: 0 };
      x.used += p[1] - p[2]; x.c++;
      by.set(p[0], x);
    }
  }
  const out = [...by].filter(([, x]) => x.c === n).sort((a, b) => a[0] - b[0]).map(([day, x]) => [day, x.used]);
  return out.length >= 2 ? out : null;
}
/**
 * v2.838 저장소 남은 일수(추정) — 이력 [[day, capacity, free], ...] 의 마지막 날과 그 30일 안 가장 이른 날 사이 사용 증가 기울기로 지금 여유를 나눈다.
 *   이력이 이틀 미만이거나 사용이 늘지 않았으면 null(모름 — 0 이 아니다).
 */
export function repoDaysLeft(series) {
  if (!Array.isArray(series)) return null;
  const s = series.filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Number.isFinite(x[2])).sort((a, b) => a[0] - b[0]);
  if (s.length < 2) return null;
  const last = s[s.length - 1];
  const first = s.find((x) => x[0] >= last[0] - 30) || s[0];
  if (first[0] >= last[0]) return null;
  const slope = ((last[1] - last[2]) - (first[1] - first[2])) / (last[0] - first[0]);
  if (!(slope > 0) || !(last[2] >= 0)) return null;
  return Math.floor(last[2] / slope);
}

/** 저장소 사용 30일 전 대비(%) — 이력 {key: [[day, capacity, free], ...]} 의 마지막 날과 30일 전(그날 또는 그 앞 가장 가까운 날) 사용 합. 둘 중 하나라도 없으면 null. */
export function repoTrend30(hist, now = Date.now()) {
  if (!hist || typeof hist !== 'object') return null;
  let a = 0; let b = 0; let n = 0;
  for (const series of Object.values(hist)) {
    if (!Array.isArray(series) || !series.length) continue;
    const s = series.filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Number.isFinite(x[2])).sort((x, y) => x[0] - y[0]);
    if (!s.length) continue;
    const last = s[s.length - 1];
    const old = [...s].reverse().find((x) => x[0] <= last[0] - 30);
    if (!old) continue;
    a += old[1] - old[2]; b += last[1] - last[2]; n++;
  }
  return n && a > 0 ? { pct: Math.round(((b - a) / a) * 1000) / 10, now: b, before: a } : null;
}

/** v2.838 그 법인을 맡는 B&R 서버 결과의 잡(이름 · 다음 실행) — 결과가 없으면(데모 · 연동 없음) 빈 목록. */
function veeamJobsOf(vcId, req) {
  const out = [];
  try { for (const x of resultsFor(vcId, req).results) for (const j of x.result?.jobs || []) if (j?.name) out.push({ name: j.name, nextRun: j.nextRun ?? null }); } catch { /* 모름 — 빈 목록 */ }
  return out;
}

/**
 * v2.838 '백업 스케줄 — 다음 24시간'(시안 ① 용량과 일정) — 법인마다 Veeam 잡 다음 실행 · Bareos 그룹 회차 · 겹침 · 7일 요약.
 *   Veeam 은 다음 1회만 안다(반복 주기 미수집) · Director 스케줄은 2차 · 그룹 파일을 못 읽으면 groupsUnreadable(Bareos 줄 모름).
 */
async function scheduleData(req, snap, scope) {
  const allowed = scopedVcenterIds(req.user, snap);
  const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const maybeYield = createYielder(15);
  const now = Date.now(); const marks = getMarks(); const unreadable = marksUnreadable();
  let groups = null;
  try { if (!bareosGroupsLoadError()) groups = bareosGroups(); } catch { groups = null; }
  const week = now + 7 * 86_400_000; const h24 = now + 86_400_000;
  // v2.839 Director 스케줄 회차(정책 수집본 — 그 법인의 포탈 잡이 든 회차만 · Director 에 접속하지 않는다)
  let dirItems = new Map();
  try { dirItems = directorScheduleItems(bareosEffectiveSettings(), bareosRegistryLoadError() ? [] : bareosJobDigests(), now, week, { demo: bareosIsDemoActive() }); } catch { dirItems = new Map(); }
  const sites = [];
  for (const vc of vcs) {
    await maybeYield();
    const b = await vcBackup(vc, vmsBy.get(vc.id) || [], req, { initial: snap?.initial === true, scope });
    const vr = backupVmRows(vc, b, { now, marks, unreadable, withClone: false });
    const fromResults = veeamJobsOf(vc.id, req);
    const veeam = veeamJobItems(vr.vms, fromResults.length ? fromResults : jobsFromRows(vr.vms), now).filter((i) => i.at <= week);
    const gi = groups ? groupItems(groups.filter((g) => g.vcenterId === vc.id), now, week, bareosNextSlot) : null;
    const di = dirItems.get(vc.id) || [];
    const bareos = gi || di.length ? [...(gi || []), ...di].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)) : null;   // 그룹 파일을 못 읽어도 Director 회차는 보인다(groupsUnreadable 은 그대로 밝힌다)
    sites.push({ id: vc.id, name: vc.name || vc.id, veeam, bareos });
  }
  const rows = sites.map((x) => {
    const v = x.veeam.filter((i) => i.at < h24); const g = (x.bareos || []).filter((i) => i.at < h24);
    return { id: x.id, name: x.name, veeam: v.slice(0, MAX_ITEMS_PER_SITE), bareos: x.bareos ? g.slice(0, MAX_ITEMS_PER_SITE) : null, overlap: overlapOf(v, g), more: Math.max(0, v.length - MAX_ITEMS_PER_SITE) + Math.max(0, g.length - MAX_ITEMS_PER_SITE),
      ...(x.bareos ? { groups: groupOverlaps(v, g) } : {}) };
  });
  return { ok: true, at: now, hours: 24, rows, days: sevenDays(sites.map((x) => ({ veeam: x.veeam, bareos: x.bareos || [] })), dayStartMs(dayIndex(now))), ...(groups ? {} : { groupsUnreadable: true }) };
}

/**
 * v2.838 통합 에러 로그(시안 ①) — 최근 N일(1·7·30)의 실패 · 경고 · 수집 오류를 한 모양으로(veeam/backupErrors.js).
 *   오류 원문은 관리자 판본만(가림 규칙 — Veeam 서버 오류는 serverView 가 이미 가린다 · Bareos Director 오류 · EM 오류도 같다).
 *   EM 세션 · EM 수집 상태는 전 법인 자료라 전체 범위 계정만.
 */
async function errorsData(req, snap, scope, days) {
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const maybeYield = createYielder(15);
  const now = Date.now(); const since = now - days * 86_400_000; const marks = getMarks(); const unreadable = marksUnreadable();
  let bset = null; try { bset = bareosEffectiveSettings(); } catch { bset = null; }
  let byDir = {}; try { byDir = bareosPollerStatus().directors || {}; } catch { byDir = {}; }
  const rows = []; const collect = []; let bareosUnknownSites = 0; const seenDir = new Set();
  for (const vc of vcs) {
    await maybeYield();
    const site = { id: vc.id, name: vc.name || vc.id };
    const b = await vcBackup(vc, vmsBy.get(vc.id) || [], req, { initial: snap?.initial === true, scope });
    const vr = backupVmRows(vc, b, { now, marks, unreadable, withClone: false });
    pushAll(rows, veeamVmRows(vr.vms, site, since, taskMsgOf(b.match?.byVm, admin)));
    if (vr.bareos) pushAll(rows, bareosRows(vr.bareos, new Set(vr.vms.map((x) => x.id)), site, since)); else bareosUnknownSites++;
    for (const v of b.views) if (v.ok === false || v.authStopped) collect.push({ at: v.ts, vc: site.id, vcName: site.name, src: 'veeam', name: v.name, error: v.error, auth: !!v.authStopped });
    const sd = bset?.sites?.find?.((x) => x.vcenterId === vc.id);
    if (sd && vr.bareos) {   // 멈춤 의심 — 진행 현황이 신선할 때만(Summary 배지와 같은 규칙 · 조회를 새로 일으키지 않는다)
      try {
        const cv = bareosCorpView(sd, bset, [...vr.bareos.values()], { now });
        if (cv?.live?.ok && Number.isFinite(cv.live.at) && now - cv.live.at <= BAREOS_LIVE_IDLE_MS) pushAll(rows, stuckRows(cv.rows, site, cv.live.at));
      } catch { /* 모름 — 행 없음 */ }
    }
    const dr = sd ? byDir[sd.directorId] : null;
    if (dr && dr.ok === false && !seenDir.has(sd.directorId)) {
      seenDir.add(sd.directorId);
      collect.push({ at: dr.at, vc: site.id, vcName: site.name, src: 'bareos', name: dr.name || 'Director', error: admin ? dr.error : (dr.code ? `조회 실패(${String(dr.code).slice(0, 32)})` : '조회 실패'), auth: /auth|pam/.test(String(dr.code || '')) });
    }
  }
  let emIncluded = false;
  if (!allowed) {
    try {
      const d = await emData(admin);
      emIncluded = true;
      pushAll(rows, emSessionRows(d.ems, since));
      for (const v of d.ems || []) if (v?.status && (v.status.ok === false || v.status.authStop)) collect.push({ at: v.status.ts, vc: '', vcName: '', src: 'veeam', name: `EM ${v.name}`, error: admin ? v.status.error : '', auth: !!v.status.authStop });
    } catch { emIncluded = false; }
  }
  pushAll(rows, collectRows(collect, since));
  // v2.840 오류 볼륨(정책 수집본 — Director 에 접속하지 않는다 · 범위 안 Director 만)
  if (bset) {
    try {
      const names = new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
      pushAll(rows, volumeRows(bareosErrorVolumeItems(bset, allowed), since, (id) => names.get(id) || id));
    } catch { /* 수집본을 못 읽음 — 행 없음(정책 탭이 손상을 밝힌다) */ }
  }
  const fin = finishErrors(rows);
  return { ok: true, at: now, days, scope, ...fin, sources: { veeamVm: true, em: emIncluded, bareos: true }, ...(bareosUnknownSites ? { bareosUnknownSites } : {}) };
}

/**
 * v2.836 전체 법인 '백업 안 된 VM 찾기'(GET /tools/backup-summary/stale) — 범위 안 법인마다 Detail 과 같은 VM 행을 만들어 backupPolicy.staleOf 로 센다.
 *   행은 상한(STALE_ROWS_MAX)까지만 싣고 수는 전부 센다. 한쪽 결과를 모르는 VM 은 '모름' 으로 따로(미달로 단정하지 않는다).
 */
async function staleData(req, snap, scope, o) {
  const allowed = scopedVcenterIds(req.user, snap);
  const vcs = (snap?.vcenters || []).filter((v) => (!allowed || allowed.has(v.id)) && (!o.vc || v.id === o.vc));   // v2.837 법인 하나(라우트가 범위를 먼저 본다)
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const maybeYield = createYielder(15);
  const now = Date.now(); const marks = getMarks(); const unreadable = marksUnreadable();
  const acc = newStaleAcc(); let bareosUnknownSites = 0;
  for (const vc of vcs) {
    await maybeYield();
    const b = await vcBackup(vc, vmsBy.get(vc.id) || [], req, { initial: snap?.initial === true, scope });
    const vr = backupVmRows(vc, b, { now, marks, unreadable, withClone: false });
    if (!vr.bareosKnown) bareosUnknownSites++;
    addStaleRows(acc, vr.vms, { id: vc.id, name: vc.name || vc.id }, o, now);
  }
  const fin = finishStaleRows(acc, Number.isFinite(o.max) || o.max === Infinity ? o.max : undefined);
  const sites = new Set(acc.rows.filter((r) => r.kind !== 'unknown').map((r) => r.vc)).size;
  return { ok: true, at: now, scope, q: { n: o.n, unit: o.unit, src: o.src, excludeNone: o.excludeNone, onlyOn: o.onlyOn, includeNever: o.includeNever, vc: o.vc },
    n: acc.n, never: acc.never, old: acc.old, unknown: acc.unknown, failing: acc.failing, excluded: acc.excluded, sites, vcenters: vcs.length, rows: fin.rows, total: fin.total,
    ...(fin.truncated ? { truncated: true } : {}), ...(bareosUnknownSites ? { bareosUnknownSites } : {}), marksUnreadable: unreadable || undefined };
}

/**
 * v2.835: 그 vCenter 의 VM → 다음 Bareos 그룹 회차(그룹 예약이 켜진 그룹만 · groupSchedule.nextSlot). 그룹 파일을 못 읽으면 빈 맵(다음 예정 '—' — 없다고 단정하지 않는다).
 *   VM 은 그룹 하나에만 든다(groups.js) — 한 번 훑어 맵을 만든다(VM 수 + 그룹 수).
 */
function bareosGroupNext(vcenterId, now, bareos = null) {
  const out = new Map();
  try {
    if (!bareosGroupsLoadError()) {
      for (const g of bareosGroups()) {
        if (g.vcenterId !== vcenterId) continue;
        const slot = bareosNextSlot(g.schedule, now);
        if (!slot) continue;
        const v = { at: slot.at, lv: slot.level, g: String(g.name || '').slice(0, 64) };
        for (const id of g.vmIds || []) out.set(id, v);
      }
    }
  } catch { /* 모름 — 그룹 회차 없음 */ }
  // v2.839 Director 스케줄의 다음 실행(정책 수집본 — Director 에 접속하지 않는다) — 그룹 회차보다 이르면 그것을(둘 다 돌면 먼저 도는 것)
  try {
    if (bareos) {
      const st = bareosEffectiveSettings();
      const byDir = new Map();
      for (const [vmId, j] of bareos) {
        if (!j?.bareosJob || j.enabled === false) continue;
        const dirId = bareosJobDirectorId(j, st);
        if (!byDir.has(dirId)) byDir.set(dirId, directorNextByJob(dirId, now));
        const n = byDir.get(dirId).get(j.bareosJob);
        if (!n) continue;
        const cur = out.get(vmId);
        if (!cur || n.at < cur.at) out.set(vmId, { at: n.at, lv: n.level, s: String(n.schedule || '').slice(0, 64) });
      }
    }
  } catch { /* 모름 */ }
  return out;
}

/** v2.828: 그 vCenter 의 VM 별 Bareos 잡 요약(원장 — Director 에 접속하지 않는다). 원장을 못 읽었으면 null(모름). */
function bareosStatesOf(vcenterId) {
  try {
    if (bareosRegistryLoadError()) return null;
    const m = new Map();
    for (const j of bareosJobDigests()) if (j.vcenterId === vcenterId) m.set(j.vmId, j);
    return m;
  } catch { return null; }
}
/**
 * v2.828 Detail 행의 'Bareos' 칸 b(bareos/vmView.bareosVmView) — 잡이 있거나 백업 방식이 Bareos 인 VM 에만 싣는다(키 없음 = 무관).
 *   원장을 못 읽었으면 방식이 Bareos 인 VM 에 b:null(모름) — 잡이 있는지 모르므로 '미등록' 이라 하지 않는다.
 *   표시 파일을 못 읽었으면 방식을 모르니 잡이 있는 VM 만 싣는다(미등록 판정 없음).
 */
function withBareos(row, bareos, marksBad) {
  const method = marksBad ? '' : row.m?.method || '';
  if (bareos == null) return method === 'bareos' ? { ...row, b: null } : row;
  const b = bareosVmView(bareos.get(row.id), method);
  return b === undefined ? row : { ...row, b };
}

/** v2.803: 그 vCenter 의 VM 별 복제 잡 상태(vmclone/jobState.js) — 실패는 null(모름). */
function cloneStatesOf(vcenterId) {
  try { return cloneStateByVm(vcenterId); } catch { return null; }
}

/** v2.837 찾기의 법인 하나(vc)가 이 계정의 조회 범위 밖이거나 없는 법인인가(404 — 존재를 흘리지 않는다). 빈 값 = 전체. */
function staleVcOutOfScope(req, snap, vc) {
  if (!vc) return false;
  const allowed = scopedVcenterIds(req.user, snap);
  return !(snap?.vcenters || []).some((v) => v.id === vc) || (allowed && !allowed.has(vc));
}

/** v2.837 캐시 키 — 이 계정이 표시를 바꿀 수 있는 법인 집합(marksWritable 과 같은 판정). */
function writeKeyOf(req, snap) {
  if (!['admin', 'operator'].includes(req.user?.role) || isDemoGuest(req.user)) return 'none';
  const w = writeScopedVcenterIds(req.user, snap);
  return w ? [...w].sort().join(',') : 'all';
}

/** v2.784: 이 계정이 이 vCenter 의 백업 표시를 바꿀 수 있는가 — 화면이 편집 칸을 여는 값(서버 PUT 판정과 같은 조건). */
function marksWritable(req, snap, vcenterId) {
  if (!['admin', 'operator'].includes(req.user?.role) || isDemoGuest(req.user)) return false;
  const w = writeScopedVcenterIds(req.user, snap);
  return !w || w.has(vcenterId);
}

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '');
/** v2.803 예전 CSV 의 Clone 두 칸 — [마지막 실행(UTC), 결과]. 백업 방식이 Clone 이 아닌 VM 은 빈칸. */
const cloneCsvCells = (vm) => ('c' in vm ? [iso(vm.c?.at), cloneResultText(vm.c)] : ['', '']);
const scopeText = (sc) => `${sc.power === 'on' ? '켜진 VM' : sc.power === 'off' ? '꺼진 VM' : '전체 VM'}${sc.excl ? ' · 템플릿·vCLS 제외' : ''}`;

/** v2.788 EM 탭 응답(순수 조합 — 판정은 veeam/em/view.js). */
async function emData(admin) {
  const now = Date.now();
  const ems = listEms();
  const demo = !ems.length && isMockMode();
  const brServers = listServers();
  let views;
  // v2.817 EM 연결 현황 — EM 이 본 호스트를 포탈 vCenter 로 맞추는 색인(등록부 host · 스냅샷 이름 — 비밀 없음)
  const snapVcs = store.get()?.vcenters || [];
  let regVcs = [];
  try { regVcs = listVcenters(); } catch { regVcs = []; }
  const vcIndex = vcIndexOf([...regVcs.map((v) => ({ id: v.id, name: snapVcs.find((x) => x.id === v.id)?.name || v.name || v.id, host: v.host })),
    ...snapVcs.filter((x) => !regVcs.some((v) => v.id === x.id)).map((x) => ({ id: x.id, name: x.name || x.id }))]);
  if (demo) {
    views = demoEmViews(store.get(), now, { vcIndex });
    for (const v of views) if (v.data) { v.data.jobs = jobsView(v.data._jobs || []); delete v.data._jobs; }
  } else {
    const vcName = new Map(snapVcs.map((v) => [v.id, v.name || v.id]));
    const map = getEmMap();   // v2.788.1 매핑(백업 서버 → vCenter·B&R 등록)
    views = ems.map((em) => emView(em, getEmRecord(em.id), { brServers, map, vcName, vcIndex, maxAgeMs: emPollMs() * 3, now }));
  }
  if (!admin) views = views.map(({ host: _h, port: _p, ...v }) => v);
  let licItems = currentLicenses();
  if (!licItems.length && isMockMode() && !brServers.length) licItems = demoLicenses(now);
  const [licHist, repoHist] = await Promise.all([licenseHistory(90, now), repoHistory(90, now)]);
  return {
    ok: true, at: now, ...(demo ? { demo: true } : {}), pollMs: emPollMs(),
    ems: views,
    licenses: { source: 'vbr', items: licItems.map((x) => ({ id: x.id, name: x.name, license: x.license, ts: x.ts ?? null, ...(x.demo ? { demo: true } : {}) })), totals: licenseTotals(licItems, now), brServers: brServers.length },
    history: { license: licHist, repo: repoHist },
  };
}

/** v2.788.1 이 EM 의 마지막 결과에 있는 세션 UID 인가 — 상세 요청은 이것만 EM 으로 보낸다(임의 값으로 EM 을 두드리지 않게). */
export function knownEmSessionUid(data, uid) {
  if (!uid || !data) return false;
  for (const j of data.jobs || []) if (j?.last?.uid === uid) return true;
  for (const x of data.sessions?.recentBad || []) if (x?.uid === uid) return true;
  return false;
}
const _emDetailCache = new Map();
export function _resetEmDetailForTest() { _emDetailCache.clear(); _emDetailBusy.clear(); }   // key → { at, body } (5분 · 상한 200)
const _emDetailBusy = new Set();    // EM 당 동시 1건
const EM_DETAIL_TTL_MS = 5 * 60_000;

export function registerBackupStatus(api) {
  const toolsPerm = requirePerm('tools');
  // v2.838 일일 메일 계산기 — 전 법인 · 시스템 계정(화면 찾기와 같은 staleData · 범위 옵션 = 전체 VM · 템플릿·vCLS 제외)
  setStaleProvider(async (q) => staleData({ user: { username: 'system', role: 'admin' } }, store.get(), { power: 'all', excl: true },
    staleQueryOf({ ...q, n: String(q.n), excludeNone: q.excludeNone === false ? '0' : '1', onlyOn: q.onlyOn === false ? '0' : '1', includeNever: q.includeNever === false ? '0' : '1' })));
  const csvPerm = requirePerm('data.csv');

  api.get('/tools/backup-summary', toolsPerm, (req, res) => {
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, 'backup-summary', async () => summaryData(req, snap, scope),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|m${marksRev()}|d${detailToolOk(req) ? 1 : 0}|em${emSourcesRev()}|c${jobsRev()}|b${bareosRegistryRev()}|g${bareosGroupsRev()}|w${writeKeyOf(req, snap)}|bp${bareosPolicyRev()}` });   // v2.839 bp = 정책 수집본 리비전   // v2.837 w = 쓰기 가능 법인(rows[].w — 같은 범위라도 operator·viewer·writeVcenters 가 다르다)   // v2.787 Detail 접근(우선순위 VM) · 키에 req.originalUrl(전원·제외)도 든다(shared.js) · v2.784 표시 리비전(저장 즉시 수가 바뀐다) · v2.806 c = 복제 잡 기록 리비전(우선순위 VM 의 Clone 상태)
  });

  /*
   * v2.836 전체 법인 '백업 안 된 VM 찾기'(Summary — 사용자 요청 '지정한 시간만큼 백업되지 않은 VM 찾기' + 시안 ①).
   *   VM 단위 백업 상태 = Detail 도구 데이터라 Detail 이 거부된 계정은 403(우선순위 VM 과 같은 판정 detailToolOk) · 범위 = scope 교집합(summaryData 와 같다).
   *   무거운 집계라 화면은 폴링하지 않고 '찾기' 를 누를 때만 부른다 · 응답 캐시 60초(키에 쿼리 — shared.js memoJson 이 originalUrl 을 넣는다).
   */
  api.get('/tools/backup-summary/stale', toolsPerm, (req, res) => {
    if (!detailToolOk(req)) return res.status(403).json({ ok: false, reason: '이 계정은 Detail 화면이 허용되지 않아 VM 목록을 볼 수 없습니다(관리자가 정한 도구별 접근).' });
    const o = staleQueryOf(req.query);
    if (o.windowMs == null) return res.status(400).json({ ok: false, reason: '기간은 1~999 사이 정수로 적으세요.' });
    const snap = store.get();
    if (staleVcOutOfScope(req, snap, o.vc)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, 'backup-summary-stale', async () => staleData(req, snap, scope, o),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|m${marksRev()}|em${emSourcesRev()}|b${bareosRegistryRev()}|g${bareosGroupsRev()}` });
  });

  /*
   * v2.838 '백업 스케줄 — 다음 24시간' · 통합 에러 로그(시안 ① 아래 두 구획). 잡 · VM 이름이 있어 Detail 이 거부된 계정은 403(detailToolOk) ·
   *   범위 = scope 교집합 · 무거운 집계라 화면은 마운트 1회 + 버튼만(폴링 없음) · 응답 캐시 60초(키 = 범위 · 역할 · 리비전 + 쿼리).
   */
  api.get('/tools/backup-summary/schedule', toolsPerm, (req, res) => {
    if (!detailToolOk(req)) return res.status(403).json({ ok: false, reason: '이 계정은 Detail 화면이 허용되지 않아 잡 · 그룹 일정을 볼 수 없습니다(관리자가 정한 도구별 접근).' });
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, 'backup-summary-schedule', async () => scheduleData(req, snap, scope),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|em${emSourcesRev()}|g${bareosGroupsRev()}|bp${bareosPolicyRev()}|r${bareosRegistryRev()}` });
  });
  api.get('/tools/backup-summary/errors', toolsPerm, (req, res) => {
    if (!detailToolOk(req)) return res.status(403).json({ ok: false, reason: '이 계정은 Detail 화면이 허용되지 않아 VM 별 에러 로그를 볼 수 없습니다(관리자가 정한 도구별 접근).' });
    const days = ERROR_DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 1;
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, 'backup-summary-errors', async () => errorsData(req, snap, scope, days),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|em${emSourcesRev()}|b${bareosRegistryRev()}|bp${bareosPolicyRev()}` });   // 백업 표시(정책)는 에러 행에 쓰지 않는다 — m 없음 · v2.840 오류 볼륨 = 정책 수집본(bp)
  });

  /*
   * v2.838 '이 조건을 알림으로(메일)'(사용자 결정 '일일 메일로 구현') — 전 법인 자료를 메일로 보내므로 **관리자 · 전체 범위**만 저장 · 지금 보내기(데모 계정 403).
   *   다른 계정은 GET 에 hidden(설정을 싣지 않는다). 저장 · 보내기는 감사에 남긴다. 지금 보내기는 1분에 한 번.
   */
  const alertEditor = (req) => isAdminDetailUser(req.user) && !scopedVcenterIds(req.user, store.get());   // 관리자 판본 판정 하나(데모 계정 제외 포함)
  const alertFullScope = fullScopeOnlyWith('전 법인 자료를 메일로 보내는 설정이라 전체 범위(vCenter 제한 없는) 관리자만 바꾸거나 보낼 수 있습니다.');   // 게이트 태그(archScan route-gate) — 핸들러의 alertEditor 와 이중
  api.get('/tools/backup-summary/alert', toolsPerm, (req, res) => {
    if (scopedVcenterIds(req.user, store.get())) return res.json({ ok: true, canEdit: false, hidden: true });
    let mail = null;
    try { const m = loadMailSettings(); mail = { enabled: !!m?.enabled, kindEnabled: m?.kinds?.[STALE_MAIL_KIND]?.enabled !== false }; } catch { mail = null; }
    return res.json({ ok: true, canEdit: alertEditor(req), settings: loadAlert(), unreadable: !!alertLoadError() || undefined, status: alertStatus(), mail });
  });
  api.put('/tools/backup-summary/alert', toolsPerm, requireRole('admin'), alertFullScope, (req, res) => {
    if (!alertEditor(req)) return res.status(403).json({ ok: false, reason: '전 법인 자료를 메일로 보내는 설정이라 전체 범위 관리자만 바꿀 수 있습니다.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const vc = String(body?.q?.vc || '');
    if (vc && !(store.get()?.vcenters || []).some((v) => v.id === vc)) return res.status(400).json({ ok: false, reason: '없는 법인입니다.' });
    try {
      const saved = saveAlert(body, { by: req.user?.username || '' });
      logAudit({ user: req.user?.username, action: 'backup-stale-alert.save', target: 'backup-summary', detail: `${saved.enabled ? '켬' : '끔'} · 매일 ${saved.time} · 최근 ${saved.q.n}${saved.q.unit} · ${saved.q.src}${saved.q.vc ? ` · ${saved.q.vc}` : ''}`, ip: req.ip });
      return res.json({ ok: true, settings: saved });
    } catch (e) { return res.status(e?.code === 'invalid' ? 400 : 409).json({ ok: false, reason: String(e?.message || e).slice(0, 200) }); }
  });
  let lastSendNow = 0;
  api.post('/tools/backup-summary/alert/send', toolsPerm, requireRole('admin'), alertFullScope, async (req, res) => {
    if (!alertEditor(req)) return res.status(403).json({ ok: false, reason: '전 법인 자료를 메일로 보내는 설정이라 전체 범위 관리자만 보낼 수 있습니다.' });
    if (Date.now() - lastSendNow < 60_000) return res.status(429).json({ ok: false, reason: '지금 보내기는 1분에 한 번입니다 — 잠시 뒤 다시 누르세요.' });
    lastSendNow = Date.now();
    const r = await sendStaleAlertNow({ by: req.user?.username || '' });
    logAudit({ user: req.user?.username, action: 'backup-stale-alert.send', target: 'backup-summary', detail: r.ok ? `보냄 · ${r.n}대` : `실패 · ${r.reason}`, ip: req.ip });
    return res.json(r);
  });

  /*
   * v2.837 전체 법인 찾기 CSV(시안 'CSV') — 화면과 같은 판정(staleData) · CSV 권한 · 동시 1건(exportBusy) · 감사. 행 상한 없이 전부(수가 많아도 VM 수 이하).
   */
  api.get('/tools/backup-summary/stale.csv', csvPerm, toolsPerm, async (req, res) => {
    if (!detailToolOk(req)) return res.status(403).json({ ok: false, reason: '이 계정은 Detail 화면이 허용되지 않아 VM 목록을 내보낼 수 없습니다(관리자가 정한 도구별 접근).' });
    const o = staleQueryOf(req.query);
    if (o.windowMs == null) return res.status(400).json({ ok: false, reason: '기간은 1~999 사이 정수로 적으세요.' });
    const snap = store.get();
    if (staleVcOutOfScope(req, snap, o.vc)) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const lock = acquireExport('backup-summary-stale.csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const scope = scopeOf(req);
      const d = await staleData(req, snap, scope, { ...o, max: Infinity });
      const lines = [CSV_BOM + csvLine(['법인', 'VM', '폴더', 'OS', '전원', '백업 정책', '판정', '마지막 성공(UTC)', '경과(시간)', '정책≠실제', '실제 Veeam', '실제 Bareos', '최근 24시간 실패'])];
      const yn = (v) => (v === true ? '있음' : v === false ? '없음' : '모름');
      for (const x of d.rows) {
        const vm = x.vm || {};
        lines.push(csvLine([x.vcName, vm.name, vm.folder, vm.os || '', vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '', METHOD_TEXT[vm.p] || '모름',
          x.kind === 'never' ? '한 번도 없음' : x.kind === 'old' ? '기준 넘음' : '모름', iso(x.last), x.last == null ? '' : String(Math.floor((d.at - x.last) / 3_600_000)),
          vm.mm === true ? '불일치' : vm.mm === false ? '일치' : '모름', yn(vm.a?.v), yn(vm.a?.b), Array.isArray(vm.e) && vm.e.some((e) => e?.r === 'fail') ? '예' : '']));
      }
      logAudit({ user: req.user?.username, action: 'backup-summary-stale.csv', target: o.vc || 'all', detail: `${d.rows.length} rows · ${o.n}${o.unit} · ${o.src} · ${scopeText(scope)}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backup-not-backed-up-${fileStamp()}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) return res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
    return undefined;
  });

  /*
   * v2.788 '서버 › Veeam › EM' 탭 — Enterprise Manager 수집 결과 + B&R 라이선스 + 일 단위 이력.
   *   EM 데이터는 vCenter 귀속이 없다(전 법인) → 전체 범위 계정만(범위 계정 403 + 사유 — '귀속 없는 데이터는 범위 계정에 노출하지 않는다').
   *   관리자 판본(isAdminDetailUser)만 EM 주소·포트를 싣는다. 폴링하지 않는 화면이라 응답 캐시는 짧게(30초).
   */
  const fullScopeOnly = fullScopeOnlyWith('Veeam Enterprise Manager 현황은 전 법인 데이터라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');
  api.get('/tools/backup-em', toolsPerm, fullScopeOnly, (req, res) => {
    const admin = isAdminDetailUser(req.user);
    return memoJson(req, res, 'backup-em', async () => emData(admin), { ttlMs: 30_000, extraKey: `${scopeKey(req.user, store.get())}|${admin ? 'admin' : 'user'}|map${emMapRev()}` });   // v2.788.1 매핑을 바꾸면 바로 보인다
  });

  /*
   * v2.788.1 실패·경고 상세 — 그 세션의 VM 별 결과와 사유를 EM 에서 **눌렀을 때만** 읽는다(전체 범위만 — EM 탭과 같은 게이트).
   *   · 저장된 결과에 있는 세션 UID 만 · 인증 정지 중이면 접속하지 않는다 · 401 이면 정지 기록(자동 재시도 없음) · EM 당 동시 1건 · 5분 캐시.
   */
  api.get('/tools/backup-em/session', toolsPerm, fullScopeOnly, async (req, res) => {
    const emId = String(req.query.em || '').slice(0, 80);
    const uid = String(req.query.uid || '').slice(0, 200);
    if (!listEms().length && isMockMode() && DEMO_EM_IDS.includes(emId)) return res.json(demoSessionDetail(uid));
    const em = getEmWithSecret(emId);
    if (!em) return res.status(404).json({ ok: false, reason: 'Enterprise Manager 를 찾을 수 없습니다.' });
    const rec = getEmRecord(em.id);
    const data = rec?.result?.ok ? rec.result : (rec?.lastOk || null);
    if (!knownEmSessionUid(data, uid)) return res.status(404).json({ ok: false, reason: '이 EM 의 최근 수집 결과에 없는 세션입니다 — 새로고침 뒤 다시 누르세요.' });
    const key = `${em.id}|${uid}`;
    const hit = _emDetailCache.get(key);
    if (hit && Date.now() - hit.at < EM_DETAIL_TTL_MS) return res.json({ ...hit.body, cachedAt: hit.at });
    const stop = emAuthGuard.authStopFor(em);
    if (stop) return res.status(409).json({ ok: false, code: 'auth-stopped', reason: `이 EM 은 인증 실패로 수집을 멈춰 접속하지 않습니다(${stop.reason}) — 설정에서 계정을 고치세요.` });
    if (!em.password) return res.status(409).json({ ok: false, code: 'no-password', reason: '저장된 비밀번호가 없어 접속하지 않습니다 — 설정에서 비밀번호를 입력하세요.' });
    if (_emDetailBusy.has(em.id)) return res.status(429).json({ ok: false, reason: '이 EM 에서 다른 상세를 읽는 중입니다 — 잠시 뒤 다시 누르세요.' });
    _emDetailBusy.add(em.id);
    try {
      const d = await withDeadline(60_000, (signal) => sessionDetail(em, uid, { signal }), 'Veeam EM 세션 상세 시한 초과');
      const body = { ok: true, uid, ...d };
      _emDetailCache.set(key, { at: Date.now(), body });
      if (_emDetailCache.size > 200) _emDetailCache.delete(_emDetailCache.keys().next().value);
      return res.json(body);
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 400);
      if (e?.authFailed) { emAuthGuard.markAuthStopped(em.id, em, reason); emAuthGuard.flush(); }
      return res.status(502).json({ ok: false, reason, ...(e?.authFailed ? { code: 'auth' } : {}) });
    } finally { _emDetailBusy.delete(em.id); }
  });

  api.get('/tools/backup-detail', toolsPerm, async (req, res) => {
    const t = vcOf(req);
    if (!t) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const scope = scopeOf(req);
    return memoJson(req, res, `backup-detail:${t.vcenterId}`, async () => detailData(req, snap, t, scope),
      { ttlMs: 60_000, extraKey: `${scopeKey(req.user, snap)}|${admin ? 'admin' : 'user'}|m${marksRev()}|w${marksWritable(req, snap, t.vcenterId) ? 1 : 0}|em${emSourcesRev()}|c${jobsRev()}|b${bareosRegistryRev()}|g${bareosGroupsRev()}|bp${bareosPolicyRev()}` });   // v2.839 bp = 정책 수집본(다음 예정의 Director 스케줄) · 쓰기 가능 여부도 계정마다 다르다 · v2.828 b = Bareos 원장 리비전(Bareos 칸)(writeVcenters) · v2.803 c = 복제 잡 기록 리비전(Clone 칸)
  });

  /*
   * v2.784(사용자 요청 '업무 중요도 아이콘 · 백업 필요 아이콘 · 백업 관련 메모 · 다중 선택 일괄 적용'): VM 표시 저장.
   *   도구 키 집행은 첫 마디 backup-detail(auth/toolAccess.js). 순서 = 역할(admin·operator) → 조회 범위 밖 404 → 쓰기 범위 밖 403
   *   (server/CLAUDE.md '조회 밖 404 → 쓰기 밖 403') → 모든 VM 이 그 vCenter 의 지금 인벤토리에 있어야(남의 vCenter VM id 로 쓰지 않게) → 감사.
   */
  api.put('/tools/backup-detail/marks', toolsPerm, requireRole('admin', 'operator'), (req, res) => {
    if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 바꿀 수 없습니다.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const vcenterId = String(body.vcenterId || '').slice(0, 128);
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const vc = (snap?.vcenters || []).find((v) => v.id === vcenterId);
    if (!vcenterId || !vc || (allowed && !allowed.has(vcenterId))) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    if (!marksWritable(req, snap, vcenterId)) return res.status(403).json({ ok: false, reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' });
    const ids = Array.isArray(body.vmIds) ? body.vmIds.map((x) => String(x || '')).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ ok: false, reason: 'VM 을 고르세요.' });
    if (ids.length > MAX_IDS_PER_REQUEST) return res.status(400).json({ ok: false, reason: `한 번에 ${MAX_IDS_PER_REQUEST}대까지입니다.` });
    const inv = new Map();
    for (const vm of snap?.vms || []) if (vm.vcenterId === vcenterId) inv.set(vm.id, vm);
    const targets = [];
    for (const id of new Set(ids)) {
      const vm = inv.get(id);
      if (!vm) return res.status(400).json({ ok: false, reason: '이 vCenter 의 VM 이 아닌 항목이 있습니다.' });
      targets.push({ id, name: vm.name, vcenterId });
    }
    const patch = {};
    for (const k of ['crit', 'method', 'need', 'memo']) if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];   // v2.803 method = 백업 방식
    const r = setMarks(targets, patch, req.user);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason, ...(r.code ? { code: r.code } : {}) });
    const what = [patch.crit !== undefined ? `중요도=${patch.crit || '지움'}` : '', patch.method !== undefined ? `백업 방식=${patch.method || '지움'}` : '', patch.need !== undefined ? `백업 필요=${patch.need ? '표시' : '해제'}` : '',
      patch.memo !== undefined ? `메모 ${String(patch.memo || '').length}자` : ''].filter(Boolean).join(' · ');
    logAudit({ user: req.user?.username, action: 'backup-marks', target: vcenterId, detail: `${targets.length}대 · ${what}${targets.length === 1 ? ` · ${targets[0].name}` : ''}`, ip: req.ip });
    res.json({ ok: true, changed: r.changed, removed: r.removed });
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
        '오래된 백업 1일+', '오래된 백업 3일+', '오래된 백업 7일+', '완료 시각 모름', '실패', '경고', '마지막 백업 완료(UTC)', 'Veeam 상태', '스냅샷 잔존', '제외(템플릿·vCLS)', '전원 모름',
        '중요도 상', '중요도 중', '중요도 하', '백업 필요', '백업 필요·미백업'])];
      const n = (v) => (Number.isFinite(v) ? v : '');
      // v2.781(B-B1): '백업 중' 을 지운 서버가 있으면 0 은 모름(빈칸) · 0 이 아니면 하한(≥N) — 화면과 같은 규칙.
      const run = (r, v) => (r.runningStale && Number.isFinite(v) ? (v > 0 ? `≥${v}` : '') : n(v));
      for (const r of d.rows) {
        lines.push(csvLine([r.name, scopeText(scope), n(r.vm), n(r.veeam), n(r.snap), n(r.split?.both), n(r.split?.vOnly), n(r.split?.sOnly), n(r.split?.none), run(r, r.running), run(r, r.pending),
          n(r.rpo?.d1), n(r.rpo?.d3), n(r.rpo?.d7), n(r.rpo?.unknown), n(r.results?.failed), n(r.results?.warning), iso(r.lastBackup), r.veeamState || '', n(r.snapStale), n(r.excluded), n(r.powerUnknown),
          n(r.marks?.high), n(r.marks?.mid), n(r.marks?.low), n(r.marks?.need), n(r.marks?.needGap)]));
      }
      logAudit({ user: req.user?.username, action: 'backup-summary.csv', target: 'backup-summary', detail: `${d.rows.length} rows · ${scopeText(scope)}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backup-summary-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });

  api.get('/tools/backup-detail.csv', csvPerm, toolsPerm, async (req, res) => {   // v2.803 백업 방식 · Clone 열(cloneCsvCells)
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
        `스냅샷 최근 ${d.snapDays || 7}일 횟수`, '스냅샷 마지막(UTC)', '지금 스냅샷', '스냅샷 잔존',
        // v2.803: 백업 방식(사람이 정한 값) · Clone 마지막 실행(백업 방식 Clone 인 VM 만) — '작업' 열은 파일 소비자 호환으로 그대로 둔다
        '백업 방식', 'Clone 마지막 실행(UTC)', 'Clone 결과', '중요도', '백업 필요', '메모'])];
      const CRIT_TEXT = { high: '상', mid: '중', low: '하' };
      let n = 0;
      for (const vm of d.vms) {
        if (!vmViewMatches(vm, filter, { rpoDays, now })) continue;
        n++;
        const v = vm.v; const s = vm.s || {};
        lines.push(csvLine([d.vcenter.name, vm.folder, vm.name, vm.power === 'POWERED_ON' ? '켜짐' : vm.power ? '꺼짐' : '', st(v), v && Number.isFinite(v.pg) ? v.pg : '',
          v?.jobs?.join(' | ') || '', v && Number.isFinite(v.rp) && v.rp >= 0 ? v.rp : '', iso(v?.lb), v ? (v.lr || v.lastResult || '') : '',
          s.ev === undefined ? '모름' : s.ev ? (s.ev.n ?? '') : 0, iso(s.ev?.ts), s.now && !s.now.stale ? s.now.n : '', s.now?.stale ? '예' : '',
          // v2.785(GR R-B2): 표시 파일을 못 읽었으면 빈칸('없음' 으로 읽힌다)이 아니라 모름 — Veeam·스냅샷 열과 같은 표기
          ...(d.marksUnreadable ? ['모름', '', '', '모름', '모름', ''] : [METHOD_TEXT[vm.m?.method] || '', ...cloneCsvCells(vm), CRIT_TEXT[vm.m?.crit] || '', vm.m?.need ? '예' : '', vm.m?.memo || ''])]));
      }
      logAudit({ user: req.user?.username, action: 'backup-detail.csv', target: t.vcenterId, detail: `${n} rows · ${scopeText(scope)} · 보기 ${filter}${filter === 'rpo' ? ` ${rpoDays}일` : ''}`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="backup-detail-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });
}
