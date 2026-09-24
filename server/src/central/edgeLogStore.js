/**
 * central/edgeLogStore.js — 중앙이 엣지에서 가져온 **로그·진행상태 스냅샷**을 보관한다(v2.549).
 *
 * 사용자 선택: "즉석 조회 + 최근분 보관". 그래서 **인메모리 링버퍼**다 — 파일에 쓰지 않는다.
 *  · 근거: `central/partFaultEdge.js` 와 같은 판단. 이 값은 '진실의 원천' 이 아니라 **방금 본 것**이고,
 *    스냅샷마다 로그 수백 줄이라 push 마다 맵 전체를 다시 직렬화하면 그 자체가 블로킹이 된다
 *    (v2.548 실측 12.5MB·74ms/push — svcmon 이 실측 근거로 거부한 방식).
 *  · ⚠ 그래서 **중앙을 재시작하면 보관분이 사라진다**. 화면이 그 사실을 말해야 한다
 *    (`storeInfo().sinceAt` = 이 저장소가 살아 있는 시각).
 *
 * 상한은 **두 축**이다 — 엣지당 건수(`KEEP`)와 봉투당 로그 줄 수(엣지가 이미 `limit` 로 자르지만
 * 중앙도 스스로 막는다. 구버전·조작된 엣지가 거대 본문을 올릴 수 있다 — v2.548 S2 와 같은 규칙).
 */

import { numOrNull } from '../util/numOrNull.js';
const KEEP = Math.max(2, Number(process.env.EDGELOG_KEEP_PER_AGENT) || 10);
const LINE_CAP = Math.max(100, Number(process.env.EDGELOG_LINE_CAP) || 1_000);
const AGENT_CAP = Math.max(10, Number(process.env.EDGELOG_MAX_AGENTS) || 200);

// v2.602(감사 CEN2602-02): 줄 길이·상태 항목·스냅샷 크기 상한. 줄 길이는 엣지 수집(edgelog/collect.js LINE_MAX)과 같은 값.
const LINE_MAX = 2_000;
const STATUS_ITEM_CAP = Math.max(20, Number(process.env.EDGELOG_STATUS_ITEM_CAP) || 200);
const STATUS_MAX_BYTES = Math.max(64 * 1024, Number(process.env.EDGELOG_STATUS_MAX_BYTES) || 512 * 1024);
const SNAP_MAX_BYTES = Math.max(256 * 1024, Number(process.env.EDGELOG_SNAP_MAX_BYTES) || 2 * 1024 * 1024);

// ⚠ `String(v)` 는 toString 이 함수가 아닌 객체에서 던진다 — 글자·숫자만 글자로 받는다.
const t = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const s = (v, max) => { const x = t(v); return x.length > max ? x.slice(0, max) : x; };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const bytesOf = (x) => { try { return JSON.stringify(x).length; } catch { return Infinity; } };

