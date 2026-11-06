/**
 * bmusage/useJudge.js — 리눅스 성능 1단계(v2.919) **USE 판정 · 교차 판정 · 커버리지**의 단일 코어(순수).
 *
 * 설계 `docs/design/linux-bm-perf/README.md` §3.2 · §4.2. 판정은 **여기 하나**다 — 웹이 같은 판정을 다시 만들지 않는다
 *   (서버가 `code` 를 내고, 판정 한 줄(`line`)도 이 노드가 만든다. 중앙은 엣지가 만든 결과를 그대로 전한다 — v2.548 규약).
 *
 * 칸(자원 × U·S·E)의 code:
 *   `ok` · `warn` · `bad` — 기준값(settings.perf — API 가 내려준다)과 비교한 결과
 *   `none`    — 그 커널·장비에 **구조적으로 없다**(absent — 예: PSI 없는 RHEL 8). 못 읽은 것과 다르다.
 *   `missing` — 경로는 있는데 이번에 **못 읽었다**(첫 표본 · 출력 잘림 · 형식 미인식 · 이 저장소가 받지 않는 값)
 *   `nopath`  — 그 값을 주는 **경로가 이 서버에 없다**(OS 계정 없음 → 포화 칸 · iDRAC 등록 없음 → 하드웨어 축). 설계 §3.2 ‘경로 없음’.
 * ⚠ none·missing·nopath 는 판정(병목·포화·오류)에 넣지 않고 **따로 센다**(numOrNull 규약 — ‘못 읽은 값은 0 이 아니다’).
 * ⚠ ‘병목’ = 한 자원의 세 칸 중 둘 이상 bad · ‘포화’ = S 가 bad · ‘오류’ = E 가 bad(설계 §4.2).
 * ⚠ 교차 판정은 **둘 다 읽힌 서버에서만** 켜지고 ‘후보’ 로만 말한다(상관 ≠ 원인).
 */
import { numOrNull } from '../util/numOrNull.js';
import { PERF_DEFAULTS } from './settings.js';

const n = numOrNull;
export const RESOURCES = Object.freeze(['cpu', 'mem', 'disk', 'net', 'hw']);
export const RESOURCE_LABEL = Object.freeze({ cpu: 'CPU', mem: '메모리', disk: '디스크', net: '네트워크', hw: '하드웨어' });
// v2.919(반증 D4): `stale` — 그 칸을 준 표본이 신선도 한계를 넘었다(오래된 값을 지금 값으로 판정하지 않는다). 판정에 넣지 않고 따로 센다.
export const CODES = Object.freeze(['ok', 'warn', 'bad', 'none', 'missing', 'nopath', 'stale']);
// v2.919(반증 D4·D5): `partial` — 판정한 칸이 기준 비율(minJudgedPct) 미만이라 ‘정상’ 이라 말하지 않는다 · `stale` — OS/행 표본이 오래됨.
export const VERDICT_LABEL = Object.freeze({ bottleneck: '병목', saturated: '포화', errors: '오류', warn: '주의', ok: '정상', partial: '대부분 못 읽음', stale: '오래됨', unknown: '판정 불가' });
const RANK = { bad: 3, warn: 2, ok: 1 };

/** 값 하나를 warn/bad 기준과 비교 — 값이 없으면 null(판정 보류). */
export function grade(v, warn, bad) {
  const x = n(v); const w = n(warn); const b = n(bad);
  if (x == null || w == null || b == null) return null;
  return x >= b ? 'bad' : x >= w ? 'warn' : 'ok';
}
/** 증가분 + 연속 주기 — 0 이면 ok · 증가 → warn · `repeatBad` 주기 연속 증가 → bad. 값이 없으면 null. */
export function gradeIncrease(delta, streak, repeatBad) {
  const d = n(delta);
  if (d == null) return null;
  if (d <= 0) return 'ok';
  return (n(streak) ?? 1) >= (n(repeatBad) ?? 3) ? 'bad' : 'warn';
}

/**
 * 입력 여럿 → 한 칸. 판정된 입력 중 가장 나쁜 것. 판정된 입력이 하나도 없으면 — 경로가 없으면 nopath, 입력이 전부 absent 면 none, 아니면 missing.
 * @param {Array<{key:string,label:string,value:any,unit?:string,code:string|null,absent?:boolean}>} inputs
 */
