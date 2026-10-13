/**
 * partfault/incidents.js — 전이 이벤트를 **장애 1건 = 1행** 으로 묶고, 부품 종류별로 집계한다(순수, v2.734).
 *
 * 사용자 요청(2026-10-13): "장애별로 볼 수 있는 기능 추가, 지금까지 발생한 장애 종류(디스크, CPU, memory, NIC,
 * GPU 등)를 종류별로 볼 수 있는 기능 추가" + 선택 "발생 1건 = 1행".
 *
 * `part_event` 는 **전이만** 한 줄씩 쌓는다(열림·변화·해소 — db.js 머리말). 그래서 '이력' 탭에서는 장애 하나가
 * '장애 발생' 줄과 '해소' 줄로 떨어져 보인다. 이 모듈이 같은 (agent, part_key) 의 '열림 → (변화) → 해소' 를 한
 * 건으로 묶는다. 판정 규칙(지어내지 않는다):
 *  · 기간 이전에 열려 기간 안에서 이어진 장애는 첫 이벤트가 '변화'·'해소' 다 — 시작 시각은 `startLookup`(인덱스로
 *    그 키의 이전 '열림' 을 찾는 DB 함수)으로 붙인다. 못 찾으면(보존 기간 밖·조회 상한) **시작 시각 모름**이다.
 *  · 지금 열려 있는 장애는 `part_state` 행(`openRows`)이 진실의 원천이다 — 처음 감지 시각·지금 상태·보류 사유를
 *    거기서 읽는다. 기간 안에 이벤트가 하나도 없는(기간 이전에 열려 지금까지 그대로인) 장애도 '진행 중' 으로 넣는다.
 *  · 해소 이벤트 없이 끝난 묶음(지금 열려 있지도 않음)은 **종료 기록 없음**(`unknown`)이다 — '정상 복귀' 라 말하지 않는다.
 *  · 식별 키 변경(`key-migrated`, v2.612 LEFT2612-04 — HPE 서비스태그 교정)은 **같은 장애가 새 키로 옮겨진 것**이다.
 *    옛 키의 닫힘과 같은 시각에 같은 자리(agent·장비 id·장비군·종류·부품 이름)로 열린 새 키 장애를 찾아 **한 건으로
 *    합친다** — 두 번 세면 종류별 수치가 부풀고 '해소' 로 보이면 거짓이다.
 *  · 수동 닫음(`manual`)·부품 제거(`removed`)는 정상 복귀(`ok`)와 다른 종료다(조치가 다르다 — 화면이 나눠 말한다).
 *  · 평균 지속 시간은 **정상 복귀·부품 제거로 끝난 장애만**으로 낸다(수동 닫음은 고친 시각이 아니고, 시작을 모르면 길이를 모른다).
 *
 * ⚠ 입력 이벤트는 **시간 오름차순**(같은 시각이면 id 오름차순)이어야 한다 — db.js `incidentEvents` 가 그렇게 준다.
 */

const t = (v) => String(v ?? '').trim();
const keyOf = (o) => `${t(o.agent)}|${t(o.partKey)}`;
const RANK = { fault: 2, warn: 1 };
const worse = (a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a);

/** 종료 사유 — 화면 문구는 웹 `partFaultText.INCIDENT_END_TEXT` 가 소유한다(키 집합 1:1 — 테스트 대조). */
export const INCIDENT_END = Object.freeze({
  ok: 'ok',             // 정상으로 복귀
  removed: 'removed',   // 부품이 제거됨(교체 중일 수 있다)
  manual: 'manual',     // 관리자가 수동으로 닫음 — 고쳐졌다는 뜻이 아니다
  migrated: 'migrated', // 식별 키 변경으로 옮겨짐(새 키 장애를 찾지 못했을 때만 남는다)
  unknown: 'unknown',   // 종료 기록 없음
});

/** 한 장애에 싣는 타임라인 이벤트 상한(넘친 개수는 eventsOmitted 로 밝힌다). */
export const INCIDENT_EVENT_MAX = 50;

const closeReasonToEnd = (r) => {
  if (r === 'removed') return INCIDENT_END.removed;
  if (r === 'manual') return INCIDENT_END.manual;
  if (r === 'key-migrated') return INCIDENT_END.migrated;
  return INCIDENT_END.ok;
};

