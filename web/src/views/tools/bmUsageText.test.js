/**
 * bmUsageText.js 회귀(v2.550) — 고정하는 것은 **이 화면이 만들 수 있는 거짓**이다.
 */
import { describe, it, expect } from 'vitest';
import {
  pctText, bpsText, ageText, usageTone, toneVar, srcMark, SRC_MARK,
  emptyDiag, firstSampleNote, skippedNotes, detailNotes, retentionNote, edgeNote, missingMark, missingFootnotes, MISSING_MARK, authStopNote, keyConflictNote,
  facetRows, pathTypeLabel, topBusiest, corpSummary, csvOf, CSV_COLS, telemetryNote,
} from './bmUsageText.js';

const NOW = 1_700_000_000_000;

describe('값 표기', () => {
  it('결측은 — 이고 0% 가 아니다', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(undefined)).toBe('—');
    expect(pctText('')).toBe('—');
    expect(pctText(0)).toBe('0%');       // 진짜 0 은 0% 다
    expect(bpsText(null)).toBe('—');
    expect(bpsText(0)).toBe('0 B/s');
  });
  it('값이 없으면 단위를 붙이지 않는다(— % 는 0℃ 처럼 읽힌다 — v2.534)', () => {
    expect(pctText(null)).not.toContain('%');
  });
  it('처리량은 크기에 따라 단위를 고른다', () => {
    expect(bpsText(500)).toContain('B/s');
    expect(bpsText(125e6)).toContain('MB/s');
    expect(bpsText(5e9)).toContain('GB/s');
  });
  it('결측은 회색이다 — 빨강이 아니다', () => {
    expect(usageTone(null)).toBe('idle');
    expect(toneVar('idle')).toContain('--muted');
    expect(usageTone(50)).toBe('ok');
    expect(usageTone(80)).toBe('warn');
    expect(usageTone(95)).toBe('bad');
  });
  it('시각이 없으면 —', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(0)).toBe('—');
    expect(ageText(NOW - 90_000, NOW)).toBe('2분 전');
  });
});

describe('값의 출처', () => {
  it('OS·iDRAC 를 구분해 밝힌다 — 같은 서버의 CPU 를 둘이 다르게 말할 수 있다', () => {
    expect(srcMark('os')).toBe('OS');
    expect(srcMark('idrac')).toBe('iDRAC');
    expect(srcMark('idrac+os')).toBe('OS·iDRAC');
    expect(srcMark('')).toBe('');
    for (const v of Object.values(SRC_MARK)) expect(v).toBeTruthy();
  });
});

describe('빈 화면 판정 — 행동이 정반대인 상황을 한 문구로 덮지 않는다', () => {
  it('꺼짐: 켜라고 말한다(기다려도 안 된다)', () => {
    const d = emptyDiag({ enabled: false });
    expect(d.kind).toBe('off');
    expect(d.waiting).toBe(false);
    expect(d.text).toContain('꺼져 있습니다');
  });
  it('법인 미선택: 고르라고 말한다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: {} } });
    expect(d.kind).toBe('no-corp');
    expect(d.waiting).toBe(false);
  });
  it('대상 0: 사유별 개수를 말한다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [], skippedCounts: { 'edge-delegated': 12, 'no-os-cred': 3 } });
    expect(d.kind).toBe('no-target');
    expect(d.text).toContain('12대');
    expect(d.text).toContain('3대');
  });
  it('첫 수집: 기다리면 된다고 말한다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], rows: [], status: {} });
    expect(d.kind).toBe('first');
    expect(d.waiting).toBe(true);
  });
  it('수집 실패: 기다려도 안 된다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], rows: [], status: { last: { at: NOW, error: '연결 거부' } } }, { now: NOW });
    expect(d.kind).toBe('failed');
    expect(d.waiting).toBe(false);
    expect(d.text).toContain('연결 거부');
  });
  it('DB 불가: 최신값은 보이지만 이력이 안 쌓인다고 말한다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], db: { available: false } });
    expect(d.kind).toBe('no-db');
  });
  it('값은 있는데 자동 수집이 멈추면 초록 정상을 두지 않는다', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], rows: [1], status: { intervalMs: 300_000, last: { at: NOW - 3_600_000 } } }, { now: NOW });
    expect(d.kind).toBe('stale');
  });
  it('정상이면 문구를 만들지 않는다(같은 말이 화면을 덮지 않게)', () => {
    const d = emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], rows: [1], status: { intervalMs: 300_000, last: { at: NOW - 60_000 } } }, { now: NOW });
    expect(d.kind).toBe('ok');
    expect(d.text).toBe('');
  });
});

