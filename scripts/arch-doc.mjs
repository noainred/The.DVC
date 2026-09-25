#!/usr/bin/env node
/**
 * arch-doc.mjs — `docs/ARCHITECTURE.md` 의 **모듈 지도 절**과 `docs/INDEX.md` 의 **전체 문서 목록 절**을
 * 소스에서 생성한다(v2.613 TESTDOC2613-11).
 *
 * ⚠⚠ **왜 손으로 적지 않는가**(CLAUDE.md v2.563 "문서는 손으로 적는 목록을 두지 않는다"): ARCHITECTURE.md 의
 * 모듈 표는 v2.583 에 마지막으로 손봤고 그 뒤 `server/src` 63개 디렉터리 중 **42개**가 표에 없었다
 * (`commmap`·`dataflow`·`devflow`·`cvp`·`portalcheck` …). INDEX.md 도 감사 보고서 18개를 싣지 않았다.
 * 손으로 적는 목록은 다음 릴리스부터 낡는다 — `api-doc.mjs`·`env-doc.mjs` 와 같은 이유로 생성물이다.
 *
 * 생성 규칙:
 *  · 모듈 지도 — `server/src/<dir>/` 마다 파일 수·줄 수(하위 디렉터리 포함) + **대표 파일 + 그 머리말 첫 줄**.
 *    대표 파일 = `index.js` 가 있으면 그것, 없으면 **다른 파일에서 가장 많이 import 되는 파일**(동률이면 이름순).
 *    머리말 = 파일 앞부분의 첫 주석 줄(JSDoc 의 첫 `*` 줄 또는 `//` 줄). ⚠ **머리말을 못 읽은 디렉터리는
 *    실패**(종료코드 1 · 문서 미기록) — '못 읽은 것을 조용히 넘기는 생성기' 가 v2.452 사고의 원인이다
 *    (`docsGen2452.test.js` 머리말).
 *  · 문서 목록 — `docs/*.md`(대소문자 무관) 전부와 각 파일의 첫 `#` 제목. 제목이 없으면 실패.
 *  · 두 문서에서 **마커 사이만** 교체한다(`<!-- arch-doc:modules:start -->` … `:end -->`,
 *    `<!-- arch-doc:docs:start -->` … `:end -->`). 서술 절은 손으로 두고 생성 절만 CI 가 `--check` 한다.
 *    마커가 없으면 실패한다(조용히 파일 끝에 붙이지 않는다).
 *
 * 사용: node scripts/arch-doc.mjs [--check]
 *   --check  파일을 쓰지 않고 현재 생성 절과 다르면 종료코드 1(CI 용)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'server/src');
const DOCS = path.join(ROOT, 'docs');
const ARCH_MD = path.join(DOCS, 'ARCHITECTURE.md');
const INDEX_MD = path.join(DOCS, 'INDEX.md');

const read = (p) => fs.readFileSync(p, 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 파일 머리말 첫 줄 — JSDoc(`/** … */`)의 첫 본문 줄 또는 첫 `//` 줄. 없으면 ''. */
export function headline(src) {
  const lines = String(src).split('\n').slice(0, 40);
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('/*')) { const body = t.replace(/^\/\*+\s?/, '').replace(/\*\/\s*$/, '').trim(); if (body) return body; continue; }
    if (t.startsWith('*')) { const body = t.replace(/^\*+\s?/, '').replace(/\*\/\s*$/, '').trim(); if (body && body !== '/') return body; continue; }
    if (t.startsWith('//')) { const body = t.replace(/^\/\/+\s?/, '').trim(); if (body) return body; continue; }
    if (t.startsWith('#!')) continue;
    break;                                   // 주석이 아닌 코드가 먼저 오면 머리말이 없는 파일
  }
  return '';
}

