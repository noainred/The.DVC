/**
 * views/tools/archCheckText.js — '포탈 점검 › 아키텍처 점검' 의 **문구**(순수, v2.614).
 *
 * 왜: v2.613 까지 감사에서 손으로 돌리던 판정(라우트 게이트·도구 세그먼트·카탈로그·엣지 로그 표·
 * BIG_JSON·DB 파일·설정 파일 분류·import 순환)을 **운영 포탈이 스스로** 돌린다. 판정은 서버
 * `portalcheck/archScan.js` 가 `code` + `state` + 표본만 주고, 문장은 여기 하나가 만든다
 * (v2.553 `settingsCheckText.js` · v2.560 `tokenCheckText.js` · v2.570 `invCheckText.js` 관례).
 *
 * ── 이 화면이 만들 수 있는 거짓 — 전부 여기서 막는다 ─────────────────────────
 *  ① **확인 불가(unknown)를 정상으로 세지 않는다** — 입력을 못 읽은 항목(카탈로그 파일 없음·
 *     dbDir 못 읽음)은 정상에도 결함에도 넣지 않고 따로 센다. KPI 항등식 `합계 = 정상+경고+결함+확인 불가`.
 *  ② **카탈로그가 없으면 초록 배너를 내지 않는다** — 카탈로그 의존 항목이 전부 확인 불가이므로
 *     '정상' 이라 말할 근거가 없다.
 *  ③ **판정을 여기서 다시 하지 않는다** — `state` 는 서버 값을 읽기만 한다(값이 없으면 확인 불가).
 *  ④ **표본을 조용히 자르지 않는다** — 화면은 3개만 펼치되 '외 N' 으로 개수를 말하고, 서버가
 *     20개 상한으로 뺀 것(`omitted`)도 따로 말한다.
 *
 * ⚠ 문구에 **백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석한다(v2.439·2.440·2.505·2.545·
 *   2.553·2.576 실제 사고). 값 인용은 홑화살괄호 ‘ ’ 로 한다. 파일·함수 이름도 그대로 적는다.
 * ⚠ 상한·주기 **숫자를 문구에 박지 말 것** — 서버가 주는 값(`omitted`·`count`)만 쓴다.
 */

import { numOrNull } from '../../numOrNull.js';

const t = (v) => String(v ?? '').trim();
/** `v == null || v === ''` 를 먼저 본다 — `Number(null)===0` 함정(v2.525·v2.550·v2.552·v2.556). */
const n = numOrNull;

/* ── 상태 ─────────────────────────────────────────────────────────────────── */

export const ARCH_STATE = Object.freeze({ OK: 'ok', WARN: 'warn', FAULT: 'fault', UNKNOWN: 'unknown' });
export const ARCH_STATE_LABEL = Object.freeze({ ok: '정상', warn: '경고', fault: '결함', unknown: '확인 불가' });
/** ⚠ unknown 은 회색 — 초록으로 칠하면 '못 읽은 것' 이 '정상' 으로 읽힌다. */
export const ARCH_STATE_TONE = Object.freeze({ ok: 'green', warn: 'amber', fault: 'red', unknown: 'gray' });
/** 나쁜 것이 위 — 표 정렬·배너 판정에 쓰는 순서. */
const STATE_RANK = Object.freeze({ fault: 0, warn: 1, unknown: 2, ok: 3 });

export const stateTone = (state) => ARCH_STATE_TONE[t(state)] || 'gray';
export const stateLabel = (state) => ARCH_STATE_LABEL[t(state)] || '확인 불가';

/**
 * ⚠⚠ **판정을 여기서 다시 하지 말 것** — 상태는 서버 `portalcheck/archScan.js scanArch` 가 소유하고
 *   `item.state` 로 내려온다. 값이 없거나 모르는 값이면 확인 불가다(초록 폴백 금지).
 */
export function itemState(item) {
  const s = t(item?.state);
  return Object.values(ARCH_STATE).includes(s) ? s : ARCH_STATE.UNKNOWN;
}

/* ── 항목 문구(코드 ↔ 문구 1:1 — 서버 ARCH_CODES 와 테스트가 대조) ───────────── */

/**
 * `title` 은 표의 '항목' 열, `meaning` 은 그 항목이 왜 결함인지(툴팁·상세), `fix` 는 '조치' 열.
 * 문장은 **그 상태가 0 이 아닐 때** 를 기준으로 쓴다(정상이면 표가 '해당 없음' 을 보인다).
 */
