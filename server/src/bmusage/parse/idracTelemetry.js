/**
 * bmusage/parse/idracTelemetry.js — iDRAC Redfish MetricReport → 우리 모양(순수, v2.551).
 *
 * 사용자 요청(2026-09-18): "방금 만든 기능 개선해줘" → 선택 ①「iDRAC 텔레메트리 리포트 전수 활용」.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────────
 * v2.550 은 `SystemUsage` 리포트 **하나만** 읽어 CPU·메모리·I/O(집계)뿐이었고, 디스크·네트워크·
 * HBA 는 **OS 계정이 있는 서버만** 값이 나왔다. 이 현장은 OS 계정 등록이 소수라 화면 대부분이
 * `—` 로 남는다. iDRAC9 텔레메트리에는 NIC·FC 통계 리포트가 **따로 있으므로** 그것을 읽는다.
 *
 * ⚠⚠ **정직 기록 — 이 현장 iDRAC 의 실제 리포트 목록·메트릭 id 를 본 적이 없다.**
 *   아래 패턴은 Redfish 표준(`MetricValues[]`)과 Dell 문서·이 저장소의 기존 코드
 *   (`redfish.js probeGpuTelemetry` 가 MetricReports 를 열거하는 방식)를 근거로 한 **추정**이다.
 *   그래서 설계가 이렇다:
 *    ① **id 를 굳히지 않는다** — 리포트는 **이름 패턴**으로 찾고 메트릭은 **후보 집합**으로 읽는다
 *       (v2.545 규약: '후보 체인의 성공 조건은 오류가 없음이 아니라 원하는 것을 읽었음이다').
 *    ② **장비가 가진 리포트 목록을 그대로 보고한다**(`seenReports`) — 화면이 '이 장비는 무엇을
 *       지원하나' 를 말할 수 있게(사용자 선택: "장비별로 무엇을 읽었는지 밝힌다").
 *    ③ **못 읽으면 `null`** 이고 0 을 지어내지 않는다.
 *
 * ⚠ **디스크 busy% 는 기대하지 않는다.** iDRAC 텔레메트리의 스토리지 리포트는 SMART·상태·용량
 *   계열이고 iostat 의 `%util` 에 해당하는 값이 **없을 가능성이 높다**. 그래서 이 파서는 디스크에서
 *   읽히는 것이 있으면 싣고, 없으면 `absent` 에 넣어 화면이 '이 경로로는 알 수 없다' 고 말한다 —
 *   '확인 불가' 와 '원래 없음' 을 섞지 않는다(v2.550 규약).
 */

/** ⚠ `v == null` 과 **빈 문자열을 먼저** 본다 — `Number('') === 0` 이라 결측이 0 으로 둔갑한다. */
const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const t = (v) => String(v ?? '').trim();

/**
 * 텔레메트리 퍼센트 값 → 0~100 숫자 또는 `null`(단일 소스 — `idrac/redfish.js` 가 재수출한다).
 * v2.595(감사 C2595-02): 숫자만 뽑는 `replace(/[^\d.]/g,'')` 는 null·'N/A' → 0, '-1' → 1 이 됐다.
 * v2.598(감사 IDRAC-2598-02): 전수 모드의 보드 퍼센트(cpu·mem·io·sys)는 이 판정을 거치지 않고 `num()` 만 써서
 *   '-1'·'150' 이 그대로 사용률로 적재됐다(형제 누락). 범위 밖·파싱 불가면 null 이다.
 * ⚠ 이 함수가 여기 사는 이유: redfish.js 가 이 파서를 정적 import 하므로(v2.613 DEPS2613-02) 반대 방향 import 는 2-cycle 이 된다
 *   (arch2579 가 동적 import 도 edge 로 센다). 순수 파서 쪽에 두고 redfish.js 가 가져다 쓴다.
 */
export function pctFromMetric(v) {
  if (v == null) return null;
  let x;
  if (typeof v === 'number') x = v;
  // v2.607 SEC2607-03·LEFT2607-10: 예전 /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/ 는 뒤쪽 \s*%?\s* 가 모호해 '1'+공백 n+'x' 에서
  //   O(n²)(16,000자 0.34초 — 메트릭 값마다). 앞뒤 공백은 trim 이 같은 집합(WhiteSpace+LineTerminator)을 떼므로 결과가 같다.
  else { const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(String(v).trim()); if (!m) return null; x = Number(m[1]); }
  return Number.isFinite(x) && x >= 0 && x <= 100 ? x : null;
}

