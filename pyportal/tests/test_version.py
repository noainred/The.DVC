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

    def test_ver_file_exists_and_matches_package_json(self):
        """ver.txt 첫 줄과 저장소 package.json 버전이 어긋나면 릴리스 절차 누락이다."""
        self.assertTrue(VER_FILE.is_file(), "pyportal/ver.txt 가 없습니다.")
        ver_top = parse_ver_line(VER_FILE.read_text(encoding="utf-8"))
        pkg = json.loads((BASE.parent / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(ver_top, pkg["version"],
                         "ver.txt 맨 윗줄과 package.json 버전이 다릅니다 — 릴리스 절차의 ver.txt 갱신 누락.")

    def test_resolved_version_is_meaningful(self):
        self.assertNotEqual(VERSION, "unknown")
        self.assertRegex(VERSION, r"^\d+\.\d+\.\d+")
