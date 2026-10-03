using System.Drawing;
using Xunit;

namespace HorizonUagMonitor.Tests;

public class AlarmSettingsTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "uagmon-test-" + Guid.NewGuid().ToString("N"));
    public AlarmSettingsTests() { Directory.CreateDirectory(_dir); }
    public void Dispose() { Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); try { Directory.Delete(_dir, true); } catch { } }

    private static readonly Rectangle Screen = new(0, 0, 1920, 1080);

    [Theory]
    [InlineData(AlarmEdge.Top, 0, 0, 1920, 64)]
    [InlineData(AlarmEdge.Bottom, 0, 1016, 1920, 64)]
    [InlineData(AlarmEdge.Left, 0, 0, 64, 1080)]
    [InlineData(AlarmEdge.Right, 1856, 0, 64, 1080)]
    public void 기본_크기의_위치(AlarmEdge edge, int x, int y, int w, int h)
    {
        var b = new AlarmSettings { Edge = edge }.ComputeBounds(Screen);
        Assert.Equal(new Rectangle(x, y, w, h), b);
    }

    [Fact]
    public void 길이를_줄이면_가운데에_놓인다()
    {
        var b = new AlarmSettings { Edge = AlarmEdge.Top, LengthPercent = 50 }.ComputeBounds(Screen);
        Assert.Equal(new Rectangle(480, 0, 960, 64), b);
        var v = new AlarmSettings { Edge = AlarmEdge.Left, LengthPercent = 50 }.ComputeBounds(Screen);
        Assert.Equal(new Rectangle(0, 270, 64, 540), v);
    }

    [Fact]
    public void 보조_모니터처럼_원점이_0이_아닌_화면에서도_그_화면_안에_놓인다()
    {
        var second = new Rectangle(-1920, 200, 1920, 1080);
        var b = new AlarmSettings { Edge = AlarmEdge.Bottom, ThicknessPx = 100 }.ComputeBounds(second);
        Assert.Equal(new Rectangle(-1920, 1180, 1920, 100), b);
    }

    [Fact]
    public void 범위를_벗어난_값은_허용_범위로_맞춘다()
    {
        var c = new AlarmSettings { ThicknessPx = 5000, LengthPercent = 1, BlinkMs = 1, Edge = (AlarmEdge)99 }.Clamped();
        Assert.Equal(AlarmSettings.MaxThickness, c.ThicknessPx);
        Assert.Equal(AlarmSettings.MinLength, c.LengthPercent);
        Assert.Equal(AlarmSettings.MinBlinkMs, c.BlinkMs);
        Assert.Equal(AlarmEdge.Top, c.Edge);
    }

    [Fact]
    public void 두께가_화면보다_커도_화면을_넘지_않는다()
    {
        var b = new AlarmSettings { Edge = AlarmEdge.Top, ThicknessPx = 240 }.ComputeBounds(new Rectangle(0, 0, 800, 100));
        Assert.True(b.Height <= 100);
    }

    [Fact]
    public void 저장하고_다시_읽으면_같다()
    {
        using var db = new Database(Path.Combine(_dir, "m.db"));
        new AlarmSettings { Enabled = false, Edge = AlarmEdge.Right, ThicknessPx = 90, LengthPercent = 60, BlinkMs = 250 }.Save(db);
        var s = AlarmSettings.Load(db);
        Assert.False(s.Enabled);
        Assert.Equal(AlarmEdge.Right, s.Edge);
        Assert.Equal(90, s.ThicknessPx);
        Assert.Equal(60, s.LengthPercent);
        Assert.Equal(250, s.BlinkMs);
    }

    [Fact]
    public void 저장된_값이_없으면_기본값이다()
    {
        using var db = new Database(Path.Combine(_dir, "m.db"));
        var s = AlarmSettings.Load(db);
        Assert.True(s.Enabled);
        Assert.Equal(AlarmEdge.Top, s.Edge);
        Assert.Equal(AlarmSettings.DefaultThickness, s.ThicknessPx);
        Assert.Equal(AlarmSettings.DefaultBlinkMs, s.BlinkMs);
    }

    [Fact]
    public void 깨진_저장값은_기본값으로_읽는다()
    {
        using var db = new Database(Path.Combine(_dir, "m.db"));
        db.SetSetting("alarmThickness", "abc");
        db.SetSetting("alarmEdge", "???");
        db.SetSetting("alarmBlinkMs", "-5");
        var s = AlarmSettings.Load(db);
        Assert.Equal(AlarmSettings.DefaultThickness, s.ThicknessPx);
        Assert.Equal(AlarmEdge.Top, s.Edge);
        Assert.Equal(AlarmSettings.MinBlinkMs, s.BlinkMs);
    }
}
