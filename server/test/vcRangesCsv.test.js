import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vcRangesToCsv, sampleCsv, parseVcRangesCsv, analyzeVcRangesImport, CSV_COLUMNS } from '../src/ipam/vcRangesCsv.js';

const NAME = { vc1: '서울-vc01', vc2: 'PL-Warsaw' };
const deps = (existing = []) => ({
  resolveVc: (v) => {
    const s = String(v || '').trim();
    if (NAME[s]) return s; // id 직접
    const hit = Object.entries(NAME).find(([, n]) => n.toLowerCase() === s.toLowerCase());
    return hit ? hit[0] : null;
  },
  hasExisting: (id) => existing.includes(id),
});

test('내보내기 → 가져오기 라운드트립: 대역·enabled 보존', () => {
  const entries = [
    { vcenterId: 'vc1', ranges: ['10.0.0.0/24', '10.0.1.1-50'], enabled: true },
    { vcenterId: 'vc2', ranges: ['172.16.5.0/26'], enabled: false },
  ];
  const csv = vcRangesToCsv(entries, (id) => NAME[id] || id);
  assert.ok(csv.includes(CSV_COLUMNS.join(',')));
  const { rows, error } = parseVcRangesCsv(csv);
  assert.equal(error, undefined);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].ranges, ['10.0.0.0/24', '10.0.1.1-50']);
  assert.equal(rows[0].vcenter, '서울-vc01');
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[1].enabled, false);
  // 라운드트립 판정: 이름으로 해석 → id, 기존 유무에 따라 add/overwrite
  const { report, summary } = analyzeVcRangesImport(rows, deps(['vc2']));
  assert.equal(summary.error, 0);
  assert.equal(report[0].action, 'add');
  assert.equal(report[0].vcId, 'vc1');
  assert.equal(report[1].action, 'overwrite');
});

test('샘플 CSV: 주석 행은 스킵되고 예시 2행이 파싱된다', () => {
  const { rows, error } = parseVcRangesCsv(sampleCsv());
  assert.equal(error, undefined);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].enabled, false);
});

test('필수 헤더 없으면 오류', () => {
  const { rows, error } = parseVcRangesCsv('foo,bar\r\na,b\r\n');
  assert.equal(rows.length, 0);
  assert.match(error, /필수 헤더/);
});

test('검증: 미등록 vCenter·대역 문법 오류·파일 내 중복은 error 판정', () => {
  const csv = [
    'vcenter,ranges,enabled',
    '없는vc,10.0.0.0/24,true',        // 미등록 vCenter
    '서울-vc01,abc; 10.0.0.0/24,true', // 문법 오류 spec 포함
    'vc2,172.16.5.0/26,true',
    'PL-Warsaw,172.16.9.0/28,true',    // vc2 와 같은 vCenter(이름) — 파일 내 중복
    'vc1,,true',                        // 빈 대역
  ].join('\r\n');
  const { rows } = parseVcRangesCsv(csv);
  // 빈 대역 행은 vcenter 만 있으므로 파싱은 되고(스킵 아님) 검증에서 걸린다.
  assert.equal(rows.length, 5);
  const { report, summary } = analyzeVcRangesImport(rows, deps());
  assert.equal(summary.error, 4);
  assert.equal(summary.add, 1);
  assert.match(report[0].reason, /알 수 없는 vCenter/);
  assert.match(report[1].reason, /대역 문법 오류: 'abc'/);
  assert.equal(report[2].action, 'add');
  assert.match(report[3].reason, /파일 내 중복/);
  assert.match(report[4].reason, /비어 있음/);
});

test('enabled 별칭: false/0/제외 → false, 빈값 → true', () => {
  const csv = ['vcenter,ranges,enabled', 'vc1,10.0.0.1,제외', 'vc2,10.0.0.2,', 'PL-Warsaw,10.0.0.3,0'].join('\n');
  const { rows } = parseVcRangesCsv(csv);
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[1].enabled, true);
  assert.equal(rows[2].enabled, false);
});

test('수식 가드 왕복: 가드된 셀이 가져오기에서 원복된다(따옴표 증식 없음)', () => {
  // '-'로 시작하는 범위 spec 은 실사용에 없지만, guardCell 대상 셀(vcenter 이름)로 검증
  const entries = [{ vcenterId: 'vc1', ranges: ['10.0.0.1'], enabled: true }];
  const csv = vcRangesToCsv(entries, () => '=수식vc');
  const { rows } = parseVcRangesCsv(csv);
  assert.equal(rows[0].vcenter, '=수식vc');
});
