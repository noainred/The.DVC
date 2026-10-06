/**
 * vmdns/poller.js — VM DNS 서버 설정 **변경 이력** 적재(v2.696). 10분마다 인벤토리 스냅샷만 읽는다 — vCenter·게스트 왕복 0.
 *
 * 규칙
 *  · 템플릿 제외. `dns === null`(모름)·`dns` 키 없음(미수집)은 **건너뛴다** — '모름' 을 '빈 DNS 로 바뀜' 으로 기록하지 않는다.
 *    다시 보고되면 마지막으로 알던 값과 비교한다(꺼졌다 켜진 VM 이 변경으로 찍히지 않게).
 *  · 첫 병합 전 스냅샷(`snap.initial`)이면 건너뛴다(빈 골격을 '전부 사라짐' 으로 읽지 않게).
 *  · 처음 보는 VM 은 최신값만 넣고 변경 행을 만들지 않는다(첫 기동 수천 행 방지 — db.js 머리말).
 *  · 비교 기준(`sig`)은 OS 가 실제로 쓰는 서버 목록(analyze.js effectiveServers — 화면과 같은 판정)이고 **순서도 본다**
 *    (1차·2차가 바뀐 것도 설정 변경이다).
 *  · 재진입 가드 · `startAdaptiveTimer`(이전 실행 종료 기준) · prune 스로틀 `(++tick % 36) === 0`(10분 주기면 6시간, 첫 틱 제외).
 *  · env: `VMDNS_HISTORY_INTERVAL_MS`(기본 10분, 1분~), `VMDNS_HISTORY_RETENTION_DAYS`(기본 365, 0 = 전부 보관, 빈 값 = 기본).
 */
import { store } from '../store.js';
import { clampIntervalMs } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { effectiveServers } from './analyze.js';
import { loadLatestMap, applyObservations, pruneVmDns, vmDnsDbStatus } from './db.js';

const TOUCH_MS = 6 * 3_600_000;   // 같은 값이면 마지막 관측 시각을 이 간격으로만 갱신한다(보존 정리 기준 — 매 주기 전량 UPDATE 금지)
const PRUNE_EVERY = 36;

/** 수집 주기(ms) — 빈 값·0·비숫자는 기본 10분, 하한 1분. raw 를 주면 그 값으로(테스트). */
export function vmDnsHistoryIntervalMs(raw) {
  const v = raw === undefined ? (numOrNull(process.env.VMDNS_HISTORY_INTERVAL_MS) ?? 600000) : (numOrNull(raw) ?? 600000);
  return clampIntervalMs(v, 600000, 60_000);
}
/** 보존일 — 빈 값 = 기본 365, 0 = 전부 보관, 음수 = 기본(음수를 '무제한' 으로 읽지 않는다 — v2.602). raw 를 주면 그 값으로(테스트). */
export function vmDnsRetentionDays(raw) {
  const n = raw === undefined ? (numOrNull(process.env.VMDNS_HISTORY_RETENTION_DAYS) ?? 365) : (numOrNull(raw) ?? 365);
  return n < 0 ? 365 : Math.floor(n);
}

let running = false;
let latest = null;          // Map vmId → { sig, seen } (DB 를 기동 뒤 한 번 읽는다)
let lastRunAt = 0;
let last = null;            // { at, vms, reported, first, changed, touched, unknown, notCollected, ms, error }
let idleReason = '';
let tick = 0;
let lastPrune = null;

export function vmDnsHistoryStatus() {
  return {
    enabled: true, running, lastRunAt: lastRunAt || null, intervalMs: vmDnsHistoryIntervalMs(),
    retentionDays: vmDnsRetentionDays(), last, idleReason, lastPrune,
  };
}

/**
 * 한 번 비교·적재. 테스트는 `snap`·`now` 를 주입한다.
 * @returns {Promise<object>} { skipped, reason } 또는 { ok, first, changed, touched, unknown, notCollected }
 */
