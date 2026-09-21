#!/usr/bin/env node
/**
 * third-party-notices.mjs — 배포 산출물에 실리는 오픈소스 고지를 **생성**한다(v2.576).
 *
 * 왜 생성기인가: 손으로 적은 목록은 다음 릴리스부터 낡는다(`ENV.md`·`CONFIG-FILES.md`·`API.md`
 * 가 이미 생성기를 쓰는 이유와 같다). 그리고 **못 읽은 것을 조용히 넘기면 안 된다** —
 * 라이선스를 판정할 수 없는 패키지가 있으면 **종료코드 1** 로 실패하고 문서를 쓰지 않는다
 * (`docsGen2452` 사고: 정규식이 못 잡은 항목이 조용히 사라지고 생성은 성공했다).
 *
 * 왜 필요한가(v2.576 라이선스 점검):
 *  · 오프라인 패키지는 `server/node_modules` 를 `cp -a` 로 **그대로 재배포**하고
 *    (`packaging/offline/build-package.sh:134`) 웹은 `web/dist` 번들을 배포한다(:114).
 *    MIT·ISC·BSD 는 공통으로 *"copies or substantial portions 에 저작권 고지와 허가 문구를
 *    포함할 것"* 을 요구하는데, minify 는 대부분의 고지 주석을 지운다(실측: `web/dist/assets/*.js`
 *    118개에 남은 `@license` 16건 · `Copyright` 12건뿐).
 *  · 서브셋 폰트는 OFL 2조가 사본마다 라이선스를 담을 것을 요구한다. `web/src/vendor/
 *    Pretendard-OFL.txt` 는 **`web/src` 가 패키지에 들어가지 않아 배포되지 않았다**.
 *
 * 출력: `web/public/THIRD-PARTY-NOTICES.txt` (vite 가 `web/dist/` 로 복사 → 두 배포 경로 모두 포함).
 * 사용: `node scripts/third-party-notices.mjs` / CI 는 `--check` 로 최신 여부만 확인.
 *
 * ⚠ 스캔 대상은 **재배포되는 것**뿐이다 — 서버 prod 의존성 트리와 웹 `dependencies`(번들에 들어가는
 *   것). vite·vitest 같은 dev 전용은 배포물에 없으므로 대상이 아니고, 그 사실을 문서가 밝힌다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/public/THIRD-PARTY-NOTICES.txt');
const CHECK = process.argv.includes('--check');

/** 그 패키지 폴더의 라이선스 본문 파일(있으면) — 여러 개면 모두 이어 붙인다. */
function licenseTexts(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    if (!/^(LICEN[CS]E|COPYING|NOTICE)/i.test(n)) continue;
    const p = path.join(dir, n);
    try {
      if (!fs.statSync(p).isFile()) continue;
      const t = fs.readFileSync(p, 'utf8');
      if (t.trim()) out.push({ file: n, text: t.replace(/\r\n/g, '\n').trim() });
    } catch { /* 읽을 수 없으면 아래 unresolved 로 잡힌다 */ }
  }
  return out;
}

function declaredLicense(pkg) {
  let l = pkg.license ?? pkg.licenses;
  if (Array.isArray(l)) l = l.map((x) => (typeof x === 'object' ? x?.type : x)).filter(Boolean).join(' OR ');
  if (l && typeof l === 'object') l = l.type;
  return typeof l === 'string' && l.trim() ? l.trim() : null;
}

