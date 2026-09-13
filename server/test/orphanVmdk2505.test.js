/**
 * v2.505 — 고아 VMDK 탐지 판정 회귀 고정.
 *
 * 이 판정은 사람이 **파일을 지울지 결정하는 근거**가 된다. 그래서 여기서 고정하는 것은
 * '기능이 동작한다' 가 아니라 **틀렸을 때 데이터가 날아가는 경계들**이다:
 *   · 소유 중인 디스크를 고아로 보고하지 않는가(경로 정규화·익스텐트 묶기)
 *   · FCD·콘텐츠 라이브러리·Replication·CBT 를 고아로 세지 않는가
 *   · 폴더에 vmx 가 있으면 '미등록 VM' 으로 구분하는가(다른 vCenter 등록 가능성)
 *   · 소유 집합이 불완전할 때 '신뢰 불가' 라고 말하는가
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isVmdk, isExtent, isCtk, logicalDiskKey, normDsPath, fullPathOf, ownedPathSet,
  excludedFolderReason, excludedNameReason, findOrphanDisks, confidenceOf, SHARED_DS_WARNING,
} from '../src/tools/orphanVmdk.js';

const f = (folder, name, sizeBytes = 0, modified = '', type = 'VmDisk') => ({ folder, name, sizeBytes, modified, type });

/* ── 경로 정규화: 여기서 틀리면 쓰고 있는 디스크를 고아로 보고한다 ─────────── */

test('경로 정규화 — 대소문자·공백·구분자 차이를 흡수한다', () => {
  const a = normDsPath('[DS1] Folder/Disk.vmdk');
  assert.equal(a, '[ds1] folder/disk.vmdk');
  assert.equal(normDsPath('[ ds1 ]  folder/disk.vmdk'), '[ds1] folder/disk.vmdk', '대괄호 안팎 공백');
  assert.equal(normDsPath('[ds1] folder\\\\disk.vmdk'), '[ds1] folder/disk.vmdk', '역슬래시');
  assert.equal(normDsPath('  [ds1] folder//disk.vmdk '), '[ds1] folder/disk.vmdk', '중복 슬래시·앞뒤 공백');
  assert.equal(normDsPath(null), '');
});

test('브라우저 folderPath + path → 전체 경로', () => {
  assert.equal(fullPathOf('[ds1] vm-a', 'vm-a.vmdk'), '[ds1] vm-a/vm-a.vmdk');
  assert.equal(fullPathOf('[ds1] vm-a/', 'vm-a.vmdk'), '[ds1] vm-a/vm-a.vmdk');
  // 데이터스토어 루트 파일의 vCenter 표기는 `[ds1] loose.vmdk`(슬래시 없음)다 —
  // 여기에 `/` 를 끼우면 layoutEx.file 의 소유 경로와 문자열이 달라져 소유 판정을 놓친다.
  assert.equal(fullPathOf('[ds1]', 'loose.vmdk'), '[ds1] loose.vmdk');
  assert.equal(fullPathOf('[ds1] ', 'Loose.VMDK'), '[ds1] loose.vmdk', '대소문자·공백 무관');
});

test('소유 집합은 정규화되어 담긴다 — 표기 차이로 소유를 놓치면 위험하다', () => {
  const owned = ownedPathSet([['[DS1] VM-A/VM-A.vmdk', '[DS1] VM-A/VM-A-flat.vmdk'], null, ['']]);
  assert.equal(owned.size, 2);
  assert.ok(owned.has('[ds1] vm-a/vm-a.vmdk'));
});

/* ── 익스텐트/디스크립터 묶기 ─────────────────────────────────────────────── */

test('익스텐트 판정 — 데이터 파일과 디스크립터를 가른다', () => {
  assert.equal(isExtent('d-flat.vmdk'), true);
  assert.equal(isExtent('d-000001-delta.vmdk'), true);
  assert.equal(isExtent('d-sesparse.vmdk'), true);
  assert.equal(isExtent('d-s001.vmdk'), true);
  assert.equal(isExtent('d-rdmp.vmdk'), true);
  assert.equal(isExtent('d-ctk.vmdk'), true);
  assert.equal(isExtent('d.vmdk'), false, '디스크립터');
  assert.equal(isCtk('d-ctk.vmdk'), true);
  assert.equal(isVmdk('d.VMDK'), true);
  assert.equal(isVmdk('d.vmx'), false);
});

