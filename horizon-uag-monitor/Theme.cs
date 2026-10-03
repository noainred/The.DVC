using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 화면 디자인 상수 모음(승인된 Claude Design 시안 기준): 진한 남색 머리말 · 밝은 본문 · 상태 칩.
/// 색·글꼴·둥근 모서리 그리기를 한곳에 둬서 화면마다 따로 정하지 않는다.
/// </summary>
internal static class Theme
{
    public static readonly Color Navy = Color.FromArgb(0x0F, 0x1B, 0x2D);
    public static readonly Color NavyTile = Color.FromArgb(0x16, 0x26, 0x3D);
    public static readonly Color TileText = Color.FromArgb(0xB7, 0xC3, 0xD6);
    public static readonly Color Page = Color.FromArgb(0xF3, 0xF5, 0xF8);
    public static readonly Color Line = Color.FromArgb(0xE1, 0xE6, 0xEE);
    public static readonly Color BtnBorder = Color.FromArgb(0xD5, 0xDC, 0xE8);
    public static readonly Color Hover = Color.FromArgb(0xEE, 0xF2, 0xF8);
    public static readonly Color Ink = Color.FromArgb(0x1B, 0x25, 0x36);
    public static readonly Color Body = Color.FromArgb(0x4A, 0x56, 0x6A);
    public static readonly Color Muted = Color.FromArgb(0x6A, 0x77, 0x8C);
    public static readonly Color Blue = Color.FromArgb(0x25, 0x63, 0xEB);
    public static readonly Color BlueDark = Color.FromArgb(0x1D, 0x4E, 0xC4);
    public static readonly Color SelectRow = Color.FromArgb(0xE8, 0xF0, 0xFE);

    public const string FontName = "Segoe UI";
    public static Font F(float pt, FontStyle st = FontStyle.Regular) => new(FontName, pt, st);

    /// <summary>한 상태의 색 묶음(칩·카드·표 행·스파크라인).</summary>
    public sealed record Pal(Color ChipBg, Color ChipFg, Color Dot, Color CardBg, Color CardBorder, Color Value, Color LineColor, Color RowBg);

    private static readonly Pal PalUp = new(C(0xE3, 0xF4, 0xEB), C(0x0E, 0x6B, 0x3F), C(0x1F, 0x9D, 0x61), Color.White, Line, Ink, C(0x1F, 0x9D, 0x61), Color.White);
    private static readonly Pal PalWarn = new(C(0xFC, 0xEF, 0xC7), C(0x7A, 0x52, 0x00), C(0xD9, 0x9A, 0x00), C(0xFF, 0xFA, 0xEA), C(0xF0, 0xD9, 0x8C), C(0x7A, 0x52, 0x00), C(0xD9, 0x9A, 0x00), C(0xFF, 0xFA, 0xEA));
    private static readonly Pal PalDown = new(C(0xFB, 0xE0, 0xE0), C(0x9B, 0x1C, 0x1C), C(0xD6, 0x3C, 0x3C), C(0xFF, 0xF3, 0xF3), C(0xF0, 0xB4, 0xB4), C(0x9B, 0x1C, 0x1C), C(0xD6, 0x3C, 0x3C), C(0xFF, 0xF3, 0xF3));
    private static readonly Pal PalOff = new(C(0xEC, 0xEF, 0xF3), Body, C(0x8A, 0x94, 0xA3), C(0xF8, 0xF9, 0xFA), Line, Muted, C(0x8A, 0x94, 0xA3), Color.White);

    private static Color C(int r, int g, int b) => Color.FromArgb(r, g, b);

    public static Pal Of(HealthStatus s, bool enabled)
        => !enabled ? PalOff : s switch
        {
            HealthStatus.Up => PalUp,
            HealthStatus.Warn => PalWarn,
            HealthStatus.Down => PalDown,
            _ => PalOff,
        };

