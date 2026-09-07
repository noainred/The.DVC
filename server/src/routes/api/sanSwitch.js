/**
 * SAN 스위치 모니터링 라우트(v2.410) — 특수기능 'SAN 스위치 모니터링' 화면용.
 *
 * 접근 규약은 스토리지 모니터링과 동일하다:
 *  - 조회: 전체 범위 계정만. SAN 스위치는 vCenter 귀속이 없는 인프라 장비라 범위 계정에
 *    노출하지 않는다('vCenter 귀속 없는 데이터는 범위 계정에 노출 금지' — server/CLAUDE.md).
 *  - 변경(등록/수정/삭제/테스트/수집): adminOnly + 감사로그.
 */
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { SAN_SWITCH_TYPES, collectMethodsFor } from '../../sanswitch/types.js';
import { listDevices, saveDevice, deleteDevice, deviceInputIssue, getDeviceWithSecret } from '../../sanswitch/registry.js';
import { localSnapshots, getSnapshot, dropSnapshot } from '../../sanswitch/store.js';
import { collectDeviceNow, sanSwitchPollerStatus, pollSanSwitchOnce, testDeviceConnection } from '../../sanswitch/poller.js';
import { edgeSanSwitchSnapshots } from '../../central/sanSwitchEdge.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { requestCollect, hasPendingRequest } from '../../sanswitch/collectRequests.js';
import { loadPerfSettings, savePerfSettings, LIMITS as PERF_LIMITS } from '../../sanswitch/perfSettings.js';
import { pollPerfOnce, sanSwitchPerfStatus } from '../../sanswitch/perfPoller.js';
import { portSeries, storageSeries, storageSeriesMulti, arraySerialOf, endpointKind, perfDbStats } from '../../sanswitch/perfDb.js';
import { listDevices as listStorageDevices } from '../../storage/registry.js';
import { localSnapshots as storageLocalSnaps } from '../../storage/store.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: 'SAN 스위치 모니터링은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

/** 목록 화면용 축약 — 포트 상세(수백 행)는 빼고 요약만 보낸다(목록 응답이 MB 가 되지 않게). */
const listShape = (s) => {
  if (!s) return null;
  const { list, ...ports } = s.ports || {};
  return { ...s, ports: { ...ports, listCount: (list || []).length } };
};

export function registerSanSwitch(api) {

/**
 * 통합 조회 — 이 노드(중앙) 직접 수집분 + 전 엣지 push 분을 합쳐 장비별 최신 스냅샷 반환.
 * 같은 deviceId 가 양쪽에 있으면 최신 collectedAt 우선(스토리지 화면과 동일 규칙).
 */
api.get('/tools/sanswitch', fullScopeOnly, (_req, res) => {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgeSanSwitchSnapshots()]) {
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const devices = listDevices().map((d) => ({ ...d, snap: listShape(byId.get(d.id)), pending: hasPendingRequest(d.id) }));
  const known = new Set(devices.map((d) => d.id));
  const orphans = [...byId.values()].filter((s) => !known.has(s.deviceId)).map(listShape);
  res.json({
    devices, orphans,
    types: SAN_SWITCH_TYPES.map((t) => ({ ...t, methods: collectMethodsFor(t.type) })),
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    agents: knownAgentNames(),
    poller: sanSwitchPollerStatus(),
  });
});

/**
 * 포트 상세 — 목록 응답에서 뺀 포트 배열을 장비 단위로만 내려준다.
 * ⚠ 엣지 위임 장비는 **중앙에 문제 포트만** 올라와 있다(push.js 가 정상 포트를 뺀다 — 고RTT
 *   회선으로 매 주기 수백 행을 밀지 않기 위함). 그래서 응답에 portsOmitted 를 그대로 실어
 *   화면이 '정상 포트 N개는 엣지에만 있음'을 정직하게 안내하게 한다.
 */
api.get('/tools/sanswitch/devices/:id/ports', fullScopeOnly, (req, res) => {
  const local = getSnapshot(req.params.id);
  const edge = edgeSanSwitchSnapshots().find((s) => s.deviceId === req.params.id);
  const snap = (!local || (edge && (edge.collectedAt || 0) > (local.collectedAt || 0))) ? edge : local;
  if (!snap) return res.status(404).json({ ok: false, reason: '수집된 스냅샷이 없습니다.' });
  // 장비 일반 정보(v2.411, 사용자 요구 '장비 일반 정보 표시')를 함께 내려준다 — 예전에는
  // 모델/FOS/수집시각만 보내서, 이미 수집해 둔 WWN·Domain·시리얼·팹·존·FRU 상태가
  // 화면에 전혀 쓰이지 않고 버려지고 있었다.
  res.json({
    ok: true, deviceId: snap.deviceId, name: snap.name, model: snap.model, fabricOs: snap.fabricOs,
    collectedAt: snap.collectedAt, source: snap === edge ? `엣지(${snap.agent || ''})` : '중앙 직접 수집',
    host: snap.host || '', agent: snap.agent || '',
    serial: snap.serial || '', wwn: snap.wwn || '', domainId: snap.domainId ?? null,
    switchState: snap.switchState || '', health: snap.health || null,
    fabric: snap.fabric || null, zoning: snap.zoning || null, licenses: snap.licenses || [],
    ports: snap.ports || { list: [] }, sections: snap.sections || {}, extra: snap.extra || {},
  });
});

