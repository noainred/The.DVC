#!/usr/bin/env node
/**
 * scripts/tools-catalog.mjs — 특수 기능 카탈로그 내보내기(v2.614, 아키텍처 점검 2단계).
 *
 * 왜: 서버(포탈 점검 › 아키텍처 점검)가 **배포된 상태에서** 카탈로그(`web/src/views/specialToolsList.js`)와
 * 라우트 게이트·권한 키·toolcats 배치의 정합을 보려면 카탈로그를 읽을 길이 있어야 한다. 서버는 `web/src` 를
 * 갖지 않는다(오프라인 패키지·업그레이드 번들은 `web/dist` 만 담는다 — `packaging/offline/build-package.sh`).
 * 그래서 빌드 시 `web/public/special-tools.json` 을 생성하고(vite 가 `public/` 을 `dist/` 로 복사) 서버는
 * `config.webDist` 에서 읽는다(`server/src/portalcheck/toolCatalog.js`).
 *
 * 규약:
 *  · **손으로 적지 않는다** — 카탈로그 원천은 `specialToolsList.js` 하나이고 이 파일은 그 투사(projection)다.
 *    `web/package.json` 의 `prebuild` 가 매 빌드마다 돌리고, CI 는 `--check` 로 낡음을 드러낸다
 *    (`api-doc.mjs` 와 같은 관례). 서버 테스트(`server/test/toolCatalog2614.test.js`)는 원천을 **ESM import**
 *    로 읽어 생성물과 대조한다(정규식 금지 — v2.563 규약).
 *  · **못 읽은 것을 조용히 넘기지 않는다**(v2.563 `docsGen2452` 사고): 원천이 배열이 아니거나 키가 비었거나
 *    중복이면 **종료코드 1 이고 파일을 쓰지 않는다**.
 *  · 실리는 필드는 계약(ARCH-SPEC '카탈로그 내보내기')대로 **k·adminOnly·perm·external·topTab·comingSoon** 여섯뿐이다.
 *    label·desc·icon·aka 는 화면 전용이라 싣지 않는다(서버 판정에 쓰이지 않고 문구 변경마다 파일이 바뀐다).
 *    값은 모양을 고정한다 — adminOnly/topTab/comingSoon 은 boolean, perm/external 은 string|null.
 *  · **내용이 같으면 파일을 다시 쓰지 않는다** — `generatedAt` 은 '이 내용이 마지막으로 바뀐 시각' 이다.
 *    빌드마다 시각만 바꿔 쓰면 매 빌드가 git diff 를 만든다. `--check` 도 `generatedAt` 을 비교에서 뺀다.
 *
 * 사용: node scripts/tools-catalog.mjs [--check]
 *   --check  파일을 쓰지 않고 현재 web/public/special-tools.json 과 다르면 종료코드 1(CI 용)
 *   env TOOLS_CATALOG_OUT=<경로>  출력 파일 위치 재지정(테스트 전용 — 운영 빌드에서는 쓰지 않는다)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const SOURCE = path.join(ROOT, 'web/src/views/specialToolsList.js');
export const OUT = process.env.TOOLS_CATALOG_OUT
  ? path.resolve(process.env.TOOLS_CATALOG_OUT)
  : path.join(ROOT, 'web/public/special-tools.json');

/** 실리는 필드(계약) — 서버 `toolCatalog.js` 와 테스트가 같은 목록을 본다. */
export const CATALOG_FIELDS = Object.freeze(['k', 'adminOnly', 'perm', 'external', 'topTab', 'comingSoon']);

const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 도구 하나를 계약 모양으로 투사한다(순수). */
export function projectTool(t) {
  return {
    k: typeof t?.k === 'string' ? t.k : '',
    adminOnly: t?.adminOnly === true,
    perm: strOrNull(t?.perm),
    external: strOrNull(t?.external),
    topTab: t?.topTab === true,
    comingSoon: t?.comingSoon === true,
  };
}

/**
 * 원천 배열 → 카탈로그 객체(순수). 원천이 이상하면 던진다 — 호출부가 종료코드 1 로 만든다.
 * @param {Array} tools  specialToolsList.js 의 TOOLS
 * @param {string} [generatedAt]  ISO 시각(기본 지금)
 */
export function buildCatalog(tools, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(tools)) throw new Error('TOOLS 가 배열이 아닙니다');
  if (tools.length === 0) throw new Error('TOOLS 가 비어 있습니다');
  const seen = new Set();
  const out = tools.map((t, i) => {
    const p = projectTool(t);
    if (!p.k) throw new Error(`TOOLS[${i}] 의 k 가 비어 있습니다`);
    if (seen.has(p.k)) throw new Error(`TOOLS 에 k '${p.k}' 가 두 번 있습니다`);
    seen.add(p.k);
    return p;
  });
  return { generatedAt, count: out.length, tools: out };
}

/** generatedAt 을 뺀 비교용 문자열 — 두 카탈로그의 '내용' 이 같은지. */
export function contentKey(cat) {
  if (!cat || typeof cat !== 'object') return null;
  return JSON.stringify({ count: cat.count, tools: cat.tools });
}

function readExisting(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  let tools;
  try {
    ({ TOOLS: tools } = await import(pathToFileURL(SOURCE).href));
  } catch (e) {
    console.error(`[tools-catalog] 원천을 읽지 못했습니다: ${SOURCE} — ${e?.message || e}`);
    return 1;
  }
  let next;
  try {
    next = buildCatalog(tools);
  } catch (e) {
    console.error(`[tools-catalog] 원천 검증 실패 — 파일을 쓰지 않습니다: ${e?.message || e}`);
    return 1;
  }
  const cur = readExisting(OUT);
  const same = contentKey(cur) === contentKey(next);
  if (check) {
    if (same) return 0;
    console.error(`[tools-catalog] ${path.relative(ROOT, OUT)} 이 최신이 아닙니다 — 'node scripts/tools-catalog.mjs' 를 실행하세요.`);
    return 1;
  }
  if (same) {
    console.log(`[tools-catalog] 변경 없음 — ${path.relative(ROOT, OUT)} (${next.count}개, generatedAt ${cur.generatedAt})`);
    return 0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
  console.log(`[tools-catalog] 생성 — ${path.relative(ROOT, OUT)} (${next.count}개)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
