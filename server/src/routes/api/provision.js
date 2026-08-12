// VM 프로비저닝 조회 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { expandSpec } from '../../provision/spec.js';
import { listSources, listJobs, getJob } from '../../provision/jobs.js';
import { getPlacement } from '../../provision/placement.js';
import { listSaved, getSaved } from '../../provision/saved.js';

export function registerProvision(api) {

// --- VM 프로비저닝 (생성/대량 생성) ---
// Clonable source VMs/templates from the current snapshot. ?vcenterId= scopes to
// one 법인; ?q= prefix-matches the name (A → all VMs/templates starting with A).
api.get('/provision/sources', (req, res) => {
  res.json(listSources(req.query.vcenterId, req.query.q));
});
// Placement options for one 법인(vCenter): cluster/host/datastore/folder/pool/profile.
api.get('/provision/placement', async (req, res) => {
  try { res.json(await getPlacement(req.query.vcenterId)); }
  catch (e) { res.status(500).json({ error: e.message, clusters: [], hosts: [], datastores: [], folders: [], resourcePools: [], profiles: [] }); }
});
// Dry-run: expand a bulk spec into the concrete per-VM list (name/hostname/ip).
api.post('/provision/preview', (req, res) => {
  const { vms, errors } = expandSpec(req.body || {});
  res.json({ ok: errors.length === 0, count: vms.length, vms: vms.slice(0, 500), errors });
});
// Saved provisioning jobs (reusable). ?vcenterId= filters; ?limit=&offset= paginate.
api.get('/provision/saved', (req, res) => {
  res.json(listSaved({ vcenterId: req.query.vcenterId, limit: req.query.limit, offset: req.query.offset }));
});
api.get('/provision/saved/:id', (req, res) => {
  const item = getSaved(req.params.id);
  if (!item) return res.status(404).json({ ok: false, reason: '저장된 작업을 찾을 수 없습니다.' });
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
