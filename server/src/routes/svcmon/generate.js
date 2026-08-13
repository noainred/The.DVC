/**
 * 성능점검 대량 자동등록(이름 규칙 + IP 범위/DNS) + 배치 이력/롤백 — routes/svcmon.js(구 1,053줄)
 * 분할(v2.291.0). 본문은 원본 그대로, 등록 순서는 셸의 register 호출 순서가 보존한다.
 *
 * 배치 이력(/batches)이 이 모듈에 함께 있는 이유: 배치 원장(recordBatch)은 generate 와
 * import(transfer.js) 두 등록 경로가 생성하고, 조회/롤백 UI(BulkTab)가 대량 등록 흐름의
 * 일부라 도메인이 같다.
 */

import dns from 'node:dns';
import { promisify } from 'node:util';
import { logAudit } from '../../audit.js';
import { bulkAddTargets, LIMITS } from '../../svcmon/store.js';
import { getTemplate, materializeForTarget } from '../../svcmon/templates.js';
import { expandGenSpec, expandNames } from '../../svcmon/genspec.js';
import { recordBatch, listBatches, rollbackBatch, deleteBatchRecord } from '../../svcmon/batches.js';
import { canEdit, dryRunTargets } from './shared.js';

const dnsResolve4 = promisify(dns.resolve4);

/* ── 대량 자동등록 ── */

/**
 * 이름 규칙 + IP 범위로 대상을 생성한다. `mode:'preview'` 는 저장하지 않는다.
 * 개수 불일치·IP 파싱 오류·차단 주소는 **전체 거부**한다 — 중간 오류 1건이 그 뒤 전 이름↔IP
 * 매핑을 한 칸 밀어 전 대상이 엉뚱한 주소를 감시하게 된다.
 */
/** 도메인 형식 — genspec 'name' 모드와 같은 규칙(라벨 사이 '.' 만). */
const SAFE_DOMAIN = /^\.[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/;

/** DNS resolve4 를 타임아웃으로 감싼다(느린 1건이 전체 생성을 막지 않게). */
function resolve4Timed(fqdn, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ips: [], err: '시간초과' }); } }, timeoutMs);
    dnsResolve4(fqdn).then((ips) => {
      if (done) return; done = true; clearTimeout(timer); resolve({ ips, err: null });
    }).catch((e) => {
      if (done) return; done = true; clearTimeout(timer); resolve({ ips: [], err: e.code || e.message || '해석 실패' });
    });
  });
}

/**
 * DNS 모드 — 이름 규칙으로 만든 이름들을 지금 DNS(A 레코드)로 해석해 **IP 로 고정**한다.
 * genspec 는 동기 순수 함수라 DNS I/O 를 넣지 않는다(CLAUDE.md). 라우트가 여기서 이름→IP 를
 * 만들어 manual 맵으로 넘기면, SSRF·중복·개수 검증은 genspec manual 모드가 그대로 수행한다.
 *
 * 부분 성공을 인정하지 않는다 — 한 이름이라도 해석되지 않으면 그 대상은 감시 공백이 되는데
 * 화면엔 안 보인다. 미해석 이름을 모아 전체 거부하고 사용자가 DNS 를 고치거나 수동 입력으로
 * 전환하게 한다(genspec 의 '전체 거부' 철학과 동일).
 *
 * @returns {Promise<{ok:boolean, hostMap?:object, resolved?:number, errors:string[]}>}
 */
