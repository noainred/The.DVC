// v2.902 — 설정 메뉴 재배치(사용자 요청 "설정에 메뉴가 너무 많아져서 스크롤바가 생기는데 … 최적화해서 재배치해줘").
// 1단이 19개(단독 항목 12개 + 그룹 7개)라 넓은 화면에서도 가로 스크롤이 생겼다 → 1단 묶음 9개 + 2단 항목으로.
// 고정하는 것:
//   ① 하위 키(#/settings/<k>) 48개는 하나도 바뀌지 않았다 — 딥링크 · linkcheck SETTINGS_PATHS · 문서가 이 키를 쓴다.
//   ② 모든 항목이 GROUP_ORDER 의 묶음 하나에 속하고, 같은 묶음은 붙어 있으며 순서가 GROUP_ORDER 와 같다(1단은 첫 등장 순서가 아니라 GROUP_ORDER 로 그린다).
//   ③ 1단 줄은 줄바꿈(가로 스크롤 아님).
//   ④ 화면·서버 문구에 옛 묶음 이름의 메뉴 경로('설정 › 수집 서버 › …' · '설정 › Security › …' 등)가 남지 않는다(주석 제외 — 버전 이력은 그대로 둔다).
//   ⑤ '설정 › <묶음> › <항목>' 문구는 그 항목이 실제로 그 묶음 안에 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/src/views/Settings.jsx'), 'utf8');

const ITEMS = [...SRC.matchAll(/^ {2}\{ k: '([a-z0-9-]+)', label: '([^']+)', C: \w+(?:, group: '([a-z-]+)')?/gm)]
  .map((m) => ({ k: m[1], label: m[2], group: m[3] || null }));
const GROUP_ORDER = JSON.parse((/const GROUP_ORDER = (\[[^\]]+\]);/.exec(SRC)?.[1] || '[]').replace(/'/g, '"'));
const GROUP_LABEL = Object.fromEntries([...SRC.matchAll(/^ {2}'?([a-z-]+)'?: \{ label: '([^']+)', desc: '/gm)].map((m) => [m[1], m[2]]));

// v2.901 까지의 48개 키 — 재배치는 묶음만 바꾼다(키를 바꾸면 북마크 · 딥링크 · 권한 문서가 깨진다).
const KEYS_V2901 = [
  'datacenter-admin', 'vcenter-admin', 'vcenter-test', 'veeam', 'bareos', 'nsx-admin', 'horizon-admin',
  'idrac-admin', 'idrac-scan-log', 'metrics', 'storage-intervals', 'power-off-check', 'vmseries', 'sansw-perf',
  'isilon-dirusage', 'guest-partition', 'gpu-collect', 'gpu-guest', 'gpu-guest-diag', 'guest-account', 'collectors',
  'agent-deploy', 'proxy', 'remote', 'users', 'edge-users', 'auth-ad', 'session-security', 'secrets', 'api-keys',
  'anomaly', 'host-access', 'peer-trust', 'security-self-check', 'ai-search', 'alerts', 'mail', 'tool-categories',
  'backup', 'nfs-mounts', 'dir-usage', 'vclogs', 'diagnostics', 'perf-monitor', 'log-analysis', 'audit', 'upgrade', 'about',
];

test('① 하위 키 48개는 그대로다(추가 · 삭제 · 이름 변경 없음)', () => {
  assert.equal(ITEMS.length, 48, `항목을 ${ITEMS.length}개 읽었다 — SUB 줄 모양('  { k: …, label: …, C: …')이 바뀌었는지 확인`);
  assert.deepEqual([...ITEMS.map((i) => i.k)].sort(), [...KEYS_V2901].sort());
  assert.equal(new Set(ITEMS.map((i) => i.k)).size, ITEMS.length, '중복 키');
});

test('② 모든 항목이 묶음 하나에 속하고, 1단은 GROUP_ORDER 9개 · 같은 묶음은 붙어 있다', () => {
  assert.equal(GROUP_ORDER.length, 9, `1단 묶음이 ${GROUP_ORDER.length}개 — 늘리면 1,440px 에서 다시 넘칠 수 있다(Chromium 으로 확인할 것)`);
  assert.deepEqual(Object.keys(GROUP_LABEL).sort(), [...GROUP_ORDER].sort(), 'GROUPS 와 GROUP_ORDER 가 어긋난다');
  const loose = ITEMS.filter((i) => !i.group || !GROUP_ORDER.includes(i.group));
  assert.deepEqual(loose.map((i) => i.k), [], '묶음 없는(또는 모르는 묶음) 항목 — 1단에 보이지 않아 메뉴로 들어갈 수 없다');
  const runs = ITEMS.map((i) => i.group).filter((g, n, a) => n === 0 || a[n - 1] !== g);
  assert.deepEqual(runs, GROUP_ORDER, '같은 묶음 항목이 흩어져 있거나 순서가 GROUP_ORDER 와 다르다');
  for (const g of GROUP_ORDER) assert.ok(!/[\u{1F300}-\u{1FAFF}⬆]/u.test(GROUP_LABEL[g]), `묶음 라벨에 이모지: ${GROUP_LABEL[g]}`);
  assert.ok(ITEMS.some((i) => i.k === 'vcenter-admin' && i.group === GROUP_ORDER[0]), '기본 화면(vcenter-admin)은 첫 묶음에 있어야 첫 진입 강조가 맞다');
});

test('③ 1단 줄은 GROUP_ORDER 로 그리고 줄바꿈한다(가로 스크롤 금지)', () => {
  const body = stripComments(SRC);
  assert.match(body, /GROUP_ORDER\.filter\(\(g\) => groupChildren\(g\)\.length > 0\)/);
  assert.match(body, /className="vcd-views" style=\{\{[^}]*flexWrap: 'wrap', overflowX: 'visible'/);
});

// ④ · ⑤ 문구 스윕 — 화면(web/src)과 서버 응답 · 메일(server/src). 테스트 · 주석 · 릴리스 노트(과거 기록)는 보지 않는다.
const SCAN = ['web/src', 'server/src'];
function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') yield* files(p); continue; }
    if (/\.(js|jsx|mjs)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) yield p;
  }
}
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;
const OLD_PATH = /설정\s*[›>]\s*(?:🖥️ |🖥 |🗄️ |🗄 |🎮 |🔌 |👤 |🛡️ |🛡 |📋 )?(vCenter 관리|수집 서버|GPU 사용량 수집|원격 접속 서버|User Control|Security|Log)(?!\(원격\)|[A-Za-z])/g;

