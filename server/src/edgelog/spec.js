/**
 * edgelog/spec.js — 엣지 포탈의 **진행상태**를 어디서 읽는지 적은 표(순수 데이터, v2.549).
 *
 * 사용자 요청: "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능".
 * 로그(콘솔 링버퍼)만으로는 부족하다 — 링버퍼는 1,000줄(`logbuffer.js:7`)이고 **재시작하면 사라진다**.
 * 그래서 로그와 함께 각 모듈이 이미 갖고 있는 `*Status()` 를 함께 읽는다.
 *
 * ⚠⚠ **이 export 들은 v2.548 까지 어떤 라우트도 부르지 않았다**(v2.549 조사에서 전 저장소 grep 으로
 *   확인 — 정의 줄 1건뿐인 것이 19개). 즉 엣지는 자기 push/pull 이 되는지를 **자기 화면에서도**
 *   볼 수 없었다. 이 표가 그 값들을 처음으로 사람이 볼 수 있는 곳으로 끌어낸다.
 *
 * ── 표에 넣는 규칙 ────────────────────────────────────────────────────────────
 *  · `mod` 는 **이미 `index.js` 가 부팅에 import 하는 모듈**만 적는다. 동적 import 가 캐시 적중이라
 *    부작용이 없다(새 모듈을 로드해 타이머를 시작시키는 일이 없어야 한다).
 *  · `relaycheck/poller.js relayCheckStatus` 는 **일부러 뺐다** — 그 응답은 역할별 축약
 *    (`relaycheck/view.js relayCheckView`)을 반드시 거쳐야 하는데(v2.500 D/M1: operator 가 `tools` 를
 *    기본 보유하므로 원격 `haproxy.cfg`·내부 IP 가 샌다) 이 경로에서 그 규칙을 다시 지키게 하면
 *    두 갈래가 된다. relaycheck 는 자기 화면이 이미 있다.
 *  · 중앙 전용 상태(`mail/service.js`·`collector/state.js`·`partfault/poller.js`)도 뺀다 — 엣지에서
 *    읽으면 '꺼짐' 만 돌려주어 화면을 잡음으로 채운다.
 *
 * ⚠ 값에 비밀이 섞일 수 있다(설정 pull 상태가 토큰을 담는 등) — `collect.js` 가 `redactDeep` 으로
 *   훑는다. **이 표에 새 항목을 더할 때 그 가림을 우회하는 경로를 만들지 말 것.**
 */

/** 묶음 라벨 — 화면이 이 순서로 그린다. */
export const GROUP_LABEL = Object.freeze({
  push: '중앙으로 보내기(push)',
  pull: '중앙 설정 받기(pull)',
  collect: '로컬 수집(폴러)',
});

/**
 * @type {ReadonlyArray<{key:string,label:string,group:'push'|'pull'|'collect',mod:string,fn:string}>}
 */
