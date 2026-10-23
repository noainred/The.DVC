// 설정 › vCenter 관리 › Veeam 백업 서버(v2.751) — 등록·수정·삭제·연결 시험·지금 읽기.
// 게이트: adminOnly + 전체 범위(전 법인 설정) · 변경은 감사 로그(비밀 미기재) · 응답에 비밀번호를 싣지 않는다(hasPassword 만).
// 연결 시험은 **저장된 서버만**(id 로) — 요청 본문의 host 로 저장 비밀번호를 보내지 않는다(server/CLAUDE.md v2.480 규칙).
import { adminOnly, fullScopeOnlyWith } from './shared.js';
import { logAudit } from '../../audit.js';
import { listServers, saveServer, deleteServer, getServerWithSecret, registryLoadError, serversForThisNode, DEFAULT_PORT, DEFAULT_API_VERSION } from '../../veeam/registry.js';
import { getRecord, dropResult } from '../../veeam/store.js';
import { pollVeeamOnce, veeamPollerStatus, authGuard } from '../../veeam/poller.js';
import { testVeeamServer } from '../../veeam/client.js';
import { withDeadline } from '../../util/deadline.js';
import { allVeeamEdgeStatus } from '../../central/veeamEdge.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { store } from '../../store.js';
import { listInventory } from '../../central/inventory.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { listAgentTokens } from '../../central/agentTokens.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import { requirePerm } from '../../auth/auth.js';
import { pickAgent } from '../../cvp/formChoices.js';
import { enrichAdvice, selectRows } from '../../util/bulkImport.js';
import { startBulkTest, publicRun, passedLines } from '../../util/bulkRun.js';
import * as vbBulk from '../../veeam/bulk.js';
import { accountView, saveManualAccounts, forgetLearned, accountsUnreadable } from '../../veeam/snapEvents.js';
// CSV·텍스트 가져오기/내보내기는 관리자 + 'data.csv' 권한(다른 대량 등록 화면과 같은 게이트 — v2.643).
const csvPerm = requirePerm('data.csv');

const fleetWideOnly = fullScopeOnlyWith('Veeam 백업 서버 등록은 전 법인에 걸친 설정이라 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다.');

/** 서버 1대의 상태 요약(화면 표 한 줄) — VM 표는 싣지 않는다. */
export function serverStatusView(rec) {
  if (!rec) return null;
  const r = rec.result || {};
  return {
    at: rec.at, via: rec.via, agent: rec.agent || '', ok: r.ok === true, ts: r.ts ?? null, ms: r.ms ?? null,
    error: r.error || '', kind: r.kind || '', apiVersion: r.apiVersion || '', notes: Array.isArray(r.notes) ? r.notes : [],
    counts: r.ok ? (r.counts || {}) : (rec.lastOk?.counts || {}), lastOkTs: r.ok ? r.ts : (rec.lastOk?.ts ?? null),
    authStop: r.authStop || null,
    jobs: (r.ok ? r.jobs : rec.lastOk?.jobs || []).slice(0, 300).map((j) => ({ name: j.name, status: j.status, lastResult: j.lastResult, lastRun: j.lastRun, running: j.running, disabled: j.disabled, vms: j.vms, containers: j.containers })),
  };
}

/**
 * v2.761 B3: 이 노드가 읽는 서버인가 — 엣지 노드에서는 중앙에서 받은 자기 몫(serversForThisNode)이 여기 든다. 그 서버의 '지금 읽기'·'연결 시험' 을
 * 막으면 엣지에서 인증 정지를 풀 길이 없다(authGuard 규칙 3 — 수동 실행은 막지 않는다).
 */
const readsHere = (d) => serversForThisNode().some((x) => x.id === d.id);
/** 중앙에서 엣지 담당 서버를 거절할 때의 문구 — 정지 중이면 '다음 주기에 반영' 이라 말하지 않는다(그 주기는 읽지 않는다). */
function edgeRefusal(d, what) {
  const rec = getRecord(d.id);
  const stopped = rec?.result?.kind === 'auth-stopped' || !!rec?.result?.authStop;
  if (stopped) {
    return `엣지 '${d.agent}' 가 읽는 서버입니다 — 그 엣지에서 인증 실패로 주기 수집이 멈춰 있어 다음 주기에도 읽지 않습니다. `
      + 'Veeam 계정을 고친 뒤(비밀번호를 바꿔 저장하면 자동으로 다시 읽습니다) 같은 비밀번호라면 엣지 포탈의 이 화면에서 \'지금 읽기\' 를 누르세요.';
  }
  return `엣지 '${d.agent}' 가 읽는 서버입니다 — 중앙에서는 ${what}. 엣지가 자기 수집 주기에 읽어 올리며, 바로 확인하려면 엣지 포탈의 이 화면에서 '지금 읽기' 를 누르세요.`;
}

