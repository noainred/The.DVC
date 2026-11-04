/**
 * bareos/issueHints.js — 작업 로그 경고·오류 줄의 해석(서버 사본 · v2.885 실패 메일 '원인' 칸).
 * 웹 `web/src/views/tools/bareosText.js ISSUE_HINTS · issueHint` 와 **같은 표**다 — 서버는 웹 소스를 실행 때 불러오지 않으므로(배포본에 web/src 없음)
 * 사본을 두고 시험(bareosMailCause)이 정규식 원문 · 플래그 · 문구를 글자까지 대조한다(판정 코어는 하나 — 한쪽만 고치지 말 것).
 * 처음 맞는 규칙 하나만 쓴다 · 모르는 줄은 해석하지 않는다('' — 지어내지 않는다) · 외부 입력이라 앞 600자만 본다.
 */
export const ISSUE_HINTS = Object.freeze([
  // v2.877(2026-11-04 사용자 로그 JobId 32 — 진짜 원인은 이 한 줄이고 뒤 오류는 그 연쇄였다): FD 플러그인이 vCenter 인증서를 받으려고 vcserver:443 에 붙다 실패.
  //   이름 풀이 실패는 따로(주소 철자 · DNS) — 나머지(Connection refused · timed out · No route to host …)는 접속 실패로 묶는다. 원인을 하나로 단정하지 않는다.
  [/Could not fetch SSL Cert.{0,200}(?:Name or service not known|name resolution|nodename nor servname)/i, 'FD 서버가 vCenter(vcserver) 이름을 풀지 못했습니다 — INI 의 vcserver 철자와 FD 서버의 DNS · /etc/hosts 를 확인하세요(FD 서버에서 getent hosts <주소>).'],
  [/Could not fetch SSL Cert/i, 'FD 서버가 vCenter(vcserver):443 에 접속하지 못했습니다 — INI 의 vcserver 주소가 vCenter 가 맞는지 · vCenter 웹 서비스 · 방화벽을 확인하세요(FD 서버에서 nc -vz <주소> 443). 이 줄 뒤의 오류는 대개 이 실패의 연쇄입니다.'],
  [/job is already cancelled/i, '잡이 이미 취소된 뒤에 나온 줄입니다(앞선 치명 오류 또는 사람의 취소) — 원인은 위의 첫 오류 줄에 있습니다.'],
  [/comm line to SD dropped/i, 'Director 와 SD 사이 연결이 끊겼습니다 — 앞에 치명 오류가 있으면 그 연쇄(잡 취소)이고, 없으면 Director↔SD 네트워크와 bareos-sd 상태를 확인하세요.'],
  [/Python 3\.10 or newer is required/i, 'FD 의 pyVmomi 가 9.x 입니다 — Python 3.9 FD 는 pyVmomi 8.x 로 바꾸고 bareos-fd 를 재시작하세요.'],
  [/Permission denied/i, '저장 경로에 bareos 계정이 쓸 수 없습니다 — 폴더 소유자·NFS 권한·SELinux 를 확인하세요.'],
  [/Please mount|label a new one/i, 'SD 가 쓸 볼륨을 열지 못해 기다렸습니다 — 바로 위 줄(열기 실패 원인)을 먼저 보세요.'],
  [/Could not open|Open device .* fail/i, 'SD 가 볼륨 파일을 열지 못했습니다 — 같은 이름의 디렉터리·권한·디스크 여유를 확인하세요.'],
  [/authenticate|Authorization failed/i, '데몬 사이 인증이 실패했습니다 — 앞선 치명 오류로 잡이 취소된 연쇄일 수 있으니 첫 오류부터 보세요.'],
  [/No space left on device/i, '디스크가 가득 찼습니다 — 저장 경로와 루트(/) 여유 공간을 확인하세요.'],
  [/Overriding plugin option/i, '잡의 플러그인 옵션이 FileSet·INI 값을 덮어썼다는 안내입니다(정상 동작).'],
  [/is not CBT enabled, enabling it now/i, 'VM 에 CBT(변경 블록 추적)가 꺼져 있어 플러그인이 켰습니다 — 문구는 Error 지만 작업은 계속됩니다. 다음 실행부터 바뀐 블록만 읽을 수 있습니다.'],
  // v2.861 커뮤니티 조사(bareos-users · GitHub PR #1473 — docs/design/bareos-ui-v2 §11 ③): 가장 흔한 두 실패의 해석
  [/new full level backup of this job is required/i, '디스크가 옮겨졌거나(복원 · Storage vMotion) 변경 블록 추적이 어긋났습니다 — 증분을 만들 수 없으니 다음 실행을 Full 로 돌리세요(백업 대상 패널의 지금 백업 › Full).'],
  [/quiesc/i, '게스트 정지(quiesce) 스냅샷이 실패했습니다 — 가장 흔한 스냅샷 실패입니다. VMware Tools 상태 · 게스트의 pre-freeze 스크립트 종료 코드 · 남은 스냅샷을 확인하고 다시 실행하세요.'],
]);

/** 줄 → 해석 한 줄('' 이면 모름). */
export function issueHint(text) {
  const s = String(text ?? '').slice(0, 600);
  for (const [re, hint] of ISSUE_HINTS) if (re.test(s)) return hint;
  return '';
}
