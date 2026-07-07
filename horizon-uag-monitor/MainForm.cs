using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;

namespace HorizonUagMonitor;

/// <summary>
/// 메인 창 — 비주얼 대시보드(요약 헤더 + DataCenter별 상태 카드 + 스파크라인) 및
/// 상세 표(전환) 제공. 닫기는 트레이로 숨김(App Context가 처리).
/// </summary>
public sealed class MainForm : Form
{
    private readonly Database _db;
    private readonly MonitorService _monitor;

    private readonly SummaryHeader _header = new();
    private readonly Panel _content = new() { Dock = DockStyle.Fill };
    private readonly WorldMap _map = new() { Dock = DockStyle.Fill };
    private readonly FlowLayoutPanel _dashboard = new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = true, AutoScroll = true, BackColor = Color.FromArgb(243, 244, 246), Padding = new Padding(12), Visible = false };
    private readonly List<Label> _groupHeaders = new();
    private readonly DataGridView _grid = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label _summary = new();
    private readonly ToolStripButton _viewMap;
    private readonly ToolStripButton _viewCards;
    private readonly ToolStripButton _viewTable;
    private readonly System.Windows.Forms.Timer _uiTimer = new();

    private enum ViewMode { Map, Cards, Table }
    private readonly Dictionary<long, EndpointCard> _cards = new();
    private string _layoutSig = "";
    private ViewMode _view = ViewMode.Map;
    private int _sortCol = -1;      // 표 정렬 컬럼(-1=기본)
    private bool _sortAsc = true;   // 정렬 방향
    private volatile bool _dirty = true;
    private int _uiTick;
    private Icon? _formIcon;

    public MainForm(Database db, MonitorService monitor)
    {
        _db = db;
        _monitor = monitor;

        Text = "Horizon UAG Monitor";
        Width = 1080;
        Height = 640;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(820, 480);
        Font = new Font("Segoe UI", 9f);
        BackColor = Color.White;

        var tool = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, Padding = new Padding(6, 2, 6, 2), Renderer = new ToolStripProfessionalRenderer() };
        tool.Items.Add(new ToolStripButton("지금 전체 점검", null, (_, _) => _monitor.CheckAllNow()));
        tool.Items.Add(new ToolStripButton("설정(대상 관리)", null, (_, _) => OpenSettings()));
        tool.Items.Add(new ToolStripButton("이력 보기", null, (_, _) => OpenHistory()));
        tool.Items.Add(new ToolStripButton("CSV 내보내기", null, (_, _) => ExportCsv()));
        tool.Items.Add(new ToolStripButton("새로고침", null, (_, _) => { _dirty = true; }));
        tool.Items.Add(new ToolStripSeparator());
        _viewMap = new ToolStripButton("지도", null, (_, _) => SetView(ViewMode.Map)) { Checked = true };
        _viewCards = new ToolStripButton("카드", null, (_, _) => SetView(ViewMode.Cards));
        _viewTable = new ToolStripButton("표", null, (_, _) => SetView(ViewMode.Table));
        tool.Items.Add(_viewMap);
        tool.Items.Add(_viewCards);
        tool.Items.Add(_viewTable);
        tool.Items.Add(new ToolStripButton("DB 위치 열기", null, (_, _) => OpenDbFolder()) { Alignment = ToolStripItemAlignment.Right });

        _header.Dock = DockStyle.Top;
        _header.Height = 74;

        _summary.Dock = DockStyle.Bottom;
        _summary.Height = 24;
        _summary.TextAlign = ContentAlignment.MiddleLeft;
        _summary.Padding = new Padding(10, 0, 0, 0);
        _summary.ForeColor = Color.FromArgb(108, 117, 125);
        _summary.BackColor = Color.FromArgb(248, 249, 250);

        _dashboard.Resize += (_, _) => UpdateHeaderWidths();

        SetupGrid();
        _content.Controls.Add(_map);
        _content.Controls.Add(_dashboard);
        _content.Controls.Add(_grid);

        Controls.Add(_content);
        Controls.Add(_summary);
        Controls.Add(_header);
        Controls.Add(tool);

        _uiTimer.Interval = 1000;
        _uiTimer.Tick += (_, _) => { if (_dirty || (++_uiTick % 5 == 0)) { _dirty = false; RefreshAll(); } };
        _uiTimer.Start();

        LoadUserLocation();
        LoadMapOverrides();
        LoadMapShow();
        _map.SiteMoved += OnSiteMoved;
        _monitor.Updated += OnMonitorUpdated;
        Load += (_, _) => RefreshAll();
    }

    private void LoadMapShow() => _map.SetShow(_db.GetSetting("mapShow") ?? "both");

    // ── 지도 마커 수동 재배치 위치(드래그) 저장/복원 ──────────────────────────
    private Dictionary<string, (double Lat, double Lon)> _mapOverrides = new(StringComparer.OrdinalIgnoreCase);

    private void LoadMapOverrides()
    {
        _mapOverrides = ParseOverrides(_db.GetSetting("mapPositions"));
        _map.SetOverrides(_mapOverrides);
    }

    private void OnSiteMoved(string code, double lat, double lon)
    {
        _mapOverrides[code] = (lat, lon);
        _db.SetSetting("mapPositions", SerializeOverrides(_mapOverrides));
        _map.SetOverrides(_mapOverrides);
    }

    private static Dictionary<string, (double Lat, double Lon)> ParseOverrides(string? json)
    {
        var d = new Dictionary<string, (double Lat, double Lon)>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrWhiteSpace(json)) return d;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return d;
            foreach (var p in doc.RootElement.EnumerateObject())
            {
                var a = p.Value;
                if (a.ValueKind == System.Text.Json.JsonValueKind.Array && a.GetArrayLength() >= 2
                    && a[0].ValueKind == System.Text.Json.JsonValueKind.Number && a[1].ValueKind == System.Text.Json.JsonValueKind.Number)
                    d[p.Name] = (a[0].GetDouble(), a[1].GetDouble());
            }
        }
        catch { /* 손상 시 무시 */ }
        return d;
    }

    private static string SerializeOverrides(Dictionary<string, (double Lat, double Lon)> d)
    {
        using var ms = new System.IO.MemoryStream();
        using (var w = new System.Text.Json.Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            foreach (var kv in d)
            {
                w.WritePropertyName(kv.Key);
                w.WriteStartArray();
                w.WriteNumberValue(kv.Value.Lat);
                w.WriteNumberValue(kv.Value.Lon);
                w.WriteEndArray();
            }
            w.WriteEndObject();
        }
        return System.Text.Encoding.UTF8.GetString(ms.ToArray());
    }

    private void OnMonitorUpdated() => _dirty = true;

    private void SetView(ViewMode v)
    {
        _view = v;
        _viewMap.Checked = v == ViewMode.Map;
        _viewCards.Checked = v == ViewMode.Cards;
        _viewTable.Checked = v == ViewMode.Table;
        _map.Visible = v == ViewMode.Map;
        _dashboard.Visible = v == ViewMode.Cards;
        _grid.Visible = v == ViewMode.Table;
        _dirty = true;
    }

    /// <summary>DB 설정에서 사용자(매니저) 위치를 읽어 지도에 반영.</summary>
    private void LoadUserLocation()
    {
        double lat = ParseD(_db.GetSetting("userLat"));
        double lon = ParseD(_db.GetSetting("userLon"));
        var label = _db.GetSetting("userCity") ?? "내 위치";
        _map.SetUser(lat, lon, string.IsNullOrWhiteSpace(label) ? "내 위치" : label);
    }

    private static double ParseD(string? s) => double.TryParse(s, System.Globalization.NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0;

    // ── 공통 새로고침 ─────────────────────────────────────────────────────────
    private void RefreshAll()
    {
        var snap = _monitor.Snapshot();
        UpdateHeader(snap);
        switch (_view)
        {
            case ViewMode.Map: _map.SetData(snap); break;
            case ViewMode.Cards: RefreshDashboard(snap); break;
            case ViewMode.Table: RefreshGrid(snap); break;
        }
        _summary.Text = $"DB: {_db.DbPath}";
    }

    private void UpdateHeader(List<EndpointStatus> snap)
    {
        var en = snap.Where(x => x.Endpoint.Enabled).ToList();
        _header.SetCounts(
            en.Count(x => x.Status == HealthStatus.Up),
            en.Count(x => x.Status == HealthStatus.Warn),
            en.Count(x => x.Status == HealthStatus.Down),
            en.Count(x => x.Status == HealthStatus.Unknown),
            snap.Count);
    }

    // ── 카드 대시보드 ─────────────────────────────────────────────────────────
    private void RefreshDashboard(List<EndpointStatus> snap)
    {
        var recent = _db.RecentSamplesAll(snap.Select(x => x.Endpoint.Id), 40);
        var sig = string.Join("|", snap.Select(x => x.Endpoint.Id + ":" + x.Endpoint.Datacenter));
        if (sig != _layoutSig) { RebuildDashboard(snap); _layoutSig = sig; }
        foreach (var es in snap)
            if (_cards.TryGetValue(es.Endpoint.Id, out var card))
                card.SetData(es, recent.TryGetValue(es.Endpoint.Id, out var r) ? r : new List<Sample>());
    }

    private void RebuildDashboard(List<EndpointStatus> snap)
    {
        _dashboard.SuspendLayout();
        // 반복 중 컬렉션 변경 방지 — 사본으로 순회하며 파기(자식 카드도 함께 파기됨).
        var old = _dashboard.Controls.Cast<Control>().ToList();
        _dashboard.Controls.Clear();
        foreach (var c in old) c.Dispose();
        _cards.Clear();
        _groupHeaders.Clear();

        if (snap.Count == 0)
        {
            _dashboard.Controls.Add(new Label
            {
                Text = "등록된 대상이 없습니다. 상단 '설정(대상 관리)'에서 UAG 주소를 추가/활성화하세요.",
                AutoSize = true, ForeColor = Color.Gray, Margin = new Padding(8, 20, 8, 8),
            });
            _dashboard.ResumeLayout();
            return;
        }

        // 데이터센터별로 그룹(등장 순서 보존). 각 그룹 헤더는 한 줄 전체를 차지(FlowBreak).
        var groups = new List<string>();
        var byDc = new Dictionary<string, List<EndpointStatus>>();
        foreach (var es in snap)
        {
            var dc = string.IsNullOrWhiteSpace(es.Endpoint.Datacenter) ? "미지정" : es.Endpoint.Datacenter;
            if (!byDc.ContainsKey(dc)) { byDc[dc] = new List<EndpointStatus>(); groups.Add(dc); }
            byDc[dc].Add(es);
        }

        foreach (var dc in groups)
        {
            var header = new Label
            {
                Text = dc, AutoSize = false, Height = 30, Font = new Font("Segoe UI", 11f, FontStyle.Bold),
                ForeColor = Color.FromArgb(52, 58, 64), TextAlign = ContentAlignment.BottomLeft,
                Margin = new Padding(4, 8, 4, 2),
            };
            _dashboard.Controls.Add(header);
            _dashboard.SetFlowBreak(header, true); // 헤더 다음 카드는 새 줄부터
            _groupHeaders.Add(header);

            EndpointCard? last = null;
            foreach (var es in byDc[dc])
            {
                var card = new EndpointCard { Tag = es.Endpoint.Id };
                card.Click += (s, _) => OpenHistoryFor((long)((Control)s!).Tag!);
                _cards[es.Endpoint.Id] = card;
                _dashboard.Controls.Add(card);
                last = card;
            }
            if (last != null) _dashboard.SetFlowBreak(last, true); // 그룹 끝 → 다음 헤더는 새 줄
        }
        _dashboard.ResumeLayout();
        UpdateHeaderWidths();
    }

    // 그룹 헤더가 항상 한 줄 전체를 차지하도록 폭을 대시보드 클라이언트 폭에 맞춘다.
    private void UpdateHeaderWidths()
    {
        int w = _dashboard.ClientSize.Width - _dashboard.Padding.Horizontal - 8;
        if (w < 100) w = 100;
        foreach (var h in _groupHeaders) h.Width = w - h.Margin.Horizontal;
    }

    // ── 상세 표 ───────────────────────────────────────────────────────────────
    private void SetupGrid()
    {
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
        Col("name", "이름", 13);
        Col("type", "유형", 7);
        Col("dc", "데이터센터", 14);
        Col("host", "호스트:포트", 22);
        Col("http", "HTTP", 8);
        Col("connect", "연결(ms)", 9);
        Col("resp", "응답(ms)", 9);
        Col("cert", "인증서(일)", 9);
        Col("checked", "마지막 점검", 14);
        // 제목 클릭 정렬(오름/내림 토글). 자동 새로고침에도 유지되도록 데이터 정렬 방식 사용.
        foreach (DataGridViewColumn c in _grid.Columns) c.SortMode = DataGridViewColumnSortMode.NotSortable;
        _grid.ColumnHeaderMouseClick += (_, e) => OnHeaderClick(e.ColumnIndex);
    }

    private void OnHeaderClick(int col)
    {
        if (col < 0) return;
        if (_sortCol == col) _sortAsc = !_sortAsc; else { _sortCol = col; _sortAsc = true; }
        foreach (DataGridViewColumn c in _grid.Columns) c.HeaderCell.SortGlyphDirection = SortOrder.None;
        _grid.Columns[col].HeaderCell.SortGlyphDirection = _sortAsc ? SortOrder.Ascending : SortOrder.Descending;
        _dirty = true;
    }

    private List<EndpointStatus> SortSnap(List<EndpointStatus> snap)
    {
        if (_sortCol < 0) return snap;
        bool numeric = _sortCol is 0 or 5 or 6 or 7 or 8 or 9;
        double sentinel = _sortAsc ? double.PositiveInfinity : double.NegativeInfinity;
        if (numeric)
        {
            double Key(EndpointStatus es)
            {
                var s = es.Latest;
                return _sortCol switch
                {
                    0 => SeverityRank(es.Status, es.Endpoint.Enabled),
                    5 => s?.HttpStatus ?? sentinel,
                    6 => s?.ConnectMs ?? sentinel,
                    7 => s?.ResponseMs ?? sentinel,
                    8 => s?.CertExpiryDays ?? sentinel,
                    9 => s != null ? s.TimestampUtc.Ticks : sentinel,
                    _ => 0,
                };
            }
            return (_sortAsc ? snap.OrderBy(Key) : snap.OrderByDescending(Key)).ToList();
        }
        string SKey(EndpointStatus es)
        {
            var e = es.Endpoint;
            return _sortCol switch
            {
                1 => e.Name, 2 => e.Type, 3 => e.Datacenter, 4 => $"{e.Scheme}://{e.Host}:{e.Port}", _ => e.Name,
            } ?? "";
        }
        return (_sortAsc ? snap.OrderBy(SKey, StringComparer.OrdinalIgnoreCase) : snap.OrderByDescending(SKey, StringComparer.OrdinalIgnoreCase)).ToList();
    }

    private static int SeverityRank(HealthStatus s, bool enabled) => !enabled ? 0 : s switch
    {
        HealthStatus.Down => 4, HealthStatus.Warn => 3, HealthStatus.Up => 2, _ => 1,
    };

    private void RefreshGrid(List<EndpointStatus> snap)
    {
        snap = SortSnap(snap); // 현재 정렬 컬럼/방향으로 정렬(자동 새로고침에도 유지)
        _grid.SuspendLayout();
        _grid.Rows.Clear();
        foreach (var es in snap)
        {
            var e = es.Endpoint; var s = es.Latest;
            var idx = _grid.Rows.Add(
                StatusText(es.Status, e.Enabled), e.Name, e.Type, e.Datacenter, $"{e.Scheme}://{e.Host}:{e.Port}",
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
    }

    // ── 액션 ──────────────────────────────────────────────────────────────────
    private void OpenSettings()
    {
        using var f = new SettingsForm(_db, _monitor);
        if (f.ShowDialog(this) == DialogResult.OK) { _monitor.ApplyThresholds(); LoadUserLocation(); LoadMapShow(); _monitor.CheckAllNow(); _layoutSig = ""; _dirty = true; }
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

    private void OpenHistoryFor(long id)
    {
        var ep = _monitor.Snapshot().FirstOrDefault(x => x.Endpoint.Id == id)?.Endpoint;
        if (ep == null) return;
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
                    q(e.Name), q(e.Datacenter), q(e.Host), e.Port, q(StatusText(es.Status, e.Enabled)),
                    s?.HttpStatus?.ToString(CultureInfo.InvariantCulture) ?? "",
                    s?.ConnectMs?.ToString("F0", CultureInfo.InvariantCulture) ?? "",
                    s?.ResponseMs?.ToString("F0", CultureInfo.InvariantCulture) ?? "",
                    s?.CertExpiryDays?.ToString(CultureInfo.InvariantCulture) ?? "",
                    q(s?.TimestampUtc.ToString("u", CultureInfo.InvariantCulture) ?? ""), q(s?.Error)));
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

    // ── 상태 색/텍스트(공용) ─────────────────────────────────────────────────
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

    /// <summary>트레이 상태 아이콘을 작업표시줄/창 아이콘에도 반영(공유 DefaultIcon 파기 방지).</summary>
    public void SetFormIcon(Icon icon)
    {
        Icon clone;
        try { clone = (Icon)icon.Clone(); } catch { return; }
        Icon = clone;
        var old = _formIcon;
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

    /// <summary>상단 요약 헤더 — 제목 + 상태 카운트 알약(pill)을 직접 그린다.</summary>
    private sealed class SummaryHeader : Panel
    {
        private static readonly Font FTitle = new("Segoe UI", 14f, FontStyle.Bold);
        private static readonly Font FSub = new("Segoe UI", 8.5f);
        private static readonly Font FPill = new("Segoe UI", 9.5f, FontStyle.Bold);
        private int _up, _warn, _down, _unknown, _total;

        public SummaryHeader() { DoubleBuffered = true; BackColor = Color.FromArgb(33, 41, 54); }

        public void SetCounts(int up, int warn, int down, int unknown, int total)
        {
            _up = up; _warn = warn; _down = down; _unknown = unknown; _total = total;
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            using var white = new SolidBrush(Color.White);
            using var sub = new SolidBrush(Color.FromArgb(173, 181, 189));
            g.DrawString("Horizon UAG Monitor", FTitle, white, 16, 12);
            g.DrawString($"전세계 데이터센터 UAG / Virtual App 포탈 443 상태  ·  대상 {_total}개", FSub, sub, 18, 44);

            // 오른쪽에서 왼쪽으로 알약 배치.
            var pills = new (string Label, int Count, Color Color)[]
            {
                ("정상", _up, StatusColor(HealthStatus.Up, true)),
                ("주의", _warn, StatusColor(HealthStatus.Warn, true)),
                ("위험", _down, StatusColor(HealthStatus.Down, true)),
                ("대기", _unknown, StatusColor(HealthStatus.Unknown, true)),
            };
            float x = Width - 16;
            for (int i = pills.Length - 1; i >= 0; i--)
            {
                var p = pills[i];
                var text = $"{p.Label} {p.Count}";
                var sz = g.MeasureString(text, FPill);
                float pw = sz.Width + 26, ph = 30, py = (Height - ph) / 2f;
                x -= pw;
                var rect = new RectangleF(x, py, pw, ph);
                using (var br = new SolidBrush(p.Color)) FillRoundedRect(g, rect, 15, br);
                g.DrawString(text, FPill, white, x + 13, py + (ph - sz.Height) / 2f);
                x -= 8;
            }
        }

        private static void FillRoundedRect(Graphics g, RectangleF r, float radius, Brush brush)
        {
            using var path = new GraphicsPath();
            float d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            g.FillPath(brush, path);
        }
    }
}
