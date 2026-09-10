// SMTP 추적 로그(v2.455) — 실제 소켓 대화로 검증한다.
//
// 요구: "특수기능에 이메일 설정하고 테스트 발송 할 수 있는 기능 추가하고, **테스트할때 구체적인
// 로그 보이게** 해줘."
//
// 여기서는 로컬에 가짜 SMTP 서버를 띄워 단계별 로그가 실제로 쌓이는지, 그리고 **비밀번호가
// 어디에도 새지 않는지**를 고정한다. 이 테스트가 없으면 '진단 로그'가 그대로 자격증명 유출
// 경로가 된다(server/CLAUDE.md: SSH 추적 로그에 비밀번호를 찍지 않는다 — 같은 원칙).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail } from '../src/util/smtp.js';

const PASSWORD = 'sup3r-s3cret-pw';
const USER = 'portal@corp.local';

/** 아주 작은 가짜 SMTP 서버. script 로 각 명령의 응답을 정한다. */
function fakeSmtp({ authFails = false, rejectRcpt = false } = {}) {
  const seen = [];
  const srv = net.createServer((sock) => {
    let stage = 'greet';
    sock.write('220 fake.local ESMTP\r\n');
    let buf = '';
    let inData = false;
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 2.0.0 Ok: queued as ABC123\r\n'); }
          continue;                                  // 본문 줄은 기록하지 않는다
        }
        seen.push(line);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) sock.write('250-fake.local\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (up.startsWith('AUTH')) {
          stage = 'auth';
          sock.write(authFails ? '535 5.7.8 Authentication credentials invalid\r\n' : '235 2.7.0 Authentication successful\r\n');
        } else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
        else if (up.startsWith('RCPT TO')) sock.write(rejectRcpt ? '550 5.1.1 No such user\r\n' : '250 2.1.5 Ok\r\n');
        else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (up === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
        else sock.write('250 2.0.0 Ok\r\n');
        void stage;
      }
    });
    sock.on('error', () => { /* 클라이언트가 먼저 끊는 경우 */ });
  });
  return { srv, seen };
}

function listen(srv) {
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
}

const CFG = (port) => ({
  host: '127.0.0.1', port, secure: false,
  startTls: false,          // 가짜 서버는 TLS 를 실제로 못 하므로 승격하지 않는다
  user: USER, password: PASSWORD, from: 'portal@corp.local', timeoutMs: 5000,
});
const MSG = { to: ['ops@corp.local'], subject: '테스트', text: '본문', html: '<b>본문</b>' };

test('추적 로그 — 단계별 명령과 응답이 순서대로 쌓인다', async () => {
  const { srv } = fakeSmtp();
  const port = await listen(srv);
  try {
    const r = await sendMail(CFG(port), MSG, { trace: true });
    assert.ok(Array.isArray(r.trace) && r.trace.length > 6, `추적이 비었다(${r.trace?.length})`);
    const sent = r.trace.filter((t) => t.dir === '>').map((t) => t.text);
    // 운영자가 어디서 막혔는지 보려면 이 단계들이 다 보여야 한다.
    assert.ok(sent.some((t) => t.startsWith('EHLO')), 'EHLO 가 로그에 없다');
    assert.ok(sent.some((t) => t.startsWith('MAIL FROM')), 'MAIL FROM 이 없다');
    assert.ok(sent.some((t) => t.startsWith('RCPT TO')), 'RCPT TO 가 없다');
    assert.ok(sent.some((t) => t === 'DATA'), 'DATA 가 없다');
    // 응답에는 서버 코드가 붙는다(250/354 등) — '왜 실패했나' 의 핵심.
    const codes = r.trace.filter((t) => t.dir === '<').map((t) => t.code);
    assert.ok(codes.includes(220) && codes.includes(250) && codes.includes(354), `응답 코드 누락: ${codes}`);
    assert.ok(r.trace.every((t) => t.ms == null || t.ms >= 0), '소요 시간이 기록돼야 한다');
    assert.deepEqual(r.accepted, ['ops@corp.local']);
  } finally { srv.close(); }
});