export const ARCH_TEXT = Object.freeze({
  'route-gate-missing': {
    title: '관리자 상태 변경 라우트에 전체 범위 게이트 없음',
    meaning: '/api/admin·/api/tools 의 POST·PUT·PATCH·DELETE 중 관리자(admin) 게이트만 있고 전체 범위(fullScope·fleet) 게이트가 없는 라우트입니다. 범위 관리자가 다른 법인 설정을 바꾸거나 지울 수 있습니다(v2.605·v2.612 사고와 같은 유형).',
    fix: '해당 라우트에 **fullScopeOnlyWith(사유)** 또는 파일 상단 **fleetOnly** 를 붙이세요. 범위 관리자에게 열어야 하는 것이면 서버 **ROUTE_GATE_ALLOW** 에 사유와 함께 적으세요.',
  },
  'asyncroute-unwrapped': {
    title: 'async 핸들러가 wrapAsyncRouter 밖에 있음',
    meaning: 'express 4 는 async 핸들러의 throw 를 잡지 않습니다 — 그 라우트는 오류가 나면 500 이 아니라 **응답 없이 매달리고** 소켓을 잡습니다(v2.574 BUG-01).',
    fix: '그 라우터를 선언 직후 **wrapAsyncRouter(router)** 로 감싸세요(라우트 등록보다 앞이어야 합니다).',
  },
  'tool-segment-unmapped': {
    title: '/api/tools 세그먼트가 도구 키에 매핑되지 않음',
    meaning: '/api/tools/<seg> 의 seg 가 auth/toolAccess.js 의 TOOL_PATH_KEYS·TOOL_PATH2_KEYS 어디에도 없어 **사용자별 도구 권한(허용·거부 목록)이 그 경로를 막지 못합니다**. 화면은 숨겨도 API 는 열려 있습니다(v2.536 사고).',
    fix: 'auth/toolAccess.js 의 **TOOL_PATH_KEYS** 에 도구 키를 매핑하거나, 도구가 아니면 **UNMAPPED_TOOL_SEGMENTS** 에 사유와 함께 선언하세요.',
  },
  'catalog-missing': {
    title: '특수 기능 카탈로그(special-tools.json)를 읽지 못함',
    meaning: '웹 빌드가 만드는 web/dist/special-tools.json 이 없거나 읽히지 않습니다. 카탈로그에 기대는 항목(권한 키 대조·adminOnly 대조)은 **판정할 수 없어 확인 불가**입니다 — 정상이라는 뜻이 아닙니다.',
    fix: '웹을 다시 빌드하세요(**npm run build** 의 prebuild 가 scripts/tools-catalog.mjs 로 만듭니다). 오프라인 패키지라면 web/dist 가 통째로 복사됐는지 확인하세요.',
  },
  'catalog-key-orphan': {
    title: '카탈로그에 없는 도구 키를 참조함',
    meaning: 'permissions.json 의 허용·거부 목록, toolcats 배치, TOOL_PATH_KEYS 값 중 카탈로그(specialToolsList)에 없는 키입니다. 그 권한·배치는 **아무 화면도 막거나 보이지 않게 하지 못합니다**(키가 바뀐 도구의 잔재이거나 오타).',
    fix: '키를 카탈로그의 현재 키로 고치거나 그 항목을 지우세요. 도구 키는 이름을 바꿔도 유지하고 옛 이름은 **aka** 에 남기는 것이 규칙입니다(v2.508).',
  },
  'catalog-adminonly-mismatch': {
    title: '카탈로그 adminOnly 와 라우트 게이트가 어긋남',
    meaning: '카드는 관리자 전용으로 표시하는데 주 라우트(/api/tools/<seg> GET)는 tools 권한만 요구하거나, 그 반대입니다. adminOnly 는 표시 관례이지 접근 제어가 아니라(v2.555) **operator 가 주소로 직접 열 수 있습니다**.',
    fix: '접근 제어가 의도라면 라우트에 **adminOnly** 게이트를 붙이고, 표시만이 의도라면 카탈로그의 adminOnly 를 내리세요. 둘 중 무엇이 맞는지는 그 화면의 데이터 범위로 정합니다.',
  },
  'edgelog-spec-drift': {
    title: '엣지 로그 표(STATUS_SPEC)가 없는 모듈·함수를 가리킴',
    meaning: 'edgelog/spec.js 항목의 모듈이 없거나 그 함수가 export 되지 않습니다. 엣지 로그 화면에서 그 워커·폴러의 상태가 **조용히 비어** 진단할 길이 사라집니다(v2.554·v2.574 규약).',
    fix: '이름을 바꾼 모듈·함수라면 **edgelog/spec.js** 의 항목을 따라 고치고, 지운 것이면 항목을 빼세요. 새 워커는 상태 함수(…Status)를 export 하고 표에 함께 넣습니다.',
  },
  'bigjson-missing': {
    title: '엣지 수신 POST 경로가 BIG_JSON 에 없음',
    meaning: 'centralRouter·collectorRouter 의 POST 경로 중 큰 본문 한도(BIG_JSON)에 등록되지 않은 것입니다. express.json 기본 1MB 는 압축 해제 후 길이라 큰 push 가 413 이 되고, 413 은 재시도 대상이 아니라 **그 법인 데이터가 조용히 전량 소실**됩니다(v2.517·v2.503).',
    fix: '큰 본문이 올 수 있는 경로면 index.js 의 **BIG_JSON** 에 등록하세요. 작은 본문만 오는 경로면 서버 **BIG_JSON_SMALL** 에 사유와 함께 적으세요.',
  },
  'dataflow-cats-unmapped': {
    title: '데이터 흐름 지도 분류(CATS)에 없는 경로',
    meaning: 'central·collector 라우터에 선언된 경로가 dataflow/build.js 의 분류 표에 걸리지 않아 데이터 흐름 지도에서 **‘기타’ 로 밀립니다**(v2.587 규약 — 새 경로는 CATS 에 분류).',
    fix: '**dataflow/build.js CATS** 에 그 경로의 분류(side:path 정규식)를 더하세요.',
  },
  'db-file-mode': {
    title: 'DB 파일 권한이 0600 이 아님',
    meaning: 'dbDir 의 .db·-wal·-shm 파일 중 소유자 외에도 읽을 수 있는 권한의 파일입니다. WAL·SHM 은 본체 권한을 복사하므로 chmod 순서가 늦으면 0644 로 남습니다(v2.611 DB2611-01).',
    fix: '그 파일을 **chmod 600** 하세요. 새 DB 모듈은 util/sqliteOpen.js 의 openSqlite 를 쓰거나 생성자 직후 chmodDbFiles 를 부릅니다.',
  },
  'db-not-migratable': {
    title: 'DB 파일이 이전 목록(MIGRATABLE)에 없음',
    meaning: 'dbDir 에 있는 .db 파일이 insights/dbLocation.js MIGRATABLE 에 없어 **DB 위치 이전에서 빠집니다** — 이전 뒤 그 이력이 사라진 것처럼 보입니다(v2.548 규약: DB 경로와 MIGRATABLE 은 함께).',
    fix: '**insights/dbLocation.js MIGRATABLE** 에 그 파일명을 더하세요. 이전 대상이 아닌 임시 파일이면 dbDir 밖으로 옮기세요.',
  },
  'db-no-purpose': {
    title: 'DB·상태 파일에 용도 설명이 없음',
    meaning: 'MIGRATABLE·RUNTIME_STATE_NAMES 에 있는 파일인데 portalDb PURPOSES 에 설명이 없습니다. DB 점검 화면에서 그 파일이 **무엇인지 말하지 못합니다**.',
    fix: '**portalDb PURPOSES** 에 그 파일의 용도 한 줄을 더하세요.',
  },
  'config-file-unclassified': {
    title: 'CONFIG_DIR 의 파일이 어느 분류에도 없음',
    meaning: 'CONFIG_DIR 의 .json·.env·.txt 중 설정(SECRET_FILES·CONFIG-FILES 카탈로그)·상태(isRuntimeStateFile)·비밀 어디에도 없는 파일입니다. 백업 변경 감시·설정 push 감시·비밀 봉인이 **그 파일을 모릅니다**(v2.590 P1·v2.602).',
    fix: '설정 파일이면 생성기가 읽는 형태(createActivityLog·loadJson 등)로 선언해 CONFIG-FILES.md 에 실리게 하고, 실행 상태면 **isRuntimeStateFile** 목록에, 비밀이면 **SECRET_FILES** 에 넣으세요.',
  },
  'import-cycle': {
    title: 'server/src 정적 import 순환이 상한을 넘음',
    meaning: '순환 강결합 요소(SCC)의 수가 arch2579 가 고정한 상한을 넘었습니다. 순환 안에서는 import 한 이름이 가려져 함수가 통째로 죽는 TDZ 사고가 납니다(v2.566 — 10일간 조용했다).',
    fix: '새로 생긴 순환의 한쪽을 **util/ 의 순수 모듈** 로 떼거나 동적 import 로 미루세요. 그리고 test/arch2579.test.js 의 상한을 올리지 마세요.',
  },
  'util-imports-domain': {
    title: 'util/ 모듈이 도메인 디렉터리를 import 함',
    meaning: 'util/ 은 도메인을 몰라야 합니다 — 도메인을 import 하는 순간 순환의 씨앗이 됩니다(v2.579 ARCH-02: 그 순환을 동적 import 로 떠받치고 있었습니다).',
    fix: '그 판정을 util/ 의 순수 함수로 옮기고 도메인 쪽이 util 을 import 하게 방향을 뒤집으세요. 예외가 필요하면 **UTIL_ALLOW** 에 사유와 함께.',
  },
});

