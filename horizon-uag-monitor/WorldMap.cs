using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 글로벌 사이트 현황 세계지도 — 모니터 대상(데이터센터=사이트)을 위경도로 지도에 찍고
/// 상태 색상(정상/주의/위험/비활성)으로 표시한다. 균일 도트 그리드 배경 + 강조 마커.
/// </summary>
public sealed class WorldMap : Panel
{
    private static readonly Font FTitle = new("Segoe UI", 12f, FontStyle.Bold);
    private static readonly Font FTitleEn = new("Segoe UI", 8f);
    private static readonly Font FLegend = new("Segoe UI", 9f, FontStyle.Bold);
    private static readonly Font FLabel = new("Segoe UI", 7.5f, FontStyle.Bold);

    private static readonly Color[] RegionPalette =
    {
        Color.FromArgb(45, 156, 219), Color.FromArgb(102, 89, 214), Color.FromArgb(214, 158, 30),
        Color.FromArgb(34, 160, 90), Color.FromArgb(214, 60, 60), Color.FromArgb(120, 120, 130),
    };

    private sealed class Site
    {
        public string Code = "";
        public string Region = "";
        public double Lat, Lon;
        public HealthStatus Status = HealthStatus.Unknown;
        public bool Enabled;
        public int Sev;
        public double RttSum;
        public int RttCount;
        public double? RttMs => RttCount > 0 ? RttSum / RttCount : (double?)null;
    }

    private List<Site> _sites = new();
    private double _userLat, _userLon;
    private string _userLabel = "내 위치";
    private bool _hasUser;

    public WorldMap()
    {
        DoubleBuffered = true;
        BackColor = Color.White;
    }

    /// <summary>사용자(매니저) 위치 지정 — 지도에 마커 + 각 사이트까지 arc/RTT 표시 기준.</summary>
    public void SetUser(double lat, double lon, string label)
    {
        _userLat = lat; _userLon = lon;
        _userLabel = string.IsNullOrWhiteSpace(label) ? "내 위치" : label;
        _hasUser = !(lat == 0 && lon == 0);
        Invalidate();
    }

    public void SetData(List<EndpointStatus> snap)
    {
        var map = new Dictionary<string, Site>(StringComparer.OrdinalIgnoreCase);
        foreach (var es in snap ?? new List<EndpointStatus>())
        {
            var ep = es.Endpoint;
            if (ep.Lat == 0 && ep.Lon == 0) continue; // 좌표 없으면 지도 표시 제외
            var key = string.IsNullOrWhiteSpace(ep.Datacenter) ? ep.Name : ep.Datacenter;
            if (!map.TryGetValue(key, out var site))
            {
                site = new Site { Code = key, Region = ep.Region, Lat = ep.Lat, Lon = ep.Lon };
                map[key] = site;
            }
            if (string.IsNullOrEmpty(site.Region) && !string.IsNullOrEmpty(ep.Region)) site.Region = ep.Region;
            if (ep.Enabled)
            {
                site.Enabled = true;
                int sev = Severity(es.Status);
                if (sev > site.Sev) { site.Sev = sev; site.Status = es.Status; }
                // 사용자 기준 RTT = 응답 지연(없으면 연결 지연) 평균.
                var rtt = es.Latest?.ResponseMs ?? es.Latest?.ConnectMs;
                if (rtt is double v) { site.RttSum += v; site.RttCount++; }
            }
        }
        _sites = map.Values.ToList();
        Invalidate();
    }

    private static int Severity(HealthStatus s) => s switch
    {
        HealthStatus.Down => 3, HealthStatus.Warn => 2, HealthStatus.Up => 1, _ => 0,
    };

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        int padL = 20, padR = 20, padT = 46, padB = 44;
        var map = new Rectangle(padL, padT, Math.Max(50, Width - padL - padR), Math.Max(50, Height - padT - padB));

