// v2.744 회귀 검토 — 리드 통합분(RY 가 넘긴 '리드가 할 일' 1·2).
//   ① 중앙 puller 는 엣지 export 503 의 detail 원문을 오류 문구에 싣지 않는다 — 2.743 엣지는 등록부 JSON.parse 오류 원문(손상된 idrac.json 의
//      조각 — 비밀번호가 들어 있을 수 있다)을 보냈고 그 문구는 수집 서버 상태·콘솔·화면에 실린다. 2.744 엣지가 보내는 registryError(코드·위치)는 살린다.
//   ② 중앙 설정 파일 손상 503(settingsUnreadable)·intervalsUnreadable·perfSettingsUnreadable·cvp settingsUnreadable 의 사유도 요약이다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rlead-'));
process.env.CONFIG_DIR = tmp;
process.env.CENTRAL_TOKEN = 'ctok-2744rlead';
process.env.COLLECTOR_TOKEN = 'coltok-2744rlead';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SECRET = 'SuperSecretPw2744';
// V8 은 조각을 잘라 보여 준다('…"assword": SuperSecre"…') — 검사는 실제로 보이는 앞부분으로 한다.
const FRAG = SECRET.slice(0, 10);
// 따옴표를 빠뜨린 손상 — V8 오류 문구가 이 조각을 그대로 담는다(직접 확인: 아래 ⓪).
const CORRUPT = `{"enabled": true, "password": ${SECRET}}`;
fs.writeFileSync(path.join(tmp, 'curuser-settings.json'), CORRUPT);

const servers = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use('/api/central', express.json({ limit: '16mb' }), centralRouter);
  const srv = http.createServer(app);
  servers.push(srv);
  base = `http://127.0.0.1:${await listen(srv)}/api/central`;
});
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⓪ 전제 — V8 의 JSON.parse 오류 문구가 실제로 파일 조각(비밀번호)을 담는다', () => {
  let msg = '';
  try { JSON.parse(CORRUPT); } catch (e) { msg = e.message; }
  assert.match(msg, new RegExp(FRAG), `이 전제가 깨지면 아래 검사가 공허하다: ${msg}`);
});

test('① exportFailError — 2.743 엣지의 원문 detail 은 요약으로 · 2.744 엣지의 registryError 위치는 살린다', async () => {
  const { exportFailError } = await import('../src/collector/puller.js');
  const mk = (body) => new Response(JSON.stringify(body), { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } });
  let raw = '';
  try { JSON.parse(CORRUPT); } catch (e) { raw = e.message; }
  // 2.743 엣지: detail 에 V8 원문, registryError 없음
  const old = await exportFailError(mk({ ok: false, reason: 'registryUnreadable', detail: raw }));
  assert.equal(old.edgeReason, 'registryUnreadable');
  assert.doesNotMatch(old.message, new RegExp(FRAG), `원문 조각이 오류 문구에 남았다: ${old.message}`);
  assert.match(old.message, /JSON 형식 오류/);
  // 2.744 엣지: 요약 detail + registryError(코드·위치)
  const neu = await exportFailError(mk({ ok: false, reason: 'registryUnreadable', detail: 'JSON 형식 오류(3번째 줄 5번째 칸)', registryError: { code: 'parse-error', line: 3, column: 5, position: null, sysCode: null } }));
  assert.match(neu.message, /JSON 형식 오류\(3번째 줄 5번째 칸\)/, neu.message);
  // 사유 없는 거절은 예전처럼 detail 없이
  const bare = await exportFailError(mk({ ok: false, reason: 'registryUnreadable' }));
  assert.doesNotMatch(bare.message, / — /);
});

test('② 중앙 설정 파일 손상 503 — detail 에 파일 조각을 싣지 않는다(콘솔 줄도)', async () => {
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let r; let j;
  try {
    r = await fetch(`${base}/curuser-config?agent=edge-a`, { headers: { 'X-Central-Token': 'ctok-2744rlead', 'X-Agent-Name': 'edge-a' } });
    j = await r.json();
  } finally { console.warn = ow; }
  assert.equal(r.status, 503, JSON.stringify(j));
  assert.equal(j.reason, 'settingsUnreadable');
  assert.doesNotMatch(JSON.stringify(j), new RegExp(FRAG), `503 본문에 파일 조각이 실렸다: ${j.detail}`);
  assert.match(j.detail, /JSON 형식 오류/, j.detail);
  assert.match(j.detail, /손상 보존본/, '조치 안내는 그대로');
  for (const w of warns) assert.doesNotMatch(w, new RegExp(FRAG), `콘솔에 파일 조각: ${w}`);
});

test('③ central.js — 설정 손상 사유를 원문으로 싣는 꼴이 남아 있지 않다(소스 검사)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/central.js'), 'utf8'));
  assert.ok(!/\b(e|perfErr|setErr)\.reason \|\| '사유 미상'\)\.slice\(/.test(src), '설정 손상 사유는 loadWhy(요약)를 지나야 한다');
  assert.match(src, /const loadWhy = \(reason\) => safeLoadText\(reason\)/);
});

test('④ safeLoadText — 따옴표 든 원문만 요약 · 사람 문장과 따옴표 없는 V8 문구는 그대로 · 설정 손상 사유는 출처에서 요약', async () => {
  const { safeLoadText } = await import('../src/util/atomicWrite.js');
  let raw = '';
  try { JSON.parse(CORRUPT); } catch (e) { raw = e.message; }
  assert.doesNotMatch(safeLoadText(raw), new RegExp(FRAG));
  assert.match(safeLoadText(raw), /JSON 형식 오류/);
  const human = '설정 파일을 읽지 못했습니다(JSON 형식 오류(1번째 줄 3번째 칸)) — 손상 보존본으로 옮겼습니다';
  assert.equal(safeLoadText(human), human, '이미 만든 사람 문장은 바꾸지 않는다(조치 단서 유지)');
  const quoteFree = 'Bad control character in string literal in JSON at position 32 (line 1 column 33)';
  assert.equal(safeLoadText(quoteFree), quoteFree);
  assert.equal(safeLoadText(''), '');
  const { makeSettingsLoadError } = await import('../src/util/settingsLoadError.js');
  const le = makeSettingsLoadError(() => path.join(tmp, 'nope.json'), { label: 'x' });
  le.corrupt(new SyntaxError(raw));
  assert.doesNotMatch(le.get().reason, new RegExp(FRAG), le.get().reason);
  assert.match(le.get().reason, /손상 보존본으로 옮겼습니다/);
});
