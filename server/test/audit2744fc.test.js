/**
 * test/audit2744fc.test.js — v2.744(세 번 반복 3회차) 최종 검토 그룹 FC.
 *
 * RG2744-02 — preserveCorrupt 의 콘솔 줄은 RY 가 요약(summarizeLoadReason)으로 바꿨는데, **같은 catch 블록**에서 호출부가 직접 찍는
 *   console.error/warn 은 `err.message` 원문을 그대로 찍었다. V8 의 JSON.parse 오류는 오류 위치 앞뒤 원문 약 10자를 싣는다
 *   (재현: `"totpSecret": SuperSecret…` → `Unexpected token 'S', ..."pSecret": SuperSecre"... is not valid JSON`). 한 손상 사건에서
 *   요약 줄과 원문 줄이 함께 남아 요약이 무의미했다 — 콘솔 링버퍼는 /admin/logs·로그 분석의 원천이고, 엣지에서는 엣지 로그로 중앙에 당겨진다.
 *   ① 담당 파일 6곳(users.json · mail.json · agent-assignments.json · agent-results.json · central-agent-gpu-guest.json ·
 *      central-agent-users.json)을 **실제 모듈 로드**로 본다(콘솔을 가로챈다). 접두 문구는 그대로다(로그 분석 규칙이 그 문구를 본다).
 *   ② 소스 스윕 — 'catch 블록 안에서 preserveCorrupt 와 함께, 그 catch 변수의 원문(.message · ${e} · String(e))을 콘솔에 찍는 꼴' 을
 *      server/src 전체에서 찾는다. 담당 파일(OWNED)은 0 이어야 하고, 나머지(PENDING_LEAD)는 리드가 통합하며 줄인다 — 고쳐진 파일이
 *      목록에 남아 있으면 이 테스트가 실패해 허용 목록을 줄이게 한다.
 * RG2744-05 — 파트 장애 스캔의 등록부 손상 표지(registryUnreadable)는 사유를 관리자용 요약(분류 + 줄·칸·위치 · 시스템 오류 코드)으로
 *   저장한다. 같은 릴리스의 RD 규칙(central/fleet.js fleetPartialsSummary)은 비-admin 에 분류 고정 문구(label)만 준다 — 그런데
 *   GET /tools/part-faults · /status · POST /scan 의 마지막 실행 기록(local · edgeAgents[] · edgeAgents[].scanned)과 엣지 push 상태가
 *   역할과 무관하게 그 요약을 실었다(tools 권한 operator 가 받는다). 저장은 그대로 두고 **응답에서** 역할로 가린다(실제 api 라우터).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fc-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', IPAM_WRITE_WORKER: '0',
  COLLECTOR_TOKEN: 'col-2744fc', CENTRAL_TOKEN: 'ctok-2744fc', AGENT_NAME: 'central-fc',
});
delete process.env.CENTRAL_URL;
delete process.env.DEFAULT_ADMIN_PASSWORD;
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } },
}));

const SECRET = 'SuperSecret123!';
// 원문 조각의 흔적 — 비밀 값 앞 글자 · V8 조각 형식. ⚠ 'assword' 를 넣지 말 것 — auth 시드 줄의 'initial-admin-password.txt' 가 걸린다.
const LEAK = /SuperSecre|uperSecret|is not valid JSON/;
// 비밀 값 바로 앞의 따옴표를 빠뜨린 손편집 — V8 메시지가 그 값의 앞 글자를 싣는다.
const BAD = {
  'users.json': `{"users":[{"username":"admin","role":"admin","passwordHash":"x","totpSecret": ${SECRET}}]}`,
  'mail.json': `{"enabled":true,"smtp":{"host":"10.9.0.5","user":"mailer","password": ${SECRET}}}`,
  'agent-assignments.json': `{"assignments":[{"agent":"edge-a","username":"root","password": ${SECRET}}]}`,
  'agent-results.json': `{"edge-a":{"at":1,"note": ${SECRET}}}`,
  'central-agent-gpu-guest.json': `{"edge-a":{"enabled":true,"password": ${SECRET}}}`,
  'central-agent-users.json': `{"edge-a":{"users":[{"username":"u1","passwordHash": ${SECRET}}]}}`,
};
for (const [n, body] of Object.entries(BAD)) fs.writeFileSync(path.join(TMP, n), body);
// RG2744-05: 콤마 하나를 빠뜨린 스토리지 등록부 — V8 이 줄·칸을 주는 형식(관리자용 요약에 위치가 붙는다).
fs.writeFileSync(path.join(TMP, 'storage-devices.json'), '{\n  "devices": [\n    {"id": "st1" "type": "unity480", "host": "10.9.0.21"}\n  ]\n}');

const v8msg = (txt) => { try { JSON.parse(txt); } catch (e) { return e.message; } return ''; };

/** console.* 를 잡는다(줄은 링버퍼 → /admin/logs · 엣지 로그로 나간다). */
async function capture(fn) {
  const lines = []; const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const k of Object.keys(saved)) console[k] = (...a) => { lines.push(a.map(String).join(' ')); };
  try { const v = await fn(); return { v, lines }; } finally { Object.assign(console, saved); }
}
const corruptCopies = (base) => fs.readdirSync(TMP).filter((n) => n.startsWith(`${base}.corrupt.`));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

