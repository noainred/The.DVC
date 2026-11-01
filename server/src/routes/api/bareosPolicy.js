/**
 * Bareos 정책 · 일정(v2.839 백업 메뉴 개편 2차-a — 시안 ③ '정책 · 일정').
 *   GET  /tools/bareos-summary/policy            — 수집본으로 만든 화면 값(조회 전용 키 bareos-summary · **Director 에 접속하지 않는다**)
 *   POST /tools/bareos-backup/policy/collect     — '지금 수집'(관리 도구 bareos-backup · admin · Director 마다 1분 1회 · 감사 · 뒤에서 돈다)
 *   v2.840 GET /tools/bareos-summary/pools       — '보존 · 풀' 탭(수집본만 — **Director 에 접속하지 않는다**)
 *   v2.840 GET /tools/bareos-backup/policy/volumes?directorId=&pool= — 풀 하나의 볼륨 목록 즉시 조회(관리 도구 · admin · Director · 풀마다 1분 1회 — 그 사이는 같은 결과)
 *
 * 규칙(되돌리지 말 것 — test/bareosPolicy2839.test.js):
 *   · 조회 범위(scopedVcenterIds)가 먼저 — 범위 안 법인에 묶인 Director 만 · 범위 밖 Director id 를 고르면 404(존재 은닉).
 *   · 잡 · VM 이름이 실리므로 범위 계정에는 범위 밖 법인의 잡을 세지 않는다(policyView.jobOk) · Director 오류 원문은 관리자 판본만.
 *   · 응답 캐시 키 = scopeKey + 역할 + 수집본 · 원장 · 표시 · 설정 · 그룹 리비전 + 수집 중 여부.
 *   · 수집 POST 는 범위 계정 관리자도 자기 법인 Director 만 — 핸들러가 범위를 판정한다(archScan ROUTE_GATE_ALLOW 에 사유).
 */
