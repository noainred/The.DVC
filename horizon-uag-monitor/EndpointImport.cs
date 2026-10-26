using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace HorizonUagMonitor;

/// <summary>
/// 설정 화면 [JSON 가져오기]의 판정(화면·DB 와 무관한 순수 부분) — v2.768(점검 R3-C3-2). 테스트로 고정한다.
/// 예전 ImportJson 결함 세 가지를 막는다:
/// ① 갱신 대상을 새 Endpoint(Sort=0·기본값)로 덮어 정렬이 맨 위로 튀고, 파일에 없는 칸(enabled·datacenter·좌표·matchText)이
///    기본값으로 지워졌다(꺼 둔 대상이 다시 켜짐) → 갱신은 **기존 레코드에 파일에 있는 칸만** 덮는다. sort 는 파일에 있으면 그 값, 없으면 유지.
/// ② 한 파일 안의 같은 키(name|host|port)가 둘 다 추가됐다 → 파일 안에서 키는 처음 한 번만 쓴다.
/// ③ DB 에 같은 키가 둘 있으면 ToDictionary 예외로 이후 가져오기가 전부 실패했다 → GroupBy 로 견딘다(정렬 순서상 첫 행을 갱신).
/// </summary>
public static class EndpointImport
{
    public sealed record Plan(IReadOnlyList<Endpoint> Upserts, int Added, int Updated, int DuplicatesInFile);

    public static string Key(Endpoint e) => KeyOf(e.Name, e.Host, e.Port);
    private static string KeyOf(string name, string host, int port) => $"{name}|{host}|{port}".ToLowerInvariant();

    public static int ClampPort(int p) => p is >= 1 and <= 65535 ? p : 443;
    public static string NormPath(string p) => string.IsNullOrWhiteSpace(p) ? "/" : p;

    /// <summary>
    /// 파일(최상위 배열) + 현재 대상 목록 → 저장할 Endpoint 목록. 갱신 항목은 기존 Id 를, 추가 항목은 Id=0 을 갖는다.
    /// existing 은 DB 정렬 순서(ORDER BY sort, …)로 준다. 입력 목록의 객체는 바꾸지 않는다(복사본을 돌려준다).
    /// </summary>
    public static Plan Build(JsonElement root, IReadOnlyList<Endpoint> existing)
    {
        if (root.ValueKind != JsonValueKind.Array) throw new ArgumentException("JSON 최상위가 배열이어야 합니다.");
        var byKey = existing.GroupBy(Key).ToDictionary(g => g.Key, g => g.First());
        var nextSort = existing.Count == 0 ? 0 : existing.Max(x => x.Sort) + 1;
        var seen = new HashSet<string>();
        var upserts = new List<Endpoint>();
        int added = 0, updated = 0, dup = 0;

        foreach (var o in root.EnumerateArray())
        {
            if (o.ValueKind != JsonValueKind.Object) continue;
            var host = Str(o, "host");
            if (string.IsNullOrWhiteSpace(host)) continue;
            var nameInFile = Str(o, "name");
            var name = string.IsNullOrWhiteSpace(nameInFile) ? host : nameInFile;
            var port = TryInt(o, "port", out var pv) ? ClampPort(pv) : 443;
            var key = KeyOf(name, host, port);
            if (!seen.Add(key)) { dup++; continue; }

            Endpoint e;
            if (byKey.TryGetValue(key, out var cur))
            {
                e = Copy(cur);
                ApplyPresent(o, e);
                if (TryInt(o, "sort", out var so)) e.Sort = so;
                updated++;
            }
            else
            {
                e = new Endpoint { Name = name, Host = host, Port = port };
                ApplyPresent(o, e);   // name·host·port 는 위에서 정한 키 값과 같다
                e.Id = 0;
                e.Sort = nextSort++;
                added++;
            }
            upserts.Add(e);
        }
        return new Plan(upserts, added, updated, dup);
    }

    /// <summary>파일에 있고 형식이 맞는 칸만 덮는다(없거나 형식이 틀린 칸은 대상의 현재 값 유지).</summary>
    private static void ApplyPresent(JsonElement o, Endpoint e)
    {
        if (TryStr(o, "name", out var name) && !string.IsNullOrWhiteSpace(name)) e.Name = name;
        if (TryStr(o, "host", out var host) && !string.IsNullOrWhiteSpace(host)) e.Host = host;
        if (TryInt(o, "port", out var port)) e.Port = ClampPort(port);
        if (TryStr(o, "type", out var type)) e.Type = type;
        if (TryStr(o, "datacenter", out var dc)) e.Datacenter = dc;
        if (TryStr(o, "scheme", out var scheme))
            e.Scheme = string.Equals(scheme, "http", StringComparison.OrdinalIgnoreCase) ? "http" : "https";
        if (TryStr(o, "path", out var path)) e.Path = NormPath(path);
        if (TryStr(o, "matchText", out var mt)) e.MatchText = mt;
        if (TryStr(o, "city", out var city)) e.City = city;
        if (TryStr(o, "region", out var region)) e.Region = region;
        if (TryDbl(o, "lat", out var lat)) e.Lat = lat;
        if (TryDbl(o, "lon", out var lon)) e.Lon = lon;
        if (TryInt(o, "intervalSec", out var iv)) e.IntervalSec = Math.Max(5, iv);
        if (TryInt(o, "timeoutMs", out var to)) e.TimeoutMs = Math.Max(1000, to);
        if (TryProp(o, "enabled", out var en) && (en.ValueKind == JsonValueKind.True || en.ValueKind == JsonValueKind.False))
            e.Enabled = en.ValueKind == JsonValueKind.True;
    }

    private static Endpoint Copy(Endpoint s) => new()
    {
        Id = s.Id, Name = s.Name, Datacenter = s.Datacenter, Host = s.Host, Port = s.Port, Path = s.Path,
        IntervalSec = s.IntervalSec, TimeoutMs = s.TimeoutMs, Enabled = s.Enabled, Sort = s.Sort, Type = s.Type,
        Scheme = s.Scheme, MatchText = s.MatchText, Lat = s.Lat, Lon = s.Lon, Region = s.Region, City = s.City,
    };

    // JsonElement 에서 대소문자 무시로 값 읽기(수동 파싱, 리플렉션 불필요).
    private static bool TryProp(JsonElement o, string name, out JsonElement v)
    {
        foreach (var p in o.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) { v = p.Value; return true; }
        v = default; return false;
    }
    private static string Str(JsonElement o, string name) => TryStr(o, name, out var s) ? s : "";
    private static bool TryStr(JsonElement o, string name, out string s)
    {
        s = "";
        if (!TryProp(o, name, out var v) || v.ValueKind != JsonValueKind.String) return false;
        s = v.GetString() ?? "";
        return true;
    }
    private static bool TryInt(JsonElement o, string name, out int n)
    {
        n = 0;
        return TryProp(o, name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out n);
    }
    private static bool TryDbl(JsonElement o, string name, out double d)
    {
        d = 0;
        return TryProp(o, name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out d);
    }
}
