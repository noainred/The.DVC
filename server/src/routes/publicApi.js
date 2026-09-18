/**
 * `/api/v1/*` — 외부 포탈이 읽는 공개 조회 API (v2.562).
 *
 * ⚠⚠ **내부 라우트를 그대로 노출하지 않는다.** 여기서 응답을 만들 때는 반드시
 * `allowlist.project()` 를 통과시켜 **선언된 필드만** 내보낸다. 내부 스냅샷 객체를
 * `{...row}` 로 펼치면 지금 없는 필드가 나중에 들어오면서 조용히 새고(v2.503 S-3 와 같은
 * 사고), 반대로 내부 필드명이 바뀌면 상대 포탈이 깨진다.
 *
 * ⚠⚠ **여기 있는 것은 전부 GET 이다.** 상태변경을 추가하지 말 것 —
 * `test/publicApi2562.test.js` 가 소스에서 `v1.post|put|patch|delete` 가 0 임을 고정한다.
 *
 * 범위는 **합성 사용자를 통해 기존 판정이 걸린다**(`publicapi/auth.js`):
 *   `scopedVcenterIds(req.user, snap)` → `null` 이면 제한 없음, Set 이면 그 vCenter 만.
 * ⚠ `null` 을 '빈 집합' 으로 읽지 말 것 — 뒤집으면 전체 범위 키가 아무것도 못 본다.
 *
 * 응답 봉투는 **고정 계약**이다: `{ ok, apiVersion, generatedAt, data, meta }`.
 * ⚠ `meta` 에 범위·상한·잘린 개수를 밝힌다(조용한 상한 금지 — CLAUDE.md 전반 규약).
 */

import express from 'express';
import { store } from '../store.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { config } from '../config.js';
import { apiKeyAuth } from '../publicapi/auth.js';
import { endpointAllowed, project, projectAll, ENDPOINTS, GROUPS } from '../publicapi/allowlist.js';
import { buildOpenApi } from '../publicapi/openapi.js';
import { numOrNull } from '../util/numOrNull.js';
import { msOrNull } from '../publicapi/time.js';

export const API_VERSION = 'v1';
/** 목록 응답 상한 — 넘치면 `meta.truncated`·`meta.omitted` 로 **밝힌다**. */
const LIST_MAX = 5000;

const v1 = express.Router();

/* ── 공용 ─────────────────────────────────────────────────────────────────── */

function envelope(res, apiPath, data, meta = {}) {
  return res.json({
    ok: true,
    apiVersion: API_VERSION,
    endpoint: apiPath,
    generatedAt: Date.now(),
    data,
    meta,
  });
}

/** 상한 적용 + 잘린 사실 표기. */
function capped(rows) {
  const all = Array.isArray(rows) ? rows : [];
  if (all.length <= LIST_MAX) return { rows: all, meta: { count: all.length, truncated: false, omitted: 0, limit: LIST_MAX } };
  return { rows: all.slice(0, LIST_MAX), meta: { count: LIST_MAX, truncated: true, omitted: all.length - LIST_MAX, limit: LIST_MAX } };
}

/**
 * 허용 목록 게이트 + 스냅샷·범위 준비.
 * ⚠ 게이트를 핸들러마다 손으로 쓰면 한 곳을 빠뜨린다 — 이 래퍼를 반드시 쓸 것.
 */
