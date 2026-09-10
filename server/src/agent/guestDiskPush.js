/**
 * agent/guestDiskPush.js — 사이트 위임 게스트 디스크 수집(엣지 → 중앙 push, v2.466).
 *
 * 배경: 중앙(OC2)은 collectMode='site' vCenter 에 직접 접속하지 않는다(고RTT 회피 — store.js).
 * 게스트 디스크 회수 리포트가 쓰는 guest.disk(게스트 파티션 할당/사용)는 기본 폴에 포함되지
 * 않고 라이브 SOAP 로만 얻는데, 중앙은 site vCenter 에 그 SOAP 를 못 건다 → site vCenter 는
 * 게스트 디스크 데이터가 아예 없었다(이번 재개발의 근본 원인).
 *
 * 해결: 로컬 vCenter 를 직접 수집하는 엣지가 guest.disk 를 모아 중앙으로 push 한다
 * (inventoryPush.js 와 동일한 단방향 아웃바운드). 중앙은 /api/central/guest-disk 에서 받아
 * guest-disk.db 에 커밋하고 리포트가 조회한다.
 *
 * CLAUDE.md 성능/보안 규약:
 *  - single-flight 가드(대용량·고RTT push 가 주기보다 길어질 때 겹침 방지).
 *  - 게스트 파티션은 천천히 변하므로 주기는 길게(기본 12h). 인벤토리 push(60초)와 별도 타이머.
 *  - per-vCenter 오류 격리(1개 실패가 전체 push 를 막지 않음) + 목/위임 슬라이스 스킵.
 *  - gzip(중앙 express.json 이 Content-Encoding: gzip 자동 해제).
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import os from 'node:os';
import { config } from '../config.js';
import { store } from '../store.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { isMockVcenter } from '../mock/generator.js';
import { collectVcenterGuestDisk } from '../guestdisk/service.js';

const gzipAsync = promisify(zlib.gzip);
const PUSH_GZIP = process.env.AGENT_PUSH_GZIP !== 'false';

let timer = null;
let last = null;       // { at, sent, skipped, errors, bytes, gzBytes, ms }
let running = false;   // single-flight

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Agent-Hostname': os.hostname(),
    ...extra,
    ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}),
  };
}

async function pushOne(vc) {
  // 엣지가 로컬 vCenter 에 직접 접속해 guest.disk 를 수집한다(중앙은 못 하는 그 일).
  const r = await collectVcenterGuestDisk(vc.id);
  // guest 보고 VM 이 0 이면 push 하지 않는다 — 콜드스타트/Tools 일시 미보고 주기의 빈 수집이
  // 중앙 latest 를 지우지 않게(중앙에도 빈-수집 가드가 있지만 불필요한 고RTT 전송도 줄인다).
  if (!r.withGuest) return { bytes: 0, gzBytes: 0, withGuest: 0, skippedEmpty: true };
  const slice = {
    agent: config.agent.name,
    source: vc?.mock === true ? 'mock' : config.dataSource,
    vcenterId: r.vcenterId,
    vcenterName: r.vcenterName,
    total: r.total,
    withGuest: r.withGuest,
    vms: r.vms, // [{vmId,vmName,allocGB,usedGB,partCount,parts:[{path,capGB,usedGB}]}]
    generatedAt: Date.now(),
  };
  const json = Buffer.from(JSON.stringify(slice));
  let body = json; let hdrs = headers();
  if (PUSH_GZIP) {
    try { const gz = await gzipAsync(json); body = gz; hdrs = headers({ 'Content-Encoding': 'gzip' }); }
    catch { /* 압축 실패 시 원본 전송 */ }
  }
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/guest-disk`, {
    method: 'POST', headers: hdrs, body,
    timeoutMs: Number(process.env.AGENT_GUESTDISK_PUSH_TIMEOUT_MS) || 120_000, retries: 1,
  });
  if (!res.ok) throw new Error(`guest-disk -> ${res.status}`);
  return { bytes: json.length, gzBytes: body.length, withGuest: r.withGuest };
}

export async function pushGuestDiskNow() {
  if (running) return { ok: false, reason: '이전 guest-disk push 진행 중(겹침 방지)' };
  const snap = store.get();
  if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 없음' };
  running = true;
  const started = Date.now();
  let sent = 0; let skipped = 0; let bytes = 0; let gzBytes = 0; const errors = [];
  try {
    for (const vc of snap.vcenters) {
      // 인벤토리 push 와 같은 필터: 비활성·위임받은 것·목 데이터는 보내지 않는다.
      if (!vc.id || vc.status === 'disabled' || vc.collectSource === 'site') { skipped++; continue; }
      if (vc.mock === true || isMockVcenter(vc)) { skipped++; continue; }
      try {
        const r = await pushOne(vc);
        if (r.skippedEmpty) { skipped++; continue; }
        sent++; bytes += r.bytes || 0; gzBytes += r.gzBytes || 0;
      } catch (e) {
        errors.push(`${vc.id}: ${e.message}`);
        console.warn(`[gd-push] ${vc.id} 실패: ${e.message}`);
      }
    }
  } finally { running = false; }
  last = { at: Date.now(), sent, skipped, errors, bytes, gzBytes, ms: Date.now() - started, gzip: PUSH_GZIP };
  return { ok: errors.length === 0, sent, skipped, errors, bytes, gzBytes };
}

export function guestDiskPushStatus() {
  return {
    enabled: !!(config.agent.pushGuestDisk && config.agent.centralUrl),
    centralUrl: config.agent.centralUrl,
    intervalMs: config.agent.guestDiskIntervalMs,
    last,
  };
}

export function startGuestDiskPush() {
  if (!config.agent.pushGuestDisk || !config.agent.centralUrl) return;
  // 첫 수집·인벤토리 push 가 자리잡은 뒤 시작(90초 지연), 이후 긴 주기 반복.
  setTimeout(() => pushGuestDiskNow().catch((e) => console.error('[gd-push] 실패:', e.message)), 90_000).unref?.();
  timer = setInterval(() => pushGuestDiskNow().catch(() => {}), config.agent.guestDiskIntervalMs);
  timer.unref?.();
  console.log(`[gd-push] started → ${config.agent.centralUrl} every ${Math.round(config.agent.guestDiskIntervalMs / 3_600_000)}h`);
}
