/**
 * v2.745 적대적 검토(그룹 W) 확정분 — 아이실론 결과 메일 설정 화면.
 *
 *  ① TOPNM-01 · WEB-2745-01 · F1: 종합 메일 탭(IsiduDigestSettings)이 법인 수를 '상위 화면이 받은 대상 목록(rows)' 에서 세는데
 *     그 탭을 그리는 유일한 곳(IsiduSettings)이 rows 를 넘기지 않아, 실제 화면에서는 '사용자 행 최대 —줄' 과
 *     '이 화면이 대상 목록을 받지 못했습니다' 만 나오고 120줄 초과 경고가 한 번도 뜨지 않았다. 배선을 소스로 고정하고,
 *     메인 목록 응답의 행 모양(서버 rows.js 가 싣는 corp)으로 줄 수가 숫자로 나오는지 함께 본다.
 *  ② WEB-2745-03: 받는 사람이 0명인 대상에도 편집 창이 '다음 발송: …' 3회와 '정한 요일·시각에 보냅니다' 를 말했다 —
 *     서버(rows.js)는 받는 사람이 없으면 next 를 [] 로 주고 회차를 판정하지 않는다. 미리보기·안내가 서버와 같은 말을 하게 한다.
 *     정기 발송 안내의 '결과가 메인에 들어오면 보냅니다' 도 사실이 아니다(정한 시각에 메인이 보낸다).
 *
 * 기준 시각은 고정한다(Date.now() 금지).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankTarget, recipientPreview, mailWhenPreview, mailSendHint } from './isiduText.js';
import { corpGroupsOf, rowsPlan, rowsPlanText, formFromDigest, LONG_MAIL_ROWS } from './isiduDigestText.js';
import { stripComments } from '../../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../../../../server/src');
const NOW = Date.UTC(2026, 9, 20, 2, 30);   // 2026-10-20(화) 11:30 KST — 고정
const OFF = 540;

/** JSX 소스에서 `<Name …>` 여는 태그 하나를 잘라 낸다(중괄호 깊이를 세어 '>' 를 찾는다 — 속성 안의 => 에 속지 않게). */
function jsxOpenTag(src, name) {
  const at = src.indexOf(`<${name}`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(at, i + 1);
  }
  return '';
}

describe('① 종합 메일 탭이 대상 목록(rows)을 받는다 — 법인 수·사용자 행 미리 계산·120줄 경고', () => {
  const S = stripComments(fs.readFileSync(path.join(here, 'IsiduSettings.jsx'), 'utf8'));
  const P = stripComments(fs.readFileSync(path.join(here, 'IsiduSettingsPage.jsx'), 'utf8'));

  it('IsiduSettings 가 IsiduDigestSettings 에 자기가 받은 rows 를 넘긴다(일괄 변경 탭과 같은 값)', () => {
    const tag = jsxOpenTag(S, 'IsiduDigestSettings');
    expect(tag).not.toBe('');
    expect(tag).toMatch(/\brows=\{rows\}/);
    // 같은 rows 를 일괄 변경 탭도 받는다 — 두 탭이 다른 목록을 보지 않게.
    expect(jsxOpenTag(S, 'IsiduBulk')).toMatch(/\brows=\{rows\}/);
    // rows 는 IsiduSettings 의 prop 이다(상위 페이지가 메인 목록 응답의 targets 를 넘긴다).
    expect(S).toMatch(/export default function IsiduSettings\(\{[^}]*\brows = \[\]/);
    expect(jsxOpenTag(P, 'IsiduSettings')).toMatch(/\brows=\{main\.targets/);
  });

  it('IsiduDigestSettings 를 그리는 곳은 IsiduSettings 하나다(다른 곳이 rows 없이 그리지 않게)', () => {
    const files = fs.readdirSync(here).filter((n) => /\.jsx?$/.test(n) && !/\.test\./.test(n));
    const users = files.filter((n) => stripComments(fs.readFileSync(path.join(here, n), 'utf8')).includes('<IsiduDigestSettings'));
    expect(users).toEqual(['IsiduSettings.jsx']);
  });

  it('메인 목록 응답의 행 모양(서버 rows.js 의 corp·datacenterId)으로 줄 수가 숫자로 나온다', () => {
    // 서버가 행에 corp·datacenterId 를 싣는지(웹 corpGroupsOf 가 그 둘을 센다).
    const rowsSrc = fs.readFileSync(path.join(SERVER, 'isidu/rows.js'), 'utf8');
    expect(rowsSrc).toMatch(/datacenterId: r\.datacenterId \|\| ''/);
    expect(rowsSrc).toMatch(/corp: r\.datacenterId \?/);
    const saved = formFromDigest({ enabled: true, days: [1], time: '08:00', topN: 10, corpTopM: 5 });
    const rows = [
      { id: 'a', corp: '오창', datacenterId: 'dc-oc' },
      { id: 'b', corp: '남경', datacenterId: 'dc-nj' },
      { id: 'c', corp: '오창', datacenterId: 'dc-oc' },
      { id: 'mock-1', corp: '데모', datacenterId: 'mock' },
    ];
    const known = rowsPlanText(rowsPlan(saved, saved, corpGroupsOf(rows)));
    expect(known.total).toBe('20');                       // 전 법인 10 + 법인 2곳 × 5
    expect(known.expr).toMatch(/법인별 2곳 × 5/);
    expect(known.notes.join(' ')).not.toMatch(/받지 못했습니다/);
    // 예전 화면 그대로(rows 없음) — 이 경로가 실제 화면에서 늘 나오던 값이다.
    const unknown = rowsPlanText(rowsPlan(saved, saved, corpGroupsOf(null)));
    expect(unknown.total).toBe('—');
    expect(unknown.notes.join(' ')).toMatch(/받지 못했습니다/);
  });

  it('법인이 많으면 120줄 초과 경고가 뜬다(rows 를 받았을 때만 셀 수 있다)', () => {
    const f = formFromDigest({ enabled: true, days: [1], time: '08:00', topN: 20, corpTopM: 20 });
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, corp: `법인${i}`, datacenterId: `dc${i}` }));
    const plan = rowsPlan(f, f, corpGroupsOf(rows));
    expect(plan.total).toBe(20 + 30 * 20);
    expect(plan.total).toBeGreaterThan(LONG_MAIL_ROWS);
    expect(rowsPlanText(plan).long).toBeTruthy();
    expect(rowsPlanText(rowsPlan(f, f, corpGroupsOf(null))).long).toBeNull();
  });
});

