using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Win32;

namespace HorizonUagMonitor;

/// <summary>설정 — 모니터링 대상(UAG/포탈) 추가·수정·삭제, 임계값, 시작 시 자동 실행.</summary>
public sealed class SettingsForm : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "HorizonUagMonitor";

    private readonly Database _db;
    private readonly MonitorService _monitor;
    private readonly ListView _list = new();
    private readonly NumericUpDown _certWarn = new();
    private readonly NumericUpDown _latency = new();
    private readonly NumericUpDown _retention = new();
    private readonly CheckBox _autostart = new();
    private readonly TextBox _userCity = new();
    private readonly TextBox _userLat = new();
    private readonly TextBox _userLon = new();
    private readonly ComboBox _mapShow = new();
    // 알람
    private readonly CheckBox _alarmOn = new();
    private readonly RadioButton[] _edgeBtns = new RadioButton[4];
    private readonly NumericUpDown _alarmThick = new();
    private readonly NumericUpDown _alarmLen = new();
    private readonly NumericUpDown _alarmBlink = new();
    private AlarmOverlay? _preview;
    private System.Windows.Forms.Timer? _previewTimer;
    // 데이터·로그 폴더
    private readonly TextBox _dataDir = new();
    private readonly string _currentDir;

    public SettingsForm(Database db, MonitorService monitor)
    {
        _db = db;
        _monitor = monitor;
        Text = "설정";
        Width = 820;
        Height = 760;
        StartPosition = FormStartPosition.CenterParent;
        Font = Theme.F(9.5f);
        BackColor = Theme.Page;
        MinimizeBox = false;

        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.GridLines = true;
        _list.Dock = DockStyle.Top;
        _list.Height = 300;
        _list.Columns.Add("이름", 120);
        _list.Columns.Add("유형", 55);
        _list.Columns.Add("데이터센터", 110);
        _list.Columns.Add("주소", 210);
        _list.Columns.Add("경로", 80);
        _list.Columns.Add("주기(s)", 55);
        _list.Columns.Add("활성", 50);
        _list.DoubleClick += (_, _) => EditSelected();

        var btns = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(4) };
        btns.Controls.Add(MakeBtn("추가", (_, _) => AddNew()));
        btns.Controls.Add(MakeBtn("수정", (_, _) => EditSelected()));
        btns.Controls.Add(MakeBtn("삭제", (_, _) => DeleteSelected()));
        btns.Controls.Add(MakeBtn("기본 12개 데이터센터 채우기", (_, _) => SeedDefaults()));
        btns.Controls.Add(MakeBtn("JSON 가져오기", (_, _) => ImportJson()));
        btns.Controls.Add(MakeBtn("JSON 내보내기", (_, _) => ExportJson()));

        var thresh = new TableLayoutPanel { Dock = DockStyle.Top, Height = 224, ColumnCount = 2, Padding = new Padding(8) };
        thresh.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 200));
        thresh.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        thresh.Controls.Add(new Label { Text = "인증서 경고 임계(일 이하)", AutoSize = true }, 0, 0);
        _certWarn.Minimum = 1; _certWarn.Maximum = 365; _certWarn.Value = Clamp(_db.GetIntSetting("certWarnDays", 30), 1, 365);
        thresh.Controls.Add(_certWarn, 1, 0);
        thresh.Controls.Add(new Label { Text = "응답 지연 경고(ms 이상)", AutoSize = true }, 0, 1);
        _latency.Minimum = 100; _latency.Maximum = 60000; _latency.Increment = 100; _latency.Value = Clamp(_db.GetIntSetting("warnLatencyMs", 3000), 100, 60000);
        thresh.Controls.Add(_latency, 1, 1);
        thresh.Controls.Add(new Label { Text = "이력 보존(일, 0=무제한)", AutoSize = true }, 0, 2);
        _retention.Minimum = 0; _retention.Maximum = 3650; _retention.Value = Clamp(_db.GetIntSetting("retentionDays", 365), 0, 3650);
        thresh.Controls.Add(_retention, 1, 2);
        // 내 위치(사용자/매니저 위치) — 지도에 사용자 마커 + 사이트별 RTT 기준
        thresh.Controls.Add(new Label { Text = "내 위치 도시(→ 좌표찾기)", AutoSize = true }, 0, 3);
        var uCell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, Height = 26, Margin = new Padding(0) };
        uCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 40));
        uCell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        uCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        uCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        _userCity.Text = _db.GetSetting("userCity") ?? "";
        _userLat.Text = _db.GetSetting("userLat") ?? "";
        _userLon.Text = _db.GetSetting("userLon") ?? "";
        _userCity.Dock = DockStyle.Fill; _userLat.Dock = DockStyle.Fill; _userLon.Dock = DockStyle.Fill;
        _userLat.Margin = new Padding(4, 0, 2, 0); _userLon.Margin = new Padding(2, 0, 0, 0);
        var uFind = new Button { Text = "좌표찾기", Dock = DockStyle.Fill, Margin = new Padding(4, 0, 0, 0) };
        uFind.Click += (_, _) => LookupUserCity();
        uCell.Controls.Add(_userCity, 0, 0);
        uCell.Controls.Add(uFind, 1, 0);
        uCell.Controls.Add(_userLat, 2, 0);
        uCell.Controls.Add(_userLon, 3, 0);
        thresh.Controls.Add(uCell, 1, 3);
        thresh.Controls.Add(new Label { Text = "(위도, 경도 직접 입력 가능)", AutoSize = true, ForeColor = System.Drawing.Color.Gray }, 1, 4);
        // 지도 RTT 표시 모드
        thresh.Controls.Add(new Label { Text = "지도 RTT 표시", AutoSize = true }, 0, 5);
        _mapShow.DropDownStyle = ComboBoxStyle.DropDownList;
        _mapShow.Items.AddRange(new object[] { "둘 다 (UAG+포탈)", "UAG만", "포탈만" });
        var showCur = _db.GetSetting("mapShow") ?? "both";
        _mapShow.SelectedIndex = showCur == "uag" ? 1 : showCur == "portal" ? 2 : 0;
        _mapShow.Width = 200;
        thresh.Controls.Add(_mapShow, 1, 5);
        _autostart.Text = "Windows 시작 시 자동 실행(현재 사용자)";
        _autostart.AutoSize = true;
        _autostart.Checked = IsAutostartEnabled();
        thresh.Controls.Add(_autostart, 0, 6);

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
        var ok = MakeBtn("저장", (_, _) => Save());
        Theme.StyleButton(ok, primary: true);
        ok.DialogResult = DialogResult.None;
        var cancel = MakeBtn("닫기", (_, _) => { DialogResult = DialogResult.Cancel; Close(); });
        bottom.Controls.Add(ok);
        bottom.Controls.Add(cancel);

        // 탭: 대상 관리(기존 화면 그대로) · 알람 · 데이터·로그 폴더. 아래 버튼줄은 모든 탭이 공유한다.
        var pgTargets = new TabPage("대상 관리 · 임계값");
        pgTargets.Controls.Add(_list);
        pgTargets.Controls.Add(btns);
        pgTargets.Controls.Add(thresh);
        var pgAlarm = new TabPage("알람") { Padding = new Padding(12) };
        BuildAlarmPage(pgAlarm);
        var pgData = new TabPage("데이터·로그 폴더") { Padding = new Padding(12) };
        _currentDir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(_db.DbPath))!;
        BuildDataPage(pgData);
        var tabs = new TabControl { Dock = DockStyle.Fill };
        tabs.TabPages.Add(pgTargets);
        tabs.TabPages.Add(pgAlarm);
        tabs.TabPages.Add(pgData);
        Controls.Add(tabs);
        Controls.Add(bottom);
        FormClosed += (_, _) => ClosePreview();

        LoadList();
    }

    private static Button MakeBtn(string text, EventHandler onClick)
    {
        var b = new Button { Text = text, AutoSize = true, Margin = new Padding(3, 3, 3, 3) };
        Theme.StyleButton(b);
        b.Click += onClick;
        return b;
    }

    private static int Clamp(int v, int lo, int hi) => Math.Max(lo, Math.Min(hi, v));

    private void LoadList()
    {
        _list.Items.Clear();
        foreach (var e in _db.ListEndpoints())
        {
            var it = new ListViewItem(new[] { e.Name, e.Type, e.Datacenter, $"{e.Scheme}://{e.Host}:{e.Port}", e.Path, e.IntervalSec.ToString(CultureInfo.InvariantCulture), e.Enabled ? "예" : "아니오" })
            { Tag = e };
            _list.Items.Add(it);
        }
    }

    private Endpoint? Selected() => _list.SelectedItems.Count > 0 ? _list.SelectedItems[0].Tag as Endpoint : null;

    private void AddNew()
    {
        var e = new Endpoint { Name = "새 UAG", Datacenter = "", Host = "", Port = 443, Path = "/", IntervalSec = 60, TimeoutMs = 5000, Enabled = true, Sort = _db.ListEndpoints().Count };
        using var dlg = new EndpointEditForm(e);
        if (dlg.ShowDialog(this) == DialogResult.OK) { _db.UpsertEndpoint(e); LoadList(); }
    }

    private void EditSelected()
    {
        var e = Selected();
        if (e == null) return;
        using var dlg = new EndpointEditForm(e);
        if (dlg.ShowDialog(this) == DialogResult.OK) { _db.UpsertEndpoint(e); LoadList(); }
    }

    private void DeleteSelected()
    {
        var e = Selected();
        if (e == null) return;
        if (MessageBox.Show(this, $"'{e.Name}' 대상과 이력을 삭제할까요?", "삭제", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        _db.DeleteEndpoint(e.Id);
        LoadList();
    }

    private void SeedDefaults()
    {
        if (MessageBox.Show(this, "기본 12개 데이터센터 대상을 추가합니다(자리표시자 주소, 비활성). 계속할까요?", "기본 채우기", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        var existing = _db.ListEndpoints().Select(x => (x.Name + "|" + x.Host).ToLowerInvariant()).ToHashSet();
        var sort = _db.ListEndpoints().Count;
        foreach (var e in DefaultEndpoints.Build())
        {
            if (existing.Contains((e.Name + "|" + e.Host).ToLowerInvariant())) continue;
            e.Sort = sort++;
            _db.UpsertEndpoint(e);
        }
        LoadList();
    }

    // ── JSON 가져오기/내보내기(실서버 대량 등록용) ─────────────────────────────
    // 단일 파일(self-contained) 배포에서도 안전하도록 리플렉션 직렬화(System.Text.Json 자동)를
    // 쓰지 않고 Utf8JsonWriter/JsonDocument로 직접 처리한다.
    private void ExportJson()
    {
        using var sfd = new SaveFileDialog { Filter = "JSON (*.json)|*.json", FileName = "horizon-uag-endpoints.json" };
        if (sfd.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var list = _db.ListEndpoints();
            var opts = new System.Text.Json.JsonWriterOptions { Indented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
            using (var stream = System.IO.File.Create(sfd.FileName))
            using (var w = new System.Text.Json.Utf8JsonWriter(stream, opts))
            {
                w.WriteStartArray();
                foreach (var e in list)
                {
                    w.WriteStartObject();
                    w.WriteString("name", e.Name);
                    w.WriteString("type", e.Type);
                    w.WriteString("datacenter", e.Datacenter);
                    w.WriteString("scheme", e.Scheme);
                    w.WriteString("host", e.Host);
                    w.WriteNumber("port", e.Port);
                    w.WriteString("path", e.Path);
                    w.WriteString("matchText", e.MatchText);
                    w.WriteString("city", e.City);
                    w.WriteString("region", e.Region);
                    w.WriteNumber("lat", e.Lat);
                    w.WriteNumber("lon", e.Lon);
                    w.WriteNumber("intervalSec", e.IntervalSec);
                    w.WriteNumber("timeoutMs", e.TimeoutMs);
                    w.WriteBoolean("enabled", e.Enabled);
                    w.WriteNumber("sort", e.Sort);
                    w.WriteEndObject();
                }
                w.WriteEndArray();
                w.Flush();
            }
            MessageBox.Show(this, $"내보내기 완료 — {list.Count}건\n{sfd.FileName}", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, $"내보내기 실패:\n{ex}", "내보내기 오류", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void ImportJson()
    {
        using var ofd = new OpenFileDialog { Filter = "JSON (*.json)|*.json" };
        if (ofd.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var json = System.IO.File.ReadAllText(ofd.FileName);
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != System.Text.Json.JsonValueKind.Array) { MessageBox.Show(this, "JSON 최상위가 배열이어야 합니다.", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            var existing = _db.ListEndpoints().ToDictionary(x => Key(x), x => x.Id);
            int added = 0, updated = 0, sort = _db.ListEndpoints().Count;
            foreach (var o in root.EnumerateArray())
            {
                if (o.ValueKind != System.Text.Json.JsonValueKind.Object) continue;
                var host = Str(o, "host");
                if (string.IsNullOrWhiteSpace(host)) continue;
                var e = new Endpoint
                {
                    Name = Str(o, "name", host),
                    Type = Str(o, "type", "UAG"),
                    Datacenter = Str(o, "datacenter"),
                    Scheme = string.Equals(Str(o, "scheme", "https"), "http", StringComparison.OrdinalIgnoreCase) ? "http" : "https",
                    Host = host,
                    Port = ClampPort(Int(o, "port", 443)),
                    Path = NormPath(Str(o, "path", "/")),
                    MatchText = Str(o, "matchText"),
                    City = Str(o, "city"),
                    Region = Str(o, "region"),
                    Lat = Dbl(o, "lat", 0),
                    Lon = Dbl(o, "lon", 0),
                    IntervalSec = Math.Max(5, Int(o, "intervalSec", 60)),
                    TimeoutMs = Math.Max(1000, Int(o, "timeoutMs", 5000)),
                    Enabled = Bool(o, "enabled", true),
                };
                if (existing.TryGetValue(Key(e), out var id)) { e.Id = id; updated++; }
                else { e.Id = 0; e.Sort = sort++; added++; }
                _db.UpsertEndpoint(e);
            }
            LoadList();
            MessageBox.Show(this, $"가져오기 완료 — 추가 {added}건, 갱신 {updated}건", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, $"가져오기 실패:\n{ex}", "JSON 오류", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static int ClampPort(int p) => p is >= 1 and <= 65535 ? p : 443;
    private static string NormPath(string p) => string.IsNullOrWhiteSpace(p) ? "/" : p;
    private static string Key(Endpoint e) => $"{e.Name}|{e.Host}|{e.Port}".ToLowerInvariant();

    // JsonElement에서 대소문자 무시로 값 읽기(수동 파싱, 리플렉션 불필요).
    private static bool TryProp(System.Text.Json.JsonElement o, string name, out System.Text.Json.JsonElement v)
    {
        foreach (var p in o.EnumerateObject())
            if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) { v = p.Value; return true; }
        v = default; return false;
    }
    private static string Str(System.Text.Json.JsonElement o, string name, string def = "")
        => TryProp(o, name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? (v.GetString() ?? def) : def;
    private static int Int(System.Text.Json.JsonElement o, string name, int def)
        => TryProp(o, name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number && v.TryGetInt32(out var n) ? n : def;
    private static double Dbl(System.Text.Json.JsonElement o, string name, double def)
        => TryProp(o, name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.Number && v.TryGetDouble(out var n) ? n : def;
    private static bool Bool(System.Text.Json.JsonElement o, string name, bool def)
        => TryProp(o, name, out var v) ? v.ValueKind == System.Text.Json.JsonValueKind.True || (v.ValueKind != System.Text.Json.JsonValueKind.False && def) : def;

    private void Save()
    {
        // 폴더 변경은 마지막에 한다 — 다른 설정은 DB 에 먼저 써 두면 이동할 때 함께 따라간다.
        _db.SetSetting("certWarnDays", ((int)_certWarn.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("warnLatencyMs", ((int)_latency.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("retentionDays", ((int)_retention.Value).ToString(CultureInfo.InvariantCulture));
        // 내 위치(사용자) — 지도 사용자 마커/RTT 기준. 숫자만 정규화 저장.
        _db.SetSetting("userCity", _userCity.Text.Trim());
        _db.SetSetting("userLat", ParseD(_userLat.Text).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("userLon", ParseD(_userLon.Text).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("mapShow", _mapShow.SelectedIndex == 1 ? "uag" : _mapShow.SelectedIndex == 2 ? "portal" : "both");
        SetAutostart(_autostart.Checked);
        ReadAlarmFromUi().Save(_db);
        if (!ApplyDataDirChange()) { _monitor.ApplyThresholds(); return; } // 폴더 이동이 취소·실패하면 창을 열어 둔다.
        _monitor.ApplyThresholds();
        DialogResult = DialogResult.OK;
        Close();
    }


    // ── 알람 탭 ──────────────────────────────────────────────────────────────
    private static readonly (AlarmEdge Edge, string Label)[] EdgeItems =
    {
        (AlarmEdge.Top, "위쪽"), (AlarmEdge.Bottom, "아래쪽"),
        (AlarmEdge.Left, "왼쪽"), (AlarmEdge.Right, "오른쪽"),
    };

    /// <summary>탭 한 장의 세로 배치 틀 — 도킹 순서에 기대지 않고 행 번호로 쌓는다.</summary>
    private static TableLayoutPanel Stack()
    {
        var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, AutoScroll = true, BackColor = Color.White, Padding = new Padding(10, 6, 10, 6) };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        return t;
    }

    private static void AddRow(TableLayoutPanel t, Control c, int bottomGap = 10)
    {
        c.Dock = DockStyle.Top;
        c.Margin = new Padding(0, 0, 0, bottomGap);
        t.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        t.Controls.Add(c, 0, t.RowCount++);
    }

    private void BuildAlarmPage(TabPage page)
    {
        var a = AlarmSettings.Load(_db);
        page.BackColor = Color.White;
        var root = Stack();

        _alarmOn.Text = "장애가 생기면 화면 가장자리에 알람 띠를 띄운다";
        _alarmOn.AutoSize = true;
        _alarmOn.Font = Theme.F(10.5f, FontStyle.Bold);
        _alarmOn.Checked = a.Enabled;
        _alarmOn.Margin = new Padding(0, 6, 0, 14);
        AddRow(root, _alarmOn, 6);

        var grid = new TableLayoutPanel { AutoSize = true, ColumnCount = 2 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        // 위치: 네 칸짜리 선택 버튼(시안의 분할 버튼)
        grid.Controls.Add(Lbl("위치"), 0, 0);
        var seg = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 4, 0, 4) };
        for (int i = 0; i < EdgeItems.Length; i++)
        {
            var rb = new RadioButton
            {
                Appearance = Appearance.Button, Text = EdgeItems[i].Label, AutoSize = false, Width = 92, Height = 32,
                TextAlign = ContentAlignment.MiddleCenter, FlatStyle = FlatStyle.Flat, Margin = new Padding(0),
                Cursor = Cursors.Hand, UseVisualStyleBackColor = false, BackColor = Color.White, ForeColor = Theme.Ink,
            };
            rb.FlatAppearance.BorderColor = Theme.BtnBorder;
            rb.FlatAppearance.CheckedBackColor = Theme.Ink;
            rb.FlatAppearance.MouseOverBackColor = Theme.Hover;
            rb.CheckedChanged += (s2, _) =>
            {
                var r = (RadioButton)s2!;
                r.ForeColor = r.Checked ? Color.White : Theme.Ink;
                r.Font = Theme.F(9.5f, r.Checked ? FontStyle.Bold : FontStyle.Regular);
            };
            _edgeBtns[i] = rb;
            seg.Controls.Add(rb);
        }
        _edgeBtns[Math.Max(0, Array.FindIndex(EdgeItems, x => x.Edge == a.Edge))].Checked = true;
        grid.Controls.Add(seg, 1, 0);

        _alarmThick.Minimum = AlarmSettings.MinThickness; _alarmThick.Maximum = AlarmSettings.MaxThickness; _alarmThick.Increment = 4;
        _alarmThick.Value = a.ThicknessPx;
        grid.Controls.Add(Lbl("두께"), 0, 1);
        grid.Controls.Add(SliderRow(_alarmThick, AlarmSettings.MinThickness, AlarmSettings.MaxThickness, 4, "px", "위·아래면 높이, 왼쪽·오른쪽이면 너비"), 1, 1);

        _alarmLen.Minimum = AlarmSettings.MinLength; _alarmLen.Maximum = AlarmSettings.MaxLength; _alarmLen.Increment = 5;
        _alarmLen.Value = a.LengthPercent;
        grid.Controls.Add(Lbl("길이"), 0, 2);
        grid.Controls.Add(SliderRow(_alarmLen, AlarmSettings.MinLength, AlarmSettings.MaxLength, 5, "%", "화면 변의 길이 기준, 가운데 정렬"), 1, 2);

        _alarmBlink.Minimum = AlarmSettings.MinBlinkMs; _alarmBlink.Maximum = AlarmSettings.MaxBlinkMs; _alarmBlink.Increment = 50;
        _alarmBlink.Value = a.BlinkMs;
        grid.Controls.Add(Lbl("깜빡이는 속도"), 0, 3);
        grid.Controls.Add(SliderRow(_alarmBlink, AlarmSettings.MinBlinkMs, AlarmSettings.MaxBlinkMs, 50, "ms", "작을수록 빠르게 (기본 600)"), 1, 3);
        AddRow(root, grid, 12);

        // 미리보기 줄
        var prev = new TableLayoutPanel { AutoSize = true, ColumnCount = 2, BackColor = Theme.Page, Padding = new Padding(14, 10, 14, 10) };
        prev.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        prev.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var prevText = new Label
        {
            AutoSize = false, Height = 40, Dock = DockStyle.Fill, ForeColor = Theme.Body, Font = Theme.F(9f),
            Text = "미리보기 — 지금 입력한 값(저장 전)으로 실제 화면 가장자리에 5초간 띄웁니다. 띠를 클릭하면 바로 닫힙니다.",
        };
        var prevBtn = MakeBtn("미리보기", (_, _) => ShowAlarmPreview());
        prev.Controls.Add(prevText, 0, 0);
        prev.Controls.Add(prevBtn, 1, 0);
        AddRow(root, prev, 12);

        var note = new Label
        {
            AutoSize = false, Height = 118, ForeColor = Theme.Body, Font = Theme.F(9f),
            Text = "• '주의'와 '위험'이 모두 알람 대상입니다. 위험은 빨강, 주의는 노랑으로 깜빡이고 둘이 섞이면 빨강입니다.\r\n" +
                   "• 띠를 클릭하거나 트레이 메뉴 › 알람 끄기를 누르면 꺼집니다. 같은 상태가 이어지는 동안에는 다시 울리지 않습니다.\r\n" +
                   "• 정상으로 돌아왔다가 다시 나빠지거나, 주의에서 위험으로 악화되거나, 다른 대상에 새 장애가 생기면 다시 울립니다.\r\n" +
                   "• 프로그램을 켠 직후에는 최근 점검 결과가 있는 대상만 알람이 됩니다(예전 기록으로 울리지 않음).\r\n" +
                   "• 알람 발생·확인·해소는 데이터 폴더의 alarm.log 에 기록됩니다. 알람 띠는 주 모니터에 표시됩니다.",
        };
        AddRow(root, note, 0);
        page.Controls.Add(root);
    }

    private static Label Lbl(string text) => new() { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 10, 3, 10), ForeColor = Theme.Body };

    /// <summary>슬라이더 + 숫자 입력 + 단위 + 설명 한 줄. 둘은 서로 따라 움직인다.</summary>
    private static Control SliderRow(NumericUpDown n, int min, int max, int small, string unit, string hint)
    {
        var tb = new TrackBar
        {
            Minimum = min, Maximum = max, SmallChange = small, LargeChange = small * 5, TickStyle = TickStyle.None,
            AutoSize = false, Width = 250, Height = 30, Value = (int)Math.Clamp(n.Value, min, max), Margin = new Padding(0, 4, 8, 0),
        };
        bool sync = false;
        tb.ValueChanged += (_, _) => { if (sync) return; sync = true; n.Value = tb.Value; sync = false; };
        n.ValueChanged += (_, _) => { if (sync) return; sync = true; tb.Value = (int)Math.Clamp(n.Value, min, max); sync = false; };
        n.Width = 74; n.Margin = new Padding(0, 6, 4, 0); n.Font = Theme.F(9.5f);
        var p = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        p.Controls.Add(tb);
        p.Controls.Add(n);
        p.Controls.Add(new Label { Text = unit, AutoSize = true, Margin = new Padding(0, 9, 10, 0), ForeColor = Theme.Body });
        p.Controls.Add(new Label { Text = hint, AutoSize = true, Margin = new Padding(0, 9, 0, 0), ForeColor = Theme.Muted, Font = Theme.F(8.5f) });
        return p;
    }

    private AlarmSettings ReadAlarmFromUi() => new AlarmSettings
    {
        Enabled = _alarmOn.Checked,
        Edge = EdgeItems[Math.Max(0, Array.FindIndex(_edgeBtns, x => x.Checked))].Edge,
        ThicknessPx = (int)_alarmThick.Value,
        LengthPercent = (int)_alarmLen.Value,
        BlinkMs = (int)_alarmBlink.Value,
    }.Clamped();

    private void ShowAlarmPreview()
    {
        ClosePreview();
        _preview = new AlarmOverlay();
        _preview.Acknowledged += ClosePreview; // 클릭하면 닫힌다(실제 알람과 같은 동작을 직접 확인)
        _preview.ShowAlarm(ReadAlarmFromUi(), Array.Empty<AlarmItem>(), preview: true);
        _previewTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        _previewTimer.Tick += (_, _) => ClosePreview();
        _previewTimer.Start();
    }

    private void ClosePreview()
    {
        try { _previewTimer?.Stop(); _previewTimer?.Dispose(); } catch { /* ignore */ }
        _previewTimer = null;
        try { _preview?.Close(); _preview?.Dispose(); } catch { /* ignore */ }
        _preview = null;
    }

    // ── 데이터·로그 폴더 탭 ───────────────────────────────────────────────────
    private void BuildDataPage(TabPage page)
    {
        var locked = DataLocation.CommandLineOverride;
        page.BackColor = Color.White;
        var root = Stack();

        AddRow(root, new Label { Text = "저장 폴더", AutoSize = true, Font = Theme.F(10f, FontStyle.Bold) }, 6);

        var pathRow = new TableLayoutPanel { AutoSize = true, ColumnCount = 2 };
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        pathRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _dataDir.Text = _currentDir;
        _dataDir.Dock = DockStyle.Fill;
        _dataDir.Enabled = !locked;
        _dataDir.Font = Theme.F(10f);
        _dataDir.BorderStyle = BorderStyle.FixedSingle;
        _dataDir.Margin = new Padding(0, 3, 6, 3);
        pathRow.Controls.Add(_dataDir, 0, 0);
        var browse = MakeBtn("찾아보기…", (_, _) => BrowseDataDir());
        browse.Enabled = !locked;
        pathRow.Controls.Add(browse, 1, 0);
        AddRow(root, pathRow, 2);

        var row2 = new FlowLayoutPanel { AutoSize = true, Margin = new Padding(0) };
        var openBtn = MakeBtn("현재 폴더 열기", (_, _) => OpenDir(_currentDir));
        var reset = MakeBtn("기본 폴더로", (_, _) => _dataDir.Text = DataLocation.DefaultBaseDir());
        reset.Enabled = !locked;
        row2.Controls.Add(openBtn);
        row2.Controls.Add(reset);
        AddRow(root, row2, 6);

        AddRow(root, new Label
        {
            AutoSize = false, Height = 40, Padding = new Padding(10, 6, 10, 0), BackColor = Color.FromArgb(0xEA, 0xF1, 0xFF), ForeColor = Color.FromArgb(0x1E, 0x3F, 0x8F), Font = Theme.F(9f),
            Text = locked
                ? "프로그램이 --db 옵션으로 실행되어 저장 폴더를 설정에서 바꿀 수 없습니다."
                : "다른 폴더로 바꾸고 [저장]을 누르면 자동으로 이동합니다. 드라이브 전체 경로로 입력하세요.",
        }, 14);

        AddRow(root, new Label { Text = "이 폴더에 저장되는 파일", AutoSize = true, Font = Theme.F(10f, FontStyle.Bold) }, 6);
        var files = new ListView
        {
            View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable, BorderStyle = BorderStyle.FixedSingle,
            Height = 104, Font = Theme.F(9.5f), BackColor = Color.White, MultiSelect = false,
        };
        files.Columns.Add("파일", 130);
        files.Columns.Add("내용", 320);
        files.Columns.Add("크기", 110, HorizontalAlignment.Right);
        void AddFile(string name, string what, params string[] related)
        {
            long total = 0; bool any = false;
            foreach (var n in new[] { name }.Concat(related))
            {
                try { var f = new System.IO.FileInfo(System.IO.Path.Combine(_currentDir, n)); if (f.Exists) { total += f.Length; any = true; } } catch { /* 읽을 수 없으면 건너뜀 */ }
            }
            files.Items.Add(new ListViewItem(new[] { name, what, any ? SizeText(total) : "아직 없음" }));
        }
        AddFile(DataLocation.DbFileName, "점검 이력 · 대상 · 설정", DataLocation.DbFileName + "-wal", DataLocation.DbFileName + "-shm");
        AddFile(AppLog.AlarmFile, "알람 발생 · 확인 · 해소 기록");
        AddFile(AppLog.ErrorFile, "프로그램 오류 기록");
        AddRow(root, files, 14);

        AddRow(root, new Label { Text = "폴더를 바꾸면 이렇게 이동합니다", AutoSize = true, Font = Theme.F(10f, FontStyle.Bold) }, 6);
        AddRow(root, new Label
        {
            AutoSize = false, Height = 88, ForeColor = Theme.Body, Font = Theme.F(9f),
            Text = "①  점검 — 경로 · 쓰기 가능 · 여유 공간 · 대상 폴더의 기존 DB 확인\r\n" +
                   "②  복사 — 점검은 멈추지 않고 계속됩니다\r\n" +
                   "③  검증 — 복사 중 쌓인 결과를 반영하고 무결성을 확인합니다\r\n" +
                   "④  전환 — 새 폴더로 바꾼 뒤 예전 폴더의 파일을 정리합니다 (실패하면 예전 폴더를 그대로 사용)",
        }, 6);
        AddRow(root, new Label
        {
            AutoSize = false, Height = 40, ForeColor = Theme.Muted, Font = Theme.F(8.5f),
            Text = "새 폴더에 이미 monitor.db 가 있으면 덮어쓰지 않고, 그 데이터베이스를 쓸지 물어봅니다. 네트워크 폴더가 끊기면 다음 시작 때 기본 폴더로 열립니다.",
        }, 0);
        page.Controls.Add(root);
    }

    private static string SizeText(long bytes)
        => bytes >= 1L << 30 ? $"{bytes / (double)(1L << 30):F1} GB"
         : bytes >= 1L << 20 ? $"{bytes / (double)(1L << 20):F1} MB"
         : bytes >= 1L << 10 ? $"{bytes / (double)(1L << 10):F0} KB"
         : $"{bytes} B";

    private void BrowseDataDir()
    {
        using var fbd = new FolderBrowserDialog { Description = "데이터·로그를 저장할 폴더", UseDescriptionForTitle = true, SelectedPath = _dataDir.Text };
        if (fbd.ShowDialog(this) == DialogResult.OK) _dataDir.Text = fbd.SelectedPath;
    }

    private static void OpenDir(string dir)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = dir, UseShellExecute = true }); }
        catch { /* ignore */ }
    }

    /// <summary>폴더가 바뀌었으면 점검·확인·이동을 진행한다. 계속 저장해도 되면 true.</summary>
    private bool ApplyDataDirChange()
    {
        if (DataLocation.CommandLineOverride) return true;
        var wanted = _dataDir.Text.Trim();
        if (wanted.Length == 0 || DataLocation.SamePath(wanted, _currentDir)) return true;

        var check = DataMigrator.Check(_db.DbPath, wanted);
        bool useExisting = false;
        switch (check.State)
        {
            case TargetState.Ok:
                var mb = Math.Max(1, new System.IO.FileInfo(_db.DbPath).Length / (1024 * 1024));
                if (MessageBox.Show(this,
                        $"데이터를 아래 폴더로 이동합니다.\n\n{check.FullPath}\n\n" +
                        $"• 데이터베이스 약 {mb} MB 를 복사하고 검증합니다.\n" +
                        "• 이동하는 동안에도 점검은 계속됩니다.\n" +
                        "• 성공하면 예전 폴더의 monitor.db 와 로그 파일은 삭제됩니다.\n\n계속할까요?",
                        "저장 폴더 이동", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                    return false;
                break;
            case TargetState.HasExistingDb:
                if (MessageBox.Show(this,
                        $"'{check.FullPath}' 에 이미 데이터베이스(monitor.db)가 있습니다.\n\n" +
                        "[예] 그 데이터베이스를 사용합니다. 지금 데이터는 예전 폴더에 그대로 남고, 새로 쓰는 데이터는 그 데이터베이스에 쌓입니다.\n" +
                        "      지금 입력한 임계값·알람 설정(내 위치·지도 표시 포함)은 대상 폴더 DB 에 저장된 값으로 대체됩니다.\n" +
                        "[아니오] 취소합니다. (기존 파일은 덮어쓰지 않습니다)",
                        "기존 데이터베이스 발견", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                    return false;
                useExisting = true;
                break;
            default:
                MessageBox.Show(this, check.Message, "저장 폴더를 바꿀 수 없습니다", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
        }

        var result = RunMigration(wanted, useExisting);
        if (!result.Ok)
        {
            MessageBox.Show(this, result.Message, "저장 폴더 이동 실패", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        var msg = result.Message + (result.Notes.Count > 0 ? "\n\n" + string.Join("\n", result.Notes) : "");
        MessageBox.Show(this, msg, "저장 폴더 이동", MessageBoxButtons.OK, result.Notes.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
        return true;
    }

    private MigrationResult RunMigration(string dir, bool useExisting)
    {
        MigrationResult? res = null;
        using var dlg = new Form
        {
            Text = "저장 폴더 이동 중",
            FormBorderStyle = FormBorderStyle.FixedDialog,
            ControlBox = false,
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(520, 266),
            ShowInTaskbar = false,
            BackColor = Color.White,
            Font = Theme.F(9.5f),
        };
        dlg.Controls.Add(new Label { Text = "데이터를 옮기고 있습니다", Left = 26, Top = 20, Width = 468, Height = 26, Font = Theme.F(12f, FontStyle.Bold), ForeColor = Theme.Ink });
        dlg.Controls.Add(new Label { Text = dir, Left = 26, Top = 48, Width = 468, Height = 20, ForeColor = Theme.Body, AutoEllipsis = true });
        var stepLabels = new[]
        {
            new Label { Text = "폴더 점검" },
            new Label { Text = "데이터베이스 복사" },
            new Label { Text = "복사 중 쌓인 결과 반영 · 검증" },
            new Label { Text = "새 폴더로 전환 · 예전 파일 정리" },
        };
        for (int i = 0; i < stepLabels.Length; i++)
        {
            var l = stepLabels[i];
            l.Left = 26; l.Top = 82 + i * 24; l.Width = 468; l.Height = 22; l.AutoSize = false;
            dlg.Controls.Add(l);
        }
        void ShowStep(int current)
        {
            for (int i = 0; i < stepLabels.Length; i++)
            {
                var done = i < current; var now = i == current;
                var l = stepLabels[i];
                var text = new[] { "폴더 점검", "데이터베이스 복사", "복사 중 쌓인 결과 반영 · 검증", "새 폴더로 전환 · 예전 파일 정리" }[i];
                l.Text = (done ? "✔  " : now ? "▶  " : "○  ") + text + (now ? " …" : "");
                l.ForeColor = done ? Theme.Body : now ? Theme.Ink : Theme.Muted;
                l.Font = Theme.F(9.5f, now ? FontStyle.Bold : FontStyle.Regular);
            }
        }
        ShowStep(0);
        var bar = new ProgressBar { Style = ProgressBarStyle.Marquee, Left = 26, Top = 190, Width = 468, Height = 10, MarqueeAnimationSpeed = 30 };
        dlg.Controls.Add(bar);
        dlg.Controls.Add(new Label { Text = "이동하는 동안에도 점검은 계속됩니다. 창을 닫지 말고 기다려 주세요.", Left = 26, Top = 212, Width = 468, Height = 36, ForeColor = Theme.Body, Font = Theme.F(9f) });
        dlg.Shown += async (_, _) =>
        {
            try
            {
                res = await System.Threading.Tasks.Task.Run(() => DataMigrator.Migrate(_db, DataLocation.Default, dir, useExisting,
                    m => { try { if (!dlg.IsDisposed) dlg.BeginInvoke(() => ShowStep(DataMigrator.StepOf(m))); } catch { /* 창이 닫히는 중 */ } }));
            }
            catch (Exception ex) { res = new MigrationResult(false, "이동 중 오류: " + ex.Message, null, Array.Empty<string>()); }
            dlg.Close();
        };
        dlg.ShowDialog(this);
        return res ?? new MigrationResult(false, "이동 결과를 확인하지 못했습니다.", null, Array.Empty<string>());
    }

    private void LookupUserCity()
    {
        var geo = CityGeo.Lookup(_userCity.Text);
        if (geo is CityGeo.Geo g)
        {
            _userLat.Text = g.Lat.ToString(CultureInfo.InvariantCulture);
            _userLon.Text = g.Lon.ToString(CultureInfo.InvariantCulture);
        }
        else
        {
            MessageBox.Show(this, "도시를 찾을 수 없습니다. 위도/경도를 직접 입력하세요.",
                "좌표찾기", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private static double ParseD(string? s)
        => double.TryParse((s ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0;

    // ── 자동 실행(HKCU Run) ─────────────────────────────────────────────────
    private static bool IsAutostartEnabled()
    {
        try { using var k = Registry.CurrentUser.OpenSubKey(RunKey, false); return k?.GetValue(RunValue) != null; }
        catch { return false; }
    }

    private static void SetAutostart(bool on)
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunKey, true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
            if (k == null) return;
            if (on) k.SetValue(RunValue, "\"" + Application.ExecutablePath + "\"");
            else if (k.GetValue(RunValue) != null) k.DeleteValue(RunValue, false);
        }
        catch { /* 권한 없으면 무시 */ }
    }
}

/// <summary>단일 대상 추가/수정 다이얼로그.</summary>
public sealed class EndpointEditForm : Form
{
    private readonly Endpoint _e;
    private readonly TextBox _name = new();
    private readonly ComboBox _type = new();
    private readonly TextBox _dc = new();
    private readonly ComboBox _scheme = new();
    private readonly TextBox _host = new();
    private readonly NumericUpDown _port = new();
    private readonly TextBox _path = new();
    private readonly TextBox _match = new();
    private readonly TextBox _city = new();
    private readonly TextBox _region = new();
    private readonly TextBox _lat = new();
    private readonly TextBox _lon = new();
    private readonly NumericUpDown _interval = new();
    private readonly NumericUpDown _timeout = new();
    private readonly CheckBox _enabled = new();

    public EndpointEditForm(Endpoint e)
    {
        _e = e;
        Text = "대상 편집";
        Width = 470;
        Height = 640;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false; MaximizeBox = false;
        Font = new System.Drawing.Font("Segoe UI", 9f);
        AutoScroll = true;

        var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), RowCount = 16, AutoSize = true };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Row(string label, Control c) { t.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }); c.Dock = DockStyle.Fill; t.Controls.Add(c); }

        _name.Text = e.Name;
        _type.DropDownStyle = ComboBoxStyle.DropDownList; _type.Items.AddRange(new object[] { "UAG", "포탈" });
        _type.SelectedItem = e.Type == "포탈" ? "포탈" : "UAG";
        _dc.Text = e.Datacenter;
        _scheme.DropDownStyle = ComboBoxStyle.DropDownList; _scheme.Items.AddRange(new object[] { "https", "http" });
        _scheme.SelectedItem = string.Equals(e.Scheme, "http", StringComparison.OrdinalIgnoreCase) ? "http" : "https";
        _host.Text = e.Host;
        _port.Minimum = 1; _port.Maximum = 65535; _port.Value = e.Port is >= 1 and <= 65535 ? e.Port : 443;
        // 스킴 변경 시 기본 포트(443/80)면 그에 맞춰 자동 조정(사용자가 바꾼 값은 유지).
        _scheme.SelectedIndexChanged += (_, _) => { if (_port.Value == 443 || _port.Value == 80) _port.Value = (string)_scheme.SelectedItem! == "http" ? 80 : 443; };
        _path.Text = string.IsNullOrEmpty(e.Path) ? "/" : e.Path;
        _match.Text = e.MatchText;
        _city.Text = e.City;
        _region.Text = e.Region;
        _lat.Text = e.Lat.ToString(CultureInfo.InvariantCulture);
        _lon.Text = e.Lon.ToString(CultureInfo.InvariantCulture);
        _interval.Minimum = 5; _interval.Maximum = 86400; _interval.Value = Math.Max(5, Math.Min(86400, e.IntervalSec));
        _timeout.Minimum = 1000; _timeout.Maximum = 60000; _timeout.Increment = 500; _timeout.Value = Math.Max(1000, Math.Min(60000, e.TimeoutMs));
        _enabled.Text = "활성(점검)"; _enabled.Checked = e.Enabled; _enabled.AutoSize = true;

        // 도시 + '좌표찾기' 버튼(한 셀)
        var cityCell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Height = 26, Margin = new Padding(0) };
        cityCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        cityCell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 84));
        _city.Dock = DockStyle.Fill;
        var findBtn = new Button { Text = "좌표찾기", Dock = DockStyle.Fill, Margin = new Padding(4, 0, 0, 0) };
        findBtn.Click += (_, _) => LookupCity();
        cityCell.Controls.Add(_city, 0, 0);
        cityCell.Controls.Add(findBtn, 1, 0);
        // 위도/경도(한 셀 2칸)
        var llCell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Height = 26, Margin = new Padding(0) };
        llCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        llCell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        _lat.Dock = DockStyle.Fill; _lon.Dock = DockStyle.Fill;
        _lat.Margin = new Padding(0, 0, 3, 0); _lon.Margin = new Padding(3, 0, 0, 0);
        llCell.Controls.Add(_lat, 0, 0);
        llCell.Controls.Add(_lon, 1, 0);

        Row("이름", _name);
        Row("유형", _type);
        Row("데이터센터", _dc);
        Row("프로토콜", _scheme);
        Row("호스트/IP", _host);
        Row("포트", _port);
        Row("경로(예: /)", _path);
        Row("콘텐츠 키워드(선택)", _match);
        Row("도시(입력 후 좌표찾기)", cityCell);
        Row("리전", _region);
        Row("위도 / 경도", llCell);
        Row("점검 주기(초)", _interval);
        Row("타임아웃(ms)", _timeout);
        t.Controls.Add(new Label()); t.Controls.Add(_enabled);

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
        var ok = new Button { Text = "확인" };
        ok.Click += (_, _) => OnOk();
        var cancel = new Button { Text = "취소", DialogResult = DialogResult.Cancel };
        bottom.Controls.Add(ok);
        bottom.Controls.Add(cancel);

        Controls.Add(t);
        Controls.Add(bottom);
        AcceptButton = ok;
        CancelButton = cancel;
    }

    private void OnOk()
    {
        var host = _host.Text.Trim();
        if (string.IsNullOrWhiteSpace(_name.Text)) { MessageBox.Show(this, "이름을 입력하세요.", "확인", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        if (string.IsNullOrWhiteSpace(host)) { MessageBox.Show(this, "호스트/IP를 입력하세요.", "확인", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
        // 사용자가 URL을 붙여넣어도 호스트만 추출.
        host = host.Replace("https://", "", StringComparison.OrdinalIgnoreCase).Replace("http://", "", StringComparison.OrdinalIgnoreCase);
        var slash = host.IndexOf('/');
        if (slash >= 0) host = host.Substring(0, slash);
        var colon = host.IndexOf(':');
        if (colon >= 0) host = host.Substring(0, colon);

        _e.Name = _name.Text.Trim();
        _e.Type = (string?)_type.SelectedItem == "포탈" ? "포탈" : "UAG";
        _e.Datacenter = _dc.Text.Trim();
        _e.Scheme = (string?)_scheme.SelectedItem == "http" ? "http" : "https";
        _e.Host = host;
        _e.Port = (int)_port.Value;
        _e.Path = string.IsNullOrWhiteSpace(_path.Text) ? "/" : _path.Text.Trim();
        _e.MatchText = _match.Text.Trim();
        _e.City = _city.Text.Trim();
        _e.Region = _region.Text.Trim();
        _e.Lat = ParseD(_lat.Text);
        _e.Lon = ParseD(_lon.Text);
        _e.IntervalSec = (int)_interval.Value;
        _e.TimeoutMs = (int)_timeout.Value;
        _e.Enabled = _enabled.Checked;
        DialogResult = DialogResult.OK;
        Close();
    }

    private void LookupCity()
    {
        var geo = CityGeo.Lookup(_city.Text);
        if (geo is CityGeo.Geo g)
        {
            _lat.Text = g.Lat.ToString(CultureInfo.InvariantCulture);
            _lon.Text = g.Lon.ToString(CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(_region.Text)) _region.Text = g.Region;
        }
        else
        {
            MessageBox.Show(this, "도시를 찾을 수 없습니다. 위도/경도를 직접 입력하거나 다른 도시명을 시도하세요.",
                "좌표찾기", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }

    private static double ParseD(string? s)
        => double.TryParse((s ?? "").Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0;
}
