/**
 * 성능점검 가져오기/내보내기(CSV·json·xlsx) + 수동 IP 매핑(hostmap) — routes/svcmon.js(구 1,053줄)
 * 분할(v2.291.0). 본문은 원본 그대로, 등록 순서는 셸의 register 호출 순서가 보존한다.
 *
 * ⚠️⚠️ 라우트 등록 순서 불변조건(이 라우터에서 유일하게 순서가 의미 있는 쌍):
 * GET /targets/export.csv 는 GET /targets/export.:format 패턴에도 매칭된다(format='csv').
 * 반드시 export.csv 를 **먼저** 등록해야 한다 — 순서가 뒤집히면 :format 핸들러가 csv 요청을
 * 404 처리해(아래 분기) CSV 내보내기가 죽는데 서버 기동은 정상이라 **무음 회귀**다.
 * 두 라우트를 다른 모듈로 찢지 말 것. 회귀 테스트: server/test/svcmonRouteOrder.test.js
 * (정적 순서 + 실제 mount 후 200/CSV 응답 확인).
 *
 * 원본 import 중 parseTargetsCsv(csvio)는 사용처가 없어(파싱은 parseTargetsAny 로 일원화됨)
 * 이관하지 않았다 — 기능 변화 아님(미사용 import 제거).
 */

import { logAudit } from '../../audit.js';
import { listTargetsCopy, bulkAddTargets, TEST_TYPES, KINDS, LIMITS } from '../../svcmon/store.js';
import { TARGET_FIELDS, TEST_FIELDS, CSV_COLUMNS } from '../../svcmon/testSchema.js';
import { csvLines, sampleCsv, REQUIRED_COLUMNS } from '../../svcmon/csvio.js';
import {
  FORMATS, FORMAT_META, serializeTargets, parseTargetsAny,
  hostMapTemplateCsv, hostMapToCsv, parseHostMapAny,
} from '../../svcmon/formats.js';
import { getTemplate, materializeForTarget } from '../../svcmon/templates.js';
import { recordBatch } from '../../svcmon/batches.js';
import { canEdit, XLSX_MAX_BYTES, dryRunTargets } from './shared.js';