api.post('/tools/sanswitch/devices', adminOnly, (req, res) => {
  try {
    const saved = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: 'SAN 스위치 등록/수정', target: `${saved.name}(${saved.host})`, detail: `${saved.type}/${saved.collectMethod}${saved.agent ? ` 엣지 ${saved.agent}` : ' 중앙 직접'}` });
    res.json({ ok: true, device: saved });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/sanswitch/devices/:id', adminOnly, (req, res) => {
  const dev = listDevices().find((d) => d.id === req.params.id);
  const ok = deleteDevice(req.params.id);
  if (ok) {
    dropSnapshot(req.params.id); // 등록을 지웠는데 스냅샷이 남아 orphan 으로 되살아나지 않게
    logAudit({ user: req.user?.username, action: 'SAN 스위치 삭제', target: `${dev?.name || ''}(${req.params.id})` });
  }
  res.json({ ok });
});

/**
 * 연결 테스트 — 등록 전/수정 중 값으로 실제 접속해 본다. 스냅샷은 저장하지 않는다.
 * 보안: adminOnly + deviceInputIssue(SSRF·형식) 선검증 + 감사로그. **host 를 바꿔 테스트할 때
 * 저장된 비밀번호를 이월하지 않는다**(uagmon M3 — host 바꿔치기로 자격증명이 공격자 서버로
 * 선제 전송되는 경로 차단). 비번을 새로 입력하지 않으면 같은 host 일 때만 저장분을 쓴다.
 */
api.post('/tools/sanswitch/test', adminOnly, async (req, res) => {
  const b = req.body || {};
  const issue = deviceInputIssue(b);
  if (issue) return res.status(400).json({ ok: false, reason: issue });
  let password = String(b.password ?? '');
  if (!password && b.id) {
    const saved = getDeviceWithSecret(b.id);
    if (saved && saved.host === String(b.host || '').trim()) password = saved.password || '';
  }
  const device = { ...b, id: b.id || `test-${Date.now()}`, password };
  logAudit({ user: req.user?.username, action: 'SAN 스위치 연결 테스트', target: `${b.name || ''}(${b.host})`, detail: `${b.type}/${b.collectMethod || ''}` });
  const r = await testDeviceConnection(device, { timeoutMs: 60_000 });
  res.json(r);
});

/**
 * 지금 수집 — 중앙 직접 수집 장비는 즉시, 엣지 위임 장비는 **재수집 요청 등록**(중앙은 엣지에
 * 명령을 밀어넣을 수 없어, 엣지가 다음 config pull 때 가져가 즉시 수집·push 한다).
 */
