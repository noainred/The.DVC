import { describe, it, expect } from 'vitest';
import { rowActions, agentAfterVcToggle, statusCell } from './VeeamSettings.jsx';
import { veeamBadge, veeamSummary, veeamCounts, resultLabel, shortTime, sizeText, durationText, veeamDetailView, veeamSnapBadge, veeamSnapCounts, VEEAM_SNAP_STALE_MS, veeamEventBadge, veeamEventStatusText, backupCell, veeamEventChip } from './veeamBadge.js';

describe('veeamBadge (v2.751)', () => {
  it('백업 대상은 완료 시각을 붙이고 · 백업 중은 진행률 · 대기', () => {
    expect(veeamBadge(null)).toBe(null);
    const lb = new Date(2026, 9, 22, 1, 12).getTime();
    const ok = veeamBadge({ jobs: ['BJ-Web'], run: 0, rp: 14, lb, lbSrc: 'task', lastRun: lb, lastResult: 'Success', servers: ['VBR-A'] });
    expect(ok.label).toBe('Veeam 10-22 01:12'); expect(ok.color).toBe('green'); expect(ok.progress).toBe(null);
    expect(ok.title).toMatch(/마지막 백업 완료/); expect(ok.title).toMatch(/복원 지점 14개/); expect(ok.title).toMatch(/누르면 백업 상세/);
    expect(veeamBadge({ rp: 3 }).label).toBe('Veeam'); // 완료 시각을 모르면 날짜를 지어내지 않는다
    expect(veeamBadge({ lb, lbSrc: 'rp' }).title).toMatch(/최신 복원 지점 생성/); // 복원 지점 시각은 완료 시각이라 말하지 않는다
    const run = veeamBadge({ jobs: ['J'], run: 1, pg: 42, by: 'task' });
    expect(run.label).toBe('백업 중 42%'); expect(run.color).toBe('amber'); expect(run.progress).toBe(42);
    const job = veeamBadge({ jobs: ['J'], run: 1, pg: null, by: 'job' });
    expect(job.label).toBe('백업 중'); expect(job.progress).toBe(null); // 진행률을 모르면 % 도 막대도 없다
    expect(veeamBadge({ run: 2 }).label).toBe('대기');
    expect(veeamBadge({ rp: -1 }).title).toMatch(/개수 모름/);
  });
  it('보조 포맷 — 값이 없으면 단위를 붙이지 않는다', () => {
    expect(resultLabel('Failed')).toBe('실패'); expect(resultLabel('None')).toBe(''); expect(resultLabel('Odd')).toBe('Odd');
    expect(shortTime(null)).toBe('');
    expect(sizeText(null)).toBe('—'); expect(sizeText(0)).toBe('0 B'); expect(sizeText(5 * 1024 ** 4)).toBe('5.0 TB');
    expect(durationText(null)).toBe('—'); expect(durationText(42 * 60)).toBe('42분'); expect(durationText(3725)).toBe('1시간 2분'); expect(durationText(9)).toBe('9초');
  });
});