/* ════════════════════ RG2744-02 ① 실제 모듈 로드 ════════════════════ */

test('RG2744-02 ① 전제: 손편집 파일의 V8 원문은 비밀 값 조각을 싣는다', () => {
  for (const [n, body] of Object.entries(BAD)) assert.match(v8msg(body), LEAK, `${n}: ${v8msg(body)}`);
});

/**
 * 한 파일의 로드를 콘솔 가로채기 안에서 돌리고, 그 파일의 호출부 줄(prefix)이 남았는지 · 원문 조각이 없는지 본다.
 * 보존(.corrupt.*)은 예전 그대로여야 한다(이 수정은 콘솔 문구만 바꾼다).
 */
async function checkLoad(file, prefix, fn) {
  const { lines } = await capture(fn);
  const all = lines.join('\n');
  const own = lines.filter((l) => prefix.test(l));
  assert.ok(own.length >= 1, `${file}: 호출부 줄(${prefix})이 남아야 한다 — 로그 분석 규칙이 그 문구를 본다\n${all}`);
  for (const l of own) assert.match(l, /JSON 형식 오류/, `${file}: 분류는 남긴다 — ${l}`);
  assert.doesNotMatch(all, LEAK, `${file}: 콘솔에 원문 조각이 남았다\n${all}`);
  assert.equal(corruptCopies(file).length, 1, `${file}: 손상본 보존(.corrupt.*)은 그대로`);
  return lines;
}

test('RG2744-02 ① users.json(TOTP 시크릿) — [auth] 줄에 원문 조각이 없다', async () => {
  const auth = await import('../src/auth/auth.js');
  await checkLoad('users.json', /\[auth\] Failed to parse users\.json: /, () => auth.loadUsers());
});

test('RG2744-02 ① mail.json(SMTP 비밀번호) — [mail] 줄에 원문 조각이 없다', async () => {
  const mail = await import('../src/mail/settings.js');
  await checkLoad('mail.json', /\[mail\] 설정 로드 실패 — 원본을 \.corrupt 로 보존하고 기본값으로 시작합니다: /, () => mail.load());
});

test('RG2744-02 ① agent-results.json(모듈 로드) · agent-assignments.json(iDRAC 스캔 비밀번호) — [central] 줄에 원문 조각이 없다', async () => {
  let mod;
  await checkLoad('agent-results.json', /\[central\] agent-results\.json 파싱 실패: /, async () => { mod = await import('../src/central/assignments.js'); });
  const lines = await checkLoad('agent-assignments.json', /\[central\] agent-assignments\.json 파싱 실패: /, () => mod.loadAssignments());
  assert.ok(lines.length >= 2);
  // 손상 사유(설정 pull 503 이 쓰는 값)도 원문 조각이 없다 — v2.744 리드가 이미 요약한 경로(되돌림 확인).
  assert.doesNotMatch(JSON.stringify(mod.assignmentsLoadError() || {}), LEAK);
});