function cell(inputs, { path = true } = {}) {
  const basis = inputs.map((x) => ({ key: x.key, label: x.label, value: x.value ?? null, unit: x.unit || '', code: x.code || (x.absent ? 'none' : (path ? 'missing' : 'nopath')), ...(x.device ? { device: x.device } : {}) }));
  if (!path) return { code: 'nopath', basis };
  const graded = inputs.filter((x) => x.code);
  if (graded.length) {
    const worst = graded.reduce((a, b) => (RANK[b.code] > RANK[a.code] ? b : a));
    return { code: worst.code, basis };
  }
  if (inputs.length && inputs.every((x) => x.absent)) return { code: 'none', basis };
  return { code: 'missing', basis };
}

/**
 * 커버리지 4등급 — 'both' · 'os' · 'idrac' · 'none'. 경로를 ‘읽었다’ 는 그 경로의 마지막 성공이 신선도 한계 안이라는 뜻이다.
 * iDRAC 쪽은 bmusage 텔레메트리(idrac_at) 또는 주 iDRAC 폴러가 받아 둔 사실(hw.read — 전력·센서·인벤토리) 중 하나면 읽힌 것이다.
 */
export function coverageOf({ osAt = null, idracAt = null, hwRead = false, now = Date.now(), freshMs = 15 * 60_000 } = {}) {
  const fresh = (at) => n(at) != null && now - n(at) <= freshMs;
  const os = fresh(osAt);
  const idrac = fresh(idracAt) || !!hwRead;
  return os && idrac ? 'both' : os ? 'os' : idrac ? 'idrac' : 'none';
}
/** 신선도 한계 — 수집 주기 × 3(누적 카운터 간격 한계와 같은 배수), 최소 15분. */
export function freshMsFor(intervalMs) {
  const iv = n(intervalMs);
  return Math.max(15 * 60_000, iv != null && iv > 0 ? iv * 3 : 0);
}

const sec = (detail, name) => (detail?.sections ? detail.sections[name] : undefined);
const psiAbsent = (detail) => sec(detail, 'psi') === 'absent';

/**
 * USE 판정 — 한 서버.
 * @param {object} p
 * @param {object} p.row      usage_latest 행(새 열 포함)
 * @param {object|null} p.detail  detail_json 파싱 결과
 * @param {object|null} p.hw      hwFacts.shapeHwFacts 결과(iDRAC 등록이 없으면 null)
 * @param {string} p.coverage    coverageOf 결과
 * @param {object} [p.th]        기준값(settings.perf) — 빠진 키는 PERF_DEFAULTS
 */
