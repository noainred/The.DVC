// 심층검색·서비스/네트워크 점검·vCenter 로그 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { pageArgs } from '../../util/pageArgs.js';
import { requirePerm, requireRole } from '../../auth/auth.js'; // v2.478(감사 S5)
import { scopedVcenterIds, inUserScope } from '../../auth/scope.js';
import { guardCell } from '../../util/csv.js';
import { store } from '../../store.js';
import { config, loadVcenterConfig } from '../../config.js';
import { scanResultList, getIpHistoryMap } from '../../ipam/scanStore.js';
import { snapshotFilter, slimVm, filterScanResults } from '../../search/deepSearch.js';
import { getServiceCheck } from '../../health/services.js';
import { confirmSettingsDefault } from '../../util/settingsLoadError.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { logAudit } from '../../audit.js';
import { getNetworkCheck } from '../../health/network.js';
import { buildVmwareConfigExport } from '../../backup/vmwareExport.js';
import { getLogsDb } from '../../logs/db.js';
import { enqueueLogQuery, getLogQueryResult, bindingOfReq } from '../../central/logQueries.js';
import { listInventory } from '../../central/inventory.js';
import { getAllGpuGuestDiag } from '../../central/gpuGuestDiag.js';
import zlib from 'node:zlib';
import { todayStamp } from "../../util/dayKey.js";
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requirePerm('data.csv');
// v2.732(B4-01): /tools/vclogs/sources — 담당 엣지를 모르는 site vCenter 의 표지(이름을 지어내지 않는다). 아래 라우트 주석 참조.
export const SITE_AGENT_UNKNOWN_LABEL = '(담당 엣지 미확인)';
/**
 * v2.732(B4-01): 로그 출처 분류(순수) — 등록부 vCenter 중 직접 수집(비활성·점검중 포함)은 local, 엣지 위임(collectMode 'site')은 remote.
 * observed = 관측된 vCenter → 엣지(위임 인벤토리·GPU 게스트 진단 — 예전과 같은 원천). site 의 담당 엣지는 등록부 remoteAgent 가 먼저다
 * (관측값보다 설정이 정확하다 — v2.542 배지 규약과 같은 판단). 셋 다 모르면 표지 + agentUnknown(연합 조회는 vCenter id 로 동작한다).
 * 등록부에 없고 관측만 된 vCenter 는 예전처럼 remote. 범위 판정(inScope)은 호출부가 넘긴다.
 */
export function classifyLogSources(registry, observed, inScope = () => true) {
  const t = (x) => (typeof x === 'string' ? x.trim() : '');
  const reg = (Array.isArray(registry) ? registry : []).filter((v) => v && v.id && inScope(v.id));
  const localIds = new Set(reg.filter((v) => v.collectMode !== 'site').map((v) => v.id));
  const agentOf = new Map(observed instanceof Map ? observed : []);
  const unknown = new Set();
  for (const v of reg) {
    if (v.collectMode !== 'site') continue;
    const a = t(v.remoteAgent) || t(agentOf.get(v.id));
    if (a) agentOf.set(v.id, a); else { agentOf.set(v.id, SITE_AGENT_UNKNOWN_LABEL); unknown.add(v.id); }
  }
  const remote = [];
  for (const [vcenterId, agent] of agentOf) if (!localIds.has(vcenterId)) remote.push({ vcenterId, agent, ...(unknown.has(vcenterId) ? { agentUnknown: true } : {}) });
  return { local: [...localIds], remote };
}


// vClogs scope: 사용자 scope 를 f.vcenterIds 화이트리스트로 강제하고, meta 도 범위 내 vCenter 만 남긴다.
// null(무제한)이면 그대로. 반환값=allowed(Set|null) — meta 필터에 재사용.
function scopeLogFilter(req, f) {
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return null; // 무제한
  const req1 = f.vcenterId ? String(f.vcenterId) : '';
  f.vcenterIds = req1 ? (allowed.has(req1) ? [req1] : []) : [...allowed];
  return allowed;
}
function scopeLogMeta(meta, allowed) {
  if (!allowed || !meta) return meta;
  const vcs = (meta.vcenters || []).filter((v) => allowed.has(v.vcenterId));
  const count = vcs.reduce((a, v) => a + (v.count || 0), 0);
  return { ...meta, count, vcenters: vcs }; // 범위 밖 vCenter 존재/건수 미노출
}