test('RG2744-02 ① central-agent-gpu-guest.json(게스트 비밀번호) — [central] 줄에 원문 조각이 없다', async () => {
  await checkLoad('central-agent-gpu-guest.json', /\[central\] central-agent-gpu-guest\.json 파싱 실패: /, () => import('../src/central/agentGpuGuestConfig.js'));
});

test('RG2744-02 ① central-agent-users.json(배포 사용자 해시) — [central] 줄에 원문 조각이 없다 · 503 detail 도', async () => {
  let mod;
  await checkLoad('central-agent-users.json', /\[central\] central-agent-users\.json 파싱 실패: /, async () => { mod = await import('../src/central/agentUsers.js'); });
  // 메모리의 로드 오류(라우트가 summarizeRegistryError 로 요약해 엣지에 준다)는 그대로 둔다 — 관리자용 위치 정보를 만드는 원천이다.
  const { summarizeRegistryError } = await import('../src/util/registryCore.js');
  const sum = summarizeRegistryError(mod.registryLoadError());
  assert.equal(sum?.code, 'parse-error');
  assert.doesNotMatch(sum.text, LEAK);
});

test('RG2744-02 ① 로그 분석 규칙이 고친 줄을 그대로 분류한다(접두 문구 불변)', async () => {
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const re = (id) => { const r = CATALOG_RULES.find((x) => x.id === id); assert.ok(r, id); return new RegExp(r.re); };
  const lines = [
    ['auth-users-corrupt', '[auth] Failed to parse users.json: JSON 형식 오류'],
    ['mail-settings-corrupt', '[mail] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: JSON 형식 오류'],
    ['central-store-corrupt', '[central] agent-assignments.json 파싱 실패: JSON 형식 오류'],
    ['central-store-corrupt', '[central] agent-results.json 파싱 실패: JSON 형식 오류'],
    ['central-store-corrupt', '[central] central-agent-gpu-guest.json 파싱 실패: JSON 형식 오류'],
    ['central-store-corrupt', '[central] central-agent-users.json 파싱 실패: JSON 형식 오류'],
  ];
  for (const [id, l] of lines) assert.match(l, re(id), `${id}: ${l}`);
});

/* ════════════════════ RG2744-02 ② 소스 스윕 ════════════════════ */

