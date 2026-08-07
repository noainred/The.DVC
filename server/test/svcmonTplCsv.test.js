/**
 * 점검 템플릿 CSV 가져오기/내보내기(svcmon/templatesCsv.js) — 왕복 안정성·그룹핑·skip·기본값.
 * 임시 CONFIG_DIR 만 쓰며 외부 네트워크에 의존하지 않는다.
 *
 * 주의: `config.configDir` 은 모듈 로드 시점에 고정되므로 CONFIG_DIR 은 **import 전에** 세운다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-tplcsv-'));
process.env.SVCMON_WORKERS = '0';

const tpl = await import('../src/svcmon/templates.js');
const tcsv = await import('../src/svcmon/templatesCsv.js');
const schema = await import('../src/svcmon/testSchema.js');
const { parseCsvRows, CSV_BOM } = await import('../src/util/csv.js');

const HEAD = 'template_name,template_desc,template_kind,item_name,type,port,url,interval_sec,insecure';

/* ── 컬럼 파생 ── */

test('컬럼: 템플릿 3열 + TEST_FIELDS 파생(name/enabled 개명), key·test_name 열 없음', () => {
  assert.deepEqual(tcsv.TPL_CSV_COLUMNS.slice(0, 3), ['template_name', 'template_desc', 'template_kind']);
  assert.equal(tcsv.TPL_CSV_COLUMNS.length, 3 + schema.TEST_FIELDS.length, '항목 열은 스키마에서 파생');
  assert.equal(new Set(tcsv.TPL_CSV_COLUMNS).size, tcsv.TPL_CSV_COLUMNS.length, '컬럼명 중복 금지');
  // 대상 CSV 와 겹치는 헤더 금지(잘못 업로드한 파일을 필수 컬럼 검사가 잡아내게)
  assert.ok(tcsv.TPL_CSV_COLUMNS.includes('item_name'));
  assert.ok(tcsv.TPL_CSV_COLUMNS.includes('item_enabled'));
  assert.ok(!tcsv.TPL_CSV_COLUMNS.includes('test_name'));
  assert.ok(!tcsv.TPL_CSV_COLUMNS.includes('test_enabled'));
  // item.key 는 내보내지 않는다(가져오기가 새 key 발급 — 원본 적용분 덮어쓰기 방지)
  assert.ok(!tcsv.TPL_CSV_COLUMNS.includes('key'));
  // 개명 2개 외에는 스키마 컬럼명 그대로여야 한다
  for (const f of schema.TEST_FIELDS) {
    if (f.key === 'name' || f.key === 'enabled') continue;
    assert.ok(tcsv.TPL_CSV_COLUMNS.includes(f.col), `${f.col} 누락`);
  }
});

/* ── T1 왕복 ── */

