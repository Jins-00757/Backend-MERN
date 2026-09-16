# Sales Pipeline Intelligence — Backend

Express/MongoDB API powering **Sales Pipeline Intelligence**: a B2B sales pipeline app with live, two-way Salesforce integration (Accounts, Contacts, Leads, Opportunities, Contracts, Quotes), analytics, bulk import/export, and a quotation & proposal generator.

This service owns authentication, all Salesforce API traffic (the frontend never talks to Salesforce directly), caching, rate limiting, email, and PDF generation.

## Tech stack

| Concern | Technology |
|---|---|
| Runtime | Node.js (ES Modules), Express 4 |
| Database | MongoDB via Mongoose |
| Cache / rate limiting | Redis (`redis`, `rate-limit-redis`) |
| Auth | JWT (httpOnly cookie) + TOTP 2FA (`speakeasy`, `qrcode`) |
| Salesforce | OAuth 2.0 Authorization Code + PKCE, REST + SOAP (raw `axios`, no SDK) |
| Email | Nodemailer (SMTP) |
| PDF | `pdfkit` |
| CSV | `csv-parse`, `@json2csv/plainjs`, `multer` |
| Realtime | `ws` (WebSocket) for live notifications |
| Scheduling | `node-cron` (daily summary emails) |
| Security | `helmet`, `cors`, `express-rate-limit`, AES-256 field encryption for stored Salesforce tokens |

## Prerequisites

- Node.js 18+ and npm
- A MongoDB database (Atlas or self-hosted)
- A Redis instance (a Windows binary is bundled at `tools/redis/redis-server.exe` for local dev; use a hosted instance — e.g. Render Key Value, Upstash — in production)
- A Salesforce org with a **Connected App** (OAuth 2.0, PKCE-capable) if you want live Salesforce data
- An SMTP account for outbound email (password reset, verification, notifications) — optional, but signup/reset flows degrade gracefully without it

## Getting started (local development)

```bash
npm install
cp .env.example .env   # then fill in the values (see table below)
npm run dev             # nodemon, restarts on file changes
# or
npm start                # plain node, for production-like runs
```

The API listens on `http://localhost:5005` by default (`PORT`). Health check: `GET /api/health`.

If you're using the bundled local Redis binary:

```bash
tools/redis/redis-server.exe tools/redis/redis.windows.conf
```

## Environment variables

Copy `.env.example` to `.env` and fill these in. **Never commit `.env`.**

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `development` or `production`. Also toggles cookie `secure` flags. |
| `PORT` | yes | Port the server listens on. |
| `MONGODB_URI` | yes | MongoDB connection string. |
| `JWT_SECRET` | yes | Random 32+ char secret. Also signs the OAuth-state cookies. Generate with `openssl rand -hex 32`. |
| `JWT_EXPIRE` | yes | e.g. `7d`. |
| `CLIENT_URL` | yes | The deployed frontend's origin. Used for CORS **and** as the base of every emailed link (password reset, verification, OAuth redirect back to the app). |
| `ENCRYPTION_KEY` | yes | Encrypts Salesforce access/refresh tokens at rest (AES-256, hashed down from whatever length you provide). Use a long random value. |
| `REDIS_HOST` / `REDIS_PORT` | yes (local) | Plain Redis connection, used when `REDIS_URL` is unset - fine for the bundled local dev server, which has no password. |
| `REDIS_URL` | yes (production) | A hosted Redis instance's full connection string (e.g. `redis://:password@host:port`, as Render's Key Value gives you). Takes priority over `REDIS_HOST`/`REDIS_PORT` when set - a hosted instance's password has no other way to travel. |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_FROM` | no | SMTP credentials. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not the account password. Without these, email-dependent features log an error but never block the underlying action (e.g. signup still succeeds without a verification email). |
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | no | From your Salesforce Connected App. Without these, Salesforce features return a clear "not configured" error rather than crashing. |
| `SALESFORCE_USERNAME` | no | Used by supporting tooling only, not the OAuth login flow itself. |
| `SALESFORCE_REDIRECT_URI` | no | **Must exactly match** the Connected App's callback URL, e.g. `https://your-backend.onrender.com/api/auth/salesforce/callback`. |
| `SALESFORCE_AUTH_URL` / `SALESFORCE_TOKEN_URL` | no | Defaults target production Salesforce (`login.salesforce.com`); point at `test.salesforce.com` for a sandbox. |

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start with nodemon (auto-restart on changes) |
| `npm start` | Start once, no file watching — use this in production |