        // 배경 도트 그리드(세계 캔버스)
        using (var dot = new SolidBrush(Color.FromArgb(224, 227, 231)))
        {
            int step = Math.Max(10, map.Width / 72);
            for (int x = map.Left; x <= map.Right; x += step)
                for (int y = map.Top; y <= map.Bottom; y += step)
                    g.FillEllipse(dot, x, y, 2f, 2f);
        }

        float X(double lon) => map.Left + (float)((lon + 180.0) / 360.0 * map.Width);
        float Y(double lat) => map.Top + (float)((90.0 - lat) / 180.0 * map.Height);

        // 사용자 → 사이트 arc(마커 아래에 먼저 그린다). 상태 색상으로 곡선.
        PointF? userPt = _hasUser ? new PointF(X(_userLon), Y(_userLat)) : null;
        if (userPt is PointF up)
        {
            foreach (var s in _sites)
            {
                var color = MainForm.StatusColor(s.Status, s.Enabled);
                DrawArc(g, up, new PointF(X(s.Lon), Y(s.Lat)), Color.FromArgb(70, color));
            }
        }

        // 마커
        foreach (var s in _sites)
        {
            float cx = X(s.Lon), cy = Y(s.Lat);
            var color = MainForm.StatusColor(s.Status, s.Enabled);
            using (var halo = new SolidBrush(Color.FromArgb(38, color)))
                g.FillEllipse(halo, cx - 15, cy - 15, 30, 30);
            using (var ring = new Pen(Color.FromArgb(90, color)))
                g.DrawEllipse(ring, cx - 15, cy - 15, 30, 30);
            using (var br = new SolidBrush(color))
                g.FillEllipse(br, cx - 5.5f, cy - 5.5f, 11, 11);
            using (var wp = new Pen(Color.White, 1.6f))
                g.DrawEllipse(wp, cx - 5.5f, cy - 5.5f, 11, 11);
            // 라벨(사이트 코드 + 사용자 기준 RTT) — 흰색 외곽 후 진한 글씨로 가독성 확보
            var label = s.RttMs is double r ? $"{s.Code}  {r:F0}ms" : s.Code;
            var lp = new PointF(cx + 9, cy - 7);
            using var wbr = new SolidBrush(Color.FromArgb(220, 255, 255, 255));
            using var dbr = new SolidBrush(Color.FromArgb(52, 58, 64));
            foreach (var (ox, oy) in new[] { (-1, 0), (1, 0), (0, -1), (0, 1) })
                g.DrawString(label, FLabel, wbr, lp.X + ox, lp.Y + oy);
            g.DrawString(label, FLabel, dbr, lp);
        }

        // 사용자(매니저) 마커
        if (userPt is PointF u)
        {
            using (var halo = new SolidBrush(Color.FromArgb(40, 45, 120, 210)))
                g.FillEllipse(halo, u.X - 13, u.Y - 13, 26, 26);
            using (var br = new SolidBrush(Color.FromArgb(45, 120, 210)))
                DrawDiamond(g, br, u, 7.5f);
            using (var wp = new Pen(Color.White, 1.6f))
                DrawDiamond(g, wp, u, 7.5f);
            var lp = new PointF(u.X + 10, u.Y - 8);
            using var wbr = new SolidBrush(Color.FromArgb(220, 255, 255, 255));
            using var dbr = new SolidBrush(Color.FromArgb(30, 64, 130));
            foreach (var (ox, oy) in new[] { (-1, 0), (1, 0), (0, -1), (0, 1) })
                g.DrawString(_userLabel, FLabel, wbr, lp.X + ox, lp.Y + oy);
            g.DrawString(_userLabel, FLabel, dbr, lp);
        }

        DrawTitle(g);
        DrawStatusLegend(g, map);
        DrawRegionLegend(g, map);

