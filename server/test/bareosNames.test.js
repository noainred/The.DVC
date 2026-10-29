/**
 * test/bareosNames.test.js — src/bareos/names.js(콘솔 명령에 들어가는 이름·값의 관문) 계약.
 *  - 잡 이름: 같은 VM → 같은 이름 · 리소스 이름 규칙 · vcenterId 의 콜론·공백은 해시로
 *  - 플러그인 옵션: 자격증명 없음 · config_file 경로 규칙 · 금지 글자(" \ : ; @ 제어) 거부 · 폴더 루트 표기
 *  - 콘솔 인용: next_arg(lib/scan.cc) 규칙의 역 — 같은 규칙으로 되읽으면 원래 값
 *  - JobStatus 매핑 · ReDoS(긴 입력이 선형)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jobNameFor, isResourceName, pluginValueIssue, backupPluginOptions, restorePluginOptions, folderForPlugin,
  consoleQuote, statusOf, isFinalStatus, normLevel, shortHash,
} from '../src/bareos/names.js';

/** lib/scan.cc next_arg 를 옮긴 되읽기(테스트 전용 — 인용이 왕복하는지 본다). */
function nextArg(s) {
  let p = 0; while (p < s.length && /\s/.test(s[p])) p++;
  let out = ''; let q = false;
  while (p < s.length) {
    const c = s[p];
    if (c === '\\') { p++; if (p < s.length) out += s[p++]; continue; }
    if (c === '"') { p++; q = !q; continue; }
    if (!q && /\s/.test(c)) { p++; break; }
    out += c; p++;
  }
  return { arg: out, rest: s.slice(p) };
}

test('잡 이름: 같은 VM 은 같은 이름 · 리소스 규칙 · vcenterId 의 특수문자는 해시', () => {
  const a = jobNameFor('vc-kr-1', 'vm-123');
  assert.equal(a, jobNameFor('vc-kr-1', 'vm-123'));
  assert.match(a, /^pv-[0-9a-f]{8}-vm-123$/);
  assert.ok(isResourceName(a));
  assert.notEqual(jobNameFor('vc:kr 1', 'vm-123'), jobNameFor('vc:kr 2', 'vm-123'));
  assert.ok(isResourceName(jobNameFor('vc:kr 1', 'vm-123')));
  assert.equal(jobNameFor('vc', ''), '');
  assert.equal(jobNameFor('vc', 'vm-1', 'r2'), `pv-${shortHash('vc')}-vm-1-r2`);
  assert.ok(!isResourceName('-x') && !isResourceName('a b') && !isResourceName('a;b') && !isResourceName('x'.repeat(65)));
});

test('플러그인 옵션: 자격증명 없이 config_file 만 · 폴더는 /a/b · 루트는 /', () => {
  const r = backupPluginOptions({ vcserver: 'vcenter.kr.corp', dc: 'DC-Seoul', folder: 'webservers/prod', vmname: 'web srv 01', configFile: '/etc/bareos/vmware/vc-kr-1.ini' });
  assert.equal(r.value, 'python3:vcserver=vcenter.kr.corp:dc=DC-Seoul:folder=/webservers/prod:vmname=web srv 01:config_file=/etc/bareos/vmware/vc-kr-1.ini');
  assert.doesNotMatch(r.value, /vcuser|vcpass/);
  assert.equal(folderForPlugin('vm'), '/');
  assert.equal(folderForPlugin(''), '/');
  assert.equal(folderForPlugin('/a//b/'), '/a/b');
  assert.equal(backupPluginOptions({ vcserver: 'v', dc: 'd', folder: '/', vmname: 'n', configFile: '/etc/x.ini', plugin: 'python' }).value.split(':')[0], 'python');
});

