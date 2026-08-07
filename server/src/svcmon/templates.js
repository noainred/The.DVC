/**
 * 성능점검 '점검 템플릿' — 서비스 유형별 점검 묶음을 저장하고 대상에 적용한다.
 * 저장 파일: `CONFIG_DIR/svcmon-templates.json` → `{ version:1, templates:[...] }`
 *
 * 왜 별도 파일인가: `store.js load()` 는 svcmon.json 에서 `targets/folders/sort` **3개 키만**
 * 읽어 db 를 재구성한다. 따라서 svcmon.json 에 templates 키를 얹으면 다음 save() 가 그 키를
 * 조용히 지운다. 파일을 분리하면 그 사고가 원천적으로 불가능하다.
 *
 * 필드 정의는 절대 여기에 다시 적지 않는다 — 점검 필드는 `testSchema.js`(TEST_FIELDS/
 * TEST_TYPES/SUBST_KEYS), 유형별 기본 포트는 `checker.js`(DEFAULT_PORTS), 수량 상한은
 * `store.js LIMITS` 에서 가져온다. 목록을 복사해 두면 필드를 추가한 날 한쪽만 갱신된다.
 *
 * 치환 변수는 `{host} {name} {path} {kind}` 4개뿐이다(중괄호 1겹·대소문자 구분). target 스키마에
 * 없는 값({ip} 등)을 만들면 항상 미치환으로 남는다. 미치환 방어는 **3단**이며 하나라도 빠지면
 * 조용히 망가진다:
 *   1) 템플릿 저장 시 허용 목록 밖의 `{...}` 토큰을 거부한다.
 *   2) 적용 시 치환 후에도 '{' 또는 '}' 가 남아 있으면 그 행을 오류로 만들고 생성하지 않는다.
 *      — 근거: `ssrfBlockReason('http://{host}:8080/health')` 는 **null(통과)** 이다(실측).
 *        즉 미치환 URL 은 저장까지 성공하고 런타임에 ENOTFOUND 로 조용히 실패한다.
 *        손으로 편집된 파일·구버전 데이터를 잡아내는 마지막 그물이므로 로드는 관용적으로 두고
 *        여기서 막는다.
 *   3) 치환 **결과**를 store 의 검증(SSRF·유형별 필수값)에 통과시킨다. store.js 는 cleanTest 를
 *      export 하지 않으므로 **최종 저장은 반드시 store.addTest/updateTest** 로 하고, 사전 판정은
 *      testSchema + `store.validateEndpoint` 로 동등하게 재현한다(`refineTest`).
 *
 * 멱등성: 매칭 키는 `(test.tpl === 템플릿id && test.tplKey === item.key)` 다. 재적용은 기존
 * **test.id 를 승계**한다(updateTest) — poller 의 results/nextDue/streak 이 test.id 키라서 id 를
 * 재발급하면 연속 실패 횟수와 만기 시각이 리셋되고, 재적용 한 번이 수천 항목의 만기를 동시에
 * 터뜨린다. 같은 이유로 `store.bulkAddTargets`(새 id 발급 경로) 는 쓰지 않는다.
 *
 * 멱등성을 지키는 부수 규칙(하나라도 빠지면 '오류 0건인 무한 중복 생성' 이 된다):
 *   - 식별자(템플릿 id·항목 key)는 **로드 시 정규화하고, 정규화했으면 그 자리에서 저장**한다
 *     (`hydrate` + `loadDb`). 랜덤 발급을 저장하지 않으면 프로세스마다 값이 바뀌어 재기동마다
 *     같은 점검이 새로 생긴다(실측: 재적용 3회에 점검 1→2→3개).
 *   - 식별자 상한은 store 의 태그 상한(`TAG_MAX` = store.js cleanTest 의 `text(...,40)`)과 같다.
 *     40자를 넘는 id/key 는 저장값(잘린 40자)과 매칭 키가 어긋나 매 적용이 중복 생성이 된다.
 *
 * 범위(scope)는 **관용적으로 넓히지 않는다** — 목록 밖 kind·배열 아닌 targetIds 는 예외다.
 * '필터 해석 실패 → 조건 없음 → 전체 대상' 경로를 남기면 오타 하나로 전 사이트(최대 2만 대상)에
 * 템플릿이 적용되고, overwrite=true 와 겹치면 사용자 조정 임계값이 한 번에 덮어써진다.
 *
 * 치환 값(대상 이름·경로)은 `send`(원시 소켓 write)·`soapAction`(HTTP 헤더) 같은 **프로토콜 경계**
 * 필드로 흘러가므로 제어문자를 거부한다(`assertNoControl`). store.cleanTarget 의 대상 이름은
 * 길이만 검사하므로 CRLF 가 들어올 수 있다(실측).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { TEST_TYPES, KINDS, TEST_FIELDS, SUBST_KEYS } from './testSchema.js';
import { DEFAULT_PORTS } from './checker.js';
import {
  LIMITS, listTargets, totalTests, addTest, updateTest, flushStore, validateEndpoint,
} from './store.js';

const FILE = () => path.join(config.configDir, 'svcmon-templates.json');

export const MAX_TEMPLATES = 100;
export const MAX_ITEMS = 50;
/**
 * ping 은 CLI(ping 프로세스)라 워커당 약 16건/초가 상한이다(다른 유형은 소켓이라 훨씬 높다).
 * 한 템플릿의 항목은 모두 **같은 호스트**를 찍으므로 ping 이 2개면 중복 부하일 뿐이다.
 */
export const MAX_PING_ITEMS = 1;
/** 치환 변수 — target 에 실제로 있는 필드만. UI 도움말에서 재사용한다. */
export const SUBST_VARS = ['host', 'name', 'path', 'kind'];
/** 오류 행 상한 — 1만 행 적용에서 전 행 오류를 담으면 응답이 수 MB 가 된다(개수는 정확히 센다). */
const MAX_ERROR_ROWS = 500;
/** 오류 표본 크기(화면 표는 전 행을 DOM 에 렌더한다). */
const SAMPLE_ROWS = 25;
/**
 * 템플릿 id·항목 key 의 상한 = **store 의 태그 상한**(store.js cleanTest 의 `text(data.tpl,40)`).
 * store 가 40자로 잘라 저장하므로, 이보다 긴 식별자를 그대로 쓰면 저장값과 매칭 키가 어긋나
 * 재적용이 매번 중복 생성이 된다(실측: 49자 id 로 3회 적용 → 점검 3개, templateUsage 는 0 보고).
 * store 가 이 값을 export 하지 않으므로 여기에 두되, store 쪽 상한을 바꾸면 함께 본다.
 */
