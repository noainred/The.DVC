using Xunit;

namespace HorizonUagMonitor.Tests;

public class AlarmEngineTests
{
    // 기준 시각은 고정한다(Date.now 류 기준 시각은 시각에 따라 깨진다).
    private static readonly DateTime T0 = new(2026, 10, 3, 3, 0, 0, DateTimeKind.Utc);

    private static EndpointStatus Ep(long id, string name, HealthStatus st, DateTime? sampleAt = null,
        bool enabled = true, int interval = 60, string? err = null)
        => new()
        {
            Endpoint = new Endpoint { Id = id, Name = name, Datacenter = "DC", Enabled = enabled, IntervalSec = interval },
            Latest = st == HealthStatus.Unknown && sampleAt == null ? null
                : new Sample { EndpointId = id, Status = st, TimestampUtc = sampleAt ?? T0, Error = err },
        };

    [Fact]
    public void 정상과_점검전은_알람이_아니다()
    {
        var e = new AlarmEngine();
        var ev = e.Update(new[] { Ep(1, "A", HealthStatus.Up), Ep(2, "B", HealthStatus.Unknown) }, T0);
        Assert.Empty(ev);
        Assert.Empty(e.Active);
    }

    [Fact]
    public void 주의와_위험은_알람이고_위험이_먼저_나온다()
    {
        var e = new AlarmEngine();
        var ev = e.Update(new[] { Ep(1, "Zeta", HealthStatus.Warn, err: "HTTP 421"), Ep(2, "Alpha", HealthStatus.Down) }, T0);
        Assert.Equal(2, ev.Count);
        Assert.All(ev, x => Assert.Equal(AlarmEventKind.Raised, x.Kind));
        Assert.Equal(new[] { "Alpha", "Zeta" }, e.Active.Select(i => i.Name));
        Assert.Equal("HTTP 421", e.Active.Single(i => i.Name == "Zeta").Detail);
        Assert.Equal(2, e.Pending.Count);
    }

    [Fact]
    public void 같은_상태가_반복되어도_다시_울리지_않는다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Warn) }, T0);
        var ev = e.Update(new[] { Ep(1, "A", HealthStatus.Warn, T0.AddSeconds(60)) }, T0.AddSeconds(60));
        Assert.Empty(ev);
    }

    [Fact]
    public void 끄면_깜빡임_대상이_사라지지만_알람_목록에는_남는다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        var acks = e.AcknowledgeAll();
        Assert.Single(acks);
        Assert.Equal(AlarmEventKind.Acknowledged, acks[0].Kind);
        Assert.Empty(e.Pending);
        Assert.Single(e.Active);
        Assert.Empty(e.AcknowledgeAll()); // 두 번 눌러도 사건이 늘지 않는다
    }

    [Fact]
    public void 끈_뒤_같은_상태가_이어져도_다시_울리지_않는다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        e.AcknowledgeAll();
        for (int i = 1; i <= 5; i++)
            Assert.Empty(e.Update(new[] { Ep(1, "A", HealthStatus.Down, T0.AddSeconds(60 * i)) }, T0.AddSeconds(60 * i)));
        Assert.Empty(e.Pending);
    }

    [Fact]
    public void 끈_뒤_더_나빠지면_다시_울린다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Warn) }, T0);
        e.AcknowledgeAll();
        var ev = e.Update(new[] { Ep(1, "A", HealthStatus.Down, T0.AddSeconds(60)) }, T0.AddSeconds(60));
        Assert.Equal(AlarmEventKind.Escalated, Assert.Single(ev).Kind);
        Assert.Single(e.Pending);
    }

    [Fact]
    public void 끈_뒤_위험에서_주의로_나아진_것은_다시_울리지_않는다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        e.AcknowledgeAll();
        var ev = e.Update(new[] { Ep(1, "A", HealthStatus.Warn, T0.AddSeconds(60)) }, T0.AddSeconds(60));
        Assert.Empty(ev);
        Assert.Empty(e.Pending);
        Assert.Equal(HealthStatus.Warn, Assert.Single(e.Active).Status);
    }

    [Fact]
    public void 정상으로_돌아왔다가_다시_나빠지면_다시_울린다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        e.AcknowledgeAll();
        var cleared = e.Update(new[] { Ep(1, "A", HealthStatus.Up, T0.AddSeconds(60)) }, T0.AddSeconds(60));
        Assert.Equal(AlarmEventKind.Cleared, Assert.Single(cleared).Kind);
        Assert.Empty(e.Active);
        var again = e.Update(new[] { Ep(1, "A", HealthStatus.Down, T0.AddSeconds(120)) }, T0.AddSeconds(120));
        Assert.Equal(AlarmEventKind.Raised, Assert.Single(again).Kind);
        Assert.Single(e.Pending);
    }

    [Fact]
    public void 다른_대상의_새_알람은_끈_뒤에도_울린다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        e.AcknowledgeAll();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down, T0.AddSeconds(60)), Ep(2, "B", HealthStatus.Warn, T0.AddSeconds(60)) }, T0.AddSeconds(60));
        Assert.Equal("B", Assert.Single(e.Pending).Name);
    }

    [Fact]
    public void 비활성_대상과_오래된_결과는_알람이_아니다()
    {
        var e = new AlarmEngine();
        // 앱을 껐다 켠 직후 DB 에 남은 하루 전 '위험' 으로 울리면 안 된다.
        Assert.Empty(e.Update(new[] { Ep(1, "Old", HealthStatus.Down, T0.AddHours(-24)) }, T0));
        Assert.Empty(e.Update(new[] { Ep(2, "Off", HealthStatus.Down, enabled: false) }, T0));
        Assert.Empty(e.Active);
    }

    [Fact]
    public void 오래됨_기준은_점검_주기에_비례한다()
    {
        var e = new AlarmEngine();
        // 주기 600초 대상의 5분 전 결과는 최신이다(3 × 600 = 1800초 이내).
        Assert.Single(e.Update(new[] { Ep(1, "Slow", HealthStatus.Warn, T0.AddMinutes(-5), interval: 600) }, T0));
        // 주기 60초 대상의 5분 전 결과는 오래됐다(max(180, 180)초 초과).
        var e2 = new AlarmEngine();
        Assert.Empty(e2.Update(new[] { Ep(2, "Fast", HealthStatus.Warn, T0.AddMinutes(-5), interval: 60) }, T0));
    }

    [Fact]
    public void 결과가_오래되어_사라지면_해제_사건이_난다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        var ev = e.Update(new[] { Ep(1, "A", HealthStatus.Down, T0) }, T0.AddHours(1));
        Assert.Equal(AlarmEventKind.Cleared, Assert.Single(ev).Kind);
    }

    [Fact]
    public void 최소_등급을_위험으로_올리면_주의는_울리지_않는다()
    {
        var e = new AlarmEngine { MinLevel = HealthStatus.Down };
        e.Update(new[] { Ep(1, "A", HealthStatus.Warn), Ep(2, "B", HealthStatus.Down) }, T0);
        Assert.Equal("B", Assert.Single(e.Active).Name);
    }

    [Fact]
    public void Reset은_모두_비운다()
    {
        var e = new AlarmEngine();
        e.Update(new[] { Ep(1, "A", HealthStatus.Down) }, T0);
        e.Reset();
        Assert.Empty(e.Active);
    }
}
