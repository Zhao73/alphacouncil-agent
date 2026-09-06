# AlphaCouncil Terminal

A character-cell terminal client for the existing AlphaCouncil research engine. It preserves the full/quick research contracts, per-run method selection and original MCP entry point.

## Start

Extract the **complete** native terminal archive, then run `./alphacouncil` on macOS/Linux or `alphacouncil.cmd` on Windows. Keep the launcher, `runtime/` and `app/` together. The archive includes Node, the interface dependencies and the official Codex runtime; users do not need to install Node, npm or Codex separately.

The native build is currently an **unsigned archive**, not a signed/notarized installer. The build identity and checks are recorded in `build-info.json`; the archive has a separate SHA-256 file. Native archives are platform/architecture specific. Passing a local archive smoke does not verify another operating system, account authorization or live research.

From a source checkout, developers can instead run:

```sh
npm ci --prefix terminal
npm run terminal
```

The regular npm/plugin installation retains `alphacouncil-agent`, the MCP stdio command. It does not install the isolated terminal package's dependencies or replace an existing host setup.

## First research

1. Select a language. A previous choice is only a prefill; the chooser still opens on startup.
2. Enter a ticker, such as `AAPL`, `0700.HK` or `7203.T`. Research covers that instrument without an extra question.
3. Select or add a model connection. Choose a model from the provider's returned list, or enter its exact model ID. API connection checks test actual model/tool access; Codex checks the official login state. Provider availability can still change before a research worker starts.
4. Choose full or quick, then the applicable pace and analyst scope. Full remains the default.
5. Read the returned configuration, select methods and review the final summary. Only **Start research** submits the one-use selection and starts the task.

English, Simplified Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese, Italian, Russian, Vietnamese and Indonesian are available. The selected language is passed unchanged into the research request; worker prose, method explanations, debate and reports follow the run language. Stable IDs, JSON keys, formulas, source titles and original quotations retain their original form. Changing the interface language does not rewrite historical research.

The complete 26-method catalog remains available with each method's identity, approach and best-fit context. The preselected panel is a starting configuration, not evidence that its size or methods are optimal. An abstention or missing source remains visible.

## Read the work

- Click a row, or use arrow keys and Enter. Tab moves to the next selectable row; Esc goes back.
- The research view opens evidence, methods, individual Bull/Bear rounds, reports and sources. An available item opens its actual saved content, including recorded questions and answers. Waiting items do not contain invented statements.
- Details scroll with arrows, the mouse wheel, Page Up/Down, Home and End. Long reports are not replaced with a short summary.
- The client displays public research outputs and exchanges, not private model reasoning or raw provider transcripts.
- `q` or Ctrl+C closes the interface. A live independent runner continues; reopening the same run attaches to it.
- **Stop research** is a separate confirmed action. It stops new work and saves the resulting terminal state. Providers may still bill requests already submitted.
- A wide terminal uses navigation plus a main pane. At 80×24 it uses a single pane. Mouse input uses standard SGR terminal events; all actions also have a keyboard path. No special font or terminal image extension is required. `NO_COLOR=1` disables color.

## Model connections

| Connection | Authentication | Research capabilities |
| --- | --- | --- |
| Codex / ChatGPT | Official, unmodified Codex CLI sign-in | Existing Codex worker path, official session lifecycle |
| Claude API | Your Anthropic API Key | Messages API, bounded tool loop, structured result, separately checked native search |
| OpenAI API | Your OpenAI Platform API Key | Responses API, bounded tool loop, structured result, separately checked native search |
| Compatible API | Your Key, HTTPS Base URL and model ID | Chat Completions tools; only capabilities demonstrated by the connection check |

Codex sign-in uses the **official CLI**, not a custom OAuth token collector or the proposed app-server integration. Login instructions and authorization URLs appear in the terminal; the user completes authorization in the browser. The official runtime owns its session. [Codex authentication](https://developers.openai.com/codex/auth)

Claude subscription tokens are not accepted as generic API credentials. Claude API access is separate from Claude Code's own official session and subscription rules. [Anthropic authentication and hosting conditions](https://code.claude.com/docs/en/legal-and-compliance)

API compatibility alone does not imply native search. The client tests structured tool round trips, records native search availability separately, and shows a missing-search notice in the setup and final review. It never treats a search snippet as a source document. API workers can read permitted public text URLs and receive the project's existing grounding data. PDF/private-page extraction and paid data permissions are not automatically supplied by a model key. Missing evidence still stops or degrades research according to the existing contract.

API requests and output tokens have explicit per-run limits, with reservations for concurrent requests. These are not exact dollar limits: input tokens, provider search/tools, pricing changes and already-submitted requests may incur additional charges. No account or billing route is silently substituted.

On macOS, system storage uses Keychain; on Windows it uses user-scoped DPAPI. Linux can use `secret-tool` when available, or session-only storage. Session keys must be re-entered after the client exits; a runner already launched retains only its own in-memory copy until it ends. API keys are not stored in plaintext configuration or passed through command-line arguments. Model and connection metadata are stored under the existing AlphaCouncil data directory.

## Commands

```text
alphacouncil                       Language → ticker → model → methods
alphacouncil research AAPL          Prefill the ticker
alphacouncil runs                   Browse history
alphacouncil attach RUN_ID          Reopen a run
alphacouncil stop RUN_ID            Explicitly stop a live terminal-managed run
alphacouncil connect                Manage model connections
alphacouncil doctor                 Inspect local runtime and authentication state
alphacouncil runs --plain           Read history without a TUI
alphacouncil attach RUN_ID --plain  Read saved run status without a TUI
```

`--language ja` prefills the language choice. Plain reads do not authorize a new research run. Existing host-managed runs can be read, but the terminal does not pretend to control a runner it did not create.

Detaching from an interface is distinct from surviving logout, machine restart or system sleep. The client can reconnect to a living runner; it does not implement continuation from an interrupted model request. The original absolute research deadline remains in effect across delays.

## Build and verify

```sh
npm ci
npm ci --prefix terminal
npm run check
npm run terminal:test
npm run terminal:build
```

The native builder requires Node 24.14.0 and copies that exact running executable for the current platform/architecture. It uses the npm package allowlist for the research core, preserves dependency licenses, checks pinned Node/Codex license hashes and verifies startup with an empty PATH and isolated data. It then unpacks the archive in a new path containing spaces and repeats the smoke. Build output is written under `dist/` and is not committed.

The separate terminal-build workflow runs native packaging and terminal tests on Linux, macOS and Windows. Tests using local/fake provider responses verify protocol, cancellation and accounting boundaries; they are not evidence that a real account has sufficient quota or that every supported model has completed a live council. Research quality and investment results require separate evidence.