const TAG_MAX = 40;
/** 식별자 허용 형식 — store 가 태그로 그대로 저장할 수 있는 문자만(선행 문자는 영숫자). */
const SAFE_TAG_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${TAG_MAX - 1}}$`);

/* ── 파싱 헬퍼 ─────────────────────────────────────────────────────────────────
 * store.js 의 동일 헬퍼와 **의도적으로 같은 동작**이다(cleanTest 가 export 되지 않아 재현이
 * 필요하다). 값 규칙이 어긋나면 적용 전 판정(diff)과 실제 저장값이 달라져 '변경 없음'이
 * 매번 update 로 잡히므로, store.js 의 이 부분을 손볼 때 여기도 함께 본다.
 * ─────────────────────────────────────────────────────────────────────────── */
const text = (v, limit, dflt = '') => {
  if (typeof v !== 'string') return dflt;
  const t = v.trim().slice(0, limit);
  return t || dflt;
};
const num = (v, low, high, dflt) => {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'string' && v.trim() === '') return dflt;   // Number('')===0 가드
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : dflt;
};
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on', 't', '예', 'o']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off', 'f', '아니오', 'x']);
const bool = (v, dflt) => {
  if (v === null || v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : dflt;
  const s = String(v).trim().toLowerCase();
  if (!s) return dflt;
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return dflt;                                                 // !!'false' === true 방지
};
const portOf = (v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : undefined;
};
const compact = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};
/** 키 순서에 무관한 비교용 직렬화(저장 후 재로드로 키 순서가 바뀌어도 같게 본다). */
const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));

const newTemplateId = () => `tpl-${crypto.randomBytes(4).toString('hex')}`;
const newItemKey = () => `k-${crypto.randomBytes(4).toString('hex')}`;
/**
 * 빌트인 항목 키는 **결정적**으로 만든다. 랜덤이면 파일 손상 후 재시드에서 키가 바뀌어
 * 이미 적용된 점검의 tplKey 와 어긋나고, 다음 적용이 전부 중복 생성이 된다.
 */
const builtinItemKey = (tplId, i, name) => `k-${crypto.createHash('sha1')
  .update(`${tplId}\u0000${i}\u0000${name}`).digest('hex').slice(0, 8)}`;

/* ── 제어문자 방어 ─────────────────────────────────────────────────────────────
 * 치환 값(대상 이름·경로)은 `send`(checker.js 가 `sock.write(`${send}\r\n`)` 로 원시 소켓에
 * 그대로 내보낸다)·`soapAction`(HTTP 헤더)·`payload`(UDP) 같은 **프로토콜 경계** 필드로 흘러간다.
 * 대상 이름에 CRLF 를 넣으면 폴링 주기마다 SMTP MAIL FROM/RCPT TO 가 추가로 전송된다(실측:
 * store.addTarget 은 이름에 문자 화이트리스트가 없어 CRLF 를 받는다 — store.js:254 는 길이만 검사).
 * `body`(SOAP XML)만 탭·줄바꿈을 허용한다 — HTTP 본문은 Content-Length 로 프레이밍되어 줄바꿈이
 * 명령 경계를 만들지 않고, XML 을 한 줄로 강제하면 정상 사용을 막는다.
 * ─────────────────────────────────────────────────────────────────────────── */
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const CTRL_RE_BODY = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function assertNoControl(value, fieldKey, label) {
  if (typeof value !== 'string' || !value) return;
  const re = fieldKey === 'body' ? CTRL_RE_BODY : CTRL_RE;
  if (re.test(value)) {
    throw new Error(`${label || fieldKey}: 제어문자(줄바꿈·탭 등)는 쓸 수 없습니다 — 프로토콜 명령 주입 경로입니다.`);
  }
}

/* ── 점검 필드 정제(store.cleanTest 동등 재현) ── */

/**
 * TEST_FIELDS 표대로 값을 정제한다. `endpoints=true` 면 SSRF/호스트 형식까지 검증한다
 * (템플릿 항목은 `{host}` 를 담으므로 저장 시엔 끄고, 치환 후 적용 판정에서 켠다).
 *
 * 길이 초과는 **절단하지 않고 오류**다(store.js 는 text() 로 조용히 자른다). 근거: 치환 결과가
 * 상한을 넘으면 서로 다른 대상이 같은 값을 갖는다 — 실측으로 80자 공통 접두사 + `-AAA`/`-BBB`
 * 대상 2개가 점검 이름 80자 절단으로 **완전히 같은 이름**이 되고, 499자 URL 은 치환 후 500자로
 * 잘려 `?flag=critical` 이 `?flag=critica` 가 됐다(둘 다 errorCount 0). 절단값은 예측/저장 양쪽에
 * 동일하게 남아 diff 파리티가 유지되므로 어떤 지표에도 드러나지 않는다.
 *
 * @param {object} data  입력 값
 * @param {object|null} base  기존 점검(있으면 미지정 필드를 승계 — updateTest 와 같은 규칙)
 */
function refineTest(data, base = null, { endpoints = true } = {}) {
  const b = base || {};
  const raw = data?.type ?? b.type ?? '';
  const type = String(raw).trim().toLowerCase();
  // 미지 유형을 ping 으로 폴백하면 'disk' 라고 적은 템플릿이 전 대상에 ping 을 만들고
  // 오류를 0건으로 보고한다. 목록 밖 값은 거부한다.
  if (!TEST_TYPES.includes(type)) {
    throw new Error(`알 수 없는 점검 유형: ${String(raw).slice(0, 40)} (가능: ${TEST_TYPES.join(', ')})`);
  }
  const t = { type };
  for (const f of TEST_FIELDS) {
    if (f.key === 'type') continue;
    const cur = data?.[f.key];
    const prev = b[f.key];
    if (f.kind === 'text') {
      // 절단 금지 — 넘치면 오류다(치환 결과가 서로 다른 대상에서 같은 값으로 잘리는 것을 막는다).
      if (typeof cur === 'string') {
        assertNoControl(cur, f.key, f.label);
        const len = cur.trim().length;
        if (len > f.max) throw new Error(`${f.label}은 ${f.max}자를 넘을 수 없습니다(${len}자 — 치환 결과가 길어졌는지 확인하세요).`);
      }
      const v = text(cur, f.max, prev || '') || undefined;
      t[f.key] = f.optional ? v : (v || '');
    } else if (f.kind === 'bool') {
      t[f.key] = bool(cur, prev === undefined ? f.dflt : prev);
    } else if (f.kind === 'int') {
      const dflt = f.dfltByType ? (f.dfltByType[type] ?? f.dfltByType['*']) : f.dflt;
      const v = num(cur, f.min, f.max, prev ?? dflt);
      t[f.key] = f.optional ? (v || undefined) : v;
    } else if (f.kind === 'port') {
      // 무효값을 클램프하지 않는다(0/음수/문자를 1로 바꾸면 엉뚱한 포트를 찍는다).
      t[f.key] = portOf(cur) || prev || DEFAULT_PORTS[type] || undefined;
    }
  }
  if (!t.name) throw new Error('점검 이름을 입력하세요.');
  for (const f of TEST_FIELDS) {
    if (f.requiredFor?.includes(type) && !t[f.key]) throw new Error(`${type} 점검은 ${f.label} 값이 필요합니다.`);
  }
  if (endpoints) validateTestEndpoints(t);
  return compact(t);
}

/** url/server/record 는 실제 목적지가 된다 — 세 필드 모두 SSRF 가드를 태운다. */
function validateTestEndpoints(t) {
  if (t.url) {
    const err = validateEndpoint({ url: t.url });
    if (err) throw new Error(err);
  }
  for (const key of ['server', 'record']) {
    const v = t[key];
    if (!v) continue;
    const err = validateEndpoint({ host: v });     // 형식(SAFE_HOST) + SSRF 를 함께 본다
    if (err) throw new Error(`${key}: ${err}`);
  }
}

/* ── 치환 ── */

const TOKEN_RE = /\{([A-Za-z]+)\}/g;
const SUBST_RE = /\{(host|name|path|kind)\}/g;

/** 방어 1 — 허용 목록 밖의 토큰·짝이 맞지 않는 중괄호를 저장 단계에서 거부한다. */
function assertTokens(value, fieldKey) {
  if (typeof value !== 'string' || !value) return;
  const rest = value.replace(TOKEN_RE, (m, name) => {
    if (!SUBST_VARS.includes(name)) {
      throw new Error(`${fieldKey}: 알 수 없는 치환 변수 {${name}} (가능: ${SUBST_VARS.map((v) => `{${v}}`).join(' ')} — 대소문자 구분)`);
    }
    return '';
  });
  if (/[{}]/.test(rest)) {
    throw new Error(`${fieldKey}: 짝이 맞지 않는 중괄호가 있습니다(치환 변수는 ${SUBST_VARS.map((v) => `{${v}}`).join(' ')}).`);
  }
}

/** 대상 → 치환 값. {path} 는 '\\' 를 '/' 로 바꿔 넣는다(URL·이름에 그대로 쓰이므로). */
function substVars(target) {
  return {
    host: String(target.host || ''),
    name: String(target.name || ''),
    path: String(target.path || '').replace(/\\/g, '/'),
    kind: String(target.kind || ''),
  };
}

/**
 * 항목 → 치환된 점검 입력. 방어 2 를 여기서 수행한다(치환 후 남은 중괄호 = 오류).
 * @throws 미치환 변수가 남으면 그 필드명을 담아 throw
 */
function substituteItem(item, vars) {
  const out = { ...item };
  delete out.key;
  for (const key of SUBST_KEYS) {
    const v = out[key];
    if (typeof v !== 'string' || !v) continue;
    const filled = v.replace(SUBST_RE, (m, name) => vars[name]);
    if (/[{}]/.test(filled)) {
      throw new Error(`${key}: 치환되지 않은 변수가 남았습니다(${filled.slice(0, 60)}) — 템플릿에서 ${SUBST_VARS.map((x) => `{${x}}`).join(' ')} 만 쓸 수 있습니다.`);
    }
    out[key] = filled;
  }
  return out;
}

/* ── 항목/템플릿 정제 ── */

/** 템플릿 항목 1개 — 필드 정제 + 치환 토큰 검사. 목적지 검증은 치환 후로 미룬다. */
function cleanItem(raw) {
  const t = refineTest(raw, null, { endpoints: false });
  for (const key of SUBST_KEYS) assertTokens(t[key], key);
  // 치환 변수가 없는 **리터럴** 목적지는 지금 검증한다 — 적용 시점에 전 대상이 같은 오류를
  // 내는 것보다 저장할 때 한 번 거절하는 편이 낫다.
  const literal = {};
  for (const key of ['url', 'server', 'record']) {
    if (t[key] && !/[{}]/.test(t[key])) literal[key] = t[key];
  }
  if (Object.keys(literal).length) validateTestEndpoints(literal);
  // 키는 **store 가 태그로 저장할 수 있는 형식이면 그대로 보존**한다(KEY_RE 만 인정하면, 손으로
  // 넣은 key='linux-ping' 짜리 템플릿을 UI 가 되돌려 저장하는 순간 key 가 재발급되어 같은 점검이
  // 하나 더 생긴다 — 이미 적용된 점검의 tplKey 는 옛 값이므로 매칭이 끊긴다).
  const given = String(raw?.key ?? '').trim();
  const key = SAFE_TAG_RE.test(given) ? given : newItemKey();
  return { key, ...t };
}

function cleanItems(list) {
  const arr = Array.isArray(list) ? list : [];
  // 절단하지 않는다 — 51번째를 조용히 버리면 사용자는 저장됐다고 믿는다.
  if (arr.length > MAX_ITEMS) throw new Error(`템플릿 항목은 최대 ${MAX_ITEMS}개까지입니다(요청 ${arr.length}개).`);
  const out = [];
  const keys = new Set();
  let pings = 0;
  arr.forEach((raw, i) => {
    let item;
    try { item = cleanItem(raw); } catch (e) { throw new Error(`${i + 1}번 항목: ${e.message}`); }
    if (item.type === 'ping') {
      pings += 1;
      if (pings > MAX_PING_ITEMS) {
        throw new Error(`${i + 1}번 항목: ping 은 템플릿당 최대 ${MAX_PING_ITEMS}개입니다(ping 은 CLI 프로세스라 처리량 상한이 낮고, 같은 호스트에 두 번 찍는 것은 중복입니다).`);
      }
    }
    // 키 중복은 매칭(tplKey)을 어긋나게 하므로 새로 발급한다.
    if (keys.has(item.key)) item.key = newItemKey();
    keys.add(item.key);
    out.push(item);
  });
  return out;
}

const normKind = (v, dflt) => {
  if (v === undefined) return dflt;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (!KINDS.includes(s)) throw new Error(`알 수 없는 구분: ${s} (가능: ${KINDS.join(', ')}, 빈 값=제한 없음)`);
  return s;
};

/**
 * 템플릿 1개를 만든다. `rev` 는 **items 가 실제로 바뀔 때만** +1 (UI 표시·감사용이며
 * test 에는 저장하지 않는다 — 저장하면 rev 가 오를 때마다 전 점검이 '변경'으로 잡힌다).
 */
function buildTemplate(data, base, user) {
  const b = base || {};
  // 이름·설명도 절단하지 않는다(항목 필드와 같은 규칙) — 조용히 잘리면 목록에서 서로 구분되지
  // 않는 템플릿이 생기고, 사용자는 저장된 값이 자기가 입력한 값이라고 믿는다.
  if (typeof data?.name === 'string' && data.name.trim().length > 60) throw new Error('템플릿 이름은 60자를 넘을 수 없습니다.');
  if (typeof data?.desc === 'string' && data.desc.trim().length > 300) throw new Error('템플릿 설명은 300자를 넘을 수 없습니다.');
  const name = text(data?.name, 60, b.name || '');
  if (!name) throw new Error('템플릿 이름을 입력하세요.');
  const items = (data?.items === undefined && base) ? (b.items || []) : cleanItems(data?.items);
  const changed = !base || canonItems(items) !== canonItems(b.items || []);
  return {
    id: b.id || newTemplateId(),
    name,
    desc: text(data?.desc, 300, b.desc || ''),
    kind: normKind(data?.kind, b.kind ?? ''),
    // 빌트인 플래그는 사용자 입력으로 세우지 않는다(시드만 true).
    builtin: !!b.builtin,
    rev: ((b.rev || 0) + (changed ? 1 : 0)) || 1,
    updatedAt: Date.now(),
    updatedBy: text(user, 80, b.updatedBy || ''),
    items,
  };
}

const canonItems = (items) => JSON.stringify((items || []).map((x) => canon(x)));
const copyTemplate = (t) => ({ ...t, items: (t.items || []).map((x) => ({ ...x })) });

/* ── 빌트인 6종 ──────────────────────────────────────────────────────────────
 * **IANA 표준 포트로 결정되는 것만** 넣는다. 앱 포트 8080·헬스 경로 /health·DB 리스너 1521 은
 * 조직마다 다르므로 근거가 없다(추측을 기본값으로 배포하면 전 대상이 빨간색이 된다).
 * 주기는 120초 이상(실측 4워커 249건/s 기준), insecure 는 전부 false, ping 은 템플릿당 1개.
 * 993/995 는 배너가 암호화되어 있어 배너 점검이 불가하므로 TCP·cert 로 본다.
 * ─────────────────────────────────────────────────────────────────────────── */
const BUILTIN_DEFS = [
  {
    id: 'tpl-linux-basic',
    name: 'Linux 서버 기본',
    kind: 'infra',
    desc: 'ICMP · SSH(22) 배너 · NTP(123) 오프셋. 표준 포트만 사용합니다.',
    items: [
      { name: 'PING', type: 'ping', intervalSec: 120 },
      { name: 'SSH(22) 배너', type: 'ssh', port: 22, intervalSec: 300 },
      { name: 'NTP(123) 오프셋', type: 'ntp', port: 123, warnMs: 1000, badMs: 5000, intervalSec: 600 },
    ],
  },
  {
    id: 'tpl-windows-basic',
    name: 'Windows 서버 기본',
    kind: 'infra',
    desc: 'ICMP · RDP(3389) · SMB(445) · NTP(123). 표준 포트만 사용합니다.',
    items: [
      { name: 'PING', type: 'ping', intervalSec: 120 },
      { name: 'RDP(3389)', type: 'tcp', port: 3389, intervalSec: 300 },
      { name: 'SMB(445)', type: 'tcp', port: 445, intervalSec: 300 },
      { name: 'NTP(123) 오프셋', type: 'ntp', port: 123, intervalSec: 600 },
    ],
  },
  {
    id: 'tpl-web-tls',
    name: '웹 서비스(HTTPS)',
    kind: 'service',
    desc: '443 포트 · 인증서 만료(D-30) · HTTPS 루트 응답. 경로·앱 포트는 조직마다 달라 넣지 않았습니다.',
    items: [
      { name: 'HTTPS 포트(443)', type: 'tcp', port: 443, intervalSec: 120 },
      { name: '인증서 만료(443)', type: 'cert', port: 443, warnDays: 30, intervalSec: 86400 },
      { name: 'HTTPS 응답', type: 'http', url: 'https://{host}/', intervalSec: 120 },
    ],
  },
  {
    id: 'tpl-dns-server',
    name: 'DNS 서버',
    kind: 'infra',
    desc: '자기 이름 질의 · 53/TCP · ICMP.',
    items: [
      { name: 'DNS 질의', type: 'dns', record: '{host}', server: '{host}', intervalSec: 300 },
      { name: 'DNS 포트(53/TCP)', type: 'tcp', port: 53, intervalSec: 300 },
      { name: 'PING', type: 'ping', intervalSec: 120 },
    ],
  },
  {
    id: 'tpl-mail',
    name: '메일 서비스',
    kind: 'service',
    desc: 'SMTP(25) 배너 · Submission(587) · IMAP(143) · POP3(110) · IMAPS(993) 인증서.',
    items: [
      { name: 'SMTP(25) 배너', type: 'smtp', port: 25, send: 'EHLO test', intervalSec: 300 },
      { name: 'SMTP Submission(587)', type: 'tcp', port: 587, intervalSec: 300 },
      { name: 'IMAP(143) 배너', type: 'imap', port: 143, intervalSec: 300 },
      { name: 'POP3(110) 배너', type: 'pop3', port: 110, intervalSec: 300 },
      { name: 'IMAPS 인증서(993)', type: 'cert', port: 993, warnDays: 30, intervalSec: 86400 },
    ],
  },
  {
    id: 'tpl-directory',
    name: '디렉터리 서비스(LDAP/AD)',
    kind: 'infra',
    desc: 'LDAP(389) bind · LDAPS(636) · Kerberos(88) · ICMP.',
    items: [
      { name: 'LDAP(389) bind', type: 'ldap', port: 389, intervalSec: 300 },
      { name: 'LDAPS 포트(636)', type: 'tcp', port: 636, intervalSec: 300 },
      { name: 'Kerberos(88)', type: 'tcp', port: 88, intervalSec: 300 },
      { name: 'PING', type: 'ping', intervalSec: 120 },
    ],
  },
];

export const BUILTIN_IDS = BUILTIN_DEFS.map((d) => d.id);

function builtinTemplates() {
  const out = [];
  for (const def of BUILTIN_DEFS) {
    try {
      const items = cleanItems(def.items.map((it, i) => ({ ...it, key: builtinItemKey(def.id, i, it.name) })));
      out.push({
        id: def.id,
        name: def.name,
        desc: def.desc,
        kind: def.kind,
        builtin: true,
        rev: 1,
        updatedAt: Date.now(),
        updatedBy: '',
        items,
      });
    } catch (e) {
      // 정의가 잘못되면 코드 버그다(테스트가 6종 시드를 검증한다). 여기서 던지면 템플릿
      // 화면 전체가 500 이 되므로 그 템플릿만 건너뛰고 남긴다.
      console.error(`[svcmon/templates] 빌트인 ${def.id} 시드 실패: ${e?.message}`);
    }
  }
  return out;
}

/* ── 저장소 ── */

let cache = null;   // { version:1, templates:[...] }

/**
 * 로드는 **값에 관용적**이다(필드 값을 정제·검증하지 않는다). 손으로 편집된 값이나 구버전
 * 데이터를 여기서 버리면 사용자는 그 항목이 사라진 이유를 알 수 없다 — 적용 단계에서 행 오류로
 * 보여 준다. 다만 **식별자(id/key)는 예외로 정규화**한다: 매칭 키가 어긋나면 오류 0건으로 점검이
 * 무한 중복 생성되므로 관용이 곧 파손이다(hydrate 주석 참고).
 *
 * '쓸 수 없는 파일' 은 **전부 preserveCorrupt 경로**로 보낸다 — 파싱 실패(잘린 JSON)뿐 아니라
 * 파싱은 됐지만 `templates` 배열이 없는 경우(키 오타 `template`, 루트가 배열, `templates:null`,
 * `templates:{...}`, 본문 `null`)도 포함한다. 이 분기는 곧바로 시드 + persist() 를 하므로,
 * 보존하지 않으면 **템플릿 목록 화면을 한 번 여는 것만으로** 사용자 템플릿이 백업 없이 사라진다
 * (실측: 5가지 입력 모두 백업 0개·원본 소실). CLAUDE.md '로드 손상 보존' 불변조건.
 * 전체 시드 + persist 는 ENOENT(진짜 최초 설치) 또는 손상 보존 직후에만 일어난다.
 */
function loadDb() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = fs.readFileSync(FILE(), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') preserveCorrupt(FILE(), e?.message);   // 디렉터리·권한 등
  }
  let parsed = null;
  if (raw !== null) {
    try { parsed = JSON.parse(raw); } catch (e) { preserveCorrupt(FILE(), e?.message); }
  }
  const rows = Array.isArray(parsed?.templates) ? parsed.templates.filter(Boolean) : null;
  if (!rows) {
    // 파일이 있었는데 쓸 수 없는 모양이면 손상과 같이 보존한다(파싱 실패 경로는 이미 옮겨져 no-op).
    if (raw !== null) preserveCorrupt(FILE(), 'templates 배열이 없음');
    cache = { version: 1, templates: builtinTemplates() };
    persist();
    return cache;
  }
  const fixed = { n: 0 };            // 식별자를 하나라도 새로 정한 경우 → 파일에 고정해야 한다
  const ids = new Set();
  cache = { version: 1, templates: rows.map((t, i) => hydrate(t, i, ids, fixed)) };
  // 이후 기동에서는 **없는 id 만 append** 한다(기존 항목을 덮어쓰지 않는다 — 사용자 수정 보존).
  const add = builtinTemplates().filter((t) => !ids.has(t.id));
  const room = MAX_TEMPLATES - cache.templates.length;
  if (add.length && room > 0) {
    cache.templates.push(...add.slice(0, room));
    fixed.n += 1;
  }
  // 정규화 결과를 **즉시 저장**한다 — 저장하지 않으면 다음 기동에서 또 계산해야 하고, 랜덤
  // 발급이었다면 프로세스마다 값이 달라져 재적용이 매번 중복 생성한다(실측: 재기동 3회 → 점검 3개).
  if (fixed.n) persist();
  return cache;
}

/**
 * 형태와 **식별자만** 맞춘다(필드 값 검증은 하지 않는다 — loadDb 주석 참고).
 *
 * 식별자 규칙(어기면 오류 0건인 무한 중복 생성이 된다):
 *   - `TAG_MAX`(40) 초과는 **앞 40자로 자른다** — store 가 태그를 그대로 40자로 잘라 저장하므로,
 *     같은 값으로 맞추면 이미 적용된 점검과 계속 매칭된다(해시로 새로 발급하면 그 점검이 고아가 된다).
 *   - 형식 밖(빈 값·공백·허용 문자 밖)이면 **결정적 해시**로 발급한다. 랜덤(`newItemKey`)은
 *     프로세스마다 달라져 재기동마다 같은 점검을 새로 만든다(실측).
 *   - 템플릿 안에서 중복된 key, 파일 안에서 중복된 id 도 여기서 갈라 준다(중복 key 는 overwrite
 *     적용에서 A→B 덮어쓰기 + 매 적용 플립플롭이 된다).
 * @param {object} t 파일에 있던 템플릿
 * @param {number} index 파일 내 순번(결정적 해시 씨앗)
 * @param {Set<string>} seenIds 이미 쓰인 템플릿 id
 * @param {{n:number}} fixed 정규화 횟수 누적(loadDb 가 persist 여부를 판단)
 */
function hydrate(t, index = 0, seenIds = new Set(), fixed = { n: 0 }) {
  const name = String(t?.name ?? '').slice(0, 60);
  const rawId = String(t?.id ?? '').trim();
  let id = rawId;
  if (id.length > TAG_MAX) { id = id.slice(0, TAG_MAX); fixed.n += 1; }
  if (!SAFE_TAG_RE.test(id)) { id = derivedTemplateId(`${index} ${name}`); fixed.n += 1; }
  for (let salt = 1; seenIds.has(id); salt += 1) {
    id = derivedTemplateId(`${index} ${name} ${rawId} #${salt}`);
    fixed.n += 1;
  }
  seenIds.add(id);

  const items = [];
  const keys = new Set();
  for (const [i, it] of (Array.isArray(t?.items) ? t.items.filter(Boolean) : []).entries()) {
    let key = String(it?.key ?? '').trim();
    if (key.length > TAG_MAX) { key = key.slice(0, TAG_MAX); fixed.n += 1; }
    if (!SAFE_TAG_RE.test(key)) { key = builtinItemKey(id, i, String(it?.name ?? '')); fixed.n += 1; }
    for (let salt = 1; keys.has(key); salt += 1) {
      key = builtinItemKey(id, i, `${it?.name ?? ''} #${salt}`);
      fixed.n += 1;
    }
    keys.add(key);
    items.push({ ...it, key });
  }
  const rev = Number(t?.rev);
  return {
    id,
    name,
    desc: String(t?.desc ?? '').slice(0, 300),
    kind: KINDS.includes(t?.kind) ? t.kind : '',
    builtin: !!t?.builtin,
    rev: Number.isFinite(rev) ? Math.max(1, Math.round(rev)) : 1,
    updatedAt: Number(t?.updatedAt) || 0,
    updatedBy: String(t?.updatedBy ?? '').slice(0, 80),
    items,
  };
}