/** 선언된 코드 목록 — 서버 ARCH_CODES 와 테스트가 1:1 대조한다. */
export const archCodesDeclared = () => Object.keys(ARCH_TEXT);

/** 카탈로그(special-tools.json)에 기대는 항목 — 카탈로그가 없으면 이 셋은 판정할 수 없다. */
export const CATALOG_DEPENDENT_CODES = Object.freeze(['catalog-missing', 'catalog-key-orphan', 'catalog-adminonly-mismatch']);

export function itemTitle(item) {
  const c = t(item?.code);
  return ARCH_TEXT[c]?.title || c || '(코드 없음)';
}

/* ── KPI ──────────────────────────────────────────────────────────────────── */

/**
 * 항목 수 기준 KPI. 항등식 `total = ok + warn + fault + unknown` — 모르는 상태는 unknown 으로 센다
 * (초록 폴백 금지). 서버가 `kpi` 를 주지만 화면은 **항목 배열에서 다시 세어** 두 값이 어긋나면 알 수 있다.
 */
export function kpiOf(items) {
  const k = { total: 0, ok: 0, warn: 0, fault: 0, unknown: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    k.total += 1;
    k[itemState(it)] += 1;
  }
  return k;
}

/** 서버 KPI 와 화면 재계산이 다르면 그 사실을 말한다(둘 중 하나를 조용히 고르지 않는다). */
export function kpiMismatchNote(serverKpi, items) {
  if (!serverKpi || typeof serverKpi !== 'object') return null;
  const mine = kpiOf(items);
  const keys = ['total', 'ok', 'warn', 'fault', 'unknown'];
  const diff = keys.filter((x) => n(serverKpi[x]) !== mine[x]);
  if (!diff.length) return null;
  return `서버 KPI 와 항목 표의 집계가 다릅니다(${diff.join('·')}) — 화면은 항목 표에서 다시 센 값을 씁니다. 서버 버전을 확인하세요.`;
}