function newIncident(ev, { openedAt = null, startedBefore = false } = {}) {
  return {
    agent: t(ev.agent), partKey: t(ev.partKey), scope: t(ev.scope), deviceId: t(ev.deviceId),
    deviceKey: t(ev.deviceKey) || t(ev.deviceId), deviceKeyKind: t(ev.deviceKeyKind), deviceName: t(ev.deviceName),
    kind: t(ev.kind) || 'other', label: t(ev.label), keyKind: t(ev.keyKind),
    openedAt, startedBefore, startUnknown: false,
    closedAt: null, ongoing: false, endReason: null,
    state: null, peak: null, rawState: '', holdReason: null, lastSeenAt: null,
    events: [], eventsOmitted: 0, migratedFrom: null,
  };
}

function pushEvent(inc, ev) {
  if (inc.events.length >= INCIDENT_EVENT_MAX) { inc.eventsOmitted += 1; return; }
  inc.events.push({
    at: ev.at, event: ev.event, state: ev.state ?? null, prevState: ev.prevState ?? null,
    rawState: t(ev.rawState), closeReason: ev.closeReason ?? null,
  });
}

/** 표시 정보는 최신 이벤트를 따른다(장비 이름·IP 가 바뀌어도 화면은 지금 이름을 보인다 — db.js upsert 와 같은 판단). */
function refreshInfo(inc, ev) {
  for (const f of ['scope', 'deviceId', 'deviceName', 'label', 'keyKind', 'deviceKeyKind']) if (t(ev[f])) inc[f] = t(ev[f]);
  if (t(ev.deviceKey)) inc.deviceKey = t(ev.deviceKey);
  if (t(ev.kind)) inc.kind = t(ev.kind);
  if (t(ev.rawState)) inc.rawState = t(ev.rawState);
}

const slotOf = (o, at) => `${t(o.agent)}|${t(o.deviceId)}|${t(o.scope)}|${t(o.kind)}|${t(o.label)}|${at}`;

/**
 * @param {object} p
 * @param {Array} p.events     시간 오름차순 전이 이벤트(`recentEvents` 모양 + 선택 `id`)
 * @param {Array} [p.openRows] 지금 열린 장애(`openFaults()` 모양) — 진행 중 판정의 원천
 * @param {number} [p.since]   조회 창 시작(절대 ms, 0 = 처음부터)
 * @param {number} [p.now]
 * @param {(agent:string, partKey:string, beforeAt:number) => ({at:number, state?:string}|null)} [p.startLookup]
 *   기간 이전 '열림' 이벤트 조회(인덱스). 없으면 시작을 모르는 것으로 둔다.
 * @param {number} [p.lookupMax=1000] 조회 상한 — 넘친 장애는 '시작 시각 모름'(개수는 stats 로 밝힌다)
 * @returns {{incidents:Array, stats:{lookups:number, lookupCapped:number, merged:number, endUnknown:number}}}
 */
