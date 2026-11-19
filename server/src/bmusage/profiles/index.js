/**
 * bmusage/profiles/index.js — 용도 프로파일 **등록부**(v2.923 예정 · 리눅스 성능 4단계 · 설계 PROFILES §1).
 *
 * 프로파일 1개 = 파일 1개(`rocky9-base.js` · `airflow.js` · `gpdb.js`). 새 프로파일은 **파일 하나 + 이 목록 한 줄 + 카탈로그 테스트**
 * (매칭 규칙 · 모든 점검·튜닝 항목의 출처 id · 근거 등급이 비면 실패 — `server/test/bmPerf2923Profiles.test.js`).
 * ⚠ 이번 활성은 셋뿐이다. ubuntu-base · windows-base · hadoop 은 **만들지 않았다**(설계 §1 ‘예정’) — 매트릭스에 ‘프로파일 없음’ 으로 보이고 점검하지 않는다.
 *   감지 규칙도 만들지 않았다(틀린 판정보다 낫다 — 없는 프로파일을 지어내지 않는다).
 */
import rocky9Base from './rocky9-base.js';
import airflow from './airflow.js';
import gpdb from './gpdb.js';

export const PROFILES = Object.freeze([rocky9Base, airflow, gpdb]);
/** 기능 프로파일끼리 같은 튜닝 키를 덮을 때의 순서(앞이 이긴다 — 충돌은 응답이 밝힌다). */
export const APP_PRIORITY = Object.freeze(['gpdb', 'airflow']);
/** 설계가 ‘예정’ 으로만 적은 것(구현 없음 · 감지 규칙 없음). */
export const PLANNED_PROFILES = Object.freeze([
  { id: 'ubuntu-base', kind: 'os' },
  { id: 'windows-base', kind: 'os' },
  { id: 'hadoop', kind: 'app' },
]);

/** 점검 결과 code(서버) — 웹 문구 표와 1:1(테스트 대조). ‘미수집’ 은 이 단계가 실행하지 않는 점검이다(정상으로 세지 않는다). */
export const CHECK_STATUS = Object.freeze(['ok', 'warn', 'bad', 'unknown', 'notCollected', 'info']);
export const CHECK_REASON = Object.freeze([
  'notRead', 'cmdNotRun', 'linkOnly', 'tunedNone', 'listCapped', 'notRunning', 'httpNotRun', 'secretConfig', 'appConfigNotRead',
  'metricsNoReceiver', 'noUnit', 'defaultOff', 'sqlNotRun', 'manualOnly',
]);
/** 서버 · 프로파일 상태(서버) — none = 맞는 프로파일이 하나도 없다(‘프로파일 없음’ — 점검하지 않음). */
export const PROFILE_STATUS = Object.freeze(['ok', 'warn', 'bad', 'unknown', 'none']);
export const OS_PROFILES = Object.freeze(PROFILES.filter((p) => p.kind === 'os'));
export const APP_PROFILES = Object.freeze(PROFILES.filter((p) => p.kind === 'app'));
export const APP_IDS = Object.freeze(APP_PROFILES.map((p) => p.id));

/**
 * 엣지 봉투에 싣는 감지 목록의 **관찰 대상**(v2.923) — 봉투는 서버 1,000대 · 8MB 상한이라 프로세스 이름 512 · 유닛 256 원목록을 그대로 실으면
 *   상한을 넘겨 **전 서버의 성능 상세(USE 근거)까지 빠진다**(edgePull fitEnvelope). 그래서 봉투에는 프로파일 · 튜닝 카탈로그가 실제로 보는 이름 · 포트만 남긴다.
 *   ⚠ 프로파일이 새 이름 · 포트를 보게 되면 **여기에도** 더할 것 — 테스트가 ‘원목록 감지 = 줄인 목록 감지’ 를 프로파일마다 대조한다.
 *   엣지 자신의 화면(이 노드 최신값)은 원목록을 그대로 쓴다.
 */
export const ENVELOPE_WATCH = Object.freeze({
  unit: /^(airflow[A-Za-z0-9@._-]{0,80}|numad|firewalld|chronyd|ntpd)\.service$/,
  procs: Object.freeze(['airflow', 'postgres']),
  port: (p) => p === 5432 || p === 8974 || p === 8793 || p === 8080 || (p >= 6000 && p <= 6999),
});
/** 봉투용 튜닝 사실 — 감지 목록만 관찰 대상으로 줄인다(나머지 필드 그대로). 줄였다는 사실은 `filtered`. */
export function compactTuningForEnvelope(tu) {
  if (!tu || typeof tu !== 'object') return tu;
  const out = { ...tu };
  if (tu.units && Array.isArray(tu.units.list)) out.units = { ...tu.units, list: tu.units.list.filter((u) => ENVELOPE_WATCH.unit.test(u)), filtered: true };
  if (tu.procs && Array.isArray(tu.procs.list)) out.procs = { ...tu.procs, list: tu.procs.list.filter((x) => ENVELOPE_WATCH.procs.includes(x)), filtered: true };
  if (tu.ports && Array.isArray(tu.ports.list)) out.ports = { ...tu.ports, list: tu.ports.list.filter((x) => ENVELOPE_WATCH.port(x)), filtered: true };
  return out;
}

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));
export function profileById(id) { return BY_ID.get(String(id || '')) || null; }

/** 카탈로그(화면 ⑥ ‘프로파일 카탈로그’ — 함수는 빼고 사실만). */
export function catalogView() {
  return [
    ...PROFILES.map((p) => ({
      id: p.id, kind: p.kind, title: p.title, matchText: p.matchText, status: 'active',
      checks: p.checks.length, tunings: p.tunings.length, sources: p.sources,
      grades: [...new Set([...p.checks, ...p.tunings].map((x) => x.grade))],
      ...(p.kind === 'os' ? { inheritsTuning: true } : {}),
    })),
    ...PLANNED_PROFILES.map((p) => ({ id: p.id, kind: p.kind, status: 'planned' })),
  ];
}
