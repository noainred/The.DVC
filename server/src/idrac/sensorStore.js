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
  const latest = s.samples[s.samples.length - 1] || null;
  // 센서 이름은 최신 샘플 기준(정렬해 안정적 순서).
  const sensors = latest ? Object.keys(latest.temps).sort() : [...s.sensors].sort();
  const fanNames = latest ? Object.keys(latest.fans || {}).sort() : [...(s.fans || [])].sort();
  return { sensors, fanNames, samples, latest, count: s.samples.length };
}

export function clearSensorSeries(serverId) { byServer.delete(serverId); }
