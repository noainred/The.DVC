import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });
process.env.COLLECTOR_HTTP_ALLOW = '*'; // 2026-10-09 S-09 이후 원격 http 등록은 예외·허용 목록만 — 이 테스트는 평문 픽스처를 쓴다

process.env.CONFIG_DIR = tmpDir('idpush-');

let addCollector, findCollectorForAgent, pushIdracScan, getIdracScanJobLog;
before(async () => {
  ({ addCollector } = await import('../src/collector/registry.js'));
  ({ findCollectorForAgent, pushIdracScan } = await import('../src/central/idracScanPush.js'));
  ({ getIdracScanJobLog } = await import('../src/central/idracScanJobs.js'));
});

test('findCollectorForAgent: 원본 토큰 포함 반환(대소문자 무관, 마스킹 금지)', () => {
  addCollector({ id: 'oc2sandbox', name: 'oc2sandbox', url: 'http://10.0.0.9:4000', token: 'SECRET-TOKEN', datacenter: 'oc2sandbox', enabled: true });
  // 에이전트 이름 대소문자가 달라도 매칭.
  const c = findCollectorForAgent('OC2Sandbox');
  assert.ok(c, '수집 서버 매칭');
  assert.equal(c.url, 'http://10.0.0.9:4000');
  // ★ PUSH 인증에 쓰이는 토큰 원본이 반드시 포함돼야 한다(listCollectors 마스킹 회귀 방지).
  assert.equal(c.token, 'SECRET-TOKEN', 'findCollectorForAgent는 마스킹 아닌 원본 토큰을 준다');
});

test('pushIdracScan: 매칭 수집 서버(URL) 없으면 ok:false + 안내', () => {
  const r = pushIdracScan('no-such-agent', { ips: '10.0.0.1', username: 'root', password: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.reason || '', /수집 서버/);
});

test('pushIdracScan: URL 끝 슬래시 정규화 — 이중 슬래시(//api) 방지(연결 테스트와 파리티)', () => {
  // 수집 서버 URL을 '.../:4000/' 처럼 끝 슬래시 포함해 저장한 경우.
  addCollector({ id: 'wa-irs', name: 'WA-IRS', url: 'http://192.168.40.221:4000/', token: 'T', datacenter: 'wa', enabled: true });
  const r = pushIdracScan('WA-IRS', { ips: '192.168.40.10', username: 'root', password: 'x' });
  assert.equal(r.ok, true, 'PUSH 잡 생성');
  const log = getIdracScanJobLog(r.reqId);
  const startMsg = (log.events || []).map((e) => e.msg || '').join(' ');
  // 정규화된 URL(끝 슬래시 없음)이 로그에 남고, 이중 슬래시가 없어야 한다.
  assert.match(startMsg, /http:\/\/192\.168\.40\.221:4000\b/, '정규화된 엣지 URL 표기');
  assert.ok(!startMsg.includes('4000//'), '이중 슬래시(//api) 없음');
});