/** 식별자 없는 템플릿의 id — 랜덤이 아니라 **내용에서 파생**한다(프로세스 간 안정). */
const derivedTemplateId = (seed) => `tpl-${crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 8)}`;

/** @returns {boolean} 파일에 실제로 썼는지(호출부가 실패를 200 으로 감추지 않게). */
function persist() {
  if (!cache) return true;
  try {
    atomicWriteFileSync(FILE(), JSON.stringify(cache, null, 2));
    return true;
  } catch (e) {
    console.error('[svcmon/templates] 저장 실패:', e?.message);
    return false;
  }
}

/**
 * 저장 실패를 **성공 응답으로 감추지 않는다** — CRUD 4개는 이 함수로만 저장한다.
 * 실패 시 `rollback()` 으로 메모리를 마지막으로 저장된 상태로 되돌린 뒤 예외를 던진다.
 * 근거(실측): 반환값을 버리면 CONFIG_DIR 권한 사고·디스크 풀에서 addTemplate 이 예외 없이
 * 정상 템플릿 객체를 돌려주고(메모리 9 / 파일 8), 재기동하면 그 작업이 통째로 사라진다.
 * 지운 템플릿(tpl-mail)은 부활한다. 되돌리기까지 하는 이유: 메모리와 파일이 어긋난 상태로
 * 두면 이후 다른 저장이 성공했을 때 **실패했던 변경이 되살아난다**(store.js 의 dirty 재시도는
 * 디바운스 저장 구조라 가능하지만, 여기 CRUD 는 요청당 1회 즉시 저장이라 롤백이 더 안전하다).
 */
