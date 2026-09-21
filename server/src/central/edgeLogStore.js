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

const t = (v) => String(v ?? '').trim();
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
  const logs = snap.logs && typeof snap.logs === 'object' ? snap.logs : null;
  const items = Array.isArray(logs?.items) ? logs.items.slice(-LINE_CAP) : [];
  const capped = Array.isArray(logs?.items) && logs.items.length > items.length;
  const rec = {
    at: Date.now(),
    via: t(snap.via) || 'pull',
    ok: snap.ok !== false,
    error: snap.error ? String(snap.error).slice(0, 300) : null,
    // ⚠ v2.574 BUG-06 — `Number(null) === 0` 이라 예전 형태는 **'못 읽음' 을 '0ms(즉시 응답)'**
    //   으로 바꿨다. 측정값 판정은 `numOrNull` 하나가 갖는다(v2.561 규약).
    ms: numOrNull(snap.ms),
    reportedAt: Number(snap.at) || null,
    node: snap.node && typeof snap.node === 'object' ? snap.node : null,
    logs: logs ? {
      lastId: Number(logs.lastId) || 0, oldestId: logs.oldestId ?? null,
      count: items.length, matched: Number(logs.matched) || items.length,
      // 엣지가 자른 것과 중앙이 자른 것을 **구분해 밝힌다** — 조치가 다르다(limit 을 올린다 / 엣지를 본다).
      truncated: !!logs.truncated, omitted: Number(logs.omitted) || 0, centralCapped: capped,
      items,
    } : null,
    status: Array.isArray(snap.status) ? snap.status : null,
    // ⚠⚠ v2.574 BUG-07 — 생산자 `edgelog/collect.js:101` 은 `withStatus=false` 면 **정직하게
    //   `null`** 을 주는데 여기서 0 이 되어 화면이 **"상태 점검 실패 0건"**(= 점검을 안 한 것을
    //   '전부 정상' 으로)이라 말했다. v2.561 이 스토리지 적재에서 겪은 것과 같은 유형이다.
    statusFailed: numOrNull(snap.statusFailed),
    maskedFields: Number(snap.maskedFields) || 0,
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
