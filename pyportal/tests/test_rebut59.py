"""전체 점검 59회차 — 56회차 수정 반증(적대적 재검토) 회귀.

R1 56회차 F2 가 PBKDF2 를 계정 저장소 잠금 밖으로 옮기면서 '계정 사본을 고른 뒤 검증이 끝나기까지' 사이에 비밀번호 변경 · 중지 · 삭제가
   끼어들 수 있게 됐다(재현) — 옛 비밀번호가 '로그인 성공'(감사 login 성공 · 실패 카운터 초기화)을 받았고(발급 토큰은 tokenVersion 으로 즉시 무효),
   역할 변경이 끼면 정상 로그인이 곧바로 죽은 세션이 됐다. 검증 뒤 잠금 안에서 지금 기록을 다시 보고 같은 비밀번호 기록 · 사용 중일 때만 지금 값으로 돌려준다.

59회차 후속③ 바로가기 `enabled` · `isFavorite` 가 `bool(값)` 이라 문자열 "false" 가 켜짐 · 즐겨찾기가 됐다(56회차 F7 의 바로가기판 — 재현).
   불리언 · 0/1 · 'true'/'false'(대소문자 무시)는 그 뜻대로. 그 밖의 값은 추가 · 수정(화면 · API)이면 400, 가져오기 · 저장 파일이면 예전 규칙 그대로
   (행을 버리지 않는다 — 다른 도구가 만든 파일의 링크를 잃지 않게).
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from hub import auth as auth_mod  # noqa: E402
from hub.app import AppContext  # noqa: E402
from hub.ssrf import ValidationError  # noqa: E402
from test_api import ServerCase, request  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ctx = AppContext(Path(self.tmp.name), start_workers=False)

    def tearDown(self):
        self.ctx.close()
        self.tmp.cleanup()

    def _during_verify(self, action):
        """비밀번호 검증 도중(잠금 밖) action 을 끼워 넣는다 — 경합 창을 결정적으로 재현한다."""
        real = auth_mod.verify_password

        def slow(record, password):
            action()
            return real(record, password)
        return mock.patch.object(auth_mod, "verify_password", side_effect=slow)


class LoginRaceTest(_Base):
    def test_password_change_during_verify_rejects_old_password(self):
        self.ctx.users.add("bob", "viewer", "old-password-1")
        with self._during_verify(lambda: self.ctx.users.set_password("bob", "new-password-2")):
            got = self.ctx.users.authenticate("bob", "old-password-1")
        self.assertIsNone(got, "비밀번호가 바뀐 뒤 옛 비밀번호는 로그인 성공이 아니다(수정 전: 성공 · 토큰은 즉시 무효)")
        # 새 비밀번호는 그대로 된다
        self.assertIsNotNone(self.ctx.users.authenticate("bob", "new-password-2"))

    def test_disable_or_delete_during_verify_rejects(self):
        self.ctx.users.add("carl", "viewer", "carl-password-1")
        self.ctx.users.add("dora", "viewer", "dora-password-1")
        with self._during_verify(lambda: self.ctx.users.update("carl", enabled=False)):
            self.assertIsNone(self.ctx.users.authenticate("carl", "carl-password-1"))
        with self._during_verify(lambda: self.ctx.users.delete("dora")):
            self.assertIsNone(self.ctx.users.authenticate("dora", "dora-password-1"))

    def test_role_change_during_verify_returns_live_session(self):
        self.ctx.users.add("amy", "viewer", "amy-password-1")
        with self._during_verify(lambda: self.ctx.users.update("amy", role="admin")):
            got = self.ctx.users.authenticate("amy", "amy-password-1")
        self.assertIsNotNone(got)
        self.assertEqual(got["role"], "admin")
        session = self.ctx.sessions.create(got)
        self.assertEqual(self.ctx.sessions.resolve(session["token"]),
                         {"username": "amy", "role": "admin"},
                         "정상 비밀번호 로그인이 죽은 세션(옛 tokenVersion)이 되지 않는다")

    def test_wrong_password_and_unknown_user_still_none(self):
        self.ctx.users.add("eve", "viewer", "eve-password-1")
        self.assertIsNone(self.ctx.users.authenticate("eve", "nope-nope-1"))
        self.assertIsNone(self.ctx.users.authenticate("nobody", "nope-nope-1"))
        self.assertEqual(self.ctx.users.authenticate("EVE", "eve-password-1")["username"], "eve",
                         "로그인은 예전처럼 대소문자를 무시한다")


class ShortcutFlagTest(_Base):
    """후속③ — 바로가기 플래그 문자열."""

    def _new(self, **extra):
        return self.ctx.shortcuts.add(dict({"name": "flag-59", "url": "https://flag59.internal/"}, **extra))

    def test_update_reads_flag_words(self):
        sc = self._new()
        cases = [("false", False), ("FALSE ", False), ("true", True), ("True", True), (0, False), (1, True),
                 ("0", False), ("1", True), (False, False), (True, True)]
        for raw, want in cases:
            got = self.ctx.shortcuts.update(sc["id"], {"enabled": raw, "isFavorite": raw})
            self.assertIs(got["enabled"], want, raw)
            self.assertIs(got["isFavorite"], want, raw)

    def test_update_rejects_other_values(self):
        sc = self._new()
        self.ctx.shortcuts.update(sc["id"], {"enabled": False})
        for raw in ("no", "off", "yes", "", 2, -1, 0.5, [], {}):
            with self.assertRaises(ValidationError, msg=repr(raw)):
                self.ctx.shortcuts.update(sc["id"], {"enabled": raw})
            with self.assertRaises(ValidationError, msg=repr(raw)):
                self.ctx.shortcuts.update(sc["id"], {"isFavorite": raw})
        self.assertIs(self.ctx.shortcuts.get(sc["id"])["enabled"], False, "거절된 저장은 값을 바꾸지 않는다")
        # null 은 '보내지 않음' 과 같다(지금 값 유지)
        self.assertIs(self.ctx.shortcuts.update(sc["id"], {"enabled": None})["enabled"], False)
        with self.assertRaises(ValidationError):
            self._new(isFavorite="nope")

    def test_import_reads_flag_words_and_keeps_legacy_rule_for_others(self):
        entries = [
            {"name": "a", "url": "https://a59.internal/", "enabled": "false", "isFavorite": "TRUE"},
            {"name": "b", "url": "https://b59.internal/", "enabled": 0, "isFavorite": "0"},
            {"name": "c", "url": "https://c59.internal/", "enabled": "yes", "isFavorite": "no"},   # 모르는 글자 — 예전 규칙 bool(값)
            {"name": "d", "url": "https://d59.internal/"},                                         # 없음 — 사용 · 즐겨찾기 아님
        ]
        items = {x["name"]: x for x in self.ctx.shortcuts.replace_all(entries)}
        self.assertEqual(sorted(items), ["a", "b", "c", "d"], "가져오기는 행을 버리지 않는다")
        self.assertEqual((items["a"]["enabled"], items["a"]["isFavorite"]), (False, True), "수정 전: 'false' 가 사용으로 켜졌다")
        self.assertEqual((items["b"]["enabled"], items["b"]["isFavorite"]), (False, False))
        self.assertEqual((items["c"]["enabled"], items["c"]["isFavorite"]), (True, True), "모르는 글자는 예전 규칙 그대로(호환)")
        self.assertEqual((items["d"]["enabled"], items["d"]["isFavorite"]), (True, False))
        _, added, skipped = self.ctx.shortcuts.append_many([{"name": "e", "url": "https://e59.internal/", "enabled": "False"}])
        self.assertEqual((added, skipped), (1, 0))
        self.assertIs(next(x for x in self.ctx.shortcuts.all() if x["name"] == "e")["enabled"], False)


class ShortcutFlagRouteTest(ServerCase):
    def test_put_with_unknown_flag_is_400_and_false_string_disables(self):
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "route-59", "url": "https://route59.internal/"}, self.auth())
        self.assertEqual(code, 201, payload)
        sid = payload["shortcut"]["id"]
        code, payload, _ = request(self.url + "/api/shortcuts/" + sid, "PUT", {"enabled": "false"}, self.auth())
        self.assertEqual(code, 200, payload)
        self.assertIs(payload["shortcut"]["enabled"], False)
        code, payload, _ = request(self.url + "/api/shortcuts/" + sid, "PUT", {"enabled": "nope"}, self.auth())
        self.assertEqual(code, 400, payload)
        code, payload, _ = request(self.url + "/api/shortcuts", "POST",
                                   {"name": "route-59b", "url": "https://route59b.internal/", "isFavorite": "maybe"}, self.auth())
        self.assertEqual(code, 400, payload)


if __name__ == "__main__":
    unittest.main()
