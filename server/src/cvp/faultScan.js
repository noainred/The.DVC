/**
 * cvp/faultScan.js — **중앙 전용**: cvp.db 최신값 → 관측(faults.observeDevice) → 전이(faults.transition) → DB(applyFaultTransition)
 * → 알림(faultNotify) 한 주기(v2.640).
 *
 * 판정은 중앙에서만 돈다 — 중앙 cvp.db 에 전 엣지의 장비 최신값이 합쳐져 있다(agent 열 = 엣지 이름, '' = 중앙 직접). 엣지가 판정하면
 * 같은 부품이 두 번 열린다(partfault v2.548 'F3 — 엣지 poller 가 알림을 두 번' 과 같은 사고). 장비에 접속하지 않는다(DB 만 읽는다) —
 * '지금 점검' 을 연타해도 장비 부하 0 이고, 재진입 가드는 **진행 중인 프라미스를 공유**한다.
 *
 * 트리거: 엣지 push·로컬 수집이 들어올 때 `scheduleCvpFaultScan()`(디바운스 — partfault/hooks.js 와 같은 모양: 한 push 가
 *   장비 수백 대를 실으므로 청크마다 판정하지 않고 한 번으로 모은다). 남는 지연은 수집 주기(settings.intervalMs)뿐이다.
 *
 * 대상: 등록부(`registry.listServers`)에 있는 CVP 의 행만 — 담당이 빈 CVP 는 agent '' 행, 담당이 있으면 그 엣지(agentKeyEq) 행만.
 *   등록부에 없는 cvp_id·다른 엣지가 올린 행은 판정하지 않는다(그 행의 열린 장애는 '관측에 없는 장비' 로 보류된다 — 닫지 않는다).
 */
import { deadlineMs } from '../util/deadline.js';
import { capStr } from '../util/capStr.js';
import { numOrNull } from '../util/numOrNull.js';
import { loadSettings } from './settings.js';
import { listServers } from './registry.js';
import { rowOwnerOf } from './overview.js'; // v2.732: '등록부 담당과 맞는 행' 판정은 한 벌(CVP 라우트·Overview 카드와 같은 함수)
import * as db from './db.js';
import { observeDevice, transition, devIdOf } from './faults.js';
import { notifyFaultTransition } from './faultNotify.js';
import { isMockMode } from '../mock/demo/flags.js'; // v2.708: 데모 CVP(mock-)가 있으면 수집이 켜진 것처럼(설정 파일은 그대로) — mock/demo/cvp.js 를 import 하면 순환이 된다

/** 디바운스 — [1초, 2시간] 관문(v2.611 TIM2611-03: 상한 없는 env 는 2^31 초과에서 setTimeout 이 1ms 가 된다). */
export const faultScanDebounceMs = (v) => deadlineMs(v, 15_000);
const DEBOUNCE_MS = faultScanDebounceMs(process.env.CVP_FAULT_SCAN_DEBOUNCE_MS);

let _running = null;   // 진행 중인 스캔 프라미스(재진입 가드 — 공유)
let _last = null;
let _timer = null;
let _pending = 0;


async function runInner({ now, reason, notify, send }) {
  const t0 = Date.now();
  const settings = loadSettings();
  const servers = listServers();
  const byId = new Map(servers.map((s) => [String(s.id), s]));
  const ownsRow = rowOwnerOf(servers);
  const nameOf = (cvpId) => String(byId.get(String(cvpId))?.name || '');
  // v2.708: 데모(mock) 모드에서는 주기 판정이 알림을 보내지 않는다 — 합성 장애가 설정된 실제 채널로 나가지 않게(명시적 notify 는 그대로).
  const doNotify = typeof notify === 'boolean' ? notify : (settings.faultAlerts === true && !isMockMode());

  const devRes = await db.listDeviceRows();
  if (devRes.unavailable) {
    _last = { at: Date.now(), reason, devices: 0, opened: 0, updated: 0, closed: 0, held: 0, notified: null, durationMs: Date.now() - t0, unavailable: true };
    return { ok: false, ..._last };
  }
  const portRes = await db.portStateRows();
  const portsBy = new Map();
  for (const p of portRes.rows) {
    const id = devIdOf({ agent: p.agent, cvpId: p.cvpId, deviceKey: p.key });
    if (!portsBy.has(id)) portsBy.set(id, []);
    portsBy.get(id).push({ name: p.port, oper: p.oper, admin: p.admin, desc: p.desc });
  }
  const observedByDevice = new Map();
  let skippedUnregistered = 0;
  for (const row of devRes.rows) {
    if (!ownsRow(row)) { skippedUnregistered++; continue; }
    const devId = devIdOf({ agent: row.agent, cvpId: row.cvpId, deviceKey: row.key });
    const ob = observeDevice({ ...row, ports: row.portsRead ? (portsBy.get(devId) || []) : null }, { intervalMs: settings.intervalMs, now });
    observedByDevice.set(devId, { ...ob, agent: row.agent, cvpId: row.cvpId, deviceKey: row.key, deviceName: row.hostname || row.key, cvpName: nameOf(row.cvpId) });
  }
  const openRes = await db.listOpenFaults();
  const tr = transition({ open: openRes.rows, observedByDevice, now });
  // 알림 문구에 CVP 이름을 싣는다(전이 항목에는 없다 — 여기서 붙인다).
  for (const list of [tr.opened, tr.updated, tr.closed]) for (const f of list) if (!f.cvpName) f.cvpName = nameOf(f.cvpId);
  const applied = await db.applyFaultTransition(tr, { now });

  let notified = null;
  if (doNotify && (tr.opened.length || tr.closed.length || tr.stats.changed)) {
    // 해소 알림은 settings.faultAlertsClosed(기본 켬 — 리드가 settings.js 에 둔 필드)가 명시적으로 false 일 때만 끈다.
    notified = await notifyFaultTransition(tr, { notifyClosed: settings.faultAlertsClosed !== false, ...(send ? { send } : {}) });
    const sentKeys = new Set(notified.results.filter((r) => !r.closed && !/^err /.test(r.results)).map((r) => r.key));
    const mark = [...tr.opened, ...tr.updated.filter((u) => !u.sameState)]
      .filter((f) => sentKeys.has(`cvpfault:${f.agent}|${f.cvpId}|${f.deviceKey}|${f.faultKey}`));
    if (mark.length) await db.markFaultNotified(mark, { now });
  }

  _last = {
    at: Date.now(), reason, devices: observedByDevice.size, skippedUnregistered,
    opened: applied.opened, updated: applied.updated, closed: applied.closed, held: applied.held,
    stats: tr.stats, notified: notified ? { sent: notified.sent, capped: notified.capped, skipped: notified.skipped, total: notified.total } : null,
    durationMs: Date.now() - t0, ...(openRes.truncated ? { openTruncated: openRes.limit } : {}),
  };
  if (tr.opened.length || tr.closed.length || tr.stats.changed) {
    console.log(`[cvp-fault] 판정(${reason}) ${_last.durationMs}ms · 장비 ${_last.devices} — 신규 ${tr.stats.opened} · 해소 ${tr.stats.closed} · 변화 ${tr.stats.changed}`
      + ` · 보류 ${tr.stats.held}(unknown ${tr.stats.heldUnknown}/장비 ${tr.stats.heldDeviceFailed + tr.stats.heldDeviceStale + tr.stats.heldNotStreaming}/종류 ${tr.stats.heldCollectionFailed}/누락 ${tr.stats.heldMissing})`
      + (notified ? ` · 알림 ${notified.sent}건${notified.capped ? `(상한 ${notified.capped}건 제외)` : ''}` : ''));
  }
  return { ok: true, ..._last };
}

