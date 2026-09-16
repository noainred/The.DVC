/**
 * unityUemcli2530.test.js — Unity(uemcli) 수집 파싱 회귀(v2.530).
 *
 * ── 사용자 신고와 지시(2026-09-16) ─────────────────────────────────────────────
 *   "unity 스토리지 지금 파싱이 안되, 기존 파싱 자료 모두 삭제하고,
 *    지금 내가 보낸 자료 기반으로 다시 파싱해줘"
 * 와 함께 **실장비 출력 3건**을 캡처로 받았다(OC2-41.237):
 *   `uemcli /stor/config/pool show` · `… show -detail` · `uemcli /stor/prov/luns/lun show`
 * 이 테스트는 그 캡처를 `fixtures/uemcli-*.txt`(식별자만 합성)로 고정한다.
 *
 * ── 확정된 근본 원인 — 순서가 아니라 **터미널 폭**이었다 ────────────────────────
 * v2.525 CSV 우선 → 실패 · v2.526 평문 우선 → 실패 · v2.529 CSV 우선 → 실패.
 * 셋 다 실패했으므로 순서는 원인이 아니다. 실제 원인은 `proxy/sshExec.js` 가
 * `{ pty: true }` 로 **ssh2 기본 80칸 터미널**을 요청한 것이었다 — 장비는 TTY 폭에 맞춰
 * 출력을 접고, 접힌 CSV 는 이렇게 읽혔다(사용자 실제 값으로 재현·실측):
 *   · `Current allocation` → `"29973242855424 (27.2T"` (닫는 괄호가 잘림)
 *   · 접힌 조각이 데이터 줄이 되어 **`ID=47%` · 이름 `38 x 3.8T SAS Flash 4` 인 없는 풀 1개**
 * 사용자가 넓은 터미널로 손수 돌린 같은 명령은 멀쩡했다.
 * 수정은 둘이다 — ① `WIDE_PTY`(1000칸) ② `parseCsv` 가 **따옴표 안에서 끊긴 줄**을 만나면
 * CSV 를 통째로 거부(장비가 요청 폭을 무시할 수 있으므로 이중 방어).
 *
 * ── 픽스처 규약(CLAUDE.md v2.513 — 이 저장소는 공개) ──────────────────────────
 * 어레이 시리얼·인증서 Serial/Id·LUN 이름은 합성값이다. **용량 수치와 그 괄호 표기는 보존**한다
 * — 그것이 픽스처의 존재 이유다:
 *   Total space 117544396521472 == 106.9T · Current allocation 29973242855424 == 27.2T
 *   Remaining 87568746020864 == 79.6T · Subscription 55491782770688 == 50.4T (47%)
 *   LUN Size 54975581388800 == 50.0T
 * 접속 배너와 인증서 수락 프롬프트도 **지우지 말 것** — `stripUemcliBanner` 검증분이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { specsFor, normalizeUnitySsh, recordsFor } from '../src/storage/collectors/unitySsh.js';
import { stripUemcliBanner } from '../src/proxy/sshExec.js';
import { parseCsv } from '../src/storage/collectors/cliSsh.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => stripUemcliBanner(fs.readFileSync(path.join(DIR, 'fixtures', n), 'utf8'));
const DEV = { id: 'unity-1', type: 'unity480', name: '등록명' };

/* ── 1. 실장비 평문 출력 ──────────────────────────────────────────────────── */

test('★ `pool show -detail` — 실제 캡처의 용량이 그대로 읽힌다', () => {
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-detail.txt') }, {});
  assert.equal(snap.sections.capacity, 'ok');
  assert.equal(snap.pools.length, 1);
  const p = snap.pools[0];
  assert.equal(p.name, 'pool_1');
  assert.equal(p.totalBytes, 117544396521472);          // 106.9T
  assert.equal(p.usedBytes, 29973242855424);            // 27.2T — **Current allocation**
  assert.equal(p.usedSource, 'device');
  assert.equal(p.freeBytes, 87568746020864);            // 79.6T
  assert.equal(p.subscribedBytes, 55491782770688);      // 50.4T — 사용량이 아니다
  assert.equal(p.subscriptionPct, 47);
  assert.equal(p.subscriptionPctSource, 'device');
  assert.equal(p.alertThresholdPct, 70);
  assert.equal(p.raid, '5');
  assert.equal(p.disks, 38);
  assert.equal(p.drives, '38 x 3.8T SAS Flash 4');      // 드라이브 종류가 이 문자열에만 있다
  assert.equal(p.health, 'ok');                         // `OK (5)`
  assert.equal(snap.capacity.totalBytes, 117544396521472);
  assert.equal(snap.capacity.pct, 25.5);
  // 괄호 안 반올림(106.9T)을 쓰면 추이에 없는 계단이 생긴다 — 앞의 정수 바이트를 써야 한다.
  assert.notEqual(p.totalBytes, 117544396521472 - 1);
});

test('★ `pool show`(-detail 없음) — 사용량 필드가 없어도 `0 · 0%` 라고 말하지 않는다', () => {
  // 평문 `show` 는 Total/Remaining 만 준다. 그대로 두면 화면에 '0 바이트 사용' 이라는 거짓이 찍힌다.
  const snap = normalizeUnitySsh(DEV, { pools: fx('uemcli-pool-show.txt') }, {});
  const p = snap.pools[0];
  assert.equal(p.totalBytes, 117544396521472);
  assert.equal(p.usedBytes, 117544396521472 - 87568746020864);   // 전체 − 잔여
  assert.equal(p.usedSource, 'derived', '계산값임을 반드시 구분해 밝힌다');
  assert.equal(snap.capacity.pct, 25.5, '실측 27.2T 와 같은 백분율이어야 한다');
});

