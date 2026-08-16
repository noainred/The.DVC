// VM 프로비저닝 조회 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { expandSpec } from '../../provision/spec.js';
import { listSources, listJobs, getJob } from '../../provision/jobs.js';
import { getPlacement } from '../../provision/placement.js';
import { listSaved, getSaved } from '../../provision/saved.js';
import { requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';

// v2.313 보안 감사 반영: 프로비저닝 조회 라우트에 requirePerm('vm.provision') + 사용자 scope
// 교집합을 적용한다(과거 갭 — scope 제한 계정이 범위 밖 전 vCenter VM/템플릿 열거, /placement 로
// 임의 vCenter 라이브 SOAP 유발). scopeOf: null=제한 없음(전체), Set=허용 vCenter id.
const scopeOf = (req) => scopedVcenterIds(req.user, store.get());
const canProvision = requirePerm('vm.provision');

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
  res.json(listSaved({ vcenterId: req.query.vcenterId, limit: req.query.limit, offset: req.query.offset, allowed: scopeOf(req) }));
});
api.get('/provision/saved/:id', canProvision, (req, res) => {
  const item = getSaved(req.params.id);
  if (!item) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
  // 범위 밖(또는 vCenter 귀속 없는) 저장 작업은 존재를 숨기고 404(403 이 아닌 — 존재 은닉).
  const allowed = scopeOf(req);
  if (allowed && (!item.vcenterId || !allowed.has(item.vcenterId))) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
  res.json(item);
});

// Provisioning jobs (only the caller's own; admins see all).
api.get('/provision/jobs', (req, res) => res.json({ jobs: listJobs(req.user) }));
api.get('/provision/jobs/:id', (req, res) => {
  const job = getJob(req.params.id, req.user);
  if (!job) return res.status(404).json({ ok: false, reason: '작업을 찾을 수 없습니다.' });
  res.json(job);
});
}
