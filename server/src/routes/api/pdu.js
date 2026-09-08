/**
 * PDU 모니터링 라우트(v2.424) — 특수기능 'PDU 정보' 화면용.
 *
 * 접근 규약은 스토리지/SAN 스위치와 동일하다:
 *  - 조회: `tools` 권한 + **전체 범위 계정만**. PDU 는 vCenter 귀속이 없는 인프라 장비라
 *    범위 계정에 노출하지 않는다('vCenter 귀속 없는 데이터는 범위 계정 미노출' — server/CLAUDE.md).
 *  - 변경(등록/수정/삭제/테스트/수집/주기/CSV): adminOnly + 감사로그.
 *  - CSV 비밀번호 포함 내보내기는 **설정 소유자 전용**(평문 자격증명 덤프이므로).
 */

import { requireRole, requirePerm } from '../../auth/auth.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import {
  listDevices, listDevicesWithSecrets, saveDevice, deleteDevice, deviceInputIssue, getDeviceWithSecret,
} from '../../pdu/registry.js';
import { collectDeviceNow, testDeviceConnection, pollOnce, pduPollerStatus, localSnapshots, getLocalSnapshot } from '../../pdu/poller.js';
import { edgePduSnapshots, edgePduStatus } from '../../central/pduEdge.js';
import { requestCollect, hasPendingRequest } from '../../pdu/collectRequests.js';
import { INTERVAL_SPEC, saveIntervals, runtimeIntervals, intervalsForEdge } from '../../pdu/intervals.js';
import { THRESHOLD_SPEC, loadThresholds, saveThresholds, evaluateSnapshot, activeViolations } from '../../pdu/thresholds.js';
import { powerSeries, envSeries, dbStats } from '../../pdu/db.js';
import { devicesToCsv, csvToDevices, sampleCsv } from '../../pdu/csv.js';
import { summarize } from '../../pdu/types.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: 'PDU 정보는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

/** 중앙 직접 수집분 + 엣지 push 분을 합친다(같은 id 는 최신 것 우선). */
function allSnapshots() {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgePduSnapshots()]) {
    const prev = byId.get(s.id);
    if (!prev || (s.collectedAt || 0) > (prev.collectedAt || 0)) byId.set(s.id, s);
  }
  return [...byId.values()];
}

