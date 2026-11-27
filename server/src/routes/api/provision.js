// VM 프로비저닝 조회 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { expandSpec } from '../../provision/spec.js';
import { listSources, listJobsScoped, getJob, jobsStoreError } from '../../provision/jobs.js';
import { getPlacement } from '../../provision/placement.js';
import { listSaved, getSaved, savedReadError } from '../../provision/saved.js';
import { requirePerm } from '../../auth/auth.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';

// v2.313 보안 감사 반영: 프로비저닝 조회 라우트에 requirePerm('vm.provision') + 사용자 scope
// 교집합을 적용한다(과거 갭 — scope 제한 계정이 범위 밖 전 vCenter VM/템플릿 열거, /placement 로
// 임의 vCenter 라이브 SOAP 유발). scopeOf: null=제한 없음(전체), Set=허용 vCenter id.
const scopeOf = (req) => scopedVcenterIds(req.user, store.get());
const canProvision = requirePerm('vm.provision');

/**
 * 보안 잔여 11-27 L7(반증 2회차 M-1 — 재현): 저장된 작업 1건이 이 사용자에게 보이는가. 데모 계정은 **자기가 만든 것만**(사실상 0건 — 데모 계정은 작업을 만들 수 없다).
 *   저장 작업은 VM 을 만들 때마다 자동으로 남고(createJob → addSaved) 작성 포탈 계정(createdBy) · 화면 입력 전체(정적 IP 목록 · 게이트웨이 · DNS · 도메인 · 이름 패턴)를 담는다.
 *   데모 계정은 요청 문맥이 role admin 이라 vm.provision 게이트를 통과했고(operator 는 기본 권한에 vm.provision 이 없어 403 — operator 판본이 없다),
 *   같은 작업의 /provision/jobs 는 v2.744 AUTHZ-01 로 '남의 작업' 을 숨기는데 이 경로로 그 결정을 비켜 갔다. 목록 · 단건 · vCenter 탭이 이 판정 하나를 쓴다.
 *   다른 역할은 바꾸지 않는다(vm.provision 을 가진 계정은 예전처럼 범위 안 저장 작업 전부 — 팀 재사용 기능).
 */
export function savedShownTo(user, e) {
  if (!isDemoGuest(user)) return true;
  const me = String(user?.username || '');
  return !!e && me !== '' && String(e.createdBy || '') === me;
}

export function registerProvision(api) {

// --- VM 프로비저닝 (생성/대량 생성) ---
// Clonable source VMs/templates from the current snapshot. ?vcenterId= scopes to
// one 법인; ?q= prefix-matches the name (A → all VMs/templates starting with A).
api.get('/provision/sources', canProvision, (req, res) => {
  const allowed = scopeOf(req);
  // 요청 vcenterId 가 범위 밖이면 빈 결과(범위 밖 존재 여부도 흘리지 않음).
  if (allowed && req.query.vcenterId && !allowed.has(req.query.vcenterId)) return res.json({ total: 0, sources: [] });
  res.json(listSources(req.query.vcenterId, req.query.q, allowed));
});
// Placement options for one 법인(vCenter): cluster/host/datastore/folder/pool/profile.
api.get('/provision/placement', canProvision, async (req, res) => {
  const allowed = scopeOf(req);
  const vcenterId = req.query.vcenterId;
  // scope 계정은 반드시 범위 내 vCenter 를 명시해야 한다 — 미지정(전체 집계)·범위 밖은 거부해
  // 범위 밖 vCenter 로의 라이브 SOAP 질의(부하·프로빙)와 토폴로지 노출을 막는다.
  if (allowed && (!vcenterId || !allowed.has(vcenterId))) {
    return res.status(403).json({ error: '범위 밖 vCenter 이거나 vCenter 를 지정하지 않았습니다.', clusters: [], hosts: [], datastores: [], folders: [], resourcePools: [], profiles: [] });
  }
  try { res.json(await getPlacement(vcenterId)); }
  catch (e) { res.status(500).json({ error: e.message, clusters: [], hosts: [], datastores: [], folders: [], resourcePools: [], profiles: [] }); }
});
// Dry-run: expand a bulk spec into the concrete per-VM list (name/hostname/ip).
api.post('/provision/preview', canProvision, (req, res) => {
  const { vms, errors } = expandSpec(req.body || {});
  res.json({ ok: errors.length === 0, count: vms.length, vms: vms.slice(0, 500), errors });
});
// Saved provisioning jobs (reusable). ?vcenterId= filters; ?limit=&offset= paginate.
api.get('/provision/saved', canProvision, (req, res) => {
  const user = req.user;
  const include = isDemoGuest(user) ? (e) => savedShownTo(user, e) : null;
  const { excluded, ...out } = listSaved({ vcenterId: req.query.vcenterId, limit: req.query.limit, offset: req.query.offset, allowed: scopeOf(req), include });
  // 데모 판본에서 뺀 것은 밝힌다(조용한 제외 금지) — 뺀 것이 없으면 관리자와 같은 모양.
  res.json({ ...out, ...(excluded > 0 ? { demoOnly: true, demoMasked: { saved: excluded } } : {}) });
});
api.get('/provision/saved/:id', canProvision, (req, res) => {
  const item = getSaved(req.params.id);
  // 75회차(74회차 F9 반증 — 재현): 파일 읽기 오류 중에는 load() 가 빈 목록을 돌려 모든 id 가 '찾을 수 없음'(404)이었다 — 목록(readError)과 같은 사실로 503.
  if (!item) {
    const re = savedReadError();
    if (re) return res.status(503).json({ ok: false, readError: true, reason: `저장된 작업 파일을 읽지 못했습니다(${re.code}) — 파일 권한 · 소유자를 확인하세요.` });
    return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
  }
  // 범위 밖(또는 vCenter 귀속 없는) 저장 작업은 존재를 숨기고 404(403 이 아닌 — 존재 은닉).
  const allowed = scopeOf(req);
  if (allowed && (!item.vcenterId || !allowed.has(item.vcenterId))) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
  if (!savedShownTo(req.user, item)) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });   // 보안 잔여 11-27 L7(반증 2회차 M-1) — 존재 은닉
  res.json(item);
});

// Provisioning jobs (only the caller's own; admins see all).
// v2.632 AX3-02: 범위 계정(범위 관리자 포함)은 자기 범위 vCenter 의 작업만 — 뺀 개수는 밝힌다, 단건은 404 존재 은닉.
api.get('/provision/jobs', (req, res) => {
  const allowed = scopeOf(req);
  const { jobs, omittedOutOfScope } = listJobsScoped(req.user, allowed);
  const storeError = jobsStoreError();   // 반증 후속 ⑥: 작업 기록 파일을 못 읽어 저장을 보류 중이면 표지
  res.json({ jobs, ...(allowed ? { scoped: true, omittedOutOfScope } : {}), ...(storeError ? { storeError } : {}) });
});
api.get('/provision/jobs/:id', (req, res) => {
  const job = getJob(req.params.id, req.user, scopeOf(req));
  if (!job) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  res.json(job);
});
}
