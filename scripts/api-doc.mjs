#!/usr/bin/env node
/**
 * api-doc.mjs — `docs/API.md`(전 엔드포인트 레퍼런스)를 **소스에서** 생성한다.
 *
 * ⚠⚠ **왜 손으로 적지 않는가**: 이 저장소의 라우트는 820개가 넘고 릴리스마다 늘어난다.
 * `docsGen2452.test.js` 머리말이 기록한 실제 사고가 정확히 이 지점이다 — "정규식이 못 잡는
 * 형태가 생기면 문서에서 항목이 **조용히 사라지는데** 생성 자체는 성공하므로 CI 의 `--check`
 * 도 통과한다"(환경변수 28개·가장 큰 DB 2개가 그렇게 빠져 있었다). 그래서 이 스크립트는
 * 세 가지를 **명시적으로 실패**시킨다:
 *   ① 라우트가 있는데 마운트 경로를 못 찾은 파일       → `unmappedFiles`
 *   ② 인자 목록을 끝까지 못 읽은 라우트                → `parseFailed`
 * 하나라도 있으면 종료코드 1 이고 문서를 쓰지 않는다. **'문서는 생겼는데 비어 있는' 상태를
 * 만들지 않는 것**이 이 설계의 전부다.
 *
 * ⚠ **게이트 별칭을 반드시 해석한다**(v2.536 감사 규약): 이 저장소는 `const toolsPerm =
 * requirePerm('tools')` · `const adminOnly = requireRole('admin')` · `canEdit`(svcmon) 처럼
 * **이름이 가드처럼 생기지 않은 별칭**을 쓴다. 해석하지 못하면 멀쩡한 라우트 40여 개를
 * '무가드' 로 오판한다 — 그 오판이 문서에 실리면 **없는 취약점을 만들어** 다음 사람이 잘못
 * 판단한다. 별칭은 **다른 파일에 있을 수 있다**(`svcmon/shared.js` 의 `export const canEdit`)
 * — 그래서 import 를 따라가 해석한다. 그래도 해석하지 못한 이름은 **버리지 않고 문서 끝에
 * 목록으로 밝힌다**(조용히 '가드 없음' 으로 만들지 않는다).
 *
 * ⚠ **선언 줄에 안 보이는 게이트가 있다**: ⓐ 마운트 수준(`app.use('/api/svcmon', …,
 * requirePerm('svcmon'), r)`) ⓑ 라우터 수준(`capacityRouter.use(adminOnly)`). 둘 다 읽어
 * `inherited` 로 표시한다. 이것을 빠뜨리면 문서가 "이 경로는 인증만 하면 된다" 는 거짓을 말한다.
 *
 * 사용: node scripts/api-doc.mjs [--check]
 *   --check  파일을 쓰지 않고 현재 docs/API.md 와 다르면 종료코드 1(CI 용)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'server/src');
const OUT = path.join(ROOT, 'docs/API.md');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/* ── 유틸 ──────────────────────────────────────────────────────────────────── */

/** 주석·문자열을 건드리지 않고 파일을 읽는다(원문 유지 — 라인 번호가 정확해야 한다). */
const read = (p) => fs.readFileSync(p, 'utf8');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/**
 * 여는 괄호 위치에서 시작해 **최상위 인자**를 차례로 돌려준다.
 * 핸들러(함수 리터럴)를 만나면 거기서 멈춘다 — 가드만 필요하기 때문이다.
 * @returns {{args:string[], ok:boolean}}  ok=false 면 인자 목록을 끝까지 못 읽은 것
 */
function topLevelArgs(text, openIdx, limit = 3000) {
  let depth = 0; let i = openIdx; let start = -1;
  let str = null; let esc = false;
  const args = [];
  for (; i < text.length && i - openIdx < limit; i++) {
    const c = text[i];
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { str = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (depth === 1) start = i + 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(start, i)); return { args, ok: true }; }
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
      /*
       * ⚠⚠ **다음 인자가 핸들러이면 여기서 멈춘다.** 최상위 쉼표만 보고 판단하면
       *   `(req, res) => …` 의 쉼표는 **깊이 2** 라 경계로 잡히지 않아, 스캐너가 핸들러 본문을
       *   끝까지 읽다가 상한에 걸려 `ok:false` 가 된다(초판이 실제로 그랬다 — 35건이 그 형태였다).
       *   `api.get('/summary', (req, res) => memoJson(...))` 처럼 **가드 없이 바로 핸들러**인
       *   라우트가 이 저장소의 다수라 이 조기 종료가 없으면 문서가 통째로 못 만들어진다.
       */
      if (peekIsHandler(text, start)) return { args, ok: true };
    }
  }
  return { args, ok: false };
}

