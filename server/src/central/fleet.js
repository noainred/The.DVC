/**
 * 엣지 베어메탈 집계 — 중앙(OC2) 측 캐시.
 *
 * 각 엣지(현장) 포탈은 자기 데이터센터의 베어메탈 서버(전력 미보고분 포함)를 중앙으로 push 한다.
 * 중앙은 vCenter 인벤토리(hosts/vms)나 원격 전력(remotePowerByHost)만으로는 보이지 않는
 * '전력 없는 베어메탈'까지 여기 모아 통합 인벤토리에 병합한다(DC별 검색).
 *
 * 메모리 + 디스크(CONFIG_DIR/central-fleet.json) 보관. 오래된 에이전트 보고는 TTL로 만료한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { bumpFleetRev } from '../insights/fleetRev.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js'; // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다

const FILE = path.join(config.configDir, 'central-fleet.json');
const TTL_MS = Number(process.env.CENTRAL_FLEET_TTL_MS) || 30 * 60_000; // 30분 무보고 시 만료
const MAX_AGENTS = Number(process.env.CENTRAL_FLEET_MAX_AGENTS) || 500; // 에이전트 수 상한(메모리 보호)
// v2.601(감사 CEN2601-03): 원소 상한. 예전에는 에이전트당 50,000 × 500 에이전트를 받았고, 공유 토큰은 본문 agent 이름을
//   마음대로 고를 수 있어 이름 40개 × 50,000 원소로 RSS 가 크게 불고 central-fleet.json 이 195MB 가 되어 **저장마다 약 1.8초**
//   이벤트 루프가 멈췄다(JSON.stringify 전량). 현실적인 에이전트당 상한 + 전체 상한 + '검증되지 않은 이름' 별도 상한을 둔다.
//   잘린 원소는 **개수로 밝힌다**(omitted — 조용한 상한 금지).
const PER_AGENT_MAX = Number(process.env.CENTRAL_FLEET_MAX_PER_AGENT) || 5_000;
const TOTAL_MAX = Number(process.env.CENTRAL_FLEET_MAX_TOTAL) || 20_000;
// 검증되지 않은 이름(공유 토큰 + 중앙이 모르는 이름)은 이름 수·원소 수를 작게 묶는다 — 검증된 엣지의 몫을 밀어내지 못하게.
const UNVERIFIED_MAX_AGENTS = Number(process.env.CENTRAL_FLEET_MAX_UNVERIFIED_AGENTS) || 20;
const UNVERIFIED_TOTAL_MAX = Number(process.env.CENTRAL_FLEET_MAX_UNVERIFIED_TOTAL) || 5_000;
const norm = (s) => String(s || '').trim().toLowerCase();

// null-proto: 에이전트 이름이 '__proto__' 등이어도 프로토타입 오염 없이 일반 키로 저장.
let cache = Object.create(null); // agent -> { at, generatedAt, baremetal: [...] }
try {
  if (fs.existsSync(FILE)) {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (p && typeof p === 'object') cache = Object.assign(Object.create(null), p.fleet || {});
    // v2.601 CEN2601-03: 상한 이전에 저장된 큰 파일도 에이전트당 상한으로 줄여 올린다(다음 저장이 다시 작아지게).
    for (const [a, e] of Object.entries(cache)) {
      if (!e || typeof e !== 'object' || !Array.isArray(e.baremetal)) { delete cache[a]; continue; }
      if (e.baremetal.length > PER_AGENT_MAX) { e.omitted = (Number(e.omitted) || 0) + (e.baremetal.length - PER_AGENT_MAX); e.baremetal = e.baremetal.slice(0, PER_AGENT_MAX); }
    }
  }
} catch (e) { cache = Object.create(null); console.warn(`[central-fleet] ${path.basename(FILE)} 를 읽지 못해 빈 캐시로 시작합니다(엣지의 다음 push 로 채워집니다): ${e.message}`); }

let writeTimer = null;
let writing = false;   // 비동기 원자 쓰기 진행 중
let dirty = false;     // 마지막 쓰기 이후 바뀐 것이 있다(종료 flush 판정)
function persistSoon() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    // v2.591 L8: 대상 파일에 직접 비동기 쓰기였다(v2.582 ARCH-3 주석은 '원자 쓰기' 라 적었다) — 쓰는 중 종료되면 절단본이
    //   남아 재기동 시 JSON 무효 → 빈 함대로 시작했다(재현: 1MB 시점 exit). 임시 파일에 쓰고 rename 한다(루프를 막지 않게 비동기).
    if (writing) { persistSoon(); return; }
    writing = true; dirty = false;
    const tmp = `${FILE}.tmp-${process.pid}`;
    (async () => {
      try {
        await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify({ fleet: cache }), { mode: 0o600 });
        await fs.promises.rename(tmp, FILE);
      } catch { dirty = true; try { await fs.promises.unlink(tmp); } catch { /* */ } }
      finally { writing = false; }
    })();
  }, 5_000);
  writeTimer.unref?.();
}

