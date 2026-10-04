using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;

namespace HorizonUagMonitor;

/// <summary>
/// 점검 엔진 — 대상별 주기(interval)에 맞춰 443 TCP 연결·TLS 인증서·HTTPS 응답을 점검하고
/// 결과를 DB에 누적한다. 동시성 제한(SemaphoreSlim), 대상별 재진입 방지(_inFlight),
/// prune 스로틀을 적용해 다수 대상·고지연에서도 안정적으로 동작한다.
/// </summary>
public sealed class MonitorService : IDisposable
{
    private readonly Database _db;
    private readonly SemaphoreSlim _concurrency;
    private readonly object _gate = new();
    // 진행 중 점검 — (DB 세대, 대상 id). 세대를 키에 넣어 DB 전환 뒤 같은 id 의 새 대상이 예전 점검에 막히지 않게 하고,
    // 예전 점검이 끝나며 지우는 항목이 새 세대 항목을 지우지 않게 한다.
    private readonly HashSet<(int Gen, long Id)> _inFlight = new();
    private readonly Dictionary<long, DateTime> _lastCheck = new();
    private int _lastGen;
    private readonly ConcurrentDictionary<Task, byte> _running = new(); // 진행 중 점검 태스크(종료 시 드레인)
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private int _tick;
    private volatile bool _forceAll;

    public int CertWarnDays { get; set; } = 30;
    public double WarnLatencyMs { get; set; } = 3000;
    public int RetentionDays { get; set; } = 365;

    /// <summary>한 대상 점검이 끝날 때마다 발생(백그라운드 스레드). UI는 스스로 스레드 마샬링할 것.</summary>
    public event Action? Updated;

    /// <summary>설정 화면에서 저장했을 때(UI 스레드) 발생 — 알람 설정 등 다른 구성요소가 다시 읽는다.</summary>
    public event Action? SettingsApplied;

    public MonitorService(Database db, int maxConcurrency = 8)
    {
        _db = db;
        _concurrency = new SemaphoreSlim(Math.Max(1, maxConcurrency));
        CertWarnDays = db.GetIntSetting("certWarnDays", 30);
        WarnLatencyMs = db.GetIntSetting("warnLatencyMs", 3000);
        RetentionDays = db.GetIntSetting("retentionDays", 365);
    }

    public void Start()
    {
        if (_loop != null) return;
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    public void Stop()
    {
        try { _cts?.Cancel(); } catch { /* ignore */ }
        try { _loop?.Wait(3000); } catch { /* ignore */ }
        // 진행 중이던 개별 점검 태스크(fire-and-forget)를 배수 — 이후 _db.Dispose()가
        // in-flight writer와 겹치지 않도록 보장(마지막 샘플 유실·핸들 경합 방지).
        try { Task.WaitAll(_running.Keys.ToArray(), 3000); } catch { /* 취소/타임아웃 무시 */ }
        _loop = null;
    }

    /// <summary>즉시 전체 재점검 요청(다음 틱에 모든 활성 대상 점검).</summary>
    public void CheckAllNow() => _forceAll = true;

    /// <summary>설정 변경 후 임계값 재적용.</summary>
    public void ApplyThresholds()
    {
        CertWarnDays = _db.GetIntSetting("certWarnDays", 30);
        WarnLatencyMs = _db.GetIntSetting("warnLatencyMs", 3000);
        RetentionDays = _db.GetIntSetting("retentionDays", 365);
        try { SettingsApplied?.Invoke(); } catch { /* 구독자 오류는 격리 */ }
    }

    /// <summary>현재 대상 + 최신 상태 스냅샷(UI 그리드용).</summary>
    public List<EndpointStatus> Snapshot()
    {
        var eps = _db.ListEndpoints();
        var latest = _db.LatestByEndpoint();
        return eps.Select(e => new EndpointStatus { Endpoint = e, Latest = latest.TryGetValue(e.Id, out var s) ? s : null }).ToList();
    }

    public HealthStatus OverallStatus()
    {
        var snap = Snapshot().Where(s => s.Endpoint.Enabled).ToList();
        if (snap.Count == 0) return HealthStatus.Unknown;
        if (snap.Any(s => s.Status == HealthStatus.Down)) return HealthStatus.Down;
        if (snap.Any(s => s.Status == HealthStatus.Warn)) return HealthStatus.Warn;
        if (snap.All(s => s.Status == HealthStatus.Unknown)) return HealthStatus.Unknown;
        return HealthStatus.Up;
    }

    private async Task LoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var force = _forceAll;
                _forceAll = false;
                var now = DateTime.UtcNow;
                // 세대는 대상 목록을 읽기 '전에' 잡는다 — 읽은 뒤에 잡으면 그 사이 전환된 경우 예전 대상에 새 세대가 붙는다.
                var gen = _db.Generation;
                lock (_gate)
                {
                    if (gen != _lastGen) { _lastCheck.Clear(); _lastGen = gen; } // 다른 DB 로 전환 — 새 대상 전부 곧바로 점검
                }
                foreach (var ep in _db.ListEndpoints())
                {
                    if (!ep.Enabled) continue;
                    bool due;
                    lock (_gate)
                    {
                        if (_inFlight.Contains((gen, ep.Id))) continue; // 진행 중이면 이번 틱 건너뜀
                        due = force || !_lastCheck.TryGetValue(ep.Id, out var last)
                              || (now - last).TotalSeconds >= Math.Max(5, ep.IntervalSec);
                        if (!due) continue;
                        _inFlight.Add((gen, ep.Id));
                        _lastCheck[ep.Id] = now;
                    }
                    // 태스크를 추적해 Stop()에서 배수(fire-and-forget이지만 종료 시 대기 가능하게).
                    var t = RunCheckAsync(ep, gen, token);
                    _running.TryAdd(t, 0);
                    _ = t.ContinueWith(x => _running.TryRemove(x, out _), TaskScheduler.Default);
                }

                // prune 스로틀: 약 5분마다(틱 1s 기준 300틱).
                if (RetentionDays > 0 && (++_tick % 300 == 0))
                {
                    try { _db.Prune(RetentionDays); } catch { /* ignore */ }
                }
            }
            catch { /* 루프는 죽지 않는다 */ }

