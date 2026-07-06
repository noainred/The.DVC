using System;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>메인 창 — 대상 목록/상태 그리드 + 도구모음. 닫기는 트레이로 숨김(App Context가 처리).</summary>
public sealed class MainForm : Form
{
    private readonly Database _db;
    private readonly MonitorService _monitor;
    private readonly DataGridView _grid = new();
    private readonly System.Windows.Forms.Timer _uiTimer = new();
    private readonly Label _summary = new();
    private volatile bool _dirty = true;
    private int _uiTick;
    private Icon? _formIcon; // SetFormIcon가 만든 직전 클론(공유 DefaultIcon 파기 방지)

    public MainForm(Database db, MonitorService monitor)
    {
        _db = db;
        _monitor = monitor;

        Text = "Horizon UAG Monitor";
        Width = 1040;
        Height = 560;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 380);
        Font = new Font("Segoe UI", 9f);

        var tool = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, Padding = new Padding(6, 2, 6, 2) };
        tool.Items.Add(new ToolStripButton("지금 전체 점검", null, (_, _) => { _monitor.CheckAllNow(); }));
        tool.Items.Add(new ToolStripButton("설정(대상 관리)", null, (_, _) => OpenSettings()));
        tool.Items.Add(new ToolStripButton("이력 보기", null, (_, _) => OpenHistory()));
        tool.Items.Add(new ToolStripButton("CSV 내보내기", null, (_, _) => ExportCsv()));
        tool.Items.Add(new ToolStripButton("새로고침", null, (_, _) => { _dirty = true; }));
        var dbBtn = new ToolStripButton("DB 위치 열기", null, (_, _) => OpenDbFolder()) { Alignment = ToolStripItemAlignment.Right };
        tool.Items.Add(dbBtn);

        _summary.Dock = DockStyle.Bottom;
        _summary.Height = 26;
        _summary.TextAlign = ContentAlignment.MiddleLeft;
        _summary.Padding = new Padding(10, 0, 0, 0);
        _summary.BackColor = Color.FromArgb(245, 246, 248);

        SetupGrid();

        Controls.Add(_grid);
        Controls.Add(_summary);
        Controls.Add(tool);

        _uiTimer.Interval = 1000;
        // dirty(점검 완료)면 즉시 갱신, 아니면 ~5초마다 갱신해 '마지막 점검 N초 전'을 최신화.
        _uiTimer.Tick += (_, _) => { if (_dirty || (++_uiTick % 5 == 0)) { _dirty = false; RefreshGrid(); } };
        _uiTimer.Start();

        _monitor.Updated += OnMonitorUpdated;
        Load += (_, _) => RefreshGrid();
    }

    private void OnMonitorUpdated()
    {
        // 백그라운드 스레드 → UI 스레드 마샬링(타이머가 처리하도록 dirty만 세팅).
        _dirty = true;
    }

    private void SetupGrid()
    {
        _grid.Dock = DockStyle.Fill;
        _grid.ReadOnly = true;
        _grid.AllowUserToAddRows = false;
        _grid.AllowUserToDeleteRows = false;
        _grid.AllowUserToResizeRows = false;
        _grid.RowHeadersVisible = false;
        _grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect;
        _grid.MultiSelect = false;
        _grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
        _grid.BackgroundColor = Color.White;
        _grid.BorderStyle = BorderStyle.None;
        _grid.EnableHeadersVisualStyles = false;
        _grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(238, 240, 243);
        _grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
        _grid.RowTemplate.Height = 30;
        _grid.CellDoubleClick += (_, e) => { if (e.RowIndex >= 0) OpenHistory(); };

        void Col(string name, string header, int fill)
            => _grid.Columns.Add(new DataGridViewTextBoxColumn { Name = name, HeaderText = header, FillWeight = fill });

        Col("status", "상태", 8);
        Col("name", "이름", 14);
        Col("dc", "데이터센터", 16);
        Col("host", "호스트:포트", 22);
        Col("http", "HTTP", 8);
        Col("connect", "연결(ms)", 9);
        Col("resp", "응답(ms)", 9);
        Col("cert", "인증서(일)", 9);
        Col("checked", "마지막 점검", 14);
    }

    private void RefreshGrid()
    {
        var snap = _monitor.Snapshot();
        _grid.SuspendLayout();
        _grid.Rows.Clear();
        foreach (var es in snap)
        {
            var e = es.Endpoint;
            var s = es.Latest;
            var idx = _grid.Rows.Add(
                StatusText(es.Status, e.Enabled),
                e.Name,
                e.Datacenter,
                $"{e.Host}:{e.Port}",
                s?.HttpStatus?.ToString(CultureInfo.InvariantCulture) ?? "—",
                s?.ConnectMs is double cm ? cm.ToString("F0", CultureInfo.InvariantCulture) : "—",
                s?.ResponseMs is double rm ? rm.ToString("F0", CultureInfo.InvariantCulture) : "—",
                s?.CertExpiryDays?.ToString(CultureInfo.InvariantCulture) ?? "—",
                s == null ? (e.Enabled ? "대기" : "비활성") : AgeText(s.TimestampUtc));
            var row = _grid.Rows[idx];
            row.Tag = e.Id;
            var color = StatusColor(es.Status, e.Enabled);
            row.Cells[0].Style.BackColor = color;
            row.Cells[0].Style.ForeColor = Color.White;
            row.Cells[0].Style.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            row.Cells[0].Style.Alignment = DataGridViewContentAlignment.MiddleCenter;
            if (!e.Enabled) row.DefaultCellStyle.ForeColor = Color.Gray;
            if (s?.Error != null) row.Cells["checked"].ToolTipText = s.Error;
        }
        _grid.ResumeLayout();
        UpdateSummary(snap);
    }

    private void UpdateSummary(System.Collections.Generic.List<EndpointStatus> snap)
    {
        var enabled = snap.Where(x => x.Endpoint.Enabled).ToList();
        int up = enabled.Count(x => x.Status == HealthStatus.Up);
        int warn = enabled.Count(x => x.Status == HealthStatus.Warn);
        int down = enabled.Count(x => x.Status == HealthStatus.Down);
        int unk = enabled.Count(x => x.Status == HealthStatus.Unknown);
        _summary.Text = $"대상 {snap.Count}개 · 활성 {enabled.Count} · 정상 {up} · 주의 {warn} · 위험 {down} · 대기 {unk}    (DB: {_db.DbPath})";
    }

    private void OpenSettings()
    {
        using var f = new SettingsForm(_db, _monitor);
        if (f.ShowDialog(this) == DialogResult.OK) { _monitor.ApplyThresholds(); _monitor.CheckAllNow(); _dirty = true; }
    }

    private void OpenHistory()
    {
        long? id = _grid.CurrentRow?.Tag as long?;
        var snap = _monitor.Snapshot();
        var ep = id != null ? snap.FirstOrDefault(x => x.Endpoint.Id == id)?.Endpoint : snap.FirstOrDefault()?.Endpoint;
        if (ep == null) { MessageBox.Show(this, "대상이 없습니다.", "이력", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
        using var f = new HistoryForm(_db, ep);
        f.ShowDialog(this);
    }

    private void ExportCsv()
    {
        using var sfd = new SaveFileDialog { Filter = "CSV (*.csv)|*.csv", FileName = $"horizon-uag-{DateTime.Now:yyyyMMdd-HHmm}.csv" };
        if (sfd.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var snap = _monitor.Snapshot();
            using var w = new System.IO.StreamWriter(sfd.FileName, false, new System.Text.UTF8Encoding(true));
            w.WriteLine("name,datacenter,host,port,status,http,connect_ms,response_ms,cert_expiry_days,last_checked_utc,error");
            foreach (var es in snap)
            {
                var e = es.Endpoint; var s = es.Latest;
                string q(string? v) => "\"" + (v ?? "").Replace("\"", "\"\"") + "\"";
                w.WriteLine(string.Join(",",
                    q(e.Name), q(e.Datacenter), q(e.Host), e.Port,
                    q(StatusText(es.Status, e.Enabled)),
                    s?.HttpStatus?.ToString(CultureInfo.InvariantCulture) ?? "",
                    s?.ConnectMs?.ToString("F0", CultureInfo.InvariantCulture) ?? "",
                    s?.ResponseMs?.ToString("F0", CultureInfo.InvariantCulture) ?? "",
                    s?.CertExpiryDays?.ToString(CultureInfo.InvariantCulture) ?? "",
                    q(s?.TimestampUtc.ToString("u", CultureInfo.InvariantCulture) ?? ""),
                    q(s?.Error)));
            }
            MessageBox.Show(this, "내보내기 완료", "CSV", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "CSV 오류", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void OpenDbFolder()
    {
        try
        {
            var dir = System.IO.Path.GetDirectoryName(_db.DbPath)!;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = dir, UseShellExecute = true });
        }
        catch { /* ignore */ }
    }

    public static string StatusText(HealthStatus s, bool enabled) => !enabled ? "비활성" : s switch
    {
        HealthStatus.Up => "정상",
        HealthStatus.Warn => "주의",
        HealthStatus.Down => "위험",
        _ => "대기",
    };

    public static Color StatusColor(HealthStatus s, bool enabled) => !enabled ? Color.Silver : s switch
    {
        HealthStatus.Up => Color.FromArgb(34, 160, 90),
        HealthStatus.Warn => Color.FromArgb(214, 158, 30),
        HealthStatus.Down => Color.FromArgb(214, 60, 60),
        _ => Color.FromArgb(150, 150, 150),
    };

    private static string AgeText(DateTime utc)
    {
        var s = (DateTime.UtcNow - utc).TotalSeconds;
        if (s < 60) return $"{s:F0}초 전";
        if (s < 3600) return $"{s / 60:F0}분 전";
        if (s < 86400) return $"{s / 3600:F0}시간 전";
        return $"{s / 86400:F0}일 전";
    }

    /// <summary>
    /// 트레이 상태 아이콘을 작업표시줄/창 아이콘에도 반영(복제해 소유권 분리).
    /// 주의: Form.Icon getter는 미지정 시 프로세스 공유 DefaultIcon을 반환하므로 그 값을
    /// Dispose하면 안 된다 — 우리가 만든 직전 클론(_formIcon)만 파기한다.
    /// </summary>
    public void SetFormIcon(Icon icon)
    {
        Icon clone;
        try { clone = (Icon)icon.Clone(); } catch { return; }
        Icon = clone;                 // 공유 DefaultIcon(getter 반환값)은 건드리지 않음
        var old = _formIcon;          // 직전에 우리가 만든 클론(최초엔 null)
        _formIcon = clone;
        if (old != null) { try { old.Dispose(); } catch { /* ignore */ } }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _monitor.Updated -= OnMonitorUpdated;
        _uiTimer.Stop();
        try { _formIcon?.Dispose(); } catch { /* ignore */ }
        base.OnFormClosed(e);
    }
}
