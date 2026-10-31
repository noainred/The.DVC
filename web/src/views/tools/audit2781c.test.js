/**
 * v2.781(점검 G3 — 백업 서머리 웹) 회귀:
 *  · C-B2 KPI — 아는 곳 0 이면 '—'(0 · 0% 가 아니다) · 비율 분모는 그 기준을 아는 vCenter 의 VM 합 · 부분 합 '*'
 *  · B-B1 '지금 백업 중' — 마지막 읽기 실패·오래된 서버가 있으면 0 은 '—', 0 이 아니면 '≥N'
 *  · C-I2 '주의가 필요한 곳' — 심각한 것부터 정렬한 뒤 자르고 '외 N건' · 표의 '주의 필요' 보기에 드는 행은 목록에도 반드시 나온다
 *  서버 backupTotals 출력을 그대로 넣는다(판정 코어는 서버 하나 — 웹은 글자만).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { summaryKpis, runningCell, attentionList, needsAttention, filterRows } from './backupViewText.js';
import { backupTotals } from '../../../../server/src/veeam/backupStatus.js';

describe('v2.781 C-B2 서머리 KPI', () => {
  it('아는 vCenter 0곳(모든 Veeam 실패·스냅샷 준비 중) — 전부 — · 실패·경고 0 을 지어내지 않는다', () => {
    const t = backupTotals([
      { vm: 100, veeam: null, veeamState: 'veeam-failed', snap: null, snapState: 'preparing', split: null, running: null },
      { vm: 50, veeam: null, veeamState: 'veeam-pending', snap: null, snapState: 'preparing', split: null, running: null },
    ]);
    const k = summaryKpis(t, { rpoDays: 1 });
    expect([k.veeam.value, k.snap.value, k.running.value, k.rpo.value]).toEqual(['—', '—', '—', '—']);
    expect(k.rpo.sub).not.toMatch(/실패 0/);
    expect(k.running.sub).toBe('대기 —');
    expect(k.vm.value).toBe('150');
  });

  it('일부만 앎 — 분모는 아는 vCenter 의 VM(b1: 75% · c1: 100%) · 부제 제외 문구가 사실', () => {
    const t = backupTotals([
      { vm: 4, veeam: 3, veeamState: 'ok', snap: 100, snapState: 'ok', split: null, running: 0, pending: 0, rpo: { d1: 0, d3: 0, d7: 0, unknown: 0 }, results: { failed: 0, warning: 0 } },
      { vm: 1000, veeam: null, veeamState: 'veeam-failed', snap: null, snapState: 'stale-events', split: null, running: null },
    ]);
    const k = summaryKpis(t);
    expect(k.veeam.value).toBe('3 · 75%');
    expect(k.veeam.sub).toMatch(/확인 불가 1곳 제외/);
    // 스냅샷 100 / 아는 VM 4 → 2500% 는 실제로는 나올 수 없는 입력이라 c1 꼴로 다시
    const t2 = backupTotals([
      { vm: 100, veeam: null, veeamState: 'unlinked', snap: 100, snapState: 'ok', split: { both: 0, vOnly: 0, sOnly: 100, none: 0 } },
      { vm: 900, veeam: null, veeamState: 'unlinked', snap: null, snapState: 'stale-events', split: null },
    ]);
    const k2 = summaryKpis(t2);
    expect(k2.snap.value).toBe('100 · 100%');
    expect(k2.snap.sub).toBe('확인 불가 1곳 제외');
    expect(k2.veeam.value).toBe('0 · 0%');   // 연동 없음뿐 — 'Veeam 0' 은 사실(없음 확정)
    expect(k2.running.value).toBe('—');      // 읽은 Veeam 이 없다
  });

  it('부분 합 표지 — 일부 서버만 · 일부만 읽은 스냅샷 · VM 목록 수집 전', () => {
    const t = backupTotals([
      { vm: 10, veeam: 6, veeamState: 'partial', snap: 5, snapState: 'partial', split: null, running: 2, pending: 1, runningStale: true, rpo: { d1: 3, d3: 1, d7: 0, unknown: 1 }, results: { failed: 1, warning: 2 } },
      { vm: null, veeam: null, veeamState: 'no-inventory', snap: null, snapState: 'no-inventory', split: null, running: null },
    ]);
    const k = summaryKpis(t, { rpoDays: 3 });
    expect(k.veeam.value).toBe('6* · 60%');
    expect(k.veeam.sub).toMatch(/\* 일부 서버만 1곳/);
    expect(k.snap.value).toBe('5* · 50%');
    expect(k.vm.value).toBe('10*');
    expect(k.vm.sub).toMatch(/VM 목록 수집 전 1곳/);
    expect(k.rpo.value).toBe('1*');
    expect(k.rpo.sub).toBe('시각 모름 1 · 실패 1 · 경고 2');
    expect(k.running.value).toBe('≥2');
    expect(k.running.sub).toBe('대기 ≥1 · 모름 1곳(마지막 읽기 실패·오래됨)');
    const k0 = summaryKpis(backupTotals([{ vm: 3, veeam: 3, veeamState: 'partial', snap: 0, snapState: 'ok', split: null, running: 0, pending: 0, runningStale: true, rpo: { d1: 0, d3: 0, d7: 0, unknown: 0 }, results: { failed: 0, warning: 0 } }]));
    expect([k0.running.value, k0.running.sub.startsWith('대기 —')]).toEqual(['—', true]);
  });

  it('신선한 정상 — 예전 표시 그대로(값 · %)', () => {
    const t = backupTotals([{ vm: 20, veeam: 10, veeamState: 'ok', snap: 4, snapState: 'ok', split: { both: 2, vOnly: 8, sOnly: 2, none: 8 }, running: 1, pending: 0, rpo: { d1: 2, d3: 0, d7: 0, unknown: 0 }, results: { failed: 0, warning: 1 } }]);
    const k = summaryKpis(t);
    expect([k.vm.value, k.veeam.value, k.snap.value, k.running.value, k.rpo.value]).toEqual(['20', '10 · 50%', '4 · 20%', '1', '2']);
    expect(k.veeam.sub).toBe('Veeam 서버 기준');
    expect(summaryKpis(null).veeam.value).toBe('—');
  });
});

describe('v2.781 B-B1 백업 중 칸', () => {
  it('stale 이면 0 은 — · 아니면 하한 · 신선하면 그대로', () => {
    expect(runningCell({ running: 0, runningStale: true })).toMatchObject({ text: '—', active: false, sort: null });
    expect(runningCell({ running: 3, runningStale: true })).toMatchObject({ text: '≥3', active: true, sort: 3 });
    expect(runningCell({ running: 0 })).toMatchObject({ text: '0', active: false, sort: 0 });
    expect(runningCell({ running: null })).toMatchObject({ text: '—', sort: null });
  });
});

describe('v2.781 C-I2 주의가 필요한 곳', () => {
  it('심각한 것부터 자르고 외 N건 — 뒤쪽 읽기 실패가 잘리지 않는다', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, name: `vc${i}`, veeamState: 'veeam-pending', snap: 1, snapStale: 0 }));
    many.push({ id: 'x', name: 'x', veeamState: 'veeam-failed', snap: 1 });
    many.push({ id: 'u', name: 'u', veeamState: 'unlinked', snap: 1 });
    const att = attentionList(many);
    expect(att[0]).toMatchObject({ id: 'x', tone: 'bad' });
    expect(att).toHaveLength(8);
    // v2.782(점검 K4 F-B3): 연동 없음 요약은 잘리지 않고 맨 끝 · '외 N곳' 은 주의 필요 보기의 행 중 목록에 안 나온 행 수(pending 5곳)
    expect(att[6]).toMatchObject({ id: 'more', more: 5, title: '외 5곳' });
    expect(att[7]).toMatchObject({ id: 'unlinked', tone: 'info' });
  });

  it('주의 필요 보기에 드는 행은 목록에도 나온다(Veeam 정상 + 스냅샷 모름 · 결과 오래됨)', () => {
    const rows = [
      { id: 'a', name: 'a', veeamState: 'ok', snap: null, snapReason: 'preparing', snapStale: 0 },
      { id: 'b', name: 'b', veeamState: 'ok', snap: 3, veeamStale: 1, snapStale: 0 },
      { id: 'c', name: 'c', veeamState: 'unlinked', snap: null, snapStale: 0 },
      { id: 'd', name: 'd', veeamState: 'ok', snap: 3, hostMismatch: true, snapStale: 1 },
      { id: 'e', name: 'e', veeamState: 'ok', snap: 3, snapStale: 0 },
    ];
    const att = attentionList(rows, 100);
    const ids = new Set(att.map((x) => String(x.id).split(':')[0]));
    for (const r of filterRows(rows, 'warn')) expect(ids.has(r.id), r.id).toBe(true);
    expect(needsAttention(rows[4])).toBe(false);
    expect(ids.has('e')).toBe(false);
    expect(att.find((x) => x.id === 'a:snap').text).toBe('사유: 준비 중');
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });

  it('화면 — KPI 는 summaryKpis 하나(백업 중) · v2.836 정책 KPI 는 summaryPolicyKpis 하나', () => {
    // v2.836(백업 메뉴 개편 1-b — 사용자 요청 + 시안 ①): Summary 의 '주의가 필요한 곳' 목록과 법인별 표(백업 중 칸)는 법인 › 폴더 › VM 트리 표로 바뀌었다.
    //   attentionList · runningCell 판정은 그대로 남아 위 테스트가 고정한다(다른 화면이 다시 쓸 때를 위해).
    const src = fs.readFileSync(new URL('./BackupSummaryTool.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/summaryKpis\(t,/);
    expect(src).toMatch(/summaryPolicyKpis\(t,/);
    expect(src).not.toMatch(/pctOf\(n, t\.vm\)/);
  });
});