            try { await Task.Delay(1000, token); } catch { break; }
        }
    }

    private async Task RunCheckAsync(Endpoint ep, int gen, CancellationToken token)
    {
        bool acquired = false;
        try
        {
            await _concurrency.WaitAsync(token).ConfigureAwait(false);
            acquired = true;
            Sample sample;
            try
            {
                sample = await CheckEndpointAsync(ep, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                // 앱 종료로 끊긴 점검 — 결과가 아니다. '시간 초과(위험)' 로 저장하면 다시 켰을 때 멀쩡한 장비에 알람이 울린다.
                AppLog.Write(AppLog.ErrorFile, $"점검 중단(앱 종료): {ep.Name} — 결과를 저장하지 않았습니다.");
                return;
            }
            if (!_db.InsertSample(sample, gen))
                AppLog.Write(AppLog.ErrorFile, $"점검 결과 버림(저장 DB 전환): {ep.Name} — 전환 전 DB 의 대상이었습니다.");
        }
        catch { /* 개별 점검 실패/취소는 격리 */ }
        finally
        {
            // WaitAsync가 취소로 던져도(acquired=false) 재진입 가드는 반드시 해제(_inFlight 누수 방지).
            if (acquired) { try { _concurrency.Release(); } catch { /* ignore */ } }
            lock (_gate) { _inFlight.Remove((gen, ep.Id)); }
            if (acquired) { try { Updated?.Invoke(); } catch { /* ignore */ } }
        }
    }

    /// <summary>대상 1개 점검: TCP(443) 연결 → HTTPS GET(인증서·상태·지연). 예외는 상태로 환원.</summary>
    private async Task<Sample> CheckEndpointAsync(Endpoint ep, CancellationToken token)
    {
        var sample = new Sample { EndpointId = ep.Id, TimestampUtc = DateTime.UtcNow, Status = HealthStatus.Unknown };
        var timeout = Math.Max(1000, ep.TimeoutMs);

        // 1) TCP 연결 지연(443 도달성)
        var sw = Stopwatch.StartNew();
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token);
            linked.CancelAfter(timeout);
            using var tcp = new TcpClient();
            await tcp.ConnectAsync(ep.Host, ep.Port, linked.Token).ConfigureAwait(false);
            sw.Stop();
            sample.TcpOk = true;
            sample.ConnectMs = sw.Elapsed.TotalMilliseconds;
        }
        catch (Exception ex)
        {
            sw.Stop();
            var kind = MonitorRules.ClassifyFailure(ex, token);
            if (kind == CheckFailureKind.AppStopping) throw new OperationCanceledException("앱 종료로 점검 중단", ex, token);
            sample.TcpOk = false;
            sample.Status = HealthStatus.Down;
            sample.Error = $"TCP {ep.Port} 연결 실패: {MonitorRules.FailureText(ex, kind)}";
            return sample;
        }

        // 2) HTTP(S) GET — (HTTPS면 인증서 만료일 캡처) + HTTP 상태 + 응답시간 + (선택) 콘텐츠 검증
        DateTime? certNotAfterUtc = null;
        bool tlsHandshook = false;
        using var handler = new HttpClientHandler
        {
            CheckCertificateRevocationList = false,
            // UAG/포탈은 자체·사설 인증서가 흔하므로 신뢰검증 실패해도 도달성 모니터링은 계속한다(만료일만 기록).
            // 콜백에서 만료일만 읽어둔다(인증서 객체는 콜백 이후 파기될 수 있으므로 보관하지 않음).
            ServerCertificateCustomValidationCallback = (msg, c, chain, errors) =>
            {
                if (c != null) { try { certNotAfterUtc = c.NotAfter.ToUniversalTime(); tlsHandshook = true; } catch { /* ignore */ } }
                return true;
            },
            AllowAutoRedirect = false,
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(timeout) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("HorizonUagMonitor/1.0");

        bool wantBody = !string.IsNullOrWhiteSpace(ep.MatchText);
        bool contentOk = true; // MatchText 없으면 검사 안 함(항상 통과)
        var sw2 = Stopwatch.StartNew();
        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(token);
            linked.CancelAfter(timeout);
            var completion = wantBody ? HttpCompletionOption.ResponseContentRead : HttpCompletionOption.ResponseHeadersRead;
            using var resp = await client.GetAsync(ep.Url, completion, linked.Token).ConfigureAwait(false);
            sample.ResponseMs = sw2.Elapsed.TotalMilliseconds;
            sample.HttpStatus = (int)resp.StatusCode;
            sample.TlsOk = tlsHandshook;
            if (wantBody)
            {
                var body = await resp.Content.ReadAsStringAsync(linked.Token).ConfigureAwait(false);
                contentOk = body.Contains(ep.MatchText, StringComparison.OrdinalIgnoreCase);
            }
            sw2.Stop();
        }
        catch (Exception ex)
        {
            sw2.Stop();
            var kind = MonitorRules.ClassifyFailure(ex, token);
            if (kind == CheckFailureKind.AppStopping) throw new OperationCanceledException("앱 종료로 점검 중단", ex, token);
            sample.ResponseMs = sw2.Elapsed.TotalMilliseconds;
            sample.TlsOk = tlsHandshook;
            sample.Error = $"{(ep.Scheme == "http" ? "HTTP" : "HTTPS")} 오류: {MonitorRules.FailureText(ex, kind)}";
        }

        if (certNotAfterUtc != null)
        {
            var days = (int)Math.Floor((certNotAfterUtc.Value - DateTime.UtcNow).TotalDays);
            sample.CertExpiryDays = days;
        }

        sample.Status = Classify(sample, contentOk);
        return sample;
    }

    private HealthStatus Classify(Sample s, bool contentOk)
    {
        if (!s.TcpOk) return HealthStatus.Down;
        var httpOk = s.HttpStatus is >= 200 and <= 399;
        var certOk = s.CertExpiryDays is null || s.CertExpiryDays > CertWarnDays;
        var latencyOk = s.ResponseMs is null || s.ResponseMs <= WarnLatencyMs;
        if (httpOk && certOk && latencyOk && contentOk && s.Error == null) return HealthStatus.Up;
        // 도달은 하나 HTTP 비정상 / 인증서 임박·만료 / 지연 과다 / 콘텐츠 불일치 / TLS 오류
        var reasons = new List<string>();
        if (!httpOk) reasons.Add(s.HttpStatus is null ? "무응답" : $"HTTP {s.HttpStatus}");
        if (!certOk) reasons.Add(s.CertExpiryDays <= 0 ? "인증서 만료" : $"인증서 {s.CertExpiryDays}일 남음");
        if (!latencyOk) reasons.Add($"지연 {s.ResponseMs:F0}ms");
        if (!contentOk) reasons.Add("콘텐츠 불일치");
        if (reasons.Count > 0 && s.Error == null) s.Error = string.Join(", ", reasons);
        return HealthStatus.Warn;
    }

    public void Dispose()
    {
        Stop();
        _cts?.Dispose();
        _concurrency.Dispose();
    }
}