export function registerPdu(api) {

  // ---- 목록/현황 ------------------------------------------------------------
  api.get('/tools/pdu', toolsPerm, fullScopeOnly, (_req, res) => {
    const th = loadThresholds();
    const snaps = new Map(allSnapshots().map((s) => [s.id, s]));
    const devices = listDevices().map((d) => {
      const s = snaps.get(d.id) || null;
      return {
        ...d,
        snapshot: s ? {
          ok: s.ok, error: s.error || '', collectedAt: s.collectedAt, agent: s.agent || '',
          model: s.model || '', serial: s.serial || '',
          summary: summarize(s),
          units: (s.units || []).map((u) => ({
            index: u.index, powerW: u.powerW, energyKwh: u.energyKwh, appPowerW: u.appPowerW, pf: u.pf,
            banks: u.banks || [], phases: u.phases || [],
          })),
          sensors: s.sensors || [],
          notes: s.notes || [],
          // 임계치 위반을 장비 행에 함께 실어 화면이 별도 조회 없이 배지를 그린다.
          violations: evaluateSnapshot(s, th),
        } : null,
      };
    });
    res.json({
      ok: true,
      devices,
      datacenters: listDatacenters(),
      agents: knownAgentNames(),
      poller: pduPollerStatus(),
      edges: edgePduStatus(),
      intervals: runtimeIntervals(),
      intervalSpec: INTERVAL_SPEC,
      thresholds: th,
      thresholdSpec: THRESHOLD_SPEC,
      activeViolations: activeViolations(),
    });
  });

  api.post('/tools/pdu/thresholds', adminOnly, (req, res) => {
    const next = saveThresholds(req.body || {});
    logAudit({ user: req.user?.username, action: 'PDU 임계치 변경', target: JSON.stringify(next) });
    res.json({ ok: true, thresholds: next });
  });

  api.get('/tools/pdu/:id', toolsPerm, fullScopeOnly, (req, res) => {
    const s = allSnapshots().find((x) => x.id === req.params.id) || getLocalSnapshot(req.params.id);
    if (!s) return res.status(404).json({ ok: false, reason: '수집된 데이터가 없습니다.' });
    res.json({ ok: true, snapshot: { ...s, summary: summarize(s) } });
  });

  // ---- 시계열(별도 DB) ------------------------------------------------------
  api.get('/tools/pdu/series/power', toolsPerm, fullScopeOnly, async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await powerSeries(ids, {
      hours: Number(req.query.hours) || 24,
      points: Math.min(500, Number(req.query.points) || 120),
      from: req.query.from ? Number(req.query.from) : null,
      to: req.query.to ? Number(req.query.to) : null,
    });
    res.json({ ok: true, ...r });
  });

  api.get('/tools/pdu/series/env', toolsPerm, fullScopeOnly, async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await envSeries(ids, {
      hours: Number(req.query.hours) || 24,
      points: Math.min(500, Number(req.query.points) || 120),
      from: req.query.from ? Number(req.query.from) : null,
      to: req.query.to ? Number(req.query.to) : null,
    });
    res.json({ ok: true, ...r });
  });

  api.get('/tools/pdu/db-stats', toolsPerm, fullScopeOnly, async (_req, res) => {
    res.json({ ok: true, stats: await dbStats() });
  });

  // ---- 등록/수정/삭제 -------------------------------------------------------
  // ⚠ 정적 경로를 파라미터 경로보다 먼저 등록한다(/tools/pdu/csv 가 :id 로 잡히지 않게).
  api.get('/tools/pdu/csv/export', adminOnly, (req, res) => {
    const withPw = String(req.query.passwords || '') === '1';
    if (withPw && !req.user?.isSettingsOwner) {
      // 평문 자격증명 덤프 — 설정 소유자 경계를 서버에서 강제한다.
      return requireSettingsOwner(req, res, () => sendCsv(req, res, true));
    }
    return sendCsv(req, res, withPw);
  });
  function sendCsv(req, res, withPw) {
    const dcName = (id) => (listDatacenters().find((d) => d.id === id)?.name || id || '');
    const devices = withPw ? listDevicesWithSecrets() : listDevices();
    logAudit({ user: req.user?.username, action: 'PDU CSV 내보내기', target: `${devices.length}대`, detail: withPw ? '비밀번호 포함' : '비밀번호 제외' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pdu-devices.csv"');
    res.send(devicesToCsv(devices, dcName, { includePasswords: withPw }));
  }

  api.get('/tools/pdu/csv/sample', adminOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pdu-devices-sample.csv"');
    res.send(sampleCsv());
  });

  api.post('/tools/pdu/csv/import', adminOnly, (req, res) => {
    const text = String(req.body?.csv || '');
    if (!text.trim()) return res.status(400).json({ ok: false, reason: 'CSV 내용이 비어 있습니다.' });
    const dcs = listDatacenters();
    const dcIdOf = (v) => {
      const s = String(v || '').trim();
      if (!s) return '';
      return (dcs.find((d) => d.id === s) || dcs.find((d) => (d.name || '').toLowerCase() === s.toLowerCase()))?.id || s;
    };
    const { rows, errors } = csvToDevices(text, dcIdOf);
    const existing = listDevices();
    let added = 0, updated = 0;
    const failed = [...errors];
    for (const r of rows) {
      // 멱등 키 = host. 있으면 그 id 로 수정, 없으면 신규.
      const prev = existing.find((d) => d.host.toLowerCase() === r.host.toLowerCase());
      const out = saveDevice(prev ? { ...r, id: prev.id } : r);
      if (!out.ok) { failed.push(`${r._line}행(${r.host}): ${out.reason}`); continue; }
      if (prev) updated++; else added++;
    }
    logAudit({ user: req.user?.username, action: 'PDU CSV 가져오기', target: `추가 ${added} · 수정 ${updated}`, detail: failed.length ? `실패 ${failed.length}건` : '' });
    res.json({ ok: true, added, updated, failed, total: rows.length });
  });

  api.post('/tools/pdu/test', adminOnly, async (req, res) => {
    const b = req.body || {};
    const issue = deviceInputIssue(b);
    if (issue) return res.status(400).json({ ok: false, reason: issue });
    // 비밀번호를 안 보내면 저장된 값 사용(재입력 없이 재테스트) — vCenter/스토리지와 동일 규약.
    let password = String(b.password ?? '');
    if (!password && b.id) {
      const saved = getDeviceWithSecret(b.id);
      if (saved && saved.host === String(b.host || '').trim()) password = saved.password || '';
    }
    if (!password) return res.status(400).json({ ok: false, reason: '비밀번호가 필요합니다.' });
    const device = { ...b, password, sshPort: Number(b.sshPort) || 22, id: b.id || `test-${Date.now()}` };
    logAudit({ user: req.user?.username, action: 'PDU 연결 테스트', target: `${b.name || ''}(${b.host})` });
    const r = await testDeviceConnection(device, { timeoutMs: 60_000 });
    res.json(r);
  });

  api.post('/tools/pdu/intervals', adminOnly, (req, res) => {
    const next = saveIntervals(req.body || {});
    logAudit({ user: req.user?.username, action: 'PDU 수집 주기 변경', target: JSON.stringify(next) });
    res.json({ ok: true, intervals: runtimeIntervals(), saved: next, forEdge: intervalsForEdge() });
  });

  api.post('/tools/pdu/devices', adminOnly, (req, res) => {
    const r = saveDevice(req.body || {});
    if (r.ok) logAudit({ user: req.user?.username, action: 'PDU 등록/수정', target: `${r.device.name}(${r.device.host})`, detail: r.device.agent ? `엣지 ${r.device.agent}` : '중앙 직접' });
    res.status(r.ok ? 200 : 400).json(r);
  });

  api.delete('/tools/pdu/devices/:id', adminOnly, (req, res) => {
    const r = deleteDevice(req.params.id);
    if (r.ok) logAudit({ user: req.user?.username, action: 'PDU 삭제', target: req.params.id });
    res.status(r.ok ? 200 : 404).json(r);
  });

  /**
   * 지금 수집 — 중앙 직접 수집 장비는 즉시, 엣지 위임 장비는 **재수집 요청 등록**
   * (중앙은 엣지에 명령을 밀어넣을 수 없어, 엣지가 다음 config pull 때 가져가 즉시 수집·push).
   */
  api.post('/tools/pdu/devices/:id/collect', adminOnly, async (req, res) => {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '없는 장비입니다.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: 'PDU 재수집 요청(엣지)', target: `${dev.name}(${dev.id})`, detail: `엣지 ${dev.agent}` });
      return res.status(202).json({
        ok: true, requested: true,
        reason: `${dup ? '이미 재수집 요청이 대기 중입니다' : '재수집 요청 등록'} — 엣지 '${dev.agent}' 의 다음 설정 pull 때 즉시 수집하고 바로 push 합니다.`,
      });
    }
    const r = await collectDeviceNow(dev.id);
    logAudit({ user: req.user?.username, action: 'PDU 즉시 수집', target: dev.id });
    res.status(r.ok ? 200 : 502).json(r);
  });

  api.post('/tools/pdu/collect-all', adminOnly, async (req, res) => {
    const r = await pollOnce();
    logAudit({ user: req.user?.username, action: 'PDU 전체 수집', target: `${r.devices ?? 0}대` });
    res.json(r);
  });

}
