/**
 * iDRAC 센서 시계열(인메모리 링버퍼) — 온도센서·CPU 사용량을 1분마다 적재해
 * 차트로 보여준다. 서버당 최근 N개 샘플만 유지(메모리 보호). 영속화하지 않는다
 * (재시작 시 비고, 전력처럼 장기 보존이 필요하면 별도 DB로 확장).
 *
 * 샘플 형태: { t, cpu, temps: { [sensorName]: celsius }, fans: { [fanName]: rpm } }
 */

const MAX_SAMPLES = Number(process.env.IDRAC_SENSOR_SAMPLES) || 1440; // 1분 간격 × 1440 = 24시간
const MAX_SENSORS = 64; // 서버당 추적할 온도센서 상한

const byServer = new Map(); // serverId -> { samples: [...], sensors: Set<string> }

export function pushSensorSample(serverId, { t, cpuUsagePct, temps, fans }) {
  if (!serverId) return;
  let s = byServer.get(serverId);
  if (!s) { s = { samples: [], sensors: new Set(), fans: new Set() }; byServer.set(serverId, s); }
  const tempMap = {};
  for (const x of (temps || []).slice(0, MAX_SENSORS)) {
    if (!x || !x.name || typeof x.celsius !== 'number') continue;
    tempMap[x.name] = x.celsius;
    s.sensors.add(x.name);
  }
  const fanMap = {};
  for (const x of (fans || []).slice(0, MAX_SENSORS)) {
    if (!x || !x.name || typeof x.rpm !== 'number') continue;
    fanMap[x.name] = x.rpm;
    s.fans.add(x.name);
  }
  s.samples.push({ t: t || Date.now(), cpu: typeof cpuUsagePct === 'number' ? cpuUsagePct : null, temps: tempMap, fans: fanMap });
  if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);
}

/** 차트용 시계열 반환. minutes로 최근 구간만 자른다(기본 전체 보유분). */
export function getSensorSeries(serverId, { minutes = 0 } = {}) {
  const s = byServer.get(serverId);
  if (!s) return { sensors: [], samples: [], latest: null };
  let samples = s.samples;
  if (minutes > 0) {
    const cutoff = Date.now() - minutes * 60_000;
    samples = samples.filter((x) => x.t >= cutoff);
  }
  // latest/sensors는 '반환하는 samples' 기준으로 뽑는다 — minutes 필터로 최근 구간이 비었는데
  // 오래된 전체 보유 샘플에서 latest를 뽑아 '빈 그래프 + 센서 라벨'만 나오던 불일치 방지.
  const latest = samples[samples.length - 1] || null;
  // 센서 이름은 최신 샘플 기준(정렬해 안정적 순서).
  const sensors = latest ? Object.keys(latest.temps).sort() : [...s.sensors].sort();
  const fanNames = latest ? Object.keys(latest.fans || {}).sort() : [...(s.fans || [])].sort();
  return { sensors, fanNames, samples, latest, count: s.samples.length };
}

export function clearSensorSeries(serverId) { byServer.delete(serverId); }

/**
 * 위임(엣지 등록) 서버의 최신 센서를 **로컬 시계열과 같은 모양**으로 변환한다(v2.493).
 *
 * 왜 필요한가: 위임 법인 서버는 엣지가 자기 메모리 시계열에서 최신값만 뽑아 export 에 실어
 * 보낸다(`collector/agent.js compactSensors` → `{ t, temps }`). 중앙은 그 값으로 '법인별 온도'
 * 화면을 정상적으로 그린다(`routes/admin/idracCore.js` /idrac/temps). 그런데 iDRAC 상세 모달의
 * 센서 탭은 위임 서버에 **하드코딩된 빈 응답**(latest:null)을 돌려주고 있었다 — 그래서 같은
 * 서버가 법인별 온도에서는 52℃ 로 보이는데 상세 모달에서는 '온도 센서 0개 · 최근 0샘플 ·
 * CPU 텔레메트리 미지원' 으로 보였다(2026-09-12 사용자 신고). 수집이 멈춘 것처럼 오해된다.
 *
 * 중앙에는 **시계열이 없고 최신 스냅샷만** 있으므로 samples 는 빈 배열로 두고
 * `seriesAvailable:false` 로 그 사실을 명시한다 — 없는 이력을 1점 차트로 지어내지 않는다.
 * CPU 사용량은 엣지가 보내지 않으므로 null 이며, '미지원' 이 아니라 '미동기화' 다(구분 필요).
 */
