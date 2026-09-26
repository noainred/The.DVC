// 수집기 CRUD/운영·데이터센터·VM 재구성 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { morefOf } from '../../vcenter/registry.js';   // v2.447: vcenterId 에 콜론이 있어도 안전한 moref 추출(감사 B1)
import { requirePerm, setLocalPassword } from '../../auth/auth.js';
import { inUserScope, inUserWriteScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { forceCollectorToken } from '../../agent/deploy.js';
import { listTargets, getTargetRaw, pickSshTarget } from '../../agent/deployRegistry.js';
import { logAudit } from '../../audit.js';
import { loadVcenterConfig } from '../../config.js';
import { getVmHardware, reconfigVm } from '../../provision/reconfig.js';
import { listCollectors, addCollector, updateCollector, removeCollector, loadCollectors, ssrfBlockReason, collectorInputIssue, identityIssue } from '../../collector/registry.js';
import { precheckTarget } from '../../sanswitch/precheck.js';
import { collectorsToCsv, sampleCsv as collectorsSampleCsv, parseCollectorsCsv, analyzeCollectorsImport } from '../../collector/csv.js';
import { clearCollectorServers } from '../../collector/remoteInventory.js';
import { listDatacenters, getDatacenterAssign, addDatacenter, updateDatacenter, removeDatacenter, setVcenterDatacenterMany, getDatacenterOrder, saveDatacenterOrder } from '../../datacenter/store.js';
import { allCollectorStatus, clearCollectorHosts, clearCollectorStatus } from '../../collector/state.js';
import { agentIdentitySummary } from '../../central/agentIdentity.js';
import { pullNow } from '../../collector/puller.js';
import { pushUpgradeToCollectors } from '../../collector/upgradePush.js';
import { resilientFetch } from '../../util/resilientFetch.js';
import { withOutboundTag } from '../../util/outboundStats.js'; // v2.611 LEFT2611-08: 같은 주소 엣지를 기록에서 나눈다
// v2.605(감사 LEFT2605-01 형제): 엣지 응답은 상한까지만 읽는다 — 비밀번호 변경·오류 본문은 작고, export 는 인벤토리 전량이라 큰 상한.
import { readJsonCapped, EDGE_EXPORT_MAX_BYTES } from '../../util/readCapped.js';
const EDGE_SMALL_MAX_BYTES = 256 * 1024;
import { resolveBundleBytes, lastBundleReject } from '../../upgrade/bundleSource.js';
import { upgradeManager } from '../../upgrade/manager.js';
import { adminOnly, ensureCollectorDatacenter, requireSettingsOwner, fullScopeOnlyWith } from './shared.js';
// v2.611 AUTHZ2611: 전 법인 등록부·동작은 전체 범위 계정만(v2.607 fleetWideOnly 의 형제 등록부).
const fleetOnly = fullScopeOnlyWith('수집 서버(엣지)·DataCenter 등록부는 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 조회·변경할 수 있습니다.');


// ── VM 사양 변경(ReconfigVM) — vCPU/RAM/디스크 증설·추가, NIC 추가/삭제 (관리자) ──────────
// vmId 형식 '<vcId>:<moref>'. 스냅샷으로 VM 존재·vCenter 자격증명을 확인한 뒤 SOAP 실행.
export function resolveVmTarget(vmId) {
  const snap = store.get();
  const vm = (snap.vms || []).find((v) => v.id === vmId);
  if (!vm) return { error: 'VM을 찾을 수 없습니다(현재 스냅샷에 없음 — 해당 vCenter 연결이 끊겼거나 폴링 전일 수 있습니다).', code: 404 };
  if (snap.source === 'mock') return { error: '데모(mock) 모드에서는 사양 변경을 사용할 수 없습니다.', code: 400 };
  // v2.598 VC2598-06: id 를 첫 콜론에서 자르지 않는다 — vCenter id 에 콜론이 있으면(registry 가 허용) 엉뚱한 vCenter 를
  // 찾았다. 스냅샷 VM 의 vcenterId 로 자른다(morefOf).
  const vcId = String(vm.vcenterId || '');
  const moref = morefOf(vmId, vcId);
  const vc = (loadVcenterConfig().vcenters || []).find((v) => v.id === vcId);
  // vCenter가 이 포탈에 직접 등록돼 있지 않으면(위임/엣지 수집 vCenter) 자격증명이 없어 사양 변경 불가.
  if (!vc) return { error: `이 VM의 vCenter('${vcId}')가 이 포탈에 등록되어 있지 않아 사양 변경을 할 수 없습니다(위임/엣지 수집 vCenter). 해당 vCenter가 직접 등록된 포탈에서 변경하세요.`, code: 400 };
  return { vm, vc, moref, snap };
}

/**
 * VM 단건 라우트의 데이터 범위 가드(v2.389) — 형제 라우트(vms/:id/console, VM 복제,
 * Tools 업그레이드, 프로비저닝)와 동일한 2단계 규약을 적용한다.
 *
 *  1) 조회 범위 밖  → 404 (존재 은닉. 범위 밖 VM 의 실재 여부를 알려주지 않는다)
 *  2) 조회는 되지만 쓰기 범위 밖 → 403 (존재는 이미 보이므로 은닉 불필요)
 *
 * 배경: /vm/:id/reconfig 는 vCPU·메모리 증설과 디스크/NIC 추가·삭제를 실제로 수행하는
 * 상태변경인데 requirePerm('vm.reconfig') 만 걸려 있었다. vm.reconfig 는 권한 카탈로그에
 * 있어 operator/viewer 에게 위임할 수 있으므로(기본 매트릭스는 admin 전용), 위임한 배포에서는
 * 범위 제한 계정이 범위 밖 vCenter 의 VM 을 재구성할 수 있었다. GET /vm/:id/hardware 도
 * 같은 권한만 요구해 범위 밖 VM 의 하드웨어·네트워크·데이터스토어 구성이 노출됐다.
 *
 * @param {boolean} write true 면 쓰기 범위까지 검사(POST reconfig), false 면 조회 범위만(GET).
 * @returns {null | { code, error }} null = 통과.
 */
function vmScopeDenied(req, vm, write) {
  const snap = store.get();
  if (!inUserScope(req.user, snap, vm.vcenterId)) {
    return { code: 404, error: 'VM 을 찾을 수 없습니다.' };
  }
  if (write && !inUserWriteScope(req.user, snap, vm.vcenterId)) {
    return { code: 403, error: '조회 전용 범위 — 이 vCenter 의 VM 사양을 변경할 수 없습니다.' };
  }
  return null;
}

export function registerCollectorsDc(adminRouter) {

// ---- Distributed collection: remote collector agents ----------------------

// List registered collectors (tokens redacted) + live pull status.
adminRouter.get('/collectors', adminOnly, fleetOnly, (_req, res) => {
  res.json({ collectors: listCollectors(), status: allCollectorStatus(), identity: agentIdentitySummary() });
});

adminRouter.post('/collectors', adminOnly, fleetOnly, (req, res) => {
  // 관리자 UI 등록 = 수동 고정(managed) — 엣지 자기등록이 URL/토큰을 덮어쓰지 못하게.
  const result = addCollector(req.body || {}, { managed: true });
  if (result.ok) { ensureCollectorDatacenter(result.collector); pullNow().catch(() => {}); logAudit({ user: req.user?.username, action: '수집 서버 등록', target: result.collector?.id || '', detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' }); }
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/collectors/:id', adminOnly, fleetOnly, (req, res) => {
  // 관리자 UI 수정 = 수동 고정(managed) — 저장한 URL/토큰이 자기등록으로 원복되던 버그 방지.
  const result = updateCollector(req.params.id, req.body || {}, { managed: true });
  if (result.ok) {
    ensureCollectorDatacenter(result.collector);
    // 비활성화 시 그 수집기의 원격 데이터도 즉시 걷어낸다 — 풀러는 disabled를 건너뛰므로
    // 남겨두면 서버 분석/전력 화면에 유령 서버가 재시작 전까지 계속 표시된다.
    if (result.collector?.enabled === false) { clearCollectorHosts(req.params.id); clearCollectorServers(req.params.id); }
    pullNow().catch(() => {});
    logAudit({ user: req.user?.username, action: '수집 서버 수정', target: req.params.id, detail: `url=${result.collector?.url || ''} vcenterId=${result.collector?.vcenterId || ''}`, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/collectors/:id', adminOnly, fleetOnly, (req, res) => {
  const result = removeCollector(req.params.id);
  if (result.ok) {
    clearCollectorHosts(req.params.id);   // 원격 전력 병합 상태 제거
    clearCollectorServers(req.params.id); // 서버 분석용 원격 인벤토리 제거(유령 서버 방지)
    clearCollectorStatus(req.params.id);  // v2.583 #31: 수집 상태도(원격 호스트 0개인 수집기는 정리 루프가 못 만난다)
    logAudit({ user: req.user?.username, action: '수집 서버 삭제', target: req.params.id, ip: req.ip || '' });
  }
  res.status(result.ok ? 200 : 404).json(result);
});

/* ── 수집 서버 CSV 일괄 관리(v2.338, 사용자 요구) — 내보내기·샘플·가져오기. ───────────────
 * 스토리지 장비 CSV(v2.313·2.317)와 동일 골격: 기본 export 는 토큰 제외, ?tokens=1 은
 * requireSettingsOwner 게이트(자격증명 덤프 — 백업 라우트와 같은 규칙) + 감사로그.
 * 가져오기는 dryRun(문법·중복·SSRF 검증, 저장 없음) → 커밋 2단계이고, 기존 id 와 겹치는
 * 행(덮어쓰기)은 body.overwrite=true 를 명시해야만 적용된다(사용자 요구 'overwrite 여부 확인').
 */

// 현재 등록 수집 서버를 CSV 로 내보내기. 기본은 토큰 제외(listCollectors redact 계약).
adminRouter.get('/collectors/export.csv', adminOnly, fleetOnly, (req, res) => {
  const withTok = String(req.query.tokens || '') === '1';
  const send = () => {
    const list = loadCollectors();
    const csv = collectorsToCsv(list, { includeTokens: withTok });
    logAudit({ user: req.user?.username, action: withTok ? '수집 서버 CSV 내보내기(토큰 포함)' : '수집 서버 CSV 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="collectors${withTok ? '-with-tokens' : ''}.csv"`);
    res.send(csv);
  };
  if (withTok) return requireSettingsOwner(req, res, send);
  send();
});

/** 샘플 CSV 템플릿 다운로드 — 헤더 + 컬럼 설명 주석 + 예시 2행. */
adminRouter.get('/collectors/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="collectors-sample.csv"');
  res.send(collectorsSampleCsv());
});

/**
 * CSV 일괄 가져오기 — body { csv, dryRun?, overwrite? }.
 *  - dryRun=true: 저장하지 않고 행별 판정(add/overwrite/error + 사유)만 반환. 검증 규칙은
 *    실제 저장과 동일(registry.collectorInputIssue — normalize 단일 소스, SSRF/URL 포함).
 *  - 커밋: add 행은 등록, overwrite 행은 **overwrite=true 일 때만** 갱신(아니면 skipped 로
 *    보고 — 기존 URL/토큰/매핑을 실수로 갈아엎는 사고 방지). 행별 성공/실패 정직 반환.
 *  - 가져온 항목은 관리자 수동 등록과 동일하게 managed=true(자기등록이 못 덮어씀).
 */
adminRouter.post('/collectors/import', adminOnly, fleetOnly, (req, res) => {
  const { rows, error } = parseCollectorsCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // 대소문자 무시 id 조회 → 기존 항목의 실제 id(registry dedupe 규칙과 동일 키).
  const existing = new Map(loadCollectors().map((c) => [String(c.id).toLowerCase(), c.id]));
  const existingId = (id) => existing.get(String(id).toLowerCase());

  const { report, summary } = analyzeCollectorsImport(rows, { existingId, validate: collectorInputIssue });
  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });
  }

  const allowOverwrite = req.body?.overwrite === true;
  let added = 0, overwritten = 0; const failed = []; const skipped = [];
  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, id: verdict.id, reason: verdict.reason }); continue; }
    const input = { id: row.id, name: row.name, url: row.url, datacenter: row.datacenter,
      vcenterId: row.vcenterId, enabled: row.enabled };
    if (row._hasToken) input.token = row.token; // 비우면 기존 유지(normalize 규칙)
    const curId = existingId(row.id);
    if (curId) {
      if (!allowOverwrite) { skipped.push({ line: row._line, id: row.id, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
      const r = updateCollector(curId, input, { managed: true });
      if (r.ok) {
        overwritten++; ensureCollectorDatacenter(r.collector);
        // v2.583 #31: PUT 라우트와 같게 — CSV 로 비활성화해도 원격 데이터를 즉시 걷어낸다(유령 서버 방지).
        if (r.collector?.enabled === false) { clearCollectorHosts(curId); clearCollectorServers(curId); }
      }
      else failed.push({ line: row._line, id: row.id, reason: r.reason });
    } else {
      const r = addCollector(input, { managed: true });
      if (r.ok) { added++; ensureCollectorDatacenter(r.collector); existing.set(row.id.toLowerCase(), row.id); }
      else failed.push({ line: row._line, id: row.id, reason: r.reason });
    }
  }
  if (added || overwritten) pullNow().catch(() => {});
  logAudit({ user: req.user?.username, action: '수집 서버 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}`, ip: req.ip || '' });
  res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
});

// 엣지 포탈 로컬 계정 비밀번호 일괄 변경 — 기본(admin) 비번을 중앙에서 한 번에 교체.
// Body: { username?='admin', password, ids?: string[](미지정=활성 전체), includeCentral?: boolean }
// 엣지의 /api/collector/set-password(COLLECTOR_TOKEN 가드)로 병렬 푸시. 비밀번호는 어디에도 로깅하지 않는다.
// ⚠ requireSettingsOwner(6차 재감사): username 이 요청 본문으로 완전히 제어되고, 서버가 저장된
// 엣지 토큰을 대신 붙여 푸시하므로 호출자는 COLLECTOR_TOKEN 을 몰라도 된다. 즉 이 라우트는
// '전 엣지의 임의 계정 비밀번호를 심는 권능'이다 — /admin/edge-users* 를 소유자 전용으로 올린
// 것과 정확히 같은 논리인데 그 승격에서 누락됐다. 엣지측에도 방어를 넣었지만(collector.js —
// 보호 계정 거부) 중앙에서도 막아 다층으로 둔다.
adminRouter.post('/collectors/set-password', adminOnly, fleetOnly, requireSettingsOwner, async (req, res) => {
  const username = String(req.body?.username || 'admin').trim();
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ ok: false, reason: '비밀번호는 8자 이상이어야 합니다.' });
  if (password.length > 128) return res.status(400).json({ ok: false, reason: '비밀번호는 128자 이하여야 합니다.' });
  const idFilter = Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids.map(String)) : null;
  const targets = loadCollectors().filter((c) => c.enabled !== false && c.url && (!idFilter || idFilter.has(String(c.id))));

  const results = await Promise.all(targets.map(async (c) => {
    if (!c.token) return { id: c.id, name: c.name || c.id, ok: false, reason: '이 수집 서버에 저장된 토큰이 없습니다(수정에서 토큰 입력).' };
    try {
      const r = await withOutboundTag(c.id, () => resilientFetch(`${String(c.url).replace(/\/+$/, '')}/api/collector/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Collector-Token': c.token },
        body: JSON.stringify({ username, password }),
        timeoutMs: 15_000, retries: 1,
      }));
      const body = await readJsonCapped(r, EDGE_SMALL_MAX_BYTES, '엣지 응답').then((j) => (j && typeof j === 'object' && !Array.isArray(j) ? j : {})).catch(() => ({}));
      if (r.status === 404) return { id: c.id, name: c.name || c.id, ok: false, reason: '엣지가 이 기능을 지원하지 않습니다(v2.107 미만 — 먼저 업그레이드하세요).' };
      if (r.status === 403) return { id: c.id, name: c.name || c.id, ok: false, reason: '토큰 불일치(엣지 COLLECTOR_TOKEN 확인).' };
      return { id: c.id, name: c.name || c.id, ok: r.ok && body.ok !== false, reason: body.reason || (r.ok ? null : `HTTP ${r.status}`), edgeVersion: body.version || null, totpEnabled: body.totpEnabled || false };
    } catch (e) {
      return { id: c.id, name: c.name || c.id, ok: false, reason: `연결 실패: ${e.message}` };
    }
  }));

  // 옵션: 중앙 포탈 자신의 동일 계정도 함께 변경(엣지/중앙 비번 통일용).
  let central = null;
  if (req.body?.includeCentral === true) {
    // actor 전달: 관리자 세션 경로이므로 보호 계정(수퍼관리자·설정소유자) 대리 변경 경계를 적용한다
    // (auth.js credentialGuardDenied — 일괄 변경으로 그 경계를 우회하지 못하게).
    const r = setLocalPassword(username, password, { actor: req.user?.username });
    central = { ok: r.ok, reason: r.reason || null };
  }

  const okN = results.filter((r) => r.ok).length;
  logAudit({ user: req.user?.username, action: '엣지 비밀번호 일괄 변경', target: username, detail: `성공 ${okN}/${results.length}${central ? ` · 중앙 ${central.ok ? '변경' : '실패'}` : ''}`, ip: req.ip || '' });
  res.json({ ok: true, username, total: results.length, succeeded: okN, results, central });
});

// ── DataCenter(법인) — vCenter의 상위 개념. 설정에서 종류 정의 + vCenter 할당 (관리자) ────────
adminRouter.get('/datacenters', adminOnly, (_req, res) => {
  // 백필: 등록된 수집 서버의 데이터센터를 DataCenter 목록에 없으면 자동 생성(이미 등록된 OC1 같은
  // 수집기도 재등록 없이 '스캔 대역 추가' 등에서 바로 보이게 한다). idempotent.
  try { for (const c of loadCollectors()) ensureCollectorDatacenter(c); } catch { /* best effort */ }
  res.json({ datacenters: listDatacenters(), assign: getDatacenterAssign() });
});
adminRouter.post('/datacenters', adminOnly, fleetOnly, (req, res) => {
  const r = addDatacenter(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 등록', target: r.datacenter?.id || '', detail: r.datacenter?.name || '', ip: req.ip || '' });
  res.status(r.ok ? 201 : 400).json(r);
});
// '/datacenters/assign'을 '/:id'보다 먼저 둬야 라우트 충돌이 없다.
adminRouter.put('/datacenters/assign', adminOnly, fleetOnly, (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 5000) : [];
  if (!entries.length) return res.status(400).json({ ok: false, reason: 'entries가 비었습니다.' });
  const r = setVcenterDatacenterMany(entries);
  if (r.ok) logAudit({ user: req.user?.username, action: 'vCenter→DataCenter 할당', target: `${r.changed}건`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.put('/datacenters/:id', adminOnly, fleetOnly, (req, res) => {
  const r = updateDatacenter(req.params.id, req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 수정', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/datacenters/:id', adminOnly, fleetOnly, (req, res) => {
  const r = removeDatacenter(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 404).json(r);
});
// DataCenter 표시 순서(vCenter 순서와 동일한 개념) — 모든 'DataCenter 선택' 목록에 적용.
adminRouter.get('/datacenter-order', adminOnly, (_req, res) => {
  res.json({ order: getDatacenterOrder(), datacenters: listDatacenters().map((d) => ({ id: d.id, name: d.name, region: d.region || '' })) });
});
adminRouter.put('/datacenter-order', adminOnly, fleetOnly, (req, res) => {
  // v2.620(WEB2620-01): 빈 순서는 명시적 초기화({clear:true})일 때만 — 화면이 조회에 실패한 상태에서
  // 저장하면 전 포탈의 DataCenter 순서가 지워졌다(v2.618 vCenter 순서 WEB-2 와 같은 모양).
  const body = req.body || {};
  const ids = Array.isArray(body.order) ? body.order : [];
  if (!ids.length && body.clear !== true) return res.status(400).json({ ok: false, reason: '빈 순서는 저장하지 않습니다 — 순서를 초기화하려면 clear:true 를 보내세요.' });
  const r = saveDatacenterOrder(ids);
  if (r.ok) logAudit({ user: req.user?.username, action: 'DataCenter 순서 변경', detail: `${(r.order || []).length}개`, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});

// 현재 하드웨어 + NIC 추가용 네트워크 목록.
adminRouter.get('/vm/:id/hardware', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  // 조회 범위 밖이면 404(존재 은닉) — 범위 밖 VM 의 하드웨어 구성 노출 차단(v2.389).
  if (t.vm) { const d = vmScopeDenied(req, t.vm, false); if (d) return res.status(d.code).json({ ok: false, reason: d.error }); }
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  try {
    const hw = await getVmHardware(t.vc, t.moref);
    // 이름 자연정렬(숫자 접미사 고려: uplink1 < uplink10, VMAX-2 < VMAX-10).
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });
    const networks = (t.snap.networks || [])
      .filter((n) => n.vcenterId === t.vc.id)
      .map((n) => ({ id: n.id, name: n.name, type: n.type, moref: morefOf(n.id, n.vcenterId || t.vc.id) }))
      .sort(byName);
    // 디스크 추가 시 선택할 데이터스토어 후보(해당 vCenter). 이름순으로 정렬(여유/총용량은 라벨에 표시).
    const datastores = (t.snap.datastores || [])
      .filter((d) => d.vcenterId === t.vc.id)
      .map((d) => ({ name: d.name, freeGB: d.freeGB, capacityGB: d.capacityGB }))
      .sort(byName);
    res.json({ ok: true, vmName: t.vm.name, powerState: hw.powerState, hw, networks, datastores });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

// 사양 변경 실행. body: { numCPUs?, memoryMB?, diskGrows?, diskAdds?, nicAdds?, nicRemoves? }
adminRouter.post('/vm/:id/reconfig', requirePerm('vm.reconfig'), async (req, res) => {
  const t = resolveVmTarget(req.params.id);
  // 상태변경 — 조회 범위 밖 404, 쓰기 범위 밖 403(v2.389). 형제 라우트와 동일 규약.
  if (t.vm) { const d = vmScopeDenied(req, t.vm, true); if (d) return res.status(d.code).json({ ok: false, reason: d.error }); }
  if (t.error) return res.status(t.code).json({ ok: false, reason: t.error });
  const b = req.body || {};
  const plan = {
    numCPUs: b.numCPUs != null ? Number(b.numCPUs) : undefined,
    coresPerSocket: b.coresPerSocket != null ? Number(b.coresPerSocket) : undefined,
    memoryMB: b.memoryMB != null ? Number(b.memoryMB) : undefined,
    diskGrows: Array.isArray(b.diskGrows) ? b.diskGrows.slice(0, 64) : [],
    diskAdds: Array.isArray(b.diskAdds) ? b.diskAdds.slice(0, 16).map((a) => ({
      sizeGB: a?.sizeGB, controllerKey: a?.controllerKey,
      datastore: a?.datastore ? String(a.datastore) : undefined,
    })) : [],
    nicAdds: Array.isArray(b.nicAdds) ? b.nicAdds.slice(0, 10) : [],
    nicRemoves: Array.isArray(b.nicRemoves) ? b.nicRemoves.slice(0, 10) : [],
    nicConnects: Array.isArray(b.nicConnects) ? b.nicConnects.slice(0, 20) : [],
  };
  // 선택한 데이터스토어가 이 vCenter의 실제 데이터스토어인지 검증(오타·타 vCenter 차단).
  const validDs = new Set((t.snap.datastores || []).filter((d) => d.vcenterId === t.vc.id).map((d) => d.name));
  for (const a of plan.diskAdds) {
    if (a.datastore && !validDs.has(a.datastore)) return res.status(400).json({ ok: false, reason: `데이터스토어 '${a.datastore}'를 찾을 수 없습니다(이 vCenter의 데이터스토어를 선택하세요).` });
  }
  try {
    const r = await reconfigVm(t.vc, t.moref, plan);
    logAudit({
      user: req.user?.username, action: 'VM 사양 변경',
      target: t.vm.name,
      detail: r.ok ? (r.changes || []).join(', ') : `실패: ${r.error}`,
      ip: req.ip || '',
    });
    if (r.ok) { store.refresh().catch(() => {}); return res.json({ ok: true, changes: r.changes }); }
    res.status(400).json({ ok: false, reason: r.error, changes: r.changes });
  } catch (e) {
    logAudit({ user: req.user?.username, action: 'VM 사양 변경', target: t.vm.name, detail: `오류: ${e.message}`, ip: req.ip || '' });
    res.status(502).json({ ok: false, reason: e.message });
  }
});

// Trigger an immediate pull of all collectors.
adminRouter.post('/collectors/pull', adminOnly, fleetOnly, async (_req, res) => {
  await pullNow();
  res.json({ ok: true, status: allCollectorStatus() });
});

// Push an upgrade bundle to collector agents. Body: { id?, force? }.
// Brings one (id) or all registered agents up to the central portal's version.
adminRouter.post('/collectors/upgrade', adminOnly, fleetOnly, async (req, res) => {
  const { id, force } = req.body || {};
  const bundle = await resolveBundleBytes(upgradeManager.settings);
  if (!bundle) {
    // 무결성 검증 실패(sha 불일치/부재)와 '번들 자체가 없음'을 구분해 알린다.
    const why = lastBundleReject();
    return res.status(409).json({ ok: false, reason: why || '업그레이드 번들을 찾을 수 없습니다 (감시 폴더/원격 소스 확인).' });
  }
  const results = await pushUpgradeToCollectors(bundle.bytes, { ids: id ? [id] : null, force: Boolean(force) });
  const ok = results.filter((r) => r.ok).length;
  res.json({ ok: true, version: bundle.version, source: bundle.source, pushed: results.length, succeeded: ok, results });
});

// Test connectivity to one collector (saved by id, or an ad-hoc {url, token}).
adminRouter.post('/collectors/test', adminOnly, fleetOnly, async (req, res) => {
  const body = req.body || {};
  let { url, token } = body;
  if (body.id) {
    const saved = loadCollectors().find((c) => c.id === body.id);
    // v2.480(3차 감사 S2): 저장 토큰을 물려받으면 URL 도 저장값으로 고정 — 임의 URL 에 저장 토큰을 헤더로 보내던 경로 차단
    // (토큰 열람은 소유자 전용인데 전송은 admin 이었다). 새 URL 을 시험하려면 토큰도 함께 입력해야 한다.
    if (saved) { if (!token) { token = saved.token; url = saved.url; } else { url = url || saved.url; } }
  }
  if (!url) return res.status(400).json({ ok: false, reason: 'url이 필요합니다.' });
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  // SSRF 방어: 링크로컬/클라우드 메타데이터 주소로는 토큰을 붙여 요청하지 않는다(등록 경로와 동일 가드).
  const ssrf = ssrfBlockReason(url);
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  const started = Date.now();
  let retried = 0;
  // 단계별 추적(v2.424, 사용자 요구 '중앙→엣지A→엣지B 포워딩 트러블슈팅'): 어디서 막히는지(TCP/토큰/정체) 분리한다.
  const steps = [];
  const entry = body.id ? loadCollectors().find((c) => c.id === body.id) : null;
  let host = '', port = 0;
  try { const u = new URL(url); host = u.hostname.replace(/^\[|\]$/g, ''); port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* */ }
  const pre = await precheckTarget(host, port, { trace: (m, lv) => steps.push({ msg: m, level: lv || 'info' }), timeoutMs: 8_000 });
  if (!pre.ok) {
    const hint = pre.phase === 'tcp' && /ECONNREFUSED/.test(pre.reason)
      ? `중앙에서 ${host}:${port} 까지는 도달했지만 그 포트에 리스너가 없습니다. 이 URL 이 중계 엣지의 포워딩 포트라면 포워딩 규칙(iptables DNAT/socat/nginx)이 없거나 죽은 것입니다.`
      : pre.phase === 'tcp' ? `중앙에서 ${host}:${port} 로 TCP 가 닿지 않습니다(SYN 무응답) — 방화벽/경로. 이 주소가 중계 엣지(A)라면 A 자체가 중앙에서 닿는지 먼저 확인하세요.` : '';
    return res.json({ ok: false, reason: `${pre.reason}${hint ? ` · ${hint}` : ''}`, phase: pre.phase, steps, ms: Date.now() - started, retried });
  }
  try {
    // 단발 fetch는 고RTT·일시적 네트워크 블립에 '가끔 연결 안 됨'으로 오판된다 → 재시도로 흡수.
    // 연결 테스트는 /export 본문(hosts·agent·version)이 필요하다 — 태그만 붙인다(v2.611 LEFT2611-08).
    const r = await withOutboundTag(String(req.body?.id || url), () => resilientFetch(`${url.replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', ...(token ? { 'X-Collector-Token': token } : {}) },
      timeoutMs: config.collector.timeoutMs, retries: 2,
      onRetry: () => { retried++; },
    }));
    if (!r.ok) {
      // 서버가 준 사유(collector 라우터의 error 필드)와 상태코드별 해결 힌트를 함께 안내한다.
      let serverMsg = '';
      try { const j = await readJsonCapped(r, EDGE_SMALL_MAX_BYTES, '엣지 오류 응답'); serverMsg = (typeof j?.error === 'string' && j.error) || (typeof j?.reason === 'string' && j.reason) || ''; } catch { /* 본문 없음/비JSON */ }
      const hint = r.status === 404
        ? "수집 서버에 COLLECTOR_TOKEN이 설정되지 않았습니다(export 비활성). 그 에이전트를 'COLLECTOR_TOKEN=<토큰>' 환경변수와 함께 실행/재시작하세요(리눅스: /etc/vmware-portal/portal.env)."
        : (r.status === 403 || r.status === 401)
          ? '토큰 불일치(인증 실패). 이 화면의 토큰을 에이전트의 COLLECTOR_TOKEN과 동일하게 맞추세요.'
          : (r.status === 405 || r.status === 400)
            ? '이 주소가 수집 에이전트(포탈)가 아닐 수 있습니다. URL/포트를 확인하세요.'
            : '';
      // 403 이면 '누가 거부했는지' 를 ping 없이도 알 수 있게 topology 힌트를 덧붙인다.
      const fwdHint = (r.status === 403 || r.status === 401) && entry && loadCollectors().some((c) => c.id !== entry.id && (() => { try { return new URL(c.url).hostname === host; } catch { return false; } })())
        ? ` 같은 호스트(${host})에 다른 수집 서버 항목이 있습니다 — 이 URL 이 포워딩 포트라면 거부한 쪽은 포워딩 대상(엣지B)이 아니라 중계 엣지(A) 자신일 수 있습니다(포워딩 규칙 확인). '토큰 강제 동기화'는 URL 호스트(A)에 SSH 하므로 이 항목에는 쓰지 마세요.`
        : '';
      steps.push({ msg: `export HTTP ${r.status}${serverMsg ? ` — ${serverMsg}` : ''}`, level: 'error' });
      return res.json({ ok: false, reason: `HTTP ${r.status}${serverMsg ? ` — ${serverMsg}` : ''}${hint ? ` · ${hint}` : ''}${fwdHint}`, status: r.status, steps, ms: Date.now() - started, retried });
    }
    const data = await readJsonCapped(r, EDGE_EXPORT_MAX_BYTES, '엣지 export 응답');
    steps.push({ msg: `export 200 · 응답 엣지 ${data.agent || '(구버전: 이름 없음)'}${data.hostname ? `(${data.hostname})` : ''} · v${data.version || '?'} · DC ${data.datacenter || '—'} · 호스트 ${data.hosts ?? '—'}대`, level: 'info' });
    const identity = identityIssue(entry || { id: String(body.id || body.name || ''), name: body.name, datacenter: body.datacenter }, data);
    if (identity) steps.push({ msg: identity.reason, level: 'warn' });
    res.json({ ok: true, ms: Date.now() - started, retried, hosts: data.hosts, version: data.version, datacenter: data.datacenter, agent: data.agent || '', hostname: data.hostname || '', identity, steps });
  } catch (err) {
    steps.push({ msg: err.message, level: 'error' });
    res.json({ ok: false, reason: err.message, steps, ms: Date.now() - started, retried });
  }
});

// 토큰 강제 동기화 — 연결 테스트가 403(토큰 불일치)일 때, 수집 서버 URL의 호스트와 일치하는
// 'Edge 노드 포탈 설치' 저장 대상(SSH)을 찾아 엣지 portal.env의 COLLECTOR_TOKEN을 이 화면의
// 토큰으로 교체·재시작하고, 중앙 저장 토큰도 같은 값으로 고정(managed)한 뒤 재검증한다.
adminRouter.post('/collectors/:id/force-token', adminOnly, fleetOnly, async (req, res) => {
  const saved = loadCollectors().find((c) => c.id === req.params.id);
  if (!saved) return res.status(404).json({ ok: false, reason: `없는 수집 서버: ${req.params.id}` });
  const token = String(req.body?.token || saved.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, reason: '토큰이 없습니다. 이 화면에서 토큰을 입력(또는 자동 생성)한 뒤 다시 시도하세요.' });
  // v2.480(3차 감사 S2): 저장 토큰(req.body.token 없음)을 쓰는 동기화는 URL 도 저장값 고정
  let url = String((req.body?.token ? req.body?.url : '') || saved.url || '').trim();
  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;
  const ssrf = url ? ssrfBlockReason(url) : 'URL이 없습니다.';
  if (ssrf) return res.status(400).json({ ok: false, reason: ssrf });
  let host = ''; let urlPort = 0;
  try { const u = new URL(url); host = u.hostname; urlPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); } catch { /* 아래에서 처리 */ }
  if (!host) return res.status(400).json({ ok: false, reason: '수집 서버 URL에서 호스트를 확인할 수 없습니다.' });
  const pick = pickSshTarget(listTargets().map((t) => getTargetRaw(t.id)).filter(Boolean), host, req.body?.sshTargetId);
  if (!pick.ok) return res.status(pick.candidates ? 409 : 404).json({ ok: false, reason: pick.reason, candidates: pick.candidates });
  const target = pick.target;
  // URL 포트를 실제 서비스 중인 인스턴스를 역추적해 적용 — 같은 호스트 다중 인스턴스(:4000/:4001)나
  // NAT 포워딩(다른 장비)일 때 기본 인스턴스만 고치고 '성공'으로 오판하던 버그 방지.
  // v2.428: 대상이 포워딩 경유(SSH 포트≠22 등 명시 선택)면 URL 포트(중계 엣지의 4068)가 아니라 그 장비의 포탈 포트로 역추적한다.
  const probePort = pick.viaRelay ? (Number(target.portalPort) || 4000) : urlPort;
  const r = await forceCollectorToken(target, token, { urlPort: probePort });
  logAudit({ user: req.user?.username, action: '수집 서버 토큰 강제 동기화', target: `${saved.id} (${host})`, detail: r.ok ? `성공 · 서비스 ${r.active}` : `실패 — ${r.reason}`, ip: req.ip || '' });
  if (!r.ok) return res.status(400).json({ ok: false, reason: r.reason, host, sshTarget: target.id, log: r.log });
  // 중앙 저장 토큰도 동일 값으로 고정(managed) — 엣지 자기등록이 이 값을 덮어쓰지 않게.
  const upd = updateCollector(saved.id, { ...saved, token, url: saved.url }, { managed: true });
  // 재검증: 새 토큰으로 export가 200인지 확인(서비스 기동 직후라 재시도 여유).
  let verified = false; let verifyReason = '';
  try {
    const vr = await withOutboundTag(saved.id, () => resilientFetch(`${String(saved.url || url).replace(/\/+$/, '')}/api/collector/export`, {
      headers: { Accept: 'application/json', 'X-Collector-Token': token },
      timeoutMs: config.collector.timeoutMs, retries: 2,
    }));
    try { await vr.body?.cancel?.(); } catch { /* 상태만 본다 — 인벤토리 본문은 읽지 않고 닫는다(v2.611 LEFT2611-08) */ }
    verified = vr.ok;
    if (!vr.ok) verifyReason = `HTTP ${vr.status}`;
  } catch (e) { verifyReason = e.message; }
  if (verified) pullNow().catch(() => {});
  res.json({ ok: true, host, sshTarget: target.id, active: r.active, unit: r.unit, envFile: r.envFile, note: r.note || undefined, savedToken: upd.ok, verified, verifyReason: verified ? undefined : verifyReason });
});
}
