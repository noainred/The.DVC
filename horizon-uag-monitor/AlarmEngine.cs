using System;
using System.Collections.Generic;
using System.Linq;

namespace HorizonUagMonitor;

public enum AlarmEventKind { Raised, Escalated, Cleared, Acknowledged }

/// <summary>알람 한 건 — 대상 하나가 '주의' 또는 '위험' 인 상태.</summary>
public sealed record AlarmItem(
    long EndpointId, string Name, string Datacenter, HealthStatus Status, string? Detail,
    DateTime RaisedUtc, bool Acknowledged);

public sealed record AlarmEvent(AlarmEventKind Kind, AlarmItem Item);

/// <summary>
/// 알람 판정 엔진(화면과 무관한 순수 논리). 최신 점검 결과를 받아 어떤 대상이 알람 상태인지,
/// 사용자가 이미 껐는지(확인)를 관리한다.
///
/// 규칙:
///  · 최소 등급(기본 '주의') 이상이고 최근에 점검된 대상만 알람이다. 점검 전(Unknown)·비활성·오래된 결과는 알람이 아니다
///    — 앱을 껐다 켠 직후 DB 에 남은 예전 결과로 울리지 않게 한다.
///  · 사용자가 끄면(<see cref="AcknowledgeAll"/>) 그 시점의 알람 전부가 '확인됨' 이 된다 — 더 깜빡이지 않는다.
///  · 확인된 알람은 ① 정상으로 돌아왔다가 다시 나빠지거나 ② 더 나쁜 등급(주의→위험)이 되면 다시 울린다.
///    위험→주의로 나아진 것은 다시 울리지 않는다.
/// </summary>
public sealed class AlarmEngine
{
    private readonly Dictionary<long, AlarmItem> _items = new();

    public HealthStatus MinLevel { get; set; } = HealthStatus.Warn;

    /// <summary>점검 결과를 알람으로 보지 않는 최소 유예. 실제로는 max(이 값, 점검 주기 × 3).</summary>
    public TimeSpan MinStale { get; set; } = TimeSpan.FromSeconds(180);

    public IReadOnlyList<AlarmEvent> Update(IEnumerable<EndpointStatus> snapshot, DateTime nowUtc)
    {
        var events = new List<AlarmEvent>();
        var seen = new HashSet<long>();
        foreach (var es in snapshot)
        {
            var ep = es.Endpoint;
            if (!IsAlarming(es, nowUtc)) continue;
            seen.Add(ep.Id);
            var st = es.Status;
            var detail = es.Latest?.Error;
            if (!_items.TryGetValue(ep.Id, out var cur))
            {
                var item = new AlarmItem(ep.Id, ep.Name, ep.Datacenter, st, detail, nowUtc, false);
                _items[ep.Id] = item;
                events.Add(new AlarmEvent(AlarmEventKind.Raised, item));
            }
            else if (st > cur.Status)
            {
                var item = cur with { Status = st, Detail = detail, Acknowledged = false };
                _items[ep.Id] = item;
                events.Add(new AlarmEvent(AlarmEventKind.Escalated, item));
            }
            else if (st != cur.Status || detail != cur.Detail)
            {
                // 나아졌거나 사유만 바뀜 — 확인 여부는 그대로 둔다.
                _items[ep.Id] = cur with { Status = st, Detail = detail };
            }
        }
        foreach (var id in _items.Keys.Where(k => !seen.Contains(k)).ToList())
        {
            events.Add(new AlarmEvent(AlarmEventKind.Cleared, _items[id]));
            _items.Remove(id);
        }
        return events;
    }

    private bool IsAlarming(EndpointStatus es, DateTime nowUtc)
    {
        var ep = es.Endpoint;
        if (!ep.Enabled || es.Latest == null) return false;
        if (es.Status < MinLevel || es.Status == HealthStatus.Unknown) return false;
        var stale = TimeSpan.FromSeconds(Math.Max(MinStale.TotalSeconds, 3.0 * Math.Max(1, ep.IntervalSec)));
        return nowUtc - es.Latest.TimestampUtc <= stale;
    }

    /// <summary>알람 상태인 대상 전부(위험 먼저, 이름순).</summary>
    public IReadOnlyList<AlarmItem> Active
        => _items.Values.OrderByDescending(i => i.Status).ThenBy(i => i.Name, StringComparer.CurrentCultureIgnoreCase).ToList();

    /// <summary>아직 끄지 않은 알람 — 있으면 띠가 깜빡인다.</summary>
    public IReadOnlyList<AlarmItem> Pending => Active.Where(i => !i.Acknowledged).ToList();

    public IReadOnlyList<AlarmEvent> AcknowledgeAll()
    {
        var events = new List<AlarmEvent>();
        foreach (var id in _items.Keys.ToList())
        {
            var it = _items[id];
            if (it.Acknowledged) continue;
            var acked = it with { Acknowledged = true };
            _items[id] = acked;
            events.Add(new AlarmEvent(AlarmEventKind.Acknowledged, acked));
        }
        return events;
    }

    public void Reset() => _items.Clear();
}
