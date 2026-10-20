/**
 * v2.745 종합 메일 설정 — '담을 내용' 카드(시안 ⑥): 전 법인 사용자 Top N(1~50) · 법인별 사용자 Top M(0~20, 0 = 절을 싣지 않음).
 *
 * 서버 규칙(`server/src/isidu/digestRules.js` DIGEST_RANGES · normalizeDigest · digestOf · buildDigestModel)의 웹 사본이
 * 같은 입력에 같은 답을 내는지 대조한다(번들 경계라 두 벌 — 기존 isiduDigestText.test.js 와 같은 방식).
 *  ① 범위 값 ② 숫자 칸 판정(빈 값 = 그대로 · 범위 밖·정수 아님 = 저장 거부) ③ 저장값 → 폼 ④ 폼 → 본문 왕복
 *  ⑤ 법인 수(실제 메일과 같은 묶음) ⑥ 사용자 행 미리 계산 · 120줄 경고 ⑦ 바뀐 칸 판정('지금 한 번 보내기' 잠금)
 *  ⑧ 입력 중 문제 문구 ⑨ 메일 순서 ⑩ 렌더(카드·순서) ⑪ 화면 소스 규칙 ⑫ 미리보기 본문에 새 절이 실리는가(서버 렌더)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DIGEST_RANGES, TOPN_PRESETS, CORP_TOPM_PRESETS, LONG_MAIL_ROWS, countField, formFromDigest, digestBody, formIssues,
  corpGroupsOf, rowsPlan, rowsPlanText, formDirty, keptHint, countHint, presetLabel, mailOrder,
} from './isiduDigestText.js';
import { DigestContentCard, DigestOrderCard } from './IsiduDigestSettings.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const R = await import('../../../../server/src/isidu/digestRules.js');
const M = await import('../../../../server/src/isidu/mailHtml.js');
const h = React.createElement;
const NOW = Date.UTC(2026, 9, 16, 3, 0);   // 고정 시각(순수 함수 — Date.now() 를 기준으로 쓰지 않는다)
const PREV = { enabled: false, days: [1], time: '08:00', topN: 7, corpTopM: 4 };
const INPUTS = [undefined, null, '', '  ', '0', '1', '10', '20', '21', '30', '50', '51', '-1', '5.5', '5.0', ' 7 ', '1e1', 'abc', '07', '０',
  true, false, [], [5], {}, 0, 1, 5, 20, 50, 51, 2.5, -0, NaN, Infinity];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('① 범위 — 서버 DIGEST_RANGES 와 같은 값', () => {
  it('값 그대로', () => { expect(JSON.parse(JSON.stringify(DIGEST_RANGES))).toEqual(JSON.parse(JSON.stringify(R.DIGEST_RANGES))); });
  it('빠른 선택은 범위 안이고 시안 그대로(5·10·20·30 / 0·3·5·10)', () => {
    expect([...TOPN_PRESETS]).toEqual([5, 10, 20, 30]);
    expect([...CORP_TOPM_PRESETS]).toEqual([0, 3, 5, 10]);
    for (const v of TOPN_PRESETS) expect(countField(v, 'topN').value).toBe(v);
    for (const v of CORP_TOPM_PRESETS) expect(countField(v, 'corpTopM').value).toBe(v);
    expect(presetLabel(0)).toMatch(/빼기/);
    expect(presetLabel(10)).toBe('10');
  });
});

describe('② 숫자 칸 판정 — 서버 normalizeDigest 와 같은 답(빈 값 = 그대로 · 범위 밖은 400)', () => {
  for (const key of ['topN', 'corpTopM']) {
    it.each(INPUTS.map((v) => [JSON.stringify(v) ?? String(v), v]))(`${key} %s`, (_l, v) => {
      const web = countField(v, key);
      const srv = R.normalizeDigest({ [key]: v }, PREV, 1);
      if (web.error) {
        expect(srv.field).toBe(`digest.${key}`);
      } else {
        expect(srv.error).toBeUndefined();
        expect(srv.digest[key]).toBe(web.keep ? R.digestOf(PREV)[key] : web.value);
      }
    });
  }
  it('Number(\'\') 함정 — 빈 칸은 0 이 아니라 그대로', () => {
    expect(countField('', 'corpTopM')).toEqual({ keep: true });
    expect(countField('0', 'corpTopM')).toEqual({ value: 0 });
    expect(countField('0', 'topN')).toEqual({ error: true });
  });
});

describe('③ 저장값 → 폼 — 서버 digestOf 와 같은 값(옛 파일 corpTopM 없음 = 0)', () => {
  const RAWS = [undefined, null, {}, { topN: 30 }, { topN: 51 }, { topN: '20' }, { topN: 5.5 }, { topN: 0 }, { corpTopM: 3 }, { corpTopM: 0 },
    { corpTopM: 21 }, { corpTopM: '5' }, { corpTopM: null }, { topN: null }, { topN: 50, corpTopM: 20 }, { topN: 1, corpTopM: -1 }];
  it.each(RAWS.map((r) => [JSON.stringify(r) ?? 'undefined', r]))('%s', (_l, raw) => {
    const f = formFromDigest(raw);
    const s = R.digestOf(raw);
    expect(typeof f.topN).toBe('string');
    expect(typeof f.corpTopM).toBe('string');
    expect(Number(f.topN)).toBe(s.topN);
    expect(Number(f.corpTopM)).toBe(s.corpTopM);
  });
});

describe('④ 폼 → 본문 왕복', () => {
  const base = formFromDigest({ enabled: true, days: [1, 3], time: '08:00', topN: 10, corpTopM: 0 });
  it('고친 값이 서버에 그대로 저장된다', () => {
    for (const [n, m] of [['30', '5'], ['1', '0'], ['50', '20'], [' 12 ', '3']]) {
      const body = digestBody({ ...base, topN: n, corpTopM: m });
      expect(typeof body.topN).toBe('number');
      expect(typeof body.corpTopM).toBe('number');
      const r = R.normalizeDigest({ ...body, to: [] }, { ...PREV, enabled: true, days: [1, 3] }, 1);
      expect(r.error).toBeUndefined();
      expect(r.digest.topN).toBe(Number(n));
      expect(r.digest.corpTopM).toBe(Number(m));
    }
  });
  it('빈 칸은 보내지 않는다 — 서버가 저장된 값을 그대로 둔다', () => {
    const body = digestBody({ ...base, topN: '', corpTopM: '  ' });
    expect('topN' in body).toBe(false);
    expect('corpTopM' in body).toBe(false);
    const r = R.normalizeDigest({ ...body, to: [] }, { ...PREV, enabled: true, days: [1, 3] }, 1);
    expect(r.digest.topN).toBe(7);
    expect(r.digest.corpTopM).toBe(4);
  });
  it('범위 밖은 그대로 보내 서버가 칸을 짚는다(조용히 자르지 않는다)', () => {
    const body = digestBody({ ...base, corpTopM: '21' });
    expect(R.normalizeDigest({ ...body, to: [] }, PREV, 1).field).toBe('digest.corpTopM');
    expect(R.normalizeDigest({ ...digestBody({ ...base, topN: '51' }), to: [] }, PREV, 1).field).toBe('digest.topN');
  });
});

describe('⑤ 법인 수 — 실제 메일(buildDigestModel)의 법인별 절과 같은 묶음', () => {
  const ROWS = [
    { id: 'a', corp: '오창', datacenterId: 'dc-oc' }, { id: 'b', corp: '오창', datacenterId: 'dc-oc' }, { id: 'c', corp: '', datacenterId: 'dc-nj' },
    { id: 'd', corp: '', datacenterId: '' }, { id: 'e', corp: ' 오창 ' }, { id: 'mock-1', corp: '데모 법인' }, { id: 'f', corp: '미시간' }, null, { corp: 'id 없음' },
  ];
  it('법인 미지정 대상은 한 묶음 · 데모 대상은 빠진다 · id 없는 행은 세지 않는다', () => {
    const g = corpGroupsOf(ROWS);
    const m = R.buildDigestModel(ROWS, new Map(), { now: NOW, corpTopM: 3 });
    expect(g.corps).toBe(m.corpTop.length);
    expect(g.corps).toBe(m.corps.length);
    expect(g.corps).toBe(4);   // 오창 · dc-nj · 미지정 · 미시간
    expect(g.unassigned).toBe(true);
    expect(g.demoTargets).toBe(1);
  });
  it('데모 대상만 있으면 0곳(실제 메일은 데모를 넣지 않는다)', () => {
    const rows = [{ id: 'mock-1', corp: 'A' }, { id: 'mock-2', corp: 'B' }];
    expect(corpGroupsOf(rows).corps).toBe(R.buildDigestModel(rows, new Map(), { now: NOW, corpTopM: 3 }).corpTop.length);
    expect(corpGroupsOf(rows)).toMatchObject({ corps: 0, demoTargets: 2 });
  });
  it('목록을 모르면 null — 숫자를 지어내지 않는다', () => {
    expect(corpGroupsOf(undefined)).toBeNull();
    expect(corpGroupsOf(null)).toBeNull();
    expect(corpGroupsOf([])).toMatchObject({ corps: 0 });
  });
});

describe('⑥ 사용자 행 미리 계산 · 긴 메일 경고', () => {
  const saved = formFromDigest({ topN: 20, corpTopM: 5 });
  const g5 = { corps: 5, unassigned: false, demoTargets: 0 };
  it('전 법인 N + 법인 수 × M', () => {
    const p = rowsPlan({ ...saved, topN: '10', corpTopM: '5' }, saved, g5);
    expect(p.total).toBe(35);
    const t = rowsPlanText(p);
    expect(t.total).toBe('35');
    expect(t.expr).toBe('전 법인 10 + 법인별 5곳 × 5');
    expect(t.notes.join(' ')).toMatch(/법인 5곳 기준/);
  });
  it('M = 0 이면 법인 수와 무관하게 N 줄이고 절을 싣지 않는다고 말한다', () => {
    const p = rowsPlan({ ...saved, topN: '10', corpTopM: '0' }, saved, null);
    expect(p.total).toBe(10);
    expect(rowsPlanText(p).expr).toBe('전 법인 10 + 법인별 0(싣지 않음)');
  });
  it('법인 수를 모르면 줄 수는 — (지어내지 않는다)', () => {
    const t = rowsPlanText(rowsPlan({ ...saved, topN: '10', corpTopM: '5' }, saved, null));
    expect(t.total).toBe('—');
    expect(t.expr).toBe('전 법인 10 + 법인별 —곳 × 5');
    expect(t.notes.join(' ')).toMatch(/법인 수를 알 수 없/);
  });
  it('범위 밖이면 —', () => {
    expect(rowsPlanText(rowsPlan({ ...saved, topN: '51', corpTopM: '5' }, saved, g5)).total).toBe('—');
    expect(rowsPlanText(rowsPlan({ ...saved, topN: '10', corpTopM: 'x' }, saved, g5)).expr).toBe('전 법인 10 + 법인별 —');
  });
  it('빈 칸은 저장된 값으로 센다', () => {
    const p = rowsPlan({ ...saved, topN: '', corpTopM: '' }, saved, g5);
    expect(p.topN).toBe(20);
    expect(p.corpTopM).toBe(5);
    expect(p.total).toBe(45);
    expect(keptHint({ ...saved, topN: '' }, saved, 'topN')).toMatch(/20/);
    expect(keptHint(saved, saved, 'topN')).toBeNull();
  });
  it(`${LONG_MAIL_ROWS}줄을 넘으면 경고`, () => {
    expect(LONG_MAIL_ROWS).toBe(120);
    expect(rowsPlan({ ...saved, topN: '20', corpTopM: '20' }, saved, { corps: 5 }).long).toBe(false);   // 120
    expect(rowsPlan({ ...saved, topN: '21', corpTopM: '20' }, saved, { corps: 5 }).long).toBe(true);    // 121
    expect(rowsPlanText(rowsPlan({ ...saved, topN: '50', corpTopM: '20' }, saved, { corps: 4 })).long).toMatch(/130줄/);
  });
  it('데모 대상은 실제 메일에서 빠진다고 말한다', () => {
    expect(rowsPlanText(rowsPlan(saved, saved, { corps: 2, demoTargets: 3 })).notes.join(' ')).toMatch(/데모/);
    expect(rowsPlanText(rowsPlan(saved, saved, { corps: 0, demoTargets: 3 })).notes.join(' ')).toMatch(/데모 대상만/);
  });
});

describe('⑦ 바뀐 칸 판정 — 숫자는 값으로 비교', () => {
  const saved = formFromDigest({ enabled: true, days: [1], time: '08:00', topN: 10, corpTopM: 5 });
  it.each([
    [{ topN: '10' }, false], [{ topN: '010' }, false], [{ topN: ' 10 ' }, false], [{ topN: '' }, false], [{ corpTopM: '' }, false],
    [{ topN: '11' }, true], [{ corpTopM: '0' }, true], [{ topN: 'abc' }, true], [{ corpTopM: '21' }, true], [{ includeWatch: false }, true],
  ])('%j → %s', (patch, dirty) => { expect(formDirty({ ...saved, ...patch }, saved)).toBe(dirty); });
  it('저장값이 없으면 바뀐 것으로 보지 않는다', () => { expect(formDirty(null, saved)).toBe(false); expect(formDirty(saved, null)).toBe(false); });
});

describe('⑧ 입력 중 문제 — 서버와 같은 이유 · 문구에 범위 값', () => {
  const base = formFromDigest({ enabled: true, days: [1], time: '08:00' });
  it('범위 밖·정수 아님은 칸마다', () => {
    const i1 = formIssues({ ...base, topN: '0' }, ['a@corp.local']);
    expect(i1.topN).toMatch(new RegExp(`${DIGEST_RANGES.topN.min}~${DIGEST_RANGES.topN.max}`));
    expect(i1.topN).toMatch(/저장할 수 없습니다/);
    const i2 = formIssues({ ...base, corpTopM: '5.5' }, ['a@corp.local']);
    expect(i2.corpTopM).toMatch(new RegExp(`${DIGEST_RANGES.corpTopM.min}~${DIGEST_RANGES.corpTopM.max}`));
    expect(formIssues({ ...base, topN: '', corpTopM: '' }, ['a@corp.local'])).toEqual({});
  });
  it('꺼져 있어도 범위는 본다(서버가 enabled 와 무관하게 400)', () => {
    expect(formIssues({ ...base, enabled: false, topN: '99' }, []).topN).toBeTruthy();
    expect(R.normalizeDigest({ enabled: false, topN: 99 }, null, 1).field).toBe('digest.topN');
  });
  it('칸 설명은 범위 값을 쓴다', () => {
    expect(countHint('topN')).toMatch(new RegExp(`${DIGEST_RANGES.topN.min}~${DIGEST_RANGES.topN.max}`));
    expect(countHint('corpTopM')).toMatch(/0 이면/);
  });
});

describe('⑨ 메일 순서 — 서버 renderDigestMail 의 절 순서와 같다', () => {
  it('켠 것 · 끈 것', () => {
    const f = formFromDigest({ topN: 10, corpTopM: 0, includeWatch: false, includeTargets: true });
    const o = mailOrder(f, rowsPlan(f, f, null));
    expect(o.map((x) => x.key)).toEqual(['kpi', 'watch', 'corps', 'top', 'corpTop', 'targets', 'how']);
    expect(o.find((x) => x.key === 'watch').off).toBe(true);
    expect(o.find((x) => x.key === 'corpTop').off).toBe(true);
    expect(o.find((x) => x.key === 'top').text).toBe('전 법인 사용자 Top 10');
    const f2 = { ...f, corpTopM: '5' };
    expect(mailOrder(f2, rowsPlan(f2, f, null)).find((x) => x.key === 'corpTop')).toMatchObject({ off: false, text: '법인별 사용자 Top 5' });
  });
  it('서버 본문의 절 제목 순서가 같다', () => {
    const all = fs.readFileSync(path.resolve(here, '../../../../server/src/isidu/mailHtml.js'), 'utf8');
    const start = all.indexOf('export function renderDigestMail');
    expect(start).toBeGreaterThan(-1);
    const src = all.slice(start);
    const at = (s) => src.indexOf(s);
    const order = ["label: '전체 사용량'", '먼저 볼 것', "sectionTitle('법인별 사용량'", '전 법인 사용자 Top', '법인별 사용자 Top', "sectionTitle('수집 대상별'", '숫자를 읽는 법'];
    for (const s of order) expect(at(s), s).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(at(order[i - 1]) < at(order[i]), `${order[i - 1]} → ${order[i]}`).toBe(true);
  });
});

describe('⑩ 렌더 — 카드·순서(서버 없이)', () => {
  const saved = formFromDigest({ enabled: true, days: [1], time: '08:00', topN: 10, corpTopM: 5 });
  const render = (form, groups, extra = {}) => renderToStaticMarkup(h(DigestContentCard, { form, saved, groups, set: () => {}, locked: false, issues: formIssues(form, ['a@corp.local']), badField: () => false, ...extra }));
  it('숫자 칸 두 개 · 빠른 선택 · 줄 수', () => {
    const html = render(saved, { corps: 5, demoTargets: 0 });
    expect(html).toMatch(/전 법인 사용자 Top/);
    expect(html).toMatch(/법인별 사용자 Top/);
    expect((html.match(/inputmode="numeric"/gi) || []).length).toBe(2);
    for (const v of [5, 20, 30, 3]) expect(html).toContain(`>${v}</button>`);
    expect(html).toContain('0 · 빼기');
    expect(html).toContain('35');
    expect(html).toContain('전 법인 10 + 법인별 5곳 × 5');
    expect(html).not.toMatch(/undefined|NaN|null|\[object/);
  });
  it('범위 밖이면 사유 · 120줄 넘으면 경고', () => {
    const bad = render({ ...saved, topN: '99' }, { corps: 5 });
    expect(bad).toMatch(/이대로는 저장할 수 없습니다/);
    expect(bad).toMatch(/aria-invalid="true"/);
    const long = render({ ...saved, topN: '50', corpTopM: '20' }, { corps: 5 });
    expect(long).toMatch(/메일이 길어집니다/);
  });
  it('법인 수를 모르면 — ', () => {
    const html = render(saved, null);
    expect(html).toContain('전 법인 10 + 법인별 —곳 × 5');
    expect(html).not.toMatch(/undefined|NaN|null/);
  });
  it('메일 순서 카드', () => {
    const html = renderToStaticMarkup(h(DigestOrderCard, { form: saved, plan: rowsPlan(saved, saved, null) }));
    expect(html).toContain('전 법인 사용자 Top 10');
    expect(html).toContain('법인별 사용자 Top 5');
  });
});

describe('⑪ 화면 소스 규칙', () => {
  const jsx = strip(fs.readFileSync(path.join(here, 'IsiduDigestSettings.jsx'), 'utf8'));
  it('옛 고정 선택지(5·10·20 세그먼트)를 쓰지 않는다', () => { expect(jsx).not.toMatch(/TOPN_CHOICES/); });
  it('바뀐 칸 판정은 formDirty — 지금 한 번 보내기 잠금', () => {
    expect(jsx).toMatch(/formDirty\(form, saved\)/);
    expect(jsx).toMatch(/onClick=\{sendNow\}[^>]*disabled=\{[^}]*dirty/);
  });
  it('저장·미리보기는 숫자 칸 문제로도 잠근다', () => {
    expect(jsx).toMatch(/hasIssue = [^;]*issues\.topN[^;]*issues\.corpTopM/);
    expect(jsx).toMatch(/onClick=\{openPreview\}[^>]*disabled=\{[^}]*countBad/);
  });
  it('법인 수는 받은 대상 목록(rows)에서', () => {
    expect(jsx).toMatch(/export default function IsiduDigestSettings\(\{[^}]*rows/);
    expect(jsx).toMatch(/corpGroupsOf\(rows\)/);
  });
  it('범위·경고 숫자를 화면에 박지 않는다', () => {
    expect(jsx).not.toMatch(/1~50|0~20|120줄|> ?120\b/);
  });
});

describe('⑫ 미리보기 본문 — 화면 값으로 만든 설정이면 법인별 절이 실린다(서버 렌더)', () => {
  const rows = [
    { id: 't1', corp: '오창', datacenterId: 'dc-oc', path: '/ifs/a', deviceName: 'OC-ISI', okScan: { id: 11, ts: NOW - 3_600_000, total: 3000, sumBytes: 3000, count: 3, errLines: 0 } },
    { id: 't2', corp: '난징', datacenterId: 'dc-nj', path: '/ifs/b', deviceName: 'NJ-ISI', okScan: { id: 12, ts: NOW - 3_600_000, total: 900, sumBytes: 900, count: 2, errLines: 0 } },
  ];
  const ov = new Map([
    ['t1', { state: 'ok', scan: { id: 11, ts: NOW - 3_600_000, path: '/ifs/a', count: 3, sizeMode: 'k' }, top: [{ name: 'u1', bytes: 2000 }, { name: 'u2', bytes: 700 }, { name: 'u3', bytes: 300 }] }],
    ['t2', { state: 'ok', scan: { id: 12, ts: NOW - 3_600_000, path: '/ifs/b', count: 2, sizeMode: 'k' }, top: [{ name: 'v1', bytes: 600 }, { name: 'v2', bytes: 300 }] }],
  ]);
  const html = (form) => {
    const d = R.normalizeDigest({ ...digestBody(form), to: [] }, null, NOW).digest;
    const model = R.buildDigestModel(rows, ov, { now: NOW, topN: d.topN, corpTopM: d.corpTopM, excludeDemo: false });
    return M.renderDigestMail(model, { digest: d, slot: NOW, preview: true, recipients: 1, now: NOW, includeWatch: d.includeWatch, includeTargets: d.includeTargets }).html;
  };
  it('법인별 Top 2 → 절이 있다', () => {
    const f = formFromDigest({ enabled: true, days: [1], time: '08:00', topN: 3 });
    const out = html({ ...f, corpTopM: '2' });
    expect(out).toContain('법인별 사용자 Top 2');
    expect(out).toContain('전 법인 사용자 Top 3');
    expect(out).toContain('사용자(폴더)');
  });
  it('0 이면 절이 없다(옛 파일 기본값)', () => {
    const out = html(formFromDigest({ enabled: true, days: [1], time: '08:00' }));
    expect(out).not.toContain('법인별 사용자 Top');
  });
});
