/**
 * tools/compareMatrix.js — 비교 매트릭스 집계(순수, v2.499).
 *
 * 사용자 요구: "비교하기 누르면 vCenter 별 비교·클러스터별 비교·스토리지별 비교로 보여주는 방식은,
 * **가로축은 vCenter, 세로축은 클러스터**인 매트릭스로 상태를 보여주는 기능"(서비스 허브 저장소
 * 비교표 형식). 같은 이름의 클러스터·데이터스토어가 여러 법인에 있으므로(PROD·DEV·DMZ 등 명명 규약)
 * 이름을 세로축에 두면 '같은 역할의 자원이 사이트마다 어떤 상태인가' 를 한눈에 비교할 수 있다.
 *
 * 설계 원칙:
 *  · **희소 셀**: (행, vCenter) 조합 중 **실재하는 것만** 담는다. 1,100 데이터스토어 × 28 vCenter 를
 *    빽빽한 표로 만들면 3만 셀이 되고 대부분 빈칸이다. 없는 조합은 화면에서 '—' 로 보이며
 *    **0 으로 채우지 않는다**(없는 것과 0 은 다르다 — 루트 CLAUDE.md 정직 규칙).
 *  · **행 상한 + 정직 표기**: 규모 순으로 자르고 자른 수를 함께 돌려준다.
 *  · 계산은 스냅샷만 읽는다(vCenter 추가 왕복 0). 호스트/VM/DS 를 한 번만 순회해 O(N).
 *  · 셀 키는 **중첩 Map**(행 → vCenter)이다. `${row}<구분자>${vcId}` 같은 문자열 결합을 쓰지 않는다 —
 *    구분자가 이름에 들어갈 수 있고(데이터스토어 이름에 임의 문자 허용), 개발 중 실제로 그 구분자가
 *    NUL 바이트로 들어가 파일이 'data' 로 분류되는 사고가 있었다(루트 CLAUDE.md 주의 항목).
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** 클러스터 축 지표 정의 — higher: 'bad'(높을수록 나쁨) · 'neutral'(규모) · 'good'(높을수록 좋음) */
export const CLUSTER_METRICS = Object.freeze([
  { key: 'cpuUsagePct', label: 'CPU 사용률', unit: '%', higher: 'bad' },
  { key: 'memUsagePct', label: '메모리 사용률', unit: '%', higher: 'bad' },
  { key: 'vcpuPerCore', label: 'vCPU:코어', higher: 'bad', help: '켜진 VM 의 vCPU 합 ÷ 물리 코어. 높으면 CPU 과할당(스케줄링 경합 위험).' },
  { key: 'memOvercommitPct', label: '메모리 과할당', unit: '%', higher: 'bad', help: '켜진 VM 의 할당 메모리 합 ÷ 호스트 물리 메모리.' },
  { key: 'hosts', label: '호스트', higher: 'neutral' },
  { key: 'vms', label: 'VM', higher: 'neutral' },
  { key: 'vmsOn', label: 'VM(On)', higher: 'neutral' },
  { key: 'cpuTotalGhz', label: 'CPU 총량', unit: ' GHz', higher: 'neutral' },
  { key: 'memTotalGB', label: '메모리 총량', unit: ' GB', higher: 'neutral' },
]);

/**
 * 스토리지(데이터스토어) 축 지표 정의.
 * 참고(정직): 'DS 별 VM 수' 는 제공하지 않는다 — 스냅샷의 VM 레코드에 데이터스토어 연결이 없다
 * (수집기가 VM 의 datastore 속성을 모으지 않는다). 없는 지표를 0 으로 채우지 않는다.
 */
export const DATASTORE_METRICS = Object.freeze([
  { key: 'usedPct', label: '사용률', unit: '%', higher: 'bad' },
  { key: 'capacityTB', label: '용량', unit: ' TB', higher: 'neutral' },
  { key: 'usedTB', label: '사용', unit: ' TB', higher: 'neutral' },
  { key: 'freeTB', label: '여유', unit: ' TB', higher: 'good' },
  { key: 'count', label: 'DS 개수', higher: 'neutral', help: '같은 이름의 데이터스토어가 그 vCenter 에 여러 개면 합산한 개수.' },
]);