const REGEX_OK_BEFORE = /[([{;,:=!&|?+\-*%~^<>]$/;
/** 문자열·템플릿(중첩 `${}`)·정규식을 건너뛰며 짝 괄호의 위치를 찾는다. 주석은 미리 지운다. */
function matchClose(s, open) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [pairs[s[open]]];
  let i = open + 1; let prev = s[open];
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j += 1; j += 1; } i = j + 1; prev = c; continue; }
    if (c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== '`') {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '{') { j = matchClose(s, j + 1) + 1; continue; }
        j += 1;
      }
      i = j + 1; prev = '`'; continue;
    }
    if (c === '/' && REGEX_OK_BEFORE.test(prev)) {
      let j = i + 1; let cls = false;
      while (j < s.length && (s[j] !== '/' || cls) && s[j] !== '\n') { if (s[j] === '\\') j += 1; else if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false; j += 1; }
      i = j + 1; prev = '/'; continue;
    }
    if (c === '{' || c === '(' || c === '[') stack.push(pairs[c]);
    else if (c === '}' || c === ')' || c === ']') { stack.pop(); if (!stack.length) return i; }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return s.length - 1;
}
// 원문을 요약하는 함수에 넘긴 참조는 허용한다(그 결과에는 원문 조각이 없다).
const SAFE_WRAP = /\b(?:safeLoadText|summarizeLoadReason|classifyLoadReason|summarizeRegistryError)\s*\(/g;
function stripSafeWraps(arg) {
  let out = ''; let last = 0; let m;
  SAFE_WRAP.lastIndex = 0;
  while ((m = SAFE_WRAP.exec(arg))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(arg, open);
    out += `${arg.slice(last, m.index)}SAFE()`;
    last = close + 1; SAFE_WRAP.lastIndex = last;
  }
  return out + arg.slice(last);
}
/** catch 블록 안에서 preserveCorrupt 와 함께, 그 catch 변수의 원문을 콘솔에 찍는 곳(줄 번호). */
function findRawLoadLogs(src) {
  const s = stripComments(src);
  const hits = [];
  const re = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[1].replace(/\$/g, '\\$');
    const open = m.index + m[0].length - 1;
    const body = s.slice(open, matchClose(s, open) + 1);
    if (!/\bpreserveCorrupt\s*\(/.test(body)) continue;
    const raw = new RegExp(`\\b${v}\\s*\\??\\.\\s*message\\b|\\$\\{\\s*${v}\\s*\\}|String\\(\\s*${v}\\s*\\)|\\$\\{\\s*${v}\\s*\\?\\?|\\|\\|\\s*${v}\\s*\\}|(?:^|[,(])\\s*${v}\\s*(?:[,)]|$)`);
    const cre = /\bconsole\s*\.\s*(?:error|warn|log|info|debug)\s*\(/g;
    let cm;
    while ((cm = cre.exec(body))) {
      const po = cm.index + cm[0].length - 1;
      const arg = stripSafeWraps(body.slice(po + 1, matchClose(body, po)));
      if (raw.test(arg)) hits.push(s.slice(0, open + cm.index).split('\n').length);
    }
  }
  return hits;
}

test('RG2744-02 ② 스윕 자체 — 원문 꼴은 잡고, 요약 함수를 거친 꼴·preserveCorrupt 없는 catch 는 잡지 않는다', () => {
  const flag = [
    'try { x(); } catch (err) { preserveCorrupt(F, err.message); console.error(`[a] 실패: ${err.message}`); }',
    'try { x(); } catch (e) { preserveCorrupt(F); console.warn(`[a] 실패(${e?.message || e}) — 보존`); }',
    'try { x(); } catch (e) {\n  if (e?.code !== "ENOENT") { console.warn(`[a] 실패(${e.message})`); preserveCorrupt(F, e.message); }\n}',
    'try { x(); } catch (e) { preserveCorrupt(F, e); console.error("[a] 실패:", e); }',
    'try { x(); } catch (e) { preserveCorrupt(F, e); console.error("[a] 실패: " + String(e)); }',
    'try { x(); } catch (ex) { preserveCorrupt(F, ex); console.log(`[a] ${ex}`); }',
  ];
  for (const s of flag) assert.equal(findRawLoadLogs(s).length, 1, s);
  const pass = [
    'try { x(); } catch (err) { preserveCorrupt(F, err.message); console.error(`[a] 실패: ${safeLoadText(err) || "사유 미상"}`); }',
    'try { x(); } catch (e) { preserveCorrupt(F, e?.message); console.warn(`[a] 실패(${summarizeLoadReason(e?.message)})`); }',
    'try { x(); } catch (e) { console.warn(`[a] 실패(${e.message})`); }',                    // preserveCorrupt 없음 — 이 스윕의 범위 밖
    'try { x(); } catch (e) { preserveCorrupt(F, e.message); console.error("[a] 손상 — 기본값으로 시작합니다"); }',
    '// catch (e) { preserveCorrupt(F); console.warn(`${e.message}`); }',                      // 주석
  ];
  for (const s of pass) assert.equal(findRawLoadLogs(s).length, 0, s);
  // 첫 줄 번호를 정확히 짚는다(주석 제거가 개행을 보존한다).
  assert.deepEqual(findRawLoadLogs('// a\n// b\ntry { x(); } catch (e) {\n  preserveCorrupt(F);\n  console.warn(`${e.message}`);\n}'), [5]);
});

/** 이 그룹(FC)이 고친 파일 — 0 이어야 한다. */
const OWNED = ['auth/auth.js', 'mail/settings.js', 'central/assignments.js', 'central/agentGpuGuestConfig.js', 'central/agentUsers.js'];
/**
 * ⚠ 리드 통합 대기 — FC 담당 밖이라 고치지 않았다(같은 꼴, 파일당 개수). 비밀이 없는 설정·상태 파일이 대부분이지만 판정 기준(원문을
 *   콘솔에 싣지 않는다)은 같다. 리드가 고친 파일은 **이 목록에서 지울 것** — 고쳐진 파일이 남아 있으면 아래 테스트가 실패한다.
 */
const PENDING_LEAD = {
  // v2.744 리드 통합: FC 가 남긴 25곳(24파일)을 같은 방법(safeLoadText)으로 고쳐 비웠다 — 새 위반은 이 목록에 넣지 말고 고칠 것.
};

function sweepAll() {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith('.js')) {
        const h = findRawLoadLogs(fs.readFileSync(p, 'utf8'));
        if (h.length) out[path.relative(SRC, p).split(path.sep).join('/')] = h;
      }
    }
  };
  walk(SRC);
  return out;
}

