import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'osinv-'));
const { classifyOs } = await import('../src/inventory/osDetect.js');
const { computeMismatch } = await import('../src/inventory/osStore.js');

test('classifyOs: 배포판 계열 분류', () => {
  assert.equal(classifyOs('Rocky Linux 9.4'), 'Rocky');
  assert.equal(classifyOs('CentOS Linux 7 (Core)'), 'CentOS');
  assert.equal(classifyOs('Red Hat Enterprise Linux 8.6'), 'RHEL');
  assert.equal(classifyOs('Ubuntu 22.04.3 LTS'), 'Ubuntu');
  assert.equal(classifyOs('Microsoft Windows Server 2019'), 'Windows');
  assert.equal(classifyOs('Oracle Linux Server 8.8'), 'Oracle');
});

test('computeMismatch: 계열 다르면 불일치(ESXi=CentOS, 실제=Rocky)', () => {
  assert.equal(computeMismatch('CentOS 7 (64-bit)', { os: 'Rocky Linux 9.4', family: 'Rocky', osVersion: '9.4' }), true);
});

test('computeMismatch: 메이저 버전 다르면 불일치(CentOS7→CentOS8)', () => {
  assert.equal(computeMismatch('CentOS 7 (64-bit)', { os: 'CentOS Linux 8', family: 'CentOS', osVersion: '8' }), true);
});

test('computeMismatch: 같은 계열·버전이면 일치', () => {
  assert.equal(computeMismatch('CentOS 7 (64-bit)', { os: 'CentOS Linux 7 (Core)', family: 'CentOS', osVersion: '7' }), false);
});

test('computeMismatch: 탐지값 없으면 불일치 아님', () => {
  assert.equal(computeMismatch('CentOS 7 (64-bit)', null), false);
});