/**
 * 리포트 **이름 패턴**. 정확한 id 를 모르므로 소문자화한 id 에 대해 부분 일치로 찾는다.
 * ⚠ 한 리포트가 두 종류에 걸릴 수 있으므로 판정은 **첫 일치**가 아니라 전부 본다(집합).
 */
export const REPORT_KINDS = Object.freeze({
  system: /^systemusage$|systemboardusage/i,
  nic: /nicstat|nicsensor|networkstat|nicmetric/i,
  fc: /fcport|fcsensor|fcstat|fibrechannel/i,
  storage: /storagedisk|storagesensor|nvmesmart|smartdata/i,
  cpumem: /cpumemmetric|aggregationmetric|cpusensor|memorysensor/i,
});

/** 그 리포트 id 가 어떤 종류인가(여러 개일 수 있다). */
export function reportKinds(id) {
  const s = t(id);
  if (!s) return [];
  return Object.entries(REPORT_KINDS).filter(([, re]) => re.test(s)).map(([k]) => k);
}

/** 우리가 읽을 가치가 있는 리포트인가. */
export function isWantedReport(id) { return reportKinds(id).length > 0; }

/** 종류별 우선순위 — 보드(SystemUsage)가 먼저다. CPU·메모리를 잃으면 전수 모드가 퇴행이 된다. */
export const REPORT_PRIORITY = Object.freeze(['system', 'nic', 'fc', 'cpumem', 'storage']);

/**
 * 읽을 리포트를 **종류별 우선순위로** 고른다(순수, v2.598 감사 IDRAC-2598-01).
 *
 * 예전에는 `ids.filter(isWantedReport).slice(0, max)` 라 **장비 목록 순서**로 앞 6개를 읽었다. 목록 앞쪽에
 * 스토리지·집계 리포트가 몰린 장비는 `SystemUsage`·NIC 리포트가 잘려 CPU·메모리·네트워크가 비는데, 스토리지
 * 값 하나만 읽혀도 결과가 `ok` 라 단독 경로 폴백도 Enterprise 대체 경로도 걸리지 않았다.
 * 이제 종류마다 1개씩(우선순위 순) 먼저 넣고, 남는 자리를 목록 순서로 채운다. 상한으로 뺀 개수를 돌려준다.
 *
 * @param {string[]} urls   리포트 URL(또는 id) 목록 — 장비가 준 순서
 * @param {number} max      장비당 상한
 * @param {(u:string)=>string} [idOf]  URL → 리포트 id
 * @returns {{ wanted:string[], skipped:number, matched:number }}
 */
export function pickReports(urls = [], max = 6, idOf = (u) => String(u || '').split('/').filter(Boolean).pop() || '') {
  const cand = (urls || []).filter((u) => isWantedReport(idOf(u)));
  const lim = Math.max(1, Math.floor(Number(max) || 1));
  const picked = [];
  const has = new Set();
  for (const k of REPORT_PRIORITY) {
    const u = cand.find((x) => !has.has(x) && reportKinds(idOf(x)).includes(k));
    if (u != null && picked.length < lim) { picked.push(u); has.add(u); }
  }
  for (const u of cand) {
    if (picked.length >= lim) break;
    if (!has.has(u)) { picked.push(u); has.add(u); }
  }
  return { wanted: picked, skipped: cand.length - picked.length, matched: cand.length };
}

/**
 * 한 MetricValue 에서 **장치 식별자**를 뽑는다.
 * Dell 은 `Oem.Dell.FQDD`(예: `NIC.Integrated.1-1-1`)에 넣고, 표준은 `MetricProperty` URL 에 담긴다.
 * ⚠ 하나로 굳히지 말 것 — 어느 것이 오는지 확인하지 못했다.
 */
export function deviceIdOf(mv = {}) {
  const dell = mv.Oem?.Dell || mv.Oem?.dell || {};
  const direct = t(dell.FQDD) || t(dell.ContextID) || t(dell.ContextId) || t(mv.MetricProperty && '');
  if (direct) return direct;
  const prop = t(mv.MetricProperty);
  if (prop) {
    // `…/NetworkDeviceFunctions/NIC.Integrated.1-1-1/Metrics#RxBytes` → `NIC.Integrated.1-1-1`
    const noFrag = prop.split('#')[0].replace(/\/(Metrics|MetricValues)$/i, '');
    const last = noFrag.split('/').filter(Boolean).pop();
    if (last && !/^\d+$/.test(last)) return last;
  }
  // 마지막 수단 — `Oem.Dell.Label` 이 '<장치> <메트릭>' 꼴이면 앞부분.
  const label = t(dell.Label);
  if (label.includes(' ')) return label.split(/\s+/)[0];
  return '';
}