export function registerVeeam(adminRouter) {
  // v2.754: vCenter 이벤트에서 Veeam 스냅샷을 가리는 'Veeam 계정'(Veeam 이 vCenter 에 접속하는 계정). 사람이 적은 것 + 자동으로 배운 것.
  //   비밀은 아니지만 계정 이름이라 관리자·전체 범위만 본다. 저장은 감사 로그(계정 수만). 엣지는 veeam-config pull 로 받는다.
  adminRouter.get('/veeam/vc-accounts', adminOnly, fleetWideOnly, (_req, res) => res.json({ ok: true, ...accountView() }));
  adminRouter.put('/veeam/vc-accounts', adminOnly, fleetWideOnly, (req, res) => {
    const raw = req.body?.accounts;
    const forget = req.body?.forget;
    if (raw != null && !Array.isArray(raw) && typeof raw !== 'string') return res.status(400).json({ ok: false, reason: 'accounts 는 목록 또는 줄바꿈 문자열입니다.' });
    if (forget != null && !Array.isArray(forget)) return res.status(400).json({ ok: false, reason: 'forget 은 계정 이름 목록입니다.' });
    // 파일을 못 읽은 상태로 저장하면 학습 계정·받은 계정까지 빈 값으로 덮는다 — 막고 이유를 말한다(조회 실패 상태로 저장하지 않는다).
    if (accountsUnreadable()) return res.status(409).json({ ok: false, reason: '계정 파일을 읽지 못한 상태라 저장하지 않습니다 — 손상본(veeam-vc-accounts.json.corrupt.*)을 확인한 뒤 포탈을 다시 시작하세요.' });
    try {
      const forgot = forget ? forgetLearned(forget) : 0;
      const r = raw != null ? saveManualAccounts(raw) : { list: accountView().manual, dropped: 0 };
      logAudit({ user: req.user?.username, action: 'Veeam vCenter 계정 저장', target: 'veeam-vc-accounts', detail: `${r.list.length}개${r.dropped ? ` · 버림 ${r.dropped}` : ''}${forgot ? ` · 학습 계정 지움 ${forgot}` : ''}` });
      res.json({ ok: true, saved: r.list.length, dropped: r.dropped, forgot, ...accountView() });
    } catch (e) { res.status(500).json({ ok: false, reason: `저장하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` }); }
  });

  adminRouter.get('/veeam/servers', adminOnly, fleetWideOnly, (_req, res) => {
    const le = registryLoadError();
    const owners = new Map(listInventory().map((i) => [i.vcenterId, i.agent]));
    // 화면 목록은 지금 보이는 vCenter(스냅샷 — 데모 포함) + 등록부의 주소·수집 방식.
    const reg = new Map(listVcenters().map((v) => [v.id, v]));
    const vcenters = (store.get()?.vcenters || []).map((v) => ({ id: v.id, name: v.name, host: reg.get(v.id)?.host || '', collectMode: reg.get(v.id)?.collectMode || 'direct', siteAgent: owners.get(v.id) || '' }));
    res.json({
      ok: true,
      servers: listServers().map((d) => ({ ...d, status: serverStatusView(getRecord(d.id)) })),
      vcenters, agents: knownAgentNames(), edges: allVeeamEdgeStatus(), poller: veeamPollerStatus(),
      // 개별 토큰이 발급된 엣지 이름 — Veeam 위임 라우트는 개별 토큰만 받는다(central.js veeam-config). 화면이 토큰 없는 엣지 배정을 경고한다.
      tokenAgents: (() => { try { return listAgentTokens().map((t) => t.agent); } catch { return []; } })(),
      defaults: { port: DEFAULT_PORT, apiVersion: DEFAULT_API_VERSION },
      ...(le ? { registryError: summarizeRegistryError(le)?.text || '등록부 읽기 오류' } : {}),
    });
  });

  adminRouter.post('/veeam/servers', adminOnly, fleetWideOnly, (req, res) => {
    try {
      // 읽는 곳(엣지)은 중앙이 아는 엣지 목록에서만(대소문자·공백 차이는 목록 표기로) — 이미 저장된 값은 목록에 없어도 통과(docs/rules/edge.md).
      const body = { ...(req.body || {}) };
      const prev = body.id ? getServerWithSecret(String(body.id)) : null;
      const ag = pickAgent(body.agent, knownAgentNames(), prev?.agent || '');
      if (ag.error) return res.status(400).json({ ok: false, reason: ag.error, field: 'agent' });
      body.agent = ag.value;
      const d = saveServer(body);
      // v2.761 B4: 접속처가 바뀌면 옛 접속처의 결과(lastOk — 실패해도 승계된다)와 인증 정지를 지운다(다른 서버다 — secretCarry 와 같은 판단).
      if (d.moved) { dropResult(d.id); authGuard.clearAuthStop(d.id); }
      logAudit({ user: req.user?.username, action: 'Veeam 서버 저장', target: d.name, detail: `${d.host}:${d.port} · vCenter ${d.vcenterIds.join(',')} · 읽는 곳=${d.agent || '중앙'}${d.moved ? ' · 접속처 변경으로 이전 결과·인증 정지 지움' : ''}${d.droppedSecrets ? ' · 접속처 변경으로 저장 비밀번호 폐기' : ''}` });
      res.status(201).json({ ok: true, server: d });
    } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
  });

  adminRouter.delete('/veeam/servers/:id', adminOnly, fleetWideOnly, (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d || !deleteServer(req.params.id)) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    dropResult(req.params.id);
    authGuard.clearAuthStop(req.params.id);
    logAudit({ user: req.user?.username, action: 'Veeam 서버 삭제', target: d.name, detail: `${d.host}:${d.port || DEFAULT_PORT}` });
    res.json({ ok: true });
  });

  // 연결 시험 — 이 노드가 읽는 서버만(중앙: 직접 서버 · 엣지: 받은 자기 몫 — v2.761 B3). 남의 엣지 담당은 그 엣지가 읽는다(중앙에서는 닿지 않는 망일 수 있다).
  adminRouter.post('/veeam/servers/:id/test', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    if (String(d.id).startsWith('mock-')) return res.json({ ok: false, reason: '데모 서버는 접속하지 않습니다.' });
    if ((d.agent || '').trim() && !readsHere(d)) return res.json({ ok: false, edge: true, reason: edgeRefusal(d, '시험하지 않습니다') });
    try {
      const r = await withDeadline(90_000, (signal) => testVeeamServer(d, { signal }), 'Veeam 연결 시험 시한 초과');
      logAudit({ user: req.user?.username, action: 'Veeam 연결 시험', target: d.name, detail: `성공 · 작업 ${r.jobs}개` });
      res.json(r);
    } catch (e) {
      const reason = String(e?.message || e).slice(0, 600);
      logAudit({ user: req.user?.username, action: 'Veeam 연결 시험', target: d.name, detail: `실패 · ${reason.slice(0, 120)}` });
      res.json({ ok: false, reason, auth: !!e?.authFailed });
    }
  });

  // 지금 읽기 — 이 노드가 읽는 서버를 바로 읽는다(수동은 인증 정지를 건너뛴다 — 고쳤는지 확인할 길. 엣지 노드에서는 자기 몫도 — v2.761 B3).
  // v2.761 D6 응답 계약: { ok:<전체 성공 boolean>, okCount, failCount, skipped?, timedOut?, disabled?, reason?, status }
  //   (예전에는 pollVeeamOnce 의 ok(성공 개수)가 스프레드로 boolean ok 를 덮었다 — 꺼진 서버는 시도도 안 했는데 '읽기 실패').
  adminRouter.post('/veeam/servers/:id/collect', adminOnly, fleetWideOnly, async (req, res) => {
    const d = getServerWithSecret(req.params.id);
    if (!d) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    if ((d.agent || '').trim() && !readsHere(d)) return res.json({ ok: false, edge: true, reason: edgeRefusal(d, '읽지 않습니다') });
    if (d.enabled === false) {
      return res.json({ ok: false, okCount: 0, failCount: 0, disabled: true, reason: '수집이 꺼진 서버라 읽지 않았습니다 — 수정에서 수집을 켠 뒤 읽으세요.', status: serverStatusView(getRecord(d.id)) });
    }
    const r = await pollVeeamOnce({ manual: true, ids: [d.id] });
    const okCount = Number(r.ok) || 0; const failCount = Number(r.fail) || 0;
    const status = serverStatusView(getRecord(d.id));
    const ok = !r.skipped && !r.timedOut && okCount > 0 && failCount === 0;
    let reason = '';
    if (r.skipped) reason = '이미 수집 중입니다 — 끝난 뒤 다시 누르세요.';
    else if (r.timedOut) reason = '수집 주기 상한을 넘겨 기다리지 않았습니다 — 잠시 뒤 상태를 확인하세요.';
    else if (!ok && !okCount && !failCount) reason = '이 노드가 읽는 서버 목록에 없어 읽지 않았습니다.';
    else if (!ok) reason = status?.error || '읽기에 실패했습니다.';
    logAudit({ user: req.user?.username, action: 'Veeam 지금 읽기', target: d.name, detail: r.skipped ? '이미 수집 중' : r.timedOut ? '주기 상한 초과' : `성공 ${okCount}·실패 ${failCount}` });
    res.json({ ok, okCount, failCount, ...(r.skipped ? { skipped: true } : {}), ...(r.timedOut ? { timedOut: true } : {}), ...(reason ? { reason } : {}), status });
  });

  /* ══════════════════ 대량 등록(CSV·자유텍스트, v2.751 사용자 요청) ══════════════════
   * 같은 코어·같은 화면 컴포넌트(util/bulkImport.js + 웹 views/tools/BulkDeviceIo.jsx — resource 'servers').
   * 흐름: ① import {dryRun:true} → ② import/test(중앙 직접 행만 실제 로그인 · 엣지 담당 행은 '테스트 불가') → ③ import {selectLines[,testRunId]}.
   * 내보내기·샘플에 비밀번호는 담기지 않는다. 비밀번호를 비운 행은 기존 유지(계정이 바뀐 행은 검증이 막는다).
   */
  const vbCtx = () => {
    const byKey = new Map(listServers().map((d) => [vbBulk.keyOfHostPort(d.host, d.port), d]));
    return { existing: (k) => byKey.get(k), vcenters: (store.get()?.vcenters || []).map((v) => ({ id: v.id, name: v.name })), agents: knownAgentNames() };
  };
  const vbParse = (body = {}) => {
    const raw = String(body.text ?? body.csv ?? '');
    const format = body.format === 'text' || (body.text != null && body.csv == null) ? 'text' : 'csv';
    if (format === 'text') return { ...vbBulk.parseServersText(raw, { defaults: body.defaults || {} }), format, raw };
    const r = vbBulk.parseServersCsv(raw);
    return { ...r, warnings: [], headerUsed: null, order: r.order || vbBulk.COLUMNS, format, raw };
  };
  const sendFile = (res, type, name, body) => { res.setHeader('Content-Type', `${type}; charset=utf-8`); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(body); };

  adminRouter.get('/veeam/servers/export.csv', csvPerm, adminOnly, fleetWideOnly, (req, res) => {
    const list = listServers();
    logAudit({ user: req.user?.username, action: 'Veeam 서버 CSV 내보내기', detail: `${list.length}대` });
    sendFile(res, 'text/csv', 'veeam-servers.csv', vbBulk.serversToCsv(list));
  });
  adminRouter.get('/veeam/servers/export.txt', csvPerm, adminOnly, fleetWideOnly, (req, res) => {
    const list = listServers();
    logAudit({ user: req.user?.username, action: 'Veeam 서버 자유텍스트 내보내기', detail: `${list.length}대` });
    sendFile(res, 'text/plain', 'veeam-servers.txt', vbBulk.serversToText(list));
  });
  adminRouter.get('/veeam/servers/sample.csv', csvPerm, adminOnly, fleetWideOnly, (_req, res) => sendFile(res, 'text/csv', 'veeam-servers-sample.csv', vbBulk.sampleCsv()));
  adminRouter.get('/veeam/servers/sample.txt', csvPerm, adminOnly, fleetWideOnly, (_req, res) => sendFile(res, 'text/plain', 'veeam-servers-sample.txt', vbBulk.sampleText()));

  // ② 실제 연결 시험 — 저장 전에 중앙 직접 행만 로그인해 본다. 자동 재시도 없음(계정 잠금). 엣지 담당 행은 '테스트 불가'(실패 아님).
  //   비밀번호를 비운 기존 행은 **저장된 서버(같은 host:port·같은 계정)의 비밀번호**로만 시험한다 — 행의 다른 값으로 저장 비밀번호를 보내지 않는다.
  adminRouter.post('/veeam/servers/import/test', csvPerm, adminOnly, fleetWideOnly, (req, res) => {
    const p = vbParse(req.body || {});
    if (p.error) return res.status(400).json({ ok: false, reason: p.error });
    const ctx = vbCtx();
    const { report } = vbBulk.analyzeImport(p.rows, ctx);
    const okLines = new Set(report.filter((r) => r.action !== 'error').map((r) => r.line));
    const targets = p.rows.filter((r) => okLines.has(r._line));
    if (!targets.length) return res.status(400).json({ ok: false, reason: '형식 검증을 통과한 행이 없습니다 — 먼저 오류를 고치세요.' });
    const started = startBulkTest({
      kind: 'veeam', rows: targets, user: req.user?.username || '',
      skipReason: (row) => {
        const input = vbBulk.toSaveInput(row, ctx);
        return input.agent ? `엣지 ‘${input.agent}’ 가 읽는 서버 — 중앙에서는 시험하지 않습니다(저장하면 그 엣지가 읽습니다)` : null;
      },
      testOne: async (row, signal) => {
        const input = vbBulk.cleanInput(vbBulk.toSaveInput(row, ctx));
        let srv = input;
        if (!row._hasPassword) {
          const saved = input.id ? getServerWithSecret(input.id) : null;
          if (!saved?.password) return { ok: false, reason: '비밀번호가 없어 시험하지 않았습니다(신규는 마지막 열에 비밀번호)' };
          srv = { ...saved, apiVersion: input.apiVersion || saved.apiVersion }; // 접속처·계정은 저장값 그대로(비밀번호를 다른 곳으로 보내지 않는다)
        }
        try {
          const r = await testVeeamServer({ ...srv, port: Number(srv.port) || DEFAULT_PORT }, { signal });
          return { ok: true, detail: { summary: `로그인 성공 · 작업 ${r.jobs}개 · API ${r.apiVersion}` } };
        } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 300) }; }
      },
    });
    if (!started.ok) return res.status(409).json(started);
    logAudit({ user: req.user?.username, action: 'Veeam 서버 대량 연결 시험', detail: `${targets.length}대 시도(형식 오류 ${p.rows.length - targets.length}건 제외)` });
    res.json({ ok: true, id: started.id, total: targets.length });
  });
  adminRouter.get('/veeam/servers/import/test/:id', csvPerm, adminOnly, fleetWideOnly, (req, res) => {
    const run = publicRun(req.params.id);
    if (!run || run.kind !== 'veeam') return res.status(404).json({ ok: false, reason: '실행을 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다).' });
    res.json({ ok: true, ...run });
  });

  // ①/③ 가져오기 — dryRun 이면 검증만, 아니면 고른 행을 저장. 걸러낸 행은 사유와 함께 skipped 로 돌려준다.
  adminRouter.post('/veeam/servers/import', csvPerm, adminOnly, fleetWideOnly, (req, res) => {
    const p = vbParse(req.body || {});
    if (p.error) return res.status(400).json({ ok: false, reason: p.error });
    const ctx = vbCtx();
    const base = vbBulk.analyzeImport(p.rows, ctx);
    const { report, hints } = enrichAdvice(base.report, p.rows, { text: p.raw, order: p.order, format: p.format, fields: vbBulk.COLUMNS, ctx: {} });
    if (req.body?.dryRun) {
      return res.json({ ok: true, dryRun: true, report, summary: base.summary, hints, warnings: p.warnings, headerUsed: p.headerUsed, format: p.format, total: p.rows.length });
    }
    const tested = req.body?.testRunId ? passedLines(req.body.testRunId) : null;
    if (req.body?.testRunId && tested == null) return res.status(400).json({ ok: false, reason: '연결 시험 결과를 찾을 수 없습니다(15분 지나 폐기되었을 수 있습니다) — 다시 시험하세요.' });
    const { picked, skipped } = selectRows(p.rows, report, { lines: Array.isArray(req.body?.selectLines) ? req.body.selectLines : null, requireTested: tested });
    let added = 0; let updated = 0; const failed = []; const dropped = [];
    for (const row of picked) {
      const input = vbBulk.toSaveInput(row, ctx);
      const issue = vbBulk.inputIssue(input, { isNew: !input.id });
      if (issue) { failed.push({ line: row._line, name: row.name || row.host, reason: issue }); continue; }
      try {
        const d = saveServer(vbBulk.cleanInput(input));
        if (d.moved) { dropResult(d.id); authGuard.clearAuthStop(d.id); } // v2.761 B4: 단건 저장과 같다
        if (input.id) updated++; else added++;
        if (d.droppedSecrets?.length) dropped.push({ line: row._line, name: row.name || row.host, reason: '접속처가 바뀌어 저장된 비밀번호를 폐기했습니다 — 비밀번호를 다시 등록하세요.' });
      } catch (e) { failed.push({ line: row._line, name: row.name || row.host, reason: String(e?.message || e).slice(0, 300) }); }
    }
    logAudit({ user: req.user?.username, action: `Veeam 서버 대량 가져오기(${p.format === 'text' ? '자유텍스트' : 'CSV'})`,
      detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}·제외 ${skipped.length}${tested ? ' (연결 통과분만)' : ''}` });
    res.json({ ok: true, added, updated, failed, skipped: [...skipped, ...dropped], total: p.rows.length, format: p.format });
  });
}