/* ── 카탈로그 배너 ───────────────────────────────────────────────────────────── */

/**
 * 카탈로그를 못 읽었으면 **초록 금지** — 카탈로그 의존 항목이 확인 불가다. 개수는 실제 항목 배열에서
 * 센다(서버가 그 항목들을 unknown 으로 내려 준다). 항목 배열이 없으면 의존 코드 수를 쓴다.
 */
export function catalogNote(catalog, items) {
  if (!catalog || typeof catalog !== 'object') return null;
  if (t(catalog.source) === 'dist') {
    const c = n(catalog.count);
    return { tone: 'gray', text: `특수 기능 카탈로그 ${c == null ? '' : `${c}개 · `}빌드 시각 ${catalog.generatedAt ? t(catalog.generatedAt) : '미상'}` };
  }
  const list = Array.isArray(items) ? items : null;
  const cnt = list
    ? list.filter((it) => CATALOG_DEPENDENT_CODES.includes(t(it?.code)) && itemState(it) === ARCH_STATE.UNKNOWN).length
    : CATALOG_DEPENDENT_CODES.length;
  return {
    tone: 'amber',
    text: `**카탈로그(special-tools.json)를 읽지 못해 ${cnt}개 항목은 확인 불가입니다** — 정상이라는 뜻이 아닙니다. 웹을 다시 빌드하면(prebuild 가 만듭니다) 판정할 수 있습니다.`,
  };
}

/* ── 배너 ─────────────────────────────────────────────────────────────────── */

