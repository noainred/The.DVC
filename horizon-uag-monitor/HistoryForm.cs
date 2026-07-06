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
    private int _rangeDays = 1;

    private static readonly (string Label, int Days)[] Ranges =
    {
        ("1일", 1), ("7일", 7), ("30일", 30), ("90일", 90), ("365일", 365),
    };

    public HistoryForm(Database db, Endpoint ep)
    {
        _db = db;
        _ep = ep;
        Text = $"이력 — {ep.Name} ({ep.Host}:{ep.Port})";
        Width = 900;
        Height = 520;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9f);

        var top = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(6) };
        foreach (var (label, days) in Ranges)
        {
            var b = new Button { Text = label, AutoSize = true, Tag = days };
            b.Click += (s, _) => { _rangeDays = (int)((Button)s!).Tag!; Reload(); };
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
        var since = DateTime.UtcNow.AddDays(-_rangeDays);
        var rows = _db.History(_ep.Id, since);
        // 과다 시 스트라이드 다운샘플(최대 ~1500점).
        const int max = 1500;
        List<Sample> pts = rows;
        if (rows.Count > max)
        {
            var stride = (int)Math.Ceiling(rows.Count / (double)max);
            pts = rows.Where((_, i) => i % stride == 0).ToList();
        }
        _chart.SetData(pts, DateTime.UtcNow.AddDays(-_rangeDays), DateTime.UtcNow);

        if (rows.Count == 0) { _stats.Text = "이 기간에 데이터가 없습니다."; return; }
        var resp = rows.Where(r => r.ResponseMs.HasValue).Select(r => r.ResponseMs!.Value).ToList();
        int up = rows.Count(r => r.Status == HealthStatus.Up);
        int down = rows.Count(r => r.Status == HealthStatus.Down);
        var avg = resp.Count > 0 ? resp.Average() : 0;
        var mx = resp.Count > 0 ? resp.Max() : 0;
        var uptime = rows.Count > 0 ? 100.0 * up / rows.Count : 0;
        var lastErr = rows.LastOrDefault(r => !string.IsNullOrEmpty(r.Error))?.Error;
        _stats.Text = $"샘플 {rows.Count} · 정상률 {uptime:F1}% · 위험 {down} · 평균 응답 {avg:F0}ms · 최대 {mx:F0}ms"
                      + (lastErr != null ? $"   ·   최근 오류: {lastErr}" : "");
    }

    /// <summary>응답지연 산점 + 상태 색상 차트(커스텀 페인트).</summary>
    private sealed class ChartPanel : Panel
    {
        private List<Sample> _data = new();
        private DateTime _t0, _t1;

        public ChartPanel()
        {
            DoubleBuffered = true;
            BackColor = Color.White;
        }

        public void SetData(List<Sample> data, DateTime t0, DateTime t1)
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
            var withResp = _data.Where(d => d.ResponseMs.HasValue).ToList();
            double maxMs = withResp.Count > 0 ? Math.Max(1, withResp.Max(d => d.ResponseMs!.Value)) : 1;
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

            float X(DateTime ts) => padL + (float)(w * ((ts - _t0).Ticks / (double)span));
            float Y(double ms) => padT + (float)(h * (1 - Math.Min(ms, maxMs) / maxMs));

            foreach (var d in _data)
            {
                float x = X(d.TimestampUtc);
                var color = MainForm.StatusColor(d.Status, true);
                if (d.ResponseMs.HasValue)
                {
                    float y = Y(d.ResponseMs.Value);
                    using var br = new SolidBrush(color);
                    float r = d.Status == HealthStatus.Up ? 2.2f : 3.0f;
                    g.FillEllipse(br, x - r, y - r, r * 2, r * 2);
                }
                else
                {
                    // 무응답(Down): 하단에 빨강 세로 표식
                    using var pen = new Pen(Color.FromArgb(120, 214, 60, 60));
                    g.DrawLine(pen, x, padT, x, padT + h);
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