export function buildIncidents({ events = [], openRows = [], since = 0, now = Date.now(), startLookup = null, lookupMax = 1000 } = {}) {
  const cur = new Map();
  const out = [];
  const migratedPending = new Map();   // slot|at → 옛 키 장애(같은 시각 같은 자리의 새 키 '열림' 이 이어받는다)
  const stats = { lookups: 0, lookupCapped: 0, merged: 0, endUnknown: 0 };

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== 'object' || !t(ev.partKey)) continue;
    const k = keyOf(ev);
    const at = Number(ev.at);
    if (!Number.isFinite(at)) continue;
    let inc = cur.get(k) || null;

    if (ev.event === 'open') {
      if (inc) {   // 해소 없이 다시 열림 — 앞 묶음의 끝을 모른다(지어내지 않는다)
        inc.endReason = INCIDENT_END.unknown; stats.endUnknown += 1;
        out.push(inc); cur.delete(k);
      }
      inc = newIncident(ev, { openedAt: at });
      const old = migratedPending.get(slotOf(ev, at));
      if (old) {
        // 같은 장애가 새 키로 옮겨졌다 — 시작·타임라인·최악 상태를 이어받고 옛 묶음은 목록에서 뺀다.
        inc.openedAt = old.openedAt; inc.startedBefore = old.startedBefore; inc.startUnknown = old.startUnknown;
        inc.events = old.events.slice(); inc.eventsOmitted = old.eventsOmitted; inc.peak = old.peak;
        inc.migratedFrom = old.partKey; old._merged = true; stats.merged += 1;
        migratedPending.delete(slotOf(ev, at));
      }
      inc.state = ev.state ?? null; inc.peak = worse(inc.peak, ev.state);
      refreshInfo(inc, ev); pushEvent(inc, ev);
      cur.set(k, inc);
      continue;
    }

    if (!inc) {   // 첫 이벤트가 변화·해소 — 기간 이전(또는 읽은 범위 이전)에 열렸다
      inc = newIncident(ev, { openedAt: null, startedBefore: true });
      inc._firstAt = at;
      cur.set(k, inc);
    }
    refreshInfo(inc, ev);
    if (ev.event === 'change') {
      inc.peak = worse(worse(inc.peak, ev.prevState), ev.state);
      inc.state = ev.state ?? inc.state;
      pushEvent(inc, ev);
      continue;
    }
    if (ev.event === 'close') {
      inc.peak = worse(inc.peak, ev.prevState);
      inc.state = ev.prevState ?? inc.state;
      inc.closedAt = at;
      inc.endReason = closeReasonToEnd(ev.closeReason);
      pushEvent(inc, ev);
      cur.delete(k);
      out.push(inc);
      if (inc.endReason === INCIDENT_END.migrated) migratedPending.set(slotOf(inc, at), inc);
    }
  }

  // 지금 열린 장애 — part_state 가 진실의 원천이다.
  const openBy = new Map();
  for (const r of Array.isArray(openRows) ? openRows : []) if (r && t(r.partKey)) openBy.set(keyOf(r), r);
  for (const [k, inc] of cur) {
    const row = openBy.get(k);
    if (row) {
      inc.ongoing = true; inc.endReason = null;
      const first = Number(row.firstSeenAt);
      if (Number.isFinite(first) && first > 0) { inc.openedAt = first; inc.startedBefore = since > 0 && first < since; inc.startUnknown = false; }
      inc.state = row.state || inc.state; inc.peak = worse(inc.peak, row.state);
      inc.holdReason = row.holdReason || null; inc.lastSeenAt = row.lastSeenAt ?? null;
      if (t(row.rawState)) inc.rawState = t(row.rawState);
      for (const f of ['deviceName', 'deviceId', 'label', 'scope']) if (t(row[f])) inc[f] = t(row[f]);
      openBy.delete(k);
    } else {
      inc.endReason = INCIDENT_END.unknown; stats.endUnknown += 1;
    }
    out.push(inc);
  }
  // 기간 안에 이벤트가 하나도 없는 열린 장애(기간 이전에 열려 지금까지 그대로) — 진행 중으로 넣는다.
  for (const row of openBy.values()) {
    const inc = newIncident(row, { openedAt: null });
    const first = Number(row.firstSeenAt);
    if (Number.isFinite(first) && first > 0) { inc.openedAt = first; inc.startedBefore = since > 0 && first < since; } else inc.startUnknown = true;
    inc.ongoing = true; inc.state = row.state || null; inc.peak = row.state || null;
    inc.holdReason = row.holdReason || null; inc.lastSeenAt = row.lastSeenAt ?? null; inc.rawState = t(row.rawState);
    out.push(inc);
  }

  // 시작 시각을 모르는 묶음 — 인덱스로 이전 '열림' 을 찾는다(상한 안에서).
  for (const inc of out) {
    if (inc._merged || inc.openedAt != null) continue;
    if (!inc.startedBefore) { inc.startUnknown = true; continue; }
    if (typeof startLookup !== 'function') { inc.startUnknown = true; continue; }
    if (stats.lookups >= lookupMax) { inc.startUnknown = true; stats.lookupCapped += 1; continue; }
    stats.lookups += 1;
    let hit = null;
    try { hit = startLookup(inc.agent, inc.partKey, inc._firstAt ?? (inc.closedAt ?? now)); } catch { hit = null; }
    const at = Number(hit?.at);
    if (hit && Number.isFinite(at)) { inc.openedAt = at; inc.peak = worse(inc.peak, hit.state); } else inc.startUnknown = true;
  }

  const incidents = out.filter((i) => !i._merged);
  // 같은 부품의 기간 중 발생 횟수(반복 장애 — 흔들리는 부품을 찾는 근거)
  const occ = new Map();
  for (const i of incidents) occ.set(keyOf(i), (occ.get(keyOf(i)) || 0) + 1);
  for (const i of incidents) {
    i.occurrences = occ.get(keyOf(i)) || 1;
    i.durationMs = i.openedAt != null ? Math.max(0, (i.closedAt ?? now) - i.openedAt) : null;
    i.latestAt = Math.max(i.closedAt || 0, i.openedAt || 0, i.lastSeenAt || 0, ...i.events.map((e) => e.at || 0)) || null;
    i.id = `${keyOf(i)}|${i.openedAt ?? 'x'}|${i.closedAt ?? 'open'}`;
    delete i._firstAt; delete i._merged;
  }
  incidents.sort((a, b) => (Number(b.ongoing) - Number(a.ongoing))
    || ((RANK[b.ongoing ? b.state : null] || 0) - (RANK[a.ongoing ? a.state : null] || 0))
    || ((b.latestAt || 0) - (a.latestAt || 0)));
  return { incidents, stats };
}

