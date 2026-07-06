using System.Collections.Generic;

namespace HorizonUagMonitor;

/// <summary>
/// 최초 실행 시(대상이 하나도 없을 때) 시드하는 12개 데이터센터 기본 목록.
/// host는 자리표시자이므로 '설정'에서 실제 UAG/Virtual App 포탈 주소로 수정한다.
/// 위경도/리전은 세계지도 표시용 기본값(실제 사이트에 맞게 조정 가능).
/// </summary>
public static class DefaultEndpoints
{
    // (코드, 리전, 위도, 경도, 자리표시자 호스트)
    private static readonly (string Code, string Region, double Lat, double Lon, string Host)[] Sites =
    {
        ("OC1", "아시아 태평양", 37.51, 127.02, "uag-oc1.example.com"),
        ("OC2", "아시아 태평양", 37.40, 127.11, "uag-oc2.example.com"),
        ("GM1", "아시아 태평양", 31.23, 121.47, "uag-gm1.example.com"),
        ("GM2", "아시아 태평양", 39.90, 116.40, "uag-gm2.example.com"),
        ("HD",  "아시아 태평양", 17.38,  78.48, "uag-hd.example.com"),
        ("WA",  "유럽",         52.23,  21.01, "uag-wa.example.com"),
        ("NJ",  "북미",         40.73, -74.17, "uag-nj.example.com"),
        ("MI",  "북미",         42.73, -84.55, "uag-mi.example.com"),
        ("AZ",  "북미",         33.45, -112.07, "uag-az.example.com"),
        ("ST",  "북미",         33.75, -84.39, "uag-st.example.com"),
        ("HM",  "북미",         35.23, -80.84, "uag-hm.example.com"),
        ("NA",  "북미",         36.07, -79.79, "uag-na.example.com"),
    };

    public static void SeedIfEmpty(Database db)
    {
        if (db.CountEndpoints() > 0) return;
        var sort = 0;
        foreach (var e in Build()) { e.Sort = sort++; db.UpsertEndpoint(e); }
    }

    public static IReadOnlyList<Endpoint> Build()
    {
        var list = new List<Endpoint>();
        var sort = 0;
        foreach (var s in Sites)
            list.Add(new Endpoint
            {
                Name = $"{s.Code} UAG", Datacenter = s.Code, Region = s.Region,
                Host = s.Host, Port = 443, Path = "/", Scheme = "https", Type = "UAG",
                Lat = s.Lat, Lon = s.Lon, IntervalSec = 60, TimeoutMs = 5000,
                Enabled = false, // 자리표시자 → 실제 주소로 수정 후 활성화
                Sort = sort++,
            });
        return list;
    }
}