export function judgeUse({ row = {}, detail = null, hw = null, coverage = 'none', th = {}, now = null, freshMs = null } = {}) {
  const T = { ...PERF_DEFAULTS, ...(th || {}) };
  const osPath = coverage === 'both' || coverage === 'os';
  const idPath = coverage === 'both' || coverage === 'idrac';
  const windows = detail?.osKind === 'windows';
  // Windows 는 이번 단계에서 새 지표를 읽지 않는다 — OS 포화·오류 칸은 ‘경로 없음’(못 읽음으로 세지 않는다).
  const osPerf = osPath && !windows;
  const anyPath = osPath || idPath;
  const v = (k) => n(row[k]);
  const streak = detail?.streak || {};
  const pa = psiAbsent(detail);

  const cells = {
    cpu: {
      U: cell([{ key: 'cpu_pct', label: 'CPU 사용률', value: v('cpu_pct'), unit: '%', code: grade(v('cpu_pct'), T.utilWarn, T.utilBad) }], { path: anyPath }),
      S: cell([
        { key: 'runq_per_core', label: '런큐/코어', value: v('runq_per_core'), code: grade(v('runq_per_core'), T.runqWarn, T.runqBad) },
        { key: 'psi_cpu_some10', label: 'PSI cpu some', value: v('psi_cpu_some10'), unit: '%', code: grade(v('psi_cpu_some10'), T.psiCpuSomeWarn, T.psiCpuSomeBad), absent: pa },
      ], { path: osPerf }),
      E: cell(hwFaultInputs(hw, 'cpuFaults', 'CPU 부품'), { path: idPath && !!hw }),
    },
    mem: {
      U: cell([{ key: 'mem_pct', label: '메모리 사용률', value: v('mem_pct'), unit: '%', code: grade(v('mem_pct'), T.utilWarn, T.utilBad) }], { path: anyPath }),
      S: cell([
        { key: 'swap_out_ps', label: '스왑 아웃', value: v('swap_out_ps'), unit: 'pages/s', code: grade(v('swap_out_ps'), T.swapOutWarn, T.swapOutBad) },
        { key: 'psi_mem_full10', label: 'PSI memory full', value: v('psi_mem_full10'), unit: '%', code: grade(v('psi_mem_full10'), T.psiFullWarn, T.psiFullBad), absent: pa },
      ], { path: osPerf }),
      // 오류는 OOM(OS)과 ECC·DIMM(iDRAC)을 **나란히** — 합산하지 않는다(설계 §3.2). 한쪽 경로만 있으면 그쪽만.
      E: cell([
        ...(osPerf ? [{ key: 'oom_kill_delta', label: 'OOM kill', value: v('oom_kill_delta'), unit: '건', code: gradeIncrease(v('oom_kill_delta'), streak.oom, T.errRepeatBad) }] : []),
        ...(idPath && hw ? dimmInputs(hw) : []),
      ], { path: osPerf || (idPath && !!hw) }),
    },
    disk: {
      U: cell([{ key: 'disk_busy_pct', label: '디스크 busy', value: v('disk_busy_pct'), unit: '%', code: grade(v('disk_busy_pct'), T.utilWarn, T.utilBad) }], { path: osPerf }),
      S: cell([
        { key: 'disk_aqu', label: '평균 대기열', value: v('disk_aqu'), code: grade(v('disk_aqu'), T.queueWarn, T.queueBad), device: topDevice(detail?.disks, 'aqu') },
        { key: 'psi_io_full10', label: 'PSI io full', value: v('psi_io_full10'), unit: '%', code: grade(v('psi_io_full10'), T.psiFullWarn, T.psiFullBad), absent: pa },
      ], { path: osPerf }),
      E: cell(idPath && hw ? diskHealthInputs(hw) : [], { path: idPath && !!hw }),
    },
    net: {
      U: cell([{ key: 'net_pct', label: '네트워크 사용률', value: v('net_pct'), unit: '%', code: grade(v('net_pct'), T.utilWarn, T.utilBad) }], { path: anyPath }),
      S: cell([
        { key: 'net_drop_delta', label: '드롭 증가', value: v('net_drop_delta'), unit: '건', code: gradeIncrease(v('net_drop_delta'), streak.netDrop, T.errRepeatBad), device: topDevice(detail?.nics, 'dropDelta', 'iface') },
        { key: 'tcp_retrans_pct', label: 'TCP 재전송', value: v('tcp_retrans_pct'), unit: '%', code: grade(v('tcp_retrans_pct'), T.retransWarn, T.retransBad) },
      ], { path: osPerf }),
      E: cell([
        ...(osPerf ? [{ key: 'net_err_delta', label: '오류 증가', value: v('net_err_delta'), unit: '건', code: gradeIncrease(v('net_err_delta'), streak.netErr, T.errRepeatBad), device: topDevice(detail?.nics, 'errDelta', 'iface') }] : []),
        ...(idPath && hw ? hwFaultInputs(hw, 'nicFaults', 'NIC 부품') : []),
      ], { path: osPerf || (idPath && !!hw) }),
    },
    hw: {
      U: cell([{ key: 'power_cap_pct', label: '전력 cap 대비', value: hw?.power?.capPct ?? null, unit: '%', code: grade(hw?.power?.capPct, T.powerCapWarnPct, T.powerCapBadPct) }], { path: idPath && !!hw }),
      S: cell([
        { key: 'inlet_c', label: '흡기 온도', value: hw?.inletC ?? null, unit: '℃', code: grade(hw?.inletC, T.inletWarnC, T.inletBadC) },
        { key: 'throttle', label: '스로틀', value: null, code: null },   // 이 저장소가 받지 않는 값 — missing(정직 기록)
      ], { path: idPath && !!hw }),
      E: cell([
        ...hwFaultInputs(hw, 'faults', '부품 장애'),
        { key: 'sel_critical', label: 'SEL Critical(최근)', value: hw?.selCritical ?? null, unit: '건', code: hw?.selCritical == null ? null : hw.selCritical > 0 ? 'warn' : 'ok' },
      ], { path: idPath && !!hw }),
    },
  };

  /*
   * v2.919(반증 D4): 행(OS·텔레메트리 값)이 신선도 한계를 넘었으면 그 행에서 온 칸(cpu·mem·disk·net)은 판정하지 않고 `stale` 로 둔다 —
   *   30일 전 표본이 ‘지금 CPU 97%’ 로 판정되던 결함. 하드웨어 칸은 hwFacts 가 이미 신선한 것만 주므로 그대로 둔다.
   *   now·freshMs 를 주지 않은 호출(단위 테스트)은 검사하지 않는다.
   */
  const rowStale = n(now) != null && n(freshMs) != null && (n(row.ts) == null || n(now) - n(row.ts) > n(freshMs));
  if (rowStale) {
    // 경로가 ‘지금’ 신선하지 않아 nopath 로 나온 칸도, 그 경로를 한 번이라도 읽었으면(os_at·idrac_at) ‘경로 없음’ 이 아니라 ‘오래됨’ 이다.
    const everOs = n(row.os_at) != null && !windows;
    const everAny = everOs || n(row.idrac_at) != null || n(row.os_at) != null;
    for (const r of ['cpu', 'mem', 'disk', 'net']) {
      for (const k of ['U', 'S', 'E']) {
        const had = cells[r][k].code !== 'nopath' || (k === 'U' ? everAny : everOs);
        if (had) cells[r][k] = { ...cells[r][k], code: 'stale' };
      }
    }
  }
  const counts = Object.fromEntries(CODES.map((c) => [c, 0]));
  const perRes = {};
  for (const r of RESOURCES) {
    for (const k of ['U', 'S', 'E']) counts[cells[r][k].code] += 1;
    const c = cells[r];
    const bads = ['U', 'S', 'E'].filter((k) => c[k].code === 'bad').length;
    const known = ['U', 'S', 'E'].filter((k) => RANK[c[k].code]).length;
    perRes[r] = bads >= 2 ? 'bottleneck' : c.S.code === 'bad' ? 'saturated' : c.E.code === 'bad' ? 'errors'
      : ['U', 'S', 'E'].some((k) => c[k].code === 'bad' || c[k].code === 'warn') ? 'warn' : known ? 'ok' : 'unknown';
  }
  const ORDER = ['bottleneck', 'saturated', 'errors', 'warn', 'ok', 'unknown'];
  let verdict = 'unknown'; let focus = null;
  for (const vv of ORDER) { const r = RESOURCES.find((x) => perRes[x] === vv); if (r) { verdict = vv; focus = r; break; } }
  if (rowStale) for (const r of ['cpu', 'mem', 'disk', 'net']) if (perRes[r] === 'unknown') perRes[r] = 'stale';
  /*
   * v2.919(반증 D5): 판정한 칸이 경로가 있는 칸의 기준 비율(minJudgedPct — API 값) 미만이면 ‘정상’ 이라 말하지 않는다(15칸 중 1칸만 읽고 정상이던 결함).
   *   병목·포화·오류·주의는 읽은 칸에서 실제로 나온 것이라 그대로 두고, 판정 한 줄에 ‘읽은 칸 j/a’ 를 늘 붙인다.
   */
  const judged = counts.ok + counts.warn + counts.bad;
  const applicable = RESOURCES.length * 3 - counts.nopath;
  if (rowStale && (verdict === 'ok' || verdict === 'unknown')) { verdict = 'stale'; focus = null; }
  else if (verdict === 'ok' && applicable > 0 && (judged / applicable) * 100 < T.minJudgedPct) { verdict = 'partial'; focus = null; }
  const bottleneckCount = RESOURCES.filter((r) => perRes[r] === 'bottleneck').length;

  // OS ↔ iDRAC CPU 불일치(설계 ⑨) — 어느 쪽이 맞는지 단정하지 않는다. OS 값은 이 행이 OS 출처일 때만.
  const osCpu = String(row.src || '').split('+').includes('os') ? v('cpu_pct') : null;
  const idCpu = hw ? n(hw.cpuPct) : null;
  const diffPp = osCpu != null && idCpu != null ? Math.round(Math.abs(osCpu - idCpu) * 10) / 10 : null;
  const mismatch = diffPp != null ? { cpu: { os: osCpu, idrac: idCpu, diffPp, flag: diffPp >= T.cpuMismatchPct } } : null;

  const read = { judged, applicable };
  return { cells, perResource: perRes, verdict, focus, bottleneckCount, counts, read, rowStale, mismatch, line: verdictLine(verdict, focus, cells, read) };
}

