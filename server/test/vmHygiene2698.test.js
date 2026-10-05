// v2.698 — VM 구성 점검(A3·A4·A5·A16·A18·A20): 판정·설정·알림.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmhyg-'));
process.env.CONFIG_DIR = dir;

const { analyzeVmHygiene, hygieneFindings, snapshotPolicySummary, HYGIENE_CODES, ALL_CODES, ROWS_MAX } = await import('../src/vmhygiene/analyze.js');
const { applyPatch, DEFAULTS, loadVmHygieneSettings, saveVmHygieneSettings, _resetVmHygieneSettings } = await import('../src/vmhygiene/settings.js');
const { vmHygieneNotifyOnce } = await import('../src/vmhygiene/notifier.js');
const { snapshotInfo } = await import('../src/vcenter/soapParse.js');
const { VM_CFG_CODES } = await import('../src/vmcfg/parse.js');
const { isRuntimeStateFile } = await import('../src/backup/service.js');

const NOW = Date.UTC(2026, 9, 5, 3, 30); // KST 12:30
const DAY = 86_400_000;
const S = { ...DEFAULTS, notify: { ...DEFAULTS.notify } };

test('① 스냅샷 정책 — 나이·개수·크기, 생성일 모름은 나이 판정 안 함, 예외는 정책만 빼고 센다', () => {
  const vm = { name: 'db01', powerState: 'POWERED_ON', snapshotCount: 4, snapshotSizeGB: 150, snapshotOldestTs: NOW - 10 * DAY };
  const codes = hygieneFindings(vm, S, NOW).findings.map((f) => f.code);
  assert.deepEqual(codes.sort(), ['snap-age', 'snap-count', 'snap-size']);
  const noAge = hygieneFindings({ ...vm, snapshotOldestTs: null, snapshotCount: 1, snapshotSizeGB: 1 }, S, NOW).findings;
  assert.equal(noAge.length, 0, '생성일을 모르면 0일로 보지 않는다');
  const exc = hygieneFindings({ ...vm, notes: '백업 솔루션 Veeam 관리' }, { ...S, exceptions: ['veeam'] }, NOW);
  assert.equal(exc.excepted, 'veeam'); assert.equal(exc.findings.length, 0);
  assert.equal(hygieneFindings({ ...vm, template: true }, S, NOW).findings.length, 0, '템플릿은 판정 대상이 아니다');
});

test('② 유령 스냅샷(A3) — 스냅샷 0개인데 델타 파일 · 파서와 판정', () => {
  const layout = '<file><name>[ds] a/a-000002-sesparse.vmdk</name><size>1073741824</size></file><file><name>[ds] a/a-flat.vmdk</name><size>5</size></file>';
  assert.equal(snapshotInfo('', layout).orphanDeltaGB, 1);
  assert.equal(snapshotInfo('', '').orphanDeltaGB, null, '파일 목록이 없으면 모름');
  const f = hygieneFindings({ name: 'x', snapshotCount: 0, orphanDeltaGB: 1 }, S, NOW).findings.map((x) => x.code);
  assert.deepEqual(f, ['snap-orphan-delta']);
  const g = hygieneFindings({ name: 'y', snapshotCount: 2, orphanDeltaGB: 5 }, S, NOW).findings.map((x) => x.code);
  assert.ok(!g.includes('snap-orphan-delta'), '스냅샷이 있으면 델타는 정상 체인이다(유령 아님)');
});

test('③ Tools 미설치(A16)·장기 미재부팅(A18) — 켜진 VM 만', () => {
  const on = { name: 'w', powerState: 'POWERED_ON', toolsVersionStatus: 'guestToolsNotInstalled', cfg: { bootTime: NOW - 400 * DAY } };
  assert.deepEqual(hygieneFindings(on, S, NOW).findings.map((f) => f.code).sort(), ['tools-missing', 'uptime-long']);
  assert.equal(hygieneFindings({ ...on, powerState: 'POWERED_OFF' }, S, NOW).findings.length, 0);
});

