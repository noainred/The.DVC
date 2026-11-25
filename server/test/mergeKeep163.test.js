// main(v3.34) 병합 뒤에도 남긴 이 PR 의 수정 가운데, main 설계로 시험이 걷힌 자리의 최소 고정.
//   146회차(141 결정 D2)의 엣지 쪽 방어: 비밀번호도 키도 없는 서버는 수집 함수가 **접속하지 않는다**(엣지 위임 잡 · 중앙 PUSH 가 받은 서버 —
//   옛 중앙이 빈 비밀번호를 실어 보내도 root + 빈 비밀번호로 로그인하지 않는다). 중앙 경로는 main 의 withResolvedAuth(not-configured)가 먼저 막는다.
//   계정 탐침(accountGate) · 자격 해석(refs)의 나머지는 main 의 설계와 시험(serverAccess324 · 점검 1~4회차 시험)이 고정한다 — 이 PR 의 decide146 · rebut151 R1 은 걷었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const { collectServer, NO_CRED_TEXT } = await import('../src/bmstor/collect.js');

test('146 D2(엣지 쪽 방어) — 비밀번호 · 키가 없으면 붙지 않는다(연결 0회 · not-configured) · 빈 글자 비밀번호도 같다', async () => {
  let conns = 0;
  const srv = net.createServer((s) => { conns += 1; s.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    for (const cred of [{}, { password: '' }, { password: null }, { privateKey: '' }]) {
      const r = await collectServer({ host: '127.0.0.1', port, username: 'root', mounts: ['/'], ...cred });
      assert.equal(r.ok, false);
      assert.equal(r.authErrorCode, 'not-configured');
      assert.equal(r.error, NO_CRED_TEXT);
    }
    assert.equal(conns, 0, '접속을 시도하지 않는다');
  } finally { await new Promise((r) => srv.close(r)); }
});
