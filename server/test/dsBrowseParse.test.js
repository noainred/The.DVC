import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMorefs, parseDsSearchResults } from '../src/vcenter/soapParse.js';

test('parseMorefs: 타입 필터 + 빈 입력 안전', () => {
  const xml = `<ManagedObjectReference type="VirtualMachine" xsi:type="ManagedObjectReference">vm-101</ManagedObjectReference>
<ManagedObjectReference type="VirtualMachine">vm-102</ManagedObjectReference>
<ManagedObjectReference type="HostSystem">host-9</ManagedObjectReference>`;
  assert.deepEqual(parseMorefs(xml, 'VirtualMachine'), ['vm-101', 'vm-102']);
  assert.deepEqual(parseMorefs(xml, 'HostSystem'), ['host-9']);
  assert.deepEqual(parseMorefs('', 'VirtualMachine'), []);
  assert.deepEqual(parseMorefs(undefined, 'VirtualMachine'), []);
});

const RESULT_XML = `
<HostDatastoreBrowserSearchResults>
  <datastore type="Datastore">datastore-11</datastore>
  <folderPath>[DS01] vm1/</folderPath>
  <file xsi:type="VmDiskFileInfo"><path>vm1.vmdk</path><fileSize>107374182400</fileSize><modification>2026-08-01T10:00:00Z</modification></file>
  <file xsi:type="VmConfigFileInfo"><path>vm1.vmx</path><fileSize>3211</fileSize><modification>2026-08-02T11:00:00Z</modification></file>
  <file xsi:type="VmLogFileInfo"><path>vmware.log</path><fileSize>123456</fileSize><modification>2026-08-03T12:00:00Z</modification></file>
</HostDatastoreBrowserSearchResults>
<HostDatastoreBrowserSearchResults>
  <folderPath>[DS01] iso/</folderPath>
  <file xsi:type="IsoImageFileInfo"><path>rocky9.iso</path><fileSize>1073741824</fileSize><modification>2026-01-01T00:00:00Z</modification></file>
  <file xsi:type="FileInfo"><path>notes.txt</path><fileSize>10</fileSize><modification>2026-01-02T00:00:00Z</modification></file>
</HostDatastoreBrowserSearchResults>`;

test('parseDsSearchResults: 폴더별 파일 평탄화 + 유형/크기/수정 파싱', () => {
  const { files, truncated } = parseDsSearchResults(RESULT_XML);
  assert.equal(truncated, false);
  assert.equal(files.length, 5);
  assert.deepEqual(files[0], { folder: '[DS01] vm1/', name: 'vm1.vmdk', type: 'VmDisk', sizeBytes: 107374182400, modified: '2026-08-01T10:00:00Z' });
  assert.equal(files[1].type, 'VmConfig');
  assert.equal(files[3].folder, '[DS01] iso/');
  assert.equal(files[3].type, 'IsoImage');
  assert.equal(files[4].type, 'File'); // 접미사 제거 후 빈 문자열 → 'File'
});

test('parseDsSearchResults: cap 상한 + truncated 플래그', () => {
  const { files, truncated } = parseDsSearchResults(RESULT_XML, 3);
  assert.equal(files.length, 3);
  assert.equal(truncated, true);
  assert.deepEqual(parseDsSearchResults(''), { files: [], truncated: false });
});
