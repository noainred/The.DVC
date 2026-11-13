/**
 * mock/demo/baremetal.js — 데모(DATA_SOURCE=mock) 베어메탈 서버·베어메탈 사용률(v2.708).
 *
 * 예전 mock 은 iDRAC 등록이 전부 ESXi 를 받치는 서버라 통합 서버 인벤토리의 '베어메탈' 이 0대였고, 그 위에 서는 화면
 * (베어메탈 사용률·법인별 서버 사용량의 물리 서버)이 통째로 비었다. 여기서
 *  ① (idrac.js 가 한다) iDRAC 등록부에 **ESXi 가 아닌 물리 서버** 17대를 시드한다(id `mock-bmsrv-` — 이미 하나라도 있으면 다시 하지 않는다,
 *     등록부에 실등록(`mock-` 아님)이 있으면 하지 않는다). 이름이 ESXi 호스트와 겹치지 않으므로 classifyFleet 이 베어메탈로 분류한다.
 *  ② 베어메탈 사용률 폴러가 mock 이면 장비에 접속하지 않고 iDRAC 텔레메트리 모양의 합성 행을 만들고(`demoBmUsageRows`),
 *     원시 14일 + 일 롤업 45일을 1회 백필한다(`backfillBmUsage`).
 *  ③ (idrac.js 가 한다) seed.js 초판이 만든 mock 서비스태그 충돌(`MOCK`+해시 앞 6자리 — 70대가 11개 태그를 공유해 전력·인벤토리가 11대로 합쳐졌다)을
 *     `mock-` 항목에 한해 1회 고친다.
 * 규칙은 flags.js 머리말 — mock 모드에서만, 설정 파일은 바꾸지 않는다(사용률 수집 켜짐·법인 선택은 판정 지점의 데모 값이다).
 */
import { isMockMode, demoHash, demoRand } from './flags.js';
import { judgeHealth } from '../../bmusage/health.js'; // v2.929(5단계): 데모 소모품 칸은 실제 판정 함수로(응답 단계 전용 — 적재하지 않는다)
import { summarizeFocus } from '../../bmusage/focus/summary.js'; // v2.929: 데모 지난 세션 요약 — 실제 요약 함수(순수 모듈)
// 베어메탈 사양·시드·서비스태그 보정은 idrac.js 가 소유한다(이 모듈 → idrac.js 단방향 — 순환 금지). 호환을 위해 재수출한다.
import { demoServerProfile, demoLoadAt, BM_PREFIX, demoBareMetalSpecs, bareMetalSpecOf, primeBareMetalSpecs, ensureBareMetalSeed, repairMockServiceTags, _resetBareMetalSeedForTest } from './idrac.js';
export { BM_PREFIX, demoBareMetalSpecs, bareMetalSpecOf, primeBareMetalSpecs, ensureBareMetalSeed, repairMockServiceTags };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/* ───────────────────────── 베어메탈 사용률 ───────────────────────── */

/**
 * 데모 설정 — 저장된 설정 파일은 바꾸지 않고 판정 지점에서만 덮는다: 수집 켜짐 · 모든 법인 선택 · 귀속 없는 서버 포함 · iDRAC 경로 켬.
 * 가상화 호스트(includeVirtualization)는 저장값 그대로 둔다(켜면 ESXi 186대가 대상이 되어 사용률 화면이 베어메탈을 덮는다).
 */
export function demoBmSettings(saved = {}, vcenters = []) {
  if (!isMockMode()) return saved;
  const corps = { ...(saved.corps || {}) };
  for (const v of vcenters || []) if (v?.id) corps[v.id] = true;
  return { ...saved, enabled: true, corps, includeUnassigned: true, idracTelemetry: true, demo: true };
}

/**
 * v2.719(감사 R1-03): 데모 대상인가 — iDRAC 등록 id(serverId·regId)가 `mock-` 이거나, iDRAC 없이 OS 계정만 있는 대상이면
 * 그 OS 등록 id 가 `mock-` 일 때. mock 모드라도 사람이 등록한 서버(`mock-` 아님)는 합성하지 않고 예전처럼 수집한다
 * (합성 값이 실장비 키로 이력 DB 에 실측처럼 남지 않게 — flags.js 규칙).
 */
export function isDemoBmTarget(tg) {
  const m = (v) => String(v || '').startsWith('mock-');
  if (!tg || typeof tg !== 'object') return false;
  if (m(tg.serverId) || m(tg.idrac?.regId)) return true;
  return !tg.idrac && !String(tg.serverId || '').trim() && m(tg.osHost?.id);
}

const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 한 대상의 시각 t 사용률 행 — iDRAC 텔레메트리 경로의 값만(CPU·메모리·I/O 집계·NIC·FC). 디스크 busy·디스크 사용률은
 * 실장비에서도 OS 경로만 주므로 **비워 둔다**(지어내지 않는다 — 화면이 '그 값은 OS 경로만 줍니다' 를 말한다).
 */