function hwFaultInputs(hw, field, label) {
  const list = hw ? hw[field] : null;
  if (!hw || list == null) return [{ key: field, label, value: null, code: null }];
  const bad = list.filter((f) => f.state === 'fault').length;
  const warn = list.filter((f) => f.state === 'warn').length;
  return [{ key: field, label, value: list.length, unit: '건', code: bad ? 'bad' : warn ? 'warn' : 'ok', ...(list.length ? { device: list[0].label } : {}) }];
}
function dimmInputs(hw) {
  const out = hwFaultInputs(hw, 'dimmFaults', 'DIMM 부품 장애');
  if (hw.dimmBad != null) out.push({ key: 'dimm_health', label: 'DIMM 상태', value: hw.dimmBad.length + hw.dimmWarn.length, unit: '개', code: hw.dimmBad.length ? 'bad' : hw.dimmWarn.length ? 'warn' : 'ok', ...(hw.dimmBad[0] || hw.dimmWarn[0] ? { device: hw.dimmBad[0] || hw.dimmWarn[0] } : {}) });
  else out.push({ key: 'dimm_health', label: 'DIMM 상태', value: null, code: null });
  out.push({ key: 'ecc_correctable', label: 'ECC 정정', value: null, code: null });   // 받지 않는 값 — missing
  return out;
}
function diskHealthInputs(hw) {
  const out = hwFaultInputs(hw, 'diskFaults', '디스크 부품 장애');
  out.push(hw.diskPredicted == null
    ? { key: 'smart_predicted', label: 'SMART 예측 장애', value: null, code: null }
    : { key: 'smart_predicted', label: 'SMART 예측 장애', value: hw.diskPredicted.length, unit: '개', code: hw.diskPredicted.length ? 'warn' : 'ok', ...(hw.diskPredicted[0] ? { device: hw.diskPredicted[0] } : {}) });
  return out;
}
/** 장치 목록에서 필드가 가장 큰 장치 이름(판정 한 줄의 근거 — ‘nvme1n1 await 18ms’). */
function topDevice(list, field, nameKey = 'name') {
  if (!Array.isArray(list)) return undefined;
  let best = null;
  for (const d of list) { const x = n(d?.[field]); if (x != null && (best == null || x > n(best[field]))) best = d; }
  return best ? String(best[nameKey] || '').slice(0, 64) || undefined : undefined;
}

