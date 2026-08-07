/**
 * 성능점검 대량 등록 이력 원장(svcmon/batches.js) — T31~T46.
 * 임시 CONFIG_DIR 만 쓰고 외부 네트워크에 접근하지 않는다(대상 host 는 RFC1918 고정).
 *
 * T38~T46 은 검증에서 실측으로 재현된 결함의 회귀 테스트다(부분 커밋·전 필드 덮어쓰기·
 * 롤백 흔적 주입·형태만 다른 유효 JSON·반환값 aliasing·잘못된 ID·정렬).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.configDir 은 모듈 로드 시점에 고정된다 — import 보다 **먼저** 설정해야 한다.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmon-batches-'));
process.env.CONFIG_DIR = DIR;
process.env.SVCMON_WORKERS = '0';

const store = await import('../src/svcmon/store.js');
const batches = await import('../src/svcmon/batches.js');

const FILE = path.join(DIR, 'svcmon-batches.json');
const STORE_FILE = path.join(DIR, 'svcmon.json');

const corruptFiles = () => fs.readdirSync(DIR).filter((f) => f.startsWith('svcmon-batches.json.corrupt.'));
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8')).batches;

/** 원장만 초기화(등록된 대상은 그대로 — 테스트끼리 배치 ID·경로를 겹치지 않게 쓴다). */
function freshLedger() {
  try { fs.unlinkSync(FILE); } catch { /* 없으면 무시 */ }
  // 손상 보존 백업은 테스트마다 개수를 단정하므로 남기지 않는다.
  for (const f of corruptFiles()) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  batches._resetBatchCache();
}

let seq = 0;
/** 배치 태그를 붙여 대상 n개(각 tests개 점검)를 등록한다. 경로는 호출마다 유일. */
function seed(batchId, n, { tests = 1 } = {}) {
  seq += 1;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      kind: 'infra',
      path: `T${seq}`,
      name: `${batchId}-${i}`,
      host: `192.168.${seq % 200}.${(i % 250) + 1}`,
      tests: Array.from({ length: tests }, (_, j) => ({ name: `p${j}`, type: 'ping' })),
    });
  }
  const r = store.bulkAddTargets(rows, { batch: batchId });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.equal(r.added, n);
  return r;
}

const withBatch = (id) => store.listTargets().filter((t) => t.batch === id);

/* ── T31 ── */
test('T31 배치 롤백은 그 배치의 대상만 지운다(다른 배치·수동 등록은 남는다)', () => {
  freshLedger();
  const A = 'b-aaaa0001';
  const B = 'b-bbbb0002';
  seed(A, 3, { tests: 2 });
  seed(B, 2);
  const manual = store.addTarget({ kind: 'infra', path: 'Manual', name: 'manual-1', host: '192.168.200.7' });
  batches.recordBatch({ id: A, source: 'import', targets: 3, tests: 6, createdBy: 'tester', path: 'T1' });
  batches.recordBatch({ id: B, source: 'generate', targets: 2, tests: 2 });
  // 출처는 저장된 값까지 단정한다 — 폴백으로 조용히 바뀌면 감사 원장이 오라벨링된다.
  assert.equal(batches.getBatch(A).source, 'import');
  assert.equal(batches.getBatch(B).source, 'generate');

  const before = store.listTargets().length;
  const r = batches.rollbackBatch(A, { expectedCount: 3, user: 'tester' });
  assert.equal(r.error, undefined);
  assert.equal(r.removed, 3);
  assert.equal(r.tests, 6);
  assert.equal(r.recorded, true);
  assert.equal(r.saved, true);
  assert.equal(r.ledgerSaved, true);
  assert.equal(store.listTargets().length, before - 3);
  assert.equal(withBatch(A).length, 0);
  assert.equal(withBatch(B).length, 2);          // 다른 배치는 그대로
  assert.ok(store.getTarget(manual.id));         // 수동 등록도 그대로

  // 원장에는 남는다(감사 흔적) — 등록 당시 수는 유지, 현재 수는 0
  const rec = batches.listBatches().find((b) => b.id === A);
  assert.ok(rec.rolledBackAt > 0);
  assert.equal(rec.rolledBackBy, 'tester');
  assert.equal(rec.targets, 3);
  assert.equal(rec.tests, 6);
  assert.equal(rec.liveTargets, 0);
  assert.equal(rec.liveTests, 0);
  // 파일에도 롤백 흔적이 남는다(재시작 후에도 재롤백을 막는 근거)
  assert.ok(onDisk().find((b) => b.id === A).rolledBackAt > 0);
});

