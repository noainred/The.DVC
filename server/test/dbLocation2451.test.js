// DB 저장 경로 변경(v2.379) 회귀 고정 — v2.451 수정분.
//
// 핵심 회귀: v2.379 이후 추가된 DB(SAN perf v2.410 · RMA v2.416/418 · PDU v2.424)가
// MIGRATABLE 에 등재되지 않아, 경로만 새 곳을 보고 데이터는 복사되지 않는 '반쪽 상태'가 됐다.
// 아래 첫 테스트가 **코드가 만드는 .db 목록과 마이그레이션 대상을 대조**해 같은 누락을 자동으로 잡는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIGRATABLE, MIGRATABLE_DIRS, preflight } from '../src/insights/dbLocation.js';
import { DEFAULT_SERVICE, DEFAULT_USER, unitNameIssue } from '../src/insights/migrateScript.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** server/src 전체에서 `'<이름>.db'` 리터럴을 모아 코드가 실제로 만드는 DB 파일명을 얻는다. */
function dbFilesInCode() {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/'([a-z0-9-]+\.db)'/g)) out.add(m[1]);
      }
    }
  };
  walk(SRC);
  return out;
}

/** 마이그레이션 대상에서 의도적으로 뺀 것 — 뺀 이유가 코드 주석에 남아 있다. */
const INTENTIONALLY_EXCLUDED = new Set([
  'ipam.db',          // 외부 프로그램이 경로를 고정해 읽는 공유 파일 — 옮기면 연동이 조용히 끊긴다
  'vcenter-logs.db',  // 설정 › vCenter 로그 보관에 자체 경로(storagePath)가 있다 — 이중 제어 금지
]);

test('코드가 만드는 모든 DB 가 마이그레이션 대상이거나 명시적으로 제외돼 있다(누락 자동 검출)', () => {
  const inCode = dbFilesInCode();
  const listed = new Set(MIGRATABLE.map((m) => m.file));
  const missing = [...inCode].filter((f) => !listed.has(f) && !INTENTIONALLY_EXCLUDED.has(f)).sort();
  assert.deepEqual(missing, [],
    `마이그레이션 대상에 없는 DB: ${missing.join(', ')}\n`
    + '→ server/src/insights/dbLocation.js 의 MIGRATABLE 에 추가하거나,\n'
    + '   옮기면 안 되는 이유가 있으면 이 테스트의 INTENTIONALLY_EXCLUDED 에 근거와 함께 넣으세요.\n'
    + '   (경로만 dbDir 을 따르고 복사 대상에서 빠지면, 재시작 후 새 경로에 빈 DB 가 생기고\n'
    + '    기존 이력은 옛 경로에 남아 화면에서 사라집니다.)');
});

test('v2.379 이후 추가된 DB 4종이 실제로 등재돼 있다', () => {
  const listed = new Set(MIGRATABLE.map((m) => m.file));
  for (const f of ['sanswitch-perf.db', 'rma-history.db', 'rma-tests.db', 'pdu.db']) {
    assert.ok(listed.has(f), `${f} 가 MIGRATABLE 에 없다(v2.451 회귀)`);
  }
  // vmperf 는 vCenter별 파일이라 디렉터리 단위로 옮긴다.
  assert.ok(MIGRATABLE_DIRS.some((d) => d.dir === 'vmperf'), 'vmperf 디렉터리 대상 누락');
  // 모든 항목에 사람이 읽을 라벨이 있어야 화면·README 가 무엇을 옮기는지 설명할 수 있다.
  for (const m of [...MIGRATABLE, ...MIGRATABLE_DIRS]) assert.ok(m.label && m.label.length > 2);
});

test('기본 서비스 계정은 install.sh 의 SERVICE_USER 와 일치한다', () => {
  const sh = fs.readFileSync(path.resolve(SRC, '../../packaging/offline/install.sh'), 'utf8');
  const user = /^SERVICE_USER="([^"]+)"/m.exec(sh)?.[1];
  const svc = /^SERVICE_NAME="([^"]+)"/m.exec(sh)?.[1];
  assert.equal(DEFAULT_USER, user, `기본 계정이 실제 설치 계정과 다르다(스크립트의 chown 이 조용히 실패한다)`);
  assert.equal(DEFAULT_SERVICE, svc);
  assert.notEqual(DEFAULT_USER, DEFAULT_SERVICE, '서비스 이름과 실행 계정은 다른 값이다(예전에 혼동했다)');
});

test('서비스명·계정명 검증 — 개행/셸 메타문자를 막는다(README 코드블록 주입 방지)', () => {
  assert.equal(unitNameIssue('vmware-portal', '서비스 이름'), null);
  assert.equal(unitNameIssue('vmportal', '서비스 계정'), null);
  assert.equal(unitNameIssue('svc.name_1@host-2', '서비스 이름'), null);
  for (const bad of ['a\nrm -rf /', 'a; id', 'a`id`', 'a$(id)', "a'b", 'a b', '', 'x'.repeat(65)]) {
    assert.ok(unitNameIssue(bad, '서비스 이름'), `거부돼야 한다: ${JSON.stringify(bad)}`);
  }
});

test('preflight — systemd 하드닝 경로를 차단한다', () => {
  const home = preflight('/home/portal/db');
  assert.equal(home.ok, false);
  assert.ok(home.reasons.some((r) => /ProtectHome/.test(r)), home.reasons.join(' / '));

  const usr = preflight('/usr/local/portal-db');
  assert.equal(usr.ok, false);
  assert.ok(usr.reasons.some((r) => /ProtectSystem/.test(r)), usr.reasons.join(' / '));

  const root = preflight('/root/db');
  assert.equal(root.ok, false);
});

test('preflight — 기본 검증(절대경로·셸 메타문자)은 그대로다', () => {
  assert.equal(preflight('relative/path').ok, false);
  assert.equal(preflight('').ok, false);
  const inj = preflight('/data/db\nrm -rf /');
  assert.equal(inj.ok, false);
  assert.ok(inj.reasons.some((r) => /제어문자/.test(r)));
});