/**
 * 부품 종류별 집계. **기록이 있는 종류만** 낸다 — 기록이 없는 종류를 '0건' 으로 보이면, 그 종류를 수집하지 않는
 * 장비군이 있을 때 '장애가 없었다' 는 거짓이 된다(화면이 그 사실을 말한다).
 * @param {Array} incidents `buildIncidents().incidents`
 * @param {{since?:number}} [o]
 */
export function summarizeKinds(incidents = [], { since = 0 } = {}) {
  const by = new Map();
  const devicesAll = new Set();
  for (const i of Array.isArray(incidents) ? incidents : []) {
    const k = t(i.kind) || 'other';
    let s = by.get(k);
    if (!s) {
      s = { kind: k, incidents: 0, started: 0, carried: 0, ongoing: 0, ongoingFault: 0, ongoingWarn: 0, peakFault: 0,
        devices: new Set(), parts: new Map(), durSum: 0, durN: 0, lastStartedAt: null, scopes: {} };
      by.set(k, s);
    }
    s.incidents += 1;
    if (i.openedAt != null && i.openedAt >= since && !i.startedBefore) {
      s.started += 1;
      if (s.lastStartedAt == null || i.openedAt > s.lastStartedAt) s.lastStartedAt = i.openedAt;
    } else s.carried += 1;
    if (i.ongoing) { s.ongoing += 1; if (i.state === 'fault') s.ongoingFault += 1; else if (i.state === 'warn') s.ongoingWarn += 1; }
    if (i.peak === 'fault') s.peakFault += 1;
    const dev = `${t(i.agent)}|${t(i.scope)}|${t(i.deviceId)}`;
    s.devices.add(dev); devicesAll.add(dev);
    s.parts.set(keyOf(i), (s.parts.get(keyOf(i)) || 0) + 1);
    if (!i.ongoing && i.openedAt != null && (i.endReason === INCIDENT_END.ok || i.endReason === INCIDENT_END.removed)) {
      s.durSum += Math.max(0, (i.closedAt || 0) - i.openedAt); s.durN += 1;
    }
    s.scopes[t(i.scope) || 'other'] = (s.scopes[t(i.scope) || 'other'] || 0) + 1;
  }
  const kinds = [...by.values()].map((s) => ({
    kind: s.kind, incidents: s.incidents, started: s.started, carried: s.carried,
    ongoing: s.ongoing, ongoingFault: s.ongoingFault, ongoingWarn: s.ongoingWarn, peakFault: s.peakFault,
    devices: s.devices.size, parts: s.parts.size,
    repeatParts: [...s.parts.values()].filter((n) => n >= 2).length,
    avgDurationMs: s.durN ? Math.round(s.durSum / s.durN) : null, durationSamples: s.durN,
    lastStartedAt: s.lastStartedAt, scopes: s.scopes,
  }));
  kinds.sort((a, b) => (b.incidents - a.incidents) || (b.ongoing - a.ongoing) || a.kind.localeCompare(b.kind));
  const list = Array.isArray(incidents) ? incidents : [];
  return {
    kinds,
    totals: {
      incidents: list.length,
      ongoing: list.filter((i) => i.ongoing).length,
      started: kinds.reduce((n, k) => n + k.started, 0),
      devices: devicesAll.size,
      kinds: kinds.length,
    },
  };
}
