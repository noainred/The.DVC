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

    public SettingsForm(Database db, MonitorService monitor)
    {
        _db = db;
        _monitor = monitor;
        Text = "설정 — 대상 관리";
        Width = 820;
        Height = 560;
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

        var thresh = new TableLayoutPanel { Dock = DockStyle.Top, Height = 130, ColumnCount = 2, Padding = new Padding(8) };
        thresh.Controls.Add(new Label { Text = "인증서 경고 임계(일 이하)", AutoSize = true }, 0, 0);
        _certWarn.Minimum = 1; _certWarn.Maximum = 365; _certWarn.Value = Clamp(_db.GetIntSetting("certWarnDays", 30), 1, 365);
        thresh.Controls.Add(_certWarn, 1, 0);
        thresh.Controls.Add(new Label { Text = "응답 지연 경고(ms 이상)", AutoSize = true }, 0, 1);
        _latency.Minimum = 100; _latency.Maximum = 60000; _latency.Increment = 100; _latency.Value = Clamp(_db.GetIntSetting("warnLatencyMs", 3000), 100, 60000);
        thresh.Controls.Add(_latency, 1, 1);
        thresh.Controls.Add(new Label { Text = "이력 보존(일, 0=무제한)", AutoSize = true }, 0, 2);
        _retention.Minimum = 0; _retention.Maximum = 3650; _retention.Value = Clamp(_db.GetIntSetting("retentionDays", 365), 0, 3650);
        thresh.Controls.Add(_retention, 1, 2);
        _autostart.Text = "Windows 시작 시 자동 실행(현재 사용자)";
        _autostart.AutoSize = true;
        _autostart.Checked = IsAutostartEnabled();
        thresh.Controls.Add(_autostart, 0, 3);

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
    private static readonly System.Text.Json.JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping, // 한글 그대로
    };

    private void ExportJson()
    {
        using var sfd = new SaveFileDialog { Filter = "JSON (*.json)|*.json", FileName = "horizon-uag-endpoints.json" };
        if (sfd.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var json = System.Text.Json.JsonSerializer.Serialize(_db.ListEndpoints(), JsonOpts);
            System.IO.File.WriteAllText(sfd.FileName, json, new System.Text.UTF8Encoding(false));
            MessageBox.Show(this, "내보내기 완료", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "내보내기 오류", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void ImportJson()
    {
        using var ofd = new OpenFileDialog { Filter = "JSON (*.json)|*.json" };
        if (ofd.ShowDialog(this) != DialogResult.OK) return;
        try
        {
            var json = System.IO.File.ReadAllText(ofd.FileName);
            var imported = System.Text.Json.JsonSerializer.Deserialize<List<Endpoint>>(json) ?? new List<Endpoint>();
            if (imported.Count == 0) { MessageBox.Show(this, "가져올 대상이 없습니다.", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            // 기존과 (이름+호스트+포트)로 매칭: 있으면 갱신, 없으면 추가(중복 방지).
            var existing = _db.ListEndpoints().ToDictionary(x => Key(x), x => x.Id);
            int added = 0, updated = 0, sort = _db.ListEndpoints().Count;
            foreach (var e in imported)
            {
                if (string.IsNullOrWhiteSpace(e.Host)) continue;
                if (e.Port is < 1 or > 65535) e.Port = 443;
                if (string.IsNullOrWhiteSpace(e.Name)) e.Name = e.Host;
                if (string.IsNullOrWhiteSpace(e.Path)) e.Path = "/";
                if (e.IntervalSec < 5) e.IntervalSec = 60;
                if (e.TimeoutMs < 1000) e.TimeoutMs = 5000;
                if (existing.TryGetValue(Key(e), out var id)) { e.Id = id; updated++; }
                else { e.Id = 0; e.Sort = sort++; added++; }
                _db.UpsertEndpoint(e);
            }
            LoadList();
            MessageBox.Show(this, $"가져오기 완료 — 추가 {added}건, 갱신 {updated}건", "JSON", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) { MessageBox.Show(this, $"가져오기 실패: {ex.Message}", "JSON 오류", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private static string Key(Endpoint e) => $"{e.Name}|{e.Host}|{e.Port}".ToLowerInvariant();

    private void Save()
    {
        _db.SetSetting("certWarnDays", ((int)_certWarn.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("warnLatencyMs", ((int)_latency.Value).ToString(CultureInfo.InvariantCulture));
        _db.SetSetting("retentionDays", ((int)_retention.Value).ToString(CultureInfo.InvariantCulture));
        SetAutostart(_autostart.Checked);
        _monitor.ApplyThresholds();
        DialogResult = DialogResult.OK;
        Close();
    }

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
    private readonly NumericUpDown _interval = new();
    private readonly NumericUpDown _timeout = new();
    private readonly CheckBox _enabled = new();

    public EndpointEditForm(Endpoint e)
    {
        _e = e;
        Text = "대상 편집";
        Width = 460;
        Height = 500;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false; MaximizeBox = false;
        Font = new System.Drawing.Font("Segoe UI", 9f);

        var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), RowCount = 12 };
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
        _interval.Minimum = 5; _interval.Maximum = 86400; _interval.Value = Math.Max(5, Math.Min(86400, e.IntervalSec));
        _timeout.Minimum = 1000; _timeout.Maximum = 60000; _timeout.Increment = 500; _timeout.Value = Math.Max(1000, Math.Min(60000, e.TimeoutMs));
        _enabled.Text = "활성(점검)"; _enabled.Checked = e.Enabled; _enabled.AutoSize = true;

        Row("이름", _name);
        Row("유형", _type);
        Row("데이터센터", _dc);
        Row("프로토콜", _scheme);
        Row("호스트/IP", _host);
        Row("포트", _port);
        Row("경로(예: /)", _path);
        Row("콘텐츠 키워드(선택)", _match);
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
        _e.IntervalSec = (int)_interval.Value;
        _e.TimeoutMs = (int)_timeout.Value;
        _e.Enabled = _enabled.Checked;
        DialogResult = DialogResult.OK;
        Close();
    }
}
