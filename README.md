# HackingTheRepo — Backend

> Express.js REST API that manages AI-powered code-refactoring jobs, authenticates users via JWT, and runs the PR pipeline itself (git + make-folder-txt + Groq) to open real GitHub PRs.

---

## Table of Contents

- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Scripts](#scripts)
- [Deployment](#deployment)
- [Upgrade Roadmap](#upgrade-roadmap)

---

## Tech Stack

| Layer            | Tool                           | Version |
| ---------------- | ------------------------------ | ------- |
| Runtime          | Node.js                        | ≥ 18    |
| Framework        | Express.js                     | 4.x     |
| Database         | MongoDB (Mongoose)             | 7.x     |
| Auth             | JSON Web Tokens (jsonwebtoken) | 9.x     |
| Password hashing | bcryptjs                       | 2.x     |
| HTTP client      | Axios                          | 1.x     |
| Deployment       | Vercel (serverless)            | —       |

---

## Architecture Overview

```
Browser / Frontend
        │
        ▼
  Express API  (:5000)
  ├── /api/auth      ← JWT signup / login / me
  ├── /api/jobs      ← CRUD + polling + refinement
  ├── /api/settings  ← GitHub & Groq key management
  └── /api/health    ← liveness probe
        │
        ▼
  In-process PR pipeline (services/)  ←  git clone/push, make-folder-txt, Groq, GitHub API
        │
        ▼
  MongoDB Atlas                ←  Users, Jobs
```

---

## Project Structure

```
backend/
├── middleware/
│   └── auth.js          # JWT protect middleware
├── models/
│   ├── Job.js           # Job schema (status, prUrl, refinements…)
│   └── User.js          # User schema + bcrypt hooks
├── routes/
│   ├── auth.js          # POST /signup  POST /login  GET /me
│   ├── jobs.js          # Full job lifecycle CRUD
│   └── settings.js      # GitHub token & Groq key storage
├── index.js             # Entry point — Express app bootstrap
├── vercel.json          # Vercel serverless config
├── .env.example         # Copy → .env and fill in values
└── .gitignore
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- MongoDB (local or Atlas)
- `git` ≥ 2.31 on the server's `PATH` (used by PR jobs)

### Install & Run

```bash
cd backend
npm install
cp .env.example .env   # fill in your values
npm run dev            # starts with nodemon on :5000
```

---

## Environment Variables

Copy `.env.example` → `.env` and populate every value:

| Variable                   | Required | Description                                                |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `MONGO_URI`                | ✅       | MongoDB connection string                                  |
| `JWT_SECRET`               | ✅       | Long random string for signing tokens                      |
| `REPOMIND_GITHUB_TOKEN`    | —        | Fallback GitHub token for PR jobs when a user saved none   |
| `REPOMIND_GITHUB_USERNAME` | —        | GitHub username of the bot account                         |
| `GROQ_API_KEY`             | —        | Fallback Groq key (prompt assistant + PR jobs)             |
| `GROQ_API_KEYS`            | —        | Extra backup Groq keys, comma-separated; used in turn when a key is expired or rate limited |
| `GROQ_KEYS_FILE`           | `groq.json` | JSON file of Groq keys (gitignored); any list/object of `gsk_` strings |
| `GROQ_MODEL`               | —        | Groq model (default `openai/gpt-oss-120b`)                 |
| `PORT`                     | —        | HTTP port (default `5000`)                                 |

`REPOMIND_API_URL` is no longer used. Optional PR-job tuning (`PR_WORKDIR`, `PR_CLEANUP_WORKDIR`, `PR_MAX_CONCURRENT_JOBS`, `PR_JOB_TIMEOUT_MS`, `PR_STRUCTURE_CHARS`, `PR_CONTEXT_CHARS`, `GROQ_MAX_OUTPUT_TOKENS`) is documented in `.env.example`.

> ⚠️ **Never commit `.env`** — it is already in `.gitignore`.

---

## API Reference

All routes are prefixed with `/api`.

### Auth — `/api/auth`

| Method | Path      | Auth      | Description                 |
| ------ | --------- | --------- | --------------------------- |
| `POST` | `/signup` | ❌        | Register a new user         |
| `POST` | `/login`  | ❌        | Login and receive a JWT     |
| `GET`  | `/me`     | ✅ Bearer | Return current user profile |

**POST /api/auth/signup** — Body: `{ username, email, password }`

**POST /api/auth/login** — Body: `{ email, password }`

All authenticated routes require: `Authorization: Bearer <token>`

---

### Jobs — `/api/jobs`

| Method   | Path          | Auth | Description                                     |
| -------- | ------------- | ---- | ----------------------------------------------- |
| `POST`   | `/`           | ✅   | Create a job (the PR pipeline runs in the background) |
| `GET`    | `/`           | ✅   | List all jobs for the logged-in user            |
| `GET`    | `/:id`        | ✅   | Get a single job by ID                          |
| `GET`    | `/:id/status` | ✅   | Current job state (poll while queued/running)   |
| `POST`   | `/:id/open-pr`| ✅   | Push a completed preview and open its PR        |
| `POST`   | `/:id/refine` | ✅   | Queue another AI pass with a follow-up instruction |
| `POST`   | `/:id/retry`  | ✅   | Re-run a failed (or stuck queued) job           |
| `DELETE` | `/:id`        | ✅   | Delete a job (cancels a running pipeline)       |

**POST /api/jobs** — Body:

```json
{
  "repoUrl": "https://github.com/owner/repo",
  "instruction": "Add unit tests for all utility functions",
  "branchName": "repomind/add-tests", // optional — auto-generated if omitted
  "prTitle": "chore: add utility tests" // optional — auto-generated if omitted
}
```

**Job Status Enum:** `queued` → `running` → `completed` | `failed` (`refined` only appears on old documents)

### How PR jobs work

Clicking **Create PR** (`POST /api/jobs`) stores the job as `queued` and hands it to an in-process queue (`services/jobQueue.js`, at most `PR_MAX_CONCURRENT_JOBS` at once, each limited to `PR_JOB_TIMEOUT_MS`). The pipeline (`services/prPipeline.js`) then:

1. **Checks access** — `GET /repos/{owner}/{repo}` for the default branch and push permission (no push access → fork first).
2. **Clones** the default branch: `git clone --depth 1 --single-branch --branch <default> -c core.symlinks=false …` into `backend/workspace/<owner>-<repo>-<last 6 chars of the job id>` (or `PR_WORKDIR/…`). The folder is kept after the run so you can look at it (`PR_CLEANUP_WORKDIR=true` deletes it instead); the next run of the same job re-clones into it, and deleting the job deletes it. `workspace/` is gitignored and ignored by nodemon (`nodemon.json`), so clones never restart the dev server. The token is sent as an HTTP `AUTHORIZATION` header through `GIT_CONFIG_*` environment variables — never in the URL, argv or `.git/config` — and is redacted from every log and error.
   **Empty repositories** (no commits yet — GitHub still reports a default branch such as `main`): the backend starts the repository locally with an empty `Initial commit` on that branch, and pushes it to GitHub just before the job's own branch, so the PR has a base to target. Previews of an empty repository push nothing.
3. **Branches** — validates the name with `git check-ref-format --branch`; if it already exists on GitHub, appends `-<last 6 chars of the job id>`; then `git checkout -b <branch>`.
4. **Maps the repo** with `make-folder-txt --folder-structure` ([make-folder-txt](https://www.npmjs.com/package/make-folder-txt) ≥ 2.3.1), which prints the folder tree and writes no file; the clone folder's name on the tree's first line becomes `.`. File contents are read from the clone with the same ignore rules (no `node_modules`, `.env*`, lock files or binaries; files over 100 KB are skipped).
5. **Analyzes** with Groq (call 1): the instruction, the structure and key files (README, manifests — or every file if the whole repo fits in `PR_CONTEXT_CHARS`) → `{analysis, plan, files_to_read}`.
6. **Edits** with Groq (call 2): the plan plus the requested files → JSON `changes` (`edit` find/replace, `replace`, `create`, `delete`). Edits whose `find` doesn't match get one repair round asking for full file content. Every path is checked to stay inside the clone (no `..`, absolute paths, `.git/`, symlinks), and CRLF files keep CRLF.
7. **Commits** (`git add -A`, `git commit --no-verify` as the token's GitHub user), stores the diff, `git diff --stat` and the changed files' final contents.
8. **Pushes** with `git push -u origin <branch>` and opens the PR via `POST /repos/{owner}/{repo}/pulls` (an already-open PR for the branch is reused).

With **preview before push**, the job stops after step 7 (`completed` with a `diff`, nothing pushed); **Open PR** (`/open-pr`) replays the stored changes on a fresh clone and runs steps 7–8. **Refine** re-runs steps 4–8 on the PR branch (the open PR updates itself) or, for a preview, on top of the stored changes. **Retry** re-runs the step that failed: a failed create starts from scratch, a failed Open PR publishes the same preview again (or just opens the PR if the branch was already pushed), and a failed refinement runs again.

Groq limits: 429/5xx responses are retried up to 3 times honouring `retry-after` (max 60 s); a "request too large" error halves the repository context once and lowers the output-token budget. Lower `PR_CONTEXT_CHARS`/`PR_STRUCTURE_CHARS` for free-tier models with small tokens-per-minute limits.

Jobs run inside the Node process, so PR jobs need a long-running server with `git` installed (not a serverless function), and a single backend instance: on startup, jobs left `running`/`queued` by a previous process are marked `failed` ("click Retry").

---

### Settings — `/api/settings`

| Method | Path | Auth | Description                                  |
| ------ | ---- | ---- | -------------------------------------------- |
| `GET`  | `/`  | ✅   | Get masked GitHub/Groq keys                |
| `PUT`  | `/`  | ✅   | Update GitHub username, token, or Groq key |

---

### Health

| Method | Path          | Description                                   |
| ------ | ------------- | --------------------------------------------- |
| `GET`  | `/api/health` | Returns `{ status: "ok", bot: "<username>" }` |

---

## Scripts

```bash
npm run dev     # nodemon hot-reload
npm start       # node index.js (production)
```

---

## Deployment

The project includes `vercel.json` for one-click Vercel deployment.

```bash
npm i -g vercel
vercel --prod
```

Add all environment variables in the Vercel dashboard under **Settings → Environment Variables**.

---

## Upgrade Roadmap

Planned improvements to bring the backend to industry-standard production quality.

### Phase 1 — API Documentation (Swagger UI)

> Estimated effort: 1–2 days

Install **swagger-jsdoc** + **swagger-ui-express** to auto-generate interactive docs from JSDoc comments:

```bash
npm install swagger-jsdoc swagger-ui-express
```

Add to `index.js`:

```js
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "HackingTheRepo API", version: "1.0.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ["./routes/*.js"],
});
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec));
```

Then annotate routes with JSDoc `@swagger` blocks. Docs will be live at `http://localhost:5000/api/docs`.

---

### Phase 2 — Input Validation (Zod)

Replace ad-hoc `if (!field)` checks with **Zod** schema validation:

```bash
npm install zod
```

```js
import { z } from "zod";

const createJobSchema = z.object({
  repoUrl: z.string().url(),
  instruction: z.string().min(10).max(1000),
  branchName: z.string().optional(),
  prTitle: z.string().optional(),
});

// In route:
const parsed = createJobSchema.safeParse(req.body);
if (!parsed.success) return res.status(400).json(parsed.error.format());
```

---

### Phase 3 — Rate Limiting & Security Headers

```bash
npm install express-rate-limit helmet
```

```js
import rateLimit from "express-rate-limit";
import helmet from "helmet";

app.use(helmet());
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
app.use("/api/jobs", rateLimit({ windowMs: 60 * 1000, max: 30 }));
```

---

### Phase 4 — Structured Logging (Pino)

Replace `console.log` with **Pino** for JSON logs compatible with Datadog / CloudWatch:

```bash
npm install pino pino-http
```

```js
import pino from "pino";
import pinoHttp from "pino-http";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
app.use(pinoHttp({ logger }));
```

---

### Phase 5 — Job Queue (BullMQ + Redis)

Replace the fire-and-forget Axios call to RepoMind with a proper **BullMQ** queue backed by Redis, enabling retries, concurrency control, and a dashboard:

```bash
npm install bullmq ioredis
```

Benefits:

- Automatic retry on transient failures
- Dead-letter queue for permanently failed jobs
- Bull Board UI for queue monitoring (`@bull-board/express`)
- Backpressure & concurrency limits

---

### Phase 6 — Testing (Vitest + Supertest)

```bash
npm install -D vitest supertest @vitest/coverage-v8
```

Structure:

```
backend/
└── tests/
    ├── auth.test.js
    ├── jobs.test.js
    └── settings.test.js
```

Run:

```bash
npx vitest run --coverage
```

---

### Phase 7 — CI/CD (GitHub Actions)

Add `.github/workflows/backend-ci.yml`:

```yaml
name: Backend CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      mongo:
        image: mongo:7
        ports: ["27017:27017"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

---

### Phase 8 — Database Migrations (migrate-mongo)

```bash
npm install migrate-mongo
```

Tracks schema changes as versioned migration scripts, preventing data loss during production deploys.

---

### Phase 9 — Observability

| Tool                           | Purpose                                     |
| ------------------------------ | ------------------------------------------- |
| **Sentry** (`@sentry/node`)    | Error tracking & alerting                   |
| **Prometheus** (`prom-client`) | Custom metrics endpoint `/metrics`          |
| **OpenTelemetry**              | Distributed traces across Express → FastAPI |

---

### Summary Roadmap

```
v1.0  ✅  Current (Express, JWT, MongoDB, Vercel)
v1.1  →  Swagger UI docs + Zod validation
v1.2  →  Helmet + Rate limiting + Pino logging
v1.3  →  BullMQ job queue + Bull Board dashboard
v1.4  →  Vitest + Supertest test suite (>80% coverage)
v1.5  →  GitHub Actions CI/CD pipeline
v2.0  →  Sentry + OpenTelemetry observability
```