api.post('/tools/sanswitch/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '스위치를 찾을 수 없습니다.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: 'SAN 스위치 재수집 요청(엣지)', target: `${dev.name}(${dev.id})`, detail: `엣지 ${dev.agent}` });
      return res.status(202).json({ ok: true, requested: true,
        reason: `${dup ? '이미 재수집 요청이 대기 중입니다' : '재수집 요청 등록'} — 엣지 '${dev.agent}' 의 다음 설정 pull 때 즉시 수집하고 바로 push 합니다.` });
    }
    await collectDeviceNow(req.params.id);
    logAudit({ user: req.user?.username, action: 'SAN 스위치 즉시 수집', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/* ── 포트 사용량(portperfshow) 수집·조회(v2.411, 사용자 요구) ──────────────────
 * '설정에서 주기적으로 portperfshow 를 수행해 포트 사용량을 수집하는 DB' + '차트로 보면서
 * 포트 사용량을 분석해 스토리지 사용량을 볼 수 있게'.
 */

/** 설정 조회 — 한계값·DB 현황·마지막 수집 결과를 함께(설정 화면이 서버를 단일 소스로 쓰게). */
api.get('/tools/sanswitch/perf/settings', adminOnly, async (_req, res) => {
  res.json({ ok: true, settings: loadPerfSettings(), limits: PERF_LIMITS,
    status: sanSwitchPerfStatus(), db: await perfDbStats() });
});

api.put('/tools/sanswitch/perf/settings', adminOnly, async (req, res) => {
  try {
    const before = loadPerfSettings();
    const saved = savePerfSettings(req.body || {});
    logAudit({ user: req.user?.username, action: 'SAN 포트 사용량 수집 설정 변경',
      target: saved.enabled ? '켜짐' : '꺼짐',
      detail: `주기 ${Math.round(saved.intervalMs / 1000)}초 · 표본 ${saved.sampleSeconds}초 · 보관 ${saved.retentionDays}일 (이전: ${before.enabled ? '켜짐' : '꺼짐'})` });
    res.json({ ok: true, settings: saved, limits: PERF_LIMITS, status: sanSwitchPerfStatus(), db: await perfDbStats() });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

/** 지금 1회 수집(설정이 꺼져 있어도 관리자가 눌러 시험할 수 있게 force). */
api.post('/tools/sanswitch/perf/collect', adminOnly, async (req, res) => {
  logAudit({ user: req.user?.username, action: 'SAN 포트 사용량 즉시 수집' });
  res.json(await pollPerfOnce({ force: true }));
});

/**
 * 포트별 사용량 시계열. 원시 점을 그대로 주지 않고 버킷 평균으로 내려준다(브라우저 보호).
 * 단위는 **바이트/초**(portperfshow 원단위) — 화면이 ×8 해 bps 로 환산한다.
 */
api.get('/tools/sanswitch/devices/:id/perf', fullScopeOnly, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours) || 24));
  const ports = String(req.query.ports || '').split(',').map((x) => Number(x)).filter(Number.isFinite).slice(0, 64);
  const r = await portSeries(req.params.id, { hours, ports: ports.length ? ports : null });
  res.json({ ok: true, unit: 'bytesPerSec', hours, ...r });
});

/** 연결 장비(스토리지 어레이)별 합산 시계열 — 포트가 아니라 '어느 스토리지가 얼마나 쓰이나'. */
api.get('/tools/sanswitch/devices/:id/perf/storage', fullScopeOnly, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours) || 24));
  const r = await storageSeries(req.params.id, { hours });
  res.json({ ok: true, unit: 'bytesPerSec', hours, ...r });
});

/**
 * 법인(또는 전체) 단위 스토리지 사용량 통합 분석(v2.412, 사용자 요구
 * '법인을 선택하면 그 법인의 모든 스토리지 사용량을 분석').
 *
 * 스토리지 어레이는 이중화를 위해 팹 A/B 두 스위치에 나눠 물린다 — 스위치 한 대만 보면
 * 그 어레이 트래픽의 절반만 보인다. 여기서는 법인 안의 **모든 스위치를 합산**한다.
 *
 * 덤으로, 어레이 키에서 뽑은 시리얼이 등록된 스토리지 장비의 시리얼과 일치하면 그 장비의
 * **용량 사용률**을 함께 붙여 준다. 대역폭(얼마나 바쁜가)과 용량(얼마나 찼는가)은 다른 축이라
 * 나란히 봐야 증설 판단이 된다. ⚠ 확실히 일치할 때만 붙이고, 아니면 비운다(억지 매칭 금지).
 */
