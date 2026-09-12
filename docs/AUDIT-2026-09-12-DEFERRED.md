# 2026-09-12 보안 감사 — 보류 항목 인수인계(M-5 · L-3 · L-4 · L-5 · L-6)

요약 보고서: `security_check_20260912.MD`(저장소 루트). 도메인별 상세 근거: `docs/AUDIT-2026-09-12/0*.md`.
v2.488.0(PR #446, main 2951dd6)에서 H-1·H-2·M-1~M-4·M-6·L-1·L-2·L-7·L-8·L-9 는 조치 완료.
아래 5건은 **미착수** — 코드 변경 없음. 이 문서는 다음 세션이 바로 시작할 수 있게 위치·설계 메모만 남긴다.

## M-5 firewall-cmd sudoers 인자 무제한 (CWE-250/269)
- 위치: `packaging/offline/install.sh` "v2.485 호스트 접근 제어" 블록 — `%s ALL=(root) NOPASSWD: /usr/bin/firewall-cmd`(인자 없음).
  `server/src/hostaccess/service.js:22 SUDOERS_HINT` 도 같은 줄을 안내. 실행기는 `server/src/hostaccess/exec.js` `fw(args)` = `sudo -n /usr/bin/firewall-cmd <args>`.
- 포탈이 실제로 쓰는 firewall-cmd 인자(service.js + render.js `planCommands`): `--state`, `--get-default-zone`, `--zone=<z> --list-all`,
  `--zone=<z> --add-rich-rule=… / --remove-rich-rule=…`, `--add-service/--remove-service`, `--add-port/--remove-port`, `--reload`, `--runtime-to-permanent`.
- 설계안: root 소유 0755 래퍼 `/usr/local/sbin/vmware-portal-fw`(install.sh 가 설치)에 서브커맨드 화이트리스트를 두고
  sudoers 는 `NOPASSWD: /usr/local/sbin/vmware-portal-fw` 만 허용. `--set-default-zone`, `--direct`, `--panic-*`, `--permanent`(확정은 runtime-to-permanent 로만) 거부.
  `exec.js FIREWALL_CMD` 를 래퍼 경로로 바꾸고 `SUDOERS_HINT` 갱신. 관련 F2: `packaging/offline/vmware-portal.service:29 NoNewPrivileges=true` 이면 `sudo -n` 이 실패 —
  `isSudoDenied`(exec.js:35)에 `no new privileges` 패턴 추가 + 화면 안내에 "NNP 를 끄지 말고 헬퍼 유닛으로 위임" 문구. 테스트: `server/test/hostaccess*.test.js` 가짜 실행기(_setExec) 패턴 재사용.

## L-3 WS 세션 JWT 가 쿼리스트링으로 전송 (CWE-598)
- 위치: `web/src/remote/RemoteConsole.jsx:53`(`/api/remote/ssh?token=`), `:172`(RDP `token`+`ticket`), 서버 `server/src/proxy/sshGateway.js:47`, `guacdTunnel.js:61`(`url.searchParams.get('token')` → `resolveTokenUser`).
- 이미 있는 패턴: RDP 자격증명은 `server/src/proxy/rdpTicket.js`(`POST /api/remote/rdp-ticket` → 1회용 티켓, `consumeRdpTicket`)로 티켓화됨.
- 설계안: 공용 "WS 접속 티켓" — `POST /api/remote/ws-ticket`(authMiddleware) 이 `{ticket}`(32B random, 30초 TTL, 1회용, 발급자 username/sid/tv 스냅샷) 발급 →
  게이트웨이는 `ticket` 로 사용자 확정(발급 시점 `resolveTokenUser` 결과를 저장하되 소비 시점에 `tv`/`sid` 재검증). `token` 쿼리 폴백 제거(감사 로그·프록시 액세스 로그에 JWT 잔존 차단).
  대안: `Sec-WebSocket-Protocol: bearer.<jwt>` 서브프로토콜(브라우저 `new WebSocket(url, ['bearer.'+token])`) — 헤더로 옮겨지지만 로그 노출은 줄고 코드 변경은 최소. 티켓 방식 권장.

## L-4 서버측 로그아웃 부재 (CWE-613)
- 위치: `web/src/App.jsx:125 logout = () => { setToken(null); broadcastLogout(); setUser(null); }` — 서버 호출 없음. `server/src/routes/auth.js` 에 logout 라우트 없음.
- 기존 폐기 수단: 토큰의 `tv`(tokenVersion, 로컬 계정 비번/역할 변경 시 증가) 와 `sid`(단일 세션 강제 시만) — `server/src/auth/auth.js:891 resolveTokenUser`, `server/src/auth/sessions.js`(`setActiveSession/isActiveSession/clearActiveSession`).
- 설계안: `POST /auth/logout`(authMiddleware) — (a) 토큰에 `sid` 가 있으면 `clearActiveSession(username)`; (b) 없으면 토큰 `jti` 를 도입해 만료(exp)까지 메모리 폐기목록(`Map<jti, exp>`, 주기 정리)에 등록하고 `resolveTokenUser` 에서 확인.
  `signToken` 에 `jti: randomBytes(12)` 추가, `/auth/extend` 는 새 jti 발급 + 옛 jti 폐기. 프론트 `logout` 은 `postJson('/auth/logout')` 를 먼저(실패해도 로컬 로그아웃 진행). AD 계정도 jti 로 동일 처리.

## L-5 CSP 기본 비활성 (CWE-1021/693)
- 위치: `server/src/index.js` 보안 헤더 미들웨어 — `if (process.env.CSP) res.setHeader('Content-Security-Policy', process.env.CSP)`.
- 설계안: 기본값 도입 — `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`.
  `CSP=off` 로 옵트아웃, `CSP=<문자열>` 은 그대로 덮어쓰기. 확인 필요: intro/landing 페이지 인라인 스크립트 여부(`web/index.html`, `web/public/*`), react-simple-maps/recharts 는 인라인 style 만 씀(→ `style-src 'unsafe-inline'` 필요). 먼저 `Content-Security-Policy-Report-Only` 로 1버전 내보내 위반 로그를 모으는 단계적 도입 권장.

## L-6 자원 상한 누락 묶음 (CWE-770/400)
- RDP WS 게이트웨이(`server/src/proxy/guacdTunnel.js`): SSH 게이트웨이(`sshGateway.js:78-108` `MAX_SESSIONS=80`, `IDLE_MS=30분`, `activeSessions` 카운트·close 시 감소) 와 같은 예산을 적용. 두 게이트웨이가 **공용 예산**을 쓰도록 `proxy/sessionBudget.js` 로 추출 권장.
- quick-connect 매핑(`server/src/routes/remote.js` `/quick-connect`): 사용자당 ephemeral 매핑 상한(예 20) + 포트 풀 고갈 시 명확한 오류.
- RDP 티켓(`server/src/proxy/rdpTicket.js`): 사용자당 미소비 티켓 상한(예 10) + TTL 정리 이미 있는지 확인.
- RMA heartbeats(`server/src/rma/jobs.js:35 heartbeats Map`): `HEARTBEAT_STALE_MS`(90초) 의 N배(예 24시간) 지난 항목 삭제하는 정리 타이머(현재 delete 0건).
- alerts 엔진(`server/src/alerts.js` `tick()`): `let ticking=false` 재진입 가드(느린 evaluate 가 인터벌보다 길면 중첩 실행).

## 진행 절차(저장소 규칙)
1. dev(`claude/vmware-global-monitoring-portal-nrnpnt`)에서 브랜치 → 항목별 커밋 → `server/test/*.test.js` 회귀 테스트 추가.
2. 3개 `package.json`(루트/server/web) + lockfile 버전 = 2.489.0, `server/src/release-notes.json` 맨 위 항목 추가, `server/CLAUDE.md` "되돌리지 말 것" 섹션에 항목 추가.
3. Draft PR → dev 머지 → main fast-forward → release 워크플로(workflow_dispatch 또는 `v2.489.0` 태그) → `versions.json latest` 확인.
