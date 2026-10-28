/**
 * veeam/licenseWatch.js — Veeam 라이선스 감시(v2.788, 사용자 채택 '라이선스 만료 알림·추이'). **중앙 전용** · 1시간마다.
 *
 *  ① 추이: B&R 서버마다(중앙 직접 수집 + 엣지 push 모두 — veeam/store.js 의 마지막 성공 결과) 라이선스 한 점을 하루 단위로 쌓는다(veeam/historyDb.js).
 *  ② 알림: 라이선스 만료·지원 만료가 D-90 → D-30 → D-7 → 만료 단계로 **넘어갈 때만** 한 번 알린다 · 갱신(단계가 좋아짐)도 한 번 알린다.
 *     판정은 util/licenseExpiry.js licenseExpiryStatus(라이선스 만료일 확인 도구와 같은 함수).
 *
 * bmusage/notify.js 규약을 따른다:
 *  · 상태를 파일에 남긴다(veeam-license-alert-state.json) — 인메모리면 재시작마다 전부 '새 단계' 가 되어 알림이 쏟아진다.
 *  · 순차 발송 · 상한(MAX_SEND)과 잘린 수를 밝힌다 · 데모(mock) 값으로 실제 채널에 보내지 않는다.
 *  · 만료일을 못 읽었으면(null) 판정하지 않는다 — '영구' 나 '정상' 으로 단정하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { notify as sendAlert } from '../alerts.js';
import { isMockMode } from '../mock/demo/flags.js';
import { licenseExpiryStatus } from '../util/licenseExpiry.js';
import { dayIndex, dayLabel } from '../util/dayKey.js';
import { listServers } from './registry.js';
import { getRecord, usableResult } from './store.js';
import { recordLicenseDaily } from './historyDb.js';

const FILE = () => path.join(config.configDir, 'veeam-license-alert-state.json');
const MAX_SEND = 20;
const TICK_MS = 60 * 60_000;
export const STAGES = Object.freeze(['ok', 'd90', 'd30', 'd7', 'expired']);   // 뒤로 갈수록 나쁘다
const KIND_LABEL = { lic: '라이선스', sup: '지원(유지보수)' };

/** 만료 시각 → 단계(못 읽음은 null). */
export function stageOf(ts, now = Date.now()) {
  if (ts == null) return null;
  const { status, daysLeft } = licenseExpiryStatus(ts, { now, soonDays: 90 });
  if (status === 'expired') return 'expired';
  if (status !== 'expiring') return 'ok';
  return daysLeft <= 7 ? 'd7' : daysLeft <= 30 ? 'd30' : 'd90';
}

/**
 * 순수 판정 — 서버별 라이선스 목록 + 이전 상태 → { next, fires }.
 * 처음 보는 키는 '정상' 이면 기록만 하고, 나쁜 단계면 한 번 알린다. 단계가 나빠지면 알리고, 좋아지면(갱신) 한 번 '안내' 로 알린다.
 */
export function evaluateLicenses(items, prev = {}, now = Date.now()) {
  const next = {}; const fires = [];
  for (const it of items) {
    for (const [kind, ts] of [['lic', it.license?.expires], ['sup', it.license?.supportExpires]]) {
      const key = `${it.id}:${kind}`;
      const stage = stageOf(ts ?? null, now);
      const before = prev[key]?.stage || null;
      if (stage == null) { if (prev[key]) next[key] = prev[key]; continue; }   // 못 읽음 — 이전 상태를 그대로 둔다(알리지 않는다)
      next[key] = { stage, at: before === stage ? (prev[key]?.at || now) : now, ts };
      if (before === stage) continue;
      if (before == null && stage === 'ok') continue;   // 처음 보는 정상 — 기록만
      const worse = STAGES.indexOf(stage) > STAGES.indexOf(before || 'ok');
      fires.push({ key, id: it.id, name: it.name, kind, stage, before, ts, daysLeft: licenseExpiryStatus(ts, { now }).daysLeft, improved: !worse });
    }
  }
  return { next, fires };
}