function guarded(apiPath, handler) {
  return (req, res) => {
    const gate = endpointAllowed(req.apiKey, apiPath);
    if (!gate.ok) {
      return res.status(gate.code === 'unknown-endpoint' ? 404 : 403)
        .json({ ok: false, error: gate.code, code: gate.code, reason: gate.reason, endpoint: apiPath });
    }
    const snap = store.get();
    if (!snap) {
      // ⚠ '수집 전' 과 '실패' 를 구분한다(v2.509 규약) — 빈 배열로 '없다' 고 말하지 않는다.
      return res.status(503).json({ ok: false, error: 'not-collected', code: 'not-collected',
        reason: '첫 수집이 아직 끝나지 않았습니다 — 잠시 뒤 다시 시도하세요.' });
    }
    const allowed = scopedVcenterIds(req.user, snap);   // null = 제한 없음
    const inScope = (vcId) => allowed == null || allowed.has(vcId);
    const fields = gate.endpoint.fields;
    const scopeMeta = { scopedToVcenters: allowed == null ? null : [...allowed].length };
    /*
     * ⚠⚠ **async 핸들러의 throw 를 반드시 잡는다** — express 4 는 그것을 잡지 않아 요청이
     *   응답 없이 **매달린다**(v2.548 S1 에서 실측한 hang). `Promise.resolve().then()` 으로
     *   감싸면 동기 throw 와 async reject 를 **한 경로에서** 받는다.
     *   ⚠ `try { return handler(...) } catch` 만 두면 async reject 를 놓친다.
     */
    Promise.resolve()
      .then(() => handler({ req, res, snap, inScope, fields, scopeMeta, apiPath }))
      .catch((e) => {
        if (res.headersSent) return;   // 이미 보낸 뒤의 오류는 덮어쓰지 않는다
        res.status(500).json({ ok: false, error: 'internal', code: 'internal',
          reason: String(e?.message || e).slice(0, 200) });
      });
  };
}

/* ── 카탈로그(키 없이도 볼 수 있어야 유용한가? 아니다 — 키를 요구한다) ────────── */

v1.use(apiKeyAuth());

/** 이 키로 무엇을 쓸 수 있는지 — 상대 포탈이 스스로 확인하는 자기점검 경로. */
v1.get('/', (req, res) => {
  const mine = new Set(req.apiKey?.groups || []);
  envelope(res, '/', {
    key: { name: req.apiKey?.name || '', groups: [...mine], fp: req.apiKey?.fp || '', expiresAt: req.apiKey?.expiresAt ?? null },
    groups: GROUPS.map((g) => ({ ...g, allowed: mine.has(g.key) })),
    endpoints: ENDPOINTS.map((e) => ({ path: e.path, method: e.method, group: e.group, summary: e.summary, fields: e.fields, allowed: mine.has(e.group) })),
  }, { note: 'allowed:false 인 항목은 이 키로 403 입니다 — 설정 › 연동 키에서 분류를 켜야 합니다.' });
});

/** OpenAPI 3.1 — 이 키가 쓸 수 있는 것만 담는다(없는 경로를 문서로 알려주지 않는다). */
v1.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buildOpenApi({ groups: req.apiKey?.groups || [], baseUrl: `${req.protocol}://${req.get('host')}/api/${API_VERSION}` }));
});

/* ── inventory ────────────────────────────────────────────────────────────── */