describe('② 받는 사람이 0명이면 정기 발송 회차를 말하지 않는다(서버 rows.js next = [] 와 같은 규칙)', () => {
  const sched = { ...blankTarget(), mailWhen: 'schedule', mailDays: [1], mailTime: '08:00' };
  const none = recipientPreview('ops@corp.local', { ...sched, mailExcludeCommon: true, mailTo: '' });
  const two = recipientPreview('ops@corp.local', { ...sched, mailTo: 'owner@corp.local' });

  it('받는 사람 수를 주지 않으면 예전 그대로(3회)', () => {
    const p = mailWhenPreview(sched, NOW, OFF);
    expect(p.slots).toHaveLength(3);
    expect(p.text).toMatch(/^다음 발송: 10\/26\(월\) 08:00/);
  });
  it('받는 사람이 있으면 3회 그대로', () => {
    expect(two.count).toBe(2);
    const p = mailWhenPreview(sched, NOW, OFF, two.count);
    expect(p.slots).toHaveLength(3);
    expect(p.text).toMatch(/^다음 발송: 10\/26\(월\) 08:00 · 11\/2\(월\) 08:00 · 11\/9\(월\) 08:00/);
  });
  it('0명이면 회차가 없고 그 사실을 말한다 — 발송 시각을 지어내지 않는다', () => {
    expect(none.count).toBe(0);
    const p = mailWhenPreview(sched, NOW, OFF, none.count);
    expect(p.slots).toEqual([]);
    expect(p.text).toMatch(/^다음 발송: —/);
    expect(p.text).toMatch(/받는 사람이 없어 보내지 않습니다/);
    expect(p.text).not.toMatch(/\d+\/\d+\(/);
  });
  it('조사가 끝날 때마다면 받는 사람과 무관하게 회차가 없다(예전 그대로)', () => {
    expect(mailWhenPreview({ ...sched, mailWhen: 'scan' }, NOW, OFF, 0)).toEqual({ slots: [], text: '' });
    expect(mailWhenPreview({ ...sched, mailWhen: 'scan' }, NOW, OFF, 3)).toEqual({ slots: [], text: '' });
  });

  it('안내 한 줄 — 0명이면 \'보냅니다\' 를 붙이지 않는다(정기·조사마다 둘 다)', () => {
    for (const s of [true, false]) {
      const t = mailSendHint(none, s);
      expect(t).toMatch(/받는 사람이 없습니다 — 이 대상은 결과 메일을 보내지 않습니다/);
      expect(t).not.toMatch(/보냅니다/);
    }
  });
  it('정기 발송 안내는 정한 시각에 메인이 보낸다고 말한다(결과가 들어오면 보낸다는 말을 하지 않는다)', () => {
    const t = mailSendHint(two, true);
    expect(t).toMatch(/^받는 사람 2명/);
    expect(t).toMatch(/정한 요일·시각에 메인이 보냅니다/);
    expect(t).not.toMatch(/결과가 메인에 들어오면 보냅니다/);
  });
  it('조사마다 안내는 예전 문장 그대로', () => {
    expect(mailSendHint(two, false)).toBe(`${'받는 사람 2명(공통 1명 + 이 대상 1명)'} · 조사가 성공할 때마다 보냅니다(메인이 보냅니다 — 엣지 담당 대상도 결과가 메인에 들어오면 보냅니다).`);
  });

  it('화면 소스 — 미리보기에 받는 사람 수를 넘기고 안내는 mailSendHint 하나로', () => {
    const S = stripComments(fs.readFileSync(path.join(here, 'IsiduSettings.jsx'), 'utf8'));
    expect(S).toMatch(/mailWhenPreview\(f, Date\.now\(\), mailOff, preview \? preview\.count : undefined\)/);
    expect(S).toMatch(/\{mailSendHint\(preview, sched\)\}/);
    expect(S).not.toMatch(/'정한 요일·시각에 보냅니다'/);
  });
});
