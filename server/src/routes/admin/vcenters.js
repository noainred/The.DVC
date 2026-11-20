// 데이터 소스·vCenter CRUD/테스트/순서 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config, loadVcenterConfig } from '../../config.js';
import { vcAuthGuard } from '../../vcenter/restClient.js';
import { authStopView } from '../../util/authGuard.js';   // 130회차: 못 읽음 표지(unread)를 떨구지 않는 공용 view(127 C1 의 남은 사본)
import { store } from '../../store.js';
import { getDataSource, setDataSource, isDataSourceOverridden } from '../../runtime-settings.js';
import { listRegistry, addVcenter, updateVcenter, removeVcenter, testConnection, registryLoadError, registryWriteRefusal } from '../../vcenter/registry.js';
import { getOrder, saveOrder, sortByOrder, orderWriteRefusal } from '../../vcenter/order.js';
import { unreadMark } from '../settingsUnreadMark.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { probeRelayPath } from '../../vcenter/relayProbe.js';
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope, WRITE_SCOPE_PARTIAL_REASON } from '../../auth/scope.js';

/*
 * v2.607 AUTHZ2607-03 — vCenter 등록부는 법인 축이 있다. 예전에는 adminOnly 뿐이라 범위 제한 admin 이 범위 밖
 * vCenter 의 관리 주소·계정명을 보고, 수정(collectMode·enabled)·삭제(그 법인 수집 중단)할 수 있었다.
 *   · 목록·순서·전체 테스트는 범위 안만(뺀 개수는 omittedOutOfScope).
 *   · 수정·삭제·단건 테스트는 범위 밖이면 404(존재 은닉), 조회만 되고 쓰기 범위 밖이면 403.
 *   · 새 등록·데이터 소스 전환·표시 순서 저장은 전 법인에 걸친 동작이라 범위 계정 403.
 */
const fleetWideOnly = fullScopeOnlyWith('vCenter 등록·데이터 소스 전환·표시 순서는 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');
/**
 * 대상 vCenter 가 범위 밖이면 응답하고 true — 조회 밖 404 → 쓰기 밖 403.
 * 전체 점검 7회차(2회차 반증 R-2 — 재현): 예전 `if (!read) return false` 가 쓰기 검사보다 앞이라 조회 무제한 · 쓰기 제한 관리자가
 *   쓰기 범위 밖 vCenter 등록을 고치고 지웠다(server/CLAUDE.md v2.733 함정). 판정이 던지면 거부.
 */