describe('첫 주기 안내', () => {
  it('Linux 와 Windows 의 차이를 말한다', () => {
    const s = firstSampleNote([{ cpu_pct: null, mem_pct: 39 }, { cpu_pct: 20, mem_pct: 50 }]);
    expect(s).toContain('1대');
    expect(s).toContain('첫 주기');
    expect(s).toContain('Windows');
  });
  it('해당 없으면 문구를 만들지 않는다', () => {
    expect(firstSampleNote([{ cpu_pct: 20, mem_pct: 50 }])).toBe('');
    expect(firstSampleNote([])).toBe('');
  });
});

describe('대상이 아닌 서버', () => {
  it('있는 사유만 한 번씩 적는다', () => {
    const notes = skippedNotes({ 'edge-delegated': 2, 'corp-off': 0, 'no-idrac': 1 }, { 'edge-delegated': 'A', 'no-idrac': 'B' });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('엣지 수집 2대');
    expect(notes[1]).toContain('iDRAC 등록 없음 1대');
  });
  it('없으면 빈 배열', () => {
    expect(skippedNotes({}, {})).toEqual([]);
  });
});

describe('상세 안내', () => {
  it("'없는 것' 을 '확인 불가' 라 하지 않는다", () => {
    const s = detailNotes({ osKind: 'linux', osRead: ['cpu'], osAbsent: ['hba'] }).join(' ');
    expect(s).toContain('FC HBA 가 없습니다');
    expect(s).toContain('이상이 아니라');
  });
  it('텔레메트리 없음은 라이선스를 말하고 OS 경로로 대체 가능함을 알린다', () => {
    const s = detailNotes({ idracKind: 'no-telemetry' }).join(' ');
    expect(s).toContain('Datacenter');
    expect(s).toContain('OS 계정');
  });
  it('메트릭 id 를 찾지 못한 경우를 따로 말한다', () => {
    const s = detailNotes({ idracKind: 'ids-unmatched', idracSeenIds: ['a', 'b'] }).join(' ');
    expect(s).toContain('아는 메트릭 id 를 찾지 못했습니다');
    expect(s).toContain('2개');
  });
  it('속도를 모르는 회선은 퍼센트를 내지 않는다고 말한다', () => {
    const s = detailNotes({ interfaces: [{ bps: 1e6, bitsPerSec: null }] }).join(' ');
    expect(s).toContain('링크 속도를 읽지 못한 인터페이스 1개');
  });
  it('해당 없으면 빈 배열', () => {
    expect(detailNotes({})).toEqual([]);
  });
});

describe('보존·엣지 안내', () => {
  it('보존 숫자는 서버 값으로만 만든다', () => {
    const s = retentionNote({ rawRetentionDays: 90, dailyRetentionDays: 1825 }, { rawRows: 5180000 });
    expect(s).toContain('90일');
    expect(s).toContain('5년');
    expect(s).toContain('5,180,000행');
    expect(retentionNote({}, {})).toBe('');
  });
  it('엣지에서는 자기 것만 수집한다고 말한다', () => {
    expect(edgeNote(false)).toBe('');
    expect(edgeNote(true)).toContain('엣지');
  });
});

describe('행 단위 누락 표지', () => {
  it('짧은 표지만 만든다(행마다 긴 문장을 넣지 않는다)', () => {
    expect(missingMark([])).toBe('');
    expect(missingMark(['no-os-cred'])).toBe('OS 계정 없음');
    expect(missingMark(['no-os-cred', 'no-idrac'])).toBe('OS 계정 없음 · iDRAC 등록 없음');
    for (const v of Object.values(MISSING_MARK)) expect(v.length).toBeLessThan(14);
  });
  it('각주는 표에 실제로 있는 종류만 한 번씩', () => {
    expect(missingFootnotes([])).toEqual([]);
    expect(missingFootnotes([{ missing: [] }])).toEqual([]);
    const f = missingFootnotes([{ missing: ['no-os-cred'] }, { missing: ['no-os-cred'] }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('베어메탈 스토리지');
    expect(missingFootnotes([{ missing: ['no-os-cred'] }, { missing: ['no-idrac'] }])).toHaveLength(2);
  });
});

describe('인증 실패 정지 — 조용히 멈추지 않는다', () => {
  it('정지가 없으면 문구를 만들지 않는다', () => {
    expect(authStopNote([])).toBe('');
    expect(authStopNote(null)).toBe('');
  });
  it('몇 대인지·언제부터인지·무엇을 하면 되는지 말한다', () => {
    const s = authStopNote([{ key: 'A', name: 'bm-01', since: NOW - 3_600_000, attempts: 3 }], { now: NOW });
    expect(s).toContain('1대');
    expect(s).toContain('bm-01');
    expect(s).toContain('1시간 전');
    expect(s).toContain('계정만 잠급니다');
    expect(s).toContain('자동으로 재개');
    expect(s).toContain("'지금 수집'");
  });
  it('많으면 일부만 나열하고 나머지는 개수로 밝힌다', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ key: `K${i}`, name: `bm-${i}`, since: NOW }));
    const s = authStopNote(many, { now: NOW });
    expect(s).toContain('9대는');
    expect(s).toContain('외 5대');
  });
});

