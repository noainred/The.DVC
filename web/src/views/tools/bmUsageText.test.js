/**
 * bmUsageText.js 회귀(v2.550) — 고정하는 것은 **이 화면이 만들 수 있는 거짓**이다.
 */
import { describe, it, expect } from 'vitest';
import {
  pctText, bpsText, ageText, usageTone, toneVar, srcMark, SRC_MARK,
  emptyDiag, firstSampleNote, skippedNotes, detailNotes, retentionNote, edgeNote, missingMark, missingFootnotes, MISSING_MARK, authStopNote, keyConflictNote,
  facetRows, pathTypeLabel, topBusiest, corpSummary, csvOf, CSV_COLS, telemetryNote,
  // v2.554
  telemetryMissingText, licenseMark, licenseNote, enterpriseConsentNote, enterpriseStatusNote,
  entDetailNotes, unassignedNote, edgePullState, edgePullNote,
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
    expect(toneVar('idle')).toContain('--text-faint'); // v2.613 DEPS2613-11: 공용 toneVar(테마 토큰) — 모르는 톤은 회색
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

/* ══════════════ v2.554 — 라이선스 · Enterprise 대체 수집 · 귀속 원인 ═════════ */
describe('v2.554 — iDRAC 라이선스 인식과 Enterprise 대체 수집', () => {
  it('⚠⚠ 텔레메트리가 왜 비었는지를 라이선스 근거로 단정한다(추측 문구로 되돌리지 말 것)', () => {
    const s = telemetryMissingText({ license: { tier: 'enterprise', label: 'Enterprise' } });
    expect(s).toContain('Enterprise');
    expect(s).toContain('Datacenter');
    // 추측 어미('있습니다' 류의 가능성 표현)가 아니라 단정이어야 한다.
    expect(s).not.toContain('필요할 수 있습니다');
  });

  it('⚠ 등급을 못 읽었으면 단정하지 않는다', () => {
    const s = telemetryMissingText({});
    expect(s).toContain('읽지 못했습니다');
    expect(s).toContain('단정할 수 없습니다');
  });

  it('Datacenter 인데 비었으면 "등급 문제가 아니다" 라고 말한다', () => {
    expect(telemetryMissingText({ license: { tier: 'datacenter', label: 'Datacenter' } })).toContain('등급 문제가 아닙니다');
  });

  it('라이선스 표지는 미상일 때 아무것도 쓰지 않는다(빈 배지를 만들지 않는다)', () => {
    expect(licenseMark({ tier: 'unknown' })).toBe('');
    expect(licenseMark(null)).toBe('');
    expect(licenseMark({ tier: 'datacenter', label: 'Datacenter' })).toBe('Datacenter');
  });

  it('⚠ 라이선스 문구는 언제 본 값인지 밝힌다', () => {
    const s = licenseNote({ tier: 'enterprise', label: 'Enterprise', at: Date.now() - 600_000, count: 1 });
    expect(s).toContain('인벤토리');
  });

  it('동의 고지는 부하를 축소해 말하지 않는다(SSH·GET 을 명시)', () => {
    const s = enterpriseConsentNote();
    expect(s).toContain('SSH');
    expect(s).toContain('부하');
  });

  it('⚠ 예산으로 미룬 대수와 형식을 못 읽은 대수를 말한다', () => {
    const s = enterpriseStatusNote({ enterpriseActive: true, enterpriseMode: 'auto', last: { ent: { tried: 40, ok: 33, viaApi: 2, viaSsh: 31, deferred: 12, unparsed: 5 } } });
    expect(s).toContain('12대');
    expect(s).toContain('5대');
  });

  it('꺼져 있으면 상태 문구를 만들지 않는다', () => {
    expect(enterpriseStatusNote({ enterpriseActive: false })).toBe('');
    expect(enterpriseStatusNote({})).toBe('');
  });

  it('⚠ 최고치·평균 열을 읽었으면 "지금 부하가 아니다" 라고 말한다', () => {
    const out = entDetailNotes({ entTried: ['ssh'], entVia: 'ssh', entUsedCmd: 'racadm x', entUsedStat: { cpuPct: 'peak' } });
    expect(out.join(' ')).toContain('지금 부하가 아닙니다');
  });

  it('시도하지 않았으면 문구를 만들지 않는다', () => {
    expect(entDetailNotes({}).length).toBe(0);
  });

  it('⚠⚠ 귀속 없음은 원인별로 조치를 나눈다', () => {
    const r = unassignedNote({ total: 500, byCause: { 'registry-no-vc': 498, 'no-registry-match': 2 } });
    expect(r.head).toContain('500대');
    expect(r.items.length).toBe(2);
    expect(r.items[0]).toContain('일괄 지정');
    // ⚠ 자동 귀속을 제안하지 않는다(틀린 귀속은 법인 통계를 거짓으로 만든다).
    expect(r.how).not.toContain('자동으로 지정');
  });

  it('귀속 없음이 0이면 문구를 만들지 않는다', () => {
    expect(unassignedNote({ total: 0 })).toBe(null);
    expect(unassignedNote(null)).toBe(null);
  });

  it('⚠⚠ 엣지 보관분이 없는 것을 "정상" 으로 칠하지 않는다', () => {
    const s = edgePullState({ enabled: true, hasUrl: true });
    expect(s.state).toBe('never');
    expect(s.tone).not.toBe('ok');
  });

  it('구버전 엣지는 "기다리면 된다" 고 말하지 않는다', () => {
    const s = edgePullState({ enabled: true, hasUrl: true, lastAttempt: { ok: false, kind: 'old-version' } }, { minEdgeVersion: '2.554.0' });
    expect(s.why).toContain('업그레이드');
    expect(s.why).toContain('다시 눌러도 같습니다');
  });

  it('엣지에서 꺼져 있으면 중앙에서 켤 수 없다고 말한다', () => {
    const s = edgePullState({ enabled: true, hasUrl: true, snapAt: Date.now(), enabledOnEdge: false });
    expect(s.why).toContain('중앙에서는 켤 수 없습니다');
  });

  it('⚠ 값은 있는데 마지막 시도가 실패면 그 사실을 말한다(낡은 값을 지금 값인 척하지 않는다)', () => {
    const s = edgePullState({ enabled: true, hasUrl: true, snapAt: Date.now(), lastAttempt: { ok: false, kind: 'timeout', reason: 'x' } });
    expect(s.state).toBe('stale-failed');
  });

  it('엣지 패널 머리말은 상시 전송이 없다는 사실을 말한다', () => {
    expect(edgePullNote([{ snapAt: 1 }, {}])).toContain('누를 때만');
  });

  it('값 출처 표지에 대체 경로가 구분돼 있다', () => {
    expect(srcMark('idrac-ent')).toContain('대체');
  });

  it('⚠ v2.554 문구에도 백틱이 없다(BoldText 는 `**` 만 해석 — v2.553 규약)', () => {
    const all = [
      telemetryMissingText({ license: { tier: 'enterprise', label: 'E' } }), telemetryMissingText({}),
      licenseNote({ tier: 'enterprise', label: 'E', at: 1 }), licenseNote({ count: 0 }),
      enterpriseConsentNote(),
      enterpriseStatusNote({ enterpriseActive: true, last: { ent: { tried: 1, ok: 0, deferred: 1, unparsed: 1 } } }),
      ...entDetailNotes({ entTried: ['api'], entKind: 'unparsed' }),
      unassignedNote({ total: 1, byCause: { 'edge-no-vc': 1, 'assign-ghost': 1, 'registry-no-vc': 1, 'no-registry-match': 1 } }).head,
      ...unassignedNote({ total: 1, byCause: { 'edge-no-vc': 1, 'assign-ghost': 1 } }).items,
      unassignedNote({ total: 1, byCause: {} }).how,
      edgePullState({ enabled: true, hasUrl: true }).why,
      edgePullNote([{ snapAt: 1 }]),
    ];
    for (const s of all) expect(String(s)).not.toContain('`');
  });
});

describe('v2.591 — 403 은 자격증명 거부가 아니다(감사 R-BM2)', () => {
  it('텔레메트리 forbidden 은 비밀번호 문제가 아니라고 말하고 auth 문구와 다르다', () => {
    const f = detailNotes({ idracKind: 'forbidden' }).join(' ');
    expect(f).toContain('403');
    expect(f).toContain('멈추지 않습니다');
    expect(f).not.toContain('계정·비밀번호를 확인하세요');
    expect(detailNotes({ idracKind: 'auth' }).join(' ')).toContain('계정·비밀번호를 확인하세요');
  });

  it('대체 경로 auth 는 401 만 · forbidden 은 권한 문제로 따로 말한다', () => {
    expect(entDetailNotes({ entTried: ['api'], entKind: 'auth' }).join(' ')).toContain('(401)');
    expect(entDetailNotes({ entTried: ['api'], entKind: 'auth' }).join(' ')).not.toContain('401/403');
    const f = entDetailNotes({ entTried: ['api'], entKind: 'forbidden' }).join(' ');
    expect(f).toContain('403');
    expect(f).toContain('멈추지 않습니다');
  });

  it('정지 안내는 수동 성공이 주 전력 수집 정지도 푼다는 사실을 말한다', () => {
    expect(authStopNote([{ key: 'a', since: 1 }], { now: 10 })).toContain('주 전력 수집의 정지도 함께 풀립니다');
  });
});

describe('csvOf 수식 가드(v2.596 SECWEB-01)', () => {
  it('서버 이름이 = + - @ 로 시작하면 엑셀 수식이 되지 않게 막는다 · 빈 값은 빈 칸', () => {
    const out = csvOf([{ name: '=cmd|calc!A1', paths: ['os'], src: {} }]);
    expect(out).toContain("'=cmd|calc!A1");
    expect(out).not.toMatch(/(^|,)=cmd/m);
  });
});

// v2.605 LEFT2605-05 — 호스트 미수집 vCenter 때문에 뺀 베어메탈 안내
import { hostsUnreadNote as _hun } from './bmUsageText.js';
describe('v2.605 hostsUnreadNote', () => {
  it('뺀 대수와 vCenter 를 말하고, 없으면 문구를 만들지 않는다', () => {
    expect(_hun(null)).toBe('');
    expect(_hun({ vcenters: [], withheld: [], expired: [], dropped: 0 })).toBe('');
    const t = _hun({ vcenters: ['vcD'], withheld: ['vcD'], expired: [], dropped: 2 });
    expect(t).toMatch(/vCenter 1개/);
    expect(t).toMatch(/베어메탈 2대/);
    expect(t).not.toMatch(/`/);
    const e = _hun({ vcenters: ['vcD'], withheld: [], expired: ['vcD'], dropped: 0, withholdMaxMs: 6 * 3_600_000 });
    expect(e).toMatch(/6시간/);
    expect(e).toMatch(/다시 수집/);
  });
});