export function demoBmUsageRow(target, t) {
  const key = String(target.key || target.serviceTag || target.serverId || target.name || '');
  const spec = bareMetalSpecOf(target.serverId || target.regId || '') || null;
  const p = demoServerProfile({ id: String(target.serverId || key), vcenterId: target.vcenterId }, { spec: spec || { model: target.model || 'PowerEdge R650', loadBase: 20 + (demoHash(key) % 40), gpus: [] } });
  const load = demoLoadAt(p, t);
  const wob = (k) => demoRand(`${key}|${k}|${Math.floor(t / (15 * MIN))}`);
  const memBase = 35 + (demoHash(`mem|${key}`) % 40);
  const netPct = r1(clamp(load * 0.35 + wob('n') * 8, 0, 100));
  const fast = /db|gpu/.test(String(target.name || '')) ? 25e9 : 10e9;
  const hasFc = /db/.test(String(target.name || ''));
  return {
    // v2.719(감사 R1-03): 데모 행 표지 — src 토큰 'demo'. 'idrac' 토큰은 그대로 둔다(iDRAC 출처 판정 bmSrcIsIdrac·IDRAC_ONLY_SQL 이 같게 읽는다).
    key, name: target.name || key, vcenterId: target.vcenterId || '', ts: t, src: 'idrac+demo', src_cm: 'ii', // v2.992: 지표별 출처(데모 — iDRAC 행)
    cpu_pct: r1(load), mem_pct: r1(clamp(memBase + load * 0.25 + (wob('m') - 0.5) * 4, 1, 99)),
    disk_busy_pct: null, disk_used_pct: null,
    net_pct: netPct, net_bps: Math.round((netPct / 100) * (fast / 8)),
    hba_pct: hasFc ? r1(clamp(load * 0.5 + wob('h') * 10, 0, 100)) : null,
    hba_bps: hasFc ? Math.round(clamp(load * 0.5, 0, 100) / 100 * (32e9 / 8)) : null,
    io_pct: r1(clamp(load * 0.45 + wob('i') * 6, 0, 100)),
  };
}

/*
 * v2.920(리눅스 성능 2단계 화면): 데모 서버에 리눅스 성능 열(OS 경로)을 **조회 응답 단계에서만** 겹친다 — 예전 데모 행은 iDRAC 값만이고
 *   os_at·idrac_at 도 비어 USE 매트릭스가 전 서버 ‘판정 불가’ 였다(화면을 볼 수 없었다). 시나리오는 데모 대상 키 순위로 고정(결정적)이고
 *   상태 9종 중 데이터로 만들 수 있는 것(정상 · 포화 · 병목 · 첫 주기 · PSI 없음 · iDRAC 만 · 드롭 증가)을 고루 둔다.
 * ⚠⚠(2단계 반증 D2) **적재 경로에 넣지 않는다** — 폴러 결과(demoBmUsageResults → insertUsage)에 섞으면 합성 런큐·PSI 가 usage_history ·
 *   usage_daily `_max` 에 매 주기 쌓이고, 다섯 지표(cpu·mem·net)를 덮어써 ‘첫 주기’ 서버는 사용률이 영구 ‘—’ 가 됐다.
 *   그래서 ① 최신값을 읽어 응답을 만드는 곳(라우트 주 조회 · 서버 상세 · 엣지 봉투)만 `demoPerfLatestRows` 를 부르고
 *   ② 기존 다섯 지표 열은 **덮지 않는다**(성능 열 · os_at · idrac_at · detail_json 만 더한다). 불일치(OS↔iDRAC) 시나리오는 cpu_pct 를
 *   바꿔야 만들 수 있어 두지 않는다(그 상태는 화면 검증에서 응답 합성으로만 봤다 — 정직 기록). 판정은 하지 않는다(useJudge 가 한다).
 */