export const STATUS_SPEC = Object.freeze([
  // ── 엣지 → 중앙 ────────────────────────────────────────────────────────────
  { key: 'push.inventory', label: '인벤토리', group: 'push', mod: '../agent/inventoryPush.js', fn: 'inventoryPushStatus' },
  { key: 'push.selfRegister', label: '자기등록', group: 'push', mod: '../agent/selfRegister.js', fn: 'selfRegisterStatus' },
  { key: 'push.capacity', label: '리소스 적정성', group: 'push', mod: '../agent/capacityPush.js', fn: 'capacityPushStatus' },
  { key: 'push.fleet', label: '베어메탈 함대', group: 'push', mod: '../agent/fleetPush.js', fn: 'fleetPushStatus' },
  { key: 'push.guestDisk', label: '게스트 디스크', group: 'push', mod: '../agent/guestDiskPush.js', fn: 'guestDiskPushStatus' },
  { key: 'push.vmseries', label: '실시간 스파이크', group: 'push', mod: '../agent/vmSeriesPush.js', fn: 'vmSeriesPushStatus' },
  { key: 'push.curUser', label: '현재 사용자', group: 'push', mod: '../agent/curUserPush.js', fn: 'curUserPushStatus' },
  { key: 'push.config', label: '설정 사본', group: 'push', mod: '../agent/configPush.js', fn: 'configPushStatus' }, // v2.583 #34
  { key: 'push.gpuGuest', label: 'GPU 게스트', group: 'push', mod: '../agent/gpuGuestPush.js', fn: 'gpuGuestPushStatus' },
  { key: 'push.svcmon', label: '성능 점검(svcmon)', group: 'push', mod: '../agent/svcmonPush.js', fn: 'svcmonPushStatus' },
  { key: 'push.storage', label: '스토리지', group: 'push', mod: '../storage/push.js', fn: 'storagePushStatus' },
  { key: 'push.sanswitch', label: 'SAN 스위치', group: 'push', mod: '../sanswitch/push.js', fn: 'sanSwitchPushStatus' },
  { key: 'push.sanswitchPerf', label: 'SAN 포트 사용량', group: 'push', mod: '../sanswitch/perfPush.js', fn: 'sanSwitchPerfPushStatus' },
  { key: 'push.cvp', label: 'CVP 네트워크 스위치', group: 'push', mod: '../cvp/push.js', fn: 'cvpPushStatus' },
  { key: 'push.pdu', label: 'PDU', group: 'push', mod: '../pdu/push.js', fn: 'pduPushStatus' },
  { key: 'push.partFault', label: '파트 장애', group: 'push', mod: '../partfault/push.js', fn: 'partFaultPushStatus' },
  /*
   * ⚠ v2.554 에 추가 — v2.552 가 이 워커를 만들면서 **이 표에 넣지 않았다**. 그래서 엣지가
   *   보고하지 못하는 상황(개별 토큰 아님 403 · 잴 링크 0개 · 워커 미동작)을 중앙 화면에서도
   *   엣지 로그 화면에서도 볼 수 없었고, 통신 점검 화면은 '첫 보고 대기' 라고만 말했다.
   *   **새 엣지 워커를 만들면 이 표에 함께 넣을 것.**
   */
  { key: 'push.linkCheck', label: '통신 점검', group: 'push', mod: '../agent/linkCheckWorker.js', fn: 'linkCheckWorkerStatus' },
  /*
   * ⚠ v2.561 에 추가 — 이 워커도 표에 없었다. 중앙의 `getLogQueryResult` 는 결과가 없으면
   *   **영원히 `{state:'pending'}`** 이라(`central/logQueries.js:57`) 사용자는 '엣지 로그 조회' 가
   *   왜 안 되는지 알 길이 없었다. 이제 인출 403 · 결과 보고 413 · DB 오류가 여기 드러난다.
   */
  { key: 'push.logQuery', label: '엣지 로그 연합 조회', group: 'push', mod: '../agent/logQueryWorker.js', fn: 'logQueryWorkerStatus' },

  // ── 중앙 → 엣지(설정 수신) ──────────────────────────────────────────────────
  { key: 'pull.storage', label: '스토리지 설정', group: 'pull', mod: '../agent/storageConfigPull.js', fn: 'storageConfigPullStatus' },
  { key: 'pull.sanswitch', label: 'SAN 스위치 설정', group: 'pull', mod: '../agent/sanSwitchConfigPull.js', fn: 'sanSwitchConfigPullStatus' },
  { key: 'pull.cvp', label: 'CVP 설정', group: 'pull', mod: '../agent/cvpConfigPull.js', fn: 'cvpConfigPullStatus' },
  { key: 'pull.pdu', label: 'PDU 설정', group: 'pull', mod: '../agent/pduConfigPull.js', fn: 'pduConfigPullStatus' },
  { key: 'pull.gpuGuest', label: 'GPU 게스트 설정', group: 'pull', mod: '../agent/gpuGuestConfigPull.js', fn: 'gpuGuestConfigPullStatus' },
  { key: 'pull.svcmon', label: 'svcmon 설정', group: 'pull', mod: '../agent/svcmonConfigPull.js', fn: 'svcmonConfigPullStatus' },
  { key: 'pull.curUser', label: '현재 사용자 설정', group: 'pull', mod: '../agent/curUserConfigPull.js', fn: 'curUserConfigPullStatus' },
  { key: 'pull.vmseries', label: '스파이크 설정', group: 'pull', mod: '../agent/vmSeriesConfigPull.js', fn: 'vmSeriesConfigPullStatus' },
  { key: 'pull.users', label: '계정 배포', group: 'pull', mod: '../agent/usersConfigPull.js', fn: 'usersConfigPullStatus' },
  { key: 'pull.partFault', label: '파트 장애 설정', group: 'pull', mod: '../agent/partFaultConfigPull.js', fn: 'partFaultConfigPullStatus' },

  // ── 로컬 수집 ──────────────────────────────────────────────────────────────
  /*
   * ⚠ v2.560 에 추가 — 이 표에 **가장 중요한 폴러가 빠져 있었다**. 중앙이 '빈 인벤토리'(호스트 0 ·
   *   VM 0) push 를 받았을 때 그 원인이 ① 그 엣지에 vCenter 등록 0 ② 첫 수집 중 ③ 접속 실패
   *   ④ mock 이라 push 에서 빠짐 ⑤ 그 vCenter 가 실제로 비었음 중 무엇인지 볼 길이 없었다.
   *   **새 폴러를 만들면 이 표에 함께 넣을 것**(v2.554 가 같은 규약을 적어 두었다).
   */
  { key: 'collect.inventory', label: 'vCenter 인벤토리 수집', group: 'collect', mod: '../store.js', fn: 'storeStatus' },
  { key: 'collect.storage', label: '스토리지 수집', group: 'collect', mod: '../storage/poller.js', fn: 'storagePollerStatus' },
  { key: 'collect.sanswitch', label: 'SAN 스위치 수집', group: 'collect', mod: '../sanswitch/poller.js', fn: 'sanSwitchPollerStatus' },
  { key: 'collect.sanswitchPerf', label: 'SAN 포트 사용량 수집', group: 'collect', mod: '../sanswitch/perfPoller.js', fn: 'sanSwitchPerfStatus' },
  { key: 'collect.cvp', label: 'CVP 수집', group: 'collect', mod: '../cvp/poller.js', fn: 'cvpPollerStatus' },
  { key: 'collect.pdu', label: 'PDU 수집', group: 'collect', mod: '../pdu/poller.js', fn: 'pduPollerStatus' },
  { key: 'collect.curUser', label: '현재 사용자 수집', group: 'collect', mod: '../curuser/poller.js', fn: 'curUserPollerStatus' },
  { key: 'collect.horizon', label: 'Horizon 세션 수집', group: 'collect', mod: '../horizon/sessionPoller.js', fn: 'hzSessionPollerStatus' },
  { key: 'collect.vmseries', label: '스파이크 수집', group: 'collect', mod: '../vmseries/poller.js', fn: 'vmSeriesPollerStatus' },
  { key: 'collect.vmtrack', label: '추이 트래킹', group: 'collect', mod: '../vmtrack/poller.js', fn: 'vmtrackPollerStatus' },
  { key: 'collect.guestDisk', label: '게스트 디스크 수집', group: 'collect', mod: '../guestdisk/poller.js', fn: 'guestDiskPollerStatus' },
  { key: 'collect.bmstor', label: '베어메탈 스토리지', group: 'collect', mod: '../bmstor/poller.js', fn: 'bmPollerStatus' },
  { key: 'collect.metrics', label: '성능 샘플러', group: 'collect', mod: '../metrics/sampler.js', fn: 'metricsSamplerStatus' },
  { key: 'collect.ipamScan', label: 'IPAM 스캔', group: 'collect', mod: '../ipam/scanPoller.js', fn: 'scanStatus' },
  { key: 'collect.osScan', label: '게스트 OS 스캔', group: 'collect', mod: '../inventory/osScanner.js', fn: 'osScanStatus' },
  { key: 'collect.idracScan', label: 'iDRAC 스캔 위임', group: 'collect', mod: '../agent/idracScanWorker.js', fn: 'getIdracScanWorkerStatus' },
  { key: 'collect.ipScanAgent', label: 'IP 스캔 위임', group: 'collect', mod: '../agent/ipScanWorker.js', fn: 'ipScanAgentStatus' }, // v2.583 #34: 무음 실패하던 워커
  { key: 'collect.agentScan', label: '에이전트 스캔', group: 'collect', mod: '../agent/scanner.js', fn: 'getAgentScanStatus' },
  /*
   * ⚠⚠ v2.574 IMP-07 — 아래 7개는 v2.573 까지 **이 표에 없었다**. CLAUDE.md 가 v2.554·v2.560·
   *   v2.561 에 "새 엣지 워커·폴러는 이 표에 함께 넣을 것" 을 **세 번** 적었는데도 빠졌다
   *   (테스트가 `length >= 20` 만 봐서 잡히지 않았다 — 이제 소스 스윕이 고정한다).
   *   앞의 셋은 상태 export 자체가 없어 `catch { return null; }` 로 **무음 실패**하고 있었다.
   */
  { key: 'push.ping', label: 'Ping 위임', group: 'push', mod: '../agent/pingWorker.js', fn: 'pingWorkerStatus' },
  { key: 'push.capture', label: '트래픽 캡처 위임', group: 'push', mod: '../agent/captureWorker.js', fn: 'captureWorkerStatus' },
  { key: 'push.bmstor', label: '베어메탈 스토리지 위임', group: 'push', mod: '../agent/bmstorWorker.js', fn: 'bmstorWorkerStatus' },
  { key: 'collect.bmUsage', label: '베어메탈 사용률 수집', group: 'collect', mod: '../bmusage/poller.js', fn: 'bmUsageStatus' },
  { key: 'collect.linkCheck', label: '통신 점검 수집', group: 'collect', mod: '../linkcheck/poller.js', fn: 'linkCheckPollerStatus' },
  { key: 'collect.gpuPhysical', label: 'GPU 물리 수집', group: 'collect', mod: '../gpu/physicalPoller.js', fn: 'physicalPollerStatus' },
  { key: 'collect.dirUsage', label: '디렉터리 사용량', group: 'collect', mod: '../dirusage/scheduler.js', fn: 'schedulerStatus' },
  /*
   * ⚠ 아래 6개는 v2.574 의 **소스 스윕이 추가로 찾아낸 것**이다(손으로 세던 목록은 이미 7개를
   *   놓친 뒤였다). 전부 `index.js` 가 **조건 없이** 시작하므로 엣지에서도 돈다 —
   *   엣지에서 '꺼짐/유휴' 로 보이는 것은 잡음이 아니라 **사실**이다.
   */
  { key: 'push.edgeLog', label: '엣지 로그 폴백', group: 'push', mod: '../agent/edgeLogWorker.js', fn: 'edgeLogWorkerStatus' },
  { key: 'collect.gpuGuest', label: 'GPU 게스트 수집', group: 'collect', mod: '../gpu/poller.js', fn: 'gpuGuestStatus' },
  { key: 'collect.idrac', label: 'iDRAC 수집', group: 'collect', mod: '../idrac/poller.js', fn: 'getPollerStatus' },
  { key: 'collect.idracScanLocal', label: 'iDRAC 스캔(로컬)', group: 'collect', mod: '../idrac/scanPoller.js', fn: 'idracScanStatus' },
  { key: 'collect.powerOff', label: '전원 꺼짐 점검', group: 'collect', mod: '../tools/powerOffPoller.js', fn: 'powerOffPollerStatus' },
  { key: 'collect.vmClone', label: 'VM 복제 스케줄러', group: 'collect', mod: '../vmclone/scheduler.js', fn: 'schedulerStatus' },
  /*
   * ⚠ v2.613(CONTRACT2613-06 · RUNTIME2613-02) — 아래 셋은 `index.js` 가 **조건 없이 시작**하는데 표에 없었다.
   *   `edgeSweep2574` 의 정규식이 `export function` 만 봐서 `export async function logStatus()` 를 못 봤고,
   *   대상 선정이 파일명(`Worker|poller|scheduler`)이라 `capacity/sampler.js`·`security/certMonitor.js` 는
   *   훑지도 않았다. 이제 스윕은 **index.js 의 `start*` import 원천 모듈**을 대상으로 한다(시작되는 모듈이
   *   곧 대상). `collect.js:62` 가 `await fn()` 이라 async 상태 함수도 그대로 받는다.
   *   `logStatus()` 의 `dbPath` 는 다른 항목(스토리지·vmtrack 폴러)의 경로와 같은 취급이다 — 이 화면은
   *   adminOnly + fullScopeOnly 이고 `redactDeep` 은 비밀 키만 가린다(경로는 진단 정보).
   */
  { key: 'collect.vcLogs', label: 'vCenter 로그·이벤트 수집', group: 'collect', mod: '../logs/poller.js', fn: 'logStatus' },
  { key: 'collect.capacity', label: '리소스 적정성 샘플러', group: 'collect', mod: '../capacity/sampler.js', fn: 'capacitySamplerStatus' },
  { key: 'collect.certs', label: 'TLS 인증서 만료 감시', group: 'collect', mod: '../security/certMonitor.js', fn: 'certStatus' },
]);

/** 표의 키 집합 — 중앙 수신이 모르는 키를 조용히 받아들이지 않게 한다. */
export const STATUS_KEYS = Object.freeze(new Set(STATUS_SPEC.map((s) => s.key)));

/** 키 → 라벨(중앙 화면이 구버전 엣지의 키도 사람 말로 그릴 수 있게). */
export const STATUS_LABEL = Object.freeze(Object.fromEntries(STATUS_SPEC.map((s) => [s.key, s.label])));