// 종료(SIGTERM/SIGINT/exit) 시 디바운스 대기 중인 마지막 엣지 보고를 동기로 flush — 재시작 시 ~5초
// 윈도우 유실 방지. 중앙 역할일 때만 핸들러 등록(테스트/엣지에서 부작용·중복 쓰기 방지).
export function flushEdgeFleetNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  dirty = false;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify({ fleet: cache }), { mode: 0o600 }); } catch { /* best-effort */ }
}
if (config.central?.token && !config.agent?.centralUrl) {
  // v2.582 ARCH-4: 자체 exit 훅 대신 공용 레지스트리(util/exitFlush.js). 시그널 훅은 두지 않는다 — index.js
  // gracefulExit 이 process.exit 을 부르므로 exit 훅 하나로 flush 가 보장된다(v2.447 판단 그대로).
  // v2.591 L8: 비동기 쓰기가 진행 중이거나(writing) 그 뒤 바뀐 것이 있으면(dirty) 동기 원자 쓰기로 마무리한다 —
  //   예전에는 writeTimer 가 있을 때만 flush 해 '쓰는 중' 종료를 건너뛰었다.
  registerExitFlush('central/fleet', () => { if (writeTimer || writing || dirty) flushEdgeFleetNow(); });
  // v2.447(감사 I3): 종료 결정은 index.js gracefulExit 한 곳에만 둔다 — 여기서 process.exit 을 부르지 말 것.
}

/**
 * 엣지가 push한 베어메탈 목록 저장.
 * @param {object} [opts]
 * @param {boolean} [opts.verified=true] 이름이 검증됐는가(개별 토큰 또는 중앙이 이미 아는 이름). false 면 별도 작은 상한.
 * @param {(vcenterId:string)=>boolean} [opts.vcAllowed] 원소의 vcenterId 를 이 에이전트가 써도 되는가(v2.601 CEN2601-02).
 *   거짓이면 그 원소를 버리지 않고 **vcenterId 만 비운다**(미귀속) — 서버 자체는 실재하므로 목록에서 사라지게 하지 않는다.
 * @returns {{accepted:number, omitted:number, vcenterBlanked:number}}
 */
export function setEdgeFleet(agent, baremetal, generatedAt, { verified = true, vcAllowed = null } = {}) {
  const a = String(agent || '').trim();
  if (!a) return { accepted: 0, omitted: 0, vcenterBlanked: 0 };
  // 신규 '미검증' 이름이 상한이면 가장 오래된 미검증 보고를 밀어낸다(검증된 엣지는 건드리지 않는다).
  if (!verified && !cache[a]) {
    const unv = Object.entries(cache).filter(([, e]) => e && e.verified === false);
    if (unv.length >= UNVERIFIED_MAX_AGENTS) {
      const oldest = unv.sort((x, y) => (x[1]?.at || 0) - (y[1]?.at || 0))[0];
      if (oldest) { delete cache[oldest[0]]; console.warn(`[central-fleet] 검증되지 않은 에이전트 이름 상한(${UNVERIFIED_MAX_AGENTS}) — 가장 오래된 '${oldest[0]}' 퇴출`); }
    }
  }
  // 이 에이전트가 받을 수 있는 원소 수 = min(에이전트당 상한, 전체 상한 − 다른 에이전트 합, [미검증] 미검증 합 상한 − 다른 미검증 합)
  let others = 0, othersUnv = 0;
  for (const [k, e] of Object.entries(cache)) {
    if (k === a || !e) continue;
    const n = Array.isArray(e.baremetal) ? e.baremetal.length : 0;
    others += n; if (e.verified === false) othersUnv += n;
  }
  let room = Math.max(0, Math.min(PER_AGENT_MAX, TOTAL_MAX - others));
  if (!verified) room = Math.max(0, Math.min(room, UNVERIFIED_TOTAL_MAX - othersUnv));
  // v2.591(3차 감사 PR-8): null·문자열 원소는 건너뛴다(v2.548 S1 규약) — `{"baremetal":[null]}` 가 TypeError → 500 이었다.
  const valid = Array.isArray(baremetal) ? baremetal.filter((b) => b && typeof b === 'object' && !Array.isArray(b)) : [];
  const omitted = Math.max(0, valid.length - room);
  let vcenterBlanked = 0;
  const vcOf = (b) => {
    const v = typeof b.vcenterId === 'string' || typeof b.vcenterId === 'number' ? String(b.vcenterId).slice(0, 128) : '';
    if (v && typeof vcAllowed === 'function' && !vcAllowed(v)) { vcenterBlanked++; return ''; }
    return v;
  };
  const list = valid.slice(0, room).map((b) => ({
    fleetId: String(b.fleetId || b.serviceTag || b.serverId || '').slice(0, 256),
    name: String(b.name || '').slice(0, 256),
    model: String(b.model || '').slice(0, 256),
    serviceTag: String(b.serviceTag || '').slice(0, 128),
    // 엣지 push는 '전력 미보고 베어메탈' 메타 전용(설계). 전력은 원격 수집(collector pull) 경로로만
    // 중앙에 반영되므로 엣지 watts는 항상 null로 정규화 — fleet KPI와 FinOps/PowerMap의 이중계상 차단.
    watts: null,
    vcenterId: vcOf(b),
    source: String(b.source || '').slice(0, 32),
  }));
  if (omitted) console.warn(`[central-fleet] '${a}' 베어메탈 ${valid.length}대 중 ${omitted}대를 상한으로 받지 않았습니다(에이전트당 ${PER_AGENT_MAX} · 전체 ${TOTAL_MAX}${verified ? '' : ` · 미검증 이름 합 ${UNVERIFIED_TOTAL_MAX}`}).`);
  if (vcenterBlanked) console.warn(`[central-fleet] '${a}' 가 소유하지 않은 vCenter 로 귀속된 베어메탈 ${vcenterBlanked}대 — 귀속(vcenterId)을 비웠습니다.`);
  // 신규 에이전트인데 상한 초과 → 가장 오래된 보고를 밀어내고 받는다(메모리 무한 누적 방지).
  if (!cache[a] && Object.keys(cache).length >= MAX_AGENTS) {
    const oldest = Object.entries(cache).sort((x, y) => (x[1]?.at || 0) - (y[1]?.at || 0))[0];
    if (oldest) { delete cache[oldest[0]]; console.warn(`[central-fleet] 에이전트 상한(${MAX_AGENTS}) 초과 — 가장 오래된 '${oldest[0]}' 퇴출(신규 '${a}' 수용)`); }
  }
  // 내용 해시(전력 제외 — 미세 변동으로 무효화 폭증 방지). 분류에 영향 주는 필드만.
  const sig = hashList(list);
  const prev = cache[a];
  cache[a] = { at: Date.now(), generatedAt: typeof generatedAt === 'string' || typeof generatedAt === 'number' ? generatedAt : null, baremetal: list, sig, verified: !!verified, ...(omitted ? { omitted } : {}), ...(vcenterBlanked ? { vcenterBlanked } : {}) };
  if (!prev || prev.sig !== sig) bumpFleetRev(); // 내용이 바뀐 경우에만 캐시 무효화
  persistSoon();
  return { accepted: list.length, omitted, vcenterBlanked };
}