test('T1 내보내기→가져오기 왕복: 항목 값 동일(key 제외), 치환 변수 {host} 보존', () => {
  const made = tpl.addTemplate({
    name: 'T1-왕복', desc: '왕복 검증', kind: 'service',
    items: [
      { name: 'HTTP {name}', type: 'http', url: 'https://{host}/health', keyword: 'ok', expectStatus: 200, warnMs: 3000, intervalSec: 120 },
      { name: '인증서', type: 'cert', port: 443, warnDays: 14, intervalSec: 86400, enabled: false },
      { name: 'DNS', type: 'dns', record: '{host}', server: '{host}', intervalSec: 300 },
    ],
  }, { user: 'tester' });
  const csv = tcsv.templatesToCsv([made]);
  assert.ok(csv.startsWith(CSV_BOM), '엑셀 한글을 위해 BOM 필수');
  assert.ok(csv.includes('{host}'), '치환 변수가 수식가드와 충돌 없이 그대로 실린다');
  for (const it of made.items) assert.ok(!csv.includes(it.key), 'item.key 는 내보내지 않는다');

  const parsed = tcsv.parseTemplatesCsv(csv);
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.equal(parsed.templates.length, 1);
  assert.equal(parsed.rowCount, 3, '항목 1건 = 1행');

  parsed.templates[0].name = 'T1-왕복-사본';   // 같은 이름은 skip 이므로 이름을 바꿔 실제 등록
  const r = tcsv.importTemplates(parsed, { mode: 'add', user: 'tester' });
  assert.equal(r.create, 1, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);

  const copy = tpl.listTemplates().find((t) => t.name === 'T1-왕복-사본');
  const strip = (x) => { const { key, ...rest } = x; return rest; };
  assert.deepEqual(copy.items.map(strip), made.items.map(strip), 'key 제외 항목 값 동일');
  assert.equal(copy.items[0].url, 'https://{host}/health');
  assert.equal(copy.items[0].name, 'HTTP {name}');
  assert.equal(copy.items[2].record, '{host}');
  assert.equal(copy.desc, '왕복 검증');
  assert.equal(copy.kind, 'service');
  // key 는 새로 발급된다(원본 템플릿의 적용분을 덮어쓰지 않게)
  const oldKeys = new Set(made.items.map((x) => x.key));
  for (const it of copy.items) assert.ok(!oldKeys.has(it.key), '가져오기는 원본 key 를 승계하지 않는다');
});

/* ── T2 그룹핑 ── */

test('T2 같은 이름 2행 → 템플릿 1개로 그룹핑', () => {
  const csv = [HEAD,
    'G1,같은 설명,infra,포트80,tcp,80,,120,',
    'G1,같은 설명,infra,포트443,tcp,443,,120,',
  ].join('\r\n');
  const r = tcsv.parseTemplatesCsv(csv);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.templates.length, 1, '2행 → 템플릿 1개');
  assert.equal(r.templates[0].items.length, 2);
  assert.equal(r.templates[0]._row, 2, '_row 는 처음 나온 CSV 행 번호');
});

test('T2 같은 이름 행의 desc/kind 불일치는 오류(추측 금지) — 그 행만 버린다', () => {
  const csv = [HEAD,
    'G2,설명A,infra,포트80,tcp,80,,120,',
    'G2,설명B,infra,포트443,tcp,443,,120,',   // desc 불일치
    'G2,설명A,service,포트22,tcp,22,,120,',   // kind 불일치
  ].join('\r\n');
  const r = tcsv.parseTemplatesCsv(csv);
  assert.equal(r.errors.length, 2);
  assert.equal(r.errors[0].row, 3);
  assert.match(r.errors[0].reason, /template_desc 가 앞 행/);
  assert.equal(r.errors[1].row, 4);
  assert.match(r.errors[1].reason, /template_kind 가 앞 행/);
  assert.equal(r.templates[0].items.length, 1, '불일치 행의 항목은 담지 않는다');
});

/* ── T3 미지값 ── */

test('T3 미지 type·미지 kind 오류 — 행 번호는 빈 행 제외 레코드 순번(헤더=1)', () => {
  const csv = [HEAD,
    'K1,,network,x,tcp,80,,120,',   // 2행: 미지 kind
    'K2,,infra,y,disk,,,120,',      // 3행: 미지 type
    'K3,,infra,z,,,,120,',          // 4행: item_name 만 있고 type 없음
    ',,infra,w,tcp,80,,120,',       // 5행: 이름 없음
  ].join('\r\n');
  const r = tcsv.parseTemplatesCsv(csv);
  assert.equal(r.errors.length, 4);
  assert.deepEqual(r.errors.map((e) => e.row), [2, 3, 4, 5]);
  assert.match(r.errors[0].reason, /template_kind 는 infra\/service/);
  assert.match(r.errors[1].reason, /알 수 없는 유형: disk/);
  assert.match(r.errors[2].reason, /type 이 필요/);
  assert.match(r.errors[3].reason, /template_name 이 비어/);
  // kind 오류 행은 템플릿을 만들지 않는다. type 오류 행은 템플릿(항목 0)만 남는다.
  assert.deepEqual(r.templates.map((t) => t.name), ['K2', 'K3']);
  assert.equal(r.templates[0].items.length, 0);
});