const looksLikeHandler = (a) => /^\s*(async\s+)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(a);

/**
 * 인자 시작 위치를 보고 '여기부터 핸들러' 인지 판단한다.
 * ⚠ 맨 앞 공백·줄바꿈을 건너뛴 뒤 `async` · `(` · `function` 으로 시작하면 핸들러다.
 *   가드는 `requirePerm('x')` · `adminOnly` 처럼 **식별자**로 시작하므로 겹치지 않는다.
 * ⚠ 한계(정직 기록): 핸들러를 **이름만 적어 참조**하면(`api.get('/x', handlerFn)`) 가드와
 *   구분할 수 없어 가드로 집계된다. 과다 보고이고 누락이 아니므로 안전한 쪽 실패다.
 */
function peekIsHandler(text, from) {
  const m = /^[\s]*(async\b|function\b|\()/.exec(text.slice(from, from + 40));
  return !!m;
}

/* ── ① 마운트 지도 — index.js 에서 '도출' 한다(표를 손으로 적지 않는다) ──────── */

function importMap(text, fromFile) {
  const m = new Map();                 // local name -> 절대 경로
  const re = /import\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s+'([^']+)'/g;
  let x;
  while ((x = re.exec(text))) {
    const spec = x[3];
    if (!spec.startsWith('.')) continue;
    const abs = path.resolve(path.dirname(fromFile), spec);
    if (x[2]) m.set(x[2], abs);
    for (const part of (x[1] || '').split(',')) {
      const name = part.split(' as ').pop().trim();
      if (name) m.set(name, abs);
    }
  }
  return m;
}

function mountTable() {
  const idxFile = path.join(SRC, 'index.js');
  const text = read(idxFile);
  const imports = importMap(text, idxFile);
  const mounts = [];                   // { prefix, guards[], file }
  const re = /app\.use\(\s*'([^']+)'\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index);
    const { args, ok } = topLevelArgs(text, open, 600);
    if (!ok || args.length < 2) continue;
    const last = args[args.length - 1].trim();
    const file = imports.get(last);
    if (!file) continue;               // BIG_JSON 등 미들웨어 마운트 — 라우터가 아니다
    mounts.push({
      prefix: m[1],
      guards: args.slice(1, -1).map((s) => s.trim()).filter(Boolean),
      file: fs.existsSync(file) ? file : `${file}.js`,
      routerVar: last,
    });
  }
  return mounts;
}

/**
 * 루트 라우터 파일 → 하위 파일로 접두를 전파한다.
 * `registerX(api)` 형태로 같은 라우터를 넘겨 등록하는 것이 이 저장소의 관례다.
 */
function propagate(mounts) {
  const byFile = new Map();            // 절대경로 -> { prefix, guards[] }
  const queue = [];
  for (const mt of mounts) {
    if (!fs.existsSync(mt.file)) continue;
    byFile.set(mt.file, { prefix: mt.prefix, guards: mt.guards });
    queue.push(mt.file);
  }
  while (queue.length) {
    const f = queue.shift();
    const base = byFile.get(f);
    const text = read(f);
    const imports = importMap(text, f);
    // `registerFoo(api);` — 인자로 넘긴 라우터가 이 파일의 라우터라고 본다.
    const re = /\n\s*([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
    let m;
    while ((m = re.exec(text))) {
      if (!/^register/.test(m[1])) continue;
      let target = imports.get(m[1]);
      if (!target) continue;
      if (!fs.existsSync(target)) target = `${target}.js`;
      if (!fs.existsSync(target) || byFile.has(target)) continue;
      byFile.set(target, { prefix: base.prefix, guards: base.guards });
      queue.push(target);
    }
  }
  return byFile;
}

/* ── ② 게이트 별칭 해석 ────────────────────────────────────────────────────── */

/** `export const canEdit = requireRole(...)` — 다른 파일이 가져다 쓰는 가드 별칭. */
const EXPORTED = new Map();          // 절대경로 -> Map(name -> expr)
function exportedAliases(file) {
  if (EXPORTED.has(file)) return EXPORTED.get(file);
  let m = new Map();
  try {
    const t = read(file);
    for (const x of t.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(requireRole\([^)]*\)|requirePerm\([^)]*\)|\[[^\]]*\])\s*;/g)) m.set(x[1], x[2].trim());
  } catch { m = new Map(); }
  EXPORTED.set(file, m);
  return m;
}