describe('키 충돌 — 오류 없이 틀린 값을 만드는 종류다(v2.550.3)', () => {
  it('충돌이 없으면 문구를 만들지 않는다', () => {
    expect(keyConflictNote([])).toBe('');
    expect(keyConflictNote(null)).toBe('');
  });
  it('몇 건인지·무엇이 겹쳤는지·왜 위험한지·어떻게 고치는지 말한다', () => {
    const s = keyConflictNote([{ key: 'DUP1', names: ['bm-a', 'bm-b'], vcenterId: 'vc1' }]);
    expect(s).toContain('1건');
    expect(s).toContain('DUP1');
    expect(s).toContain('bm-a');
    expect(s).toContain('다른 서버 것으로 보입니다');
    expect(s).toContain('서비스태그를 채우면');
  });
  it('수집에서 빼지 않았다는 사실도 말한다(사용자가 사라진 서버를 찾지 않게)', () => {
    expect(keyConflictNote([{ key: 'A', names: ['x', 'y'] }])).toContain('빼지는 않았습니다');
  });
  it('많으면 일부만 나열하고 나머지는 개수로', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ key: `K${i}`, names: [`a${i}`, `b${i}`] }));
    const s = keyConflictNote(many);
    expect(s).toContain('7건');
    expect(s).toContain('외 4건');
  });
});

describe('집계·상위N·CSV (v2.551)', () => {
  const rows = [
    { key: 'A', name: 'a', vcenterId: 'vc1', paths: ['idrac', 'os'], cpu_pct: 91.5, mem_pct: 88, ts: NOW, src: 'os' },
    { key: 'B', name: 'b', vcenterId: 'vc1', paths: ['idrac'], cpu_pct: null, mem_pct: 44, ts: NOW, src: 'idrac' },
    { key: 'C', name: 'c', vcenterId: 'vc2', paths: ['idrac', 'os'], cpu_pct: 20, mem_pct: 61, ts: NOW, src: 'os' },
  ];
  it('공용 facetState 가 읽는 축을 붙인다 — 종류는 수집 경로다', () => {
    const f = facetRows(rows);
    expect(f.map((r) => r.type)).toEqual(['idrac+os', 'idrac', 'idrac+os']);
    expect(f.map((r) => r.datacenterId)).toEqual(['vc1', 'vc1', 'vc2']);
    expect(pathTypeLabel('idrac+os')).toBe('iDRAC·OS');
    expect(pathTypeLabel('idrac')).toBe('iDRAC 만');
  });
  it("⚠ 값이 없는 서버를 0 으로 줄 세우지 않는다 — 제외하고 개수를 밝힌다", () => {
    const t = topBusiest(rows, { metric: 'cpu_pct', limit: 5 });
    expect(t.list.map((r) => r.name)).toEqual(['a', 'c']);
    expect(t.excluded).toBe(1);
  });
  it('법인 집계의 평균은 읽은 대수 기준이다(못 읽은 서버가 평균을 끌어내리지 않게)', () => {
    const c = corpSummary(rows, { metric: 'cpu_pct' });
    const vc1 = c.find((x) => x.vcenterId === 'vc1');
    expect(vc1.servers).toBe(2);
    expect(vc1.n).toBe(1);
    expect(vc1.avg).toBe(91.5);
    expect(vc1.unread).toBe(1);
    expect(vc1.over90).toBe(1);
  });
  it('읽은 대수가 0 이면 평균은 null 이다(0 이 아니다)', () => {
    const c = corpSummary([{ key: 'X', vcenterId: 'vc9', cpu_pct: null }], { metric: 'cpu_pct' });
    expect(c[0].avg).toBeNull();
    expect(c[0].max).toBeNull();
  });
  it('귀속 없는 서버를 아무 법인에 넣지 않는다', () => {
    const c = corpSummary([{ key: 'X', vcenterId: '', cpu_pct: 10 }]);
    expect(c[0].vcenterId).toBe('(귀속 없음)');
  });
  it('⚠ CSV 는 값이 없으면 빈 칸이다 — 0 을 쓰지 않는다(엑셀에서 0 은 부하 없음으로 읽힌다)', () => {
    const csv = csvOf(rows);
    const lines = csv.split('\n');
    expect(lines[0].split(',')).toHaveLength(CSV_COLS.length);
    const b = lines.find((l) => l.startsWith('b,'));
    // CPU 열이 빈 칸이어야 한다(쉼표가 연달아 온다)
    expect(b).toMatch(/,,44,/);
    expect(b).not.toMatch(/,0,44,/);
  });
  it('CSV 에 자격증명·호스트 주소 열이 없다', () => {
    const keys = CSV_COLS.map(([k]) => k).join(' ');
    for (const bad of ['password', 'idracHost', 'osHostName', 'username']) expect(keys).not.toContain(bad);
  });
  it('CSV 는 쉼표·따옴표를 이스케이프한다', () => {
    const csv = csvOf([{ key: 'K', name: 'a,b"c', cpu_pct: 1 }]);
    expect(csv).toContain('"a,b""c"');
  });
});