export const DEMO_PERF_SCENARIOS = Object.freeze(['idrac-only', 'healthy', 'disk-sat', 'cpu-sat', 'psi-absent', 'first', 'net-drop', 'mem-sat', 'healthy2']);
export function demoPerfOverlay(target, t, scenario, base = {}) {
  if (scenario === 'idrac-only' || !DEMO_PERF_SCENARIOS.includes(scenario)) return { idrac_at: t };
  const key = String(target.key || '');
  const w = (k) => demoRand(`${key}|perf|${k}|${Math.floor(t / (15 * MIN))}`);
  const cores = 16 + (demoHash(`cores|${key}`) % 3) * 16;
  const cpu = base.cpu_pct ?? 30;
  const first = scenario === 'first';
  const psiAbsent = scenario === 'psi-absent';
  const pick = (v) => (first ? null : v);
  const load1 = r1((scenario === 'cpu-sat' ? 2.1 : 0.2 + w('l') * 0.4) * cores);
  const psi = (v) => (psiAbsent ? null : v);
  const disks = [
    { name: 'nvme0n1', busyPct: pick(r1(scenario === 'disk-sat' ? 94 : 8 + w('d0') * 20)), iops: pick(Math.round(800 + w('i0') * 3000)), awaitMs: pick(r1(scenario === 'disk-sat' ? 18 : 0.4 + w('a0'))), aqu: pick(r1(scenario === 'disk-sat' ? 9.2 : 0.1 + w('q0') * 0.5)), inFlight: Math.round(w('f0') * 4) },
    { name: 'sda', busyPct: pick(r1(2 + w('d1') * 5)), iops: pick(Math.round(10 + w('i1') * 30)), awaitMs: pick(r1(3 + w('a1'))), aqu: pick(0), inFlight: 0 },
  ];
  const nics = [
    { iface: 'bond0', errDelta: pick(0), dropDelta: pick(scenario === 'net-drop' ? 1204 : 0), rxErrDelta: pick(0), txErrDelta: pick(0), rxDropDelta: pick(scenario === 'net-drop' ? 1204 : 0), txDropDelta: pick(0), state: 'up' },
    { iface: 'eno1', errDelta: pick(0), dropDelta: pick(0), rxErrDelta: pick(0), txErrDelta: pick(0), rxDropDelta: pick(0), txDropDelta: pick(0), state: 'up' },
  ];
  const maxOf = (list, k) => { const v = list.map((x) => x[k]).filter((x) => x != null); return v.length ? Math.max(...v) : null; };
  const cols = {
    cpu_user_pct: pick(r1(cpu * 0.7)), cpu_sys_pct: pick(r1(cpu * 0.15)), cpu_iowait_pct: pick(r1(scenario === 'disk-sat' ? 11 : w('io') * 2)), cpu_steal_pct: pick(0),
    cpu_core_max_pct: pick(r1(Math.min(100, cpu + 20 + w('cm') * 15))),
    load1, load5: r1(load1 * 0.9), load15: r1(load1 * 0.8), runq_per_core: Math.round((load1 / cores) * 100) / 100,
    ctxt_ps: pick(Math.round(8000 + w('cx') * 12000)),
    psi_cpu_some10: psi(r1(scenario === 'cpu-sat' ? 41 : w('pc') * 4)), psi_cpu_some60: psi(r1(scenario === 'cpu-sat' ? 38 : w('pc6') * 3)),
    swap_in_ps: pick(0), swap_out_ps: pick(scenario === 'mem-sat' ? 412 : 0), pgmajfault_ps: pick(r1(scenario === 'mem-sat' ? 180 : w('pf') * 3)),
    psi_mem_full10: psi(r1(scenario === 'mem-sat' ? 7 : 0)), psi_mem_full60: psi(r1(scenario === 'mem-sat' ? 6 : 0)),
    oom_kill_delta: pick(0),
    disk_iops: maxOf(disks, 'iops'), disk_await_ms: maxOf(disks, 'awaitMs'), disk_inflight: maxOf(disks, 'inFlight'), disk_aqu: maxOf(disks, 'aqu'),
    procs_blocked: scenario === 'disk-sat' ? 6 : 0,
    psi_io_full10: psi(r1(scenario === 'disk-sat' ? 12 : w('pi') * 0.5)), psi_io_full60: psi(r1(scenario === 'disk-sat' ? 10 : 0)),
    net_drop_delta: maxOf(nics, 'dropDelta'), tcp_retrans_pct: pick(r1(scenario === 'net-drop' ? 2.3 : 0.1 + w('rt') * 0.3)), net_err_delta: maxOf(nics, 'errDelta'),
  };
  const sec = (v) => ({ stat: v, load: v, psi: psiAbsent ? 'absent' : v, vmstat: v, snmp: v, blkq: v, sysctl: v, hugepages: v, irq: v, dfi: v });
  const detail = {
    v: 1, at: t, osKind: 'linux', firstSample: first, cores, coresTruncated: false, procsRunning: Math.round(load1), threads: 900 + Math.round(w('th') * 600),
    psi: psiAbsent ? null : { cpu: { some10: cols.psi_cpu_some10, some60: cols.psi_cpu_some60, some300: cols.psi_cpu_some60 }, memory: { some10: cols.psi_mem_full10, full10: cols.psi_mem_full10, full60: cols.psi_mem_full60, full300: 0 }, io: { some10: cols.psi_io_full10, full10: cols.psi_io_full10, full60: cols.psi_io_full60, full300: 0 } },
    disks, disksTotal: disks.length, nics, nicsTotal: nics.length, inodes: null,
    streak: { netErr: 0, netDrop: scenario === 'net-drop' ? 1 : 0, oom: 0 }, sections: sec('ok'), truncated: false,
  };
  const tuning = demoTuningFacts(key, t, cores);
  // v2.929(5단계): 점검 소모품 — 시나리오별 가상 사실을 실제 판정 함수(health.js)로 판정한다(수치 · 이름은 가상).
  detail.hfacts = demoHealthFacts(key, t, scenario);
  const h = judgeHealth({ hfacts: detail.hfacts, tuning, row: cols, cert: scenario === 'disk-sat' ? { days: 12, count: 1 } : null, th: {}, now: t });
  h.since = Object.fromEntries(Object.entries(h.cells).map(([k, c]) => [k, ['warn', 'bad'].includes(c.code) ? t - (1 + (demoHash(`${key}|${k}`) % 6)) * DAY : t - 20 * DAY]));
  detail.health = h;
  // v2.992(출처 색): 지표별 출처 — 데모 서버 일곱 대 중 하나는 메모리만 iDRAC(OS 가 메모리를 못 읽은 경우를 화면에서 보이게)
  const srcCm = demoHash(`srccm|${key}`) % 7 === 0 ? 'oi' : 'oo';
  return { ...cols, src: 'os+idrac+demo', src_cm: srcCm, os_at: t, idrac_at: t, detail_json: JSON.stringify(detail), tuning_json: JSON.stringify(tuning) };
}

