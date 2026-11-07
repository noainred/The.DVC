// v2.925(B-③ — 시안 san-cvp-traffic §4.3 'ESXi vmnic 드롭·에러'): 호스트 물리 NIC(vmnic) 성능 카운터 — 순수 파서 · 요약.
//   네트워크 I/O 가 '스위치 쪽에서 버려지는가, ESXi 쪽에서 버려지는가' 를 보려면 두 쪽 드롭이 **같은 창**에 함께 있어야 한다(시안 §4.2).
//   CVP 쪽은 cvp/db.js portWindowSums(원시 표본 합), ESXi 쪽은 여기 — vCenter QueryPerf 를 instance '*' 로 물어 vmnic 마다 계열을 받는다.
//
//   ⚠ 통계 레벨: VMware 문서 기준 실시간(20초) 통계는 호스트가 들고 있어 통계 레벨과 무관하고, 일·주 롤업만 레벨을 따른다.
//     그래서 '최근 1시간 실시간' 만 묻는다(실장비로 확인하지 못했다 — 카운터가 없거나 계열이 비면 '—' 로 둔다).
//   ⚠ vCenter 는 그 시각 값을 모르면 -1 을 준다(수집 공백) — 0 으로 세지 않고 결측으로 따로 센다(entityMetricPoints 와 같은 규약).
//   ⚠ 합은 값이 있는 표본만 더한다. 결측이 섞이면 partial 로 밝힌다(부분 합 — 화면이 '표본 N/M' 을 붙인다).

/** 카운터 키('group.name.rollup') — 전부 summation(20초 구간당 개수). 처리량(KBps)은 호스트 성능 화면·CVP 포트 bps 가 이미 보여 준다. */
export const HOST_NIC_COUNTERS = {
  droppedRx: 'net.droppedRx.summation', droppedTx: 'net.droppedTx.summation',
  errorsRx: 'net.errorsRx.summation', errorsTx: 'net.errorsTx.summation',
  packetsRx: 'net.packetsRx.summation', packetsTx: 'net.packetsTx.summation',
};
const SUM_KEYS = Object.keys(HOST_NIC_COUNTERS);
const DROP_ERR_KEYS = ['droppedRx', 'droppedTx', 'errorsRx', 'errorsTx'];
/** 인스턴스(vmnic) 상한 — 호스트 물리 NIC 은 많아야 수십 개다. 넘으면 truncated. */
export const NIC_INSTANCE_MAX = 64;
/** 실시간 최근 1시간(20초 × 180). */
export const NIC_REALTIME_SAMPLES = 180;
const INSTANCE_RE = /^[A-Za-z][\w.:-]{0,63}$/;
const VALUES_MAX = 4096;   // 계열 하나의 표본 상한(실시간 1시간은 180 — 이상한 응답이 메모리를 붙잡지 않게)

/**
 * instance '*' QueryPerf 응답(첫 returnval) → { times, series: Map<counterId, Map<instance, number[]>>, truncated }.
 *   계열 경계는 `<id>` 블록으로 잡는다(parsePerfMultiXml 과 같은 이유 — 계열 컨테이너와 표본이 같은 `<value>` 태그를 쓴다).
 *   집계 계열(instance '')과 모양이 이상한 인스턴스 이름은 버린다. 인스턴스는 NIC_INSTANCE_MAX 개까지.
 */
export function parsePerfInstancesXml(xml, counterIds = [], { maxInstances = NIC_INSTANCE_MAX } = {}) {
  const ids = [...new Set((counterIds || []).filter(Boolean).map(String))];
  const series = new Map(ids.map((id) => [id, new Map()]));
  const out = { times: [], series, truncated: false };
  if (!ids.length) return out;
  const rv = /<returnval[^>]*>([\s\S]*?)<\/returnval>/.exec(String(xml || ''))?.[1] || '';
  if (!rv) return out;
  out.times = [...rv.matchAll(/<timestamp>([^<]{1,40})<\/timestamp>/g)].map((m) => m[1]).slice(0, VALUES_MAX);
  const marks = [...rv.matchAll(/<id>([\s\S]*?)<\/id>/g)];
  const seen = new Set();
  for (let i = 0; i < marks.length; i++) {
    const cid = /<counterId>(\d+)<\/counterId>/.exec(marks[i][1])?.[1];
    if (!cid || !series.has(cid)) continue;
    const instance = /<instance>([^<]*)<\/instance>/.exec(marks[i][1])?.[1] ?? '';
    if (!instance || !INSTANCE_RE.test(instance)) continue;   // 집계('') · 이상한 이름
    if (!seen.has(instance)) {
      if (seen.size >= maxInstances) { out.truncated = true; continue; }
      seen.add(instance);
    }
    if (series.get(cid).has(instance)) continue;   // 같은 계열이 두 번 오면 첫 것
    const from = marks[i].index + marks[i][0].length;
    const to = i + 1 < marks.length ? marks[i + 1].index : rv.length;
    const vals = [];
    for (const m of rv.slice(from, to).matchAll(/<value>(-?\d{1,18})<\/value>/g)) {
      vals.push(Number(m[1]));
      if (vals.length >= VALUES_MAX) break;
    }
    series.get(cid).set(instance, vals);
  }
  return out;
}

/** 'vmnic10' 이 'vmnic2' 뒤에 오게(숫자 인식 정렬). */
const nicCmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/**
 * 파싱 결과 → vmnic 별 요약(순수).
 * @param {{times:string[], series:Map<string,Map<string,number[]>>}} parsed
 * @param {Record<string,string>} idOf  키(droppedRx…) → counterId(카탈로그에 없으면 빠진다)
 * @returns {{ nics: object[], windowStart: string|null, windowEnd: string|null, samples: number }}
 *   nics[i] = { nic, droppedRx…packetsTx(합|null), valid:{키:값 있는 표본 수}, samples, partial }
 *   - 합은 값이 있는(≥0) 표본만. 값이 하나도 없으면 null(0 이 아니다).
 *   - partial = 드롭·에러 계열 중 하나라도 결측(-1·짧은 계열)이 섞였다 — 그 합은 창 전체가 아니다.
 */
export function summarizeNicPerf(parsed, idOf = {}) {
  const times = Array.isArray(parsed?.times) ? parsed.times : [];
  const series = parsed?.series instanceof Map ? parsed.series : new Map();
  const total = times.length;
  const names = new Set();
  for (const k of SUM_KEYS) {
    const s = idOf[k] != null ? series.get(String(idOf[k])) : null;
    if (s) for (const n of s.keys()) names.add(n);
  }
  const nics = [...names].sort(nicCmp).map((nic) => {
    const row = { nic, valid: {}, samples: total, partial: false };
    for (const k of SUM_KEYS) {
      const vals = idOf[k] != null ? (series.get(String(idOf[k]))?.get(nic) || null) : null;
      if (!vals) { row[k] = null; row.valid[k] = 0; continue; }
      let sum = 0; let n = 0;
      for (let i = 0; i < Math.min(vals.length, total || vals.length); i++) {
        const v = vals[i];
        if (!Number.isFinite(v) || v < 0) continue;
        sum += v; n += 1;
      }
      row.valid[k] = n;
      row[k] = n ? sum : null;
      if (DROP_ERR_KEYS.includes(k) && total && n < total) row.partial = true;
    }
    return row;
  });
  return { nics, windowStart: times[0] || null, windowEnd: times[total - 1] || null, samples: total };
}
