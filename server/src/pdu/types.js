/**
 * pdu/types.js — PDU 수집 공통 스키마(순수).
 *
 * 한 '등록 장비' = NMC 한 대(호스트 하나). 그 아래에:
 *  - devices[]  : 데이지체인된 PDU 본체 1~4대 (rpdu2g 최대 4대) — 각각 전력/에너지/역률
 *  - sensors[]  : 환경 센서 1~N — 각각 온도(℃), 습도(%RH)
 *  - banks[]    : PDU 본체별 뱅크 부하(A)
 *  - phases[]   : PDU 본체별 상(phase) 전류/전압
 *
 * 자동 탐지: 인덱스를 1부터 올려가며 조회해 `E1xx`(Parameter Error)가 나오면 거기서 멈춘다.
 * 실측 근거 — 센서 1개짜리 장비에서 `tempReading 2:C` 가 `E102 Parameter Error` 였다.
 */

/** 자동 탐지 상한(rpdu2g 데이지체인 최대 4대 + 여유). 무한 탐색을 막는다. */
export const MAX_PDU_UNITS = 4;
export const MAX_SENSORS = 8;
export const MAX_BANKS = 12;
export const MAX_PHASES = 3;

export function emptySnapshot(device) {
  return {
    id: device?.id || '',
    name: device?.name || device?.host || '',
    host: device?.host || '',
    datacenterId: device?.datacenterId || '',
    agent: '',                 // 수집 주체(엣지 이름). 중앙 직접이면 ''
    collectedAt: Date.now(),
    ok: false,
    error: '',
    model: '', serial: '', nmcModel: '', aosVersion: '', appVersion: '',
    units: [],                 // [{ index, powerW, energyKwh, appPowerW, pf, banks:[], phases:[] }]
    sensors: [],               // [{ index, name, tempC, humidityPct }]
    totals: { powerW: null, energyKwh: null, units: 0, sensors: 0 },
    // 수집 실패 항목을 '오류'가 아니라 '해당 없음'으로 남긴다(센서 없는 PDU도 정상 등록).
    notes: [],
  };
}

/** 스냅샷 요약(목록/카드용). 값이 없으면 null 을 유지한다(0 으로 채우지 않는다). */
export function summarize(snap) {
  const units = snap.units || [];
  const sensors = snap.sensors || [];
  const powerVals = units.map((u) => u.powerW).filter((v) => v != null);
  const energyVals = units.map((u) => u.energyKwh).filter((v) => v != null);
  const tempVals = sensors.map((s) => s.tempC).filter((v) => v != null);
  const humVals = sensors.map((s) => s.humidityPct).filter((v) => v != null);
  return {
    units: units.length,
    sensors: sensors.length,
    powerW: powerVals.length ? powerVals.reduce((a, b) => a + b, 0) : null,
    energyKwh: energyVals.length ? Math.round(energyVals.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    tempMaxC: tempVals.length ? Math.max(...tempVals) : null,
    tempAvgC: tempVals.length ? Math.round((tempVals.reduce((a, b) => a + b, 0) / tempVals.length) * 10) / 10 : null,
    humidityAvgPct: humVals.length ? Math.round(humVals.reduce((a, b) => a + b, 0) / humVals.length) : null,
  };
}