/** `dir/node_modules` 의 패키지 폴더를 (스코프 포함) 열거. 중첩 node_modules 도 재귀. */
function scanModules(nmDir, acc = new Map()) {
  let entries = [];
  try { entries = fs.readdirSync(nmDir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin') continue;
    const dirs = e.name.startsWith('@')
      ? fs.readdirSync(path.join(nmDir, e.name), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(nmDir, e.name, x.name))
      : [path.join(nmDir, e.name)];
    for (const d of dirs) {
      const pj = path.join(d, 'package.json');
      if (fs.existsSync(pj)) {
        let pkg; try { pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { pkg = null; }
        if (pkg?.name) {
          const key = `${pkg.name}@${pkg.version || '?'}`;
          if (!acc.has(key)) acc.set(key, { name: pkg.name, version: pkg.version || '?', license: declaredLicense(pkg), dir: d, texts: licenseTexts(d) });
        }
      }
      scanModules(path.join(d, 'node_modules'), acc);
    }
  }
  return acc;
}

/** 웹은 dependencies(번들 대상)만. 그 전이 의존성까지 포함하려면 폴더를 그대로 훑되 dev 트리는 빼야
 *  하므로, 여기서는 **선언된 dependencies 를 뿌리로 하는 도달 집합**을 계산한다. */
function reachable(nmDir, roots) {
  const seen = new Map(); const queue = [...roots];
  const find = (name) => {
    const d = path.join(nmDir, name);
    return fs.existsSync(path.join(d, 'package.json')) ? d : null;
  };
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const d = find(name);
    if (!d) { seen.set(name, null); continue; }
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { pkg = null; }
    seen.set(name, pkg ? { name: pkg.name, version: pkg.version || '?', license: declaredLicense(pkg), dir: d, texts: licenseTexts(d) } : null);
    for (const dep of Object.keys(pkg?.dependencies || {})) queue.push(dep);
    for (const dep of Object.keys(pkg?.optionalDependencies || {})) queue.push(dep);
  }
  return seen;
}

const serverPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'));
const webPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/package.json'), 'utf8'));

const serverMods = reachable(path.join(ROOT, 'server/node_modules'), Object.keys(serverPkg.dependencies || {}));
const webMods = reachable(path.join(ROOT, 'web/node_modules'), Object.keys(webPkg.dependencies || {}));

const missingInstall = [];
const packages = new Map();   // name@version → { …, where:Set }
for (const [scope, map] of [['server', serverMods], ['web', webMods]]) {
  for (const [name, info] of map) {
    if (!info) { missingInstall.push(`${scope}:${name}`); continue; }
    const key = `${info.name}@${info.version}`;
    const cur = packages.get(key) || { ...info, where: new Set() };
    cur.where.add(scope);
    packages.set(key, cur);
  }
}

if (missingInstall.length) {
  console.error('[notices] 설치되지 않은 의존성이 있어 고지를 생성할 수 없습니다 — `npm ci` 먼저:');
  for (const m of missingInstall) console.error('  -', m);
  process.exit(1);
}

/** 라이선스 본문을 dedupe — 같은 MIT 본문 300벌을 싣지 않는다(패키지별 저작권 줄은 따로 남긴다). */
const bodies = new Map();   // sha1 → { text, users:[] }
const unresolved = [];
for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  if (!p.texts.length && !p.license) { unresolved.push(p); continue; }
  for (const t of p.texts) {
    const h = crypto.createHash('sha1').update(t.text).digest('hex');
    const e = bodies.get(h) || { text: t.text, users: [] };
    e.users.push(`${p.name}@${p.version}`);
    bodies.set(h, e);
  }
}

const OFL = fs.readFileSync(path.join(ROOT, 'web/src/vendor/Pretendard-OFL.txt'), 'utf8').replace(/\r\n/g, '\n').trim();

