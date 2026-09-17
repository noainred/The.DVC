/**
 * partfault/push.js — 엣지 → 중앙 **파트 장애만** push(v2.547).
 *
 * 사용자 지시(2026-09-17): "엣지에서 수집해서 로컬에서 처리하고 **장애만** 중앙으로 보내게 해줘".
 *
 * 그래서 이 경로가 보내는 것은 두 가지뿐이다 —
 *  ① `open[]`  — 지금 **열려 있는 장애 전량**(`fault`/`warn`). 보통 수 건~수십 건이라 작다.
 *  ② `scanned` — **스캔 요약**(몇 대를 봤고, 몇 개를 판정했고, 확인 불가가 몇 개인지).
 *
 * ⚠⚠ **`open` 이 0건이어도 반드시 보낸다.** 장애만 보내고 요약을 빼면 중앙은 '정상' 과
 *   '수집 안 됨' 을 **구분할 수 없다**. 이것이 v2.517 이 SAN 포트 사용량에서 이미 고친 결함이고
 *   (`perfPush.js sendStatusOnly` — "엣지는 표본이 0건이어도 상태를 올린다"),
 *   **`storage/push.js:30` 에는 아직 남아 있는 결함**이다(`if (!devices.length) … return` 이라
 *   장비 0대면 POST 자체를 안 해 중앙이 그 엣지의 존재를 모른다 — 이번 OC2SDBX 조사에서 확인).
 *   여기서 그 실수를 반복하지 않는다.
 *
 * ⚠ **전이를 보내지 않고 '지금 열린 것 전량' 을 보낸다.** 전이만 보내면 push 1회 유실로
 *   중앙·엣지 상태가 **영구히 어긋난다**(중앙이 닫지 못한 장애가 영원히 남는다).
 *   전량 스냅샷이면 다음 push 한 번으로 저절로 맞춰진다.
 *
 * 규약(v2.503): ① gzip ② 중앙 `BIG_JSON` 등록 ③ 413 로그 — 셋을 모두 지킨다.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { runScan } from './scan.js';

const gzipAsync = promisify(zlib.gzip);
const PUSH_GZIP = process.env.PARTFAULT_PUSH_GZIP !== 'false';
/** 한 번에 올릴 열린 장애 상한 — 넘치면 **버리지 않고 밝힌다**(조용한 상한 금지). */
const MAX_OPEN = Math.max(100, Number(process.env.PARTFAULT_PUSH_MAX) || 5_000);
const intervalMs = () => Math.max(60_000, Number(process.env.PARTFAULT_PUSH_MS) || 10 * 60_000);

let _timer = null;
let _busy = false;
let _last = null;

export async function pushPartFaultsNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  }
  if (_busy) return { ok: false, reason: '이전 push 진행 중' }; // 재진입 가드(CLAUDE.md 필수)
  _busy = true;
  try {
    const { open, unknownKeys, scanned, deviceOk } = await runScan();
    const sendOpen = open.slice(0, MAX_OPEN);
    const omitted = open.length - sendOpen.length;
    const payload = {
      agent: config.agent.name,
      at: Date.now(),
      open: sendOpen,
      omitted,                 // ⚠ 상한으로 뺀 개수를 밝힌다
      // ⚠ 상태를 읽지 못한 파트의 **키만** — 중앙이 그것을 '해소' 로 읽지 않게 한다(scan.js 주석 참조).
      unknownKeys,
      scanned,
      deviceOk,                // 중앙이 '이 장비는 이번에 못 봤다' 를 알아야 닫지 않는다
    };
    const json = JSON.stringify(payload);
    const hdrs = { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken };
    let body = json;
    if (PUSH_GZIP) { try { body = await gzipAsync(json); hdrs['Content-Encoding'] = 'gzip'; } catch { body = json; } }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/part-faults`, {
      method: 'POST', headers: hdrs, body, timeoutMs: 30_000, retries: 2,
      onRetry: (i) => console.warn(`[partfault-push] 재시도 ${i.attempt} (${i.error || `HTTP ${i.status}`})`),
    });
    if (res.status === 413) {
      console.warn(`[partfault-push] 중앙이 본문 크기를 거부(413). 열린 장애 ${sendOpen.length}건 · JSON ${Math.round(json.length / 1024)}KB`
        + ' — 중앙의 BIG_JSON 등록 또는 PARTFAULT_PUSH_MAX 를 확인하세요.');
    }
    if (!res.ok) throw new Error(`part-faults <- ${res.status}`);
    _last = { at: Date.now(), open: sendOpen.length, omitted, bytes: json.length, gzip: hdrs['Content-Encoding'] === 'gzip', scanned };
    // ⚠ 성공도 로그를 남긴다 — `storageConfigPull` 이 기동·실패 로그를 **둘 다** 두지 않아
    //   "무로그 = 성공·실패 구분 불가" 가 된 것이 이번 조사의 확정 결함이다. 같은 실수 금지.
    console.log(`[partfault-push] 열린 장애 ${sendOpen.length}건 push (판정 ${scanned?.summary?.total ?? 0}개 · 확인불가 ${scanned?.summary?.unknown ?? 0}개)${omitted ? ` · 상한으로 ${omitted}건 제외` : ''}`);
    return { ok: true, open: sendOpen.length, omitted };
  } catch (e) {
    _last = { at: Date.now(), error: String(e.message || e).slice(0, 200) };
    console.warn(`[partfault-push] 실패: ${_last.error}`);   // 실패도 반드시 로그(무음 실패 금지)
    return { ok: false, reason: _last.error };
  } finally { _busy = false; }
}

export function startPartFaultPush() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) {
    // ⚠ 조용히 return 하지 않는다 — `startStorageConfigPull` 이 그래서 '켜졌는지조차 알 수 없는'
    //   상태가 됐다(이번 조사 확정 결함). 왜 안 켰는지 한 줄 남긴다.
    if (!_timer) console.log('[partfault-push] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 이 없어 엣지 push 를 켜지 않습니다(중앙 자신이면 정상).');
    return;
  }
  console.log(`[partfault-push] started (interval=${Math.round(intervalMs() / 1000)}s)`);
  _timer = setInterval(() => { pushPartFaultsNow().catch(() => {}); }, intervalMs());
  _timer.unref?.();
  setTimeout(() => { pushPartFaultsNow().catch(() => {}); }, 60_000).unref?.();
}

export function partFaultPushStatus() { return { ..._last, intervalMs: intervalMs(), maxOpen: MAX_OPEN }; }