/* ── T32 ── */
test('T32 expectedCount 불일치 → 아무것도 지우지 않고 오류', () => {
  freshLedger();
  const id = 'b-cccc0003';
  seed(id, 4);
  batches.recordBatch({ id, source: 'import', targets: 4, tests: 4 });

  const before = store.listTargets().length;
  const r = batches.rollbackBatch(id, { expectedCount: 9 });
  assert.match(r.error, /대상 수가 다릅니다/);
  assert.equal(r.removed, 0);
  assert.equal(r.tests, 0);
  assert.equal(store.listTargets().length, before);
  assert.equal(withBatch(id).length, 4);
  // 실패한 롤백은 원장에 흔적을 남기지 않는다(남기면 재시도가 '이미 롤백'으로 막힌다)
  assert.equal(batches.listBatches().find((b) => b.id === id).rolledBackAt, undefined);

  // 개수가 맞으면 지워진다
  const ok = batches.rollbackBatch(id, { expectedCount: 4 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.removed, 4);
  assert.equal(store.listTargets().length, before - 4);
});

/* ── T33 ── */
test('T33 최근 50건만 유지 — 먼저 기록된 것부터 버린다', () => {
  freshLedger();
  // 기대 개수는 **리터럴 50**으로 단정한다 — 상수를 그대로 기대값에 쓰면 값을 5로 줄여도
  // 통과하는 자기참조 테스트가 된다(회귀 보호 0).
  assert.equal(batches.MAX_BATCHES, 50);
  assert.deepEqual(batches.SOURCES, ['import', 'generate', 'template']);
  const ids = [];
  const base = Date.now() - 100000;
  for (let i = 0; i < batches.MAX_BATCHES + 5; i += 1) {
    const id = `b-keep${String(i).padStart(4, '0')}`;
    ids.push(id);
    batches.recordBatch({ id, source: 'import', targets: 1, tests: 1, createdAt: base + i });
  }
  const list = batches.listBatches({ withCounts: false });
  assert.equal(list.length, 50);
  assert.equal(list[0].id, ids[ids.length - 1]);                 // 최신순
  const kept = new Set(list.map((b) => b.id));
  for (const id of ids.slice(0, 5)) assert.ok(!kept.has(id), `${id} 는 버려져야 한다`);
  for (const id of ids.slice(5)) assert.ok(kept.has(id), `${id} 는 남아야 한다`);
  // 파일도 함께 잘린다(재시작 후 다시 55건으로 늘지 않게)
  assert.equal(onDisk().length, 50);
  // 재로드해도 상한 유지
  batches._resetBatchCache();
  assert.equal(batches.listBatches({ withCounts: false }).length, 50);
});

/* ── T34 ── */
test('T34 원장 파일 손상 → .corrupt.<ts> 보존 + 빈 목록으로 계속 동작', () => {
  freshLedger();
  batches.recordBatch({ id: 'b-before01', source: 'import', targets: 1, tests: 1 });
  fs.writeFileSync(FILE, '{ "batches": [ 이건 JSON 이 아니다');
  batches._resetBatchCache();

  assert.deepEqual(batches.listBatches(), []);
  const bak = corruptFiles();
  assert.equal(bak.length, 1);
  assert.match(fs.readFileSync(path.join(DIR, bak[0]), 'utf8'), /이건 JSON 이 아니다/);

  // 손상 이후에도 기록이 되고, 새 파일에는 손상본을 덮어쓴 흔적이 남지 않는다
  const rec = batches.recordBatch({ id: 'b-after001', source: 'generate', targets: 2, tests: 0 });
  assert.equal(rec.id, 'b-after001');
  assert.equal(onDisk().length, 1);
  assert.equal(onDisk()[0].id, 'b-after001');
});

/* ── T35 ── */
test('T35 listBatches 는 현재 남은 수(liveTargets)를 등록 당시 수와 별도로 보고', () => {
  freshLedger();
  const id = 'b-dddd0005';
  seed(id, 4, { tests: 2 });
  batches.recordBatch({ id, source: 'import', targets: 4, tests: 8 });

  // 사용자가 대상 1개를 개별 삭제 → 원장의 수와 실제가 어긋난다
  const victim = withBatch(id)[0];
  assert.equal(store.deleteTarget(victim.id), true);

  const rec = batches.listBatches().find((b) => b.id === id);
  assert.equal(rec.targets, 4);
  assert.equal(rec.tests, 8);
  assert.equal(rec.liveTargets, 3);
  assert.equal(rec.liveTests, 6);
  // withCounts:false 면 붙이지 않는다(집계 비용 회피 경로)
  const plain = batches.listBatches({ withCounts: false }).find((b) => b.id === id);
  assert.equal(plain.liveTargets, undefined);
  assert.equal(plain.liveTests, undefined);

  // 그래서 롤백은 남은 3개만 지운다 — liveTargets 가 없으면 사용자가 이 차이를 알 수 없다
  const r = batches.rollbackBatch(id, { expectedCount: 3 });
  assert.equal(r.error, undefined);
  assert.equal(r.removed, 3);
  assert.equal(r.tests, 6);
});

/* ── T36 ── */
test('T36 이미 롤백된 배치 재롤백 → 오류 / 원장 레코드 삭제는 대상을 건드리지 않는다', () => {
  freshLedger();
  const id = 'b-eeee0006';
  seed(id, 2);
  batches.recordBatch({ id, source: 'template', templateId: 'tpl-1', targets: 2, tests: 2 });
  assert.equal(batches.getBatch(id).source, 'template');
  assert.equal(batches.getBatch(id).templateId, 'tpl-1');

  assert.equal(batches.rollbackBatch(id, { user: 'op' }).removed, 2);
  const again = batches.rollbackBatch(id, { user: 'op' });
  assert.equal(again.removed, 0);
  assert.equal(again.tests, 0);
  assert.match(again.error, /이미 롤백/);
  assert.ok(batches.listBatches().some((b) => b.id === id));      // 목록에는 유지

  // 원장에 없는 배치도 롤백 가능(대상 태그가 진실의 원천) — recorded:false 로 알린다
  const orphan = 'b-eeee0007';
  seed(orphan, 1);
  const o = batches.rollbackBatch(orphan);
  assert.equal(o.removed, 1);
  assert.equal(o.recorded, false);

  // 원장 레코드만 삭제 — 대상 수는 변하지 않는다
  seed('b-eeee0008', 2);
  const n = store.listTargets().length;
  assert.equal(batches.deleteBatchRecord(id), true);
  assert.equal(batches.deleteBatchRecord(id), false);             // 두 번째는 false
  assert.equal(batches.getBatch(id), null);
  assert.equal(store.listTargets().length, n);
  assert.equal(withBatch('b-eeee0008').length, 2);
});

/* ── T37 ── */
test('T37 원장 기록 실패는 예외를 던지지 않는다(best-effort)', () => {
  freshLedger();
  assert.doesNotThrow(() => batches.recordBatch(null));

  // 알 수 없는 값은 기본값으로 떨어지고 예외가 되지 않는다.
  // source 는 'import' 로 바꾸지 않는다 — 없던 출처를 CSV 로 오라벨링하는 것이므로 ''(불명).
  const bad = batches.recordBatch({ source: 'no-such-source', targets: 'x', tests: -5, createdAt: 'nope', kind: 'nope' });
  assert.equal(bad.source, '');
  assert.equal(bad.targets, 0);
  assert.equal(bad.tests, 0);
  assert.equal(bad.kind, '');
  assert.ok(bad.createdAt > 0);
  assert.match(bad.id, /^b-[0-9a-f]{8}$/);

  // 디렉터리 쓰기 권한이 없어도 등록 경로를 막지 않는다.
  // (root 로 실행되면 쓰기가 그대로 성공하지만, 어느 쪽이든 예외는 없어야 한다.)
  const mode = fs.statSync(DIR).mode & 0o777;
  fs.chmodSync(DIR, 0o500);
  let rec = null;
  try {
    assert.doesNotThrow(() => { rec = batches.recordBatch({ id: 'b-ffff0009', source: 'import', targets: 1, tests: 1 }); });
  } finally {
    fs.chmodSync(DIR, mode);
  }
  assert.equal(rec.id, 'b-ffff0009');
  // 저장이 실패했어도 메모리에는 남아 다음 저장에 함께 기록된다
  assert.ok(batches.listBatches().some((b) => b.id === 'b-ffff0009'));
  assert.equal(batches.recordBatch({ id: 'b-ffff0010', source: 'import', targets: 1, tests: 1 }).id, 'b-ffff0010');
  const ids = onDisk().map((b) => b.id);
  assert.ok(ids.includes('b-ffff0009'));
  assert.ok(ids.includes('b-ffff0010'));
});

/* ── T38 ── */
test('T38 같은 id 재기록은 부분 병합 — 등록 시각·등록자·출처가 살아남는다', () => {
  freshLedger();
  const id = 'b-mrg00001';
  const first = batches.recordBatch({
    id, source: 'template', templateId: 'tpl-7', createdBy: 'alice',
    path: 'DC1\\WEB', kind: 'infra', note: '월간 점검 일괄', targets: 5, tests: 10, createdAt: 1000,
  });
  assert.equal(first.createdAt, 1000);

  // 수량만 다시 기록(재시도·건수 보정) — 나머지 필드가 기본값으로 전멸하면 감사 레코드가 파괴된다.
  const upd = batches.recordBatch({ id, targets: 12, tests: 36 });
  assert.equal(upd.targets, 12);
  assert.equal(upd.tests, 36);
  assert.equal(upd.createdAt, 1000, '등록 시각은 첫 기록을 유지해야 한다');
  assert.equal(upd.createdBy, 'alice');
  assert.equal(upd.source, 'template');
  assert.equal(upd.templateId, 'tpl-7');
  assert.equal(upd.path, 'DC1\\WEB');
  assert.equal(upd.kind, 'infra');
  assert.equal(upd.note, '월간 점검 일괄');
  // 반환값은 '저장된 레코드'여야 한다(라우트가 이 값으로 화면을 갱신한다)
  assert.deepEqual(upd, batches.getBatch(id));
  assert.equal(batches.listBatches({ withCounts: false }).length, 1);   // 행이 늘지 않는다
  assert.deepEqual(onDisk().find((b) => b.id === id).createdBy, 'alice');

  // 값이 undefined 인 키는 '주지 않은 것'으로 본다(`templateId: tplId` 패턴이 리셋이 되지 않게)
  batches.recordBatch({ id, templateId: undefined, note: undefined });
  assert.equal(batches.getBatch(id).templateId, 'tpl-7');
  assert.equal(batches.getBatch(id).note, '월간 점검 일괄');
});

/* ── T39 ── */
test('T39 호출부가 넘긴 롤백 흔적은 무시한다(감사 위조·롤백 봉인 차단)', () => {
  freshLedger();
  const id = 'b-inj00001';
  seed(id, 3);
  batches.recordBatch({ id, source: 'import', targets: 3, tests: 3, rolledBackAt: 1, rolledBackBy: 'alice' });
  const rec = batches.getBatch(id);
  assert.equal(rec.rolledBackAt, undefined);
  assert.equal(rec.rolledBackBy, undefined);
  assert.equal(onDisk().find((b) => b.id === id).rolledBackAt, undefined);

  // 주입이 통하면 여기서 '이미 롤백된 배치입니다' 로 영구 거부된다
  const r = batches.rollbackBatch(id, { expectedCount: 3, user: 'bob' });
  assert.equal(r.error, undefined);
  assert.equal(r.removed, 3);
  assert.equal(batches.getBatch(id).rolledBackBy, 'bob');       // 실제 롤백만 흔적을 남긴다
});

/* ── T40 ── */
test('T40 롤백 후 같은 id 로 다시 등록되면 되돌릴 수 있다(흔적은 새 등록에서 초기화)', () => {
  freshLedger();
  const id = 'b-re000001';
  seed(id, 2);
  batches.recordBatch({ id, source: 'import', targets: 2, tests: 2, createdBy: 'alice' });
  assert.equal(batches.rollbackBatch(id, { user: 'op' }).removed, 2);
  assert.ok(batches.getBatch(id).rolledBackAt > 0);

  // 같은 태그로 2차 등록 + 등록 기록 → 살아 있는 대상 2개를 되돌릴 수 있어야 한다
  seed(id, 2);
  const rec = batches.recordBatch({ id, targets: 2, tests: 2 });
  assert.equal(rec.rolledBackAt, undefined);
  assert.equal(rec.rolledBackBy, undefined);
  assert.equal(rec.createdBy, 'alice');                          // 병합은 유지
  const r2 = batches.rollbackBatch(id, { expectedCount: 2, user: 'op2' });
  assert.equal(r2.error, undefined);
  assert.equal(r2.removed, 2);
  assert.equal(withBatch(id).length, 0);
});

/* ── T41 ── */
test('T41 대상 파일 저장 실패(saved:false) → 원장에 롤백 흔적을 남기지 않고 재시도가 가능하다', () => {
  freshLedger();
  const id = 'b-nosave01';
  seed(id, 2);
  batches.recordBatch({ id, source: 'import', targets: 2, tests: 2 });

  // svcmon.json 자리를 디렉터리로 만들어 **store 쓰기만** 실패시킨다(원장 쓰기는 정상).
  const snap = fs.readFileSync(STORE_FILE);
  fs.unlinkSync(STORE_FILE);
  fs.mkdirSync(STORE_FILE);
  let r;
  try {
    r = batches.rollbackBatch(id, { expectedCount: 2, user: 'op' });
  } finally {
    fs.rmdirSync(STORE_FILE);
    fs.writeFileSync(STORE_FILE, snap);          // 재기동 시 디스크 상태 = 롤백 이전
    store._resetCache();                          // 프로세스 재기동 모사(메모리 삭제분 폐기)
  }
  assert.equal(r.saved, false);
  assert.match(r.error, /저장하지 못했습니다/);
  // 삭제가 디스크에 없는데 '롤백 완료'가 확정되면 재기동 후 영구히 되돌릴 수 없다
  assert.equal(batches.getBatch(id).rolledBackAt, undefined);
  assert.equal(onDisk().find((b) => b.id === id).rolledBackAt, undefined);

  // 재기동 후: 대상이 되살아나 있고 재롤백이 가능하다
  batches._resetBatchCache();
  assert.equal(withBatch(id).length, 2);
  const retry = batches.rollbackBatch(id, { expectedCount: 2, user: 'op' });
  assert.equal(retry.error, undefined);
  assert.equal(retry.removed, 2);
  assert.equal(retry.saved, true);
  assert.ok(batches.getBatch(id).rolledBackAt > 0);
});

/* ── T42 ── */
test('T42 원장 파일 쓰기만 실패하면 삭제는 확정하고 ledgerSaved:false 로 알린다', () => {
  freshLedger();
  const id = 'b-ledg0001';
  seed(id, 2);
  batches.recordBatch({ id, source: 'import', targets: 2, tests: 2 });   // 캐시·파일 준비

  fs.unlinkSync(FILE);
  fs.mkdirSync(FILE);                                                    // 원장 쓰기만 실패
  let r;
  try {
    r = batches.rollbackBatch(id, { expectedCount: 2, user: 'op' });
  } finally {
    fs.rmdirSync(FILE);
  }
  assert.equal(r.error, undefined);        // 삭제는 성공했다 — 실패로 보고하면 사용자가 두 번 지운다
  assert.equal(r.removed, 2);
  assert.equal(r.saved, true);
  assert.equal(r.ledgerSaved, false);      // 재기동 시 '이미 롤백' 가드가 사라진다는 경고
  assert.equal(withBatch(id).length, 0);
});

/* ── T43 ── */
test('T43 JSON 은 유효하지만 원장 형태가 아니면 손상으로 보존한다(파싱 성공 ≠ 온전)', () => {
  freshLedger();
  fs.writeFileSync(FILE, JSON.stringify({ version: 2, items: [{ id: 'b-real0001', targets: 9 }] }));
  batches._resetBatchCache();
  assert.deepEqual(batches.listBatches(), []);
  const bak = corruptFiles();
  assert.equal(bak.length, 1, '백업이 없으면 다음 저장이 원본을 영구 삭제한다');
  assert.match(fs.readFileSync(path.join(DIR, bak[0]), 'utf8'), /b-real0001/);
  batches.recordBatch({ id: 'b-newone01', targets: 1 });
  assert.deepEqual(onDisk().map((b) => b.id), ['b-newone01']);
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);        // 원장은 0600(자격증명급은 아니나 계정명 포함)

  // 빈 객체는 '내용 없음'이다 — 잃을 데이터가 없으므로 백업을 만들지 않는다
  freshLedger();
  fs.writeFileSync(FILE, '{}');
  batches._resetBatchCache();
  assert.deepEqual(batches.listBatches(), []);
  assert.equal(corruptFiles().length, 0);

  // 레코드가 아닌 원소는 랜덤 id 의 빈 행으로 승격하지 않고 버린다(원장 오염 + 상한 축출)
  freshLedger();
  fs.writeFileSync(FILE, JSON.stringify({ batches: ['쓰레기', 7, null, { id: 'b-ok000001', targets: 2 }] }));
  batches._resetBatchCache();
  assert.deepEqual(batches.listBatches({ withCounts: false }).map((b) => b.id), ['b-ok000001']);
});