function persistOrThrow(rollback) {
  if (persist()) return;
  try { rollback(); } catch { /* 롤백 실패는 로그만 — 아래 예외로 호출부가 알게 된다 */ }
  throw new Error('템플릿 파일 저장에 실패했습니다(디스크 공간·권한·CONFIG_DIR 확인). 변경은 적용되지 않았습니다.');
}

/* ── 조회 ── */

export function listTemplates() { return loadDb().templates.map(copyTemplate); }

export function getTemplate(id) {
  const t = loadDb().templates.find((x) => x.id === id);
  return t ? copyTemplate(t) : null;
}

/** 적용 흔적 집계 — 삭제 경고·사용량 표시에 쓴다. */
export function templateUsage(id) {
  let targets = 0;
  let tests = 0;
  for (const target of listTargets()) {
    let hit = 0;
    // 손으로 편집된 파일에는 tests 키가 없을 수 있다(로드는 관용적이다).
    for (const x of (Array.isArray(target.tests) ? target.tests : [])) if (x.tpl === id) hit += 1;
    if (hit) { targets += 1; tests += hit; }
  }
  return { targets, tests };
}

/* ── CRUD ── */

export function addTemplate(data, opts = {}) {
  const dbx = loadDb();
  if (dbx.templates.length >= MAX_TEMPLATES) throw new Error(`템플릿은 최대 ${MAX_TEMPLATES}개까지입니다.`);
  const t = buildTemplate(data || {}, null, opts.user);
  dbx.templates.push(t);
  persistOrThrow(() => { dbx.templates.pop(); });
  return copyTemplate(t);
}

