/**
 * 성능점검 '점검 템플릿' 라우트 — routes/svcmon.js(구 1,053줄) 분할(v2.291.0). 본문은 원본 그대로,
 * 등록 순서는 셸(routes/svcmon.js)의 register 호출 순서가 보존한다.
 *
 * 파일명 주의: 이 파일은 **라우트**이고, 템플릿 저장/치환 로직은 svcmon/templates.js(별개 파일)다 —
 * import 경로(../../svcmon/templates.js)로 구분된다. 순서 메모: 이 모듈의 GET /templates/export.csv·
 * sample.csv(2세그먼트 리터럴)와 GET /templates/:id/usage(3세그먼트)는 세그먼트 수가 달라 등록
 * 순서와 무관하게 겹치지 않는다(GET /templates/:id 단건 라우트는 존재하지 않음).
 */

import { logAudit } from '../../audit.js';
import { listTargets } from '../../svcmon/store.js';
import { judgeCapacity } from '../../svcmon/capacity.js';
import { templatesToCsv, sampleTemplatesCsv, parseTemplatesCsv, importTemplates, PREVIEW_NOTICE } from '../../svcmon/templatesCsv.js';
import {
  listTemplates, getTemplate, addTemplate, updateTemplate, duplicateTemplate,
  deleteTemplate, applyTemplate, templateUsage,
  MAX_TEMPLATES, MAX_ITEMS, SUBST_VARS,
} from '../../svcmon/templates.js';
import { canEdit } from './shared.js';

