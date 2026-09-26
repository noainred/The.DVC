/**
 * v2.574 — **새 엣지 워커·폴러가 조용히 빠지는 것을 막는 스윕** (감사 IMP-06·07).
 *
 * ⚠⚠ CLAUDE.md 가 v2.554·v2.560·v2.561 에 **세 번** "새 엣지 워커는 `edgelog/spec.js` 표에
 * 함께 넣을 것" 을 적었는데도 v2.573 시점에 **7개가 빠져 있었다**. 기존 테스트가
 * `length >= 20` 만 봤기 때문이다 — 그런 검사는 '추가를 잊은 것' 을 절대 잡지 못한다.
 * 그리고 그중 셋(`pingWorker`·`captureWorker`·`bmstorWorker`)은 상태 export 자체가 없어
 * `catch { return null; }` 로 **무음 실패**하고 있었다(v2.561 이 이름까지 적어 뒀다).
 *
 * ⚠ v2.566 교훈도 여기서 함께 고정한다 — push/pull 진입 함수는 **실제로 호출하는 테스트**가
 * 있어야 TDZ 급 결함이 잡힌다(순수 헬퍼만 고정하면 통과하면서 놓친다).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { stripComments } from './_stripComments.js';

// v2.613 TESTDOC2613-05: 아래 IMP-06 이 push/pull 진입 함수를 **실제로 부른다** — 개발 트리의 `server/config`
//   (실제 등록부·자격증명이 있을 수 있다)를 읽지 않게 임시 디렉터리를 먼저 잡는다(config.js 는 로드 시 1회 읽는다).
process.env.CONFIG_DIR = process.env.CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'edgesweep2574-'));
const { STATUS_SPEC } = await import('../src/edgelog/spec.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
};

describe('IMP-07 — edgelog/spec.js 표가 실재하고 빠짐이 없다', () => {
  test('★ 표의 모든 항목이 실제로 존재하는 함수를 가리킨다', async () => {
    const missing = [];
    for (const sp of STATUS_SPEC) {
      const abs = path.resolve(SRC, 'edgelog', sp.mod);
      if (!fs.existsSync(abs)) { missing.push(`${sp.key}: 파일 없음 ${sp.mod}`); continue; }
      const m = await import(abs);
      if (typeof m[sp.fn] !== 'function') missing.push(`${sp.key}: ${sp.fn} 없음`);
    }
    assert.deepEqual(missing, [], missing.join(' · '));
  });

  test('★ 상태 export 를 가진 엣지 워커·폴러가 전부 표에 있다', () => {
    /*
     * 대상(v2.613 CONTRACT2613-06 · RUNTIME2613-02 에 넓혔다):
     *  ① `index.js` 가 `start*` 이름으로 import 하는 **원천 모듈 전부** — 시작되는 모듈이 곧 대상이다.
     *     예전 파일명 패턴(Worker|poller|scheduler)은 `capacity/sampler.js`·`security/certMonitor.js` 를
     *     훑지도 않았고, 정규식 `export function` 은 `export async function logStatus()` 를 못 봤다.
     *  ② 예전 패턴(agent 의 *Worker.js · 각 모듈의 poller.js·scheduler.js)도 그대로 합집합에 둔다.
     * 상태 함수 = **인자 없는** `*Status*` export(`collect.js` 가 `fn()` 으로 부른다). 인자가 필요한
     * 헬퍼(`statusFromPull(r)`·`certExpiryStatus(ts, …)`)는 상태 getter 가 아니다.
     * (여기에 별표+슬래시 조합을 쓰면 이 주석이 그 자리에서 끝난다 — 이번 세션에서 세 번째다.)
     * ⚠ 표에서 **의도적으로 뺀 것**은 사유와 함께 `EXCLUDED` 에 적는다 — 사유 없이 빠지는 것만 잡는다.
     */
    const EXCLUDED = new Map([
      ['relaycheck/poller.js', '역할별 축약(relayCheckView)을 거쳐야 한다 — spec.js 머리말'],
      ['mail/service.js', '중앙 전용'], ['collector/state.js', '중앙 전용'], ['partfault/poller.js', '중앙 전용(전이·DB·알림)'],
      ['central/svcmonSilence.js', '중앙 전용(엣지 무보고 감시) — 엣지에서 읽으면 늘 비어 있다'],
      ['alerts.js', 'alertStatus().config 가 alerts.json 전체(웹훅 URL — v2.604 FILE_EXTRA_SECRET_FIELDS 의 url)를 담는다. redactDeep 은 키 이름으로만 가리므로 URL 속 토큰을 못 가린다 — 설정 › 알림 화면이 따로 있다'],
      ['backup/settings.js', '포탈 자체 서비스(수집·push/pull 아님) — 설정 › 백업 화면이 상태를 보여준다. 등재는 값 내용(경로·보관 정책) 검토 뒤 별건'],
      ['security/loginMonitor.js', '포탈 자체 서비스 — lastSummary 에 로그인 실패 계정명·IP 가 담긴다. 설정 › 보안 화면이 따로 있다. 등재는 별건'],
      ['perf/stallWatch.js', '포탈 자체 감시(v2.617, 수집·push/pull 아님) — 서비스 점검에 전용 행(stallwatch)이 있고, 멈춘 동안의 기록·스택은 그 노드의 journal [stallwatch] 줄에 남는다(엣지 로그 표의 폴러 판정(주기·최근 실행)과 뜻이 맞지 않는다)'],
      ['reports/dailyReport.js', '포탈 자체 서비스(메일 보고) — 설정 › 일일 보고 화면이 상태를 보여준다. 등재는 별건'],
    ]);
    const inSpec = new Set(STATUS_SPEC.map((s) => path.normalize(s.mod).replace(/^\.\.\//, '')));
    // ① index.js 의 start* import 원천
    const indexSrc = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
    const started = new Set();
    for (const m of indexSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
      if (/\bstart[A-Z]\w*/.test(m[1])) started.add(path.normalize(m[2]));
    }
    assert.ok(started.size >= 60, `index.js 의 start* import 원천 모듈이 ${started.size}개뿐이다 — 파서를 확인할 것`);
    // ② 예전 파일명 패턴
    const targets = new Set(started);
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f);
      if (/(Worker|poller|scheduler)\.js$/i.test(rel)) targets.add(rel);
    }
    const STATUS_RE = /export (?:async )?function (\w*[Ss]tatus\w*)\s*\(\s*\)|export const (\w*[Ss]tatus\w*)\s*=\s*(?:async\s*)?\(\s*\)\s*=>/g;
    const missed = [];
    for (const rel of [...targets].sort()) {
      if (EXCLUDED.has(rel) || inSpec.has(rel)) continue;
      const abs = path.join(SRC, rel);
      if (!fs.existsSync(abs)) continue;
      const src = stripComments(fs.readFileSync(abs, 'utf8'));
      for (const st of src.matchAll(STATUS_RE)) missed.push(`${rel} :: ${st[1] || st[2]}`);
    }
    assert.deepEqual(missed, [], `edgelog/spec.js 에 빠진 워커·폴러: ${missed.join(', ')}`);
    // EXCLUDED 의 항목은 실재해야 한다(사라진 파일을 사유째 들고 있으면 목록이 낡는다).
    for (const rel of EXCLUDED.keys()) assert.ok(fs.existsSync(path.join(SRC, rel)), `EXCLUDED 에 없는 파일: ${rel}`);
  });

  test('키가 중복되지 않는다 — 중앙 수신이 덮어쓴다', () => {
    const keys = STATUS_SPEC.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('IMP-07 — 위임 워커가 무음 실패하지 않는다', () => {
  const WORKERS = ['agent/pingWorker.js', 'agent/captureWorker.js', 'agent/bmstorWorker.js'];
  for (const rel of WORKERS) {
    test(`${rel} — catch 에서 사유를 남기고 콘솔에도 적는다`, () => {
      const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
      assert.ok(!/\}\s*catch\s*\{\s*return null;\s*\}/.test(src),
        '`catch { return null; }` 무음 실패가 남아 있다(v2.549·2.561 규약)');
      assert.match(src, /_last\s*=\s*\{[^}]*error/, '실패 사유를 상태에 남기지 않는다');
      assert.match(src, /console\.warn/, '실패를 콘솔에도 적지 않는다');
    });
  }
  test('★ 세 워커의 상태 함수가 실제로 동작한다(정의만 있고 안 불리는 것을 막는다)', async () => {
    for (const [rel, fn] of [['agent/pingWorker.js', 'pingWorkerStatus'],
      ['agent/captureWorker.js', 'captureWorkerStatus'], ['agent/bmstorWorker.js', 'bmstorWorkerStatus']]) {
      const m = await import(path.join(SRC, rel));
      const st = m[fn]();
      assert.equal(typeof st, 'object');
      assert.ok(Number.isFinite(st.pollMs), `${fn} 이 주기를 밝히지 않는다`);
    }
  });
});

describe('IMP-06 — push/pull 진입 함수를 실제로 호출한다(v2.566 TDZ 교훈)', () => {
  /*
   * v2.613 TESTDOC2613-05: 대상을 agent 디렉터리에서 agent 디렉터리 + 각 모듈의 push.js·perfPush.js 로, 이름을
   * `push|run` 에서 `push|pull|run` 으로 넓혔다 — v2.566 의 사고 모듈 자체가 `sanswitch/perfPush.js`(agent 밖)
   * 였고 `pull*Now` 4개는 어떤 테스트도 부르지 않았다. 폴러의 `poll*Once|run*Now` 는 **여기서 부르지 않는다**
   * — 그것은 등록 장비에 실제로 접속하는 수집이다(목 없이는 위험). 기대 목록은 **열거**한다(`length >= N`
   * 은 추가를 잊은 것을 잡지 못한다).
   */
  const ENTRY_RE = /export async function ((?:push|pull|run)\w*(?:Now|Once))\s*\(\s*(?:\.\.\.\w+)?\s*\)/g;
  const targetFiles = () => {
    const out = [];
    for (const f of fs.readdirSync(path.join(SRC, 'agent'))) if (f.endsWith('.js')) out.push(`agent/${f}`);
    for (const d of fs.readdirSync(SRC, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of ['push.js', 'perfPush.js']) if (fs.existsSync(path.join(SRC, d.name, f))) out.push(`${d.name}/${f}`);
    }
    return out.sort();
  };
  const EXPECTED = [
    'agent/bmstorWorker.js::runBmstorWorkerOnce', 'agent/capacityPush.js::pushCapacityNow', 'agent/captureWorker.js::runCaptureWorkerOnce',
    'agent/configPush.js::pushConfigNow', 'agent/curUserConfigPull.js::pullCurUserConfigNow', 'agent/cvpConfigPull.js::pullCvpConfigNow',
    'agent/edgeLogWorker.js::runEdgeLogWorkerOnce', 'agent/fleetPush.js::pushFleetNow', 'agent/gpuGuestConfigPull.js::pullGpuGuestConfigNow',
    'agent/gpuGuestPush.js::pushGpuGuestNow', 'agent/guestDiskPush.js::pushGuestDiskNow', 'agent/idracScanWorker.js::runIdracScanWorkerOnce',
    'agent/inventoryPush.js::pushInventoryNow', 'agent/ipScanWorker.js::runIpScanAgentOnce', 'agent/linkCheckWorker.js::runLinkCheckWorkerOnce',
    'agent/logQueryWorker.js::runLogQueryWorkerOnce', 'agent/partFaultConfigPull.js::pullPartFaultConfigNow', 'agent/pduConfigPull.js::pullPduConfigNow',
    'agent/pingWorker.js::runPingWorkerOnce', 'agent/sanSwitchConfigPull.js::pullSanSwitchConfigNow', 'agent/storageConfigPull.js::pullStorageConfigNow',
    'agent/svcmonConfigPull.js::pullSvcmonConfigNow', 'agent/svcmonPush.js::pushSvcmonNow', 'agent/usersConfigPull.js::pullUsersConfigNow',
    'agent/vmSeriesConfigPull.js::pullVmSeriesConfigNow',
    'cvp/push.js::pushCvpNow', 'pdu/push.js::pushPduNow', 'sanswitch/perfPush.js::pushPerfNow', 'sanswitch/push.js::pushSanSwitchNow', 'storage/push.js::pushStorageNow',
  ];
  test('★ 진입 함수 목록은 열거된 기대 목록과 같다(새 push/pull 을 만들면 여기에 더하고 호출 테스트를 함께 쓴다)', () => {
    const found = [];
    for (const rel of targetFiles()) {
      const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
      for (const m of src.matchAll(ENTRY_RE)) found.push(`${rel}::${m[1]}`);
    }
    assert.deepEqual(found.sort(), [...EXPECTED].sort());
  });
  test('★ 중앙 미설정 상태에서 전부 즉시 반환한다 — 던지지 않는다', async () => {
    /*
     * v2.566 의 결함(`perfPush.js` 의 TDZ)은 **함수 첫 줄에서** 터졌다. 순수 헬퍼만 고정하는
     * 테스트는 그것을 통과시켰다. 여기서는 진입 함수를 **실제로 부른다** — `CENTRAL_URL` 이
     * 없으므로 전부 조기 반환(또는 잡힌 실패)해야 하고, 그 과정에서 TDZ·오타는 즉시 드러난다.
     */
    const errors = [];
    let called = 0;
    for (const key of EXPECTED) {
      const [rel, name] = key.split('::');
      const mod = await import(path.join(SRC, rel));
      const fn = mod[name];
      assert.equal(typeof fn, 'function', `${key} 가 함수가 아니다`);
      called += 1;
      try { await fn(); } catch (e) { errors.push(`${key} → ${e?.message}`); }
    }
    assert.equal(called, EXPECTED.length);
    assert.deepEqual(errors, [], `진입 함수가 던졌다: ${errors.join(' · ')}`);
  });
});
