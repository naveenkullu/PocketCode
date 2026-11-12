# Development

## Prerequisites

- Node.js 22 or later (the root package declares `engines.node` as `>=22`).
- npm.
- Optional for GitHub workflows: a GitHub OAuth application and GitHub App with the required repository access.
- Optional for web AI requests: an API key for a provider supported by the provider-settings route.

## Setup

From the project root:

```powershell
npm install
npm --prefix frontend install
Copy-Item .env.example .env
```

On macOS/Linux, use `cp .env.example .env` for the final command.

Configure `.env` locally as needed. GitHub OAuth/App values are required for sign-in and repository integration. The web application receives user AI credentials through its settings UI; the CLI configuration in `src/index.ts` is separate. Never commit `.env` or paste real values into issues or logs.

## Run locally

Start the backend and frontend in separate terminals:

```powershell
npm run dev
npm --prefix frontend run dev
```

The backend defaults to `127.0.0.1:3000`; Vite binds to `127.0.0.1:5173` and proxies API requests to the backend.

## Build and type-check

```powershell
npx tsc --noEmit -p tsconfig.json
npm run build
npm --prefix frontend run build
```

The frontend build runs its TypeScript project build before Vite creates frontend output.

## Tests

The root `test` script is `tsx --test tests/*.test.ts`. However, the current test files mix imports from Node's built-in `node:test` and Vitest, while Vitest is not declared in the root package manifest. The root command therefore does not reliably execute the complete test suite; three Vitest-based diagnostics files have failed under this runner.

For a focused Node test file, the project has used:

```powershell
npx tsx --test tests/agents.test.ts
```

Vitest-based tests require the Vitest runner and a compatible dependency setup, which the current root manifest does not provide. Do not interpret a partial test run as a full green suite. There is no frontend test script in `frontend/package.json`.

## Available package scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch and run the Fastify backend |
| `npm run build` | Compile the TypeScript backend to `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev:cli` | Run the separate environment-configured CLI |
| `npm run start:cli` | Run the compiled CLI |
| `npm test` | Attempt Node test-runner execution of `tests/*.test.ts`; currently mismatched for Vitest tests |
| `npm --prefix frontend run dev` | Start Vite frontend |
| `npm --prefix frontend run build` | Type-check and build frontend |
| `npm --prefix frontend run preview` | Preview a built frontend |

## Data locations and cleanup

The database defaults to `data/pocketcode.sqlite`. Workspace runtime data is kept separately from source files. Both are local data and should not be committed. Build output, dependency directories, local environment files, and runtime recovery artifacts are excluded by `.gitignore`.