## Project structure

```
src/
  app.js               Express app assembly (middleware, routes, error handler)
  config/               env, MongoDB, Redis connections
  controllers/           one file per resource (accounts, contacts, leads, opportunities,
                          contracts, quotes, bulk operations, analytics, auth, 2FA, ...)
  middleware/            auth (JWT), RBAC, rate limiters, CSV upload, error handling
  models/                Mongoose schemas (User, Team, BulkJob, SyncLog, AuditLog)
  routes/                 one router per concern, mounted in app.js
  services/               SalesforceService (all Salesforce REST/SOAP calls), email,
                          export (CSV/PDF), caching, encryption, notifications, scheduler
  utils/                  small pure helpers (e.g. quote total calculations)
server.js                entrypoint - imports app.js and starts listening
```

## Architecture notes worth knowing before you touch this

- **Salesforce is never cached locally as a source of truth.** Every Accounts/Contacts/Opportunities/Quotes/etc. read is a live SOQL query through `SalesforceService`, short-TTL cached in Redis for a few minutes. MongoDB only stores this app's own data: users, teams, bulk job history, audit logs.
- **Salesforce OAuth happens entirely server-side** (Authorization Code + PKCE). The frontend only ever sees a `?sf=connected` / `?sfError=...` redirect flag — the authorization code and tokens never touch client-side JavaScript.
- **Stored Salesforce tokens are encrypted at rest** (`ENCRYPTION_KEY`) and every decryption is audit-logged.
- **Bulk CSV import** validates every row against required fields *before* it ever reaches Salesforce's Bulk API, and reports rejected rows separately from ones Salesforce itself rejected.
- **Rate limiting is tiered**: a general API limiter, a stricter auth limiter, a Salesforce-CRUD limiter on the whole `/api/salesforce` router, and a `sensitiveOperationLimiter` (5/hour) on the highest-blast-radius actions (starting a bulk job, exporting data, emailing a quote).
- **Secure downloads** (dashboard exports, bulk job results, quote PDFs) are never streamed directly — they're generated once, hashed, and handed back as a single-use, 1-hour download token redeemed via `GET /api/export/download/:token`.

## Deploying

This is a stateful Node process (WebSocket connections, in-memory notification routing, a `node-cron` job) — it needs a platform that runs a **persistent server process**, not serverless functions. Render, Railway, Fly.io, or a plain VM all work; Render is used below as the concrete example.

1. Push this folder to its own Git repository (or a monorepo with `Backend-MERN` as the service root).
2. Create a **Web Service** pointing at that repo:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Provision MongoDB (e.g. MongoDB Atlas, free tier is enough to start) and a Redis-compatible instance (e.g. Render's Key Value).
4. Set every environment variable from the table above on the service. In particular:
   - `CLIENT_URL` → your deployed frontend's URL
   - `SALESFORCE_REDIRECT_URI` → `https://<your-backend-domain>/api/auth/salesforce/callback`
5. In Salesforce Setup → your Connected App → update **Callback URL** to match `SALESFORCE_REDIRECT_URI` exactly (Salesforce rejects a mismatch).
6. Deploy, then confirm `GET https://<your-backend-domain>/api/health` returns `{"status":"ok"}`.

If the deployed frontend can't reach the API, it's almost always one of: `CLIENT_URL` not matching the frontend's real origin (CORS), or the frontend's `VITE_API_URL` not pointing at this service's `/api` path.
