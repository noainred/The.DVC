// 가짜 `ping`(PATH 앞에 두는 sleep) 공용 헬퍼 — audit2732d·audit2733b 가 같이 쓴다.
// 스크립트는 자기 PID 를 남기고 sleep 으로 바뀐다(exec — execFile 시한이 sleep 자체를 죽인다).
// 정리(killOwned)는 그 PID 가 **아직 이 헬퍼가 띄운 sleep 일 때만** 죽인다: 로그에 남은 PID 의 sleep 이 이미 끝났다면
// 커널이 그 번호를 다른 프로세스(병렬로 도는 다른 테스트 파일의 자식 등)에 다시 줬을 수 있다. 소유 표지는 exec 된 sleep 의
// 환경에만 싣는 `DVC_FAKE_PING=<dir>`(mkdtemp 디렉터리 — 파일마다 다르다). cmdline 'sleep 30' 은 두 파일 공통이라 표지로 못 쓴다.
import fs from 'node:fs';
import path from 'node:path';

const MARK = 'DVC_FAKE_PING';

// 단일 인용부호 안에 넣을 수 있게 — mkdtemp 경로에는 보통 없지만 os.tmpdir() 가 무엇이든 깨지지 않게 한다.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 이 PID 가 dir 표지를 단 가짜 ping 인가 — 못 읽으면(이미 끝남·/proc 없음·권한) false. */
export function ownsPid(pid, dir) {
  let env;
  try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return false; }
  return env.split('\0').includes(`${MARK}=${dir}`);
}

export function installFakePing(dir) {
  const log = path.join(dir, 'pids');
  fs.writeFileSync(path.join(dir, 'ping'), `#!/bin/sh\necho $$ >> ${shQuote(log)}\nexport ${MARK}=${shQuote(dir)}\nexec sleep 30\n`, { mode: 0o755 });
  const pids = () => { try { return fs.readFileSync(log, 'utf8').split('\n').map((x) => Number(x)).filter((n) => n > 0); } catch { return []; } };
  // 표지가 없으면 죽이지 않는다 — 진짜 가짜 ping 을 놓쳐도 30초 뒤 스스로 끝나므로 무해하다.
  const killOwned = () => {
    for (const pid of pids()) {
      if (!ownsPid(pid, dir)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* 확인과 kill 사이에 끝남 */ }
    }
  };
  return { pids, killOwned };
}
