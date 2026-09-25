/**
 * storage/collectors/isilon.js — Isilon/PowerScale(OneFS Platform API) 수집기(v2.302).
 *
 * 공통 수집기 계약(types.js): collect(device) → NormalizedSnapshot.
 * OneFS REST 는 HTTPS(8080) + HTTP Basic 인증을 지원한다. 장비는 대개 자체서명 인증서라
 * **이 모듈 전용 로컬 디스패처**로만 검증을 완화한다(전역 TLS 디스패처 금지 — server/CLAUDE.md).
 *
 * 섹션별 best-effort(iDRAC redfish fetchInventory 와 같은 철학): 한 엔드포인트 실패가 전체
 * 수집을 죽이지 않고, sections{} 에 섹션별 결과('ok'|오류)를 정직하게 남긴다 — OneFS 버전에
 * 따라 경로/필드가 다를 수 있어(8.x/9.x) 주 경로 실패 시 대체 경로를 시도한다.
 * ⚠ 실장비 검증 전(2026-08-15): 엔드포인트는 OneFS Platform API 표준 경로 기준 구현이며,
 *   현장 버전별 차이는 sections 오류 문구로 드러난다 — 첫 실행 후 문구를 보고 보정할 것.
 */

import { Agent } from 'undici';
import { withSsrfLookup } from '../../util/ssrfLookup.js';
import { emptySnapshot } from '../types.js';
// v2.513: 전송 계층 실패(`fetch failed`·`aborted`)를 행동 가능한 사유로 — restCommon 과 같은 규약.
import { describeFetchError, isTransportError } from './netError.js';
import { healthWord } from '../healthWord.js'; // v2.586 — 노드 상태 판정 단일 소스

/** 초당 바이트 → 초당 비트(v2.599 C2599-01). null·비유한값은 null(0 으로 채우면 '트래픽 없음' 거짓). */
export function bytesRateToBps(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v * 8 : null;
}
import { numOrNull } from '../../util/numOrNull.js';
import { reqTimeoutMs } from '../../agent/envTimeout.js';

// Isilon 전용 로컬 TLS 디스패처 — 사내 자체서명 장비 한정(다른 fetch 에 주입 금지).
// 보안(M-4): STORAGE_TLS_VERIFY=true 면 인증서 검증을 켠다(기본은 기존대로 해제).
// v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. v2.506 배선(11곳)에서 빠져 있던 dispatcher.
const isilonDispatcher = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: process.env.STORAGE_TLS_VERIFY === 'true' }) });
const PORT = Number(process.env.STORAGE_ISILON_PORT) || 8080;
// v2.605(TIM2605-04): 음수·2^31 초과 env 는 AbortSignal.timeout 의 RangeError·즉시 중단이 된다 → [1초, 10분].
const TIMEOUT_MS = reqTimeoutMs(process.env.STORAGE_HTTP_TIMEOUT_MS, 15_000);

export async function get(device, apiPath, { signal } = {}) { // v2.308: 영역 수집기(areasCollector)가 재사용
  const url = `https://${device.host}:${PORT}${apiPath}`;
  const auth = Buffer.from(`${device.username}:${device.password || ''}`).toString('base64');
  // v2.598 T2598-01: 바깥 시한(영역 수집 withDeadline · 폴러가 넘기는 device._signal)이 요청을 **실제로** 끊게
  // 건별 시한과 합친다(v2.417 규약) — 예전엔 건별 15초만 있어 시한이 지나도 남은 엔드포인트를 계속 호출했다.
  const outer = signal || device?._signal || null;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      dispatcher: isilonDispatcher,
      signal: outer ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), outer]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (!isTransportError(e)) throw e;
    throw new Error(describeFetchError(e, { host: device.host, port: PORT, timeoutMs: TIMEOUT_MS }), { cause: e });
  }
  if (res.status === 401) throw new Error('인증 실패(401) — 계정/비밀번호 확인');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 주 경로 실패 시 대체 경로 순차 시도(버전별 경로 차이 흡수). 전부 실패면 마지막 오류 throw. */
export async function getAny(device, paths) {
  let err;
  for (const p of paths) {
    try { return await get(device, p); } catch (e) { err = e; }
  }
  throw err;
}

/**
 * OneFS 응답 → NormalizedSnapshot 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw 인자: { config, stats, nodes, users, pools, events } (섹션별 원본 또는 null).
 */