export function alertOf(f) {
  const what = KIND_LABEL[f.kind] || '라이선스';
  const date = dayLabel(dayIndex(f.ts));
  if (f.improved) {
    return { key: `veeamlic:${f.key}:${f.stage}`, severity: 'info', title: `Veeam ${what} 만료일이 늘었습니다 — ${f.name}`, detail: `서버: ${f.name}\n새 만료일: ${date}(D-${f.daysLeft})` };
  }
  const sev = f.stage === 'expired' || f.stage === 'd7' ? 'critical' : f.stage === 'd30' ? 'warning' : 'info';
  const head = f.stage === 'expired' ? `Veeam ${what}가 만료됐습니다` : `Veeam ${what} 만료 D-${f.daysLeft}`;
  return { key: `veeamlic:${f.key}:${f.stage}`, severity: sev, title: `${head} — ${f.name}`, detail: `서버: ${f.name}\n만료일: ${date}\n확인: Backup 현황 › EM 탭의 라이선스 카드` };
}

let _state = null;
function load() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _state = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  } catch { _state = {}; }   // 재생성 가능한 상태 — 손상이면 빈 상태(알림이 한 번 더 나갈 수 있다 — 쏟아지지는 않는다: 단계당 1건)
  return _state;
}
function save(next) {
  _state = next;
  try { atomicWriteFileSync(FILE(), `${JSON.stringify({ keys: next, at: Date.now() })}\n`, { mode: 0o600 }); } catch { /* 최선 */ }
}

/** B&R 서버별 마지막 라이선스(중앙 직접 수집 + 엣지 push). 화면·알림·이력이 같은 목록을 쓴다. */
export function currentLicenses() {
  const out = [];
  for (const sv of listServers()) {
    const r = usableResult(getRecord(sv.id));
    if (r?.license) out.push({ id: sv.id, name: sv.name, vcenterIds: sv.vcenterIds || [], license: r.license, ts: r.ts });
  }
  return out;
}

/** 한 번 — 이력 기록 + 알림. */
export async function runLicenseWatch({ now = Date.now() } = {}) {
  const items = currentLicenses();
  let recorded = 0;
  for (const it of items) { try { if (await recordLicenseDaily(`vbr:${it.id}`, it.license, it.ts || now)) recorded++; } catch { /* 이력은 최선 */ } }
  if (isMockMode()) return { ok: true, recorded, skipped: 'demo' };
  const { next, fires } = evaluateLicenses(items, load(), now);
  save(next);
  const ordered = [...fires].sort((a, b) => STAGES.indexOf(b.stage) - STAGES.indexOf(a.stage));
  const take = ordered.slice(0, MAX_SEND);
  let sent = 0; const errors = [];
  for (const f of take) { try { await sendAlert(alertOf(f)); sent++; } catch (e) { errors.push(String(e?.message || e).slice(0, 120)); } }
  if (ordered.length > take.length) console.warn(`[veeam-license] 알림 ${ordered.length}건 중 ${take.length}건만 보냈습니다(상한 ${MAX_SEND})`);
  return { ok: true, recorded, sent, capped: Math.max(0, ordered.length - take.length), errors: errors.slice(0, 5) };
}

let _timer = null;
export function startLicenseWatch() {
  if (_timer || String(config.agent?.centralUrl || '').trim()) return;   // 중앙 전용(엣지 결과도 중앙에 모인다)
  const tick = () => { runLicenseWatch().catch((e) => console.warn(`[veeam-license] 감시 실패: ${String(e?.message || e).slice(0, 200)}`)); };
  _timer = setTimeout(function loop() { tick(); _timer = setTimeout(loop, TICK_MS); _timer.unref?.(); }, 10 * 60_000);
  _timer.unref?.();
}
export function _resetLicenseWatchForTest() { _state = null; try { fs.unlinkSync(FILE()); } catch { /* */ } }
