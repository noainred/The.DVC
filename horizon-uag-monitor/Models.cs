using System;

namespace HorizonUagMonitor;

/// <summary>점검 대상 상태 등급.</summary>
public enum HealthStatus
{
    Unknown = 0, // 아직 점검 전
    Up = 1,      // 443 도달 + HTTPS 정상 + 인증서 여유
    Warn = 2,    // 도달하나 HTTP 비정상 / 인증서 임박 / 지연 높음
    Down = 3,    // 443 미도달(TCP 실패)
}

/// <summary>모니터링 대상(Horizon UAG / Virtual App 포탈) 정의.</summary>
public sealed class Endpoint
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string Datacenter { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; } = 443;
    public string Path { get; set; } = "/";
    public int IntervalSec { get; set; } = 60;
    public int TimeoutMs { get; set; } = 5000;
    public bool Enabled { get; set; } = true;
    public int Sort { get; set; } = 0;

    public string HttpsUrl
    {
        get
        {
            var p = string.IsNullOrEmpty(Path) ? "/" : (Path.StartsWith("/") ? Path : "/" + Path);
            var portPart = Port == 443 ? "" : ":" + Port;
            return $"https://{Host}{portPart}{p}";
        }
    }
}

/// <summary>한 번의 점검 결과(시계열 1 샘플).</summary>
public sealed class Sample
{
    public long Id { get; set; }
    public long EndpointId { get; set; }
    public DateTime TimestampUtc { get; set; }
    public HealthStatus Status { get; set; }
    public bool TcpOk { get; set; }
    public double? ConnectMs { get; set; }   // 443 TCP 연결 지연
    public bool TlsOk { get; set; }
    public int? HttpStatus { get; set; }
    public double? ResponseMs { get; set; }  // HTTPS 응답 전체 시간
    public int? CertExpiryDays { get; set; } // 서버 인증서 만료까지 남은 일수
    public string? Error { get; set; }
}

/// <summary>대상별 최신 상태 요약(그리드/트레이 표시용).</summary>
public sealed class EndpointStatus
{
    public Endpoint Endpoint { get; set; } = new();
    public Sample? Latest { get; set; }
    public HealthStatus Status => Latest?.Status ?? HealthStatus.Unknown;
}
