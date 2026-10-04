using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using Microsoft.Data.Sqlite;

namespace HorizonUagMonitor;

/// <summary>
/// 자체 SQLite DB(자기완결형 파일). %LOCALAPPDATA%\HorizonUagMonitor\monitor.db 에 보관.
/// 단일 연결을 열어두고 lock으로 직렬화(동시 점검이 write를 경쟁하지 않게). WAL로 write 가속.
/// </summary>
public sealed class Database : IDisposable
{
    private SqliteConnection _conn;
    private readonly object _gate = new();

    public string DbPath { get; private set; }

    private int _generation;

    /// <summary>
    /// 데이터 세대 — 다른 DB 파일로 전환(<see cref="SwitchTo"/>)할 때마다 1 오른다. 대상 id 는 DB 마다 따로 매겨지므로
    /// 전환 전에 읽은 대상의 점검 결과·알람 판정은 전환 뒤 DB 에 쓰면 안 된다(<see cref="InsertSample(Sample,int)"/>).
    /// 폴더 이동(<see cref="FinishMigration"/>)은 같은 내용·같은 id 를 옮기므로 올리지 않는다 — 올리면 그 순간 진행 중이던
    /// 정상 결과를 버리고 이미 끈 알람이 다시 울린다.
    /// </summary>
    public int Generation => Volatile.Read(ref _generation);

    public Database(string? overridePath = null)
    {
        DbPath = overridePath ?? DefaultDbPath();
        Directory.CreateDirectory(Path.GetDirectoryName(DbPath)!);
        _conn = OpenConnection(DbPath);
        CreateSchema();
    }

    /// <summary>기본(저장 폴더를 바꾸지 않았을 때의) DB 경로. 실제 경로는 <see cref="DataLocation"/> 이 정한다.</summary>
    public static string DefaultDbPath() => DataLocation.DbPathIn(DataLocation.DefaultBaseDir());

