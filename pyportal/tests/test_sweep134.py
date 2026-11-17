"""전체 점검 134회차 — '파일 없음' 판정 스윕(Node 쪽 `fs.existsSync` 로더의 pyportal 판).

Node 의 `fs.existsSync` 는 stat 이 어떤 이유로든 실패하면 False 라 못 읽은 파일이 '없음' 이 됐다. 파이썬은 다르다 — `Path.exists()` 는
ENOENT · ENOTDIR · ELOOP 만 False 이고 권한 · 입출력 오류(PermissionError 등)는 **올린다**(`os.path.exists` 는 False — pyportal 은 쓰지 않는다).
그래서 계정 파일(users.json — strict_io)은 폴더 수준 오류에도 '못 읽음' 으로 닫힌다(새 admin 을 만들지 않는다 — 여기서 동작만 고정).
같은 꼴로 남아 있던 둘을 고쳤다:

S1 세션 서명 키(`SessionStore._load_secret`): 읽기 오류(OSError)도 '없음' 으로 보고 새 키를 **파일에 덮어썼다**(재현 — 파일만 root 소유 0600 ·
   폴더는 서비스 계정이 쓸 수 있는 모양에서 원래 키가 사라짐). 일시 오류 한 번에 그전 세션이 영영 돌아오지 않는다. → 있는데 못 읽으면 덮지 않고
   이 프로세스만 임의 키(전원 다시 로그인 — 닫는 쪽). 정말 없을 때(FileNotFoundError) · 형식이 틀릴 때만 새로 만든다(예전과 같다).
S2 `read_json_state`: `path.exists()` 가 try 밖이라 폴더 수준 읽기 오류가 'unreadable' 상태가 아니라 **예외**로 호출부(저장소 로드)에 나갔다.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub import jsonfile  # noqa: E402
from hub.auth import SessionStore, UserStore  # noqa: E402

IS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0
OLD_KEY = "ab" * 32


def _raising(target: Path, exc: OSError, real):
    """그 경로만 exc 로 실패하게 하는 대역(다른 경로는 원래 함수)."""
    def fake(self, *args, **kwargs):
        if Path(self) == target:
            raise exc
        return real(self, *args, **kwargs)
    return fake


class SecretKeyTest(unittest.TestCase):
    """S1: 있는데 못 읽은 서명 키를 새 키로 덮지 않는다."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.key = self.dir / "session-secret"

    def tearDown(self):
        self._tmp.cleanup()

    def test_read_error_does_not_overwrite_the_key(self):
        self.key.write_text(OLD_KEY + "\n", encoding="utf-8")
        for exc in (PermissionError(13, "Permission denied"), OSError(5, "Input/output error")):
            with self.subTest(exc=type(exc).__name__):
                with mock.patch.object(Path, "read_text", _raising(self.key, exc, Path.read_text)), mock.patch("builtins.print"):
                    secret = SessionStore._load_secret(self.key)
                self.assertEqual(len(secret), 32)
                self.assertNotEqual(secret, bytes.fromhex(OLD_KEY), "못 읽었는데 원래 키를 돌려줄 수는 없다")
                self.assertEqual(self.key.read_text(encoding="utf-8"), OLD_KEY + "\n", "읽기 오류 한 번에 원래 키를 새 키로 덮었다")
        # 오류가 풀린 뒤(재시작)에는 원래 키를 그대로 읽는다 — 그전 세션이 살아난다
        self.assertEqual(SessionStore._load_secret(self.key), bytes.fromhex(OLD_KEY))

    def test_missing_or_malformed_key_is_created_as_before(self):
        with mock.patch("builtins.print"):
            made = SessionStore._load_secret(self.key)
        self.assertEqual(self.key.read_text(encoding="utf-8").strip(), made.hex(), "정말 없으면(첫 기동) 만든다")
        self.key.write_text("short\n", encoding="utf-8")
        with mock.patch("builtins.print"):
            again = SessionStore._load_secret(self.key)
        self.assertEqual(self.key.read_text(encoding="utf-8").strip(), again.hex(), "짧은 값은 예전처럼 새로 만든다")
        self.assertEqual(len(SessionStore._load_secret(None)), 32)

    @unittest.skipUnless(IS_ROOT, "root 가 아니라 권한을 내릴 수 없다")
    def test_real_permission_file_owned_by_root_in_service_writable_dir(self):
        """실제 조건: 파일만 root 소유 0600 · 폴더는 서비스 계정이 쓸 수 있다(콘솔 복구를 root 로 돌린 뒤의 모양)."""
        os.chown(self.dir, 65534, 65534)
        os.chmod(self.dir, 0o700)
        self.key.write_text(OLD_KEY + "\n", encoding="utf-8")
        os.chmod(self.key, 0o600)
        os.setegid(65534); os.seteuid(65534)
        try:
            with mock.patch("builtins.print"):
                secret = SessionStore._load_secret(self.key)
        finally:
            os.seteuid(0); os.setegid(0)
        self.assertEqual(len(secret), 32)
        self.assertEqual(self.key.read_text(encoding="utf-8"), OLD_KEY + "\n", "서비스 계정이 못 읽는 키를 새 키로 바꿔치기했다")