describe('veeamSummary (v2.751 요약 카드)', () => {
  it('미등록 · 읽기 실패는 백업 없음으로 단정하지 않는다', () => {
    const u = veeamSummary({ configured: false });
    expect(u.kind).toBe('unconfigured'); expect(u.text).toMatch(/Veeam 백업 서버에서 등록/); expect(u.stats).toBe(null); expect(u.text).not.toMatch(/메모/); expect(u.text).toMatch(/스냅샷 기준/);
    const e = veeamSummary(null, { error: 'HTTP 500' });
    expect(e.tone).toBe('warn'); expect(e.text).toMatch(/백업이 없다는 뜻이 아닙니다/);
  });
  it('집계·출처·기준 시각 · 서버 실패는 경고 · 대조 못 한 항목은 자세히 · 백틱 없음', () => {
    const d = { configured: true, servers: [{ name: 'A', ok: true, lastOkTs: Date.UTC(2026, 9, 22) }, { name: 'B', ok: false, error: '인증 실패(401)', authStopped: true, lastOkTs: null }],
      byVm: { a: { run: 1 }, b: { run: 0 }, c: { run: 2 } }, otherVcenter: 3, ambiguous: 1, unmatched: 2 };
    expect(veeamCounts(d.byVm)).toEqual({ total: 3, running: 1, pending: 1 });
    const s = veeamSummary(d, { vmTotal: 240 });
    expect(s.tone).toBe('warn'); expect(s.kind).toBe('ok');
    expect(s.stats).toEqual({ total: 3, running: 1, pending: 1, vmTotal: 240 });
    expect(s.source).toBe('서버 A, B'); expect(s.basis).toMatch(/^기준 /);
    expect(s.warnings.join('\n')).toMatch(/B 인증 실패로 주기 수집을 멈췄습니다/);
    expect(s.details.join('\n')).toMatch(/다른 vCenter 로 적은 VM 3개/);
    expect(s.details.join('\n')).toMatch(/고르지 못한 항목 1개/);
    expect(s.details.join('\n')).toMatch(/찾지 못한 Veeam 항목 2개/);
    expect([...s.warnings, ...s.details].join('')).not.toMatch(/`/);
  });
});

describe('veeamDetailView (v2.751 상세 창)', () => {
  it('정보가 없으면 백업 안 됨으로 단정하지 않는다', () => {
    const v = veeamDetailView(null);
    expect(v.sections).toEqual([]); expect(v.status.text).toMatch(/단정하지 않습니다/);
  });
  it('마지막 백업·복원 지점·용량 — 모르는 값은 — 과 이유', () => {
    const v = veeamDetailView({
      running: null, pending: false, lastBackup: Date.UTC(2026, 9, 21, 16, 42), lastBackupSrc: 'task',
      lastTask: { result: 'Success', job: 'BJ-Web', start: Date.UTC(2026, 9, 21, 16), end: Date.UTC(2026, 9, 21, 16, 42), durationSec: 2520, processed: null, read: null, transferred: null, message: '' },
      restorePoints: { count: 14, oldest: 1, latest: 2, recent: [2, 1] }, vmSize: null, backups: [{ id: 'b', name: 'BJ-Web' }], jobs: [{ name: 'BJ-Web' }],
    });
    expect(v.status.tone).toBe('green'); expect(v.status.text).toMatch(/마지막 백업 완료/);
    const last = v.sections.find((x) => x.title === '마지막 백업');
    expect(last.rows).toContainEqual(['소요 시간', '42분']);
    expect(last.rows).toContainEqual(['처리한 데이터', '—']);
    expect(last.note).toMatch(/처리 용량을 주지 않았습니다/);
    expect(v.sections.find((x) => x.title === '복원 지점').rows[0]).toEqual(['개수', '14개']);
    expect(v.sections.find((x) => x.title === '용량').note).toMatch(/공유/);
    expect(v.recent).toEqual([2, 1]); expect(v.backups.length).toBe(1);
  });
  it('백업 중이면 진행률', () => {
    const v = veeamDetailView({ running: { progress: 37, by: 'task' }, restorePoints: {} });
    expect(v.status.progress).toBe(37); expect(v.status.text).toMatch(/37%/);
  });
});

describe('에이전트 백업 표시 (v2.752)', () => {
  it('배지·상세가 이름으로 맞췄다는 근거를 말한다', () => {
    expect(veeamBadge({ rp: 7, ag: 1, servers: ['OC'] }).title).toMatch(/에이전트 백업 — .*컴퓨터 이름으로/);
    expect(veeamBadge({ rp: 7, servers: ['OC'] }).title).not.toMatch(/에이전트/);
    expect(veeamDetailView({ agent: true, restorePoints: { count: 7 }, lastBackup: Date.UTC(2026, 9, 22), lastBackupSrc: 'rp' }).status.text).toMatch(/에이전트 백업\(컴퓨터 이름으로 맞춤\)/);
  });
});

describe('vCenter 스냅샷 기준 배지 (v2.753)', () => {
  const now = new Date(2026, 9, 22, 12, 0).getTime();
  it('Veeam 임시 스냅샷이 없으면 배지 없음 · 새 스냅샷은 보라 📸 백업 중 · 하루 넘으면 빨강 잔존', () => {
    expect(veeamSnapBadge({}, now)).toBe(null);
    expect(veeamSnapBadge({ veeamSnaps: 0, veeamSnapTs: now }, now)).toBe(null);
    const run = veeamSnapBadge({ veeamSnaps: 1, veeamSnapTs: now - 40 * 60_000 }, now);
    expect(run.label).toBe('📸 백업 중'); expect(run.color).toBe('purple'); expect(run.stale).toBe(false);
    expect(run.title).toMatch(/vCenter 스냅샷 기준 — Veeam 서버에서 확인한 값이 아닙니다/);
    expect(run.title).toMatch(/성공 여부와 지난 백업 이력은 스냅샷으로 알 수 없습니다/);
    const old = veeamSnapBadge({ veeamSnaps: 1, veeamSnapTs: now - VEEAM_SNAP_STALE_MS - 3_600_000 }, now);
    expect(old.label).toBe('📸 스냅샷 잔존 25시간'); expect(old.color).toBe('red'); expect(old.title).toMatch(/KB1790/);
    expect(veeamSnapBadge({ veeamSnaps: 2, veeamSnapTs: now - 5 * 86_400_000 }, now).label).toBe('📸 스냅샷 잔존 5일');
    const unk = veeamSnapBadge({ veeamSnaps: 1, veeamSnapTs: null }, now);
    expect(unk.stale).toBe(false); expect(unk.title).toMatch(/생성 시각 모름/); // 시각을 모르면 잔존이라 단정하지 않는다
  });
  it('Veeam 서버 배지와 모양·문구가 다르다 · 집계 · 백틱 없음', () => {
    const vb = veeamBadge({ run: 1, pg: 10, by: 'task' });
    const sb = veeamSnapBadge({ veeamSnaps: 1, veeamSnapTs: now }, now);
    expect(sb.label.startsWith('📸')).toBe(true); expect(vb.label.startsWith('📸')).toBe(false); expect(sb.color).not.toBe(vb.color);
    expect(veeamSnapCounts([{ veeamSnaps: 1, veeamSnapTs: now }, { veeamSnaps: 1, veeamSnapTs: now - 3 * 86_400_000 }, {}, null], now)).toEqual({ running: 1, stale: 1 });
    expect(sb.title).not.toMatch(/`/);
  });
});

