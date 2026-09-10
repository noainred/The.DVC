// 설정 문서(docs/ENV.md · docs/CONFIG-FILES.md · docs/SETTINGS.md) 회귀 고정 — v2.452.
//
// 배경: 두 생성 스크립트가 **코드를 정규식으로 훑어** 문서를 만든다. 정규식이 못 잡는 형태가
// 생기면 문서에서 항목이 조용히 사라지는데, 생성 자체는 성공하므로 CI 의 `--check` 도 통과한다.
// 실제로 v2.448~2.450 은 다음을 통째로 빠뜨린 채 "최신"이었다:
//   · 환경변수 28개 — `const env = process.env` 별칭을 쓰는 rma/agent.js(25개)와
//     `policyFromEnv(env = process.env)` 를 쓰는 metrics/deadband.js(3개).
//     그중 RMA_ALLOW_SSH·RMA_ALLOW_CUSTOM·RMA_FILE_ROOTS 는 **엣지에서만 켤 수 있는 보안 옵트인**이라
//     문서에 없으면 운영자가 존재조차 알 수 없다.
//   · 설정 파일 4개 — `dbFile('x.db')` 헬퍼로 만드는 DB. 하필 **가장 큰 두 개**(host-temp.db 34.3GB ·
//     idrac-power.db 26.9GB)가 여기 있었다. 백업·용량 판단용 문서에서 제일 큰 파일이 빠진 셈이다.
//
// 아래 테스트는 '문서가 최신인가'가 아니라 **'스캐너가 이 형태들을 여전히 잡는가'** 를 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const DOCS = path.resolve(HERE, '../../docs');
const WEB = path.resolve(HERE, '../../web/src');
const read = (p) => fs.readFileSync(p, 'utf8');

const ENV_MD = read(path.join(DOCS, 'ENV.md'));
const CFG_MD = read(path.join(DOCS, 'CONFIG-FILES.md'));
const SET_MD = read(path.join(DOCS, 'SETTINGS.md'));

test('ENV.md — `process.env` 별칭(`const env = process.env`)으로 읽는 키가 빠지지 않는다', () => {
  // rma/agent.js 는 모듈 최상단에서 `const env = process.env;` 로 받아 `env.KEY` 로만 쓴다.
  const agent = read(path.join(SRC, 'rma/agent.js'));
  const used = new Set([...agent.matchAll(/\benv\.([A-Z][A-Z_0-9]*)/g)].map((m) => m[1]));
  assert.ok(used.size > 20, `별칭 참조를 찾지 못했다(${used.size}개) — agent.js 구조가 바뀌었는지 확인`);
  const missing = [...used].filter((k) => !ENV_MD.includes(`\`${k}\``));
  assert.deepEqual(missing, [], `docs/ENV.md 누락: ${missing.join(', ')} — node scripts/env-doc.mjs`);
});

test('ENV.md — 보안 옵트인 키는 반드시 문서에 있다(운영자가 존재를 알아야 한다)', () => {
  for (const k of ['RMA_ALLOW_CUSTOM', 'RMA_ALLOW_SSH', 'RMA_ALLOW_REBOOT', 'RMA_FILE_ROOTS', 'RMA_SERVICE_UNITS']) {
    assert.ok(ENV_MD.includes(`\`${k}\``), `${k} 가 docs/ENV.md 에 없다`);
  }
});

test('ENV.md — 함수 인자 env(`policyFromEnv(env = process.env)`) 키도 잡힌다', () => {
  for (const k of ['METRICS_DEADBAND_TEMP_C', 'METRICS_DEADBAND_POWER_W', 'METRICS_DEADBAND_MAX_GAP_MS',
    'DISKTREND_WARN_PCT', 'DISKTREND_CRIT_PCT', 'DISKTREND_SNAPSHOT_MAX_HOURS']) {
    assert.ok(ENV_MD.includes(`\`${k}\``), `${k} 가 docs/ENV.md 에 없다`);
  }
});

