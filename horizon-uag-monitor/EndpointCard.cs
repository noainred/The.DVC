using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 대상 1개를 시각적으로 보여주는 상태 카드 — 좌측 상태 색상 스트라이프, 큰 현재 RTT,
/// HTTP/인증서/연결 지표, 하단 응답지연 스파크라인. 클릭 시 이력 열기(부모가 처리).
/// </summary>
public sealed class EndpointCard : Panel
{
    private static readonly Font FName = new("Segoe UI", 11f, FontStyle.Bold);
    private static readonly Font FDc = new("Segoe UI", 8.5f);
    private static readonly Font FHost = new("Segoe UI", 8f);
    private static readonly Font FBig = new("Segoe UI", 19f, FontStyle.Bold);
    private static readonly Font FStat = new("Segoe UI", 8.5f, FontStyle.Bold);
    private static readonly Font FMetric = new("Segoe UI", 8f);

    private EndpointStatus _es = new();
    private List<Sample> _recent = new();

    public long EndpointId => _es.Endpoint.Id;

    public EndpointCard()
    {
        DoubleBuffered = true;
        Width = 300;
        Height = 152;
        Margin = new Padding(8);
        Cursor = Cursors.Hand;
        BackColor = Color.White;
    }

    public void SetData(EndpointStatus es, List<Sample> recent)
    {
        _es = es;
        _recent = recent ?? new List<Sample>();
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        var ep = _es.Endpoint;
        var s = _es.Latest;
        var status = _es.Status;
        var color = MainForm.StatusColor(status, ep.Enabled);
        int w = Width, h = Height;

        // 카드 배경 + 테두리 + 좌측 상태 스트라이프
        using (var bg = new SolidBrush(ep.Enabled ? Color.White : Color.FromArgb(248, 249, 250)))
            g.FillRectangle(bg, 0, 0, w - 1, h - 1);
        using (var border = new Pen(Color.FromArgb(226, 229, 233)))
            g.DrawRectangle(border, 0, 0, w - 1, h - 1);
        using (var stripe = new SolidBrush(color))
            g.FillRectangle(stripe, 0, 0, 6, h - 1);

        // 헤더: 이름 / 데이터센터 / 호스트
        using var dark = new SolidBrush(Color.FromArgb(33, 37, 41));
        using var gray = new SolidBrush(Color.FromArgb(134, 142, 150));
        g.DrawString(Ellipsis(g, ep.Name, FName, w - 120), FName, dark, 16, 10);
        var typeLabel = string.IsNullOrWhiteSpace(ep.Type) ? "UAG" : ep.Type;
        var sub = string.IsNullOrEmpty(ep.Datacenter) ? typeLabel : $"{typeLabel} · {ep.Datacenter}";
        g.DrawString(Ellipsis(g, sub, FDc, w - 120), FDc, gray, 16, 33);
        g.DrawString(Ellipsis(g, $"{ep.Scheme}://{ep.Host}:{ep.Port}", FHost, w - 24), FHost, gray, 16, 52);

        // 우측 상단: 큰 현재 RTT + 상태 라벨
        using var statBrush = new SolidBrush(color);
        string big = !ep.Enabled ? "비활성"
            : status == HealthStatus.Down ? "무응답"
            : s?.ResponseMs is double rm ? $"{rm:F0} ms"
            : "—";
        var bigSz = g.MeasureString(big, FBig);
        g.DrawString(big, FBig, statBrush, w - bigSz.Width - 14, 8);
        var statText = MainForm.StatusText(status, ep.Enabled);
        var stSz = g.MeasureString(statText, FStat);
        g.DrawString(statText, FStat, statBrush, w - stSz.Width - 14, 8 + bigSz.Height - 2);

        // 지표 행
        var metrics = new List<string>();
        if (s != null)
        {
            metrics.Add(s.HttpStatus is int hs ? $"HTTP {hs}" : "HTTP —");
            if (s.CertExpiryDays is int cd) metrics.Add($"인증서 {cd}일");
            if (s.ConnectMs is double cm) metrics.Add($"연결 {cm:F0}ms");
        }
        else metrics.Add(ep.Enabled ? "측정 대기" : "측정 안 함");
        g.DrawString(string.Join("  ·  ", metrics), FMetric, gray, 16, 74);

        // 하단 스파크라인
        DrawSparkline(g, new Rectangle(14, 94, w - 26, h - 94 - 10), color);
    }

    private void DrawSparkline(Graphics g, Rectangle area, Color baseColor)
    {
        var pts = _recent;
        if (pts.Count == 0)
        {
            using var br = new SolidBrush(Color.FromArgb(173, 181, 189));
            g.DrawString("데이터 없음", FMetric, br, area.X, area.Y + area.Height / 2 - 7);
            return;
        }
        var withResp = pts.Where(p => p.ResponseMs.HasValue).ToList();
        double max = withResp.Count > 0 ? Math.Max(1, withResp.Max(p => p.ResponseMs!.Value)) * 1.2 : 1;
        int n = pts.Count;
        float dx = n > 1 ? area.Width / (float)(n - 1) : 0;
        float Y(double v) => area.Bottom - (float)(area.Height * Math.Min(v, max) / max);

        // 기준선(격자)
        using (var grid = new Pen(Color.FromArgb(238, 240, 243)))
        {
            g.DrawLine(grid, area.X, area.Y, area.Right, area.Y);
            g.DrawLine(grid, area.X, area.Bottom, area.Right, area.Bottom);
        }

        // 연결선(유효 구간)
        var linePts = new List<PointF>();
        for (int i = 0; i < n; i++)
        {
            if (pts[i].ResponseMs is double v)
                linePts.Add(new PointF(area.X + dx * i, Y(v)));
            else if (linePts.Count > 1) { DrawPoly(g, linePts, baseColor); linePts.Clear(); }
            else linePts.Clear();
        }
        if (linePts.Count > 1) DrawPoly(g, linePts, baseColor);

        // 점(상태 색상)
        for (int i = 0; i < n; i++)
        {
            float x = area.X + dx * i;
            if (pts[i].ResponseMs is double v)
            {
                var c = MainForm.StatusColor(pts[i].Status, true);
                using var br = new SolidBrush(c);
                float r = pts[i].Status == HealthStatus.Up ? 1.8f : 2.6f;
                g.FillEllipse(br, x - r, Y(v) - r, r * 2, r * 2);
            }
            else
            {
                using var pen = new Pen(Color.FromArgb(90, 214, 60, 60));
                g.DrawLine(pen, x, area.Y, x, area.Bottom);
            }
        }
    }

    private static void DrawPoly(Graphics g, List<PointF> pts, Color color)
    {
        using var pen = new Pen(Color.FromArgb(150, color), 1.4f);
        g.DrawLines(pen, pts.ToArray());
    }

    private static string Ellipsis(Graphics g, string text, Font font, float maxWidth)
    {
        if (string.IsNullOrEmpty(text)) return "";
        if (g.MeasureString(text, font).Width <= maxWidth) return text;
        for (int len = text.Length - 1; len > 1; len--)
        {
            var t = text.Substring(0, len) + "…";
            if (g.MeasureString(t, font).Width <= maxWidth) return t;
        }
        return "…";
    }
}