test('RG2744-02 ② 소스 스윕 — 담당 파일은 0 · 나머지는 리드 통합 대기 목록 안에서만(새 위반 0)', () => {
  const hits = sweepAll();
  for (const f of OWNED) assert.equal(hits[f], undefined, `${f}: 로드 catch 의 원문 콘솔 출력이 남았다(줄 ${hits[f]})`);
  const fresh = Object.entries(hits).filter(([f, h]) => !Object.hasOwn(PENDING_LEAD, f) || h.length > PENDING_LEAD[f]);
  assert.deepEqual(fresh.map(([f, h]) => `${f}:${h.join(',')}`), [],
    '로드 catch 에서 preserveCorrupt 와 함께 원문(err.message 류)을 콘솔에 찍지 말 것 — safeLoadText(err) 로 요약한다');
  // 허용 목록은 줄이기만 한다 — 고쳐진 파일이 남아 있으면 지운다.
  const stale = Object.keys(PENDING_LEAD).filter((f) => (hits[f]?.length || 0) < PENDING_LEAD[f]);
  assert.deepEqual(stale, [], `고쳐진 파일을 PENDING_LEAD 에서 지울 것: ${stale.join(', ')}`);
});

/* ════════════════════ RG2744-05 파트 장애 응답의 등록부 손상 사유 ════════════════════ */