v1.get('/inventory/summary', guarded('/inventory/summary', ({ res, snap, inScope, fields, scopeMeta, apiPath }) => {
  const vcs = (snap.vcenters || []).filter((v) => inScope(v.id));
  const ids = new Set(vcs.map((v) => v.id));
  const hosts = (snap.hosts || []).filter((h) => ids.has(h.vcenterId));
  const vms = (snap.vms || []).filter((v) => ids.has(v.vcenterId));
  const dss = (snap.datastores || []).filter((d) => ids.has(d.vcenterId));
  const nets = (snap.networks || []).filter((n) => ids.has(n.vcenterId));
  const sum = (arr, fn) => arr.reduce((a, x) => a + (numOrNull(fn(x)) || 0), 0);
  /*
   * ⚠ 이 합계는 내부 `/summary` 와 **같은 값이어야 한다**. 집계가 그 라우트 안에 인라인으로
   *   있어 꺼내 쓸 함수가 없으므로, `test/publicApi2562.test.js` 가 두 값을 대조해 고정한다 —
   *   갈라지면 CI 가 깨진다(중복 구현이 조용히 어긋나는 것을 막는 유일한 수단).
   */
  const row = {
    vcenters: vcs.length,
    hosts: hosts.length,
    vms: vms.length,
    vmsPoweredOn: vms.filter((v) => v.powerState === 'POWERED_ON').length,
    templates: vms.filter((v) => v.template).length,
    datastores: dss.length,
    networks: nets.length,
    clusters: new Set(hosts.map((h) => `${h.vcenterId}/${h.cluster}`)).size,
    cpuCores: sum(hosts, (h) => h.cpuCores),
    cpuTotalMhz: sum(hosts, (h) => h.cpuTotalMhz),
    cpuUsedMhz: sum(hosts, (h) => h.cpuUsageMhz),
    memTotalMB: sum(hosts, (h) => h.memTotalMB),
    memUsedMB: sum(hosts, (h) => h.memUsageMB),
    storageCapacityGB: sum(dss, (d) => d.capacityGB),
    storageUsedGB: sum(dss, (d) => d.usedGB),
    vmVcpu: sum(vms, (v) => v.cpuCount),
    vmRamMB: sum(vms, (v) => v.memMB),
    vmProvisionedGB: sum(vms, (v) => v.storageGB),
  };
  return envelope(res, apiPath, project(row, fields), { ...scopeMeta, collectedAt: msOrNull(snap.generatedAt) });
}));

v1.get('/inventory/vcenters', guarded('/inventory/vcenters', ({ res, snap, inScope, fields, scopeMeta, apiPath }) => {
  const rows = (snap.vcenters || []).filter((v) => inScope(v.id)).map((v) => {
    const cnt = (arr, k) => (arr || []).reduce((a, x) => a + (x[k] === v.id ? 1 : 0), 0);
    return {
      id: v.id, name: v.name, status: v.status || null, version: v.version || null,
      hosts: cnt(snap.hosts, 'vcenterId'), vms: cnt(snap.vms, 'vcenterId'),
      datastores: cnt(snap.datastores, 'vcenterId'), alarms: cnt(snap.alarms, 'vcenterId'),
      // ⚠ `snap.generatedAt` 은 ISO 문자열이다(`store.js:402`) — epoch ms 로 통일한다.
      collectedAt: msOrNull(v.collectedAt ?? snap.generatedAt),
    };
  });
  const c = capped(rows);
  return envelope(res, apiPath, projectAll(c.rows, fields), { ...scopeMeta, ...c.meta });
}));

v1.get('/inventory/collection', guarded('/inventory/collection', ({ res, snap, fields, apiPath }) => {
  /*
   * ⚠⚠ '첫 수집 중'(pending)과 '접속 실패'(unreachable)를 **합치지 말 것** — 조치가 정반대다
   *   (v2.509 규약. pending 은 기다리면 되고 unreachable 은 기다려도 안 된다).
   * ⚠ 상태값은 `/health`(`overviewNsx.js:88`)와 **같은 정확 비교**를 쓴다 — 추측 정규식으로
   *   분류하면 두 경로가 다른 수를 말한다.
   */
  const vcs = snap.vcenters || [];
  const by = (st) => vcs.filter((v) => v.status === st).length;
  const row = {
    registered: vcs.length,
    connected: by('connected'),
    pending: by('pending'),
    unreachable: by('unreachable'),
    maintenance: by('maintenance'),
    generatedAt: msOrNull(snap.generatedAt),
    source: snap.source || null,
    intervalMs: numOrNull(config.pollIntervalMs),
  };
  return envelope(res, apiPath, project(row, fields), {
    note: 'pending 은 첫 수집이 끝나지 않은 것이고 unreachable 은 접속 실패입니다 — 조치가 다릅니다.',
  });
}));

/* ── capacity ─────────────────────────────────────────────────────────────── */

