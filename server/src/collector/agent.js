/**
 * Collector-agent export. When this instance runs at a datacenter as a
 * collector, it exposes its locally-collected power so the central portal can
 * pull and merge it. Only LOCAL data (this instance's iDRAC/OME) is exported —
 * never re-exported remote data — so there are no pull loops.
 */

import { exportSensorDetail } from '../idrac/sensorDetailCache.js'; // v2.659
import os from 'node:os';
import crypto from 'node:crypto';
import { config, currentVersion } from '../config.js';
import { getCollectorDenyStats } from './denyLog.js'; // v2.579: 도메인은 routes 를 import 하지 않는다(ARCH-03)
import { localPowerByHostName } from '../idrac/service.js';
import { getPollerStatus } from '../idrac/poller.js';
import { allOmeDevices } from '../idrac/omeCache.js';
import { loadRegistry as loadIdracRegistry, isHpeEntry } from '../idrac/registry.js';
import { getInventory } from '../idrac/invCache.js';
import { getSensorSeries, sensorPollCycle } from '../idrac/sensorStore.js';
import { compactInv } from './compactInv.js'; // v2.728: 축약 인벤토리(순수 — 데모와 공유)

// 최신 온도 센서(콤팩트) — 중앙 '법인별 온도'가 위임 법인(엣지 등록) 서버도 보이게 실어 보낸다.
// 센서 이름→℃ 맵 + 관측 시각만(시계열 전체는 안 보냄, 센서 수 상한 64).
// v2.659: 엣지 export 의 센서 상세 상한 — 서버당 150개(보통 60~120개). 60초 pull 마다 실리므로 줄인다.
export const EXPORT_SENSOR_MAX = 150;
function exportSensorDetailCapped(serverId) {
  const d = exportSensorDetail(serverId);
  if (!d) return null;
  if (d.list.length <= EXPORT_SENSOR_MAX) return d;
  // v2.681(감사 R2A-02): 넘치면 사용률(%)·온도 센서를 먼저 남긴다 — v2.680 이 병합 순서를 Thermal 먼저로 바꾸며 컬렉션 꼬리의
  //   CPU 사용률 센서가 잘려 중앙에서 그 서버의 CPU 값이 사라질 수 있었다. 같은 묶음 안의 순서는 그대로다.
  const rank = (o) => (o?.k === 'percent' ? 0 : o?.k === 'temperature' ? 1 : 2);
  const kept = d.list.map((o, i) => [o, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).slice(0, EXPORT_SENSOR_MAX).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  return { ...d, list: kept, omitted: (d.omitted || 0) + (d.list.length - EXPORT_SENSOR_MAX) };
}

function compactSensors(serverId) {
  const latest = getSensorSeries(serverId).latest;
  const temps = latest?.temps;
  const cpuOk = typeof latest?.cpu === 'number' && Number.isFinite(latest.cpu);
  // v2.680(감사 F-05): 온도가 0개여도 텔레메트리 CPU 를 읽었으면 싣는다 — 로컬 폴러도 그 경우를 temps 빈 값 + cpu 로 적재한다.
  if ((!temps || !Object.keys(temps).length) && !cpuOk) return null;
  // v2.634: 엣지 폴러의 주기 소요·간격을 함께 싣는다 — 중앙이 그 엣지 표본의 신선도 경계를 맞출 수 있게
  //   (roomTemp.effectiveMaxAgeMs). 구버전 중앙은 모르는 필드라 무시한다.
  const cyc = sensorPollCycle();
  return {
    t: latest.t, temps: Object.fromEntries(Object.entries(temps || {}).slice(0, 64)),
    // v2.660: CPU 사용률(텔레메트리 SystemUsage) — 중앙 iDRAC 통합 추이가 위임 서버도 그린다. 없으면 싣지 않는다.
    ...(typeof latest.cpu === 'number' && Number.isFinite(latest.cpu) ? { cpu: latest.cpu } : {}),
    ...(cyc?.durationMs != null ? { cycleMs: Math.round(cyc.durationMs) } : {}),
    ...(cyc?.intervalMs != null ? { intervalMs: cyc.intervalMs } : {}),
  };
}

// 서버 분석용 콤팩트 인벤토리 — v2.728 에 collector/compactInv.js 로 옮겼다(데모가 import 순환 없이 같은 함수를 쓰게).
// ⚠ 재수출은 import 뒤 export 다(`export { x } from` 은 이 모듈 스코프에 이름을 만들지 않는다 — v2.575). 아래 localServersForExport 가 쓴다.
export { compactInv };

// 이 엣지의 iDRAC 레지스트리를 '서버 분석'용으로 직렬화(자격증명 제외). 위임 스캔으로 현지
// 등록된 서버 + 캐시 인벤토리를 중앙이 병합해 위임 법인도 서버 분석에 나타나게 한다.
// 표시 이름을 hostname으로 통일해 도출한다: ① hostNames 중 IP가 아닌 항목(=hostname) 우선,
// ② 없으면 저장된 name이 서비스태그가 아닐 때만 그 name, ③ 그래도 없으면 host(IP)/id.
// (과거 등록분이 name=서비스태그로 저장돼 있어도 재스캔 없이 다음 수집에서 교정된다.)
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
function serverDisplayName(s) {
  const tag = String(s.serviceTag || '').trim();
  const hn = (s.hostNames || []).find((h) => h && !IPV4_RE.test(String(h).trim()) && String(h).trim() !== tag);
  if (hn) return String(hn).trim();
  if (s.name && String(s.name).trim() !== tag) return String(s.name).trim();
  return String(s.host || '').replace(/^https?:\/\//, '') || s.id; // 스킴 제거한 IP
}

/*
 * v2.742(감사 EDGE-01): 센서 상세(서버당 최대 150개)는 **바뀐 서버만** 싣는다. 예전에는 60초 pull 마다 전 서버의 상세를 통째로
 *   다시 실어, 서버 1천 대 엣지에서 매분 엣지 직렬화(약 0.2초)·중앙 해석+정제(약 0.5초)가 동기로 돌았다(합성 측정 — 운영 규모는 추정).
 *   계약(작고 양쪽이 모르는 경우 예전 그대로):
 *    · 엣지는 서버마다 '내보낸 상세' 의 내용 지문(sha1)을 기억하고, 지문이 바뀐 export 의 세대(gen)를 붙인다. export 마다 커서
 *      `sdCursor = <프로세스 표지>:<세대>` 를 싣는다.
 *    · 중앙은 마지막으로 **저장한** export 의 커서를 다음 pull 에 `?sdSince=` 로 보낸다. 그 세대 뒤로 지문이 바뀌지 않은 서버는
 *      상세를 빼고 `sensorDetailSame:true` 만 싣는다 — 중앙은 직전에 받은 그 서버의 상세를 그대로 쓴다(내용·시각이 같으므로
 *      나이 판정도 같다).
 *    · 표지가 다르거나(엣지 재시작) 형식이 틀리거나 세대가 앞서 있으면(위조·다른 엣지) **전량**이다. 쿼리가 없으면(구버전 중앙)
 *      전량이고, 구버전 엣지는 쿼리를 모르므로 언제나 전량을 준다. 요청자별 상태를 엣지가 들고 있지 않으므로 중앙이 둘이어도 맞다.
 *   ⚠ 지문은 내용 전체(시각 포함)로 만든다 — Thermal 시각은 폴마다 바뀌므로, 폴 주기(기본 60초)가 pull 주기보다 짧은 작은 엣지에서는
 *     거의 전 서버가 매번 바뀐 것으로 나간다(줄어드는 것은 폴 주기가 pull 보다 긴 큰 엣지 · 응답 없는 서버 · 컬렉션만 있는 서버다 — 정직 기록).
 *     시각을 빼고 지문을 만들면 중앙이 낡은 시각을 들고 있게 되어 나이 판정이 틀린다 — 되돌리지 말 것.
 */
const SD_BOOT = crypto.randomBytes(6).toString('hex');   // 이 프로세스의 표지(재시작하면 바뀐다 → 중앙 커서가 무효가 되어 전량)
const SD_CURSOR_RE = /^([0-9a-f]{12}):(\d{1,15})$/;
let sdGen = 0;
const sdState = new Map(); // serverId -> { sig, gen } — 마지막으로 내보낸 상세의 지문과 그 지문이 처음 나온 세대
/** 중앙이 보낸 커서 → 이 프로세스의 세대(쓸 수 없으면 null = 전량). 순수에 가깝다(현재 표지·세대만 본다). */
export function parseSdSince(v) {
  if (typeof v !== 'string') return null;
  const m = SD_CURSOR_RE.exec(v.trim());
  if (!m || m[1] !== SD_BOOT) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) && n >= 0 && n <= sdGen ? n : null;
}
function sdSigOf(d) { return d ? crypto.createHash('sha1').update(JSON.stringify(d)).digest('base64') : ''; }
/** 테스트 전용 — 세대·기억을 비운다(표지는 그대로). */
export function _resetSensorDetailDeltaForTest() { sdGen = 0; sdState.clear(); }

function localServersForExport({ sdSince = null } = {}) {
  const out = [];
  const since = parseSdSince(sdSince);
  const cur = sdGen + 1; let changed = false; let omitted = 0;
  const live = new Set();
  for (const s of loadIdracRegistry()) {
    if (s.type === 'ome') continue; // OME는 상세 인벤토리 미지원
    const inv = getInventory(s.id);
    // v2.742(EDGE-01): 상세 지문 — 바뀌었으면 이번 세대를 붙인다. 중앙이 그 세대 이후를 이미 가졌으면 상세를 뺀다.
    const detail = exportSensorDetailCapped(s.id);
    const sid = String(s.id);
    live.add(sid);
    const sig = sdSigOf(detail);
    const st = sdState.get(sid);
    if (!st || st.sig !== sig) { sdState.set(sid, { sig, gen: cur }); changed = true; }
    const same = detail != null && since != null && sdState.get(sid).gen <= since;
    if (same) omitted += 1;
    out.push({
      id: s.id,
      name: serverDisplayName(s),
      host: s.host || '',
      serviceTag: s.serviceTag || inv?.system?.serviceTag || '',
      model: s.model || inv?.system?.model || '',
      vcenterId: s.vcenterId || '',
      datacenterId: s.datacenterId || '',
      type: s.type || 'idrac',
      // v2.621(감사 WEB-04): BMC 벤더를 싣는다 — 예전에는 빠져 있어 중앙 서버 목록이 위임 HPE 서버를 'iDRAC' 으로 보였다.
      //   등록부 규약(vendor 없음 = Dell iDRAC)대로 'hpe' | 'dell' 을 명시한다. 필드 자체가 없으면 중앙은 구버전 엣지로 보고 '미상'.
      vendor: isHpeEntry(s) ? 'hpe' : 'dell',
      // v2.682(R3E-01): OS 호스트네임·별칭 — 중앙 '통합 성능 모니터링' 의 호스트네임·IP 규칙 근거(로컬 서버와 같은 필드).
      //   구버전 중앙은 hostNames 를 모르는 필드라 버린다. 상한: 별칭 16개 · 글자 255자.
      ...(typeof s.hostName === 'string' && s.hostName ? { hostName: s.hostName.slice(0, 255) } : {}),
      ...(Array.isArray(s.hostNames) ? { hostNames: s.hostNames.filter((h) => typeof h === 'string' && h.trim()).slice(0, 16).map((h) => h.trim().slice(0, 255)) } : {}),
      inv: compactInv(inv),
      sensors: compactSensors(s.id), // 최신 온도(중앙 '법인별 온도'용) — 구버전 중앙은 무시(하위호환)
      // v2.659: 센서 상세(임계값·상태·전압 등 — 콤팩트, 서버당 상한). 구버전 중앙은 모르는 필드라 버린다.
      // v2.742(EDGE-01): 중앙이 이미 가진 상세는 빼고 표지만 싣는다(`sensorDetailSame` — 중앙이 직전 값을 쓴다).
      sensorDetail: same ? null : detail,
      ...(same ? { sensorDetailSame: true } : {}),
    });
  }
  if (changed) sdGen = cur;
  for (const k of sdState.keys()) if (!live.has(k)) sdState.delete(k); // 등록부에서 빠진 서버의 지문은 버린다(다시 등록되면 새 세대로 나간다)
  return { servers: out, sdCursor: `${SD_BOOT}:${sdGen}`, sensorDetailOmitted: omitted };
}

/**
 * @param {{ sdSince?: string|null }} [opts] sdSince — 중앙이 마지막으로 저장한 export 의 커서(`?sdSince=`). 없으면 센서 상세 전량.
 */
export async function buildExport({ sdSince = null } = {}) {
  const byNameMap = await localPowerByHostName();
  // 서버 1대당 한 행으로 중복 제거. localPowerByHostName은 한 서버를 여러 별칭(이름·서비스태그·
  // hostNames) 키로 넣으므로, 중복 제거 없이 export하면 중앙이 같은 서버를 별칭 수만큼 중복 집계한다
  // ('전력 보고' 수 과다·동일 호스트 중복의 원인). serverId 기준으로 첫 행만 내보낸다.
  const seen = new Set();
  const byHost = [];
  for (const [host, r] of byNameMap) {
    if (r.serverId != null && seen.has(r.serverId)) continue;
    if (r.serverId != null) seen.add(r.serverId);
    byHost.push({ host, watts: r.watts, ts: r.ts, serverName: r.serverName, serverId: r.serverId, serviceTag: r.serviceTag || '', model: r.model || '' });
  }
  const { servers, sdCursor, sensorDetailOmitted } = localServersForExport({ sdSince });
  return {
    version: currentVersion(),
    datacenter: config.collector.datacenter || '',
    agent: config.agent.name || '',      // v2.424: 응답 엣지 정체(중앙의 URL↔엣지 불일치 판정용)
    hostname: os.hostname(),
    mock: config.dataSource === 'mock',  // v2.428: 가짜 데이터 노드임을 중앙에 명시(구성도 미스매치 #12)
    generatedAt: Date.now(),
    poller: getPollerStatus(),
    omeDevices: allOmeDevices().length,
    hosts: byHost.length,
    // 인증 거부 통계(관측성) — 토큰 불일치 등 무음 실패를 중앙 '수집 서버' 상태에 노출.
    authDeny: getCollectorDenyStats(),
    power: { byHost },
    // 서버 분석용 인벤토리(위임 법인 서버가 중앙 '서버 분석'에 나타나게 함). 전력만 쓰던
    // 구버전 중앙은 이 필드를 무시하므로 하위호환.
    servers,
    // v2.742(EDGE-01): 센서 상세 변경분 커서 · 이번에 뺀(중앙이 이미 가진) 상세 수 — 구버전 중앙은 모르는 필드라 버린다.
    sdCursor,
    sensorDetailOmitted,
  };
}
