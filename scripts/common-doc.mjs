#!/usr/bin/env node
/**
 * scripts/common-doc.mjs — 솔루션 전체가 함께 쓰는 **공통 기능 목록**을 코드에서 뽑아 `docs/COMMON.md` 를 만든다.
 *
 * 왜: 공용 모듈이 서버 `util/` 85개 · 웹 `components/`·`hooks/`·`util/` 수십 개로 늘었는데 목록이 없었다.
 * 그래서 새 기능을 만들 때 '이미 있는 것' 을 찾지 못하고 같은 헬퍼를 다시 적었다 — `numOrNull` 13벌(v2.561) ·
 * 동시성 풀 23벌(v2.575) · `withDeadline` 2벌(v2.607)이 실제 사례다. 손으로 적는 목록은 다음 릴리스부터 낡으므로
 * (`docs/rules/common.md` '문서는 손으로 적는 목록을 두지 않는다') **코드가 진실의 원천**이다.
 *
 * 무엇을 싣나:
 *  · **공용 위치의 모듈**(SCOPES) — 머리 주석 첫 단락(하는 일) · 내보내는 이름 · 사용처(import 하는 파일 수) ·
 *    사용 영역 수 · 그 모듈을 가리키는 테스트 파일 수.
 *  · **공용 위치 밖인데 널리 쓰이는 모듈** — 사실상 공통 기능인데 도메인 폴더에 있는 것(서버는 영역 수, 웹은 사용처 수로도).
 *  · **살펴볼 것** — import 사용처가 없는 공용 모듈 · 서버와 웹에 같은 이름으로 두 벌 있는 모듈.
 *
 * 규약:
 *  · **'못 읽은 것' 을 조용히 넘기지 않는다**(v2.563 `docsGen2452` 사고): 공용 위치가 비었거나, 내보내기를
 *    읽을 수 없는 형태(`export const { a } = …`)이거나, 테스트가 아닌 소스의 상대 경로 import 가 실재 파일로
 *    풀리지 않으면 **종료코드 1 이고 파일을 쓰지 않는다**(사용처 수가 조용히 틀리는 것을 막는다).
 *  · 주석 제거는 `server/test/_stripComments.js`(상태 기계) 하나를 쓴다 — 정규식 두 줄짜리 판본은 틀렸다(v2.574).
 *  · 날짜를 싣지 않는다 — 내용이 같으면 파일이 같다(`--check` 가 그대로 비교한다).
 *  · 사용처는 **정적 import · 재수출 · 문자열 리터럴 동적 import** 만 센다. 경로를 런타임에 조합하는
 *    동적 import 는 세지 못한다 — 그 파일 목록을 문서 머리말에 밝힌다. 테스트는 '실재 모듈을 가리키는 경로 문자열' 로 센다.
 *
 * 사용: node scripts/common-doc.mjs          (docs/COMMON.md 갱신)
 *       node scripts/common-doc.mjs --check  (갱신이 필요하면 1 로 종료 — CI 에서 씀)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from '../server/test/_stripComments.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'docs', 'COMMON.md');

/**
 * 공용 위치. `deep` 이면 하위 폴더까지, `only` 는 그 폴더 바로 아래 파일만.
 * 웹 최상위(`web/src/*.js`)는 진입점(App.jsx·main.jsx)을 뺀다 — 진입점은 '쓰이는 쪽' 이 아니다.
 */
export const SCOPES = Object.freeze([
  { id: 'server-util', title: '서버 공용 유틸', dir: 'server/src/util', deep: false },
  { id: 'web-components', title: '웹 공용 컴포넌트', dir: 'web/src/components', deep: true },
  { id: 'web-hooks', title: '웹 공용 훅', dir: 'web/src/hooks', deep: false },
  { id: 'web-util', title: '웹 공용 유틸', dir: 'web/src/util', deep: false },
  { id: 'web-top', title: '웹 최상위 공용 모듈', dir: 'web/src', deep: false, exclude: ['App.jsx', 'main.jsx'] },
]);

/** 사용처를 찾을 소스 범위(공용 위치를 import 할 수 있는 곳 전부). */
export const SOURCE_ROOTS = Object.freeze(['server/src', 'server/test', 'web/src', 'scripts']);

