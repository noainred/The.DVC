// v2.744 최종 수정분 적대적 검토 — VC 검토자가 그룹 파일 밖에서 찾은 형제 경로 4곳(리드 후속).
//   손상본을 보존하지 않는 로드 catch 라 audit2744fc 의 넓힌 스윕(preserveCorrupt·.corrupt 가 있는 파일만)에도 걸리지 않았다:
//   ① config.js loadVcenterConfig — vcenters.json(vCenter 비밀번호가 기본 평문)의 V8 JSON.parse 오류 원문을 `[config] Failed to parse` 줄에
//      그대로 찍었다. 이 경로는 파일을 옮기지 않아 수집 주기마다 같은 줄이 반복되고, 링 버퍼 → /admin/logs·엣지 로그로 나간다(25초에 3번 — 검토자 실측).
//   ② config.js readDbDir — db-location.json(ENOENT 아닌 오류는 파싱 오류도 같은 줄)  ③ central/fleet.js — central-fleet.json
//   ④ idrac/sensorDetailCache.js — idrac-sensor-cache.json
// 규칙(CLAUDE.md v2.744 최종 검토): 로드 오류 원문은 콘솔 줄에도 싣지 않는다 — safeLoadText 한 벌.
// 재현은 실제 모듈을 자식 프로세스로 띄워(CONFIG_DIR 은 모듈 로드 때 굳는다) 표준 출력·오류에 비밀 조각이 있는지 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(SERVER, 'src');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744vlead-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const SECRET = 'VcPassw0rdSecret2744';
const FRAG = SECRET.slice(0, 10);
const v8Text = (() => { try { JSON.parse(`{"p": ${SECRET}}`); } catch (e) { return e.message; } return ''; })();

/** CONFIG_DIR 에 파일을 두고 자식 프로세스에서 모듈을 불러 출력 전체를 돌려준다. */
function runWith(files, body) {
  const dir = fs.mkdtempSync(path.join(base, 'cfg-'));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    encoding: 'utf8', timeout: 20000, cwd: SERVER,
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', VCENTERS_EXAMPLE_FALLBACK: 'false', NODE_OPTIONS: '' },
  });
  return { out: `${r.stdout || ''}\n${r.stderr || ''}`, status: r.status };
}

test('⓪ 전제: V8 의 JSON.parse 오류 문구는 비밀 값 조각을 담는다', () => {
  assert.ok(v8Text.includes(FRAG), v8Text);
});

test('① vcenters.json 손상 — [config] Failed to parse 줄에 비밀번호 조각이 없다(요약만)', () => {
  const r = runWith(
    { 'vcenters.json': `{"vcenters":[{"id":"vc-x","host":"10.0.0.1","username":"u","password": ${SECRET}}]}` },
    `const { loadVcenterConfig } = await import(${JSON.stringify(path.join(SRC, 'config.js'))}); loadVcenterConfig(); loadVcenterConfig();`,
  );
  assert.match(r.out, /\[config\] Failed to parse .*vcenters\.json: JSON 형식 오류/, r.out);
  assert.doesNotMatch(r.out, new RegExp(FRAG), r.out);
});

test('② db-location.json 손상 — 폴백 줄에 원문 조각이 없다', () => {
  const r = runWith(
    { 'db-location.json': `{"dbDir": ${SECRET}}` },
    `await import(${JSON.stringify(path.join(SRC, 'config.js'))});`,
  );
  assert.match(r.out, /\[db-location\] .*기본 경로\(CONFIG_DIR\)로 폴백.*JSON 형식 오류/, r.out);
  assert.doesNotMatch(r.out, new RegExp(FRAG), r.out);
});

test('③ central-fleet.json 손상 — 빈 캐시로 시작하는 줄에 원문 조각이 없다', () => {
  const r = runWith(
    { 'central-fleet.json': `{"fleet":{"edge-a":{"baremetal":[{"name": ${SECRET}}]}}}` },
    `await import(${JSON.stringify(path.join(SRC, 'central/fleet.js'))});`,
  );
  assert.match(r.out, /\[central-fleet\] central-fleet\.json 를 읽지 못해 빈 캐시로 시작합니다.*JSON 형식 오류/, r.out);
  assert.doesNotMatch(r.out, new RegExp(FRAG), r.out);
});