/**
 * 상단 배너 — 나쁜 것이 이긴다: 결함 → 경고 → 확인 불가 → 정상. **확인 불가가 하나라도 있으면 초록이
 * 아니다**(못 읽은 것을 정상으로 칠하지 않는다). 아직 응답이 없으면 회색.
 */
export function bannerText(data) {
  if (!data || !Array.isArray(data.items)) {
    return { tone: 'gray', text: '아직 점검 결과가 없습니다 — ‘지금 점검’ 을 누르세요. 이 점검은 장비·엣지에 나가지 않고 이 서버 안의 라우트·카탈로그·파일만 봅니다.' };
  }
  const k = kpiOf(data.items);
  const errs = Array.isArray(data.inputs?.errors) ? data.inputs.errors.length : 0;
  const tail = errs > 0 ? ` 입력을 읽지 못한 것 ${errs}건이 있습니다(아래 표의 확인 불가 행).` : '';
  if (k.fault > 0) {
    return { tone: 'red', text: `**결함 ${k.fault}개 항목** — 게이트·래퍼·매핑이 빠진 것입니다. 배포 전에 고치세요.${k.unknown > 0 ? ` 확인 불가 ${k.unknown}개는 별도입니다.` : ''}${tail}` };
  }
  if (k.warn > 0) {
    return { tone: 'amber', text: `**경고 ${k.warn}개 항목** — 결함은 없지만 정합이 어긋난 것이 있습니다.${k.unknown > 0 ? ` 확인 불가 ${k.unknown}개는 정상이라는 뜻이 아닙니다.` : ''}${tail}` };
  }
  if (k.unknown > 0) {
    return { tone: 'amber', text: `결함·경고는 없지만 **${k.unknown}개 항목은 확인하지 못했습니다** — 입력을 읽지 못한 것이고 정상이라는 뜻이 아닙니다.${tail}` };
  }
  if (k.total === 0) {
    return { tone: 'gray', text: '점검 항목이 0개입니다 — 서버가 항목을 내려 주지 않았습니다(구버전 서버이거나 응답 형식이 다릅니다).' };
  }
  return { tone: 'green', text: `${k.total}개 항목 모두 정상입니다 — 라우트 게이트·도구 매핑·카탈로그·엣지 로그 표·BIG_JSON·DB·설정 파일·import 그래프가 서로 맞습니다.` };
}

/* ── 표 셀 ───────────────────────────────────────────────────────────────── */

/** 개수 칸 — 정상은 0 이 정답이고, 확인 불가는 개수 자체를 모른다(‘—’). */
export function countText(item) {
  const s = itemState(item);
  if (s === ARCH_STATE.UNKNOWN) return '—';
  const c = n(item?.count);
  return c == null ? '—' : String(c);
}

/**
 * 표본 — 화면은 `max` 개만 펼치고 나머지는 '외 N' 으로 **개수를 말한다**. 서버가 상한으로 뺀 것
 * (`omitted`)은 펼쳐도 볼 수 없으므로 따로 말한다(조용한 상한 금지).
 * @returns {{shown:string[], hidden:number, omitted:number, moreText:string|null}}
 */
export function samplesView(item, { max = 3, expanded = false } = {}) {
  const all = (Array.isArray(item?.samples) ? item.samples : []).map((s) => t(s)).filter(Boolean);
  const omitted = n(item?.omitted) ?? 0;
  const shown = expanded ? all : all.slice(0, max);
  const hidden = all.length - shown.length;
  const more = hidden + (omitted > 0 ? omitted : 0);
  let moreText = null;
  if (more > 0) {
    moreText = `외 ${more}`;
    if (omitted > 0 && hidden === 0) moreText = `외 ${omitted}(서버 상한으로 응답에 없음)`;
    else if (omitted > 0) moreText = `외 ${more}(그중 ${omitted}은 서버 상한으로 응답에 없음)`;
  }
  return { shown, hidden, omitted, moreText };
}

/** 표본 칸이 비었을 때의 문구 — 상태에 따라 뜻이 다르다. */
export function emptySamplesText(item) {
  const s = itemState(item);
  if (s === ARCH_STATE.OK) return '해당 없음';
  if (s === ARCH_STATE.UNKNOWN) return '판정하지 못함';
  return '표본 없음(개수만 보고됨)';
}

