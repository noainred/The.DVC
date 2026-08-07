"""버전 해석(v2.222) — ver.txt 파싱과 해석 우선순위 검증."""
import json
import pathlib
import unittest

from hub.config import VERSION, VER_FILE, parse_ver_line

BASE = pathlib.Path(__file__).resolve().parent.parent


class VersionTest(unittest.TestCase):
    def test_parse_ver_line_extracts_first_token(self):
        self.assertEqual(parse_ver_line("2.222.0 (2026-08-04) 설명\n2.221.0 ..."), "2.222.0")
        self.assertEqual(parse_ver_line("\n\n  3.0.1  \n"), "3.0.1")
        self.assertEqual(parse_ver_line(""), "")

    def test_ver_file_top_is_a_real_release_and_not_ahead(self):
        """ver.txt 첫 줄은 실존 릴리스 버전이고 포탈 버전보다 앞서지 않아야 한다.

        ver.txt 는 pyportal 을 변경한 릴리스에서만 갱신하는 게 절차라서(단독 배포 버전 표시 소스),
        '항상 package.json 과 일치'를 요구하면 pyportal 을 안 건드린 릴리스마다 오탐이 난다
        (v2.230~2.235 에서 실제로 CI 상시 실패). 'pyportal 을 고친 PR 인데 ver.txt 갱신을 잊은'
        경우는 CI 의 PR 변경 파일 검사가 잡는다(.github/workflows/ci.yml).
        """
        self.assertTrue(VER_FILE.is_file(), "pyportal/ver.txt 가 없습니다.")
        ver_top = parse_ver_line(VER_FILE.read_text(encoding="utf-8"))
        self.assertRegex(ver_top, r"^\d+\.\d+\.\d+$", "ver.txt 첫 줄이 'X.Y.Z (날짜) 요약' 형식이 아닙니다.")
        pkg = json.loads((BASE.parent / "package.json").read_text(encoding="utf-8"))
        as_tuple = lambda v: tuple(int(p) for p in v.split("."))  # noqa: E731
        self.assertLessEqual(as_tuple(ver_top), as_tuple(pkg["version"]),
                             "ver.txt 첫 줄이 package.json 보다 미래 버전입니다 — 오타이거나 잘못된 갱신.")
        notes_path = BASE.parent / "server" / "src" / "release-notes.json"
        if notes_path.is_file():  # 단독 복사본(server/ 없음)에서는 이 교차검증만 생략
            versions = {n.get("version") for n in json.loads(notes_path.read_text(encoding="utf-8"))["notes"]}
            self.assertIn(ver_top, versions,
                          "ver.txt 첫 줄이 release-notes.json 에 없는 버전입니다 — 실존 릴리스가 아닙니다.")

    def test_resolved_version_is_meaningful(self):
        self.assertNotEqual(VERSION, "unknown")
        self.assertRegex(VERSION, r"^\d+\.\d+\.\d+")
