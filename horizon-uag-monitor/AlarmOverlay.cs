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
        var text = Compose();
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        var size = Math.Clamp(_s.ThicknessPx * 0.34f, 9f, 30f);
        using var font = new Font("Segoe UI", size, FontStyle.Bold, GraphicsUnit.Pixel);
        using var brush = new SolidBrush(fg);
        using var fmt = new StringFormat(StringFormatFlags.NoWrap)
        {
            Alignment = StringAlignment.Near,
            LineAlignment = StringAlignment.Center,
            Trimming = StringTrimming.EllipsisCharacter,
        };

        var pad = 14;
        if (!_s.IsVertical)
        {
            g.DrawString(text, font, brush, new RectangleF(pad, 0, Width - pad * 2, Height), fmt);
        }
        else
        {
            // 세로 띠는 글자를 눕혀 쓴다(왼쪽은 아래→위, 오른쪽은 위→아래).
            var state = g.Save();
            try
            {
                if (_s.Edge == AlarmEdge.Left)
                {
                    g.TranslateTransform(0, Height);
                    g.RotateTransform(-90);
                }
                else
                {
                    g.TranslateTransform(Width, 0);
                    g.RotateTransform(90);
                }
                g.DrawString(text, font, brush, new RectangleF(pad, 0, Height - pad * 2, Width), fmt);
            }
            finally { g.Restore(state); }
        }
    }

    private string Compose()
    {
        if (_preview)
            return "⚠ 알람 미리보기 — 이 띠를 클릭하면 닫힙니다";
        var down = _items.Count(i => i.Status == HealthStatus.Down);
        var warn = _items.Count(i => i.Status == HealthStatus.Warn);
        var head = down > 0 && warn > 0 ? $"⚠ 장애 {down + warn}건 (위험 {down} · 주의 {warn})"
            : down > 0 ? $"⚠ 위험 {down}건" : $"⚠ 주의 {warn}건";
        var names = string.Join(", ", _items.Take(6).Select(i => $"{i.Name}({(i.Status == HealthStatus.Down ? "위험" : "주의")})"));
        var more = _items.Count > 6 ? $" 외 {_items.Count - 6}건" : "";
        return $"{head}  {names}{more}   — 클릭하면 알람이 꺼집니다";
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
