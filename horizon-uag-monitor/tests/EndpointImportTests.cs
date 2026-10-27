using System.Text.Json;
using Microsoft.Data.Sqlite;
using Xunit;

namespace HorizonUagMonitor.Tests;

/// <summary>
/// v2.768(점검 R3-C3-2) 회귀 고정 — 설정 화면 [JSON 가져오기](EndpointImport.Build):
/// ① 갱신은 기존 레코드에 파일에 있는 칸만 덮는다(sort 는 파일값 또는 유지, enabled 등 빠진 칸은 유지)
/// ② 한 파일 안의 같은 키는 한 번만 반영 ③ DB 에 같은 키가 둘 있어도 예외 없이 동작
/// </summary>
public class EndpointImportTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "uagmon-import-" + Guid.NewGuid().ToString("N"));

    public EndpointImportTests() { Directory.CreateDirectory(_dir); }
    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_dir, true); } catch { /* 윈도우에서 잠금이 늦게 풀릴 수 있다 */ }
    }

    private static EndpointImport.Plan Build(string json, IReadOnlyList<Endpoint> existing)
    {
        using var doc = JsonDocument.Parse(json);
        return EndpointImport.Build(doc.RootElement, existing);
    }

    private static Endpoint Ep(long id, string name, int sort, bool enabled = true, string dc = "DC") => new()
    {
        Id = id, Name = name, Host = name.ToLowerInvariant() + ".corp", Port = 443, Sort = sort, Enabled = enabled,
        Datacenter = dc, City = "Seoul", Lat = 37.5, Lon = 127.0, MatchText = "Horizon", IntervalSec = 30, TimeoutMs = 3000,
    };

    [Fact]
    public void Update_keeps_sort_and_fields_missing_from_file()
    {
        var existing = new List<Endpoint> { Ep(1, "DC0", 0), Ep(2, "DC1", 1), Ep(3, "DC2", 2), Ep(4, "DC3", 3, enabled: false) };
        // 손으로 줄인 파일 — name·host 만 있다(sort·enabled·datacenter·좌표 없음).
        var plan = Build("""[{"name":"DC3","host":"dc3.corp"}]""", existing);
        Assert.Equal((0, 1), (plan.Added, plan.Updated));
        var e = Assert.Single(plan.Upserts);
        Assert.Equal(4, e.Id);
        Assert.Equal(3, e.Sort);                  // 예전: 0 으로 덮여 목록 맨 위로 튀었다
        Assert.False(e.Enabled);                  // 예전: 꺼 둔 대상이 다시 켜졌다
        Assert.Equal(("DC", "Seoul", 37.5, 127.0, "Horizon", 30, 3000),
            (e.Datacenter, e.City, e.Lat, e.Lon, e.MatchText, e.IntervalSec, e.TimeoutMs));
        Assert.Equal(3, existing[3].Sort);        // 입력 목록은 바꾸지 않는다
    }

    [Fact]
    public void Update_takes_sort_and_fields_present_in_file()
    {
        var existing = new List<Endpoint> { Ep(1, "A", 0), Ep(2, "B", 1) };
        var plan = Build("""[{"name":"B","host":"b.corp","port":443,"sort":7,"enabled":false,"datacenter":"NEW","intervalSec":1}]""", existing);
        var e = Assert.Single(plan.Upserts);
        Assert.Equal((2L, 7, false, "NEW", 5), (e.Id, e.Sort, e.Enabled, e.Datacenter, e.IntervalSec));
        Assert.Equal("Seoul", e.City);
    }

    [Fact]
    public void New_entries_append_after_max_sort_with_defaults()
    {
        var existing = new List<Endpoint> { Ep(1, "A", 0), Ep(2, "B", 9) };
        var plan = Build("""[{"host":"n1.corp"},{"name":"N2","host":"n2.corp","port":99999,"enabled":false}]""", existing);
        Assert.Equal((2, 0), (plan.Added, plan.Updated));
        Assert.All(plan.Upserts, x => Assert.Equal(0, x.Id));
        Assert.Equal(new[] { 10, 11 }, plan.Upserts.Select(x => x.Sort).ToArray());
        Assert.Equal(("n1.corp", 443, true, 60, 5000, "/", "https"),
            (plan.Upserts[0].Name, plan.Upserts[0].Port, plan.Upserts[0].Enabled, plan.Upserts[0].IntervalSec,
             plan.Upserts[0].TimeoutMs, plan.Upserts[0].Path, plan.Upserts[0].Scheme));
        Assert.Equal((443, false), (plan.Upserts[1].Port, plan.Upserts[1].Enabled));
    }

    [Fact]
    public void Same_key_twice_in_file_is_applied_once()
    {
        var plan = Build("""[{"name":"NEW","host":"new.corp","port":443,"city":"first"},{"name":"new","host":"NEW.corp","city":"second"}]""",
            new List<Endpoint>());
        Assert.Equal((1, 0, 1), (plan.Added, plan.Updated, plan.DuplicatesInFile));
        Assert.Equal("first", Assert.Single(plan.Upserts).City);
    }

    [Fact]
    public void Duplicate_keys_in_db_do_not_throw()
    {
        var existing = new List<Endpoint> { Ep(1, "NEW", 0), Ep(2, "NEW", 1) };   // 예전: ToDictionary ArgumentException
        var plan = Build("""[{"name":"NEW","host":"new.corp","city":"X"}]""", existing);
        var e = Assert.Single(plan.Upserts);
        Assert.Equal((1L, "X"), (e.Id, e.City));   // 정렬 순서상 첫 행을 갱신
    }

    [Fact]
    public void Non_array_root_is_rejected()
    {
        Assert.Throws<ArgumentException>(() => Build("""{"host":"x"}""", new List<Endpoint>()));
    }

    [Fact]
    public void Real_database_order_is_kept_after_reimport()
    {
        using var db = new Database(Path.Combine(_dir, "m.db"));
        for (var i = 0; i < 4; i++) db.UpsertEndpoint(new Endpoint { Name = $"DC{i}", Host = $"dc{i}.corp", Sort = i, Datacenter = "Z" });
        // 내보낸 파일에서 DC3 한 건만 다시 가져온다(sort 칸 없음).
        var plan = Build("""[{"name":"DC3","host":"dc3.corp","port":443}]""", db.ListEndpoints());
        foreach (var e in plan.Upserts) db.UpsertEndpoint(e);
        Assert.Equal(new[] { "DC0", "DC1", "DC2", "DC3" }, db.ListEndpoints().Select(x => x.Name).ToArray());
        // 같은 키 2행 파일 → 1건만 추가, 그다음 가져오기도 실패하지 않는다.
        plan = Build("""[{"name":"N","host":"n.corp"},{"name":"N","host":"n.corp"}]""", db.ListEndpoints());
        foreach (var e in plan.Upserts) db.UpsertEndpoint(e);
        Assert.Equal(1, db.ListEndpoints().Count(x => x.Name == "N"));
        plan = Build("""[{"name":"N","host":"n.corp","city":"Busan"}]""", db.ListEndpoints());
        Assert.Equal(1, plan.Updated);
    }
}