async function resolveDnsHostMap(spec) {
  const hostSpec = spec?.host && typeof spec.host === 'object' ? spec.host : {};
  const domain = typeof hostSpec.domain === 'string' ? hostSpec.domain.trim() : '';
  const errors = [];
  if (!domain) errors.push("도메인을 입력하세요(예: '.sbp.local') — 이름을 DNS 로 해석하려면 도메인이 필요합니다.");
  else if (!domain.startsWith('.')) errors.push(`도메인은 '.' 으로 시작해야 합니다(예: '.sbp.local'): ${domain.slice(0, 40)}`);
  else if (!SAFE_DOMAIN.test(domain) || domain.length > 253) errors.push(`도메인 형식이 올바르지 않습니다: ${domain.slice(0, 40)}`);

  const { names, errors: nameErrors } = expandNames(spec?.name || {});
  errors.push(...nameErrors);
  if (errors.length) return { ok: false, errors };

  const timeoutMs = 3000;
  const concurrency = 24;
  const hostMap = {};
  const unresolved = [];
  let idx = 0;
  const worker = async () => {
    while (idx < names.length) {
      const i = idx; idx += 1;
      const name = names[i];
      const fqdn = `${name}${domain}`;
      const r = await resolve4Timed(fqdn, timeoutMs);
      if (r.ips.length) hostMap[name] = r.ips.slice().sort()[0];  // 다IP 면 정렬 후 첫 주소로 고정(결정적)
      else unresolved.push(`${fqdn}: ${r.err}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));

  if (unresolved.length) {
    const head = unresolved.slice(0, 5);
    errors.push(`DNS 로 해석되지 않은 호스트 ${unresolved.length}개 — 전체를 거부했습니다(빈 채로 등록하면 그 대상은 감시되지 않습니다): ${head.join(', ')}${unresolved.length > 5 ? ' …' : ''}`);
    return { ok: false, errors };
  }
  return { ok: true, hostMap, resolved: Object.keys(hostMap).length, errors: [] };
}

export function registerGenerate(svcmonRouter) {

svcmonRouter.post('/targets/generate', canEdit, async (req, res) => {
  let spec = req.body?.spec || {};
  const commit = req.body?.mode === 'apply';

  // DNS 모드는 라우트가 이름→IP 로 해석해 manual 로 변환한다(genspec 는 동기 유지).
  if (spec?.host && typeof spec.host === 'object' && String(spec.host.mode || '').toLowerCase() === 'dns') {
    const dns = await resolveDnsHostMap(spec);
    if (!dns.ok) {
      return res.status(400).json({
        summary: { rows: 0, create: 0, skip: 0, error: dns.errors.length },
        errors: dns.errors.map((reason) => ({ row: 0, name: '', reason })),
        blocked: [], warnings: [], limits: LIMITS,
        error: dns.errors[0] || 'DNS 해석에 실패했습니다.',
      });
    }
    spec = { ...spec, host: { mode: 'manual', hostMap: dns.hostMap } };
  }
  const tplId = typeof spec.templateId === 'string' ? spec.templateId.trim() : '';
  let tpl = null;
  if (tplId) {
    tpl = getTemplate(tplId);
    if (!tpl) return res.status(400).json({ error: `템플릿을 찾을 수 없습니다: ${tplId}` });
  }

  // 템플릿 항목을 대상별로 실체화(치환 → 정제)한다. genspec 은 templates 를 import 하지 않고
  // 이 콜백만 호출한다 — 순환 의존을 피하고 치환 책임을 한 곳(templates.js)에 둔다.
  // 미치환 변수가 남거나 치환 결과가 SSRF 가드에 걸리면 여기서 throw 되어 그 행이 오류가 된다.
  const genErrors = [];
  const materialize = tpl
    ? (target) => {
      const r = materializeForTarget(tplId, target);
      if (r.errors.length) genErrors.push(...r.errors.map((e) => `${target.name}: ${e}`));
      return r.tests;
    }
    : null;

  const ex = expandGenSpec(spec, materialize ? { materialize } : {});
  if (genErrors.length) ex.errors.push(...genErrors);
  if (ex.errors.length || ex.blocked.length) {
    return res.status(400).json({
      summary: { rows: ex.stats?.names || 0, create: 0, skip: 0, error: ex.errors.length },
      errors: ex.errors.map((reason) => ({ row: 0, name: '', reason })),
      blocked: ex.blocked, warnings: ex.warnings, stats: ex.stats, suggest: ex.suggest,
      limits: LIMITS,
      error: ex.errors[0] || `차단된 주소 ${ex.blocked.length}개가 있어 생성하지 않았습니다.`,
    });
  }

  const dry = dryRunTargets(ex.rows);
  const errors = dry.errors;
  const payload = {
    mode: commit ? 'apply' : 'preview',
    summary: { rows: ex.rows.length, create: dry.create, skip: dry.skip, error: errors.length, newFolders: dry.newFolders, newTests: dry.newTests },
    errors: errors.slice(0, 300),
    truncated: { errors: errors.length > 300 },
    warnings: ex.warnings, stats: ex.stats, blocked: [],
    sample: dry.sample, after: dry.after, limits: LIMITS, capacity: dry.capacity,
    expectedCount: dry.create,
  };
  if (!commit) return res.json(payload);

  if (errors.length) return res.status(400).json({ ...payload, error: `오류 ${errors.length}건이 있어 등록하지 않았습니다.` });
  if (dry.capacity.verdict === 'reject') return res.status(400).json({ ...payload, error: dry.capacity.reasons[0] });
  if (typeof req.body?.expectedCount === 'number' && req.body.expectedCount !== dry.create) {
    return res.status(409).json({ ...payload, error: '미리보기 이후 목록이 바뀌었습니다. 미리보기를 다시 확인하세요.' });
  }
  const batch = 'b-' + Math.random().toString(36).slice(2, 10);
  const r = bulkAddTargets(ex.rows, { batch });
  if (!r.committed) return res.status(400).json({ ...payload, ...r, error: '검증에 실패해 등록하지 않았습니다.' });
  if (!r.saved) return res.status(500).json({ ...payload, ...r, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
  recordBatch({
    id: batch, createdBy: req.user?.username || '', source: 'generate',
    kind: spec.kind || 'infra', path: spec.path || '', targets: r.added, tests: r.newTests, templateId: tplId,
  });
  logAudit({
    user: req.user?.username, action: 'svcmon.target.generate',
    detail: `batch=${batch} · 대상 ${r.added} · 점검 ${r.newTests}${tplId ? ` · ${tplId}` : ''} · 필요 ${dry.capacity.requiredPerSec}/s`,
  });
  res.status(201).json({ ...payload, ...r, batch });
});

/* ── 배치 이력 / 롤백 ── */

svcmonRouter.get('/batches', canEdit, (req, res) => res.json({ batches: listBatches() }));

svcmonRouter.post('/batches/:id/rollback', canEdit, (req, res) => {
  const r = rollbackBatch(req.params.id, {
    expectedCount: typeof req.body?.expectedCount === 'number' ? req.body.expectedCount : null,
    user: req.user?.username,
  });
  if (r.error) return res.status(400).json(r);
  logAudit({
    user: req.user?.username, action: 'svcmon.target.batch.delete', target: req.params.id,
    detail: `대상 ${r.removed} · 점검 ${r.tests}`,
  });
  res.json({ ...r, batches: listBatches() });
});

svcmonRouter.delete('/batches/:id', canEdit, (req, res) => {
  if (!deleteBatchRecord(req.params.id)) return res.status(404).json({ error: '배치 기록을 찾을 수 없습니다.' });
  logAudit({ user: req.user?.username, action: 'svcmon.batch.record.delete', target: req.params.id, detail: '이력만 삭제(대상 유지)' });
  res.json({ ok: true, batches: listBatches() });
});

}