/**
 * v2.631(감사 AX2-05): vCenter 로그 CSV 내보내기의 페이지 순회 — 순수 헬퍼(테스트가 직접 부른다).
 *
 * 예전 구현은 until 을 고정하지 않은 OFFSET 페이징이라, 청크 사이 양보(setImmediate) 동안 로그 폴러가 새 행을
 * 넣으면 OFFSET 기준이 밀려 경계 행이 **두 번** 나갔다. 또 행 수가 정확히 상한이면 더 없는데도 '잘렸습니다' 를 썼다.
 *  - 첫 청크 뒤로는 커서 시각이 상한이 된다(지정 until 이 있으면 그것부터). '지금' 으로 고정하지 않는 것은
 *    vCenter 시계가 포탈보다 빠를 때 최신 이벤트가 조용히 빠지지 않게 하기 위해서다.
 *  - (ts, 같은 ts 안에서 이미 낸 개수) 커서로 이어 간다 — 다음 청크는 `ts <= 마지막 ts` 에서 같은 ts 로 낸 만큼만 건너뛴다.
 *    그래서 커서보다 **새** 시각의 삽입은 결과를 밀지 않는다. ✅ v2.632: 실제 DB(sqlite·NDJSON)는 queryPage((ts, rowid) 키셋)를
 *    주므로 커서와 **같은 ts** 의 삽입도 밀지 않는다 — 이 OFFSET 경로는 queryPage 가 없는 구현에만 남는다(그때는 동률 삽입이 한 칸 민다).
 *  - 잘림은 상한에 닿은 뒤 **한 행 더 있을 때만** 밝힌다.
 * onRows 가 false 를 돌려주면 중단(aborted).
 */
export async function exportLogPages(db, f, { max, chunk, onRows } = {}) {
  const base = { ...f, until: f.until ? Number(f.until) : 0 };
  // v2.632(A6-2632-02): db 가 키셋 페이지(queryPage)를 주면 (ts, rowid) 커서로 잇는다 — OFFSET 이 없어 청크 사이에 커서와
  //   **같은 ts** 로 들어온 행도 결과를 밀지 않는다(예전: 경계 행 1개 중복 + 새 행 누락). 그 늦은 행은 내보내기 시작 뒤에 들어온
  //   것이라 이번 결과에 없다(스냅샷 의미 — 중복·누락이 아니다). queryPage 가 없는 구현(테스트 목)만 아래 OFFSET 경로를 쓴다.
  if (typeof db.queryPage === 'function') {
    let cursor = null;
    let emitted = 0;
    for (;;) {
      const take = Math.min(chunk, max - emitted);
      if (take <= 0) {
        const more = db.queryPage(base, 1, cursor);
        return { emitted, truncated: more.length > 0, aborted: false };
      }
      const rows = db.queryPage(base, take, cursor);
      if (rows.length) {
        const go = await onRows(rows);
        if (go === false) return { emitted, truncated: false, aborted: true };
        emitted += rows.length;
        const last = rows[rows.length - 1];
        cursor = { ts: last.ts, rid: last.rid };
      }
      if (rows.length < take) return { emitted, truncated: false, aborted: false };
      await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보(다른 사용자 요청 처리)
    }
  }
  let cursorTs = base.until || null;   // null = 상한 없음(첫 청크만)
  let tieSkip = 0;
  let emitted = 0;
  for (;;) {
    const take = Math.min(chunk, max - emitted);
    if (take <= 0) {
      const more = db.query({ ...base, until: cursorTs ?? 0 }, 1, tieSkip);
      return { emitted, truncated: more.length > 0, aborted: false };
    }
    const rows = db.query({ ...base, until: cursorTs ?? 0 }, take, tieSkip);
    if (rows.length) {
      const go = await onRows(rows);
      if (go === false) return { emitted, truncated: false, aborted: true };
      emitted += rows.length;
      const lastTs = rows[rows.length - 1].ts;
      let same = 0;
      for (let i = rows.length - 1; i >= 0 && rows[i].ts === lastTs; i--) same++;
      if (lastTs === cursorTs) tieSkip += same; else { cursorTs = lastTs; tieSkip = same; }
    }
    if (rows.length < take) return { emitted, truncated: false, aborted: false };
    await new Promise((resolve) => setImmediate(resolve)); // 이벤트 루프 양보(다른 사용자 요청 처리)
  }
}