/** 공용 위치 밖 모듈을 '널리 쓰인다' 로 싣는 기준 — 테스트가 아닌 사용처가 속한 영역 수(자기 영역 제외). */
export const SHARED_MIN_AREAS = 5;
/**
 * 웹은 도구 화면 500여 개가 한 폴더(`views/tools`)에 모여 있어 영역 수로는 '널리 쓰인다' 를 가를 수 없다
 * (초판 실측 — 영역 기준만으로는 웹 모듈이 1개뿐이었다). 그래서 웹은 사용처 파일 수로도 본다.
 */
export const SHARED_MIN_WEB_USERS = 20;

const CODE_EXT = new Set(['.js', '.jsx', '.mjs']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'vendor', 'coverage']);
const SUMMARY_MAX = 150;
const EXPORTS_SHOWN = 6;

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** 테스트 파일인가 — 사용처와 따로 센다. */
export function isTestFile(relPath) {
  return relPath.startsWith('server/test/') || relPath.startsWith('web/src/test/') || /\.test\.(js|jsx|mjs)$/.test(relPath);
}

/** 폴더를 훑어 코드 파일의 절대 경로를 모은다(정렬 — 출력이 실행 환경에 따라 달라지지 않게). */
export function walk(absDir, deep = true) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (deep && !SKIP_DIR.has(e.name)) out.push(...walk(p, true));
    } else if (e.isFile() && CODE_EXT.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 파일이 속한 '영역' — 서버는 `server/src/<영역>/…`, 웹은 `views/tools` 만 두 단계(도구 화면이 한 폴더에 모여 있다).
 * 폴더 바로 아래 파일은 '(루트)'.
 */
export function areaOf(relPath) {
  const seg = relPath.split('/');
  if (relPath.startsWith('server/src/')) return seg.length > 3 ? `server:${seg[2]}` : 'server:(루트)';
  if (relPath.startsWith('web/src/')) {
    if (seg.length <= 3) return 'web:(루트)';
    if (seg[2] === 'views' && seg.length > 4) return `web:views/${seg[3]}`;
    return `web:${seg[2]}`;
  }
  return seg[0];
}

/**
 * 머리 주석 첫 단락 → 한 줄 요약(순수). 없으면 ''.
 * shebang 과 빈 줄을 건너뛰고 파일 맨 앞의 블록 주석(또는 연속된 줄 주석)만 본다 — 코드 뒤 주석은 그 모듈의 설명이 아니다.
 */
export function headSummary(src, fileName = '') {
  let s = String(src ?? '');
  if (s.startsWith('#!')) s = s.slice(s.indexOf('\n') + 1);
  s = s.trimStart();
  // 머리 주석이 import 문 **뒤에** 오는 파일이 있다(`util/atomicWrite.js` — 사용처가 가장 많은 모듈이 '설명 없음' 이 됐다).
  // 맨 앞의 정적 import 문만 건너뛴다. 다른 코드가 나오면 멈춘다 — 그 뒤 주석은 모듈 설명이 아니라 그 코드의 설명이다.
  for (let m; (m = /^import\b[^;]{0,2000};/.exec(s));) s = s.slice(m[0].length).trimStart();
  let lines = [];
  if (s.startsWith('/*')) {
    const end = s.indexOf('*/');
    const body = s.slice(2, end === -1 ? s.length : end);
    lines = body.split('\n').map((l) => l.replace(/^\s*\*?[ \t]?/, ''));
    if (lines.length && lines[0].startsWith('*')) lines[0] = lines[0].slice(1).trimStart(); // `/**` 의 둘째 별
  } else if (s.startsWith('//')) {
    for (const l of s.split('\n')) {
      if (!l.trimStart().startsWith('//')) break;
      lines.push(l.trimStart().slice(2).replace(/^[ \t]/, ''));
    }
  } else {
    return '';
  }
  // 첫 단락: 앞의 빈 줄을 버리고 다음 빈 줄 전까지.
  const para = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (para.length) break; continue; }
    if (!/[\p{L}\p{N}]/u.test(t)) continue; // 장식 줄(`────`·`====`)은 설명이 아니다
    if (t.startsWith('@')) break; // JSDoc 태그부터는 설명이 아니다
    para.push(t);
  }
  let text = para.join(' ').replace(/\s+/g, ' ').trim();
  // 'util/x.js — ' · 'x.js — ' 처럼 자기 파일 이름으로 시작하면 뗀다(표의 첫 칸과 중복).
  if (fileName) {
    const base = fileName.split('/').pop();
    const m = text.match(/^`?[\w./-]*?`?\s*[—–:-]\s+/);
    if (m && m[0].includes(base)) text = text.slice(m[0].length);
  }
  const chars = [...text];
  if (chars.length > SUMMARY_MAX) {
    text = chars.slice(0, SUMMARY_MAX).join('').trimEnd();
    // 코드 표기(백틱) 한가운데서 잘렸으면 닫는다 — 열린 채 두면 표의 나머지 칸이 코드로 렌더된다.
    if ((text.split('`').length - 1) % 2 === 1) text += '`';
    text += '…';
  }
  return text;
}

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * 내보내는 이름을 읽는다(순수). 입력은 **주석을 제거한** 소스.
 * @returns {{ names: string[], unreadable: string[] }}  unreadable 은 이름을 뽑지 못한 export 형태(호출부가 실패로 만든다).
 */
