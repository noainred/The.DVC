/**
 * Ping 모니터링 폴러 — 등록된 활성 대상을 주기적으로 프로브(ICMP 또는 TCP 연결 지연)해
 * 시계열 DB에 기록한다. 파이썬 원본의 run_loop/record_once를 Node로 이식.
 *
 * 성능/안정성(운영 환경 규칙 준수):
 *  - 재진입 가드(pollOnce): 이전 주기가 간격을 넘겨도 중첩 실행하지 않는다.
 *  - 동시성 제한(config.ping.concurrency): 다수 대상 프로브가 이벤트 루프/소켓을 폭주시키지 않게.
 *  - per-대상 타임아웃(config.ping.timeoutMs): 느린 1개가 전체 주기를 막지 않는다.
 *  - prune 스로틀: 매 주기 DELETE 스캔 대신 N주기마다 1회(retentionDays 경과분 삭제).
 *  - 배치 insert는 트랜잭션(insertMany)으로 묶어 fsync 폭주/이벤트 루프 블로킹을 막는다.
 */

<<<<<<< HEAD
import { config, loadVcenterConfig } from '../config.js';
import { getPingDb } from './db.js';
import { enabledTargets, seedVcenterTargets } from './store.js';
=======
import { config } from '../config.js';
import { getPingDb } from './db.js';
import { enabledTargets } from './store.js';
>>>>>>> origin/claude/vmware-global-monitoring-portal-nrnpnt
import { pingOne, tcpConnect } from '../util/ping.js';

let timer = null;
let running = false;      // 재진입 가드
let tick = 0;
const PRUNE_EVERY = 20;   // 20주기마다 1회 prune(기본 1분 주기 → ~20분마다)

async function probe(t) {
  const timeoutMs = config.ping.timeoutMs;
  try {
    if (t.kind === 'tcp') {
      const r = await tcpConnect(t.host, t.port || 443, timeoutMs);
      return { target: t.id, ts: Date.now(), rtt: r.alive ? r.rttMs : null, ok: r.alive };
    }
    const r = await pingOne(t.host, { timeoutMs });
    return { target: t.id, ts: Date.now(), rtt: r.alive ? r.rttMs : null, ok: r.alive };
  } catch {
    return { target: t.id, ts: Date.now(), rtt: null, ok: false };
  }
}

/** 1회 폴링: 모든 활성 대상을 동시성 제한 하에 프로브하고 배치 기록. */
export async function pollOnce() {
  if (running) return null;
  running = true;
  try {
    const targets = enabledTargets();
    if (!targets.length) return { measured: 0 };
    const db = await getPingDb();
    const results = [];
    let i = 0;
    const worker = async () => { while (i < targets.length) { const t = targets[i++]; results.push(await probe(t)); } };
    await Promise.all(Array.from({ length: Math.min(config.ping.concurrency, targets.length) }, worker));
    if (results.length) db.insertMany(results);
    // prune 스로틀
    tick += 1;
    if (config.ping.retentionDays > 0 && tick % PRUNE_EVERY === 0) {
      try { db.prune(Date.now() - config.ping.retentionDays * 86_400_000); } catch { /* */ }
    }
    return { measured: results.length, up: results.filter((r) => r.ok).length };
  } finally {
    running = false;
  }
}

export function startPingMonitor() {
  if (!config.ping.enabled) { console.log('[ping] 모니터 비활성(PING_MON_ENABLED=false)'); return; }
<<<<<<< HEAD
  // vCenter를 기본 Ping 대상으로 자동 등록(제어플레인 443). 이미 시드했거나 사용자가 삭제한 건 건너뜀.
  try { const { vcenters } = loadVcenterConfig(); const r = seedVcenterTargets(vcenters); if (r.added) console.log(`[ping] vCenter ${r.added}개 자동 대상 등록`); } catch (e) { console.warn('[ping] vCenter 시드 실패:', e.message); }
=======
>>>>>>> origin/claude/vmware-global-monitoring-portal-nrnpnt
  timer = setInterval(() => { pollOnce().catch((e) => console.warn('[ping] poll 오류:', e.message)); }, config.ping.pollIntervalMs);
  timer.unref?.();
  console.log(`[ping] 모니터 시작 (interval=${config.ping.pollIntervalMs}ms, timeout=${config.ping.timeoutMs}ms, conc=${config.ping.concurrency})`);
}