test('④ analyzeVmHygiene — 수집 범위(미수집 따로)·코드 개수는 거르기 전·상한 밝힘·심각도 정렬', () => {
  const vms = [
    { id: 'a', name: 'a', vcenterId: 'vc1', powerState: 'POWERED_ON', cfg: { question: { text: 'q' } } },
    { id: 'b', name: 'b', vcenterId: 'vc1', powerState: 'POWERED_ON', dev: { cdroms: [{ connected: true }] } },
    { id: 'c', name: 'c', vcenterId: 'vc2', powerState: 'POWERED_ON' },
    { id: 't', name: 't', vcenterId: 'vc2', template: true },
  ];
  const r = analyzeVmHygiene(vms, S, { now: NOW, vcName: new Map([['vc1', 'VC One']]) });
  assert.deepEqual({ vms: r.coverage.vms, cfg: r.coverage.cfg, dev: r.coverage.dev, nc: r.coverage.notCollected, t: r.coverage.templates }, { vms: 3, cfg: 1, dev: 1, nc: 1, t: 1 });
  assert.equal(r.rows[0].worst, 'crit');
  assert.equal(r.rows[0].vcenterName, 'VC One');
  const f = analyzeVmHygiene(vms, S, { now: NOW, code: 'cdrom-connected' });
  assert.equal(f.rows.length, 1); assert.equal(f.byCode.question.vms, 1, '코드 개수는 거르기 전 기준');
  const many = Array.from({ length: ROWS_MAX + 5 }, (_, i) => ({ id: `v${i}`, name: `v${i}`, vcenterId: 'vc', powerState: 'POWERED_ON', cfg: { cbt: false } }));
  const big = analyzeVmHygiene(many, S, { now: NOW });
  assert.equal(big.rows.length, ROWS_MAX); assert.equal(big.omitted, 5);
  assert.deepEqual(Object.keys(ALL_CODES).sort(), [...Object.keys(VM_CFG_CODES), ...Object.keys(HYGIENE_CODES)].sort());
});

test('⑤ 설정 — 빈 칸·글자는 이전 값(Number(\'\')===0 함정), 범위 클램프, 예외 중복 제거', () => {
  const n = applyPatch(S, { snapAgeDays: '', snapCount: 'abc', snapSizeGB: 0, uptimeDays: 99999, exceptions: ['Veeam', 'veeam', '  ', 5], notify: { enabled: true, hour: 25 } });
  assert.equal(n.snapAgeDays, 7); assert.equal(n.snapCount, 3); assert.equal(n.snapSizeGB, 1); assert.equal(n.uptimeDays, 3650);
  assert.deepEqual(n.exceptions, ['Veeam']); assert.equal(n.notify.enabled, true); assert.equal(n.notify.hour, 9);
  _resetVmHygieneSettings();
  const saved = saveVmHygieneSettings({ snapAgeDays: 30 }, 'admin');
  assert.equal(saved.snapAgeDays, 30); assert.equal(saved.updatedBy, 'admin');
  fs.writeFileSync(path.join(dir, 'vm-hygiene.json'), '{ broken');
  _resetVmHygieneSettings();
  assert.equal(loadVmHygieneSettings().snapAgeDays, 7, '손상이면 기본값');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('vm-hygiene.json.corrupt')), '손상 원본은 보존');
  _resetVmHygieneSettings();
});

test('⑥ 알림 — 꺼짐·시각 전·첫 수집 중·하루 1회·채널 없음을 구분, 상태 파일은 백업 감시 제외', async () => {
  _resetVmHygieneSettings();
  saveVmHygieneSettings({ notify: { enabled: false } });
  const snap = { vms: [{ id: 'a', name: 'a', vcenterId: 'vc1', powerState: 'POWERED_ON', snapshotCount: 9, snapshotOldestTs: NOW - 30 * DAY }], vcenters: [{ id: 'vc1', name: 'VC1' }] };
  const sent = [];
  const send = async (text) => { sent.push(text); return ['slack:200']; };
  assert.equal((await vmHygieneNotifyOnce({ now: NOW, send, snap })).reason, 'off');
  saveVmHygieneSettings({ notify: { enabled: true, hour: 13 } });
  assert.equal((await vmHygieneNotifyOnce({ now: NOW, send, snap })).reason, 'before-hour');
  saveVmHygieneSettings({ notify: { enabled: true, hour: 9 } });
  assert.equal((await vmHygieneNotifyOnce({ now: NOW, send, snap: { ...snap, initial: true } })).reason, 'first-collect');
  const r = await vmHygieneNotifyOnce({ now: NOW, send, snap });
  assert.equal(r.sent, true); assert.match(sent[0], /스냅샷 정책 위반 1대/);
  assert.equal((await vmHygieneNotifyOnce({ now: NOW + 60_000, send, snap })).reason, 'already-sent');
  const none = await vmHygieneNotifyOnce({ now: NOW, force: true, send: async () => [], snap });
  assert.equal(none.reason, 'no-channel'); assert.equal(none.sent, false);
  assert.equal(isRuntimeStateFile('vm-hygiene-state.json'), true);
  assert.equal(isRuntimeStateFile('vm-hygiene.json'), false, '사람이 정하는 설정은 백업 감시 대상');
  assert.equal(snapshotPolicySummary({ rows: [], coverage: {}, settings: S }), null);
});
