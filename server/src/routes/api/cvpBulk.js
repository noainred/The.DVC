/**
 * CVP 서버 **대량 등록(CSV·자유텍스트)** 라우트(v2.641) — 특수기능 'CVP 네트워크 스위치'(도구 키 `cvp`).
 *
 * 사용자 요청(2026-09-28): "CVP 를 CSV import/export 하는 기능 추가해줘 CVP 가 많아" → "비밀번호도 export 에
 * 추가해줘" → "토큰도 포함".
 *
 * ⚠ 스토리지·SAN 스위치·Horizon 과 **같은 코어·같은 화면 컴포넌트**를 쓴다(`util/bulkImport.js` + 웹
 *   `views/tools/BulkDeviceIo.jsx`). 판정·저장 입력은 `cvp/bulk.js prepareRow` 하나다(드라이런 통과 = 저장 성공).
 *
 * ⚠ 경로가 `/tools/cvp/bulk/servers/…` 인 이유: 기존 `POST /tools/cvp/servers/:id/test` 가 먼저 등록돼 있어
 *   `/tools/cvp/servers/import/test` 로 두면 `:id='import'` 로 **그 라우트에 먹힌다**(등록 순서 의존). 경로를 분리해
 *   순서와 무관하게 만든다. 웹 모달은 base='/tools/cvp/bulk', resource='servers' 로 부른다.
 *
 * 접근(routes/api/cvp.js 등록부 라우트와 같다): adminOnly + tools + 전체 범위. 비밀 포함 내보내기(`?secrets=1`)는
 * 거기에 **설정 소유자**(requireSettingsOwner)를 더하고 감사로그에 '비밀번호·토큰 포함' 을 남긴다(값은 남기지 않는다) —
 * routes/admin/idracScan.js export.csv · routes/api/bmstor.js export.csv 선례.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith, requireSettingsOwner } from '../admin/shared.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listDatacenters } from '../../datacenter/store.js';
import { listServers, getServerWithSecret, saveServer } from '../../cvp/registry.js';
import { testServerConnection } from '../../cvp/poller.js';
import * as cvpBulk from '../../cvp/bulk.js';
import { enrichAdvice, selectRows } from '../../util/bulkImport.js';
import { startBulkTest, publicRun, passedLines } from '../../util/bulkRun.js';
import { capStr } from '../../util/capStr.js';
import { fileStamp } from '../../util/dayKey.js';
// v2.643: CSV·텍스트 가져오기/내보내기는 관리자 이상 + 'data.csv' 권한(super_admin 항상, admin 은 권한 설정에서 끌 수 있다).
const csvPerm = requirePerm('data.csv');

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('CVP 네트워크 스위치는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const BASE = '/tools/cvp/bulk/servers';
const TEST_TIMEOUT_MS = 55_000;   // bulkRun 장비당 시한(60초)보다 작게 — testServerConnection 이 스스로 세션을 끊는다(v2.417)

/** DataCenter 목록 — 폼 드롭다운·저장 검증과 같은 목록(routes/api/cvp.js dcList 와 같은 모양). */
function dcList() {
  try { return listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { return []; }
}

/** 등록부 원본(비밀 포함) — 판정(serverInputIssue 의 prev)·비밀 포함 내보내기 전용. 응답에 싣지 말 것. */
function rawServers() {
  return listServers().map((s) => getServerWithSecret(s.id)).filter(Boolean);
}

/** 요청마다 판정 문맥을 새로 만든다(등록부·엣지·DataCenter 는 그 사이 바뀔 수 있다). */
function ctxNow() {
  return { servers: rawServers(), agents: knownAgentNames(), datacenters: dcList() };
}

/** 입력 본문 → 파싱 결과 + 형식 구분. `text` 가 있으면 자유텍스트, 아니면 CSV(horizonAssign hzParseBody 와 같은 규칙). */
function parseBody(body = {}) {
  const raw = String(body.text ?? body.csv ?? '');
  const format = body.format === 'text' || (body.text != null && body.csv == null) ? 'text' : 'csv';
  if (format === 'text') {
    const r = cvpBulk.parseServersText(raw, { defaults: body.defaults && typeof body.defaults === 'object' ? body.defaults : {} });
    return { ...r, format, raw };
  }
  const r = cvpBulk.parseServersCsv(raw);
  return { ...r, warnings: [], headerUsed: null, order: r.order || cvpBulk.COLUMNS, format, raw };
}

const setDownload = (res, type, name) => {
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);   // ASCII 파일명(헤드리스·일부 브라우저가 한글을 떨군다)
  res.setHeader('Cache-Control', 'no-store');
};