/** v2.929 — 데모 소모품 사실(가상). 시나리오마다 주의 칸이 다르게 — 화면의 8칸 · 함대 ‘소모품 주의’ 표를 볼 수 있게. */
export function demoHealthFacts(key, t, scenario) {
  const w = (k) => demoRand(`${key}|hf|${k}|${Math.floor(t / DAY)}`);
  const base = {
    chrony: { offsetMs: Math.round((w('o') - 0.5) * 2000) / 1000, stratum: 3, leap: 'Normal', synced: true, refId: 'C0A80101' },
    dmesg: { err: 0, warn: 2, err24: 0, warn24: 0 }, upS: (20 + Math.floor(w('u') * 30)) * DAY / 1000, kernel: '5.14.0-427.13.1.el9_4.x86_64', needsRestart: false, nrAbsent: false,
    firewalld: 'inactive', fd: { alloc: 4096, max: 26214400, pct: 0 }, conntrack: { count: 1200 + Math.round(w('c') * 4000), max: 262144, pct: 1.2 }, oomTotal: 0,
    sections: { chrony: 'ok', dmesg: 'ok', changes: 'ok' },
  };
  if (scenario === 'first') return { ...base, chrony: null, dmesg: null, upS: null, needsRestart: null, fd: null, conntrack: null, oomTotal: null, sections: { chrony: 'missing', dmesg: 'missing', changes: 'missing' } };
  if (scenario === 'disk-sat') return { ...base, dmesg: { err: 3, warn: 9, err24: 1, warn24: 2 }, needsRestart: true, kernel: '5.14.0-362.24.1.el9_3.x86_64' };
  if (scenario === 'net-drop') return { ...base, chrony: { offsetMs: 12400, stratum: 0, leap: 'Not synchronised', synced: false, refId: '00000000' } };
  if (scenario === 'mem-sat') return { ...base, oomTotal: 2, conntrack: { count: 225000, max: 262144, pct: 85.8 } };
  if (scenario === 'psi-absent') return { ...base, chrony: null, dmesg: { failed: true, rc: 1 }, nrAbsent: true, needsRestart: null, sections: { chrony: 'absent', dmesg: 'ok', changes: 'ok' } };
  return base;
}

/**
 * v2.929 — 데모 집중 모니터링 한 분(장비에 접속하지 않는다 — 응답 · 보관 모두 가상). 시나리오가 disk-sat 이면 앞 4분 포화 → 완화 → 정상(아트보드 Focus 와 같은 흐름).
 *   5번째 분은 OS 결측(시한 초과) — 결측 칸을 볼 수 있게. 값 · 이름은 가상이다.
 */
