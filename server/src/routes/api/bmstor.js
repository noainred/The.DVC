// 베어메탈 스토리지(v2.340, 사용자 요구) — 서버 SSH(df)로 로컬 디스크 마운트 용량을 주기 수집해
// 서버/그룹/전체 합산(총·사용·가용)을 보여준다. 전부 adminOnly(SSH 자격증명·호스트 구성).
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { listBmServers, listBmServersRaw, saveBmServer, removeBmServer, getBmSettings, saveBmSettings, bmServerInputIssue } from '../../bmstor/registry.js';
import { getBmLatest, bmCollectNow, bmPollerStatus } from '../../bmstor/poller.js';
import { aggregate } from '../../bmstor/agg.js';
import { bmServersToCsv, sampleCsv as bmSampleCsv, parseBmServersCsv, analyzeBmServersImport } from '../../bmstor/csv.js';
import { listCollectors } from '../../collector/registry.js';
import { requireSettingsOwner } from '../admin/shared.js';

const adminOnly = requireRole('admin');

export function registerBmStorage(api) {
  // 현황 — 서버 목록(비밀 redact) + 최신 수집을 합산(서버/그룹/전체)해 반환. 엣지 콤보용 목록 포함.
  api.get('/tools/bm-storage', adminOnly, (_req, res) => {
    const servers = listBmServers();
    const { total, groups, perServer } = aggregate(servers, getBmLatest());
    res.json({
      ok: true, total, groups, servers: perServer,
      config: servers, // 편집 폼용 원본(마운트 목록 포함, 비밀번호는 hasPassword 만)
      settings: getBmSettings(), status: bmPollerStatus(),
      agents: listCollectors().map((c) => c.id), // 위임 가능한 엣지(수집 서버) 이름 목록
    });
  });

  // 서버 추가/수정 — body { id?, name, host, port, username, password?, agent, group, mounts, enabled }
  api.post('/tools/bm-storage/servers', adminOnly, (req, res) => {
    const r = saveBmServer(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 저장', target: r.server?.host || '', detail: `mounts ${(r.server?.mounts || []).length}개${r.server?.agent ? ` · 엣지 ${r.server.agent}` : ''}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  api.delete('/tools/bm-storage/servers/:id', adminOnly, (req, res) => {
    const r = removeBmServer(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 서버 삭제', target: req.params.id, ip: req.ip || '' });
    res.status(r.ok ? 200 : 404).json(r);
  });

  // 수집 주기 저장(분) — 폴러가 30초 틱마다 설정을 다시 읽으므로 재기동 없이 반영된다.
  api.put('/tools/bm-storage/settings', adminOnly, (req, res) => {
    const r = saveBmSettings(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 주기 변경', target: `${r.settings.intervalMinutes}분`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  /* ── 서버 CSV 일괄 관리(v2.341, 사용자 요구 — 다수 서버 등록). 수집 서버 CSV(v2.338)와 동일 골격:
   * 기본 export 는 비밀번호 제외(?secrets=1 은 설정 소유자 + 감사로그), 가져오기는 드라이런 →
   * 덮어쓰기(overwrite=true 명시) 2단계. agent 는 등록된 수집 서버(원격) 이름만 허용. ── */
  api.get('/tools/bm-storage/export.csv', adminOnly, (req, res) => {
    const withPw = String(req.query.secrets || '') === '1';
    const send = () => {
      const list = withPw ? listBmServersRaw() : listBmServers();
      const csv = bmServersToCsv(list, { includeSecrets: withPw });
      logAudit({ user: req.user?.username, action: withPw ? '베어메탈 스토리지 CSV 내보내기(비밀번호 포함)' : '베어메탈 스토리지 CSV 내보내기', detail: `${list.length}대`, ip: req.ip || '' });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bm-storage-servers${withPw ? '-with-passwords' : ''}.csv"`);
      res.send(csv);
    };
    if (withPw) return requireSettingsOwner(req, res, send);
    send();
  });

  api.get('/tools/bm-storage/sample.csv', adminOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-storage-servers-sample.csv"');
    res.send(bmSampleCsv());
  });

  api.post('/tools/bm-storage/import', adminOnly, (req, res) => {
    const { rows, error } = parseBmServersCsv(String(req.body?.csv || ''));
    if (error) return res.status(400).json({ ok: false, reason: error });
    if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

    const all = listBmServers();
    const existingId = (host, port, user) => all.find((s) =>
      String(s.host).trim() === String(host).trim()
      && String(s.port || 22) === String(port || 22)
      && String(s.username || '') === String(user || ''))?.id;
    const agentSet = new Set(listCollectors().map((c) => String(c.id).toLowerCase()));
    const validAgent = (a) => agentSet.has(String(a).trim().toLowerCase());

    const { report, summary } = analyzeBmServersImport(rows, { existingId, validate: bmServerInputIssue, validAgent });
    if (req.body?.dryRun) return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });

    const allowOverwrite = req.body?.overwrite === true;
    let added = 0, overwritten = 0; const failed = []; const skipped = [];
    for (const row of rows) {
      const verdict = report.find((r) => r.line === row._line);
      if (verdict?.action === 'error') { failed.push({ line: verdict.line, host: row.host, reason: verdict.reason }); continue; }
      const id = existingId(row.host, row.port, row.username);
      if (id && !allowOverwrite) { skipped.push({ line: row._line, host: row.host, reason: '기존 항목 — 덮어쓰기 미허용(overwrite 확인 필요)' }); continue; }
      const input = { id, name: row.name, host: row.host, port: row.port, username: row.username,
        group: row.group, agent: row.agent, dispatch: row.dispatch, mounts: row.mounts, enabled: row.enabled };
      if (row._hasPassword) input.password = row.password; // 비우면 기존 유지(saveBmServer 규칙)
      const r = saveBmServer(input);
      if (r.ok) { if (id) overwritten++; else added++; }
      else failed.push({ line: row._line, host: row.host, reason: r.reason });
    }
    logAudit({ user: req.user?.username, action: '베어메탈 스토리지 CSV 가져오기', detail: `추가 ${added}·덮어쓰기 ${overwritten}·건너뜀 ${skipped.length}·실패 ${failed.length}`, ip: req.ip || '' });
    res.json({ ok: true, added, overwritten, skipped, failed, total: rows.length });
  });

  // 지금 수집 — 진행 중이면 skipped(재진입 가드 공유, net/monitor.runMonitorNow 패턴).
  api.post('/tools/bm-storage/collect', adminOnly, async (req, res) => {
    const r = await bmCollectNow('manual');
    if (r.ok) logAudit({ user: req.user?.username, action: '베어메탈 스토리지 수동 수집', detail: `서버 ${r.servers} · 성공 ${r.okCount} · 오류 ${r.errors}`, ip: req.ip || '' });
    res.status(r.ok ? 200 : 409).json(r);
  });
}