describe('iDRAC 텔레메트리 안내 (v2.551 — 장비별로 무엇을 읽었는지 밝힌다)', () => {
  it('읽은 리포트 수와 전체 수를 말한다', () => {
    const s = telemetryNote({ idracSeenReports: ['SystemUsage', 'NICStatistics', 'ThermalSensor'], idracReports: ['SystemUsage', 'NICStatistics'], idracAbsent: [] });
    expect(s).toContain('3종');
    expect(s).toContain('2종');
    expect(s).toContain('NICStatistics');
  });
  it('없는 리포트는 원인과 대안을 말한다', () => {
    const s = telemetryNote({ idracSeenReports: ['SystemUsage'], idracReports: ['SystemUsage'], idracAbsent: ['net', 'hba', 'disk', 'diskbusy'] });
    expect(s).toContain('Datacenter');
    expect(s).toContain('OS 계정');
  });
  it('디스크 busy% 가 이 경로에 없다는 사실을 따로 말한다', () => {
    const s = telemetryNote({ idracSeenReports: ['StorageDiskSMARTData'], idracReports: ['StorageDiskSMARTData'], idracAbsent: ['diskbusy'] });
    expect(s).toContain('사용률(busy%)');
  });
  it('정보가 없으면 문구를 만들지 않는다', () => {
    expect(telemetryNote({})).toBe('');
  });
});

describe('마크다운 누출 방지', () => {
  it('BoldText 가 못 그리는 백틱을 문구에 넣지 않는다', () => {
    const all = [
      emptyDiag({ enabled: false }).text,
      emptyDiag({ enabled: true, settings: { corps: {} } }).text,
      emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [], skippedCounts: { 'no-os-cred': 1 } }).text,
      emptyDiag({ enabled: true, settings: { corps: { a: true } }, targets: [1], rows: [], status: {} }).text,
      firstSampleNote([{ cpu_pct: null, mem_pct: 1 }]),
      ...skippedNotes({ 'no-idrac': 1 }, { 'no-idrac': 'x' }),
      ...detailNotes({ osKind: 'linux', osRead: ['cpu'], osAbsent: ['hba', 'diskspace'], idracKind: 'no-telemetry', interfaces: [{ bps: 1, bitsPerSec: null }] }),
      retentionNote({ rawRetentionDays: 90, dailyRetentionDays: 1825 }, {}),
      edgeNote(true),
      ...missingFootnotes([{ missing: ['no-os-cred', 'no-idrac', 'no-idrac-cred'] }]),
      missingMark(['no-os-cred']),
      authStopNote([{ key: 'A', name: 'n', since: NOW }], { now: NOW }),
      keyConflictNote([{ key: 'A', names: ['x', 'y'] }]),
      telemetryNote({ idracSeenReports: ['A', 'B'], idracReports: ['A'], idracAbsent: ['net', 'hba', 'disk', 'diskbusy'] }),
    ];
    for (const s of all) expect(s).not.toContain('`');
  });
});
