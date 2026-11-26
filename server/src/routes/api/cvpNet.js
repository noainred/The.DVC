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
 *  ③    버전 준수(v3.41)                   GET  /tools/cvp/compliance
 *  ⑧    MLAG · 포트 채널 이중화(v3.41)      GET  /tools/cvp/redundancy
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
import { reclaimCandidates, exhaustForecast, saturationForecastAsync, IDLE_CHOICES, FORECAST_MIN_DAYS, FORECAST_WINDOW_DAYS, UPLINK_SAT_PCT } from '../../cvp/portplan.js';
import { opticTrendsAsync, opticInventory, TREND_DAYS, TREND_MIN_DAYS } from '../../cvp/opticstrend.js';
import { HORIZON_DAYS } from '../../cvp/trend.js';
import { heavyJson, heavyKey } from '../../cvp/heavyGate.js';   // v3.42: 무거운 조회 동시 상한 + 같은 조회 합류(3회차 다시 설계)
import { buildTopology, switchIndex, uplinkPortsOf, hostPortsOf, normPort, shortOf } from '../../cvp/topology.js';
import { parseQuery, subjectsOf, placeRows, MANY_MACS } from '../../cvp/locate.js';
import { snapshotBody, diffSnapshots } from '../../cvp/snapdiff.js';
import { complianceFleet } from '../../cvp/compliance.js';     // v3.41 ③
import { redundancyFleet } from '../../cvp/redundancy.js';    // v3.41 ⑧
import { store } from '../../store.js';
import { capStr } from '../../util/capStr.js';
import { numOrNull } from '../../util/numOrNull.js';
import { createYielder } from '../../util/timeSlice.js';
import { kickDemo, maskErrText, maskMlag } from './cvp.js';
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

/**
 * 담당 장비 · 포트 행(등록부 담당만 — 옛 엣지 행을 섞지 않는다) + 법인. cvpId 가 있으면 그 CVP 만.
 * v3.42(버그 점검 1회차):
 *  · 포트는 장비마다 조각으로 읽고 양보한다(db.portRowsOf — 전량 동기 읽기가 요청마다 이벤트 루프를 250~360ms 멈췄다 · A3-F3 · A4-F1).
 *  · 포트 목록을 못 읽은 장비의 옛 행은 쓰지 않는다(portsUnread 로 센다 — A2-F2: 옛 oper 로 채널 '정상' 을 판정했다).
 *  · VLAN · 채널을 읽은 장비(info.cfgReadAt)의 빈 값(DB 에서 NULL)은 '없음'('')으로 돌린다 — 저장소가 '' 을 NULL 로 바꿔 양끝 비교 · 전후 비교가
 *    채널 소속을 늘 '비교 못 함' 으로 보았다(A1-01 · A1-02 · A2-F1). 일부만 읽은 장비(lagPartial)는 그대로 null(모름).
 *  · 같은 조건의 요청이 겹치면 진행 중인 결과를 함께 쓴다(값은 요청마다 새로 읽는다 — 기억하지 않는다).
 */