export function registerChecksLogs(api) {

// 심층 검색(스냅샷 1차) — 다조건 + 범위(전체/특정/복수 vCenter). Body: { vcenterIds[], filters{} }.
api.post('/tools/deep-search', requirePerm('tools'), (req, res) => {
  const b = req.body || {};
  const f = b.filters || {};
  const snap = store.get();
  // 사용자 scope 를 요청 vcenterIds 와 교집합 강제 — 빈배열=전체 우회를 막는다.
  //  · 무제한(allowed=null): 요청값 그대로(빈=전체, 기존 동작).
  //  · 제한: 요청이 있으면 allowed 와 교집합, 없으면 allowed 전체. 교집합이 공집합이면 즉시 빈 결과.
  const allowed = scopedVcenterIds(req.user, snap);
  const reqIds = Array.isArray(b.vcenterIds) ? b.vcenterIds : [];
  const effIds = allowed ? (reqIds.length ? reqIds.filter((id) => allowed.has(id)) : [...allowed]) : reqIds;
  if (allowed && effIds.length === 0) return res.json({ total: 0, items: [], scanTotal: 0, scanItems: [] });
  const vms = snapshotFilter(snap, { vcenterIds: effIds, f });
  // 옵션: IP 스캔으로 발견된(=vCenter가 모르는) 항목도 함께 검색. IP/서브넷/검색어 조건이 있을 때만.
  // 스캔 발견물은 vCenter 귀속(vcenterId)이 없어 scope 로 거를 수 없다 → 범위 제한 계정에는 노출하지 않는다.
  let scanItems = [];
  if (!allowed && (f.includeScan || b.includeScan)) {
    try { scanItems = filterScanResults(scanResultList(), f, getIpHistoryMap()).slice(0, 2000); } catch { scanItems = []; }
  }
  res.json({ total: vms.length, items: vms.slice(0, 2000).map(slimVm), scanTotal: scanItems.length, scanItems });
});

// 다빈치 서비스 점검 — 포탈 내부 서비스/수집기 상태 통합.
// v2.597(감사 AUTHZ-2597-02): 세부 문구가 전부 함대 수준 수치(vCenter 연결 n/N·NSX 매니저·활성 알림 수)라 범위 제한 계정에는
//   상태만 주고 문구를 비운다(형제 /tools/network-check 는 범위로 거른다). 뺀 사실은 scoped 로 밝힌다.
api.get('/tools/service-check', requirePerm('tools'), (req, res) => {
  try {
    // v2.617(SEC-2): 멈춤 감시 행의 '멈춘 지점'(설치 절대 경로·소스 줄)은 관리자에게만.
    const r = getServiceCheck({ isAdmin: req.user?.role === 'admin' });
    if (!scopedVcenterIds(req.user, store.get())) return res.json(r);
    res.json({ ...r, scoped: true, checks: (r.checks || []).map((c) => ({ ...c, detail: '범위 제한 계정 — 함대 수준 세부 수치는 표시하지 않습니다' })) });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// v2.633: 손상 보존본(.corrupt.*)만 남은 설정 파일을 **지금 적용 중인 기본값으로 확정**한다 — 그 뒤 설정 pull 이 다시 200 으로
//   답하므로 이 기본값(대개 '꺼짐')이 전 엣지에 배포된다. 보존본의 나이로 자동 해제하지 않는 이유는 util/settingsLoadError.js.
//   파일은 서비스 점검이 준 목록(등록부)에 있는 이름만 받는다(경로 조작 불가) · 보존본은 지우지 않는다 · 감사 로그를 남긴다.
const settingsFleetOnly = fullScopeOnlyWith('설정 파일을 기본값으로 확정하면 그 값이 모든 엣지에 배포됩니다 — 전체 범위(vCenter 제한 없는) 관리자만 할 수 있습니다.');
api.post('/tools/service-check/settings-files/confirm', requireRole('admin'), settingsFleetOnly, (req, res) => {
  const file = typeof req.body?.file === 'string' ? req.body.file.slice(0, 128) : '';
  if (!file) return res.status(400).json({ ok: false, code: 'bad-request', reason: 'file 이 필요합니다' });
  const r = confirmSettingsDefault(file, { by: req.user?.username || '' });
  if (!r.ok) {
    const status = r.code === 'unknown-file' ? 404 : r.code === 'not-in-error' ? 409 : r.code === 'not-confirmable' ? 409 : 500;
    return res.status(status).json(r);
  }
  logAudit({ user: req.user?.username, action: 'settings-file.confirm-default', target: r.file, detail: `${r.label || r.file} 을(를) 기본값으로 확정 — 이 기본값이 엣지에 배포됩니다(손상 보존본은 보관)`, ip: req.ip });
  res.json(r);
});

// 글로벌 네트워크 점검 — 제어플레인(vCenter/NSX) 도달성·RTT + 네트워크 객체 요약.
// v2.322 보안 감사: 범위 제한 계정은 허용 vCenter·귀속 NSX 매니저만(범위 밖 host/이름/region/RTT 차단).
api.get('/tools/network-check', requirePerm('tools'), async (req, res) => {
  try { res.json(await getNetworkCheck(scopedVcenterIds(req.user, store.get()))); } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});

// 사이트 VMware 솔루션 구성 백업 — 수집 구성 스냅샷. ?vcenterId=로 사이트 한정, ?download=1로 gzip 파일.
// v2.322 보안 감사(HIGH): 범위 제한 계정은 허용 vCenter(및 귀속 NSX 매니저)로만 — 과거 이 라우트만
// scope 를 안 걸어 범위 밖 전 함대 ESXi 관리 IP·전 VM IP/메모·NSX DFW 규칙이 gzip 으로 새었다.
api.get('/tools/vmware-config', requirePerm('tools'), async (req, res) => {
  try {
    const allowed = scopedVcenterIds(req.user, store.get());
    const reqVc = req.query.vcenterId ? String(req.query.vcenterId) : null;
    // 범위 밖 vCenter 를 명시 요청하면 존재를 흘리지 않게 404(형제 vclogs/federate 패턴).
    if (reqVc && allowed && !allowed.has(reqVc)) return res.status(404).json({ error: 'not found' });
    const data = buildVmwareConfigExport({ vcenterId: reqVc, allowed });
    if (req.query.download === '1') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      // v2.594(감사 SEC-2594-04): scope 는 요청 vcenterId 원문이다 — 따옴표·CRLF·비ASCII 가 헤더에 그대로 들어가
      //   filename 매개변수 주입 또는 500(잘못된 헤더 문자)이 됐다. 파일명에는 안전한 문자만 남긴다.
      const safeScope = String(data.meta.scope || 'all').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64) || 'all';
      const fn = `vmware-config-${safeScope}-${stamp}.json.gz`;
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
      // ⚠ gzipSync 는 수 MB 페이로드(전 함대 호스트·VM·NSX)에서 이벤트 루프를 수백 ms~초 단위로
      //   멈춘다(2026-08-13 감사 '대량 export 동기 gzip' 잔여 항목). createGzip 스트림에 1MB 청크로
      //   흘려 압축을 비동기화하고, 백프레셔 때 drain 을 기다린다(gpuSeriesExport 스트리밍과 같은 취지).
      //   JSON.stringify 자체는 동기로 남는다 — 전체 객체를 문자열화하는 비용은 피할 수 없다.
      const json = JSON.stringify(data, null, 2);
      const gzip = zlib.createGzip();
      gzip.on('error', () => { try { res.destroy(); } catch { /* 이미 종료 */ } });
      gzip.pipe(res);
      const CHUNK = 1 << 20;
      for (let i = 0; i < json.length; i += CHUNK) {
        if (res.destroyed) { gzip.destroy(); return undefined; }   // 클라이언트 중단 시 즉시 정지
        if (!gzip.write(json.slice(i, i + CHUNK))) {
          // drain 또는 연결 종료 중 먼저 오는 쪽을 기다린다(abort 시 영원히 기다리지 않도록).
          await new Promise((r) => { gzip.once('drain', r); res.once('close', r); });
        }
      }
      gzip.end();
      return undefined;
    }
    res.json(data);
  } catch (e) {
    // 스트리밍 시작 후 실패하면 헤더가 이미 나갔으므로 JSON 오류를 보낼 수 없다.
    if (res.headersSent) { try { res.destroy(e); } catch { /* 이미 종료 */ } return; }
    res.status(500).json({ ok: false, reason: e.message });
  }
});

// 로그 출처 — 이 포탈 로컬 보관(local) vs 엣지 보관(remote, 연합 조회 필요).
// ⚠⚠ v2.574 SEC-01 — **이 라우트만 scope 가 없었다.** 예전 시그니처는 `(_req, res)` 였다(사용자를
//   아예 보지 않는다는 뜻이다). 실측: 범위 계정(`vc-asia-seoul` 만 허용)의 응답이
//   `{"local":["vc-asia-seoul","vc-eu-warsaw","vc-us-east"],"remote":[]}` 로 **admin 응답과
//   바이트 단위로 동일**했다 — 다른 법인 vCenter 의 **존재와 id** 가 그대로 나갔다.
//   바로 위 형제(`/tools/vmware-config`)와 아래 형제(`/tools/vclogs/federate`)는 둘 다
//   `allowed.has(reqVc)` 로 거르고 있었다(게이팅 비대칭). server/CLAUDE.md '조회 라우트 scope 는
//   예외 없이' · '귀속 없는/범위 밖 데이터 미노출' 불변조건.
// ⚠ `allowed === null` 은 '제한 없음(전체)' 이다 — 빈 집합으로 읽으면 전체 범위 계정이
//   아무것도 못 본다(`auth/scope.js:16-26`).
//
// ⚠⚠ v2.732(점검 2회차 B4-01): **엣지 위임(collectMode 'site') vCenter 는 local 이 아니라 remote 다.** 로그 폴러는 이제 site vCenter 에
//   로그인하지 않는다(엣지가 수집·보관한다 — logs/poller.js · vcenter/collectTarget.js). 예전에는 등록부의 vCenter 를 전부 local 로 분류해
//   화면이 '중앙이 직접 로그인해 쌓은 값' 을 읽었다 — 폴러만 고치면 site 로그가 화면에서 **조용히 멈춘다**. 그래서 site 는 연합 조회
//   (/tools/vclogs/federate — vCenter id 로 그 vCenter 를 수집하는 엣지가 답한다)로 넘긴다. 담당 엣지 이름은 등록부 remoteAgent →
//   (위임 인벤토리 · GPU 게스트 진단 — 예전과 같은 관측값) 순서이고, 셋 다 모르면 이름을 지어내지 않고 `agentUnknown:true` 와 '(담당 엣지 미확인)' 표지를 싣는다
//   (연합 조회는 이름이 아니라 vCenter id 로 동작한다 — 표지는 화면 배지용이다). 비활성·점검중(직접 수집)은 local 그대로(이미 쌓인 이력 조회).
//   이미 중앙에 쌓여 있던 site vCenter 의 옛 로그는 vCenter 를 고르지 않은 '전체' 조회에서 계속 보인다(지우지 않는다).
api.get('/tools/vclogs/sources', requirePerm('tools'), (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const inScope = (id) => allowed == null || allowed.has(id);
  const vcAgent = new Map();
  for (const inv of listInventory()) if (inv.agent && inScope(inv.vcenterId)) vcAgent.set(inv.vcenterId, inv.agent);
  for (const a of getAllGpuGuestDiag()) {
    // v2.598(감사 CENTRAL-02): insights/graph.js 와 같은 형식 가드 — 오염된 저장값이 이 목록을 500 으로 만들지 않게.
    if (!a || !a.agent || !Array.isArray(a.vcenters)) continue;
    for (const vc of a.vcenters) if (vc && vc.vcId && inScope(vc.vcId)) vcAgent.set(vc.vcId, a.agent);
  }
  res.json(classifyLogSources(loadVcenterConfig().vcenters || [], vcAgent, inScope));
});

// v2.630 SEC2630-02: 연합 조회 입력 상한과 '이 포탈이 아는 vCenter' 집합.
const FEDERATE_Q_MAX = 500;
const FEDERATE_SEV_MAX = 32;
function knownVcenterIds() {
  const ids = new Set();
  for (const v of loadVcenterConfig().vcenters || []) if (v && v.id) ids.add(String(v.id));
  for (const v of store.get()?.vcenters || []) if (v && v.id) ids.add(String(v.id));
  for (const inv of listInventory()) if (inv && inv.vcenterId) ids.add(String(inv.vcenterId));
  for (const a of getAllGpuGuestDiag()) {
    if (!a || !Array.isArray(a.vcenters)) continue;
    for (const vc of a.vcenters) if (vc && vc.vcId) ids.add(String(vc.vcId));
  }
  return ids;
}

// 엣지 로그 연합 조회 — 요청 큐잉(POST) / 결과 폴링(GET ?reqId=).
api.post('/tools/vclogs/federate', requirePerm('tools'), (req, res) => {
  const b = req.body || {};
  const vcenterId = String(b.vcenterId || '').trim();
  if (!vcenterId) return res.status(400).json({ ok: false, reason: 'vcenterId가 필요합니다.' });
  // scope 강제: 범위 밖 vCenter 의 엣지 로그 연합 조회를 큐잉할 수 없다(범위 밖은 존재도 숨겨 404).
  if (!inUserScope(req.user, store.get(), vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter를 찾을 수 없습니다.' });
  // v2.630 SEC2630-02: 존재하지 않는 id 로 인메모리 큐 키를 무한히 만들지 못하게 — 이 포탈이 아는 vCenter 만.
  //   (등록부 · 스냅샷 · 위임 인벤토리 · GPU 게스트 진단 — /tools/vclogs/sources 가 목록을 만드는 것과 같은 원천)
  if (!knownVcenterIds().has(vcenterId)) return res.status(404).json({ ok: false, reason: 'vCenter를 찾을 수 없습니다.' });
  // 검색어·심각도는 엣지 LIKE 검색으로 내려간다 — 원문 그대로(최대 1MB 본문)를 60초 보관·전달하지 않는다.
  const q = typeof b.q === 'string' ? b.q : '';
  if (q.length > FEDERATE_Q_MAX) return res.status(400).json({ ok: false, reason: `검색어가 너무 깁니다(${q.length}자 > ${FEDERATE_Q_MAX}자).` });
  const severity = typeof b.severity === 'string' ? b.severity : '';
  if (severity.length > FEDERATE_SEV_MAX) return res.status(400).json({ ok: false, reason: '심각도 값이 올바르지 않습니다.' });
  const fin = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const lim = Math.trunc(Number(b.limit));
  const filter = { vcenterId, severity, q, since: fin(b.since), until: fin(b.until), limit: Number.isFinite(lim) && lim >= 1 ? Math.min(500, lim) : 200 };
  res.json({ ok: true, reqId: enqueueLogQuery(vcenterId, filter, req.user?.username || '') });
});
api.get('/tools/vclogs/federate', requirePerm('tools'), (req, res) => {
  const reqId = String(req.query.reqId || '');
  if (!reqId) return res.status(400).json({ ok: false, reason: 'reqId가 필요합니다.' });
  // v2.478(감사 S6): reqId 는 `lq_<ms36>_<seq36>` 로 예측 가능 → 큐잉한 사용자(또는 admin)만 결과를 받고,
  // 대상 vCenter 가 조회 범위 밖이면 404(존재 은닉). 만료(TTL)된 reqId 는 기존대로 빈 결과.
  // v2.583 #35: 바인딩이 없으면(만료·위조 reqId) 결과를 주지 않는다 — 빈 owner/vc 로 검사를 건너뛰던 것이 우회로였다.
  const bind = bindingOfReq(reqId);
  if (!bind) return res.status(404).json({ ok: false, reason: '조회 요청을 찾을 수 없습니다(만료되었을 수 있습니다 — 다시 조회하세요).' });
  if (req.user?.role !== 'admin' && bind.owner !== String(req.user?.username || '')) return res.status(404).json({ ok: false, reason: '조회 요청을 찾을 수 없습니다.' });
  if (!bind.vcenterId || !inUserScope(req.user, store.get(), bind.vcenterId)) return res.status(404).json({ ok: false, reason: '조회 요청을 찾을 수 없습니다.' });
  res.json({ ok: true, ...getLogQueryResult(reqId) });
});
// vCenter 장기 보관 로그 조회 — 필터: vcenterId·severity·q·since·until + 페이징.
api.get('/tools/vclogs', requirePerm('tools'), async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    const allowed = scopeLogFilter(req, f); // 사용자 scope 화이트리스트를 f.vcenterIds 로 강제(범위 밖 로그 열람 차단)
    const { limit, offset } = pageArgs(req.query, { def: 200, max: 1000 });   // v2.594: 하한·정수화(limit=-1 → 무제한이었다)
    // v2.607 DB2607-02: 검색어·심각도 필터는 인덱스 밖이라 정확 COUNT 가 페이지마다 events 전체를 동기로 훑었다
    // (100만 행 q 무일치 약 0.3초 + 정렬 조회). 필터가 있으면 상한 COUNT 로 세고 닿았으면 totalCapped 로 밝힌다
    // (total 은 '적어도 이만큼'). 무필터·vCenter·기간만이면 예전대로 정확 COUNT(인덱스로 싸다).
    const filtered = !!(f.q || f.severity);
    const counted = filtered && typeof db.countCapped === 'function' ? db.countCapped(f) : { total: db.count(f), capped: false };
    res.json({ total: counted.total, totalCapped: counted.capped, ...(counted.capped ? { totalCap: counted.total } : {}),
      rows: db.query(f, limit, offset), meta: scopeLogMeta(db.meta(), allowed), dbKind: db.kind });
  } catch (e) { res.status(500).json({ ok: false, reason: e.message }); }
});
api.get('/tools/vclogs/export.csv', csvPerm, requirePerm('tools'), async (req, res) => {
  try {
    const db = await getLogsDb();
    const f = { vcenterId: req.query.vcenterId || '', severity: req.query.severity || '', q: req.query.q || '',
      since: req.query.since ? Number(req.query.since) : 0, until: req.query.until ? Number(req.query.until) : 0 };
    scopeLogFilter(req, f); // scope 화이트리스트 강제(범위 밖 로그 CSV 유출 차단)
    const esc = (v) => `"${guardCell(v).replace(/"/g, '""')}"`; // guardCell: 수식 인젝션 방어(로그 user/entity/message 는 외부 입력)
    // 과거: 10만 행 1회 조회 + 전체 join → 수십 MB 문자열을 만드는 동안 이벤트 루프 정지.
    // gpuSeriesExport 패턴: 청크 조회 + res.write 스트리밍 + 청크 사이 setImmediate 양보 +
    // 행 상한(초과 시 잘림을 CSV 안에 명시 — 잘린 결과를 완전한 것처럼 주지 않는다).
    const MAX = Math.max(1000, Number(process.env.VCLOGS_EXPORT_MAX_ROWS) || 100_000);
    const CHUNK = 20_000;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vcenter-logs-${todayStamp()}.csv"`);
    res.write('﻿time,vcenter,severity,type,user,entity,message\n'); // BOM(엑셀 한글)
    const r = await exportLogPages(db, f, {
      max: MAX, chunk: CHUNK,
      onRows: async (rows) => {
        if (res.destroyed) return false; // 클라이언트 중단 시 즉시 종료(불필요한 조회 방지)
        const ok = res.write(rows.map((x) => [new Date(x.ts).toISOString(), x.vcenterId, x.severity, x.type, x.user, x.entity, x.message].map(esc).join(',')).join('\n') + '\n');
        if (!ok) await new Promise((resolve) => res.once('drain', resolve)); // 소켓 백프레셔(느린 클라이언트에 수십 MB 버퍼링 방지)
        return true;
      },
    });
    if (r.aborted) return;
    if (r.truncated) res.write(`"(행 상한 ${MAX.toLocaleString()}건에서 잘렸습니다 — 기간을 좁혀 다시 내보내세요)"\n`);
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, reason: e.message });
    else try { res.destroy(e); } catch { /* 이미 종료 */ }
  }
});
}