export function remoteSensorView(rs) {
  const temps = rs && rs.sensors && rs.sensors.temps && typeof rs.sensors.temps === 'object' ? rs.sensors.temps : null;
  const names = temps ? Object.keys(temps).filter((k) => typeof temps[k] === 'number').sort() : [];
  if (!names.length) {
    // 엣지가 아직 센서를 못 보냈다(엣지 재시작 직후·엣지에서도 센서 조회 실패).
    return { remote: true, seriesAvailable: false, latest: null, sensors: [], fanNames: [], samples: [], count: 0, syncedAt: null, cpuSynced: false };
  }
  const clean = {};
  for (const n of names) clean[n] = temps[n];
  const t = Number(rs.sensors.t) || null;
  return {
    remote: true,
    seriesAvailable: false,       // 중앙에 이력이 없다(엣지에만 있음)
    // v2.660: 2.660+ 엣지는 CPU 사용량(텔레메트리)을 함께 보낸다 — 없으면 예전처럼 미동기화.
    cpuSynced: typeof rs.sensors.cpu === 'number',
    latest: { t, cpu: typeof rs.sensors.cpu === 'number' ? rs.sensors.cpu : null, temps: clean, fans: {} },
    sensors: names,
    fanNames: [],
    samples: [],
    count: 0,
    syncedAt: t,
  };
}

/*
 * v2.634 — 폴 주기 정보(신선도 판정용). 2026-09-28 사용자 신고: 법인 전산실 운영 온도가 '측정 서버 0/980 ·
 * 미갱신 975' 로 통째로 비었다. 표본 시각이 주기 시작 시각이었고(poller.js — 이 릴리스에 '실제로 읽은 시각' 으로
 * 고쳤다), 신선도 경계(15분)가 **한 주기가 얼마나 걸리는지를 모른 채** 고정돼 있었다. 대상이 많거나 불통
 * iDRAC 이 많아 한 주기가 15분을 넘으면, 표본을 읽은 시각으로 찍어도 다음 표본까지의 간격이 15분을 넘어
 * 정상 서버가 '미갱신' 으로 빠진다. 그래서 폴러가 주기 소요를 여기에 남기고 판정 쪽이 경계를 넓힌다.
 * 이 모듈은 leaf 다(import 0) — 판정 모듈(roomTemp 등)이 폴러를 import 하지 않게 여기에 둔다.
 */
let _cycle = { durationMs: null, intervalMs: null, at: null, runningSince: null };

/** 폴러가 주기 시작을 알린다. */
export function markSensorPollStart(at = Date.now()) { _cycle = { ..._cycle, runningSince: at }; }

/** 폴러가 주기 종료를 알린다. */
export function setSensorPollCycle({ durationMs, intervalMs, at = Date.now() } = {}) {
  const d = Number(durationMs); const i = Number(intervalMs);
  _cycle = {
    durationMs: Number.isFinite(d) && d >= 0 ? d : null,
    intervalMs: Number.isFinite(i) && i > 0 ? i : null,
    at,
    runningSince: null,
  };
}

/**
 * 판정에 쓸 주기 정보 — `durationMs` 는 직전 주기 소요와 **지금 도는 주기의 경과** 중 큰 값이다
 * (지금 주기가 더 오래 걸리고 있으면 그만큼 표본이 늦게 온다). 폴러가 한 번도 돌지 않았으면 null.
 */
export function sensorPollCycle(now = Date.now()) {
  const running = _cycle.runningSince != null ? Math.max(0, now - _cycle.runningSince) : null;
  const d = [_cycle.durationMs, running].filter((x) => x != null);
  if (!d.length && _cycle.intervalMs == null) return null;
  return { durationMs: d.length ? Math.max(...d) : null, intervalMs: _cycle.intervalMs, lastDurationMs: _cycle.durationMs, runningForMs: running };
}

export function _resetSensorPollCycleForTest() { _cycle = { durationMs: null, intervalMs: null, at: null, runningSince: null }; }