test('필수 컬럼(template_name) 누락은 헤더 오류 — 대상 CSV 를 잘못 올린 경우를 잡는다', () => {
  const r = tcsv.parseTemplatesCsv('kind,path,target_name,host\r\ninfra,A,srv1,10.0.0.1\r\n');
  assert.equal(r.templates.length, 0);
  assert.equal(r.errors[0].row, 1);
  assert.match(r.errors[0].reason, /필수 컬럼이 없습니다: template_name/);
});

test('알 수 없는 컬럼은 조용히 무시하지 않고 보고, 행 상한 초과는 오류', () => {
  const r = tcsv.parseTemplatesCsv('template_name,비고,owner\r\nU1,메모,x\r\n');
  assert.deepEqual(r.unknownColumns, ['비고', 'owner']);
  assert.equal(r.templates.length, 1);

  const body = Array.from({ length: 20 }, (_, i) => `R${i},,,p${i},ping,,,120,`).join('\r\n');
  const over = tcsv.parseTemplatesCsv(`${HEAD}\r\n${body}`, { maxRows: 5 });
  assert.equal(over.templates.length, 0);
  // 내부 헤더 보정(+1)을 노출하지 않는다 — '최대 6행'이 아니라 데이터 행 기준으로 말한다.
  assert.match(over.errors[0].reason, /데이터 행이 최대 5행.*헤더 제외/);
});

/* ── 행 번호 규약: 빈 행 제외 레코드 순번 ── */

test('행 번호는 빈 행 제외 레코드 순번 — 빈 줄·멀티라인 셀이 끼면 원본 줄 번호와 다르다', () => {
  // 빈 줄 1개: 원본 텍스트 4번째 줄의 오류가 레코드 순번 3으로 보고된다(빈 레코드는 걸러짐).
  const a = tcsv.parseTemplatesCsv([HEAD, '', 'A,,infra,p,tcp,80,,120,', 'B,,badkind,q,tcp,80,,120,'].join('\r\n'));
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0].reason, /template_kind/);
  assert.equal(a.errors[0].row, 3, '빈 행은 레코드 수에 들어가지 않는다');
  // 따옴표 안 줄바꿈(멀티라인 desc): 원본 2줄이 1레코드 — 다음 행 오류도 레코드 순번 3.
  const b = tcsv.parseTemplatesCsv([HEAD, 'A,"줄1\n줄2",infra,p,tcp,80,,120,', 'B,,badkind,q,tcp,80,,120,'].join('\r\n'));
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0].row, 3, '멀티라인 셀은 1레코드로 센다');
  assert.equal(b.templates[0].desc, '줄1\n줄2', '멀티라인 desc 는 값 그대로 파싱된다');
});

/* ── 수식가드 셀 상한 경계 ── */

test('저장 상한(4000자) body 가 = 로 시작해도 내보내기→가져오기 왕복된다(가드 접두 +1자 여유)', () => {
  const body = '=' + 'x'.repeat(3999);                 // 저장 상한 4000자 정확히, 수식가드 대상 문자로 시작
  const made = tpl.addTemplate({
    name: 'R1-가드경계', desc: '', kind: 'service',
    items: [{ name: 'SOAP', type: 'soap', url: 'https://{host}/x', body, intervalSec: 120 }],
  });
  assert.equal(made.items[0].body.length, 4000, '저장은 4000자를 허용한다');

  const csv = tcsv.templatesToCsv([made]);             // guardCell 이 ' 를 붙여 셀이 4001자가 된다
  const p = tcsv.parseTemplatesCsv(csv);
  assert.equal(p.errors.length, 0, `과거: maxCell 4000 으로 파일 전체 거부 — ${JSON.stringify(p.errors)}`);
  assert.equal(p.templates.length, 1);
  assert.equal(p.templates[0].items[0].body, body, '수식가드가 벗겨져 원문 그대로 돌아온다');

  // 상한 자체는 살아 있다 — 가드 여유(+1)를 넘는 셀은 여전히 파일 거부.
  const bigHead = 'template_name,template_desc,template_kind,item_name,type,url,interval_sec,body';
  const over = tcsv.parseTemplatesCsv([bigHead, `X,,service,s,soap,https://a/x,120,${'y'.repeat(4002)}`].join('\r\n'));
  assert.equal(over.templates.length, 0);
  assert.match(over.errors[0].reason, /최대 4001자/);
});

