# Sales Pipeline Intelligence — Backend

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.18-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose%207-47A248?logo=mongodb&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-cache%20%2B%20rate--limit-DC382D?logo=redis&logoColor=white)
![Salesforce](https://img.shields.io/badge/Salesforce-OAuth%202.0%20%2B%20Bulk%20API-00A1E0?logo=salesforce&logoColor=white)
![Groq](https://img.shields.io/badge/AI-Groq%20LLM-F55036)
![License](https://img.shields.io/badge/license-proprietary-lightgrey)

The Express/MongoDB API powering **Sales Pipeline Intelligence** — a B2B sales pipeline platform with live, two-way Salesforce integration, an AI assistant capable of executing multi-step CRM workflows, real-time team collaboration, analytics, and secure bulk data operations.

This service owns **every** integration point: authentication, all Salesforce API traffic (REST, SOAP, and Bulk API — the frontend never talks to Salesforce directly), the Groq LLM integration, caching, rate limiting, email, PDF generation, and both real-time channels (WebSocket + Socket.IO).

> **Companion project:** [`Fronted-MERN`](../Fronted-MERN/README.md) — the React SPA that consumes this API.

---

## Table of Contents

- [Feature Highlights](#feature-highlights)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Tech Stack](#tech-stack)
- [Complete Dependency Reference](#complete-dependency-reference)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started-local-development)
- [Environment Variables](#environment-variables)
- [NPM Scripts](#npm-scripts)
- [Project Structure](#project-structure)
- [API Surface](#api-surface)
- [The AI Assistant (Groq Function Calling)](#the-ai-assistant-groq-function-calling)
- [Two-Factor Authentication](#two-factor-authentication)
- [Real-Time Architecture](#real-time-architecture)
- [Security Architecture](#security-architecture)
- [Deployment](#deploying)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Feature Highlights

### Salesforce Integration
- Full CRUD for **Accounts, Contacts, Leads, Opportunities, Contracts, and Quotes** (with line items) against a live Salesforce org — Salesforce is the system of record; MongoDB only stores this app's own users, teams, jobs, and audit trail.
- **OAuth 2.0 Authorization Code + PKCE** flow, entirely server-side — an authorization code or access token never reaches client-side JavaScript.
- **Lead conversion** (single and bulk) via hand-built SOAP `convertLead` envelopes — the only way to convert a Lead, since Salesforce has no REST equivalent.
- **Quote-to-PDF generation and emailing**, with line-item totals computed server-side and mirrored on the client for live previews.
- **Inbound Salesforce webhook** (HMAC-SHA256 verified) that reacts in real time when a deal is closed *directly in Salesforce*, computing commission and pushing a live "deal won/lost" notification back into the app.
- **Optimistic-concurrency conflict resolution**: a 3-way merge (base vs. live vs. incoming) detects when two people edited the same Opportunity/Quote concurrently, rather than silently overwriting one edit.
- **Bulk Insert / Update / Upsert / Delete** via the real Salesforce **Bulk API**, from pasted JSON or an uploaded CSV, with per-row pre-validation, job polling, and downloadable success/failure result sets.
- **CSV/PDF export** of any dashboard, report, quote, or bulk-job result via short-lived, single-use, integrity-hashed download tokens.

### AI Assistant (Groq)
- A floating **chat widget** for general CRM help (drafting emails, explaining features) — deliberately scoped away from live CRM data.
- An **"Actions" mode** built on **Groq's function-calling / agentic tool-calling**, capable of planning and executing **multi-step Salesforce workflows** in one conversation (e.g. *"create an Account, add an Opportunity, and generate a Quote"*) — the model chains tool calls, threading each step's real Salesforce ID into the next, but every mutating action requires **explicit user confirmation** before anything is actually written.
- Row-level AI actions throughout the app: quote follow-up email drafting, quote risk scoring (green/amber/red), discount-justification drafting, account activity summarization, opportunity executive summaries, and natural-language search-query parsing.
- All mutating writes triggered by the AI assistant go through a dedicated `jsforce`-based Salesforce client, kept deliberately separate from the primary `axios`-based client used everywhere else.

### Analytics, Reporting & Insights
- **Pipeline health, forecast, deal-risk, team-performance, and revenue-trend** reports, computed live from Salesforce SOQL with short-TTL Redis caching.
- **SaaS metrics suite**: ARR forecast, churn-risk scoring, customer health, and expansion-opportunity detection derived from Closed-Won Opportunity data.
- **Rules-based lead scoring** (firmographic + engagement + recency) producing an explainable Hot/Warm/Cold tier, synced back to Salesforce's `Rating` field.
- **Sales territory map** — Account billing addresses geocoded (OpenStreetMap Nominatim, 30-day cache) and annotated with opportunity count/value.

### Real-Time Collaboration
- Live **presence indicators** ("who's online" and "who's viewing this record right now") over Socket.IO.
- Live **in-app notifications** (record changes, deal closed, discount-justification requests, email failures) over a dedicated WebSocket channel.
- A **cross-entity activity feed** built from the audit trail.

### Security, Compliance & Access Control
- **Two-Factor Authentication (TOTP)** with QR-code setup and single-use backup codes.
- **Role-based access control** (admin / manager / user / sales_rep / viewer) enforced on every mutating route.
- **AES-256-GCM encryption at rest** for Salesforce OAuth tokens and 2FA secrets, with every decryption audit-logged.
- **Ten distinct, Redis-backed rate-limit tiers** — general API, auth, Salesforce reads, Salesforce writes, the highest-blast-radius actions (bulk jobs, exports — 5/hour), outbound email, inbound webhooks, and a dedicated global quota guard on the shared Groq AI key.
- **CSV/formula-injection sanitization** on every exported cell.
- A full, queryable **audit log** of every create/read/update/delete/login/export/import action in the system.

### Team & Access Management
- Team creation with a designated manager and member roster; managers are scoped to their own team's data where relevant.

---

## Architecture at a Glance

```
                         ┌────────────────────────┐
                         │   Fronted-MERN (SPA)    │
                         └───────────┬─────────────┘
                                     │ HTTPS + httpOnly cookie (JWT)
                                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         Backend-MERN (this repo)                      │
│                                                                        │
│   Express app.js                                                      │
│   ├─ REST API (/api/*) ─── controllers ─── services ─── models        │
│   ├─ WebSocket  (/ws)         → NotificationService (live push)       │
│   └─ Socket.IO  (/socket.io)  → PresenceService (who's online/viewing)│
│                                                                        │
│   Two independent Salesforce clients:                                 │
│   ├─ SalesforceService (axios)  → everything except AI-confirmed writes│
│   └─ jsforceService (jsforce)   → only AI-assistant-confirmed writes   │
│                                                                        │
│   groqService  ──── Groq LLM API (chat + function calling)            │
└───────┬───────────────────────┬───────────────────────┬──────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
   MongoDB (Mongoose)        Redis (cache,          Salesforce org
   users, teams, jobs,       rate limits,           (system of record for
   audit log, conflict       download tokens,       Accounts/Contacts/Leads/
   log, local Quote          geocoding cache)       Opportunities/Contracts/
   sync records)                                    Quotes)
```

**Design decisions worth knowing before you touch this codebase:**

- **Salesforce is never cached locally as a source of truth.** Every read is a live SOQL query, short-TTL cached in Redis (a few minutes). MongoDB only stores this app's *own* data.
- **Two separate Salesforce clients exist on purpose.** The primary `axios`-based `SalesforceService` (raw REST/SOQL/SOAP, no SDK) powers every manually-triggered feature. A second, `jsforce`-based client powers *only* writes the AI assistant proposes and the user explicitly confirms — isolating the AI's write path from the rest of the app.
- **Two real-time channels exist on purpose, not by accident.** A plain `ws` WebSocket server handles live notifications (deal closed, discount justification requested, etc.); a separate Socket.IO server handles presence (online roster, per-record "N people viewing"). They're independent systems with independent client connections.
- **Stored Salesforce tokens and 2FA secrets are encrypted at rest** and every decryption is individually audit-logged.

---

## Tech Stack

| Concern | Technology |
|---|---|
| Runtime | Node.js (ES Modules), Express 4 |
| Database | MongoDB via Mongoose 7 |
| Cache / rate limiting / atomic tokens | Redis (`redis` v6, `rate-limit-redis`) |
| Authentication | JWT (httpOnly cookie) |
| Two-Factor Authentication | TOTP (`speakeasy`) + QR code rendering (`qrcode`) + SHA-256-hashed single-use backup codes |
| Salesforce (primary) | OAuth 2.0 Authorization Code + PKCE, REST + SOAP over raw `axios` (no SDK) |
| Salesforce (AI-assistant writes) | `jsforce` — a second, isolated client used only for AI-confirmed mutations |
| AI / LLM | Groq API — chat completions **and** function-calling / agentic tool loops |
| Email | Nodemailer (SMTP) |
| PDF generation | `pdfkit` |
| CSV | `csv-parse` (import), `@json2csv/plainjs` (export), `multer` (upload handling) |
| Real-time (notifications) | `ws` — plain WebSocket server |
| Real-time (presence) | `socket.io` — online roster + per-record viewer presence |
| Scheduling | `node-cron` (daily pipeline-summary emails) |
| Geocoding | OpenStreetMap Nominatim (via `axios`), Redis-cached |
| Security middleware | `helmet`, `cors`, `express-rate-limit`, `cookie-parser` (signed cookies) |
| Encryption | Node's built-in `crypto` — AES-256-GCM with per-record scrypt-derived keys |
| XML parsing | `fast-xml-parser` (SOAP responses, e.g. lead conversion) |

---

## Complete Dependency Reference

Every package in `package.json`, with no omissions:

<details>
<summary><strong>Production dependencies (26)</strong></summary>

| Package | Version | Purpose |
|---|---|---|
| `@json2csv/plainjs` | `^7.0.8` | Converts arrays of records to CSV for exports and Bulk API uploads |
| `axios` | `^1.4.0` | HTTP client for every Salesforce REST/SOQL call, SOAP envelope posting, and outbound geocoding requests |
| `bcryptjs` | `^2.4.3` | Password hashing |
| `compression` | `^1.7.4` | Gzip response compression |
| `cookie` | `^2.0.1` | Cookie serialization/parsing utility |
| `cookie-parser` | `^1.4.6` | Signed httpOnly cookie parsing (JWT session, OAuth state) |
| `cors` | `^2.8.5` | Cross-Origin Resource Sharing, locked to `CLIENT_URL` |
| `csv-parse` | `^7.0.2` | Parses uploaded CSV files for bulk import |
| `dotenv` | `^16.0.3` | Loads `.env` into `process.env` |
| `express` | `^4.18.2` | HTTP server / routing framework |
| `express-rate-limit` | `^6.7.0` | Rate-limiting middleware (used across 10 distinct tiers) |
| `fast-xml-parser` | `^5.11.1` | Parses SOAP XML responses (e.g. Salesforce `convertLead`) |
| `helmet` | `^7.0.0` | Security-related HTTP headers |
| `jsforce` | `^3.10.25` | Second Salesforce client, used exclusively for AI-assistant-confirmed writes |
| `jsonwebtoken` | `^9.0.0` | Signs/verifies session and pending-2FA JWTs |
| `mongoose` | `^7.0.3` | MongoDB ODM |
| `multer` | `^2.4.0` | Multipart form handling for CSV file uploads |
| `node-cron` | `^3.0.3` | Schedules the daily pipeline-summary email job |
| `nodemailer` | `^10.0.10` | SMTP email sending |
| `pdfkit` | `^0.20.2` | Generates quote and dashboard PDFs |
| `qrcode` | `^1.5.4` | Renders the TOTP QR code for 2FA setup |
| `rate-limit-redis` | `^3.1.0` | Redis-backed store for `express-rate-limit` |
| `redis` | `^6.2.1` | Redis client (caching, rate limiting, atomic download tokens, geocoding cache) |
| `socket.io` | `^4.8.3` | Real-time presence server (online roster, per-record viewers) |
| `speakeasy` | `^2.0.0` | TOTP secret generation and verification for 2FA |
| `ws` | `^8.21.3` | Real-time notification server (plain WebSocket) |

</details>

<details>
<summary><strong>Development dependencies (1)</strong></summary>

| Package | Version | Purpose |
|---|---|---|
| `nodemon` | `^3.0.1` | Auto-restarts the server on file changes during development |

</details>

---

## Prerequisites

- **Node.js 18+** (Node 20 LTS recommended) and npm
- A **MongoDB** database (Atlas or self-hosted)
- A **Redis** instance — a Windows binary is bundled at `tools/redis/redis-server.exe` for local dev convenience; use a hosted instance (Render Key Value, Upstash, etc.) in production
- A **Salesforce org** with a Connected App (OAuth 2.0, PKCE-capable) — required for any Salesforce-backed feature
- A **Groq API key** ([console.groq.com](https://console.groq.com/keys), free tier available) — required for the AI assistant and chat widget; every AI feature degrades to "disabled" gracefully without one
- An **SMTP account** for outbound email (password reset, verification, notifications) — optional; auth flows still function without it, just without emails

---

## Getting Started (local development)

```bash
npm install
cp .env.example .env   # then fill in the values — see the table below
npm run dev             # nodemon, restarts on file changes
# or
npm start                # plain node, for production-like runs
```

The API listens on `http://localhost:5005` by default (`PORT`). Health check: `GET /api/health`.

If you're using the bundled local Redis binary on Windows:

```bash
tools/redis/redis-server.exe tools/redis/redis.windows.conf
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill these in. **Never commit `.env`.**

### Server & database

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `development` or `production`. Also toggles cookie `secure` flags and hard-fails on a placeholder `ENCRYPTION_KEY` in production. |
| `PORT` | yes | Port the server listens on (default `5005`). |
| `CLIENT_URL` | yes | The deployed frontend's origin. Used for CORS **and** as the base of every emailed link (password reset, verification, OAuth redirect). |
| `MONGODB_URI` | yes | MongoDB connection string. |

### Authentication & encryption

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | Random 32+ char secret. Also signs OAuth-state cookies. Generate with `openssl rand -hex 32`. |
| `JWT_EXPIRE` | yes | e.g. `7d`. |
| `ENCRYPTION_KEY` | yes | Encrypts Salesforce OAuth tokens and 2FA secrets at rest (AES-256-GCM). Use a long, random value — required (hard-fails the process) in production. |

### Redis

| Variable | Required | Notes |
|---|---|---|
| `REDIS_URL` | yes (production) | A hosted Redis instance's full connection string (e.g. `redis://:password@host:port`). Takes priority over `REDIS_HOST`/`REDIS_PORT` when set. |
| `REDIS_HOST` / `REDIS_PORT` | yes (local) | Plain Redis connection, used when `REDIS_URL` is unset — fine for the bundled local dev server. |

### Email (optional)

| Variable | Required | Notes |
|---|---|---|
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_FROM` | no | SMTP credentials. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not the account password. Without these, email-dependent features log an error but never block the underlying action. |

### Salesforce OAuth (optional, but required for any Salesforce feature)

| Variable | Required | Notes |
|---|---|---|
| `SALESFORCE_CLIENT_ID` / `SALESFORCE_CLIENT_SECRET` | no | From your Salesforce Connected App. Without these, Salesforce features return a clear "not configured" error rather than crashing. |
| `SALESFORCE_USERNAME` | no | Used by supporting tooling only, not the OAuth login flow itself. |
| `SALESFORCE_REDIRECT_URI` | no | **Must exactly match** the Connected App's callback URL, e.g. `https://your-backend.onrender.com/api/auth/salesforce/callback`. |
| `SALESFORCE_AUTH_URL` / `SALESFORCE_TOKEN_URL` | no | Default to production Salesforce (`login.salesforce.com`); point at `test.salesforce.com` for a sandbox. |
| `SALESFORCE_WEBHOOK_SECRET` | no | Shared HMAC-SHA256 secret used to verify the inbound Salesforce webhook (deal closed in Salesforce). Generate with `openssl rand -hex 32`. Without it, the webhook endpoint rejects every request. |

### AI Assistant (optional)

| Variable | Required | Notes |
|---|---|---|
| `GROQ_API_KEY` | no | From [console.groq.com](https://console.groq.com/keys). Without it, the chat widget hides itself and every AI endpoint returns a clear "not configured" error. |
| `GROQ_MODEL` | no | Defaults to a verified-working Groq model; override only after confirming the replacement supports both plain chat and function-calling. |
| `GROQ_CHAT_RPM_GLOBAL` | no | Requests/minute the chat/AI endpoints allow **across all users combined** — Groq's free tier is one shared quota per key, not per user. |

### Scheduling

| Variable | Required | Notes |
|---|---|---|
| `DAILY_SUMMARY_CRON` | no | Cron expression for the daily pipeline-summary email (default `0 8 * * *`). |
| `DISABLE_SCHEDULED_JOBS` | no | Set to `true` to disable all scheduled jobs (useful for local dev). |

---

## NPM Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start with `nodemon` (auto-restart on changes) |
| `npm start` | Start once, no file watching — use this in production |

> There is currently no `test` script — see [Known Limitations](#known-limitations).

---

## Project Structure

```
Backend-MERN/
├── server.js                    Entry point — starts HTTP server, WebSocket, Socket.IO, cron jobs, graceful shutdown
├── src/
│   ├── app.js                   Express app assembly: middleware order, route mounting, error handler
│   ├── config/
│   │   ├── env.js                 Centralized environment variable loading + validation
│   │   ├── db.js                   MongoDB connection
│   │   └── redisClient.js          Shared Redis client
│   │
│   ├── controllers/               One file per resource/feature (24 files)
│   │   ├── accountsController.js, contactsController.js, contractsController.js
│   │   ├── leadsController.js, opportunitiesController.js, quotesController.js
│   │   ├── salesforce.controller.js        Salesforce OAuth flow
│   │   ├── auth.controller.js              Signup/login/logout/password/email verification
│   │   ├── twoFactor.controller.js         2FA setup/verify/validate/disable/backup codes
│   │   ├── bulkOperationsController.js     Bulk API jobs, CSV import/export
│   │   ├── analyticsController.js, saasMetricsController.js
│   │   ├── searchController.js             Global search + typeahead
│   │   ├── mapController.js                Geocoded accounts for the sales map
│   │   ├── teamController.js               Team CRUD
│   │   ├── activityController.js           Cross-entity activity feed
│   │   ├── aiActionsController.js          Row-level AI actions (draft email, risk, summaries)
│   │   ├── aiToolsController.js            AI Assistant chat + confirm-to-execute workflow
│   │   ├── chatbotController.js            General-purpose chat widget
│   │   ├── data.controller.js              Dashboard aggregate data + export
│   │   ├── exportController.js             Redeems secure download tokens
│   │   └── webhookController.js            Inbound Salesforce webhook
│   │
│   ├── services/                  Business logic + integrations (21 files)
│   │   ├── salesforceService.js            Primary Salesforce client (axios, REST/SOQL/SOAP)
│   │   ├── jsforceService.js               Secondary Salesforce client (jsforce, AI-confirmed writes only)
│   │   ├── groqService.js                  Groq LLM client (chat + function calling)
│   │   ├── aiToolsService.js               AI agent loop: plan → confirm → execute
│   │   ├── twoFactorService.js             TOTP/QR/backup-code logic
│   │   ├── tokenService.js                 JWT issuance + cookie management
│   │   ├── encryptionService.js            AES-256-GCM field encryption + audited decryption
│   │   ├── AnalyticsService.js, SaaSMetricsService.js, LeadScoringService.js
│   │   ├── SearchService.js, GeocodingService.js
│   │   ├── conflictResolutionService.js    3-way merge / optimistic concurrency
│   │   ├── ExportService.js                CSV/PDF generation
│   │   ├── emailService.js                 Nodemailer SMTP wrapper
│   │   ├── CacheService.js                 Redis caching layer
│   │   ├── downloadTokenService.js         Single-use, hash-verified download tokens
│   │   ├── NotificationService.js          WebSocket notification routing
│   │   ├── PresenceService.js              Online/viewer presence tracking
│   │   ├── schedulerService.js             node-cron job registration
│   │   └── AuditLogger.js                  Central audit-trail writer/reader
│   │
│   ├── middleware/                 (7 files)
│   │   ├── auth.js                          JWT verification (`protect`)
│   │   ├── rbac.js                          Role→permission authorization
│   │   ├── rateLimiter.js                   10 Redis-backed rate-limit tiers
│   │   ├── csvUpload.js                     Multer config + validation for CSV imports
│   │   ├── errorHandler.js                  Global error handler + `AppError`
│   │   └── salesforceWebhook.js             HMAC-SHA256 webhook signature verification
│   │
│   ├── models/                     Mongoose schemas (7 files)
│   │   ├── User.js                          Profile, role, encrypted Salesforce tokens, 2FA fields
│   │   ├── Team.js, Quote.js
│   │   ├── AuditLog.js, ConflictLog.js, SyncLog.js, BulkJob.js
│   │
│   ├── routes/                     One router per concern (13 files) — see API Surface below
│   ├── realtime/
│   │   └── socketServer.js                  Socket.IO presence server
│   └── utils/                       Pure helper functions (commission math, quote totals, CSV safety)
│
└── tools/redis/                    Bundled Windows Redis 5.0 binaries for local dev convenience
```

---

## API Surface

Every route is mounted under `/api` (except the two real-time channels, `/ws` and `/socket.io`). Health check: `GET /api/health`.

| Router (mount path) | Covers |
|---|---|
| `/api/auth` | Signup, login, logout, password reset, email verification, profile |
| `/api/auth/salesforce` | Salesforce OAuth (auth URL, callback, status, disconnect) |
| `/api/auth/2fa` | Two-factor authentication lifecycle |
| `/api/salesforce` | Accounts, Contacts, Leads, Opportunities, Contracts, Quotes, sales map, activity feed, Bulk API jobs |
| `/api/data` | Dashboard aggregate data + export |
| `/api/analytics` | Pipeline health, forecast, risk, team performance, revenue trend |
| `/api/saas-metrics` | ARR forecast, churn risk, customer health, expansion opportunities |
| `/api/teams` | Team management |
| `/api/search` | Global opportunity search + typeahead + export |
| `/api/export` | Secure download-token redemption |
| `/api/chatbot` | General-purpose AI chat widget |
| `/api/ai` | Row-level AI actions + the AI Assistant's plan/confirm workflow |
| `/api/webhooks` | Inbound Salesforce webhook (public, HMAC-verified) |

<details>
<summary><strong>Full endpoint reference (click to expand)</strong></summary>

**Auth** (`auth.routes.js`) — `POST /signup`, `/login`, `/forgot-password`, `/reset-password`, `/verify-email`, `/verify-email/resend`, `/logout`, `/change-password`, `/delete-account`; `GET /me`; `PUT /profile`

**Salesforce OAuth** (`salesforceAuth.routes.js`) — `GET /auth-url`, `/callback`, `/status`; `POST /disconnect`

**Two-Factor Auth** (`twoFactor.routes.js`) — `POST /validate`, `/setup`, `/verify-setup`, `/disable`, `/backup-codes/regenerate`; `GET /status`

**Salesforce CRM** (`salesforce.routes.js`) — full CRUD for `/opportunities`, `/accounts`, `/contacts`, `/leads` (+ `/convert`, `/sync-score`, `/bulk-convert`), `/contracts`, `/quotes` (+ `/line-items`, `/pdf`, `/email`, `/discount-justification`); `GET /map/accounts`, `/activity`; Bulk API lifecycle under `/bulk/*` (`create-job`, `upload`, `upload-file`, `close`, `status`, `results`, `failed`, download-link generation)

**Analytics** (`analytics.routes.js`) — `GET /pipeline-health`, `/forecast`, `/risks`, `/team-performance`, `/revenue-trend`, `/export/:format`

**SaaS Metrics** (`saasMetrics.routes.js`) — `GET /arr-forecast`, `/churn-risk`, `/customer-health`, `/expansion-opportunities`

**Search** (`search.routes.js`) — `GET /opportunities`, `/suggestions`, `/export/:format`

**Teams** (`team.routes.js`) — `GET /`, `/:id`; `POST /`; `PATCH /:id`; `DELETE /:id`

**Dashboard Data** (`data.routes.js`) — `GET /opportunities`, `/accounts`, `/pipeline-summary`, `/export/:format`

**Export** (`export.routes.js`) — `GET /history`, `/download/:token`

**Chatbot** (`chatbot.routes.js`) — `GET /status`; `POST /message`

**AI Actions & Assistant** (`aiActions.routes.js`) — `POST /quotes/:id/draft-email`, `/quotes/:id/risk`, `/quotes/discount-justification`, `/accounts/:id/activity-summary`, `/opportunities/exec-summary`, `/search/parse-query`, `/assistant/message`, `/assistant/confirm`

**Webhooks** (`webhook.routes.js`) — `POST /salesforce` (public, HMAC-verified)

</details>

---

## The AI Assistant (Groq Function Calling)

The `/api/ai/assistant/*` endpoints implement a genuine **agentic tool-calling loop** against the Groq API:

1. **Plan.** The model is given a small set of tools (`find_accounts`, `find_quotes`, `get_quote_details` — auto-executed, read-only — and `propose_workflow`, which can bundle several mutating steps into one call). It reasons out the *entire* multi-step plan (e.g. Account → Opportunity → Quote) in as few round-trips as possible, using placeholder IDs to reference records it's proposing to create later in the same plan.
2. **Confirm.** The plan is returned to the user as a single, human-readable summary. **Nothing is written to Salesforce at this point.**
3. **Execute.** Only after explicit user confirmation does the backend replay the plan step-by-step for real — via `jsforceService`, not the app's primary Salesforce client — substituting each step's real Salesforce ID into the next as it's created. A failure partway through reports exactly which steps completed rather than an all-or-nothing result.

This design is deliberate: Groq's free tier is a tight, shared **6,000-tokens-per-minute** quota, so the tool schema is kept minimal and round-trips are collapsed into as few Groq calls as possible; and no live Salesforce write is ever triggered without a human in the loop.

---

## Two-Factor Authentication

Full TOTP-based 2FA, powered by `speakeasy` (secret generation/verification) and `qrcode` (QR rendering):

- **Setup** (`POST /2fa/setup`) generates a pending secret (encrypted at rest) and an `otpauth://` QR code.
- **Verification** (`POST /2fa/verify-setup`) proves possession of the authenticator app before the secret is promoted to active.
- **Login** issues a short-lived, pending-2FA JWT when 2FA is enabled; `POST /2fa/validate` accepts either a live TOTP code (±2 time-step tolerance) or a single-use backup code.
- **10 backup codes** are generated per account (`XXXXX-XXXXX` format), stored as SHA-256 hashes, and each is consumable exactly once — with a regeneration endpoint (`POST /2fa/backup-codes/regenerate`).
- **Disable** (`POST /2fa/disable`) removes the secret and backup codes entirely.

---

## Real-Time Architecture

Two independent real-time systems run on the same HTTP server:

| Channel | Path | Library | Purpose |
|---|---|---|---|
| WebSocket | `/ws` | `ws` | Live, per-user notifications: record changes, a deal closing (via the Salesforce webhook), discount-justification requests, email-send failures |
| Socket.IO | `/socket.io` | `socket.io` | Presence: a global online-user roster, and per-record "N people are viewing this" rooms |

Both channels authenticate using the same httpOnly session cookie as the REST API — no separate token exchange.

---

## Security Architecture

- **Encryption at rest** — Salesforce OAuth tokens and 2FA secrets are encrypted with AES-256-GCM, keyed by a per-record scrypt-derived key; every decryption is individually audit-logged.
- **Role-based access control** — a five-role permission table (`admin`, `manager`, `user`, `sales_rep`, `viewer`) gates every write/delete route; admin's permission set is a strict superset of manager's.
- **Tiered rate limiting** (all Redis-backed) — general API, auth (brute-force protection), Salesforce reads, Salesforce writes, a `sensitiveOperationLimiter` (5/hour) on bulk jobs and data exports, outbound email, inbound webhooks (IP-keyed), the chat widget, row-level AI actions, and a global cap protecting the shared Groq API quota.
- **Inbound webhook verification** — the Salesforce → app webhook is authenticated via an HMAC-SHA256 signature over the raw request body, checked with a timing-safe comparison.
- **CSV/formula-injection protection** — every exported CSV cell that begins with `=`, `+`, `-`, or `@` is prefixed with a quote before it's written, preventing formula execution if the file is later opened in Excel/Sheets.
- **Secure, single-use downloads** — dashboard exports, bulk-job results, and quote PDFs are generated once, SHA-256 hash-verified, and handed back as a **single-use, 1-hour download token**, never streamed or linked directly.
- **Full audit trail** — every create/read/update/delete/login/logout/export/import/notify action is recorded with actor, resource, changes, IP, and user agent.
- **Bulk operations are the most tightly gated feature in the app** — running an import job requires manager/admin permissions, is capped at 5/hour, and every job is audit-logged.

---

## Deploying

This is a **stateful** Node process (WebSocket + Socket.IO connections, in-memory notification/presence routing, a `node-cron` job) — it needs a platform that runs a persistent server process, not serverless functions. Render, Railway, Fly.io, or a plain VM all work; Render is used below as the concrete example.

1. Push this folder to its own Git repository (or a monorepo with `Backend-MERN` as the service root).
2. Create a **Web Service**:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Provision **MongoDB** (e.g. MongoDB Atlas, free tier is enough to start) and a **Redis-compatible instance** (e.g. Render's Key Value).
4. Set every environment variable from the tables above. In particular:
   - `CLIENT_URL` → your deployed frontend's URL
   - `SALESFORCE_REDIRECT_URI` → `https://<your-backend-domain>/api/auth/salesforce/callback`
5. In Salesforce Setup → your Connected App → update **Callback URL** to match `SALESFORCE_REDIRECT_URI` exactly (Salesforce rejects a mismatch).
6. Deploy, then confirm `GET https://<your-backend-domain>/api/health` returns `{"status":"ok"}`.

If the deployed frontend can't reach the API, it's almost always one of: `CLIENT_URL` not matching the frontend's real origin (CORS), or the frontend's `VITE_API_URL` not pointing at this service's `/api` path.

---

## Known Limitations

- **No automated test suite.** There is no `test` script, no test framework installed, and no `*.test.js`/`*.spec.js` files anywhere in the repo. Changes are currently validated manually and via `node --check`/linting.
- The bundled `tools/redis/` Windows binaries are a local-dev convenience only — never use them in production; provision a real managed Redis instance instead.

---

## License

No license file is currently included in this repository. Absent an explicit license, all rights are reserved by the project owner — add a `LICENSE` file if you intend to open-source or otherwise formally license this project.