export function scanExports(stripped) {
  const s = String(stripped ?? '');
  const names = new Set();
  const unreadable = [];
  for (const m of s.matchAll(new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of s.matchAll(new RegExp(`\\bexport\\s+class\\s+(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of s.matchAll(/\bexport\s+(?:const|let|var)\s+([^\s=;]+)/g)) {
    if (new RegExp(`^${IDENT}$`).test(m[1])) names.add(m[1]);
    else unreadable.push(m[0].trim()); // 구조 분해(`export const { a } = x`) — 이름을 정확히 못 뽑는다
  }
  for (const m of s.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      const name = (as[1] ?? as[0]).trim();
      if (new RegExp(`^${IDENT}$`).test(name)) names.add(name);
      else unreadable.push(`export { ${t} }`);
    }
  }
  if (/\bexport\s+default\b/.test(s)) names.add('default');
  if (/\bexport\s*\*\s*from\b/.test(s)) names.add('*');
  if (/\bexport\s*\*\s*as\s/.test(s)) {
    for (const m of s.matchAll(new RegExp(`\\bexport\\s*\\*\\s*as\\s+(${IDENT})`, 'g'))) names.add(m[1]);
  }
  return { names: [...names], unreadable };
}

/**
 * import 대상 지정자를 읽는다(순수). 입력은 **주석을 제거한** 소스.
 * 정적 import · 재수출(`export … from`) · 문자열 리터럴 동적 import 만. 경로를 조합하는 동적 import 는 `dynamicUnknown`(건수)으로 센다.
 */
export function scanImports(stripped) {
  const s = String(stripped ?? '');
  const specs = [];
  // `import x from '…'` · `export { a } from '…'` · `export * from '…'` — 반드시 `from` 을 거친다.
  // ⚠ `=` 를 건너지 않는다: `export const SEL = '.a, .b'` 의 문자열을 import 대상으로 읽던 오탐(초판 실측 2건).
  for (const m of s.matchAll(/(?<![.\w$])(?:import|export)\b[^'"`;()=]*?\bfrom\s*['"]([^'"\n]+)['"]/g)) specs.push(m[1]);
  // 부수효과 import: `import './x.css'`
  for (const m of s.matchAll(/(?<![.\w$])import\s*['"]([^'"\n]+)['"]/g)) specs.push(m[1]);
  let dynamicUnknown = 0;
  // ⚠ `obj.import('./x.js')`(메서드 호출)는 동적 import 가 아니다 — 앞이 `.`·식별자 문자면 건너뛴다(테스트가 고정).
  for (const m of s.matchAll(/(?<![.\w$])import\s*\(\s*(['"]([^'"\n]+)['"]\s*\)|[^)]{0,200})/g)) {
    if (m[2]) specs.push(m[2]);
    else dynamicUnknown += 1;
  }
  return { specs, dynamicUnknown };
}