// 분류 관련 필드만으로 안정 해시(djb2). 전력(watts)은 remote 경로/TTL로 반영하므로 제외.
function hashList(list) {
  let h = 5381;
  const s = list.map((b) => `${b.fleetId}|${b.serviceTag}|${b.vcenterId}|${b.name}`).sort().join('\n');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

/** TTL 지난(무보고) 에이전트 제거 후 살아있는 캐시 반환. */
function liveCache() {
  const now = Date.now();
  let changed = false;
  for (const [a, e] of Object.entries(cache)) {
    if (!e || (now - (e.at || 0)) > TTL_MS) { delete cache[a]; changed = true; }
  }
  // 만료로 에이전트가 빠지면 /fleet 캐시 키를 무효화 — 오프라인 엣지 베어메탈이 최대 60s stale로
  // 남지 않게 즉시 반영.
  if (changed) { persistSoon(); bumpFleetRev(); }
  return cache;
}

/**
 * 통합 인벤토리 병합용 — 엣지 보고 베어메탈을 classifyFleet의 servers 형식으로 변환.
 * serverId는 agent+fleetId로 유일화, source='edge', remoteAgent로 출처 표시.
 */
export function getEdgeFleetServers() {
  const out = [];
  for (const [agent, e] of Object.entries(liveCache())) {
    for (const b of (e.baremetal || [])) {
      const st = b.serviceTag || '';
      out.push({
        serverId: `edge:${agent}:${b.fleetId || st || b.name}`,
        serverName: b.name || st || b.fleetId,
        serviceTag: st,
        model: b.model || '',
        host: norm(st || b.name),
        hostNames: [norm(st), norm(b.name)].filter(Boolean),
        watts: Number.isFinite(b.watts) ? b.watts : null,
        vcenterId: b.vcenterId || '',
        source: 'edge',
        remoteAgent: agent,
      });
    }
  }
  return out;
}

/** 운영 화면용 요약. */
export function listEdgeFleet() {
  return Object.entries(liveCache()).map(([agent, e]) => ({
    agent, at: e.at, generatedAt: e.generatedAt, baremetal: (e.baremetal || []).length,
    // v2.601 CEN2601-02·03: 상한으로 받지 않은 수·귀속을 비운 수·이름 검증 여부를 화면이 말할 수 있게 싣는다.
    omitted: e.omitted || 0, vcenterBlanked: e.vcenterBlanked || 0, verified: e.verified !== false,
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 테스트/관리용 초기화. */
export function resetEdgeFleet() { cache = {}; }
