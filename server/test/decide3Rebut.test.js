/**
 * decide3Rebut.test.js — 남은 결정(76~105회차) 권장안 구현(G1 A1 · A6 · G2 A3 · G3 A9)의 **반증** 회귀(2026-11-20 · 검증 수준 '표준').
 *
 *  R1 위임 인벤토리(central/inventory.js): 기동 때 **읽기 오류**였다가 다시 읽을 때 **손상**이면 예전에는 `preserve:false` 라 보존본 없이 창을 풀었고,
 *     다음 저장이 손상본(관리자 소유 지정 포함)을 덮었다 — 기동 때 손상(보존 후 빈 캐시)과 비대칭(재현: `.corrupt.*` 0개 · 원본 소실).
 *     → 다시 읽을 때도 보존본으로 옮긴 뒤에만 연다 · 옮기지 못하면 읽기 오류처럼 계속 막는다(저장 거절 — 원본을 보존본 없이 덮지 않는다).
 *     함대(central/fleet.js)는 고치지 않았다 — 기동 때 손상도 보존하지 않는 설계(순수 캐시 · TTL 30분 · 엣지 다음 push 로 채움)라 두 경로가 이미 같다.
 *  R2 A9 소비처 전수: 잘린 결과로 대조했으면 대조에 없는 VM 은 화면 · 내보내기 · 표시 집계 · 우선순위 어디에서도 '없음'(미백업) · 0 이 아니다.
 *
 * ⚠ 저장소 server/config 오염 방지 — 모든 파일은 임시 폴더. 읽기 오류는 자식 프로세스에서 fs.readFileSync 를 그 파일에서만 던지게 해 만든다(컨테이너가 root 라 chmod 로는 재현 불가).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } });

const CFG = tmpDir('decide3rebut-');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCDIR = path.join(HERE, '..', 'src');
/** 정시 경계로 떨어뜨린 기준 시각 — Date.now() 직접 · 고정 epoch 둘 다 쓰지 않는다. */
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000;

