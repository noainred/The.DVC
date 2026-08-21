// Edge 배포 대상 CSV(v2.339) 단위테스트 — 비밀값 제외 기본·파싱·드라이런 판정(add/overwrite/
// error/파일 내 중복)·문법 검증. 식별 키는 (host, port, username) — findTargetByHost 와 동일.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetsToCsv, sampleCsv, parseTargetsCsv, analyzeTargetsImport, targetRowIssue } from '../src/agent/deployCsv.js';

const LIST = [
  { host: '192.168.88.221', port: 22, username: 'root', agentName: 'AZ', centralUrl: 'http://c:4000', collectorDatacenter: 'AZ', portalPort: 4000, autoUpgrade: true, pushInventory: true, enabled: true, password: 'ssh-pw', centralToken: 'ct', collectorToken: 'kt' },
  { host: '192.168.88.221', port: 4067, username: 'root', agentName: 'AZ-IRS', enabled: false },
];

test('targetsToCsv: 기본은 비밀 3컬럼(비번·토큰) 제외', () => {
  const csv = targetsToCsv(LIST);
  assert.ok(!csv.includes('ssh-pw') && !csv.includes(',ct,') && !csv.includes(',kt'));
  const withS = targetsToCsv(LIST, { includeSecrets: true });
  assert.ok(withS.includes('ssh-pw') && withS.includes('ct') && withS.includes('kt'));
});

test('parseTargetsCsv: 기본값(port 22·user root)·불리언·비밀값 감지, 샘플은 주석 걸러 2행', () => {
  const { rows } = parseTargetsCsv('host,agentName\n10.0.0.1,GM1');
  assert.equal(rows[0].port, '22');
  assert.equal(rows[0].username, 'root');
  assert.equal(rows[0].autoUpgrade, true);
  assert.equal(rows[0]._hasSecret, false);
  const s = parseTargetsCsv(sampleCsv());
  assert.equal(s.error, undefined);
  assert.deepEqual(s.rows.map((r) => r.agentName), ['AZ', 'GM1']);
  assert.equal(s.rows[0]._hasSecret, true, '샘플 1행은 password 예시 포함');
  assert.ok(parseTargetsCsv('port,username\n22,root').error, 'host 헤더 없으면 오류');
});

test('targetRowIssue: 포트/URL 문법 검증', () => {
  assert.equal(targetRowIssue({ host: 'h', port: '22', portalPort: '', centralUrl: '' }), null);
  assert.match(targetRowIssue({ host: 'h', port: 'abc', portalPort: '' }), /포트/);
  assert.match(targetRowIssue({ host: 'h', port: '22', portalPort: '99999' }), /포탈 포트/);
  assert.match(targetRowIssue({ host: 'h', port: '22', portalPort: '', centralUrl: 'ftp://x' }), /http/);
});

test('analyzeTargetsImport: (host,port,user) 겹침=overwrite, 같은 키 재등장=파일 내 중복', () => {
  const { rows } = parseTargetsCsv(['host,port,username',
    '10.0.0.1,22,root',        // 신규
    '10.0.0.2,22,root',        // 기존 → overwrite
    '10.0.0.2,4067,root',      // 포트 다름 → 신규(스크린샷 :22/:4067 사례)
    '10.0.0.1,22,ROOT'].join('\n')); // 대소문자 무시 중복 → error
  const { report, summary } = analyzeTargetsImport(rows, {
    existingId: (h, p) => (h === '10.0.0.2' && String(p) === '22' ? 'id-2' : undefined),
  });
  assert.deepEqual(summary, { add: 2, overwrite: 1, error: 1, withSecret: 0 });
  assert.match(report[3].reason, /파일 내 중복/);
});
