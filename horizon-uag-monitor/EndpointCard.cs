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
    private static readonly Font FName = Theme.F(11f, FontStyle.Bold);
    private static readonly Font FSub = Theme.F(8.5f);
    private static readonly Font FBig = Theme.F(20f, FontStyle.Bold);
    private static readonly Font FUnit = Theme.F(9f);
    private static readonly Font FChip = Theme.F(8.5f, FontStyle.Bold);
    private static readonly Font FMetric = Theme.F(8.5f);

    private EndpointStatus _es = new();
    private List<Sample> _recent = new();

    public long EndpointId => _es.Endpoint.Id;

    public EndpointCard()
    {
        DoubleBuffered = true;
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true); // 더블클릭 이벤트 활성
        Width = 296;
        Height = 150;
        Margin = new Padding(6);
        Cursor = Cursors.Hand;
        BackColor = Theme.Page; // 둥근 모서리 바깥은 바탕색
    }

    public void SetData(EndpointStatus es, List<Sample> recent)
    {
        _es = es;
        _recent = recent ?? new List<Sample>();
        Invalidate();
    }

    /// <summary>
    /// 시안의 카드: 둥근 모서리, 상태별 바탕·테두리(주의·위험은 옅게 물들임), 이름 + 상태 칩,
    /// 큰 응답시간 + 인증서, 오른쪽 스파크라인, 아래 한 줄 메모. 왼쪽 막대(스트라이프)는 쓰지 않는다.
    /// </summary>
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        var ep = _es.Endpoint;
        var s = _es.Latest;
        var status = _es.Status;
        var pal = Theme.Of(status, ep.Enabled);
        int w = Width, h = Height;

        var card = new RectangleF(0.5f, 0.5f, w - 2, h - 2);
        Theme.FillRound(g, card, 10, pal.CardBg);
        Theme.DrawRound(g, card, 10, pal.CardBorder);

        using var ink = new SolidBrush(Theme.Ink);
        using var gray = new SolidBrush(Theme.Muted);
        using var val = new SolidBrush(pal.Value);

        // 1행: 이름(왼쪽) + 상태 칩(오른쪽)
        var statText = MainForm.StatusText(status, ep.Enabled);
        var chipW = Theme.ChipSize(g, statText, FChip).Width;
        Theme.DrawChip(g, statText, FChip, pal, w - 16 - chipW, 12);
        g.DrawString(Ellipsis(g, ep.Name, FName, w - 16 - chipW - 28), FName, ink, 16, 12);

        // 2행: 유형 · 데이터센터 · 호스트
        var typeLabel = string.IsNullOrWhiteSpace(ep.Type) ? "UAG" : ep.Type;
        var where = string.IsNullOrEmpty(ep.Datacenter) ? typeLabel : $"{typeLabel} · {ep.Datacenter}";
        g.DrawString(Ellipsis(g, $"{where} · {ep.Host}:{ep.Port}", FSub, w - 32), FSub, gray, 16, 38);

        // 3행: 큰 응답시간(왼쪽) + 스파크라인(오른쪽)
        string big; string unit = "";
        if (!ep.Enabled) big = "비활성";
        else if (status == HealthStatus.Down) big = "—";
        else if (s?.ResponseMs is double rm) { big = rm.ToString("F0", CultureInfo.InvariantCulture); unit = " ms"; }
        else big = "—";
        g.DrawString(big, FBig, val, 14, 60);
        if (unit.Length > 0)
        {
            var bw = g.MeasureString(big, FBig, 1000, StringFormat.GenericTypographic).Width;
            g.DrawString(unit, FUnit, gray, 16 + bw, 72);
        }
        var metrics = new List<string> { "응답" };
        if (s?.CertExpiryDays is int cd) metrics.Add($"인증서 {cd}일");
        else if (s?.HttpStatus is int hs) metrics.Add($"HTTP {hs}");
        g.DrawString(string.Join(" · ", metrics), FMetric, gray, 16, 92);
        DrawSparkline(g, new Rectangle(w - 16 - 112, 62, 112, 34), pal.LineColor);

        // 4행: 메모 — 문제가 있으면 사유, 아니면 점검 시각
        string note;
        Brush noteBrush;
        if (!ep.Enabled) { note = "점검 안 함"; noteBrush = gray; }
        else if (s == null) { note = "측정 대기"; noteBrush = gray; }
        else if (status != HealthStatus.Up && !string.IsNullOrWhiteSpace(s.Error)) { note = s.Error!; noteBrush = val; }
        else { note = AgeText(s.TimestampUtc) + " 점검"; noteBrush = gray; }
        g.DrawString(Ellipsis(g, note, FMetric, w - 32), FMetric, noteBrush, 16, h - 28);
    }

    private static string AgeText(DateTime utc)
    {
        var sec = Math.Max(0, (DateTime.UtcNow - utc).TotalSeconds);
        if (sec < 60) return $"{sec:F0}초 전";
        if (sec < 3600) return $"{sec / 60:F0}분 전";
        if (sec < 86400) return $"{sec / 3600:F0}시간 전";
        return $"{sec / 86400:F0}일 전";
    }

    private void DrawSparkline(Graphics g, Rectangle area, Color baseColor)
    {
        var pts = _recent;
        if (pts.Count == 0)
        {
            using var br = new SolidBrush(Theme.Muted);
            g.DrawString("데이터 없음", FMetric, br, area.X, area.Y + area.Height / 2 - 7);
            return;
        }
        var withResp = pts.Where(p => p.ResponseMs.HasValue).ToList();
        double max = withResp.Count > 0 ? Math.Max(1, withResp.Max(p => p.ResponseMs!.Value)) * 1.2 : 1;
        int n = pts.Count;
        float dx = n > 1 ? area.Width / (float)(n - 1) : 0;
        float Y(double v) => area.Bottom - (float)(area.Height * Math.Min(v, max) / max);

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
                if (pts[i].Status == HealthStatus.Up) continue; // 정상 점은 그리지 않는다(선만) — 문제 구간만 점으로 눈에 띄게
                float r = 2.8f;
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
        using var pen = new Pen(color, 1.6f) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
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