import { requirePerm, requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { isAdminDetailUser, isDemoGuest } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { logAudit } from '../../audit.js';
import { jobDigests, registryLoadError, registryRev } from '../../bareos/registry.js';
import { listGroups, groupsLoadError, groupsRev } from '../../bareos/groups.js';
import { settingsRev } from '../../bareos/settings.js';
import { effectiveSettings, isDemoActive, onDirector } from '../../bareos/service.js';
import { isResourceName } from '../../bareos/names.js';
import { sendBareosErr } from './bareosBackup.js';
import { getMarks, marksRev, marksUnreadable } from '../../veeam/backupMarks.js';
import {
  policyView, poolsView, policyRev, policyCollecting, policyBusy, collectPolicy, scopedDirectors, manualWaitSec, markManual,
} from '../../bareos/policy.js';

/** 조회(GET)용 Director 작업 — 데모 계정은 데모 Director 일 때만(bareosGroups.js 와 같은 모양 — audit2719b 스윕이 대조). */
const readDirector = ({ demoOnly = false } = {}, directorId, kind, args, opts = {}) => onDirector(directorId, kind, args, { ...opts, demoOnly });
/** v2.840 볼륨 즉시 조회 간격 · 기억(Director|풀 → { at, result } · 진행 중) — 1분 안에 다시 누르면 같은 결과(Director 를 다시 부르지 않는다). */
export const VOLUME_QUERY_GAP_MS = 60_000;
const VOLUME_QUERY_MS = 60_000;
const VOLUME_MEMO_MAX = 200;
const _volMemo = new Map();
const _volBusy = new Set();
export function _resetVolumeQueryForTest() { _volMemo.clear(); _volBusy.clear(); }

export function registerBareosPolicy(api) {
  const toolsPerm = requirePerm('tools');

  api.get('/tools/bareos-summary/policy', toolsPerm, (req, res) => {
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const collecting = policyCollecting();
    const key = `${scopeKey(req.user, snap)}|${admin ? 'a' : 'u'}|p${policyRev()}|r${registryRev()}|m${marksRev()}|s${settingsRev()}|g${groupsRev()}|c${[...collecting].sort().join(',')}|b${policyBusy() ? 1 : 0}`;
    return memoJson(req, res, 'bareos-policy', async () => {
      const allowed = scopedVcenterIds(req.user, snap);
      const settings = effectiveSettings();
      const regBad = !!registryLoadError();
      let groups = [];
      try { groups = groupsLoadError() ? [] : listGroups(); } catch { groups = []; }
      const marksBad = marksUnreadable();
      const vmsById = new Map((snap?.vms || []).map((v) => [v.id, v]));
      const names = new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
      const view = policyView({
        settings, digests: regBad ? [] : jobDigests(), digestsKnown: !regBad, groups, marks: marksBad ? {} : getMarks(), marksKnown: !marksBad,
        vmsById, allowed, admin, demo: isDemoActive(), now: Date.now(), vcName: (id) => names.get(id) || id, collecting,
      });
      return { ...view, demo: isDemoActive() || undefined, canCollect: admin, groupsUnreadable: (() => { try { return !!groupsLoadError(); } catch { return true; } })() || undefined };
    }, { ttlMs: 30_000, extraKey: key });
  });

  /*
   * v2.840 '보존 · 풀' 탭 — 범위 안 Director 의 수집본(풀 · 볼륨 요약 · 클라이언트 보존). Director 에 접속하지 않는다(v2.828 조회 화면 규칙).
   *   canQuery = 볼륨 즉시 조회 버튼(관리자 판본 — 서버는 그 라우트에서 다시 판정한다).
   */
  api.get('/tools/bareos-summary/pools', toolsPerm, (req, res) => {
    const snap = store.get();
    const admin = isAdminDetailUser(req.user);
    const key = `${scopeKey(req.user, snap)}|${admin ? 'a' : 'u'}|p${policyRev()}|r${registryRev()}|s${settingsRev()}|g${groupsRev()}`;
    return memoJson(req, res, 'bareos-pools', async () => {
      const allowed = scopedVcenterIds(req.user, snap);
      const settings = effectiveSettings();
      const regBad = !!registryLoadError();
      let groups = [];
      try { groups = groupsLoadError() ? [] : listGroups(); } catch { groups = []; }
      const names = new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
      const view = poolsView({ settings, digests: regBad ? [] : jobDigests(), digestsKnown: !regBad, groups, allowed, admin, demo: isDemoActive(), now: Date.now(), vcName: (id) => names.get(id) || id });
      return { ...view, demo: isDemoActive() || undefined, canQuery: admin, queryGapSec: Math.round(VOLUME_QUERY_GAP_MS / 1000) };
    }, { ttlMs: 30_000, extraKey: key });
  });

  /*
   * v2.840 풀 하나의 볼륨 목록 — Director 에 `list volumes pool=` 하나(읽기 전용 · ops.volumes). 관리 도구(bareos-backup) · admin.
   *   범위: 조회 범위 안 법인에 묶인 Director 만(밖이면 404) · 풀 이름은 리소스 이름 모양만(400) · Director|풀마다 1분 — 그 안에는 기억한 결과(cached).
   *   같은 Director|풀 조회가 진행 중이면 409. 결과는 저장하지 않는다(화면에만).
   */
  api.get('/tools/bareos-backup/policy/volumes', toolsPerm, requireRole('admin'), async (req, res) => {
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const settings = effectiveSettings();
    const directorId = String(req.query.directorId || '').slice(0, 44);
    const pool = String(req.query.pool || '').slice(0, 80);
    if (!scopedDirectors(settings, allowed).has(directorId)) return res.status(404).json({ ok: false, reason: 'Director 를 찾을 수 없습니다.' });
    if (!isResourceName(pool)) return res.status(400).json({ ok: false, code: 'invalid', reason: '풀 이름이 올바르지 않습니다(공백 · 따옴표가 든 이름은 즉시 조회를 지원하지 않습니다 — Director 에서 직접 확인하세요).' });
    const k = `${directorId}|${pool}`;
    const now = Date.now();
    const m = _volMemo.get(k);
    if (m && now - m.at < VOLUME_QUERY_GAP_MS) return res.json({ ok: true, cached: true, at: m.at, nextSec: Math.ceil((VOLUME_QUERY_GAP_MS - (now - m.at)) / 1000), ...m.result });
    if (_volBusy.has(k)) return res.status(409).json({ ok: false, code: 'busy', reason: '같은 풀을 조회하는 중입니다 — 끝나면 다시 누르세요.' });
    _volBusy.add(k);
    try {
      const r = await readDirector({ demoOnly: isDemoGuest(req.user) }, directorId, 'volumes', { pool }, { trigger: 'manual', signal: AbortSignal.timeout(VOLUME_QUERY_MS) });
      const at = Date.now();
      _volMemo.set(k, { at, result: r });
      if (_volMemo.size > VOLUME_MEMO_MAX) _volMemo.delete(_volMemo.keys().next().value);
      return res.json({ ok: true, at, nextSec: Math.round(VOLUME_QUERY_GAP_MS / 1000), ...r });
    } catch (e) {
      return sendBareosErr(res, e);
    } finally { _volBusy.delete(k); }
  });

  /*
   * '지금 수집' — body { directorIds?: string[] }(없으면 범위 안 전부 · 수집을 끈 Director 는 빼고). 뒤에서 돈다 — 202 로 바로 답하고 화면은 GET 의 collecting 을 본다.
   *   Director 에는 읽기 전용 명령만 보낸다(ops.policy) · 엣지 대행 Director 는 그 엣지 큐로.
   */
  api.post('/tools/bareos-backup/policy/collect', toolsPerm, requireRole('admin'), (req, res) => {
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const settings = effectiveSettings();
    const scoped = scopedDirectors(settings, allowed);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const asked = Array.isArray(body.directorIds) ? [...new Set(body.directorIds.map((x) => String(x).slice(0, 44)))].slice(0, 64) : null;
    if (asked && asked.some((id) => !scoped.has(id))) return res.status(404).json({ ok: false, reason: 'Director 를 찾을 수 없습니다.' });
    const off = new Set(settings.defaults?.policy?.off || []);
    const ids = asked || [...scoped.keys()].filter((id) => !off.has(id));
    if (!ids.length) return res.status(400).json({ ok: false, reason: '수집할 Director 가 없습니다 — 설정 › 법인별 Director 와 매핑을 확인하세요.' });
    if (policyBusy()) return res.status(409).json({ ok: false, reason: '이미 수집 중입니다 — 끝난 뒤 화면이 새 값을 보입니다.' });
    const wait = manualWaitSec(ids);
    if (wait) return res.status(429).json({ ok: false, reason: `‘지금 수집’ 은 Director 마다 1분에 한 번입니다 — ${wait}초 뒤 다시 누르세요.` });
    markManual(ids);
    collectPolicy({ trigger: 'manual', directorIds: ids }).catch(() => {});
    logAudit({ user: req.user?.username, action: 'bareos-policy.collect', target: 'bareos', detail: `Director ${ids.length}개 · ${ids.map((id) => settings.directors.find((d) => d.id === id)?.name || id).slice(0, 5).join(', ')}`, ip: req.ip });
    return res.status(202).json({ ok: true, started: ids });
  });
}
