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

from hub.config import APP_NAME, VERSION, config  # noqa: E402
from hub.datacenters import DATACENTERS  # noqa: E402
from hub.server import create_server  # noqa: E402
from hub.store import ShortcutStore  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=f"{APP_NAME} v{VERSION}")
    parser.add_argument("--host", default=None, help="바인드 주소(기본 HUB_HOST 또는 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None, help="포트(기본 HUB_PORT 또는 8095)")
    parser.add_argument("--data-dir", default=None, help="바로가기 저장 디렉터리")
    args = parser.parse_args(argv)

    if args.data_dir:
        config.data_dir = Path(args.data_dir)

    store = ShortcutStore(config.shortcuts_file)
    # 기동 시 1회 로드해 저장 파일 손상 여부를 즉시 로그로 알린다(첫 요청까지 미루지 않는다).
    loaded = store.all()

    server = create_server(args.host, args.port, store)
    host, port = server.server_address[0], server.server_address[1]
    shown_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host

    print(f"=== {APP_NAME} v{VERSION} ===", flush=True)
    print(f"  주소       : http://{shown_host}:{port}/", flush=True)
    print(f"  바인드     : {host}:{port}", flush=True)
    print(f"  데이터센터 : {len(DATACENTERS)}개", flush=True)
    print(f"  바로가기   : {len(loaded)}개  ({config.shortcuts_file})", flush=True)
    print(f"  접근 토큰  : {'사용(HUB_TOKEN)' if config.token else '미사용(사내망 공개)'}", flush=True)
    print("  종료       : Ctrl+C", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[hub] 종료합니다.", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
