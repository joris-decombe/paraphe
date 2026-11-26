using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Paraphe
{
    /// <summary>
    /// Colours the window's title bar to match the page: dark mode on Windows 10
    /// and 11, and the toolbar's own colours on Windows 11.
    /// </summary>
    internal static class TitleBar
    {
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19; // Windows 10 before 20H1
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        private const int DWMWA_CAPTION_COLOR = 35;               // Windows 11
        private const int DWMWA_TEXT_COLOR = 36;

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        public static void Apply(Form form, bool dark, string caption, string text)
        {
            int on = dark ? 1 : 0;
            if (DwmSetWindowAttribute(form.Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, 4) != 0)
                DwmSetWindowAttribute(form.Handle, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref on, 4);

            Color? back = Parse(caption), fore = Parse(text);
            if (back is Color b)
            {
                form.BackColor = b; // what shows while the page loads or resizes
                int colorref = ColorRef(b);
                DwmSetWindowAttribute(form.Handle, DWMWA_CAPTION_COLOR, ref colorref, 4);
            }
            if (fore is Color f)
            {
                int colorref = ColorRef(f);
                DwmSetWindowAttribute(form.Handle, DWMWA_TEXT_COLOR, ref colorref, 4);
            }
        }

        private static int ColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

        /// <summary>Reads a computed CSS colour such as "rgb(35, 38, 45)".</summary>
        private static Color? Parse(string css)
        {
            if (css == null) return null;
            Match m = Regex.Match(css, @"^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})");
            if (!m.Success) return null;
            int r = int.Parse(m.Groups[1].Value), g = int.Parse(m.Groups[2].Value), b = int.Parse(m.Groups[3].Value);
            if (r > 255 || g > 255 || b > 255) return null;
            return Color.FromArgb(r, g, b);
        }
    }
}
