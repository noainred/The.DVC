/**
 * scanWorker.js — IP 스캔 전용 **자식 프로세스**(v2.363). child_process.fork 로 띄워지고,
 * 부모(중앙 scanPoller / 엣지 ipScanWorker)와 IPC 로만 통신한다.
 *
 * 왜 별도 프로세스인가(핵심):
 *  - 스캔은 TCP 소켓 다수 + (죽은 IP) ping 프로세스 스폰 + 역DNS 로 **FD·CPU 를 많이 쓴다**.
 *    이걸 메인 포탈 안에서 돌리면 그 부하·FD 가 포탈 이벤트 루프/FD 테이블을 잠식해, 폭주 시
 *    HTTP accept 가 막혀 포탈 전체가 먹통이 된다(v2.359 실제 장애).
 *  - 자식 프로세스는 **자기만의 FD 테이블·이벤트 루프**를 가지므로, 여기서 무슨 일이 나도
 *    부모 포탈은 계속 응답한다. 최악의 경우 부모가 데드라인에 이 자식을 SIGKILL 하고 다음
 *    주기에 새로 포크한다(scanRunner). fping 이 있으면 자식 안에서 배치 ping 으로 더 가볍게.
 *
 * DB·store 는 건드리지 않는다(순수 scanRanges 만). 결과 병합·보고는 부모가 한다.
 * 메시지 프로토콜:
 *   부모 → 자식: { job: { ranges, ports, concurrency, timeoutMs, reverseDns, ping } }
 *   자식 → 부모: { type:'progress', done, total, alive } | { type:'alive', rows:[...] } | { type:'done', scanned, alive:[...] } | { type:'error', message }
 *
 * v2.733(점검 3회차 C1-02): 'alive' 는 1단계(TCP)에서 찾은 생존 IP 를 조금씩 미리 보내는 **부분 결과**다 — 부모가 시한에
 *   이 자식을 죽이면 'done' 이 오지 않아 그때까지 찾은 것이 전부 사라졌다(v2.732 B4-02 가 메인 재실행을 없앤 뒤로는 결과 0).
 *   부모는 이것을 시한 초과 때만 쓴다(마지막 확인 시각 갱신 — 해제 판정 근거로는 쓰지 않는다). 상한 PARTIAL_MAX · 500ms 묶음.
 */
import { scanRanges } from './scan.js';

// 포크된 자식으로만 의미가 있다(직접 실행/임포트 시 no-op).
if (process.send) {
  let handled = false;
  process.on('message', async (msg) => {
    if (handled || !msg || !msg.job) return;
    handled = true; // 잡은 1회만 — 자식은 잡 하나 처리 후 종료(부모가 매 스캔 새로 포크)
    const j = msg.job;
    // 진행률은 너무 잦으면 IPC 부하 → 최소 간격으로 스로틀.
    let lastSent = 0;
    // v2.733: 부분 결과(1단계 생존 IP) — 묶어서 보낸다. 남은 것은 500ms 타이머가 내보낸다(그 뒤 탐침이 시한까지 매달려도 남지 않게).
    const PARTIAL_MAX = 20_000; const BATCH = 200;
    let pend = []; let partialN = 0; let lastAlive = 0;
    const flushAlive = (force) => {
      if (!pend.length) return;
      const now = Date.now();
      if (!force && pend.length < BATCH && now - lastAlive < 500) return;
      lastAlive = now;
      const rows = pend; pend = [];
      try { process.send({ type: 'alive', rows }); } catch { /* 부모 종료 */ }
    };
    const aliveTimer = setInterval(() => flushAlive(true), 500);
    aliveTimer.unref?.();
    try {
      const { scanned, alive } = await scanRanges(j.ranges || [], {
        ports: j.ports, concurrency: j.concurrency, timeoutMs: j.timeoutMs, reverseDns: j.reverseDns, ping: j.ping,
        onTcpAlive: (row) => { if (partialN >= PARTIAL_MAX) return; partialN++; pend.push(row); flushAlive(false); },
        onProgress: (done, total, aliveN) => {
          const now = Date.now();
          if (now - lastSent >= 500 || done === total) { lastSent = now; try { process.send({ type: 'progress', done, total, alive: aliveN }); } catch { /* 부모 종료 */ } }
          if (done === total) flushAlive(true); // 1단계가 끝났다 — 2단계(ping·역DNS)가 시한에 걸려도 1단계 생존 IP 는 부모에 있다
        },
      });
      clearInterval(aliveTimer); pend = []; // 'done' 에 전체가 실린다 — 부분 결과를 더 보내지 않는다
      try { process.send({ type: 'done', scanned, alive }); } catch { /* */ }
    } catch (e) {
      clearInterval(aliveTimer);
      try { process.send({ type: 'error', message: e?.message || String(e) }); } catch { /* */ }
    } finally {
      // 메시지 플러시 여유 후 종료(부모가 먼저 kill 하면 그게 우선).
      setTimeout(() => process.exit(0), 200).unref?.();
    }
  });
  // 부모가 IPC 채널을 닫으면(정상 종료/데드라인) 자식도 함께 종료.
  process.on('disconnect', () => process.exit(0));
}
