using Microsoft.Data.Sqlite;
using Xunit;

namespace HorizonUagMonitor.Tests;

public class DataMigrationTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "uagmon-mig-" + Guid.NewGuid().ToString("N"));
    private string Dir(string name) { var d = Path.Combine(_root, name); Directory.CreateDirectory(d); return d; }
    private DataLocation Loc() => new(Dir("base"));

    public DataMigrationTests() { Directory.CreateDirectory(_root); }
    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, true); } catch { /* 윈도우에서 잠금이 늦게 풀릴 수 있다 */ }
    }

    private static Database Seed(string dir, int samples = 500)
    {
        var db = new Database(DataLocation.DbPathIn(dir));
        var id = db.UpsertEndpoint(new Endpoint { Name = "OC2 UAG", Host = "h", Datacenter = "OC2" });
        db.SetSetting("certWarnDays", "45");
        var t = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
        for (int i = 0; i < samples; i++)
            db.InsertSample(new Sample { EndpointId = id, TimestampUtc = t.AddSeconds(i), Status = HealthStatus.Up, TcpOk = true, TlsOk = true, ConnectMs = i });
        return db;
    }

    private static long Count(string dbFile, string table)
    {
        using var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = dbFile, Pooling = false, Mode = SqliteOpenMode.ReadOnly }.ToString());
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM {table}";
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    // ── 폴더 위치 기록 ───────────────────────────────────────────────────────
    [Fact]
    public void 위치_파일이_없으면_기본_폴더()
    {
        var loc = Loc();
        Assert.Equal(loc.BaseDir, loc.ResolveDataDir());
        Assert.False(loc.IsCustom);
    }

    [Fact]
    public void 위치를_저장하고_다시_읽는다()
    {
        var loc = Loc(); var target = Dir("custom");
        loc.SaveDataDir(target);
        Assert.Equal(target, loc.ResolveDataDir());
        Assert.True(loc.IsCustom);
        loc.SaveDataDir(loc.BaseDir); // 기본 폴더로 되돌리면 파일을 지운다
        Assert.False(File.Exists(loc.BootstrapPath));
        Assert.Equal(loc.BaseDir, loc.ResolveDataDir());
    }

    [Theory]
    [InlineData("{ 깨진 json")]
    [InlineData("{\"dataDir\": \"relative/path\"}")]
    [InlineData("{\"dataDir\": 5}")]
    [InlineData("[]")]
    public void 위치_파일이_깨지면_기본_폴더로_연다(string content)
    {
        var loc = Loc();
        File.WriteAllText(loc.BootstrapPath, content);
        Assert.Equal(loc.BaseDir, loc.ResolveDataDir());
    }

    [Fact]
    public void 시작할_때_지정_폴더를_못_쓰면_기본_폴더와_경고를_준다()
    {
        var loc = Loc();
        var blocker = Path.Combine(_root, "blocker"); File.WriteAllText(blocker, "파일");
        File.WriteAllText(loc.BootstrapPath, $"{{\"dataDir\": {System.Text.Json.JsonSerializer.Serialize(Path.Combine(blocker, "sub"))}}}");
        var dir = loc.ResolveForStartup(out var warn);
        Assert.Equal(loc.BaseDir, dir);
        Assert.NotNull(warn);
        Assert.True(File.Exists(loc.BootstrapPath), "지정 값은 지우지 않는다(연결이 돌아오면 다시 쓴다)");
    }

    // ── 사전 점검 ────────────────────────────────────────────────────────────
    [Fact]
    public void 사전_점검의_거부_사유()
    {
        using var db = Seed(Dir("old"), 3);
        Assert.Equal(TargetState.Invalid, DataMigrator.Check(db.DbPath, "상대경로\\폴더").State);
        Assert.Equal(TargetState.Invalid, DataMigrator.Check(db.DbPath, "  ").State);
        Assert.Equal(TargetState.SameAsCurrent, DataMigrator.Check(db.DbPath, Path.GetDirectoryName(db.DbPath)!).State);
        var blocker = Path.Combine(_root, "f"); File.WriteAllText(blocker, "x");
        Assert.Equal(TargetState.NotWritable, DataMigrator.Check(db.DbPath, Path.Combine(blocker, "x")).State);
        Assert.Equal(TargetState.Ok, DataMigrator.Check(db.DbPath, Path.Combine(_root, "new")).State);
    }

    [Fact]
    public void 대상_폴더에_이미_DB가_있으면_알려_준다()
    {
        using var db = Seed(Dir("old"), 3);
        using (Seed(Dir("target"), 1)) { }
        Assert.Equal(TargetState.HasExistingDb, DataMigrator.Check(db.DbPath, Path.Combine(_root, "target")).State);
    }

    // ── 이동 ────────────────────────────────────────────────────────────────
    [Fact]
    public void 이동하면_데이터가_그대로_새_폴더로_가고_예전_파일은_지워진다()
    {
        var loc = Loc(); var oldDir = Dir("old"); var newDir = Path.Combine(_root, "new");
        using var db = Seed(oldDir, 500);
        File.WriteAllText(Path.Combine(oldDir, AppLog.ErrorFile), "오류 기록");
        File.WriteAllText(Path.Combine(oldDir, AppLog.AlarmFile), "알람 기록");
        var oldDb = db.DbPath;

        var r = DataMigrator.Migrate(db, loc, newDir);

        Assert.True(r.Ok, r.Message);
        var newDb = DataLocation.DbPathIn(newDir);
        Assert.Equal(newDb, db.DbPath);
        Assert.Equal(500, Count(newDb, "samples"));
        Assert.Equal(1, Count(newDb, "endpoints"));
        Assert.Equal("45", db.GetSetting("certWarnDays"));
        Assert.Equal(newDir, loc.ResolveDataDir());
        Assert.False(File.Exists(oldDb));
        Assert.False(File.Exists(oldDb + "-wal"));
        Assert.False(File.Exists(Path.Combine(oldDir, AppLog.ErrorFile)));
        Assert.Equal("오류 기록", File.ReadAllText(Path.Combine(newDir, AppLog.ErrorFile)));
        Assert.Equal("알람 기록", File.ReadAllText(Path.Combine(newDir, AppLog.AlarmFile)));
        Assert.False(File.Exists(newDb + ".migrating"));
        // 이동 뒤에도 같은 Database 객체로 계속 쓸 수 있다.
        db.InsertSample(new Sample { EndpointId = 1, TimestampUtc = DateTime.UtcNow, Status = HealthStatus.Warn });
        Assert.Equal(501, Count(newDb, "samples"));
    }

    [Fact]
    public void 이동하는_동안_쌓인_점검_결과도_빠짐없이_옮겨진다()
    {
        var loc = Loc(); var newDir = Path.Combine(_root, "new");
        using var db = Seed(Dir("old"), 20000);
        long inserted = 0; var stop = false; var lastId = 1L;
        var writer = new Thread(() =>
        {
            while (!Volatile.Read(ref stop))
            {
                db.InsertSample(new Sample { EndpointId = lastId, TimestampUtc = DateTime.UtcNow, Status = HealthStatus.Up, TcpOk = true });
                Interlocked.Increment(ref inserted);
            }
        });
        writer.Start();
        Thread.Sleep(100);
        var r = DataMigrator.Migrate(db, loc, newDir);
        Thread.Sleep(100);
        Volatile.Write(ref stop, true); writer.Join();

        Assert.True(r.Ok, r.Message);
        Assert.True(Interlocked.Read(ref inserted) > 0);
        // 전환 전에 들어간 것도, 전환 뒤에 들어간 것도 새 DB 에 모두 있다.
        Assert.Equal(20000 + Interlocked.Read(ref inserted), Count(DataLocation.DbPathIn(newDir), "samples"));
    }

    [Fact]
    public void 대상이_쓸_수_없으면_아무것도_바꾸지_않는다()
    {
        var loc = Loc(); var oldDir = Dir("old");
        using var db = Seed(oldDir, 10);
        var blocker = Path.Combine(_root, "f"); File.WriteAllText(blocker, "x");
        var r = DataMigrator.Migrate(db, loc, Path.Combine(blocker, "x"));
        Assert.False(r.Ok);
        Assert.Equal(DataLocation.DbPathIn(oldDir), db.DbPath);
        Assert.True(File.Exists(db.DbPath));
        Assert.False(File.Exists(loc.BootstrapPath));
        Assert.Equal(10, Count(db.DbPath, "samples"));
    }

    [Fact]
    public void 위치_기록이_실패하면_예전_DB를_그대로_쓰고_만든_파일을_지운다()
    {
        // 위치 파일이 놓일 자리(BaseDir)를 '파일'로 막아 SaveDataDir 이 실패하게 한다.
        var blocked = Path.Combine(_root, "blockedbase"); File.WriteAllText(blocked, "x");
        var loc = new DataLocation(blocked);
        var oldDir = Dir("old"); var newDir = Path.Combine(_root, "new");
        using var db = Seed(oldDir, 50);
        var r = DataMigrator.Migrate(db, loc, newDir);
        Assert.False(r.Ok);
        Assert.Equal(DataLocation.DbPathIn(oldDir), db.DbPath);
        Assert.Equal(50, Count(db.DbPath, "samples"));
        Assert.False(File.Exists(DataLocation.DbPathIn(newDir)), "새 폴더에 반쯤 만든 DB 가 남으면 안 된다");
        Assert.False(File.Exists(DataLocation.DbPathIn(newDir) + ".migrating"));
        db.InsertSample(new Sample { EndpointId = 1, TimestampUtc = DateTime.UtcNow }); // 아직 쓸 수 있다
    }

    [Fact]
    public void 대상에_기존_DB가_있으면_기본은_거부하고_덮어쓰지_않는다()
    {
        var loc = Loc(); var oldDir = Dir("old"); var tgt = Dir("target");
        using var db = Seed(oldDir, 10);
        using (var other = Seed(tgt, 7)) { }
        var before = File.ReadAllBytes(DataLocation.DbPathIn(tgt)).Length;
        var r = DataMigrator.Migrate(db, loc, tgt);
        Assert.False(r.Ok);
        Assert.Equal(before, File.ReadAllBytes(DataLocation.DbPathIn(tgt)).Length);
        Assert.Equal(DataLocation.DbPathIn(oldDir), db.DbPath);
    }

    [Fact]
    public void 대상의_기존_DB로_전환하면_예전_폴더는_그대로_남는다()
    {
        var loc = Loc(); var oldDir = Dir("old"); var tgt = Dir("target");
        using var db = Seed(oldDir, 10);
        using (Seed(tgt, 7)) { }
        var r = DataMigrator.Migrate(db, loc, tgt, useExistingTargetDb: true);
        Assert.True(r.Ok, r.Message);
        Assert.Equal(DataLocation.DbPathIn(tgt), db.DbPath);
        Assert.True(File.Exists(DataLocation.DbPathIn(oldDir)), "예전 데이터는 지우지 않는다");
        Assert.Equal(10, Count(DataLocation.DbPathIn(oldDir), "samples"));
        Assert.Equal(tgt, loc.ResolveDataDir());
        Assert.NotEmpty(r.Notes);
    }

    [Fact]
    public void 이동한_뒤_다시_원래_폴더로도_옮길_수_있다()
    {
        var loc = Loc(); var a = Dir("a"); var b = Path.Combine(_root, "b");
        using var db = Seed(a, 100);
        Assert.True(DataMigrator.Migrate(db, loc, b).Ok);
        Assert.True(DataMigrator.Migrate(db, loc, a).Ok);
        Assert.Equal(100, Count(DataLocation.DbPathIn(a), "samples"));
        Assert.False(File.Exists(DataLocation.DbPathIn(b)));
    }

    [Fact]
    public void 진행_메시지를_보고한다()
    {
        var loc = Loc();
        using var db = Seed(Dir("old"), 5);
        var msgs = new List<string>();
        DataMigrator.Migrate(db, loc, Path.Combine(_root, "new"), progress: msgs.Add);
        Assert.True(msgs.Count >= 3);
    }
}
