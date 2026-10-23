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
        _engine.SyncGeneration(db.Generation);
        _overlay.Acknowledged += Acknowledge;
    }

    /// <summary>
    /// 저장 폴더를 '기존 DB 로 전환' 했으면 판정을 비우고 알람 설정을 새 DB 에서 다시 읽는다 —
    /// 예전 DB 의 대상 id 로 들고 있던 알람·'확인됨' 이 새 DB 의 다른 대상에 붙지 않게.
    /// </summary>
    private void SyncGeneration()
    {
        if (!_engine.SyncGeneration(_db.Generation)) return;
        _settings = AlarmSettings.Load(_db);
        AppLog.Write(AppLog.AlarmFile, "저장 데이터베이스가 바뀌어 알람 판정을 처음부터 다시 합니다.");
    }

    /// <summary>끄지 않은 알람이 있는가(트레이 메뉴의 '알람 끄기' 활성화용).</summary>
    public bool HasPending => _engine.Pending.Count > 0;

    /// <summary>설정 저장 직후 다시 읽는다. 위치·크기·속도는 곧바로 띠에 반영된다.</summary>
    public void ReloadSettings()
    {
        SyncGeneration();
        _settings = AlarmSettings.Load(_db);
        if (!_settings.Enabled) { _overlay.HideAlarm(); return; }
        Render();
    }

    public void Update(IEnumerable<EndpointStatus> snapshot)
    {
        SyncGeneration();
        if (!_settings.Enabled)
        {
            _engine.Reset();
            _overlay.HideAlarm();
            return;
        }
        var snap = snapshot as IReadOnlyCollection<EndpointStatus> ?? snapshot.ToList();
        var events = _engine.Update(snap, DateTime.UtcNow);
        // v2.762(H-S2): 결과가 오래돼 빠진 알람(엔진은 Cleared 로 알린다)은 '해소' 가 아니다 — 대상은 여전히 주의·위험이다.
        //   최신 결과가 알람 등급인데 Cleared 면 오래됨으로 적는다(엔진의 IsAlarming 은 그때만 false).
        var stillBad = snap.Where(es => es.Endpoint.Enabled && es.Latest != null
                                        && es.Status >= _engine.MinLevel && es.Status != HealthStatus.Unknown)
                           .Select(es => es.Endpoint.Id).ToHashSet();
        foreach (var ev in events) Log(ev, ev.Kind == AlarmEventKind.Cleared && stillBad.Contains(ev.Item.EndpointId));
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

    private static void Log(AlarmEvent ev, bool staleCleared = false)
    {
        var i = ev.Item;
        var st = i.Status == HealthStatus.Down ? "위험" : "주의";
        // v2.762(H-S2): v2.760 B-05 로 '확인됨' 인 채 되살아난 알람도 Raised 다 — 해소된 적도 다시 울린 적도 없으니 '발생' 이 아니다.
        var kind = ev.Kind switch
        {
            AlarmEventKind.Raised when i.Acknowledged => "재표시(확인됨)",
            AlarmEventKind.Raised => "발생",
            AlarmEventKind.Escalated => "악화",
            AlarmEventKind.Cleared when staleCleared => "결과 오래됨(알람 보류)",
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
