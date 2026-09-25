/**
 * archCheckText.test.js — 아키텍처 점검 화면 문구 회귀(v2.614).
 *
 * 고정하는 것:
 *  ① 코드 키 집합 == 계약(ARCH-SPEC 표) == 서버 `portalcheck/archScan.js ARCH_CODES` — 한쪽만 늘면
 *     화면이 코드를 그대로 보여 준다(v2.553·v2.560 규약). 서버 파일·spec 파일은 fs 로 읽고, 없으면
 *     **그 반쪽만** 건너뛴다(사유를 it.skip 에 적는다). 여기 박아 둔 목록이 세 번째 기준이다.
 *  ② KPI 항등식 `total = ok+warn+fault+unknown` · unknown 은 정상으로 세지 않는다.
 *  ③ 문구에 백틱 0 · 카탈로그 missing 배너는 초록이 아니다 · 확인 불가는 회색.
 *  ④ 표본 '외 N' 은 개수를 말하고, 서버 상한으로 뺀 것도 말한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCH_STATE, ARCH_STATE_LABEL, ARCH_STATE_TONE, ARCH_TEXT, CATALOG_DEPENDENT_CODES, INPUT_KEYS_OF,
  archCodesDeclared, itemState, stateTone, stateLabel, itemTitle, kpiOf, kpiMismatchNote,
  catalogNote, bannerText, countText, samplesView, emptySamplesText, inputErrorFor, fixText,
  meaningText, sortItems, metaLine, runSummary,
} from './archCheckText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SERVER_SCAN = path.join(ROOT, 'server', 'src', 'portalcheck', 'archScan.js');
const SPEC = process.env.ARCH_SPEC_PATH
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/ARCH-CHECK.md'); // v2.614: 계약 문서는 저장소 docs/ 에 산다

/** 계약 표(v2.614 ARCH-SPEC) — 세 번째 기준. 코드를 더하면 여기·서버·문구 셋 다 함께. */
const CONTRACT_CODES = [
  'route-gate-missing', 'asyncroute-unwrapped', 'tool-segment-unmapped', 'catalog-missing',
  'catalog-key-orphan', 'catalog-adminonly-mismatch', 'edgelog-spec-drift', 'bigjson-missing',
  'dataflow-cats-unmapped', 'db-file-mode', 'db-not-migratable', 'db-no-purpose',
  'config-file-unclassified', 'import-cycle', 'util-imports-domain',
];

const sorted = (a) => [...a].sort();