/**
 * 한 주기. 수동 실행('지금 점검')·디바운스 훅이 같은 함수를 부른다 — 진행 중이면 그 프라미스를 공유한다.
 * @param {{now?:number, reason?:string, notify?:boolean, send?:Function}} [o]  notify 를 주면 settings.faultAlerts 를 덮는다(테스트·수동).
 */
export async function runCvpFaultScan({ now = Date.now(), reason = 'manual', notify, send } = {}) {
  if (_running) return _running;
  _running = runInner({ now, reason, notify, send })
    .catch((e) => {
      _last = { at: Date.now(), reason, error: capStr(String(e?.message || e), 300) };
      console.warn(`[cvp-fault] 판정 실패(${reason}): ${_last.error}`);
      return { ok: false, ..._last };
    })
    .finally(() => { _running = null; });
  return _running;
}

/** 수집 적재 뒤 부른다 — 여러 번 불려도 디바운스 창 안에서는 한 번만 돈다. */
export function scheduleCvpFaultScan(source = 'ingest') {
  _pending += 1;
  if (_timer || _trailing) return;
  armCvpFaultTimer(source);
}
/*
 * v2.682(감사 R3E-04): 타이머가 울렸을 때 판정이 이미 진행 중이면(수동 실행·알림 순차 발송으로 길어진 직전 판정) 그 프라미스를
 *   공유하고 _pending 을 비우던 것은 틀렸다 — 진행 중 판정은 이번 적재 **이전** DB 를 읽었을 수 있어 이번 적재의 전이가
 *   다음 적재(수집 주기)까지, 엣지가 모두 멈추면 영영 판정되지 않았다. 이제 _pending 을 남겨 두고 진행 중 판정이 끝나면 다시 예약한다(trailing).
 */
let _trailing = false;
function armCvpFaultTimer(source) {
  _timer = setTimeout(() => {
    _timer = null;
    if (_running) {
      _trailing = true;
      _running.finally(() => { _trailing = false; if (_pending > 0 && !_timer) armCvpFaultTimer(source); });
      return;
    }
    const n = _pending; _pending = 0;
    runCvpFaultScan({ reason: `${source}:${n}` }).catch(() => { /* runCvpFaultScan 이 _last.error 와 콘솔에 남긴다 */ });
  }, DEBOUNCE_MS);
  _timer.unref?.();
}

/**
 * 상태(서비스 점검 pollerCheck 가 읽는다): enabled = 수집이 켜져 있고 등록 CVP 가 1대 이상 · intervalMs = 수집 주기(판정은 수집이
 * 들어올 때마다 디바운스로 돌지만 '주기' 로는 수집 주기를 적는다) · at/last = 마지막 판정.
 */
export function cvpFaultScanStatus() {
  const s = loadSettings();
  let servers = 0; let demo = false;
  try { const list = listServers(); servers = list.length; demo = isMockMode() && list.some((x) => String(x?.id || '').startsWith('mock-')); } catch { servers = 0; }
  return {
    ...(_last || {}),
    enabled: (s.enabled === true || demo) && servers > 0, faultAlerts: s.faultAlerts === true, servers,
    intervalMs: numOrNull(s.intervalMs), debounceMs: DEBOUNCE_MS, pending: _pending, busy: !!_running,
    at: _last?.at ?? null, last: _last,
  };
}

export function _resetForTest() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _pending = 0; _last = null; _running = null; _trailing = false;
}
/** 테스트 전용 — 진행 중 판정을 흉내 낸다(R3E-04 trailing 재예약 고정). */
export function _setRunningForTest(p) { _running = p ? Promise.resolve(p).finally(() => { _running = null; }) : null; return _running; }
