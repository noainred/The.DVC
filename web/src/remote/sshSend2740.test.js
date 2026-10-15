/**
 * v2.740 점검 그룹 f · F-10 — 웹 SSH 게이트웨이가 빈 비밀번호 auth 프레임을 대상에 접속하기 전에 거부한다.
 *  서버(server/src/proxy/sshGateway.js)는 closeAll(4400, 'empty-password') 로 닫는다. 화면은 그 사유를 '권한' 이나 '연결 종료' 로
 *  말하지 않고 '비밀번호가 비어 있다' 고 말해야 한다(서버 사유 코드와 1:1 — 서버 소스에서 리터럴을 뽑아 대조한다).
 *  기존 대조 테스트(audit2731g4a_remoteClose)는 4403·4404 리터럴만 본다 — 4400 은 여기서 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteCloseReasonText, sshCloseReasonText } from './sshSend.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const gw = stripComments(fs.readFileSync(path.join(here, '../../../server/src/proxy/sshGateway.js'), 'utf8'));

describe('F-10 빈 비밀번호 닫힘 사유', () => {
  it('서버는 4400 empty-password 로 닫고, 그 리터럴마다 화면 문구가 있다', () => {
    const codes = [...gw.matchAll(/closeAll\(\s*4400,\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(codes).toContain('empty-password');
    for (const c of codes) expect(remoteCloseReasonText(c), c).toBeTruthy();
  });
  it('사유 문구는 비밀번호를 말하고 권한·호스트키로 단정하지 않는다 · 백틱·별표 없음', () => {
    const t = remoteCloseReasonText('empty-password');
    expect(t).toMatch(/비밀번호가 비어/);
    expect(t).toMatch(/접속하지 않/);
    expect(t).not.toMatch(/권한|호스트키/);
    expect(t).not.toMatch(/[`*]/);
  });
  it('사유가 사라진 4400 도 코드 문구로 같은 뜻을 말한다', () => {
    expect(sshCloseReasonText(4400)).toMatch(/비밀번호가 비어/);
  });
});