v1.get('/capacity/datastores', guarded('/capacity/datastores', ({ res, snap, inScope, fields, scopeMeta, apiPath }) => {
  const rows = (snap.datastores || []).filter((d) => inScope(d.vcenterId)).map((d) => {
    const cap = numOrNull(d.capacityGB); const used = numOrNull(d.usedGB);
    return {
      id: d.id, vcenterId: d.vcenterId, name: d.name, type: d.type || null,
      capacityGB: cap, usedGB: used,
      freeGB: cap != null && used != null ? Math.max(0, cap - used) : null,
      // ⚠ 0 으로 나누지 않는다 — 용량이 0 이거나 미상이면 퍼센트는 null 이다(지어내지 않는다).
      usedPct: cap != null && cap > 0 && used != null ? Math.round((used / cap) * 1000) / 10 : null,
    };
  });
  const c = capped(rows);
  return envelope(res, apiPath, projectAll(c.rows, fields), { ...scopeMeta, ...c.meta });
}));

v1.get('/capacity/storage', guarded('/capacity/storage', async ({ res, fields, apiPath }) => {
  /*
   * ⚠ 목록은 **로컬 + 엣지 push 분** 둘을 합쳐야 한다(`routes/api/storageMon.js:48` 과 같은 조합).
   *   로컬만 쓰면 위임 법인의 장비가 통째로 빠져 '장비가 없다' 는 거짓이 된다.
   */
  const [{ localSnapshots }, { edgeStorageSnapshots }] = await Promise.all([
    import('../storage/store.js'),
    import('../central/storageEdge.js'),
  ]);
  const rows = [...(localSnapshots() || []), ...(edgeStorageSnapshots() || [])].map((s2) => {
    const total = numOrNull(s2.capacity?.totalBytes); const used = numOrNull(s2.capacity?.usedBytes);
    return {
      deviceId: s2.deviceId, name: s2.name || s2.deviceId, type: s2.type || null,
      totalBytes: total, usedBytes: used,
      // ⚠ 0 으로 나누지 않고, 사용량이 미상이면 퍼센트도 null 이다(지어내지 않는다).
      usedPct: total != null && total > 0 && used != null ? Math.round((used / total) * 1000) / 10 : null,
      // ⚠ v2.561 규약 — 읽지 못한 사용량은 **null** 이고 0 으로 채우지 않는다. 그 사실을 밝힌다.
      usedUnknown: used == null,
      collectedAt: msOrNull(s2.collectedAt),
    };
  });
  const c = capped(rows);
  const unknown = c.rows.filter((r) => r.usedUnknown).length;
  return envelope(res, apiPath, projectAll(c.rows, fields), {
    ...c.meta, usedUnknownCount: unknown,
    note: unknown
      ? `사용량을 읽지 못한 장비 ${unknown}대는 usedBytes 가 null 입니다 — 0 으로 채우지 않았습니다.`
      : '사용량을 읽지 못한 장비는 usedBytes 가 null 로 나갑니다(0 으로 채우지 않습니다).',
  });
}));

v1.get('/capacity/storage-growth', guarded('/capacity/storage-growth', async ({ res, fields, apiPath }) => {
  const db = await import('../storage/db.js').catch(() => null);
  const g = await import('../storage/growth.js').catch(() => null);
  if (!db || !g) return res.status(503).json({ ok: false, error: 'unavailable', code: 'unavailable', reason: '증가량 모듈을 불러올 수 없습니다.' });
  /*
   * ⚠⚠ **`normalizePeriods` 는 배열이 아니라 `{periods, dropped}` 를 돌려준다**
   *   (`storage/growth.js:43`). v2.562 초판이 반환값을 그대로 `periods` 로 넘겨
   *   `periods.map is not a function` 으로 **이 경로가 통째로 500** 이었다(실측).
   *   버린 기간 수(`dropped`)도 응답에 밝힌다 — 조용히 버리지 않는다.
   */
  const { periods, dropped } = g.normalizePeriods([1, 7, 30]);
  const rows = await db.dailySeries(null, 0);
  const m = g.growthMatrix(rows, { periods });
  const out = (m.devices || []).map((d) => ({
    deviceId: d.deviceId, name: d.name, usedBytes: d.usedBytes, totalBytes: d.totalBytes,
    observedDays: d.observedDays,
    // 기간별 증가 바이트만 — 내부 growth 객체를 그대로 싣지 않는다(내부 필드가 새지 않게).
    growth: Object.fromEntries(periods.map((p) => [p.key, d.growth?.[p.key]?.bytes ?? null])),
    unknownUsed: d.usedBytes == null,
  }));
  const c = capped(out);
  return envelope(res, apiPath, projectAll(c.rows, fields), {
    ...c.meta, periods: periods.map((p) => p.key), periodsDropped: dropped,
    unknownUsedCount: m.totals?.unknownUsed ?? null,
    note: '기준선이 없는 기간은 null 입니다 — 관측이 짧은 구간을 추정으로 메우지 않습니다.',
  });
}));

