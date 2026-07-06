using System.Collections.Generic;

namespace HorizonUagMonitor;

/// <summary>
/// 최초 실행 시(대상이 하나도 없을 때) 시드하는 12개 데이터센터 기본 목록.
/// host는 자리표시자이므로 '설정'에서 실제 UAG/Virtual App 포탈 주소로 수정한다.
/// </summary>
public static class DefaultEndpoints
{
    // (표시이름, 데이터센터, 자리표시자 호스트)
    private static readonly (string Name, string Dc, string Host)[] Sites =
    {
        ("OC1 UAG",  "OC1 · 아시아",  "uag-oc1.example.com"),
        ("OC2 UAG",  "OC2 · 아시아",  "uag-oc2.example.com"),
        ("NJ UAG",   "NJ · 북미",     "uag-nj.example.com"),
        ("MI UAG",   "MI · 북미",     "uag-mi.example.com"),
        ("WA UAG",   "WA · 유럽",     "uag-wa.example.com"),
        ("AZ UAG",   "AZ · 북미",     "uag-az.example.com"),
        ("HD UAG",   "HD · 남미",     "uag-hd.example.com"),
        ("GM1 UAG",  "GM1 · 아시아",  "uag-gm1.example.com"),
        ("GM2 UAG",  "GM2 · 아시아",  "uag-gm2.example.com"),
        ("ST UAG",   "ST · 아시아",   "uag-st.example.com"),
        ("HM UAG",   "HM · 아시아",   "uag-hm.example.com"),
        ("NA UAG",   "NA · 아시아",   "uag-na.example.com"),
    };

    public static void SeedIfEmpty(Database db)
    {
        if (db.CountEndpoints() > 0) return;
        var sort = 0;
        foreach (var s in Sites)
        {
            db.UpsertEndpoint(new Endpoint
            {
                Name = s.Name,
                Datacenter = s.Dc,
                Host = s.Host,
                Port = 443,
                Path = "/",
                IntervalSec = 60,
                TimeoutMs = 5000,
                Enabled = false, // 자리표시자이므로 기본 비활성 — 실제 주소로 수정 후 활성화
                Sort = sort++,
            });
        }
    }

    public static IReadOnlyList<Endpoint> Build()
    {
        var list = new List<Endpoint>();
        var sort = 0;
        foreach (var s in Sites)
            list.Add(new Endpoint { Name = s.Name, Datacenter = s.Dc, Host = s.Host, Port = 443, Path = "/", IntervalSec = 60, TimeoutMs = 5000, Enabled = false, Sort = sort++ });
        return list;
    }
}