/** 이름 정규화 — 앞뒤 공백만 제거한다(대소문자·구분자는 건드리지 않는다: 다른 자원을 합치면 거짓이 된다). */
const nameOf = (s) => String(s ?? '').trim();

/**
 * **사이트 접두 제거(휴리스틱, 기본 꺼짐)** — `Ashburn-CL3` · `Dublin-CL3` 처럼 이름 앞에 사이트가
 * 붙는 규약이면 행이 사이트마다 갈라져 매트릭스가 대각선이 되고 '같은 역할 비교' 가 성립하지 않는다.
 * 첫 `-` 토큰을 떼어 역할 이름으로 묶는다(`CL3`). 규약이 다르면 틀릴 수 있으므로 **옵션**이고,
 * 화면은 이것이 휴리스틱임을 밝히고 원래 이름을 툴팁에 남긴다.
 * 토큰이 1개뿐이면(구분자 없음) 그대로 둔다 — 이름 전체가 사라지면 안 된다.
 */
export function stripSitePrefix(name) {
  const s = nameOf(name);
  const i = s.indexOf('-');
  if (i <= 0 || i >= s.length - 1) return s;
  return s.slice(i + 1);
}

/** 중첩 Map 접근자 — rows: Map<행, Map<vcId, acc>> */
function cellOf(rows, row, vcId, mkAcc) {
  let byVc = rows.get(row);
  if (!byVc) rows.set(row, byVc = new Map());
  let a = byVc.get(vcId);
  if (!a) byVc.set(vcId, a = mkAcc());
  return a;
}
function totalOf(totals, row, mkAcc) {
  let a = totals.get(row);
  if (!a) totals.set(row, a = mkAcc());
  return a;
}

/**
 * 클러스터 매트릭스.
 * @param {object} slice scopeSlice 결과({ vcenters, hosts, vms, datastores })
 * @param {object} [opts] { maxRows = 200 }
 */
export function clusterMatrix(slice = {}, { maxRows = 200, normalize = false } = {}) {
  const rowName = normalize ? stripSitePrefix : nameOf;
  const vcs = (slice.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id }));
  const allowed = new Set(vcs.map((v) => v.id));
  const mkAcc = () => ({ hosts: 0, cores: 0, cpuTotalMhz: 0, cpuUsedMhz: 0, memTotalMB: 0, memUsedMB: 0, vms: 0, vmsOn: 0, vcpuOn: 0, memAllocOnMB: 0 });
  const rows = new Map();     // 행 -> Map<vcId, acc>
  const totals = new Map();   // 행 -> acc(전 vCenter 합)
  const origNames = new Map(); // 행 -> Set<원래 이름>(정규화했을 때 무엇이 합쳐졌는지 밝힌다)
  const note = (row, raw) => { let set = origNames.get(row); if (!set) origNames.set(row, set = new Set()); if (raw) set.add(raw); };

  for (const h of slice.hosts || []) {
    if (!allowed.has(h.vcenterId)) continue;
    const row = rowName(h.cluster) || '(독립 호스트)';
    note(row, nameOf(h.cluster));
    for (const a of [cellOf(rows, row, h.vcenterId, mkAcc), totalOf(totals, row, mkAcc)]) {
      a.hosts += 1;
      a.cores += num(h.cpuCores);
      a.cpuTotalMhz += num(h.cpuTotalMhz);
      a.cpuUsedMhz += num(h.cpuUsageMhz);
      a.memTotalMB += num(h.memTotalMB);
      a.memUsedMB += num(h.memUsageMB);
    }
  }
  for (const v of slice.vms || []) {
    if (!allowed.has(v.vcenterId) || v.template) continue;
    // VM 은 호스트가 없는 클러스터 이름을 가질 수 있다(스냅샷 불일치) — 그 경우에도 셀을 만든다.
    const row = rowName(v.cluster) || '(독립 호스트)';
    note(row, nameOf(v.cluster));
    for (const a of [cellOf(rows, row, v.vcenterId, mkAcc), totalOf(totals, row, mkAcc)]) {
      a.vms += 1;
      if (v.powerState === 'POWERED_ON') { a.vmsOn += 1; a.vcpuOn += num(v.cpuCount); a.memAllocOnMB += num(v.memMB); }
    }
  }

  const shape = (a) => ({
    cpuUsagePct: pct(a.cpuUsedMhz, a.cpuTotalMhz),
    memUsagePct: pct(a.memUsedMB, a.memTotalMB),
    vcpuPerCore: a.cores > 0 ? r1(a.vcpuOn / a.cores) : null,
    memOvercommitPct: a.memTotalMB > 0 ? Math.round((a.memAllocOnMB / a.memTotalMB) * 100) : null,
    hosts: a.hosts,
    vms: a.vms,
    vmsOn: a.vmsOn,
    cpuTotalGhz: r1(a.cpuTotalMhz / 1000),
    memTotalGB: Math.round(a.memTotalMB / 1024),
  });

  return buildRows({ rows, totals, vcs, shape, mkAcc, maxRows, sortBy: (t) => t.vms, origNames });
}