export function registerCvpBulk(api) {

api.get(`${BASE}/export.csv`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  // 스토리지 모달의 옛 쿼리(`passwords=1`)도 같은 뜻으로 받는다 — 어느 쪽이든 설정 소유자 게이트를 탄다.
  const withSecrets = String(req.query.secrets || '') === '1' || String(req.query.passwords || '') === '1';
  const send = () => {
    const list = withSecrets ? rawServers() : listServers();
    const csv = cvpBulk.serversToCsv(list, { includeSecrets: withSecrets });
    const nSecret = withSecrets ? list.filter((s) => s.password || s.token).length : 0;
    logAudit({ user: req.user?.username, action: withSecrets ? 'CVP 서버 CSV 내보내기(비밀번호·토큰 포함)' : 'CVP 서버 CSV 내보내기',
      detail: `${list.length}대${withSecrets ? ` · 비밀 포함 ${nSecret}대` : ''}`, ip: req.ip || '' });
    setDownload(res, 'text/csv', `cvp-servers${withSecrets ? '-with-secrets' : ''}-${fileStamp()}.csv`);
    res.send(csv);
  };
  if (withSecrets) return requireSettingsOwner(req, res, send);
  send();
});

api.get(`${BASE}/export.txt`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const list = listServers();
  logAudit({ user: req.user?.username, action: 'CVP 서버 자유텍스트 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
  setDownload(res, 'text/plain', `cvp-servers-${fileStamp()}.txt`);
  res.send(cvpBulk.serversToText(list));
});

api.get(`${BASE}/sample.csv`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (_req, res) => {
  setDownload(res, 'text/csv', 'cvp-servers-sample.csv');
  res.send(cvpBulk.sampleCsv());
});

api.get(`${BASE}/sample.txt`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (_req, res) => {
  setDownload(res, 'text/plain', 'cvp-servers-sample.txt');
  res.send(cvpBulk.sampleText());
});

/**
 * ② 실제 연결 테스트 — 저장 **전에** 행마다 CVP 로그인·장비 목록 조회를 1회 시도한다.
 * ⚠ 자동 재시도 없음(잘못된 비밀번호 반복 = 계정 잠금). 재진입 가드·TTL·자격증명 제거는 `bulkRun` 이 강제한다.
 * ⚠ 엣지 위임 행은 '실패' 가 아니라 '테스트 불가'(skipped)다 — 중앙에서 닿지 않는 것이 정상이다.
 */
api.post(`${BASE}/import/test`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const p = parseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });
  const ctx = ctxNow();
  const { report, prepared } = cvpBulk.analyzeImport(p.rows, ctx);
  const okLines = new Set(report.filter((r) => r.action !== 'error').map((r) => r.line));
  const targets = p.rows.filter((r) => okLines.has(r._line));
  if (!targets.length) return res.status(400).json({ ok: false, reason: '형식 검증을 통과한 행이 없습니다 — 먼저 오류를 고치세요.' });

  const started = startBulkTest({
    kind: 'cvp', rows: targets, user: req.user?.username || '',
    skipReason: (row) => cvpBulk.skipReasonOf(prepared(row).input),
    testOne: async (row) => {
      const target = cvpBulk.testTargetOf(prepared(row));
      if (!target) return { ok: false, reason: '테스트할 자격증명이 없습니다(비밀번호·토큰을 적으세요).' };
      const r = await testServerConnection(target, { timeoutMs: TEST_TIMEOUT_MS });
      return r?.ok
        ? { ok: true, detail: { summary: `연결 성공 · 장비 ${r.deviceCount ?? '?'}대${r.cvpVersion ? ` · CVP ${r.cvpVersion}` : ''}` } }
        : { ok: false, reason: capStr(r?.reason || '연결 실패', 300), detail: r?.authFailed ? { hint: '자격증명이 거부됐습니다 — 토큰·비밀번호·계정을 확인하세요(반복 시도하면 계정이 잠길 수 있습니다).' } : {} };
    },
  });
  if (!started.ok) return res.status(409).json(started);
  logAudit({ user: req.user?.username, action: 'CVP 서버 대량 연결 테스트',
    detail: `${targets.length}대 시도(형식 오류 ${p.rows.length - targets.length}건 제외)`, ip: req.ip || '' });
  res.json({ ok: true, id: started.id, total: targets.length });
});