test('④ idrac-sensor-cache.json 손상 — 새로 시작하는 줄에 원문 조각이 없다', () => {
  const r = runWith(
    { 'idrac-sensor-cache.json': `{"srv-1": {"sensors": [{"name": ${SECRET}}]}}` },
    `const m = await import(${JSON.stringify(path.join(SRC, 'idrac/sensorDetailCache.js'))}); m.localSensorDetail('srv-1');`,
  );
  assert.match(r.out, /\[idrac\] 센서 상세 캐시를 읽지 못해 새로 시작합니다: JSON 형식 오류/, r.out);
  assert.doesNotMatch(r.out, new RegExp(FRAG), r.out);
});

// 넓힌 스윕(검토자 스크립트를 옮김): `try { … JSON.parse( … } catch (v) { … console.*( … v.message / ${v} / String(v) … ) }` 꼴 전수.
//   손상본 보존 여부와 무관하게 본다 — 이번 4곳은 보존하지 않아 audit2744fc 스윕 밖이었다. 휴리스틱이다: 중간 변수를 거치는 꼴은 놓친다.
function matchClose(s, i) {
  const o = s[i]; const c = o === '{' ? '}' : o === '(' ? ')' : ']';
  let d = 0;
  for (let k = i; k < s.length; k++) { if (s[k] === o) d++; else if (s[k] === c) { d--; if (!d) return k; } }
  return s.length - 1;
}
function walk(d, out = []) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
function findRawParseLogs(src, label = '') {
  const s = stripComments(src);
  const hits = [];
  const re = /\btry\s*\{/g; let m;
  while ((m = re.exec(s))) {
    const o = m.index + m[0].length - 1; const c = matchClose(s, o);
    if (!/JSON\.parse\s*\(/.test(s.slice(o, c + 1))) continue;
    const cm = /^\s*catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(s.slice(c + 1, c + 200));
    if (!cm) continue;
    const co = c + 1 + cm.index + cm[0].length - 1; const cc = matchClose(s, co);
    const cbody = s.slice(co, cc + 1); const v = cm[1];
    const conRe = /\bconsole\s*\.\s*(?:error|warn|log|info)\s*\(/g; let k;
    while ((k = conRe.exec(cbody))) {
      const po = k.index + k[0].length - 1; const arg = cbody.slice(po + 1, matchClose(cbody, po));
      const raw = new RegExp(`\\b${v}\\s*\\??\\.\\s*message\\b|\\$\\{\\s*${v}\\s*\\}|\\|\\|\\s*${v}\\s*\\}|(?:^|[,(])\\s*${v}\\s*(?:[,)]|$)|String\\(\\s*${v}\\s*\\)`);
      if (raw.test(arg) && !/safeLoadText|summarizeLoadReason|summarizeRegistryError/.test(arg)) {
        hits.push(`${label}:${s.slice(0, co + k.index).split('\n').length}`);
      }
    }
  }
  return hits;
}

test('⑤ 스윕 자체 — 원문을 찍는 parse catch 는 잡고, 요약을 쓰는 것은 통과시킨다', () => {
  const bad = [
    'try { const j = JSON.parse(fs.readFileSync(f)); } catch (e) { console.error(`x ${e.message}`); }',
    'try { JSON.parse(t) } catch (err) { console.warn("x", err); }',
    'try { JSON.parse(t) } catch (e) { console.warn(`x ${e?.message || e}`); }',
  ];
  const good = [
    'try { JSON.parse(t) } catch (e) { console.warn(`x ${safeLoadText(e)}`); }',
    'try { JSON.parse(t) } catch (e) { console.warn("x — 형식 오류"); }',
    'try { doIo() } catch (e) { console.warn(`x ${e.message}`); }',
  ];
  for (const b of bad) assert.equal(findRawParseLogs(b).length, 1, b);
  for (const g of good) assert.equal(findRawParseLogs(g).length, 0, g);
});

test('⑥ server/src 전수 — JSON.parse 를 감싼 catch 가 오류 원문을 콘솔에 찍는 곳이 0이다', () => {
  const hits = [];
  for (const f of walk(SRC)) hits.push(...findRawParseLogs(fs.readFileSync(f, 'utf8'), path.relative(SERVER, f)));
  assert.deepEqual(hits, [], `원문을 찍는 곳 — safeLoadText 로 요약할 것: ${hits.join(' · ')}`);
});