describe('vCenter 이벤트 기준 배지 (v2.754)', () => {
  it('최근 Veeam 스냅샷 생성 시각 · 횟수 · 출처 · 성공 여부는 모른다고 말한다', () => {
    expect(veeamEventBadge(null)).toBe(null);
    expect(veeamEventBadge([null, 1])).toBe(null);
    const ts = new Date(2026, 9, 22, 1, 12).getTime();
    const b = veeamEventBadge([ts, 3], { days: 7 });
    expect(b.label).toBe('📸 10-22 01:12'); expect(b.color).toBe('sky'); // 성공처럼 읽히는 녹색이 아니다(v2.754 검토 #3)
    expect(b.title).toMatch(/백업을 시도한/);
    expect(b.title).toMatch(/vCenter 이벤트 기준 — Veeam 서버에서 확인한 값이 아닙니다/);
    expect(b.title).toMatch(/최근 7일 3번/); expect(b.title).toMatch(/성공 여부는 이벤트로 알 수 없습니다/);
    expect(veeamEventBadge([ts, 1], { source: 'edge' }).title).toMatch(/엣지가 보낸 요약/);
    expect(b.title).not.toMatch(/`/);
  });
  it('상태 문구 — ok 면 없음 · 못 본 이유는 백업 없음으로 말하지 않는다', () => {
    expect(veeamEventStatusText(null)).toBe('');
    expect(veeamEventStatusText({ status: 'ok' })).toBe('');
    for (const st of ['log-off', 'severity-filter', 'not-collected', 'no-edge-data']) {
      const t = veeamEventStatusText({ status: st });
      expect(t.length).toBeGreaterThan(10); expect(t).not.toMatch(/백업 안 됨|백업이 없/);
    }
    expect(veeamEventStatusText({ status: 'weird' })).toMatch(/받지 못했습니다/);
    expect(veeamEventStatusText({ status: 'stale-edge', at: Date.now() })).toMatch(/오래됐습니다/);
    expect(veeamEventStatusText({ status: 'ok', accounts: 0, byVm: {} })).toMatch(/Veeam 계정을 아직 모릅니다/);
    expect(veeamEventStatusText({ status: 'ok', accounts: 0, byVm: { a: [1, 1] } })).toBe('');
    const at = Date.UTC(2026, 9, 22, 12);
    expect(veeamEventStatusText({ status: 'ok', accounts: 1, byVm: {}, at, collectedAt: at - 7 * 3_600_000 })).toMatch(/마지막으로 수집한 시각/);
    expect(veeamEventStatusText({ status: 'ok', accounts: 1, byVm: {}, truncated: true })).toMatch(/일부만 읽었습니다/);
    expect(veeamEventStatusText({ status: 'ok', accounts: 1, byVm: {}, unpaired: 3 })).toMatch(/공용 계정\(administrator 등\).*3건/); // v2.755
  });
});

describe('backupCell (v2.757 — vCenter 카드 백업 수량)', () => {
  it('Veeam 기준은 n/전체 · 녹색 칸 · 백업 중을 툴팁에', () => {
    const c = backupCell({ src: 'veeam', n: 182, vmTotal: 195, running: 3, pending: 1, basisTs: 1 });
    expect(c.text).toBe('182/195'); expect(c.tone).toBe('veeam'); expect(c.label).toBe('백업 · Veeam');
    expect(c.title).toMatch(/Veeam 백업 182대 \/ VM 195대/); expect(c.title).toMatch(/지금 백업 중 3 · 대기 1/);
  });
  it('스냅샷 기준은 하늘색 점선 칸 · 성공 여부를 모른다고 말한다', () => {
    const c = backupCell({ src: 'snap', n: 271, vmTotal: 340, snapEv: 268, snapNow: 5, overlap: 2, days: 7 });
    expect(c.text).toBe('271/340'); expect(c.tone).toBe('snap'); expect(c.label).toBe('백업 · 스냅샷');
    expect(c.title).toMatch(/최근 7일 Veeam 이 스냅샷을 만든 VM 268 \+ 지금 Veeam 임시 스냅샷이 있는 VM 5 \(겹침 2\)/);
    expect(c.title).toMatch(/백업 성공 여부는 알 수 없습니다/);
  });
  it('부분 값은 별표·노란 칸 · 모르면 0 이 아니라 대시와 이유', () => {
    const p = backupCell({ src: 'veeam', n: 240, vmTotal: 288, partial: true, failed: 1 });
    expect(p.text).toBe('240/288 *'); expect(p.tone).toBe('warn'); expect(p.title).toMatch(/마지막 성공 값/);
    const st = backupCell({ src: 'snap', n: null, reason: 'stale-events', collectedAt: new Date(2026, 9, 10, 4, 32).getTime(), snapNow: 2 });
    expect(st.text).toBe('—'); expect(st.tone).toBe('none'); expect(st.label).toBe('백업 · 확인 불가');
    expect(st.title).toMatch(/0대가 아닙니다/); expect(st.title).toMatch(/2026-10-10 04:32/); expect(st.title).toMatch(/임시 스냅샷이 있는 VM 2대/);
    expect(backupCell({ src: 'snap', n: null, reason: 'log-off' }).title).toMatch(/이벤트 수집이 꺼져/);
    expect(backupCell({ src: 'veeam', n: null, reason: 'veeam-pending' }).label).toBe('백업 · Veeam');
    expect(backupCell({ src: 'snap', n: null, reason: '??' }).title).toMatch(/받지 못했습니다/);
  });
  it('항목이 없으면 칸을 그리지 않는다 · 전체 VM 수는 카드 값으로 보충', () => {
    expect(backupCell(null)).toBe(null); expect(backupCell({ src: 'x', n: 1 })).toBe(null);
    expect(backupCell({ src: 'veeam', n: 5 }, 9).text).toBe('5/9');
    expect(backupCell({ src: 'veeam', n: 5 }).text).toBe('5/—');
  });
});

describe('v2.758 — VM 목록 수집 전은 0 이 아니라 모름', () => {
  it('카드·VM 화면 모두 no-inventory 를 안내한다', () => {
    const c = backupCell({ src: 'snap', n: null, reason: 'no-inventory' });
    expect(c.text).toBe('—'); expect(c.title).toMatch(/VM 목록을 아직 수집하지 않았습니다/);
    expect(backupCell({ src: 'veeam', n: null, reason: 'no-inventory' }).title).toMatch(/VM 목록을 아직 수집하지 않았습니다/);
    expect(veeamEventStatusText({ status: 'no-inventory' })).toMatch(/VM 목록을 아직 수집하지 않았습니다/);
  });
});

describe('v2.759 — 전용 DB 준비 중', () => {
  it('준비 중은 0 이 아니라 대시 + 이유', () => {
    const c = backupCell({ src: 'snap', n: null, reason: 'preparing' });
    expect(c.text).toBe('—'); expect(c.title).toMatch(/전용 DB 로 옮기는 중/);
  });
  it('카드 폴링 주기는 고정(상태에 따라 바꾸면 usePolling 이 데이터를 비우고 다시 묻는 무한 재요청)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./VCenters.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/usePolling\(openId \? null : '\/veeam\/backup-counts', \{\}, 60_000\)/);
  });
});

describe('v2.761 — Veeam 표시 버그 점검 수정(웹)', () => {
  const sv = (o) => ({ name: 'VBR', ok: true, lastOkTs: 1, notes: [], ...o });
  it('D1: 쓸 수 있는 결과가 하나도 없으면 0/N 이 아니라 모름(경고는 남긴다)', () => {
    const s = veeamSummary({ configured: true, servers: [sv({ ok: false, lastOkTs: null, error: '연결 거부' })], byVm: {} }, { vmTotal: 340 });
    expect(s.stats).toBe(null); expect(s.kind).toBe('pending'); expect(s.text).toMatch(/0대가 아니라 아직 모릅니다/);
    expect(s.warnings.join()).toMatch(/연결 거부/);
    expect(veeamSummary({ configured: true, servers: [sv({ ok: null, lastOkTs: null })], byVm: {} }).kind).toBe('pending');
  });
  it('D5: 서버가 오래된 백업 중 표지를 지웠으면 실행 중·대기는 모름', () => {
    const s = veeamSummary({ configured: true, servers: [sv()], byVm: { a: {} }, runningStale: true });
    expect(s.stats.running).toBe(null); expect(s.stats.pending).toBe(null); expect(s.details.join()).toMatch(/최신 결과가 아니라/);
    expect(veeamSummary({ configured: true, servers: [sv()], byVm: { a: { run: 1 } } }).stats.running).toBe(1);
  });
  it('D8: 첫 응답 뒤 갱신 실패는 경고로 · B2: 오래된 결과 경고 · A5: 맞은 VM 0 + 다른 vCenter 만 → 주소 불일치 경고', () => {
    expect(veeamSummary({ configured: true, servers: [sv()], byVm: {} }, { refreshError: '503' }).warnings[0]).toMatch(/최근 갱신에 실패했습니다.*503/);
    expect(veeamSummary({ configured: true, servers: [sv({ stale: true })], byVm: { a: {} } }).warnings.join()).toMatch(/오래됐습니다/);
    const mis = veeamSummary({ configured: true, servers: [sv()], byVm: {}, otherVcenter: 120 });
    expect(mis.warnings.join()).toMatch(/IP·FQDN/); expect(mis.tone).toBe('warn');
    expect(veeamSummary({ configured: true, servers: [sv()], byVm: { a: {} }, otherVcenter: 3 }).details.join()).toMatch(/정상/);
  });
  it('카드 칸: 오래됨·주소 불일치는 노란 칸 · 동명 VM·잔존 스냅샷 안내 · 새 사유 코드', () => {
    expect(backupCell({ src: 'veeam', n: 5, vmTotal: 9, stale: 1, partial: true }).title).toMatch(/1대의 결과가 오래됐습니다/);
    const hm = backupCell({ src: 'veeam', n: 0, vmTotal: 9, otherVcenter: 9, hostMismatch: true });
    expect(hm.tone).toBe('warn'); expect(hm.title).toMatch(/IP·FQDN/);
    const sn = backupCell({ src: 'snap', n: 3, vmTotal: 9, ambiguous: 2, snapStale: 1, partial: true, snapEv: 3, snapNow: 0 });
    expect(sn.title).toMatch(/이름이 같은 VM 이 둘 이상.*2건/); expect(sn.title).toMatch(/하루 넘게 남은.*1대/);
    expect(backupCell({ src: 'snap', n: null, reason: 'no-collect-yet' }).title).toMatch(/아직 한 번도 수집하지 못했습니다/);
  });
  it('D4: 칩 숫자는 서버 판정(verdict)을 따른다 — 계정 모름·오래됨이면 숫자 없이 이유', () => {
    const byVm = { a: [1, 1], b: [1, 2] };
    expect(veeamEventChip({ status: 'ok', byVm, verdict: { ok: true, reason: null } }).n).toBe(2);
    const st = veeamEventChip({ status: 'ok', byVm, collectedAt: new Date(2026, 9, 10, 6, 27).getTime(), verdict: { ok: false, reason: 'stale-events' } });
    expect(st.n).toBe(null); expect(st.why).toMatch(/2026-10-10 06:27/);
    expect(veeamEventChip({ status: 'ok', byVm: {}, verdict: { ok: false, reason: 'no-account' } }).why).toMatch(/계정을 아직 모릅니다/);
    expect(veeamEventChip({ status: 'ok', byVm }).n).toBe(2);   // 옛 서버(verdict 없음)는 예전처럼
    expect(veeamEventChip({ status: 'log-off' }).n).toBe(null);
  });
});

describe('v2.762 — Veeam 표시·수량 판정 점검 수정(웹)', () => {
  const sv = (o) => ({ name: 'VBR', ok: true, lastOkTs: 1, notes: [], ...o });
  it('F1: 첫 수집 전 서버가 있으면 카드(부분)와 같이 경고 · 실행 중·대기는 모름', () => {
    const s = veeamSummary({ configured: true, servers: [sv({ name: 'A' }), sv({ name: 'B', ok: null, lastOkTs: null })], byVm: { a: { run: 0 } } }, { vmTotal: 10 });
    expect(s.tone).toBe('warn'); expect(s.warnings.join()).toMatch(/B: 아직 읽은 결과가 없습니다/);
    expect(s.stats.running).toBe(null); expect(s.stats.pending).toBe(null); expect(s.details.join()).toMatch(/첫 수집 전인 Veeam 서버/);
    expect(veeamSummary({ configured: true, servers: [sv()], byVm: { a: { run: 1 } } }).tone).toBe('ok');
  });
  it('F2: 한 번도 성공 못한 실패 서버는 마지막 성공 값이 아니라 VM 이 빠졌다고 말한다', () => {
    const t = backupCell({ src: 'veeam', n: 2, vmTotal: 10, failed: 2, failedNoLast: 1, partial: true }).title;
    expect(t).toMatch(/1대를 이번에 읽지 못해 마지막 성공 값/); expect(t).toMatch(/1대는 아직 한 번도 읽지 못해 그 서버의 VM 이 빠졌습니다/);
    expect(backupCell({ src: 'veeam', n: 2, vmTotal: 10, failed: 1, partial: true }).title).toMatch(/1대를 이번에 읽지 못해 마지막 성공 값/);   // 옛 서버 응답
  });
  it('F3: 실패 우선 사유에 첫 수집 대기 수를 같이 말한다', () => {
    const c = backupCell({ src: 'veeam', n: null, vmTotal: 9, reason: 'veeam-failed', failed: 1, waiting: 1 });
    expect(c.text).toBe('—'); expect(c.title).toMatch(/한 번도 읽지 못했습니다/); expect(c.title).toMatch(/1대는 아직 첫 수집 전/);
  });
  it('F4: 등록부를 못 읽으면 기준을 단정하지 않는 확인 불가 칸', () => {
    const c = backupCell({ src: 'veeam', n: null, vmTotal: 9, reason: 'registry-unreadable' });
    expect(c.text).toBe('—'); expect(c.label).toBe('백업 · 확인 불가'); expect(c.tone).toBe('none');
    expect(c.title).toMatch(/^백업 수량을 알 수 없습니다/); expect(c.title).toMatch(/등록부를 읽지 못해/); expect(c.title).not.toMatch(/`/);
  });
  it('F5: 수가 없는(비관리자) 응답은 수 없이 말한다 · 관리자는 수', () => {
    const v = veeamSummary({ configured: true, servers: [sv()], byVm: {}, otherVcenter: null, hostMismatch: true });
    expect(v.warnings.join()).toMatch(/Veeam 이 적은 VM 이 모두 다른 vCenter/); expect(v.warnings.join()).not.toMatch(/null|undefined/);
    expect(veeamSummary({ configured: true, servers: [sv()], byVm: { a: {} }, otherVcenter: null }).details.join()).not.toMatch(/다른 vCenter/);
    const hm = backupCell({ src: 'veeam', n: 0, vmTotal: 9, otherVcenter: null, hostMismatch: true });
    expect(hm.title).toMatch(/Veeam 이 적은 VM 이 모두/); expect(hm.title).not.toMatch(/null/);
    expect(backupCell({ src: 'veeam', n: 0, vmTotal: 9, otherVcenter: 9, hostMismatch: true }).title).toMatch(/VM 9개가 모두/);
  });
  it('F6: 마지막 수집 안내는 서버가 준 한도(staleMs)를 쓴다 — 없으면 6시간', () => {
    const at = new Date(2026, 9, 22, 12, 0).getTime();
    const base = { status: 'ok', byVm: { a: [1, 1] }, accounts: 1, at, collectedAt: at - 11 * 3_600_000 };
    expect(veeamEventStatusText({ ...base, staleMs: 24.5 * 3_600_000 })).toBe('');
    expect(veeamEventStatusText(base)).toMatch(/마지막으로 수집한 시각/);
  });
});