/** 메트릭 id 후보 — 소문자 비교. ⚠ 굳히지 않는다(v2.545 규약). */
const M = {
  rxBytes: [/^rxbytes$/, /^rxtotalbytes$/, /^rxbytescount$/, /rxbytes/],
  txBytes: [/^txbytes$/, /^txtotalbytes$/, /^txbytescount$/, /txbytes/],
  rxKb: [/^rxkbcount$/, /rxkb/],
  txKb: [/^txkbcount$/, /txkb/],
  linkMbps: [/^linkspeedmbps$/, /^currentlinkspeedmbps$/, /linkspeed/, /^portspeed/],
  cpuPct: [/^systemboardcpuusage$/, /^cpuusage$/, /^systemboardcpuusagepercent$/],
  memPct: [/^systemboardmemusage$/, /^memoryusage$/, /^systemboardmemoryusage$/],
  ioPct: [/^systemboardiousage$/, /^iousage$/, /^systemboardiousagepercent$/],
  sysPct: [/^systemboardsysusage$/, /^sysusage$/, /^systemusage$/],
};
function matchField(metricId) {
  const s = t(metricId).toLowerCase();
  if (!s) return '';
  for (const [field, pats] of Object.entries(M)) {
    for (const re of pats) if (re.test(s)) return field;
  }
  return '';
}

/**
 * 리포트 하나를 읽어 **장치별 원시값**으로 정리한다.
 * @param {object} rep  MetricReport JSON
 * @returns {{kind:string[], id:string, devices:Map<string,object>, board:object, seenIds:string[], at:number|null}}
 */
export function parseReport(rep = {}) {
  const id = t(rep.Id) || t(rep['@odata.id']).split('/').filter(Boolean).pop() || '';
  const kind = reportKinds(id);
  const devices = new Map();
  const board = {};
  const seenIds = [];
  let at = null;
  let boardRejected = 0;
  for (const mv of (rep.MetricValues || [])) {
    const mid = t(mv.MetricId);
    if (mid) seenIds.push(mid);
    const ts = Date.parse(t(mv.Timestamp));
    if (Number.isFinite(ts) && (at == null || ts > at)) at = ts;
    const field = matchField(mid);
    if (!field) continue;
    // 보드 단위 지표(CPU·MEM·IO·SYS)는 장치 축이 없다.
    // v2.598(감사 IDRAC-2598-02): 퍼센트는 **범위 검사**를 거친다 — '-1'·'150' 을 사용률로 쓰지 않는다.
    if (field.endsWith('Pct')) {
      const pv = pctFromMetric(mv.MetricValue);
      if (pv == null) { if (t(mv.MetricValue)) boardRejected += 1; continue; }
      if (board[field] == null) board[field] = pv;
      continue;
    }
    const v = num(mv.MetricValue);
    if (v == null) continue;
    const dev = deviceIdOf(mv) || '(미상)';
    const cur = devices.get(dev) || { device: dev };
    // ⚠ 같은 장치·같은 필드가 여러 번 오면 **가장 큰 값**을 쓴다(누적 카운터는 단조 증가라
    //   더 늦은 표본이 더 크다 — Timestamp 파싱에 의존하지 않는 안전한 선택).
    cur[field] = cur[field] == null ? v : Math.max(cur[field], v);
    // v2.598(감사 IDRAC-2598-03): 장치별 **리포트 표본 시각**을 싣는다 — 환산(usage.js)이 '리포트가 갱신됐는가' 를
    //   이것으로 본다. 폴러 시계로만 나누면 갱신되지 않은 리포트를 두 번 읽은 주기가 0 B/s('트래픽 없음')가 된다.
    if (Number.isFinite(ts) && (cur.at == null || ts > cur.at)) cur.at = ts;
    devices.set(dev, cur);
  }
  // 메트릭별 Timestamp 가 없으면 리포트 자체의 Timestamp 를 쓴다(Redfish MetricReport 의 최상위 필드).
  const repTs = Date.parse(t(rep.Timestamp));
  if (at == null && Number.isFinite(repTs)) at = repTs;
  for (const d of devices.values()) if (d.at == null && at != null) d.at = at;
  return { kind, id, devices, board, seenIds: [...new Set(seenIds)], at, boardRejected };
}