/** 노드 신원(edgelog/collect.js nodeInfo 모양)만 받는다 — 모르는 키·객체 값은 버린다. */
function sanitizeNode(n) {
  if (!isObj(n)) return null;
  return {
    agent: s(n.agent, 128), hostname: s(n.hostname, 128), version: s(n.version, 64), role: s(n.role, 16),
    datacenter: s(n.datacenter, 128), pid: numOrNull(n.pid), uptimeMs: numOrNull(n.uptimeMs), startedAt: numOrNull(n.startedAt),
  };
}
/** 로그 줄 — 평범한 객체만, msg 는 글자 LINE_MAX 자. */
function sanitizeLine(e) {
  if (!isObj(e)) return null;
  const msg = typeof e.msg === 'string' ? e.msg : '';
  return { id: numOrNull(e.id), time: typeof e.time === 'string' || typeof e.time === 'number' ? s(e.time, 40) : '', level: s(e.level, 16), msg: msg.length > LINE_MAX ? msg.slice(0, LINE_MAX) : msg };
}
/** 상태 항목 — 알려진 키만. value 는 크기 합계 상한 안에서만 남기고 넘치면 null + 개수. */
function sanitizeStatus(list) {
  if (!Array.isArray(list)) return { status: null, dropped: 0, valuesDropped: 0 };
  const out = [];
  let dropped = 0, valuesDropped = 0, total = 0;
  for (const x of list) {
    if (!isObj(x)) { dropped += 1; continue; }
    if (out.length >= STATUS_ITEM_CAP) { dropped += 1; continue; }
    const item = { key: s(x.key, 80), label: s(x.label, 120), group: s(x.group, 80), ok: x.ok === true, error: x.error == null ? null : s(x.error, 300), value: null, ...(x.truncated === true ? { truncated: true } : {}) };
    if (x.value != null) {
      const b = bytesOf(x.value);
      if (total + b <= STATUS_MAX_BYTES) { item.value = x.value; total += b; } else { valuesDropped += 1; item.valueDropped = true; }
    }
    out.push(item);
  }
  return { status: out, dropped, valuesDropped };
}
let _map = new Map();       // agentLower -> { agent, snaps: [최신이 뒤] }
let _sinceAt = Date.now();  // 이 저장소가 시작된 시각(재시작 감지)

/**
 * 스냅샷 1건 보관.
 * @param {string} agent  중앙이 아는 엣지 이름(수집 서버 등록부 name). 엣지 본문의 값을 믿지 않는다.
 * @param {object} snap   `collectEdgeLog` 봉투 + `via`('pull'|'job') + `ok`/`error`
 */
export function putEdgeLog(agent, snap = {}) {
  const key = t(agent).toLowerCase();
  if (!key) return null;
  if (!_map.has(key) && _map.size >= AGENT_CAP) return null;   // 엣지 수 상한(무한 증식 방지)
  if (!isObj(snap)) snap = {};
  const logs = isObj(snap.logs) ? snap.logs : null;
  const items = Array.isArray(logs?.items) ? logs.items.slice(-LINE_CAP).map(sanitizeLine).filter(Boolean) : [];
  const capped = Array.isArray(logs?.items) && logs.items.length > items.length;
  const st = sanitizeStatus(snap.status);
  // 스냅샷 하나의 크기 상한 — 넘치면 **오래된 줄부터** 뺀다(진행상태를 보려는 것이라 방금 줄이 중요 — collect.js 와 같은 방향).
  let sizeCapped = 0;
  let lineBytes = items.reduce((a, x) => a + x.msg.length + 64, 0);
  while (items.length && lineBytes > SNAP_MAX_BYTES - STATUS_MAX_BYTES) { const x = items.shift(); lineBytes -= x.msg.length + 64; sizeCapped += 1; }
  const rec = {
    at: Date.now(),
    via: s(snap.via, 16) || 'pull',
    ok: snap.ok !== false,
    error: snap.error ? (s(snap.error, 300) || '(형식 오류)') : null,
    // ⚠ v2.574 BUG-06 — `Number(null) === 0` 이라 예전 형태는 **'못 읽음' 을 '0ms(즉시 응답)'**
    //   으로 바꿨다. 측정값 판정은 `numOrNull` 하나가 갖는다(v2.561 규약).
    ms: numOrNull(snap.ms),
    reportedAt: numOrNull(snap.at),
    node: sanitizeNode(snap.node),
    logs: logs ? {
      lastId: numOrNull(logs.lastId) ?? 0, oldestId: items.length ? items[0].id : numOrNull(logs.oldestId),
      count: items.length, matched: numOrNull(logs.matched) ?? items.length,
      // 엣지가 자른 것과 중앙이 자른 것을 **구분해 밝힌다** — 조치가 다르다(limit 을 올린다 / 엣지를 본다).
      truncated: logs.truncated === true, omitted: numOrNull(logs.omitted) ?? 0, centralCapped: capped || sizeCapped > 0,
      ...(sizeCapped ? { sizeCapped } : {}),
      items,
    } : null,
    status: st.status,
    ...(st.dropped || st.valuesDropped ? { statusCapped: { dropped: st.dropped, valuesDropped: st.valuesDropped } } : {}),
    // ⚠⚠ v2.574 BUG-07 — 생산자 `edgelog/collect.js:101` 은 `withStatus=false` 면 **정직하게
    //   `null`** 을 주는데 여기서 0 이 되어 화면이 **"상태 점검 실패 0건"**(= 점검을 안 한 것을
    //   '전부 정상' 으로)이라 말했다. v2.561 이 스토리지 적재에서 겪은 것과 같은 유형이다.
    statusFailed: numOrNull(snap.statusFailed),
    maskedFields: numOrNull(snap.maskedFields) ?? 0,
  };
  const cur = _map.get(key) || { agent: t(agent), snaps: [] };
  cur.agent = t(agent) || cur.agent;
  cur.snaps.push(rec);
  if (cur.snaps.length > KEEP) cur.snaps.splice(0, cur.snaps.length - KEEP);
  _map.set(key, cur);
  return rec;
}