/* ── T44 ── */
test('T44 ID 형식 위반은 기록을 거부한다(랜덤 id 유령 행이 이력을 밀어내지 않게)', () => {
  freshLedger();
  batches.recordBatch({ id: 'b-keepme01', source: 'import', targets: 1, tests: 1 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(batches.recordBatch({ id: '2026-08-07 야간배치', targets: 1 }), null);
  }
  assert.equal(batches.recordBatch({ id: '../../etc/passwd' }), null);   // 라우트 URL 에 실리는 값
  assert.equal(batches.recordBatch({ id: 'x'.repeat(41) }), null);       // 40자 초과
  assert.deepEqual(batches.listBatches({ withCounts: false }).map((b) => b.id), ['b-keepme01']);
  assert.deepEqual(onDisk().map((b) => b.id), ['b-keepme01']);
  assert.ok(batches.getBatch('b-keepme01'));
});

/* ── T45 ── */
test('T45 recordBatch 반환값은 사본이다(호출부의 응답 가공이 원장을 오염시키지 않게)', () => {
  freshLedger();
  const ins = batches.recordBatch({ id: 'b-alias001', createdBy: 'alice', targets: 1 });
  ins.createdBy = 'ATTACKER';
  ins.targets = 12345;
  batches.recordBatch({ id: 'b-other001', targets: 1 });        // 저장을 한 번 더 유발
  assert.equal(batches.getBatch('b-alias001').createdBy, 'alice');
  const disk = onDisk().find((b) => b.id === 'b-alias001');
  assert.equal(disk.createdBy, 'alice');
  assert.equal(disk.targets, 1);

  // 갱신 경로도 같은 규칙(경로마다 동작이 다르면 재현 어려운 버그가 된다)
  const upd = batches.recordBatch({ id: 'b-alias001', note: 'ok' });
  upd.note = 'HACK';
  assert.equal(batches.getBatch('b-alias001').note, 'ok');
});

/* ── T46 ── */
test('T46 listBatches 는 등록 시각 내림차순(삽입 순서와 무관)', () => {
  freshLedger();
  batches.recordBatch({ id: 'b-new00001', targets: 1, createdAt: Date.parse('2026-08-07T00:00:00Z') });
  batches.recordBatch({ id: 'b-old00001', targets: 1, createdAt: Date.parse('2026-01-01T00:00:00Z') });
  batches.recordBatch({ id: 'b-mid00001', targets: 1, createdAt: Date.parse('2026-05-05T00:00:00Z') });
  assert.deepEqual(
    batches.listBatches({ withCounts: false }).map((b) => b.id),
    ['b-new00001', 'b-mid00001', 'b-old00001'],
  );
  // 같은 시각이면 나중에 기록된 것이 앞(안정 정렬)
  freshLedger();
  const same = Date.parse('2026-03-03T00:00:00Z');
  batches.recordBatch({ id: 'b-same0001', targets: 1, createdAt: same });
  batches.recordBatch({ id: 'b-same0002', targets: 1, createdAt: same });
  assert.deepEqual(
    batches.listBatches({ withCounts: false }).map((b) => b.id),
    ['b-same0002', 'b-same0001'],
  );
});
