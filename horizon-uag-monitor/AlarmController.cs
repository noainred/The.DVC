using System;
using System.Collections.Generic;
using System.Linq;

namespace HorizonUagMonitor;

/// <summary>
/// 알람 엔진(판정)과 화면 띠(표시)를 잇는다. UI 스레드에서만 부른다.
/// 점검 결과가 갱신될 때마다 <see cref="Update"/> 를 부르면, 끄지 않은 알람이 있는 동안 띠가 깜빡이고
/// 모두 해소되면 스스로 사라진다. 알람 발생·확인·해소는 alarm.log 에 남긴다.
/// </summary>
public sealed class AlarmController : IDisposable
{
    private readonly Database _db;
    private readonly AlarmEngine _engine = new();
    private readonly AlarmOverlay _overlay = new();
    private AlarmSettings _settings;

    public AlarmController(Database db)
    {
        _db = db;
        _settings = AlarmSettings.Load(db);
        _overlay.Acknowledged += Acknowledge;
    }

    /// <summary>끄지 않은 알람이 있는가(트레이 메뉴의 '알람 끄기' 활성화용).</summary>
    public bool HasPending => _engine.Pending.Count > 0;

    /// <summary>설정 저장 직후 다시 읽는다. 위치·크기·속도는 곧바로 띠에 반영된다.</summary>
    public void ReloadSettings()
    {
        _settings = AlarmSettings.Load(_db);
        if (!_settings.Enabled) { _overlay.HideAlarm(); return; }
        Render();
    }

    public void Update(IEnumerable<EndpointStatus> snapshot)
    {
        if (!_settings.Enabled)
        {
            _engine.Reset();
            _overlay.HideAlarm();
            return;
        }
        var events = _engine.Update(snapshot, DateTime.UtcNow);
        foreach (var ev in events) Log(ev);
        Render();
    }

    public void Acknowledge()
    {
        foreach (var ev in _engine.AcknowledgeAll()) Log(ev);
        Render();
    }

    private void Render()
    {
        var pending = _engine.Pending;
        if (pending.Count == 0) { _overlay.HideAlarm(); return; }
        _overlay.ShowAlarm(_settings, pending);
    }

    private static void Log(AlarmEvent ev)
    {
        var i = ev.Item;
        var st = i.Status == HealthStatus.Down ? "위험" : "주의";
        var kind = ev.Kind switch
        {
            AlarmEventKind.Raised => "발생",
            AlarmEventKind.Escalated => "악화",
            AlarmEventKind.Cleared => "해소",
            _ => "확인",
        };
        var dc = string.IsNullOrWhiteSpace(i.Datacenter) ? "" : $" [{i.Datacenter}]";
        var detail = string.IsNullOrWhiteSpace(i.Detail) ? "" : $" — {i.Detail}";
        AppLog.Write(AppLog.AlarmFile, $"{kind} {st} {i.Name}{dc}{detail}");
    }

    public void Dispose()
    {
        try { _overlay.Acknowledged -= Acknowledge; _overlay.Close(); _overlay.Dispose(); } catch { /* ignore */ }
    }
}
