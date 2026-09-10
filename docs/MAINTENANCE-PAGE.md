# 업데이트·재시작 안내 페이지 (다운타임 안내)

업그레이드는 서버를 재시작하므로 그 몇 초~수십 초 동안 포탈이 응답하지 않습니다. 이때 사용자에게
브라우저의 "사이트에 연결할 수 없음(ERR_CONNECTION_TIMED_OUT)" 대신 **"업데이트 후 재시작 중"**
안내를 보여 주는 방법을 정리합니다.

## 두 가지 상황 — 하나는 포탈이 스스로 처리, 하나는 프록시가 필요

| 상황 | 처리 주체 | 동작 |
|---|---|---|
| **포탈을 이미 열어 둔 탭**에서 재시작을 만남 | **포탈(내장)** — 추가 설정 불필요 | 화면이 자동으로 **"업데이트 후 재시작 중입니다"** 로 바뀌고, `/api/health` 를 폴링하다 서버가 살아나면 **자동 새로고침**한다(v2.462). 헤더 버전 배지도 빨간 점멸 `Upgrading…` 로 바뀐다(v2.458). |
| **새 탭/새로고침으로 접속하는 순간** 서버가 내려가 있음 | **앞단 리버스 프록시만 가능** | 포탈 프로세스가 통째로 죽어 있어 **포탈 자신은 어떤 HTML 도 못 내려준다**. 프록시(nginx/HAProxy)가 백엔드 장애를 감지해 이 저장소의 `packaging/maintenance.html` 을 대신 내려줘야 한다. |

> **정직한 한계**: 두 번째 상황(스크린샷의 Chrome 오류)은 **포탈만으로는 해결할 수 없습니다.**
> 재시작 중에는 포트(:4000)에 아무도 응답하지 않으므로, 항상 떠 있는 앞단(리버스 프록시)이 없으면
> 브라우저는 연결 오류를 그대로 봅니다. 현재처럼 `:4000` 에 **직접 접속**하는 구성이라면 먼저 프록시를
> 두어야 이 안내가 뜹니다.

## 유지보수 페이지

`packaging/maintenance.html` — 의존성 없는 단일 HTML. 포탈과 같은 다크 테마로 "업데이트 후 재시작 중"
을 안내하고, `/api/health` 를 폴링하다 백엔드가 살아나면 자동으로 포탈로 이동한다(JS 차단 환경을 위해
`<meta refresh>` 15초 폴백도 포함). 프록시가 다운 구간에만 이 파일을 내려주도록 설정한다.

## 1) nginx (권장 — HTML 을 그대로 서빙)

```nginx
upstream davinci_portal { server 127.0.0.1:4000; }

server {
  listen 80;                     # 필요하면 443 + TLS
  server_name portal.example.com;

  # 유지보수 페이지 소스(이 저장소 packaging/maintenance.html 을 복사해 둔다)
  # cp packaging/maintenance.html /var/www/portal-maintenance/maintenance.html

  location / {
    proxy_pass http://davinci_portal;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;          # WebSocket(원격 콘솔) 유지
    proxy_set_header Connection $connection_upgrade;

    # 백엔드가 죽었을 때(연결 실패/5xx) 유지보수 페이지로.
    proxy_connect_timeout 2s;                        # 죽었으면 빨리 실패(타임아웃 대기 금지)
    proxy_intercept_errors on;
    error_page 502 503 504 = @maintenance;
  }

  location @maintenance {
    root /var/www/portal-maintenance;
    rewrite ^ /maintenance.html break;
    add_header Cache-Control "no-store" always;
    default_type text/html;
  }
}

map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

핵심: **`proxy_intercept_errors on` + `error_page`** 로 백엔드 장애를 가로채 유지보수 HTML 로 바꾼다.
`proxy_connect_timeout` 을 짧게 둬야 재시작 중 연결 실패를 빨리 감지한다. `maintenance.html` 의
JS 가 `/api/health` 를 폴링하다 백엔드 복귀 시 자동으로 포탈로 되돌린다.

## 2) HAProxy (relaytopo 등 이미 HAProxy 를 쓰는 구성)

HAProxy 의 `errorfile` 은 **완전한 HTTP 응답 파일**(상태줄·헤더·빈 줄·본문)이라야 한다. 변환:

```bash
{ printf 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n';
  cat packaging/maintenance.html; } > /etc/haproxy/errors/maintenance.http
```

```haproxy
backend davinci_portal
  option httpchk GET /api/health
  http-check expect status 200
  # 백엔드가 down 이면 503 을 이 파일로 대체
  errorfile 503 /etc/haproxy/errors/maintenance.http
  server portal 127.0.0.1:4000 check inter 2s fall 2 rise 1
```

주의: HAProxy `errorfile` 은 **정적 파일**이라 `maintenance.html` 을 바꾸면 위 변환을 다시 돌리고
`reload` 해야 한다. 그리고 `errorfile` 본문 안의 JS 폴링은 프록시가 정상 통과로 바뀌면 `/api/health`
200 을 받아 포탈로 이동한다.

## 확인

- 포탈을 열어 둔 탭: 서버를 재시작(`systemctl restart vmware-portal`)하고 화면이 "업데이트 후
  재시작 중" 으로 바뀌었다가 **스스로 포탈로 복귀**하는지 본다(v2.462).
- 새 탭 접속: 프록시를 둔 뒤 재시작 중에 `http://portal.example.com/` 을 새로 열어 유지보수 페이지가
  뜨고, 복귀 후 자동으로 포탈로 넘어가는지 본다.

## 함께 보기

- 종료(재시작) 시간 자체를 줄인 수정: 릴리스 노트 **v2.456.0**(종료가 매번 유예 8초를 소진하던 문제).
- 업그레이드 진행 표시(헤더 점멸): **v2.458.0**. 앱 내 안내 화면: **v2.459.0** + 자동 재연결 **v2.462.0**.
