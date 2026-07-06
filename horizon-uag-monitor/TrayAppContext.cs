using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 트레이 상주 애플리케이션 컨텍스트 — 메인 창을 닫으면(X) 트레이로 숨고, 트레이 메뉴의
/// '종료'를 눌러야만 실제로 프로그램이 끝난다. 트레이 아이콘 색상은 전체 상태(정상/주의/위험)를 반영.
/// </summary>
public sealed class TrayAppContext : ApplicationContext
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);

    private readonly Database _db;
    private readonly MonitorService _monitor;
    private readonly MainForm _main;
    private readonly NotifyIcon _tray;
    private bool _exiting;
    private bool _balloonShown;
    private Icon? _currentIcon;
    private IntPtr _currentIconHandle = IntPtr.Zero;
    private HealthStatus _lastOverall = (HealthStatus)(-1);

    public TrayAppContext(string? dbPath = null, bool startHidden = false)
    {
        _db = new Database(dbPath);
        DefaultEndpoints.SeedIfEmpty(_db);

        _monitor = new MonitorService(_db);
        _monitor.Start();

        _tray = new NotifyIcon
        {
            Text = "Horizon UAG Monitor",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.DoubleClick += (_, _) => ShowMain();
        UpdateTrayIcon(HealthStatus.Unknown, force: true);

        _main = new MainForm(_db, _monitor);
        _main.FormClosing += MainOnFormClosing;
        _ = _main.Handle; // 핸들 미리 생성 — 백그라운드 점검 결과를 항상 UI 스레드로 마샬링 가능하게.

        _monitor.Updated += OnMonitorUpdated;

        if (!startHidden) _main.Show();
        else ShowStartupBalloon();
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("열기", null, (_, _) => ShowMain());
        menu.Items.Add("지금 전체 점검", null, (_, _) => _monitor.CheckAllNow());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("종료", null, (_, _) => ExitApp());
        return menu;
    }

    private void OnMonitorUpdated()
    {
        // 백그라운드 스레드 → UI 스레드로 마샬링해 트레이 아이콘/툴팁 갱신(핸들은 ctor에서 선생성).
        try
        {
            if (!_exiting && _main.IsHandleCreated && !_main.IsDisposed)
                _main.BeginInvoke(new Action(RefreshTray));
        }
        catch { /* 종료 경합 무시 */ }
    }

    private void RefreshTray()
    {
        if (_exiting) return;
        var overall = _monitor.OverallStatus();
        var snap = _monitor.Snapshot();
        int up = 0, warn = 0, down = 0;
        foreach (var es in snap)
        {
            if (!es.Endpoint.Enabled) continue;
            switch (es.Status)
            {
                case HealthStatus.Up: up++; break;
                case HealthStatus.Warn: warn++; break;
                case HealthStatus.Down: down++; break;
            }
        }
        _tray.Text = Truncate($"Horizon UAG: 정상 {up} / 주의 {warn} / 위험 {down}", 63);
        UpdateTrayIcon(overall);
    }

    private void UpdateTrayIcon(HealthStatus status, bool force = false)
    {
        if (!force && status == _lastOverall) return;
        _lastOverall = status;

        var color = status switch
        {
            HealthStatus.Up => Color.FromArgb(34, 160, 90),
            HealthStatus.Warn => Color.FromArgb(214, 158, 30),
            HealthStatus.Down => Color.FromArgb(214, 60, 60),
            _ => Color.FromArgb(150, 150, 150),
        };

        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var br = new SolidBrush(color);
            g.FillEllipse(br, 4, 4, 24, 24);
            using var pen = new Pen(Color.FromArgb(230, 255, 255, 255), 2);
            g.DrawEllipse(pen, 4, 4, 24, 24);
        }

        var newHandle = bmp.GetHicon();
        var newIcon = Icon.FromHandle(newHandle);
        var oldIcon = _currentIcon;
        var oldHandle = _currentIconHandle;
        _tray.Icon = newIcon;
        _currentIcon = newIcon;
        _currentIconHandle = newHandle;
        // 이전 아이콘/핸들 정리(핸들 누수 방지).
        try { oldIcon?.Dispose(); } catch { /* ignore */ }
        if (oldHandle != IntPtr.Zero) { try { DestroyIcon(oldHandle); } catch { /* ignore */ } }
        // 메인 창 아이콘도 맞춰준다(작업표시줄).
        try { if (_currentIcon != null) _main?.SetFormIcon(_currentIcon); } catch { /* ignore */ }
    }

    private void ShowMain()
    {
        if (_main.IsDisposed) return;
        _main.Show();
        if (_main.WindowState == FormWindowState.Minimized) _main.WindowState = FormWindowState.Normal;
        _main.Activate();
        _main.BringToFront();
    }

    private void MainOnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // 사용자가 X로 닫으면 종료가 아니라 트레이로 숨긴다. '종료' 메뉴만 실제 종료.
        if (_exiting) return;
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            _main.Hide();
            ShowStartupBalloon();
        }
    }

    private void ShowStartupBalloon()
    {
        if (_balloonShown) return;
        _balloonShown = true;
        try
        {
            _tray.BalloonTipTitle = "Horizon UAG Monitor";
            _tray.BalloonTipText = "트레이에서 계속 실행 중입니다. 트레이 아이콘을 두 번 클릭하면 창이 열립니다. 완전히 끝내려면 트레이 메뉴 › 종료.";
            _tray.ShowBalloonTip(4000);
        }
        catch { /* ignore */ }
    }

    private void ExitApp()
    {
        if (_exiting) return;
        _exiting = true;
        _monitor.Updated -= OnMonitorUpdated;
        try { _monitor.Stop(); } catch { /* ignore */ }
        try { _tray.Visible = false; } catch { /* ignore */ }
        try { _main.FormClosing -= MainOnFormClosing; _main.Close(); } catch { /* ignore */ }
        try { _tray.Dispose(); } catch { /* ignore */ }
        try { _currentIcon?.Dispose(); } catch { /* ignore */ }
        if (_currentIconHandle != IntPtr.Zero) { try { DestroyIcon(_currentIconHandle); } catch { /* ignore */ } }
        try { _monitor.Dispose(); } catch { /* ignore */ }
        try { _db.Dispose(); } catch { /* ignore */ }
        ExitThread();
    }
}