export function updateTemplate(id, data, opts = {}) {
  const dbx = loadDb();
  const i = dbx.templates.findIndex((x) => x.id === id);
  if (i < 0) return null;
  // 실패(검증 오류)하면 기존 템플릿을 건드리지 않는다 — 예외가 대입 전에 던져진다.
  const prev = dbx.templates[i];
  const next = buildTemplate(data || {}, prev, opts.user);
  dbx.templates[i] = next;
  persistOrThrow(() => { dbx.templates[i] = prev; });
  return copyTemplate(next);
}

/**
 * 복제 — 새 템플릿 id + **전 항목 새 key**(같은 key 면 원본이 적용한 점검을 덮어쓴다).
 * 항목은 `cleanItems` 를 **다시 통과**시킨다: 손으로 편집된 원본(항목 60개·ping 6개 등 상한 초과,
 * 미지 유형)을 그대로 복사하면 API 로 만든 **정상 템플릿(builtin=false)** 이 되어 상한 초과가
 * 정상 데이터로 굳는다(실측: duplicate 로 items 60개·ping 6개 템플릿 생성).
 */
export function duplicateTemplate(id, opts = {}) {
  const dbx = loadDb();
  const src = dbx.templates.find((x) => x.id === id);
  if (!src) return null;
  if (dbx.templates.length >= MAX_TEMPLATES) throw new Error(`템플릿은 최대 ${MAX_TEMPLATES}개까지입니다.`);
  const t = {
    id: newTemplateId(),
    name: `${src.name} (복사)`.slice(0, 60),
    desc: src.desc,
    kind: src.kind,
    builtin: false,
    rev: 1,
    updatedAt: Date.now(),
    updatedBy: text(opts.user, 80, ''),
    items: cleanItems((src.items || []).map((x) => ({ ...x, key: newItemKey() }))),
  };
  dbx.templates.push(t);
  persistOrThrow(() => { dbx.templates.pop(); });
  return copyTemplate(t);
}

