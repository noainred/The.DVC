/**
 * 보안 잔여 11-27 M1 — 중계 서버 SSH 자동 배포 명령 칸 표시(proxyDeployCmdText.js) + 화면 원문 스윕.
 * 형식 판정은 서버 하나(server/src/proxy/registry.js resolveDeployCmd) — 웹은 서버가 실어 준 deployCommands 를 글로 바꿀 뿐이다(문법 · 상한을 복제하지 않는다).
 * 회귀 서버 쪽: server/test/secResidual1127Proxy.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployCmdNote, deployCmdPlaceholder, deployCmdHelp, deployResultText, MAPPING_STATUS_LABEL, MAPPING_TEARDOWN_TITLE } from './proxyDeployCmdText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');

describe('deployCmdNote — 서버 판정을 글로', () => {
  it('형식 밖 사유가 있으면 붉은(error) 줄 — 서버 사유를 그대로 싣는다', () => {
    const n = deployCmdNote({ value: null, stored: 'x && y', source: 'saved', issue: '쓸 수 없는 글자가 있습니다.', help: 'h' });
    expect(n.tone).toBe('error');
    expect(n.text).toContain('쓸 수 없는 글자가 있습니다.');
    expect(n.text).toContain('접속하기 전에 거절');
  });
  it('운영자 값(env) · 내장 기본 · 저장값을 구분한다', () => {
    expect(deployCmdNote({ value: 'docker kill -s HUP h', stored: null, source: 'env', issue: null })).toEqual({ tone: 'info', text: '비어 있어 호스트 운영자 값(portal.env)을 씁니다: ‘docker kill -s HUP h’' });
    expect(deployCmdNote({ value: 'docker kill -s HUP h', stored: 'docker kill -s HUP h', source: 'env', issue: null }).text).toContain('저장된 값이 호스트 운영자 값');
    expect(deployCmdNote({ value: 'systemctl reload haproxy', stored: null, source: 'builtin', issue: null })).toEqual({ tone: 'muted', text: '비어 있어 기본값 ‘systemctl reload haproxy’ 을 씁니다.' });
    expect(deployCmdNote({ value: 'sudo -n systemctl reload haproxy', stored: 'sudo systemctl reload haproxy', source: 'saved', issue: null }).text).toBe('실행할 명령: ‘sudo -n systemctl reload haproxy’');
  });
  it('옛 서버(deployCommands 없음)·이상한 값이면 아무것도 보이지 않는다', () => {
    for (const v of [undefined, null, 'x', 5, {}]) expect(deployCmdNote(v)).toBe(null);
  });
  it('placeholder 는 빈 칸일 때 실제로 쓰이는 기본 · 안내는 서버 문구 그대로', () => {
    expect(deployCmdPlaceholder({ value: 'haproxy -c -f {file}', source: 'builtin' })).toBe('haproxy -c -f {file}');
    expect(deployCmdPlaceholder({ value: 'x', source: 'saved' })).toBe('');
    expect(deployCmdPlaceholder(null)).toBe('');
    expect(deployCmdHelp({ help: '서버 안내' })).toBe('서버 안내');
    expect(deployCmdHelp({})).toBe('');
  });
});

describe('deployResultText — POST /remote/deploy 의 results[] (예전: 배포 실패: undefined)', () => {
  it('실패한 중계 서버를 이름: 사유 로 잇는다', () => {
    const t = deployResultText({ ok: false, results: [{ proxy: '기본 프록시', ok: true, deployed: 2 }, { proxy: '법인A', ok: false, reason: '저장된 재적재(reload) 명령이 허용 형식 밖' }] });
    expect(t.ok).toBe(false);
    expect(t.text).toContain('‘법인A’: 저장된 재적재(reload) 명령이 허용 형식 밖');
    expect(t.text).toContain('1곳 / 2곳');
    expect(t.text).not.toContain('undefined');
  });
  it('성공 · 대상 없음 · 요청 실패', () => {
    expect(deployResultText({ ok: true, results: [{ proxy: 'a', ok: true }] })).toEqual({ ok: true, text: '배포 완료(reload) — 중계 서버 1곳.' });
    expect(deployResultText({ ok: true, results: [] }).text).toContain('켠 중계 서버가 없어');
    expect(deployResultText({ ok: false, reason: '네트워크 오류' }).text).toBe('배포 실패: 네트워크 오류');
    expect(deployResultText(null).ok).toBe(false);
    expect(deployResultText({ ok: false, results: [{ ok: false }] }).text).toContain('‘이름 없음’: 사유 미상');
  });
  it('철거 보류 상태 이름 · 설명', () => {
    expect(MAPPING_STATUS_LABEL['teardown-pending']).toBe('철거 보류');
    expect(MAPPING_TEARDOWN_TITLE).toContain('HAProxy 포트');
  });
});

describe('화면 원문 스윕', () => {
  const ps = read('ProxySettings.jsx');
  const ra = read('RemoteAccess.jsx');
  const editor = ps.slice(ps.indexOf('export function ProxyEditor'));
  it('ProxyEditor 에 reload · 검증 명령 칸이 있다(예전에는 받은 값을 보이지 않고 다시 보냈다)', () => {
    expect(editor).toMatch(/onChange=\{setSub\('deploy', 'reloadCmd'\)\}/);
    expect(editor).toMatch(/onChange=\{setSub\('deploy', 'validateCmd'\)\}/);
    expect(editor).toMatch(/view=\{initial\.deployCommands\?\.reloadCmd\}/);
  });
  it('손대지 않은 칸을 빈 문자열로 상태에 넣지 않는다(범위 관리자 공유 중계 저장 403 함정 — 반증 S-5)', () => {
    expect(editor).not.toMatch(/reloadCmd:\s*''/);
    expect(editor).not.toMatch(/validateCmd:\s*''/);
    expect(ps).not.toMatch(/useState\(\{[^)]*reloadCmd/);
  });
  it('기본 프록시 카드도 서버 표시(deployCommands)를 쓴다', () => {
    expect(ps).toMatch(/view=\{cfg\.deployCommands\?\.reloadCmd\}/);
    expect(ps).toMatch(/view=\{cfg\.deployCommands\?\.validateCmd\}/);
  });
  it('새 중계 서버 틀이 내장 기본 명령을 박지 않는다(빈 칸 = 기본값 — 운영자 값을 무시하고 굳히지 않게)', () => {
    for (const src of [ps, ra]) {
      expect(src).not.toContain("'systemctl reload haproxy'");
      expect(src).not.toContain("'haproxy -c -f {file}'");
    }
  });
  it('지금 배포 · 저장 실패가 서버 사유를 보인다', () => {
    expect(ps).toMatch(/deployResultText\(r\)/);
    expect(ps).not.toMatch(/배포 실패: \$\{r\.reason\}/);
    expect(ps).toMatch(/저장 실패: \$\{changeFailText\(r\)/);
  });
  it('매핑 삭제가 409(철거 보류)를 성공으로 읽지 않는다 · 보류 매핑은 접속 버튼을 보이지 않는다', () => {
    expect(ra).toMatch(/requireChanged\(await delJson\(`\/remote\/mappings\//);
    expect(ra).toMatch(/m\.status === 'teardown-pending' \?/);
  });
  it('새 문구에 백틱 글자가 없다(BoldText 규약)', () => {
    const helper = read('proxyDeployCmdText.js');
    const strings = helper.match(/'[^'\n]*'|`[^`]*`/g) || [];
    for (const s of strings.filter((x) => x.startsWith("'"))) expect(s.includes('`')).toBe(false);
  });
});
