/**
 * central/partFaultEdge.js — 엣지가 올린 **파트 장애 보고**를 중앙이 보관한다(v2.547).
 *
 * 엣지는 `partfault/push.js` 로 `{open[], scanned, deviceOk}` 를 주기마다 보낸다.
 * 이 모듈은 **에이전트별 최신 보고 1건**만 갖는다 — 이력은 `partfault/db.js` 가 소유한다.
 * 캐시 성격이라 손상되면 새로 시작한다(`preserveCorrupt` 대상 아님 — v2.516 규약).
 *
 * ⚠ **보고가 없는 엣지를 '장애 없음' 이라 말하지 말 것** — '모른다' 다. 화면이 그 구분을
 *   할 수 있도록 `at`(마지막 보고 시각)을 반드시 함께 보관한다(v2.517 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'partfault-edge.json');
let _map = null;

function load() {
  if (_map) return _map;
  try { _map = new Map(Object.entries(JSON.parse(fs.readFileSync(FILE(), 'utf8')))); }
  catch { _map = new Map(); }   // 캐시 — 손상 시 재생성
  return _map;
}
function persist() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(Object.fromEntries(load())), { mode: 0o600 }); }
  catch { /* 파일 쓰기 실패가 수신을 막지 않는다 */ }
}

/**
 * 한 엣지의 보고를 저장한다.
 * @param {string} agent  **인증된** agent 이름(body.agent 를 그대로 믿지 않는다 — 라우트가 정한다)
 */
export function putEdgeReport(agent, body = {}) {
  const key = String(agent || '').trim();
  if (!key) return { ok: false, reason: 'agent 없음' };
  const open = Array.isArray(body.open) ? body.open : [];
  load().set(key, {
    at: Date.now(),
    reportedAt: Number(body.at) || null,
    open,
    /*
     * 상태를 읽지 못한 파트의 키(값 없음) — 중앙이 '목록에 없으니 해소' 로 오판하지 않게 한다.
     * ⚠ **필드가 없으면 `null`**(빈 배열이 아니다) — 구버전 엣지와 '이번엔 unknown 이 하나도
     *   없었다' 를 구분해야 한다. `[]` 로 정규화하면 구버전 보고가 '완전한 정보' 로 둔갑해
     *   중앙이 그 엣지의 장애를 **거짓으로 닫는다**(v2.547 자체 테스트가 이 결함을 잡았다).
     */
    unknownKeys: Array.isArray(body.unknownKeys) ? body.unknownKeys.map((k) => String(k)) : null,
    omitted: Number(body.omitted) || 0,
    scanned: body.scanned || null,
    deviceOk: body.deviceOk && typeof body.deviceOk === 'object' ? body.deviceOk : {},
  });
  persist();
  return { ok: true, open: open.length };
}

export function edgeReports() { return [...load().entries()].map(([agent, r]) => ({ agent, ...r })); }
export function edgeReport(agent) { return load().get(String(agent || '').trim()) || null; }
export function _resetForTest() { _map = null; }

/**
 * 모든 엣지 보고를 합쳐 전이 입력으로 만든다.
 * ⚠ **오래된 보고는 쓰지 않는다** — 엣지가 죽으면 그 엣지의 장애가 영원히 '지금 열려 있는 것'
 *   으로 남는다. `staleMs` 를 넘으면 `deviceOk` 를 **전부 false** 로 바꿔(= '이번엔 못 봤다')
 *   전이가 그 장비들을 **닫지 않게** 한다. 지우지도 않는다 — 둘 다 거짓이기 때문이다.
 * @returns {{open:Array, deviceOk:Object, agents:Array}}
 */
export function mergeEdgeReports({ staleMs = 3 * 3_600_000, now = Date.now() } = {}) {
  const open = [];
  const deviceOk = {};
  const agents = [];
  const unknownKeys = new Set();
  /** unknown 키 목록이 상한으로 잘린 엣지 — 그 엣지의 장애는 이번에 **닫지 않는다**. */
  const unknownTruncated = new Set();
  for (const r of edgeReports()) {
    const age = now - (Number(r.at) || 0);
    const stale = age > staleMs;
    agents.push({
      agent: r.agent, at: r.at, stale, ageMs: age,
      open: (r.open || []).length, omitted: r.omitted || 0, scanned: r.scanned || null,
    });
    for (const p of r.open || []) open.push({ ...p, agent: p.agent || r.agent });
    for (const [id, ok] of Object.entries(r.deviceOk || {})) deviceOk[id] = stale ? false : !!ok;
    // ⚠ 오래된 보고의 unknownKeys 는 쓰지 않는다 — 어차피 그 엣지의 장비는 deviceOk=false 라
    //   전이가 손대지 않는다(중복 보호).
    if (!stale) for (const k of r.unknownKeys || []) unknownKeys.add(String(k));
    /*
     * ⚠ 구버전 엣지(unknownKeys 자체가 없음)와 **상한으로 잘린 엣지**는 'unknown 이라 사라진 것'
     *   과 '해소돼 사라진 것' 을 구분할 수 없다. 둘 다 **닫지 않는 쪽**으로 실패시킨다 —
     *   거짓 '복구' 는 이 기능이 만들 수 있는 최악의 거짓이고, 반대(조금 늦게 닫힘)는 회복 가능하다.
     */
    const legacy = !Array.isArray(r.unknownKeys);
    if (!stale && (legacy || Number(r.scanned?.unknownOmitted) > 0)) unknownTruncated.add(r.agent);
  }
  return { open, deviceOk, agents, unknownKeys, unknownTruncated };
}