/**
 * 테스트 파일이 **가리키는** 모듈 경로 문자열을 읽는다(순수). 입력은 주석을 제거한 소스.
 * 왜 import 만 세지 않나: 이 저장소의 테스트는 `import(pathToFileURL(path.join(SRC, 'util/x.js')))` 같은 조합 경로 동적 import 와
 * 소스를 문자열로 읽는 스윕(`read(path.join(SRC, 'util/x.js'))`)을 많이 쓴다(초판 실측 — import 로 풀리지 않는 동적 import 가
 * 테스트에 632건). import 만 세면 '테스트 0' 이 대량으로 거짓이 된다. 그래서 `.js`·`.jsx`·`.mjs` 로 끝나는 문자열 리터럴을 모으고
 * (캐시 무효화용 `?v=…` 접미는 뗀다) 호출부가 실재 파일로 풀리는 것만 센다.
 */
export function scanPathLiterals(stripped) {
  const out = [];
  for (const m of String(stripped ?? '').matchAll(/['"`]([^'"`\n$?]{3,200}\.(?:js|jsx|mjs))(?=['"`?])/g)) out.push(m[1]);
  return out;
}

/** 상대 지정자를 실재 파일로 푼다. 못 풀면 null. (이 저장소의 import 는 확장자를 적지만 폴더·무확장도 받아 준다.) */
export function resolveSpec(fromAbs, spec) {
  if (!spec.startsWith('.')) return null; // 패키지·node: 는 대상이 아니다
  const clean = spec.split('?')[0].split('#')[0]; // vite 의 `?raw`·`?url` 접미
  const base = path.resolve(path.dirname(fromAbs), clean);
  const cands = [base, ...['.js', '.jsx', '.mjs'].map((e) => base + e), ...['index.js', 'index.jsx'].map((f) => path.join(base, f))];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * 저장소를 훑어 카탈로그를 만든다. 읽지 못한 것이 있으면 `problems` 에 담는다(호출부가 종료코드 1 로 만든다).
 */
export function buildCatalog(root = ROOT) {
  const problems = [];
  const abs = (r) => path.join(root, r);
  const relOf = (a) => path.relative(root, a).split(path.sep).join('/');

  // 1) 공용 위치의 모듈.
  const scopeOf = new Map(); // rel → scope id
  for (const sc of SCOPES) {
    const files = walk(abs(sc.dir), sc.deep)
      .map(relOf)
      .filter((r) => !isTestFile(r) && !(sc.exclude || []).includes(r.split('/').pop()));
    if (files.length === 0) problems.push(`공용 위치 '${sc.dir}' 에서 모듈을 하나도 찾지 못했습니다`);
    for (const r of files) if (!scopeOf.has(r)) scopeOf.set(r, sc.id);
  }

  // 2) 전체 소스의 import 그래프.
  const allFiles = [...new Set(SOURCE_ROOTS.flatMap((r) => walk(abs(r), true)).map(relOf))];
  const info = new Map(); // rel → { summary, exports, importers:Set, testImporters:Set }
  const ensure = (r) => {
    if (!info.has(r)) info.set(r, { importers: new Set(), testImporters: new Set() });
    return info.get(r);
  };
  // 테스트가 문자열로 가리키는 경로를 풀 기준 폴더 — 테스트 파일 폴더 다음에 이 순서로 본다(먼저 실재하는 것).
  const testBases = (r) => (r.startsWith('web/')
    ? ['web/src', 'web', '', 'server/src', 'server']
    : ['server/src', 'server', '', 'web/src', 'web']).map(abs);
  const dynamicUnknown = []; // 테스트가 아닌 소스에서 경로를 조합하는 동적 import — 사용처로 세지 못한 자리
  for (const r of allFiles) {
    let raw;
    try { raw = fs.readFileSync(abs(r), 'utf8'); } catch (e) { problems.push(`${r} 를 읽지 못했습니다(${e.code || e.message})`); continue; }
    const stripped = stripComments(raw);
    const me = ensure(r);
    if (scopeOf.has(r)) {
      const ex = scanExports(stripped);
      for (const u of ex.unreadable) problems.push(`${r}: 내보내기 형태를 읽지 못했습니다 — ${u}`);
      me.exports = ex.names;
      me.summary = headSummary(raw, r);
    }
    if (isTestFile(r)) {
      // 테스트: import 든 소스 스윕이든 '실재 모듈을 가리키는 경로 문자열' 을 센다(scanPathLiterals 머리말).
      for (const lit of scanPathLiterals(stripped)) {
        let target = lit.startsWith('.') ? resolveSpec(abs(r), lit) : null;
        for (const base of testBases(r)) {
          if (target) break;
          const c = path.resolve(base, lit);
          try { if (fs.statSync(c).isFile()) target = c; } catch { /* 다음 기준 폴더 */ }
        }
        if (!target) continue; // 픽스처 안의 가짜 경로 — 실재 파일이 아니면 세지 않는다
        const t = relOf(target);
        if (t !== r && !t.startsWith('..')) ensure(t).testImporters.add(r);
      }
      continue;
    }
    const im = scanImports(stripped);
    if (im.dynamicUnknown) dynamicUnknown.push({ file: r, count: im.dynamicUnknown });
    for (const spec of im.specs) {
      if (!spec.startsWith('.')) continue;
      const target = resolveSpec(abs(r), spec);
      // 소스의 상대 import 가 안 풀리면 실패다 — 조용히 넘기면 사용처 수가 틀린 채 '최신' 이 된다.
      if (!target) { problems.push(`${r}: import '${spec}' 를 파일로 풀지 못했습니다`); continue; }
      const t = relOf(target);
      if (t !== r) ensure(t).importers.add(r);
    }
  }

  const row = (r) => {
    const i = info.get(r) || { importers: new Set(), testImporters: new Set() };
    const areas = new Set([...i.importers].map(areaOf));
    return {
      file: r, summary: i.summary || '', exports: i.exports || [],
      users: i.importers.size, areas: areas.size, areaList: [...areas].sort(), tests: i.testImporters.size,
    };
  };
  const byUse = (a, b) => b.users - a.users || (a.file < b.file ? -1 : 1);

  const scopes = SCOPES.map((sc) => ({
    ...sc,
    modules: [...scopeOf].filter(([, id]) => id === sc.id).map(([r]) => row(r)).sort(byUse),
  }));

  // 3) 공용 위치 밖인데 널리 쓰이는 모듈(테스트·스크립트 제외 — 제품 코드만).
  const shared = [];
  for (const [r, i] of info) {
    if (scopeOf.has(r) || isTestFile(r) || r.startsWith('scripts/') || !CODE_EXT.has(path.extname(r))) continue;
    const own = areaOf(r);
    const areas = new Set([...i.importers].map(areaOf));
    areas.delete(own);
    const web = r.startsWith('web/');
    if (areas.size >= SHARED_MIN_AREAS || (web && i.importers.size >= SHARED_MIN_WEB_USERS)) {
      const raw = fs.readFileSync(abs(r), 'utf8');
      shared.push({ ...row(r), summary: headSummary(raw, r), otherAreas: areas.size, side: web ? 'web' : 'server' });
    }
  }
  shared.sort((a, b) => (a.side === 'web' ? byUse(a, b) : b.otherAreas - a.otherAreas || byUse(a, b)));

  // 4) 서버·웹에 같은 이름으로 두 벌.
  const serverUtil = new Map(scopes[0].modules.map((m) => [path.basename(m.file).replace(/\.\w+$/, ''), m.file]));
  const twins = [];
  for (const sc of scopes.slice(1)) {
    for (const m of sc.modules) {
      const k = path.basename(m.file).replace(/\.\w+$/, '');
      if (serverUtil.has(k)) twins.push({ name: k, server: serverUtil.get(k), web: m.file });
    }
  }
  twins.sort((a, b) => (a.name < b.name ? -1 : 1));

  return { scopes, shared, twins, dynamicUnknown, fileCount: allFiles.length, problems };
}

/**
 * 표 칸에 넣을 문자열(순수). `|` 는 칸을 가르므로 어디서든 이스케이프하고, `<` 는 **코드 표기 밖에서만** 엔티티로 바꾼다 —
 * 코드 표기 안에서는 Markdown 이 엔티티를 풀지 않아 `&lt;table>` 이 글자 그대로 보인다(초판 판독에서 발견).
 */
export const esc = (t) => String(t).split('`')
  .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/</g, '&lt;')).replace(/\|/g, '\\|'))
  .join('`');
const exportsCell = (names) => {
  if (!names.length) return '(없음)';
  const shown = names.slice(0, EXPORTS_SHOWN).map((n) => `\`${n}\``).join(' ');
  return names.length > EXPORTS_SHOWN ? `${shown} 외 ${names.length - EXPORTS_SHOWN}` : shown;
};
const short = (file, dir) => (file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file);

/** 카탈로그 → Markdown(순수). */
export function renderMd(cat) {
  const all = cat.scopes.flatMap((s) => s.modules);
  const noHead = all.filter((m) => !m.summary);
  const unused = all.filter((m) => m.users === 0);
  const noTest = all.filter((m) => m.tests === 0);
  const dynN = cat.dynamicUnknown.reduce((n, d) => n + d.count, 0);
  const dyn = dynN ? `${dynN}건 · 파일 ${cat.dynamicUnknown.length}개(${cat.dynamicUnknown.map((d) => `\`${d.file}\``).join(' · ')})` : '0건';
  let md = `# 공통 기능 목록 (자동 생성)

