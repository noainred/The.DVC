// v2.905 — 설정 메뉴 재배치(사용자 요청 "설정에 메뉴가 너무 많아져서 스크롤바가 생기는데 … 최적화해서 재배치해줘").
// 1단이 19개(단독 항목 12개 + 그룹 7개)라 넓은 화면에서도 가로 스크롤이 생겼다 → 1단 묶음 9개 + 2단 항목으로.
// 고정하는 것:
//   ① 하위 키(#/settings/<k>) 48개는 하나도 바뀌지 않았다 — 딥링크 · linkcheck SETTINGS_PATHS · 문서가 이 키를 쓴다.
//   ② 모든 항목이 GROUP_ORDER 의 묶음 하나에 속하고, 같은 묶음은 붙어 있으며 순서가 GROUP_ORDER 와 같다(1단은 첫 등장 순서가 아니라 GROUP_ORDER 로 그린다).
//   ③ 1단 줄은 줄바꿈(가로 스크롤 아님).
//   ④ 화면·서버 문구에 옛 묶음 이름의 메뉴 경로('설정 › 수집 서버 › …' · '설정 › Security › …' 등)가 남지 않는다(주석 제외 — 버전 이력은 그대로 둔다).
//   ⑤ '설정 › <묶음> › <항목>' 문구는 그 항목이 실제로 그 묶음 안에 있다.
// v2.916(사용자 요청 '설정 메뉴를 클로드 디자인으로 개편 — 효율적이고 직관적으로' · 시안 A안 + 상태 요약): 1단 탭 줄 → 설정 안의 왼쪽 목록.
//   묶음 9 → 10('수집' → '수집 주기·임계' + '게스트·GPU', '알림·연동' → '알림·메일', 특수 기능 카테고리 → 시스템). ③ · ④ 를 그에 맞게 바꿨다.
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

// v2.904 까지의 48개 키 — 재배치는 묶음만 바꾼다(키를 바꾸면 북마크 · 딥링크 · 권한 문서가 깨진다).
const KEYS_V2901 = [
  'datacenter-admin', 'vcenter-admin', 'vcenter-test', 'veeam', 'bareos', 'nsx-admin', 'horizon-admin',
  'idrac-admin', 'idrac-scan-log', 'metrics', 'storage-intervals', 'power-off-check', 'vmseries', 'sansw-perf',
  'isilon-dirusage', 'guest-partition', 'gpu-collect', 'gpu-guest', 'gpu-guest-diag', 'guest-account', 'collectors',
  'agent-deploy', 'proxy', 'remote', 'users', 'edge-users', 'auth-ad', 'session-security', 'secrets', 'api-keys',
  'anomaly', 'host-access', 'peer-trust', 'security-self-check', 'ai-search', 'alerts', 'mail', 'tool-categories',
  'backup', 'nfs-mounts', 'dir-usage', 'vclogs', 'diagnostics', 'perf-monitor', 'log-analysis', 'audit', 'upgrade', 'about',
];

// v2.912 에 더한 키(설정 › 로그 › 최근 로그인 · 로그인 횟수). 옛 48개는 하나도 빠지거나 이름이 바뀌지 않는다.
const KEYS_ADDED = ['recent-logins', 'login-counts', 'feature-usage', 'ssh-access']; // v2.913 설정 › 사용자 › 기능 사용 현황 · v3.9.0 설정 › 보안 › SSH 공용 접속

test('① 하위 키 48개는 그대로다(삭제 · 이름 변경 없음) — 더한 키는 KEYS_ADDED 에만', () => {
  assert.equal(ITEMS.length, 48 + KEYS_ADDED.length, `항목을 ${ITEMS.length}개 읽었다 — SUB 줄 모양('  { k: …, label: …, C: …')이 바뀌었는지 확인`);
  assert.deepEqual([...ITEMS.map((i) => i.k)].sort(), [...KEYS_V2901, ...KEYS_ADDED].sort());
  assert.equal(new Set(ITEMS.map((i) => i.k)).size, ITEMS.length, '중복 키');
});