function runChild(dir, body, extraEnv = {}) {
  const script = `
    import fs from 'node:fs';
    const realRead = fs.readFileSync; const realRename = fs.renameSync;
    globalThis.__deny = []; globalThis.__renameFail = [];
    fs.readFileSync = function (p, ...a) { if (globalThis.__deny.includes(String(p))) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead.call(this, p, ...a); };
    fs.renameSync = function (from, to) { if (globalThis.__renameFail.includes(String(from))) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; } return realRename.call(this, from, to); };
    const realNow = Date.now; globalThis.__shift = (ms) => { Date.now = () => realNow() + ms; };
    const out = {};
    const auditOf = (prefix) => { try { return realRead(${JSON.stringify(path.join(dir, 'audit.ndjson'))}, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.action.startsWith(prefix)); } catch { return []; } };
    const errs = []; const realErr = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ')); };
    const realWarn = console.warn; console.warn = () => {};
    ${body}
    console.error = realErr; console.warn = realWarn;
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const res = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, ...extraEnv }, encoding: 'utf8', timeout: 90_000 });
  return JSON.parse(res.split('\n').find((l) => l.startsWith('@@')).slice(2));
}

/* ── R1 ─────────────────────────────────────────────────────────────── */
test('R1 위임 인벤토리 — 읽기 오류 창을 닫을 때 파일이 손상이면 보존본으로 옮긴 뒤에만 연다 · 옮기지 못하면 계속 막는다(보존본 없이 덮지 않는다)', () => {
  const dir = tmpDir('decide3rebut-inv-');
  const I = path.join(dir, 'central-inventory.json');
  fs.writeFileSync(I, JSON.stringify({ inventory: { 'vc-a': { at: BASE - 60_000, agent: 'edge-a', ownerSetBy: 'admin-assign', data: { hosts: [], vms: [] } } } }));
  // 창 동안 바뀐 손상본 — 관리자 소유 지정이 든 잘린 본문(디스크 복구 뒤 쓰레기 등)
  const CORRUPT = '{"inventory": {"vc-a": {"agent": "edge-a", "ownerSetBy": "admin-assign"';
  const out = runChild(dir, `
    globalThis.__deny = [${JSON.stringify(I)}];
    const inv = await import(${JSON.stringify(path.join(SRCDIR, 'central/inventory.js'))});
    out.blocked0 = inv.inventoryReadBlocked();
    inv.setInventory('vc-b', { vcenter: { id: 'vc-b', status: 'connected' }, hosts: [], vms: [] }, 'edge-b', null, { verified: true });
    fs.writeFileSync(${JSON.stringify(I)}, ${JSON.stringify(CORRUPT)});
    globalThis.__deny = [];
    // ① 보존본으로 옮기지 못함(EBUSY) — 창을 풀지 않는다(저장 거절 · 원본 그대로)
    globalThis.__renameFail = [${JSON.stringify(I)}];
    globalThis.__shift(31_000);
    out.r1 = inv.setInventoryOwner('vc-b', 'edge-b');
    out.blocked1 = inv.inventoryReadBlocked();
    out.text1 = realRead(${JSON.stringify(I)}, 'utf8');
    out.bak1 = fs.readdirSync(${JSON.stringify(dir)}).filter((n) => n.startsWith('central-inventory.json.corrupt.'));
    out.merge1 = auditOf('central-inventory.unread-window-merge').length;
    out.preserveFailLogged = errs.some((e) => e.includes('보존본(.corrupt.*)으로 옮기지 못했습니다'));
    // ② 간격이 지나 옮길 수 있게 되면 — 보존 후 연다(합친 결과 감사 로그에 보존본 이름)
    globalThis.__renameFail = [];
    globalThis.__shift(62_000);
    out.r2 = inv.setInventoryOwner('vc-b', 'edge-b');
    out.blocked2 = inv.inventoryReadBlocked();
    const baks = fs.readdirSync(${JSON.stringify(dir)}).filter((n) => n.startsWith('central-inventory.json.corrupt.'));
    out.bak2 = baks.map((n) => realRead(${JSON.stringify(dir)} + '/' + n, 'utf8'));
    out.file2 = JSON.parse(realRead(${JSON.stringify(I)}, 'utf8'));
    out.merge2 = auditOf('central-inventory.unread-window-merge').map((x) => x.detail);
  `, { DATA_SOURCE: 'live' });
  assert.equal(out.blocked0, true, '전제: 기동 때 읽기 오류');
  assert.equal(out.r1.persisted, false, JSON.stringify(out.r1));
  assert.equal(out.blocked1, true, '보존하지 못한 손상본 위에는 창을 풀지 않는다');
  assert.equal(out.text1, CORRUPT, '손상본을 보존본 없이 덮지 않는다');
  assert.deepEqual(out.bak1, []);
  assert.equal(out.merge1, 0, '아직 합치지 않았다');
  assert.equal(out.preserveFailLogged, true, '옮기지 못한 사실은 콘솔에(무음 금지 — preserveCorrupt 한 줄)');

  assert.equal(out.r2.persisted, true, JSON.stringify(out.r2));
  assert.equal(out.blocked2, false);
  assert.deepEqual(out.bak2, [CORRUPT], '손상본은 보존본(.corrupt.*)에 그대로 — 기동 때 손상과 같은 규약');
  assert.equal(out.file2.inventory['vc-b'].agent, 'edge-b', '그 뒤 저장은 지금 메모리 값으로');
  assert.equal(out.merge2.length, 1);
  assert.match(out.merge2[0], /파일이 손상돼\(손상본은 central-inventory\.json\.corrupt\.\S+ 로 보존/, '합친 결과에 보존본 이름(경로 없이)');
  assert.ok(!out.merge2[0].includes(dir), '절대 경로가 없다');
});

test('R1 소스 — 다시 읽기는 보존(preserve:true)하고 보존 실패(backup 없음)는 읽기 오류와 같이 막는다 · 함대는 기동 · 다시 읽기 모두 보존하지 않는 같은 설계', () => {
  const inv = stripComments(fs.readFileSync(path.join(SRCDIR, 'central/inventory.js'), 'utf8'));
  const body = inv.slice(inv.indexOf('function inventoryWritable'), inv.indexOf('export function inventoryReadBlocked'));
  assert.match(body, /readJsonFile\(FILE, \{ parse: parseInventoryFile, preserve: true \}\)/);
  assert.match(body, /r\.kind === 'corrupt' && !r\.backup/);
  const fl = stripComments(fs.readFileSync(path.join(SRCDIR, 'central/fleet.js'), 'utf8'));
  const n = (fl.match(/readJsonFile\(FILE, \{ parse: parseFleetFile, preserve: false \}\)/g) || []).length;
  assert.equal(n, 2, '함대는 기동 · 다시 읽기 둘 다 같은 판정(보존 없음 — 순수 캐시). 한쪽만 바꾸면 이 시험이 알린다');
});

/* ── R2 ─────────────────────────────────────────────────────────────── */
test('R2 A9 소비처 — 잘린 결과로 대조했으면 대조에 없는 VM 은 표시 집계 · 우선순위 · VM 칸 · 내보내기 문구 · 합계 어디에서도 미백업이 아니다', async () => {
  const { veeamCount, resultsTruncated } = await import('../src/veeam/backupCounts.js');
  const { backupRow, backupTotals, vmBackupView, priorityCandidates } = await import('../src/veeam/backupStatus.js');
  const { markCounts } = await import('../src/veeam/backupMarks.js');
  const { veeamStateText } = await import('../src/veeam/vmListCsv.js');
  const vms = [{ id: 'v1', name: 'a' }, { id: 'v2', name: 'b' }, { id: 'v3', name: 'c' }];
  const byVm = { v1: { lb: BASE - 3_600_000, lr: 'Success' } };
  const match = { byVm };
  const views = [{ ok: true, lastOkTs: BASE, stale: false }];
  const marks = { v2: { need: true, crit: 'high' } };
  const sc = { n: 0, partial: false };
  const run = (results) => {
    const vcnt = veeamCount({ views, byVm, vmTotal: vms.length, truncated: resultsTruncated(results) });
    const row = backupRow({ vms, linked: true, vcnt, match, sc, ev: { byVm: {} }, now: BASE });
    const absentKnown = !row.veeamAbsentUnknown;   // routes/api/veeam.js 의 모든 호출부와 같은 식(아래 소스 대조)
    row.marks = markCounts(vms, marks, byVm, { veeamKnown: true, absentKnown });
    const view = vmBackupView(vms[1], undefined, undefined, { veeamKnown: true, snapKnown: true, absentKnown, now: BASE });
    const prio = priorityCandidates(vms, { byVm, marks, veeamKnown: true, absentKnown, now: BASE });
    return { vcnt, row, view, prio, totals: backupTotals([row]) };
  };
  const full = run([{ result: { truncated: [] } }]);
  assert.equal(full.vcnt.partial, false); assert.equal(full.row.veeamAbsentUnknown, undefined);
  assert.equal(full.row.marks.needGap, 1, '전제: 잘리지 않았으면 대조에 없는 VM 은 미백업(없음)');
  assert.equal(veeamStateText(full.view.v, true), '없음');
  assert.equal(full.prio.find((c) => c.id === 'v2')?.gap, true);
  assert.ok(full.row.split, '전제: 나눔을 낸다');

  const cut = run([{ result: { truncated: ['vms'] } }]);
  assert.equal(cut.vcnt.partial, true); assert.equal(cut.vcnt.truncated, true); assert.equal(cut.vcnt.n, 1, '수는 하한 그대로(지우지 않는다)');
  assert.equal(cut.row.veeamState, 'partial');
  assert.equal(cut.row.veeamAbsentUnknown, true);
  assert.equal(cut.row.marks.needGap, null, '표시 집계(백업 필요 · 미백업)는 0 이 아니라 모름');
  assert.equal(cut.view.v, undefined, 'VM 칸은 없음(null)이 아니라 모름');
  assert.equal(veeamStateText(cut.view.v, true), '모름', 'VM 목록 CSV · 엑셀 · 화면 문구');
  assert.equal(cut.prio.some((c) => c.gap), false, '우선순위 VM 에 미백업으로 올리지 않는다');
  assert.equal(cut.row.split, null, '둘 다 · 한쪽만 나눔도 모름');
  assert.equal(cut.totals.marks.needGap, 0, '합계는 아는 곳만 더하고');
  assert.equal(cut.totals.marks.needGapUnknown, 1, '모르는 곳은 따로 센다');
  assert.equal(cut.totals.veeamPartial, 1);

  // 소스 대조 — 모름을 받는 함수(vmBackupView · markCounts · priorityCandidates)의 라우트 호출부는 전부 행의 veeamAbsentUnknown 에서 absentKnown 을 만든다
  const src = stripComments(fs.readFileSync(path.join(SRCDIR, 'routes/api/veeam.js'), 'utf8'));
  const calls = src.match(/\b(?:vmBackupView|markCounts|priorityCandidates)\(/g) || [];
  const known = src.match(/absentKnown: !(?:b\.)?row\.veeamAbsentUnknown/g) || [];
  assert.ok(calls.length >= 6, `호출부 ${calls.length}`);
  assert.equal(known.length, calls.length, '호출부마다 absentKnown 을 행 표지에서(빠진 호출부가 있으면 잘린 결과의 부재가 미백업으로 돌아간다)');
});
