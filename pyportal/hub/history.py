"""링크 점검 이력 DB(SQLite) + 기간별 차트 집계.

왜 파일 DB 인가
- 5분~한 달 범위의 추이를 보려면 점검 결과를 계속 쌓아야 하는데, JSON 한 덩어리로는
  한 달치(수십만 행)를 매번 읽고 쓰는 순간 화면이 멈춘다. `sqlite3` 는 표준 라이브러리라
  추가 설치 없이 인덱스·집계를 쓸 수 있다.

성능 규칙(본 저장소의 시계열 규칙과 동일)
- **WAL + synchronous=NORMAL + busy_timeout** — 점검 결과 삽입이 fsync 로 막히지 않게.
- **한 번의 트랜잭션으로 일괄 insert** — 링크 30개를 30번 커밋하면 그만큼 fsync 가 늘어난다.
- **`ts` 단독 인덱스** — 보관기간 정리(`DELETE WHERE ts < ?`)가 풀스캔이 되지 않게.
  복합 인덱스 `(shortcut_id, ts)` 만으로는 이 조건을 탈 수 없다.
- **정리는 스로틀** — 매 점검마다 DELETE 를 돌리지 않고 N회에 1번만.
"""

from __future__ import annotations

import sqlite3
import threading
import time

# 화면의 기간 선택 버튼과 1:1 로 대응한다.
RANGES = {
    "5m": 300,
    "10m": 600,
    "30m": 1800,
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
}

RANGE_LABELS = {
    "5m": "5분", "10m": "10분", "30m": "30분", "1h": "1시간",
    "6h": "6시간", "24h": "24시간", "7d": "일주일", "30d": "한달",
}

# 기간별 버킷 크기(초). 대략 30~70개 구간이 나오도록 잡았다 — 점이 너무 많으면
# 차트가 뭉개지고, 너무 적으면 추이가 안 보인다.
BUCKETS = {
    "5m": 10,
    "10m": 20,
    "30m": 60,
    "1h": 120,
    "6h": 600,
    "24h": 1800,
    "7d": 10800,
    "30d": 43200,
}

PRUNE_EVERY = 20        # 삽입 20회마다 1번만 보관기간 정리


