/**
 * audit2743lead.test.js — v2.743(2회차) 리드 통합분.
 *
 *  ① 일일 헬스체크 발송 성공 판정(기존 결함) — sendText 결과는 웹훅 'slack:200' · 메일 'email:ok' 인데 판정이 /:(2\d\d)/ 하나라
 *     메일만 쓰는 현장에서 성공한 발송을 실패로 읽었다(lastRunTs 를 세우지 않아 그날 틱마다 다시 보냈다).
 *  ② VM 프로비저닝 배치 칸 조회 — 생성(provision/vsphere.js)이 v2.743 VC-03 으로 주문형 로그인 문을 지나므로 배치 조회도 같은 문을 쓴다
 *     (실제 로그인 수 검증은 audit2741d AUTHZ-03 — 여기는 소스 계약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743lead-'));

test('① 일일 보고 성공 판정 — 메일 email:ok 도 성공, 실패·건너뜀은 성공이 아니다(alerts.js 테스트 발송과 같은 규칙)', async () => {
  const { anySendOk } = await import('../src/reports/dailyReport.js');
  assert.equal(anySendOk(['email:ok']), true, '메일만 쓰는 현장');
  assert.equal(anySendOk(['slack:200']), true);
  assert.equal(anySendOk(['teams:202', 'email:err timeout']), true);
  assert.equal(anySendOk(['email:err 535 auth']), false);
  assert.equal(anySendOk(['email:skip SMTP 인증 정지']), false);
  assert.equal(anySendOk(['slack:500', 'webhook:404']), false);
  assert.equal(anySendOk(['email:okay']), false, "단어 경계 — 'ok' 로 시작하는 다른 낱말은 성공이 아니다");
  assert.equal(anySendOk([]), false);
  assert.equal(anySendOk(null), false);
  // 발송 경로가 그 판정을 쓴다(인라인 정규식으로 되돌리지 않게)
  const src = stripComments(fs.readFileSync(path.join(SRC, 'reports/dailyReport.js'), 'utf8'));
  assert.match(src, /const anyOk = anySendOk\(results\);/);
  assert.equal(/results\.some\(\(r\) => \/:\(2\\d\\d\)\/\.test\(r\)\)/.test(src), false);
});

test('② VM 프로비저닝 배치 칸 조회는 생성과 같은 주문형 로그인 문(onDemandVcBlock)을 지나고 사유 코드를 싣는다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'provision/placement.js'), 'utf8'));
  assert.match(src, /import \{ onDemandVcBlock \} from '\.\.\/vcenter\/dsBrowse\.js';/);
  assert.match(src, /const block = onDemandVcBlock\(vc\);/);
  assert.ok(src.indexOf('onDemandVcBlock(vc)') < src.indexOf('collectFoldersAndPools(vc)'), '판정이 로그인(폴더 조회)보다 먼저');
  assert.match(src, /skipReason \? \{ skipReason \} : \{\}/);
  const vs = stripComments(fs.readFileSync(path.join(SRC, 'provision/vsphere.js'), 'utf8'));
  assert.match(vs, /onDemandLogin\(client, vc/, '생성 쪽 문(VC-03) — 이것이 사라지면 ② 의 근거도 사라진다');
});
