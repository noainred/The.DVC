/**
 * vmhygiene/notifier.js — 스냅샷 정책 위반 하루 한 번 알림(A20, v2.698). 기본 꺼짐(설정 notify.enabled).
 *  · 한국 시각(포탈 오프셋) notify.hour 시 이후 첫 확인에서 그날 한 번 보낸다 — 10분마다 확인(스냅샷만 읽는다, vCenter 왕복 0).
 *  · 보낸 날은 상태 파일(`vm-hygiene-state.json`, 상태 파일 등록 — 백업 '설정 변경' 감시 제외)에 남긴다 — 재시작해도 같은 날 두 번 보내지 않는다.
 *  · 첫 수집 중(snap.initial)이면 보내지 않는다(VM 0대 = '위반 0' 이 아니다).
 *  · 엣지 노드(CENTRAL_URL 있음)는 보내지 않는다 — 알림은 중앙 하나에서(같은 VM 을 두 번 알리지 않게).
 *  · 재진입 가드 · 실패는 상태와 콘솔에 남긴다(무음 실패 금지).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localClock, dayKey } from '../util/dayKey.js';
import { store } from '../store.js';
import { sendText } from '../alerts.js';
import { loadVmHygieneSettings } from './settings.js';
import { analyzeVmHygiene, snapshotPolicySummary } from './analyze.js';

const STATE = registerStateFile('vm-hygiene-state.json');
const FILE = () => path.join(config.configDir, STATE);
const CHECK_MS = 10 * 60_000;
let _timer = null;
let _busy = false;
let _last = null; // { at, ok, sent, reason, error }

function readState() {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); } catch { return {}; }
  try { const p = JSON.parse(raw); return p && typeof p === 'object' ? p : {}; } catch (e) { preserveCorrupt(FILE(), e.message); return {}; }
}

/** 한 번 확인 — 보낼 때면 보낸다. 반환 { sent, reason }. `force` 는 시각·하루 1회 조건을 무시한다(설정 화면 '지금 보내기'). */
export async function vmHygieneNotifyOnce({ now = Date.now(), force = false, send = sendText, snap = store.get() } = {}) {
  if (_busy) return { sent: false, reason: 'busy' };
  _busy = true;
  try {
    const s = loadVmHygieneSettings();
    if (!force && !s.notify?.enabled) return (_last = { at: now, ok: true, sent: false, reason: 'off' });
    if (config.agent?.centralUrl && !force) return (_last = { at: now, ok: true, sent: false, reason: 'edge' });
    const today = dayKey(now);
    const st = readState();
    if (!force) {
      if (localClock(now).hour < (s.notify?.hour ?? 9)) return (_last = { at: now, ok: true, sent: false, reason: 'before-hour' });
      if (st.lastSentDay === today) return (_last = { at: now, ok: true, sent: false, reason: 'already-sent' });
    }
    if (!snap || snap.initial || !Array.isArray(snap.vms)) return (_last = { at: now, ok: true, sent: false, reason: 'first-collect' });
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const r = analyzeVmHygiene(snap.vms, s, { now, vcName });
    const text = snapshotPolicySummary(r);
    if (!text) {
      atomicWriteFileSync(FILE(), JSON.stringify({ ...st, lastSentDay: today, lastCheckedAt: now, lastSentAt: st.lastSentAt || null, lastCount: 0 }));
      return (_last = { at: now, ok: true, sent: false, reason: 'no-violation' });
    }
    const results = await send(text, 'VM 스냅샷 정책 위반', 'daily');
    const list = Array.isArray(results) ? results.slice(0, 8).map((x) => String(x).slice(0, 120)) : [];
    // 켜진 채널이 하나도 없으면 '보냈다' 고 하지 않는다(그날 다시 보내지 않게 기록은 남긴다 — 매 10분 같은 시도 방지).
    atomicWriteFileSync(FILE(), JSON.stringify({ ...st, lastSentDay: today, lastSentAt: list.length ? now : (st.lastSentAt || null), lastCheckedAt: now }));
    if (!list.length) return (_last = { at: now, ok: false, sent: false, reason: 'no-channel' });
    return (_last = { at: now, ok: !list.some((x) => /err/.test(x)), sent: true, reason: 'sent', results: list });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    console.warn(`[vm-hygiene] 스냅샷 정책 알림 실패: ${msg}`);
    return (_last = { at: now, ok: false, sent: false, reason: 'error', error: msg });
  } finally {
    _busy = false;
  }
}

export function startVmHygieneNotifier() {
  if (_timer) return;
  _timer = setInterval(() => { vmHygieneNotifyOnce().catch(() => {}); }, CHECK_MS);
  _timer.unref?.();
}

export function vmHygieneNotifierStatus() {
  const s = loadVmHygieneSettings();
  const st = readState();
  return { enabled: !!s.notify?.enabled, hour: s.notify?.hour ?? 9, intervalMs: CHECK_MS, running: !!_timer, last: _last, lastSentDay: st.lastSentDay || null, lastSentAt: st.lastSentAt || null };
}
