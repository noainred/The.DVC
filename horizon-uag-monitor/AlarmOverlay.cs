using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 화면 가장자리에 붙는 알람 띠. 항상 위에 떠 있고 포커스를 빼앗지 않으며(작업 중인 창을 방해하지 않게),
/// 클릭하면 <see cref="Acknowledged"/> 가 발생한다. 위험은 빨강, 주의는 노랑 — 둘이 섞여 있으면 빨강.
/// 밝음/어두움을 <see cref="AlarmSettings.BlinkMs"/> 간격으로 오가며 깜빡인다.
/// </summary>
public sealed class AlarmOverlay : Form
{
    private const int WS_EX_TOOLWINDOW = 0x80;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOPMOST = 0x8;

    public static readonly Color DownColor = Color.FromArgb(0xE5, 0x39, 0x35);
    public static readonly Color WarnColor = Color.FromArgb(0xF2, 0xA5, 0x0B);

    private readonly System.Windows.Forms.Timer _blink = new();
    private AlarmSettings _s = AlarmSettings.Default;
    private IReadOnlyList<AlarmItem> _items = Array.Empty<AlarmItem>();
    private bool _bright = true;
    private bool _preview;

    /// <summary>사용자가 띠를 클릭했다(알람 끄기).</summary>
    public event Action? Acknowledged;

