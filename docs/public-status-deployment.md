# Public Appbox status page deployment

The public page is https://status.appbox.co/. Administration stays at http://localhost:52345 through the existing SSH tunnel.

## Production configuration

- VPS: 202.61.194.214, Checkmate under /opt/checkmate, application port bound to 127.0.0.1:52345.
- Cloudflare zone: appbox.co, account 39c212b1305b53d11826a8fa15dbacf4, zone 9e7efcc603ac4e253369ffc2fd7ceaaf.
- DNS: proxied A record, name status, address 202.61.194.214, TTL Auto. Cloudflare provides public IPv4 and IPv6 access.
- TLS: the zone already uses Full (strict). The hostname-specific Cloudflare Origin CA certificate expires 14 September 2041 at 18:03 UTC. Keep proxying enabled: this certificate is trusted by Cloudflare, not by ordinary browsers connecting directly to the VPS.
- Certificate: /etc/nginx/ssl/status.appbox.co.pem; private key: /etc/nginx/ssl/status.appbox.co.key. The key was generated on the VPS and stays root-only. Never commit key material.
- Nginx configuration: /etc/nginx/conf.d/checkmate-status.conf. Reviewed copy: deploy/nginx/status.appbox.co.conf. Nginx is enabled at boot.
- Status page: appbox (ID 6aacf1fada712f9860a903fe), team 6aaab6a34711d7db1fae67e5, customDomain status.appbox.co, isPublished true, 32 selected monitors. The admin login link remains hidden. Existing paused-monitor handling excludes the paused monitor from the overall status and active count.
- App image at cutover: appbox/checkmate:3.12.0-pushover-61c16e424e96. The cutover does not change application code, monitor settings or notification channels.

## Routing and caching

HTTP redirects to HTTPS. Nginx exposes only the status document, runtime config, frontend assets, favicon, source download and the existing public status API. Admin paths return 404 and write methods return 405.

The public /config.js selects same-origin API requests and identifies the existing private instance hostname so Checkmate renders its custom-domain status view at /. Requests to the two public status API routes resolve only the Appbox page. They use fixed monitor types and the validated latest, 30d, 60d or 90d range. Authentication headers and cookies are not forwarded on this public surface.

Nginx shares public document/API reads for one second and hashed assets for one hour. Both API routes share a cache key per range. This keeps visitors from sharing the backend's 600-per-minute IP limit. Failures are not cached, stale responses are not served, and browser/Cloudflare caching is disabled with Cache-Control: no-store. The source archive is always fetched from the running image. HTML and assets are proxied from that image, so future image deployments require no separate frontend copy.

## Verification after deployment

Run nginx -t and /opt/checkmate/verify.sh. Verify the public root and status API over HTTPS, all three history ranges, the logo link and source download. Confirm /login and /api/v1/monitors return 404 publicly while the SSH-tunnel dashboard still works.

Cloudflare's RSA Origin CA certificate is saved at /etc/nginx/ssl/cloudflare-origin-ca-rsa.pem for direct origin checks with curl --cacert and --resolve. Source: https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/.

## Cutover and rollback

Cutover date: 18 September 2026. Before changing DNS, origin HTTPS, all four data ranges and public route restrictions passed. DNS was changed using the Cloudflare dashboard in Chrome.

Pre-cutover application/database backup: /var/backups/checkmate/backup-20260918T180533Z-5AhKvL. The same directory includes nginx-before-status with the Nginx configuration baseline.

To restore the old public provider, edit only status.appbox.co in Cloudflare: replace the proxied A record with a DNS-only CNAME to stats.uptimerobot.com, TTL Auto. Existing resolver caches may briefly use either provider. UptimeRobot monitors and account settings were not modified as part of the DNS cutover.

To unpublish Checkmate after a rollback, update the same status page through its native service or UI: isPublished false and customDomain cleared. Do not restore an entire database backup merely to change these two settings, since that would discard subsequent monitoring history.