    public static GraphicsPath RoundPath(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        if (d <= 0) { path.AddRectangle(r); return path; }
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void FillRound(Graphics g, RectangleF r, float radius, Color color)
    {
        using var p = RoundPath(r, radius);
        using var b = new SolidBrush(color);
        g.FillPath(b, p);
    }

    public static void DrawRound(Graphics g, RectangleF r, float radius, Color color, float width = 1f)
    {
        using var p = RoundPath(r, radius);
        using var pen = new Pen(color, width);
        g.DrawPath(pen, p);
    }

    /// <summary>상태 칩(점 + 글자) 크기.</summary>
    public static SizeF ChipSize(Graphics g, string text, Font font)
        => new(g.MeasureString(text, font, 1000, StringFormat.GenericTypographic).Width + 10 + 7 + 6 + 10, 22);

    /// <summary>상태 칩을 (x, y) 에서 시작해 그린다. 폭을 돌려준다.</summary>
    public static float DrawChip(Graphics g, string text, Font font, Pal p, float x, float y)
    {
        var sz = ChipSize(g, text, font);
        FillRound(g, new RectangleF(x, y, sz.Width, sz.Height), 11, p.ChipBg);
        using (var dot = new SolidBrush(p.Dot)) g.FillEllipse(dot, x + 10, y + (sz.Height - 7) / 2f, 7, 7);
        using var fg = new SolidBrush(p.ChipFg);
        g.DrawString(text, font, fg, new PointF(x + 10 + 7 + 6, y + (sz.Height - font.GetHeight(g)) / 2f), StringFormat.GenericTypographic);
        return sz.Width;
    }

    /// <summary>아이콘 없는 평면 버튼 모양을 입힌다(설정 창 등).</summary>
    public static void StyleButton(Button b, bool primary = false)
    {
        b.FlatStyle = FlatStyle.Flat;
        b.UseVisualStyleBackColor = false;
        b.Cursor = Cursors.Hand;
        b.Font = F(9.5f, primary ? FontStyle.Bold : FontStyle.Regular);
        b.MinimumSize = new Size(0, 32);
        b.Padding = new Padding(10, 2, 10, 2);
        if (primary)
        {
            b.BackColor = Blue; b.ForeColor = Color.White;
            b.FlatAppearance.BorderSize = 0;
            b.FlatAppearance.MouseOverBackColor = BlueDark;
        }
        else
        {
            b.BackColor = Color.White; b.ForeColor = Ink;
            b.FlatAppearance.BorderColor = BtnBorder;
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.MouseOverBackColor = Hover;
        }
    }
}

/// <summary>메인 도구줄 그리기 — 흰 바탕, 둥근 버튼, 선택(보기 전환)은 어두운 배경, 주 버튼은 파랑.</summary>
internal sealed class ThemedToolRenderer : ToolStripProfessionalRenderer
{
    public const string PrimaryTag = "primary";
    public const string LinkTag = "link";

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        using var b = new SolidBrush(Color.White);
        e.Graphics.FillRectangle(b, e.AffectedBounds);
    }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using var pen = new Pen(Theme.Line);
        e.Graphics.DrawLine(pen, 0, e.ToolStrip.Height - 1, e.ToolStrip.Width, e.ToolStrip.Height - 1);
    }

    protected override void OnRenderButtonBackground(ToolStripItemRenderEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var item = e.Item;
        var tag = item.Tag as string;
        var r = new RectangleF(1.5f, 3.5f, item.Width - 3, item.Height - 7);
        bool checkedItem = item is ToolStripButton tb && tb.Checked;
        if (tag == PrimaryTag)
        {
            Theme.FillRound(g, r, 6, item.Selected ? Theme.BlueDark : Theme.Blue);
        }
        else if (checkedItem)
        {
            Theme.FillRound(g, r, 6, Theme.Ink);
        }
        else if (item.Selected)
        {
            Theme.FillRound(g, r, 6, Theme.Hover);
        }
        else if (tag != LinkTag && item.Alignment == ToolStripItemAlignment.Left)
        {
            Theme.DrawRound(g, r, 6, Theme.BtnBorder);
        }
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        var tag = e.Item.Tag as string;
        bool checkedItem = e.Item is ToolStripButton tb && tb.Checked;
        e.TextColor = tag == PrimaryTag || checkedItem ? Color.White
            : tag == LinkTag ? Theme.Blue
            : Theme.Ink;
        base.OnRenderItemText(e);
    }
}