function denyVcOutOfScope(req, res, id) {
  const snap = store.get();
  let read; let write;
  try { read = scopedVcenterIds(req.user, snap); write = writeScopedVcenterIds(req.user, snap); } catch { read = new Set(); write = new Set(); }
  if (read && !read.has(String(id))) { res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' }); return true; }
  if (write && !write.has(String(id))) { res.status(403).json({ ok: false, error: 'forbidden', reason: '조회 전용 범위 — 이 vCenter 는 수정 권한이 없습니다.' }); return true; }
  return false;
}

/*
 * 118회차: vCenter 등록부 · 표시 순서 파일을 **읽지 못한 동안**(읽기 오류 — 원본은 그대로 있다)의 응답 규약.
 *   · 쓰기 거절은 **503**(`code:'registry-unreadable'` · `registryUnreadable:true` · `readError:true`) — 웹 `putJson`/`delJson` 은 400 · 409 본문을 던지지 않고
 *     돌려주므로(삭제 화면은 반환값을 보지 않는다) 그 상태 코드로 주면 화면이 성공으로 읽는다. 사유는 고정 문구 + 오류 코드뿐이다(파일 조각 없음).
 *   · 조회는 표지(`loadError` — routes/settingsUnreadMark.js 규약)를 싣는다 — 목록은 마지막으로 읽은 것(기동 뒤 한 번도 못 읽었으면 빈 목록)이라
 *     화면이 '등록된 vCenter 가 없습니다' 로 읽고 새로 등록하지 않게. 손상(보존본으로 옮김)은 readError 없이 사유만(저장이 새 등록부를 만든다 — 예전 규약).
 */
function unreadable503(res, ref) {
  res.status(503).json({ ok: false, code: 'registry-unreadable', registryUnreadable: true, readError: true, reason: String(ref?.reason || '등록부를 읽지 못해 저장하지 않았습니다.') });
}
function registryMark() {
  let le = null;
  try { le = registryLoadError(); } catch { le = null; }
  if (!le) return {};
  if (le.readError) return unreadMark(registryWriteRefusal());
  const why = summarizeRegistryError(le)?.text || '손상';
  return { loadError: { reason: `vCenter 등록부(vcenters.json)를 읽지 못했습니다(${why}) — 손상 보존본(vcenters.json.corrupt.*)이 설정 폴더에 있습니다` } };
}

export function registerVcenters(adminRouter) {

// Read the effective data source (UI override or env default).
adminRouter.get('/data-source', adminOnly, (_req, res) => {
  res.json({ dataSource: getDataSource(), envDefault: config.dataSource, overridden: isDataSourceOverridden() });
});

// Switch the data source at runtime (mock | live | auto) and re-poll.
adminRouter.put('/data-source', adminOnly, fleetWideOnly, async (req, res) => {
  const result = setDataSource((req.body || {}).dataSource);
  if (!result.ok) return res.status(result.status === 503 ? 503 : 400).json(result);   // 107회차: 설정 파일 읽기 오류는 503 settingsUnreadable
  await store.refresh().catch(() => {});
  res.json({ ...result, overridden: isDataSourceOverridden() });
});

// List registered vCenters (credentials redacted) + current data-source mode.
adminRouter.get('/vcenters', adminOnly, (req, res) => {
  // v2.590(감사 F1): 인증 실패로 **주기 수집을 멈춘** vCenter 를 목록이 말하게 정지 기록을 싣는다.
  // 판정에는 복호된 자격증명이 필요하다(credHash — 비밀번호를 고쳤으면 스스로 해제된다). 응답에는
  // 해시·비밀번호를 싣지 않는다(시각·횟수·사유만).
  let full = new Map();
  try { full = new Map((loadVcenterConfig().vcenters || []).map((v) => [v.id, v])); } catch { /* 목록은 그대로 */ }
  const withStop = (v) => {
    // 130회차(127 반증 — 재현): 목록은 **보기만** 한다(peekAuthStop). authStopFor 로 물으면 정지 기록 파일을 못 읽는 창에서 이 조회가 자격 지문의 탐침을 받아 간다 —
    //   이 목록은 비활성 · 점검중 · 엣지 위임 vCenter(이 포탈이 수집하지 않는다)까지 표시 순서대로 묻기 때문에, 탐침이 수집하지 않는 vCenter 로 가면 결과가 오지 않아
    //   직접 수집 vCenter 가 시한(10분)씩 기다렸다. 자격증명을 고친 경우의 표시는 같다(peek 도 기록과 자격이 다르면 null — 기록 정리는 주 폴러가 한다).
    const rec = full.has(v.id) ? vcAuthGuard.peekAuthStop(full.get(v.id)) : null;
    return rec ? { ...v, authStopped: authStopView(rec) } : v;
  };
  const all = sortByOrder(listRegistry());
  const allowed = scopedVcenterIds(req.user, store.get());
  if (!allowed) return res.json({ dataSource: getDataSource(), vcenters: all.map(withStop), ...registryMark() }); // 저장된 표시 순서 적용
  const mine = all.filter((v) => allowed.has(v.id));
  res.json({ dataSource: getDataSource(), vcenters: mine.map(withStop), scoped: true, omittedOutOfScope: all.length - mine.length, ...registryMark() });
});

// Register a new vCenter, then trigger a re-poll.
adminRouter.post('/vcenters', adminOnly, fleetWideOnly, async (req, res) => {
  const result = addVcenter(req.body || {});
  if (!result.ok && result.code === 'registry-unreadable') return unreadable503(res, result);   // 118회차
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});

// Update an existing vCenter (omit password to keep it), then re-poll.
adminRouter.put('/vcenters/:id', adminOnly, async (req, res) => {
  if (denyVcOutOfScope(req, res, req.params.id)) return;
  const result = updateVcenter(req.params.id, req.body || {});
  if (!result.ok && result.code === 'registry-unreadable') return unreadable503(res, result);   // 118회차
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Remove a vCenter, then re-poll.
adminRouter.delete('/vcenters/:id', adminOnly, async (req, res) => {
  if (denyVcOutOfScope(req, res, req.params.id)) return;
  const result = removeVcenter(req.params.id);
  if (!result.ok && result.code === 'registry-unreadable') return unreadable503(res, result);   // 118회차
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});

// Test connectivity to a vCenter (new entry or a saved one by id).
adminRouter.post('/vcenters/test', adminOnly, async (req, res) => {
  // v2.607: 범위 계정은 저장된 범위 안 vCenter 만 시험한다(새 항목 시험은 등록과 같은 전 법인 동작 — 403).
  // 전체 점검 2회차 V-1: 새 항목 시험은 등록(fleetWideOnly — POST 는 조회 ∧ 쓰기 전체)과 같은 판정. 조회만 보면 쓰기만 줄인 관리자가 새 항목(임의 호스트)을 시험했다.
  if (!isFullReadWriteScope(req.user, store.get())) {
    const id = String((req.body || {}).id || '');
    const read = scopedVcenterIds(req.user, store.get());
    if (!id) return res.status(403).json(read ? { ok: false, error: 'forbidden', reason: '새 vCenter 연결 테스트는 전체 범위(vCenter 제한 없는) 계정만 할 수 있습니다.' } : { ok: false, error: 'forbidden', reason: WRITE_SCOPE_PARTIAL_REASON, writeScope: 'partial' });
    if (denyVcOutOfScope(req, res, id)) return;   // 전체 점검 7회차: 저장 항목 시험(저장 비밀로 접속)도 조회 밖 404 → 쓰기 밖 403
    // v2.630 AUTHZ2630-02: 범위 계정의 테스트는 저장된 접속처(host·port)로만 — body.host 로 바꿔 임의 호스트를 두드리지 못하게.
    return res.json(await testConnection(req.body || {}, { pinSavedHost: true }));
  }
  res.json(await testConnection(req.body || {}));
});

// 등록된 모든 vCenter 연결을 병렬로 한 번에 테스트(느린 1곳이 전체를 막지 않게 per-vCenter 독립).
// ?only=enabled 면 '수집 사용'인 것만. 실패 시 중계 경로(TCP·TLS·HTTP) 단계 진단을 자동 첨부해
// 'TCP부터 안 됨(경로/방화벽)' vs 'TCP는 되는데 TLS만 막힘(HAProxy backend 끊김)'을 바로 구분.
adminRouter.post('/vcenters/test-all', adminOnly, async (req, res) => {
  const onlyEnabled = String(req.query.only || (req.body || {}).only || '') === 'enabled';
  const withRelay = String(req.query.relay || (req.body || {}).relay || 'true') !== 'false';
  let list = sortByOrder(listRegistry());
  // 전체 점검 7회차: 저장 비밀로 접속하는 시험이라 쓰기 범위 안만(writeScopedVcenterIds — 조회 범위와의 교집합 · 둘 다 무제한이면 null). 던지면 빈 목록.
  let allowedAll;
  try { allowedAll = writeScopedVcenterIds(req.user, store.get()); } catch { allowedAll = new Set(); }
  const totalRegistered = list.length;
  if (allowedAll) list = list.filter((v) => allowedAll.has(v.id));   // v2.607: 범위 안만
  const omittedOutOfScope = totalRegistered - list.length;
  if (onlyEnabled) list = list.filter((v) => v.enabled !== false);
  const results = await Promise.all(list.map(async (vc) => {
    const r = await testConnection({ id: vc.id }).catch((e) => ({ ok: false, reason: e.message }));
    const base = { id: vc.id, name: vc.name, host: vc.host, enabled: vc.enabled !== false, collectMode: vc.collectMode || 'direct', ...r };
    // 실패 시에만 경로 진단(짧은 6s 단계 타임아웃, 병렬) — 어디서 막혔는지 즉시 노출.
    if (!r.ok && withRelay) base.relay = await probeRelayPath(vc.host, { timeoutMs: 6000 }).catch(() => null);
    return base;
  }));
  res.json({ ok: true, testedAt: Date.now(), total: results.length, okCount: results.filter((r) => r.ok).length, results, ...(allowedAll ? { scoped: true, omittedOutOfScope } : {}) });
});

// vCenter display order (applies to every "vCenter 선택" list in the web).
adminRouter.get('/vcenter-order', adminOnly, (req, res) => {
  const allowed = scopedVcenterIds(req.user, store.get());
  const order = allowed ? getOrder().filter((id) => allowed.has(id)) : getOrder();
  const rank = new Map(order.map((id, i) => [id, i]));
  // Return all registered vCenters in saved order; unsaved ones appended.
  const list = listRegistry().filter((v) => !allowed || allowed.has(v.id)).map((v) => ({ id: v.id, name: v.name, region: v.location?.region || '' }));
  list.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  res.json({ order, vcenters: list, ...unreadMark(orderWriteRefusal() || registryWriteRefusal()) });   // 118회차: 순서 · 등록부를 못 읽은 동안의 조회 표지
});
adminRouter.put('/vcenter-order', adminOnly, fleetWideOnly, (req, res) => {
  // v2.618(WEB-2): 빈 순서는 명시적 초기화({clear:true})일 때만 — 화면이 조회에 실패한 상태에서 저장하면 전 포탈 순서가 지워졌다.
  const body = req.body || {};
  const ids = Array.isArray(body.order) ? body.order.filter((x) => String(x ?? '').trim()) : [];
  if (!ids.length && body.clear !== true) return res.status(400).json({ ok: false, reason: '빈 순서는 저장하지 않습니다 — 순서를 초기화하려면 clear:true 를 보내세요.' });
  { const ref = orderWriteRefusal(); if (ref) return unreadable503(res, ref); }   // 118회차: 읽히지 않는 순서 파일을 보존본 없이 덮지 않는다
  res.json({ ok: true, order: saveOrder(ids) });
});
}
