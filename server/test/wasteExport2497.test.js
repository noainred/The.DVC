// v2.497 — 낭비 리소스 엑셀 내보내기 회귀 고정(순수 모듈 3종 + zipMany).
// (1) zipMany: 다중 항목 ZIP 구조(로컬 헤더 오프셋·EOCD 개수·UTF-8 플래그·라운드트립),
// (2) wasteExport: 시트 6개·열이 화면 표와 1:1·리포트 링크 셀은 상대경로 ASCII·CPU/메모리 같은 VM → 같은 파일·
//     조회 실패/상한 생략은 링크 대신 사유 텍스트, (3) rightsizeHtml: 이스케이프·판정·SVG 유무.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zipMany, zipSingle } from '../src/util/zip.js';
import { buildWasteSheets, reportTargets, reportFileName, exportZipName, LINK } from '../src/tools/wasteExport.js';
import { renderRightsizeHtml, svgLineChart } from '../src/tools/rightsizeHtml.js';
import { analyzeRightsize } from '../src/tools/rightsize.js';

/* ── zipMany ─────────────────────────────────────────────────────── */
test('zipMany: 항목 3개 — 로컬 헤더 오프셋·중앙 디렉터리·EOCD 개수가 맞고 각 항목이 라운드트립된다', () => {
  const entries = [
    { name: 'waste.xlsx', data: Buffer.from('X'.repeat(3000)) },
    { name: 'reports/vm-a-12345678.html', data: '<html>a</html>' },
    { name: 'reports/한글-이름.html', data: Buffer.from('한글 본문', 'utf8') },
  ];
  const zip = zipMany(entries);
  // EOCD
  const eocdAt = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdAt), 0x06054b50);
  assert.equal(zip.readUInt16LE(eocdAt + 8), 3);
  assert.equal(zip.readUInt16LE(eocdAt + 10), 3);
  const cdSize = zip.readUInt32LE(eocdAt + 12);
  const cdOff = zip.readUInt32LE(eocdAt + 16);
  assert.equal(cdOff + cdSize, eocdAt);
  // 중앙 디렉터리 순회 → 각 로컬 헤더에서 데이터 꺼내 inflate
  let p = cdOff;
  for (const e of entries) {
    assert.equal(zip.readUInt32LE(p), 0x02014b50);
    assert.equal(zip.readUInt16LE(p + 8) & 0x0800, 0x0800, 'UTF-8 파일명 플래그');
    const nameLen = zip.readUInt16LE(p + 28);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(name, e.name);
    assert.equal(zip.readUInt32LE(localOff), 0x04034b50);
    const lNameLen = zip.readUInt16LE(localOff + 26);
    const compLen = zip.readUInt32LE(localOff + 18);
    const comp = zip.subarray(localOff + 30 + lNameLen, localOff + 30 + lNameLen + compLen);
    const expected = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    assert.deepEqual(zlib.inflateRawSync(comp), expected);
    p += 46 + nameLen;
  }
  assert.equal(p, eocdAt);
});

test('zipMany: 이름 중복·빈 이름·상한 초과는 throw, zipSingle 은 기존 형식 그대로', () => {
  assert.throws(() => zipMany([{ name: 'a', data: '1' }, { name: 'a', data: '2' }]), /중복/);
  assert.throws(() => zipMany([{ name: '', data: '1' }]), /비어/);
  assert.throws(() => zipMany([{ name: 'a', data: '1' }, { name: 'b', data: '2' }], { maxEntries: 1 }), /상한/);
  assert.throws(() => zipMany([{ name: 'a', data: 'x'.repeat(100) }], { maxBytes: 10 }), /상한/);
  const z = zipSingle('a.csv', 'abc');
  assert.equal(z.readUInt16LE(6), 0); // 단일 파일 플래그는 그대로 0(바이트 호환)
  assert.equal(z.readUInt16LE(z.length - 22 + 8), 1);
});