/** 그 엣지의 최신 스냅샷(없으면 null). */
export function latestEdgeLog(agent) {
  const c = _map.get(t(agent).toLowerCase());
  return c && c.snaps.length ? c.snaps[c.snaps.length - 1] : null;
}

/**
 * 그 엣지의 **내용이 있는** 최신 스냅샷(실패 기록은 건너뛴다).
 * ⚠ 실패도 `putEdgeLog` 로 기록하므로(사유를 남기려고) `latestEdgeLog` 가 **로그 없는 실패 행**일 수
 *   있다. 그것을 화면에 '보관분' 이라고 내주면 "아래는 N분 전 가져온 값" 이라 말해 놓고 **빈 화면**이
 *   된다 — 거짓 안내다. 실패 사유는 별도 필드로 전하고, 보여줄 값은 이 함수가 고른다.
 */
export function lastDataEdgeLog(agent) {
  const c = _map.get(t(agent).toLowerCase());
  if (!c) return null;
  for (let i = c.snaps.length - 1; i >= 0; i -= 1) if (c.snaps[i].ok && c.snaps[i].logs) return c.snaps[i];
  return null;
}

/** 그 엣지의 보관분 전부(최신이 뒤). */
export function edgeLogHistory(agent) {
  const c = _map.get(t(agent).toLowerCase());
  return c ? [...c.snaps] : [];
}

/** 엣지별 요약(목록 화면용) — 로그 본문은 빼고 크기만 준다. */
export function edgeLogSummaries() {
  const out = [];
  for (const [, c] of _map) {
    const last = c.snaps[c.snaps.length - 1] || null;
    out.push({
      agent: c.agent, kept: c.snaps.length,
      // ⚠ '보관분이 있다' 는 **내용이 있는 기록이 있다** 는 뜻이다 — 실패 기록만 있는 것을 보관분이라
      //   세면 KPI 가 '보관분 있음 1' 이라 말해 놓고 열면 빈 화면이다(v2.549 스크린샷 판독에서 발견).
      hasData: c.snaps.some((x) => x.ok && x.logs),
      at: last?.at || null, via: last?.via || null, ok: last?.ok ?? null, error: last?.error || null, ms: last?.ms ?? null,
      node: last?.node || null,
      logCount: last?.logs?.count ?? null, logTruncated: !!last?.logs?.truncated,
      statusFailed: last?.statusFailed ?? null, maskedFields: last?.maskedFields ?? 0,
    });
  }
  return out;
}

/** 저장소 자체의 사실 — 화면이 '재시작해서 비었다' 와 '한 번도 안 가져왔다' 를 구분한다. */
export function storeInfo() {
  return { sinceAt: _sinceAt, agents: _map.size, keepPerAgent: KEEP, lineCap: LINE_CAP, agentCap: AGENT_CAP };
}

export function _resetForTest() { _map = new Map(); _sinceAt = Date.now(); }