test('★ 추적 로그에 비밀번호가 절대 남지 않는다', async () => {
  const { srv } = fakeSmtp();
  const port = await listen(srv);
  try {
    const r = await sendMail(CFG(port), MSG, { trace: true });
    const dump = JSON.stringify(r.trace);
    assert.ok(!dump.includes(PASSWORD), '평문 비밀번호가 추적 로그에 있다');
    // base64 로도 새면 안 된다 — AUTH PLAIN 토큰에 비밀번호가 그대로 들어 있다.
    const b64plain = Buffer.from(`\0${USER}\0${PASSWORD}`, 'utf8').toString('base64');
    assert.ok(!dump.includes(b64plain), 'AUTH PLAIN base64 토큰이 추적 로그에 있다(디코드하면 비밀번호)');
    assert.ok(!dump.includes(Buffer.from(PASSWORD, 'utf8').toString('base64')), '비밀번호 base64 가 남았다');
    // 대신 가려진 표기가 있어야 한다(무엇을 했는지는 보여야 진단이 된다).
    assert.ok(dump.includes('redacted') || dump.includes('기록하지 않음'), '인증 단계 자체가 로그에 없다');
  } finally { srv.close(); }
});

test('추적 로그에 본문을 통째로 싣지 않는다(크기만)', async () => {
  const { srv } = fakeSmtp();
  const port = await listen(srv);
  try {
    const r = await sendMail(CFG(port), { ...MSG, text: 'VERY-SECRET-BODY-CONTENT' }, { trace: true });
    const dump = JSON.stringify(r.trace);
    assert.ok(!dump.includes('VERY-SECRET-BODY-CONTENT'), '본문이 로그에 그대로 실렸다');
    assert.match(dump, /본문 \d+ bytes/, '본문 크기는 남겨야 한다');
  } finally { srv.close(); }
});

test('실패해도 추적을 돌려준다 — 인증 실패의 서버 응답이 그대로 보인다', async () => {
  const { srv } = fakeSmtp({ authFails: true });
  const port = await listen(srv);
  try {
    await assert.rejects(
      () => sendMail(CFG(port), MSG, { trace: true }),
      (e) => {
        // 실패한 대화야말로 진단에 필요하다.
        assert.ok(Array.isArray(e.trace) && e.trace.length, '오류에 추적이 붙어야 한다');
        const dump = JSON.stringify(e.trace);
        assert.ok(dump.includes('535'), '서버가 준 실패 코드가 보여야 한다');
        assert.ok(dump.includes('Authentication credentials invalid'), '서버 메시지가 보여야 한다');
        assert.ok(!dump.includes(PASSWORD), '실패 경로에서도 비밀번호가 새면 안 된다');
        assert.match(e.message, /인증/);
        return true;
      },
    );
  } finally { srv.close(); }
});

test('수신자 거부 — 전원 거부면 오류이고 이유가 추적에 남는다', async () => {
  const { srv } = fakeSmtp({ rejectRcpt: true });
  const port = await listen(srv);
  try {
    await assert.rejects(
      () => sendMail(CFG(port), MSG, { trace: true }),
      (e) => {
        assert.match(e.message, /수신자가 거부/);
        assert.ok(JSON.stringify(e.trace).includes('550'), '거부 코드가 보여야 한다');
        return true;
      },
    );
  } finally { srv.close(); }
});

test('연결 실패도 추적 없이 조용히 죽지 않고 이유를 준다', async () => {
  // 아무도 듣지 않는 포트(연결 거부).
  await assert.rejects(
    () => sendMail({ ...CFG(1), host: '127.0.0.1', port: 1, timeoutMs: 2000 }, MSG, { trace: true }),
    (e) => { assert.match(e.message, /접속 실패/); return true; },
  );
});

test('trace 를 요청하지 않으면 수집하지 않는다(운영 발송의 오버헤드 0)', async () => {
  const { srv } = fakeSmtp();
  const port = await listen(srv);
  try {
    const r = await sendMail(CFG(port), MSG);
    assert.equal(r.trace, null);
  } finally { srv.close(); }
});
