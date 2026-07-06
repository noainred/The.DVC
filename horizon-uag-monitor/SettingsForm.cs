using System;
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
        _list.Columns.Add("이름", 130);
        _list.Columns.Add("데이터센터", 130);
        _list.Columns.Add("호스트", 190);
        _list.Columns.Add("포트", 55);
        _list.Columns.Add("경로", 90);
        _list.Columns.Add("주기(s)", 60);
        _list.Columns.Add("활성", 55);
        _list.DoubleClick += (_, _) => EditSelected();

        var btns = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 40, Padding = new Padding(4) };
        btns.Controls.Add(MakeBtn("추가", (_, _) => AddNew()));
        btns.Controls.Add(MakeBtn("수정", (_, _) => EditSelected()));
        btns.Controls.Add(MakeBtn("삭제", (_, _) => DeleteSelected()));
        btns.Controls.Add(MakeBtn("기본 12개 데이터센터 채우기", (_, _) => SeedDefaults()));

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
            var it = new ListViewItem(new[] { e.Name, e.Datacenter, e.Host, e.Port.ToString(CultureInfo.InvariantCulture), e.Path, e.IntervalSec.ToString(CultureInfo.InvariantCulture), e.Enabled ? "예" : "아니오" })
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
    private readonly TextBox _dc = new();
    private readonly TextBox _host = new();
    private readonly NumericUpDown _port = new();
    private readonly TextBox _path = new();
    private readonly NumericUpDown _interval = new();
    private readonly NumericUpDown _timeout = new();
    private readonly CheckBox _enabled = new();

    public EndpointEditForm(Endpoint e)
    {
        _e = e;
        Text = "대상 편집";
        Width = 440;
        Height = 360;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false; MaximizeBox = false;
        Font = new System.Drawing.Font("Segoe UI", 9f);

        var t = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(12), RowCount = 9 };
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 130));
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        void Row(string label, Control c) { t.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left }); c.Dock = DockStyle.Fill; t.Controls.Add(c); }

        _name.Text = e.Name;
        _dc.Text = e.Datacenter;
        _host.Text = e.Host;
        _port.Minimum = 1; _port.Maximum = 65535; _port.Value = e.Port is >= 1 and <= 65535 ? e.Port : 443;
        _path.Text = string.IsNullOrEmpty(e.Path) ? "/" : e.Path;
        _interval.Minimum = 5; _interval.Maximum = 86400; _interval.Value = Math.Max(5, Math.Min(86400, e.IntervalSec));
        _timeout.Minimum = 1000; _timeout.Maximum = 60000; _timeout.Increment = 500; _timeout.Value = Math.Max(1000, Math.Min(60000, e.TimeoutMs));
        _enabled.Text = "활성(점검)"; _enabled.Checked = e.Enabled; _enabled.AutoSize = true;

        Row("이름", _name);
        Row("데이터센터", _dc);
        Row("호스트/IP", _host);
        Row("포트", _port);
        Row("경로(예: /)", _path);
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
        _e.Datacenter = _dc.Text.Trim();
        _e.Host = host;
        _e.Port = (int)_port.Value;
        _e.Path = string.IsNullOrWhiteSpace(_path.Text) ? "/" : _path.Text.Trim();
        _e.IntervalSec = (int)_interval.Value;
        _e.TimeoutMs = (int)_timeout.Value;
        _e.Enabled = _enabled.Checked;
        DialogResult = DialogResult.OK;
        Close();
    }
}