test('RG2744-05 단위 — maskRegistryUnreadable: 비-admin 판본은 분류 문구만 · 원본은 그대로 · 모양(단건·장비군 맵) 둘 다', async () => {
  const { lastView, pushView, maskRegistryUnreadable } = await import('../src/routes/api/partFaults.js');
  const last = {
    at: 1,
    local: { storage: { devices: 0, registryUnreadable: { at: 5, code: 'parse-error', reason: 'JSON 형식 오류(3번째 줄 18번째 칸)' } }, idrac: { devices: 2 } },
    edgeAgents: [{
      agent: 'edge-a',
      registryUnreadable: { storage: { at: 6, reason: 'JSON 형식 오류(위치 812)' }, sanswitch: { at: 7, reason: '등록부 읽기 오류(EACCES)' } },
      scanned: { pdu: { registryUnreadable: { at: 8, code: 'corrupt-only', reason: '등록부 파일이 없고 손상 보존본만 있음' } } },
    }, {
      // 2.744 이전 엣지 — 원문을 그대로 보냈다(중앙 수신은 200자로 자르기만 한다)
      agent: 'edge-old', registryUnreadable: { storage: { at: 9, reason: v8msg(`{"password": ${SECRET}}`) } },
    }],
    notify: { sent: 1, results: [{ partKey: 'idrac:10.9.0.11:psu:1' }] },
  };
  const before = structuredClone(last);
  const v = lastView(last, false);
  assert.deepEqual(last, before, '원본(poller _last — 관리자 응답과 공유)은 바꾸지 않는다');
  assert.equal(v.local.storage.registryUnreadable.reason, 'JSON 형식 오류');
  assert.equal(v.local.storage.registryUnreadable.code, 'parse-error');
  assert.equal(v.local.storage.registryUnreadable.at, 5);
  assert.equal(v.local.storage.registryUnreadable.reasonDetailHidden, true);
  assert.equal(v.local.idrac, last.local.idrac, '바뀌지 않은 경로는 그대로 공유');
  assert.equal(v.edgeAgents[0].registryUnreadable.storage.reason, 'JSON 형식 오류');
  assert.equal(v.edgeAgents[0].registryUnreadable.sanswitch.reason, '등록부 읽기 오류');
  assert.equal(v.edgeAgents[0].registryUnreadable.sanswitch.code, 'read-error');
  assert.equal(v.edgeAgents[0].scanned.pdu.registryUnreadable.reason, '등록부 파일이 없고 손상 보존본만 있음');
  assert.equal(v.edgeAgents[1].registryUnreadable.storage.reason, 'JSON 형식 오류');
  assert.equal(v.notify.resultsHidden, true, '기존 가림(notify.results)은 그대로');
  const txt = JSON.stringify(v);
  assert.doesNotMatch(txt, /번째 줄|위치 \d|EACCES/, txt);
  assert.doesNotMatch(txt, LEAK, txt);
  // 관리자 판본은 요약 그대로(위치·코드 — 조치 단서).
  assert.equal(lastView(last, true), last);
  assert.match(lastView(last, true).local.storage.registryUnreadable.reason, /3번째 줄 18번째 칸/);
  // 엣지 push 상태 모양(엣지 노드의 GET /tools/part-faults · /status 의 push)
  const push = { configured: true, last: { ok: true, scanned: { storage: { registryUnreadable: { at: 1, code: 'parse-error', reason: 'JSON 형식 오류(2번째 줄 4번째 칸)' } } }, registryUnreadable: { storage: { at: 1, code: 'parse-error', reason: 'JSON 형식 오류(2번째 줄 4번째 칸)' } } } };
  const pb = structuredClone(push);
  const pv = pushView(push, false);
  assert.deepEqual(push, pb);
  assert.doesNotMatch(JSON.stringify(pv), /번째 줄/);
  assert.equal(pv.last.registryUnreadable.storage.reason, 'JSON 형식 오류');
  assert.equal(pushView(push, true), push);
  assert.equal(pushView(null, false), null);
  // 표지가 아닌 값(진리값 등)·순환이 깊은 값에도 던지지 않는다.
  assert.equal(maskRegistryUnreadable({ registryUnreadable: true }).registryUnreadable, true);
  let deep = { registryUnreadable: { at: 1, reason: 'JSON 형식 오류(위치 3)' } };
  for (let i = 0; i < 50; i += 1) deep = { a: deep };
  assert.doesNotThrow(() => maskRegistryUnreadable(deep));
});

