"""바로가기 CSV 내보내기 / 가져오기.

왜 JSON 말고 CSV 도 필요한가: 바로가기 목록은 결국 사람이 엑셀·시트에서 정리해 온다.
JSON 만 지원하면 "표에 정리해 둔 200개를 옮기고 싶다"는 가장 흔한 요구를 못 받는다.

규칙(회귀 방지)
- **RFC 4180 파서를 쓴다**(표준 라이브러리 `csv`). 순진한 `split(",")` 은 설명·태그에 들어간
  쉼표에서 필드를 밀어내 URL 자리에 엉뚱한 값을 넣는다.
- **CSV 인젝션 방어**: `= + - @` 로 시작하는 셀은 엑셀에서 **수식으로 실행**된다. 내보낼 때
  작은따옴표를 앞에 붙이고, 가져올 때 그 작은따옴표를 되돌린다(왕복해도 값이 안 변하게).
- **UTF-8 BOM**: 붙이지 않으면 엑셀이 한글을 깨뜨린다. 가져오기는 BOM 을 지우고 읽는다.
- 가져온 행은 **바로가기 저장소의 정규화를 그대로 통과**시킨다 — URL 스킴 화이트리스트·
  SSRF 관련 검증을 CSV 경로만 우회하면 안 된다.
"""

from __future__ import annotations

import csv
import io

# 내보내기 열 순서 = 가져오기가 기대하는 헤더. 사용자가 열을 지우거나 순서를 바꿔도
# 헤더 이름으로 찾으므로 동작한다(헤더가 아예 없으면 이 순서로 간주).
COLUMNS = ["name", "url", "category", "icon", "description", "tags",
           "datacenterId", "isFavorite", "enabled"]

# 엑셀이 수식으로 해석하는 선두 문자.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

MAX_ROWS = 2000          # 한 번에 받아들일 최대 행(메모리·처리시간 상한)
MAX_CELL = 2048


def _guard(value) -> str:
    """엑셀 수식으로 실행될 수 있는 셀 앞에 작은따옴표를 붙인다."""
    text = "" if value is None else str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def _unguard(value) -> str:
    """내보내기가 붙인 작은따옴표를 되돌린다(왕복 시 값이 변하지 않게)."""
    text = "" if value is None else str(value).strip()
    if len(text) > 1 and text[0] == "'" and text[1] in _FORMULA_PREFIXES:
        return text[1:]
    return text[:MAX_CELL]


def export_csv(shortcuts) -> str:
    """현재 바로가기 전체를 CSV 문자열로. 앞에 BOM 을 붙여 엑셀 한글 깨짐을 막는다."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")   # RFC 4180 개행
    writer.writerow(COLUMNS)
    for item in shortcuts:
        writer.writerow([
            _guard(item.get("name")),
            _guard(item.get("url")),
            _guard(item.get("category")),
            _guard(item.get("icon")),
            _guard(item.get("description")),
            _guard(", ".join(item.get("tags") or [])),
            _guard(item.get("datacenterId")),
            "true" if item.get("isFavorite") else "false",
            "true" if item.get("enabled", True) else "false",
        ])
    return "﻿" + buffer.getvalue()


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "y", "on", "예")


def parse_csv(text) -> list:
    """CSV 문자열 → 바로가기 dict 목록(저장 전 원시 형태).

    이름과 URL 이 모두 있는 행만 남긴다 — 빈 줄·주석 줄로 목록이 오염되지 않게.
    """
    if not isinstance(text, str) or not text.strip():
        return []
    if text.startswith("﻿"):
        text = text[1:]

    rows = list(csv.reader(io.StringIO(text)))
    if not rows:
        return []

    header = [str(cell or "").strip().lstrip("﻿").lower() for cell in rows[0]]
    known = {name.lower(): name for name in COLUMNS}
    if any(cell in known for cell in header):
        index = {known[cell]: position for position, cell in enumerate(header) if cell in known}
        body = rows[1:]
    else:
        # 헤더가 없으면 정해진 열 순서로 간주한다(엑셀에서 헤더를 지우고 붙여넣는 경우).
        index = {name: position for position, name in enumerate(COLUMNS)}
        body = rows

    entries = []
    for row in body[:MAX_ROWS]:
        if not any(str(cell or "").strip() for cell in row):
            continue                                   # 빈 줄
        def cell(name):
            position = index.get(name)
            return _unguard(row[position]) if position is not None and position < len(row) else ""

        name, url = cell("name"), cell("url")
        if not name or not url:
            continue                                   # 이름·URL 없는 행은 버린다
        entries.append({
            "name": name,
            "url": url,
            "category": cell("category"),
            "icon": cell("icon"),
            "description": cell("description"),
            "tags": cell("tags"),
            "datacenterId": cell("datacenterId"),
            "isFavorite": _truthy(cell("isFavorite")),
            # enabled 열이 없는 옛 CSV 는 '사용'(True) — 왕복/업그레이드 시 링크가 꺼지지 않게.
            "enabled": _truthy(cell("enabled")) if str(cell("enabled") or "").strip() else True,
        })
    return entries