const fmt = (x) => {
  const v = n(x);
  if (v == null) return '—';
  return Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
};
/**
 * 판정 한 줄 — ‘디스크 포화 — nvme1n1 평균 대기열 6.2 · PSI io full 12%’. 값은 측정값뿐이고 기준 숫자는 넣지 않는다(기준은 API 값).
 * 정상·판정 불가면 짧게. 백틱·`**` 를 쓰지 않는다(문구 규약).
 */
export function verdictLine(verdict, focus, cells, read = null) {
  const tail = read && n(read.applicable) != null ? ` · 읽은 칸 ${read.judged}/${read.applicable}` : '';
  if (verdict === 'stale') return `오래됨 — 마지막 표본이 신선도 한계를 넘어 판정하지 않았습니다${tail}`;
  if (verdict === 'partial') return `대부분 못 읽음 — 읽은 칸은 정상이지만 판정하기에 부족합니다${tail}`;
  if (!focus || verdict === 'unknown') return `판정 불가 — 읽은 칸이 없습니다${tail}`;
  if (verdict === 'ok') return `정상${tail}`;
  const c = cells[focus];
  const ev = [];
  for (const k of ['S', 'E', 'U']) {
    for (const b of c[k].basis) {
      if (b.code !== 'bad' && b.code !== 'warn') continue;
      ev.push(`${b.device ? `${b.device} ` : ''}${b.label} ${fmt(b.value)}${b.unit && b.value != null ? b.unit : ''}`);
      if (ev.length >= 3) break;
    }
    if (ev.length >= 3) break;
  }
  return `${RESOURCE_LABEL[focus]} ${VERDICT_LABEL[verdict]}${ev.length ? ` — ${ev.join(' · ')}` : ''}${tail}`;
}

