# Deployment

FreeCut is deployed as a static Vite application at `https://video.xedoc.ru`.
The editor stores projects and imported media in the user's selected local
workspace; the web server does not receive user media or project files.

## Server layout

- Host: `82.146.42.213`
- Web root: `/var/www/video.xedoc.ru/current`
- nginx site: `/etc/nginx/sites-enabled/video.xedoc.ru`
- Tracked nginx template: `deploy/nginx/video.xedoc.ru.conf`

## Release

From the repository root, build the immutable frontend bundle:

```bash
npm ci
npm run build
```

Upload `dist/` to a new timestamped release on the server, validate nginx, and
atomically point `current` to that release. The first HTTPS deployment also
requires a Let's Encrypt certificate for `video.xedoc.ru`.

The nginx configuration sets the cross-origin isolation headers required by
FreeCut's worker/media pipelines, routes client-side URLs to `index.html`,
avoids caching the entry page and service worker, and caches hashed assets for
one year.