/** 연결 테스트 진행률·결과(폴링). 자격증명은 응답에 없다(`bulkRun publicRun`). */
api.get(`${BASE}/import/test/:id`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const run = publicRun(req.params.id);
  if (!run || run.kind !== 'cvp') return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다).' });
  res.json({ ok: true, ...run });
});

/**
 * ①/③ 가져오기 — `dryRun:true` 면 검증만, 아니면 저장.
 * 걸러낸 행은 버리지 않고 `skipped` 로 사유와 함께 돌려준다. 접속 대상이 바뀌어 저장 비밀을 폐기한 행은
 * `droppedSecrets` 로 **따로** 밝힌다(다음 수집이 실패한다 — 조용히 넘기지 않는다).
 */
api.post(`${BASE}/import`, csvPerm, adminOnly, toolsPerm, fullScopeOnly, (req, res) => {
  const p = parseBody(req.body || {});
  if (p.error) return res.status(400).json({ ok: false, reason: p.error });

  const ctx = ctxNow();
  const base = cvpBulk.analyzeImport(p.rows, ctx);
  const enriched = enrichAdvice(base.report, p.rows, {
    text: p.raw, order: p.order, format: p.format, fields: cvpBulk.COLUMNS,
    ctx: { agents: ctx.agents, datacenters: ctx.datacenters.map((d) => d.name || d.id) },
  });
  // CVP host 는 URL(https://cvp) 과 호스트[:포트] **둘 다** 정답이다(registry.baseUrlOf). 공용 조언('address' 는 "URL·포트를 빼라",
  // 'url' 은 "https:// 를 붙여라")은 어느 쪽이든 멀쩡한 값을 고치게 하는 **틀린 조언**이 된다(v2.525) — 판정은 그대로 두고 문구만 바로잡는다.
  const report = cvpBulk.fixCvpAdvice(enriched.report, { text: p.raw, order: p.order, format: p.format });
  const hints = cvpBulk.cvpHints(enriched.hints);

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

  let added = 0; let updated = 0; const failed = []; const droppedSecrets = [];
  for (const row of picked) {
    const prep = base.prepared(row);
    try {
      const saved = saveServer(prep.input);
      if (prep.prev) updated++; else added++;
      if (saved.droppedSecrets?.length) {
        droppedSecrets.push({ line: row._line, name: saved.name, secrets: saved.droppedSecrets,
          reason: `접속 대상(host·계정·인증 방식)이 바뀌어 저장돼 있던 ${saved.droppedSecrets.map((k) => (k === 'token' ? '토큰' : '비밀번호')).join('·')}을(를) 폐기했습니다.` });
      }
    } catch (e) {
      failed.push({ line: row._line, name: prep.input.name || row.host, reason: e.message });
    }
  }
  logAudit({ user: req.user?.username, action: `CVP 서버 대량 가져오기(${p.format === 'text' ? '자유텍스트' : 'CSV'})`,
    detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}·제외 ${skipped.length}${droppedSecrets.length ? ` · 접속 대상 변경으로 저장 비밀 폐기 ${droppedSecrets.length}건` : ''}${tested ? ' (연결 통과분만)' : ''}`,
    ip: req.ip || '' });
  // skipped 에도 폐기 사실을 한 줄씩 싣는다 — 공용 모달(BulkDeviceIo)이 skipped 를 그대로 보여 준다.
  res.json({ ok: true, added, updated, failed, droppedSecrets,
    skipped: [...skipped, ...droppedSecrets.map((d) => ({ line: d.line, name: d.name, reason: `${d.reason} 다음 수집 전에 다시 등록하세요(저장은 됐습니다).` }))],
    total: p.rows.length, format: p.format });
});
}
