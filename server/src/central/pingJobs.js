/**
 * 에이전트 위임 Ping 작업큐(인메모리) — claim→ack 2단계 확인응답(v2.290 #6-B).
 *
 * 중앙 포탈은 현장 VM IP(특히 사설/내부망)에 직접 못 가므로, 그 vCenter를 담당하는
 * 현장 에이전트가 ping을 대행한다.
 *   UI    → POST /api/tools/ip-ping(vcenterId, ips)         → enqueuePing
 *   Agent ← GET  /api/central/ping-jobs?vcenters=...        → takePingJobs (4초 폴, agent/pingWorker.js)
 *   Agent → POST /api/central/ping-result(vcenterId, ...)   → setPingResults (IP별 ack)
 *   UI    ← GET  /api/tools/ip-ping?vcenterId&ips=...       → getPingResults (녹/적/대기 표시)
 *
 * ── 왜 2단계(claim→ack)인가 ──
 * 종전(v2.289 이하)에는 takePingJobs 가 인출 즉시 대기열에서 IP를 삭제했다(1단계 인출).
 * 두 가지 문제가 있었다:
 *   1) 유실 — 엣지가 인출 직후 재시작/단절되면 그 IP들은 결과가 영영 없고, 사용자가 다시
 *      요청하기 전까지 상태 미상으로 남는다.
 *   2) UI 결함 — 인출 즉시 pending 에서 빠지므로, 에이전트가 ping 을 도는 몇 초 동안 UI 가
 *      'pending' 이 아니라 'unknown'(회색) 으로 떨어졌다가 결과가 오면 다시 색이 바뀌었다(깜빡임).
 * 인출된 IP를 in-flight(진행 중) 맵으로 옮겨 추적하면 두 문제가 함께 풀린다: 기한 내 결과(ack)가
 * 없으면 대기로 되돌려 재인출시키고(재시도 상한 초과 시 폐기), UI 는 in-flight 도 'pending' 으로 본다.
 *
 * ── 타임아웃 근거(코드 기반, 추정 아님) ──
 * 에이전트 실행측(agent/pingWorker.js): pingMany(timeoutMs 1500, concurrency 8) + 결과 POST
 * (timeoutMs 15s, retries 2). vCenter당 대기 IP 상한 MAX_IPS=64 → 최악 64/8×1.5s ≈ 12초 + 회신.
 * ACK 기한 30초는 그 2 배 이상의 여유다. 폴 주기 4초 → 재인출 지연은 수 초 내.
 *
 * ── 컴팩트(요약) 후 이어받기 메모 ──
 * v2.290 에서 1단계 인출 → 2단계 claim→ack 로 개편. 같은 개편이 captureJobs.js(잡 단위)에도
 * 적용됐고 idracScanJobs.js 가 원형. ping 은 잡 단위가 아니라 IP 단위로 in-flight 를 추적한다
 * (에이전트 회신이 IP 배열이라 개별 IP 가 ack 단위). 회귀 테스트: server/test/pingJobsClaim.test.js.
 *
 * vCenterId 기준으로 키잉한다(UI는 vcenterId를, 에이전트는 자기 vcenters.json의 id를 앎).
 */

const pending = new Map();  // vcenterId -> Map<ip, { at, tries }>          (요청됐으나 아직 인출 안 된 IP)
const inflight = new Map(); // vcenterId -> Map<ip, { deadline, tries }>    (인출됐고 결과(ack) 대기 중인 IP)
const results = new Map();  // vcenterId -> Map<ip, { alive, rttMs, at }>

const RESULT_TTL = 5 * 60_000; // 결과 보존 5분
const UP_STICKY_MS = 2 * 60_000; // 최근 'up'은 이 시간 동안 down 보고로 덮어쓰지 않음(멀티홈/멀티에이전트 깜빡임 방지)
const MAX_IPS = 64;            // 한 vCenter당 동시 대기 IP 상한(남용 방지)
// 한 vCenter당 결과 맵 상한. pending 은 MAX_IPS 로 묶이지만 결과 보고엔 상한이 없어, 탈취/오작동
// 에이전트가 '요청한 적 없는' IP 를 대량 보고하면 TTL(5분) 만료 전까지 맵이 무한 증식한다(메모리 남용).
// 상한 초과 시 가장 오래된 항목부터 축출한다(감사 L17).
const MAX_RESULT_IPS = 512;
// 인출(claim) 후 결과(ack) 기한 — 근거는 파일 헤더 주석(최악 ~12초 실행 + 회신의 2배 이상 여유).
const ACK_TIMEOUT_MS = Number(process.env.PING_ACK_TIMEOUT_MS) || 30_000;
// IP당 재인출 한도 — 초과 시 폐기(UI는 unknown). ping 은 저비용·멱등이라 2회면 충분하고,
// 무한 재시도는 죽은 엣지에 같은 IP 를 영원히 돌리는 낭비가 된다.
const MAX_TRIES = 2;

/**
 * 만료 in-flight 재수확 — 기한 내 결과(ack)가 없는 IP 를 처리한다.
 * - 재시도 남음(tries < MAX_TRIES): pending 으로 복귀(다음 폴에 재인출 — 같은/다른 에이전트).
 * - 한도 도달: 폐기(결과 없음 → UI 는 unknown). 오류 결과를 남기지 않는 이유: ping 결과 모델이
 *   { alive } 뿐이라 실패 사유 필드가 없고, down 으로 기록하면 '실제 다운'과 '에이전트 미회신'이
 *   섞여 오판을 만든다(정직하게 '모름' 상태로 남긴다).
 * now 는 테스트에서 시간 제어용으로 주입 가능.
 */
