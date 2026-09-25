// v2.613 아키텍처 점검 그룹 A — 특수 기능 집행 매핑(auth/toolAccess.js) 회귀 고정.
//   CATALOG2613-03 CurrentUsers 형제 경로·storage-track 전용 하위경로 매핑 + 선언 문장 정정 + 미매핑 세그먼트 = 허용 목록(사유)
//   CATALOG2613-12 이름 규약 — 세그먼트≠키 는 LEGACY_SEGMENT_KEYS(옛 항목)뿐이고 늘어나지 않는다.
// 라우터 스택은 실제 `api` 라우터(routes/api.js)를 import 해 열거한다 — 문서·정규식이 아니라 선언된 경로 그 자체.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2613a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WEB = path.join(SRC, '..', '..', 'web', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let TA, api;
before(async () => {
  TA = await import('../src/auth/toolAccess.js');
  ({ api } = await import('../src/routes/api.js'));
});

/** `api` 라우터에 선언된 경로 전부(문자열·배열 경로 평탄화). */
function declaredPaths() {
  const out = [];
  for (const layer of api.stack) {
    if (!layer.route) continue;
    const p = layer.route.path;
    for (const x of Array.isArray(p) ? p : [p]) out.push(String(x));
  }
  return out;
}

test('CATALOG2613-03: CurrentUsers 형제 경로가 curuser 로, StorageTrackTool 전용 ds-* 가 storage-track 으로 집행된다', () => {
  // v2.612 까지 null(통과) — `curuser` 를 거부해도 '전체(합집합)'·'VDI' 탭이 그대로 동작했다.
  assert.equal(TA.toolKeyForPath('/current-users/combined'), 'curuser');
  assert.equal(TA.toolKeyForPath('/horizon-sessions'), 'curuser');
  assert.equal(TA.toolKeyForPath('/horizon-sessions/settings'), 'curuser');
  assert.equal(TA.toolKeyForPath('/Horizon-Sessions/history?days=7'), 'curuser'); // 대소문자·쿼리 변형
  // StorageTrackTool.jsx 전용 하위경로 — 예전 선언 "ds-* 만 막힌다" 는 ds-change-log 하나만 사실이었다.
  for (const p of ['/vm-track/ds-change-log', '/vm-track/ds-list', '/vm-track/ds-pivot', '/vm-track/ds-series-all']) {
    assert.equal(TA.toolKeyForPath(p), 'storage-track', p);
  }
  // ⚠ 공유 경로는 vm-track 그대로 — 옮기면 storage-track 거부가 Datastores 추이 모달·V4 스토리지·VM 수량 추이를 같이 막는다.
  for (const p of ['/vm-track/ds-series', '/vm-track/ds-top', '/vm-track/ds-changes', '/vm-track']) {
    assert.equal(TA.toolKeyForPath(p), 'vm-track', p);
  }
  // 공유 관계는 웹 호출부가 근거다 — 그 근거가 바뀌면(파일이 그 경로를 더 이상 안 쓰면) 여기서 알아야 한다.
  const w = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
  assert.match(w('views/tools/DsTrendModal.jsx'), /\/tools\/vm-track\/ds-series'/, 'ds-series 는 Datastores 추이 모달이 쓴다');
  assert.match(w('version_4/pages/Storage.jsx'), /\/tools\/vm-track\/ds-top'/, 'ds-top 은 V4 스토리지가 쓴다');
  assert.match(w('views/tools/VmTrackTool.jsx'), /\/tools\/vm-track\/ds-changes'/, 'ds-changes 는 VmTrackTool 이 쓴다');
  for (const seg of ['ds-list', 'ds-pivot', 'ds-series-all']) {
    const users = ['views/tools', 'version_4', 'views', 'components', 'console'].flatMap((d) => {
      const dir = path.join(WEB, d);
      return fs.readdirSync(dir).filter((f) => /\.jsx?$/.test(f) && !/\.test\./.test(f)).map((f) => path.join(d, f));
    }).filter((rel) => w(rel).includes(`/tools/vm-track/${seg}`));
    assert.deepEqual(users, ['views/tools/StorageTrackTool.jsx'], `${seg} 는 StorageTrackTool 전용이어야 두 세그먼트 표에 둘 수 있다`);
  }
});

test('CATALOG2613-03: 선언 문장이 사실이다 — storage-track 노트는 실제 목록, nsx 노트는 주 API', () => {
  const notes = TA.TOOL_ENFORCEMENT_NOTES;
  const st = notes['storage-track'];
  assert.equal(st[0], TA.ENFORCE_PARTIAL);
  for (const seg of ['ds-change-log', 'ds-list', 'ds-pivot', 'ds-series-all']) assert.ok(st[1].includes(seg), `storage-track 노트에 ${seg} 가 없다`);
  assert.ok(!/ds-\*/.test(st[1]), "'ds-* 만 막힌다' 는 거짓 선언이었다 — 실제 목록으로 적는다");
  // 노트가 말하는 전용 하위경로 == 두 세그먼트 표의 storage-track 항목(문장과 표가 갈라지지 않게).
  const inTable = Object.entries(TA.TOOL_PATH2_KEYS).filter(([, k]) => k === 'storage-track').map(([p]) => p.split('/')[1]).sort();
  assert.deepEqual(inTable, ['ds-change-log', 'ds-list', 'ds-pivot', 'ds-series-all']);
  assert.match(notes.nsx[1], /\/api\/nsx\(requirePerm\('inv\.nsx'\)\)/, 'Nsx.jsx 의 주 API 는 /api/nsx(inv.nsx) 다');
  // 주 API 가 실제로 그 게이트인지 — 라우트 선언에서 확인(문장이 낡지 않게).
  const nsxSrc = stripComments(read('routes/api/overviewNsx.js'));
  const alias = nsxSrc.match(/api\.get\('\/nsx',\s*([A-Za-z_]+),/);
  assert.ok(alias, "'/nsx' 라우트 선언을 못 찾았다");
  assert.match(nsxSrc, new RegExp(`const ${alias[1]} = requirePerm\\('inv\\.nsx'\\)`), `'/nsx' 게이트 별칭 ${alias[1]} 이 inv.nsx 가 아니다`);
  // 문구에 백틱 금지(관리 화면이 BoldText 로 그린다).
  for (const [k, [, why]] of Object.entries(notes)) assert.ok(!why.includes('`'), `${k} 노트에 백틱`);
});

test('CATALOG2613-03: 매핑 없는 /tools 세그먼트는 UNMAPPED_TOOL_SEGMENTS(사유) 와 정확히 일치한다', () => {
  const paths = declaredPaths().filter((p) => p.startsWith('/tools/'));
  assert.ok(paths.length > 150, `라우터 스택에서 /tools 경로를 못 읽었다(${paths.length})`);
  const unmapped = new Set();
  for (const p of paths) {
    if (TA.toolKeyForPath(p.slice('/tools'.length))) continue;
    unmapped.add(p.slice('/tools/'.length).split('/')[0].replace(/\.(csv|json|xlsx)$/, '').replace(/:.*$/, ''));
  }
  const declared = new Set(Object.keys(TA.UNMAPPED_TOOL_SEGMENTS));
  assert.deepEqual([...unmapped].sort(), [...declared].sort(),
    '매핑도 선언도 없는 세그먼트가 있다 — 그 도구는 거부해도 서버가 막지 않는데 아무도 모른다(또는 사라진 세그먼트가 선언에 남았다)');
  // 사유는 실재해야 한다 — ip-ping 은 EntityDetail, vclogs 는 VcenterLogs, groups 는 SpecialTools ToolPanel.
  const w = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
  assert.ok(w('components/EntityDetail.jsx').includes("'/tools/ip-ping'"));
  assert.ok(w('views/VcenterLogs.jsx').includes('/tools/vclogs'));
  assert.ok(w('views/SpecialTools.jsx').includes("'/tools/groups'"));
  for (const why of Object.values(TA.UNMAPPED_TOOL_SEGMENTS)) assert.ok(why.length > 10 && !why.includes('`'));
});

test('CATALOG2613-12: 세그먼트≠키 는 LEGACY_SEGMENT_KEYS 뿐 — 새 도구는 /api/tools/<k> 세그먼트 = 카탈로그 키', () => {
  const differ = Object.entries(TA.TOOL_PATH_KEYS).filter(([seg, k]) => seg !== k).map(([seg]) => seg).sort();
  const legacy = [...TA.LEGACY_SEGMENT_KEYS].sort();
  assert.deepEqual(differ, legacy, '세그먼트≠키 항목이 LEGACY 집합과 다르다 — 새 항목은 세그먼트=키 로 만들 것(옛 것을 지웠으면 집합에서도 뺄 것)');
  assert.ok(Object.isFrozen(TA.LEGACY_SEGMENT_KEYS));
  assert.ok(legacy.length <= 18, `LEGACY 가 늘었다(${legacy.length}) — 이 집합은 줄어들 수만 있다`);
  // 두 세그먼트 표(report/*, vm-track/*)는 성격상 세그먼트≠키 다 — 첫 세그먼트가 'report'·'vm-track' 인 것만 허용.
  for (const p of Object.keys(TA.TOOL_PATH2_KEYS)) assert.match(p, /^(report|vm-track)\//, p);
  // 머리말에 규약이 적혀 있다(다음 사람이 표를 늘리기 전에 읽게).
  assert.match(read('auth/toolAccess.js'), /이름 규약\(v2\.613 CATALOG2613-12\)/);
  // 매핑된 키는 전부 카탈로그에 실재한다(유령 키 금지).
  const cat = new Set([...fs.readFileSync(path.join(WEB, 'views/specialToolsList.js'), 'utf8').matchAll(/\{\s*k:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  for (const k of TA.enforcedToolKeys()) assert.ok(cat.has(k), `매핑된 키 ${k} 가 카탈로그에 없다`);
});
