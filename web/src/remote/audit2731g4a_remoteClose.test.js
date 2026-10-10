/**
 * v2.731 점검 1회차 G4a · A5-02 + A1-03 — 원격 콘솔 닫힘 문구는 서버가 보낸 **사유**로 고른다.
 *
 * 4403 은 권한·범위·매핑 삭제·대상 변경·호스트키 거부가 함께 쓰는 코드다. 예전 화면은 코드 하나로 '권한·범위가 바뀌어' 를 말해
 * 호스트키가 승인되지 않은 장비·지워진 매핑을 권한 문제로 안내했다. 여기서 고정하는 것:
 *  ① 사유별 문구 — 호스트키(판정 사유별)·매핑 삭제·대상 변경·매핑 권한 없음이 서로 다르고 권한·범위 단정이 없다
 *  ② 사유를 모르는 4403 은 원인을 하나로 단정하지 않는다 · 모르는 사유·프로토타입 키는 null(코드 문구로 떨어진다)
 *  ③ 서버 소스의 사유 코드(remoteUserIssue·remoteEntryIssue·closeAll 리터럴·호스트키 판정 사유)와 1:1
 *  ④ 화면 배선 — SSH onclose 는 ev.reason 을 먼저 보고, RDP 는 Guacamole 터널의 닫힘 사유(status.message)를 보인다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteCloseReasonText, sshCloseReasonText } from './sshSend.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srvSrc = (rel) => stripComments(fs.readFileSync(path.join(here, '../../../server/src', rel), 'utf8'));
const PERM_ONLY = /권한·범위가 바뀌어/;

describe('① 사유별 문구', () => {
  it('호스트키 거부는 호스트키·장비 신뢰를 말하고 권한을 말하지 않는다(판정 사유마다 다르다)', () => {
    const unk = remoteCloseReasonText('host-key-unknown');
    const chg = remoteCloseReasonText('host-key-changed');
    for (const t of [unk, chg, remoteCloseReasonText('host-key-not-approved')]) {
      expect(t).toMatch(/호스트키/);
      expect(t).toMatch(/장비 신뢰/);
      expect(t).toMatch(/비밀번호는 보내지 않았습니다/);
      expect(t).not.toMatch(PERM_ONLY);
    }
    expect(unk).toMatch(/승인되지 않아/);
    expect(chg).toMatch(/승인된 키와 달라/);
    expect(remoteCloseReasonText('host-key-rejected')).toMatch(/거부한/);
    expect(remoteCloseReasonText('host-key-internal')).toMatch(/저장소를 확인하지 못해/);
    // 판정 사유가 새로 늘어도 호스트키라는 사실은 말한다
    expect(remoteCloseReasonText('host-key-something-new')).toMatch(/호스트키/);
    // 2.730 이하 서버의 사유
    expect(remoteCloseReasonText('host key not trusted')).toMatch(/호스트키/);
  });
  it('매핑 삭제·대상 변경·매핑 권한 없음은 서로 다른 문구다', () => {
    const gone = remoteCloseReasonText('mapping-gone');
    const changed = remoteCloseReasonText('mapping-changed');
    const denied = remoteCloseReasonText('mapping-denied');
    expect(gone).toMatch(/삭제/);
    expect(changed).toMatch(/대상\(호스트·포트\)이 바뀌어/);
    expect(denied).toMatch(/매핑을 쓸 수 없/);
    expect(new Set([gone, changed, denied]).size).toBe(3);
    for (const t of [gone, changed, denied]) expect(t).not.toMatch(PERM_ONLY);
    expect(remoteCloseReasonText('forbidden')).toBe(denied); // 2.730 이하 서버의 접속 시점 매핑 거부
    expect(remoteCloseReasonText('mapping not found')).toMatch(/찾을 수 없/);
    expect(remoteCloseReasonText('rdp mapping not found')).toMatch(/찾을 수 없/);
  });
  it('계정 쪽 사유(권한·OTP·데모·세션)도 그 원인을 말한다', () => {
    expect(remoteCloseReasonText('no-remote-access')).toMatch(/remote\.access/);
    expect(remoteCloseReasonText('otp-enroll')).toMatch(/OTP/);
    expect(remoteCloseReasonText('demo-guest')).toMatch(/데모/);
    expect(remoteCloseReasonText('session-invalid')).toMatch(/로그인/);
    expect(remoteCloseReasonText('revoked')).toMatch(/폐기/);
  });
  it('문구에 백틱·별표가 없다(BoldText 규약)', () => {
    for (const k of ['host-key-unknown', 'host-key-changed', 'mapping-gone', 'mapping-changed', 'mapping-denied']) {
      expect(remoteCloseReasonText(k)).not.toMatch(/[`*]/);
    }
  });
});

describe('② 모르는 사유 · 사유 없는 4403', () => {
  it('모르는 사유·빈 값·프로토타입 키는 null — 화면이 코드 문구로 떨어진다', () => {
    for (const r of ['', '   ', null, undefined, 42, 'idle', 'session end', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect(remoteCloseReasonText(r), String(r)).toBeNull();
    }
  });
  it('사유를 모르는 4403 은 원인을 \'권한·범위\' 하나로 단정하지 않는다', () => {
    const t = sshCloseReasonText(4403);
    expect(t).not.toMatch(PERM_ONLY);
    expect(t).toMatch(/호스트키/);
    expect(t).toMatch(/매핑/);
    expect(sshCloseReasonText(1000)).toBeNull();
  });
});

describe('③ 서버 사유 코드와 1:1', () => {
  it('sshGateway 의 403·401 사유 코드와 4403·4404 닫힘 리터럴마다 문구가 있다', () => {
    const g = srvSrc('proxy/sshGateway.js');
    const codes = new Set([...g.matchAll(/status:\s*40[13],\s*code:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    expect(codes.size).toBeGreaterThanOrEqual(8);
    for (const m of g.matchAll(/closeAll\(\s*440[34],\s*'([^']+)'\s*\)/g)) codes.add(m[1]);
    expect(codes.has('mapping-denied')).toBe(true);
    expect(codes.has('forbidden'), '접속 시점 매핑 거부도 원인 코드(mapping-denied)로 닫는다').toBe(false);
    for (const c of codes) expect(remoteCloseReasonText(c), `서버 사유 ${c}`).toBeTruthy();
  });
  it('호스트키 거부는 \'host-key-<판정 사유>\' 로 닫고, 판정 사유마다 호스트키 문구가 있다', () => {
    const g = srvSrc('proxy/sshGateway.js');
    expect(g).toMatch(/closeAll\(4403, hostKeyCloseReason\(hk\)\)/);
    expect(g).not.toMatch(/'host key not trusted'/);
    const ex = srvSrc('proxy/sshExec.js');
    const block = ex.match(/HOSTKEY_REASON_TEXT\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
    expect(block, 'sshExec.js HOSTKEY_REASON_TEXT 를 읽지 못했다').toBeTruthy();
    const reasons = [...block[1].matchAll(/^\s*'?([a-z-]+)'?\s*:/gm)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const r of reasons) expect(remoteCloseReasonText(`host-key-${r}`), r).toMatch(/호스트키|장비 신뢰/);
  });
  it('RDP 게이트웨이의 매핑 거부도 같은 사유 코드다', () => {
    const t = srvSrc('proxy/guacdTunnel.js');
    expect(t).toMatch(/safeWsClose\(ws, 1011, 'mapping-denied'\)/);
    expect(t).not.toMatch(/safeWsClose\(ws, 1011, 'forbidden'\)/);
  });
});

describe('④ 화면 배선(주석 제거 후 소스)', () => {
  const con = stripComments(fs.readFileSync(path.join(here, 'RemoteConsole.jsx'), 'utf8'));
  it('SSH onclose 는 서버 사유를 먼저 보고 코드 문구로 떨어진다', () => {
    expect(con).toMatch(/const why = remoteCloseReasonText\(ev\?\.reason\) \|\| sshCloseReasonText\(ev\?\.code\);/);
  });
  it('열린 세션이 닫히면 상태줄이 \'연결됨\' 으로 남지 않는다(사유 있으면 오류, 없으면 연결 종료)', () => {
    expect(con).toMatch(/if \(phaseRef\.current === 'live'\) \{ setPhase\(why \? 'error' : 'closed'\);/);
    expect(con).toMatch(/phase === 'closed' && <span>■ \{status\}<\/span>/);
  });
  it('RDP 는 Guacamole 터널 닫힘 사유를 상태로 보인다(아는 사유만)', () => {
    expect(con).toMatch(/tunnel\.onerror = \(st\) => \{ const t = remoteCloseReasonText\(st\?\.message\); if \(t\) setStatus\(t\); \};/);
  });
});