/**
 * 여러 리포트를 합쳐 **이번 주기의 iDRAC 관측**을 만든다.
 * 누적 카운터는 그대로 싣는다(환산은 `rates.js` 가 이전 표본과 함께 한다 — 코어는 하나다).
 *
 * @param {Array<object>} reports  읽은 MetricReport JSON 배열
 * @param {Array<string>} seenReports  장비가 **가진** 전체 리포트 id(읽지 않은 것도 포함)
 */
export function buildIdracUsage(reports = [], seenReports = []) {
  const out = {
    ok: true,
    cpuPct: null, memPct: null, ioPct: null, sysPct: null,
    nics: [], fcs: [], disks: [],
    usedIds: {}, usedReports: [], seenReports: [...new Set(seenReports.map(t).filter(Boolean))],
    read: [], absent: [], at: null,
    // v2.598(감사 IDRAC-2598-02): 범위 밖(-1·150 등)이라 버린 보드 퍼센트 개수 — 조용히 버리지 않는다.
    boardRejected: 0,
  };
  const nicMap = new Map();
  const fcMap = new Map();
  const diskMap = new Map();
  const seenIds = [];

  for (const rep of reports) {
    const p = parseReport(rep);
    if (!p.id) continue;
    out.usedReports.push(p.id);
    seenIds.push(...p.seenIds);
    out.boardRejected += p.boardRejected || 0;
    if (p.at != null && (out.at == null || p.at > out.at)) out.at = p.at;
    for (const [field, v] of Object.entries(p.board)) {
      if (out[field] == null) { out[field] = v; out.usedIds[field] = p.id; }
    }
    const target = p.kind.includes('nic') ? nicMap : p.kind.includes('fc') ? fcMap : p.kind.includes('storage') ? diskMap : null;
    if (!target) continue;
    for (const [dev, vals] of p.devices) {
      const cur = target.get(dev) || { device: dev };
      for (const [k, v] of Object.entries(vals)) if (k !== 'device' && v != null) cur[k] = v;
      target.set(dev, cur);
    }
  }

  // NIC — 누적 바이트 + 링크 속도(있으면).
  for (const x of nicMap.values()) {
    out.nics.push({
      iface: x.device,
      rxBytes: x.rxBytes ?? null,
      txBytes: x.txBytes ?? null,
      at: x.at ?? null,
      // Mbps → bit/s. ⚠ 0 은 '모른다' 다(카운터 기본값) — v2.550 winPerf 와 같은 규약.
      bitsPerSec: x.linkMbps != null && x.linkMbps > 0 ? x.linkMbps * 1e6 : null,
    });
  }
  // FC(HBA) — Dell 은 KB 단위 카운터를 준다(문서 기반 추정) → 바이트로 맞춘다.
  for (const x of fcMap.values()) {
    const rx = x.rxBytes ?? (x.rxKb != null ? x.rxKb * 1024 : null);
    const tx = x.txBytes ?? (x.txKb != null ? x.txKb * 1024 : null);
    out.fcs.push({
      host: x.device, rxBytes: rx, txBytes: tx, at: x.at ?? null,
      bitsPerSec: x.linkMbps != null && x.linkMbps > 0 ? x.linkMbps * 1e6 : null,
    });
  }
  // 디스크 — 읽힌 것이 있으면 싣는다(busy% 는 보통 없다 — 아래 absent 참조).
  for (const x of diskMap.values()) out.disks.push({ name: x.device, ...x, device: undefined });

  out.usedIds.__seenMetricIds = [...new Set(seenIds)].slice(0, 200);
  if (out.cpuPct != null || out.memPct != null) out.read.push('cpumem');
  if (out.nics.length) out.read.push('net');
  if (out.fcs.length) out.read.push('hba');
  if (out.disks.length) out.read.push('disk');
  /*
   * ⚠ **'이 경로로는 원래 없는 것' 과 '못 읽은 것' 을 구분한다**(v2.550 규약):
   *   장비가 그 종류의 리포트를 **갖고 있지 않으면** `absent`(이 경로의 한계)이고,
   *   갖고 있는데 값이 안 나왔으면 그것은 `read` 에 없는 것으로 드러난다.
   */
  const has = (k) => out.seenReports.some((r) => reportKinds(r).includes(k));
  if (!has('nic')) out.absent.push('net');
  if (!has('fc')) out.absent.push('hba');
  if (!has('storage')) out.absent.push('disk');
  // 디스크 busy% 는 이 경로에 사실상 없다 — 리포트가 있어도 그렇다.
  if (!out.disks.some((d) => d.busyPct != null)) out.absent.push('diskbusy');
  return out;
}
