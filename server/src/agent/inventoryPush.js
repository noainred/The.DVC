/**
 * 사이트 위임 수집 — 현장 서버(에이전트) 측 push 워커.
 *
 * AGENT_PUSH_INVENTORY=true + CENTRAL_URL 설정 시, 이 서버가 자기 로컬 store에서 수집한
 * vCenter 인벤토리를 vCenter별로 잘라 중앙(OC2)의 /api/central/inventory 로 주기적으로
 * 보낸다. 중앙은 그 vCenter를 직접 폴링하지 않으므로 중앙↔원격vCenter RTT가 사라진다.
 *
 * 통신은 사이트 → 중앙 단방향 아웃바운드(push)라 폐쇄망/NAT 사이트에 유리하다.
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { store } from '../store.js';
import { resilientFetch } from '../util/resilientFetch.js';

const gzipAsync = promisify(zlib.gzip);
// 인벤토리 push 본문 gzip 압축(기본 on). 인벤토리 JSON은 반복 필드가 많아 ~5~10× 줄어 WAN
// 수신량을 크게 낮춘다. 중앙(express.json)은 Content-Encoding: gzip 본문을 자동 해제한다.
// AGENT_PUSH_GZIP=false 로 끌 수 있다(구버전 중앙 호환 등).
const PUSH_GZIP = process.env.AGENT_PUSH_GZIP !== 'false';

let timer = null;
let last = null; // { at, sent, errors, bytes, gzBytes }
let running = false; // 한 push 사이클이 (대용량/고RTT로) 주기보다 길어질 때 다음 사이클이 겹쳐
                     // 연결·트래픽이 누적되는 것을 방지(single-flight).

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra, ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

async function pushVcenter(snap, vc) {
  const slice = {
    agent: config.agent.name,
    vcenterId: vc.id,
    vcenter: vc,
    hosts: snap.hosts.filter((h) => h.vcenterId === vc.id),
    vms: snap.vms.filter((v) => v.vcenterId === vc.id),
    datastores: snap.datastores.filter((d) => d.vcenterId === vc.id),
    networks: snap.networks.filter((n) => n.vcenterId === vc.id),
    alarms: snap.alarms.filter((a) => a.vcenterId === vc.id),
    generatedAt: snap.generatedAt,
  };
  const json = Buffer.from(JSON.stringify(slice));
  let body = json; let hdrs = headers();
  if (PUSH_GZIP) {
    try { const gz = await gzipAsync(json); body = gz; hdrs = headers({ 'Content-Encoding': 'gzip' }); }
    catch { /* 압축 실패 시 원본 전송 */ }
  }
  // 대용량 인벤토리 + 고RTT를 고려해 타임아웃을 넉넉히, 일시 오류는 1회 재시도(중복 push는 멱등).
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/inventory`, {
    method: 'POST', headers: hdrs, body,
    timeoutMs: Number(process.env.AGENT_PUSH_TIMEOUT_MS) || 120_000, retries: 1,
  });
  if (!res.ok) throw new Error(`inventory -> ${res.status}`);
  return { bytes: json.length, gzBytes: body.length };
}

export async function pushInventoryNow() {
  if (running) return { ok: false, reason: '이전 push 진행 중(겹침 방지)' };
  const snap = store.get();
  if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 없음' };
  running = true;
  let sent = 0; let bytes = 0; let gzBytes = 0; const errors = [];
  try {
    for (const vc of snap.vcenters) {
      if (!vc.id || vc.status === 'disabled' || vc.collectSource === 'site') continue; // 위임받은 건 재전송 안 함
      try { const r = await pushVcenter(snap, vc); sent++; bytes += r.bytes || 0; gzBytes += r.gzBytes || 0; }
      catch (e) { errors.push(`${vc.id}: ${e.message}`); console.warn(`[inv-push] ${vc.id} 실패: ${e.message}`); }
    }
  } finally { running = false; }
  last = { at: Date.now(), sent, errors, bytes, gzBytes, gzip: PUSH_GZIP };
  return { ok: errors.length === 0, sent, errors, bytes, gzBytes };
}

export function inventoryPushStatus() { return { enabled: !!(config.agent.pushInventory && config.agent.centralUrl), centralUrl: config.agent.centralUrl, intervalMs: config.agent.inventoryIntervalMs, last }; }

export function startInventoryPush() {
  if (!config.agent.pushInventory || !config.agent.centralUrl) return;
  // 첫 수집이 끝난 뒤 보내도록 20초 지연 후 시작, 이후 주기 반복.
  setTimeout(() => pushInventoryNow().catch((e) => console.error('[inv-push] 실패:', e.message)), 20_000).unref?.();
  timer = setInterval(() => pushInventoryNow().catch(() => {}), config.agent.inventoryIntervalMs);
  timer.unref?.();
  console.log(`[inv-push] started → ${config.agent.centralUrl} every ${Math.round(config.agent.inventoryIntervalMs / 1000)}s`);
}
