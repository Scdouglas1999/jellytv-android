using System;
using System.Net.Http;
using Jellyfin.Plugin.Tally.Client;
using Jellyfin.Plugin.Tally.Scores;
using Jellyfin.Plugin.Tally.Services;
using Jellyfin.Plugin.Tally.Sources;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Tally;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost applicationHost)
    {
        services.AddHttpClient("jellytv")
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
            {
                AutomaticDecompression = System.Net.DecompressionMethods.All,
                // Sites often gate pages behind a Set-Cookie + redirect dance —
                // without a jar the request loops until redirect-limit errors.
                UseCookies = true,
                CookieContainer = new System.Net.CookieContainer()
            })
            .ConfigureHttpClient(c => c.Timeout = TimeSpan.FromSeconds(30));

        services.AddHttpClient("jellytv-proxy")
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
            {
                // Raw pass-through: no Accept-Encoding advertised, so upstreams
                // never gzip — avoids decompression latency on multi-MB segments
                // and content-length mismatches.
                AllowAutoRedirect = true,
                // No shared cookie jar: a handler-owned CookieContainer would
                // merge upstream Set-Cookie across different channels' hosts
                // and duplicate any configured Cookie header.
                UseCookies = false
            })
            // Generous: the timeout CTS stays armed through body streaming —
            // a slow 6s segment must not be aborted mid-body.
            .ConfigureHttpClient(c => c.Timeout = TimeSpan.FromSeconds(120));

        // First-time download of the headless browser for web page sources (Playwright driver ~60 MB, Chromium ~120 MB):
        // no overall timeout, slow links just take longer; BrowserRuntime cancels after 30 minutes.
        services.AddHttpClient("jellytv-download")
            .ConfigureHttpClient(c => c.Timeout = System.Threading.Timeout.InfiniteTimeSpan);

        services.AddTransient<IStartupFilter, WebInjectionStartupFilter>();

        services.AddSingleton<StreamSigner>();
        services.AddSingleton<BrowserRuntime>();
        services.AddSingleton<BrowserFetchService>();
        services.AddSingleton<UpstreamFetcher>();
        services.AddSingleton<ProxyCache>();
        services.AddSingleton<UserSettingsStore>();
        services.AddSingleton<SourceManager>();
        services.AddSingleton<Live.LiveLadderService>();
        services.AddSingleton<ScoreboardService>();
        services.AddSingleton<CardArtService>();
        services.AddSingleton<GameArtService>();
        services.AddSingleton<TvAppService>();

        // Client API: the board is assembled by enrichers — add a feature module by adding a line here.
        services.AddSingleton<EventFeed>();
        services.AddSingleton<LiveTvItemIndex>();
        services.AddSingleton<IBoardEnricher, ScoresEnricher>();
        services.AddSingleton<Dvr.DvrService>();
        services.AddSingleton<IBoardEnricher, Dvr.DvrEnricher>();
        services.AddHostedService(sp => sp.GetRequiredService<Dvr.DvrService>());
        services.AddHostedService(sp => sp.GetRequiredService<Live.LiveLadderService>());
        services.AddHostedService<RefreshService>();
        services.AddHostedService<LiveTvRegistrationService>();
        services.AddHostedService<LiveCardRefreshService>();
        services.AddHostedService<PluginRepositoryService>();

        // LG TVs: keeps Developer Mode on for the TVs Tally for LG installed Tally on
        services.AddSingleton(sp => new LgDevModeService(
            sp.GetRequiredService<IHttpClientFactory>(), sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<LgDevModeService>>()));
        services.AddHostedService(sp => sp.GetRequiredService<LgDevModeService>());
    }
}