/** 표 셀용 — 파이프·개행을 지우고 길이를 자른다. */
const cell = (s, max = 140) => {
  const t = String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * 모듈 지도 행 — `server/src` 의 최상위 디렉터리마다 하나.
 * @returns {Array<{dir:string, files:number, lines:number, anchor:string, desc:string, importers:number}>}
 */
export function moduleMap() {
  const all = walk(SRC);
  // import 그래프(누가 누구를 import 하나) — 상대 경로 import 만 본다(패키지 import 는 무관).
  const importers = new Map();               // abs → Set(importing file)
  for (const f of all) {
    const src = read(f);
    for (const m of src.matchAll(/(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*)['"](\.[^'"]+)['"]/g)) {
      let target = path.resolve(path.dirname(f), m[1]);
      if (!target.endsWith('.js')) target += '.js';
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(f);
    }
  }
  const dirs = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const rows = [];
  for (const dir of dirs) {
    const files = all.filter((f) => f.startsWith(path.join(SRC, dir) + path.sep));
    const lines = files.reduce((n, f) => n + read(f).split('\n').length, 0);
    let anchor = files.find((f) => path.relative(path.join(SRC, dir), f) === 'index.js') || null;
    let cnt = 0;
    if (!anchor) {
      // 디렉터리 밖에서 가장 많이 import 되는 파일 중 **머리말이 있는 첫 파일**(밖이 0이면 안에서라도). 동률은 이름순.
      // 머리말 없는 파일(auth/auth.js·util/atomicWrite.js 처럼 코드가 바로 시작하는 것)은 건너뛴다 — 설명이 빈 표는 표가 아니다.
      const score = (f, outsideOnly) => [...(importers.get(f) || [])].filter((i) => !outsideOnly || !i.startsWith(path.join(SRC, dir) + path.sep)).length;
      const ranked = (outsideOnly) => [...files].map((f) => [f, score(f, outsideOnly)]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      let list = ranked(true);
      if (!list.length || list[0][1] === 0) list = ranked(false);
      const best = list.find(([f]) => headline(read(f))) || list[0];
      if (best) { anchor = best[0]; cnt = best[1]; }
    } else cnt = (importers.get(anchor) || new Set()).size;
    const desc = anchor ? headline(read(anchor)) : '';
    rows.push({ dir, files: files.length, lines, anchor: anchor ? path.relative(SRC, anchor).split(path.sep).join('/') : '', desc, importers: cnt });
  }
  return rows;
}

/** docs/*.md 전부 — 첫 `#` 제목. */
export function docList() {
  return fs.readdirSync(DOCS).filter((f) => /\.md$/i.test(f)).sort().map((file) => {
    const src = read(path.join(DOCS, file));
    const m = /^#\s+(.+?)\s*$/m.exec(src);
    return { file, title: m ? m[1].trim() : '' };
  });
}

/* ── 생성 절 ─────────────────────────────────────────────────────────────── */
function modulesSection(rows) {
  const out = [];
  out.push('| 디렉터리 | 파일 | 줄 | 대표 파일(밖에서 import 수) | 머리말 첫 줄 |');
  out.push('|---|---:|---:|---|---|');
  for (const r of rows) out.push(`| \`${r.dir}/\` | ${r.files} | ${r.lines.toLocaleString('en-US')} | \`${r.anchor}\` (${r.importers}) | ${cell(r.desc)} |`);
  out.push('');
  out.push(`디렉터리 ${rows.length}개 · 파일 ${rows.reduce((n, r) => n + r.files, 0)}개 · ${rows.reduce((n, r) => n + r.lines, 0).toLocaleString('en-US')}줄. ` +
    '대표 파일은 `index.js` 가 있으면 그것, 없으면 그 디렉터리 밖에서 가장 많이 import 되는 파일이고, 설명은 그 파일 머리말의 첫 줄을 그대로 옮긴 것이다(따라서 머리말이 곧 문서다 — 첫 줄을 잘 쓸 것).');
  return out.join('\n');
}

function docsSection(docs) {
  const out = [];
  out.push('| 문서 | 제목(첫 줄) |');
  out.push('|---|---|');
  for (const d of docs) out.push(`| [${d.file}](${d.file}) | ${cell(d.title, 160)} |`);
  out.push('');
  out.push(`\`docs/*.md\` ${docs.length}개(이름순). 위 분류 절에 없는 문서도 여기에는 반드시 있다 — 분류 절은 손으로 쓰고 이 절은 생성한다.`);
  return out.join('\n');
}

const MARK = {
  modules: ['<!-- arch-doc:modules:start -->', '<!-- arch-doc:modules:end -->'],
  docs: ['<!-- arch-doc:docs:start -->', '<!-- arch-doc:docs:end -->'],
};

/** 마커 사이를 교체한다. 마커가 없으면 던진다. */
export function splice(doc, [start, end], body) {
  const i = doc.indexOf(start); const j = doc.indexOf(end);
  if (i < 0 || j < 0 || j < i) throw new Error(`마커가 없습니다: ${start} … ${end}`);
  return `${doc.slice(0, i + start.length)}\n${body}\n${doc.slice(j)}`;
}

export function render() {
  const rows = moduleMap();
  const bad = rows.filter((r) => !r.anchor || !r.desc);
  if (bad.length) throw new Error(`대표 파일·머리말을 읽지 못한 디렉터리: ${bad.map((r) => r.dir).join(', ')} — 그 파일 첫 줄에 JSDoc 머리말을 적으세요`);
  const docs = docList();
  const noTitle = docs.filter((d) => !d.title);
  if (noTitle.length) throw new Error(`제목(# …)이 없는 문서: ${noTitle.map((d) => d.file).join(', ')}`);
  return {
    arch: splice(read(ARCH_MD), MARK.modules, modulesSection(rows)),
    index: splice(read(INDEX_MD), MARK.docs, docsSection(docs)),
  };
}

function main() {
  let out;
  try { out = render(); } catch (e) { console.error(`[arch-doc] ${e.message}`); process.exit(1); }
  const check = process.argv.includes('--check');
  const targets = [[ARCH_MD, out.arch], [INDEX_MD, out.index]];
  if (check) {
    const stale = targets.filter(([p, md]) => read(p) !== md).map(([p]) => path.relative(ROOT, p));
    if (stale.length) { console.error(`[arch-doc] ${stale.join(', ')} 의 생성 절이 최신이 아닙니다 — 'node scripts/arch-doc.mjs' 를 실행하세요.`); process.exit(1); }
    console.log('[arch-doc] 최신');
  } else {
    for (const [p, md] of targets) fs.writeFileSync(p, md);
    console.log(`[arch-doc] wrote ${targets.map(([p]) => path.relative(ROOT, p)).join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