class HealthHistory:
    def __init__(self, path, retention_days: int = 40):
        self._path = str(path)
        self._retention = max(2, int(retention_days))
        self._lock = threading.RLock()
        self._writes = 0
        from pathlib import Path
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self._path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._prepare()

    def _prepare(self):
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.execute("PRAGMA busy_timeout=3000")
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS checks (
                  id          INTEGER PRIMARY KEY AUTOINCREMENT,
                  ts          INTEGER NOT NULL,
                  shortcut_id TEXT,
                  url         TEXT NOT NULL,
                  status      TEXT NOT NULL,
                  status_code INTEGER NOT NULL DEFAULT 0,
                  latency_ms  INTEGER NOT NULL DEFAULT 0,
                  message     TEXT
                )
            """)
            self._db.execute("CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts)")
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS idx_checks_sc_ts ON checks(shortcut_id, ts)")
            self._db.commit()

    # ---------- 쓰기 ----------

    def record(self, results, ts: int = None) -> int:
        """점검 결과 목록을 한 트랜잭션으로 적재하고 적재 건수를 돌려준다."""
        if not results:
            return 0
        stamp = int(ts if ts is not None else time.time())
        rows = [(
            stamp,
            row.get("id"),
            str(row.get("url", ""))[:2048],
            str(row.get("status", "unknown"))[:20],
            int(row.get("statusCode") or 0),
            int(row.get("latencyMs") or 0),
            str(row.get("message", ""))[:300],
        ) for row in results]

        with self._lock:
            self._db.executemany(
                "INSERT INTO checks (ts, shortcut_id, url, status, status_code, latency_ms, message)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            self._db.commit()
            self._writes += 1
            if self._writes % PRUNE_EVERY == 0:
                self.prune()
        return len(rows)

    def prune(self) -> int:
        cutoff = int(time.time()) - self._retention * 86400
        with self._lock:
            cursor = self._db.execute("DELETE FROM checks WHERE ts < ?", (cutoff,))
            self._db.commit()
            return cursor.rowcount or 0

    # ---------- 읽기 ----------

    def latest(self) -> dict:
        """바로가기별 최신 결과 — 재시작 후에도 카드에 상태 배지를 띄우기 위해."""
        with self._lock:
            rows = self._db.execute("""
                SELECT c.shortcut_id, c.ts, c.url, c.status, c.status_code, c.latency_ms, c.message
                FROM checks c
                JOIN (SELECT shortcut_id, MAX(ts) AS ts FROM checks
                      WHERE shortcut_id IS NOT NULL GROUP BY shortcut_id) m
                  ON m.shortcut_id = c.shortcut_id AND m.ts = c.ts
            """).fetchall()
        result = {}
        for row in rows:
            result[row["shortcut_id"]] = {
                "id": row["shortcut_id"], "url": row["url"], "status": row["status"],
                "statusCode": row["status_code"], "latencyMs": row["latency_ms"],
                "message": row["message"], "ts": row["ts"],
            }
        return result

    def series(self, range_key: str, shortcut_id: str = None) -> dict:
        """기간별 버킷 집계. 화면은 이 결과만으로 차트를 그린다."""
        if range_key not in RANGES:
            range_key = "24h"
        window = RANGES[range_key]
        bucket = BUCKETS[range_key]
        now = int(time.time())
        since = now - window

        params = [bucket, bucket, since]
        where = "ts >= ?"
        if shortcut_id:
            where += " AND shortcut_id = ?"
            params.append(shortcut_id)

        sql = f"""
            SELECT (ts / ?) * ? AS bucket,
                   COUNT(*)                                             AS total,
                   SUM(CASE WHEN status = 'healthy'   THEN 1 ELSE 0 END) AS up,
                   SUM(CASE WHEN status = 'warning'   THEN 1 ELSE 0 END) AS warn,
                   SUM(CASE WHEN status NOT IN ('healthy','warning') THEN 1 ELSE 0 END) AS down,
                   AVG(CASE WHEN status = 'healthy' THEN latency_ms END) AS avg_latency,
                   MAX(CASE WHEN status = 'healthy' THEN latency_ms END) AS max_latency
            FROM checks
            WHERE {where}
            GROUP BY bucket
            ORDER BY bucket
        """
        with self._lock:
            rows = self._db.execute(sql, params).fetchall()

        points = [{
            "ts": int(row["bucket"]),
            "total": int(row["total"] or 0),
            "up": int(row["up"] or 0),
            "warn": int(row["warn"] or 0),
            "down": int(row["down"] or 0),
            "avgLatencyMs": round(row["avg_latency"], 1) if row["avg_latency"] is not None else None,
            "maxLatencyMs": int(row["max_latency"]) if row["max_latency"] is not None else None,
            "uptimePct": round(100.0 * (row["up"] or 0) / row["total"], 1) if row["total"] else None,
        } for row in rows]

        total = sum(p["total"] for p in points)
        up = sum(p["up"] for p in points)
        latencies = [p["avgLatencyMs"] for p in points if p["avgLatencyMs"] is not None]
        return {
            "range": range_key,
            "rangeLabel": RANGE_LABELS[range_key],
            "bucketSeconds": bucket,
            "from": since,
            "to": now,
            "points": points,
            "summary": {
                "samples": total,
                "uptimePct": round(100.0 * up / total, 2) if total else None,
                "avgLatencyMs": round(sum(latencies) / len(latencies), 1) if latencies else None,
                "maxLatencyMs": max((p["maxLatencyMs"] for p in points
                                     if p["maxLatencyMs"] is not None), default=None),
                "failures": total - up,
            },
        }

    def stats(self) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT COUNT(*) AS rows, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM checks"
            ).fetchone()
        return {
            "rows": int(row["rows"] or 0),
            "firstTs": int(row["first_ts"]) if row["first_ts"] else None,
            "lastTs": int(row["last_ts"]) if row["last_ts"] else None,
            "retentionDays": self._retention,
        }

    def close(self):
        with self._lock:
            self._db.close()