test('RG2744-05 라우트 — operator 가 받는 GET /tools/part-faults · /status · POST /scan 에 등록부 손상 위치가 없다(admin 은 그대로)', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const edge = await import('../src/central/partFaultEdge.js');
  const { runPartFaultsNow } = await import('../src/partfault/poller.js');
  const storage = await import('../src/storage/registry.js');
  // 중앙 스토리지 등록부는 손상(파일 맨 위에서 썼다) — 관리자용 요약에 줄·칸이 붙는 형식이다.
  const { lines } = await capture(() => storage.loadRegistry?.() ?? storage.listDevices?.());
  void lines;
  assert.ok(storage.registryLoadError(), '전제: 스토리지 등록부 손상');
  // 엣지 보고 — 등록부 손상 표지(장비군 맵)와 scanned 안의 단건 표지 둘 다.
  edge._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const ru = { at: 11, code: 'parse-error', reason: 'JSON 형식 오류(7번째 줄 3번째 칸)' };
  const put = await edge.putEdgeReport('edge-a', { v: 2, agent: 'edge-a', version: '2.744.0', at: Date.now(), devices: [],
    scanned: { storage: { devices: 0, registryUnreadable: ru } }, registryUnreadable: { storage: ru } });
  assert.equal(put.ok, true, JSON.stringify(put));
  const r = await runPartFaultsNow({ notify: false, reason: 'manual' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.local.storage.registryUnreadable.reason, /번째 줄/, '전제: 저장(마지막 실행 기록)은 관리자용 요약 그대로');

  const app = express(); app.use(express.json());
  app.use((req, _r, n) => { const role = req.get('x-role') || 'admin'; req.user = { username: role === 'admin' ? 'adm' : `u-${role}`, role, scope: null }; n(); });
  app.use('/api', api);
  const base = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((q) => { s.closeAllConnections?.(); s.close(q); })); res(`http://127.0.0.1:${s.address().port}`); }); });
  const call = async (method, p, role) => {
    const res = await fetch(`${base}/api${p}`, { method, headers: { 'x-role': role, 'Content-Type': 'application/json' } });
    return { status: res.status, body: await res.json() };
  };

  for (const [method, p, pick] of [
    ['GET', '/tools/part-faults', (b) => b.poller.last],
    ['GET', '/tools/part-faults/status', (b) => b.last],
    ['POST', '/tools/part-faults/scan', (b) => b],
  ]) {
    const op = await call(method, p, 'operator');
    assert.equal(op.status, 200, `${method} ${p}: ${JSON.stringify(op.body).slice(0, 300)}`);
    const last = pick(op.body);
    assert.equal(last.local.storage.registryUnreadable.reason, 'JSON 형식 오류', `${method} ${p}`);
    assert.equal(last.local.storage.registryUnreadable.reasonDetailHidden, true);
    const ea = last.edgeAgents.find((a) => a.agent === 'edge-a');
    assert.ok(ea, `${method} ${p}: 엣지 보고`);
    assert.equal(ea.registryUnreadable.storage.reason, 'JSON 형식 오류');
    assert.equal(ea.scanned.storage.registryUnreadable.reason, 'JSON 형식 오류');
    assert.doesNotMatch(JSON.stringify(op.body), /번째 줄|위치 \d/, `${method} ${p}: operator 응답에 관리자용 위치가 있다`);
    // 관리자 판본은 위치를 그대로 싣는다(조치 단서) — operator 요청이 공유 원본을 바꾸지 않았다는 확인이기도 하다.
    const ad = await call(method, p, 'admin');
    assert.equal(ad.status, 200);
    const al = pick(ad.body);
    assert.match(al.local.storage.registryUnreadable.reason, /번째 줄/, `${method} ${p}: admin`);
    assert.match(al.edgeAgents.find((a) => a.agent === 'edge-a').registryUnreadable.storage.reason, /7번째 줄 3번째 칸/);
  }
});

test('RG2744-05 소스 — 라우트의 push 상태는 전부 pushView 를 거친다(형제 경로 누락 금지)', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/partFaults.js'), 'utf8'));
  const calls = (s.match(/partFaultPushStatus\(\)/g) || []).length;
  const wrapped = (s.match(/pushView\(\s*partFaultPushStatus\(\)/g) || []).length;
  assert.ok(calls >= 2, '전제: push 상태를 싣는 응답이 있다');
  assert.equal(wrapped, calls, 'partFaultPushStatus() 를 응답에 그대로 싣지 말 것 — pushView(…, isAdmin) 로');
});