api.get('/tools/sanswitch/perf/storage-summary', fullScopeOnly, async (req, res) => {
  const hours = Math.max(1, Math.min(24 * 90, Number(req.query.hours) || 24));
  // 법인은 **여러 개**를 받을 수 있다(쉼표 구분). 빈 값이면 전체.
  const dcs = String(req.query.datacenterId || '').split(',').map((x) => x.trim()).filter(Boolean);
  const dcSet = dcs.length ? new Set(dcs) : null;
  // split=1 이면 같은 어레이라도 법인마다 따로 집계한다(사용자 요구 — 복수 법인을 한꺼번에
  // 보면서도 법인 구분이 사라지지 않게). 기본은 법인이 2곳 이상일 때 자동 분리.
  const split = req.query.split == null ? dcs.length !== 1 : req.query.split === '1';
  const devices = listDevices().filter((d) => d.enabled !== false && (!dcSet || dcSet.has(String(d.datacenterId || ''))));
  const ids = devices.map((d) => d.id);
  const groupOf = split ? new Map(devices.map((d) => [String(d.id), String(d.datacenterId || '')])) : null;
  const agg = await storageSeriesMulti(ids, { hours, groupOf });

  // 등록 스토리지의 최신 스냅샷(용량) 색인 — 시리얼 정규화 후 대조.
  const norm = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');
  const stDevById = new Map(listStorageDevices().map((d) => [d.id, d]));
  // 법인별로 분리해 볼 때는 **그 법인의 스토리지 용량만** 붙여야 한다 — 그래서 키에 법인을 넣는다.
  const capBySerial = new Map();   // `${dc}\u0000${serial}` 또는 split 아니면 serial
  const capKey = (dcId, serial) => (split ? `${dcId}\u0000${serial}` : serial);
  for (const snap of [...storageLocalSnaps(), ...edgeStorageSnapshots()]) {
    if (!snap?.ok) continue;
    const d = stDevById.get(snap.deviceId) || {};
    if (dcSet && !dcSet.has(String(d.datacenterId || ''))) continue;  // 범위 밖 법인의 어레이는 붙이지 않는다
    const info = {
      deviceId: snap.deviceId, name: d.name || snap.name || '', type: d.type || '',
      totalBytes: snap.capacity?.totalBytes ?? null, usedBytes: snap.capacity?.usedBytes ?? null,
      pct: snap.capacity?.pct ?? null,
    };
    for (const key of [snap.serial, ...(snap.extra?.appliances || []).map((a) => a.serviceTag)]) {
      if (key) capBySerial.set(capKey(String(d.datacenterId || ''), norm(key)), info);
    }
  }

  const nameOf = new Map(devices.map((d) => [d.id, d.name || d.host || d.id]));
  const dcNameOf = (() => {
    try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || '(법인 미지정)'; }
    catch { return (id) => id || '(법인 미지정)'; }
  })();
  const series = agg.series.map((s) => {
    const serial = arraySerialOf(s.key);
    const capacity = serial ? (capBySerial.get(capKey(s.group ?? '', norm(serial))) || null) : null;
    return {
      ...s,
      datacenterId: s.group ?? null,
      datacenterName: s.group == null ? null : dcNameOf(s.group),
      arraySerial: serial,
      // 어레이/호스트 구분 — 법인 합산에서는 서버 HBA 가 수십 개씩 잡혀 표를 덮는다.
      // 화면 기본은 어레이만 보여주고 호스트는 따로 고를 수 있게 한다.
      endpointKind: endpointKind(s.key, { matched: !!capacity }),
      switches: s.deviceIds.map((id) => nameOf.get(id) || id),
      portCount: s.ports.length,
      capacity,
    };
  });
  const counts = series.reduce((a, s) => { a[s.endpointKind] = (a[s.endpointKind] || 0) + 1; return a; }, {});
  // 법인별 소계 — '어느 법인이 얼마나 쓰나'를 한눈에(스토리지만 합산, 호스트 제외).
  const byDc = {};
  for (const s of series) {
    if (s.endpointKind !== 'array') continue;
    const k = s.datacenterId ?? '';
    if (!byDc[k]) byDc[k] = { datacenterId: k, name: dcNameOf(k), storages: 0, avgTotal: 0, maxTotal: 0, switches: new Set() };
    byDc[k].storages++;
    byDc[k].avgTotal += s.avgTotal;
    byDc[k].maxTotal += s.maxTotal;
    for (const id of s.deviceIds) byDc[k].switches.add(id);
  }
  // 화면이 창을 닫지 않고 범위를 바꿀 수 있게, **필터와 무관한 전 법인 목록**을 함께 준다
  // (스위치가 등록된 법인만). 이게 없으면 사용자가 목록 화면으로 돌아가 칩을 다시 골라야 한다.
  const allDcs = (() => {
    const m = new Map();
    for (const d of listDevices().filter((x) => x.enabled !== false)) {
      const id = String(d.datacenterId || '');
      if (!m.has(id)) m.set(id, { id, name: dcNameOf(id), switches: 0 });
      m.get(id).switches++;
    }
    return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  })();
  res.json({
    ok: true, unit: 'bytesPerSec', hours, datacenterIds: dcs, split, allDatacenters: allDcs,
    byDatacenter: Object.values(byDc).map((x) => ({ ...x, switches: x.switches.size }))
      .sort((a, b) => b.avgTotal - a.avgTotal),
    switches: devices.map((d) => ({ id: d.id, name: d.name, host: d.host, datacenterId: d.datacenterId, datacenterName: dcNameOf(d.datacenterId) })),
    buckets: agg.buckets, bucketMs: agg.bucketMs, series, counts, unavailable: agg.unavailable || false,
  });
});

/** 이 노드 몫 전체 재수집(관리자 수동 실행 — 폴러와 재진입 가드를 공유한다). */
api.post('/tools/sanswitch/poll', adminOnly, async (req, res) => {
  logAudit({ user: req.user?.username, action: 'SAN 스위치 전체 수집 실행' });
  res.json(await pollSanSwitchOnce());
});

}
