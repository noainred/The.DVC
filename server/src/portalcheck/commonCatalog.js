/**
 * 포탈 점검 › 공통 기능 — 빌드 때 만든 공통 기능 목록(`commonCatalog.json`)을 읽어 화면에 줄 모양으로 다듬는다(v3.10).
 *
 * 왜 파일을 읽기만 하나: 목록은 `scripts/common-doc.mjs` 가 **소스에서** 만든다(공용 모듈의 내보내는 이름 · 사용처 · 테스트 수).
 * 배포본에는 `web/src` · `server/test` · `scripts/` 가 없어(`packaging/offline/build-package.sh` 는 server/src · web/dist 만 담는다)
 * 포탈이 실행 중에 다시 만들 수 없다. 그래서 생성물을 `server/src` 에 싣고 여기서는 **읽기 · 모양 검증**만 한다.
 * `web/public` 에 두지 않는다 — `web/dist` 는 인증 없이 서빙되고 목록에는 서버 내부 모듈의 설명이 들어 있다(설계 docs/design/common-catalog §4.2).
 *
 * 규칙:
 *  · **'못 읽은 것' 은 0 이 아니다** — 파일이 없으면 `missing`, 형식이 틀리면 `unreadable` 을 돌려주고 빈 목록(모듈 0개)으로 만들지 않는다.
 *  · 읽기 오류의 원문(파일 조각 · 절대 경로)은 돌려주지 않는다 — 상태 글자만(`safeLoadText` 규칙과 같은 이유).
 *  · 숫자는 `numOrNull` 을 거친다(문자열 '' · null 이 0 이 되지 않게). 문자열 · 배열은 상한으로 자른다 — 우리 생성물이지만
 *    설치본 파일은 손상될 수 있고, 그 값이 그대로 응답에 실린다.
 *  · 파일은 설치본과 함께 바뀐다(업그레이드 = 재시작). 그래도 크기 · 수정 시각이 달라지면 다시 읽는다 — 재시작 없이 파일만 바뀐
 *    경우(수동 복구)에 낡은 판본을 붙잡지 않게.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { numOrNull } from '../util/numOrNull.js';

export const COMMON_CATALOG_FILE = fileURLToPath(new URL('./commonCatalog.json', import.meta.url));

export const COMMON_STATUS = Object.freeze({ OK: 'ok', MISSING: 'missing', UNREADABLE: 'unreadable' });

/** 생성기(`scripts/common-doc.mjs SCOPES` + 'outside')가 내는 구분 — 모르는 값은 그 모듈을 버린다. */
export const COMMON_SCOPES = Object.freeze(['server-util', 'web-components', 'web-hooks', 'web-util', 'web-top', 'outside']);

const MAX_FILE_BYTES = 8 * 1024 * 1024;   // 실측 약 176KB(2026-11-14) — 그 수십 배가 넘으면 우리 생성물이 아니다
const MAX_MODULES = 5000;
const MAX_EXPORTS = 200;
const MAX_AREAS = 300;
const MAX_TEST_FILES = 30;

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
/** 0 이상의 정수 또는 null(못 읽음). */
const count = (v) => {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const strList = (v, max, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(0, max).map((x) => x.slice(0, len)) : []);

/** 모듈 하나를 아는 필드만으로 다시 만든다(순수). 경로 · 구분이 없거나 모르는 구분이면 null. */
export function normalizeModule(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const file = str(m.file, 300);
  if (!file || !COMMON_SCOPES.includes(m.scope)) return null;
  const areaCounts = [];
  for (const pair of Array.isArray(m.areaCounts) ? m.areaCounts.slice(0, MAX_AREAS) : []) {
    if (!Array.isArray(pair)) continue;
    const name = str(pair[0], 80);
    const n = count(pair[1]);
    if (name && n !== null) areaCounts.push([name, n]);
  }
  return {
    file,
    scope: m.scope,
    summary: str(m.summary, 400),
    exports: strList(m.exports, MAX_EXPORTS, 120),
    users: count(m.users),
    areas: count(m.areas),
    areaCounts,
    tests: count(m.tests),
    testFiles: strList(m.testFiles, MAX_TEST_FILES, 300),
    twin: str(m.twin, 300) || null,
  };
}

/**
 * 파일 내용(파싱된 객체) → 화면에 줄 목록(순수). 모양이 아니면 null — 호출부가 `unreadable` 로 만든다.
 * ⚠ 모듈이 하나도 남지 않으면 null 이다 — '공용 모듈 0개' 는 이 저장소에서 있을 수 없는 값이고, 그렇게 읽혔다면 못 읽은 것이다.
 */
export function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.modules)) return null;
  const modules = [];
  for (const m of raw.modules.slice(0, MAX_MODULES)) {
    const n = normalizeModule(m);
    if (n) modules.push(n);
  }
  if (modules.length === 0) return null;
  const scopes = [];
  for (const s of Array.isArray(raw.scopes) ? raw.scopes.slice(0, 20) : []) {
    if (!s || typeof s !== 'object' || !COMMON_SCOPES.includes(s.id)) continue;
    scopes.push({ id: s.id, title: str(s.title, 60), dir: str(s.dir, 120) });
  }
  const dyn = raw.dynamicUnknown && typeof raw.dynamicUnknown === 'object' ? raw.dynamicUnknown : {};
  const lim = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  return {
    fileCount: count(raw.fileCount),
    dynamicUnknown: { count: count(dyn.count), files: strList(dyn.files, 50, 300) },
    limits: { sharedMinAreas: count(lim.sharedMinAreas), sharedMinWebUsers: count(lim.sharedMinWebUsers), testFilesMax: count(lim.testFilesMax) },
    scopes,
    modules,
  };
}

/**
 * 파일을 읽어 `{ status, catalog? }` 로. 던지지 않는다.
 * @param {string} [file] 테스트용 경로 재지정
 */
export function readCommonCatalog(file = COMMON_CATALOG_FILE) {
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return { status: COMMON_STATUS.UNREADABLE };
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // 없는 것(이 기능보다 앞선 설치본 · 수동 삭제)과 못 읽는 것(권한 · I/O)을 가른다.
    return { status: e?.code === 'ENOENT' ? COMMON_STATUS.MISSING : COMMON_STATUS.UNREADABLE };
  }
  let raw;
  try { raw = JSON.parse(text); } catch { return { status: COMMON_STATUS.UNREADABLE }; }
  const catalog = normalizeCatalog(raw);
  return catalog ? { status: COMMON_STATUS.OK, catalog } : { status: COMMON_STATUS.UNREADABLE };
}

let _cache = null; // { key, value }

/** 캐시된 읽기 — 파일의 크기 · 수정 시각이 같으면 다시 파싱하지 않는다(요청마다 176KB 를 파싱하지 않게). */
export function getCommonCatalog(file = COMMON_CATALOG_FILE) {
  let key = 'none';
  try { const st = fs.statSync(file); key = `${file}|${st.size}|${st.mtimeMs}`; } catch { /* 없음 — readCommonCatalog 가 상태로 말한다 */ }
  if (_cache && _cache.key === key) return _cache.value;
  const value = readCommonCatalog(file);
  _cache = { key, value };
  return value;
}

/** 테스트용 — 캐시를 비운다. */
export function _resetCommonCatalogForTest() { _cache = null; }