/**
 * 삭제 — **적용된 점검은 남긴다**(태그 tpl/tplKey 도 유지). 점검을 함께 지우면 템플릿 정리가
 * 곧 모니터링 중단이 된다.
 *
 * 태그를 남기는 근거는 **빌트인 한정**이다: 빌트인은 id/key 가 결정적이라 삭제 → 재기동 부활 후
 * 재적용이 skip 으로 잡힌다(실측 skip=4, 중복 0). 사용자 템플릿은 재생성 때 새 `tpl-<랜덤8>` 을
 * 받으므로 태그를 남겨도 중복 생성을 막지 못한다(실측: 같은 이름·항목으로 재생성 후 적용 →
 * create=1, 점검 2개). 그래서 applyTemplate 이 '이름·유형이 같은데 태그가 다른 기존 점검' 을
 * 경고로 알린다(자동 흡수는 하지 않는다 — 남의 점검을 템플릿에 종속시키는 것이 더 위험하다).
 */
export function deleteTemplate(id) {
  const dbx = loadDb();
  const usage = templateUsage(id);
  const before = dbx.templates;
  const kept = before.filter((x) => x.id !== id);
  const removed = kept.length !== before.length;
  if (removed) {
    dbx.templates = kept;
    persistOrThrow(() => { dbx.templates = before; });
  }
  return { removed, orphanTests: usage.tests, orphanTargets: usage.targets };
}

/* ── 적용 ── */

/**
 * 적용 범위. **해석에 실패한 조건은 버리지 않고 예외로 돌린다** — '필터를 못 읽었으니 조건 없음'
 * 은 곧 전체 대상(최대 2만)에 적용이고, overwrite=true 와 겹치면 전 대상의 사용자 조정값이
 * 한 번에 덮어써진다. 실측으로 다음이 모두 전체 적용이었다: `targetIds:'g-xxx'`(스칼라),
 * `targetIds:null`, `kind:'network'`(목록 밖), `scope:null`, `path:123`.
 *
 *  - `targetIds` 가 있으면 **배열만** 인정한다(빈 배열이라도 그 경로 — 0건이 정답이다).
 *  - `kind` 는 store 의 `pickEnum` 과 같은 규칙: 대소문자만 정규화하고 목록 밖이면 예외.
 *  - `path` 는 문자열/미지정만. `includeSub` 는 `bool()` 화이트리스트(문자열 'false' 반전 방지).
 */
function scopeTargets(scope = {}) {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('적용 범위(scope)는 객체여야 합니다({targetIds:[...]} 또는 {kind,path,includeSub}).');
  }
  const all = listTargets();
  // 키가 있으면 배열만 인정한다 — null/undefined 를 '미지정' 으로 넘기면 대상 목록을 만들다 실패한
  // 호출부가 전체 적용으로 승격된다. '대상 필터 없음' 은 키를 **빼는** 것으로 표현한다.
  if (Object.hasOwn(scope, 'targetIds')) {
    if (!Array.isArray(scope.targetIds)) {
      throw new Error('scope.targetIds 는 배열이어야 합니다(대상 1개도 [id] 로 보내세요 — 스칼라·null 을 무시하면 전체 대상에 적용됩니다).');
    }
    const want = new Set(scope.targetIds.map((v) => String(v)));
    return all.filter((t) => want.has(t.id));
  }
  const kind = normKind(scope.kind, '');               // 목록 밖이면 예외(조용한 '제한 없음' 금지)
  if (scope.path !== undefined && scope.path !== null && typeof scope.path !== 'string') {
    throw new Error('scope.path 는 문자열이어야 합니다(트리 경로).');
  }
  const p = typeof scope.path === 'string' ? scope.path.trim() : '';
  const includeSub = bool(scope.includeSub, true);      // 기본 true
  return all.filter((t) => (!kind || t.kind === kind)
    && (!p || t.path === p || (includeSub && t.path.startsWith(`${p}\\`))));
}

/** 범위 조건이 하나도 없는지 — '전체 적용' 은 경고로 알린다(요청 본문 `{}` 하나면 성립한다). */
function scopeIsAll(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  if (Object.hasOwn(scope, 'targetIds')) return false;
  if (normKind(scope.kind, '')) return false;
  return !(typeof scope.path === 'string' && scope.path.trim());
}

/**
 * 저장된 점검과 '치환 → 정제' 결과가 같은지. id·tpl·tplKey 는 비교에서 제외한다.
 * 템플릿 원본과 저장값을 그대로 비교하면 정제가 채운 기본값({type:'cert'} → port 443,
 * warnDays 30) 때문에 'same' 이 구조적으로 0 이 되어 overwrite 가 매번 전량 update 가 된다.
 * @param {string[]} ignore 비교에서 뺄 키 — '템플릿에서 제거됐지만 store 가 지울 수 없는 필드'.
 *   빼지 않으면 매 적용이 update 로 잡히고(플립플롭) 실제로는 값이 바뀌지 않는다.
 */
function sameTest(predicted, stored, ignore = []) {
  const strip = (o) => {
    const c = { ...o };
    delete c.id; delete c.tpl; delete c.tplKey;
    for (const k of ignore) delete c[k];
    return canon(c);
  };
  return strip(predicted) === strip(stored);
}

const TEST_KEYS = TEST_FIELDS.map((f) => f.key);
const LABEL_BY_KEY = new Map(TEST_FIELDS.map((f) => [f.key, f.label]));
/** 인덱스 키 — 이름·유형에 구분자가 들어가도 섞이지 않게 NUL 로 잇는다. */
const joinKey = (a, b) => `${a}\u0000${b}`;

/**
 * 템플릿 적용.
 *
 * | 상태                          | overwrite=false | overwrite=true            |
 * |-------------------------------|-----------------|---------------------------|
 * | 대상에 그 tplKey 없음         | add             | add                       |
 * | 있음(값 다름)                 | skip(무수정)    | update(test.id 승계)      |
 * | 있음(값 같음)                 | skip            | skip                      |
 * | 템플릿에서 삭제된 **항목** 잔존| 유지(고아)     | 유지(고아)                |
 * | 템플릿에서 삭제된 **필드**    | 유지            | 유지 + 경고(아래)         |
 * | 태그 없는 수동 점검(이름 동일)| 흡수하지 않음   | 흡수하지 않음(경고)       |
 *
 * overwrite=true 는 값 계산의 base 를 **두지 않는다**(템플릿이 진실의 원천). 다만 템플릿에서
 * *제거된* 선택 필드(keyword/expectStatus/warnMs …)는 이미 적용된 점검에서 **지워지지 않는다** —
 * 최종 저장이 store.updateTest 이고 `store.cleanTest` 가 미지정 필드를 기존값으로 승계하기 때문이다
 * (빈 문자열·null 을 넘겨도 승계된다 — 실측). 이 경우 그 필드를 diff 에서 빼고(매 적용이 update 로
 * 잡히는 플립플롭 방지) `warnings` 로 알린다. 실제로 지우려면 그 점검을 삭제하고 다시 적용한다.
 *
 * @param {string} id
 * @param {{scope?:object, overwrite?:boolean, dryRun?:boolean, user?:string}} opts
 *   scope = `{kind, path, includeSub=true}` 또는 `{targetIds:[...]}`. 해석 실패는 예외다(scopeTargets).
 *   overwrite/dryRun 은 `bool()` 화이트리스트로 정규화한다 — 쿼리스트링·HTML form·CSV 왕복은
 *   문자열 `'false'` 를 보내고 JS 에서 그것은 truthy 다(실측: `overwrite:'false'` 가 사용자 조정
 *   주기 900초를 템플릿값 300초로 덮어썼고, `dryRun:'false'` 는 create:1 로 보고하면서 실제로는
 *   아무것도 저장하지 않았다). store.js:128 이 같은 사고(`insecure='false'` → TLS 검증 해제)를
 *   주석으로 남긴 회귀다.
 *   `user` 는 호출 호환을 위해 받되 점검에 기록하지 않는다(감사 로그는 라우트가 남긴다 —
 *   점검마다 사용자명을 넣으면 다음 재적용의 diff 가 사용자만 바뀌어도 전량 update 가 된다).
 * @returns {null|{create:number,update:number,skip:number,errorCount:number,errors:object[],
 *   sample:object[],targets:number,tests:number,saved:boolean,committed:boolean,
 *   dryRun:boolean,kindMismatch:number,warnings:string[],aborted:boolean}}
 *   id 가 없으면 null(라우트가 404 로 응답). `tests` = 검토한 (대상×항목) 행 수.
 *   커밋은 all-or-nothing — 검증 오류가 1건이라도 있으면 아무것도 쓰지 않는다.
 *   `aborted:true` 면 1회 적용 상한을 넘어 **검토를 중간에 멈춘** 것이므로 수치가 부분값이다.
 */
