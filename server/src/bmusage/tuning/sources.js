/**
 * bmusage/tuning/sources.js — 튜닝 탭 · 용도 프로파일의 **근거 문서 목록**(v2.923 예정 · 리눅스 성능 4단계).
 *
 * 원천: `docs/design/linux-bm-perf/TUNING-SOURCES.md` ‘근거 문서 목록’(R1 · R2 · H1~H9 — 11건) · `PROFILES.md` §7(A1~A6 · G1~G4 · R3 — 11건).
 * 화면의 각 행은 이 id 를 가리킨다(각주 번호). 값을 화면에 흩뿌리지 않는다 — 웹은 API 가 내려 준 이 표를 그대로 그린다.
 *
 * 등급(설계 그대로):
 *   ● 공식 문서 **원문을 받아** 문장을 대조했다 · ◐ 공식 문서지만 **검색 결과에 인용된 문장**으로만 확인 · ○ 공식 문서에서 권고 문장을 찾지 못했다(이 표에는 ○ 문서가 없다 — 항목 쪽 등급).
 * ⚠ 정직 기록(설계 §6-9): Red Hat 문서(H1~H9)는 원문을 열지 못했다(docs.redhat.com 이 비브라우저 요청 403 — 사용자 에이전트를 바꿔 우회하지 않았다).
 *   이 구현 단계에서도 원문을 다시 대조하지 않았다(브라우저 대조는 TUNING-SOURCES 구현 메모의 남은 일).
 */
export const GRADES = Object.freeze(['●', '◐', '○']);