class ReadStateTest(unittest.TestCase):
    """S2 + 계정 파일 동작 고정: 폴더 수준 읽기 오류는 '없음' 도 예외도 아니고 '못 읽음' 이다."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_read_json_state_reports_unreadable_instead_of_raising(self):
        path = self.dir / "settings.json"
        path.write_text(json.dumps({"healthInterval": 60}), encoding="utf-8")
        with mock.patch.object(Path, "stat", _raising(path, PermissionError(13, "Permission denied"), Path.stat)):
            self.assertEqual(jsonfile.read_json_state(path, expect=dict, quiet=True), (None, "unreadable"))
        self.assertEqual(list(self.dir.glob("settings.json.corrupt.*")), [], "읽기 오류는 손상이 아니다 — 옮기지 않는다")
        self.assertEqual(jsonfile.read_json_state(path, expect=dict), ({"healthInterval": 60}, None))
        self.assertEqual(jsonfile.read_json_state(self.dir / "none.json", expect=dict), (None, "missing"))

    def test_users_file_folder_level_error_is_not_missing(self):
        """계정 파일: 확인하지 못한 것을 '없음' 으로 읽으면 새 admin 이 생긴다 — strict 읽기가 OSError 를 올린다(31회차 F3 의 폴더 수준 판)."""
        path = self.dir / "users.json"
        path.write_text(json.dumps([{"username": "alice", "role": "admin", "hash": "x", "tokenVersion": 5}]), encoding="utf-8")
        with mock.patch.object(Path, "stat", _raising(path, PermissionError(13, "Permission denied"), Path.stat)):
            with self.assertRaises(OSError):
                jsonfile.read_json(path, [], expect=list, strict_io=True, quiet=True)

    @unittest.skipUnless(IS_ROOT, "root 가 아니라 권한을 내릴 수 없다")
    def test_real_permission_folder_level(self):
        """실제 조건: 데이터 폴더 탐색 권한을 잃은 서비스 계정 — 상태 파일은 'unreadable', 계정 저장소는 새 admin 을 만들지 않는다."""
        os.chmod(self.dir, 0o700)   # root 만 들어온다
        (self.dir / "settings.json").write_text(json.dumps({"healthInterval": 60}), encoding="utf-8")
        users = self.dir / "users.json"
        users.write_text(json.dumps([{"username": "alice", "role": "admin", "hash": "x", "tokenVersion": 5}]), encoding="utf-8")
        before = users.read_text(encoding="utf-8")
        os.setegid(65534); os.seteuid(65534)
        try:
            with mock.patch("builtins.print"):
                state = jsonfile.read_json_state(self.dir / "settings.json", expect=dict, quiet=True)
                store = UserStore(users, initial_password_file=self.dir / "initial-password.txt")
                made = store.bootstrap()   # 첫 기동이면 admin 을 만들고 초기 비밀번호를 돌려준다
                names = [u.get("username") for u in store.public_list()]
        finally:
            os.seteuid(0); os.setegid(0)
        self.assertEqual(state, (None, "unreadable"))
        self.assertEqual(users.read_text(encoding="utf-8"), before, "못 읽은 계정 파일을 건드렸다")
        self.assertFalse(list(self.dir.glob("initial-*")), "새 admin(초기 비밀번호 파일)을 만들었다")
        self.assertFalse(made, "못 읽은 계정 파일을 '없음' 으로 보고 기본 admin 을 만들었다")
        self.assertEqual(names, [])


if __name__ == "__main__":
    unittest.main()
