// Horizon 등록·svcmon 할당 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import { config } from '../../config.js';
import { listHorizon as listHorizonServers, upsertHorizon, removeHorizon, testHorizon, horizonInputIssue } from '../../horizon/horizon.js';
import * as hzBulk from '../../horizon/bulk.js';                     // v2.525: CSV/자유텍스트 대량 등록
import { enrichAdvice, selectRows } from '../../util/bulkImport.js';
import { startBulkTest, publicRun, passedLines } from '../../util/bulkRun.js';
import { logAudit } from '../../audit.js';
import { listCollectors } from '../../collector/registry.js';
import { listAssignments, addAssignment, updateAssignment, removeAssignment, getResults, parseCsv as parseAssignmentsCsv, importAssignments, mergeKnownAgents } from '../../central/assignments.js';
import { adminOnly, fullScopeOnlyWith } from './shared.js';
// v2.611 AUTHZ2611: 전 법인 등록부·동작은 전체 범위 계정만(v2.607 fleetWideOnly 의 형제 등록부).
const fleetOnly = fullScopeOnlyWith('Horizon 연결 서버·엣지 스캔 배정은 vCenter(법인) 축이 없는 전 법인 등록부라 전체 범위(vCenter 제한 없는) 계정만 조회·변경할 수 있습니다.');