/* ── wasteExport 시트 모델 ───────────────────────────────────────── */
const vmA = { id: 'vc1:vm-1', name: '웹서버 A/1', vcenterId: 'vc1', host: 'esx1', guestOS: 'RHEL 9', vcpu: 8, cpuAllocMhz: 19200, cpuUsedMhz: 1920, cpuIdleMhz: 17280, cpuUsagePct: 10, cpuSavingPct: 90, memAllocGB: 64, memUsedGB: 6.4, memIdleGB: 57.6, memUsagePct: 10, memSavingPct: 90 };
const vmB = { id: 'vc2:vm-2', name: 'db-b', vcenterId: 'vc2', host: 'esx2', guestOS: 'Windows', vcpu: 4, cpuAllocMhz: 9600, cpuUsedMhz: 960, cpuIdleMhz: 8640, cpuUsagePct: 10, cpuSavingPct: 90, memAllocGB: 32, memUsedGB: 8, memIdleGB: 24, memUsagePct: 25, memSavingPct: 75 };
const vmC = { id: 'vc1:vm-3', name: 'app-c', vcenterId: 'vc1', host: 'esx1', guestOS: 'Ubuntu', memAllocGB: 16, memUsedGB: 2, memIdleGB: 14, memUsagePct: 12, memSavingPct: 88 };
const waste = {
  overAllocated: {
    thresholds: { cpuIdlePct: 20, memIdlePct: 40 }, excludedNoHostMhz: 2,
    cpu: { allocGHz: 100, usedGHz: 10, idleGHz: 90, usedPct: 10, savingPct: 90, candidates: 2 },
    mem: { allocGB: 200, usedGB: 40, idleGB: 160, usedPct: 20, savingPct: 80, candidates: 3 },
    cpuTop: [vmA, vmB], memTop: [vmA, vmC, vmB],
  },
  poweredOff: { count: 2, storageGB: 300, vms: [{ id: 'vc1:vm-9', name: 'old', vcenterId: 'vc1', storageGB: 200, guestOS: 'CentOS' }, { id: 'vc2:vm-8', name: 'old2', vcenterId: 'vc2', storageGB: 100 }] },
  snapshots: { count: 1, sizeGB: 12.5, vms: [{ id: 'vc1:vm-5', name: 'snapvm', vcenterId: 'vc1', snapshotCount: 3, snapshotSizeGB: 12.5 }] },
  thinReclaim: { count: 4, reclaimableGB: 512 },
  noTools: { count: 1, vms: [{ id: 'vc1:vm-6', name: 'notools', vcenterId: 'vc1', toolsStatus: 'NOT_RUNNING' }] },
  byVcenter: [{ vcenterId: 'vc1', vms: 10, poweredOff: 1, poweredOffGB: 200, snapshots: 1, snapshotGB: 12.5, noTools: 1, thinReclaimGB: 500, cpuCandidates: 1, memCandidates: 2 }, { vcenterId: 'vc2', vms: 5, poweredOff: 1, poweredOffGB: 100, snapshots: 0, snapshotGB: 0, noTools: 0, thinReclaimGB: 12, cpuCandidates: 1, memCandidates: 1 }],
};

test('reportTargets: CPU ∪ 메모리 상위, VM id 로 중복 제거·순서 유지', () => {
  assert.deepEqual(reportTargets(waste).map((v) => v.id), ['vc1:vm-1', 'vc2:vm-2', 'vc1:vm-3']);
});

test('reportFileName/exportZipName: ASCII 상대경로·id 해시로 구분·ZIP 파일명 ASCII', () => {
  const f = reportFileName(vmA);
  assert.match(f, /^reports\/[A-Za-z0-9._-]+-[0-9a-f]{8}\.html$/, f); // 한글·공백·슬래시 제거
  assert.notEqual(reportFileName(vmA), reportFileName({ ...vmA, id: 'vc1:vm-99' }));   // 같은 이름·다른 id → 다른 파일
  assert.equal(reportFileName(vmA), reportFileName({ id: vmA.id, name: vmA.name }));  // 같은 VM → 같은 파일(CPU·메모리 시트 공유)
  const z = exportZipName({ scope: 'vc 한글', cluster: 'Cluster A', at: Date.UTC(2026, 8, 12, 3, 4) });
  assert.match(z, /^waste-vc-Cluster-A-\d{8}-\d{4}\.zip$/, z);
  assert.match(exportZipName({}), /^waste-all-\d{8}-\d{4}\.zip$/);
});