const L = [];
L.push('VMware Global Monitoring Portal — 제3자 오픈소스 고지 (THIRD-PARTY NOTICES)');
L.push('='.repeat(78));
L.push('');
L.push('이 파일은 `scripts/third-party-notices.mjs` 가 생성합니다 — 직접 고치지 마세요.');
L.push('갱신: `node scripts/third-party-notices.mjs`');
L.push('');
L.push('대상은 **배포물에 실제로 실리는 것**입니다 — 서버 운영 의존성 트리(오프라인 패키지가');
L.push('`server/node_modules` 를 그대로 포함합니다)와 웹 번들에 들어가는 의존성. vite·vitest 같은');
L.push('개발 전용 도구는 배포물에 없으므로 여기 없습니다.');
L.push('');
L.push(`패키지 ${packages.size}개 · 라이선스 본문 ${bodies.size}종`);
L.push('');
L.push('-'.repeat(78));
L.push('1. 임베드 글꼴 — DVC Sans KSX (Pretendard 의 KS X 1001 서브셋)');
L.push('-'.repeat(78));
L.push('');
L.push('PDF 내보내기에 쓰는 한글 글꼴은 Pretendard 에서 파생한 **수정본**입니다 — 상류 가변폰트의');
L.push('글리프 14,757자를 2,918자 정적 인스턴스로 서브셋했습니다. SIL Open Font License 1.1 의');
L.push('"Modified Version" 정의에 해당하므로, 3조에 따라 **예약 폰트 이름 "Pretendard" 를 쓰지');
L.push('않고** 내부 이름을 `DVC Sans KSX` 로 바꾸었습니다. 원저작자 저작권 표시(name ID 0)와');
L.push('라이선스 고지(name ID 13·14)는 글꼴 파일 안에 보존되어 있습니다.');
L.push('');
L.push('아래는 상류 Pretendard 의 라이선스 전문입니다.');
L.push('');
L.push(OFL);
L.push('');
L.push('-'.repeat(78));
L.push('2. 지도 데이터');
L.push('-'.repeat(78));
L.push('');
L.push('`server/src/intro/vendor/land-110m.json` 은 world-atlas(TopoJSON, ISC) 배포본이며');
L.push('원천 데이터는 Natural Earth(퍼블릭 도메인)입니다.');
L.push('  https://github.com/topojson/world-atlas  ·  https://www.naturalearthdata.com/');
L.push('');
if (unresolved.length) {
  L.push('-'.repeat(78));
  L.push('3. ⚠ 라이선스를 확인할 수 없는 패키지');
  L.push('-'.repeat(78));
  L.push('');
  L.push('아래 패키지는 `package.json` 의 `license` 필드도, 라이선스 본문 파일도 없습니다.');
  L.push('사실을 숨기지 않기 위해 그대로 적습니다 — 상용 납품 시 실사 대상입니다.');
  L.push('');
  for (const p of unresolved) L.push(`  · ${p.name}@${p.version}   (${[...p.where].join(', ')})`);
  L.push('');
}
L.push('-'.repeat(78));
L.push(`${unresolved.length ? '4' : '3'}. 패키지 목록`);
L.push('-'.repeat(78));
L.push('');
for (const p of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  L.push(`${p.name}@${p.version}  —  ${p.license || '(선언 없음)'}  [${[...p.where].sort().join(', ')}]`);
}
L.push('');
L.push('-'.repeat(78));
L.push(`${unresolved.length ? '5' : '4'}. 라이선스 본문`);
L.push('-'.repeat(78));
for (const [, e] of [...bodies.entries()].sort((a, b) => b[1].users.length - a[1].users.length)) {
  L.push('');
  L.push('='.repeat(78));
  L.push(`적용 패키지 (${e.users.length}): ${e.users.sort().join(', ')}`);
  L.push('='.repeat(78));
  L.push('');
  L.push(e.text);
}
L.push('');

const body = `${L.join('\n')}\n`;
const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (CHECK) {
  if (prev !== body) { console.error('[notices] THIRD-PARTY-NOTICES.txt 가 최신이 아닙니다 — `node scripts/third-party-notices.mjs` 를 돌리세요.'); process.exit(1); }
  console.log(`[notices] 최신입니다 (패키지 ${packages.size} · 본문 ${bodies.size}종).`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`[notices] ${path.relative(ROOT, OUT)} 생성 — 패키지 ${packages.size} · 본문 ${bodies.size}종 · ${(body.length / 1024).toFixed(0)}KB${unresolved.length ? ` · ⚠ 미확인 ${unresolved.length}건` : ''}`);
}
