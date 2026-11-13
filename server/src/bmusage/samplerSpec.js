/**
 * bmusage/samplerSpec.js — 피크 수집 B 안(서버 경량 샘플러)의 **수거 자리**(v2.922 · 3a). 설계 PROFILES §6 끝 · §19(16차 보안).
 *
 * 이번 단계에서 만드는 것: ① 옵트인 설정 키(store.peakSampler — 기본 꺼짐) ② 수거 구획 `##SAMPLER`(파일이 있으면 읽고 없으면 absent)
 *   ③ 파일 형식 명세(아래) ④ 해시 **기록** 자리(store.peakSamplerSha256).
 * ⚠⚠ 정정(v2.922 반증 D13): 머리 줄의 sha256 은 **파일을 쓴 쪽이 스스로 적은 값(자기 신고)** 이다 — 이 모듈은 스크립트를 해시하지 않는다.
 *   그래서 설정값과 비교하는 것은 ‘대조(검증)’ 가 아니라 **기록 일치 확인**이고, 파일을 쓸 수 있는 누구든 같은 값을 적을 수 있다(위조 방지 아님).
 *   예전 주석의 “지금은 어떤 서버에서도 state 가 'ok' 가 될 수 없다” 도 틀렸다 — 관리자가 설정에 해시를 넣으면 같은 머리 줄을 쓴 파일은 ok 가 된다.
 *   스크립트 실물을 해시해 대조하는 것(번들 고정)은 배포 기능과 함께 7단계(16차 보안 설계)다. 화면은 sampler 출처 옆에 ‘자기 신고 해시’ 를 적어야 한다.
 *
 * ── 파일 형식 v1(샘플러가 5분마다 원자적으로 바꿔 쓴다 — 1초 원시는 서버 로컬에 7일, 이 파일은 마지막 5분 요약만) ─────────────
 *   1줄 머리:  `#dvc-bmperf v1 sha256=<스크립트 sha256 64자리> at=<요약 끝 epoch 초> window=<초>`
 *   그 뒤 줄:  `<지표>|<평균>|<최대>|<피크 시각 epoch 초>`  — 지표는 SAMPLER_METRICS 만(모르는 이름은 버린다) · 숫자 아니면 그 줄 버림.
 *   ⚠ 이 파일의 숫자는 **서버가 쓴 것**이다 — 해시가 맞아도 범위(0~100 · 음수 금지)를 다시 본다.
 */
import { numOrNull } from '../util/numOrNull.js';

/** 수거 경로(고정 상수 — 명령에 외부 입력이 들어가지 않는다). */
export const SAMPLER_FILE = '/var/lib/dvc-bmperf/peak5m.v1';
export const SAMPLER_MAX_LINES = 64;
/** 샘플러가 낼 수 있는 지표(서버 피크 열 이름과 같다). */
export const SAMPLER_METRICS = Object.freeze(['cpu_pct', 'cpu_iowait_pct', 'disk_busy_pct', 'disk_iops', 'disk_await_ms', 'disk_aqu', 'net_pct', 'net_bps']);
const PCT = new Set(['cpu_pct', 'cpu_iowait_pct', 'disk_busy_pct', 'net_pct']);

/** 수거 명령 조각 — 옵트인일 때만 linuxCommand 에 붙는다. 파일이 없으면 0줄(= absent). */
export function samplerCommand() {
  return `if [ -r ${SAMPLER_FILE} ]; then head -n ${SAMPLER_MAX_LINES} ${SAMPLER_FILE} | cut -c1-256; fi`;
}

/**
 * 구획 줄 → 상태(순수). state: absent(파일 없음) | bad(형식 오류) | unverified(기대 해시 없음·불일치) | stale(요약이 오래됨) | ok.
 * @param {string[]|null} lines   ##SAMPLER 구획 줄(null = 구획 미도착 → missing)
 * @param {{expectedSha?:string, now?:number, maxAgeMs?:number}} opt
 */
export function parseSamplerFile(lines, { expectedSha = '', now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  if (!Array.isArray(lines)) return { state: 'missing', metrics: null };
  const ls = lines.map((l) => String(l).trim()).filter(Boolean);
  if (!ls.length) return { state: 'absent', metrics: null };
  const h = /^#dvc-bmperf v1 sha256=([0-9a-f]{64}) at=(\d{9,11}) window=(\d{1,5})$/.exec(ls[0]);
  if (!h) return { state: 'bad', metrics: null, reason: '머리 줄 형식이 다릅니다' };
  const metrics = {};
  for (const l of ls.slice(1)) {
    const f = l.split('|');
    if (f.length !== 4 || !SAMPLER_METRICS.includes(f[0])) continue;
    const avg = numOrNull(f[1]); const max = numOrNull(f[2]); const at = numOrNull(f[3]);
    if (avg == null || max == null || at == null || avg < 0 || max < 0 || (PCT.has(f[0]) && (avg > 100 || max > 100))) continue;
    metrics[f[0]] = { avg, peak: max, at: at * 1000 };
  }
  const at = Number(h[2]) * 1000;
  // v2.922(반증 D13): 원격 시계가 쓴 요약 끝 시각 — 미래(5분 넘게)면 형식 오류로 본다(오래됨 판정을 피해 가지 못하게).
  if (at > now + 5 * 60_000) return { state: 'bad', metrics: null, reason: '요약 시각이 미래입니다(원격 시계 확인 필요)' };
  const base = { sha256: h[1], at, windowS: Number(h[3]), metrics, shaSelfReported: true };
  if (!expectedSha || expectedSha !== h[1]) return { ...base, state: 'unverified', reason: expectedSha ? '파일이 적은 해시가 설정값과 다릅니다(자기 신고 값 — 위조 방지 아님)' : '설정에 해시가 없습니다(스크립트 실물 대조·배포는 7단계)' };
  if (now - at > maxAgeMs) return { ...base, state: 'stale' };
  return { ...base, state: 'ok' };
}