export function registerHorizonAssign(adminRouter) {

// ---- Horizon Connection Server (라이선스 만료일 확인용 등록) ---------------
adminRouter.get('/horizon', adminOnly, fleetOnly, (_req, res) => res.json({ servers: listHorizonServers() }));
adminRouter.post('/horizon', adminOnly, fleetOnly, (req, res) => {
  const r = upsertHorizon(req.body || {});
  if (r.ok) logAudit({ user: req.user?.username, action: 'Horizon 서버 등록/수정', target: String(req.body?.id || ''), ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.delete('/horizon/:id', adminOnly, fleetOnly, (req, res) => {
  const r = removeHorizon(req.params.id);
  if (r.ok) logAudit({ user: req.user?.username, action: 'Horizon 서버 삭제', target: req.params.id, ip: req.ip || '' });
  res.status(r.ok ? 200 : 400).json(r);
});
adminRouter.post('/horizon/test', adminOnly, fleetOnly, async (req, res) => res.json(await testHorizon(req.body || {})));

/* ══════════════════ Horizon 서버 대량 등록(CSV·자유텍스트, v2.525) ══════════════════
 * 사용자 요청(2026-09-16): "호라이즌 서비스에 호라이즌 서버 등록이 필요하면 csv/text
 * import/export 기능 추가해줘".
 *
 * ⚠ 스토리지·SAN 스위치와 **같은 코어·같은 화면 컴포넌트**를 쓴다(`util/bulkImport.js` +
 *   웹 `views/tools/BulkDeviceIo.jsx`). 복제하면 판정이 갈라진다(v2.513 규약).
 * ⚠ 식별 키는 **`id` 단독**이다(`upsertHorizon` 이 id 로 찾는다) — `horizon/bulk.js` 머리말 참조.
 * ⚠ 경로 조각이 `servers` 인 이유: 이 도구의 대상은 장비가 아니라 Connection Server 다.
 *   웹 컴포넌트는 `resource` prop 으로 이 조각을 받는다(경로를 두 벌 만들지 않기 위해).
 *
 * 흐름(화면과 1:1): ① import {dryRun:true} → ② import/test → ③ import {selectLines[,testRunId]}
 * 전부 adminOnly. 내보내기·샘플에 **비밀번호는 담기지 않는다**.
 */

/** 입력 본문 → 파싱 결과 + 형식 구분. `text` 가 있으면 자유텍스트, 아니면 CSV. */
function hzParseBody(body = {}) {
  const raw = String(body.text ?? body.csv ?? '');
  const format = body.format === 'text' || (body.text != null && body.csv == null) ? 'text' : 'csv';
  if (format === 'text') {
    const r = hzBulk.parseServersText(raw, { defaults: body.defaults || {} });
    return { ...r, format, raw };
  }
  const r = hzBulk.parseServersCsv(raw);
  return { ...r, warnings: [], headerUsed: null, order: r.order || hzBulk.COLUMNS, format, raw };
}

const hzExistingMap = () => new Map(listHorizonServers().map((s) => [String(s.id).trim().toLowerCase(), s]));

adminRouter.get('/horizon/servers/export.csv', adminOnly, fleetOnly, (req, res) => {
  const servers = listHorizonServers();
  logAudit({ user: req.user?.username, action: 'Horizon 서버 CSV 내보내기', detail: `${servers.length}대`, ip: req.ip || '' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="horizon-servers.csv"');
  res.send(hzBulk.serversToCsv(servers));
});

adminRouter.get('/horizon/servers/export.txt', adminOnly, fleetOnly, (req, res) => {
  const servers = listHorizonServers();
  logAudit({ user: req.user?.username, action: 'Horizon 서버 자유텍스트 내보내기', detail: `${servers.length}대`, ip: req.ip || '' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="horizon-servers.txt"');
  res.send(hzBulk.serversToText(servers));
});

adminRouter.get('/horizon/servers/sample.csv', adminOnly, fleetOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="horizon-servers-sample.csv"');
  res.send(hzBulk.sampleCsv());
});

adminRouter.get('/horizon/servers/sample.txt', adminOnly, fleetOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="horizon-servers-sample.txt"');
  res.send(hzBulk.sampleText());
});

/**
 * ② 실제 연결 테스트 — 저장 **전에** 행마다 Horizon 로그인을 시도한다.
 * ⚠ 자동 재시도 없음(잘못된 비밀번호 반복 = AD 계정 잠금). `bulkRun` 이 강제한다.
 */
adminRouter.post('/horizon/servers/import/test', adminOnly, fleetOnly, (req, res) => {
  const p = hzParseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });
  const existing = hzExistingMap();
  // 형식 오류 행은 테스트하지 않는다(로그인 시도가 무의미하고 계정 잠금 위험만 만든다).
  const { report } = hzBulk.analyzeImport(p.rows, {
    existingId: (id) => existing.get(String(id).trim().toLowerCase()),
    validate: horizonInputIssue,
  });
  const okLines = new Set(report.filter((r) => r.action !== 'error').map((r) => r.line));
  const targets = p.rows.filter((r) => okLines.has(r._line));
  if (!targets.length) return res.status(400).json({ ok: false, reason: '형식 검증을 통과한 행이 없습니다 — 먼저 오류를 고치세요.' });

  const started = startBulkTest({
    kind: 'horizon', rows: targets, user: req.user?.username || '',
    testOne: async (row) => {
      // 비밀번호를 비운 행은 `testHorizon` 이 저장값을 쓰고 **host 도 저장값으로 고정**한다
      // (v2.480 감사 S6 — body.host 만 바꿔 평문 비밀번호를 받아 가는 경로 차단). 그래서
      // 접속처를 바꾼 행은 비밀번호를 적어야 하고, 안 적으면 위 검증이 먼저 거른다.
      const r = await testHorizon({ ...hzBulk.toSaveInput(row) });
      return r?.ok
        ? { ok: true, detail: { summary: r.licenses != null ? `로그인 성공 · 라이선스 ${r.licenses}건` : '로그인 성공' } }
        : { ok: false, reason: r?.reason || '로그인 실패', detail: { hint: r?.hint } };
    },
  });
  if (!started.ok) return res.status(409).json(started);
  logAudit({ user: req.user?.username, action: 'Horizon 서버 대량 연결 테스트', detail: `${targets.length}대 시도(형식 오류 ${p.rows.length - targets.length}건 제외)`, ip: req.ip || '' });
  res.json({ ok: true, id: started.id, total: targets.length });
});

/** 연결 테스트 진행률·결과(폴링). 자격증명은 응답에 없다(`bulkRun publicRun`). */
adminRouter.get('/horizon/servers/import/test/:id', adminOnly, fleetOnly, (req, res) => {
  const run = publicRun(req.params.id);
  if (!run || run.kind !== 'horizon') return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다).' });
  res.json({ ok: true, ...run });
});

/**
 * ①/③ 가져오기 — `dryRun:true` 면 검증만, 아니면 저장.
 * 걸러낸 행은 버리지 않고 `skipped` 로 사유와 함께 돌려준다.
 */
adminRouter.post('/horizon/servers/import', adminOnly, fleetOnly, (req, res) => {
  const p = hzParseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });

  const existing = hzExistingMap();
  const base = hzBulk.analyzeImport(p.rows, {
    existingId: (id) => existing.get(String(id).trim().toLowerCase()),
    validate: horizonInputIssue,
  });
  const { report, hints } = enrichAdvice(base.report, p.rows, {
    text: p.raw, order: p.order, format: p.format, fields: hzBulk.COLUMNS, ctx: {},
    hostForm: 'url',   // Horizon 의 host 는 `https://커넥션서버` 가 필수다 — 기본(IP/호스트명) 조언은 틀린 조언이 된다

  });

  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary: base.summary, hints,
      warnings: p.warnings, headerUsed: p.headerUsed, format: p.format, total: p.rows.length });
  }

  const tested = req.body?.testRunId ? passedLines(req.body.testRunId) : null;
  if (req.body?.testRunId && tested == null) {
    return res.status(400).json({ ok: false, reason: '연결 테스트 결과를 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다) — 다시 테스트하세요.' });
  }
  const { picked, skipped } = selectRows(p.rows, report, {
    lines: Array.isArray(req.body?.selectLines) ? req.body.selectLines : null,
    requireTested: tested,
  });

  let added = 0; let updated = 0; const failed = [];
  const droppedSecretRows = [];
  for (const row of picked) {
    const prev = existing.get(String(row.id).trim().toLowerCase());
    const r = upsertHorizon(hzBulk.toSaveInput(row));
    if (!r.ok) { failed.push({ line: row._line, name: row.name || row.id, reason: r.reason }); continue; }
    if (prev) updated++; else added++;
    // 접속처가 바뀌어 저장 비밀이 폐기된 행은 **조용히 넘기지 않는다**(다음 수집이 실패한다).
    if (r.droppedSecrets?.length) droppedSecretRows.push({ line: row._line, name: row.name || row.id, reason: '접속처(host·계정·도메인)가 바뀌어 저장된 비밀번호를 폐기했습니다 — 비밀번호를 다시 등록하세요.' });
  }
  logAudit({ user: req.user?.username, action: `Horizon 서버 대량 가져오기(${p.format === 'text' ? '자유텍스트' : 'CSV'})`,
    detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}·제외 ${skipped.length}${tested ? ' (연결 통과분만)' : ''}`, ip: req.ip || '' });
  res.json({ ok: true, added, updated, failed, skipped: [...skipped, ...droppedSecretRows], total: p.rows.length, format: p.format });
});

// ---- Agent scan assignments (central orchestration) -----------------------

// List per-agent IP assignments (credentials redacted) + each agent's last
// reported scan result.
adminRouter.get('/assignments', adminOnly, fleetOnly, (_req, res) => {
  // knownAgents: 폼에서 '에이전트 이름'을 직접 타이핑하지 않고 목록에서 고르게 한다(AGENT_NAME
  // 오타로 인한 잡 인출 불일치 방지). 출처 = 등록된 수집 서버(원격, 실제 AGENT_NAME) + 중앙에
  // 한 번이라도 보고한 에이전트 + 기존 할당. mergeKnownAgents가 대소문자 무시 중복 제거.
  const knownAgents = mergeKnownAgents({ assignments: listAssignments(), results: getResults(), collectors: listCollectors() });
  res.json({ assignments: listAssignments(), results: getResults(), knownAgents, centralEnabled: Boolean(config.central.token) });
});

adminRouter.post('/assignments', adminOnly, fleetOnly, (req, res) => {
  const result = addAssignment(req.body || {});
  res.status(result.ok ? 201 : 400).json(result);
});

adminRouter.put('/assignments/:agent', adminOnly, fleetOnly, (req, res) => {
  const result = updateAssignment(req.params.agent, req.body || {});
  res.status(result.ok ? 200 : 400).json(result);
});

adminRouter.delete('/assignments/:agent', adminOnly, fleetOnly, (req, res) => {
  const result = removeAssignment(req.params.agent);
  res.status(result.ok ? 200 : 404).json(result);
});

// Import assignments from CSV text or a JSON array. Body:
//   { csv:"...", mode? } | { assignments:[...], mode? } | bare array
adminRouter.post('/assignments/import', adminOnly, fleetOnly, (req, res) => {
  const b = req.body || {};
  let list;
  if (typeof b.csv === 'string') list = parseAssignmentsCsv(b.csv);
  else list = Array.isArray(b) ? b : b.assignments;
  const result = importAssignments(list, b.mode === 'replace' ? 'replace' : 'merge');
  res.status(result.ok ? 200 : 400).json(result);
});
}