export function demoFocusSample(target, t, idx) {
  const key = String(target.key || '');
  const w = (k) => demoRand(`${key}|fo|${k}|${idx}`);
  const hot = idx < 4; const cooling = idx === 5;
  if (idx === 4) return { osOk: false, idracOk: true, missOs: 'timeout', verdict: null, vals: { power_w: { avg: 449 }, inlet_c: { avg: 25 } }, snap: null };
  const await_ = hot ? 24 + idx * 60 + w('a') * 20 : cooling ? 41 : 2 + w('a') * 2;
  const vals = {
    cpu_pct: { avg: Math.round(hot ? 58 + idx * 6 : 60 - idx * 2), peak: Math.round(hot ? 80 + idx * 4 : 70) }, cpu_iowait_pct: { avg: hot ? 9 + idx * 8 : 7, peak: hot ? 20 + idx * 8 : 9 },
    runq_per_core: { avg: hot ? 0.3 + idx * 0.3 : 0.3 }, disk_busy_pct: { avg: hot ? 91 + idx * 3 : cooling ? 72 : 38, peak: hot ? 100 : 80 },
    disk_await_ms: { avg: Math.round(await_ * 10) / 10, peak: Math.round(await_ * 2.5) }, disk_aqu: { avg: hot ? 9 + idx * 18 : 1, peak: hot ? 31 + idx * 22 : 3 },
    psi_io_full10: { avg: hot ? 6 + idx * 12 : 0 }, mem_pct: { avg: 71 + (hot ? 1 : 0) }, swap_out_ps: { avg: 0 }, net_pct: { avg: 21 + idx, peak: 30 + idx }, net_drop_delta: { avg: 0 }, net_err_delta: { avg: 0 },
    power_w: { avg: 418 + (hot ? idx * 10 : 0) }, inlet_c: { avg: 24 }, dmesg_err: { avg: idx >= 2 ? 1 : 0 },
    _res: { disk: hot ? 'saturated' : cooling ? 'warn' : 'ok', cpu: hot && idx >= 2 ? 'saturated' : 'ok', mem: 'ok', net: 'ok', hw: 'ok' },
  };
  const io1 = idx < 2 || idx === 5 ? 'pg_dump' : 'checkpointer';
  return {
    osOk: true, idracOk: true, missOs: null, verdict: hot ? 'saturated' : cooling ? 'warn' : 'ok', vals,
    snap: { cpuTop: [{ name: 'postgres', cpuPct: 41 + idx * 3 }, { name: 'pg_dump', cpuPct: 9 }], ioTop: [{ name: io1, readBps: 0, writeBps: Math.round((hot ? 2e8 : 4e7) * (1 + w('i'))) }, { name: io1 === 'pg_dump' ? 'checkpointer' : 'pg_dump', readBps: 1e8, writeBps: 0 }, { name: 'walwriter', readBps: 0, writeBps: 3.8e7 }],
      io: 'ok', cpu: 'ok', ssTcp: { total: 120, estab: 88, timewait: 4 } },
  };
}

let _opsSeeded = null;
/**
 * v2.929 — 데모 변경 이벤트 · 지난 집중 세션 시드(1회 · 메인 bm-usage.db). 데모 대상(mock-)에만 · 이미 있으면 건너뛴다. 값은 가상이다.
 */
export async function seedDemoOps(targets = [], { now = Date.now() } = {}) {
  if (!isMockMode() || !targets.length) return { skipped: 'empty' };
  if (_opsSeeded) return _opsSeeded;
  _opsSeeded = (async () => {
    const O = await import('../../bmusage/opsDb.js');
    const { config } = await import('../../config.js');
    const agent = config.agent?.name || '';
    const sorted = [...targets].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    // demoPerfLatestRows 의 시나리오 순서(정렬 순위 % 9 — 0 은 iDRAC 만)와 맞춘다: OS 경로가 있는 시나리오 서버에만 시드(디스크 포화 서버가 집중 세션 첫째).
    const pick = sorted.filter((_, i) => i % DEMO_PERF_SCENARIOS.length !== 0).slice(0, 6);
    const existing = await O.changeEventsRange({ key: String(pick[0]?.key || ''), agent, from: now - 30 * DAY, to: now, limit: 1 }).catch(() => null);
    if (!existing || existing.rows.length) return { skipped: 'exists' };
    const items = pick.map((tg, i) => ({ key: tg.key, at: now, facts: null, events: [
      { ts: now - 19 * HOUR - 40 * MIN, kind: 'sysctl', item: 'vm.dirty_ratio', before: '20', after: '10' },
      { ts: now - 19 * HOUR - 40 * MIN, kind: 'sysctl-file', item: '99-gp.conf', before: 'crc 31a7c2e0', after: 'crc 8b02f4d1' },
      { ts: now - 15 * HOUR - 30 * MIN, kind: 'package', item: 'dnf history #214', before: null, after: 'Install · 12개 · 2026-11-05 22:05' },
      { ts: now - 15 * HOUR - 20 * MIN, kind: 'needs-restart', item: '재부팅 필요', before: '불필요', after: '필요' },
      { ts: now - 2 * HOUR - 10 * MIN, kind: 'cron', item: 'pg_dump-adhoc', before: '없음', after: 'crc 5e6d0a11' },
      ...(i % 2 ? [{ ts: now - 5 * DAY, kind: 'firmware', item: 'BIOS', before: '2.13.3', after: '2.14.1' }, { ts: now - 3 * DAY, kind: 'health', item: 'chrony', before: 'ok', after: 'warn' }] : [{ ts: now - 6 * DAY, kind: 'reboot', item: '재부팅', before: '가동 41일', after: '가동 0시간' }]),
    ] }));
    // change_latest 는 실제 수집이 채운다(이벤트만 넣는다 — latest:false).
    await O.changeWriteBatch({ agent, items, latest: false });
    // 지난 집중 세션 2건(앞 대상) — 끝난 세션 · 표본 10분
    for (const [j, tg] of [pick[1], pick[0]].filter(Boolean).entries()) {
      const start = j ? now - 3 * DAY - 2 * HOUR : now - 3 * HOUR;   // 하나는 최근 24시간(보드 칩 목록에 보이게) · 하나는 사흘 전
      const id = `00000000-0000-4000-8000-${String(900_000_000_000 + j).padStart(12, '0')}`;
      const samples = Array.from({ length: 10 }, (_, idx) => ({ sessionId: id, idx, minuteTs: start + idx * MIN, ...demoFocusSample(tg, start + idx * MIN, idx) }));
      const summary = summarizeFocus(samples, { before: { disk_await_ms: { avg: 0.4, max: 2.1, n: 12 }, cpu_pct: { avg: 44, max: 71, n: 12 } }, hasOs: true, hasIdrac: true });
      await O.focusInsert({ id, agent, key: tg.key, vcenterId: tg.vcenterId || '', trigger: j ? 'auto' : 'manual', rule: j ? 'use' : '', by: j ? 'rule' : 'demo.ops', reason: j ? '자동 규칙 ‘use’ — 디스크 포화' : '디스크 포화 판정 뒤 확인(데모)', created: start, start, intervalS: 60, count: 10, status: 'running' });
      for (const sm of samples) await O.focusSampleInsert(sm);
      await O.focusUpdate(id, { status: 'done', end: start + 10 * MIN, done: 10, missOs: 1, missIdrac: 0, summary });
    }
    console.log(`[mock] 베어메탈 성능 데모 시드: 변경 이벤트 ${items.reduce((a, x) => a + x.events.length, 0)}건 · 지난 집중 세션 2건`);
    return { seeded: true };
  })().catch((e) => { _opsSeeded = null; return { error: String(e?.message || e) }; });
  return _opsSeeded;
}