export function reapPingClaims(now = Date.now()) {
  let requeued = 0, dropped = 0;
  for (const [vc, fl] of inflight) {
    for (const [ip, f] of fl) {
      if (now <= f.deadline) continue;
      fl.delete(ip);
      if ((f.tries || 0) >= MAX_TRIES) { dropped++; continue; }
      const m = pending.get(vc) || new Map();
      // 재복귀도 대기 상한을 지킨다(복귀분이 상한을 밀어내지 않게 초과분은 폐기 — 남용 방지 우선).
      if (m.size < MAX_IPS) { m.set(ip, { at: now, tries: f.tries || 0 }); pending.set(vc, m); requeued++; }
      else dropped++;
    }
    if (!fl.size) inflight.delete(vc);
  }
  return { requeued, dropped };
}

/** UI가 ping을 요청 — 대기열에 추가(중복 IP는 갱신). 이미 진행 중(in-flight)인 IP는 곧 결과가 오므로 중복 적재하지 않는다. */
export function enqueuePing(vcenterId, ips = []) {
  if (!vcenterId) return 0;
  reapPingClaims(); // 만료분을 먼저 정리해 in-flight 중복 판정이 낡은 항목에 걸리지 않게
  const m = pending.get(vcenterId) || new Map();
  const fl = inflight.get(vcenterId);
  const now = Date.now();
  for (const ip of ips) {
    const v = String(ip || '').trim();
    if (!v || m.size >= MAX_IPS) continue;
    if (fl && fl.has(v)) continue; // 진행 중 — 재적재하면 결과 도착 직후 또 인출되는 낭비
    m.set(v, { at: now, tries: m.get(v)?.tries || 0 });
  }
  pending.set(vcenterId, m);
  return m.size;
}

/**
 * 에이전트가 자기 담당 vCenter들의 대기 IP를 인출(claim) — 대기열에서 빼되 in-flight 로 옮겨
 * 기한을 건다. 기한 내 결과(ack)가 없으면 reap 이 대기로 되돌린다(2단계 확인응답의 핵심).
 */
export function takePingJobs(vcenterIds = [], now = Date.now()) {
  reapPingClaims(now); // 만료 in-flight 를 먼저 대기로 복귀 → 이번 인출에 즉시 포함(재시도 지연 최소화)
  const out = {};
  for (const vc of vcenterIds) {
    const m = pending.get(vc);
    if (!m || !m.size) continue;
    const fl = inflight.get(vc) || new Map();
    for (const [ip, p] of m) fl.set(ip, { deadline: now + ACK_TIMEOUT_MS, tries: (p.tries || 0) + 1 });
    inflight.set(vc, fl);
    out[vc] = [...m.keys()];
    pending.delete(vc);
  }
  return out;
}

/** 에이전트가 ping 결과 보고. results: [{ ip, alive, rttMs }]. 보고된 IP는 in-flight 에서 제거(= IP별 ack). */
export function setPingResults(vcenterId, rows = []) {
  if (!vcenterId) return;
  const m = results.get(vcenterId) || new Map();
  const fl = inflight.get(vcenterId);
  const now = Date.now();
  for (const r of rows) {
    if (!r || !r.ip) continue;
    const key = String(r.ip);
    // ack — 이 IP 의 결과가 왔으므로 재수확 대상에서 제외. (요청한 적 없는 IP 보고는 fl 에 없어 무해.)
    if (fl) { fl.delete(key); if (!fl.size) inflight.delete(vcenterId); }
    const prev = m.get(key);
    // 도달성은 'OR' — 한 vantage point(중앙/다른 망 에이전트)라도 최근에 응답했으면 up 유지.
    // 다른 곳에서 못 닿아 down을 보고해도 신선한 up을 덮어쓰지 않는다(녹↔적 깜빡임 방지).
    if (!r.alive && prev && prev.alive && (now - prev.at) < UP_STICKY_MS) continue;
    m.set(key, { alive: !!r.alive, rttMs: r.rttMs ?? null, at: now });
  }
  // TTL 만료 정리
  for (const [ip, v] of m) if (now - v.at > RESULT_TTL) m.delete(ip);
  // 상한 초과 시 가장 오래된 항목부터 축출(대량 보고로 인한 메모리 남용 방지).
  if (m.size > MAX_RESULT_IPS) {
    const oldest = [...m.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < oldest.length && m.size > MAX_RESULT_IPS; i++) m.delete(oldest[i][0]);
  }
  results.set(vcenterId, m);
}

/**
 * UI가 결과 조회 — { ip: { alive, rttMs, at, ageMs } }. 미수행 IP는 결과 없음(pending 여부 포함).
 * in-flight(인출돼 에이전트가 ping 도는 중)도 'pending' 으로 표시한다 — 종전에는 인출 즉시
 * pending 에서 빠져 결과 도착 전까지 'unknown'(회색)으로 깜빡였다(v2.290 에서 함께 수정).
 */
export function getPingResults(vcenterId, ips = []) {
  reapPingClaims(); // 만료 in-flight 가 'pending' 으로 영원히 보이지 않게 조회 시에도 정리
  const m = results.get(vcenterId) || new Map();
  const pend = pending.get(vcenterId) || new Map();
  const fl = inflight.get(vcenterId) || new Map();
  const now = Date.now();
  const out = {};
  for (const ip of ips) {
    const key = String(ip);
    const r = m.get(key);
    if (r && now - r.at <= RESULT_TTL) out[key] = { alive: r.alive, rttMs: r.rttMs, ageMs: now - r.at, state: r.alive ? 'up' : 'down' };
    else out[key] = { state: (pend.has(key) || fl.has(key)) ? 'pending' : 'unknown' };
  }
  return out;
}