test('ENV.md — 손으로 적은 기본값이 코드 상수와 일치한다(드리프트 방지)', async () => {
  // 이 6개는 같은 줄에 리터럴 기본값이 없어 scripts/env-doc.mjs 의 MANUAL 에 적혀 있다.
  // 코드 상수를 바꾸고 MANUAL 을 안 고치면 문서가 조용히 거짓말을 하므로 여기서 대조한다.
  const { DEFAULT_POLICY: DB } = await import('../src/metrics/deadband.js');
  const { DEFAULT_POLICY: DT } = await import('../src/tools/diskTrend.js');
  const docDefault = (key) => {
    const m = new RegExp(`\\| \`${key}\` \\| \`([^\`]*)\``).exec(ENV_MD);
    return m ? m[1] : null;
  };
  assert.equal(docDefault('METRICS_DEADBAND_TEMP_C'), String(DB.temp.eps));
  assert.equal(docDefault('METRICS_DEADBAND_POWER_W'), String(DB.power.eps));
  assert.equal(docDefault('METRICS_DEADBAND_MAX_GAP_MS'), String(DB.temp.maxGapMs));
  assert.equal(docDefault('DISKTREND_WARN_PCT'), String(DT.warnPct));
  assert.equal(docDefault('DISKTREND_CRIT_PCT'), String(DT.critPct));
  assert.equal(docDefault('DISKTREND_SNAPSHOT_MAX_HOURS'), String(DT.snapshotMaxHours));
});

test('CONFIG-FILES.md — 이관 대상 DB 가 전부 문서에 있다(가장 큰 파일이 빠지지 않게)', async () => {
  const { MIGRATABLE, MIGRATABLE_DIRS } = await import('../src/insights/dbLocation.js');
  const missing = MIGRATABLE.map((m) => m.file).filter((f) => !CFG_MD.includes(`\`${f}\``));
  assert.deepEqual(missing, [], `docs/CONFIG-FILES.md 누락: ${missing.join(', ')} — node scripts/config-doc.mjs`);
  for (const d of MIGRATABLE_DIRS) {
    assert.ok(CFG_MD.includes(`\`${d.dir}\``), `디렉터리 ${d.dir} 이 문서에 없다`);
  }
  // 이관 대상이 아니지만 실재하고 큰 두 파일도 문서화 대상이다.
  for (const f of ['ipam.db', 'vcenter-logs.db']) {
    assert.ok(CFG_MD.includes(`\`${f}\``), `${f} 가 문서에 없다`);
  }
});

test('CONFIG-FILES.md — DELETE 가 파일을 줄이지 않는다는 사실이 적혀 있다', () => {
  // 이 한계를 빼면 "보존기간 줄였는데 왜 그대로냐"는 오해가 반복된다(실제 문의 사유).
  assert.match(CFG_MD, /VACUUM/);
  assert.match(CFG_MD, /파일 크기를 줄이지 않는다/);
});

test('SETTINGS.md — 설정 탭이 코드와 1:1 로 대응한다', () => {
  const jsx = read(path.join(WEB, 'views/Settings.jsx'));
  const keys = [...jsx.matchAll(/\bk: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 30, `탭 키를 못 찾았다(${keys.length}개) — Settings.jsx 구조 변경 확인`);
  const missing = keys.filter((k) => !SET_MD.includes(`#/settings/${k}`));
  assert.deepEqual(missing, [], `docs/SETTINGS.md 에 없는 탭: ${missing.join(', ')}`);
  // 문서가 선언한 탭 수도 실제와 맞아야 한다(v2.448 에서 34 로 잘못 적혀 있었다).
  const declared = /설정\*\* 메뉴의 (\d+)개 화면/.exec(SET_MD);
  assert.ok(declared, '탭 수 문장을 찾지 못했다');
  assert.equal(Number(declared[1]), keys.length, `문서가 ${declared[1]}개라고 적었지만 실제 ${keys.length}개`);
});

test('SETTINGS.md — 존재하지 않는 환경변수를 안내하지 않는다', () => {
  // v2.448 은 METRICS_SAMPLE_INTERVAL_MS · METRICS_RETENTION_DAYS 를 안내했으나 코드에 없는 키였다.
  // 백틱으로 감싼 대문자 토큰 중 ENV.md 에 없는 것은 오안내다(허용 목록은 환경변수가 아닌 상수/값).
  // 환경변수가 아닌 토큰(SQL 키워드·파일 상수 등)은 제외한다.
  const ALLOW = new Set(['KEY', 'AUTH_SECRET', 'CENTRAL_TOKEN', 'SETTINGS_OWNERS', 'RMA_SUDOERS', 'DELETE', 'VACUUM']);
  const tokens = new Set([...SET_MD.matchAll(/`([A-Z][A-Z_0-9]{4,})`/g)].map((m) => m[1]));
  const bogus = [...tokens].filter((t) => !ALLOW.has(t) && !ENV_MD.includes(`\`${t}\``));
  assert.deepEqual(bogus, [], `docs/SETTINGS.md 가 코드에 없는 환경변수를 안내한다: ${bogus.join(', ')}`);
});