export function normalizeIsilon(device, raw) {
  const snap = emptySnapshot(device);
  if (raw.config) {
    snap.name = raw.config.name || device.name;
    snap.version = raw.config.onefs_version?.release || raw.config.onefs_version?.version || '';
    snap.serial = raw.config.guid || '';
    snap.sections.config = 'ok';
  }
  if (raw.stats) {
    // /statistics/current 응답: { stats: [{ key, value }] } — ifs.bytes.* 키가 클러스터 용량.
    // v2.597(감사 C2597-03 — 재현): 값이 null·'' 인 키를 0 으로 넣지 않는다 — 넣으면 '읽었다' 가 되어 SSD 0% · HDD 에 SSD 분 포함.
    const byKey = Object.fromEntries((raw.stats.stats || []).map((s) => [s.key, numOrNull(s.value)]).filter(([, v]) => v != null));
    const total = byKey['ifs.bytes.total'] || 0;
    // v2.595(감사 C2595-05): 전체 용량 키가 없으면 '정상 · 0 TB' 가 아니라 섹션 오류다(받은 키를 밝힌다).
    if (!(total > 0)) {
      snap.sections.capacity = `오류: ifs.bytes.total 없음(받은 키 ${Object.keys(byKey).slice(0, 8).join(', ') || '없음'})`;
    }
    // v2.593(감사 DATA-01): 사용량을 못 읽으면 0 이 아니라 null — 0 은 '비었다' 는 거짓이고 증가량에 거짓 급변을 만든다(v2.561 규약).
    const usedRaw = (raw.stats.stats || []).find((s) => s.key === 'ifs.bytes.used');
    const availRaw = (raw.stats.stats || []).find((s) => s.key === 'ifs.bytes.avail');
    const usedN = numOrNull(usedRaw?.value), availN = numOrNull(availRaw?.value);
    const used = usedN != null ? usedN : (total && availN != null ? total - availN : null);
    snap.capacity = { totalBytes: total, usedBytes: used, pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null };
    // 미디어(디스크 풀) 분리(v2.303, 사용자 요구 — isi status 의 HDD/SSD 컬럼): OneFS 통계 키
    // ifs.ssd.bytes.* 가 SSD 풀 전용 카운터이고, ifs.bytes.* 는 클러스터 전체(HDD+SSD 스토리지)
    // 합이다 — HDD = 전체 − SSD 로 산출한다. ⚠ SSD 가 메타데이터 전용(L3/VHS)인 구성에서는
    // ifs.ssd.bytes.* 가 0 또는 부재일 수 있어 그 경우 media.ssd 는 0 으로, HDD=전체가 된다
    // (실장비 검증 전 가정 — 값이 이상하면 섹션 상태/실측으로 보정할 것, 은폐하지 않음).
    const ssdTotal = byKey['ifs.ssd.bytes.total'] || 0;
    // SSD 사용량: used → (total − avail) → SSD 풀이 없으면 0, 있는데 못 읽으면 null(HDD 사용량도 null — 부분 차감 금지).
    const ssdUsed = byKey['ifs.ssd.bytes.used'] != null ? byKey['ifs.ssd.bytes.used']
      : (ssdTotal && byKey['ifs.ssd.bytes.avail'] != null ? ssdTotal - byKey['ifs.ssd.bytes.avail'] : (ssdTotal > 0 ? null : 0));
    // total 0 인 미디어는 null — '풀 없음'(SSD 메타 전용/무SSD 구성)을 0TB 로 오표시하지 않는다.
    // v2.594(감사 R2594-03): 사용량을 못 읽었으면(used null) HDD 사용량·% 도 null — max(0, null − x) 는 0 이 되어
    // '비었다' 는 거짓이 DB hdd_used 에 적재됐다.
    const mk = (t, u) => (t > 0 ? { totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 } : null);
    snap.media = {
      hdd: mk(Math.max(0, total - ssdTotal), used == null || ssdUsed == null ? null : Math.max(0, used - ssdUsed)),
      ssd: mk(ssdTotal, ssdUsed),
    };
    if (total > 0) snap.sections.capacity = 'ok';
  }
  if (raw.nodes) {
    const list = raw.nodes.nodes || [];
    snap.nodes.count = list.length;
    // OneFS 노드 상태 필드는 버전별 상이(status/health) — 명시적으로 정상 아닌 것만 센다(모르면 0).
    // v2.600(감사 COL-2600-05): status 가 health 키 없는 **객체**면 String() 이 '[object object]' 를 만들고, healthWord 가
    //   모르는 단어를 나쁨으로 봐 **전 노드가 비정상**이 됐다(위 주석 '모르면 0' 과 반대). 문자열(또는 숫자)일 때만 쓴다.
    const word = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    const healthOf = (n) => (word(n.status?.health) || word(n.status) || word(n.health)).toLowerCase() || 'unknown';
    // v2.586 — 판정은 `storage/healthWord.js` 하나(앵커 없는 부분 일치가 'unhealthy'·'broken' 을 정상으로 셌다).
    snap.nodes.unhealthy = list.filter((n) => healthWord(healthOf(n)) === 'bad').length;
    // v2.615(SF-R1-02): **전 노드** 기준 상태 미확인 수 — 목록은 64대로 잘리므로 화면이 목록만 보면 상한 밖 노드의
    //   '못 읽음' 을 정상으로 단정한다(66노드 클러스터 실재). unhealthy 와 같은 판정 함수로 센다.
    snap.nodes.unknown = list.filter((n) => healthWord(healthOf(n)) === 'unknown').length;
    // 노드별 상세(v2.303) — devid(= 노드 id) 기준으로 노드별 통계를 조인. IP 필드는 버전별 상이라
    // 흔한 후보(ip/ip_address/ip_addresses[0]/ext_ip)를 순서대로 취하고 없으면 ''(정직 표기 — 위조 금지).
    const perNode = new Map(); // devid → { key → value }
    for (const r of (raw.nodeStats?.stats || [])) {
      if (r.devid == null) continue;
      if (!perNode.has(r.devid)) perNode.set(r.devid, {});
      // v2.597(감사 C2597-04 — 재현): null 값은 키를 넣지 않는다 — has() 가 '읽었다' 를 뜻하게(0 bps·사용량 0 거짓 방지).
      const v = numOrNull(r.value);
      if (v != null) perNode.get(r.devid)[r.key] = v;
    }
    const mkPool = (t, u) => (t > 0 ? { totalBytes: t, usedBytes: u, pct: u == null ? null : Math.round((u / t) * 1000) / 10 } : null); // total 0 = 무디스크(No Storage HDDs)
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    snap.nodes.list = list.slice(0, 64).map((n) => {
      const lnn = n.lnn ?? n.id;
      // v2.603(감사 COL-2603-02): 통계의 devid 는 노드 **장치 번호(= /cluster/nodes 의 id)** 이고 lnn(논리 번호)과
      //   다를 수 있다(노드 교체 뒤). lnn 으로 찾으면 다른 노드의 값이 오류 없이 붙는다. id 로 조인하고,
      //   id 가 없는 응답에서만 lnn 으로 찾는다(표시 id 는 예전처럼 lnn). ⚠ 실장비 devid≠lnn 응답은 확인하지 못했다.
      const st = (n.id != null ? perNode.get(n.id) : perNode.get(lnn)) || {};
      return {
        id: lnn,
        ip: String(n.ip || n.ip_address || (Array.isArray(n.ip_addresses) ? n.ip_addresses[0] : '') || n.ext_ip || ''),
        health: healthOf(n),
        // v2.599(감사 C2599-01): node.net.ext.bytes.*.rate 는 **초당 바이트(B/s)** 인데 칸 이름·화면(bps())·SSH 경로
        //   (isilonSsh.parseBps — 'Throughput (bps)')는 초당 비트다. 그대로 두면 REST 노드가 8배 과소로 보였다.
        //   ×8 은 sanswitch/rates.js toBps 와 같은 규칙이고, 못 읽은 값(null)은 그대로 null 이다.
        inBps: bytesRateToBps(st['node.net.ext.bytes.in.rate']),
        outBps: bytesRateToBps(st['node.net.ext.bytes.out.rate']),
        hdd: mkPool(Math.max(0, (st['node.ifs.bytes.total'] || 0) - (st['node.ifs.ssd.bytes.total'] || 0)),
                    has(st, 'node.ifs.bytes.used') && (has(st, 'node.ifs.ssd.bytes.used') || !((st['node.ifs.ssd.bytes.total'] || 0) > 0))
                      ? Math.max(0, st['node.ifs.bytes.used'] - (st['node.ifs.ssd.bytes.used'] || 0)) : null),
        ssd: mkPool(st['node.ifs.ssd.bytes.total'] || 0, has(st, 'node.ifs.ssd.bytes.used') ? st['node.ifs.ssd.bytes.used'] : null),
      };
    });
    snap.sections.nodes = 'ok';
  }
  if (raw.users) {
    snap.accounts = (raw.users.users || []).slice(0, 200)
      .map((u) => ({ name: u.name || u.id || '', enabled: u.enabled !== false }));
    snap.sections.accounts = 'ok';
  }
  if (raw.pools) {
    snap.pools = (raw.pools.storagepools || raw.pools.nodepools || []).slice(0, 32).map((p) => {
      const u = p.usage || {};
      const total = Number(u.total_bytes ?? u.usable_bytes) || 0;
      const used = numOrNull(u.used_bytes);
      return { name: p.name || '', totalBytes: total, usedBytes: used, pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null };
    });
    snap.sections.pools = 'ok';
  }
  if (raw.events) {
    // v2.600(감사 COL-2600-09): 조회가 `limit=1` 이라 목록 길이는 **전체 건수가 아니다**(최대 1). 예전에는 total 이 없으면
    //   그 길이를 전체로 썼고, v1 폴백(`/platform/1/event/events`)의 `events` 키는 읽지 않아 0 이 됐다.
    //   total 이 있으면 그것, 없고 목록이 비었으면 0(확정), 목록에 항목이 있으면 **하한**(1건 이상)으로 밝힌다.
    const ev = raw.events;
    const total = numOrNull(ev.total);
    const list = Array.isArray(ev.eventgroups) ? ev.eventgroups : Array.isArray(ev.events) ? ev.events : [];
    if (total != null) snap.alerts.unresolved = total;
    else {
      snap.alerts.unresolved = list.length;
      if (list.length) {
        snap.extra.alertsLowerBound = true;
        snap.extra.alertsNote = `장비가 전체 건수(total)를 주지 않아 미해결 경보는 ${list.length}건 이상입니다(조회 상한 기준 하한값).`;
      }
    }
    snap.sections.alerts = 'ok';
  }
  // 성공 판정: 최소한 config 또는 capacity 를 읽었으면 '수집됨'(부분 실패는 sections 가 설명).
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  return snap;
}

