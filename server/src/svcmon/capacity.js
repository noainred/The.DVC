/**
 * 용량 판정 — 대량 등록·CSV 가져오기·템플릿 적용이 커밋 전에 "이 규모를 폴러가 소화할 수
 * 있는지" 계산한다.
 *
 * 왜 필요한가: 만기 처리량을 넘기면 등록은 성공하지만 감시가 지정한 주기로 돌지 않는다.
 * 정확히 무슨 일이 벌어지는지 시뮬레이션으로 확인했다(720틱=1시간, 15만 항목·주기 60초·
 * 천장 800/s): 앞쪽 48,000개는 정확히 60초로 돌고 **나머지 102,000개(68%)는 한 번도 실행되지
 * 않았다.** 즉 '모두의 주기가 조금씩 늘어난다'가 아니라 '뒤쪽은 아예 안 돈다'였다.
 * (v2.244 에서 poller 선정을 원형 커서로 바꿔 지연을 전체에 분산했지만, 천장을 넘는 구성은
 *  여전히 designed 주기를 지킬 수 없다 — 그래서 커밋 전에 거부한다.)
 *
 * 상수 출처는 `docs/SVCMON-ARCHITECTURE.md` §3 실측표(4워커 249/s, ping 워커당 약 16/s)이며
 * 화면에도 그 출처를 표시한다. 워커 수는 하드코딩하지 않고 실제 설정값을 쓴다.
 */

import os from 'node:os';

const PER_WORKER_SOCKET = 62;   // 249/s ÷ 4워커 (소켓 대기형: tcp/http/dns/배너…)
const PER_WORKER_PROC = 16;     // 64 동시 ÷ 4초 타임아웃 (프로세스 생성형: ping/trace)
const PROC_TYPES = new Set(['ping', 'trace']);

const envInt = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : dflt;
};

/** 워커 수 — poller/pool 과 같은 규칙(0 이면 인라인이라 1로 센다). */
export function workerCount() {
  const raw = process.env.SVCMON_WORKERS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(1, Math.round(n));   // 0=인라인도 1개 스레드분
  }
  // pool.js 와 **같은 식**이어야 한다. 이전에는 os.cpus() 를 보지 않고 4를 가정해
  // 8코어에서 실제 4워커를 3으로(처리량 25% 과소평가), 2코어에서 실제 1워커를 3으로
  // (3배 과대평가) 계산했다 — 과대평가는 '가능하다'고 통과시킨 뒤 실제로는 못 도는 상태다.
  return Math.max(1, Math.min(4, Math.max(1, os.cpus().length - 1)));
}

/** 틱 상한이 만드는 절대 천장 — 어떤 튜닝으로도 이보다 많은 만기는 소화할 수 없다. */
export function tickCeilingPerSec() {
  const maxPerTick = envInt('SVCMON_MAX_PER_TICK', 4000);
  const tickMs = envInt('SVCMON_TICK_MS', 5000);
  return Math.round((maxPerTick / tickMs) * 1000);
}

/**
 * 점검 목록의 초당 필요 처리량. `{intervalSec, type, enabled}` 만 본다.
 * 중지(enabled=false)된 항목은 만기 인덱스에 들어가지 않으므로 부하가 0이다.
 */
export function requiredPerSec(tests = []) {
  let all = 0;
  let proc = 0;
  for (const x of tests) {
    if (x?.enabled === false) continue;
    const iv = Math.max(1, Number(x?.intervalSec) || 60);
    const rate = 1 / iv;
    all += rate;
    if (PROC_TYPES.has(x?.type)) proc += rate;
  }
  return { all, proc };
}

/**
 * 판정 — 'ok' | 'warn' | 'reject'.
 * reject 는 틱 천장을 넘긴 경우로, 등록해도 designed 주기로 돌지 않으므로 400 으로 거부한다.
 * warn 은 워커를 늘리거나 주기를 늘리면 해소되는 범위다.
 */
export function judgeCapacity({ tests = [], addedTests = [] } = {}) {
  const cur = requiredPerSec(tests);
  const add = requiredPerSec(addedTests);
  const need = cur.all + add.all;
  const needProc = cur.proc + add.proc;
  const workers = workerCount();
  const capable = workers * PER_WORKER_SOCKET;
  const procCapable = workers * PER_WORKER_PROC;
  const ceiling = tickCeilingPerSec();

  const reasons = [];
  let verdict = 'ok';
  if (need > ceiling) {
    verdict = 'reject';
    reasons.push(`틱 상한 초과: 필요 ${need.toFixed(1)}/s > 천장 ${ceiling}/s. 등록해도 지정한 주기로 돌지 않습니다(주기를 늘리거나 SVCMON_MAX_PER_TICK 을 조정하세요).`);
  } else {
    if (need > capable) {
      verdict = 'warn';
      reasons.push(`처리량 부족 가능: 필요 ${need.toFixed(1)}/s > 추정 가능 ${capable}/s (워커 ${workers}개). 주기를 늘리거나 SVCMON_WORKERS 를 늘리세요.`);
    }
    if (needProc > procCapable) {
      verdict = 'warn';
      reasons.push(`ping/trace 부족 가능: 필요 ${needProc.toFixed(1)}/s > 추정 가능 ${procCapable}/s. ping 은 프로세스를 띄우므로 TCP 점검 병용을 권합니다.`);
    }
  }

  // 로그량 — 링버퍼 초과분은 오래된 행부터 폐기되므로(csvlog) 미리 알린다.
  const bytesPerDay = Math.round(need * 86400 * 98);
  return {
    verdict,
    reasons,
    requiredPerSec: Number(need.toFixed(2)),
    requiredProcPerSec: Number(needProc.toFixed(2)),
    capablePerSec: capable,
    procPerSec: procCapable,
    tickCeilingPerSec: ceiling,
    workers,
    logBytesPerDay: bytesPerDay,
    logGbPerDay: Number((bytesPerDay / 1073741824).toFixed(2)),
    source: 'docs/SVCMON-ARCHITECTURE.md §3 실측(4워커 249/s · ping 워커당 16/s)',
  };
}

/** 권장 주기 — 현재 워커 수로 소화 가능한 최소 주기(초). */
export function suggestIntervalSec(totalTestCount, workers = workerCount()) {
  const capable = Math.max(1, workers * PER_WORKER_SOCKET);
  return Math.max(10, Math.ceil(totalTestCount / capable));
}
