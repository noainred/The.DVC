using System;
using System.Collections.Generic;
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

    public SettingsForm(Database db, MonitorService monitor)
    {
        _db = db;
        _monitor = monitor;
        Text = "설정 — 대상 관리";
        Width = 820;
        Height = 620;
        StartPosition = FormStartPosition.CenterParent;
        Font = new System.Drawing.Font("Segoe UI", 9f);
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

        var thresh = new TableLayoutPanel { Dock = DockStyle.Top, Height = 190, ColumnCount = 2, Padding = new Padding(8) };
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
        _autostart.Text = "Windows 시작 시 자동 실행(현재 사용자)";
        _autostart.AutoSize = true;
        _autostart.Checked = IsAutostartEnabled();
        thresh.Controls.Add(_autostart, 0, 5);

        var bottom = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 46, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(8) };
        var ok = MakeBtn("저장", (_, _) => Save());
        ok.DialogResult = DialogResult.None;
        var cancel = MakeBtn("닫기", (_, _) => { DialogResult = DialogResult.Cancel; Close(); });
        bottom.Controls.Add(ok);
        bottom.Controls.Add(cancel);

        Controls.Add(_list);
        Controls.Add(btns);
        Controls.Add(thresh);
        Controls.Add(bottom);

        LoadList();
    }

    private static Button MakeBtn(string text, EventHandler onClick)
    {
        var b = new Button { Text = text, AutoSize = true, Padding = new Padding(6, 2, 6, 2) };
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
        _db.SetSetting("certWarnDays", ((int)_certWarn.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("warnLatencyMs", ((int)_latency.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("retentionDays", ((int)_retention.Value).ToString(CultureInfo.InvariantCulture));
        // 내 위치(사용자) — 지도 사용자 마커/RTT 기준. 숫자만 정규화 저장.
        _db.SetSetting("userCity", _userCity.Text.Trim());
        _db.SetSetting("userLat", ParseD(_userLat.Text).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("userLon", ParseD(_userLon.Text).ToString(CultureInfo.InvariantCulture));
        SetAutostart(_autostart.Checked);
        _monitor.ApplyThresholds();
        DialogResult = DialogResult.OK;
        Close();
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
