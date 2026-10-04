/**
 * v2.689 G2 — 백업 원자성·복원 실패 보고·비동기 수집.
 *  ① B3 백업 gz 는 원자 쓰기 — 생성 뒤 .tmp 잔재 0 · 아카이브가 온전히 풀린다
 *  ② B3 쓰기(rename)가 실패하면 createBackup 이 던지고 prune 이 돌지 않는다(온전한 옛 백업이 지워지지 않는다)
 *  ③ B4 복원 중 한 파일 쓰기가 실패하면 failed[{file, reason}] 로 밝힌다(조용히 'restored N' 만 주지 않는다)
 *  ④ I3 백업 수집은 비동기 — createBackup 이 설정 파일을 readFileSync 로 읽지 않고, 결과는 동기판과 같다
 * ⚠ 이 컨테이너는 root 라 읽기 전용 디렉터리로는 쓰기 실패를 만들 수 없다 — ② 는 fs.renameSync 를 가로채고,
 *   ③ 은 대상 이름에 '비어 있지 않은 디렉터리' 를 두어 rename 이 실제로 실패하게 한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'g2backup2689-'));
process.env.CONFIG_DIR = DIR;
fs.writeFileSync(path.join(DIR, 'g2-a.json'), JSON.stringify({ a: 1 }));
fs.writeFileSync(path.join(DIR, 'g2-b.json'), JSON.stringify({ b: [1, 2, 3] }));
fs.writeFileSync(path.join(DIR, 'portal.env'), 'PORT=4000\nAUTH_SECRET=s3cret\n');

const svc = await import('../src/backup/service.js');
const BACKUP_DIR = path.join(DIR, 'backups');

test('① 백업 생성 뒤 임시 파일 잔재가 없고 아카이브가 온전히 풀린다', async () => {
  const r = await svc.createBackup('manual', { retention: 30 });
  const names = fs.readdirSync(BACKUP_DIR);
  assert.deepEqual(names.filter((n) => n.includes('.tmp')), [], `임시 파일 잔재: ${names.join(', ')}`);
  assert.ok(names.includes(r.name));
  const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(BACKUP_DIR, r.name))).toString('utf8'));
  assert.equal(a.central.files['g2-a.json'], JSON.stringify({ a: 1 }));
  assert.ok(!a.central.files['portal.env'].includes('s3cret'), '.env 비밀은 여전히 가린다');
  assert.equal((fs.statSync(path.join(BACKUP_DIR, r.name)).mode & 0o777), 0o600);
});

test('② 백업 쓰기가 실패하면 던지고 옛 백업을 prune 하지 않는다', async () => {
  // 보관 2 를 넘는 옛 백업 3개(정기 사유 — 자동 사유 상한과 무관)
  for (let i = 0; i < 3; i++) {
    const f = path.join(BACKUP_DIR, `portal-backup-2020-01-0${i + 1}T00-00-00-000Z-schedule.json.gz`);
    fs.writeFileSync(f, zlib.gzipSync('{}'));
    const t = new Date(Date.UTC(2020, 0, i + 1)); fs.utimesSync(f, t, t);
  }
  const before = fs.readdirSync(BACKUP_DIR).filter((n) => n.endsWith('.json.gz')).sort();
  const orig = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (String(dst).startsWith(BACKUP_DIR)) { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return orig(src, dst);
  };
  try {
    await assert.rejects(svc.createBackup('manual', { retention: 2 }), /ENOSPC/);
  } finally { fs.renameSync = orig; }
  const after = fs.readdirSync(BACKUP_DIR);
  assert.deepEqual(after.filter((n) => n.endsWith('.json.gz')).sort(), before, '실패한 백업 뒤에 prune 이 옛 백업을 지웠다');
  assert.deepEqual(after.filter((n) => n.includes('.tmp')), [], '실패해도 임시 파일을 남기지 않는다');
});

test('③ 복원 중 한 파일 쓰기가 실패하면 failed 로 밝히고 나머지는 복원한다', async () => {
  // 대상 이름 자리에 비어 있지 않은 디렉터리 — rename 이 실제로 실패한다(EISDIR/ENOTEMPTY)
  fs.mkdirSync(path.join(DIR, 'g2-blocked.json', 'x'), { recursive: true });
  const warn = console.warn; const warned = [];
  console.warn = (m) => { warned.push(String(m)); };
  let r;
  try {
    r = await svc.restoreCentral({ central: { files: { 'g2-blocked.json': '{"z":1}', 'g2-c.json': '{"c":2}' } }, edges: {} }, { retention: 30 });
  } finally { console.warn = warn; }
  assert.equal(r.restored, 1);
  assert.ok(Array.isArray(r.failed), 'failed 배열을 돌려준다');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].file, 'g2-blocked.json');
  assert.ok(r.failed[0].reason, '사유를 싣는다');
  assert.equal(fs.readFileSync(path.join(DIR, 'g2-c.json'), 'utf8'), '{"c":2}');
  assert.ok(warned.some((m) => m.includes('g2-blocked.json')), '실패를 콘솔에도 남긴다');
  fs.rmSync(path.join(DIR, 'g2-blocked.json'), { recursive: true, force: true });
});

test('④ 백업 수집은 비동기 — 설정 파일을 readFileSync 로 읽지 않고, 결과는 동기판과 같다', async () => {
  const big = path.join(DIR, 'g2-big.json');
  fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 10, 0x20));   // 크기 상한(8MB) 초과 → SKIPPED_META
  try {
    const syncOut = svc.collectConfigDir(DIR);
    const asyncOut = await svc.collectConfigDirAsync(DIR);
    assert.deepEqual(asyncOut, syncOut, '동기판과 같은 결과(가림·상한 메타 포함)');
    assert.equal(asyncOut[svc.SKIPPED_META][0].name, 'g2-big.json');
    assert.ok(asyncOut[svc.REDACTED_META]['portal.env'].includes('AUTH_SECRET'));
    assert.equal(svc.settingsFingerprint(asyncOut), svc.settingsFingerprint(syncOut), '지문도 같다');
    const orig = fs.readFileSync;
    const syncReads = [];
    fs.readFileSync = function patched(p, ...rest) {
      if (/g2-[a-z]+\.json$|portal\.env$/.test(String(p))) syncReads.push(String(p));
      return orig.call(this, p, ...rest);
    };
    try { await svc.createBackup('manual', { retention: 30 }); } finally { fs.readFileSync = orig; }
    assert.deepEqual(syncReads, [], `백업이 설정 파일을 동기로 읽었다: ${syncReads.join(', ')}`);
  } finally { fs.rmSync(big, { force: true }); }
});
