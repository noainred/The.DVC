using System;
using System.Collections.Generic;

namespace HorizonUagMonitor;

/// <summary>
/// 오프라인 도시 → 좌표 사전(폐쇄망 대비, 인터넷 지오코딩 불필요). 주요 도시/데이터센터 허브 위주.
/// 영문·한글 이름 모두 매칭(소문자·공백 무시). 없는 도시는 위경도 직접 입력.
/// </summary>
public static class CityGeo
{
    public readonly record struct Geo(double Lat, double Lon, string Region);

    // (도시, 위도, 경도, 리전) — 필요 시 추가 가능.
    private static readonly (string[] Names, double Lat, double Lon, string Region)[] Cities =
    {
        (new[]{"seoul","서울"}, 37.5665, 126.9780, "아시아 태평양"),
        (new[]{"incheon","인천"}, 37.4563, 126.7052, "아시아 태평양"),
        (new[]{"busan","부산"}, 35.1796, 129.0756, "아시아 태평양"),
        (new[]{"pyeongtaek","평택"}, 36.9920, 127.1127, "아시아 태평양"),
        (new[]{"cheongju","청주"}, 36.6424, 127.4890, "아시아 태평양"),
        (new[]{"tokyo","도쿄","동경"}, 35.6762, 139.6503, "아시아 태평양"),
        (new[]{"osaka","오사카"}, 34.6937, 135.5023, "아시아 태평양"),
        (new[]{"shanghai","상하이","상해"}, 31.2304, 121.4737, "아시아 태평양"),
        (new[]{"beijing","베이징","북경"}, 39.9042, 116.4074, "아시아 태평양"),
        (new[]{"shenzhen","선전","심천"}, 22.5431, 114.0579, "아시아 태평양"),
        (new[]{"guangzhou","광저우"}, 23.1291, 113.2644, "아시아 태평양"),
        (new[]{"nanjing","난징"}, 32.0603, 118.7969, "아시아 태평양"),
        (new[]{"hong kong","hongkong","홍콩"}, 22.3193, 114.1694, "아시아 태평양"),
        (new[]{"taipei","타이베이","타이페이"}, 25.0330, 121.5654, "아시아 태평양"),
        (new[]{"singapore","싱가포르"}, 1.3521, 103.8198, "아시아 태평양"),
        (new[]{"kuala lumpur","쿠알라룸푸르"}, 3.1390, 101.6869, "아시아 태평양"),
        (new[]{"jakarta","자카르타"}, -6.2088, 106.8456, "아시아 태평양"),
        (new[]{"bangkok","방콕"}, 13.7563, 100.5018, "아시아 태평양"),
        (new[]{"hanoi","하노이"}, 21.0278, 105.8342, "아시아 태평양"),
        (new[]{"ho chi minh","호치민"}, 10.8231, 106.6297, "아시아 태평양"),
        (new[]{"manila","마닐라"}, 14.5995, 120.9842, "아시아 태평양"),
        (new[]{"mumbai","뭄바이"}, 19.0760, 72.8777, "아시아 태평양"),
        (new[]{"delhi","new delhi","델리","뉴델리"}, 28.6139, 77.2090, "아시아 태평양"),
        (new[]{"bangalore","bengaluru","방갈로르","벵갈루루"}, 12.9716, 77.5946, "아시아 태평양"),
        (new[]{"hyderabad","하이데라바드"}, 17.3850, 78.4867, "아시아 태평양"),
        (new[]{"chennai","첸나이"}, 13.0827, 80.2707, "아시아 태평양"),
        (new[]{"pune","푸네"}, 18.5204, 73.8567, "아시아 태평양"),
        (new[]{"sydney","시드니"}, -33.8688, 151.2093, "아시아 태평양"),
        (new[]{"melbourne","멜버른"}, -37.8136, 144.9631, "아시아 태평양"),
        (new[]{"auckland","오클랜드"}, -36.8485, 174.7633, "아시아 태평양"),

        (new[]{"new york","뉴욕","newyork"}, 40.7128, -74.0060, "북미"),
        (new[]{"newark","new jersey","뉴저지","뉴어크"}, 40.7357, -74.1724, "북미"),
        (new[]{"ashburn","애쉬번"}, 39.0438, -77.4874, "북미"),
        (new[]{"washington","워싱턴"}, 38.9072, -77.0369, "북미"),
        (new[]{"boston","보스턴"}, 42.3601, -71.0589, "북미"),
        (new[]{"chicago","시카고"}, 41.8781, -87.6298, "북미"),
        (new[]{"detroit","디트로이트"}, 42.3314, -83.0458, "북미"),
        (new[]{"michigan","미시간"}, 42.7325, -84.5555, "북미"),
        (new[]{"atlanta","애틀랜타"}, 33.7490, -84.3880, "북미"),
        (new[]{"charlotte","샬럿"}, 35.2271, -80.8431, "북미"),
        (new[]{"dallas","댈러스"}, 32.7767, -96.7970, "북미"),
        (new[]{"houston","휴스턴"}, 29.7604, -95.3698, "북미"),
        (new[]{"phoenix","피닉스","arizona","애리조나"}, 33.4484, -112.0740, "북미"),
        (new[]{"denver","덴버"}, 39.7392, -104.9903, "북미"),
        (new[]{"seattle","시애틀"}, 47.6062, -122.3321, "북미"),
        (new[]{"san jose","산호세"}, 37.3382, -121.8863, "북미"),
        (new[]{"san francisco","샌프란시스코"}, 37.7749, -122.4194, "북미"),
        (new[]{"los angeles","로스앤젤레스","la"}, 34.0522, -118.2437, "북미"),
        (new[]{"toronto","토론토"}, 43.6532, -79.3832, "북미"),
        (new[]{"montreal","몬트리올"}, 45.5017, -73.5673, "북미"),
        (new[]{"mexico city","멕시코시티"}, 19.4326, -99.1332, "북미"),

        (new[]{"london","런던"}, 51.5074, -0.1278, "유럽"),
        (new[]{"dublin","더블린"}, 53.3498, -6.2603, "유럽"),
        (new[]{"paris","파리"}, 48.8566, 2.3522, "유럽"),
        (new[]{"frankfurt","프랑크푸르트"}, 50.1109, 8.6821, "유럽"),
        (new[]{"amsterdam","암스테르담"}, 52.3676, 4.9041, "유럽"),
        (new[]{"berlin","베를린"}, 52.5200, 13.4050, "유럽"),
        (new[]{"munich","뮌헨"}, 48.1351, 11.5820, "유럽"),
        (new[]{"warsaw","바르샤바"}, 52.2297, 21.0122, "유럽"),
        (new[]{"madrid","마드리드"}, 40.4168, -3.7038, "유럽"),
        (new[]{"milan","밀라노"}, 45.4642, 9.1900, "유럽"),
        (new[]{"stockholm","스톡홀름"}, 59.3293, 18.0686, "유럽"),
        (new[]{"zurich","취리히"}, 47.3769, 8.5417, "유럽"),
        (new[]{"moscow","모스크바"}, 55.7558, 37.6173, "유럽"),

        (new[]{"sao paulo","상파울루"}, -23.5505, -46.6333, "남미"),
        (new[]{"rio de janeiro","리우데자네이루"}, -22.9068, -43.1729, "남미"),
        (new[]{"buenos aires","부에노스아이레스"}, -34.6037, -58.3816, "남미"),
        (new[]{"santiago","산티아고"}, -33.4489, -70.6693, "남미"),

        (new[]{"dubai","두바이"}, 25.2048, 55.2708, "중동·아프리카"),
        (new[]{"tel aviv","텔아비브"}, 32.0853, 34.7818, "중동·아프리카"),
        (new[]{"riyadh","리야드"}, 24.7136, 46.6753, "중동·아프리카"),
        (new[]{"johannesburg","요하네스버그"}, -26.2041, 28.0473, "중동·아프리카"),
        (new[]{"cairo","카이로"}, 30.0444, 31.2357, "중동·아프리카"),
        (new[]{"cape town","케이프타운"}, -33.9249, 18.4241, "중동·아프리카"),
    };

    private static readonly Dictionary<string, Geo> _index = Build();

    private static Dictionary<string, Geo> Build()
    {
        var d = new Dictionary<string, Geo>();
        foreach (var c in Cities)
            foreach (var n in c.Names)
                d[Norm(n)] = new Geo(c.Lat, c.Lon, c.Region);
        return d;
    }

    private static string Norm(string s) => (s ?? "").Trim().ToLowerInvariant().Replace(" ", "");

    /// <summary>도시명으로 좌표 조회. 정확 일치 우선, 없으면 부분 일치 시도. 실패 시 null.</summary>
    public static Geo? Lookup(string city)
    {
        var key = Norm(city);
        if (key.Length == 0) return null;
        if (_index.TryGetValue(key, out var g)) return g;
        foreach (var kv in _index)
            if (kv.Key.Contains(key) || key.Contains(kv.Key)) return kv.Value;
        return null;
    }
}