/* ── item_name 만 빈 항목 행 ── */

test('item_name 만 비어 있고 다른 항목 값이 있는 행은 조용히 버리지 않고 오류로 보고한다', () => {
  const r = tcsv.parseTemplatesCsv([HEAD, 'S1,,infra,,tcp,443,,120,'].join('\r\n'));
  assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
  assert.equal(r.errors[0].row, 2);
  assert.match(r.errors[0].reason, /item_name 이 비어 있는데 항목 값/);
  assert.match(r.errors[0].reason, /type, interval_sec, port/, '어떤 열에 값이 남았는지 알려준다(TEST_FIELDS 순서)');
  assert.equal(r.templates.length, 1, '템플릿 행 자체는 남는다(type 오류 행과 같은 규칙)');
  assert.equal(r.templates[0].items.length, 0, '이름 없는 항목을 지어내지 않는다');

  // 항목 열이 전부 빈 행(항목 0개 템플릿 행)은 여전히 오류가 아니다 — T8 왕복 규약 유지.
  const ok = tcsv.parseTemplatesCsv([HEAD, 'S2,,infra,,,,,,'].join('\r\n'));
  assert.equal(ok.errors.length, 0, JSON.stringify(ok.errors));
  assert.equal(ok.templates[0].items.length, 0);
});

/* ── 기본 행 상한 = 내보내기 최대 규모 ── */

test('내보내기 최대 규모(MAX_TEMPLATES×MAX_ITEMS 행)가 기본 옵션으로 재가져와진다', () => {
  assert.equal(tcsv.DEFAULT_MAX_ROWS, tpl.MAX_TEMPLATES * tpl.MAX_ITEMS, '기본 상한은 저장 상한 곱에서 파생');
  const templates = Array.from({ length: tpl.MAX_TEMPLATES }, (_, t) => ({
    name: `R3-${t}`, desc: '', kind: 'infra',
    items: Array.from({ length: tpl.MAX_ITEMS }, (_, i) => (
      { name: `p${i}`, type: 'tcp', port: 80, intervalSec: 120, enabled: true })),
  }));
  const csv = tcsv.templatesToCsv(templates);
  const p = tcsv.parseTemplatesCsv(csv);               // 기본 옵션 — 가져오기 라우트와 같은 호출
  assert.equal(p.errors.length, 0, `과거: 기본 2000행으로 통째 거부 — ${JSON.stringify(p.errors.slice(0, 1))}`);
  assert.equal(p.templates.length, tpl.MAX_TEMPLATES);
  assert.equal(p.rowCount, tpl.MAX_TEMPLATES * tpl.MAX_ITEMS);

  // 1행 초과는 거부하되, 메시지는 데이터 행 기준(내부 헤더 보정 +1 노출 금지).
  const over = tcsv.parseTemplatesCsv(csv + 'R3-over,,infra,x,tcp,80,,120,\r\n');
  assert.equal(over.templates.length, 0);
  assert.match(over.errors[0].reason, new RegExp(`데이터 행이 최대 ${tcsv.DEFAULT_MAX_ROWS}행.*헤더 제외`));
});

/* ── T4 skip ── */

