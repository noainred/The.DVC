"""바로가기 CSV — RFC 4180 파싱 · CSV 인젝션 방어 · 왕복 보존."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hub.csvio import COLUMNS, export_csv, parse_csv  # noqa: E402


def shortcut(name="Grafana", url="https://grafana.internal.dc/d/x", **extra):
    base = {"name": name, "url": url, "category": "monitoring", "icon": "📈",
            "description": "대시보드", "tags": ["Monitoring", "Realtime"],
            "datacenterId": "all", "isFavorite": True}
    base.update(extra)
    return base


class ExportTest(unittest.TestCase):
    def test_header_and_bom(self):
        text = export_csv([shortcut()])
        self.assertTrue(text.startswith("﻿"), "BOM 이 없으면 엑셀이 한글을 깨뜨린다.")
        self.assertIn(",".join(COLUMNS), text)

    def test_tags_are_joined(self):
        self.assertIn("Monitoring, Realtime", export_csv([shortcut()]))

    def test_formula_cells_are_neutralized(self):
        # `=`로 시작하는 셀은 엑셀에서 수식으로 '실행'된다(CSV 인젝션).
        text = export_csv([shortcut(name="=HYPERLINK(\"http://evil\",\"click\")")])
        self.assertIn("'=HYPERLINK", text)

    def test_comma_and_quote_are_escaped(self):
        text = export_csv([shortcut(description='설명, 쉼표와 "따옴표"')])
        rows = parse_csv(text)
        self.assertEqual(rows[0]["description"], '설명, 쉼표와 "따옴표"')


class ParseTest(unittest.TestCase):
    def test_round_trip_preserves_values(self):
        original = shortcut(name="NetBox, DCIM", description='a "b" c')
        parsed = parse_csv(export_csv([original]))
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["name"], "NetBox, DCIM")
        self.assertEqual(parsed[0]["url"], original["url"])
        self.assertEqual(parsed[0]["isFavorite"], True)

    def test_formula_guard_is_reversed_on_import(self):
        parsed = parse_csv(export_csv([shortcut(name="=SUM(1,2)")]))
        self.assertEqual(parsed[0]["name"], "=SUM(1,2)",
                         "내보내기가 붙인 작은따옴표를 되돌리지 않으면 왕복할 때마다 값이 자란다.")

    def test_comma_in_quoted_field_does_not_shift_columns(self):
        csv_text = ('name,url,description\n'
                    '"Splunk, SIEM",https://splunk.internal.dc/,"로그, 감사"\n')
        rows = parse_csv(csv_text)
        self.assertEqual(rows[0]["name"], "Splunk, SIEM")
        self.assertEqual(rows[0]["url"], "https://splunk.internal.dc/")

    def test_header_order_may_differ(self):
        rows = parse_csv("url,name\nhttps://a.internal/,A\n")
        self.assertEqual(rows[0]["name"], "A")
        self.assertEqual(rows[0]["url"], "https://a.internal/")

    def test_missing_header_falls_back_to_column_order(self):
        rows = parse_csv("A,https://a.internal/,monitoring\n")
        self.assertEqual(rows[0]["name"], "A")
        self.assertEqual(rows[0]["category"], "monitoring")

    def test_rows_without_name_or_url_are_dropped(self):
        rows = parse_csv("name,url\n,https://a.internal/\nB,\n\nC,https://c.internal/\n")
        self.assertEqual([row["name"] for row in rows], ["C"])

    def test_favorite_accepts_common_truthy_words(self):
        rows = parse_csv("name,url,isFavorite\nA,https://a.internal/,TRUE\n"
                         "B,https://b.internal/,no\n")
        self.assertEqual([row["isFavorite"] for row in rows], [True, False])

    def test_empty_input_is_empty_list(self):
        self.assertEqual(parse_csv(""), [])
        self.assertEqual(parse_csv(None), [])
        self.assertEqual(parse_csv("   \n"), [])

    def test_bom_prefixed_file_is_read(self):
        rows = parse_csv("﻿name,url\nA,https://a.internal/\n")
        self.assertEqual(rows[0]["name"], "A")


if __name__ == "__main__":
    unittest.main()
