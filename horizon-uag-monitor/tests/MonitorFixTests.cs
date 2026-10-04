using Microsoft.Data.Sqlite;
using Xunit;

namespace HorizonUagMonitor.Tests;

/// <summary>
/// 점검 저장·이력·보존 정리·DB 전환의 회귀 고정:
/// ① 앱 종료로 끊긴 점검은 결과가 아니다(가짜 '위험' 샘플 금지)
/// ② 이력은 시간 버킷 집계라 365일 범위도 전 기간을 덮고 단발 장애가 사라지지 않는다
/// ③ 보존 정리는 청크로 지우고 청크 사이에 잠금을 놓는다
/// ④ 다른 DB 로 전환하면 진행 중 점검 결과·알람 판정을 버린다
/// </summary>
public class MonitorFixTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "uagmon-fix-" + Guid.NewGuid().ToString("N"));
    private string Dir(string name) { var d = Path.Combine(_root, name); Directory.CreateDirectory(d); return d; }

    public MonitorFixTests() { Directory.CreateDirectory(_root); }
    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, true); } catch { /* 윈도우에서 잠금이 늦게 풀릴 수 있다 */ }
    }

    private static long ToMs(DateTime utc) => new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    private sealed record Row(long Ts, HealthStatus Status, double? ResponseMs);

    /// <summary>테스트용 대량 적재 — 별도 연결에서 트랜잭션 1회(행마다 InsertSample 을 부르면 느리다).</summary>
    private static void BulkInsert(string dbFile, long endpointId, IEnumerable<Row> rows)
    {
        using var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbFile, Pooling = false }.ToString());
        c.Open();
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO samples (endpoint_id,ts,status,tcp_ok,connect_ms,tls_ok,http_status,response_ms,cert_expiry_days,error) VALUES ($e,$t,$s,1,NULL,1,200,$r,NULL,NULL)";
        var pe = cmd.Parameters.Add("$e", SqliteType.Integer);
        var pt = cmd.Parameters.Add("$t", SqliteType.Integer);
        var ps = cmd.Parameters.Add("$s", SqliteType.Integer);
        var pr = cmd.Parameters.Add("$r", SqliteType.Real);
        foreach (var r in rows)
        {
            pe.Value = endpointId; pt.Value = r.Ts; ps.Value = (int)r.Status;
            pr.Value = (object?)r.ResponseMs ?? DBNull.Value;
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    private static long Count(string dbFile, string sql)
    {
        using var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbFile, Pooling = false, Mode = SqliteOpenMode.ReadOnly }.ToString());
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    // ── ① 앱 종료 vs 시간 초과 ────────────────────────────────────────────────
    [Fact]
    public void 앱_토큰이_취소되면_어떤_예외든_앱_종료다()
    {
        using var app = new CancellationTokenSource();
        app.Cancel();
        Assert.Equal(CheckFailureKind.AppStopping, MonitorRules.ClassifyFailure(new OperationCanceledException(), app.Token));
        Assert.Equal(CheckFailureKind.AppStopping, MonitorRules.ClassifyFailure(new TaskCanceledException(), app.Token));
        Assert.Equal(CheckFailureKind.AppStopping, MonitorRules.ClassifyFailure(new System.Net.Sockets.SocketException(10061), app.Token));
    }

    [Fact]
    public void 앱이_살아_있으면_취소는_시간_초과이고_그_밖은_오류다()
    {
        Assert.Equal(CheckFailureKind.Timeout, MonitorRules.ClassifyFailure(new OperationCanceledException(), CancellationToken.None));
        Assert.Equal(CheckFailureKind.Timeout, MonitorRules.ClassifyFailure(new TaskCanceledException("x", new TimeoutException()), CancellationToken.None));
        Assert.Equal(CheckFailureKind.Error, MonitorRules.ClassifyFailure(new System.Net.Sockets.SocketException(10061), CancellationToken.None));
        Assert.Equal("시간 초과", MonitorRules.FailureText(new OperationCanceledException(), CheckFailureKind.Timeout));
        Assert.Equal("거부됨", MonitorRules.FailureText(new Exception("바깥", new Exception("거부됨")), CheckFailureKind.Error));
        Assert.Equal(120, MonitorRules.FailureText(new Exception(new string('x', 500)), CheckFailureKind.Error).Length);
    }

    [Fact]
    public async Task 실제_연결_토큰으로_종료와_시한을_구분한다()
    {
        // MonitorService 와 같은 모양: 앱 토큰에 연결한 토큰 + CancelAfter(요청 시한).
        async Task<CheckFailureKind> Run(CancellationToken app, int afterMs, Action? cancelApp)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(app);
            linked.CancelAfter(afterMs);
            cancelApp?.Invoke();
            try { await Task.Delay(Timeout.Infinite, linked.Token); return CheckFailureKind.Error; }
            catch (Exception ex) { return MonitorRules.ClassifyFailure(ex, app); }
        }
        using var app1 = new CancellationTokenSource();
        Assert.Equal(CheckFailureKind.Timeout, await Run(app1.Token, 30, null));
        using var app2 = new CancellationTokenSource();
        Assert.Equal(CheckFailureKind.AppStopping, await Run(app2.Token, 60_000, () => app2.Cancel()));
    }

    // ── ② 이력 버킷 집계 ─────────────────────────────────────────────────────
    [Fact]
    public void 버킷_크기는_점_수_상한을_넘지_않는다()
    {
        Assert.Equal(60, HistoryRules.BucketSecFor(1440));       // 1일 = 1분
        Assert.Equal(300, HistoryRules.BucketSecFor(10080));     // 7일 = 5분
        Assert.Equal(1200, HistoryRules.BucketSecFor(43200));    // 30일 = 20분(15분이면 2,880점)
        Assert.Equal(3600, HistoryRules.BucketSecFor(129600));   // 90일 = 1시간
        Assert.Equal(14400, HistoryRules.BucketSecFor(525600));  // 365일 = 4시간
        foreach (var m in new[] { 1, 10, 30, 60, 180, 360, 1440, 10080, 43200, 129600, 525600 })
            Assert.True(m * 60.0 / HistoryRules.BucketSecFor(m) <= HistoryRules.MaxPoints, $"{m}분");
        Assert.Equal(1, HistoryRules.BucketSecFor(1));
    }

    [Fact]
    public void 이력_365일은_전_기간을_덮고_단발_위험이_사라지지_않는다()
    {
        using var db = new Database(DataLocation.DbPathIn(Dir("hist")));
        var id = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "h" });
        var now = DateTime.UtcNow;
        const int n = 30_000; // 60초 주기 약 20.8일 — v1.1 의 상한(2만 건)이면 최근 13.9일만 보였다
        var t0 = ToMs(now.AddMinutes(-n));
        var rows = new List<Row>(n);
        for (int i = 0; i < n; i++)
        {
            var st = i == 1234 ? HealthStatus.Down : (i % 1000 == 7 ? HealthStatus.Warn : HealthStatus.Up);
            rows.Add(new Row(t0 + i * 60_000L, st, st == HealthStatus.Down ? null : 100 + (i % 50)));
        }
        BulkInsert(db.DbPath, id, rows);

        var since = now.AddDays(-365);
        var buckets = db.HistoryBuckets(id, since, HistoryRules.BucketSecFor(525600));
        var sum = HistoryRules.Summarize(buckets);

        Assert.Equal(n, sum.Count);
        Assert.Equal(t0, ToMs(buckets[0].FirstUtc));                      // 가장 오래된 샘플까지 덮는다
        Assert.Equal(t0 + (n - 1) * 60_000L, ToMs(buckets[^1].LastUtc));
        Assert.Equal(1, sum.Down);
        Assert.Equal(HealthStatus.Down, Assert.Single(buckets, b => b.Down > 0).Worst);
        Assert.Equal(rows.Count(r => r.Status == HealthStatus.Warn), sum.Warn);
        // 통계는 건수 합이라 원시 행으로 낸 값과 같다.
        var resp = rows.Where(r => r.ResponseMs.HasValue).Select(r => r.ResponseMs!.Value).ToList();
        Assert.Equal(resp.Average(), sum.AvgResponseMs!.Value, 6);
        Assert.Equal(resp.Max(), sum.MaxResponseMs);
        Assert.Equal(100.0 * rows.Count(r => r.Status == HealthStatus.Up) / n, sum.UptimePct, 9);
        Assert.True(buckets.Count <= HistoryRules.MaxPoints);
        Assert.Null(db.LastError(id, since));
    }

    [Fact]
    public void 버킷의_가장_나쁜_상태는_위험이_주의보다_앞선다()
    {
        Assert.Equal(HealthStatus.Down, HistoryRules.WorstOf(up: 100, warn: 3, down: 1));
        Assert.Equal(HealthStatus.Warn, HistoryRules.WorstOf(up: 100, warn: 1, down: 0));
        Assert.Equal(HealthStatus.Up, HistoryRules.WorstOf(up: 1, warn: 0, down: 0));
        Assert.Equal(HealthStatus.Unknown, HistoryRules.WorstOf(0, 0, 0));
        Assert.Null(HistoryRules.Summarize(Array.Empty<HistoryBucket>()).AvgResponseMs);
    }

    // ── ③ 보존 정리 ─────────────────────────────────────────────────────────
    [Fact]
    public void 보존_정리는_청크로_지우고_청크_사이에_잠금을_놓는다()
    {
        using var db = new Database(DataLocation.DbPathIn(Dir("prune")));
        var id = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "h" });
        var oldT = ToMs(DateTime.UtcNow.AddDays(-400));
        var newT = ToMs(DateTime.UtcNow.AddDays(-1));
        BulkInsert(db.DbPath, id, Enumerable.Range(0, 7000).Select(i => new Row(oldT + i * 1000L, HealthStatus.Up, 1)));
        BulkInsert(db.DbPath, id, Enumerable.Range(0, 5000).Select(i => new Row(newT + i * 1000L, HealthStatus.Up, 1)));

        var chunks = new List<int>();
        var otherThreadGotLock = new List<bool>();
        var removed = db.Prune(365, onChunk: n =>
        {
            chunks.Add(n);
            // 다른 스레드(화면 타이머·점검 저장 자리)가 청크 사이에 DB 를 쓸 수 있어야 한다.
            var t = Task.Run(() => db.CountEndpoints());
            otherThreadGotLock.Add(t.Wait(TimeSpan.FromSeconds(5)));
        });

        Assert.Equal(7000, removed);
        Assert.Equal(new[] { 5000, 2000 }, chunks);
        Assert.All(otherThreadGotLock, Assert.True);
        Assert.Equal(5000, Count(db.DbPath, "SELECT COUNT(*) FROM samples"));
        Assert.Equal(0, Count(db.DbPath, $"SELECT COUNT(*) FROM samples WHERE ts < {newT}"));
        // 많이 지웠으면 WAL 을 본 파일에 합친다(TRUNCATE — 길이 0).
        var wal = db.DbPath + "-wal";
        Assert.True(!File.Exists(wal) || new FileInfo(wal).Length == 0, "WAL 이 비어 있어야 한다");
        Assert.Equal(0, db.Prune(365));
    }

    // ── ④ DB 전환 세대 ──────────────────────────────────────────────────────
    [Fact]
    public void 기존_DB로_전환하면_전환_전에_시작한_점검_결과는_저장하지_않는다()
    {
        var targetFile = DataLocation.DbPathIn(Dir("target"));
        using (var t = new Database(targetFile)) t.UpsertEndpoint(new Endpoint { Name = "다른 대상", Host = "x" });
        using var db = new Database(DataLocation.DbPathIn(Dir("old")));
        var oldId = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "h" });

        var gen = db.Generation; // 점검 시작 때의 세대
        db.SwitchTo(targetFile, () => { });
        Assert.Equal(gen + 1, db.Generation);

        var sample = new Sample { EndpointId = oldId, TimestampUtc = DateTime.UtcNow, Status = HealthStatus.Down };
        Assert.False(db.InsertSample(sample, gen));
        Assert.Equal(0, Count(targetFile, "SELECT COUNT(*) FROM samples"));
        Assert.True(db.InsertSample(sample, db.Generation));
        Assert.Equal(1, Count(targetFile, "SELECT COUNT(*) FROM samples"));
    }

    [Fact]
    public void 폴더_이동은_세대를_바꾸지_않는다()
    {
        var loc = new DataLocation(Dir("base"));
        using var db = new Database(DataLocation.DbPathIn(Dir("mv-old")));
        var id = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "h" });
        var gen = db.Generation;
        var r = DataMigrator.Migrate(db, loc, Path.Combine(_root, "mv-new"));
        Assert.True(r.Ok, r.Message);
        Assert.Equal(gen, db.Generation); // 같은 id 를 옮겼다 — 진행 중 결과·끈 알람을 버리지 않는다
        Assert.True(db.InsertSample(new Sample { EndpointId = id, TimestampUtc = DateTime.UtcNow, Status = HealthStatus.Up }, gen));
    }

    [Fact]
    public void 세대가_바뀌면_알람_판정을_비운다()
    {
        var e = new AlarmEngine();
        var T0 = new DateTime(2026, 10, 3, 3, 0, 0, DateTimeKind.Utc);
        var snap = new[]
        {
            new EndpointStatus
            {
                Endpoint = new Endpoint { Id = 1, Name = "A", Enabled = true, IntervalSec = 60 },
                Latest = new Sample { EndpointId = 1, Status = HealthStatus.Down, TimestampUtc = T0 },
            },
        };
        Assert.False(e.SyncGeneration(0)); // 처음은 기억만
        e.Update(snap, T0);
        e.AcknowledgeAll();
        Assert.False(e.SyncGeneration(0));
        Assert.Single(e.Active);
        Assert.True(e.SyncGeneration(1));
        Assert.Empty(e.Active);
        Assert.False(e.SyncGeneration(1));
    }
}