        if (_sites.Count == 0)
        {
            using var hint = new SolidBrush(Color.FromArgb(150, 150, 150));
            g.DrawString("지도에 표시할 좌표(위도/경도)가 지정된 대상이 없습니다. 설정에서 위경도를 입력하세요.",
                new Font("Segoe UI", 9f), hint, map.Left + 20, map.Top + map.Height / 2);
        }
    }

    private void DrawTitle(Graphics g)
    {
        using var dark = new SolidBrush(Color.FromArgb(33, 37, 41));
        using var gray = new SolidBrush(Color.FromArgb(140, 148, 156));
        g.DrawString("글로벌 사이트 현황", FTitle, dark, 20, 14);
        var w = g.MeasureString("글로벌 사이트 현황", FTitle).Width;
        g.DrawString("GLOBAL SITE STATUS", FTitleEn, gray, 20 + w + 8, 22);
    }

    private void DrawStatusLegend(Graphics g, Rectangle map)
    {
        var items = new (string Label, Color Color)[]
        {
            ("정상", MainForm.StatusColor(HealthStatus.Up, true)),
            ("주의", MainForm.StatusColor(HealthStatus.Warn, true)),
            ("위험", MainForm.StatusColor(HealthStatus.Down, true)),
        };
        using var txt = new SolidBrush(Color.FromArgb(90, 96, 104));
        float x = Width - 20;
        // LIVE
        var liveSz = g.MeasureString("LIVE", FLegend);
        x -= liveSz.Width;
        using (var live = new SolidBrush(Color.FromArgb(34, 160, 90)))
        {
            g.DrawString("LIVE", FLegend, live, x, 16);
            g.FillEllipse(live, x - 14, 20, 7, 7);
        }
        x -= 24;
        for (int i = items.Length - 1; i >= 0; i--)
        {
            var it = items[i];
            var sz = g.MeasureString(it.Label, FLegend);
            x -= sz.Width;
            g.DrawString(it.Label, FLegend, txt, x, 16);
            x -= 12;
            using (var br = new SolidBrush(it.Color)) g.FillEllipse(br, x, 20, 8, 8);
            x -= 12;
        }
    }

    private void DrawRegionLegend(Graphics g, Rectangle map)
    {
        // 리전별 사이트 수(첫 등장 순서), 색상은 팔레트 순환.
        var order = new List<string>();
        var counts = new Dictionary<string, int>();
        foreach (var s in _sites)
        {
            var rg = string.IsNullOrWhiteSpace(s.Region) ? "기타" : s.Region;
            if (!counts.ContainsKey(rg)) { counts[rg] = 0; order.Add(rg); }
            counts[rg]++;
        }
        using var txt = new SolidBrush(Color.FromArgb(90, 96, 104));
        float x = 20, y = Height - 30;
        for (int i = 0; i < order.Count; i++)
        {
            var rg = order[i];
            var color = RegionPalette[i % RegionPalette.Length];
            using (var br = new SolidBrush(color)) g.FillEllipse(br, x, y + 2, 9, 9);
            x += 14;
            var label = $"{rg} {counts[rg]}";
            g.DrawString(label, FLegend, txt, x, y);
            x += g.MeasureString(label, FLegend).Width + 18;
        }
    }

    private static void DrawArc(Graphics g, PointF a, PointF b, Color color)
    {
        float dx = b.X - a.X, dy = b.Y - a.Y;
        float dist = (float)Math.Sqrt(dx * dx + dy * dy);
        float lift = Math.Min(dist * 0.22f, 70f); // 위로 볼록한 곡선
        var c1 = new PointF(a.X + dx * 0.33f, a.Y + dy * 0.33f - lift);
        var c2 = new PointF(a.X + dx * 0.66f, a.Y + dy * 0.66f - lift);
        using var pen = new Pen(color, 1.2f);
        g.DrawBezier(pen, a, c1, c2, b);
    }

    private static void DrawDiamond(Graphics g, Brush b, PointF c, float r)
        => g.FillPolygon(b, new[] { new PointF(c.X, c.Y - r), new PointF(c.X + r, c.Y), new PointF(c.X, c.Y + r), new PointF(c.X - r, c.Y) });

    private static void DrawDiamond(Graphics g, Pen p, PointF c, float r)
        => g.DrawPolygon(p, new[] { new PointF(c.X, c.Y - r), new PointF(c.X + r, c.Y), new PointF(c.X, c.Y + r), new PointF(c.X - r, c.Y) });
}
