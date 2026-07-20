# Shortify Hub

YouTube Shorts, Instagram Reels, and TikTok content operations in one local-first service. The repository contains three independent runtimes:

- `frontend/`: responsive browser application with ten API-backed views
- `backend/`: JSON API and SQLite persistence
- `worker/`: independent asynchronous project-processing worker

Creating a project returns `202 Accepted` immediately. The worker claims the queued job transactionally, records heartbeat and progress, generates one content item and three hook variants per selected channel, and completes the project independently from the API process.

## Run locally

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080). The API is available through the same origin at `/api`; the direct API listener uses `http://localhost:3000`.

The default database is `data/statusscreen.db`. Stop the process with `Ctrl-C`; the API and worker shut down cleanly.

## Run with Docker

```bash
docker compose up --build -d
docker compose ps
```

Open [http://localhost:8080](http://localhost:8080). SQLite data persists in the `statusscreen-data` volume.

```bash
docker compose down
```

## Verify

```bash
npm run verify
npm run test:e2e
```

`npm run verify` runs syntax checks plus API, persistence, queue, retry, stale-job recovery, graceful shutdown, and frontend-server tests. `npm run test:e2e` launches an isolated database and browser, exercises all ten views and critical mutations, checks desktop/mobile overflow and browser errors, and writes screenshots under `test-results/`.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `STATUSSCREEN_DB` | `data/statusscreen.db` | SQLite database path shared by API and worker |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | API listener |
| `FRONTEND_HOST` / `FRONTEND_PORT` | `127.0.0.1` / `8080` | Frontend listener |
| `BACKEND_URL` | `http://127.0.0.1:3000` | Frontend server proxy target |

## Reliability model

- SQLite uses WAL, foreign keys, a busy timeout, and transactional job claiming.
- The worker records heartbeat and progress, retries failed jobs up to the configured attempt limit, periodically recovers abandoned jobs, and finishes active work during shutdown.
- API errors use `{ "error": { "code", "message", "details" } }`, include request IDs, enforce a body limit, and expose local-development CORS only.
- The frontend provides loading, empty, error, retry, confirmation, and timeout states for API operations.

Channel connection state and generated content are persisted locally. Real uploads to YouTube, Instagram, or TikTok require each platform's OAuth credentials and review-approved publishing APIs; this repository does not claim or perform external uploads without those credentials.
