/**
 * mock/demo/bmTop.js — 데모(mock) 대상의 **프로세스 Top-N 합성 표본**(8b단계 ⑳ — 화면 확인용). 장비에 접속하지 않는다 · 같은 저장 경로(topStore.topWriteBatch)로 들어간다.
 *   값은 parse/linuxTop.js parseTop 과 같은 모양 — 대상마다 용도 꼴(GPDB · Airflow · 일반)을 키 해시로 고르고 하루 주기 + 피크를 얹는다(수치는 가상).
 *   첫 호출은 최근 24시간(5분)을 함께 돌려준다(띠 · ◀ ▶ 확인용 · 대상 12대까지). I/O 는 한 프로세스를 ‘권한 없음’ 으로(— 칸 확인).
 */
const HOUR = 3_600_000;
const STEP = 5 * 60_000;
let _backfilled = false;
export function _resetDemoTopForTest() { _backfilled = false; }

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const r1 = (v) => Math.round(v * 10) / 10;

const ROLES = [
  [['postgres', 'gpadmin'], ['postgres', 'gpadmin'], ['kswapd0', 'root'], ['node_exporter', 'root'], ['sshd', 'root'], ['postgres', 'gpadmin']],
  [['airflow', 'airflow'], ['celery', 'airflow'], ['python3', 'airflow'], ['chronyd', 'chrony'], ['sshd', 'root'], ['rsyslogd', 'root']],
  [['java', 'app'], ['nginx', 'nginx'], ['node_exporter', 'root'], ['kworker/2:1-events', 'root'], ['sshd', 'root'], ['crond', 'root']],
];

/** 대상 하나 · 시각 하나 → parseTop 모양. */
export function demoTopValue(tg, t) {
  const h = hash(String(tg.key || ''));
  const role = ROLES[h % ROLES.length];
  const hod = ((t / HOUR) + 9) % 24;
  const day = Math.sin(((hod - 6) / 24) * 2 * Math.PI) * 0.5 + 0.5;
  const peak = ((Math.floor(t / STEP) + h) % 37) === 0 ? 1.8 : 1;
  const bootMs = Math.floor(t / (7 * 86_400_000)) * 7 * 86_400_000 - (h % 5) * 86_400_000;   // 대상마다 고정 부팅(주 단위로만 바뀐다 — 같은 PID · 시작이 이어진다)
  const upS = Math.floor((t - bootMs) / 1000);
  const base = 1000 + (h % 5000);
  const cpu = role.map(([comm, user], i) => {
    const v = Math.max(0, r1((i === 0 ? 55 : i === 1 ? 14 : 4 / (i + 1)) * (0.3 + day) * peak));
    const start = i < 2 ? 3_600 + i * 900 : 7_200 + i * 13;
    return { pid: base + i * 7, user, state: v > 20 ? 'R' : i === 1 && peak > 1 ? 'D' : 'S', comm, cpu: v, cpuS: r1((t / 1000 - 1.7e9) * (i === 0 ? 0.55 : i === 1 ? 0.14 : 0.01)), start,
      rssKb: Math.round((i < 2 ? 3_000_000 : 40_000) * (1 + (i % 3) * 0.1)), rd: i === 3 ? null : Math.round((i < 2 ? 200 : 2) * 1e6 * day), wr: i === 3 ? null : Math.round((i < 2 ? 40 : 1) * 1e6 * day), ioPerm: i === 3 };
  }).sort((a, b) => b.cpu - a.cpu);
  const mem = [...cpu].sort((a, b) => b.rssKb - a.rssKb).slice(0, 5).map((x) => ({ pid: x.pid, user: x.user, rssKb: x.rssKb, state: x.state, etimes: Math.max(0, Math.floor(upS - x.start)), comm: x.comm, start: x.start }));
  const io = cpu.filter((x) => x.rd != null && x.wr != null).sort((a, b) => (b.rd + b.wr) - (a.rd + a.wr)).slice(0, 5);
  const tot = r1(cpu.reduce((a, x) => a + x.cpu, 0) + 2.6);
  return { src: 'top', dtS: 1.02, clk: 100, pageKb: 4, uptimeS: upS, nproc: 380 + (h % 60), nrun: cpu.filter((x) => x.state === 'R').length + 1, nd: cpu.filter((x) => x.state === 'D').length,
    cpuTotal: tot, candidates: cpu.length, cpu, mem, io, ioPerm: 1, ioUnknown: 0, unparsed: 0, capped: false };
}

/** 이번 주기 항목(첫 호출은 최근 24시간 5분 표본을 앞에 붙인다 — 대상 12대까지). */
export function demoTopItems(targets = [], now = Date.now()) {
  const list = (targets || []).filter((x) => x?.key);
  const out = [];
  if (!_backfilled) {
    _backfilled = true;
    for (const tg of list.slice(0, 12)) for (let t = Math.floor((now - 24 * HOUR) / STEP) * STEP; t < now - STEP; t += STEP) out.push({ key: tg.key, ts: t, top: demoTopValue(tg, t) });
  }
  for (const tg of list) out.push({ key: tg.key, ts: now, top: demoTopValue(tg, now) });
  return out;
}