test('★ `lun show` — 인증서 프롬프트가 없는 캡처도 읽는다', () => {
  const recs = recordsFor(fx('uemcli-lun-show.txt'), ['ID', 'Name', 'Size', 'Storage pool']);
  assert.equal(recs.length, 1, '배너만 있는 출력에서 레코드 1건');
  assert.equal(recs[0].Name, 'SYNTH_LUN_0');
  assert.equal(recs[0].Size, '54975581388800 (50.0T)');
  assert.equal(recs[0]['SP owner'], 'SPA');
});

test('배너·인증서 블록은 레코드가 되지 않는다(없는 장비를 만들지 않는다)', () => {
  for (const f of ['uemcli-pool-show.txt', 'uemcli-pool-detail.txt', 'uemcli-lun-show.txt']) {
    const text = fx(f);
    assert.ok(!/Remote certificate|Storage system address|Accept the certificate/.test(text), `${f}: 배너 잔재`);
    // 인증서 `Id:` 가 레코드로 남으면 `pick(rec,'ID')` 에 걸려 **가짜 풀**이 된다(v2.525 실제 사고).
    const recs = recordsFor(text, ['Name', 'ID', 'Total space', 'Current allocation', 'Size']);
    assert.equal(recs.length, 1, `${f}: 레코드는 1건이어야 한다 — 배너가 섞이면 늘어난다`);
  }
});

/* ── 2. 80칸 PTY 줄바꿈 방어(확정된 근본 원인) ────────────────────────────── */

const HEADER = '"ID","Type","Name","Description","Total space","Current allocation","Preallocated",'
  + '"Remaining space","Subscription","Flash percent","Subscription percent","Alert threshold",'
  + '"Drives","Number of drives","RAID level","Stripe length","Rebalancing","Health state"';
const ROW = '"pool_1","Dynamic","pool_1","","117544396521472 (106.9T)","29973242855424 (27.2T)",'
  + '"2407645184 (2.2G)","87568746020864 (79.6T)","55491782770688 (50.4T)","100%","47%","70%",'
  + '"38 x 3.8T SAS Flash 4","38","5","9","no","OK (5)"';
const hardWrap = (t, cols) => t.split('\n').map((l) => {
  const parts = [];
  for (let i = 0; i < Math.max(1, l.length); i += cols) parts.push(l.slice(i, i + cols));
  return parts.join('\n');
}).join('\n');

test('★ 80칸에서 접힌 CSV 는 통째로 거부한다 — 없는 풀을 만들지 않는다', () => {
  const wrapped = hardWrap(`${HEADER}\n${ROW}\n`, 80);
  assert.deepEqual(parseCsv(wrapped), [], '접힌 CSV 에서 한 줄이라도 살리면 틀린 값이 화면에 남는다');
  // 접힘의 실제 피해를 고정한다: 예전 파서는 `ID=47%` 라는 가짜 풀을 만들었다.
  const recs = recordsFor(wrapped, ['Name', 'ID', 'Total space', 'Current allocation']);
  assert.ok(!recs.some((r) => r.ID === '47%' || r.Name === '38 x 3.8T SAS Flash 4'),
    '줄바꿈 조각이 장비로 둔갑하면 안 된다');
});

test('접히지 않은 CSV 는 정상적으로 읽는다(거부가 과하지 않다)', () => {
  const rows = parseCsv(`${HEADER}\n${ROW}\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['Current allocation'], '29973242855424 (27.2T)');
});

test('열 수가 헤더와 다른 줄은 데이터로 쓰지 않는다', () => {
  assert.deepEqual(parseCsv('"a","b","c"\n"1","2"\n'), [], '모자란 줄은 버린다');
});

/* ── 3. 명령 후보 순서 ────────────────────────────────────────────────────── */

const uemcliSpecs = () => specsFor({ deep: true, configRound: true })
  .filter((s) => (s.cmds || []).some((c) => c.startsWith('uemcli ')));

test('★ 모든 uemcli 항목의 첫 후보는 **평문**이다(이 장비에서 확인된 유일한 형식)', () => {
  const bad = uemcliSpecs().filter((s) => /-output csv/.test(s.cmds[0]));
  assert.deepEqual(bad.map((s) => `${s.key}: ${s.cmds[0]}`), [],
    'CSV 출력은 이 장비에서 한 번도 캡처하지 못했다 — 검증된 형식을 앞에 둔다');
});

test('CSV 후보는 지우지 않고 뒤에 남긴다 — 평문이 안 되는 항목 대비', () => {
  for (const s of uemcliSpecs()) {
    assert.ok(s.cmds.length >= 2, `${s.key}: 후보가 하나뿐이면 폴백이 없다`);
    assert.ok(s.cmds.some((c) => /-output csv/.test(c)), `${s.key}: CSV 폴백이 있어야 한다`);
  }
});

test('필수·매주기 항목이 앞에 오는 순서는 그대로다(v2.528 예산 계약)', () => {
  const all = specsFor({ deep: true, configRound: true });
  assert.equal(all[0].required, true, '필수(system)가 첫 명령');
  const lastAlways = all.map((s) => s.when).lastIndexOf('always');
  const firstConfig = all.findIndex((s) => s.when === 'config');
  assert.ok(lastAlways < firstConfig, '매주기 항목이 구성 항목보다 앞이어야 예산이 모자랄 때 용량을 지킨다');
});

test('인증서 프롬프트 자동 응답은 모든 uemcli 항목에 켜져 있다', () => {
  for (const s of uemcliSpecs()) assert.equal(s.answered, true, `${s.key}: answered 가 없으면 명령이 끝나지 않는다`);
});
