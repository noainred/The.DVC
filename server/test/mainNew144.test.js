/**
 * 새 코드 점검 144회차가 '범위 밖' 으로 남긴 것(메인 수정): 호스트 엑셀(routes/api/hostExport.js)도 /hosts/checks 와 같은 결함이었다 —
 *   ① 로그 DB 를 못 읽으면 빈 Map 이라 기간 안에 부팅한 호스트 칸에 '최근 30일 안에 재부팅하지 않았습니다(마지막 부팅 …)' 라는 모순 문장
 *   ② analyzeReboots 의 rows 가 화면 상한(500행)에서 잘려, 한 vCenter 에서 기간 안 부팅이 500대를 넘으면 잘린 호스트가 '재부팅 없음'.
 * 판정은 hostcfg/reboots.js rebootVerdictsByHost 하나로 모았다(/hosts/checks · /hosts/insight · 엑셀).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 고정(docs/rules/common.md)

const { rebootVerdictsByHost, analyzeReboots, REBOOT_CHUNK } = await import('../src/hostcfg/reboots.js');

test('rebootVerdictsByHost — 기간 안 부팅이 500대를 넘어도 호스트마다 판정이 있다(화면 상한 없이)', () => {
  const hosts = Array.from({ length: 700 }, (_, i) => ({ id: `vc1:h${i}`, vcenterId: 'vc1', name: `esx${i}`, connectionState: 'CONNECTED', bootTime: NOW - (1 + (i % 20)) * DAY }));
  const capped = analyzeReboots(hosts, [], { now: NOW, days: 30 });
  assert.equal(capped.rows.length, 500, '전제: analyzeReboots 의 rows 는 500행에서 잘린다');
  const m = rebootVerdictsByHost(hosts, [], { now: NOW, days: 30 });
  assert.equal(m.size, 700, '700대 전부 판정이 있다');
  assert.ok(REBOOT_CHUNK < 500);
  // 로그 DB 를 못 읽은 경우(이벤트 []) — 기간 안 부팅은 판정 불가('no-events'), 기간 밖 부팅은 행 없음
  assert.equal(m.get('vc1:h699').kind, 'no-events');
  const out = rebootVerdictsByHost([{ id: 'vc1:old', vcenterId: 'vc1', name: 'old', connectionState: 'CONNECTED', bootTime: NOW - 40 * DAY }], [], { now: NOW, days: 30 });
  assert.equal(out.has('vc1:old'), false, '기간 밖 부팅은 재부팅 없음과 같다(모름이 아니다)');
});

test('호스트 엑셀 · /hosts/checks 가 같은 판정 하나를 쓴다 — 로그 DB 를 못 읽어도 빈 Map 으로 넘기지 않는다', () => {
  const ex = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/hostExport.js'), 'utf8'));
  assert.match(ex, /return rebootVerdictsByHost\(hosts, events, \{/, '엑셀의 판정도 상한 없는 호스트별 판정');
  assert.match(ex, /catch \{ reboots = rebootVerdictsByHost\(target, \[\], \{ now: Date\.now\(\), days: BOOT_DAYS \}\); \}/, '못 읽으면 이벤트 없는 판정');
  assert.ok(!/reboots = new Map\(\)/.test(ex), '빈 Map 으로 넘기지 않는다');
  assert.ok(!/analyzeReboots\(/.test(ex), 'rows(화면 상한)를 직접 쓰지 않는다');
  const ck = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/hostChecks.js'), 'utf8'));
  assert.ok(!/analyzeReboots\(/.test(ck), '/hosts/checks 도 공용 판정만');
  assert.match(ck, /return rebootVerdictsByHost\(hosts, \[\], \{ now, days: BOOT_DAYS \}\);/);
});
