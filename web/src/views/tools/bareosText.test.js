import { describe, it, expect } from 'vitest';
import {
  stateBadge, levelLabel, bytesText, whenText, elapsedText, runCell, directorLine, restoreLine, candidateSummary,
  directorPrepBlock, fdIniTemplate, PREP_CHECKLIST, STATE_LABEL, RESTORE_MODE_LABEL, autoSetupDirectorText, autoSetupFdText, thumbprintText,
  parseJobReport, reportBytes, reportVerdict, reportCards, issueHint, storeRatio, reportText, reportValue,
  folderOptions, inFolder, pickCap, bulkSummary, NO_FOLDER, diagView,
  driftText, restorePointsNote,
} from './bareosText.js';

describe('bareosText (v2.820 Bareos VM 백업)', () => {
  it('못 읽은 값은 0 이 아니라 —', () => {
    for (const v of [null, undefined, '', 'abc', -1]) expect(bytesText(v)).toBe('—');
    expect(bytesText(0)).toBe('0 B');
    expect(bytesText(2048)).toBe('2.0 KB');
    expect(bytesText(42949672960)).toBe('40.0 GB');
    expect(whenText(null)).toBe('—');
    expect(whenText(0)).toBe('—');
    expect(levelLabel('X')).toBe('—');
    expect(levelLabel('F')).toBe('Full');
  });

  it('상태 배지 — 모르는 상태는 확인 불가, 상태 글자는 한 글자만 덧붙인다', () => {
    expect(stateBadge('ok', 'T')).toEqual({ label: '성공 · T', cls: 'green' });
    expect(stateBadge('error', 'f').cls).toBe('red');
    expect(stateBadge('weird', 'T').label).toBe('확인 불가 · T');
    expect(stateBadge('running', 'RR').label).toBe('실행 중');
  });

  it('최근 실행 칸 — 진행 중이 lastRun 보다 앞, 없으면 아직 실행 없음', () => {
    const now = 1_800_000_000_000;
    const pend = runCell({ pending: { jobid: 9, since: now - 5 * 60_000, state: 'running', status: 'R' }, lastRun: { jobid: 8, state: 'ok' } }, now);
    expect(pend.jobid).toBe(9);
    expect(pend.note).toMatch(/5분째/);
    expect(pend.bytes).toBe('—');
    const last = runCell({ lastRun: { jobid: 8, state: 'ok', status: 'T', level: 'I', bytes: null, startedAt: now } }, now);
    expect(last.bytes).toBe('—');
    expect(last.note).toBe('jobid 8 · Incremental');
    expect(runCell({}).note).toBe('아직 실행 없음');
    expect(elapsedText(now - 125 * 60_000, now)).toBe('2시간 5분째');
  });

  it('머리 상태 줄 — 데모·미설정·가림·인증 정지·조회 실패', () => {
    expect(directorLine({ demo: true })).toMatch(/데모 Director/);
    expect(directorLine({ configured: false })).toMatch(/설정되지 않았습니다/);
    const masked = directorLine({ configured: true, director: { masked: true }, poller: {} });
    expect(masked).toMatch(/전체 범위 관리자만/);
    expect(masked).not.toMatch(/\?/);
    expect(directorLine({ configured: true, director: { host: 'dir', port: 9101, consoleName: 'portal' }, authStopped: { reason: '인증 실패' } })).toMatch(/주기 조회를 멈췄습니다/);
    expect(directorLine({ configured: true, director: { host: 'dir' }, poller: { ok: false, error: 'x' } })).toMatch(/조회 실패: x/);
  });

  it('복원 이력 한 줄·후보 요약', () => {
    expect(restoreLine({ mode: 'newVm', target: { name: 'r1', datastore: 'ds' }, fromJobids: [1, 2], by: 'adm' })).toBe('새 VM ‘r1’ · ds · 원본 1,2 · adm');
    expect(restoreLine({ mode: 'original', fromJobids: [] })).toBe('원래 VM 덮어쓰기 · 원본 — · —');
    expect(candidateSummary({ items: [{ eligible: true }, { eligible: true, registered: true }, { eligible: false }], total: 10, returned: 3 }))
      .toBe('등록 가능 1대 · 이미 대상 1대 · 등록 불가 1대 · 전체 10대 중 앞 3대(이름순)');
  });

  it('사전 준비 블록 — 설정의 이름을 쓰고, FD INI 는 비밀번호 칸을 비운다', () => {
    const b = directorPrepBlock({ defaults: { fileSet: 'FS1', jobDefs: 'JD1', restoreJob: 'RJ1', pluginName: 'python3' }, consoleName: 'pc' });
    expect(b).toMatch(/Name = "FS1"/);
    expect(b).toMatch(/FileSet = "FS1"/);
    expect(b).toMatch(/Name = "RJ1"/);
    expect(b).toMatch(/Plugin = "python3:module_name=bareos-fd-vmware"/);
    expect(b).toMatch(/Name = "pc"/);
    const ini = fdIniTemplate({ configFile: '/etc/bareos/vmware/a.ini', client: 'kr-fd', vcserver: 'vc.corp' });
    expect(ini).toMatch(/vcserver=vc\.corp/);
    expect(ini).not.toMatch(/vcpass=\S*[A-Za-z0-9]{6,}$/m);
    expect(ini).toMatch(/포탈은 저장하지 않습니다/);
  });

  it('문구 규약 — 백틱·마크다운 굵게 없음, 대문자 변환 불필요', () => {
    const texts = [
      ...Object.values(STATE_LABEL), ...Object.values(RESTORE_MODE_LABEL), ...PREP_CHECKLIST,
      directorLine({ demo: true }), directorLine({ configured: false }), runCell({}).note,
      fdIniTemplate({}), candidateSummary({ items: [] }),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/`/);
      expect(t).not.toMatch(/\*\*/);
    }
  });

  it('v2.822 일괄 등록 — 폴더 목록·하위 폴더 포함 필터·폴더 없음 · 고를 수 있는 수 · 결과 한 줄', () => {
    const items = [{ folder: '/app/web' }, { folder: '/app' }, { folder: '/db' }, { folder: null }, { folder: '/app' }];
    expect(folderOptions(items).map((f) => f.label)).toEqual(['/app', '/app/web', '/db', '(폴더 정보 없음)']);
    expect(items.filter((x) => inFolder(x, '/app')).length).toBe(3);
    expect(items.filter((x) => inFolder(x, '/ap')).length).toBe(0);
    expect(items.filter((x) => inFolder(x, NO_FOLDER)).length).toBe(1);
    expect(items.filter((x) => inFolder(x, '')).length).toBe(5);
    expect(pickCap({ maxBulk: 200, jobsLeft: 37 })).toBe(37);
    expect(pickCap({ maxBulk: 200 })).toBe(200);
    expect(pickCap(null)).toBe(0);
    expect(bulkSummary({ created: 2, failed: 1 })).toMatch(/^2대를 .* 1대는 등록하지 못했습니다/);
    expect(bulkSummary({ created: 0, failed: 3 })).toMatch(/한 대도/);
    for (const t of [bulkSummary({ created: 2, failed: 1 }), folderOptions([{}])[0].label]) expect(t).not.toMatch(/`|\*\*/);
  });

  it('v2.822 연결 진단 — 시도 안 함은 실패가 아니다 · 시간 표기 · 못 읽은 시간은 비운다', () => {
    expect(diagView({ skipped: true })).toEqual({ mark: '시도 안 함', cls: 'gray', ms: '' });
    expect(diagView({ ok: true, ms: 12 })).toEqual({ mark: '✓ 통과', cls: 'green', ms: '12ms' });
    expect(diagView({ ok: false, ms: 2500 }).ms).toBe('2.5초');
    expect(diagView({ ok: false }).ms).toBe('');
    expect(diagView({ ok: false, ms: -1 }).cls).toBe('red');
  });

  it('v2.822 drift 안내 · 복원 지점 잘림 안내(숫자는 API 값)', () => {
    expect(driftText(null)).toBe('');
    expect(driftText('missing')).toMatch(/찾지 못했습니다/);
    expect(driftText(['이름', '폴더'])).toMatch(/이름·폴더이\(가\) 바뀌었습니다/);
    for (const t of [driftText(['이름']), driftText('missing'), restorePointsNote({ items: [1, 2], scanned: 60 }, 30)]) {
      expect(t).not.toMatch(/`|\*\*/);
    }
    expect(restorePointsNote({ items: Array.from({ length: 40 }, (_, i) => i), scanned: 60 }, 30)).toMatch(/40건 중 최근 30건/);
    expect(restorePointsNote({ items: [1], scanned: 60 }, 30)).toMatch(/1건\. Director 카탈로그의 최근 실행 60건/);
    expect(restorePointsNote({ items: [] }, 30)).toBe('성공한 백업 0건.');
  });
});

describe('자동 설정 문구(v2.821)', () => {
  it('Director·FD 요약은 파일·동작을 밝히고 값이 없으면 —', () => {
    const t = autoSetupDirectorText({ files: [{ path: '/etc/bareos/bareos-dir.d/console/portal.conf', action: 'created' }, { path: '/x', action: 'unchanged' }], settings: { director: { consoleName: 'portal' } }, probe: { version: '24.0.1' } });
    expect(t).toContain('새 콘솔 ‘portal’');
    expect(t).toContain('/etc/bareos/bareos-dir.d/console/portal.conf(새로 만듦)');
    expect(t).toContain('/x(그대로)');
    expect(t).not.toContain('`');
    expect(autoSetupDirectorText({})).toContain('파일: —');
    expect(autoSetupFdText({ path: '/etc/bareos/vmware/a.ini', action: 'updated', plugin: 'missing' })).toContain('찾지 못했습니다');
    expect(autoSetupFdText({ path: '/a', action: 'created', plugin: 'installed' })).toContain('설치됨');
    expect(thumbprintText({})).toBe('');
    expect(thumbprintText({ thumbprint: 'AB', vcserver: 'vc' })).toContain('**AB**');
  });
});

describe('사전 준비 체크리스트 — pyVmomi(v2.822.1)', () => {
  it('Python 3.9 FD 는 pyVmomi 8.x 안내가 있다(9.x 는 3.10 이상 — 현장 실측 실패)', () => {
    const t = PREP_CHECKLIST.find((x) => x.includes('pyvmomi>=8,<9'));
    expect(t).toBeTruthy();
    expect(t).toContain('Python 3.10 이상');
    expect(t).not.toContain('`');
  });
});

describe('작업 결과 요약(v2.822.3 — 현장 jobid 8 로그 모양)', () => {
  const T = '2026-10-30 09:54:52';
  const W = '2026-10-30 09:48:00';
  // 서버 jobLog 는 logtext 의 줄마다 그 행의 시각을 앞에 붙인다(director.js jobLog).
  const lines = [
    `${W} bareos-sd JobId 8: Warning: stored/label.cc:359 Open device "FileStorage0001" (/mnt/theDVC/bareos) Volume "Full-0006" failed: ERR=stored/dev.cc:630 Could not open: /mnt/theDVC/bareos/Full-0006, ERR=Permission denied`,
    `${W} bareos-sd JobId 8: Warning: stored/label.cc:359 Open device "FileStorage0001" (/mnt/theDVC/bareos) Volume "Full-0006" failed: ERR=stored/dev.cc:630 Could not open: /mnt/theDVC/bareos/Full-0006, ERR=Permission denied`,
    `${W} bareos-sd JobId 8: Please mount append Volume "Full-0006" or label a new one for:`,
    `${W}     Job:          pv-54220daf-vm-11013.2026-10-30_08.58.44_31`,
    `${W}     Pool:         Full`,
    `${T} bareos-dir JobId 8: Bareos bareos-dir 25.1.2~pre73 (26Oct26):`,
    `${T}   Build OS:               Rocky Linux release 9.4 (Blue Onyx)`,
    `${T}   JobId:                  8`,
    `${T}   Backup Level:           Full (upgraded from Incremental)`,
    `${T}   Pool:                   "Full" (From Job resource)`,
    `${T}   Storage:                "File" (From Job resource)`,
    `${T}   Start time:             30-Oct-2026 09:53:45`,
    `${T}   End time:               30-Oct-2026 09:54:52`,
    `${T}   Elapsed time:           1 min 7 secs`,
    `${T}   FD Files Written:       6`,
    `${T}   FD Bytes Read:          10,223,626,211 (10.22 GB)`,
    `${T}   SD Bytes Written:       5,833,172,285 (5.833 GB)`,
    `${T}   Rate:                   87062.0 KB/s`,
    `${T}   Software Compression:   42.9 % (lz4)`,
    `${T}   Volume name(s):         Full-0009`,
    `${T}   Non-fatal FD errors:    0`,
    `${T}   SD Errors:              6`,
    `${T}   FD termination status:  OK`,
    `${T}   SD termination status:  OK`,
    `${T}   Termination:            Backup OK -- with warnings`,
  ];
  it('마지막 보고 블록만 읽는다 — 앞의 Please mount 의 Pool·Job 줄은 보고가 아니다', () => {
    const r = parseJobReport(lines);
    expect(r.found).toBe(true);
    expect(r.fields.Pool).toBe('"Full" (From Job resource)');
    expect(r.fields.Job).toBeUndefined();
    expect(r.fields['Volume name(s)']).toBe('Full-0009');
    expect(r.verdict).toEqual({ cls: 'amber', label: '경고와 함께 성공' });
  });
  it('수치 — 쉼표 바이트 · 저장 효율 · 카드 · 못 읽은 값은 — (0 아님)', () => {
    expect(reportBytes('10,223,626,211 (10.22 GB)')).toBe(10223626211);
    expect(reportBytes('')).toBeNull();
    expect(reportBytes(undefined)).toBeNull();
    const r = parseJobReport(lines);
    expect(storeRatio(r.fields)).toBeCloseTo(0.5706, 3);
    expect(storeRatio({})).toBeNull();
    const cards = Object.fromEntries(reportCards(r.fields).map((c) => [c.k, c.value]));
    expect(cards.read).toBe('9.5 GB');
    expect(cards.comp).toBe('42.9 % (lz4)');
    expect(Object.values(Object.fromEntries(reportCards({}).map((c) => [c.k, c.value])))).toEqual(['—', '—', '—', '—', '—', '—']);
  });
  it('경고·오류 줄 — 같은 줄은 한 번 + 횟수 · 아는 줄만 해석', () => {
    const r = parseJobReport(lines);
    const perm = r.issues.find((x) => /Permission denied/.test(x.text));
    expect(perm.count).toBe(2);
    expect(issueHint(perm.text)).toMatch(/bareos 계정/);
    expect(issueHint(lines[2])).toMatch(/볼륨을 열지 못해/);
    expect(issueHint('Exception: Python 3.10 or newer is required (found 3.9)')).toMatch(/pyVmomi 8\.x/);
    expect(issueHint('something unknown')).toBe('');
    expect(r.issues.some((x) => /^SD Errors:|Non-fatal FD errors/.test(x.text)), '보고 블록의 오류 수 줄은 경고 목록에 넣지 않는다').toBe(false);
    expect(reportValue('"Full" (From Job resource)')).toBe('Full');
    expect(reportValue('')).toBe('—');
  });
  it('결과 판정 · 보고 없음(실행 중) · 복원 보고', () => {
    expect(reportVerdict('Backup OK').cls).toBe('green');
    expect(reportVerdict('*** Backup Error ***').cls).toBe('red');
    expect(reportVerdict('Backup Canceled').label).toBe('취소');
    expect(reportVerdict('').label).toBe('—');
    const running = parseJobReport(lines.slice(0, 4));
    expect(running.found).toBe(false);
    expect(running.issues.length).toBeGreaterThan(0);
    const rest = parseJobReport([`${T} bareos-dir JobId 9: Bareos x:`, `${T}   JobId:  9`, `${T}   Files Restored:  6`, `${T}   Bytes Restored:  1,000 (1 KB)`, `${T}   Termination:  Restore OK`]);
    expect(reportCards(rest.fields).map((c) => c.k)).toEqual(['rbytes', 'rfiles', 'rate', 'elapsed']);
  });
  it('복사 글 · 문구 규약(백틱 없음) · 긴 줄도 선형', () => {
    const t = reportText(parseJobReport(lines), { vmName: 'LESAGITPS02', jobid: 8 });
    expect(t).toMatch(/LESAGITPS02 · jobid 8 · 경고와 함께 성공/);
    expect(t).not.toContain('`');
    const long = [`${T}   ${'A'.repeat(50000)}:  x`, `${T} ${' '.repeat(50000)}x`];
    const t0 = Date.now(); parseJobReport(long); expect(Date.now() - t0).toBeLessThan(200);
  });
});