export function registerTemplates(svcmonRouter) {

/* ── 점검 템플릿 ── */

svcmonRouter.get('/templates', (req, res) => {
  const items = listTemplates().map((t) => ({ ...t, usage: templateUsage(t.id) }));
  res.json({ templates: items, limits: { maxTemplates: MAX_TEMPLATES, maxItems: MAX_ITEMS }, substVars: SUBST_VARS });
});

svcmonRouter.post('/templates', canEdit, (req, res) => {
  try {
    const t = addTemplate(req.body || {}, { user: req.user?.username });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.add', target: t.name,
      detail: `항목 ${t.items.length}${t.items.some((x) => x.insecure) ? ' · insecure=true' : ''}`,
    });
    res.status(201).json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.put('/templates/:id', canEdit, (req, res) => {
  try {
    const t = updateTemplate(req.params.id, req.body || {}, { user: req.user?.username });
    if (!t) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.update', target: t.name,
      detail: `항목 ${t.items.length} · rev ${t.rev}${t.items.some((x) => x.insecure) ? ' · insecure=true' : ''}`,
    });
    res.json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

svcmonRouter.post('/templates/:id/duplicate', canEdit, (req, res) => {
  try {
    const t = duplicateTemplate(req.params.id, { user: req.user?.username });
    if (!t) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({ user: req.user?.username, action: 'svcmon.template.add', target: t.name, detail: `복제 ← ${req.params.id}` });
    res.status(201).json({ template: t });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** 삭제 — 이미 적용된 점검은 **남긴다**(태그도 유지). 감시를 끊지 않는 쪽이 안전하다. */
svcmonRouter.delete('/templates/:id', canEdit, (req, res) => {
  try {
    const r = deleteTemplate(req.params.id);
    if (!r.removed) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
    logAudit({
      user: req.user?.username, action: 'svcmon.template.delete', target: req.params.id,
      detail: `남은 점검 ${r.orphanTests} · 대상 ${r.orphanTargets}`,
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/** 템플릿 내보내기 — 항목 1건=1행(대상 CSV 와 같은 규약). item.key 는 싣지 않는다. */
svcmonRouter.get('/templates/export.csv', canEdit, (req, res) => {
  const all = listTemplates();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="svcmon-templates-${new Date().toISOString().slice(0, 10)}.csv"`);
  logAudit({ user: req.user?.username, action: 'svcmon.template.export', detail: `템플릿 ${all.length}개` });
  res.send(templatesToCsv(all));
});

svcmonRouter.get('/templates/sample.csv', canEdit, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="svcmon-templates-sample.csv"');
  res.send(sampleTemplatesCsv());
});

/**
 * 템플릿 가져오기 — 이미 있는 **이름**은 건너뛴다(조용한 덮어쓰기 금지).
 * preview 는 파싱 수준 검증만이다 — 치환 변수·상한 검증은 addTemplate 안에 있어 등록
 * 시점에 실패할 수 있다(그 한계를 응답 notice 로 명시한다. 과장 금지).
 */
svcmonRouter.post('/templates/import', canEdit, (req, res) => {
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv.trim()) return res.status(400).json({ error: 'CSV 내용이 비어 있습니다.' });
  // 내보내기 상한(템플릿 100 × 항목 50 = 5,000행)을 자기 가져오기가 못 받는 비대칭을 없앤다.
  const parsed = parseTemplatesCsv(csv, { maxRows: 5001 });
  const mode = req.body?.mode === 'add' ? 'add' : 'preview';
  const r = importTemplates(parsed, { mode, user: req.user?.username });
  const payload = {
    mode,
    // '파싱 수준 검증만' 안내는 미리보기에만 — 등록 성공 응답에 실으면 화면이 혼란스럽다.
    ...(mode === 'preview' ? { notice: PREVIEW_NOTICE } : {}),
    summary: { rows: parsed.rowCount, create: r.create, skip: r.skip, error: (r.errors || []).length },
    errors: (r.errors || []).slice(0, 200),
    unknownColumns: parsed.unknownColumns,
    results: r.results || [],
  };
  if (mode === 'preview') return res.json(payload);
  if ((r.errors || []).length && !r.create) return res.status(400).json({ ...payload, error: '오류가 있어 등록하지 못했습니다.' });
  logAudit({
    user: req.user?.username, action: 'svcmon.template.import',
    detail: `생성 ${r.create} · 건너뜀 ${r.skip} · 오류 ${(r.errors || []).length}`,
  });
  res.status(201).json(payload);
});

svcmonRouter.get('/templates/:id/usage', canEdit, (req, res) => {
  if (!getTemplate(req.params.id)) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });
  res.json(templateUsage(req.params.id));
});

/** 적용 — `mode:'preview'` 는 저장하지 않는다. 커밋은 all-or-nothing. */
svcmonRouter.post('/templates/:id/apply', canEdit, async (req, res) => {
  const dryRun = req.body?.mode !== 'apply';
  try {
    const r = await applyTemplate(req.params.id, {
      scope: req.body?.scope || {}, overwrite: !!req.body?.overwrite, dryRun,
      user: req.user?.username,
    });
    if (!r) return res.status(404).json({ error: '템플릿을 찾을 수 없습니다.' });

    // 적용 후 규모가 폴러 처리량을 넘는지 — 대량 적용은 CSV 가져오기와 같은 판정을 받는다.
    const cur = [];
    for (const t of listTargets()) { if (t.enabled !== false) for (const x of t.tests) cur.push(x); }
    const capacity = judgeCapacity({ tests: cur, addedTests: [] });
    const payload = {
      mode: dryRun ? 'preview' : 'apply',
      summary: { create: r.create, update: r.update, skip: r.skip, error: r.errorCount, rows: r.tests },
      errors: (r.errors || []).slice(0, 300),
      truncated: { errors: (r.errors || []).length > 300 },
      sample: r.sample || [],
      warnings: r.warnings || [],
      kindMismatch: r.kindMismatch,
      capacity,
      committed: r.committed,
      expectedCount: r.create + r.update,
    };
    if (dryRun) return res.json(payload);
    if (!r.committed) return res.status(400).json({ ...payload, error: `오류 ${r.errorCount}건이 있어 적용하지 않았습니다.` });
    if (r.saved === false) return res.status(500).json({ ...payload, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
    const tpl = getTemplate(req.params.id);
    logAudit({
      user: req.user?.username, action: 'svcmon.template.apply', target: req.params.id,
      detail: `${tpl?.name || ''} rev${tpl?.rev} · 추가 ${r.create} · 갱신 ${r.update} · 건너뜀 ${r.skip}${req.body?.overwrite ? ' · overwrite' : ''}`,
    });
    res.json(payload);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

}
