using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Paraphe
{
    /// <summary>
    /// A window showing web/paraphe.html in WebView2, served from a private
    /// virtual host. The page talks to this host through web messages.
    /// </summary>
    internal sealed class MainForm : Form
    {
        private const string Host = "app.paraphe";
        private static readonly string StartUrl = $"https://{Host}/paraphe.html";

        private readonly WebView2 _web = new WebView2 { Dock = DockStyle.Fill };
        private readonly bool _devTools;
        private string _pendingFile;
        private string _currentDir;
        private bool _closeConfirmed;
        private bool _restartAfterUpdate;
        private Updater.Release _available;
        private bool _busy;

        public MainForm(string file, bool devTools)
        {
            _pendingFile = file;
            _devTools = devTools;
            Text = "Paraphe";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            StartPosition = FormStartPosition.CenterScreen;
            var area = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1280, area.Width - 80), Math.Min(980, area.Height - 60));
            MinimumSize = new Size(640, 480);
            BackColor = Color.FromArgb(232, 228, 220);
            Controls.Add(_web);
            Load += async (s, e) => await InitAsync();
        }

        private async Task InitAsync()
        {
            string webDir = Path.Combine(AppContext.BaseDirectory, "web");
            if (!File.Exists(Path.Combine(webDir, "paraphe.html")))
            {
                Fail("The file web\\paraphe.html is missing next to Paraphe.exe. Extract the whole zip again.");
                return;
            }

            CoreWebView2Environment env;
            try
            {
                // Private profile: signatures and settings stay inside this app.
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Paraphe", "WebView2");
                env = await CoreWebView2Environment.CreateAsync(null, data, new CoreWebView2EnvironmentOptions());
                await _web.EnsureCoreWebView2Async(env);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                Fail("Paraphe needs the Microsoft Edge WebView2 Runtime, which comes with Windows 11.\n\n" +
                     "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start Paraphe again.");
                return;
            }
            catch (Exception ex)
            {
                // E.g. another Paraphe window started with different browser options.
                Fail("Paraphe couldn't start its viewer: " + ex.Message + "\n\nClose other Paraphe windows and try again.");
                return;
            }

            CoreWebView2 core = _web.CoreWebView2;
            CoreWebView2Settings settings = core.Settings;
            settings.AreDevToolsEnabled = _devTools;
            settings.AreBrowserAcceleratorKeysEnabled = _devTools; // no F5 reload, Ctrl+P, find bar...
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;
            settings.IsGeneralAutofillEnabled = false;
            settings.IsPasswordAutosaveEnabled = false;
            settings.IsSwipeNavigationEnabled = false;
            settings.AreHostObjectsAllowed = false;

            core.SetVirtualHostNameToFolderMapping(Host, webDir, CoreWebView2HostResourceAccessKind.DenyCors);
            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.DocumentTitleChanged += (s, e) => Text = core.DocumentTitle;
            core.WebMessageReceived += OnWebMessage;
            core.Navigate(StartUrl);
        }

        private void Fail(string message)
        {
            MessageBox.Show(this, message, "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }

        // Only the app page may load in the window. Links found in PDFs open in
        // the default browser instead.
        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        }

        private static void OpenExternal(string uri)
        {
            if (Uri.TryCreate(uri, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeMailto))
            {
                Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true });
            }
        }

        private static JavaScriptSerializer Json => new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            var msg = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            msg.TryGetValue("type", out object type);
            switch (type as string)
            {
                case "save":
                    Save(msg["name"] as string, msg["data"] as string);
                    break;
                case "ready":
                    PostHostInfo();
                    if (_pendingFile != null)
                    {
                        OpenInPage(_pendingFile);
                        _pendingFile = null;
                    }
                    var s = Updater.Load();
                    if (s.Updates == "on" && DateTime.UtcNow - s.LastCheck > TimeSpan.FromDays(1)) _ = CheckForUpdate(false);
                    break;
                case "make-default":
                    MakeDefault();
                    break;
                case "install":
                    InstallOnly();
                    break;
                case "default-app":
                    ChooseDefaultApp();
                    break;
                case "uninstall":
                    if (Installer.Uninstall(this))
                    {
                        _closeConfirmed = true;
                        Close();
                    }
                    else PostHostInfo();
                    break;
                case "updates-mode":
                    SetUpdatesMode(msg["mode"] as string);
                    break;
                case "update-check":
                    _ = CheckForUpdate(true);
                    break;
                case "update-download":
                    _ = DownloadUpdate();
                    break;
                case "update-skip":
                    var skip = Updater.Load();
                    skip.Skip = msg["version"] as string;
                    Updater.Save(skip);
                    break;
                case "theme":
                    TitleBar.Apply(this, msg.TryGetValue("dark", out object dark) && dark is bool d && d,
                        msg.TryGetValue("caption", out object cap) ? cap as string : null,
                        msg.TryGetValue("text", out object txt) ? txt as string : null);
                    break;
                case "update-restart":
                    _restartAfterUpdate = true;
                    Close();
                    break;
            }
        }

        // ---------- updates ----------

        private void PostUpdate(string state, string version = null, string error = null, bool manual = false) =>
            Reply(new Dictionary<string, object>
            {
                ["type"] = "update",
                ["state"] = state,
                ["version"] = version,
                ["error"] = error,
                ["manual"] = manual,
            });

        private void SetUpdatesMode(string mode)
        {
            if (mode != "on" && mode != "off") return;
            var s = Updater.Load();
            s.Updates = mode;
            Updater.Save(s);
            PostHostInfo();
            if (mode == "on" && DateTime.UtcNow - s.LastCheck > TimeSpan.FromDays(1)) _ = CheckForUpdate(false);
        }

        /// <summary>One request for the signed update description.</summary>
        private async Task CheckForUpdate(bool manual)
        {
            if (_busy) return;
            if (Updater.Staged != null)
            {
                PostUpdate("ready", Updater.StagedVersion, manual: manual);
                return;
            }
            _busy = true;
            if (manual) PostUpdate("checking", manual: true);
            try
            {
                var release = await Updater.CheckAsync();
                var s = Updater.Load();
                s.LastCheck = DateTime.UtcNow;
                Updater.Save(s);
                _available = release;
                if (release == null) PostUpdate("none", Updater.CurrentText, manual: manual);
                else if (!manual && release.Version == s.Skip) { /* the user skipped this one */ }
                else PostUpdate(Updater.CanApply() ? "available" : "manual", release.Version, manual: manual);
            }
            catch (Exception ex)
            {
                // Automatic checks fail quietly (offline, GitHub down); a manual one says why.
                if (manual) PostUpdate("error", error: ex.Message, manual: true);
            }
            finally
            {
                _busy = false;
            }
        }

        private async Task DownloadUpdate()
        {
            if (_busy || _available == null) return;
            _busy = true;
            PostUpdate("downloading", _available.Version);
            try
            {
                await Updater.DownloadAsync(_available);
                PostUpdate("ready", _available.Version);
            }
            catch (Exception ex)
            {
                PostUpdate("error", _available.Version, ex.Message);
            }
            finally
            {
                _busy = false;
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            // A downloaded update goes in when Paraphe closes, or right away on "Restart".
            if (Updater.Staged != null && Updater.Apply() && _restartAfterUpdate) Updater.Restart();
        }

        // ---------- install, default app ----------

        private void InstallOnly()
        {
            try
            {
                string exe = Installer.Install();
                PostHostInfo();
                string moved = string.Equals(exe, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase)
                    ? ""
                    : $"\n\nIt was copied to {Path.GetDirectoryName(exe)}. You can delete the folder you extracted it to.";
                MessageBox.Show(this, "Paraphe is installed. It's in the Start menu, and in Open with for PDFs." + moved,
                    "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Couldn't install Paraphe: " + ex.Message, "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>Windows lets only the user pick the default app: show its picker.</summary>
        private void ChooseDefaultApp()
        {
            // Paraphe has to be registered to appear in the picker.
            if (!Installer.IsRegistered)
            {
                try { Installer.Install(); }
                catch (Exception ex)
                {
                    MessageBox.Show(this, "Couldn't install Paraphe: " + ex.Message, "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
            }
            Installer.ShowPdfAppPicker();
        }

        // Back from the picker (or Windows Settings): show whether it worked.
        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (_web.CoreWebView2 != null) PostHostInfo();
        }

        private void PostHostInfo()
        {
            var info = new Dictionary<string, object>
            {
                ["type"] = "host",
                ["version"] = Updater.CurrentText,
                ["installed"] = Installer.IsRunningInstalled,
                ["registered"] = Installer.IsRegistered,
                ["isDefault"] = Installer.IsDefaultPdfApp,
                ["defaultApp"] = Installer.DefaultPdfAppName(),
                ["updates"] = Updater.Load().Updates,
                ["features"] = new[] { "install", "default-app", "uninstall", "updates" },
                // Windows "Regional format" (dates, numbers), which can differ
                // from the display language the web view reports.
                ["locale"] = System.Globalization.CultureInfo.CurrentCulture.Name,
            };
            _web.CoreWebView2.PostWebMessageAsJson(new JavaScriptSerializer().Serialize(info));
        }

        private void Reply(Dictionary<string, object> message) =>
            _web.CoreWebView2.PostWebMessageAsJson(Json.Serialize(message));

        /// <summary>Native "Save as", starting next to the PDF that was opened from Explorer.</summary>
        private void Save(string name, string base64)
        {
            using (var dialog = new SaveFileDialog
            {
                Title = "Save the filled PDF",
                Filter = "PDF document (*.pdf)|*.pdf",
                DefaultExt = "pdf",
                AddExtension = true,
                OverwritePrompt = true,
                FileName = string.IsNullOrEmpty(name) ? "document.pdf" : name,
            })
            {
                if (_currentDir != null && Directory.Exists(_currentDir)) dialog.InitialDirectory = _currentDir;
                if (dialog.ShowDialog(this) != DialogResult.OK)
                {
                    Reply(new Dictionary<string, object> { ["type"] = "save-cancelled" });
                    return;
                }
                try
                {
                    File.WriteAllBytes(dialog.FileName, Convert.FromBase64String(base64));
                    _currentDir = Path.GetDirectoryName(dialog.FileName);
                    Reply(new Dictionary<string, object> { ["type"] = "saved", ["name"] = Path.GetFileName(dialog.FileName) });
                }
                catch (Exception ex)
                {
                    Reply(new Dictionary<string, object> { ["type"] = "save-failed", ["error"] = ex.Message });
                }
            }
        }

        /// <summary>Hand the page a handle to the file Explorer asked us to open.</summary>
        private void OpenInPage(string path)
        {
            _currentDir = Path.GetDirectoryName(path);
            var env = _web.CoreWebView2.Environment;
            var handle = env.CreateWebFileSystemFileHandle(path, CoreWebView2FileSystemHandlePermission.ReadOnly);
            var json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { ["type"] = "open", ["name"] = Path.GetFileName(path) });
            _web.CoreWebView2.PostWebMessageAsJson(json, new List<object> { handle });
            Activate();
        }

        private void MakeDefault()
        {
            try
            {
                string exe = Installer.Install();
                PostHostInfo();
                var answer = MessageBox.Show(this,
                    "Paraphe is installed for your account and listed as a PDF app.\n\n" +
                    "Windows asks you to confirm the default yourself. Open Settings now and pick Paraphe for .pdf?",
                    "Paraphe", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes) Installer.OpenDefaultAppsSettings();
                if (!string.Equals(exe, Application.ExecutablePath, StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show(this,
                        $"Paraphe was copied to:\n{Path.GetDirectoryName(exe)}\n\nYou can delete the folder you extracted it to. Paraphe is in the Start menu.",
                        "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Couldn't install Paraphe: " + ex.Message, "Paraphe", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override async void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (_closeConfirmed || _web.CoreWebView2 == null) return;
            e.Cancel = true;
            string dirty = "false";
            try
            {
                dirty = await _web.CoreWebView2.ExecuteScriptAsync("!!(window.parapheIsDirty && window.parapheIsDirty())");
            }
            catch
            {
                // Page not responding: allow closing.
            }
            if (dirty == "true" &&
                MessageBox.Show(this, "You have unsaved changes. Close anyway?", "Paraphe",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.Yes)
            {
                return;
            }
            _closeConfirmed = true;
            Close();
        }
    }
}
