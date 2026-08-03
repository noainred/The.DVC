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

# 원본(checks)을 그대로 집계하면 한 달 차트가 수십만 행을 스캔한다. 적재 트랜잭션 안에서
# **시간당 집계 테이블(checks_hourly)을 증분 갱신**해 두고, 버킷이 1시간 이상인 기간
# (일주일·한달)은 이 테이블만 읽는다 — 스캔 대상이 수십만 → 수백 행으로 줄어든다.
ROLLUP_MIN_BUCKET = 3600


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
            # 시간당 롤업 — (시각버킷, 바로가기) 당 1행. 적재 시 증분 upsert 한다.
            self._db.execute("""
                CREATE TABLE IF NOT EXISTS checks_hourly (
                  hour        INTEGER NOT NULL,
                  shortcut_id TEXT    NOT NULL,
                  total       INTEGER NOT NULL DEFAULT 0,
                  up          INTEGER NOT NULL DEFAULT 0,
                  warn        INTEGER NOT NULL DEFAULT 0,
                  down        INTEGER NOT NULL DEFAULT 0,
                  lat_sum     INTEGER NOT NULL DEFAULT 0,
                  lat_n       INTEGER NOT NULL DEFAULT 0,
                  lat_max     INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY (hour, shortcut_id)
                )
            """)
            self._db.execute("CREATE INDEX IF NOT EXISTS idx_hourly_hour ON checks_hourly(hour)")
            self._db.commit()
            self._backfill_rollup()

    def _backfill_rollup(self):
        """기존 DB(롤업 도입 이전) 마이그레이션 — 원본을 한 번만 접어 넣는다.

        이걸 빼면 업그레이드 직후 일주일·한달 차트가 '데이터 없음'으로 비어 보인다
        (롤업이 앞으로 들어오는 점검부터만 쌓이므로).
        """
        if self._db.execute("SELECT 1 FROM checks_hourly LIMIT 1").fetchone():
            return
        if not self._db.execute("SELECT 1 FROM checks LIMIT 1").fetchone():
            return
        self._db.execute("""
            INSERT INTO checks_hourly (hour, shortcut_id, total, up, warn, down,
                                       lat_sum, lat_n, lat_max)
            SELECT (ts / 3600) * 3600, shortcut_id,
                   COUNT(*),
                   SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN status NOT IN ('healthy','warning') THEN 1 ELSE 0 END),
                   SUM(CASE WHEN status = 'healthy' THEN latency_ms ELSE 0 END),
                   SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END),
                   MAX(CASE WHEN status = 'healthy' THEN latency_ms ELSE 0 END)
            FROM checks
            WHERE shortcut_id IS NOT NULL
            GROUP BY 1, shortcut_id
        """)
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

        hour = (stamp // 3600) * 3600
        # (hour, id) 별 증분값을 미리 접어서 한 번에 upsert 한다.
        folded = {}
        for row in results:
            shortcut_id = row.get("id")
            if not shortcut_id:
                continue
            status = str(row.get("status", "unknown"))
            latency = int(row.get("latencyMs") or 0)
            acc = folded.setdefault(shortcut_id, [0, 0, 0, 0, 0, 0, 0])
            acc[0] += 1                                    # total
            if status == "healthy":
                acc[1] += 1                                # up
                acc[4] += latency                          # lat_sum
                acc[5] += 1                                # lat_n
                acc[6] = max(acc[6], latency)              # lat_max
            elif status == "warning":
                acc[2] += 1                                # warn
            else:
                acc[3] += 1                                # down

        with self._lock:
            self._db.execute("BEGIN")
            try:
                self._db.executemany(
                    "INSERT INTO checks (ts, shortcut_id, url, status, status_code, latency_ms, message)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
                if folded:
                    self._db.executemany("""
                        INSERT INTO checks_hourly (hour, shortcut_id, total, up, warn, down,
                                                   lat_sum, lat_n, lat_max)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(hour, shortcut_id) DO UPDATE SET
                          total   = total   + excluded.total,
                          up      = up      + excluded.up,
                          warn    = warn    + excluded.warn,
                          down    = down    + excluded.down,
                          lat_sum = lat_sum + excluded.lat_sum,
                          lat_n   = lat_n   + excluded.lat_n,
                          lat_max = MAX(lat_max, excluded.lat_max)
                    """, [(hour, sid, *acc) for sid, acc in folded.items()])
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
            self._writes += 1
            if self._writes % PRUNE_EVERY == 0:
                self.prune()
        return len(rows)

    def prune(self) -> int:
        cutoff = int(time.time()) - self._retention * 86400
        with self._lock:
            cursor = self._db.execute("DELETE FROM checks WHERE ts < ?", (cutoff,))
            # 롤업도 같은 기준으로 정리한다(원본만 지우면 집계가 영원히 남는다).
            self._db.execute("DELETE FROM checks_hourly WHERE hour < ?", (cutoff,))
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

        # 버킷이 1시간 이상이면 원본 대신 시간당 롤업을 읽는다. 한 달(43200초 버킷) 차트가
        # 수십만 행 스캔 → 링크당 720행 스캔으로 줄어든다.
        source_rollup = bucket >= ROLLUP_MIN_BUCKET
        if source_rollup:
            params = [bucket, bucket, since]
            where = "hour >= ?"
            if shortcut_id:
                where += " AND shortcut_id = ?"
                params.append(shortcut_id)
            sql = f"""
                SELECT (hour / ?) * ? AS bucket,
                       SUM(total)   AS total,
                       SUM(up)      AS up,
                       SUM(warn)    AS warn,
                       SUM(down)    AS down,
                       SUM(lat_sum) AS lat_sum,
                       SUM(lat_n)   AS lat_n,
                       MAX(lat_max) AS max_latency
                FROM checks_hourly
                WHERE {where}
                GROUP BY bucket
                ORDER BY bucket
            """
        else:
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
                       SUM(CASE WHEN status = 'healthy' THEN latency_ms ELSE 0 END) AS lat_sum,
                       SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END)  AS lat_n,
                       MAX(CASE WHEN status = 'healthy' THEN latency_ms END) AS max_latency
                FROM checks
                WHERE {where}
                GROUP BY bucket
                ORDER BY bucket
            """
        with self._lock:
            rows = self._db.execute(sql, params).fetchall()

        points = []
        for row in rows:
            lat_n = int(row["lat_n"] or 0)
            lat_sum = int(row["lat_sum"] or 0)
            total = int(row["total"] or 0)
            points.append({
                "ts": int(row["bucket"]),
                "total": total,
                "up": int(row["up"] or 0),
                "warn": int(row["warn"] or 0),
                "down": int(row["down"] or 0),
                "avgLatencyMs": round(lat_sum / lat_n, 1) if lat_n else None,
                "maxLatencyMs": int(row["max_latency"]) if row["max_latency"] else None,
                "uptimePct": round(100.0 * (row["up"] or 0) / total, 1) if total else None,
            })

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
