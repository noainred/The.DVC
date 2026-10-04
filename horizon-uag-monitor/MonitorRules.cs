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
