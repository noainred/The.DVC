/**
 * bmusage/perfCols.js — 리눅스 성능 1단계(v2.919)의 **새 지표 열 계약**(순수 · 이 목록이 단일 원천).
 *
 * 설계 `docs/design/linux-bm-perf/README.md` §4 의 USE 칸과 1:1 로 맞춘다 — db.js(열·마이그레이션·일 롤업)·usage.js(값)·
 *   useJudge.js(판정)·라우트(응답)가 같은 표를 쓴다. 열을 늘리면 이 표에만 더한다(세 곳에 따로 적으면 갈라진다).
 *
 *  · `res`  — 자원 축(cpu · mem · disk · net). 하드웨어 축(hw)은 iDRAC 쪽 사실이라 열이 아니다(hwFacts.js).
 *  · `use`  — USE 칸(U 사용률 · S 포화 · E 오류).
 *  · `judged` — 참이면 판정(useJudge)이 그 칸의 등급을 이 값으로 정한다. 거짓이면 **근거(evidence)** 로만 싣는다
 *    (예: load1 은 runq_per_core 의 원재료 · iowait 는 사실상 idle 이라 사용률 판정에 넣지 않는다).
 *  · 이름은 node_exporter 와 가깝게(나중에 에이전트 연동이 쉽도록 — 설계 §3.1) 하되 열 이름 규약(소문자_밑줄)을 따른다.
 *
 * ⚠ 일 롤업은 **최대만** 둔다(`<col>_max`) — 포화·오류 칸은 피크가 뜻이고, 평균을 더하면 열이 두 배다(사용률 다섯 지표의 평균+최대 규약은 그대로).
 */
export const PERF_COLS = Object.freeze([
  // CPU — U 분해 · S 런큐/PSI · (E 는 OS 경로에 없다: MCE 는 이번 단계에서 읽지 않는다 → iDRAC 하드웨어 축)
  { col: 'cpu_user_pct', res: 'cpu', use: 'U', judged: false, unit: '%', label: 'CPU user' },
  { col: 'cpu_sys_pct', res: 'cpu', use: 'U', judged: false, unit: '%', label: 'CPU system(+irq·softirq)' },
  { col: 'cpu_iowait_pct', res: 'cpu', use: 'U', judged: false, unit: '%', label: 'CPU iowait' },
  { col: 'cpu_steal_pct', res: 'cpu', use: 'U', judged: false, unit: '%', label: 'CPU steal' },
  { col: 'cpu_core_max_pct', res: 'cpu', use: 'U', judged: false, unit: '%', label: '코어 최고' },
  { col: 'load1', res: 'cpu', use: 'S', judged: false, unit: '', label: 'load 1분' },
  { col: 'load5', res: 'cpu', use: 'S', judged: false, unit: '', label: 'load 5분' },
  { col: 'load15', res: 'cpu', use: 'S', judged: false, unit: '', label: 'load 15분' },
  { col: 'runq_per_core', res: 'cpu', use: 'S', judged: true, unit: '', label: '런큐/코어(load1 ÷ 코어)' },
  { col: 'ctxt_ps', res: 'cpu', use: 'S', judged: false, unit: '/s', label: '문맥 전환' },
  { col: 'psi_cpu_some10', res: 'cpu', use: 'S', judged: true, unit: '%', label: 'PSI cpu some 10초' },
  { col: 'psi_cpu_some60', res: 'cpu', use: 'S', judged: false, unit: '%', label: 'PSI cpu some 60초' },
  // 메모리 — U 는 기존 mem_pct · S 스왑/폴트/PSI · E OOM(iDRAC ECC 와 나란히 — 합산하지 않는다)
  { col: 'swap_in_ps', res: 'mem', use: 'S', judged: false, unit: 'pages/s', label: '스왑 인' },
  { col: 'swap_out_ps', res: 'mem', use: 'S', judged: true, unit: 'pages/s', label: '스왑 아웃' },
  { col: 'pgmajfault_ps', res: 'mem', use: 'S', judged: false, unit: '/s', label: '메이저 폴트' },
  { col: 'psi_mem_full10', res: 'mem', use: 'S', judged: true, unit: '%', label: 'PSI memory full 10초' },
  { col: 'psi_mem_full60', res: 'mem', use: 'S', judged: false, unit: '%', label: 'PSI memory full 60초' },
  { col: 'oom_kill_delta', res: 'mem', use: 'E', judged: true, unit: '건', label: 'OOM kill 증가' },
  // 디스크 — U 는 기존 disk_busy_pct · S 대기열/PSI(await 는 근거) · E 는 OS 경로에 없다(SMART — iDRAC)
  { col: 'disk_iops', res: 'disk', use: 'U', judged: false, unit: '/s', label: 'IOPS(최대 장치)' },
  { col: 'disk_await_ms', res: 'disk', use: 'S', judged: false, unit: 'ms', label: 'await(최대 장치)' },
  { col: 'disk_inflight', res: 'disk', use: 'S', judged: false, unit: '', label: 'in-flight(순간값 · 최대 장치)' },
  { col: 'disk_aqu', res: 'disk', use: 'S', judged: true, unit: '', label: '평균 대기열(aqu-sz · 최대 장치)' },
  { col: 'procs_blocked', res: 'disk', use: 'S', judged: false, unit: '', label: 'D 상태 프로세스(순간값)' },
  { col: 'psi_io_full10', res: 'disk', use: 'S', judged: true, unit: '%', label: 'PSI io full 10초' },
  { col: 'psi_io_full60', res: 'disk', use: 'S', judged: false, unit: '%', label: 'PSI io full 60초' },
  // 네트워크 — U 는 기존 net_pct · S 드롭/재전송 · E 오류(iDRAC CRC 는 다른 칸 — 교차 ④)
  { col: 'net_drop_delta', res: 'net', use: 'S', judged: true, unit: '건', label: '드롭 증가(최대 NIC)' },
  { col: 'tcp_retrans_pct', res: 'net', use: 'S', judged: true, unit: '%', label: 'TCP 재전송률' },
  { col: 'net_err_delta', res: 'net', use: 'E', judged: true, unit: '건', label: '오류 증가(최대 NIC)' },
]);

/** 열 이름만 — SQL 조립·적재·응답 필드 목록이 쓴다. */
export const PERF_COL_NAMES = Object.freeze(PERF_COLS.map((c) => c.col));
/** 최신값 전용 열(이력·롤업에 넣지 않는다) — 두 경로 읽은 시각 + 장치별·튜닝 현재값 JSON(이력 적재는 3단계). */
export const LATEST_ONLY_COLS = Object.freeze(['os_at', 'idrac_at', 'detail_json', 'tuning_json']);
/** JSON 열 크기 상한(바이트) — 넘치면 적재하지 않고 `{truncated:true}` 만 둔다(조용히 잘린 JSON 을 만들지 않는다). */
export const JSON_COL_MAX = 64 * 1024;