/** 튜닝 탭 근거 문서 11건(TUNING-SOURCES). */
export const TUNING_SOURCES = Object.freeze([
  { id: 'R1', title: 'Rocky Linux · KVM tuning (Rocky 8·9·10 공통)', url: 'https://docs.rockylinux.org/guides/virtualization/kvm_tuning/', how: '원문 수신(HTTP 200) · 문장 대조', grade: '●' },
  { id: 'R2', title: 'Rocky Linux 10 · IRQs and kernel packet drops (network performance tuning)', url: 'https://docs.rockylinux.org/10/guides/network/performance_tuning/network_performance_irq_tuning/', how: '원문 수신(HTTP 200) · 문장 대조', grade: '●' },
  { id: 'H1', title: 'RHEL 9 · Monitoring and managing system status and performance › Getting started with TuneD', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/getting-started-with-tuned_monitoring-and-managing-system-status-and-performance', how: '검색 발췌(docs.redhat.com 이 비브라우저 요청 403)', grade: '◐' },
  { id: 'H2', title: 'RHEL 9 · 같은 문서 › Setting the disk scheduler', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/setting-the-disk-scheduler_monitoring-and-managing-system-status-and-performance', how: '검색 발췌', grade: '◐' },
  { id: 'H3', title: 'RHEL 9 · 같은 문서 › Configuring huge pages (THP · HugeTLB)', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-huge-pages_monitoring-and-managing-system-status-and-performance', how: '검색 발췌', grade: '◐' },
  { id: 'H4', title: 'RHEL 9 · 같은 문서 › Configuring an operating system to optimize memory access', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-an-operating-system-to-optimize-memory-access_monitoring-and-managing-system-status-and-performance', how: '검색 발췌', grade: '◐' },
  { id: 'H5', title: 'RHEL 9 · 같은 문서 › Configuring an operating system to optimize CPU utilization (numad · irqbalance · tuna)', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/monitoring_and_managing_system_status_and_performance/configuring-an-operating-system-to-optimize-cpu-utilization_monitoring-and-managing-system-status-and-performance', how: '검색 발췌', grade: '◐' },
  { id: 'H6', title: 'RHEL 8 · Tuning CPU frequency to optimize energy consumption / RHEL 10 · Optimizing CPU frequency scaling', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/8/html/monitoring_and_managing_system_status_and_performance/tuning-cpu-frequency-to-optimize-energy-consumption_monitoring-and-managing-system-status-and-performance', how: '검색 발췌(RHEL 9 판 미확인)', grade: '◐' },
  { id: 'H7', title: 'RHEL 10 · Network troubleshooting and performance tuning › Tuning IRQ balancing · Tuning UDP connections', url: 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/network_troubleshooting_and_performance_tuning/tuning-irq-balancing', how: '검색 발췌(RHEL 10 — 9 와 다를 수 있음)', grade: '◐' },
  { id: 'H8', title: 'RHEL 6 · Performance Tuning Guide 5.5 Tuning Virtual Memory (swappiness 10 · Oracle 예시)', url: 'https://docs.redhat.com/en/documentation/red_Hat_enterprise_linux/6/html/performance_tuning_guide/s-memory-tunables', how: '검색 발췌 · 구판', grade: '◐' },
  { id: 'H9', title: 'Red Hat 솔루션 6773531 (RHEL 8.5+ 에서 intel_cpufreq 로드) · RHEL 9 Managing power consumption with PowerTOP', url: 'https://access.redhat.com/solutions/6773531', how: '검색 발췌', grade: '◐' },
]);

/** 용도 프로파일 근거 문서 11건(PROFILES §7 — 확인일 2026-11-06). */
export const PROFILE_SOURCES = Object.freeze([
  { id: 'A1', title: 'Apache Airflow (stable) · Checking Airflow Health Status', url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/check-health.html', how: '원문(HTTP 200)', grade: '●' },
  { id: 'A2', title: 'Apache Airflow (stable) · Production Deployment', url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/production-deployment.html', how: '원문', grade: '●' },
  { id: 'A3', title: 'Apache Airflow (stable) · Scheduler', url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/scheduler.html', how: '원문', grade: '●' },
  { id: 'A4', title: 'Apache Airflow (stable) · Metrics Configuration', url: 'https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/logging-monitoring/metrics.html', how: '원문', grade: '●' },
  { id: 'A5', title: 'Astronomer · Scaling Airflow to optimize performance (3rd party)', url: 'https://www.astronomer.io/docs/learn/airflow-scaling-workers', how: '검색 발췌', grade: '◐' },
  { id: 'A6', title: 'Apache Airflow (stable) · Best Practices', url: 'https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html', how: '원문', grade: '●' },
  { id: 'G1', title: 'Tanzu Greenplum 7 · Configuring Your Systems', url: 'https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/install_guide-prep_os.html', how: '원문', grade: '●' },
  { id: 'G2', title: 'Tanzu Greenplum 7 · System Configuration (Best Practices)', url: 'https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/best_practices-sysconfig.html', how: '원문', grade: '●' },
  { id: 'G3', title: 'Tanzu Greenplum 7 · Recommended Monitoring and Maintenance Tasks', url: 'https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/admin_guide-monitoring-monitoring.html', how: '원문', grade: '●' },
  { id: 'G4', title: 'Tanzu Greenplum 7 · System Monitoring and Maintenance', url: 'https://techdocs.broadcom.com/us/en/vmware-tanzu/data-solutions/tanzu-greenplum/7/greenplum-database/best_practices-maintenance.html', how: '원문', grade: '●' },
  { id: 'R3', title: 'Rocky Linux · Release notes 9.4', url: 'https://docs.rockylinux.org/9/release_notes/9_4/', how: '원문', grade: '●' },
]);

const BY_ID = new Map([...TUNING_SOURCES, ...PROFILE_SOURCES].map((s) => [s.id, s]));
/** id → 문서(없으면 null). */
export function sourceOf(id) { return BY_ID.get(String(id || '')) || null; }
/** 모든 문서(튜닝 + 용도). */
export const ALL_SOURCES = Object.freeze([...TUNING_SOURCES, ...PROFILE_SOURCES]);
/** 확인일(설계 문서의 확인일 — 화면 각주). */
export const SOURCES_CHECKED_AT = '2026-11-06';