/** 스토리지 매트릭스 — 같은 이름의 데이터스토어가 한 vCenter 에 여러 개면 합산한다(개수도 함께 보인다). */
export function datastoreMatrix(slice = {}, { maxRows = 300, normalize = false } = {}) {
  const rowName = normalize ? stripSitePrefix : nameOf;
  const vcs = (slice.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id }));
  const allowed = new Set(vcs.map((v) => v.id));
  const mkAcc = () => ({ count: 0, capacityGB: 0, usedGB: 0, freeGB: 0 });
  const rows = new Map();
  const totals = new Map();
  const origNames = new Map();
  const note = (row, raw) => { let set = origNames.get(row); if (!set) origNames.set(row, set = new Set()); if (raw) set.add(raw); };

  for (const d of slice.datastores || []) {
    if (!allowed.has(d.vcenterId)) continue;
    const row = rowName(d.name) || '(이름 없음)';
    note(row, nameOf(d.name));
    const used = d.usedGB != null ? num(d.usedGB) : Math.max(0, num(d.capacityGB) - num(d.freeGB));
    for (const a of [cellOf(rows, row, d.vcenterId, mkAcc), totalOf(totals, row, mkAcc)]) {
      a.count += 1;
      a.capacityGB += num(d.capacityGB);
      a.usedGB += used;
      a.freeGB += num(d.freeGB);
    }
  }

  const shape = (a) => ({
    usedPct: pct(a.usedGB, a.capacityGB),
    capacityTB: r1(a.capacityGB / 1024),
    usedTB: r1(a.usedGB / 1024),
    freeTB: r1(a.freeGB / 1024),
    count: a.count,
  });

  return buildRows({ rows, totals, vcs, shape, mkAcc, maxRows, sortBy: (t) => t.capacityGB, origNames });
}

/** 공통 조립 — 행 정렬·상한·희소 셀·행 합계·열(vCenter) 합계. */
function buildRows({ rows, totals, vcs, shape, mkAcc, maxRows, sortBy, origNames }) {
  const names = [...totals.keys()].sort(
    (a, b) => (sortBy(totals.get(b)) - sortBy(totals.get(a))) || a.localeCompare(b, undefined, { numeric: true }),
  );
  const limit = Math.max(1, Number(maxRows) || 200);
  const kept = names.slice(0, limit);
  // 열 합계는 **표시 대상 행만** 합산한다 — 자른 행을 넣으면 열 합계와 보이는 행의 합이 어긋난다.
  const colAcc = new Map();
  const out = kept.map((name) => {
    const byVc = rows.get(name) || new Map();
    const cells = {};
    let present = 0;
    for (const v of vcs) {
      const a = byVc.get(v.id);
      if (!a) continue;                       // 희소 — 없는 조합은 담지 않는다(0 으로 채우지 않는다)
      cells[v.id] = shape(a);
      present += 1;
      let c = colAcc.get(v.id);
      if (!c) colAcc.set(v.id, c = mkAcc());
      for (const k of Object.keys(a)) c[k] += a[k];
    }
    const orig = origNames?.get(name);
    return { name, cells, total: shape(totals.get(name)), vcenters: present, ...(orig && (orig.size > 1 || !orig.has(name)) ? { origNames: [...orig].sort().slice(0, 12) } : {}) };
  });
  const colTotals = {};
  for (const [vcId, a] of colAcc) colTotals[vcId] = shape(a);
  return {
    vcenters: vcs,
    rows: out,
    colTotals,
    rowCount: names.length,
    truncated: names.length > kept.length,
    truncatedRows: names.length - kept.length,
  };
}
