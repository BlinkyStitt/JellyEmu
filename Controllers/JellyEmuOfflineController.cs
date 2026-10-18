using System.Net.Mime;
using JellyEmu.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Scriban;

namespace JellyEmu.Controllers
{
    /// <summary>Serves the offline library and complete EmulatorJS download manifests.</summary>
    public class JellyEmuOfflineController : JellyEmuBaseController
    {
        public JellyEmuOfflineController(ILibraryManager libraryManager, IApplicationPaths appPaths,
            ILogger<JellyEmuOfflineController> logger, JellyEmuEjsManager ejsManager,
            JellyEmuSessionService sessionService, IHttpClientFactory httpClientFactory)
            : base(libraryManager, appPaths, logger, ejsManager, sessionService, httpClientFactory) { }

        /// <summary>Returns the device's offline game library.</summary>
        [HttpGet("/jellyemu/offline/")]
        public IActionResult Library()
        {
            using var stream = typeof(JellyEmuOfflineController).Assembly
                .GetManifestResourceStream("JellyEmu.Templates.offline.html")!;
            using var reader = new StreamReader(stream);
            var html = Template.Parse(reader.ReadToEnd()).Render(new { base_url = GetPathBase() });
            ApplyCrossOriginIsolationHeaders();
            return Content(html, MediaTypeNames.Text.Html);
        }

        /// <summary>Returns installation metadata for the Home Screen app.</summary>
        [HttpGet("/jellyemu/offline/manifest.webmanifest")]
        public IActionResult WebManifest()
        {
            return new JsonResult(new
            {
                name = "JellyEmu Offline",
                short_name = "JellyEmu",
                start_url = ToAppUrl("jellyemu/offline/"),
                scope = ToAppUrl(string.Empty),
                display = "standalone",
                background_color = "#101820",
                theme_color = "#101820"
            }) { ContentType = "application/manifest+json" };
        }

        /// <summary>Lists every file needed to launch a single-ROM game without the server.</summary>
        [HttpGet("/jellyemu/offline/{itemId}/manifest")]
        public IActionResult DownloadManifest(string itemId, [FromQuery] string userId, [FromQuery] string? core)
        {
            if (!IsValidId(itemId) || !IsValidId(userId)) return BadRequest("Invalid item or user ID.");
            if (!VerifyUser(userId)) return Forbid();
            var item = LibraryManager.GetItemById(itemId);
            if (item == null || string.IsNullOrEmpty(item.Path)) return NotFound();
            var resolvedCore = ResolveCore(item, userId, core);
            if (string.IsNullOrEmpty(resolvedCore) || resolvedCore is "play" or "pico8" ||
                item.Path?.EndsWith(".j3u", StringComparison.OrdinalIgnoreCase) == true)
                return UnprocessableEntity("Offline downloads require a single-ROM EmulatorJS game.");
            if (!EjsManager.IsReady) return Conflict("Emulator files are still downloading on the server. Try again later.");

            var files = GetRuntimeFiles(EjsManager.LocalRoot, resolvedCore);
            if (!files.Any(p => p.StartsWith("cores/", StringComparison.Ordinal) && p.EndsWith(".data")))
                return Conflict("The selected emulator core is missing from the server.");
            var pageUrl = ToAppUrl($"jellyemu/ejs/play/{itemId}?userId={userId}&core={Uri.EscapeDataString(resolvedCore)}");
            var filename = JellyEmuPlayController.CleanCosmeticFilename(Path.GetFileName(item.Path) ?? itemId);
            var urls = files.Select(p => ToAppUrl("jellyemu/ejs/" +
                string.Join('/', p.Split('/').Select(Uri.EscapeDataString)))).ToList();
            urls.Add(pageUrl);
            urls.Add(ToAppUrl($"jellyemu/rom/{itemId}/{Uri.EscapeDataString(filename)}?userId={userId}"));
            foreach (var name in new[] { "jellyemu.utils.js", "coi-serviceworker.js", "ejs.style.css",
                "ejs.input.js", "ejs.core.js", "ejs.save.js", "ejs.setting.js", "ejs.xr.js",
                "ejs.netplay.js", "ejs.offline.js" })
                urls.Add(ToAppUrl("jellyemu/assets/" + name));
            urls.Add(ToAppUrl("jellyemu/threejs/three.min.js"));
            var bios = HttpContext.RequestServices.GetService(typeof(JellyEmuBiosService)) as JellyEmuBiosService;
            var biosPath = bios?.ResolveBiosRelativePath(ResolvePlatformTag(item), resolvedCore);
            if (!string.IsNullOrEmpty(biosPath)) urls.Add(ToAppUrl("jellyemu/bios/file/" + biosPath));
            if (System.IO.File.Exists(GetSavePath(userId, itemId, 1)))
                urls.Add(ToAppUrl($"jellyemu/save/{itemId}/{userId}"));
            return Ok(new { name = item.Name, pageUrl, userId, core = resolvedCore, urls });
        }

        /// <summary>Includes common runtime files and only the selected core's bundles.</summary>
        internal static string[] GetRuntimeFiles(string root, string core)
        {
            return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
                .Select(p => Path.GetRelativePath(root, p).Replace('\\', '/'))
                .Where(p => !p.StartsWith('.') && (!p.StartsWith("cores/", StringComparison.Ordinal) ||
                    Path.GetFileName(p).StartsWith(core + "-", StringComparison.Ordinal) ||
                    Path.GetFileName(p).StartsWith(core + ".", StringComparison.Ordinal)))
                .OrderBy(p => p, StringComparer.Ordinal).ToArray();
        }
    }
}
