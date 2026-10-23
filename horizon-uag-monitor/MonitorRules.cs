using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace HorizonUagMonitor;

/// <summary>점검 실패의 종류. 앱 종료로 끊긴 점검은 결과가 아니다.</summary>
public enum CheckFailureKind
{
    /// <summary>앱이 멈추는 중(Stop 의 취소) — 샘플을 만들지도 저장하지도 않는다.</summary>
    AppStopping,
    /// <summary>요청 시한(CancelAfter·HttpClient.Timeout) 초과 — 진짜 장애 신호다.</summary>
    Timeout,
    /// <summary>그 밖의 오류(연결 거부·DNS·TLS 등).</summary>
    Error,
}

/// <summary>
/// 점검 엔진(<see cref="MonitorService"/>)의 판정 중 화면·네트워크와 무관한 부분 — 테스트로 고정한다.
/// </summary>
public static class MonitorRules
{
    /// <summary>
    /// 점검 중 난 예외를 분류한다. 앱 토큰이 취소됐으면 어떤 예외든 '앱 종료' 다 —
    /// 종료 순간의 실패를 '시간 초과(위험)' 로 저장하면 다시 켰을 때 멀쩡한 장비에 알람이 울린다.
    /// </summary>
    public static CheckFailureKind ClassifyFailure(Exception ex, CancellationToken appToken)
    {
        if (appToken.IsCancellationRequested) return CheckFailureKind.AppStopping;
        if (ex is OperationCanceledException || ex is TimeoutException || ex.InnerException is TimeoutException)
            return CheckFailureKind.Timeout;
        return CheckFailureKind.Error;
    }

    /// <summary>오류 문구(120자 상한). '시간 초과' 는 진짜 시한 초과일 때만 쓴다.</summary>
    public static string FailureText(Exception ex, CheckFailureKind kind)
    {
        var m = kind == CheckFailureKind.Timeout ? "시간 초과" : (ex.InnerException?.Message ?? ex.Message);
        return m.Length > 120 ? m.Substring(0, 120) : m;
    }

    /// <summary>점검 결과를 '오래됨' 으로 보는 최소 유예. 실제로는 max(이 값, 점검 주기 × 3).</summary>
    public static readonly TimeSpan DefaultMinStale = TimeSpan.FromSeconds(180);

    /// <summary>그 대상의 결과가 오래됐다고 보는 나이 — max(최소 유예, 점검 주기 × 3).</summary>
    public static TimeSpan StaleAfter(Endpoint ep, TimeSpan minStale)
        => TimeSpan.FromSeconds(Math.Max(minStale.TotalSeconds, 3.0 * Math.Max(1, ep.IntervalSec)));

    /// <summary>
    /// 최신 결과가 아직 유효한가(오래되지 않았나). 알람(<see cref="AlarmEngine"/>)과 트레이·머리말 집계가 같은 판정을 쓴다.
    /// </summary>
    public static bool IsFresh(EndpointStatus es, DateTime nowUtc, TimeSpan minStale)
        => es.Latest != null && nowUtc - es.Latest.TimestampUtc <= StaleAfter(es.Endpoint, minStale);

    /// <summary>
    /// v2.767(점검 R2-B5-1): 트레이 아이콘·머리말 집계. 활성 대상만 세고, **오래된 결과는 대기(Unknown)** 로 센다 —
    /// 저장·점검이 멈춘 동안 마지막 저장 상태(예: 정상)를 그대로 그리면 장애가 나도 아이콘이 초록으로 남는다(알람 엔진은 이미
    /// 오래된 결과를 알람에서 뺀다). <paramref name="saveFailing"/> 이면 '정상' 이라고 그리지 않는다(대기로 내린다).
    /// </summary>
    public static StatusCounts CountStatuses(IEnumerable<EndpointStatus> snapshot, DateTime nowUtc, TimeSpan minStale, bool saveFailing = false)
    {
        int up = 0, warn = 0, down = 0, unknown = 0;
        foreach (var es in snapshot)
        {
            if (!es.Endpoint.Enabled) continue;
            var st = IsFresh(es, nowUtc, minStale) ? es.Status : HealthStatus.Unknown;
            switch (st)
            {
                case HealthStatus.Up: up++; break;
                case HealthStatus.Warn: warn++; break;
                case HealthStatus.Down: down++; break;
                default: unknown++; break;
            }
        }
        var overall = (up + warn + down + unknown) == 0 ? HealthStatus.Unknown
            : down > 0 ? HealthStatus.Down
            : warn > 0 ? HealthStatus.Warn
            : up == 0 ? HealthStatus.Unknown
            : HealthStatus.Up;
        if (saveFailing && overall == HealthStatus.Up) overall = HealthStatus.Unknown;
        return new StatusCounts(up, warn, down, unknown, overall);
    }
}

/// <summary>활성 대상의 상태별 개수와 전체 상태(트레이·머리말).</summary>
public sealed record StatusCounts(int Up, int Warn, int Down, int Unknown, HealthStatus Overall);