/**
 * v2.923(4단계) — 데모 튜닝 · 용도 사실(가상 · 응답 단계 전용 — 적재하지 않는다). 키 해시로 다섯 모양 중 하나:
 *   Rocky 9.4 × Airflow · Rocky 9.4 × GPDB · Rocky 9.4(기능 없음) · Rocky 8.10 · Ubuntu 22.04. 수치 · 이름은 전부 가상이다.
 */
export const DEMO_TUNING_KINDS = Object.freeze(['rocky-airflow', 'rocky-gpdb', 'rocky-plain', 'rocky8', 'ubuntu']);
export function demoTuningFacts(key, t, cores = 32) {
  const kind = DEMO_TUNING_KINDS[demoHash(`tuning|${key}`) % DEMO_TUNING_KINDS.length];
  const memTotalKb = 256 * 1024 * 1024;
  const rocky = kind.startsWith('rocky');
  const os = kind === 'ubuntu' ? { id: 'ubuntu', versionId: '22.04', prettyName: 'Ubuntu 22.04.4 LTS', pageSize: 4096, selinux: null, removeIpc: null }
    : { id: 'rocky', versionId: kind === 'rocky8' ? '8.10' : '9.4', prettyName: `Rocky Linux ${kind === 'rocky8' ? '8.10 (Green Obsidian)' : '9.4 (Blue Onyx)'}`, pageSize: 4096, selinux: kind === 'rocky-gpdb' ? 'disabled' : 'enforcing', removeIpc: kind === 'rocky-gpdb' ? 'no' : null };
  const gp = kind === 'rocky-gpdb';
  const sysctl = {
    'vm.swappiness': gp ? '10' : '60', 'vm.dirty_ratio': '20', 'vm.dirty_background_ratio': '10', 'vm.min_free_kbytes': gp ? '8053063' : '262144',
    'vm.overcommit_memory': gp ? '2' : '0', 'vm.overcommit_ratio': gp ? '95' : '50', 'vm.zone_reclaim_mode': '0', 'kernel.numa_balancing': '1',
    'net.core.somaxconn': '4096', 'net.core.netdev_max_backlog': gp ? '10000' : '1000', 'net.core.rmem_max': gp ? '16777216' : '212992', 'net.core.wmem_max': gp ? '16777216' : '212992',
    'net.core.rmem_default': gp ? '2097152' : '212992', 'net.core.wmem_default': gp ? '2097152' : '212992',
    'net.ipv4.tcp_rmem': '4096 87380 6291456', 'net.ipv4.tcp_wmem': '4096 16384 4194304', 'net.ipv4.tcp_max_syn_backlog': '4096', 'net.ipv4.tcp_tw_reuse': gp ? '1' : '2',
    'net.ipv4.ip_local_port_range': gp ? '10000 65535' : '32768 60999', 'fs.file-max': '26214400',
    'thp.enabled': gp ? 'never' : 'always', 'thp.defrag': 'madvise',
    'cpu.governor': rocky ? 'performance' : 'powersave', 'cpu.scaling_driver': 'intel_cpufreq',
    ...(rocky ? { 'tuned.active_profile': gp ? 'throughput-performance' : kind === 'rocky8' ? 'balanced' : 'throughput-performance' } : {}),
    'vm.dirty_bytes': gp ? '4294967296' : '0', 'vm.dirty_background_bytes': gp ? '1610612736' : '0',
    'kernel.shmall': gp ? '33554432' : '18446744073692774399', 'kernel.shmmax': gp ? '137438953472' : '18446744073692774399', 'kernel.shmmni': gp ? '32768' : '4096',
    'kernel.sem': gp ? '32000 1048576000 1000 32768' : '32000 1024000000 500 32000', 'kernel.core_pattern': gp ? '/var/core/core.%h.%t' : '|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h',
    'net.core.netdev_budget': '300', 'net.core.netdev_budget_usecs': '2000',
  };
  const units = ['chronyd.service', 'irqbalance.service', 'sshd.service', ...(rocky ? ['tuned.service', 'firewalld.service'] : ['systemd-timesyncd.service']),
    ...(kind === 'rocky-airflow' ? ['airflow-scheduler.service', 'airflow-webserver.service', 'airflow-triggerer.service'] : [])].filter((u) => !(gp && u === 'firewalld.service'));
  const procs = ['sshd', 'chronyd', 'irqbalance', 'node_exporter', ...(kind === 'rocky-airflow' ? ['airflow'] : []), ...(gp ? ['postgres'] : [])];
  const ports = [22, ...(kind === 'rocky-airflow' ? [8080, 8974, 8793] : []), ...(gp ? [5432, 6000, 6001] : [])];
  return {
    v: 1, at: t, sysctl, hugepages: { total: 0, free: 0, sizeKb: 2048 },
    blkq: [{ name: 'nvme0n1', scheduler: 'none', schedulers: ['none', 'mq-deadline'], nrRequests: 1023, rotational: false, readAheadKb: gp ? 8192 : 128 },
      { name: 'sda', scheduler: 'mq-deadline', schedulers: ['none', 'mq-deadline', 'kyber', 'bfq'], nrRequests: 256, rotational: true, readAheadKb: gp ? 8192 : 4096 }],
    blkqTotal: 2,
    irq: { irqbalance: 'active', nicIrqs: 16, spreadMin: 6, spreadMax: 8, cpus: cores },
    os, units: { list: units, failed: kind === 'rocky8' ? 1 : 0, capped: false }, ports: { list: ports, capped: false }, procs: { list: procs, capped: false },
    accounts: [...(kind === 'rocky-airflow' ? ['airflow'] : []), ...(gp ? ['gpadmin'] : [])], kargs: {},
    softnet: { cpus: cores, processed: 81234567, dropped: 0, squeezed: kind === 'rocky8' ? 12 : 0 },
    netq: [{ name: 'eno1', txqlen: 1000, rxq: 8, txq: 8 }, { name: 'eno2', txqlen: 1000, rxq: 8, txq: 8 }],
    xfs: gp ? [{ mount: '/', opts: ['rw', 'relatime', 'attr2', 'inode64', 'noquota'] }, { mount: '/data', opts: ['rw', 'nodev', 'noatime', 'attr2', 'inode64', 'noquota'] }] : [{ mount: '/', opts: ['rw', 'relatime', 'attr2', 'inode64', 'noquota'] }],
    memTotalKb, cores,
    sections: { sysctl: 'ok', hugepages: 'ok', blkq: 'ok', irq: 'ok', osrel: 'ok', units: 'ok', ports: 'ok', procs: 'ok', acct: gp || kind === 'rocky-airflow' ? 'ok' : 'absent', kargs: 'absent', softnet: 'ok', netq: 'ok', xfs: 'ok' },
  };
}
/**
 * 최신값 행 → 데모 대상이면 성능 열을 겹친 사본(조회 응답 전용 — DB 에 쓰지 않는다). mock 이 아니면 입력 그대로.
 * 다섯 지표 열(cpu_pct·mem_pct·disk_busy_pct·disk_used_pct·net_pct·hba_*)은 바꾸지 않는다.
 */