/** spec 의 마크다운 표에서 코드 열(`| code |` 표의 첫 열)을 뽑는다. */
function codesFromSpec(md) {
  const out = [];
  let inTable = false;
  for (const line of md.split('\n')) {
    if (/^\|\s*code\s*\|/.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!/^\|/.test(line)) break;
    if (/^\|\s*-+/.test(line)) continue;
    const m = line.match(/^\|\s*([a-z0-9-]+)\s*\|/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 주석을 지우고(개행 보존) `ARCH_CODES = Object.freeze([...])` 또는 `ARCH_CODES = [...]` 의 문자열을 뽑는다. */
function codesFromServer(src) {
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"])\/\/[^\n]*/g, (m, p) => p);
  const m = stripped.match(/ARCH_CODES\s*=\s*(?:Object\.freeze\()?\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((x) => x[1]);
}

describe('코드 키 == 계약(spec 표) == 서버 ARCH_CODES', () => {
  it('문구 키 집합이 계약 목록과 같다(순서 무관, 중복 없음)', () => {
    const keys = archCodesDeclared();
    expect(new Set(keys).size).toBe(keys.length);
    expect(sorted(keys)).toEqual(sorted(CONTRACT_CODES));
  });
  it('spec 표 파서가 동작한다(합성 표)', () => {
    const md = '# x\n| code | 뜻 | 규칙 |\n|---|---|---|\n| a-b | x | y |\n| c-d | x | y |\n\n다른 문단';
    expect(codesFromSpec(md)).toEqual(['a-b', 'c-d']);
  });
  const hasSpec = fs.existsSync(SPEC);
  (hasSpec ? it : it.skip)(`ARCH-SPEC.md 표의 코드 == 문구 키${hasSpec ? '' : ' (spec 파일이 없어 건너뜀 — ARCH_SPEC_PATH 로 지정)'}`, () => {
    const codes = codesFromSpec(fs.readFileSync(SPEC, 'utf8'));
    expect(codes.length).toBeGreaterThan(0);
    expect(sorted(codes)).toEqual(sorted(archCodesDeclared()));
  });
  const hasServer = fs.existsSync(SERVER_SCAN);
  (hasServer ? it : it.skip)(`server/src/portalcheck/archScan.js ARCH_CODES == 문구 키${hasServer ? '' : ' (서버 파일이 아직 없어 건너뜀 — 다른 그룹이 만든다)'}`, () => {
    const codes = codesFromServer(fs.readFileSync(SERVER_SCAN, 'utf8'));
    expect(codes, 'archScan.js 에서 ARCH_CODES = Object.freeze([...]) 를 찾지 못했다').not.toBeNull();
    expect(codes.length).toBeGreaterThan(0);
    expect(sorted(codes)).toEqual(sorted(archCodesDeclared()));
  });
  it('서버 파서가 동작한다(합성 소스 — 주석 속 코드는 세지 않는다)', () => {
    const src = "// 'zzz-comment'\n/* 'yyy' */\nexport const ARCH_CODES = Object.freeze([\n  'a-b', // 'not-me'\n  'c-d',\n]);\n";
    expect(codesFromServer(src)).toEqual(['a-b', 'c-d']);
    expect(codesFromServer('nothing')).toBeNull();
  });
  it('모든 코드에 title·meaning·fix 가 있고 백틱이 없다', () => {
    for (const [code, txt] of Object.entries(ARCH_TEXT)) {
      for (const k of ['title', 'meaning', 'fix']) {
        expect(typeof txt[k], `${code}.${k}`).toBe('string');
        expect(txt[k].length, `${code}.${k}`).toBeGreaterThan(5);
        expect(txt[k], `${code}.${k} 에 백틱`).not.toContain('`');
      }
    }
  });
  it('카탈로그 의존 코드는 전부 선언된 코드다', () => {
    for (const c of CATALOG_DEPENDENT_CODES) expect(ARCH_TEXT[c]).toBeTruthy();
    expect(CATALOG_DEPENDENT_CODES).toContain('catalog-missing');
  });
});

describe('상태 — 서버 값을 읽기만 하고 unknown 은 회색', () => {
  it('네 상태 전부 라벨·색이 있고 unknown 은 초록이 아니다', () => {
    for (const s of Object.values(ARCH_STATE)) {
      expect(ARCH_STATE_LABEL[s]).toBeTruthy();
      expect(ARCH_STATE_TONE[s]).toBeTruthy();
    }
    expect(ARCH_STATE_TONE.unknown).toBe('gray');
    expect(ARCH_STATE_TONE.fault).toBe('red');
    expect(ARCH_STATE_TONE.ok).toBe('green');
    expect(stateTone('nonsense')).toBe('gray');
    expect(stateLabel('nonsense')).toBe('확인 불가');
  });
  it('값이 없거나 모르는 값이면 확인 불가(초록 폴백 금지)', () => {
    expect(itemState({ state: 'ok' })).toBe('ok');
    expect(itemState({ state: 'green' })).toBe('unknown');
    expect(itemState({})).toBe('unknown');
    expect(itemState(null)).toBe('unknown');
  });
  it('모르는 코드의 제목은 코드 그대로 — 지어내지 않는다', () => {
    expect(itemTitle({ code: 'zzz' })).toBe('zzz');
    expect(itemTitle({ code: 'db-file-mode' })).toBe(ARCH_TEXT['db-file-mode'].title);
    expect(meaningText({ code: 'zzz' })).toContain('zzz');
  });
});

describe('KPI 항등식 — total = ok+warn+fault+unknown, unknown 은 정상이 아니다', () => {
  const items = [
    { code: 'a', state: 'ok' }, { code: 'b', state: 'warn' }, { code: 'c', state: 'fault' },
    { code: 'd', state: 'unknown' }, { code: 'e' }, { code: 'f', state: 'weird' },
  ];
  it('세고 항등식이 성립한다', () => {
    const k = kpiOf(items);
    expect(k).toEqual({ total: 6, ok: 1, warn: 1, fault: 1, unknown: 3 });
    expect(k.total).toBe(k.ok + k.warn + k.fault + k.unknown);
  });
  it('빈 입력·비배열은 전부 0', () => {
    expect(kpiOf([])).toEqual({ total: 0, ok: 0, warn: 0, fault: 0, unknown: 0 });
    expect(kpiOf(null)).toEqual({ total: 0, ok: 0, warn: 0, fault: 0, unknown: 0 });
  });
  it('서버 KPI 와 다르면 그 사실을 말하고, 같으면 조용하다', () => {
    expect(kpiMismatchNote({ total: 6, ok: 1, warn: 1, fault: 1, unknown: 3 }, items)).toBeNull();
    const note = kpiMismatchNote({ total: 6, ok: 4, warn: 1, fault: 1, unknown: 0 }, items);
    expect(note).toContain('ok');
    expect(note).toContain('unknown');
    expect(kpiMismatchNote(null, items)).toBeNull();
  });
});

describe('카탈로그 배너 — missing 이면 초록 금지, N 은 실제 unknown 항목 수', () => {
  it('dist 면 회색 정보', () => {
    const r = catalogNote({ source: 'dist', count: 91, generatedAt: '2026-09-25T00:00:00Z' }, []);
    expect(r.tone).toBe('gray');
    expect(r.text).toContain('91개');
  });
  it('missing 이면 호박색이고 확인 불가 개수를 말한다', () => {
    const items = [
      { code: 'catalog-missing', state: 'unknown' }, { code: 'catalog-key-orphan', state: 'unknown' },
      { code: 'catalog-adminonly-mismatch', state: 'unknown' }, { code: 'db-file-mode', state: 'ok' },
    ];
    const r = catalogNote({ source: 'missing', count: 0, generatedAt: null }, items);
    expect(r.tone).not.toBe('green');
    expect(r.tone).toBe('amber');
    expect(r.text).toContain('3개 항목은 확인 불가');
    expect(r.text).toContain('정상이라는 뜻이 아닙니다');
  });
  it('항목 배열이 없으면 의존 코드 수를 쓴다 · 카탈로그 객체가 없으면 null', () => {
    expect(catalogNote({ source: 'missing' }, null).text).toContain(`${CATALOG_DEPENDENT_CODES.length}개 항목`);
    expect(catalogNote(null, [])).toBeNull();
  });
});

describe('배너 — 나쁜 것이 이기고, 확인 불가가 있으면 초록이 아니다', () => {
  const mk = (states, errors = []) => ({ items: states.map((s, i) => ({ code: `c${i}`, state: s })), inputs: { errors } });
  it('결과 없음 → 회색', () => {
    expect(bannerText(null).tone).toBe('gray');
    expect(bannerText({}).tone).toBe('gray');
  });
  it('fault > warn > unknown > ok', () => {
    expect(bannerText(mk(['ok', 'fault', 'warn', 'unknown'])).tone).toBe('red');
    expect(bannerText(mk(['ok', 'warn', 'unknown'])).tone).toBe('amber');
    expect(bannerText(mk(['ok', 'unknown'])).tone).toBe('amber');
    expect(bannerText(mk(['ok', 'ok'])).tone).toBe('green');
  });
  it('unknown 이 섞이면 초록이 아니고 정상 아님을 말한다', () => {
    const b = bannerText(mk(['ok', 'unknown']));
    expect(b.tone).not.toBe('green');
    expect(b.text).toContain('정상이라는 뜻이 아닙니다');
  });
  it('입력 오류 개수를 함께 말한다 · 항목 0개는 초록이 아니다', () => {
    expect(bannerText(mk(['warn'], [{ code: 'x', message: 'y' }])).text).toContain('1건');
    expect(bannerText(mk([])).tone).toBe('gray');
  });
  it('문구에 백틱 0', () => {
    for (const d of [null, mk([]), mk(['ok']), mk(['warn']), mk(['fault', 'unknown']), mk(['unknown'], [{ code: 'a', message: 'b' }])]) {
      expect(bannerText(d).text).not.toContain('`');
    }
  });
});

describe('표 셀 — 개수·표본·조치', () => {
  it('개수: unknown 은 ‘—’, ok 는 0 이 정답, 결측은 ‘—’', () => {
    expect(countText({ state: 'unknown', count: 5 })).toBe('—');
    expect(countText({ state: 'ok', count: 0 })).toBe('0');
    expect(countText({ state: 'warn', count: 3 })).toBe('3');
    expect(countText({ state: 'warn' })).toBe('—');
    expect(countText({ state: 'warn', count: '' })).toBe('—'); // Number('')===0 함정
  });
  it('표본: 3개까지 + 외 N, 펼치면 전부, 서버 상한(omitted)은 따로 말한다', () => {
    const it5 = { state: 'warn', samples: ['a', 'b', 'c', 'd', 'e'], omitted: 0 };
    const v = samplesView(it5);
    expect(v.shown).toEqual(['a', 'b', 'c']);
    expect(v.hidden).toBe(2);
    expect(v.moreText).toBe('외 2');
    const e = samplesView(it5, { expanded: true });
    expect(e.shown).toHaveLength(5);
    expect(e.moreText).toBeNull();
    const o = samplesView({ samples: ['a', 'b', 'c', 'd'], omitted: 10 });
    expect(o.moreText).toBe('외 11(그중 10은 서버 상한으로 응답에 없음)');
    const o2 = samplesView({ samples: ['a', 'b', 'c', 'd'], omitted: 10 }, { expanded: true });
    expect(o2.moreText).toBe('외 10(서버 상한으로 응답에 없음)');
    const few = samplesView({ samples: ['a'], omitted: 0 });
    expect(few.moreText).toBeNull();
    expect(samplesView({ samples: null }).shown).toEqual([]);
    expect(samplesView({ samples: ['', null, 'x'] }).shown).toEqual(['x']);
  });
  it('빈 표본의 뜻은 상태마다 다르다', () => {
    expect(emptySamplesText({ state: 'ok' })).toBe('해당 없음');
    expect(emptySamplesText({ state: 'unknown' })).toBe('판정하지 못함');
    expect(emptySamplesText({ state: 'warn' })).toContain('표본 없음');
  });
  it('조치: ok 는 조치 없음, unknown 은 입력 오류 사유, 그 밖은 고정 조치문, 모르는 코드는 지어내지 않는다', () => {
    const data = { inputs: { errors: [{ code: 'db-file-mode', message: 'dbDir 을 열 수 없음' }] } };
    expect(fixText({ code: 'db-file-mode', state: 'ok' }, data)).toBe('조치 없음');
    expect(fixText({ code: 'db-file-mode', state: 'unknown' }, data)).toContain('dbDir 을 열 수 없음');
    expect(fixText({ code: 'import-cycle', state: 'unknown' }, data)).toContain('정상이라는 뜻이 아닙니다');
    expect(fixText({ code: 'db-file-mode', state: 'warn' }, data)).toBe(ARCH_TEXT['db-file-mode'].fix);
    expect(fixText({ code: 'zzz', state: 'warn' }, data)).toContain('zzz');
    expect(inputErrorFor(data, 'db-file-mode')).toBe('dbDir 을 열 수 없음');
    expect(inputErrorFor(data, 'other')).toBe('');
    expect(inputErrorFor(null, 'x')).toBe('');
  });
  it('입력 키(서버 safe(errors, key))로도 잇는다 — 서버 오류 코드는 항목 코드가 아니다', () => {
    const data = { inputs: { errors: [
      { code: 'catalog', message: 'special-tools.json 없음' }, { code: 'routes', message: '라우터 스택 없음' },
      { code: 'db-mode', message: 'Windows' }, { code: 'db-files', message: 'ENOENT' },
    ] } };
    expect(inputErrorFor(data, 'catalog-key-orphan')).toBe('special-tools.json 없음');
    expect(inputErrorFor(data, 'catalog-adminonly-mismatch')).toBe('special-tools.json 없음 · 라우터 스택 없음');
    expect(inputErrorFor(data, 'db-file-mode')).toBe('Windows · ENOENT'); // 서버 오류 배열 순서 그대로
    expect(inputErrorFor(data, 'import-cycle')).toBe('');
    expect(fixText({ code: 'catalog-key-orphan', state: 'unknown' }, data)).toContain('special-tools.json 없음');
  });
  it('INPUT_KEYS_OF 는 선언된 코드 전부를 덮고, 서버가 실제로 쓰는 입력 키만 가리킨다', () => {
    expect(sorted(Object.keys(INPUT_KEYS_OF))).toEqual(sorted(archCodesDeclared()));
    if (!fs.existsSync(SERVER_SCAN)) return;
    const src = fs.readFileSync(SERVER_SCAN, 'utf8');
    const used = new Set([
      ...[...src.matchAll(/safe(?:Async)?\(errors, '([a-z-]+)'/g)].map((m) => m[1]),
      ...[...src.matchAll(/errors\.push\(\{ code: '([a-z-]+)'/g)].map((m) => m[1]),
    ]);
    for (const [code, keys] of Object.entries(INPUT_KEYS_OF)) {
      for (const k of keys) expect(used.has(k), `${code} → 입력 키 ‘${k}’ 를 서버가 쓰지 않는다`).toBe(true);
    }
  });
  it('정렬: 결함 → 경고 → 확인 불가 → 정상, 같은 상태면 코드 순', () => {
    const s = sortItems([
      { code: 'b', state: 'ok' }, { code: 'a', state: 'ok' }, { code: 'u', state: 'unknown' },
      { code: 'w', state: 'warn' }, { code: 'f', state: 'fault' },
    ]).map((x) => x.code);
    expect(s).toEqual(['f', 'w', 'u', 'a', 'b']);
  });
});

describe('메타·요약 — 값이 없으면 단위를 붙이지 않는다', () => {
  it('metaLine', () => {
    expect(metaLine(null)).toBe('');
    expect(metaLine({}, () => '1분 전')).toBe('');
    expect(metaLine({ at: 1000, tookMs: 12, version: '2.614.0' }, () => '1분 전')).toBe('점검 1분 전 · 소요 12ms · 서버 v2.614.0');
    expect(metaLine({ at: 0, tookMs: '', version: '' }, () => 'x')).toBe('');
  });
  it('runSummary 는 항등식대로 센다', () => {
    expect(runSummary({ items: [{ state: 'ok' }, { state: 'fault' }] })).toBe('점검 완료 — 정상 1 · 경고 0 · 결함 1 · 확인 불가 0(합계 2).');
    expect(runSummary(null)).toContain('읽지 못했습니다');
  });
});
