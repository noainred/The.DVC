using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>대상 1개의 응답지연/상태 이력 — 범위(1일~365일) 선택 + 산점 차트 + 통계.</summary>
public sealed class HistoryForm : Form
{
    private readonly Database _db;
    private readonly Endpoint _ep;
    private readonly ChartPanel _chart = new();
    private readonly Label _stats = new();
    private int _rangeMinutes = 180; // 기본 3시간

    // 라벨, 분 단위 범위. 분/시간 단기 범위 + 일 단위 장기 범위.
    private static readonly (string Label, int Minutes)[] Ranges =
    {
        ("1분", 1), ("10분", 10), ("30분", 30), ("1시간", 60), ("3시간", 180), ("6시간", 360),
        ("1일", 1440), ("7일", 10080), ("30일", 43200), ("90일", 129600), ("365일", 525600),
    };

    public HistoryForm(Database db, Endpoint ep)
    {
        _db = db;
        _ep = ep;
        Text = $"이력 — {ep.Name} ({ep.Host}:{ep.Port})";
        Width = 1020;
        Height = 520;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9f);

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(6), WrapContents = false, AutoScroll = true };
        foreach (var (label, minutes) in Ranges)
        {
            var b = new Button { Text = label, AutoSize = true, Tag = minutes };
            b.Click += (s, _) => { _rangeMinutes = (int)((Button)s!).Tag!; Reload(); };
            top.Controls.Add(b);
        }
        var refresh = new Button { Text = "새로고침", AutoSize = true };
        refresh.Click += (_, _) => Reload();
        top.Controls.Add(refresh);

        _chart.Dock = DockStyle.Fill;
        _stats.Dock = DockStyle.Bottom;
        _stats.Height = 30;
        _stats.TextAlign = ContentAlignment.MiddleLeft;
        _stats.Padding = new Padding(10, 0, 0, 0);
        _stats.BackColor = Color.FromArgb(245, 246, 248);

        Controls.Add(_chart);
        Controls.Add(_stats);
        Controls.Add(top);

        Load += (_, _) => Reload();
    }

    private void Reload()
    {
        var now = DateTime.UtcNow;
        var since = now.AddMinutes(-_rangeMinutes);
        // DB 가 시간 버킷으로 집계한다 — 원시 행을 상한으로 자르지 않으므로 365일도 전 기간을 덮는다(v1.1 까지는
        // 최근 2만 건 ≈ 60초 주기 14일만 보였다). 버킷마다 위험 건수를 남겨 단발 장애가 다운샘플로 사라지지 않는다.
        var bucketSec = HistoryRules.BucketSecFor(_rangeMinutes);
        var buckets = _db.HistoryBuckets(_ep.Id, since, bucketSec);
        _chart.SetData(buckets, since, now);

        var sum = HistoryRules.Summarize(buckets);
        if (sum.Count == 0) { _stats.Text = "이 기간에 데이터가 없습니다."; return; }
        var lastErr = _db.LastError(_ep.Id, since);
        var unit = bucketSec >= 3600 ? $"{bucketSec / 3600}시간" : bucketSec >= 60 ? $"{bucketSec / 60}분" : $"{bucketSec}초";
        var avg = sum.AvgResponseMs is double a ? $"{a:F0}ms" : "—";
        var mx = sum.MaxResponseMs is double m ? $"{m:F0}ms" : "—";
        _stats.Text = $"샘플 {sum.Count} · 정상률 {sum.UptimePct:F1}% · 위험 {sum.Down} · 주의 {sum.Warn} · 평균 응답 {avg} · 최대 {mx} · 차트 {unit} 단위"
                      + (lastErr != null ? $"   ·   최근 오류: {lastErr}" : "");
    }

    /// <summary>응답지연 + 상태 색상 차트(커스텀 페인트). 점 = 버킷 평균, 세로 선 = 버킷 최대, 빨간 세로 표식 = 위험 포함 버킷.</summary>
    private sealed class ChartPanel : Panel
    {
        private List<HistoryBucket> _data = new();
        private DateTime _t0, _t1;

        public ChartPanel()
        {
            DoubleBuffered = true;
            BackColor = Color.White;
        }

        public void SetData(List<HistoryBucket> data, DateTime t0, DateTime t1)
        {
            _data = data;
            _t0 = t0;
            _t1 = t1;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int padL = 48, padR = 14, padT = 14, padB = 26;
            int w = Width - padL - padR, h = Height - padT - padB;
            if (w <= 10 || h <= 10) return;

            using var axis = new Pen(Color.FromArgb(230, 232, 235));
            var withResp = _data.Where(d => d.MaxResponseMs.HasValue).ToList();
            double maxMs = withResp.Count > 0 ? Math.Max(1, withResp.Max(d => d.MaxResponseMs!.Value)) : 1;
            maxMs *= 1.15;
            long span = Math.Max(1, (_t1 - _t0).Ticks);

            // y축 격자 + 라벨
            for (int i = 0; i <= 4; i++)
            {
                float yy = padT + h * (i / 4f);
                g.DrawLine(axis, padL, yy, padL + w, yy);
                var v = maxMs * (1 - i / 4f);
                using var br = new SolidBrush(Color.Gray);
                g.DrawString($"{v:F0}ms", Font, br, 2, yy - 7);
            }

            if (_data.Count == 0)
            {
                using var br2 = new SolidBrush(Color.Gray);
                g.DrawString("데이터 없음", Font, br2, padL + w / 2 - 30, padT + h / 2);
                return;
            }

            float X(DateTime ts) => padL + (float)(w * Math.Clamp((ts - _t0).Ticks / (double)span, 0, 1));
            float Y(double ms) => padT + (float)(h * (1 - Math.Min(ms, maxMs) / maxMs));

            using var downPen = new Pen(Color.FromArgb(120, 214, 60, 60));
            using var rangePen = new Pen(Color.FromArgb(70, 120, 120, 130));
            foreach (var d in _data)
            {
                // 버킷 안 실제 샘플 구간의 가운데에 찍는다(버킷 경계가 조회 시작보다 앞일 수 있다).
                float x = X(d.FirstUtc + TimeSpan.FromTicks((d.LastUtc - d.FirstUtc).Ticks / 2));
                if (d.Down > 0)
                {
                    // 위험(무응답)이 한 건이라도 있는 칸 — 평균에 묻히지 않게 세로 표식.
                    g.DrawLine(downPen, x, padT, x, padT + h);
                }
                if (d.AvgResponseMs is double avg)
                {
                    if (d.MaxResponseMs is double mx && mx > avg) g.DrawLine(rangePen, x, Y(avg), x, Y(mx));
                    var color = MainForm.StatusColor(d.Worst, true);
                    using var br = new SolidBrush(color);
                    float r = d.Worst == HealthStatus.Up ? 2.2f : 3.0f;
                    float y = Y(avg);
                    g.FillEllipse(br, x - r, y - r, r * 2, r * 2);
                }
            }

            // x축 시간 라벨
            using var brx = new SolidBrush(Color.Gray);
            g.DrawString(_t0.ToLocalTime().ToString("MM-dd HH:mm", CultureInfo.InvariantCulture), Font, brx, padL, padT + h + 6);
            var endStr = _t1.ToLocalTime().ToString("MM-dd HH:mm", CultureInfo.InvariantCulture);
            var sz = g.MeasureString(endStr, Font);
            g.DrawString(endStr, Font, brx, padL + w - sz.Width, padT + h + 6);
        }
    }
}