export function demoPerfLatestRows(rows = [], targets = []) {
  if (!isMockMode() || !Array.isArray(rows) || !rows.length) return rows;
  const demoTg = (targets || []).filter(isDemoBmTarget);
  if (!demoTg.length) return rows;
  const byKey = new Map(demoTg.map((tg) => [String(tg.key || ''), tg]));
  const rank = new Map([...byKey.keys()].sort().map((k, i) => [k, i]));
  return rows.map((r) => {
    const k = String(r?.key ?? '');
    const tg = byKey.get(k);
    if (!tg || r?.ts == null) return r;
    const sc = DEMO_PERF_SCENARIOS[rank.get(k) % DEMO_PERF_SCENARIOS.length];
    const o = demoPerfOverlay(tg, r.ts, sc, r);
    return { ...r, ...o, src: o.src || r.src };
  });
}

/** 폴러 결과 모양(`collectOne` 과 같은 {ok, target, built:{row}}). ⚠ 성능 열은 여기 넣지 않는다(적재 경로 — 위 D2). */
export function demoBmUsageResults(targets = [], now = Date.now()) {
  return targets.map((tg) => ({ ok: true, target: tg, demo: true, built: { row: demoBmUsageRow(tg, now), srcOf: { cpu: 'idrac', mem: 'idrac', io: 'idrac', net: 'idrac', hba: 'idrac' }, notes: [] } }));
}