/**
 * 검토·커밋 루프의 양보 간격. 실측(15,000 대상 × 10 항목 = 150,000 행, overwrite):
 * 양보 없이 647ms 소요 · **이벤트 루프 최대지연 598ms**. 대상 수는 상한이 20,000 이므로
 * 정상 요청도 이 규모에 도달한다. 코드베이스 선례와 같은 방식으로 끊어 준다
 * (poller.js 의 결과 반영 청크 500 + setImmediate, routes/api.js 의 대량 export 청크).
 */
const YIELD_ROWS = 2000;
const yieldNow = () => new Promise((r) => setImmediate(r));

export async function applyTemplate(id, opts = {}) {
  const scope = opts.scope === undefined ? {} : opts.scope;
  const overwrite = bool(opts.overwrite, false);
  const dryRun = bool(opts.dryRun, false);
  const tpl = getTemplate(id);
  if (!tpl) return null;

  const targets = scopeTargets(scope);
  const items = tpl.items || [];
  const errors = [];
  const warnings = [];
  let errorCount = 0;
  const pushErr = (targetName, testName, reason) => {
    errorCount += 1;
    if (errors.length < MAX_ERROR_ROWS) errors.push({ targetName, testName, reason });
  };

  /*
   * 손편집·복원 파일은 상한을 지키지 않는다(hydrate 는 값 검증을 하지 않는다). 정제해서 통과시키지
   * 않고 **단건 오류로 거부**한다 — 실측으로 항목 60개·ping 6개 템플릿이 오류 0건으로 적용됐고,
   * ping 6개 × 658 호스트면 3,948건이라 ping 워커 처리량(약 16건/초/워커)을 크게 넘긴다.
   * duplicateTemplate 로 복제하면 그 상태가 정상 템플릿으로 굳으므로 그쪽도 cleanItems 를 태운다.
   */
  if (items.length > MAX_ITEMS) {
    pushErr('', '', `템플릿 항목이 상한을 넘습니다(${items.length} > ${MAX_ITEMS}) — 저장 파일을 손으로 편집했을 수 있습니다. 항목을 줄인 뒤 적용하세요.`);
  }
  const pingItems = items.filter((x) => String(x?.type ?? '').trim().toLowerCase() === 'ping').length;
  if (pingItems > MAX_PING_ITEMS) {
    pushErr('', '', `ping 항목이 상한을 넘습니다(${pingItems} > ${MAX_PING_ITEMS}) — ping 은 CLI 프로세스라 처리량 상한이 낮고, 같은 호스트에 여러 번 찍는 것은 중복입니다.`);
  }

  const plan = [];              // { target, existing, data, key }
  const newPerTarget = new Map();
  let skip = 0;
  let examined = 0;
  let kindMismatch = 0;
  let dropRows = 0;             // overwrite 로도 지울 수 없는 필드를 가진 행
  const dropFields = new Set();
  let nameClash = 0;            // 이름·유형이 같지만 다른 템플릿 태그를 가진 기존 점검
  let aborted = false;

  // 상한을 넘긴 요청은 어차피 커밋되지 않는다 — 계획을 **전량 만든 뒤** 거부하면 그 비용이 그대로
  // 이벤트 루프 정지가 된다(실측: 2만 대상 × 50항목 = 100만 행, 동기 1.5초, heap +597MB, 결과는
  // '1회 적용은 최대 10000건' 거부). 그래서 상한을 넘는 순간 검토를 멈춘다. 반대로 '대상×항목'
  // 을 미리 곱해 거부하지는 않는다 — 재적용은 대부분 skip 이라 5,000대상×3항목(1.5만 행)도
  // 정상 요청이다(계획에 쌓이는 건수만 상한 대상이다).
  const planLimit = LIMITS.maxBulkTests;

  if (!errorCount) for (const target of targets) {
    // 구분 불일치는 **경고만** — 적용을 막지 않는다(한 대상이 두 성격을 겸하는 경우가 있다).
    if (tpl.kind && target.kind !== tpl.kind) kindMismatch += 1;
    const vars = substVars(target);
    const cur = Array.isArray(target.tests) ? target.tests : [];   // 손편집 파일 방어
    // 매칭/이름충돌 조회는 **대상당 1회 인덱스**로 만든다. 항목마다 tests.find 를 돌리면
    // O(대상×항목×점검) 이라 2만 대상·50항목·200점검에서 2억 회 비교가 된다.
    const byTag = new Map();
    const byNameType = new Map();
    for (const x of cur) {
      if (x.tpl && x.tplKey) byTag.set(joinKey(x.tpl, x.tplKey), x);
      if (!byNameType.has(joinKey(x.type, x.name))) byNameType.set(joinKey(x.type, x.name), x);
    }
    for (const item of items) {
      examined += 1;
      // 양보는 **루프 앞쪽**에 둔다. 뒤에 두면 skip 경로의 `continue` 가 그 지점을 건너뛰어
      // 전량 skip 재적용(가장 흔한 경우)에서 한 번도 양보하지 않는다(실측: 636ms 정지).
      if (examined % YIELD_ROWS === 0) await yieldNow();
      // 매칭 키는 (tpl, tplKey) 뿐이다 — 이름/유형이 같은 **수동** 점검을 흡수하면 사용자가
      // 직접 만든 항목이 템플릿에 종속되고, 다음 재적용에서 조용히 덮어써진다.
      const existing = byTag.get(joinKey(tpl.id, item.key)) || null;
      if (existing && !overwrite) { skip += 1; continue; }
      try {
        const data = substituteItem(item, vars);            // 방어 2
        // overwrite=true 는 base 를 두지 않는다(템플릿이 진실의 원천 → 제거된 필드가 diff 에 보인다).
        const predicted = refineTest(data, overwrite ? null : existing, { endpoints: true });   // 방어 3
        let unclearable = [];
        if (existing && overwrite) {
          unclearable = TEST_KEYS.filter((k) => existing[k] !== undefined && predicted[k] === undefined);
          if (unclearable.length) {
            dropRows += 1;
            for (const k of unclearable) dropFields.add(LABEL_BY_KEY.get(k) || k);
          }
        }
        if (existing && sameTest(predicted, existing, unclearable)) { skip += 1; continue; }
        if (!existing) {
          const clash = byNameType.get(joinKey(predicted.type, predicted.name));
          if (clash && clash.tpl !== tpl.id) nameClash += 1;
        }
        plan.push({ target, existing, data, key: item.key });
        if (!existing) newPerTarget.set(target, (newPerTarget.get(target) || 0) + 1);
      } catch (e) {
        pushErr(target.name, String(item.name || ''), e.message);
      }
      if (plan.length + errorCount > planLimit) { aborted = true; break; }
      // 2,000행마다 이벤트 루프를 놓아 준다. 여기서 양보해도 판정이 어긋나지 않는다 —
      // store 는 단일 프로세스 동기 API 라 양보 사이에 다른 요청이 대상을 바꿀 수는 있지만,
      // 커밋 직전에 상한을 다시 보고 addTest/updateTest 가 없는 대상을 오류로 돌린다.
      if (examined % YIELD_ROWS === 0) await yieldNow();
    }
    if (aborted) break;
  }

  // 상한은 **커밋 전에** 본다 — store.addTest 가 루프 중간에 던지면 부분 커밋이 남는다.
  for (const [target, n] of newPerTarget) {
    const have = Array.isArray(target.tests) ? target.tests.length : 0;
    if (have + n > LIMITS.maxTestsPerTarget) {
      pushErr(target.name, '', `점검은 대상당 최대 ${LIMITS.maxTestsPerTarget}개까지입니다(기존 ${have} + 신규 ${n}).`);
    }
  }
  const creates = plan.filter((p) => !p.existing).length;
  const updates = plan.length - creates;
  if (creates) {
    const cur = totalTests();
    if (cur + creates > LIMITS.maxTotalTests) {
      pushErr('', '', `전체 점검 상한 초과: 기존 ${cur} + 신규 ${creates} > ${LIMITS.maxTotalTests}`);
    }
  }
  // 1회 적용 상한 — store.addTest 는 호출마다 전체 점검 수를 세므로(O(대상)) 한 번에 수만 건을
  // 쓰면 이벤트 루프가 초 단위로 멈춘다. 클램프하지 않고 범위를 좁히게 돌려보낸다.
  if (aborted || plan.length > planLimit) {
    pushErr('', '', `1회 적용은 최대 ${planLimit}건까지입니다(계획 ${plan.length}건 이상에서 검토를 중단했습니다). 범위(폴더/대상)를 좁혀 나눠 적용하세요.`);
  }
  if (errorCount > errors.length) {
    errors.push({ targetName: '', testName: '', reason: `오류가 ${errorCount}건이라 앞 ${MAX_ERROR_ROWS}건만 담았습니다.` });
  }

  if (kindMismatch) {
    warnings.push(`템플릿 구분(${tpl.kind}) 과 다른 대상 ${kindMismatch}개가 범위에 있습니다(경고만 — 적용은 막지 않습니다).`);
  }
  if (!items.length) warnings.push('템플릿에 항목이 없어 적용할 것이 없습니다.');
  if (scopeIsAll(scope) && targets.length) {
    warnings.push(`범위 조건이 없어 전체 대상 ${targets.length}개가 적용 대상입니다(폴더/구분/대상 목록으로 좁힐 수 있습니다).`);
  }
  if (dropRows) {
    warnings.push(`템플릿에서 제거된 필드는 이미 적용된 점검에서 자동으로 지워지지 않습니다(점검 ${dropRows}건 · 필드: ${[...dropFields].join(', ')}) — store 가 미지정 필드를 기존값으로 승계하기 때문입니다. 지우려면 그 점검을 삭제하고 다시 적용하세요.`);
  }
  if (nameClash) {
    warnings.push(`이름·유형이 같은 기존 점검 ${nameClash}건이 있습니다(태그가 없는 수동 점검이거나 다른 템플릿 태그 — 자동 흡수하지 않으므로 중복 감시가 될 수 있습니다). 템플릿을 삭제하고 같은 이름으로 다시 만들면 새 tpl 태그가 발급되어 이전 세트가 그대로 남습니다.`);
  }
  const shape = (extra) => ({
    skip,
    errorCount,
    errors,
    sample: errors.slice(0, SAMPLE_ROWS),
    targets: targets.length,
    tests: examined,
    kindMismatch,
    warnings,
    aborted,
    ...extra,
  });

  // 오류가 있으면 아무것도 쓰지 않는다(all-or-nothing).
  if (errorCount) return shape({ create: 0, update: 0, saved: true, committed: false, dryRun });
  // dryRun 은 계획 수치만 돌려주고 저장소를 건드리지 않는다(storeRevision 불변).
  if (dryRun) return shape({ create: creates, update: updates, saved: true, committed: false, dryRun: true });

  let create = 0;
  let update = 0;
  let written = 0;
  for (const p of plan) {
    // 커밋도 최대 10,000건이라 끊어 준다. 여기서 양보하면 폴러가 중간 상태(일부만 반영된
    // 점검)를 볼 수 있지만, 저장 자체가 디바운스라 이전에도 부분 반영은 가능했고
    // 초 단위 정지가 더 나쁘다.
    if (written && written % YIELD_ROWS === 0) await yieldNow();
    written += 1;
    // 태그는 반드시 함께 저장한다 — 빠지면 재적용이 매번 중복 생성한다.
    const data = { ...p.data, tpl: tpl.id, tplKey: p.key };
    try {
      if (p.existing) {
        // test.id 를 승계한다(poller 의 results/nextDue/streak 이 test.id 키).
        const r = updateTest(p.target.id, p.existing.id, data);
        if (!r) throw new Error('점검을 찾을 수 없습니다(다른 세션이 삭제했을 수 있습니다).');
        update += 1;
      } else {
        const r = addTest(p.target.id, data);
        if (!r) throw new Error('대상을 찾을 수 없습니다(다른 세션이 삭제했을 수 있습니다).');
        create += 1;
      }
    } catch (e) {
      // 사전 판정을 통과한 뒤의 실패다(동시 편집·상한 경합). 부분 커밋이 남을 수 있으므로
      // 감추지 않고 그대로 보고한다.
      pushErr(p.target.name, String(p.data?.name || ''), e.message);
    }
  }
  const saved = flushStore() !== false;
  return shape({ create, update, saved, committed: true, dryRun: false });
}

