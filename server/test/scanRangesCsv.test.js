// iDRAC 스캔 대역 CSV(v2.339) 단위테스트 — 세미콜론 대역 직렬화/파싱·법인 해석 실패 오류·
// 대역 문법 검증(expandIpList 재사용)·(법인,서비스) 덮어쓰기/모호 판정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRangesToCsv, sampleCsv, parseScanRangesCsv, analyzeScanRangesImport } from '../src/idrac/scanRangesCsv.js';

const ENTRIES = [
  { datacenterId: 'az', service: '', ranges: ['192.168.88.0/26', '192.168.88.100-110'], username: 'root', agent: 'AZ', dispatch: 'poll', enabled: true, mode: 'merge', password: 'pw-1' },
  { datacenterId: 'az', service: 'AZ IRS MGMT', ranges: ['192.168.89.10'], username: 'root', agent: 'AZ-IRS', dispatch: 'push', enabled: true, mode: 'merge', password: '' },
];
const dcName = (id) => ({ az: 'AZ' }[id] || id);
const DEPS = {
  resolveDc: (v) => ({ az: 'az', AZ: 'az' }[String(v).trim()] || null),
  existingIds: (dcId, service) => (dcId === 'az' && !service ? ['e-1'] : []),
};

test('scanRangesToCsv: 대역은 ; 직렬화, 비밀번호는 기본 제외', () => {
  const csv = scanRangesToCsv(ENTRIES, dcName);
  assert.ok(csv.includes('192.168.88.0/26; 192.168.88.100-110'));
  assert.ok(!csv.includes('pw-1'));
  assert.ok(scanRangesToCsv(ENTRIES, dcName, { includeSecrets: true }).includes('pw-1'));
});

test('parseScanRangesCsv: ;/줄바꿈 대역 분리·dispatch/mode 정규화, 샘플 왕복', () => {
  const { rows } = parseScanRangesCsv('datacenter,ranges,dispatch,mode\nAZ,10.0.0.0/28; 10.0.0.30,PUSH,replace-datacenter');
  assert.deepEqual(rows[0].ranges, ['10.0.0.0/28', '10.0.0.30']);
  assert.equal(rows[0].dispatch, 'push');
  assert.equal(rows[0].mode, 'replace-datacenter');
  const s = parseScanRangesCsv(sampleCsv());
  assert.equal(s.error, undefined);
  assert.equal(s.rows.length, 2, '주석 행은 걸러진다');
  assert.ok(parseScanRangesCsv('service,username\nx,y').error, 'datacenter/ranges 헤더 없으면 오류');
});

test('analyzeScanRangesImport: 법인 미해석·대역 문법 오류·겹침 판정', () => {
  const { rows } = parseScanRangesCsv(['datacenter,service,ranges',
    'AZ,,10.0.0.0/28',              // 기존 (az,'') → overwrite
    'AZ,MGMT,10.0.0.1-5',           // 신규 → add
    'NOPE,,10.0.0.1',               // 법인 미해석 → error
    'AZ,BAD,999.1.2.3/99'].join('\n')); // 대역 문법 → error
  const { report, summary } = analyzeScanRangesImport(rows, DEPS);
  assert.deepEqual(summary, { add: 1, overwrite: 1, error: 2, withPassword: 0 });
  assert.equal(report[0].action, 'overwrite');
  assert.match(report[2].reason, /알 수 없는 법인/);
  assert.match(report[3].reason, /대역 문법 오류/);
});

test('analyzeScanRangesImport: 파일 내 중복 + 기존 2건 이상 모호 판정', () => {
  const { rows } = parseScanRangesCsv(['datacenter,service,ranges',
    'AZ,DUP,10.0.0.1',
    'az,dup,10.0.0.2'].join('\n')); // 같은 (법인,서비스) 재등장 → error
  const r1 = analyzeScanRangesImport(rows, DEPS);
  assert.match(r1.report[1].reason, /파일 내 중복/);
  const r2 = analyzeScanRangesImport(parseScanRangesCsv('datacenter,ranges\nAZ,10.0.0.1').rows,
    { ...DEPS, existingIds: () => ['a', 'b'] });
  assert.match(r2.report[0].reason, /모호/);
});
