/**
 * 용도 프로파일 — **airflow**(기능 · 설계 PROFILES §3 · 근거 A1~A6 원문 ●, A5 만 ◐). 파일 1개 = 프로파일 1개(§1).
 *
 * 감지(읽기 전용 — 1단계 SSH 1회의 구획): running 유닛 이름 `airflow*` · 프로세스 이름(comm) `airflow` 가 **강한 단서**, 계정 `airflow` · 포트 8974(스케줄러 헬스) ·
 *   8793(워커 로그 서버) 은 곁들이 단서(단독으로는 감지하지 않는다 — 8080 처럼 흔한 포트로 오판하지 않게). 수동 태그가 덮어쓴다.
 * ⚠ 프로세스 **인자를 읽지 않는다** — `airflow scheduler` · `api-server` 구분은 인자에 있다(설계 §1 ##PROCS 의 `args` 는 이 구현에서 뺐다 — 인자에 비밀이 실린다).
 *   comm 이 `airflow` 인지 `python3` 인지는 설치 방식(셸 스크립트 진입점 · setproctitle)에 따라 다를 수 있다 — 실장비 미확인(정직 기록).
 * ⚠ 정상 동작 점검의 대부분(jobs check CLI · HTTP health · airflow.cfg · StatsD/OTel 메트릭)은 **이 단계가 실행하지 않는다** → ‘미수집’(정상으로 세지 않는다).
 *   airflow.cfg 는 [database] sql_alchemy_conn 에 비밀번호가 있고 위치(AIRFLOW_HOME)가 현장마다 다르며 환경 변수로 덮인다 — 읽지 않았다.
 * 튜닝: OS 요구값은 없다(카탈로그 상속) · 기능 튜닝(airflow.cfg)은 값을 읽지 않으므로 ‘확인 불가’ 로 근거만 보인다.
 */
const UNIT_RE = /^airflow[A-Za-z0-9@._-]{0,80}\.service$/;
const unitsOf = (tu) => (tu?.units && Array.isArray(tu.units.list) ? tu.units.list : null);

/** 감지(순수) — { detected, evidence[] }. */
export function detectAirflow(tu) {
  const ev = [];
  const units = (unitsOf(tu) || []).filter((u) => UNIT_RE.test(u));
  if (units.length) ev.push({ kind: 'unit', value: units.slice(0, 8).join(' · '), strong: true });
  if (Array.isArray(tu?.procs?.list) && tu.procs.list.includes('airflow')) ev.push({ kind: 'proc', value: 'airflow', strong: true });
  if (Array.isArray(tu?.accounts) && tu.accounts.includes('airflow')) ev.push({ kind: 'account', value: 'airflow', strong: false });
  const ports = Array.isArray(tu?.ports?.list) ? tu.ports.list : [];
  for (const p of [8974, 8793, 8080]) if (ports.includes(p)) ev.push({ kind: 'port', value: String(p), strong: false });
  return { detected: ev.some((e) => e.strong), evidence: ev };
}

const notCollected = (reason) => () => ({ status: 'notCollected', reason });
const cfgTuning = (key, title, recText, evidence, sources, grade) => ({
  key, title, reads: 'airflow.cfg(읽지 않음)', fact: () => undefined, rule: { kind: 'hold', reason: 'appConfigNotRead', text: recText }, evidence, sources, grade,
});