export function registerTransfer(svcmonRouter) {

/* ── CSV 가져오기 / 내보내기 ── */

/** 내보내기 — 청크 스트리밍. `res.json` 을 쓰면 압축 래퍼의 SHA-1 ETag 계산이 동기로 걸린다. */
svcmonRouter.get('/targets/export.csv', canEdit, (req, res) => {
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const withTests = req.query.tests !== '0';
  const all = listTargetsCopy().filter((t) => {
    if (kind && (t.kind || 'infra') !== kind) return false;
    if (scope && !(t.path === scope || t.path.startsWith(`${scope}\\`))) return false;
    return true;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="svcmon-targets-${stamp}.csv"`);
  let tests = 0;
  for (const t of all) tests += (t.tests || []).length;
  logAudit({
    user: req.user?.username,
    action: 'svcmon.target.export',
    detail: `대상 ${all.length} · 점검 ${withTests ? tests : 0} · 열 ${CSV_COLUMNS.length}${scope ? ` · 경로 ${scope}` : ''}`,
  });
  // 줄을 모아 8,000줄마다 write — 한 문자열로 join 하면 30MB 규모에서 그 자체가 블로킹이다.
  let buf = [];
  for (const line of csvLines(all, { includeTests: withTests })) {
    buf.push(line);
    if (buf.length >= 8000) { res.write(buf.join('\r\n') + '\r\n'); buf = []; }
  }
  if (buf.length) res.write(buf.join('\r\n') + '\r\n');
  res.end();
});

/** 샘플 CSV — 스키마에서 생성한다(하드코딩 상수면 컬럼 추가한 날 샘플만 낡는다). */
/**
 * 대상 내보내기 — 다중 포맷(json·xlsx). CSV 는 위 스트리밍 라우트가 담당(대용량 청크).
 * json/xlsx 는 전량을 메모리에 만들되 1회 요청 상한(대상 20,000) 규모에서 수 MB 수준이다.
 * ⚠️ 이 라우트는 반드시 export.csv **뒤에** 등록돼야 한다(파일 헤더의 순서 불변조건).
 */
svcmonRouter.get('/targets/export.:format', canEdit, async (req, res) => {
  const format = FORMATS.includes(req.params.format) ? req.params.format : null;
  if (!format || format === 'csv') return res.status(404).json({ error: 'csv 는 /targets/export.csv 를 쓰세요.' });
  const kind = KINDS.includes(req.query.kind) ? req.query.kind : null;
  const scope = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  const withTests = req.query.tests !== '0';
  const all = listTargetsCopy().filter((t) => {
    if (kind && (t.kind || 'infra') !== kind) return false;
    if (scope && !(t.path === scope || t.path.startsWith(`${scope}\\`))) return false;
    return true;
  });
  try {
    const body = await serializeTargets(all, format, { includeTests: withTests });
    const meta = FORMAT_META[format];
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Disposition', `attachment; filename="svcmon-targets-${stamp}.${meta.ext}"`);
    logAudit({ user: req.user?.username, action: 'svcmon.target.export', detail: `대상 ${all.length} · ${format}${scope ? ` · 경로 ${scope}` : ''}` });
    res.send(Buffer.isBuffer(body) ? body : Buffer.from(body));
  } catch (e) { res.status(500).json({ error: `내보내기 실패: ${e.message}` }); }
});

svcmonRouter.get('/targets/sample.csv', canEdit, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="svcmon-sample.csv"');
  res.send(sampleCsv());
});

/* ── 수동 IP 매핑(이름↔IP) 템플릿·가져오기·내보내기 ── */

/** 수동 매핑 CSV 템플릿 다운로드. `?names=a,b,c` 를 주면 그 이름들을 미리 채워 IP 만 적게 한다. */
svcmonRouter.get('/targets/hostmap-template.csv', canEdit, (req, res) => {
  const raw = typeof req.query.names === 'string' ? req.query.names : '';
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, LIMITS.maxBulkRows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="svcmon-hostmap-template.csv"');
  res.send(hostMapTemplateCsv(names));
});

/** 수동 매핑 파일(csv/json/xlsx) → `{pairs:[{name,ip}], rowCount, errors}`(화면 표 채우기용). */
svcmonRouter.post('/targets/hostmap/parse', canEdit, async (req, res) => {
  const format = FORMATS.includes(req.body?.format) ? req.body.format : 'csv';
  const rawContent = typeof req.body?.content === 'string' ? req.body.content
    : (typeof req.body?.csv === 'string' ? req.body.csv : '');
  if (!rawContent.trim()) return res.status(400).json({ error: '내용이 비어 있습니다.' });
  let input = rawContent;
  if (format === 'xlsx') {
    try { input = Buffer.from(rawContent, 'base64'); } catch { return res.status(400).json({ error: 'XLSX(base64) 디코딩 실패.' }); }
    if (input.length > XLSX_MAX_BYTES) return res.status(413).json({ error: `XLSX 파일이 너무 큽니다(${Math.round(input.length / 1e6)}MB > ${XLSX_MAX_BYTES / 1e6}MB). 나눠 올리세요.` });
  }
  try {
    const r = await parseHostMapAny(input, format);
    if (r.pairs.length > LIMITS.maxBulkRows) {
      return res.status(400).json({ error: `한 번에 최대 ${LIMITS.maxBulkRows}개까지 가져올 수 있습니다(파싱 ${r.pairs.length}개).` });
    }
    res.json({ pairs: r.pairs.slice(0, LIMITS.maxBulkRows), rowCount: r.rowCount, errors: r.errors || [] });
  } catch (e) { res.status(400).json({ error: `파싱 실패: ${e.message}` }); }
});

/** 현재 매핑 표를 CSV 로 내보내기(수식 인젝션 가드는 hostMapToCsv 가 적용). */
svcmonRouter.post('/targets/hostmap/export.csv', canEdit, (req, res) => {
  const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs.slice(0, LIMITS.maxBulkRows) : [];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="svcmon-hostmap.csv"');
  res.send(hostMapToCsv(pairs.map((p) => ({ name: String(p?.name ?? ''), ip: String(p?.ip ?? '') }))));
});

/** 컬럼 설명 — 화면이 표를 그릴 때 쓴다(스키마와 화면이 어긋나지 않게). */
svcmonRouter.get('/targets/csv-schema', canEdit, (req, res) => {
  const of = (f) => ({
    col: f.col, label: f.label, kind: f.kind, max: f.max, min: f.min,
    dflt: f.dflt, requiredFor: f.requiredFor, usedBy: f.usedBy,
    required: REQUIRED_COLUMNS.includes(f.col),
  });
  res.json({
    columns: CSV_COLUMNS,
    target: TARGET_FIELDS.map(of),
    test: TEST_FIELDS.map(of),
    required: REQUIRED_COLUMNS,
    types: TEST_TYPES,
    kinds: KINDS,
    limits: LIMITS,
  });
});

/**
 * 가져오기 — `mode:'preview'` 는 저장하지 않고 판정만, `'add'` 는 커밋한다.
 * 커밋은 all-or-nothing 이며 이미 있는 대상(구분+경로+이름)은 건너뛴다.
 */
svcmonRouter.post('/targets/import', canEdit, async (req, res) => {
  const mode = req.body?.mode === 'add' ? 'add' : 'preview';
  // 포맷 결정: format 이 명시되면 그것을, 없고 csv 필드만 오면 csv(구버전 호환).
  const format = FORMATS.includes(req.body?.format) ? req.body.format : 'csv';
  // content = csv/json 은 텍스트, xlsx 는 base64. 구버전은 csv 필드로 텍스트를 보냈다.
  const rawContent = typeof req.body?.content === 'string' ? req.body.content
    : (typeof req.body?.csv === 'string' ? req.body.csv : '');
  if (!rawContent.trim()) return res.status(400).json({ error: `${format.toUpperCase()} 내용이 비어 있습니다.` });
  let input;
  if (format === 'xlsx') {
    try { input = Buffer.from(rawContent, 'base64'); }
    catch { return res.status(400).json({ error: 'XLSX(base64) 디코딩에 실패했습니다.' }); }
    if (!input.length) return res.status(400).json({ error: 'XLSX 내용이 비어 있습니다.' });
    // 압축폭탄(decompression bomb) 완화 — 디코딩 크기 상한. 정상 2,000행 xlsx 는 1MB 미만이므로
    // 8MB 상한은 여유 있고, 고압축 폭탄의 입력 크기를 제한해 exceljs 로드 시 팽창을 억제한다.
    if (input.length > XLSX_MAX_BYTES) return res.status(413).json({ error: `XLSX 파일이 너무 큽니다(${Math.round(input.length / 1e6)}MB > ${XLSX_MAX_BYTES / 1e6}MB). 나눠 올리세요.` });
  } else {
    input = rawContent;
  }

  let parsed;
  try { parsed = await parseTargetsAny(input, format, { maxRows: LIMITS.maxBulkRows }); }
  catch (e) { return res.status(400).json({ error: `${format.toUpperCase()} 파싱 실패: ${e.message}` }); }
  if (parsed.targets.length > LIMITS.maxBulkRows) {
    return res.status(400).json({ error: `한 번에 최대 ${LIMITS.maxBulkRows}개 대상까지 가져올 수 있습니다(파싱 ${parsed.targets.length}개).` });
  }
  // 대량 자동등록(줄별 {엣지·호스트명·IP}) 경로: templateId 가 오면 각 대상에 그 템플릿의 점검을
  // 서버에서 실체화(치환·정제)해 붙인다. /targets/generate 와 같은 materializeForTarget 을 재사용해
  // 치환/정제/오류 판정을 한 곳(templates.js)에 둔다. 미치환 변수·SSRF 위반은 그 대상의 오류가 된다.
  const tplId = typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : '';
  if (tplId) {
    if (!getTemplate(tplId)) return res.status(400).json({ error: `템플릿을 찾을 수 없습니다: ${tplId}` });
    parsed.targets.forEach((t, idx) => {
      const r = materializeForTarget(tplId, t);
      for (const e of r.errors) parsed.errors.push({ row: idx + 1, name: t.name || '', reason: e });
      t.tests = [...(t.tests || []), ...r.tests];
    });
  }
  const dry = dryRunTargets(parsed.targets);
  const errors = [...parsed.errors, ...dry.errors];
  const summary = {
    rows: parsed.rowCount,
    create: dry.create,
    skip: dry.skip,
    error: errors.length,
    newFolders: dry.newFolders,
    newTests: dry.newTests,
  };
  const payload = {
    mode, summary, errors: errors.slice(0, 300),
    truncated: { errors: errors.length > 300 },
    unknownColumns: parsed.unknownColumns,
    sample: dry.sample,
    after: dry.after,
    limits: LIMITS,
    capacity: dry.capacity,
    expectedCount: dry.create,
  };
  if (mode === 'preview') return res.json(payload);

  if (errors.length) return res.status(400).json({ ...payload, error: `오류 ${errors.length}건이 있어 등록하지 않았습니다(전부 성공 또는 전부 취소).` });
  if (dry.capacity.verdict === 'reject') {
    return res.status(400).json({ ...payload, error: dry.capacity.reasons[0] });
  }
  if (typeof req.body?.expectedCount === 'number' && req.body.expectedCount !== dry.create) {
    return res.status(409).json({ ...payload, error: '미리보기 이후 목록이 바뀌었습니다. 미리보기를 다시 확인하세요.' });
  }
  const batch = 'b-' + Math.random().toString(36).slice(2, 10);
  const r = bulkAddTargets(parsed.targets, { batch });
  if (!r.committed) return res.status(400).json({ ...payload, ...r, error: '검증에 실패해 등록하지 않았습니다.' });
  if (!r.saved) return res.status(500).json({ ...payload, ...r, error: '파일 저장에 실패했습니다(디스크·권한 확인).' });
  // ⚠ 회귀 방지(v2.287, 확정 버그 #19): generate 와 달리 import add 는 recordBatch 를 호출하지 않아
  // 배치 원장에 안 남았고, BulkTab 의 '등록 이력'·되돌리기 UI 가 원장 기반이라 가져오기로 등록한
  // 건은 이력/롤백이 전혀 안 됐다(현재 UI 의 모든 등록이 /targets/import 경로). generate 와 동일하게 기록.
  recordBatch({
    id: batch, createdBy: req.user?.username || '', source: 'import',
    kind: (parsed.targets[0]?.kind) || 'infra', path: (parsed.targets[0]?.path) || '', targets: r.added, tests: r.newTests, templateId: tplId,
  });
  logAudit({
    user: req.user?.username,
    action: 'svcmon.target.import',
    detail: `batch=${batch} · 추가 ${r.added} · 건너뜀 ${r.skipped.length} · 점검 ${r.newTests} · 신규폴더 ${r.newFolders}`,
  });
  res.status(201).json({ ...payload, ...r, batch });
});

}