test('buildWasteSheets: 시트 6개 · 화면 열과 1:1 · 링크/실패/생략 셀 · vCenter 별 현황 섹션', () => {
  const reports = new Map([
    [vmA.id, { file: reportFileName(vmA), verdict: { state: 'reduce', title: '감축 가능', summary: 'vCPU 8 → 4' } }],
    [vmB.id, { error: 'vCenter 성능 조회 실패: timeout' }],
    [vmC.id, { skipped: '상한 200대' }],
  ]);
  const offSince = { rows: [{ id: 'vc1:vm-9', offSince: Date.UTC(2026, 0, 15), offDays: 240, source: 'event', exact: true }], sources: {} };
  const sheets = buildWasteSheets({ waste, offSince, reports, scopeLabel: 'all', days: 30, full: false, generatedAt: Date.UTC(2026, 8, 12), reportNote: '리포트 1건 생성' });
  assert.deepEqual(sheets.map((s) => s.name), ['요약', '전원 꺼짐', '스냅샷', 'Tools 미실행', 'CPU 과할당', '메모리 과할당']);
  // 요약: vCenter 별 현황 섹션
  const sum = sheets[0];
  assert.equal(sum.section.title, 'vCenter 별 현황');
  assert.deepEqual(sum.section.rows.map((r) => r.vcenterId), ['vc1', 'vc2']);
  assert.ok(sum.rows.some((r) => String(r.v).includes('ZIP 을 압축 해제')), 'ZIP 해제 안내');
  // 전원 꺼짐: 꺼진 지 병합
  const off = sheets[1];
  assert.deepEqual(off.columns.map((c) => c.header), ['VM', 'vCenter', 'OS', '스토리지(GB)', '꺼진 지(일)', '꺼진 시각', '정확도', '출처']);
  assert.equal(off.rows[0].offDays, 240); assert.equal(off.rows[0].source, '이벤트'); assert.equal(off.rows[0].exact, '정확');
  assert.equal(off.rows[1].offDays, null); assert.equal(off.rows[1].source, '');
  // CPU: 열 = 화면 표(스파크라인 제외) + 판정 + 근거 리포트
  const cpu = sheets[4];
  assert.deepEqual(cpu.columns.map((c) => c.header), ['VM', 'vCenter', 'vCPU', '할당 clock(GHz)', '사용 clock(GHz)', '미사용 clock(GHz)', '사용률(%)', '절감 가능(%)', 'ESXi 호스트', '판정(최근 30일)', '근거 리포트']);
  assert.equal(cpu.rows[0].cpuAllocGHz, 19.2); assert.equal(cpu.rows[0].cpuIdleGHz, 17.28);
  assert.equal(typeof cpu.rows[0].report, 'object'); assert.equal(cpu.rows[0].report.hyperlink, reportFileName(vmA));
  assert.match(cpu.rows[0].verdict, /감축 가능 — vCPU 8 → 4/);
  assert.equal(typeof cpu.rows[1].report, 'string'); assert.match(cpu.rows[1].verdict, /조회 실패: vCenter 성능 조회 실패/);
  // 메모리: 같은 VM(A) 은 같은 파일, 생략(C) 은 사유
  const mem = sheets[5];
  assert.equal(mem.rows[0].report.hyperlink, cpu.rows[0].report.hyperlink);
  assert.match(mem.rows[1].verdict, /리포트 생략\(상한 200대\)/); assert.equal(typeof mem.rows[1].report, 'string');
  assert.equal(mem.rows[2].memIdleGB, 24);
  assert.ok(cpu.notes.some((n) => n.includes('2대는 CPU clock 집계에서 제외')));
  assert.equal(LINK('t', 'u').hyperlink, 'u');
});

/* ── rightsizeHtml ───────────────────────────────────────────────── */
function synthSeries(days, intervalSec, base, amp) {
  const n = Math.floor((days * 86_400) / intervalSec); const start = Date.UTC(2026, 8, 1);
  return Array.from({ length: n }, (_, i) => ({ t: new Date(start + i * intervalSec * 1000).toISOString(), v: base + (i % 5) * amp }));
}

test('renderRightsizeHtml: 판정·차트 SVG·이스케이프·참고 문서 링크', () => {
  const vm = { id: 'vc1:vm-1', name: 'evil<script>alert(1)</script>', vcenterId: 'vc1', host: 'esx1', guestOS: 'RHEL "9"', powerState: 'POWERED_ON', cpuCount: 8, memMB: 65536 };
  const series = {
    cpuUsageMhz: synthSeries(30, 7200, 1500, 50), cpuUsagePct: synthSeries(30, 7200, 8, 1), cpuReadyMs: synthSeries(30, 7200, 100, 10),
    memActiveMB: synthSeries(30, 7200, 4000, 100), memConsumedMB: synthSeries(30, 7200, 30000, 100), memBalloonMB: synthSeries(30, 7200, 0, 0), memSwappedMB: synthSeries(30, 7200, 0, 0), memUsagePct: synthSeries(30, 7200, 6, 1),
  };
  const report = analyzeRightsize({ vm, hostMhzPerCore: 2400, intervalSec: 7200, days: 30, series, now: Date.UTC(2026, 8, 30) });
  const html = renderRightsizeHtml({ report: { ...report, series }, vm, days: 30, generatedAt: Date.UTC(2026, 8, 12) });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>'), '스크립트 태그가 그대로 들어가면 안 된다');
  assert.ok(html.includes('evil&lt;script&gt;'), '이스케이프된 이름');
  assert.ok(html.includes(report.verdict.title));
  assert.equal((html.match(/<svg /g) || []).length, 3, 'CPU·Consumed·Active 차트 3개');
  assert.ok(html.includes('knowledge.broadcom.com'), '참고 문서 링크');
  assert.ok(!/https?:\/\/(?!www\.vmware\.com|knowledge\.broadcom\.com|techdocs\.broadcom\.com)/.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), '외부 자원 참조 없음(참고 문서 링크만)');
});

test('renderRightsizeHtml: 표본 없음 → SVG 없이 "표본 없음" 문구, 근거 불충분 판정 표기', () => {
  const vm = { id: 'vc1:vm-2', name: 'empty', vcenterId: 'vc1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 };
  const report = analyzeRightsize({ vm, hostMhzPerCore: 2400, intervalSec: 7200, days: 30, series: {}, empty: ['cpuUsageMhz(cpu.usagemhz.average)'] });
  const html = renderRightsizeHtml({ report, vm, days: 30 });
  assert.equal((html.match(/<svg /g) || []).length, 0);
  assert.ok(html.includes('표본 없음'));
  assert.ok(html.includes('근거 불충분'));
  assert.equal(svgLineChart({ points: [] }), '');
  assert.ok(svgLineChart({ points: [{ t: 1, v: 1 }, { t: 2, v: 2 }], refY: 1.5, refLabel: 'p95' }).includes('p95'));
});