export default Object.freeze({
  id: 'airflow',
  kind: 'app',
  title: 'Apache Airflow',
  matchText: 'running 유닛 airflow* 또는 프로세스 이름 airflow(곁들이 단서: 계정 airflow · 포트 8974 · 8793)',
  match: (tu) => detectAirflow(tu).detected,
  detect: detectAirflow,
  accounts: ['airflow'],
  checks: [
    {
      id: 'af.heartbeat', title: '스케줄러 하트비트', how: 'airflow jobs check --job-type SchedulerJob --hostname $(hostname)',
      judge: notCollected('cmdNotRun'),
      evidence: '“On failure, the command will exit with a non-zero error code.” 운영 가이드: “make sure you have a health check set up that will detect when your scheduler has not heartbeat in a while.”',
      sources: ['A1', 'A2'], grade: '●',
    },
    {
      id: 'af.healthPort', title: '스케줄러 헬스 서버(8974)', how: '수신 포트 8974(ss -ltn) — 켜져 있으면 성능점검(svcmon) HTTP 점검으로 등록할 수 있다',
      judge: ({ tu }) => {
        if (!Array.isArray(tu?.ports?.list)) return { status: 'unknown', reason: 'notRead' };
        return tu.ports.list.includes(8974) ? { status: 'ok', value: '켜짐(포트 수신)' } : { status: 'info', value: '꺼짐(기본)', reason: 'defaultOff' };
      },
      evidence: '200 = 정상 · 503 = 비정상. “[scheduler] enable_health_check to True. By default, it is False … By default, it is 8974.”',
      sources: ['A1'], grade: '●',
    },
    {
      id: 'af.apiHealth', title: 'API 서버 종합 상태', how: 'GET /api/v2/monitor/health(이 단계는 HTTP 점검을 하지 않음)',
      judge: notCollected('httpNotRun'),
      evidence: '컴포넌트별 최신 하트비트(metadatabase · scheduler · triggerer · dag_processor) · 임계값 [scheduler] scheduler_health_check_threshold 등. 웹서버 프로브는 api/v2/version 권고.',
      sources: ['A1'], grade: '●',
    },
    {
      id: 'af.metaDb', title: '메타데이터 DB', how: 'airflow.cfg [database] sql_alchemy_conn(비밀번호가 있어 읽지 않음)',
      judge: notCollected('secretConfig'),
      evidence: '“configure the backend to be an external database such as PostgreSQL or MySQL.” 기본 SQLite 는 시험용.',
      sources: ['A2'], grade: '●',
    },
    {
      id: 'af.executor', title: '실행기(executor)', how: 'airflow.cfg [core] executor(읽지 않음)',
      judge: notCollected('appConfigNotRead'),
      evidence: '“Airflow uses LocalExecutor by default. For a multi-node setup, choose a remote executor, or a multi-executor configuration”',
      sources: ['A2'], grade: '●',
    },
    {
      id: 'af.multiScheduler', title: '다중 스케줄러 조건', how: 'DB 종류·버전 · use_row_level_locking(읽지 않음)',
      judge: notCollected('appConfigNotRead'),
      evidence: '“PostgreSQL 12+ or MySQL 8.0+ are all ready to go” · row-level locking 이 False 면 스케줄러 1개만.',
      sources: ['A3'], grade: '●',
    },
    {
      id: 'af.parseMetrics', title: 'DAG 임포트 오류 · 파싱 시간', how: 'StatsD/OTel: dag_processing.import_errors · total_parse_time · dagbag_size',
      judge: notCollected('metricsNoReceiver'),
      evidence: '메트릭 이름은 공식 목록. 포탈이 받으려면 StatsD 수신기 또는 OTel 수신이 필요하다 — 이번 범위 밖.',
      sources: ['A4'], grade: '●',
    },
    {
      id: 'af.slotMetrics', title: '실행 슬롯 · 굶는 태스크', how: 'executor.open_slots · queued_tasks · pool.open_slots · scheduler.tasks.starving',
      judge: notCollected('metricsNoReceiver'),
      evidence: '같은 메트릭 목록.',
      sources: ['A4'], grade: '●',
    },
    {
      id: 'af.units', title: '서비스 유닛', how: 'running 유닛 airflow*(유닛 이름은 현장마다 다르다 — Airflow 는 유닛을 배포하지 않는다)',
      judge: ({ tu }) => {
        const u = unitsOf(tu);
        if (!u) return { status: 'unknown', reason: 'notRead' };
        const n = u.filter((x) => UNIT_RE.test(x)).length;
        return n ? { status: 'ok', value: `${n}개 실행 중` } : { status: 'info', reason: 'noUnit' };
      },
      evidence: '유닛 이름은 현장 설정이다(Airflow 는 유닛을 배포하지 않음) — journalctl 오류 수는 이 단계에서 실행하지 않는다.',
      sources: [], grade: '○',
    },
  ],
  tunings: [
    cfgTuning('af.maxTisPerQuery', 'scheduler.max_tis_per_query', '≤ core.parallelism(0 = 같게)', '“This should not be greater than core.parallelism. If this is too high then SQL query performance may be impacted … Set this to 0 to use the value of core.parallelism.”', ['A3'], '●'),
    cfgTuning('af.parallelism', 'core.parallelism · max_active_tasks_per_dag', '워커 자원에 맞춰', '전역/DAG별 동시 태스크 상한(3rd party 요약). 공식 설정 참조 원문은 미열람.', ['A5'], '◐'),
    cfgTuning('af.rowLocking', 'scheduler.use_row_level_locking', 'True(스케줄러 2+면 필수)', '“If this is set to False then you should not run more than a single scheduler at once.”', ['A3'], '●'),
    cfgTuning('af.dagrunsPerLoop', 'max_dagruns_per_loop_to_schedule', '작은 DAG 많으면 ↑ · 500+ 태스크 DAG 면 ↓', '“Increasing this limit will allow more throughput for smaller Dags but will likely slow down throughput for larger (>500 tasks …) Dags.”', ['A3'], '●'),
    cfgTuning('af.orphanCheck', 'orphaned_tasks_check_interval · scheduler_health_check_threshold', '기본 유지', '죽은 SchedulerJob 감지·태스크 인계 주기 — “there is no harm in not detecting this for a while.”', ['A3'], '●'),
    cfgTuning('af.parsing', 'parsing_processes · min_file_process_interval', 'CPU 여유만큼 ↑ · 동적 DAG 면 간격 ↑', 'Astronomer: parsing_processes ≈ 2×vCPU, 낮은 간격은 스케줄러 CPU ↑. Airflow 3 는 dag-processor 설정 — 공식 원문 미확인.', ['A5'], '◐'),
    cfgTuning('af.topLevel', 'DAG 상위(top-level) 코드', '무거운 import · Variable 접근 제거', '“avoid writing the top level code which is not necessary to create Operators” · Variables 는 jinja 로(파싱 때 DB 호출 금지).', ['A6'], '●'),
    cfgTuning('af.schedRes', '스케줄러 자원', '병목 자원 증설(working memory 기준)', '“CPU, memory, I/O are the usual limiting factors” · 메모리는 total 이 아니라 working memory 로 본다.', ['A3'], '●'),
  ],
  sources: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
});
