import { describe, it, expect } from 'vitest';
import {
  stateBadge, levelLabel, bytesText, whenText, elapsedText, runCell, directorLine, restoreLine, candidateSummary,
  directorPrepBlock, fdIniTemplate, PREP_CHECKLIST, STATE_LABEL, RESTORE_MODE_LABEL, autoSetupDirectorText, autoSetupFdText, thumbprintText,
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