    public AlarmOverlay()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Cursor = Cursors.Hand;
        BackColor = DownColor;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        _blink.Tick += (_, _) => { _bright = !_bright; Invalidate(); };
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
            return cp;
        }
    }

    /// <summary>설정·알람 목록을 반영해 위치를 잡고 보이게 한다. <paramref name="preview"/> 이면 안내 문구가 다르다.</summary>
    public void ShowAlarm(AlarmSettings settings, IReadOnlyList<AlarmItem> items, bool preview = false)
    {
        _s = settings.Clamped();
        _items = items;
        _preview = preview;
        var screen = Screen.PrimaryScreen?.Bounds ?? new Rectangle(0, 0, 1280, 720);
        Bounds = _s.ComputeBounds(screen);
        _blink.Interval = _s.BlinkMs;
        if (!_blink.Enabled) { _bright = true; _blink.Start(); }
        if (!Visible) Show();
        Invalidate();
    }

    public void HideAlarm()
    {
        _blink.Stop();
        if (Visible) Hide();
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        Acknowledged?.Invoke();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var worst = _items.Count == 0 ? HealthStatus.Down : _items.Max(i => i.Status);
        var baseColor = worst == HealthStatus.Warn ? WarnColor : DownColor;
        // 어두운 쪽은 완전히 끄지 않고 55% 정도 가라앉힌다 — 깜빡이되 위치는 계속 보이게.
        var color = _bright ? baseColor : Blend(baseColor, Color.FromArgb(40, 20, 20), 0.55f);
        using (var bg = new SolidBrush(color)) g.FillRectangle(bg, ClientRectangle);

        var fg = worst == HealthStatus.Warn && _bright ? Color.FromArgb(0x2B, 0x1B, 0x00) : Color.White;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        if (!_s.IsVertical)
        {
            PaintBand(g, Width, Height, fg);
        }
        else
        {
            // 세로 띠는 글자를 눕혀 쓴다(왼쪽은 아래→위, 오른쪽은 위→아래). 가상의 가로 띠(길이 × 두께)에 그린 뒤 돌린다.
            var state = g.Save();
            try
            {
                if (_s.Edge == AlarmEdge.Left) { g.TranslateTransform(0, Height); g.RotateTransform(-90); }
                else { g.TranslateTransform(Width, 0); g.RotateTransform(90); }
                PaintBand(g, Height, Width, fg);
            }
            finally { g.Restore(state); }
        }
    }

    /// <summary>길이 <paramref name="len"/> × 두께 <paramref name="thick"/> 인 가로 띠 안쪽을 그린다: 아이콘 · 제목 · 이름들 · (오른쪽) 안내.</summary>
    private void PaintBand(Graphics g, int len, int thick, Color fg)
    {
        var (head, names, hint) = Compose();
        float px = Math.Clamp(thick * 0.36f, 10f, 30f);          // 제목 글자 크기
        using var fHead = new Font("Segoe UI", px, FontStyle.Bold, GraphicsUnit.Pixel);
        using var fNames = new Font("Segoe UI", Math.Max(9f, px * 0.78f), FontStyle.Bold, GraphicsUnit.Pixel);
        using var fHint = new Font("Segoe UI", Math.Max(9f, px * 0.62f), FontStyle.Regular, GraphicsUnit.Pixel);
        using var brush = new SolidBrush(fg);
        using var fmt = new StringFormat(StringFormat.GenericTypographic)
        {
            FormatFlags = StringFormatFlags.NoWrap,
            Trimming = StringTrimming.EllipsisCharacter,
            LineAlignment = StringAlignment.Center,
        };

        float pad = Math.Max(12f, thick * 0.3f);
        float icon = Math.Clamp(thick * 0.42f, 12f, 40f);
        float x = pad;
        float cy = thick / 2f;
        DrawWarnIcon(g, fg, x, cy - icon / 2f, icon);
        x += icon + pad * 0.6f;

        // 오른쪽 안내가 들어갈 자리를 먼저 잡는다(띠가 짧으면 안내를 뺀다).
        float hintW = g.MeasureString(hint, fHint, 4000, StringFormat.GenericTypographic).Width;
        bool showHint = len > 560 + hintW;
        float right = len - pad - (showHint ? hintW + pad : 0);

        float headW = g.MeasureString(head, fHead, 4000, StringFormat.GenericTypographic).Width;
        g.DrawString(head, fHead, brush, new RectangleF(x, 0, Math.Max(10, right - x), thick), fmt);
        x += headW + pad * 0.7f;
        if (right - x > 40)
            g.DrawString(names, fNames, brush, new RectangleF(x, 0, right - x, thick), fmt);
        if (showHint)
        {
            using var right_ = new StringFormat(fmt) { Alignment = StringAlignment.Far };
            g.DrawString(hint, fHint, brush, new RectangleF(len - pad - hintW - 4, 0, hintW + 4, thick), right_);
        }
    }

    // 이모지 글자(⚠)는 글꼴마다 모양이 달라 선 아이콘으로 직접 그린다.
    private static void DrawWarnIcon(Graphics g, Color color, float x, float y, float size)
    {
        float k = size / 26f;
        using var pen = new Pen(color, Math.Max(1.6f, 2.2f * k)) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round };
        PointF P(float px, float py) => new(x + px * k, y + py * k);
        g.DrawPolygon(pen, new[] { P(13, 3.5f), P(24, 22.5f), P(2, 22.5f) });
        g.DrawLine(pen, P(13, 10), P(13, 16));
        using var dot = new SolidBrush(color);
        g.FillEllipse(dot, x + 12f * k, y + 18.2f * k, 2f * k, 2f * k);
    }

    private (string Head, string Names, string Hint) Compose()
    {
        if (_preview)
            return ("알람 미리보기", "이 띠가 장애 때 이 위치·크기·속도로 깜빡입니다", "클릭하면 닫힙니다");
        var down = _items.Count(i => i.Status == HealthStatus.Down);
        var warn = _items.Count(i => i.Status == HealthStatus.Warn);
        var head = down > 0 && warn > 0 ? $"위험 {down}건 · 주의 {warn}건"
            : down > 0 ? $"위험 {down}건" : $"주의 {warn}건";
        var names = string.Join(", ", _items.Take(6).Select(i => $"{i.Name}({(i.Status == HealthStatus.Down ? "위험" : "주의")})"));
        if (_items.Count > 6) names += $" 외 {_items.Count - 6}건";
        return (head, names, "클릭하면 알람이 꺼집니다");
    }

    private static Color Blend(Color a, Color b, float t)
        => Color.FromArgb(
            (int)(a.R + (b.R - a.R) * t),
            (int)(a.G + (b.G - a.G) * t),
            (int)(a.B + (b.B - a.B) * t));

    protected override void Dispose(bool disposing)
    {
        if (disposing) { _blink.Stop(); _blink.Dispose(); }
        base.Dispose(disposing);
    }
}
