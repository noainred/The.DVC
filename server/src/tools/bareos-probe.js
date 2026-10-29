#!/usr/bin/env node
/**
 * Bareos Director 연결 점검(PoC) 도구 — 포탈 서버에서 직접 실행한다.
 *
 * 포탈의 Bareos 연동은 Node 로 옮긴 콘솔 프로토콜(TLS-PSK · CRAM-MD5 · JSON 모드)을 쓴다. 실제 Director 와의 상호운용
 * (특히 TLS-PSK 협상)과 VMware 플러그인이 잡 단위 옵션을 받아들이는지는 **실제 환경에서만** 확인할 수 있어, 이 도구로
 * 단계별로 확인한다. 각 단계는 앞 단계가 성공해야 진행한다.
 *
 * 사용법(비밀번호는 인자 대신 환경변수로 — 셸 기록·프로세스 목록에 남지 않게):
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host bareos-dir.corp --name portal
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --catalog
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --history <잡 이름>
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --chain <jobid>
 *   BAREOS_PASSWORD='…' node server/src/tools/bareos-probe.js --host … --name portal --cmd '.jobs'
 *
 * 옵션:
 *   --port 9101           Director 포트
 *   --tls12               TLS 1.2 까지만(1.3 협상이 실패할 때 비교용)
 *   --insecure-plain      TLS 없이(시험 전용 — 같은 호스트의 Director 를 비교할 때만. 포탈 설정에는 이 경로가 없다)
 *   --timeout 15          초
 *   --cmd '<명령>'        JSON 모드 명령 1개를 그대로 보내 결과를 출력(읽기 명령만 쓰세요 — 이 도구는 막지 않습니다)
 *
 * 주소 검사: 포탈과 같은 SSRF 규칙(루프백·링크로컬 차단)을 쓴다. 같은 호스트의 Director 를 시험하려면 SSRF_ALLOW_LOOPBACK=true.
 */
import process from 'node:process';
import { openConsole } from '../bareos/console.js';
import { probe, catalogLists, jobHistory, restoreChain } from '../bareos/director.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

if (has('--help') || has('-h') || !val('--host') || !val('--name')) {
  console.log(`
Bareos Director 연결 점검

  BAREOS_PASSWORD='콘솔 비밀번호' node server/src/tools/bareos-probe.js --host <주소> --name <콘솔 이름> [--port 9101]
      [--catalog] [--history <잡 이름>] [--chain <jobid>] [--cmd '<명령>'] [--tls12] [--insecure-plain] [--timeout 초]
`);
  process.exit(has('--help') || has('-h') ? 0 : 2);
}
const password = process.env.BAREOS_PASSWORD || '';
if (!password) { console.error('\n✖ BAREOS_PASSWORD 환경변수로 콘솔 비밀번호를 주세요(인자로 받지 않습니다).\n'); process.exit(2); }

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const opts = {
  host: val('--host'), port: val('--port') || 9101, name: val('--name'), password,
  timeoutMs: (Number(val('--timeout')) || 15) * 1000,
  tls: has('--insecure-plain') ? 'none' : 'psk',
  tlsMaxVersion: has('--tls12') ? 'TLSv1.2' : 'TLSv1.3',
};

let s = null;
try {
  step(1, `접속·인증: ${opts.host}:${opts.port} · 콘솔 ‘${opts.name}’ · ${opts.tls === 'psk' ? `TLS-PSK(최대 ${opts.tlsMaxVersion})` : '평문(시험 전용)'}`);
  s = await openConsole(opts);
  const p = await probe(s);
  console.log(`  ✔ 인증 성공 — Director ‘${p.director || '?'}’ 버전 ${p.version || '?'} · 암호화 ${s.info.tls ? `${s.info.tls.protocol} ${s.info.tls.cipher}` : '없음'}`);
  console.log(`  ✔ 안내: ${s.info.infoMessage.split('\n').join(' / ')}`);
  if (p.clients) console.log(`  ✔ .clients ${p.clients.length}개: ${p.clients.slice(0, 20).join(', ')}${p.clients.length > 20 ? ' …' : ''}`);
  else console.log(`  ✖ .clients 실패: ${p.clientsError} (콘솔 Profile 의 Command ACL 을 확인하세요)`);

  if (has('--catalog')) {
    step(2, '카탈로그 목록(사이트 매핑 드롭다운 원천)');
    const c = await catalogLists(s);
    for (const k of ['clients', 'storages', 'pools', 'schedules', 'jobdefs', 'filesets']) {
      console.log(c[k] ? `  ✔ ${k} ${c[k].length}개: ${c[k].slice(0, 15).join(', ')}` : `  ✖ ${k} 실패: ${c.errors[k]}`);
    }
  }
  if (val('--history')) {
    step(3, `잡 실행 이력: ${val('--history')}`);
    for (const r of await jobHistory(s, val('--history'), 10)) {
      console.log(`  jobid ${r.jobid} · ${r.level} · ${r.status}(${r.state}) · ${r.startedAt ? new Date(r.startedAt).toISOString() : '—'} · ${r.bytes ?? '—'} bytes`);
    }
  }
  if (val('--chain')) {
    step(4, `복원 체인(.bvfs_get_jobids): jobid ${val('--chain')}`);
    const ids = await restoreChain(s, Number(val('--chain')));
    console.log(ids ? `  ✔ ${ids.join(', ')}` : '  ✖ 응답에서 jobid 를 읽지 못했습니다 — 아래 --cmd 로 원문을 확인해 알려 주세요.');
  }
  if (val('--cmd')) {
    step(5, `명령: ${val('--cmd')}`);
    console.log(JSON.stringify(await s.call(val('--cmd')), null, 2).slice(0, 20_000));
  }
  console.log('\n완료.\n');
} catch (e) {
  console.error(`\n✖ ${e?.code ? `[${e.code}] ` : ''}${e?.message || e}\n`);
  if (e?.code === 'tls') console.error('  TLS 1.2 로 비교: --tls12 · 같은 호스트에서 평문 비교: --insecure-plain(시험 전용)\n');
  process.exitCode = 1;
} finally {
  try { s?.close(); } catch { /* */ }
}