export async function collect(device, { signal = null } = {}) {
  // v2.605(TIM2605-02): 폴러·연결 테스트가 넘기는 opts.signal 도 받는다 — get() 은 device._signal 을 읽으므로
  //   _signal 없이 opts 로만 온 신호를 거기에 싣는다(형제 unity·powerstore 와 같은 계약).
  if (signal && !device?._signal) device = { ...device, _signal: signal };
  // 수집 방식 분기(v2.304): 기본 ssh(isi status 파싱 — isilonSsh.js), 'api' 선택 시 아래 REST 경로.
  if (device.collectMethod !== 'api') {
    const { collectViaSsh } = await import('./isilonSsh.js');
    return collectViaSsh(device);
  }
  const raw = { config: null, stats: null, nodes: null, nodeStats: null, users: null, pools: null, events: null };
  const snap = emptySnapshot(device);
  const trySection = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (key === 'nodeStats') { snap.sections.nodeStats = `오류: ${e.message}`; return; } snap.sections[key === 'stats' ? 'capacity' : key === 'events' ? 'alerts' : key === 'users' ? 'accounts' : key] = `오류: ${e.message}`; }
  };
  // config 를 먼저 — 인증 실패(401)면 나머지를 시도하지 않고 즉시 실패로 끝낸다(계정 잠금 방지:
  // 잘못된 비번으로 엔드포인트 6개 × 폴링마다 두드리면 장비 쪽 실패 잠금을 유발한다).
  try { raw.config = await get(device, '/platform/1/cluster/config'); }
  catch (e) {
    if (/401/.test(e.message) || /인증 실패/.test(e.message)) {
      const out = normalizeIsilon(device, raw);
      out.error = e.message; out.sections.config = `오류: ${e.message}`;
      return out;
    }
    snap.sections.config = `오류: ${e.message}`;
  }
  await trySection('stats', () => get(device, '/platform/1/statistics/current?key=ifs.bytes.total&key=ifs.bytes.used&key=ifs.bytes.avail&key=ifs.ssd.bytes.total&key=ifs.ssd.bytes.used&key=ifs.ssd.bytes.avail&devid=0'));
  await trySection('nodes', () => getAny(device, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes']));
  // 노드별 통계(v2.303, 사용자 요구 — isi status 노드 표): devid=all 이면 stats[] 각 행에
  // devid(=노드 lnn)가 붙어 노드 단위 값이 온다. node.ifs.bytes.* = 노드 로컬 디스크 풀,
  // node.net.ext.bytes.{in,out}.rate = 외부망 처리량(B/s). 실패해도 노드 수/상태(nodes 섹션)는 유지.
  await trySection('nodeStats', () => get(device, '/platform/1/statistics/current?devid=all'
    + '&key=node.ifs.bytes.total&key=node.ifs.bytes.used&key=node.ifs.ssd.bytes.total&key=node.ifs.ssd.bytes.used'
    + '&key=node.net.ext.bytes.in.rate&key=node.net.ext.bytes.out.rate'));
  await trySection('users', () => get(device, '/platform/1/auth/users?limit=200'));
  await trySection('pools', () => getAny(device, ['/platform/1/storagepool/storagepools', '/platform/1/storagepool/nodepools']));
  await trySection('events', () => getAny(device, ['/platform/3/event/eventgroup-occurrences?resolved=false&limit=1', '/platform/1/event/events?resolved=false&limit=1']));
  const out = normalizeIsilon(device, raw);
  // normalize 가 만든 sections 위에, 시도 단계에서 기록한 오류 문구를 보존(덮어쓰기 방지).
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  if (!out.ok && !out.error) out.error = out.sections.config !== 'ok' ? String(out.sections.config) : '수집 실패(섹션 오류 참조)';
  return out;
}
