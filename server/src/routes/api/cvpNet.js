/**
 * CVP 네트워크 기능 라우트(v3.38 — docs/design/cvp-network-features · 사용자 2026-11-25 "나머지 네트워크 기능도 구현해줘", 2차 범위).
 *
 *  ④ ⑩ 링크 품질(불량 링크 · 플랩)        GET  /tools/cvp/linkq
 *  ⑤    미사용 포트 회수                   GET  /tools/cvp/portplan/reclaim
 *  ⑨    포트 고갈 · 업링크 포화 예측        GET  /tools/cvp/portplan/forecast
 *  ⑮    GBIC 열화 추세 · 재고               GET  /tools/cvp/optics/trend
 *  ⑥ ⑦ 토폴로지 · 양끝 불일치             GET  /tools/cvp/topology
 *  ①    MAC · IP · 이름으로 위치 찾기        GET  /tools/cvp/locate
 *  ⑬    작업 전후 비교(스냅샷)              GET/POST /tools/cvp/snapshots · DELETE /tools/cvp/snapshots/:id · GET /tools/cvp/compare
 *
 * 접근 규약은 형제 cvp.js 와 같다: 조회 = `requirePerm('tools')` + **전체 범위 계정만**(fullScopeOnly — 범위 계정 403).
 *   스냅샷 찍기 · 지우기는 상태 변경 — `requireRole('admin','operator')` + tools + 전체 범위 + 감사 로그.
 *   비-admin 응답은 설명 · LLDP 문자열의 주소를 가리고(maskErrText) BGP 피어 주소를 비운다(maskPeers 와 같은 등급).
 * 판정은 cvp/{linkq,portplan,opticstrend,topology,locate,snapdiff}.js 하나씩(웹은 그리기만). 전부 중앙 DB · 인벤토리 읽기 — 장비 · 엣지 왕복 0.
 * 무거운 조회라 화면은 마운트 1회 + 새로고침(폴링 없음). 큰 조회는 날 단위 조각 + 시간 기준 양보(db.js).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { isAdminReq } from '../../auth/addressMask.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { listServers } from '../../cvp/registry.js';
import { loadSettings } from '../../cvp/settings.js';
import * as cdb from '../../cvp/db.js';
import { corpResolver, rowOwnerOf } from '../../cvp/overview.js';
import { rankLinks, FLAP_MIN_DEFAULT } from '../../cvp/linkq.js';
import { reclaimCandidates, exhaustForecast, saturationForecast, IDLE_CHOICES, FORECAST_MIN_DAYS, FORECAST_WINDOW_DAYS, UPLINK_SAT_PCT } from '../../cvp/portplan.js';
import { opticTrends, opticInventory, TREND_DAYS, TREND_MIN_DAYS } from '../../cvp/opticstrend.js';
import { buildTopology, switchIndex, uplinkPortsOf, normPort } from '../../cvp/topology.js';
import { parseQuery, subjectsOf, placeRows, MANY_MACS } from '../../cvp/locate.js';
import { snapshotBody, diffSnapshots } from '../../cvp/snapdiff.js';
import { store } from '../../store.js';
import { capStr } from '../../util/capStr.js';
import { numOrNull } from '../../util/numOrNull.js';
import { kickDemo, maskErrText } from './cvp.js';
import { listDatacenters } from '../../datacenter/store.js';

const writer = requireRole('admin', 'operator');
const toolsPerm = requirePerm('tools');
const fullScopeOnly = fullScopeOnlyWith('CVP 네트워크 스위치는 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.');
const DB_DOWN = { ok: false, reason: '중앙 CVP DB 를 열지 못했습니다.' };
const PORTS_MAX = 200_000;
const devKey = (a, c, k) => `${a}\u0000${c}\u0000${k}`;
const hostsOf = () => listServers().map((x) => x.host);
/** 법인 목록(cvp.js dcList 와 같은 모양 — 그쪽은 registerCvp 안 지역 함수다). */
const dcList = () => { try { return listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { return []; } };

/** 담당 장비 · 포트 행(등록부 담당만 — 옛 엣지 행을 섞지 않는다) + 법인. cvpId 가 있으면 그 CVP 만. */
async function baseOf({ cvpId = null, withPorts = true } = {}) {
  const servers = listServers();
  const own = rowOwnerOf(servers);
  const dl = await cdb.listDeviceRows(cvpId ? { cvpId } : {});
  if (dl.unavailable) return null;
  const corpOf = corpResolver(servers, dcList());
  const nameOf = new Map(servers.map((x) => [String(x.id), x.name || x.id]));
  const devices = dl.rows.filter(own).map((d) => ({ ...d, corpName: corpOf(d.cvpId).corpName, cvpName: nameOf.get(String(d.cvpId)) || d.cvpId }));
  const keys = new Set(devices.map((d) => devKey(d.agent, d.cvpId, d.key)));
  let ports = []; let truncated = false;
  if (withPorts) {
    const pr = await cdb.portLatestRows({ ...(cvpId ? { cvpIds: [cvpId] } : {}), limit: PORTS_MAX });
    if (pr.unavailable) return null;
    truncated = !!pr.truncated;
    ports = pr.rows.filter((r) => keys.has(devKey(r.agent, r.cvp_id, r.device_key))).map((r) => ({
      agent: r.agent, cvpId: r.cvp_id, key: r.device_key, hostname: r.hostname || r.device_key, port: r.port, oper: r.oper || 'unknown', admin: r.admin || 'unknown',
      speedBps: r.speed_bps ?? null, desc: r.descr == null ? null : r.descr, lag: r.lag ?? null, vlan: r.vlan ?? null, mtu: r.mtu ?? null, duplex: r.duplex ?? null,
    }));
  }
  return { servers, devices, keys, ports, truncated };
}
const cvpIdOf = (req) => (typeof req.query.cvpId === 'string' && req.query.cvpId ? req.query.cvpId : null);
const unknownCvp = (id) => id && !listServers().some((x) => String(x.id) === id);

export function registerCvpNet(api) {
  // ── ④ ⑩ 링크 품질 ──────────────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/linkq', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const b = await baseOf({ cvpId });
    if (!b) return res.status(503).json(DB_DOWN);
    const [err, flap] = await Promise.all([cdb.errWindow({ days }), cdb.flapWindow({ days })]);
    if (err.unavailable || flap.unavailable) return res.status(503).json(DB_DOWN);
    const s = loadSettings();
    const devMap = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), { parts: d.partsList }]));
    const r = rankLinks({ ports: b.ports, devices: devMap, err: err.map, flap: flap.map, warnDbm: s.xcvrRxWarnDbm, flapMin: FLAP_MIN_DEFAULT });
    const hosts = hostsOf();
    const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
    res.json({
      days, from: err.from, rows: r.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', desc: admin ? x.desc : maskErrText(x.desc, hosts) })),
      counts: r.counts, omitted: r.omitted, flapMin: FLAP_MIN_DEFAULT, warnDbm: s.xcvrRxWarnDbm,
      flapRecordSince: flap.recordSince, intervalMs: s.intervalMs, ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
    });
  });

  // ── ⑤ 미사용 포트 회수 ──────────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/portplan/reclaim', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const idle = IDLE_CHOICES.includes(Number(req.query.idle)) ? Number(req.query.idle) : 90;
    const b = await baseOf({ cvpId });
    if (!b) return res.status(503).json(DB_DOWN);
    // v3.38 이전 기록의 마지막 링크 날을 옮기는 일은 처음 한 번 — 기다리지 않는다(끝나면 다음 조회부터 반영 · 화면이 '정리 중' 을 밝힌다).
    const done = await cdb.lastLinkBackfilled();
    if (!done) cdb.backfillLastLink();
    const ll = await cdb.lastLinkAll();
    if (ll.unavailable) return res.status(503).json(DB_DOWN);
    const r = reclaimCandidates({ ports: b.ports, last: ll.last, first: ll.first, idleDays: idle });
    const hosts = hostsOf();
    const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
    res.json({ idle, choices: IDLE_CHOICES, rows: r.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', desc: admin ? x.desc : maskErrText(x.desc, hosts) })),
      counts: r.counts, omitted: r.omitted, backfilling: !ll.backfilled, ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }) });
  });

  // ── ⑨ 포트 고갈 · 업링크 포화 예측 ──────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/portplan/forecast', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const b = await baseOf({ cvpId });
    if (!b) return res.status(503).json(DB_DOWN);
    const [ser, lldp] = await Promise.all([cdb.devPortSeries({ days: FORECAST_WINDOW_DAYS }), cdb.lldpAll()]);
    if (ser.unavailable || lldp.unavailable) return res.status(503).json(DB_DOWN);
    const ex = exhaustForecast({ devices: b.devices, series: ser.map });
    // 업링크 = LLDP 이웃이 CVP 스위치인 포트(링크가 올라온 것). LLDP 를 읽지 못한 장비는 40G 이상 · 링크 있음 포트를 업링크로 본다(basis 'speed' — 추정).
    const idx = switchIndex(b.devices);
    const lrows = lldp.rows.filter((r) => b.keys.has(devKey(r.agent, r.cvpId, r.key)));
    const ups = uplinkPortsOf(lrows, idx);
    const peerOf = new Map(lrows.map((r) => [`${devKey(r.agent, r.cvpId, r.key)}\u0000${normPort(r.port)}`, r.sysName]));
    const uplinks = [];
    for (const p of b.ports) {
      if (p.oper !== 'up') continue;
      const dk = devKey(p.agent, p.cvpId, p.key);
      const np = normPort(p.port);
      const read = lldp.meta.get(dk)?.at != null;
      if (ups.get(dk)?.has(np)) uplinks.push({ ...p, peer: peerOf.get(`${dk}\u0000${np}`) || '', basis: 'lldp' });
      else if (!read && numOrNull(p.speedBps) != null && p.speedBps >= 40e9) uplinks.push({ ...p, peer: '', basis: 'speed' });
    }
    const us = await cdb.utilMaxSeries(uplinks, { days: FORECAST_WINDOW_DAYS });
    if (us.unavailable) return res.status(503).json(DB_DOWN);
    const sat = saturationForecast({ uplinks, series: us.map });
    const hosts = hostsOf();
    const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
    res.json({
      exhaust: { rows: ex.rows, counts: ex.counts },
      saturation: { rows: sat.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', peer: admin ? x.peer : maskErrText(x.peer, hosts) })), counts: sat.counts, satPct: UPLINK_SAT_PCT,
        ...(us.truncated ? { truncated: true } : {}) },
      minDays: FORECAST_MIN_DAYS, windowDays: FORECAST_WINDOW_DAYS, ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
    });
  });

  // ── ⑮ GBIC 열화 추세 · 재고 ─────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/optics/trend', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const b = await baseOf({ cvpId, withPorts: false });
    if (!b) return res.status(503).json(DB_DOWN);
    const xs = await cdb.xcvrSeries({ days: 90 });
    if (xs.unavailable) return res.status(503).json(DB_DOWN);
    const own = new Map();
    for (const [k, v] of xs.map) { const [a, c, d] = k.split('\u0000'); if (b.keys.has(devKey(a, c, d))) own.set(k, v); }
    const s = loadSettings();
    const names = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), { hostname: d.hostname || d.key, cvpId: d.cvpId, corpName: d.corpName }]));
    const t = opticTrends({ series: own, names, warnDbm: s.xcvrRxWarnDbm, faultDbm: s.xcvrRxFaultDbm });
    const inv = opticInventory(b.devices);
    res.json({ trend: t, inventory: inv, trendDays: TREND_DAYS, minDays: TREND_MIN_DAYS });
  });

  // ── ⑥ ⑦ 토폴로지 · 양끝 불일치 ──────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/topology', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const b = await baseOf({ cvpId });
    if (!b) return res.status(503).json(DB_DOWN);
    const lldp = await cdb.lldpAll();
    if (lldp.unavailable) return res.status(503).json(DB_DOWN);
    const snap = store.get() || {};
    const hostNames = new Set((snap.hosts || []).map((h) => String(h?.name || '').toLowerCase().split('.')[0]).filter((n) => n.length >= 3));
    const t = buildTopology({ devices: b.devices, lldp: lldp.rows.filter((r) => b.keys.has(devKey(r.agent, r.cvpId, r.key))), lldpMeta: lldp.meta, ports: b.ports, hostNames });
    const hosts = hostsOf();
    const mk = (v) => (admin || v == null ? v : maskErrText(String(v), hosts));
    res.json({
      nodes: t.nodes, counts: t.counts, lldpReadDevices: t.lldpReadDevices, devices: b.devices.length,
      links: t.links.map((l) => ({ ...l, items: l.items ? l.items.map((x) => (x.field.startsWith('desc') ? { ...x, a: mk(x.a), b: mk(x.b) } : x)) : null })),
      ...(lldp.truncated ? { lldpTruncated: true } : {}), ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
    });
  });

  // ── ① 위치 찾기 ────────────────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/locate', toolsPerm, fullScopeOnly, async (req, res) => {
    const q = parseQuery(typeof req.query.q === 'string' ? req.query.q : '');
    if (q.kind === 'empty') return res.status(400).json({ ok: false, reason: 'MAC · IP · 이름 중 하나를 넣어 주세요.' });
    if (q.kind === 'bad') return res.status(400).json({ ok: false, reason: q.reason });
    const b = await baseOf({ withPorts: false });
    if (!b) return res.status(503).json(DB_DOWN);
    const snap = store.get() || {};
    const subj = subjectsOf(q, snap);
    const macs = [...new Set([...(q.kind === 'mac' ? [q.mac] : []), ...subj.subjects.flatMap((x) => x.macs)])].slice(0, 256);
    const owners = b.servers.map((sv) => ({ agent: String(sv.agent ?? '').trim() ? sv.agent : '', cvpId: sv.id }));
    const own = (r) => b.keys.has(devKey(r.agent, r.cvpId, r.key));
    const [fdb, ep, lldp, l2] = await Promise.all([
      macs.length ? cdb.fdbByMacs(macs) : { rows: [] }, macs.length ? cdb.endpointsByMacs(macs, { owners }) : { rows: [] }, cdb.lldpAll(), cdb.l2Status(owners),
    ]);
    if (lldp.unavailable) return res.status(503).json(DB_DOWN);
    const fdbRows = (fdb.rows || []).filter(own); const epRows = (ep.rows || []).filter(own);
    const ups = uplinkPortsOf(lldp.rows.filter(own), switchIndex(b.devices));
    for (const d of b.devices) { const dk = devKey(d.agent, d.cvpId, d.key); if (lldp.meta.get(dk)?.at != null && !ups.has(dk)) ups.set(dk, new Set()); }
    const devs = [...new Map(fdbRows.map((r) => [devKey(r.agent, r.cvpId, r.key), { agent: r.agent, cvpId: r.cvpId, key: r.key }])).values()];
    const macCount = devs.length ? await cdb.fdbPortTotals(devs) : new Map();
    const placed = placeRows({ fdb: fdbRows, ep: epRows, uplinks: ups, macCount });
    const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
    const withCorp = (x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '' });
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    res.json({
      query: { kind: q.kind, value: q.kind === 'mac' ? q.mac : q.kind === 'ip' ? q.ip : q.name },
      subjects: subj.subjects.map((x) => ({ ...x, vcenterName: vcName.get(x.vcenterId) || x.vcenterId || '' })), subjectsTruncated: subj.truncated,
      macs, edge: placed.edge.map(withCorp), transit: placed.transit.map(withCorp), manyMacs: MANY_MACS,
      l2: { devices: b.devices.length, fdbDevices: l2.fdbDevices ?? 0, fdbFailing: l2.fdbFailing ?? 0, lastAt: l2.lastAt ?? null, ...(l2.unavailable ? { unavailable: true } : {}) },
      ...(fdb.truncated ? { fdbTruncated: true } : {}),
    });
  });

  // ── ⑬ 작업 전후 비교 ──────────────────────────────────────────────────────────────────────────────────────
  /** 지금 중앙 DB 의 최신값으로 장비별 스냅샷 본문을 만든다(스냅샷 찍기 · '지금' 과 비교가 같은 함수를 쓴다). */
  async function currentBodies(cvpId) {
    const b = await baseOf({ cvpId });
    if (!b) return null;
    const lldp = await cdb.lldpAll();
    if (lldp.unavailable) return null;
    const portsBy = new Map(); const lldpBy = new Map();
    for (const p of b.ports) { const k = devKey(p.agent, p.cvpId, p.key); if (!portsBy.has(k)) portsBy.set(k, []); portsBy.get(k).push(p); }
    for (const r of lldp.rows) { const k = devKey(r.agent, r.cvpId, r.key); if (!b.keys.has(k)) continue; if (!lldpBy.has(k)) lldpBy.set(k, []); lldpBy.get(k).push(r); }
    const bodies = b.devices.slice(0, cdb.SNAP_DEV_MAX).map((d) => {
      const k = devKey(d.agent, d.cvpId, d.key);
      const read = lldp.meta.get(k)?.at != null;
      return { agent: d.agent, cvpId: d.cvpId, key: d.key, body: snapshotBody({ device: d, ports: portsBy.get(k) || [], lldp: read ? { read: true, rows: lldpBy.get(k) || [] } : null }) };
    });
    return { bodies, truncated: b.devices.length > cdb.SNAP_DEV_MAX || b.truncated };
  }
  let snapBusy = false;
  api.get('/tools/cvp/snapshots', toolsPerm, fullScopeOnly, async (req, res) => {
    const r = await cdb.listSnaps();
    if (r.unavailable) return res.status(503).json(DB_DOWN);
    const nameOf = new Map(listServers().map((x) => [String(x.id), x.name || x.id]));
    res.json({ snapshots: r.rows.map((x) => ({ ...x, cvpName: x.cvpId ? (nameOf.get(String(x.cvpId)) || x.cvpId) : '' })), max: cdb.SNAP_MAX, retentionDays: cdb.SNAP_RETENTION_DAYS, busy: snapBusy });
  });
  api.post('/tools/cvp/snapshots', writer, toolsPerm, fullScopeOnly, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const cvpId = typeof body.cvpId === 'string' && body.cvpId ? body.cvpId : null;
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const label = capStr(typeof body.label === 'string' ? body.label.trim() : '', 120);
    if (snapBusy) return res.status(409).json({ ok: false, reason: '다른 스냅샷을 저장하는 중입니다 — 끝난 뒤 다시 누르세요.' });
    snapBusy = true;
    try {
      const cur = await currentBodies(cvpId);
      if (!cur) return res.status(503).json(DB_DOWN);
      if (!cur.bodies.length) return res.status(409).json({ ok: false, reason: '저장할 장비가 없습니다(수집된 CVP 장비 0대).' });
      const r = await cdb.createSnap({ by: req.user?.username || '', label, cvpId, bodies: cur.bodies });
      if (r.unavailable) return res.status(503).json(DB_DOWN);
      logAudit({ user: req.user?.username, action: 'CVP 스냅샷 저장', target: `cvp-snapshot/${r.id}`, detail: `장비 ${r.devices}대 · ${cvpId ? `CVP ${cvpId}` : '모든 CVP'}${label ? ` · ${label}` : ''}` });
      res.json({ ok: true, id: r.id, devices: r.devices, bytes: r.bytes, ...(cur.truncated ? { truncated: true } : {}) });
    } catch (e) {
      console.warn(`[cvp-net] 스냅샷 저장 실패: ${e.message}`);
      res.status(500).json({ ok: false, reason: '스냅샷을 저장하지 못했습니다(서버 로그 참고).' });
    } finally { snapBusy = false; }
  });
  api.delete('/tools/cvp/snapshots/:id', writer, toolsPerm, fullScopeOnly, async (req, res) => {
    const id = numOrNull(req.params.id);
    if (id == null || !Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, reason: '스냅샷 번호가 올바르지 않습니다.' });
    const r = await cdb.deleteSnap(id);
    if (r.unavailable) return res.status(503).json(DB_DOWN);
    if (!r.deleted) return res.status(404).json({ ok: false, reason: '없는 스냅샷입니다.' });
    logAudit({ user: req.user?.username, action: 'CVP 스냅샷 삭제', target: `cvp-snapshot/${id}`, detail: '' });
    res.json({ ok: true });
  });
  api.get('/tools/cvp/compare', toolsPerm, fullScopeOnly, async (req, res) => {
    const admin = isAdminReq(req);
    const aId = numOrNull(req.query.a);
    const bRaw = typeof req.query.b === 'string' ? req.query.b : 'now';
    const cvpId = cvpIdOf(req);
    if (aId == null) return res.status(400).json({ ok: false, reason: '비교할 스냅샷(a)을 고르세요.' });
    const A = await cdb.readSnap(aId);
    if (A && A.unavailable) return res.status(503).json(DB_DOWN);
    if (!A) return res.status(404).json({ ok: false, reason: '없는 스냅샷이거나 저장이 끝나지 않았습니다.' });
    let B; let bHead;
    if (bRaw === 'now') {
      const cur = await currentBodies(cvpId || A.head.cvpId);
      if (!cur) return res.status(503).json(DB_DOWN);
      B = new Map(cur.bodies.map((x) => [devKey(x.agent, x.cvpId, x.key), x.body]));
      bHead = { id: null, at: Date.now(), label: '지금', now: true };
    } else {
      const bId = numOrNull(bRaw);
      if (bId == null) return res.status(400).json({ ok: false, reason: '비교 대상(b)이 올바르지 않습니다.' });
      const Bs = await cdb.readSnap(bId);
      if (Bs && Bs.unavailable) return res.status(503).json(DB_DOWN);
      if (!Bs) return res.status(404).json({ ok: false, reason: '없는 스냅샷이거나 저장이 끝나지 않았습니다.' });
      B = Bs.devices; bHead = Bs.head;
    }
    // 범위를 맞춘다: 한쪽이 한 CVP 만 찍었으면 다른 쪽도 그 CVP 만(나머지를 '사라짐 · 새로 생김' 으로 지어내지 않게). 요청 cvpId 가 있으면 그것.
    const only = cvpId || A.head.cvpId || bHead.cvpId || null;
    const keep = (m) => (only ? new Map([...m].filter(([k]) => k.split('\u0000')[1] === String(only))) : m);
    const d = diffSnapshots(keep(A.devices), keep(B));
    const hosts = hostsOf();
    const mk = (v) => (admin || v == null ? v : maskErrText(String(v), hosts));
    const devices = d.devices.map((x) => ({ ...x, changes: x.changes.map((c) => {
      if (admin) return c;
      // BGP 피어 주소는 장비 관리 주소와 같은 등급(cvp.js maskPeers) — 비-admin 에는 VRF 만 남긴다.
      if (c.kind === 'bgp') return { ...c, item: `${mk(String(c.item).split('|')[0])}|(주소 가림)` };
      if ((c.kind === 'port' && c.field === 'desc') || c.kind === 'lldp') return { ...c, before: mk(c.before), after: mk(c.after) };
      return c;
    }) }));
    res.json({ a: A.head, b: bHead, scopeCvpId: only, devices, counts: d.counts, unchanged: d.unchanged, omitted: d.omitted, ...(admin ? {} : { addressHidden: true }) });
  });
}
