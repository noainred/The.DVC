// 전체 점검 115회차 — 메인 반영(반증 에이전트가 '메인 결정 필요' 로 남긴 D1).
//  D1 런타임 설정(runtime.json — 화면에서 고른 데이터 소스)이 **있는데 읽지 못한 동안** getDataSource() 가 env 기본값을 줬다. 설치 예제의 기본이
//     DATA_SOURCE=mock 이고 운영자는 화면에서 live 로 바꿔 쓰므로, 재시작 직후 읽기 오류에 운영 포탈이 데모(mock) 모드로 돌았다
//     (합성 스냅샷 · 데모 계정 관리자 문맥 · mock 전용 분기). 못 읽은 것은 'mock 을 골랐다' 가 아니다 — env 가 mock 이면 live 로 판정한다.
//  모듈이 기동 때 한 번 읽고 캐시하므로 시나리오마다 새 프로세스로 돌린다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIRS = [];
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); });
const mkCfg = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'main-fix-115-')); TMP_DIRS.push(d); return d; };

/** 새 프로세스에서 getDataSource() · dataSourceUnread() · 저장 거절을 읽는다. env.DATA_SOURCE 를 주지 않으면 지운다(기본값 경로). */
function probe(cfgDir, dataSource, extra = '') {
  const env = { ...process.env, CONFIG_DIR: cfgDir, PORT: '4000' };
  delete env.DATA_SOURCE; delete env.EDGE_ALL;
  if (dataSource != null) env.DATA_SOURCE = dataSource;
  const code = `
    const rs = await import(${JSON.stringify(path.join(HERE, '..', 'src', 'runtime-settings.js'))});
    const out = { ds: rs.getDataSource(), unread: rs.dataSourceUnread(), refusal: !!rs.runtimeSettingsWriteRefusal(), overridden: rs.isDataSourceOverridden() };
    ${extra}
    process.stdout.write('\\n@@' + JSON.stringify(out) + '\\n');
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 60_000 });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `프로브 실패: ${String(r.stderr || '').slice(0, 600)}`);
  return { ...JSON.parse(line.slice(2)), stderr: String(r.stderr || '') + String(r.stdout || '') };
}
const FILE = (d) => path.join(d, 'runtime.json');

test('D1: 저장된 선택(live)을 못 읽는 동안 env 기본값 mock 으로 돌지 않는다 — live 로 판정하고 사유를 남긴다', () => {
  const d = mkCfg();
  fs.mkdirSync(FILE(d));   // 파일 자리가 폴더(EISDIR) — 읽기 오류
  const r = probe(d, 'mock');
  assert.equal(r.ds, 'live', '읽기 오류 중에 env 기본값 mock 으로 돌았다(운영 포탈이 데모 모드)');
  assert.equal(r.unread?.readError, true);
  assert.equal(r.refusal, true, '읽기 오류 중의 저장 거절(107회차)이 사라졌다');
  assert.equal(r.overridden, false);
  assert.match(r.stderr, /가짜 데이터로 돌지 않도록 live 로 판정/);
  assert.ok(!r.stderr.includes(d), '콘솔 사유에 설정 폴더 경로가 실렸다');
  assert.ok(fs.statSync(FILE(d)).isDirectory(), '원본 자리를 옮겼다');
});

test('D1: env 기본값이 mock 이 아니면(live · auto) 못 읽는 동안에도 그 값 그대로', () => {
  for (const ds of ['live', 'auto']) {
    const d = mkCfg();
    fs.mkdirSync(FILE(d));
    assert.equal(probe(d, ds).ds, ds);
  }
});

test('D1: 파일이 없는 것은 읽기 오류가 아니다 — env 기본값(mock 포함) 그대로 · 저장된 선택은 그대로 읽힌다', () => {
  const none = mkCfg();
  const a = probe(none, 'mock');
  assert.equal(a.ds, 'mock', '파일 없음(화면에서 고른 적 없음)인데 mock 을 live 로 바꿨다 — 데모 설치가 깨진다');
  assert.equal(a.unread, null);
  const saved = mkCfg();
  fs.writeFileSync(FILE(saved), JSON.stringify({ dataSource: 'live' }));
  const b = probe(saved, 'mock');
  assert.equal(b.ds, 'live');
  assert.equal(b.overridden, true);
  const savedMock = mkCfg();
  fs.writeFileSync(FILE(savedMock), JSON.stringify({ dataSource: 'mock' }));
  assert.equal(probe(savedMock, 'live').ds, 'mock', '화면에서 고른 mock 은 그대로 존중한다');
});

test('D1: 손상(JSON)은 예전 규약 그대로 — 보존본으로 옮기고 env 기본값', () => {
  const d = mkCfg();
  fs.writeFileSync(FILE(d), '{"dataSource": ');
  const r = probe(d, 'mock');
  assert.equal(r.ds, 'mock');
  assert.equal(r.unread, null);
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith('runtime.json.corrupt')), '손상본을 보존하지 않았다');
});

// ── 118회차 메인(Chromium 2차 판독): 설정 상태 배지 — 등록부를 읽지 못한 동안 '등록된 vCenter 없음 · 미설정' 이라고 말했다 ─────────────
test('설정 상태: vCenter · NSX 등록부 읽기 오류는 0건(미설정 · 사용 안 함)이 아니라 주의 — 손상은 보존본 확인 문구 그대로', async () => {
  const { RULES, buildSettingsStatus } = await import('../src/settingsStatus/grade.js');
  const one = (k, facts) => buildSettingsStatus({ [k]: () => facts }).items[k] ?? null;
  // 읽기 오류: 건수를 모른다(null) — '등록된 vCenter 없음' 이 나오면 안 된다
  const vc = one('vcenter-admin', { loadError: true, readError: true, count: null, authStopped: 0 });
  assert.equal(vc.grade, 'warn');
  assert.match(vc.text, /읽지 못함\(읽기 오류/);
  assert.doesNotMatch(vc.text, /없음|손상 보존본/);
  const nsx = one('nsx-admin', { loadError: true, readError: true, count: null });
  assert.equal(nsx.grade, 'warn');
  assert.match(nsx.text, /읽지 못함\(읽기 오류/);
  // 손상(보존본만 남음)은 예전 문구 그대로(v2.916 반증 D2 — 보존본을 되돌리게)
  assert.equal(one('vcenter-admin', { loadError: true, count: null, authStopped: 0 }).text, '설정 파일을 읽지 못함(손상 보존본 확인)');
  assert.equal(one('nsx-admin', { loadError: true, count: null }).text, '설정 파일을 읽지 못함(손상 보존본 확인)');
  // 정상 판정은 그대로
  assert.equal(one('vcenter-admin', { count: 0, authStopped: 0 }).grade, 'unset');
  assert.equal(one('nsx-admin', { count: 0 }).grade, 'off');
  assert.equal(one('vcenter-admin', { count: 3, authStopped: 0 }), null);
  // 사실 함수가 읽기 오류 때 건수를 싣지 않는다(소스 배선)
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'settingsStatus', 'sources.js'), 'utf8');
  assert.match(src, /const count = unread \? null : len\(listVcenters\(\)\);/);
  assert.match(src, /readError: le\?\.readError === true/);
});