function aliasMap(text) {
  const m = new Map();
  // const adminOnly = requireRole('admin');  /  const owner = [adminOnly, requireSettingsOwner];
  const re = /const\s+([A-Za-z_$][\w$]*)\s*=\s*(requireRole\([^)]*\)|requirePerm\([^)]*\)|\[[^\]]*\])\s*;/g;
  let x;
  while ((x = re.exec(text))) m.set(x[1], x[2].trim());
  return m;
}

/** 별칭을 한 단계씩 펼친다(배열 별칭이 별칭을 품는 경우가 있다). */
/**
 * 가드 인자 텍스트에서 **주석을 먼저 제거**한다.
 * ⚠ 이것을 빼면 라우트 인자 사이에 적힌 설명 주석이 통째로 '가드 이름' 으로 문서에 실린다
 *   (초판이 실제로 그랬다 — `// ★ 인증을 256MB raw 바디 …` 한 줄이 게이트 표에 나왔다).
 *   v2.535 의 '주석을 먼저 제거하고 검사할 것' 과 같은 규칙이다.
 */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

function resolveGuard(g, alias, depth = 0, imports = null) {
  let t = stripComments(g).trim();
  if (!t) return [];
  // ⚠ `...adminOnly` — 배열 별칭 전개. 접두를 떼지 않으면 별칭 해석이 통째로 빗나간다.
  if (t.startsWith('...')) t = t.slice(3).trim();
  if (depth > 4) return [t];
  const expand = (v) => (v.startsWith('[')
    ? v.slice(1, -1).split(',').flatMap((s) => resolveGuard(s, alias, depth + 1, imports))
    : [v]);
  if (alias.has(t)) return expand(alias.get(t));
  // ⚠ 같은 파일에 없으면 **import 를 따라간다** — `canEdit` 는 `svcmon/shared.js` 에 있다.
  if (imports && /^[A-Za-z_$][\w$]*$/.test(t)) {
    let f = imports.get(t);
    if (f) {
      if (!fs.existsSync(f)) f = `${f}.js`;
      if (fs.existsSync(f)) {
        const ex = exportedAliases(f);
        if (ex.has(t)) return expand(ex.get(t));
      }
    }
  }
  if (t.startsWith('[')) return t.slice(1, -1).split(',').flatMap((s) => resolveGuard(s, alias, depth + 1, imports));
  return [t];
}

/** 해석된 가드 텍스트에서 권한·역할을 뽑는다. */
function classify(guards) {
  const perms = new Set(); const roles = new Set(); const flags = new Set();
  for (const g of guards) {
    let m = /requirePerm\(\s*'([^']+)'/.exec(g);
    if (m) { perms.add(m[1]); continue; }
    m = /requireRole\(([^)]*)\)/.exec(g);
    if (m) { for (const r of m[1].split(',')) { const v = r.trim().replace(/^'|'$/g, ''); if (v) roles.add(v); } continue; }
    const name = g.replace(/\(.*$/s, '').trim();
    if (name) flags.add(name);
  }
  return { perms: [...perms], roles: [...roles], flags: [...flags] };
}

/**
 * 이 파일에서 '라우터' 인 변수 이름을 모은다.
 * ⚠ 이름을 블랙리스트(`req`·`res` 제외)로 거르지 말 것 — 다음에 생길 `ctx.get('x')` 류를
 *   또 놓친다. **화이트리스트(라우터임이 증명된 이름)** 로 받는다.
 */
function routerVarsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\.)?Router\(/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+register[A-Za-z0-9_$]*\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}

/* ── ③ 라우트 수집 ─────────────────────────────────────────────────────────── */

