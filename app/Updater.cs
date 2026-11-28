using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Paraphe
{
    /// <summary>
    /// Updates from GitHub releases, verified with the release signing key.
    ///
    /// Each release carries update.json (version, zip name, size, SHA-256) and
    /// update.json.sig, an ECDSA P-256 / SHA-256 signature of update.json's
    /// exact bytes, made offline with the private key (tools/sign-update.mjs).
    /// The public key is built into the app (update-public-key.txt), so an
    /// update is installed only if that key signed it: a compromised GitHub
    /// account or release can't ship one.
    ///
    /// The check is one request for update.json, at most once a day, and only
    /// if the user said yes. It sends nothing about the user's documents.
    /// A downloaded update replaces the app's files when Paraphe closes (or
    /// restarts): running files are renamed to *.old, the new ones copied in,
    /// and the *.old files deleted at the next start.
    /// </summary>
    internal static class Updater
    {
        private const string App = "paraphe-windows";
        private const string DefaultBase = "https://github.com/joris-decombe/paraphe/releases/latest/download/";

        // Lets a test point at a local server. Every update still has to be
        // signed by the built-in key, so this can't be used to ship one.
        private static string BaseUrl =>
            Environment.GetEnvironmentVariable("PARAPHE_UPDATE_BASE") is string b && b.Length > 0 ? b.TrimEnd('/') + "/" : DefaultBase;

        private static string DataDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Paraphe");
        private static string UpdatesDir => Path.Combine(DataDir, "updates");
        // The *.old files an update left behind, one path per line. Only these
        // are ever deleted, so nothing else near the app can be touched.
        private static string CleanupList => Path.Combine(DataDir, "update-cleanup.txt");
        private static string AppDir => AppContext.BaseDirectory.TrimEnd('\\');

        public static Version Current => Assembly.GetExecutingAssembly().GetName().Version;
        public static string CurrentText => $"{Current.Major}.{Current.Minor}.{Current.Build}";

        /// <summary>The folder of a verified, unpacked update waiting to be applied.</summary>
        public static string Staged { get; private set; }
        public static string StagedVersion { get; private set; }

        // ---------- settings ----------

        public sealed class Settings
        {
            /// <summary>"ask" (first launch), "on" or "off".</summary>
            public string Updates { get; set; } = "ask";
            public DateTime LastCheck { get; set; } = DateTime.MinValue;
            public string Skip { get; set; }
            /// <summary>Tabs on (Settings): a PDF opened from Explorer joins the running window.</summary>
            public bool Tabs { get; set; }
        }

        private static string SettingsPath => Path.Combine(DataDir, "settings.json");

        public static Settings Load()
        {
            try
            {
                if (File.Exists(SettingsPath))
                    return new JavaScriptSerializer().Deserialize<Settings>(File.ReadAllText(SettingsPath)) ?? new Settings();
            }
            catch
            {
                // A damaged file: start over (asks again).
            }
            return new Settings();
        }

        public static void Save(Settings s)
        {
            Directory.CreateDirectory(DataDir);
            File.WriteAllText(SettingsPath, new JavaScriptSerializer().Serialize(s));
        }

        // ---------- check ----------

        public sealed class Release
        {
            public string Version;
            public string File;
            public long Size;
            public string Sha256;
        }

        private static HttpClient NewClient()
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = true }) { Timeout = TimeSpan.FromMinutes(5) };
            // A generic name: nothing that identifies the user or the machine.
            http.DefaultRequestHeaders.UserAgent.ParseAdd("Paraphe-Updater");
            return http;
        }

        /// <summary>The newer signed release, or null if this is the latest.</summary>
        public static async Task<Release> CheckAsync()
        {
            using (var http = NewClient())
            {
                byte[] manifest = await http.GetByteArrayAsync(BaseUrl + "update.json");
                string sig = (await http.GetStringAsync(BaseUrl + "update.json.sig")).Trim();
                if (!Verify(manifest, Convert.FromBase64String(sig)))
                    throw new InvalidDataException("The update isn't signed by Paraphe's release key.");

                var m = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(manifest));
                if (!(m.TryGetValue("app", out var app) && app as string == App))
                    throw new InvalidDataException("The update is for another app.");
                var r = new Release
                {
                    Version = m["version"] as string,
                    File = m["file"] as string,
                    Size = Convert.ToInt64(m["size"]),
                    Sha256 = (m["sha256"] as string ?? "").ToLowerInvariant(),
                };
                if (r.File == null || r.File.IndexOfAny(new[] { '/', '\\' }) >= 0 || r.Sha256.Length != 64)
                    throw new InvalidDataException("The update description is malformed.");
                return Version.TryParse(r.Version, out var v) && v > Current ? r : null;
            }
        }

        private static bool Verify(byte[] data, byte[] signature)
        {
            // update-public-key.txt: base64 of the P-256 point X || Y (64 bytes).
            byte[] xy;
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Paraphe.update-public-key.txt"))
            using (var reader = new StreamReader(s))
                xy = Convert.FromBase64String(reader.ReadToEnd().Trim());
            if (xy.Length != 64 || signature.Length != 64) return false;
            var p = new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                Q = new ECPoint { X = xy.Take(32).ToArray(), Y = xy.Skip(32).ToArray() },
            };
            using (var ecdsa = ECDsa.Create(p))
                return ecdsa.VerifyData(data, signature, HashAlgorithmName.SHA256);
        }

        // ---------- download ----------

        /// <summary>Whether this copy of the app can replace its own files.</summary>
        public static bool CanApply()
        {
            try
            {
                string probe = Path.Combine(AppDir, ".update-probe");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Download, check size and hash, unpack. Sets <see cref="Staged"/>.</summary>
        public static async Task DownloadAsync(Release r)
        {
            Directory.CreateDirectory(UpdatesDir);
            string zip = Path.Combine(UpdatesDir, r.File);
            using (var http = NewClient())
            using (var res = await http.GetAsync(BaseUrl + r.File, HttpCompletionOption.ResponseHeadersRead))
            {
                res.EnsureSuccessStatusCode();
                using (var input = await res.Content.ReadAsStreamAsync())
                using (var output = File.Create(zip))
                    await input.CopyToAsync(output);
            }

            var info = new FileInfo(zip);
            string hash;
            using (var sha = SHA256.Create())
            using (var f = File.OpenRead(zip))
                hash = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
            if (info.Length != r.Size || hash != r.Sha256)
            {
                File.Delete(zip);
                throw new InvalidDataException("The downloaded update doesn't match its signed description.");
            }

            string dir = Path.Combine(UpdatesDir, r.Version);
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            ZipFile.ExtractToDirectory(zip, dir);
            File.Delete(zip);
            // The zip holds one folder, Paraphe\, with Paraphe.exe in it.
            string root = Directory.GetFiles(dir, "Paraphe.exe", SearchOption.AllDirectories)
                .Select(Path.GetDirectoryName).OrderBy(d => d.Length).FirstOrDefault();
            if (root == null || !File.Exists(Path.Combine(root, "web", "paraphe.html")))
                throw new InvalidDataException("The update is missing Paraphe.exe or its page.");
            Staged = root;
            StagedVersion = r.Version;
        }

        // ---------- apply ----------

        /// <summary>
        /// Replace the app's files with the staged update. Files in use (this
        /// exe, loaded DLLs) can be renamed but not overwritten, so each one is
        /// renamed to *.old first. On any failure the old files are put back.
        /// </summary>
        public static bool Apply()
        {
            if (Staged == null) return false;
            var done = new List<(string target, string old)>();
            try
            {
                foreach (string src in Directory.GetFiles(Staged, "*", SearchOption.AllDirectories))
                {
                    string target = Path.Combine(AppDir, src.Substring(Staged.Length + 1));
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    string old = null;
                    if (File.Exists(target))
                    {
                        old = target + ".old";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(target, old);
                    }
                    done.Add((target, old));
                    File.Copy(src, target);
                }
                File.AppendAllLines(CleanupList, done.Where(d => d.old != null).Select(d => d.old));
                return true;
            }
            catch
            {
                foreach (var (target, old) in Enumerable.Reverse(done))
                {
                    try
                    {
                        if (File.Exists(target)) File.Delete(target);
                        if (old != null) File.Move(old, target);
                    }
                    catch
                    {
                        // Best effort: the next start cleans up what it can.
                    }
                }
                return false;
            }
        }

        public static void Restart()
        {
            Process.Start(new ProcessStartInfo(Path.Combine(AppDir, "Paraphe.exe"), "--updated") { UseShellExecute = false });
        }

        /// <summary>
        /// At start: remove what a previous update left behind. Right after an
        /// update the old process may still hold its files, so the list keeps
        /// what couldn't be deleted yet for the next try.
        /// </summary>
        public static void CleanUp()
        {
            try
            {
                if (File.Exists(CleanupList))
                {
                    var left = new List<string>();
                    foreach (string old in File.ReadAllLines(CleanupList).Where(l => l.EndsWith(".old")).Distinct())
                    {
                        try { if (File.Exists(old)) File.Delete(old); }
                        catch { left.Add(old); }
                    }
                    if (left.Count == 0) File.Delete(CleanupList);
                    else File.WriteAllLines(CleanupList, left);
                }
                if (Staged == null && Directory.Exists(UpdatesDir)) Directory.Delete(UpdatesDir, true);
            }
            catch
            {
                // Nothing here is worth failing the start for.
            }
        }
    }
}
