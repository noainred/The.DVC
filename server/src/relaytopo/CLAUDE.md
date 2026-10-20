# 중계 토폴로지(`relaytopo/`, v2.431) 불변조건 — v2.435 감사 조치, 되돌리지 말 것

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

- **host 변경 시 저장 비밀 미이월**(`store.js normNode`·`mergeImport mergeNode`·Main): 노드의
  privateIp/publicIp 가 바뀌면 password/privateKey/passphrase 를 **전부 버린다**. dc 이름만 보고
  이월하던 v2.431 은 `publicIp` 만 공격자 호스트로 바꾸고 비밀을 빈 값으로 저장한 뒤 SSH 테스트를
  부르면 운영 비밀번호가 그 호스트로 평문 전송됐다(uagmon v2.257 M3 와 같은 패턴의 회귀).
  저장·가져오기 **양쪽 모두** 유지할 것 — 한쪽만 남기면 다른 경로로 뚫린다.
- **배포 대상 자격증명은 그 배포 대상 자신에게만**(`ops.js resolveNodeAccess`): `agent-deploy-targets.json`
  의 비밀을 쓸 수 있는 것은 **접속 host = 그 배포 대상 host** 일 때뿐이다. IRS 는 중계 엣지를 경유하므로
  '그 중계 엣지가 바로 그 배포 대상' 일 때만 허용한다. 이 검사를 없애면 sshTargetId 로 아무 대상을 골라
  다른 비밀 저장소의 자격증명을 임의 호스트로 내보낼 수 있다.
- **조회 응답은 역할로 축약**(`routes/api/relaytopo.js`): `GET /tools/relaytopo` 는 `requirePerm('tools')`
  로 열려 있고 **operator 가 tools 를 기본 보유**하므로, 원격 `haproxy.cfg` 전문·`portal.env` 발췌·배포
  대상 목록·접속 경로는 `req.user?.role === 'admin'`(**거부 기본값**)일 때만 싣는다(`ops.stripCfg`).
  `render/:dc` 는 관리 블록에 전 사이트 내부 IP 가 들어가므로 adminOnly. `stripCfg` 를 다시 항등함수로
  되돌리지 말 것.
  ⚠ **v2.593(AUTHZ-01)**: 그 축약이 **토폴로지 본체**에는 없었다 — 비-admin 에게 전 사이트 사설·공인 IP·vCenter IP·SSH 계정명이
  그대로 나갔다. `maskTopology` 가 주소·계정을 비우고 점검 결과(issues)는 문구에 주소가 들어가 개수만 준다(`addressHidden`·`issueCount`).
- **원격 haproxy.cfg 교체 3규칙**(`ops.js applySite`): ① `systemctl is-active` 는 **마지막 줄 정확 비교**
  (`isActiveOut`) — `/active$/` 는 'inactive' 에 매치돼 장애를 성공으로 보고하고 롤백을 건너뛴다.
  ② 백업(`cp -a`) 실패 시 **원본을 건드리지 않고 중단**(`set -e` + 종료코드 91/92/93) — `;` 로 이으면
  백업 없는 교체가 되고 롤백이 불가능해진다. ③ 현재 cfg 읽기는 **존재 신호(`__HAS__`/`__NONE__`)를 분리**
  — 파일은 있는데 내용이 비면 중단한다(빈 문자열로 병합하면 관리 블록만 남은 cfg 가 `haproxy -c` 를
  통과해 기존 설정을 전부 날린다).