/**
 * 항목 코드 → 그 항목이 기대는 **입력 키**(서버 `gatherArchInputs` 의 `safe(errors, '<key>')`·`errors.push({code})`).
 * 서버의 `inputs.errors[].code` 는 항목 코드가 아니라 입력 이름이라(‘routes’·‘catalog’·‘db-files’ …) 이 표로 잇는다.
 * 표에 없는 키의 오류는 어느 행에도 붙지 않지만 '읽지 못한 입력' 표에는 전부 보인다(조용히 버리지 않는다).
 */
export const INPUT_KEYS_OF = Object.freeze({
  'route-gate-missing': ['routes', 'routers', 'app'],
  'asyncroute-unwrapped': ['routes', 'routers'],
  'tool-segment-unmapped': ['routes', 'routers', 'tool-keys'],
  'catalog-missing': ['catalog'],
  'catalog-key-orphan': ['catalog', 'tool-keys'],
  'catalog-adminonly-mismatch': ['catalog', 'routes', 'routers'],
  'edgelog-spec-drift': ['edgelog'],
  'bigjson-missing': ['app', 'routes', 'routers'],
  'dataflow-cats-unmapped': ['dataflow'],
  'db-file-mode': ['db-files', 'db-mode'],
  'db-not-migratable': ['db-files'],
  'db-no-purpose': ['db-files'],
  'config-file-unclassified': ['config-files'],
  'import-cycle': ['import-graph'],
  'util-imports-domain': ['import-graph'],
});

/** 입력 오류 중 이 항목에 해당하는 사유 — 항목 코드와 같거나 `INPUT_KEYS_OF` 의 입력 키인 것을 전부 잇는다. */
export function inputErrorFor(data, code) {
  const errs = Array.isArray(data?.inputs?.errors) ? data.inputs.errors : [];
  const c = t(code);
  const keys = new Set([c, ...(INPUT_KEYS_OF[c] || [])]);
  const msgs = errs.filter((e) => keys.has(t(e?.code))).map((e) => t(e?.message)).filter(Boolean);
  return [...new Set(msgs)].join(' · ');
}

/** 조치 칸 — 정상이면 짧게, 확인 불가면 '왜 못 읽었나' 를, 그 밖은 고정 조치문. */
export function fixText(item, data) {
  const s = itemState(item);
  const c = t(item?.code);
  const txt = ARCH_TEXT[c];
  if (s === ARCH_STATE.OK) return '조치 없음';
  if (s === ARCH_STATE.UNKNOWN) {
    const why = inputErrorFor(data, c);
    return why
      ? `**입력을 읽지 못해 판정하지 않았습니다** — ${why}`
      : '**입력을 읽지 못해 판정하지 않았습니다** — 정상이라는 뜻이 아닙니다. 서버 로그에서 사유를 확인하세요.';
  }
  return txt?.fix || `서버가 보낸 코드 ‘${c}’ 의 조치문이 이 화면에 없습니다 — 웹을 서버와 같은 버전으로 올리세요.`;
}

/** 항목 뜻(툴팁·상세). 모르는 코드는 지어내지 않는다. */
export function meaningText(item) {
  const c = t(item?.code);
  return ARCH_TEXT[c]?.meaning || `서버가 보낸 코드 ‘${c}’ 의 설명이 이 화면에 없습니다.`;
}

/** 나쁜 것이 위 — 같은 상태면 코드 순. */
export function sortItems(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const d = STATE_RANK[itemState(a)] - STATE_RANK[itemState(b)];
    return d !== 0 ? d : t(a?.code).localeCompare(t(b?.code));
  });
}

/* ── 점검 메타 ───────────────────────────────────────────────────────────── */

/** '점검 시각 · 소요 · 서버 버전' 한 줄 — 값이 없으면 단위를 붙이지 않는다(v2.575 unitText 규약). */
export function metaLine(data, agoFn) {
  if (!data) return '';
  const parts = [];
  const at = n(data.at);
  if (at != null && at > 0) parts.push(`점검 ${typeof agoFn === 'function' ? agoFn(at) : ''}`.trim());
  const took = n(data.tookMs);
  if (took != null) parts.push(`소요 ${took}ms`);
  if (t(data.version)) parts.push(`서버 v${t(data.version)}`);
  return parts.join(' · ');
}

/** '지금 점검' 응답 요약. */
export function runSummary(r) {
  if (!r || !Array.isArray(r.items)) return '점검 응답을 읽지 못했습니다.';
  const k = kpiOf(r.items);
  return `점검 완료 — 정상 ${k.ok} · 경고 ${k.warn} · 결함 ${k.fault} · 확인 불가 ${k.unknown}(합계 ${k.total}).`;
}