function collect() {
  const mounts = mountTable();
  const byFile = propagate(mounts);
  const routes = [];
  const unmappedFiles = new Set();
  const parseFailed = [];

  for (const file of walk(path.join(SRC, 'routes'))) {
    const text = read(file);
    const alias = aliasMap(text);
    const imports = importMap(text, file);
    const base = byFile.get(file);

    // 라우터 수준 가드: `xRouter.use(adminOnly);` (경로 인자가 없는 것만 — 전 라우트에 걸린다)
    const routerGuards = [];
    const useRe = /\n\s*[A-Za-z_$][\w$]*\.use\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;/g;
    let u;
    while ((u = useRe.exec(text))) routerGuards.push(...resolveGuard(u[1], alias, 0, imports));

    const routerNames = routerVarsOf(text);
    const re = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.(${METHODS.join('|')})\\(\\s*'([^']*)'`, 'g');
    let m;
    while ((m = re.exec(text))) {
      /*
       * ⚠⚠ **`req.get('host')` 은 라우트가 아니다** — express 의 요청 헤더 읽기다.
       *   초판은 변수명을 가리지 않아 **34건을 라우트로 잘못 셌다**(854 중). 없는 엔드포인트를
       *   문서에 싣는 것은 누락만큼 나쁘다 — 읽는 사람이 있지도 않은 경로를 호출한다.
       *   그래서 **그 파일에서 실제로 라우터인 이름**만 받는다(`Router()` 선언 · `register*`
       *   함수의 인자 · 마운트된 라우터 이름).
       */
      if (!routerNames.has(m[1])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      if (!base) { unmappedFiles.add(rel(file)); continue; }
      const open = text.indexOf('(', m.index + m[1].length + 1);
      const { args, ok } = topLevelArgs(text, open);
      if (!ok) { parseFailed.push(`${rel(file)}:${line}`); continue; }
      const own = args.slice(1).filter((a) => !looksLikeHandler(a))
        .flatMap((a) => resolveGuard(a, alias, 0, imports));
      routes.push({
        method: m[2].toUpperCase(),
        path: (base.prefix + m[3]).replace(/\/+$/, '') || base.prefix,
        sub: m[3],
        mount: base.prefix,
        own,
        inherited: [...base.guards.flatMap((g) => resolveGuard(g, alias, 0, imports)), ...routerGuards],
        file: rel(file),
        line,
      });
    }
  }
  return { routes, mounts, unmappedFiles: [...unmappedFiles], parseFailed };
}

/* ── ④ 문서 생성 ───────────────────────────────────────────────────────────── */

/** 마운트 접두별 설명 — 문서의 '뜻' 은 여기 한 곳에만 손으로 적는다. */
const GROUP_NOTE = {
  '/api/v1': '**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).',
  '/api/collector': '엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.',
  '/api/central': '엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.',
  '/api/auth': '로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).',
  '/api/admin': '설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다.',
  '/api/upgrade': '자동 업그레이드 제어(번들 수신·적용).',
  '/api/remote': '원격 접속(HAProxy/SSH/RDP 중계).',
  '/api/insights': 'FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm(\'insights\')`.',
  '/api/svcmon': '성능점검(서비스 모니터링). 마운트에서 `requirePerm(\'svcmon\')` — v2.506 에 추가된 게이트다.',
  '/api/capacity': '리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다.',
  '/api/ping': '네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).',
  '/api': '포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.',
  '/dl': '중앙 업그레이드 소스(`versions.json` + 번들). **공개**다.',
  '/metrics': 'Prometheus/OTel 익스포터(선택 토큰).',
};

/**
 * 게이트 헬퍼 용어집 — `requireRole`·`requirePerm` 으로 환원되지 않는 이름의 뜻.
 * ⚠ **여기 없는 이름이 표에 나오면 그것은 '뜻을 모른다' 는 뜻**이다. 문서가 스스로
 *   그 사실을 밝히도록 생성 시 목록으로 남긴다(조용히 넘어가지 않는다).
 */
const GUARD_NOTE = {
  fullScopeOnly: '**전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 \'장비 0대\' 라는 거짓이 된다).',
  fleetFullScopeOnly: '**전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403.',
  requireSettingsOwner: '**설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다.',
  requireOwnOtp: '**본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다.',
  reauth: '통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만.',
  ownerIfAutoCentralToken: '요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급).',
  'express.json': '본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약).',
  'express.raw': '원시 바디 버퍼(업그레이드 번들 등). ⚠ 게이트가 아니다 — 인증을 이 앞에 두어 미인증 요청이 대용량 바디를 적재하지 못하게 한다.',
  guarded: '공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다.',
  authMiddleware: '세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등).',
  auditMiddleware: '상태변경 감사 로그 기록.',
  requireEnrolled: 'OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다.',
};

