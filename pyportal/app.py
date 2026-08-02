#!/usr/bin/env python3
"""Global DC Service Hub 실행 진입점.

    python3 app.py                 # 0.0.0.0:8095
    HUB_PORT=9000 python3 app.py   # 포트 변경
    python3 app.py --port 9000     # 인자로도 가능

의존성 없음(표준 라이브러리만). 종료는 Ctrl+C.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 저장소를 통째로 복사해 쓰는 경우를 위해 패키지 경로를 직접 넣는다.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub.app import AppContext  # noqa: E402
from hub.config import APP_NAME, VERSION, config  # noqa: E402
from hub.server import create_server  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=f"{APP_NAME} v{VERSION}")
    parser.add_argument("--host", default=None, help="바인드 주소(기본 HUB_HOST 또는 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None, help="포트(기본 HUB_PORT 또는 8095)")
    parser.add_argument("--data-dir", default=None, help="설정·데이터 저장 디렉터리")
    args = parser.parse_args(argv)

    if args.data_dir:
        config.data_dir = Path(args.data_dir)

    # 기동 시 1회 로드해 저장 파일 손상 여부를 즉시 로그로 알린다(첫 요청까지 미루지 않는다).
    ctx = AppContext()
    shortcuts = ctx.shortcuts.all()
    datacenters = ctx.datacenters.all()

    server = create_server(args.host, args.port, ctx)
    host, port = server.server_address[0], server.server_address[1]
    shown_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host

    print(f"=== {APP_NAME} v{VERSION} ===", flush=True)
    print(f"  주소       : http://{shown_host}:{port}/", flush=True)
    print(f"  바인드     : {host}:{port}", flush=True)
    print(f"  데이터센터 : {len(datacenters)}개", flush=True)
    print(f"  바로가기   : {len(shortcuts)}개", flush=True)
    print(f"  데이터 폴더: {config.data_dir}", flush=True)
    print(f"  접근 토큰  : {'사용(HUB_TOKEN)' if config.token else '미사용(사내망 공개)'}", flush=True)
    if ctx.users.initial_password_present():
        print("  " + "─" * 56, flush=True)
        print("  ★ 설정 화면 초기 비밀번호가 아래 파일에 있습니다(최초 1회):", flush=True)
        print(f"     {config.initial_password_file}", flush=True)
        print("     비밀번호를 변경하면 이 파일은 자동 삭제됩니다.", flush=True)
        print("  " + "─" * 56, flush=True)
    print("  종료       : Ctrl+C", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[hub] 종료합니다.", flush=True)
    finally:
        server.server_close()
        ctx.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