/**
 * 대량 자동등록(genspec)용 — **아직 만들어지지 않은 대상**에 붙일 점검 배열을 만든다.
 * genspec 은 templates.js 를 import 하지 않고 라우트가 넘긴 이 콜백만 호출한다(순환 의존 회피 +
 * 치환 책임을 한 곳에 둔다). applyTemplate 과 **같은 3단 방어**를 통과한다(토큰 잔여·제어문자·
 * 길이·SSRF). 태그(tpl/tplKey)를 함께 넣어야 나중에 같은 템플릿을 재적용해도 중복 생성되지 않는다.
 * @param {string} templateId
 * @param {{host?:string,name?:string,path?:string,kind?:string}} target 아직 저장 전인 대상 후보
 * @returns {{tests:object[], errors:string[]}} 오류 행은 tests 에 넣지 않는다(호출부가 행 오류로 집계).
 */
export function materializeForTarget(templateId, target) {
  const tpl = getTemplate(templateId);
  if (!tpl) return { tests: [], errors: [`템플릿을 찾을 수 없습니다: ${String(templateId).slice(0, 40)}`] };
  const items = tpl.items || [];
  const errors = [];
  if (items.length > MAX_ITEMS) errors.push(`템플릿 항목이 상한을 넘습니다(${items.length} > ${MAX_ITEMS}).`);
  const pings = items.filter((x) => String(x?.type ?? '').trim().toLowerCase() === 'ping').length;
  if (pings > MAX_PING_ITEMS) errors.push(`ping 항목이 상한을 넘습니다(${pings} > ${MAX_PING_ITEMS}).`);
  // host 가 비면 `{host}` 가 빈 문자열로 치환돼 'https:///h' 같은 목적지가 만들어진다(SSRF 가드는
  // 스킴만 보고 통과시킨다 — 실측). 대상 후보 단계에서 거른다.
  if (!String(target?.host ?? '').trim()) errors.push('대상 host 가 없습니다(템플릿 치환에 필요).');
  if (errors.length) return { tests: [], errors };
  const vars = substVars(target || {});
  const tests = [];
  for (const item of items) {
    try {
      const data = substituteItem(item, vars);
      const t = refineTest(data, null, { endpoints: true });
      tests.push({ ...t, tpl: tpl.id, tplKey: item.key });
    } catch (e) {
      errors.push(`${String(item?.name || '')}: ${e.message}`);
    }
  }
  return { tests, errors };
}

export function _resetTemplateCache() { cache = null; }