test('T4 이미 있는 이름은 skip — 2회 가져와도 템플릿 수 불변', () => {
  const csv = tcsv.templatesToCsv([{
    name: 'T4-유일', desc: '', kind: '',
    items: [{ name: 'p', type: 'ping', intervalSec: 120, enabled: true }],
  }]);
  const r1 = tcsv.importTemplates(tcsv.parseTemplatesCsv(csv), { mode: 'add' });
  assert.equal(r1.create, 1, JSON.stringify(r1.errors));
  const n = tpl.listTemplates().length;

  const r2 = tcsv.importTemplates(tcsv.parseTemplatesCsv(csv), { mode: 'add' });
  assert.equal(r2.create, 0);
  assert.equal(r2.skip, 1);
  assert.equal(r2.results[0].action, 'skip');
  assert.equal(tpl.listTemplates().length, n, '조용한 덮어쓰기 금지 — 수가 늘지도 줄지도 않는다');

  // 대소문자만 다른 이름도 중복으로 본다(그룹핑과 같은 규칙)
  const r3 = tcsv.importTemplates(tcsv.parseTemplatesCsv(csv.replace('T4-유일', 't4-유일')), { mode: 'add' });
  assert.equal(r3.skip, 1);
  assert.equal(tpl.listTemplates().length, n);
});

test('preview 는 addTemplate 를 호출하지 않고, 실제 검증은 등록 시임을 명시한다', () => {
  // {bogus} 는 파싱 수준에서는 오류가 아니다 — 치환 변수 검증은 addTemplate(cleanItem)에 있다.
  const csv = [HEAD, 'PV-미리보기,,service,헬스,http,,https://{bogus}/x,120,'].join('\r\n');
  const p = tcsv.parseTemplatesCsv(csv);
  assert.equal(p.errors.length, 0, '파싱 수준에서는 통과한다');

  const before = tpl.listTemplates().length;
  const pv = tcsv.importTemplates(p, { mode: 'preview' });
  assert.equal(pv.mode, 'preview');
  assert.equal(pv.create, 1, 'preview 의 create 는 파싱 수준 판정이다');
  assert.equal(tpl.listTemplates().length, before, 'preview 는 저장소를 건드리지 않는다');
  assert.match(pv.notice, /등록 시/, 'preview 통과 ≠ 등록 성공을 결과에 명시(과장 금지)');

  // 같은 입력이 add 에서는 실패한다 — notice 가 거짓 안심이 아님을 실제로 확인
  const r = tcsv.importTemplates(p, { mode: 'add' });
  assert.equal(r.create, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /치환 변수/);
  assert.equal(r.errors[0].row, 2, '등록 오류도 CSV 행 번호로 돌려준다');
  assert.equal(tpl.listTemplates().length, before);
});

/* ── T5 빈 셀 → 기본값 ── */

test('T5 빈 셀은 키를 만들지 않고 addTemplate 기본값이 적용된다', () => {
  const csv = [HEAD, 'T5-기본값,,service,헬스,http,,https://{host}/health,,'].join('\r\n');
  const p = tcsv.parseTemplatesCsv(csv);
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  const item = p.templates[0].items[0];
  assert.equal(Object.hasOwn(item, 'intervalSec'), false, '파서는 빈 셀을 넘기지 않는다');
  assert.equal(Object.hasOwn(item, 'insecure'), false);
  assert.equal(Object.hasOwn(item, 'port'), false);

  const r = tcsv.importTemplates(p, { mode: 'add' });
  assert.equal(r.create, 1, JSON.stringify(r.errors));
  const saved = tpl.listTemplates().find((t) => t.name === 'T5-기본값');
  assert.equal(saved.items[0].intervalSec, 60, '기본값은 addTemplate(refineTest)가 채운다');
  assert.equal(saved.items[0].enabled, true);
  assert.equal(saved.items[0].insecure, false);
  assert.equal(saved.items[0].expectStatus, undefined, 'optional 필드는 미지정으로 남는다');
});

