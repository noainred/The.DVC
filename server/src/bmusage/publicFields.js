/**
 * bmusage/publicFields.js — 베어메탈 사용률 **공개 대상 · 최신값 행의 필드 표**(다음 작업 ⑤ 2026-11-19 · 순수 · import 는 perfCols.js 하나).
 *
 * 왜: 엣지 봉투(`bmusage/edgePull.js` — targets 는 `targets.publicTarget()` 출력 · rows 는 `usage_latest` 행에서 JSON 열을 뗀 것)를 중앙이
 *   예전에는 **칸 수 상한만 둔 얕은 복사**(shallow)로 받았다 — 가짜 엣지가 대상에 넣은 ‘password’ · osHost 객체가 관리자 응답에 그대로 실렸다(10회차 의심 3 재현).
 *   루트 CLAUDE.md ‘엣지가 보낸 것은 정제한다: 아는 필드만 · 객체만 · 상한 · 문자열 수치는 수로’.
 * 규칙:
 *   · 엣지 export 와 중앙 정제(`central/bmUsageEdgePull.js sanitizeBmUsageSnap`)가 **이 표 하나**를 쓴다.
 *   · 대상에 새 필드를 더하면 여기에도 넣는다 — 시험(server/test/bmUsageNextGb.test.js)이 실제 `resolveTargets` → `publicTarget` 출력 ·
 *     `targets.push({…})` 소스 · 데모 표시 표지와 대조한다(빠지면 중앙이 조용히 버리므로 시험이 실패한다).
 *   · 행 열은 `usage_latest`(bmusage/db.js 의 CREATE TABLE + PERF_TABLE_COLS)에서 JSON 열을 뺀 것과 **같아야** 한다(시험이 PRAGMA 로 대조).
 * 꼴(값):
 *   'str' 글자(숫자 · 불리언은 글자로 · 객체는 '') · 'strOrNull'(null = 그 경로가 없다 · '' = 가렸다 — maskTargetAddress) · 'num'(문자열 수치 → 수 · 못 읽으면 null) ·
 *   'bool'(true 만 참) · 'boolOrNull' · 'strList' · 'pathList'('idrac' · 'os' 만) · 객체(같은 꼴 표 — 한 단계씩).
 */
import { PERF_COL_NAMES, PEAK_SQL_COLS, PEAK_META_COLS } from './perfCols.js';

const LICENSE_SPEC = Object.freeze({ tier: 'str', label: 'str', matched: 'str', source: 'str', names: 'strList', count: 'num', expired: 'num', evaluation: 'bool', at: 'num' });
/** bmusage/hbaBasis.js recordHbaBasis 가 남기는 모양(summarizeHbaBasis 개수 + 출처 · 대표값 · 시각 · OS 쪽 사실). */
const HBA_BASIS_SPEC = Object.freeze({
  ports: 'num', dataRate: 'num', nominal: 'num', noSpeed: 'num', clamped: 'num', blanked: 'num', nominalOver: 'num', unread: 'num',
  src: 'str', rep: 'str', at: 'num', clampMaxPct: 'num', overBlank: 'bool',
  osFallback: Object.freeze({ ports: 'num', nominalOver: 'num', noSpeed: 'num', unread: 'num' }),
});

/** 공개 대상 필드(publicTarget 출력 = 주 조회 응답 · 엣지 봉투 targets). */
export const PUBLIC_TARGET_SPEC = Object.freeze({
  // targets.js idOf
  serverId: 'str', fleetId: 'str', name: 'str', serviceTag: 'str', key: 'str', keyKind: 'str',
  // targets.js targets.push(베어메탈 · 가상화 호스트)
  vcenterId: 'str', vcName: 'str', model: 'str', role: 'str', paths: 'pathList', license: LICENSE_SPEC, entAllowed: 'bool', missing: 'strList',
  // publicTarget 이 비밀을 빼고 더하는 칸
  idracHost: 'strOrNull', osHostName: 'strOrNull', osMounts: 'num', osAuthUnresolved: 'boolOrNull', hbaBasis: HBA_BASIS_SPEC,
  // 다음 작업 ④: 데모(mock) 표시 경로 표지(mock/demo/baremetal.js demoDisplayOf — 실운영 대상에는 없다)
  demoOs: 'bool', pathsShown: 'pathList', missingShown: 'strList',
});
/** publicTarget 이 빼는 내부 칸(자격증명 · 누락 점검 전용) — 봉투 · 응답에 실리면 안 된다. */
export const TARGET_PRIVATE_FIELDS = Object.freeze(['idrac', 'osHost', 'osRegId']);

/** usage_latest 의 처음 열(CREATE TABLE — bmusage/db.js). */
const LATEST_BASE_SPEC = Object.freeze({
  agent: 'str', key: 'str', ts: 'ts', name: 'str', vcenter_id: 'str', src: 'str',
  cpu_pct: 'num', mem_pct: 'num', disk_busy_pct: 'num', disk_used_pct: 'num', net_pct: 'num', net_bps: 'num', hba_pct: 'num', hba_bps: 'num', io_pct: 'num',
});
/**
 * 최신값 행 열(엣지 봉투 rows — JSON 열 detail_json · tuning_json 은 봉투가 떼고 중앙도 받지 않는다).
 *   'ts' 는 엣지 시각(수신 시각으로 자르고 원본은 atRaw) · 'peakAt' 은 피크 시각(같은 규칙 · 원본은 peakAtRaw) · 'peakSrc' · 'srcCm' 은 아는 꼴만.
 */
export const LATEST_ROW_SPEC = Object.freeze({
  ...LATEST_BASE_SPEC,
  ...Object.fromEntries(PERF_COL_NAMES.map((c) => [c, 'num'])),
  os_at: 'ts', idrac_at: 'ts',
  ...Object.fromEntries(PEAK_SQL_COLS.map(([c]) => [c, c.endsWith('_peak_at') ? 'peakAt' : 'num'])),
  ...Object.fromEntries(PEAK_META_COLS.map(([c]) => [c, c === 'peak_src' ? 'peakSrc' : 'num'])),
  dev_over: 'num', src_cm: 'srcCm',
});
export const LATEST_ROW_JSON_COLS = Object.freeze(['detail_json', 'tuning_json']);