솔루션 전체가 함께 쓰는 공용 모듈 **${all.length}개**를 코드에서 뽑은 목록이다. 새 헬퍼·컴포넌트를 만들기 전에 여기서 먼저 찾는다
(같은 판정을 복제하지 말 것 — 루트 \`CLAUDE.md\` '판정 코어는 하나').

- 생성: \`node scripts/common-doc.mjs\` · 최신 여부: \`node scripts/common-doc.mjs --check\`
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이며 다음 실행에서 덮어써진다. 설명을 고치려면 그 모듈의 **머리 주석 첫 단락**을 고친다.
- 훑은 소스 ${cat.fileCount}개 파일(\`${SOURCE_ROOTS.join('` · `')}\`). \`pyportal/\`(Python)은 대상이 아니다.

## 읽는 법 · 한계

- **하는 일**: 그 파일 맨 앞 주석의 첫 단락(${SUMMARY_MAX}자에서 자름). 머리 주석이 없는 모듈은 ${noHead.length}개다.
- **사용처**: 그 모듈을 import 하는 파일 수(테스트 제외). **영역**: 사용처가 속한 폴더 수(서버 \`server/src/<영역>\` · 웹 \`web/src/<영역>\`, \`views/tools\` 는 따로).
- **테스트**: 그 모듈의 경로를 **import 하거나 문자열로 가리키는**(소스 스윕) 테스트 파일 수. 경로를 조각으로 조합하면(\`path.join(SRC, 'util', 'x.js')\`) 세지 못하므로 0 이 '검증 없음' 을 뜻하지는 않는다(0 인 모듈 ${noTest.length}개).
- 사용처로 세는 것은 정적 import · 재수출 · 문자열 리터럴 동적 import 다. 경로를 런타임에 조합하는 동적 import 는 세지 못했다 — ${dyn}.
- 사용처 수는 '얼마나 널리 쓰이는가' 이지 품질 지표가 아니다.

## 요약

| 구분 | 위치 | 모듈 | 사용처 0 | 테스트 0 |
|---|---|---|---|---|
`;
  for (const sc of cat.scopes) {
    md += `| ${sc.title} | \`${sc.dir}/\` | ${sc.modules.length} | ${sc.modules.filter((m) => m.users === 0).length} | ${sc.modules.filter((m) => m.tests === 0).length} |\n`;
  }
  md += `| **합계** | | **${all.length}** | **${unused.length}** | **${noTest.length}** |\n`;

  for (const sc of cat.scopes) {
    md += `\n## ${sc.title} — \`${sc.dir}/\` (${sc.modules.length})\n\n사용처가 많은 순.\n\n| 모듈 | 하는 일 | 내보내는 이름 | 사용처 | 영역 | 테스트 |\n|---|---|---|---|---|---|\n`;
    for (const m of sc.modules) {
      md += `| \`${short(m.file, sc.dir)}\` | ${m.summary ? esc(m.summary) : '(머리 주석 없음)'} | ${exportsCell(m.exports)} | ${m.users} | ${m.areas} | ${m.tests} |\n`;
    }
  }

  md += `\n## 공용 위치 밖에서 널리 쓰이는 모듈 (${cat.shared.length})\n\n공용 위치(위 ${cat.scopes.length}곳) 밖에 있지만 사실상 공통 기능인 모듈이다. 새로 만들기 전에 함께 본다.\n`;
  const sharedTable = (list) => {
    let t = '\n| 모듈 | 하는 일 | 사용처 | 다른 영역 | 테스트 |\n|---|---|---|---|---|\n';
    for (const m of list) t += `| \`${m.file}\` | ${m.summary ? esc(m.summary) : '(머리 주석 없음)'} | ${m.users} | ${m.otherAreas} | ${m.tests} |\n`;
    return t;
  };
  const srv = cat.shared.filter((m) => m.side === 'server');
  const web = cat.shared.filter((m) => m.side === 'web');
  md += `\n### 서버 (${srv.length})\n\n**자기 영역 말고 ${SHARED_MIN_AREAS}개 이상 영역**이 import 하는 모듈. 다른 영역 수가 많은 순.\n${sharedTable(srv)}`;
  md += `\n### 웹 (${web.length})\n\n다른 영역 ${SHARED_MIN_AREAS}개 이상 **또는 사용처 ${SHARED_MIN_WEB_USERS}개 파일 이상**인 모듈(도구 화면이 한 폴더 \`views/tools\` 에 모여 있어 영역 수만으로는 가를 수 없다). 사용처가 많은 순.\n${sharedTable(web)}`;
  md += `\n## 살펴볼 것\n\n판정이 아니라 **사실 목록**이다 — 지우거나 옮기기 전에 그 파일을 열어 확인한다.\n`;
  md += `\n### import 사용처가 없는 공용 모듈 (${unused.length})\n\n죽은 코드라는 뜻이 아니다 — 경로를 조합하는 동적 import · 워커 진입점 · 테스트 전용일 수 있다.\n\n`;
  md += unused.length ? `${unused.map((m) => `- \`${m.file}\`(테스트 ${m.tests})`).join('\n')}\n` : '없음.\n';
  md += `\n### 서버와 웹에 같은 이름으로 두 벌 있는 모듈 (${cat.twins.length})\n\n런타임이 달라 두 벌일 수 있다. 같은 판정이면 테스트가 같은 입력으로 두 벌을 대조해야 한다(루트 \`CLAUDE.md\`).\n\n`;
  md += cat.twins.length ? `| 이름 | 서버 | 웹 |\n|---|---|---|\n${cat.twins.map((t) => `| \`${t.name}\` | \`${t.server}\` | \`${t.web}\` |`).join('\n')}\n` : '없음.\n';
  return md;
}

function main() {
  const cat = buildCatalog();
  if (cat.problems.length) {
    console.error(`공통 기능 목록을 만들지 못했습니다 — 읽지 못한 것 ${cat.problems.length}건(파일을 쓰지 않습니다):`);
    for (const p of cat.problems.slice(0, 40)) console.error(`  · ${p}`);
    process.exit(1);
  }
  const md = renderMd(cat);
  const total = cat.scopes.reduce((n, s) => n + s.modules.length, 0);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== md) {
      console.error('docs/COMMON.md 가 코드와 다릅니다 — `node scripts/common-doc.mjs` 로 갱신하세요.');
      process.exit(1);
    }
    console.log(`docs/COMMON.md 최신 (공용 모듈 ${total}개)`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  console.log(`docs/COMMON.md 생성 — 공용 모듈 ${total}개 · 공용 위치 밖 공유 ${cat.shared.length}개 · 소스 ${cat.fileCount}개 파일`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