const _baseFlight = new Map();
function baseOf(opts = {}) {
  const k = `${opts.cvpId || ''}\u0000${opts.withPorts !== false}`;
  if (_baseFlight.has(k)) return _baseFlight.get(k);
  const p = baseOfInner(opts).finally(() => _baseFlight.delete(k));
  _baseFlight.set(k, p);
  return p;
}
async function baseOfInner({ cvpId = null, withPorts = true } = {}) {
  const servers = listServers();
  const own = rowOwnerOf(servers);
  const dl = await cdb.listDeviceRows(cvpId ? { cvpId } : {});
  if (dl.unavailable) return null;
  const corpOf = corpResolver(servers, dcList());
  const nameOf = new Map(servers.map((x) => [String(x.id), x.name || x.id]));
  const devices = dl.rows.filter(own).map((d) => ({ ...d, corpName: corpOf(d.cvpId).corpName, cvpName: nameOf.get(String(d.cvpId)) || d.cvpId }));
  const keys = new Set(devices.map((d) => devKey(d.agent, d.cvpId, d.key)));
  let ports = []; let truncated = false; let portsUnread = 0;
  if (withPorts) {
    const pr = await cdb.portRowsOf(devices, { limit: PORTS_MAX });
    if (pr.unavailable) return null;
    truncated = !!pr.truncated; portsUnread = pr.unread;
    const cfg = new Map(devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.info && typeof d.info === 'object' ? d.info.cfgReadAt || null : null]));
    ports = pr.rows.map((r) => {
      const c = cfg.get(devKey(r.agent, r.cvpId, r.key));
      const lagRead = !!(c && c.lag && !c.lagPartial); const vlanRead = !!(c && c.vlan && !c.vlanPartial);
      return { ...r, lag: r.lag ?? (lagRead ? '' : null), vlan: r.vlan ?? (vlanRead ? '' : null) };
    });
  }
  return { servers, devices, keys, ports, truncated, portsUnread };
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
    return heavyJson(req, res, heavyKey('linkq', admin, cvpId, days), async () => {
      const b = await baseOf({ cvpId });
      if (!b) return { status: 503, body: DB_DOWN };
      const [err, flap] = await Promise.all([cdb.errWindow({ days }), cdb.flapWindow({ days })]);
      if (err.unavailable || flap.unavailable) return { status: 503, body: DB_DOWN };
      const s = loadSettings();
      const devMap = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), { parts: d.partsList }]));
      const r = rankLinks({ ports: b.ports, devices: devMap, err: err.map, flap: flap.map, warnDbm: s.xcvrRxWarnDbm, flapMin: FLAP_MIN_DEFAULT });
      const hosts = hostsOf();
      const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
      return { body: {
        days, from: err.from, rows: r.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', desc: admin ? x.desc : maskErrText(x.desc, hosts) })),
        counts: r.counts, omitted: r.omitted, flapMin: FLAP_MIN_DEFAULT, warnDbm: s.xcvrRxWarnDbm,
        flapRecordSince: flap.recordSince, intervalMs: s.intervalMs, ...(b.portsUnread ? { portsUnread: b.portsUnread } : {}), ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
      } };
    });
  });

  // ── ⑤ 미사용 포트 회수 ──────────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/portplan/reclaim', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const idle = IDLE_CHOICES.includes(Number(req.query.idle)) ? Number(req.query.idle) : 90;
    return heavyJson(req, res, heavyKey('reclaim', admin, cvpId, idle), async () => {
      const b = await baseOf({ cvpId });
      if (!b) return { status: 503, body: DB_DOWN };
      // v3.38 이전 기록의 마지막 링크 날을 옮기는 일은 처음 한 번 — 기다리지 않는다(끝나면 다음 조회부터 반영 · 화면이 '정리 중' 을 밝힌다).
      const done = await cdb.lastLinkBackfilled();
      if (!done) cdb.backfillLastLink();
      const ll = await cdb.lastLinkAll();
      if (ll.unavailable) return { status: 503, body: DB_DOWN };
      const r = reclaimCandidates({ ports: b.ports, last: ll.last, first: ll.first, idleDays: idle });
      const hosts = hostsOf();
      const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
      return { body: { idle, choices: IDLE_CHOICES, rows: r.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', desc: admin ? x.desc : maskErrText(x.desc, hosts) })),
        counts: r.counts, omitted: r.omitted, backfilling: !ll.backfilled, ...(ll.truncated ? { lastLinkTruncated: true } : {}), ...(b.portsUnread ? { portsUnread: b.portsUnread } : {}), ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }) } };
    });
  });

  // ── ⑨ 포트 고갈 · 업링크 포화 예측 ──────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/portplan/forecast', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    return heavyJson(req, res, heavyKey('forecast', admin, cvpId), async () => {
      const b = await baseOf({ cvpId });
      if (!b) return { status: 503, body: DB_DOWN };
      const [ser, lldp] = await Promise.all([cdb.devPortSeries({ days: FORECAST_WINDOW_DAYS }), cdb.lldpAll()]);
      if (ser.unavailable || lldp.unavailable) return { status: 503, body: DB_DOWN };
      const ex = exhaustForecast({ devices: b.devices, series: ser.map });
      // 업링크 = LLDP 이웃이 CVP 스위치인 포트(링크가 올라온 것). LLDP 를 읽지 못한 장비는 40G 이상 · 링크 있음 포트를 업링크로 본다(basis 'speed' — 추정).
      const idx = switchIndex(b.devices);
      const lrows = lldp.rows.filter((r) => b.keys.has(devKey(r.agent, r.cvpId, r.key)));
      const ups = uplinkPortsOf(lrows, idx);
      // v3.42(3회차 A4-F4): 이 구간(전 LLDP 행 · 전 포트)이 예측 라우트의 가장 긴 한 덩어리(97~148ms)였다 — 시간 기준 양보.
      const yv = createYielder(15);
      const peerOf = new Map();
      for (const r of lrows) { peerOf.set(`${devKey(r.agent, r.cvpId, r.key)}\u0000${normPort(r.port)}`, r.sysName); await yv(); }
      const uplinks = [];
      for (const p of b.ports) {
        await yv();
        if (p.oper !== 'up') continue;
        const dk = devKey(p.agent, p.cvpId, p.key);
        const np = normPort(p.port);
        const read = lldp.meta.get(dk)?.at != null;
        if (ups.get(dk)?.has(np)) uplinks.push({ ...p, peer: peerOf.get(`${dk}\u0000${np}`) || '', basis: 'lldp' });
        else if (!read && numOrNull(p.speedBps) != null && p.speedBps >= 40e9) uplinks.push({ ...p, peer: '', basis: 'speed' });
      }
      // v3.42(2회차 A4-F6): 상한 밖 업링크는 계열을 못 읽은 것 — '기록 부족' 으로 세지 않고 빼서 따로 센다(seriesUnread). LLDP 로 확인한 업링크를 먼저 · 추정(속도)은 뒤.
      uplinks.sort((x, y) => (x.basis === 'lldp' ? 0 : 1) - (y.basis === 'lldp' ? 0 : 1));
      const looked = uplinks.slice(0, cdb.UPLINK_SERIES_MAX);
      const us = await cdb.utilMaxSeries(looked, { days: FORECAST_WINDOW_DAYS });
      if (us.unavailable) return { status: 503, body: DB_DOWN };
      const sat = await saturationForecastAsync({ uplinks: looked, series: us.map });
      const hosts = hostsOf();
      const corp = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), d.corpName]));
      return { body: {
        exhaust: { rows: ex.rows, counts: ex.counts, pointsRows: ex.pointsRows },
        saturation: { rows: sat.rows.map((x) => ({ ...x, corpName: corp.get(devKey(x.agent, x.cvpId, x.key)) || '', peer: admin ? x.peer : maskErrText(x.peer, hosts) })), counts: sat.counts, satPct: UPLINK_SAT_PCT,
          omitted: sat.omitted || 0, pointsRows: sat.pointsRows, ...(uplinks.length > looked.length ? { truncated: true, seriesUnread: uplinks.length - looked.length } : {}) },
        minDays: FORECAST_MIN_DAYS, windowDays: FORECAST_WINDOW_DAYS, horizonDays: HORIZON_DAYS, ...(b.portsUnread ? { portsUnread: b.portsUnread } : {}), ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
      } };
    });
  });

  // ── ⑮ GBIC 열화 추세 · 재고 ─────────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/optics/trend', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    return heavyJson(req, res, heavyKey('optics-trend', false, cvpId), async () => {
      const b = await baseOf({ cvpId, withPorts: false });
      if (!b) return { status: 503, body: DB_DOWN };
      // v3.42(버그 점검 1회차 A4-F2): 회귀는 최근 TREND_DAYS 일만 쓴다 — 90일(135만 행 · 힙 +260MB)을 읽지 않는다. 7일 더 읽어 막 끊긴 GBIC 은 '오래됨' 으로 보인다.
      const xs = await cdb.xcvrSeries({ days: TREND_DAYS + 7, keep: (dk) => b.keys.has(dk) });
      if (xs.unavailable) return { status: 503, body: DB_DOWN };
      const own = xs.map;
      const s = loadSettings();
      const names = new Map(b.devices.map((d) => [devKey(d.agent, d.cvpId, d.key), { hostname: d.hostname || d.key, cvpId: d.cvpId, corpName: d.corpName }]));
      const t = await opticTrendsAsync({ series: own, names, warnDbm: s.xcvrRxWarnDbm, faultDbm: s.xcvrRxFaultDbm });
      const inv = opticInventory(b.devices);
      return { body: { trend: t, inventory: inv, trendDays: TREND_DAYS, minDays: TREND_MIN_DAYS, horizonDays: HORIZON_DAYS } };
    });
  });

  /** 가상화 호스트 짧은 이름(소문자 · IP 이름은 통째로) — 토폴로지 · 위치 찾기가 같은 함수를 쓴다(v3.42 2회차 A3-F2: 사본 두 벌이 IP 이름을 첫 옥텟으로 줄였다). */
  const hostNamesOf = (snap) => new Set((snap.hosts || []).map((h) => shortOf(h?.name || '')).filter((n) => n.length >= 3));

  // ── ⑥ ⑦ 토폴로지 · 양끝 불일치 ──────────────────────────────────────────────────────────────────────────────
  api.get('/tools/cvp/topology', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const admin = isAdminReq(req);
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    return heavyJson(req, res, heavyKey('topology', admin, cvpId), async () => {
      const b = await baseOf({ cvpId });
      if (!b) return { status: 503, body: DB_DOWN };
      const lldp = await cdb.lldpAll();
      if (lldp.unavailable) return { status: 503, body: DB_DOWN };
      const snap = store.get() || {};
      const hostNames = hostNamesOf(snap);
      const t = buildTopology({ devices: b.devices, lldp: lldp.rows.filter((r) => b.keys.has(devKey(r.agent, r.cvpId, r.key))), lldpMeta: lldp.meta, ports: b.ports, hostNames });
      const hosts = hostsOf();
      const mk = (v) => (admin || v == null ? v : maskErrText(String(v), hosts));
      return { body: {
        nodes: t.nodes, counts: t.counts, lldpReadDevices: t.lldpReadDevices, devices: b.devices.length,
        links: t.links.map((l) => ({ ...l, items: l.items ? l.items.map((x) => (x.field.startsWith('desc') ? { ...x, a: mk(x.a), b: mk(x.b) } : x)) : null })),
        ...(lldp.truncated ? { lldpTruncated: true } : {}), ...(b.portsUnread ? { portsUnread: b.portsUnread } : {}), ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }),
      } };
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
    const hostNames = hostNamesOf(snap);
    const hostPorts = hostPortsOf(lldp.rows.filter(own), hostNames);
    // v3.42(2회차 A1-F10 · 3회차 A1-F6 · A3-F6 · A4-F5): MAC 은 포트 채널 이름으로 배울 수 있다 — 답에 나온 장비(FDB · CVP 위치 행이 있는 장비)의 채널 소속만 읽어
    //   ESXi 물리 포트의 채널은 호스트 포트로, 업링크 물리 포트의 채널은 업링크로 본다. 예전(2회차)에는 호스트가 붙은 전 장비를 검색마다 읽었고(5만 행 상한 밖은 조용히 빠짐),
    //   업링크 채널은 '가장자리' 로 답했다.
    const ansDevs = [...new Map([...fdbRows, ...epRows].map((r) => [devKey(r.agent, r.cvpId, r.key), r])).keys()];
    const ansSet = new Set(ansDevs);
    if (ansSet.size) {
      const pr = await cdb.portRowsOf(b.devices.filter((d) => ansSet.has(devKey(d.agent, d.cvpId, d.key))), { limit: 50_000 });
      for (const r of pr.rows || []) {
        if (!r.lag) continue;
        const dk = devKey(r.agent, r.cvpId, r.key); const np = normPort(r.port); const po = normPort(r.lag);
        if (hostPorts.get(dk)?.has(np)) hostPorts.get(dk).add(po);
        if (ups.get(dk)?.has(np)) ups.get(dk).add(po);
      }
    }
    const placed = placeRows({ fdb: fdbRows, ep: epRows, uplinks: ups, macCount, hostPorts });
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

  // ── ③ 버전 준수(v3.41) — CVP 가 준 준수 · 버그/CVE · 수명주기를 그대로(포탈이 판정하지 않는다). 새 수집 없음(v2.641 CVP 단위 항목). ──
  api.get('/tools/cvp/compliance', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const b = await baseOf({ cvpId, withPorts: false });
    if (!b) return res.status(503).json(DB_DOWN);
    const r = complianceFleet(b.devices);
    res.json({ ...r, devicesCount: b.devices.length });
  });

  // ── ⑧ MLAG · 포트 채널 이중화(v3.41) — 채널 = 포트 행의 lag · oper(새로 읽는 채널 소속) · MLAG = info.mlagStatus(새로 읽는 상태 노드). 장애로 열지 않는다(화면만). ──
  api.get('/tools/cvp/redundancy', toolsPerm, fullScopeOnly, async (req, res) => {
    kickDemo();
    const cvpId = cvpIdOf(req);
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    const admin = isAdminReq(req);
    return heavyJson(req, res, heavyKey('redundancy', admin, cvpId), async () => {
      const b = await baseOf({ cvpId });
      if (!b) return { status: 503, body: DB_DOWN };
      const portsByDev = new Map();
      for (const p of b.ports) { const k = devKey(p.agent, p.cvpId, p.key); if (!portsByDev.has(k)) portsByDev.set(k, []); portsByDev.get(k).push(p); }
      const r = redundancyFleet({ devices: b.devices, portsByDev });
      // 반증 E8: MLAG 도메인 · 피어 링크는 장비가 준 자유 문자열 — 비관리자에는 형제 라우트처럼 주소를 가린다.
      const hosts = hostsOf();
      // v3.42(2회차 A4-F9): 정상 · 꺼진 채널의 멤버는 포트 이름만(관리상 꺼짐 표지만 남긴다) — 전 채널 · 멤버 전부를 실어 응답이 3.5~3.8MB 였다.
      const slim = (x) => ({ ...x, channels: x.channels.map((ch) => (ch.state === 'ok' || ch.state === 'off' ? { ...ch, members: ch.members.map((m) => (m.admin === 'down' ? { port: m.port, admin: 'down' } : { port: m.port })) } : ch)) });
      return { body: { ...r, rows: r.rows.map((x) => slim(admin ? x : { ...x, mlag: maskMlag(x.mlag, false, hosts) })), portsUnread: b.portsUnread,
        ...(b.truncated ? { truncated: true } : {}), ...(admin ? {} : { addressHidden: true }) } };
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
  let snapDeleting = 0;
  api.get('/tools/cvp/snapshots', toolsPerm, fullScopeOnly, async (req, res) => {
    // v3.42(2회차 반증 — 주석과 코드 불일치): 끝나지 않은 채 1시간 넘은 스냅샷 · 보존일 밖은 목록을 볼 때도 정리한다(예전에는 새 스냅샷 저장이 성공할 때만 돌았다).
    if (!snapBusy && !snapDeleting) await cdb.pruneSnaps().catch((e) => console.warn(`[cvp-net] 스냅샷 정리 실패: ${e.message}`));
    const r = await cdb.listSnaps();
    if (r.unavailable) return res.status(503).json(DB_DOWN);
    const nameOf = new Map(listServers().map((x) => [String(x.id), x.name || x.id]));
    res.json({ snapshots: r.rows.map((x) => ({ ...x, cvpName: x.cvpId ? (nameOf.get(String(x.cvpId)) || x.cvpId) : '' })), max: cdb.SNAP_MAX, retentionDays: cdb.SNAP_RETENTION_DAYS, busy: snapBusy });
  });
  api.post('/tools/cvp/snapshots', writer, toolsPerm, fullScopeOnly, async (req, res) => {
    if (Array.isArray(req.body)) return res.status(400).json({ ok: false, reason: '본문은 객체여야 합니다.' });   // 3회차 A3-F7
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // v3.42(2회차 A3-F3): 범위 입력이 글자가 아니면(배열 · 숫자 · 객체) 400 — 조용히 '모든 CVP' 로 넓히지 않는다. 없음 · null · '' 만 모든 CVP.
    if (body.cvpId != null && typeof body.cvpId !== 'string') return res.status(400).json({ ok: false, reason: 'cvpId 는 글자여야 합니다.' });
    if (body.label != null && typeof body.label !== 'string') return res.status(400).json({ ok: false, reason: 'label 은 글자여야 합니다.' });
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
      if (e?.code === 'SNAP_GONE') return res.status(409).json({ ok: false, reason: '저장하는 동안 스냅샷이 지워졌습니다 — 다시 찍어 주세요.' });
      console.warn(`[cvp-net] 스냅샷 저장 실패: ${e.message}`);
      res.status(500).json({ ok: false, reason: '스냅샷을 저장하지 못했습니다(서버 로그 참고).' });
    } finally { snapBusy = false; }
  });
  api.delete('/tools/cvp/snapshots/:id', writer, toolsPerm, fullScopeOnly, async (req, res) => {
    const id = numOrNull(req.params.id);
    if (id == null || !Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, reason: '스냅샷 번호가 올바르지 않습니다.' });
    // v3.42(A3-F4 · A4-F7): 저장 중인 것은 지우지 않는다(지우면 찍은 쪽이 '저장 성공' 을 받고 감사 로그와 실제가 어긋났다). 끝나지 않은 채 1시간 넘은 것은 pruneSnaps 가 지운다.
    if (snapBusy) return res.status(409).json({ ok: false, reason: '스냅샷을 저장하는 중입니다 — 끝난 뒤 다시 누르세요.' });
    // v3.42(3회차 A2-F8): 지우는 동안에는 목록 조회의 정리(pruneSnaps)가 같은 스냅샷을 먼저 지우지 않게 — 지운 사람이 404 를 받고 감사 로그가 빠졌다.
    snapDeleting++;
    let r;
    try { r = await cdb.deleteSnap(id); } finally { snapDeleting--; }
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
    if (unknownCvp(cvpId)) return res.status(404).json({ ok: false, reason: '없는 CVP 서버입니다.' });
    return heavyJson(req, res, heavyKey('compare', admin, cvpId, aId, bRaw), async () => {
      const A = await cdb.readSnap(aId);
      if (A && A.unavailable) return { status: 503, body: DB_DOWN };
      if (!A) return { status: 404, body: { ok: false, reason: '없는 스냅샷이거나 저장이 끝나지 않았습니다.' } };
      // v3.42(A3-F2): 범위가 다른 것끼리는 비교하지 않는다 — 'X 전체 ↔ Y 만' 은 X 의 장비 전부를 '사라짐' 으로 지어냈다.
      const scopeMismatch = (x) => x && A.head.cvpId && String(x) !== String(A.head.cvpId);
      if (scopeMismatch(cvpId)) return { status: 400, body: { ok: false, reason: '이 스냅샷은 다른 CVP 를 찍은 것입니다 — 같은 범위끼리 비교하세요.' } };
      let B; let bHead; let bBroken = new Set();
      if (bRaw === 'now') {
        const cur = await currentBodies(cvpId || A.head.cvpId);
        if (!cur) return { status: 503, body: DB_DOWN };
        B = new Map(cur.bodies.map((x) => [devKey(x.agent, x.cvpId, x.key), x.body]));
        bHead = { id: null, at: Date.now(), label: '지금', now: true };
      } else {
        const bId = numOrNull(bRaw);
        if (bId == null) return { status: 400, body: { ok: false, reason: '비교 대상(b)이 올바르지 않습니다.' } };
        const Bs = await cdb.readSnap(bId);
        if (Bs && Bs.unavailable) return { status: 503, body: DB_DOWN };
        if (!Bs) return { status: 404, body: { ok: false, reason: '없는 스냅샷이거나 저장이 끝나지 않았습니다.' } };
        if ((Bs.head.cvpId ?? null) !== (A.head.cvpId ?? null)) return { status: 400, body: { ok: false, reason: '두 스냅샷의 범위(CVP)가 다릅니다 — 같은 범위끼리 비교하세요.' } };
        B = Bs.devices; bHead = Bs.head; bBroken = Bs.broken;
      }
      // 범위를 맞춘다: 한쪽이 한 CVP 만 찍었으면 다른 쪽도 그 CVP 만(나머지를 '사라짐 · 새로 생김' 으로 지어내지 않게). 요청 cvpId 가 있으면 그것.
      const only = cvpId || A.head.cvpId || bHead.cvpId || null;
      const keep = (m) => (only ? new Map([...m].filter(([k]) => k.split('\u0000')[1] === String(only))) : m);
      // v3.42(2회차 A1-F8): 깨진 행 목록도 범위로 거른다(범위 밖 장비가 이름 없는 '비교 못 함' 행으로 나왔다).
      const inScope = (k) => !only || String(k).split('\u0000')[1] === String(only);
      const d = diffSnapshots(keep(A.devices), keep(B), { broken: new Set([...(A.broken || []), ...bBroken].filter(inScope)) });
      const hosts = hostsOf();
      const mk = (v) => (admin || v == null ? v : maskErrText(String(v), hosts));
      const devices = d.devices.map((x) => ({ ...x, changes: x.changes.map((c) => {
        if (admin) return c;
        // BGP 피어 주소는 장비 관리 주소와 같은 등급(cvp.js maskPeers) — 비-admin 에는 VRF 만 남긴다.
        if (c.kind === 'bgp') return { ...c, item: `${mk(String(c.item).split('|')[0])}|(주소 가림)` };
        if ((c.kind === 'port' && c.field === 'desc') || c.kind === 'lldp') return { ...c, before: mk(c.before), after: mk(c.after) };
        return c;
      }) }));
      return { body: { a: A.head, b: bHead, scopeCvpId: only, devices, counts: d.counts, unchanged: d.unchanged, omitted: d.omitted, ...(admin ? {} : { addressHidden: true }) } };
    });
  });
}
