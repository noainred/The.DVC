// v2.732(점검 2회차 B1-03): 위임 IP 스캔 할당의 비밀번호 폐기 안내가 '스캔은 iDRAC 로그인에 실패합니다' 라고 단정했다.
// 2.731 이상 엣지는 빈 비밀번호 할당을 스캔하지 않는다(agent/scanner.js 'no-password') — 건너뜀을 실패라 말하면 관리자가 iDRAC 인증 실패
// 로그·계정 잠금을 찾는다(v2.513 'skipped ≠ fail'). 실제 함수(updateAssignment·importAssignments)의 응답과 화면 문구로 판정한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'asg2732d-'));
process.env.CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

const asg = await import('../src/central/assignments.js');
const webText = await import('../../web/src/views/droppedSecretText.js');

function checkReason(reason) {
  assert.equal(typeof reason, 'string');
  assert.match(reason, /^IP 대역·iDRAC 계정이 바뀌어/, '앞부분(화면·기존 테스트가 기대하는 머리)은 그대로');
  assert.match(reason, /스캔을 하지 않습니다/, '2.731+ 엣지의 실제 동작(건너뜀)을 말해야 한다');
  // '실패합니다' 는 구버전 엣지 단서와 함께일 때만 — 단정형으로 모든 엣지가 실패한다고 말하지 않는다.
  if (/실패합니다/.test(reason)) assert.match(reason, /2\.730 이하 엣지는[^.]*실패합니다/, reason);
  assert.doesNotMatch(reason, /스캔은 iDRAC 로그인에 실패합니다/, '옛 단정 문구');
  assert.ok(!reason.includes('`') && !reason.includes('**'), '서버 문구에 백틱·별표 금지');
}

test('B1-03 ① 수정 저장 폐기 사유 — 건너뜀을 말하고 실패를 단정하지 않는다', () => {
  assert.equal(asg.addAssignment({ agent: 'edge-a', ips: '10.20.0.0/24', username: 'root', password: 'PW-1' }).ok, true);
  const up = asg.updateAssignment('edge-a', { ips: '10.21.0.0/24', username: 'root', password: '' });
  assert.equal(up.ok, true);
  assert.deepEqual(up.droppedSecrets, ['password']);
  const reason = up.skipped?.find((x) => x.field === 'password')?.reason;
  checkReason(reason);
  const note = webText.droppedSecretNote(up);
  assert.match(note, /^저장했습니다 — 단 IP 대역·iDRAC 계정이 바뀌어/);
  assert.match(note, /스캔을 하지 않습니다/);
  assert.equal(asg.getAssignment('edge-a').password, '');
});

test('B1-03 ② CSV merge 폐기 사유(passwordDropped)도 같은 문장', () => {
  asg.updateAssignment('edge-a', { password: 'PW-2' });
  const r = asg.importAssignments([{ agent: 'edge-a', ips: '198.51.100.7', username: 'root', password: '' }], 'merge');
  assert.equal(r.ok, true);
  const d = (r.passwordDropped || []).find((x) => x.name === 'edge-a');
  assert.ok(d, JSON.stringify(r));
  checkReason(d.reason);
  const lines = webText.passwordDroppedLines(r);
  assert.match(lines[0], /^edge-a — IP 대역·iDRAC 계정이 바뀌어/);
});