describe('v2.763 — Veeam 등록·관리 화면 점검 수정(웹, 그룹 A)', () => {
  const S = { id: 's1', agent: '', enabled: true };
  it('V5-1: 진행 중 잠금은 그 서버의 그 버튼만 · 편집은 잠그지 않음 · 잠긴 버튼에 title', () => {
    const busy = new Set(['collect:s1', 'test:s2']);
    const a = Object.fromEntries(rowActions(S, busy).map((x) => [x.kind, x]));
    expect(a.collect.disabled).toBe(true); expect(a.collect.title).toMatch(/읽는 중/); expect(a.collect.label).toBe('읽는 중…');
    expect(a.test.disabled).toBe(false); expect(a.edit.disabled).toBe(false); expect(a.del.disabled).toBe(false);
    const b = Object.fromEntries(rowActions({ ...S, id: 's2' }, busy).map((x) => [x.kind, x]));
    expect([b.test.disabled, b.collect.disabled]).toEqual([true, false]);
    expect(b.test.title).toMatch(/진행 중/);
    const off = Object.fromEntries(rowActions({ ...S, enabled: false }, new Set()).map((x) => [x.kind, x]));
    expect(off.collect.disabled).toBe(true); expect(off.collect.title).toMatch(/꺼진/);
  });
  it('V2-1: 엣지의 중앙 배정 서버는 편집·삭제 대신 안내 — 연결 시험·지금 읽기는 그대로 · 남의 엣지 담당은 시험 버튼 없음', () => {
    const kinds = rowActions({ ...S, agent: 'pl-edge', readsHere: true, centralManaged: true }, new Set()).map((x) => x.kind);
    expect(kinds).toEqual(['test', 'collect', 'central']);
    expect(rowActions({ ...S, agent: 'pl-edge', readsHere: false }, new Set()).map((x) => x.kind)).toEqual(['edit', 'del']);
    const note = rowActions({ ...S, centralManaged: true }, new Set()).find((x) => x.kind === 'central');
    expect(note.title).toMatch(/중앙 포탈의 설정 › Veeam 백업 서버/); expect(note.title).not.toMatch(/`/);
  });
  it('V5-2: 읽는 곳 제안은 신규·미선택일 때만 — 사람이 고른 중앙 직접·기존 서버는 바꾸지 않는다', () => {
    expect(agentAfterVcToggle({ id: '', agent: '', agentTouched: false }, true, 'pl-edge')).toBe('pl-edge');
    expect(agentAfterVcToggle({ id: '', agent: '', agentTouched: true }, true, 'pl-edge')).toBe('', '사람이 고른 중앙에서 직접');
    expect(agentAfterVcToggle({ id: 'vbr-1', agent: '', agentTouched: true }, true, 'pl-edge')).toBe('', '편집 중 기존 서버');
    expect(agentAfterVcToggle({ id: 'vbr-1', agent: '', agentTouched: false }, true, 'pl-edge')).toBe('');
    expect(agentAfterVcToggle({ id: '', agent: 'kr-edge', agentTouched: false }, true, 'pl-edge')).toBe('kr-edge', '이미 고른 엣지는 그대로');
    expect(agentAfterVcToggle({ id: '', agent: '', agentTouched: false }, false, 'pl-edge')).toBe('', '체크 해제는 제안하지 않는다');
  });
  it('V5-4: 성공이라도 오래된 결과는 정상이라 말하지 않는다', () => {
    expect(statusCell({ ok: true, ts: 1, stale: true }).tone).toBe('warn');
    expect(statusCell({ ok: true, ts: 1, stale: true }).text).toMatch(/오래된 결과/);
    expect(statusCell({ ok: true, ts: 1 }).tone).toBe('ok');
  });
  it('V5-I1: 받은 뒤 갱신이 실패하면 옛 값에 최근 갱신 실패 표지(노란 칸) · 모름 칸은 색을 바꾸지 않는다', async () => {
    const fs = await import('node:fs');
    const e = { src: 'veeam', n: 5, vmTotal: 10, servers: 1 };
    const ok = backupCell(e);
    const bad = backupCell(e, null, Date.now(), { refreshError: 'HTTP 503' });
    expect(ok.tone).toBe('veeam'); expect(ok.refreshFailed).toBeUndefined();
    expect([bad.text, bad.tone, bad.refreshFailed]).toEqual([ok.text, 'warn', true]);
    expect(bad.title.split('\n')[0]).toMatch(/최근 갱신에 실패했습니다.*HTTP 503/);
    const unk = backupCell({ src: 'veeam', n: null, reason: 'veeam-failed' }, null, Date.now(), { refreshError: 'x' });
    expect(unk.tone).toBe('none'); expect(unk.title).toMatch(/최근 갱신에 실패/);
    const src = fs.readFileSync(new URL('./VCenters.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/refreshError: backupRefreshErr/);
  });
});
