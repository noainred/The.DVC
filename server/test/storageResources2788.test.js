/**
 * storageResources2788.test.js — 스토리지 하위 항목(LUN·파일시스템) 수집·정제 회귀(v2.788).
 *
 * 사용자 요청(2026-10-26): 엑셀 캡처처럼 Unity480 아래 `SAN Davinci_01` · `NAS sandbox` 행을 일간/주간으로 보기 —
 * 선택 "LUN·파일시스템까지".
 *
 * ⚠ 픽스처 `uemcli-{lun,fs}-detail-2788.txt` 는 **합성**이다 — 이 장비의 두 출력은 본 적이 없고, 형식은 Unisphere CLI
 *   가이드 예시 + 실장비로 확인된 풀 출력 규칙(` = ` · `N:` · 앞의 정수 바이트)을 따랐다. 크기·사용량 값은 사용자 캡처의
 *   GB 값을 바이트로 옮긴 것이다(122880.0 GB → 131941395333120). 실출력을 받으면 픽스처를 그것으로 바꿀 것.
 *   프롬프트가 첫 레코드에 붙는 형태(`uemcli-fs-prompt-inline-2788.txt`)도 함께 둔다(v2.544 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseLuns, parseFilesystems } from '../src/storage/collectors/uemcliParse.js';
import { SPECS, applyUnitySshResources } from '../src/storage/collectors/unitySsh.js';
import { applyUnityResources } from '../src/storage/collectors/unity.js';
import { stripUemcliBanner } from '../src/proxy/sshExec.js';
import { normalizeResource, normalizeResourceList, sanitizeEdgeResources, RESOURCE_MAX, resourceKey } from '../src/storage/resources.js';
import { narrowStorageSnapshot } from '../src/central/storageEdge.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');
const G = 1024 ** 3;

test('LUN 파서 — 크기와 할당량(Current allocation)을 앞의 정수 바이트로 읽는다', () => {
  const luns = parseLuns(stripUemcliBanner(fx('uemcli-lun-detail-2788.txt')));
  assert.equal(luns.length, 2);
  const d = luns[0];
  assert.equal(d.name, 'Davinci_01');
  assert.equal(d.id, 'sv_1');
  assert.equal(d.totalBytes, 122880 * G);
  assert.ok(Math.abs(d.usedBytes / G - 44979.6) < 0.01);
  assert.equal(d.usedSource, 'allocation');
  assert.equal(d.pool, 'pool_1');
  assert.equal(d.health, 'OK');
});

test('파일시스템 파서 — Size·Size used, 이력 키는 리소스 ID(res_N)', () => {
  const list = parseFilesystems(stripUemcliBanner(fx('uemcli-fs-detail-2788.txt')));
  assert.deepEqual(list.map((x) => x.name), ['temp_share', 'spitforebackup', 'sandbox', 'repo', 'dvc_portal', 'dvc_datakey']);
  const sb = list.find((x) => x.name === 'sandbox');
  assert.equal(sb.id, 'res_3');
  assert.equal(sb.totalBytes, 1024 * G);
  assert.ok(Math.abs(sb.usedBytes / G - 185.6) < 0.01);
  assert.equal(sb.protocol, 'cifs');
  assert.equal(sb.usedSource, 'fs');
});

test('프롬프트가 첫 레코드에 붙은 출력도 첫 항목을 잃지 않는다(v2.544 규약)', () => {
  const list = parseFilesystems(stripUemcliBanner(fx('uemcli-fs-prompt-inline-2788.txt')));
  assert.deepEqual(list.map((x) => x.name), ['temp_share', 'sandbox']);
});

test('못 읽은 크기·사용량은 0 이 아니라 null — 사용률도 null', () => {
  const [x] = parseLuns('1:    ID = sv_9\n      Name = L9\n      Storage pool = p\n');
  assert.equal(x.totalBytes, null);
  assert.equal(x.usedBytes, null);
  assert.equal(normalizeResource(x).pct, null);
});

test('수집 명령 — LUN·파일시스템은 맨 뒤 lowPriority(앞 항목을 밀어내지 않는다) · CSV 아님', () => {
  const keys = SPECS.map((s) => s.key);
  assert.deepEqual(keys.slice(-3), ['power', 'luns', 'filesystems']);
  for (const k of ['luns', 'filesystems']) {
    const s = SPECS.find((x) => x.key === k);
    assert.equal(s.lowPriority, true);
    assert.ok(!s.required);
    assert.equal(s.cmds.length, 1);
    assert.ok(Number(s.timeoutMs) > 0 && Number(s.timeoutMs) < 45_000);
  }
});

test('SSH 결과 표지 — ok/0개 · 예산 건너뜀 · 실패 · 형식 불명을 구분한다', () => {
  const ok = {};
  applyUnitySshResources(ok, { out: { luns: stripUemcliBanner(fx('uemcli-lun-detail-2788.txt')), filesystems: stripUemcliBanner(fx('uemcli-fs-detail-2788.txt')) } });
  assert.equal(ok.resources.length, 8);
  assert.deepEqual(ok.resourcesProbe.lun, { state: 'ok', source: 'uemcli /stor/prov/luns/lun show -detail', count: 2 });
  assert.equal(ok.resourcesProbe.fs.count, 6);

  const sk = {};
  applyUnitySshResources(sk, { out: {}, skipped: ['luns', 'filesystems'], errors: {} });
  assert.equal(sk.resourcesProbe.lun.state, 'skipped');
  assert.deepEqual(sk.resources, []);

  const fail = {};
  applyUnitySshResources(fail, { out: {}, skipped: [], errors: { luns: 'Operation failed. Error code: 0x1', filesystems: '빈 출력' } });
  assert.equal(fail.resourcesProbe.lun.state, 'failed');
  assert.match(fail.resourcesProbe.lun.detail, /Operation failed/);
  assert.match(fail.resourcesProbe.fs.detail, /항목이 없는 장비이거나/);

  // 레코드는 있는데 Size 키가 다르면 '항목 0개' 가 아니라 '형식 불명' 이다(빈 값을 항목이라 하지 않는다).
  const odd = {};
  applyUnitySshResources(odd, { out: { luns: '1:    ID = sv_1\n      Name = A\n      Storage pool = p\n      Capacity = 10\n', filesystems: '' } });
  assert.equal(odd.resourcesProbe.lun.state, 'unparsed');
  assert.deepEqual(odd.resources, []);
});

test('REST 경로 — sizeAllocated(LUN)·sizeUsed(FS), 조회 실패는 사유로, 조회 전 중단이면 아무것도 싣지 않는다', () => {
  const ex = {};
  applyUnityResources(ex, {
    luns: { entries: [{ content: { id: 'sv_1', name: 'L1', sizeTotal: 100 * G, sizeAllocated: 40 * G } }] },
    fsErr: 'HTTP 404',
  });
  assert.equal(ex.resources.length, 1);
  assert.equal(ex.resources[0].pct, 40);
  assert.equal(ex.resources[0].usedSource, 'allocation');
  assert.equal(ex.resourcesProbe.fs.state, 'failed');
  const none = {};
  applyUnityResources(none, {});
  assert.equal(none.resources, undefined);
  assert.equal(none.resourcesProbe, undefined);
});

test('정규화 — 모르는 종류·이름 없는 원소는 버리고, 상한을 넘은 개수를 센다', () => {
  const many = Array.from({ length: RESOURCE_MAX + 5 }, (_, i) => ({ kind: 'fs', id: `r${i}`, name: `f${i}`, totalBytes: 1 }));
  const { list, dropped } = normalizeResourceList([...many, { kind: 'x', name: 'a' }, { kind: 'lun' }, null]);
  assert.equal(list.length, RESOURCE_MAX);
  assert.equal(dropped, 5 + 3);
  assert.equal(resourceKey({ kind: 'lun', id: 'sv_1', name: 'A' }), 'lun:sv_1');
  assert.equal(resourceKey({ kind: 'fs', id: null, name: 'A' }), 'fs:A');
});

test('엣지 수신 정제 — 객체 이름·문자열 수치·__proto__ 류를 좁히고 storageEdge 가 그것을 거친다', () => {
  const o = { extra: { resources: [{ kind: 'lun', name: { a: 1 }, id: 'sv_1', totalBytes: '1024', usedBytes: '' }, 'x', { kind: 'fs', name: 'A', totalBytes: -1 }],
    resourcesProbe: { lun: { state: 'weird', detail: { a: 1 } }, bad: 1 } } };
  sanitizeEdgeResources(o);
  assert.equal(o.extra.resources.length, 2);
  assert.equal(o.extra.resources[0].name, 'sv_1');         // 이름이 객체면 id 로(지어내지 않는다)
  assert.equal(o.extra.resources[0].totalBytes, 1024);
  assert.equal(o.extra.resources[0].usedBytes, null);       // 빈 문자열은 0 이 아니다
  assert.equal(o.extra.resources[1].totalBytes, null);      // 음수 크기는 못 읽음
  assert.equal(o.extra.resourcesDropped, 1);
  assert.deepEqual(Object.keys(o.extra.resourcesProbe), ['lun']);
  assert.equal(o.extra.resourcesProbe.lun.state, 'failed');

  const { snap } = narrowStorageSnapshot({ deviceId: 'd1', extra: { resources: [{ kind: 'lun', name: 'L', totalBytes: '5' }, 7] } });
  assert.equal(snap.extra.resources.length, 1);
  assert.equal(snap.extra.resources[0].totalBytes, 5);
});