/**
 * 교차 판정 ①~④(설계 §3.2) — **둘 다 읽힌 서버에서만** 켜진다. 상관은 ‘후보’ 로만.
 * state: `candidate`(조건이 맞아 원인 후보를 말한다) · `clear`(조건은 섰지만 iDRAC 쪽이 깨끗 — 다른 후보를 말한다) · `inactive`(OS 쪽 조건이 안 섰다) ·
 *        `missing`(판정에 필요한 값을 못 읽었다 — 이 저장소가 받지 않는 값 포함) · `nopath`(두 경로가 다 읽히지 않았다).
 */
export function crossJudge({ use, hw = null, coverage = 'none', th = {} } = {}) {
  const T = { ...PERF_DEFAULTS, ...(th || {}) };
  const both = coverage === 'both' && !!hw;
  const hot = (code) => code === 'warn' || code === 'bad';
  const mk = (id, title, body) => ({ id, title, ...(both ? body() : { state: 'nopath', code: '', evidence: [] }) });
  const c = use?.cells || {};
  return [
    mk(1, 'CPU 포화의 원인이 전력·열 제한인가', () => {
      if (!hot(c.cpu?.S?.code)) return { state: 'inactive', code: '', evidence: [] };
      const capPct = n(hw.power?.capPct); const inlet = n(hw.inletC);
      const ev = [`전력 cap 대비 ${fmt(capPct)}${capPct != null ? '%' : ''}`, `흡기 ${fmt(inlet)}${inlet != null ? '℃' : ''}`, '스로틀 —(받지 않는 값)'];
      if ((capPct != null && capPct >= T.powerCapWarnPct) || (inlet != null && inlet >= T.inletWarnC)) return { state: 'candidate', code: 'power-thermal-limit', evidence: ev };
      if (capPct == null && inlet == null) return { state: 'missing', code: '', evidence: ev };
      return { state: 'clear', code: 'cpu-demand', evidence: ev };
    }),
    mk(2, '디스크 대기 증가가 고장 전조인가', () => {
      if (!hot(c.disk?.S?.code)) return { state: 'inactive', code: '', evidence: [] };
      const pred = hw.diskPredicted; const df = hw.diskFaults;
      const ev = [`SMART 예측 장애 ${pred == null ? '—' : pred.length}`, `디스크 부품 장애 ${df == null ? '—' : df.length}`, 'SMART 재할당 —(받지 않는 값)'];
      if ((pred && pred.length) || (df && df.length)) return { state: 'candidate', code: 'replace-candidate', evidence: ev, devices: [...(pred || []), ...((df || []).map((f) => f.label))].slice(0, 8) };
      if (pred == null && df == null) return { state: 'missing', code: '', evidence: ev };
      return { state: 'clear', code: 'io-volume', evidence: ev };
    }),
    mk(3, '메모리 오류의 위치(DIMM)', () => {
      const bad = [...(hw.dimmBad || []), ...(hw.dimmWarn || []), ...((hw.dimmFaults || []).map((f) => f.label))].filter(Boolean);
      const ev = [`DIMM 이상 ${hw.dimmBad == null ? '—' : bad.length}`, 'ECC 정정 —(받지 않는 값)', 'OS MCE —(이번 단계에서 읽지 않음)'];
      if (bad.length) return { state: 'candidate', code: 'dimm-slot', evidence: ev, devices: [...new Set(bad)].slice(0, 8) };
      if (hw.dimmBad == null && hw.dimmFaults == null) return { state: 'missing', code: '', evidence: ev };
      return { state: 'inactive', code: '', evidence: ev };
    }),
    mk(4, '드롭이 커널·큐 문제인가 회선(케이블·광모듈) 문제인가', () => {
      const drop = c.net?.S?.basis?.find((b) => b.key === 'net_drop_delta');
      if (!hot(drop?.code)) return { state: 'inactive', code: '', evidence: [] };
      // iDRAC NIC CRC 는 이 저장소가 받지 않는다 — 단정하지 않고 missing(정직 기록). 받게 되면 0 → kernel-queue · >0 → cable-optic.
      if (hw.nicCrc == null) return { state: 'missing', code: '', evidence: [`드롭 증가 ${fmt(drop.value)}건`, 'iDRAC CRC —(받지 않는 값)'] };
      return hw.nicCrc > 0 ? { state: 'candidate', code: 'cable-optic', evidence: [`CRC ${hw.nicCrc}`] } : { state: 'candidate', code: 'kernel-queue', evidence: ['CRC 0'] };
    }),
  ];
}