/// <summary>
/// v2.767(점검 R2-B5-1): 점검 결과 저장(InsertSample) 실패 추적 — 예전에는 예외를 조용히 삼켜 디스크 가득·네트워크 폴더 끊김에서
/// 모니터링이 아무 기록 없이 멈췄다. 연속 실패 수를 들고(화면·트레이 표시), error.log 는 스로틀한다: 첫 실패는 곧바로,
/// 그 뒤로는 <see cref="LogEvery"/> 마다 한 줄(그 사이 건수 포함). 다시 저장되면 복구 한 줄을 남기고 0 으로 돌아간다.
/// 여러 점검이 동시에 부르므로 내부에서 잠근다.
/// </summary>
public sealed class SaveFailureTracker
{
    public static readonly TimeSpan LogEvery = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private int _consecutive;
    private int _suppressed;
    private DateTime? _lastLogUtc;
    private DateTime? _sinceUtc;
    private string? _lastError;

    /// <summary>마지막 성공 이후 연속 실패 수(0 = 정상).</summary>
    public int Consecutive { get { lock (_gate) return _consecutive; } }
    public string? LastError { get { lock (_gate) return _lastError; } }
    public DateTime? SinceUtc { get { lock (_gate) return _sinceUtc; } }

    /// <summary>실패 1건. 남길 로그 줄을 돌려준다(스로틀 중이면 null).</summary>
    public string? Fail(string target, Exception ex, DateTime nowUtc)
    {
        lock (_gate)
        {
            _consecutive++;
            _sinceUtc ??= nowUtc;
            var msg = ex.Message ?? "";
            if (msg.Length > 300) msg = msg.Substring(0, 300);
            _lastError = $"{ex.GetType().Name}: {msg}";
            if (_lastLogUtc is DateTime t && nowUtc - t < LogEvery) { _suppressed++; return null; }
            var extra = _suppressed > 0 ? $" — 직전 기록 이후 {_suppressed}건 더 실패" : "";
            _suppressed = 0;
            _lastLogUtc = nowUtc;
            return $"점검 결과 저장 실패(연속 {_consecutive}회): {target} — {_lastError}{extra}. 결과가 기록되지 않아 알람·이력이 멈춥니다(저장 폴더·디스크 확인).";
        }
    }

    /// <summary>저장 성공. 실패 중이었으면 복구 로그 줄을 돌려준다.</summary>
    public string? Succeed(DateTime nowUtc)
    {
        lock (_gate)
        {
            if (_consecutive == 0) return null;
            var since = _sinceUtc ?? nowUtc;
            var line = $"점검 결과 저장 복구: 연속 {_consecutive}회 실패 뒤 다시 저장합니다(실패 시작 {since.ToLocalTime():yyyy-MM-dd HH:mm:ss}).";
            _consecutive = 0; _suppressed = 0; _lastLogUtc = null; _sinceUtc = null; _lastError = null;
            return line;
        }
    }
}

/// <summary>이력 한 칸(시간 버킷) 집계 — DB 가 GROUP BY 로 만든다(원시 행을 화면으로 옮기지 않는다).</summary>
public sealed record HistoryBucket(
    DateTime StartUtc, DateTime FirstUtc, DateTime LastUtc,
    int Count, int Up, int Warn, int Down,
    int RespCount, double RespSum, double? AvgResponseMs, double? MaxResponseMs)
{
    /// <summary>그 칸의 가장 나쁜 상태 — 위험이 한 건이라도 있으면 위험이다(평균으로 장애를 지우지 않는다).</summary>
    public HealthStatus Worst => HistoryRules.WorstOf(Up, Warn, Down);
}

/// <summary>기간 통계 — 버킷의 건수 합으로 계산하므로 원시 행으로 계산한 값과 같다.</summary>
public sealed record HistorySummary(int Count, int Up, int Warn, int Down, double UptimePct, double? AvgResponseMs, double? MaxResponseMs);

public static class HistoryRules
{
    /// <summary>한 차트에 그릴 점 수 상한(대략). 버킷 크기는 이 수를 넘지 않는 가장 작은 '보기 좋은' 단위다.</summary>
    public const int MaxPoints = 2200;

    private static readonly int[] NiceSteps =
    {
        1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 14400, 28800, 86400,
    };

    /// <summary>
    /// 조회 범위(분)에 맞는 버킷 크기(초). 1일=1분 · 7일=5분 · 30일=20분 · 90일=1시간 · 365일=4시간.
    /// (30일을 15분으로 하면 2,880점이라 상한을 넘는다 — 20분이면 2,160점.)
    /// 짧은 범위는 1~10초라 사실상 원시 샘플이 그대로 보인다(점검 주기 하한 5초).
    /// </summary>
    public static int BucketSecFor(int rangeMinutes)
    {
        long sec = Math.Max(1, (long)rangeMinutes) * 60L;
        foreach (var s in NiceSteps)
            if (sec / (double)s <= MaxPoints) return s;
        return NiceSteps[^1];
    }

    public static HealthStatus WorstOf(int up, int warn, int down)
        => down > 0 ? HealthStatus.Down : warn > 0 ? HealthStatus.Warn : up > 0 ? HealthStatus.Up : HealthStatus.Unknown;

    public static HistorySummary Summarize(IReadOnlyList<HistoryBucket> buckets)
    {
        int count = 0, up = 0, warn = 0, down = 0, respCount = 0;
        double respSum = 0;
        double? max = null;
        foreach (var b in buckets)
        {
            count += b.Count; up += b.Up; warn += b.Warn; down += b.Down;
            respCount += b.RespCount; respSum += b.RespSum;
            if (b.MaxResponseMs is double m && (max == null || m > max)) max = m;
        }
        var uptime = count > 0 ? 100.0 * up / count : 0;
        return new HistorySummary(count, up, warn, down, uptime, respCount > 0 ? respSum / respCount : null, max);
    }
}
