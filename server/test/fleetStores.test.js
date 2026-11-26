import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 2026-11-26: 프로젝트 모듈을 불러오기 **전에** 설정 폴더를 임시 폴더로 잡는다. 잡지 않아 설정이 실제 `server/config` 로 풀려
//   fleet-assign.json · fleet-tags.json 을 남겼다(같은 체크아웃의 다음 실행이 그것을 읽는다). 정적 import 는 호이스팅돼 아래 대입보다 먼저 돌므로
//   src 모듈은 동적 import 로 부른다(v3.41.1 arch2582 와 같은 꼴 · 고정: test/configDirPerFile.test.js).
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
process.env.CONFIG_DIR = tmpDir('dvc-fleetstores-cfg-');

const { setFleetAssign, setFleetAssignMany, loadFleetAssign, applyFleetAssign, pruneFleetAssign, resetFleetAssign } = await import('../src/insights/fleetAssign.js');
const { setFleetTag, loadFleetTags, pruneFleetTags, resetFleetTags, applyFleetExclude } = await import('../src/insights/fleetTags.js');

beforeEach(() => { resetFleetAssign(); resetFleetTags(); });

test('setFleetAssign: validIds로 유령 vCenter 거부', () => {
  const valid = new Set(['vc-kr', 'vc-eu']);
  assert.equal(setFleetAssign('z1', 'ghost', valid).ok, false); // 없는 vCenter
  assert.equal(setFleetAssign('z1', 'vc-kr', valid).ok, true);
  assert.equal(loadFleetAssign().z1, 'vc-kr');
});

test('setFleetAssign: 키는 소문자로 정규화 저장, 빈값이면 해제', () => {
  setFleetAssign('ABC123', 'vc-kr');
  assert.equal(loadFleetAssign().abc123, 'vc-kr'); // 소문자
  setFleetAssign('abc123', '');
  assert.equal(loadFleetAssign().abc123, undefined); // 해제
});

test('applyFleetAssign: 수동 등록이 비-iDRAC를 덮고, iDRAC(레지스트리)는 권위로 보존', () => {
  setFleetAssign('z1', 'vc-kr');     // 서비스태그 기준
  setFleetAssign('srv-2', 'vc-eu');  // serverId 기준
  const measured = [
    { serverId: 'srv-1', serviceTag: 'Z1', vcenterId: '', source: 'ome' },          // assign으로 채워짐
    { serverId: 'srv-2', serviceTag: '', vcenterId: '', source: 'ome' },            // serverId 키로 채워짐
    { serverId: 'srv-3', serviceTag: 'Z1', vcenterId: 'vc-existing', source: 'idrac' }, // iDRAC 권위 → 보존
    { serverId: 'srv-4', serviceTag: 'Z1', vcenterId: 'vc-inferred', source: 'ome' },   // OME 추론값을 수동이 덮음
  ];
  applyFleetAssign(measured);
  assert.equal(measured[0].vcenterId, 'vc-kr');
  assert.equal(measured[1].vcenterId, 'vc-eu');
  assert.equal(measured[2].vcenterId, 'vc-existing'); // idrac 보존
  assert.equal(measured[3].vcenterId, 'vc-kr');       // ome는 수동 우선
});

test('applyFleetAssign: 호스트명 키 폴백 + vcenter 소스 보존 + validIds 거부', () => {
  setFleetAssign('esxi-7.lab', 'vc-kr'); // 호스트명(FQDN) 키로 귀속
  setFleetAssign('z9', 'vc-dead');       // 죽은(미존재) 법인 키
  const measured = [
    { serverId: 'srv-a', serviceTag: '', hostNames: ['esxi-7.lab'], vcenterId: '', source: 'remote' }, // 호스트명 폴백
    { serverId: 'srv-b', serviceTag: 'Z9', vcenterId: 'vc-host', source: 'vcenter' },                   // vcenter 권위 → 보존
    { serverId: 'srv-c', serviceTag: 'Z9', vcenterId: '', source: 'ome' },                              // validIds 미포함 → 무시
  ];
  applyFleetAssign(measured, new Set(['vc-kr'])); // valid엔 vc-dead 없음
  assert.equal(measured[0].vcenterId, 'vc-kr');  // 호스트명 키로 채워짐
  assert.equal(measured[1].vcenterId, 'vc-host'); // vcenter 소스 보존(옮기지 않음)
  assert.equal(measured[2].vcenterId, '');        // 죽은 법인 귀속은 validIds로 거부
});

test('applyFleetExclude: exclude 태그 서버를 전력 목록에서 제거', () => {
  setFleetTag('z1', 'exclude');          // 서비스태그 기준
  setFleetTag('srv-x', 'exclude');       // serverId 기준
  const measured = [
    { serverId: 'srv-1', serviceTag: 'Z1', hostNames: [] },   // 제외(태그)
    { serverId: 'srv-x', serviceTag: '', hostNames: [] },     // 제외(serverId)
    { serverId: 'srv-2', serviceTag: 'Z2', hostNames: ['keep-1'] }, // 유지
  ];
  const out = applyFleetExclude(measured);
  assert.equal(out.length, 1);
  assert.equal(out[0].serverId, 'srv-2');
});

test('setFleetTag: 잘못된 tag 거부, 유효 태그 저장/해제', () => {
  assert.equal(setFleetTag('z1', 'nonsense').ok, false);
  assert.equal(setFleetTag('z1', 'baremetal').ok, true);
  assert.equal(loadFleetTags().z1, 'baremetal');
  assert.equal(setFleetTag('z1', 'auto').ok, true); // auto = 해제
  assert.equal(loadFleetTags().z1, undefined);
});

test('setFleetAssignMany: 일괄 설정/해제 + validIds 거부 + 정규화', () => {
  const valid = new Set(['vc-kr', 'vc-eu']);
  const r = setFleetAssignMany([['K1', 'vc-kr'], ['k2', 'vc-eu'], ['k3', 'ghost'], ['k1', '']], valid);
  assert.equal(r.ok, true);
  const a = loadFleetAssign();
  assert.equal(a.k1, undefined);   // 마지막 해제 반영
  assert.equal(a.k2, 'vc-eu');     // 소문자 정규화
  assert.equal(a.k3, undefined);   // 유령 vCenter 거부
});

test('setFleetAssign: 해제인데 이미 없으면 no-op(ok)', () => {
  assert.equal(setFleetAssign('nope', '').ok, true);
  assert.equal(loadFleetAssign().nope, undefined);
});

test('pruneFleetTags/Assign: live 키만 남기고 유령 키 제거', () => {
  setFleetTag('z1', 'exclude');
  setFleetTag('dead', 'baremetal');
  setFleetAssign('z1', 'vc-kr');
  setFleetAssign('deadkey', 'vc-eu');
  const live = new Set(['z1']);
  assert.equal(pruneFleetTags(live), 1);   // 'dead' 제거
  assert.equal(pruneFleetAssign(live), 1); // 'deadkey' 제거
  assert.equal(loadFleetTags().z1, 'exclude');
  assert.equal(loadFleetTags().dead, undefined);
  assert.equal(loadFleetAssign().z1, 'vc-kr');
  assert.equal(loadFleetAssign().deadkey, undefined);
  assert.equal(pruneFleetTags(live), 0);   // 더 이상 제거할 것 없음
});
