/**
 * sanSwitchPorts.js — SAN 스위치 화면의 순수 판정 로직(v2.410).
 *
 * 웹 테스트가 node 환경(DOM 없음)이라 렌더는 검증할 수 없다. 그래서 **틀리면 운영자가 잘못된
 * 판단을 하게 되는 규칙**(광레벨 임계·에러 등급·포트 여유 판정)을 여기 순수 함수로 두고
 * 회귀로 고정한다(storageColumns.js·accessDeniedText.js 와 같은 패턴).
 */

/** 포트 상태 → 화면 표시(라벨·색). summarizePorts 의 분류와 1:1. */
export const STATE_LABEL = {
  online: { label: '사용중', tone: 'ok' },
  offline: { label: '비어있음', tone: 'muted' },
  disabled: { label: '비활성', tone: 'warn' },
  faulty: { label: '장애', tone: 'bad' },
  noLicense: { label: '라이선스 없음', tone: 'muted' },
  unknown: { label: '알수없음', tone: 'muted' },
};
export const stateLabel = (s) => STATE_LABEL[s]?.label || s || '—';
export const stateTone = (s) => STATE_LABEL[s]?.tone || 'muted';

/**
 * 광레벨(dBm) 건전성.
 *
 * 임계 근거: FC SFP(단파 850nm)의 일반적인 수신 감도는 대략 -10 ~ -14 dBm 이고, 벤더
 * 권장 운용 하한은 보통 -9 dBm 안팎이다. 값이 그 아래로 내려가면 CRC 에러가 따라 오르는
 * 것이 현장에서 흔한 패턴이라 **경고(-9) / 위험(-12)** 두 단계로 나눈다.
 * ⚠ 정직 표기: 정확한 임계는 SFP 모델·거리·케이블에 따라 다르다. 여기 값은 **일반 기준**이며
 *   장비 벤더 사양을 대체하지 않는다(화면 툴팁에도 그렇게 적는다).
 * 송신(Tx)이 -3 dBm 이하로 크게 떨어지면 SFP 노후/고장 신호로 본다.
 */
export const RX_WARN_DBM = -9;
export const RX_BAD_DBM = -12;

/**
 * 숫자 변환 — **null/undefined/빈 문자열은 null 로 남긴다**.
 * ⚠ `Number(null)` 은 0 이고 0 은 유한값이라, `Number.isFinite(Number(v))` 로 거르면
 *   '미수집'이 '0 dBm'(=완벽한 광레벨)으로 둔갑한다. 실제로 이 함수의 첫 구현이 그랬고
 *   회귀 테스트가 잡았다 — 미수집을 정상으로 칠하는 것은 이 화면에서 가장 위험한 오류다.
 */
export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function opticalHealth(rxDbm, txDbm) {
  const rx = numOrNull(rxDbm);
  const tx = numOrNull(txDbm);
  if (rx == null && tx == null) return { level: 'none', why: '' };
  if (rx != null && rx <= RX_BAD_DBM) return { level: 'bad', why: `수신 ${rx} dBm — 일반 하한(${RX_BAD_DBM})보다 낮습니다. 케이블·SFP·접점을 점검하세요.` };
  if (rx != null && rx <= RX_WARN_DBM) return { level: 'warn', why: `수신 ${rx} dBm — 일반 권장 하한(${RX_WARN_DBM})에 근접합니다.` };
  if (tx != null && tx <= -7) return { level: 'warn', why: `송신 ${tx} dBm — SFP 출력이 낮습니다(노후 의심).` };
  return { level: 'ok', why: '' };
}

/**
 * 에러 카운터 등급. **누적값**이라 '값이 크다 = 지금 나쁘다'가 아니다(스위치를 껐다 켠 적이
 * 없으면 몇 년치가 쌓여 있다). 그래서 등급은 '0인가 / 있는가'를 먼저 보고, 규모로 강조만 한다.
 * 화면 툴팁에 '누적값이며 마지막 초기화 이후 합계'임을 반드시 적는다 — 안 그러면 오래된
 * 카운터를 현재 장애로 오해한다.
 */
export function errorLevel(port) {
  const crc = Number(port?.errCrc) || 0;
  const linkFail = Number(port?.errLinkFail) || 0;
  const lossSync = Number(port?.errLossSync) || 0;
  const encOut = Number(port?.errEncOut) || 0;
  const total = crc + linkFail + lossSync;
  if (total === 0 && encOut === 0) return { level: 'ok', total: 0 };
  if (crc >= 1000 || linkFail >= 100) return { level: 'bad', total };
  if (total > 0) return { level: 'warn', total };
  return { level: 'info', total };
}

/** 포트 사용률 → 색 등급. 여유 포트가 적을수록 증설 판단이 급해진다. */
export function capacityLevel(usedPct) {
  const p = Number(usedPct) || 0;
  if (p >= 90) return 'bad';
  if (p >= 75) return 'warn';
  return 'ok';
}

/** 여러 스위치 합산(법인 카드·상단 KPI). 실패 스냅샷은 포트 합계에서 제외한다. */
export function aggregate(rows = []) {
  const a = { switches: 0, ok: 0, failed: 0, total: 0, licensed: 0, online: 0, free: 0,
    faulty: 0, disabled: 0, alerts: 0, usedPct: 0 };
  for (const r of rows) {
    a.switches++;
    const s = r.snap;
    if (!s || !s.ok) { a.failed++; continue; }
    a.ok++;
    const p = s.ports || {};
    a.total += p.total || 0;
    a.licensed += p.licensed || 0;
    a.online += p.online || 0;
    a.free += p.free || 0;
    a.faulty += p.faulty || 0;
    a.disabled += p.disabled || 0;
    a.alerts += s.health?.alerts || 0;
  }
  a.usedPct = a.licensed ? Math.round((a.online / a.licensed) * 1000) / 10 : 0;
  return a;
}

/** 처리량 표기 — REST 는 bps, SSH 는 프레임/초. 단위를 섞어 보여주지 않는다. */
export function throughputText(port, unit) {
  if (unit === 'bps') {
    if (numOrNull(port?.inBps) == null && numOrNull(port?.outBps) == null) return '—';
    return `${bps(port.inBps)} / ${bps(port.outBps)}`;
  }
  if (numOrNull(port?.inFps) == null && numOrNull(port?.outFps) == null) return '—';
  return `${num(port.inFps)} / ${num(port.outFps)} f/s`;
}
const num = (n) => (numOrNull(n) == null ? '—' : Number(n).toLocaleString());
export function bps(v) {
  const n = numOrNull(v);   // null/'' 을 0 으로 보지 않는다(위 numOrNull 머리말 참조)
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Gbps`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mbps`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} Kbps`;
  return `${n} bps`;
}

/** 포트 목록 필터(순수) — 화면의 '문제만 보기'가 무엇을 남기는지 한 곳에서 정의. */
export function filterPorts(list = [], mode = 'all') {
  if (mode === 'online') return list.filter((p) => p.state === 'online');
  if (mode === 'free') return list.filter((p) => p.state === 'offline');
  if (mode === 'problem') {
    return list.filter((p) => p.state === 'faulty' || p.state === 'disabled'
      || errorLevel(p).level === 'bad' || errorLevel(p).level === 'warn'
      || ['warn', 'bad'].includes(opticalHealth(p.rxPowerDbm, p.txPowerDbm).level));
  }
  return list;
}
