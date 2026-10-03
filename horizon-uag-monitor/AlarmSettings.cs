using System;
using System.Drawing;
using System.Globalization;

namespace HorizonUagMonitor;

public enum AlarmEdge { Top, Bottom, Left, Right }

/// <summary>화면 가장자리 알람 설정 — 켬/끔 · 위치 · 크기(두께·길이) · 깜빡임 속도. DB settings 표에 저장.</summary>
public sealed class AlarmSettings
{
    public const int MinThickness = 24, MaxThickness = 240, DefaultThickness = 64;
    public const int MinLength = 20, MaxLength = 100;
    public const int MinBlinkMs = 150, MaxBlinkMs = 5000, DefaultBlinkMs = 600;

    public bool Enabled { get; set; } = true;
    public AlarmEdge Edge { get; set; } = AlarmEdge.Top;
    /// <summary>띠의 두께(px). 위/아래면 높이, 왼쪽/오른쪽이면 너비.</summary>
    public int ThicknessPx { get; set; } = DefaultThickness;
    /// <summary>띠의 길이(화면 변 길이의 %, 가운데 정렬).</summary>
    public int LengthPercent { get; set; } = MaxLength;
    /// <summary>밝았다 어두워지는 한 번의 간격(ms).</summary>
    public int BlinkMs { get; set; } = DefaultBlinkMs;

    public static AlarmSettings Default => new();

    /// <summary>범위를 벗어난 값을 허용 범위로 맞춘 사본.</summary>
    public AlarmSettings Clamped() => new()
    {
        Enabled = Enabled,
        Edge = Enum.IsDefined(Edge) ? Edge : AlarmEdge.Top,
        ThicknessPx = Math.Clamp(ThicknessPx, MinThickness, MaxThickness),
        LengthPercent = Math.Clamp(LengthPercent, MinLength, MaxLength),
        BlinkMs = Math.Clamp(BlinkMs, MinBlinkMs, MaxBlinkMs),
    };

    public static AlarmSettings Load(Database db)
    {
        var s = new AlarmSettings
        {
            Enabled = db.GetIntSetting("alarmEnabled", 1) != 0,
            ThicknessPx = db.GetIntSetting("alarmThickness", DefaultThickness),
            LengthPercent = db.GetIntSetting("alarmLength", MaxLength),
            BlinkMs = db.GetIntSetting("alarmBlinkMs", DefaultBlinkMs),
            Edge = ParseEdge(db.GetSetting("alarmEdge")),
        };
        return s.Clamped();
    }

    public void Save(Database db)
    {
        var c = Clamped();
        db.SetSetting("alarmEnabled", c.Enabled ? "1" : "0");
        db.SetSetting("alarmEdge", c.Edge.ToString().ToLowerInvariant());
        db.SetSetting("alarmThickness", c.ThicknessPx.ToString(CultureInfo.InvariantCulture));
        db.SetSetting("alarmLength", c.LengthPercent.ToString(CultureInfo.InvariantCulture));
        db.SetSetting("alarmBlinkMs", c.BlinkMs.ToString(CultureInfo.InvariantCulture));
    }

    public static AlarmEdge ParseEdge(string? s) => (s ?? "").Trim().ToLowerInvariant() switch
    {
        "bottom" => AlarmEdge.Bottom,
        "left" => AlarmEdge.Left,
        "right" => AlarmEdge.Right,
        _ => AlarmEdge.Top,
    };

    public bool IsVertical => Edge is AlarmEdge.Left or AlarmEdge.Right;

    /// <summary>화면(<paramref name="screen"/>) 안에서 띠가 차지할 영역. 두께·길이는 화면 크기를 넘지 않게 자른다.</summary>
    public Rectangle ComputeBounds(Rectangle screen)
    {
        var c = Clamped();
        if (c.Edge is AlarmEdge.Top or AlarmEdge.Bottom)
        {
            var h = Math.Min(c.ThicknessPx, screen.Height);
            var w = Math.Max(1, screen.Width * c.LengthPercent / 100);
            var x = screen.Left + (screen.Width - w) / 2;
            var y = c.Edge == AlarmEdge.Top ? screen.Top : screen.Bottom - h;
            return new Rectangle(x, y, w, h);
        }
        else
        {
            var w = Math.Min(c.ThicknessPx, screen.Width);
            var h = Math.Max(1, screen.Height * c.LengthPercent / 100);
            var y = screen.Top + (screen.Height - h) / 2;
            var x = c.Edge == AlarmEdge.Left ? screen.Left : screen.Right - w;
            return new Rectangle(x, y, w, h);
        }
    }
}
