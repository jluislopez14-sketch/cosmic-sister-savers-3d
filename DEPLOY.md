# Deploying Cosmic Sister Savers to Vercel

## Quick deploy

```bash
npm i -g vercel@latest
vercel login          # one-time, opens browser
vercel deploy         # preview deployment (any branch)
vercel deploy --prod  # production
```

The first run will ask:
- **Set up and deploy?** → yes
- **Which scope?** → your team / personal
- **Link to existing project?** → no (or yes if you've deployed before)
- **In which directory?** → `./` (project root)
- **Override settings?** → no (keep `vercel.json` defaults)

After deploy, paste the URL into the game's `index.html` (or set
`window.__remoteLeaderboardURL` on the page) so submissions go to your
backend.

## Optional: persistent leaderboard with Upstash Redis

By default the API uses an in-memory store that resets on cold starts.
For a persistent global leaderboard, install Upstash through the Vercel
Marketplace:

1. **Storage tab** in the Vercel dashboard → Browse Marketplace → **Upstash for Redis** → Install.
2. Vercel will auto-provision `KV_REST_API_URL` + `KV_REST_API_TOKEN` env vars.
3. Run `vercel env pull` locally to sync.
4. Redeploy. The leaderboard endpoint detects the env vars and switches
   to Upstash automatically.

## API contract

```
POST /api/leaderboard
  Body: { score, combo, hard, name? }
  Returns: { rank, top: [...], source }

GET  /api/leaderboard
  Returns: { top: [{ score, combo, hard, name, ts }, ...], source }
```

`top` is sorted descending by score, max 25 entries.
`source` is `'upstash'` or `'memory'`.

## File map

- `vercel.json` — caching headers + `model/gltf-binary` MIME type for GLBs
- `package.json` — dependency on `@upstash/redis`
- `api/leaderboard.js` — single serverless function for both GET/POST
- `js/RemoteLeaderboard.js` — client wrapper (already in the project)

## Hooking up the client

Open `index.html` and add this in `<head>` (or anywhere before `js/main.js`):

```html
<script>window.__remoteLeaderboardURL = '';   // empty = same origin</script>
```

When deployed to `https://your-app.vercel.app`, the client makes
same-origin requests to `/api/leaderboard` automatically.
