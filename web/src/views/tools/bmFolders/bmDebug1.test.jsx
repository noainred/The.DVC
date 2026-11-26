// 물리서버 기능 디버깅 회차 1(v3.52) 화면 축 U1~U8 회귀 — 글자 · 정렬 순위 · 연결. 클릭은 jsdom 이 없어 소스 꼴로 고정하고 Chromium 으로 확인한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../../test/_stripComments.js';
import { lifeView } from './lifeText.js';
import { CASE_STATUS_ORDER, HWLOG_SEV_ORDER } from './opsText.js';
import { escMarkView } from '../partFaultEscText.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('디버깅 1회차 화면', () => {
  it('U1 — 끝난 요청은 지금 그려진 구역들에 알린다(시작한 구역이 사라져도) · 진행 중 한 줄', () => {
    const s = read('./PowerSection.jsx');
    expect(s).toMatch(/const _subs = new Set\(\);/);
    expect(s).toMatch(/useEffect\(\(\) => \{ const f = \(\) => bump\(\(x\) => x \+ 1\); _subs\.add\(f\); return \(\) => \{ _subs\.delete\(f\); \}; \}, \[\]\);/);
    expect(s).toMatch(/finally \{ _inflight\.delete\(key\); notify\(\); \}/);
    expect(s).not.toMatch(/finally \{ _inflight\.delete\(key\); bump/);
    expect(s).toContain('이 서버에 보낸 요청이 아직 끝나지 않았습니다');
  });
  it('U2 — 이벤트 로그 등급 · 케이스 상태는 순위로 정렬(글자 순 아님)', () => {
    expect(HWLOG_SEV_ORDER.critical).toBeLessThan(HWLOG_SEV_ORDER.warning);
    expect(HWLOG_SEV_ORDER.warning).toBeLessThan(HWLOG_SEV_ORDER.ok);
    expect([CASE_STATUS_ORDER.open, CASE_STATUS_ORDER.parts, CASE_STATUS_ORDER.replaced, CASE_STATUS_ORDER.closed]).toEqual([0, 1, 2, 3]);
    const s = read('./OpsSections.jsx');
    expect(s).toContain('data-sort={HWLOG_SEV_ORDER[x.sev] ?? 9}');
    expect(s).toContain('data-sort={CASE_STATUS_ORDER[c.status] ?? 9}');
    expect(s).not.toContain('data-sort={s.label}');
  });
  it('U3 — 구역 머리 배지는 접지 않는다', () => {
    expect(read('../../../styles.css')).toMatch(/\.vmh-sec \.sh h3 \.badge \{ white-space: nowrap; \}/);
  });
  it('U4 · U8 — 권고 오류는 전체 수로 말하고 · 적용 중에는 두 창이 닫히지 않는다', () => {
    const a = read('./AdvisoryLedger.jsx');
    expect(a).toContain('오류 {errN}행{errN > errs.length ? `(표에는 앞 ${errs.length}행)` : \'\'}');
    expect(a).toContain('onClose={() => { if (!busy) onClose(); }}');
    expect(read('./AssetLedger.jsx')).toContain('onClose={() => { if (!busy) onClose(); }}');
  });
  it('U5 — SSD 가 줄 상한보다 많으면 머리는 같은 응답의 전체 요약으로 센다', () => {
    const life = Array.from({ length: 64 }, (_, i) => ({ name: `Disk ${i}`, model: 'SYNTH', gb: 960, life: i === 0 ? 3 : 90, low: i === 0, gap: null }));
    const v = lifeView({ kind: 'bm', detail: { life }, summary: { disk: { life: { n: 90, read: 88, min: 3 } } } });
    expect(v.head).toBe('SSD 90개 중 88개 읽음 · 가장 낮은 값 3% · 표에는 가장 닳은 64개');
    const small = lifeView({ kind: 'bm', detail: { life: life.slice(0, 5) }, summary: { disk: { life: { n: 5, read: 5, min: 3 } } } });
    expect(small.head).toBe('SSD 5개 · 가장 낮은 값 3%');
  });
  it('U7 — 회차가 보내지 않는 상태 · 정비 창 보류면 행 표지가 ‘보냅니다’ 라고 약속하지 않는다', () => {
    const on = { enabled: true, canAck: true };
    const demo = escMarkView({ ackId: 'a', covered: true, step: null, acked: false, paused: 'demo' }, on);
    expect(demo).toMatchObject({ text: '보내지 않음', tone: 'gray', canAck: true });
    expect(demo.title).toContain('데모 점검이라 보내지 않음');
    expect(demo.title).not.toContain('보냅니다');
    const held = escMarkView({ ackId: 'a', covered: true, step: 2, acked: false, held: true }, on);
    expect(held.text).toBe('정비 창 보류');
    expect(held.title).toContain('2단계까지는 갔습니다');
    expect(escMarkView({ ackId: 'a', covered: true, step: null, acked: false }, on).text).toBe('2단계 대기');
  });
});