/* ── T6 수식가드 ── */

test('T6 수식가드 왕복 누적 없음 — 3회 반복해도 값이 자라지 않는다', () => {
  const src = [{
    name: '=수식 템플릿', desc: '-대시 설명', kind: '',
    items: [{ name: '-dash', type: 'tcp', port: 80, intervalSec: 60, enabled: true }],
  }];
  let csv = tcsv.templatesToCsv(src);
  const rows = parseCsvRows(csv);
  assert.equal(rows[1][0], "'=수식 템플릿", '내보내기 셀에는 수식가드가 붙는다');
  assert.equal(rows[1][1], "'-대시 설명");
  for (let i = 0; i < 3; i += 1) {
    const p = tcsv.parseTemplatesCsv(csv);
    assert.equal(p.errors.length, 0);
    assert.equal(p.templates[0].name, '=수식 템플릿');
    assert.equal(p.templates[0].desc, '-대시 설명');
    assert.equal(p.templates[0].items[0].name, '-dash');
    csv = tcsv.templatesToCsv(p.templates);
  }
});

/* ── T7 샘플 ── */

test('T7 샘플이 오류 없이 파싱·등록된다', () => {
  const csv = tcsv.sampleTemplatesCsv();
  assert.ok(csv.startsWith(CSV_BOM));
  const rows = parseCsvRows(csv);
  assert.deepEqual(rows[0], tcsv.TPL_CSV_COLUMNS, '샘플 헤더가 컬럼 정의와 어긋나면 안내가 거짓이 된다');

  const p = tcsv.parseTemplatesCsv(csv);
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  assert.equal(p.templates.length, 2);

  const before = tpl.listTemplates().length;
  const r = tcsv.importTemplates(p, { mode: 'add', user: 'sample' });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.create, 2, '빌트인과 이름이 겹치면 skip 이 되어 샘플이 무용해진다');
  assert.equal(tpl.listTemplates().length, before + 2);
  // 가짜 조직값 금지 — example.com 만
  assert.ok(!/lge|lgcns|corp\.local/i.test(csv));
  assert.match(csv, /example\.com/);
  // 등록된 샘플이 상한 규칙(ping 1개)을 지킨다
  for (const t of p.templates) {
    const made = tpl.listTemplates().find((x) => x.name === t.name);
    assert.ok(made.items.filter((x) => x.type === 'ping').length <= tpl.MAX_PING_ITEMS);
  }
});

/* ── T8 항목 0개 ── */

test('T8 항목 0개 템플릿 왕복 — 1행(항목 열 빈칸)으로 나가고 그대로 돌아온다', () => {
  const made = tpl.addTemplate({ name: 'T8-빈', desc: '항목 없음', kind: 'infra', items: [] });
  const csv = tcsv.templatesToCsv([made]);
  const rows = parseCsvRows(csv);
  assert.equal(rows.length, 2, '헤더 + 템플릿 1행');
  assert.equal(rows[1][tcsv.TPL_CSV_COLUMNS.indexOf('item_name')], '');
  assert.equal(rows[1][tcsv.TPL_CSV_COLUMNS.indexOf('type')], '');

  const p = tcsv.parseTemplatesCsv(csv);
  assert.equal(p.errors.length, 0, JSON.stringify(p.errors));
  assert.equal(p.templates.length, 1);
  assert.equal(p.templates[0].items.length, 0);

  p.templates[0].name = 'T8-빈-사본';
  const r = tcsv.importTemplates(p, { mode: 'add' });
  assert.equal(r.create, 1, JSON.stringify(r.errors));
  const copy = tpl.getTemplate(r.results.find((x) => x.action === 'create').id);
  assert.equal(copy.items.length, 0);
  assert.equal(copy.desc, '항목 없음');
  assert.equal(copy.kind, 'infra');
});
