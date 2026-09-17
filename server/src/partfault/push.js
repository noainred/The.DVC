/**
 * partfault/push.js — 엣지 → 중앙 push(v2.548, 프로토콜 2).
 *
 * 사용자 지시(2026-09-17): "엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로" → 재설계 선택
 * "장애 + 판정한 전체 요약". v2.547 의 '장애만' 은 실측 18.3KB/push 라 회선 근거가 없었고, 대신
 * `unknownKeys`·`unknownOmitted`·`unknownTruncated` 3단 우회를 낳았다(상한을 넘으면 그 엣지의 장애가
 * 영영 안 닫힌다). 전량 요약을 보내면 그 우회가 통째로 사라진다.
 *
 * 보내는 것(장비 단위):
 *  · `open[]`   — 열린 장애 상세(fault/warn — 라벨·원문 포함)
 *  · `states`   — 그 밖의 파트는 **키 꼬리(`kind:partId`)만** 상태별 배열로(ok/unknown/absent). 파트당 ~20B.
 *  · `ok`·`reason`·`failedKinds` — 장비에 닿았는가 / 왜 못 봤나 / 어느 컬렉션이 실패했나(F1)
 *  · `deviceKey`·`deviceKeyKind` — 장비 축(F2, 서비스태그 우선)
 * 그리고 `version`(이 엣지의 포탈 버전) — 중앙이 '구버전 엣지' 를 구분하는 근거.
 *
 * ⚠⚠ **장애가 0건이어도 보낸다.** 요약이 없으면 중앙은 '정상' 과 '수집 안 됨' 을 구분할 수 없다
 *   (v2.517 `perfPush.sendStatusOnly` 규약. `storage/push.js:30` 에는 아직 그 결함이 남아 있다).
 * ⚠ **전이를 보내지 않고 '지금 판정한 것 전량'** 을 보낸다 — 전이만 보내면 push 1회 유실로 양쪽
 *   상태가 영구히 어긋난다. 전량이면 다음 push 한 번으로 저절로 맞는다.
 * ⚠ **기능 스위치를 본다**(v2.548 F3 — v2.547 은 안 봤다). `partfault/settings.js partFaultEnabled()`
 *   하나가 판정하고, 꺼져 있으면 **왜** 꺼졌는지 상태에 남긴다.
 *
 * 규약(v2.503): ① gzip ② 중앙 `BIG_JSON` 등록 ③ 413 로그 — 셋을 모두 지킨다.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config, currentVersion } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { runScan } from './scan.js';
import { partFaultEnabled } from './settings.js';
import { PUSH_PROTOCOL, partKeyTail, isBad } from './types.js';

const gzipAsync = promisify(zlib.gzip);
const PUSH_GZIP = process.env.PARTFAULT_PUSH_GZIP !== 'false';
/** 한 번에 올릴 장비 상한 — 넘치면 **버리지 않고 밝힌다**(조용한 상한 금지). */
const MAX_DEVICES = Math.max(100, Number(process.env.PARTFAULT_PUSH_MAX_DEVICES) || 5_000);
const intervalMs = () => Math.max(60_000, Number(process.env.PARTFAULT_PUSH_MS) || 10 * 60_000);

let _timer = null;
let _busy = false;
let _last = null;

/** 스캔 결과 → 프로토콜 2 본문(순수). 테스트가 모양을 고정한다. */
export function buildPayload(scan, { agent = config.agent.name, version = currentVersion(), now = Date.now() } = {}) {
  const devs = (scan.devices || []).slice(0, MAX_DEVICES).map((d) => {
    const states = { ok: [], unknown: [], absent: [] };
    const open = [];
    for (const p of d.parts || []) {
      if (isBad(p.state)) open.push({ kind: p.kind, partId: p.partId, keyKind: p.keyKind, state: p.state, rawState: p.rawState, label: p.label, detail: p.detail });
      else if (states[p.state]) states[p.state].push(partKeyTail(p));
    }
    return {
      scope: d.scope, deviceId: d.deviceId, deviceKey: d.deviceKey || d.deviceId, deviceKeyKind: d.deviceKeyKind || 'localId',
      deviceName: d.deviceName, ok: !!d.ok, reason: d.reason || '', failedKinds: d.failedKinds || [],
      capped: !!d.capped, notCollected: d.notCollected || [], states, open,
    };
  });
  return {
    v: PUSH_PROTOCOL, agent, version, at: now,
    devices: devs,
    omitted: Math.max(0, (scan.devices || []).length - devs.length),   // ⚠ 상한으로 뺀 장비 수를 밝힌다
    scanned: scan.scanned,
  };
}