test('논리 디스크 키 — 디스크립터와 익스텐트가 같은 키로 묶인다', () => {
  const k = logicalDiskKey('[ds1] vm-a', 'vm-a.vmdk');
  assert.equal(logicalDiskKey('[DS1] VM-A', 'vm-a-flat.vmdk'), k);
  assert.equal(logicalDiskKey('[ds1] vm-a', 'vm-a-s003.vmdk'), k);
  // 스냅샷 세대는 별개 디스크로 본다(세대별로 회수 판단이 다르다).
  assert.notEqual(logicalDiskKey('[ds1] vm-a', 'vm-a-000001.vmdk'), k);
  assert.equal(logicalDiskKey('[ds1] vm-a', 'vm-a-000001-delta.vmdk'), logicalDiskKey('[ds1] vm-a', 'vm-a-000001.vmdk'));
});

test('디스크 묶음은 크기를 합산하고 표시 이름은 디스크립터를 쓴다', () => {
  const files = [
    f('[ds1] gone', 'gone-flat.vmdk', 40 * 1024 ** 3, '2026-01-01T00:00:00Z'),
    f('[ds1] gone', 'gone.vmdk', 1024, '2026-01-01T00:00:00Z'),
  ];
  const { disks } = findOrphanDisks(files, new Set(), { now: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(disks.length, 1, '두 파일이 한 디스크로 묶여야 한다(개수 부풀림 방지)');
  assert.equal(disks[0].name, 'gone.vmdk', '표시 이름은 디스크립터');
  assert.equal(disks[0].sizeBytes, 40 * 1024 ** 3 + 1024, '회수 가능 용량은 합산값(디스크립터 크기만 보이면 오판)');
  assert.equal(disks[0].files.length, 2);
});

/* ── 소유 중인 디스크는 절대 보고하지 않는다 ──────────────────────────────── */

test('소유 중인 디스크는 결과에 나오지 않는다(표기가 달라도)', () => {
  const files = [
    f('[ds1] vm-live', 'vm-live.vmdk', 1024),
    f('[ds1] vm-live', 'vm-live-flat.vmdk', 30 * 1024 ** 3),
    f('[ds1] vm-live', 'vm-live.vmx', 3000, '', 'VmConfig'),
  ];
  // vCenter 가 준 소유 경로는 대문자 표기 — 정규화가 없으면 전부 고아로 잡힌다.
  const owned = ownedPathSet([['[DS1] VM-Live/VM-Live.vmdk', '[DS1] VM-Live/VM-Live-flat.vmdk']]);
  const r = findOrphanDisks(files, owned);
  assert.equal(r.disks.length, 0, `소유 디스크가 고아로 보고됐다: ${JSON.stringify(r.disks)}`);
  assert.equal(r.summary.ownedVmdkFiles, 2);
  assert.equal(r.summary.scannedVmdkFiles, 2, 'vmx 는 vmdk 로 세지 않는다');
});

/* ── 제외 구역: 여기를 고아로 세면 PV·라이브러리가 파괴된다 ──────────────── */

test('FCD(쿠버네티스 PV)·콘텐츠 라이브러리·Replication·시스템 폴더는 고아가 아니다', () => {
  const files = [
    f('[ds1] fcd', 'e1f2.vmdk', 10 * 1024 ** 3),
    f('[ds1] fcd/sub', 'e1f2-flat.vmdk', 10 * 1024 ** 3),
    f('[ds1] contentlib-abc/def', 'tpl.vmdk', 5 * 1024 ** 3),
    f('[ds1] vm-a', 'hbrdisk.RDID-x.vmdk', 2 * 1024 ** 3),
    f('[ds1] .vSphere-HA', 'x.vmdk', 1024),
    f('[ds1] vm-a', 'vm-a-ctk.vmdk', 1024 ** 2),
  ];
  const r = findOrphanDisks(files, new Set());
  assert.equal(r.disks.length, 0, `제외 대상이 고아로 보고됐다: ${JSON.stringify(r.disks.map((d) => d.name))}`);
  assert.equal(r.summary.excludedFiles, 6);
  const reasons = new Set(r.excluded.map((e) => e.reason));
  for (const want of ['fcd', 'contentlib', 'replication', 'system', 'ctk']) {
    assert.ok(reasons.has(want), `제외 사유 누락: ${want}`);
  }
});

test('제외 사유 판정 — 폴더/파일명 각각', () => {
  assert.equal(excludedFolderReason('[ds1] fcd'), 'fcd');
  assert.equal(excludedFolderReason('[ds1] FCD/sub'), 'fcd');
  assert.equal(excludedFolderReason('[ds1] contentlib-9f/abc'), 'contentlib');
  assert.equal(excludedFolderReason('[ds1] .dvsData'), 'system');
  assert.equal(excludedFolderReason('[ds1] vm-a'), null, '일반 VM 폴더는 제외 대상이 아니다');
  assert.equal(excludedNameReason('hbrdisk.RDID-1.vmdk'), 'replication');
  assert.equal(excludedNameReason('vm-a-ctk.vmdk'), 'ctk');
  assert.equal(excludedNameReason('vm-a.vmdk'), null);
});

/* ── 판정 구분: 고아 / 미등록 VM / 보류 ───────────────────────────────────── */

test('폴더에 vmx 가 있으면 고아가 아니라 미등록 VM 으로 구분한다', () => {
  // 이 구분이 없으면 '다른 vCenter 가 등록한 VM' 과 '의도적으로 언레지스터한 VM' 을
  // 삭제해도 되는 고아 디스크로 보고한다.
  const old = '2026-01-01T00:00:00Z';
  const files = [
    f('[ds1] unreg', 'unreg.vmx', 3000, old, 'VmConfig'),
    f('[ds1] unreg', 'unreg.vmdk', 1024, old),
    f('[ds1] unreg', 'unreg-flat.vmdk', 20 * 1024 ** 3, old),
    f('[ds1] truly-gone', 'lost.vmdk', 1024, old),
    f('[ds1] truly-gone', 'lost-flat.vmdk', 50 * 1024 ** 3, old),
  ];
  const r = findOrphanDisks(files, new Set(), { now: Date.parse('2026-06-01T00:00:00Z') });
  const byName = Object.fromEntries(r.disks.map((d) => [d.name, d]));
  assert.equal(byName['unreg.vmdk'].verdict, 'unregistered');
  assert.ok(byName['unreg.vmdk'].reason.includes('.vmx'));
  assert.equal(byName['lost.vmdk'].verdict, 'orphan');
  assert.equal(r.summary.orphanDisks, 1);
  assert.equal(r.summary.unregisteredDisks, 1);
  assert.equal(r.summary.orphanBytes, 50 * 1024 ** 3 + 1024);
});

test('최근 변경된 파일은 판정을 보류한다(복제·백업 진행 중일 수 있다)', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const files = [
    f('[ds1] cloning', 'new.vmdk', 1024, '2026-06-01T11:00:00Z'),
    f('[ds1] old', 'old.vmdk', 1024, '2026-05-01T00:00:00Z'),
  ];
  const r = findOrphanDisks(files, new Set(), { now, recentHours: 24 });
  const byName = Object.fromEntries(r.disks.map((d) => [d.name, d]));
  assert.equal(byName['new.vmdk'].verdict, 'hold');
  assert.equal(byName['old.vmdk'].verdict, 'orphan');
  // 보류 창을 0 으로 주면 검사하지 않는다(호출부가 명시적으로 끈 경우).
  const r0 = findOrphanDisks(files, new Set(), { now, recentHours: 0 });
  assert.equal(r0.summary.holdDisks, 0);
  assert.equal(r0.summary.orphanDisks, 2);
});

test('수정 시각이 없는 파일은 보류로 만들지 않는다(나이를 모르면 보류 판정도 못 한다)', () => {
  const r = findOrphanDisks([f('[ds1] a', 'a.vmdk', 10)], new Set(), { now: Date.now() });
  assert.equal(r.disks[0].verdict, 'orphan');
  assert.equal(r.disks[0].modified, '');
});

test('큰 것부터 정렬 — 용량 회수 검토가 목적이다', () => {
  const files = [
    f('[ds1] s', 'small.vmdk', 1024, '2026-01-01T00:00:00Z'),
    f('[ds1] b', 'big.vmdk', 99 * 1024 ** 3, '2026-01-01T00:00:00Z'),
  ];
  const { disks } = findOrphanDisks(files, new Set(), { now: Date.parse('2026-06-01T00:00:00Z') });
  assert.equal(disks[0].name, 'big.vmdk');
});

test('빈 입력에 안전', () => {
  const r = findOrphanDisks();
  assert.deepEqual(r.disks, []);
  assert.equal(r.summary.orphanDisks, 0);
  assert.equal(r.summary.orphanBytes, 0);
});

/* ── 신뢰도: 소유 집합이 불완전하면 '신뢰 불가' 라고 말해야 한다 ──────────── */

test('신뢰도 — 파일 목록 절단은 누락 가능이므로 low', () => {
  assert.equal(confidenceOf({ truncated: true, dsVmCount: 3, vmsQueried: 3, vmsWithLayout: 3 }).level, 'low');
});

test('신뢰도 — VM 파일 목록을 못 읽었으면 신뢰 불가(none)', () => {
  const c = confidenceOf({ dsVmCount: 5, vmsQueried: 0, vmsWithLayout: 0 });
  assert.equal(c.level, 'none');
  assert.ok(c.text.includes('신뢰할 수 없'));
});

test('신뢰도 — 일부 VM 만 읽었으면 low 이고 몇 대인지 밝힌다', () => {
  const c = confidenceOf({ dsVmCount: 10, vmsQueried: 10, vmsWithLayout: 7 });
  assert.equal(c.level, 'low');
  assert.ok(c.text.includes('10') && c.text.includes('7'));
});

test('신뢰도 — 전부 대조했으면 high', () => {
  assert.equal(confidenceOf({ dsVmCount: 4, vmsQueried: 4, vmsWithLayout: 4, ownedFiles: 40 }).level, 'high');
});

test('신뢰도 — 등록 VM 이 없는 데이터스토어는 medium(정상일 수 있음을 밝힌다)', () => {
  const c = confidenceOf({ dsVmCount: 0, vmsQueried: 0, vmsWithLayout: 0, ownedFiles: 0 });
  assert.equal(c.level, 'medium');
  assert.ok(c.text.includes('정상일 수 있'));
});

test('공유 데이터스토어 경고는 항상 존재한다(오삭제를 막는 마지막 줄)', () => {
  assert.ok(SHARED_DS_WARNING.includes('다른 vCenter'));
  assert.ok(SHARED_DS_WARNING.includes('직접 확인'));
});

/* ── 통합: 실제 vCenter XML 형태 → 파싱 → 판정 ───────────────────────────────
 * 순수 판정만 고정하면 '파서가 주는 형태' 와 어긋나도 테스트가 통과한다. 그 어긋남이
 * 바로 '쓰고 있는 디스크를 고아로 보고' 하는 사고이므로, 실제 XML 모양으로 한 번 더 묶는다.
 */
import { parseLayoutFilePaths, parseDsSearchResults } from '../src/vcenter/soapParse.js';

test('통합 — layoutEx.file XML 과 브라우저 XML 을 대조하면 소유 디스크가 걸러진다', () => {
  // vCenter 가 실제로 주는 형태: layoutEx 는 `[ds] folder/file`, 브라우저는 folderPath + path 분리.
  const layoutXml = `
    <file><key>0</key><name>[ds1] vm-live/vm-live.vmx</name><type>config</type><size>3134</size></file>
    <file><key>1</key><name>[ds1] vm-live/vm-live.vmdk</name><type>diskDescriptor</type><size>569</size></file>
    <file><key>2</key><name>[ds1] vm-live/vm-live-flat.vmdk</name><type>diskExtent</type><size>42949672960</size></file>
    <file><key>3</key><name>[ds1] vm-live/vmware.log</name><type>log</type><size>102400</size></file>`;
  const browseXml = `
    <HostDatastoreBrowserSearchResults>
      <folderPath>[ds1] vm-live</folderPath>
      <file xsi:type="VmConfigFileInfo"><path>vm-live.vmx</path><fileSize>3134</fileSize><modification>2026-09-01T00:00:00Z</modification></file>
      <file xsi:type="VmDiskFileInfo"><path>vm-live.vmdk</path><fileSize>569</fileSize><modification>2026-09-01T00:00:00Z</modification></file>
      <file xsi:type="VmDiskFileInfo"><path>vm-live-flat.vmdk</path><fileSize>42949672960</fileSize><modification>2026-09-01T00:00:00Z</modification></file>
    </HostDatastoreBrowserSearchResults>
    <HostDatastoreBrowserSearchResults>
      <folderPath>[ds1] deleted-vm</folderPath>
      <file xsi:type="VmDiskFileInfo"><path>deleted-vm.vmdk</path><fileSize>600</fileSize><modification>2026-02-01T00:00:00Z</modification></file>
      <file xsi:type="VmDiskFileInfo"><path>deleted-vm-flat.vmdk</path><fileSize>107374182400</fileSize><modification>2026-02-01T00:00:00Z</modification></file>
    </HostDatastoreBrowserSearchResults>
    <HostDatastoreBrowserSearchResults>
      <folderPath>[ds1] fcd</folderPath>
      <file xsi:type="VmDiskFileInfo"><path>a1b2c3.vmdk</path><fileSize>21474836480</fileSize><modification>2026-02-01T00:00:00Z</modification></file>
    </HostDatastoreBrowserSearchResults>`;

  const owned = ownedPathSet([parseLayoutFilePaths(layoutXml)]);
  assert.equal(owned.size, 4, 'layoutEx 의 파일 4개가 모두 소유로 들어가야 한다');

  const { files, truncated } = parseDsSearchResults(browseXml);
  assert.equal(truncated, false);
  assert.equal(files.length, 6);

  const r = findOrphanDisks(files, owned, { now: Date.parse('2026-09-13T00:00:00Z') });
  assert.equal(r.disks.length, 1, `기대: deleted-vm 1건. 실제: ${JSON.stringify(r.disks.map((d) => d.name))}`);
  assert.equal(r.disks[0].name, 'deleted-vm.vmdk');
  assert.equal(r.disks[0].verdict, 'orphan', '폴더에 vmx 가 없으니 orphan');
  assert.equal(r.disks[0].sizeBytes, 107374182400 + 600);
  assert.equal(r.summary.ownedVmdkFiles, 2, '소유 vmdk 2개(디스크립터+flat)');
  assert.equal(r.summary.excludedFiles, 1, 'fcd 1개 제외');
  assert.equal(r.excluded[0].reason, 'fcd');
});

test('통합 — layoutEx 를 못 읽으면(빈 소유 집합) 멀쩡한 디스크도 후보로 나온다 → 신뢰도가 그것을 알린다', () => {
  const browseXml = `
    <HostDatastoreBrowserSearchResults>
      <folderPath>[ds1] vm-live</folderPath>
      <file xsi:type="VmConfigFileInfo"><path>vm-live.vmx</path><fileSize>3134</fileSize><modification>2026-01-01T00:00:00Z</modification></file>
      <file xsi:type="VmDiskFileInfo"><path>vm-live.vmdk</path><fileSize>569</fileSize><modification>2026-01-01T00:00:00Z</modification></file>
    </HostDatastoreBrowserSearchResults>`;
  const { files } = parseDsSearchResults(browseXml);
  const r = findOrphanDisks(files, ownedPathSet([]), { now: Date.parse('2026-09-13T00:00:00Z') });
  // vmx 가 있어 최소한 orphan 이 아니라 unregistered 로 분류된다(오삭제 위험 완화 1차 방어).
  assert.equal(r.disks[0].verdict, 'unregistered');
  // 그리고 신뢰도가 '신뢰 불가' 여야 한다(2차 방어) — 화면이 이 값을 결과 위에 표시한다.
  const c = confidenceOf({ dsVmCount: 1, vmsQueried: 0, vmsWithLayout: 0, ownedFiles: 0 });
  assert.equal(c.level, 'none');
});