function guardText(r) {
  const c = classify([...r.inherited, ...r.own]);
  const parts = [];
  if (c.roles.length) parts.push(`역할 ${c.roles.join('/')}`);
  if (c.perms.length) parts.push(`권한 ${c.perms.map((p) => `\`${p}\``).join(', ')}`);
  for (const f of c.flags) {
    if (f === 'authMiddleware' || f === 'requireEnrolled' || f === 'auditMiddleware') continue;
    parts.push(`\`${f}\``);
  }
  return parts.length ? parts.join(' · ') : '—';
}

function render({ routes, mounts, counts }) {
  const groups = new Map();
  for (const r of routes) {
    if (!groups.has(r.mount)) groups.set(r.mount, []);
    groups.get(r.mount).push(r);
  }
  const order = [...groups.keys()].sort((a, b) => (b.length - a.length) || a.localeCompare(b));

  const L = [];
  L.push('# API 레퍼런스 (전 엔드포인트)');
  L.push('');
  L.push('> ⚙️ **이 파일은 `scripts/api-doc.mjs` 가 소스에서 생성합니다 — 직접 고치지 마세요.**');
  L.push('> 라우트를 추가·삭제하면 `node scripts/api-doc.mjs` 로 다시 만듭니다.');
  L.push('> 외부 포탈이 쓰는 **공개 API** 는 이 파일이 아니라 [API-PUBLIC.md](API-PUBLIC.md) 를 보세요.');
  L.push('');
  L.push('## 이 문서를 읽는 법');
  L.push('');
  L.push('- **게이트** 열은 그 경로에 실제로 걸린 인증·인가를 **마운트 수준과 라우터 수준까지 합쳐** 적습니다.');
  L.push('  선언 줄만 보면 보이지 않는 것들입니다(예: `/api/svcmon/*` 의 `requirePerm(\'svcmon\')` 은');
  L.push('  `index.js` 의 마운트에 있고, `/api/capacity/*` 의 `adminOnly` 는 라우터의 `use()` 에 있습니다).');
  L.push('- `authMiddleware`·`requireEnrolled`·`auditMiddleware` 는 `/api/*` 대부분에 공통이라 열에서 생략했습니다.');
  L.push('  **생략은 "없다" 가 아닙니다** — 그룹 설명에 어느 경로가 그것을 타는지 적혀 있습니다.');
  L.push('- **게이트가 `—` 인 것이 곧 무방비라는 뜻은 아닙니다.** 토큰 게이트(`/api/collector`·`/api/central`)는');
  L.push('  라우터 미들웨어가 처리하고, 일부 라우트는 핸들러 안에서 직접 검사합니다(`fullScopeOnly` 같은');
  L.push('  헬퍼가 함수 안에 있는 경우). 정확한 판정은 항상 **파일:줄** 을 열어 확인하세요.');
  L.push('- **범위(scope)**: 조회 라우트는 `auth/scope.js scopedVcenterIds` 로 사용자의 vCenter 범위와');
  L.push('  교집합합니다. 범위 밖 단건은 **403 이 아니라 404**(존재 은닉)이고, 조회는 되지만 쓰기 범위');
  L.push('  밖이면 403 입니다. 자세한 규약은 `server/CLAUDE.md`.');
  L.push('');
  L.push('## 요약');
  L.push('');
  L.push('| 항목 | 값 |');
  L.push('|---|---|');
  L.push(`| 엔드포인트 | **${routes.length}개** |`);
  L.push(`| 마운트 그룹 | ${order.length}개 |`);
  L.push(`| 라우트 파일 | ${new Set(routes.map((r) => r.file)).size}개 |`);
  for (const m of METHODS) {
    const n = routes.filter((r) => r.method === m.toUpperCase()).length;
    if (n) L.push(`| ${m.toUpperCase()} | ${n}개 |`);
  }
  L.push('');
  L.push('| 그룹 | 엔드포인트 | 설명 |');
  L.push('|---|---:|---|');
  for (const g of order) {
    L.push(`| [\`${g}\`](#${anchor(g)}) | ${groups.get(g).length} | ${(GROUP_NOTE[g] || '').replace(/\|/g, '\\|') || '—'} |`);
  }
  L.push('');
  L.push('---');
  L.push('');

  for (const g of order) {
    const rs = groups.get(g).sort((a, b) => a.sub.localeCompare(b.sub) || a.method.localeCompare(b.method));
    L.push(`## \`${g}\``);
    L.push('');
    if (GROUP_NOTE[g]) { L.push(GROUP_NOTE[g]); L.push(''); }
    const inh = rs[0] ? classify(rs[0].inherited) : { roles: [], perms: [], flags: [] };
    const inhTxt = [...inh.flags, ...inh.perms.map((p) => `requirePerm('${p}')`), ...inh.roles.map((r) => `role:${r}`)];
    if (inhTxt.length) {
      L.push(`**공통 게이트**(마운트·라우터 수준): ${inhTxt.map((t) => `\`${t}\``).join(' → ')}`);
      L.push('');
    }
    L.push('| 메서드 | 경로 | 게이트(공통 제외) | 소스 |');
    L.push('|---|---|---|---|');
    for (const r of rs) {
      const own = r.own.length ? guardOwn(r) : '—';
      L.push(`| ${r.method} | \`${r.sub || '/'}\` | ${own} | [${r.file}:${r.line}](../${r.file}#L${r.line}) |`);
    }
    L.push('');
  }

  // 표에 실제로 나온 가드 헬퍼 이름을 모아 용어집을 만든다(안 나온 것은 싣지 않는다).
  const used = new Map();
  for (const r of routes) {
    for (const f of classify(r.own).flags) used.set(f, (used.get(f) || 0) + 1);
  }
  if (used.size) {
    L.push('---');
    L.push('');
    L.push('## 게이트 헬퍼 용어집');
    L.push('');
    L.push('표의 게이트 열에 나오는 이름 중 `역할`·`권한` 으로 환원되지 않는 것들입니다.');
    L.push('');
    L.push('| 이름 | 붙은 라우트 | 뜻 |');
    L.push('|---|---:|---|');
    const unknown = [];
    for (const [k, n] of [...used.entries()].sort((a, b) => b[1] - a[1])) {
      if (!GUARD_NOTE[k]) unknown.push(k);
      L.push(`| \`${k}\` | ${n} | ${GUARD_NOTE[k] || '⚠ **이 생성기가 뜻을 모르는 이름입니다** — 소스를 열어 확인하고 `scripts/api-doc.mjs` 의 `GUARD_NOTE` 에 추가하세요.'} |`);
    }
    L.push('');
    if (unknown.length) {
      L.push(`> ⚠ 뜻을 모르는 게이트 **${unknown.length}개**: ${unknown.map((u) => `\`${u}\``).join(', ')} — 문서가 이 사실을 숨기지 않습니다.`);
      L.push('');
    }
  }
  L.push('---');
  L.push('');
  L.push('## 생성 정보');
  L.push('');
  L.push('- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`');
  L.push('- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이');
  L.push('  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).');
  L.push('');
  return `${L.join('\n')}\n`;
}