let _bmBackfill = null;
/**
 * 사용률 DB 백필 — 원시 14일(30분) + 그 앞 31일은 하루 4점(일 롤업용). 대상의 첫 키에 이력이 있으면 건너뛴다. 1회.
 * insertUsage 가 원시·일 롤업·최신 표를 같은 트랜잭션으로 채운다.
 */
export async function backfillBmUsage(targets = [], { now = Date.now() } = {}) {
  if (!isMockMode() || !targets.length) return { skipped: 'empty' };
  if (_bmBackfill) return _bmBackfill;
  _bmBackfill = (async () => {
    const db = await import('../../bmusage/db.js');
    const { config } = await import('../../config.js');
    const agent = config.agent?.name || '';   // 폴러(insertUsage(rows, config.agent?.name))와 같은 agent 축 — 다르면 최신값이 두 행이 된다
    try {
      const days = await db.usageDaily({ key: String(targets[0].key), agent, days: 45 });
      if (Array.isArray(days) && days.length >= 5) return { skipped: 'exists' };
    } catch { /* */ }
    const rows = [];
    for (let t = Math.floor((now - 45 * DAY) / HOUR) * HOUR; t < now - 14 * DAY; t += 6 * HOUR) for (const tg of targets) rows.push(demoBmUsageRow(tg, t));
    for (let t = Math.floor((now - 14 * DAY) / (30 * MIN)) * 30 * MIN; t < now - 5 * MIN; t += 30 * MIN) for (const tg of targets) rows.push(demoBmUsageRow(tg, t));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 2_000) {
      const r = await db.insertUsage(rows.slice(i, i + 2_000), agent);
      inserted += r?.inserted || 0;
      await new Promise((res) => setImmediate(res));
    }
    // 8a단계: 마운트 일 롤업 데모(용량 소진 예측 화면 — 증가 · 평탄 · 주기 정리 · 등록 직후 꼴). 같은 쓰기 경로(monthStore.writeMountRows).
    let mounts = 0;
    try { const M = await import('../../bmusage/monthStore.js'); const mr = demoMountRows(targets, now); await M.writeMountRows(mr, agent); mounts = mr.length; } catch { /* 데모 마운트는 없어도 된다 */ }
    console.log(`[mock] 베어메탈 사용률 데모 백필: ${targets.length}대 · ${inserted}행(원시 14일 + 일 롤업 45일) · 마운트 일 ${mounts}행`);
    return { inserted };
  })();
  // v2.929(5단계): 변경 이벤트 · 지난 집중 세션 데모 시드(1회 — 백필과 같은 때).
  _bmBackfill.then(() => seedDemoOps(targets, { now })).catch(() => {});
  return _bmBackfill;
}

/**
 * 8a단계 데모 마운트 일 롤업(순수) — 서버마다 키 해시로 꼴을 고른다: 0 증가(/data — 7일 안 도달) · 1 평탄 · 2 주기 정리(톱니 — 불안정) · 3 등록 직후(4일만 — 데이터 부족) · 4 느린 증가.
 *   inode 는 / 만 값(나머지는 xfs 처럼 값 없음 — ‘상한 없음’).
 */
export function demoMountRows(targets = [], now = Date.now()) {
  const out = [];
  for (const tg of targets) {
    const k = String(tg?.key || ''); if (!k) continue;
    let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const shape = h % 5;
    const days = shape === 3 ? 4 : 30;
    for (let b = days - 1; b >= 0; b -= 1) {
      const ts = now - b * DAY - 2 * HOUR;
      const age = days - 1 - b;
      const data = shape === 0 ? 62 + age * 0.9 + ((h >> 3) % 7) * 0.4 : shape === 1 ? 48 + ((age * 7 + h) % 3) * 0.2 : shape === 2 ? 40 + (age % 6) * 6 + ((h >> 5) % 4) : shape === 3 ? 22 + age * 0.3 : 30 + age * 0.15;
      out.push({ key: k, ts, mount: '/', used_pct: 35 + ((h >> 2) % 10) + age * 0.02, inode_pct: 4 + age * 0.01, size_bytes: 200e9, used_bytes: 80e9 });
      out.push({ key: k, ts, mount: '/data', used_pct: Math.min(99, Math.round(data * 10) / 10), inode_pct: null, size_bytes: 7.3e12, used_bytes: 7.3e12 * Math.min(0.99, data / 100) });
    }
  }
  return out;
}

export function _resetBareMetalDemoForTest() { _resetBareMetalSeedForTest(); _bmBackfill = null; _opsSeeded = null; }