test('플러그인 옵션: 금지 글자·경로 이탈·빈 값은 사유와 함께 거부', () => {
  const base = { vcserver: 'v', dc: 'd', folder: '/f', vmname: 'n', configFile: '/etc/bareos/x.ini' };
  for (const [k, v, re] of [
    ['vmname', 'a:b', /콜론/], ['vmname', 'a"b', /큰따옴표/], ['vmname', 'a\\b', /역슬래시/], ['vmname', 'a;b', /세미콜론/],
    ['vmname', 'a@b', /@/], ['vmname', 'a\nb', /제어 문자/], ['vmname', ' a', /공백/], ['vmname', '', /비어/], ['dc', 'x'.repeat(201), /너무 깁니다/],
    ['folder', '/a:b', /콜론/],
  ]) {
    const r = backupPluginOptions({ ...base, [k]: v });
    assert.ok(r.issue && re.test(r.issue), `${k}=${JSON.stringify(v)} → ${r.issue}`);
  }
  assert.ok(backupPluginOptions({ ...base, configFile: 'etc/x.ini' }).issue);
  assert.ok(backupPluginOptions({ ...base, configFile: '/etc/../root/x' }).issue);
  assert.ok(backupPluginOptions({ ...base, configFile: '/etc/x y.ini' }).issue);
  assert.ok(backupPluginOptions({ ...base, plugin: 'Py thon' }).issue);
  assert.equal(pluginValueIssue('한글 VM 이름-01', 'VM 이름'), '', '한글·공백·하이픈은 허용');
});

test('복원 옵션: 허용 키만 · 빈 값 생략 · 값 규칙 동일', () => {
  assert.equal(restorePluginOptions({ restore_powerstate: 'off', vmname: 'web-r', restore_datastore: 'ds-02', restore_cluster: '' }).value,
    'python3:restore_powerstate=off:vmname=web-r:restore_datastore=ds-02');
  assert.equal(restorePluginOptions({ localvmdk: 'yes' }).value, 'python3:localvmdk=yes');
  assert.match(restorePluginOptions({ vcpass: 'x' }).issue, /받지 않습니다/);
  assert.match(restorePluginOptions({ vmname: 'a:b' }).issue, /콜론/);
  assert.match(restorePluginOptions({}).issue, /비어/);
});

test('콘솔 인용: next_arg 로 되읽으면 원래 값 · ALIST_STR 은 따옴표를 값에 남긴다', () => {
  for (const v of ['simple', 'with space', 'a"b', 'back\\slash', 'python3:vmname=web srv 01:folder=/a b']) {
    const cmd = `fdpluginoptions=${consoleQuote(v)} next=1`;
    const { arg, rest } = nextArg(cmd);
    assert.equal(arg, `fdpluginoptions=${v}`);
    assert.equal(nextArg(rest).arg, 'next=1');
  }
  const { arg } = nextArg(`fdpluginoptions=${consoleQuote('python3:vmname=web srv', { literalQuotes: true })}`);
  assert.equal(arg, 'fdpluginoptions="python3:vmname=web srv"', '설정 파일에 FdPluginOptions = "…" 로 쓰이도록 따옴표가 값에 남는다');
});

test('JobStatus → 포탈 상태 · 끝난 상태 · 레벨 정규화', () => {
  assert.equal(statusOf('T'), 'ok');
  assert.equal(statusOf('W'), 'warning');
  assert.equal(statusOf('R'), 'running');
  assert.equal(statusOf('C'), 'queued');
  assert.equal(statusOf('A'), 'canceled');
  for (const c of ['E', 'e', 'f', 'I']) assert.equal(statusOf(c), 'error', c);
  for (const c of ['F', 'S', 'm', 'M', 'c', 'd', 'B']) assert.equal(statusOf(c), 'waiting', c);
  assert.equal(statusOf(''), 'unknown');
  assert.equal(statusOf(null), 'unknown');
  assert.equal(statusOf('?'), 'unknown');
  assert.ok(isFinalStatus('T') && isFinalStatus('f') && isFinalStatus('A') && !isFinalStatus('R') && !isFinalStatus(''));
  assert.equal(normLevel('Full'), 'Full');
  assert.equal(normLevel('full'), 'Incremental');
  assert.equal(normLevel('__proto__'), 'Incremental');
});

test('ReDoS: 긴 입력도 선형(100KB 값 검사 1회 < 50ms)', () => {
  const big = 'a'.repeat(100_000) + ':';
  const t0 = performance.now();
  pluginValueIssue(big, 'x'); jobNameFor(big, big); folderForPlugin(big.replace(/a/g, 'a/'));
  assert.ok(performance.now() - t0 < 50);
});