function guardOwn(r) {
  const c = classify(r.own);
  const parts = [];
  if (c.roles.length) parts.push(`역할 \`${c.roles.join('/')}\``);
  if (c.perms.length) parts.push(`권한 ${c.perms.map((p) => `\`${p}\``).join(', ')}`);
  for (const f of c.flags) parts.push(`\`${f}\``);
  return parts.length ? parts.join(' · ') : '—';
}

const anchor = (s) => s.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();

/* ── 실행 ──────────────────────────────────────────────────────────────────── */

const res = collect();
const problems = [];
if (res.unmappedFiles.length) problems.push(`마운트 경로를 찾지 못한 라우트 파일 ${res.unmappedFiles.length}개:\n  ${res.unmappedFiles.join('\n  ')}`);
if (res.parseFailed.length) problems.push(`인자 목록을 읽지 못한 라우트 ${res.parseFailed.length}건:\n  ${res.parseFailed.join('\n  ')}`);
if (problems.length) {
  console.error('[api-doc] 생성 중단 — 스캐너가 놓친 것이 있습니다(문서를 조용히 비우지 않습니다):\n');
  for (const p of problems) console.error(`- ${p}\n`);
  process.exit(1);
}

const md = render(res);
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? read(OUT) : '';
  if (cur !== md) { console.error(`[api-doc] docs/API.md 가 최신이 아닙니다 — 'node scripts/api-doc.mjs' 를 실행하세요.`); process.exit(1); }
  console.log(`[api-doc] 최신 (${res.routes.length}개 엔드포인트)`);
} else {
  fs.writeFileSync(OUT, md);
  console.log(`[api-doc] docs/API.md 생성 — 엔드포인트 ${res.routes.length}개 · 그룹 ${new Set(res.routes.map((r) => r.mount)).size}개 · 파일 ${new Set(res.routes.map((r) => r.file)).size}개`);
}