export async function runVmDnsHistoryOnce({ snap = null, now = Date.now() } = {}) {
  if (running) return { skipped: true, reason: 'running' };
  running = true;
  const t0 = Date.now();
  try {
    const s = snap || store.get();
    if (!s || s.initial === true) { idleReason = '첫 인벤토리 수집을 기다리는 중입니다'; return { skipped: true, reason: 'initial' }; }
    if (!latest) {
      latest = await loadLatestMap();
      if (!latest) {
        const st = await vmDnsDbStatus();
        idleReason = `이력 DB 를 열지 못했습니다: ${st.error || '원인 미상'}`;
        last = { at: now, error: idleReason };
        console.warn(`[vm-dns] ${idleReason}`);
        return { ok: false, reason: idleReason };
      }
    }
    idleReason = '';
    const firsts = []; const changes = []; const touches = [];
    let vms = 0; let reported = 0; let unknown = 0; let notCollected = 0;
    for (const vm of Array.isArray(s.vms) ? s.vms : []) {
      if (!vm || typeof vm !== 'object' || vm.template === true || vm.id == null) continue;
      vms += 1;
      if (!Object.hasOwn(vm, 'dns')) { notCollected += 1; continue; }
      const servers = effectiveServers(vm);
      if (!servers) { unknown += 1; continue; }
      reported += 1;
      const vmId = String(vm.id);
      const sig = servers.join(',');
      const prev = latest.get(vmId);
      const base = { vmId, vcId: String(vm.vcenterId ?? ''), name: String(vm.name ?? '') };
      if (!prev) firsts.push({ ...base, servers, sig });
      else if (prev.sig !== sig) changes.push({ ...base, before: prev.sig ? prev.sig.split(',') : [], after: servers, sig });
      else if (now - (prev.seen || 0) >= TOUCH_MS) touches.push(base);
    }
    const r = await applyObservations({ now, firsts, changes, touches });
    if (!r.ok) {
      last = { at: now, vms, reported, unknown, notCollected, first: 0, changed: 0, touched: 0, ms: Date.now() - t0, error: r.reason };
      console.warn(`[vm-dns] 변경 이력 적재 실패: ${r.reason}`);
      latest = null;   // 일부만 커밋됐을 수 있다 — 다음 주기에 DB 에서 다시 읽는다
      return { ok: false, reason: r.reason };
    }
    for (const f of firsts) latest.set(f.vmId, { sig: f.sig, seen: now });
    for (const c of changes) latest.set(c.vmId, { sig: c.sig, seen: now });
    for (const t of touches) { const p = latest.get(t.vmId); if (p) p.seen = now; }
    // v2.710: 데모(mock)에서는 첫 관측 뒤 한 번 과거 변경 이력을 채운다(mock 이 아니면 아무것도 하지 않는다).
    if (firsts.length) {
      const { ensureVmDnsChangeDemo } = await import('../mock/demo/vmdns.js');
      await ensureVmDnsChangeDemo(s, now).catch((e) => console.warn(`[vm-dns] 데모 이력 실패: ${e?.message || e}`));
    }
    lastRunAt = now;
    last = { at: now, vms, reported, unknown, notCollected, first: firsts.length, changed: changes.length, touched: touches.length, ms: Date.now() - t0, error: null };
    if ((++tick % PRUNE_EVERY) === 0) {
      lastPrune = await pruneVmDns(vmDnsRetentionDays()).catch((e) => ({ error: String(e?.message || e).slice(0, 200) }));
    }
    return { ok: true, first: firsts.length, changed: changes.length, touched: touches.length, unknown, notCollected };
  } finally {
    running = false;
  }
}

export function startVmDnsHistory() {
  startAdaptiveTimer(() => vmDnsHistoryIntervalMs(), () => runVmDnsHistoryOnce().catch((e) => console.warn(`[vm-dns] ${e?.message || e}`)),
    { firstDelayMs: 90_000, name: 'vm-dns-history' });
}

export function _resetVmDnsHistoryForTest() {
  running = false; latest = null; lastRunAt = 0; last = null; idleReason = ''; tick = 0; lastPrune = null;
}