test('④ 옛 묶음 이름의 메뉴 경로가 화면 · 서버 문구에 남지 않는다', () => {
  const hits = [];
  for (const dir of SCAN) {
    for (const f of files(path.join(ROOT, dir))) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of s.matchAll(OLD_PATH)) hits.push(`${path.relative(ROOT, f)}:${lineOf(s, m.index)} ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], '옛 경로(v2.901 까지의 묶음 이름) — 새 묶음 이름으로 고칠 것');
});

test('⑤ ‘설정 › <묶음> › <항목>’ 의 항목은 실제로 그 묶음에 있다', () => {
  const stripParen = (l) => l.replace(/\(.*$/, '').trim();
  const firstWord = (l) => l.split(' ')[0];
  // 라벨 앞 기호(⬆ 업그레이드)는 문구에 쓰지 않는다 — 글자부터 비교한다.
  const byLabel = Object.fromEntries(GROUP_ORDER.map((g) => [GROUP_LABEL[g], ITEMS.filter((i) => i.group === g).map((i) => i.label.replace(/^[^\p{L}\p{N}]+/u, ''))]));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`설정 › (${Object.keys(byLabel).map(esc).join('|')}) › ([^'"\`\\n]{1,40})`, 'g');
  const bad = [];
  let seen = 0;
  for (const dir of SCAN) {
    for (const f of files(path.join(ROOT, dir))) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of s.matchAll(re)) {
        seen++;
        const rest = m[2].replace(/^\*\*/, '');
        const ok = byLabel[m[1]].some((l) => rest.startsWith(l) || rest.startsWith(stripParen(l)) || rest.startsWith(`${firstWord(l)} `));
        if (!ok) bad.push(`${path.relative(ROOT, f)}:${lineOf(s, m.index)} ${m[0].slice(0, 60)}`);
      }
    }
  }
  assert.ok(seen > 50, `경로 문구를 ${seen}개만 찾았다 — 스윕 정규식 확인`);
  assert.deepEqual(bad, [], '묶음과 항목이 맞지 않는 메뉴 경로');
});