    // 풀링을 끈다 — 한 연결을 오래 쓰는 구조라 풀이 이득이 없고, 풀이 파일 핸들을 잡고 있으면
    // 저장 폴더를 옮긴 뒤 예전 파일을 지울 수 없다.
    private static SqliteConnection OpenConnection(string path, bool readOnly = false)
    {
        var cs = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Pooling = false,
            Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate,
        }.ToString();
        var c = new SqliteConnection(cs);
        try
        {
            c.Open();
            if (!readOnly)
            {
                using var cmd = c.CreateCommand();
                cmd.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;";
                cmd.ExecuteNonQuery();
            }
        }
        catch { c.Dispose(); throw; }
        return c;
    }

    private void CreateSchema()
    {
        Exec(@"
            CREATE TABLE IF NOT EXISTS endpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                datacenter TEXT NOT NULL DEFAULT '',
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 443,
                path TEXT NOT NULL DEFAULT '/',
                interval_sec INTEGER NOT NULL DEFAULT 60,
                timeout_ms INTEGER NOT NULL DEFAULT 5000,
                enabled INTEGER NOT NULL DEFAULT 1,
                sort INTEGER NOT NULL DEFAULT 0,
                type TEXT NOT NULL DEFAULT 'UAG',
                scheme TEXT NOT NULL DEFAULT 'https',
                match_text TEXT NOT NULL DEFAULT '',
                lat REAL NOT NULL DEFAULT 0,
                lon REAL NOT NULL DEFAULT 0,
                region TEXT NOT NULL DEFAULT '',
                city TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint_id INTEGER NOT NULL,
                ts INTEGER NOT NULL,
                status INTEGER NOT NULL,
                tcp_ok INTEGER NOT NULL,
                connect_ms REAL,
                tls_ok INTEGER NOT NULL,
                http_status INTEGER,
                response_ms REAL,
                cert_expiry_days INTEGER,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_samples_ep_ts ON samples (endpoint_id, ts);
            CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples (ts);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        ");
        // 기존 DB 마이그레이션 — 신규 컬럼을 추가(이미 있으면 오류 무시). 포탈 모니터링 필드.
        TryExec("ALTER TABLE endpoints ADD COLUMN type TEXT NOT NULL DEFAULT 'UAG'");
        TryExec("ALTER TABLE endpoints ADD COLUMN scheme TEXT NOT NULL DEFAULT 'https'");
        TryExec("ALTER TABLE endpoints ADD COLUMN match_text TEXT NOT NULL DEFAULT ''");
        TryExec("ALTER TABLE endpoints ADD COLUMN lat REAL NOT NULL DEFAULT 0");
        TryExec("ALTER TABLE endpoints ADD COLUMN lon REAL NOT NULL DEFAULT 0");
        TryExec("ALTER TABLE endpoints ADD COLUMN region TEXT NOT NULL DEFAULT ''");
        TryExec("ALTER TABLE endpoints ADD COLUMN city TEXT NOT NULL DEFAULT ''");
    }

    private void TryExec(string sql)
    {
        lock (_gate)
        {
            try { using var cmd = _conn.CreateCommand(); cmd.CommandText = sql; cmd.ExecuteNonQuery(); }
            catch { /* 이미 존재하는 컬럼 등은 무시 */ }
        }
    }

    private void Exec(string sql)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }
    }

    // ── endpoints ────────────────────────────────────────────────────────────
    public List<Endpoint> ListEndpoints()
    {
        lock (_gate)
        {
            var list = new List<Endpoint>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT id,name,datacenter,host,port,path,interval_sec,timeout_ms,enabled,sort,type,scheme,match_text,lat,lon,region,city FROM endpoints ORDER BY sort, datacenter, name";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                list.Add(new Endpoint
                {
                    Id = r.GetInt64(0),
                    Name = r.GetString(1),
                    Datacenter = r.GetString(2),
                    Host = r.GetString(3),
                    Port = r.GetInt32(4),
                    Path = r.GetString(5),
                    IntervalSec = r.GetInt32(6),
                    TimeoutMs = r.GetInt32(7),
                    Enabled = r.GetInt32(8) != 0,
                    Sort = r.GetInt32(9),
                    Type = r.IsDBNull(10) ? "UAG" : r.GetString(10),
                    Scheme = r.IsDBNull(11) ? "https" : r.GetString(11),
                    MatchText = r.IsDBNull(12) ? "" : r.GetString(12),
                    Lat = r.IsDBNull(13) ? 0 : r.GetDouble(13),
                    Lon = r.IsDBNull(14) ? 0 : r.GetDouble(14),
                    Region = r.IsDBNull(15) ? "" : r.GetString(15),
                    City = r.IsDBNull(16) ? "" : r.GetString(16),
                });
            }
            return list;
        }
    }

    public long UpsertEndpoint(Endpoint e)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            if (e.Id > 0)
            {
                cmd.CommandText = @"UPDATE endpoints SET name=$n,datacenter=$dc,host=$h,port=$p,path=$pa,
                    interval_sec=$iv,timeout_ms=$to,enabled=$en,sort=$so,type=$ty,scheme=$sc,match_text=$mt,lat=$lat,lon=$lon,region=$rg,city=$ci WHERE id=$id";
                cmd.Parameters.AddWithValue("$id", e.Id);
            }
            else
            {
                cmd.CommandText = @"INSERT INTO endpoints (name,datacenter,host,port,path,interval_sec,timeout_ms,enabled,sort,type,scheme,match_text,lat,lon,region,city)
                    VALUES ($n,$dc,$h,$p,$pa,$iv,$to,$en,$so,$ty,$sc,$mt,$lat,$lon,$rg,$ci)";
            }
            cmd.Parameters.AddWithValue("$n", e.Name);
            cmd.Parameters.AddWithValue("$dc", e.Datacenter ?? "");
            cmd.Parameters.AddWithValue("$h", e.Host);
            cmd.Parameters.AddWithValue("$p", e.Port);
            cmd.Parameters.AddWithValue("$pa", string.IsNullOrEmpty(e.Path) ? "/" : e.Path);
            cmd.Parameters.AddWithValue("$iv", e.IntervalSec);
            cmd.Parameters.AddWithValue("$to", e.TimeoutMs);
            cmd.Parameters.AddWithValue("$en", e.Enabled ? 1 : 0);
            cmd.Parameters.AddWithValue("$so", e.Sort);
            cmd.Parameters.AddWithValue("$ty", string.IsNullOrWhiteSpace(e.Type) ? "UAG" : e.Type);
            cmd.Parameters.AddWithValue("$sc", string.Equals(e.Scheme, "http", StringComparison.OrdinalIgnoreCase) ? "http" : "https");
            cmd.Parameters.AddWithValue("$mt", e.MatchText ?? "");
            cmd.Parameters.AddWithValue("$lat", e.Lat);
            cmd.Parameters.AddWithValue("$lon", e.Lon);
            cmd.Parameters.AddWithValue("$rg", e.Region ?? "");
            cmd.Parameters.AddWithValue("$ci", e.City ?? "");
            cmd.ExecuteNonQuery();
            if (e.Id > 0) return e.Id;
            // last_insert_rowid()는 같은 연결에서 별도 조회(배치+ExecuteScalar의 미묘한 동작 회피).
            using var idCmd = _conn.CreateCommand();
            idCmd.CommandText = "SELECT last_insert_rowid()";
            var id = (long)(idCmd.ExecuteScalar() ?? 0L);
            e.Id = id;
            return id;
        }
    }

    public void DeleteEndpoint(long id)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "DELETE FROM samples WHERE endpoint_id=$id; DELETE FROM endpoints WHERE id=$id;";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.ExecuteNonQuery();
        }
    }

    public int CountEndpoints()
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM endpoints";
            return Convert.ToInt32(cmd.ExecuteScalar() ?? 0, CultureInfo.InvariantCulture);
        }
    }

    // ── samples ──────────────────────────────────────────────────────────────
    public void InsertSample(Sample s)
    {
        lock (_gate) InsertSampleLocked(s);
    }

    /// <summary>
    /// 세대가 <paramref name="expectedGeneration"/> 그대로일 때만 저장한다(검사와 쓰기가 같은 잠금 안이다).
    /// 점검 도중 다른 DB 로 전환됐으면 false — 그 결과는 예전 DB 의 대상 id 를 들고 있다.
    /// </summary>
    public bool InsertSample(Sample s, int expectedGeneration)
    {
        lock (_gate)
        {
            if (_generation != expectedGeneration) return false;
            InsertSampleLocked(s);
            return true;
        }
    }

    private void InsertSampleLocked(Sample s)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = @"INSERT INTO samples (endpoint_id,ts,status,tcp_ok,connect_ms,tls_ok,http_status,response_ms,cert_expiry_days,error)
            VALUES ($e,$t,$s,$tcp,$c,$tls,$hs,$rm,$ce,$err)";
        cmd.Parameters.AddWithValue("$e", s.EndpointId);
        cmd.Parameters.AddWithValue("$t", ToMs(s.TimestampUtc));
        cmd.Parameters.AddWithValue("$s", (int)s.Status);
        cmd.Parameters.AddWithValue("$tcp", s.TcpOk ? 1 : 0);
        cmd.Parameters.AddWithValue("$c", (object?)s.ConnectMs ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$tls", s.TlsOk ? 1 : 0);
        cmd.Parameters.AddWithValue("$hs", (object?)s.HttpStatus ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$rm", (object?)s.ResponseMs ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$ce", (object?)s.CertExpiryDays ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$err", (object?)s.Error ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    public Dictionary<long, Sample> LatestByEndpoint()
    {
        lock (_gate)
        {
            var map = new Dictionary<long, Sample>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"SELECT s.endpoint_id, s.ts, s.status, s.tcp_ok, s.connect_ms, s.tls_ok, s.http_status, s.response_ms, s.cert_expiry_days, s.error
                FROM samples s JOIN (SELECT endpoint_id, MAX(ts) mt FROM samples GROUP BY endpoint_id) m
                ON s.endpoint_id=m.endpoint_id AND s.ts=m.mt";
            using var r = cmd.ExecuteReader();
            while (r.Read()) { var s = ReadSample(r, epIdCol: 0, tsCol: 1, baseCol: 2); map[s.EndpointId] = s; }
            return map;
        }
    }

    /// <summary>대상별 최근 N개 샘플(오래된→최신) — 카드 스파크라인용(가볍게).</summary>
    public List<Sample> RecentSamples(long endpointId, int limit = 40)
    {
        lock (_gate)
        {
            var list = new List<Sample>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"SELECT endpoint_id, ts, status, tcp_ok, connect_ms, tls_ok, http_status, response_ms, cert_expiry_days, error
                FROM samples WHERE endpoint_id=$e ORDER BY ts DESC LIMIT $lim";
            cmd.Parameters.AddWithValue("$e", endpointId);
            cmd.Parameters.AddWithValue("$lim", limit);
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add(ReadSample(r, epIdCol: 0, tsCol: 1, baseCol: 2));
            list.Reverse();
            return list;
        }
    }

    /// <summary>대상별 최근 N개 샘플을 한 번에(대시보드 카드 다수용). 반환: id → 오래된→최신 리스트.</summary>
    public Dictionary<long, List<Sample>> RecentSamplesAll(IEnumerable<long> ids, int limit = 40)
    {
        var map = new Dictionary<long, List<Sample>>();
        foreach (var id in ids) map[id] = RecentSamples(id, limit);
        return map;
    }

    public List<Sample> History(long endpointId, DateTime sinceUtc, int maxRows = 20000)
    {
        lock (_gate)
        {
            var list = new List<Sample>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"SELECT endpoint_id, ts, status, tcp_ok, connect_ms, tls_ok, http_status, response_ms, cert_expiry_days, error
                FROM samples WHERE endpoint_id=$e AND ts>=$since ORDER BY ts DESC LIMIT $lim";
            cmd.Parameters.AddWithValue("$e", endpointId);
            cmd.Parameters.AddWithValue("$since", ToMs(sinceUtc));
            cmd.Parameters.AddWithValue("$lim", maxRows);
            using var r = cmd.ExecuteReader();
            while (r.Read()) list.Add(ReadSample(r, epIdCol: 0, tsCol: 1, baseCol: 2));
            list.Reverse(); // 오래된→최신
            return list;
        }
    }

    /// <summary>
    /// 기간 이력을 시간 버킷으로 집계한다(ts 는 epoch ms). 원시 행을 상한으로 자르지 않으므로 365일 범위도 전 기간을 덮고,
    /// 버킷마다 위험·주의 건수와 '가장 나쁜 상태' 를 남겨 단발 장애가 다운샘플로 사라지지 않는다.
    /// </summary>
    public List<HistoryBucket> HistoryBuckets(long endpointId, DateTime sinceUtc, int bucketSec)
    {
        long bucketMs = Math.Max(1, bucketSec) * 1000L;
        lock (_gate)
        {
            var list = new List<HistoryBucket>();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"SELECT CAST(ts / $b AS INTEGER) AS bk, COUNT(*), MIN(ts), MAX(ts),
                    SUM(CASE WHEN status=$up THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status=$warn THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status=$down THEN 1 ELSE 0 END),
                    COUNT(response_ms), TOTAL(response_ms), MAX(response_ms)
                FROM samples WHERE endpoint_id=$e AND ts>=$since
                GROUP BY bk ORDER BY bk";
            cmd.Parameters.AddWithValue("$b", bucketMs);
            cmd.Parameters.AddWithValue("$e", endpointId);
            cmd.Parameters.AddWithValue("$since", ToMs(sinceUtc));
            cmd.Parameters.AddWithValue("$up", (int)HealthStatus.Up);
            cmd.Parameters.AddWithValue("$warn", (int)HealthStatus.Warn);
            cmd.Parameters.AddWithValue("$down", (int)HealthStatus.Down);
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                int respCount = r.GetInt32(7);
                double respSum = r.GetDouble(8);
                list.Add(new HistoryBucket(
                    StartUtc: FromMs(r.GetInt64(0) * bucketMs),
                    FirstUtc: FromMs(r.GetInt64(2)),
                    LastUtc: FromMs(r.GetInt64(3)),
                    Count: r.GetInt32(1),
                    Up: r.GetInt32(4),
                    Warn: r.GetInt32(5),
                    Down: r.GetInt32(6),
                    RespCount: respCount,
                    RespSum: respSum,
                    AvgResponseMs: respCount > 0 ? respSum / respCount : null,
                    MaxResponseMs: r.IsDBNull(9) ? null : r.GetDouble(9)));
            }
            return list;
        }
    }

    /// <summary>기간 안의 가장 최근 오류 문구(없으면 null).</summary>
    public string? LastError(long endpointId, DateTime sinceUtc)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = @"SELECT error FROM samples WHERE endpoint_id=$e AND ts>=$since AND error IS NOT NULL AND error<>''
                ORDER BY ts DESC LIMIT 1";
            cmd.Parameters.AddWithValue("$e", endpointId);
            cmd.Parameters.AddWithValue("$since", ToMs(sinceUtc));
            return cmd.ExecuteScalar() as string;
        }
    }

    /// <summary>보존 기간 정리 한 번에 지우는 행 수. 청크 사이에 잠금을 놓아 점검 저장·화면 조회가 끼어들 수 있게 한다.</summary>
    public const int PruneChunk = 5000;

    /// <summary>
    /// 보존일보다 오래된 샘플을 지운다(삭제 건수 반환). 한 문장으로 수백만 행을 지우면 그동안 잠금을 쥐어 화면·점검이 멈추므로
    /// <see cref="PruneChunk"/> 행씩 지우고 청크마다 잠금을 놓는다. 많이 지웠으면 WAL 을 본 파일에 합쳐 줄인다(VACUUM 은 하지 않는다 —
    /// 파일 크기 축소는 폴더 이동의 VACUUM INTO 가 맡는다). <paramref name="onChunk"/> 는 청크마다 잠금 밖에서 불린다(테스트용).
    /// </summary>
    public int Prune(int retentionDays, int chunk = PruneChunk, Action<int>? onChunk = null)
    {
        if (retentionDays <= 0) return 0;
        chunk = Math.Max(1, chunk);
        var before = ToMs(DateTime.UtcNow.AddDays(-retentionDays));
        int total = 0;
        while (true)
        {
            int n;
            lock (_gate)
            {
                using var cmd = _conn.CreateCommand();
                cmd.CommandText = "DELETE FROM samples WHERE id IN (SELECT id FROM samples WHERE ts < $before LIMIT $n)";
                cmd.Parameters.AddWithValue("$before", before);
                cmd.Parameters.AddWithValue("$n", chunk);
                n = cmd.ExecuteNonQuery();
            }
            total += n;
            if (n > 0) { try { onChunk?.Invoke(n); } catch { /* 관찰자 오류 격리 */ } }
            if (n < chunk) break;
            Thread.Sleep(1); // 잠금을 기다리던 쪽(UI 타이머·점검 저장)이 먼저 잡을 기회를 준다.
        }
        if (total >= chunk)
        {
            lock (_gate)
            {
                try { Exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* 읽는 쪽이 있으면 다음에 */ }
            }
        }
        return total;
    }

    // ── settings ─────────────────────────────────────────────────────────────
    public string? GetSetting(string key)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT value FROM settings WHERE key=$k";
            cmd.Parameters.AddWithValue("$k", key);
            return cmd.ExecuteScalar() as string;
        }
    }

    public void SetSetting(string key, string value)
    {
        lock (_gate)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "INSERT INTO settings (key,value) VALUES ($k,$v) ON CONFLICT(key) DO UPDATE SET value=$v";
            cmd.Parameters.AddWithValue("$k", key);
            cmd.Parameters.AddWithValue("$v", value);
            cmd.ExecuteNonQuery();
        }
    }

    public int GetIntSetting(string key, int fallback)
        => int.TryParse(GetSetting(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;

    private static Sample ReadSample(SqliteDataReader r, int epIdCol, int tsCol, int baseCol)
    {
        // baseCol: status, +1 tcp_ok, +2 connect_ms, +3 tls_ok, +4 http_status, +5 response_ms, +6 cert_expiry_days, +7 error
        return new Sample
        {
            EndpointId = r.GetInt64(epIdCol),
            TimestampUtc = FromMs(r.GetInt64(tsCol)),
            Status = (HealthStatus)r.GetInt32(baseCol),
            TcpOk = r.GetInt32(baseCol + 1) != 0,
            ConnectMs = r.IsDBNull(baseCol + 2) ? null : r.GetDouble(baseCol + 2),
            TlsOk = r.GetInt32(baseCol + 3) != 0,
            HttpStatus = r.IsDBNull(baseCol + 4) ? null : r.GetInt32(baseCol + 4),
            ResponseMs = r.IsDBNull(baseCol + 5) ? null : r.GetDouble(baseCol + 5),
            CertExpiryDays = r.IsDBNull(baseCol + 6) ? null : r.GetInt32(baseCol + 6),
            Error = r.IsDBNull(baseCol + 7) ? null : r.GetString(baseCol + 7),
        };
    }

    private static long ToMs(DateTime utc) => new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
    private static DateTime FromMs(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;

    // ── 저장 폴더 이동(마이그레이션) ─────────────────────────────────────────
    // 무거운 복사는 별도 읽기 연결에서 잠금 없이 한다(점검·화면이 멈추지 않게) — WAL 이라 쓰기와 동시에 읽을 수 있다.
    // 복사하는 동안 쌓인 샘플은 마지막에 잠금을 잡고 짧게 따라잡는다(FinishMigration).

    /// <summary>현재 DB 의 일관된 사본을 <paramref name="destFile"/> 에 만든다(VACUUM INTO). 현재 DB 는 건드리지 않는다.</summary>
    public void ExportCopyTo(string destFile)
    {
        if (File.Exists(destFile)) File.Delete(destFile);
        using var src = OpenConnection(DbPath);
        using var cmd = src.CreateCommand();
        cmd.CommandText = "VACUUM INTO '" + destFile.Replace("'", "''") + "'";
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// 사본(<paramref name="copyFile"/>)에 복사 이후의 변경을 반영하고 검증한 뒤 <paramref name="finalFile"/> 로 옮기고,
    /// <paramref name="persistLocation"/> 로 새 위치를 기록한 다음 연결을 새 파일로 바꾼다.
    /// 어느 단계에서든 실패하면 현재 DB 는 그대로이며 만든 파일은 지운다.
    /// </summary>
    public void FinishMigration(string copyFile, string finalFile, Action persistLocation)
    {
        lock (_gate)
        {
            // 1) 따라잡기: 복사 이후 들어온 샘플 + 대상·설정(작은 표)은 통째로 다시 맞춘다.
            using (var attach = _conn.CreateCommand())
            {
                attach.CommandText = "ATTACH DATABASE $p AS dst";
                attach.Parameters.AddWithValue("$p", copyFile);
                attach.ExecuteNonQuery();
            }
            try
            {
                Exec(@"BEGIN IMMEDIATE;
                    INSERT INTO dst.samples (id,endpoint_id,ts,status,tcp_ok,connect_ms,tls_ok,http_status,response_ms,cert_expiry_days,error)
                        SELECT id,endpoint_id,ts,status,tcp_ok,connect_ms,tls_ok,http_status,response_ms,cert_expiry_days,error
                        FROM main.samples WHERE id > (SELECT IFNULL(MAX(id),0) FROM dst.samples);
                    DELETE FROM dst.endpoints;
                    INSERT INTO dst.endpoints SELECT * FROM main.endpoints;
                    DELETE FROM dst.settings;
                    INSERT INTO dst.settings SELECT * FROM main.settings;
                    COMMIT;");
            }
            catch
            {
                try { Exec("ROLLBACK"); } catch { /* 이미 끝난 트랜잭션 */ }
                try { Exec("DETACH DATABASE dst"); } catch { /* ignore */ }
                throw;
            }
            Exec("DETACH DATABASE dst");

            // 2) 검증(별도 연결): 무결성 + 대상·설정 개수 + 마지막 샘플 번호.
            VerifyCopy(copyFile);

            // 3) 제자리로 옮기고 새 연결을 먼저 열어 본다.
            File.Move(copyFile, finalFile, overwrite: false);
            SqliteConnection? next = null;
            try
            {
                next = OpenConnection(finalFile);
                persistLocation(); // 새 위치를 기록한 다음에만 연결을 바꾼다(기록이 실패하면 현재 DB 유지).
            }
            catch
            {
                try { next?.Dispose(); } catch { /* ignore */ }
                SqliteConnection.ClearAllPools();
                try { File.Delete(finalFile); } catch { /* ignore */ }
                throw;
            }

            var old = _conn;
            _conn = next;
            DbPath = finalFile;
            try { old.Dispose(); } catch { /* ignore */ }
            SqliteConnection.ClearAllPools();
        }
    }

    /// <summary>이미 있는 DB 파일로 연결만 바꾼다(예전 폴더는 건드리지 않는다). 스키마가 옛 버전이면 올린다.</summary>
    public void SwitchTo(string existingFile, Action persistLocation)
    {
        lock (_gate)
        {
            var next = OpenConnection(existingFile);
            var old = _conn;
            var oldPath = DbPath;
            try
            {
                _conn = next;
                DbPath = existingFile;
                CreateSchema();
                persistLocation();
            }
            catch
            {
                _conn = old;
                DbPath = oldPath;
                try { next.Dispose(); } catch { /* ignore */ }
                throw;
            }
            Interlocked.Increment(ref _generation); // 대상 id 의 뜻이 바뀌었다 — 진행 중 점검·알람 판정을 버리게 한다.
            try { old.Dispose(); } catch { /* ignore */ }
            SqliteConnection.ClearAllPools();
        }
    }

    /// <summary>지금 DB 의 쓰기 대기 로그를 본 파일에 합친다(파일을 복사·삭제하기 전).</summary>
    public void Checkpoint()
    {
        lock (_gate)
        {
            try { Exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ignore */ }
        }
    }

    private void VerifyCopy(string file)
    {
        using var dst = OpenConnection(file, readOnly: true);
        string Scalar(SqliteConnection c, string sql)
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = sql;
            return Convert.ToString(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) ?? "";
        }
        var check = Scalar(dst, "PRAGMA quick_check");
        if (!string.Equals(check, "ok", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("복사본 무결성 검사 실패: " + check);
        foreach (var t in new[] { "endpoints", "settings" })
        {
            var a = Scalar(_conn, $"SELECT COUNT(*) FROM main.{t}");
            var b = Scalar(dst, $"SELECT COUNT(*) FROM main.{t}");
            if (a != b) throw new InvalidOperationException($"복사본 검증 실패: {t} {a}행 → {b}행");
        }
        var ma = Scalar(_conn, "SELECT IFNULL(MAX(id),0) FROM main.samples");
        var mb = Scalar(dst, "SELECT IFNULL(MAX(id),0) FROM main.samples");
        if (ma != mb) throw new InvalidOperationException($"복사본 검증 실패: 마지막 샘플 번호 {ma} → {mb}");
        // 복사 도중 보존 정리가 오래된 행을 지웠을 수 있으므로 사본이 더 많은 것은 정상, 적은 것만 오류.
        var ca = long.Parse(Scalar(_conn, "SELECT COUNT(*) FROM main.samples"), CultureInfo.InvariantCulture);
        var cb = long.Parse(Scalar(dst, "SELECT COUNT(*) FROM main.samples"), CultureInfo.InvariantCulture);
        if (cb < ca) throw new InvalidOperationException($"복사본 검증 실패: 샘플 {ca}건 → {cb}건");
    }

    public void Dispose()
    {
        // 다른 모든 접근과 동일하게 _gate로 직렬화 — 종료 시점에 in-flight 명령(InsertSample 등)이
        // 실행 중이면 완료를 기다린 뒤 연결을 파기(네이티브 핸들 동시 접근/크래시 방지).
        lock (_gate)
        {
            try { _conn.Dispose(); } catch { /* ignore */ }
        }
    }
}