test('② 모든 항목이 묶음 하나에 속하고, 묶음은 GROUP_ORDER 10개 · 같은 묶음은 붙어 있다', () => {
  assert.equal(GROUP_ORDER.length, 10, `묶음이 ${GROUP_ORDER.length}개 — v2.916 은 10개(왼쪽 목록). 바꾸면 docs/SETTINGS.md 절 순서와 시안 문서도 함께`);
  assert.deepEqual(Object.keys(GROUP_LABEL).sort(), [...GROUP_ORDER].sort(), 'GROUPS 와 GROUP_ORDER 가 어긋난다');
  const loose = ITEMS.filter((i) => !i.group || !GROUP_ORDER.includes(i.group));
  assert.deepEqual(loose.map((i) => i.k), [], '묶음 없는(또는 모르는 묶음) 항목 — 1단에 보이지 않아 메뉴로 들어갈 수 없다');
  const runs = ITEMS.map((i) => i.group).filter((g, n, a) => n === 0 || a[n - 1] !== g);
  assert.deepEqual(runs, GROUP_ORDER, '같은 묶음 항목이 흩어져 있거나 순서가 GROUP_ORDER 와 다르다');
  for (const g of GROUP_ORDER) assert.ok(!/[\u{1F300}-\u{1FAFF}⬆]/u.test(GROUP_LABEL[g]), `묶음 라벨에 이모지: ${GROUP_LABEL[g]}`);
  assert.ok(ITEMS.some((i) => i.k === 'vcenter-admin' && i.group === GROUP_ORDER[0]), '기본 화면(vcenter-admin)은 첫 묶음에 있어야 첫 진입 강조가 맞다');
});

test('③ 메뉴는 왼쪽 목록(GROUP_ORDER 순)이고 가로 탭 줄이 없다 · 모든 항목에 설명 한 줄 · 좁은 화면은 컨테이너 쿼리로 접는다', () => {
  const body = stripComments(SRC);
  assert.match(body, /GROUP_ORDER\.map\(\(g\) =>/, '묶음은 GROUP_ORDER 순서로 그린다(첫 등장 순서가 아니라)');
  assert.match(body, /className="stg-list"/);
  assert.doesNotMatch(body, /className="vcd-views"/, 'v2.905 의 1단 가로 탭 줄이 남아 있다 — v2.916 은 왼쪽 목록');
  const descs = [...SRC.matchAll(/^ {2}\{ k: '([a-z0-9-]+)', label: '[^']+', C: \w+, group: '[a-z-]+', desc: '([^']{10,})'/gm)].map((m) => m[1]);
  assert.deepEqual(ITEMS.map((i) => i.k).filter((k) => !descs.includes(k)), [], '설명(desc) 없는 항목 — 본문 머리의 한 줄 설명 · 검색이 쓴다');
  const css = fs.readFileSync(path.join(ROOT, 'web/src/styles.css'), 'utf8');
  assert.match(css, /\.stg-cq \{ container: stg \/ inline-size;/, '목록 접힘은 화면 폭이 아니라 설정 영역 폭으로(사이드바 펼침/접힘에 따라 본문 폭이 다르다)');
  // 컨테이너 쿼리는 컨테이너 자신에게 걸리지 않는다 — 접히는 .stg 는 컨테이너(.stg-cq)의 자손이어야 한다(v2.916 Chromium 400px 실측 결함).
  assert.doesNotMatch(css, /\.stg \{[^}]*container:/);
  assert.match(body, /<div className="stg-cq"><div className=\{`stg\$\{navOpen/);
  assert.match(css, /@container stg \(max-width: 760px\)/);
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
// v2.916: '설정 › 수집 › …'(→ 수집 주기·임계 / 게스트·GPU) · '설정 › 알림·연동 › …'(→ 알림·메일 / 시스템) 도 옛 경로다.
const OLD_PATH = /설정\s*[›>]\s*(?:🖥️ |🖥 |🗄️ |🗄 |🎮 |🔌 |👤 |🛡️ |🛡 |📋 )?(vCenter 관리|수집 서버|GPU 사용량 수집|원격 접속 서버|User Control|Security|Log|수집(?= › )|알림·연동)(?!\(원격\)|[A-Za-z])/g;

test('④ 옛 묶음 이름의 메뉴 경로가 화면 · 서버 문구에 남지 않는다', () => {
  const hits = [];
  for (const dir of SCAN) {
    for (const f of files(path.join(ROOT, dir))) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      for (const m of s.matchAll(OLD_PATH)) hits.push(`${path.relative(ROOT, f)}:${lineOf(s, m.index)} ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], '옛 경로(v2.904 까지의 묶음 이름) — 새 묶음 이름으로 고칠 것');
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