/* ── faults ───────────────────────────────────────────────────────────────── */

v1.get('/faults/alarms', guarded('/faults/alarms', ({ res, snap, inScope, fields, scopeMeta, apiPath }) => {
  const rows = (snap.alarms || []).filter((a) => inScope(a.vcenterId)).map((a) => ({
    id: a.id, vcenterId: a.vcenterId, entity: a.entity || null, entityType: a.entityType || null,
    name: a.name || null, severity: a.severity || a.status || null,
    triggeredAt: msOrNull(a.triggeredAt),
    // ⚠ 음소거된 알람을 **빼지 않는다** — 빼면 '알람 없음' 이라는 거짓이 된다. 표시만 한다.
    muted: a.muted === true,
  }));
  const c = capped(rows);
  return envelope(res, apiPath, projectAll(c.rows, fields), {
    ...scopeMeta, ...c.meta, mutedCount: c.rows.filter((r) => r.muted).length,
    note: '음소거된 알람도 포함하고 muted:true 로 표시합니다 — 목록에서 빼지 않습니다.',
  });
}));

v1.get('/faults/parts', guarded('/faults/parts', async ({ res, fields, apiPath }) => {
  const pf = await import('../partfault/db.js').catch(() => null);
  if (!pf?.openFaults) {
    return res.status(503).json({ ok: false, error: 'unavailable', code: 'unavailable', reason: '부품 장애 모듈을 불러올 수 없습니다.' });
  }
  const open = (await pf.openFaults()) || [];
  const rows = open.map((f) => ({
    partKey: f.part_key ?? f.partKey ?? null, agent: f.agent ?? null, scope: f.scope ?? null,
    deviceKey: f.device_key ?? f.deviceKey ?? null, kind: f.kind ?? null, partId: f.part_id ?? f.partId ?? null,
    state: f.state ?? null, openedAt: msOrNull(f.opened_at ?? f.openedAt),
    lastSeenAt: msOrNull(f.last_seen_at ?? f.lastSeenAt), reason: f.reason ?? null,
  }));
  const c = capped(rows);
  return envelope(res, apiPath, projectAll(c.rows, fields), {
    ...c.meta,
    note: "확인 불가(unknown)·빈 슬롯(absent)은 장애로 세지 않습니다 — state 를 그대로 보세요.",
  });
}));

/* ── 미선언 경로 ──────────────────────────────────────────────────────────── */

/**
 * ⚠ 404 에 **무엇이 있는지 알려주지 않는다** — 카탈로그(`GET /api/v1/`)가 그 역할이고
 *   거기서는 이미 키가 검증된 상태다. 여기서 경로 목록을 흘리면 열거 단서가 된다.
 */
v1.use((req, res) => res.status(404).json({
  ok: false, error: 'unknown-endpoint', code: 'unknown-endpoint',
  reason: '공개되지 않은 경로입니다 — GET /api/v1/ 로 이 키가 쓸 수 있는 목록을 확인하세요.',
}));

export default v1;