export async function pushPartFaultsNow({ reason = 'timer' } = {}) {
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  }
  const en = partFaultEnabled();
  if (!en.enabled) {
    _last = { at: Date.now(), skipped: true, reason: `꺼짐(${en.source})` };
    return { ok: false, reason: `파트 장애 기능이 꺼져 있습니다(${en.source})` };
  }
  if (_busy) return { ok: false, reason: '이전 push 진행 중' }; // 재진입 가드(CLAUDE.md 필수)
  _busy = true;
  const t0 = Date.now();
  try {
    const scan = await runScan();
    const payload = buildPayload(scan);
    const json = JSON.stringify(payload);
    const hdrs = { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken, 'X-Agent-Name': config.agent.name };
    let body = json;
    if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/part-faults`, {
      method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2,
      onRetry: (i) => console.warn(`[partfault-push] 재시도 ${i.attempt} (${i.error || `HTTP ${i.status}`})`),
    });
    if (res.status === 413) {
      console.warn(`[partfault-push] 중앙이 본문 크기를 거부(413). 장비 ${payload.devices.length}대 · JSON ${Math.round(json.length / 1024)}KB`
        + ' — 중앙의 BIG_JSON 등록 또는 PARTFAULT_PUSH_MAX_DEVICES 를 확인하세요.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.reason || ''; } catch { /* 본문 없음 */ }
      throw Object.assign(new Error(`part-faults <- ${res.status}${detail ? ` (${detail})` : ''}`), { status: res.status });
    }
    const openN = payload.devices.reduce((a, d) => a + d.open.length, 0);
    // 중앙의 응답을 읽는다(v2.548 리뷰 H6) — '중앙이 꺼져 있다'·'소유권 불일치로 버렸다' 를 엣지 화면이 말할 수 있게.
    let ack = null;
    try { ack = await res.json(); } catch { ack = null; }
    _last = {
      at: Date.now(), ms: Date.now() - t0, reason, ok: true, httpStatus: res.status,
      centralEnabled: typeof ack?.centralEnabled === 'boolean' ? ack.centralEnabled : null,
      rejected: Number(ack?.rejected) || 0,
      devices: payload.devices.length, open: openN, omitted: payload.omitted,
      bytes: json.length, gzipBytes: hdrs['Content-Encoding'] === 'gzip' ? body.length : null,
      scanned: scan.scanned,
    };
    // ⚠ 성공도 로그를 남긴다 — 기동·실패 로그를 둘 다 두지 않아 "무로그 = 성공·실패 구분 불가" 가 된
    //   `storageConfigPull` 이 이번 조사의 확정 결함이다. 같은 실수 금지.
    console.log(`[partfault-push] ${reason} — 장비 ${payload.devices.length}대(실패 ${scan.scanned.devicesFailed}) · 열린 장애 ${openN}건 · ${Math.round(json.length / 1024)}KB${_last.gzipBytes ? `→gzip ${Math.round(_last.gzipBytes / 1024)}KB` : ''}${payload.omitted ? ` · 상한으로 ${payload.omitted}대 제외` : ''}`);
    return { ok: true, devices: payload.devices.length, open: openN, omitted: payload.omitted };
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, reason, ok: false, httpStatus: e?.status || null, error: String(e.message || e).slice(0, 200) };
    console.warn(`[partfault-push] 실패: ${_last.error}`);   // 실패도 반드시 로그(무음 실패 금지)
    return { ok: false, reason: _last.error };
  } finally { _busy = false; }
}

export function startPartFaultPush() {
  if (_timer) return;
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    console.log('[partfault-push] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 이 없어 엣지 push 를 켜지 않습니다(중앙 자신이면 정상).');
    return;
  }
  const en = partFaultEnabled();
  // ⚠ 꺼져 있어도 타이머는 건다 — 중앙 설정 pull 로 나중에 켜질 수 있다. 매 틱 스위치를 다시 본다.
  console.log(`[partfault-push] ${en.enabled ? 'started' : '대기(꺼짐)'} — 스위치 ${en.source} · interval=${Math.round(intervalMs() / 1000)}s`);
  _timer = setInterval(() => { pushPartFaultsNow({ reason: 'timer' }).catch(() => {}); }, intervalMs());
  _timer.unref?.();
  setTimeout(() => { pushPartFaultsNow({ reason: 'boot' }).catch(() => {}); }, 60_000).unref?.();
}

export function partFaultPushStatus() {
  const en = partFaultEnabled();
  return {
    configured: !!(config.agent.centralUrl && config.agent.centralToken),
    enabled: en.enabled, source: en.source,
    agent: config.agent.name, version: currentVersion(),
    intervalMs: intervalMs(), maxDevices: MAX_DEVICES, last: _last,
  };
}
