// 물리서버 기능 디버깅 회차 1(v3.52) 화면 축 U1~U8 회귀 — 글자 · 정렬 순위 · 연결. 클릭은 jsdom 이 없어 소스 꼴로 고정하고 Chromium 으로 확인한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../../test/_stripComments.js';
import { lifeView, memCeView } from './lifeText.js';
import { CASE_STATUS_ORDER, HWLOG_SEV_ORDER } from './opsText.js';
import { escMarkView, formToEsc, escToForm } from '../partFaultEscText.js';

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
    expect(v.head).toBe('SSD 90개 중 88개 읽음 · 가장 낮은 값 3% · 표에는 64개만 — 표지 있는 것 · 낮은 값을 골라 실었습니다(값 없는 SSD 는 남은 자리에만)');
    expect(lifeView({ kind: 'bm', detail: { life }, summary: { disk: { life: { n: 90, read: 90, min: 3 } } } }).head).toBe('SSD 90개 · 가장 낮은 값 3% · 표에는 64개만 — 표지 있는 것 · 낮은 값을 골라 실었습니다');
    const small = lifeView({ kind: 'bm', detail: { life: life.slice(0, 5) }, summary: { disk: { life: { n: 5, read: 5, min: 3 } } } });
    expect(small.head).toBe('SSD 5개 · 가장 낮은 값 3%');
  });
  it('U7 — 회차가 보내지 않는 상태 · 정비 창 보류면 행 표지가 ‘보냅니다’ 라고 약속하지 않는다', () => {
    const on = { enabled: true, canAck: true };
    const demo = escMarkView({ ackId: 'a', covered: true, step: null, acked: false, paused: 'demo' }, on);
    expect(demo).toMatchObject({ text: '보내지 않음', tone: 'gray', canAck: true });
    expect(demo.title).toContain('데모 점검이라 보내지 않음');
    expect(demo.title).not.toContain('2단계 시각에 보냅니다');
    expect(demo.title).toContain('풀리면 그동안 시각이 지난 단계 가운데 가장 높은 단계를 바로 보냅니다');   // 2회차 판정 #4 — ‘다시 센다’ 가 아니다
    const held = escMarkView({ ackId: 'a', covered: true, step: 2, acked: false, held: true }, on);
    expect(held.text).toBe('정비 창 보류');
    expect(held.title).toContain('2단계까지는 갔습니다');
    expect(escMarkView({ ackId: 'a', covered: true, step: null, acked: false }, on).text).toBe('2단계 대기');
  });
  it('2회차 — 정책 칸에 당직표 표기(‘이 포탈(중앙 수집)’ · ‘모두’)를 적어도 맞는 값으로 · 시각 모름 경고는 ‘없음’ · 0 으로 보이지 않는다', () => {
    const f = escToForm({ enabled: true, policies: [{ id: 'p', name: 'p', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a@example.test'], channels: false, oncall: false }] }], oncall: {} });
    f.policies[0].agentsText = '이 포탈(중앙 수집), 모두, Edge-A';
    expect(formToEsc(f).policies[0].agents).toEqual(['', '*', 'edge-a']);
    const v = memCeView({ covered: false, days: 30, total: 0, untimed: 2, slots: [['A1', 0], ['B3', 0]], uslots: [['A1', 2]], unknownSlot: 0 });
    expect(v.head).toBe('읽은 기록 안 시각을 읽은 경고 없음 · 시각 모름 2건(지난 30일을 다 읽지 못함)');   // 3회차 판정 #4 — 일부만 읽음도 밝힌다
    expect(v.note).toContain('다 덮지 못했습니다');
    expect(v.slots.find((x) => x.slot === 'A1')).toMatchObject({ n: 0, u: 2 });
  });
  it('2회차 화면 — 이 노드 서버(detail.summary) 머리 · 시각 모름은 다 읽었으면 ‘다 읽지 못함’ 이 아님 · edge-refused 문구 · 400px 표 · 결과 열 순위 정렬 · 띠 글자 자리수', async () => {
    const life = Array.from({ length: 64 }, (_, i) => ({ name: `Disk ${i}`, model: 'SYNTH', gb: 960, life: i === 0 ? 3 : 90, low: i === 0, gap: null }));
    expect(lifeView({ kind: 'bm', detail: { life, summary: { disk: { life: { n: 90, read: 90, min: 3 } } } } }).head).toBe('SSD 90개 · 가장 낮은 값 3% · 표에는 64개만 — 표지 있는 것 · 낮은 값을 골라 실었습니다');   // D1
    const c = memCeView({ covered: true, days: 30, total: 0, untimed: 1, slots: [['A1', 0]], uslots: [['A1', 1]], unknownSlot: 0 });
    expect(c.head).toBe('지난 30일 시각을 읽은 경고 기록 없음 · 시각 모름 1건(기간 안인지 모름)');   // D5
    expect(c.note).toContain('시각을 읽지 못한 교정 오류 경고 기록 1건');
    const { POWER_STATUS } = await import('./powerText.js');
    expect(POWER_STATUS['edge-refused'].text || POWER_STATUS['edge-refused']).not.toMatch(/사유를 확인/);   // D6
    const es = read('./EventSubSettings.jsx');
    expect(es).not.toContain('minWidth={420}');   // D9
    expect(es).toContain('data-sort={EVT_SYNC_ORDER[x.status] ?? 9}');   // D10
    expect(read('./AssetLedger.jsx')).toContain('data-sort={IMPORT_ACTION_ORDER[x.action] ?? 9}');
    const { peerStrip } = await import('./peerText.js');
    const st = peerStrip('cpu', { state: 'high', value: 40.4, lo: 10, hi: 40, median: 25, n: 6, points: [10, 20, 25, 30, 40, 40.4], min: 10, max: 40.4, basis: 'avg' });
    expect(st).toBeTruthy();
    expect(st.self.label).toBe('이 서버 40.4%');   // D4 — 띠 글자도 행과 같은 자리수
  });
  it('3회차 화면 — 진행 기록 못 읽음은 ‘기록 못 읽음’(확인 단추 없음) · 등록부 못 읽음 503 은 잠그지 않음 · 제목 줄 · 띠 범위 자리수', async () => {
    const v = escMarkView({ ackId: 'a', covered: true, step: null, acked: false, paused: 'state-unreadable' }, { enabled: true, canAck: true });
    expect(v).toMatchObject({ text: '기록 못 읽음', canAck: false });
    const { powerFailText } = await import('./powerText.js');
    expect(powerFailText({ status: 503, body: { error: 'registryUnreadable', reason: '이 포탈의 iDRAC 등록부를 읽지 못했습니다' } }, '위치 LED 켜기').unknown).toBe(false);
    expect(powerFailText({ status: 503, body: {} }, 'x').unknown).toBe(true);
    expect(read('../../../styles.css')).toMatch(/\.vmh-sec > \.sh:has\(> \.bmd-sh-sub\) > h3 \{ flex-shrink: 0;/);
    expect(read('./peerText.js')).toContain('spanText: ok && vMin != null && vMax != null ? `값 범위 ${pv(vMin)} ~ ${pv(vMax)}`');
  });
  it('4회차 화면 — not-found · 등록부 503 문구를 두 번 쓰지 않음 · 503 으로 돌려보낸 수', async () => {
    const { powerResultText, powerFailText } = await import('./powerText.js');
    const nf = powerResultText({ ok: false, status: 'not-found', message: '그 엣지의 등록부에서 이 서버를 찾지 못했습니다.' }, 'LED 켜기');
    expect((nf.text.match(/찾지 못했|없습니다/g) || []).length).toBeLessThanOrEqual(1);
    const t = powerFailText({ status: 503, body: { error: 'registryUnreadable', reason: '이 포탈의 iDRAC 등록부를 읽지 못했습니다 — 보내지 않았습니다(서비스 점검에서 등록부를 확인).' } }, 'LED 켜기').text;
    expect((t.match(/보내지 않았습니다/g) || []).length).toBe(1);
    expect(read('./EventSubSettings.jsx')).toContain('구독 설정 · 등록부를 못 읽어 다시 보내게 한 것');
  });
});

