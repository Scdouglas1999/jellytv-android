using System.Threading.Tasks;
using Jellyfin.Plugin.Tally.Services;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Tally.Api;

/// <summary>
/// The LG TV app hands over its Developer Mode session token here once someone is signed in (Tally for LG stamped
/// it into the app); <see cref="LgDevModeService"/> keeps the session on. Write-only: tokens are never returned.
/// </summary>
[ApiController]
[Route("JellyTV/Client/v1/lg")]
[Authorize]
public class LgDevModeController : ControllerBase
{
    private readonly LgDevModeService _devMode;
    private readonly IAuthorizationContext _authContext;

    public LgDevModeController(LgDevModeService devMode, IAuthorizationContext authContext)
    {
        _devMode = devMode;
        _authContext = authContext;
    }

    public sealed class DevModeRequest
    {
        public string? Token { get; set; }

        /// <summary>The TV's model ("OLED55CX9LA"), for the log and the settings page.</summary>
        public string? Model { get; set; }
    }

    [HttpPost("devmode")]
    public async Task<IActionResult> Register([FromBody] DevModeRequest request)
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User == null)
        {
            return Unauthorized();
        }

        var name = !string.IsNullOrWhiteSpace(request.Model) ? "LG " + request.Model : auth.Device ?? "an LG TV";
        return _devMode.Register(auth.DeviceId ?? string.Empty, name, request.Token ?? string.Empty) ? NoContent() : BadRequest();
    }
}
