using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Microsoft.Data.Sqlite;
using Xunit;

namespace HorizonUagMonitor.Tests;

/// <summary>
/// v2.767(점검 R2-B5-1·B5-2) 회귀 고정:
/// ① 점검 결과 저장 실패를 조용히 삼키지 않는다 — error.log(스로틀) + 연속 실패 수, 복구되면 0
/// ② 트레이·머리말 집계는 오래된 결과를 대기(Unknown)로 센다(알람 엔진과 같은 판정)
/// ③ 대상별 최신 샘플은 GROUP BY + MAX(ts) 전체 스캔이 아니라 대상별 인덱스 한 행이고, 스냅샷 캐시는 쓰기 1건에도 갱신된다
/// </summary>
public class SaveAndLatestTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "uagmon-save-" + Guid.NewGuid().ToString("N"));
    private string Dir(string name) { var d = Path.Combine(_root, name); Directory.CreateDirectory(d); return d; }

    // 기준 시각은 실제 시각을 정시로 떨어뜨려 고정한다(DateTime.UtcNow 직접·고정 epoch 둘 다 쓰지 않는다).
    private static readonly DateTime T0 = new(DateTime.UtcNow.Year, DateTime.UtcNow.Month, DateTime.UtcNow.Day, DateTime.UtcNow.Hour, 0, 0, DateTimeKind.Utc);

    public SaveAndLatestTests() { Directory.CreateDirectory(_root); }
    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, true); } catch { /* 윈도우에서 잠금이 늦게 풀릴 수 있다 */ }
    }

    private static void Exec(string dbFile, string sql)
    {
        using var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbFile, Pooling = false }.ToString());
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static async Task WaitUntil(Func<bool> cond, int timeoutMs = 20_000)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (!cond())
        {
            if (sw.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("조건을 기다리다 시한 초과");
            await Task.Delay(100);
        }
    }

    // ── ① 저장 실패 ─────────────────────────────────────────────────────────
    [Fact]
    public async Task 저장이_실패하면_기록하고_연속_실패를_세며_복구되면_0이다()
    {
        var dir = Dir("savefail");
        var dbFile = DataLocation.DbPathIn(dir);
        using var db = new Database(dbFile);
        // 닫힌 포트(1) — 곧바로 '위험' 샘플이 나온다. 네트워크 밖으로 나가지 않는다.
        var ep = new Endpoint { Name = "closed-port", Host = "127.0.0.1", Port = 1, IntervalSec = 5, TimeoutMs = 1000 };
        db.UpsertEndpoint(ep);
        // 쓰기만 실패(디스크 가득·네트워크 폴더 끊김 모사) — 읽기는 된다.
        Exec(dbFile, "CREATE TRIGGER fail_ins BEFORE INSERT ON samples BEGIN SELECT RAISE(FAIL,'simulated write failure'); END;");

        var log = new ConcurrentQueue<string>();
        using var mon = new MonitorService(db) { ErrorLog = log.Enqueue };
        int updates = 0;
        mon.Updated += () => Interlocked.Increment(ref updates);
        mon.Start();
        try
        {
            await WaitUntil(() => Volatile.Read(ref updates) >= 1);
            Assert.True(mon.SaveFailures >= 1, "저장 실패가 세어지지 않았다");
            Assert.Contains("simulated write failure", mon.LastSaveError);
            Assert.NotNull(mon.SaveFailingSinceUtc);
            Assert.Contains(log, l => l.Contains("점검 결과 저장 실패") && l.Contains("closed-port"));
            Assert.Empty(db.LatestByEndpoint());
            // 저장이 멈췄으면 '정상' 이라고 그리지 않는다(여기서는 결과가 없으니 대기).
            Assert.Equal(HealthStatus.Unknown, mon.OverallStatus());

            // 쓰기가 돌아오면 다음 점검에서 0 으로 돌아가고 복구 한 줄을 남긴다.
            Exec(dbFile, "DROP TRIGGER fail_ins;");
            mon.CheckAllNow();
            await WaitUntil(() => mon.SaveFailures == 0);
            Assert.Contains(log, l => l.Contains("점검 결과 저장 복구"));
            Assert.Null(mon.LastSaveError);
            Assert.Equal(HealthStatus.Down, db.LatestByEndpoint()[ep.Id].Status);
        }
        finally { mon.Stop(); }
    }

    [Fact]
    public void 저장_실패_로그는_스로틀한다()
    {
        var t = new SaveFailureTracker();
        var ex = new InvalidOperationException("disk full");
        var first = t.Fail("A", ex, T0);
        Assert.NotNull(first);
        Assert.Contains("연속 1회", first);
        Assert.Null(t.Fail("A", ex, T0.AddSeconds(30)));
        Assert.Null(t.Fail("B", ex, T0.AddMinutes(4)));
        var later = t.Fail("A", ex, T0.Add(SaveFailureTracker.LogEvery));
        Assert.NotNull(later);
        Assert.Contains("연속 4회", later);
        Assert.Contains("2건 더 실패", later);
        Assert.Equal(4, t.Consecutive);
        Assert.Equal(T0, t.SinceUtc);
        var rec = t.Succeed(T0.AddMinutes(6));
        Assert.NotNull(rec);
        Assert.Equal(0, t.Consecutive);
        Assert.Null(t.Succeed(T0.AddMinutes(7))); // 실패 중이 아니면 복구 줄도 없다
        // 복구 뒤 새 실패는 곧바로 기록된다(스로틀 초기화).
        Assert.NotNull(t.Fail("A", ex, T0.AddMinutes(7)));
    }

    // ── ② 오래된 결과는 대기 ─────────────────────────────────────────────────
    private static EndpointStatus Es(long id, HealthStatus st, DateTime? ts, bool enabled = true, int interval = 60)
        => new()
        {
            Endpoint = new Endpoint { Id = id, Name = "e" + id, Enabled = enabled, IntervalSec = interval },
            Latest = ts == null ? null : new Sample { EndpointId = id, Status = st, TimestampUtc = ts.Value },
        };

    [Fact]
    public void 트레이_집계는_오래된_결과를_대기로_센다()
    {
        var min = MonitorRules.DefaultMinStale;
        // 마지막 저장이 '정상' 이어도 3분(주기 60초 × 3)이 지나면 대기다 — 점검·저장이 멈춘 동안 초록으로 남지 않는다.
        var stale = MonitorRules.CountStatuses(new[] { Es(1, HealthStatus.Up, T0.AddMinutes(-4)) }, T0, min);
        Assert.Equal(new StatusCounts(0, 0, 0, 1, HealthStatus.Unknown), stale);
        var fresh = MonitorRules.CountStatuses(new[] { Es(1, HealthStatus.Up, T0.AddMinutes(-2)) }, T0, min);
        Assert.Equal(HealthStatus.Up, fresh.Overall);
        // 오래된 '위험' 도 위험으로 세지 않는다(알람 엔진과 같은 판정).
        var mixed = MonitorRules.CountStatuses(new[]
        {
            Es(1, HealthStatus.Down, T0.AddMinutes(-10)),
            Es(2, HealthStatus.Up, T0.AddSeconds(-30)),
            Es(3, HealthStatus.Warn, T0.AddSeconds(-30), enabled: false),
            Es(4, HealthStatus.Unknown, null),
        }, T0, min);
        Assert.Equal(new StatusCounts(1, 0, 0, 2, HealthStatus.Up), mixed);
        // 주기가 길면 유예도 길다(주기 × 3).
        Assert.Equal(HealthStatus.Warn, MonitorRules.CountStatuses(new[] { Es(1, HealthStatus.Warn, T0.AddMinutes(-20), interval: 600) }, T0, min).Overall);
        // 저장 실패 중이면 '정상' 이라고 그리지 않는다. 위험·주의는 그대로.
        Assert.Equal(HealthStatus.Unknown, MonitorRules.CountStatuses(new[] { Es(1, HealthStatus.Up, T0) }, T0, min, saveFailing: true).Overall);
        Assert.Equal(HealthStatus.Down, MonitorRules.CountStatuses(new[] { Es(1, HealthStatus.Down, T0) }, T0, min, saveFailing: true).Overall);
        Assert.Equal(HealthStatus.Unknown, MonitorRules.CountStatuses(Array.Empty<EndpointStatus>(), T0, min).Overall);
    }

    [Fact]
    public void 알람_엔진과_트레이는_같은_오래됨_경계를_쓴다()
    {
        var eng = new AlarmEngine();
        var es = Es(1, HealthStatus.Down, T0.AddSeconds(-180));
        Assert.Single(eng.Update(new[] { es }, T0));                                  // 경계(정확히 180초)는 아직 유효
        Assert.Equal(HealthStatus.Down, MonitorRules.CountStatuses(new[] { es }, T0, eng.MinStale).Overall);
        var later = T0.AddSeconds(1);
        Assert.Contains(eng.Update(new[] { es }, later), e => e.Kind == AlarmEventKind.Cleared);
        Assert.Equal(HealthStatus.Unknown, MonitorRules.CountStatuses(new[] { es }, later, eng.MinStale).Overall);
    }

    // ── ③ 대상별 최신 샘플 · 스냅샷 캐시 ─────────────────────────────────────
    [Fact]
    public void 대상별_최신_샘플은_대상마다_가장_늦은_한_행이다()
    {
        using var db = new Database(DataLocation.DbPathIn(Dir("latest")));
        var a = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "a" });
        var b = db.UpsertEndpoint(new Endpoint { Name = "B", Host = "b" });
        var c = db.UpsertEndpoint(new Endpoint { Name = "C", Host = "c" }); // 샘플 없음
        for (int i = 0; i < 50; i++)
        {
            db.InsertSample(new Sample { EndpointId = a, TimestampUtc = T0.AddMinutes(-60 + i), Status = HealthStatus.Up, TcpOk = true });
            db.InsertSample(new Sample { EndpointId = b, TimestampUtc = T0.AddMinutes(-120 + i), Status = HealthStatus.Warn, TcpOk = true });
        }
        // 시계가 거꾸로 간 뒤의 늦은 저장(ts 가 더 이르다)은 최신이 아니다 — 기준은 저장 순서가 아니라 ts.
        db.InsertSample(new Sample { EndpointId = a, TimestampUtc = T0.AddMinutes(-500), Status = HealthStatus.Down });
        // 같은 ts 두 건이면 나중에 저장한 것.
        db.InsertSample(new Sample { EndpointId = b, TimestampUtc = T0, Status = HealthStatus.Up, TcpOk = true, Error = "first" });
        db.InsertSample(new Sample { EndpointId = b, TimestampUtc = T0, Status = HealthStatus.Down, Error = "second" });

        var m = db.LatestByEndpoint();
        Assert.Equal(2, m.Count);
        Assert.False(m.ContainsKey(c));
        Assert.Equal(T0.AddMinutes(-11), m[a].TimestampUtc);
        Assert.Equal(HealthStatus.Up, m[a].Status);
        Assert.Equal(T0, m[b].TimestampUtc);
        Assert.Equal("second", m[b].Error);
    }

    [Fact]
    public void 대상별_최신_조회는_GROUP_BY_MAX_로_만들지_않는다()
    {
        // 루트 규칙: '키별 최신값' 을 GROUP BY + MAX(ts) 로 만들지 말 것 — SQLite 가 인덱스 전체를 훑는다(630만 행 약 0.5초).
        var src = File.ReadAllText(Path.Combine(SrcDir(), "..", "Database.cs"));
        var start = src.IndexOf("public Dictionary<long, Sample> LatestByEndpoint()", StringComparison.Ordinal);
        Assert.True(start > 0);
        var end = src.IndexOf("public List<Sample> RecentSamples(", start, StringComparison.Ordinal);
        var body = src.Substring(start, end - start);
        var code = string.Join("\n", body.Split('\n').Where(l => !l.TrimStart().StartsWith("//")));
        Assert.DoesNotContain("GROUP BY", code);
        Assert.Contains("ORDER BY x.ts DESC", code);
        Assert.Contains("LIMIT 1", code);
    }

    private static string SrcDir([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;

    [Fact]
    public void 스냅샷은_DB_가_그대로면_나눠_쓰고_쓰기_한_건에도_다시_읽는다()
    {
        using var db = new Database(DataLocation.DbPathIn(Dir("snap")));
        var id = db.UpsertEndpoint(new Endpoint { Name = "A", Host = "a" });
        using var mon = new MonitorService(db);
        var s1 = mon.Snapshot();
        var s2 = mon.Snapshot();
        Assert.NotSame(s1, s2);                       // 호출마다 새 목록(호출자가 정렬해도 서로 영향 없음)
        Assert.Same(s1[0], s2[0]);                    // 내용은 공유(같은 조회를 두 번 하지 않는다)
        Assert.Null(s2[0].Latest);

        var st0 = db.ChangeStamp();
        db.InsertSample(new Sample { EndpointId = id, TimestampUtc = T0, Status = HealthStatus.Warn });
        Assert.NotEqual(st0, db.ChangeStamp());
        var s3 = mon.Snapshot();
        Assert.Equal(HealthStatus.Warn, s3[0].Status);

        db.UpsertEndpoint(new Endpoint { Id = id, Name = "A2", Host = "a" });
        Assert.Equal("A2", mon.Snapshot()[0].Endpoint.Name);
        db.DeleteEndpoint(id);
        Assert.Empty(mon.Snapshot());
    }

    [Fact]
    public void 다른_DB_로_전환하면_스냅샷을_다시_읽는다()
    {
        var other = DataLocation.DbPathIn(Dir("other"));
        using (var o = new Database(other))
        {
            o.UpsertEndpoint(new Endpoint { Name = "OTHER", Host = "o" });
        }
        SqliteConnection.ClearAllPools();
        using var db = new Database(DataLocation.DbPathIn(Dir("main")));
        db.UpsertEndpoint(new Endpoint { Name = "MAIN", Host = "m" });
        using var mon = new MonitorService(db);
        Assert.Equal("MAIN", mon.Snapshot()[0].Endpoint.Name);
        db.SwitchTo(other, () => { });
        Assert.Equal("OTHER", mon.Snapshot()[0].Endpoint.Name);
    }
}
