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
3. Select or add a model connection. Open **Model** to search or refresh its directory, choose a model, or enter its exact ID. The directory can be opened before selecting a model. API connection checks exercise the selected model's tool round trip and structured output; Codex checks the official login state. Listing a model does not verify account entitlement, quota or research capabilities. Provider availability can still change before a research worker starts.
4. Choose full or quick, then the applicable pace and analyst scope. Full remains the default.
5. Read the returned configuration, select methods and review the final summary. Only **Start research** submits the one-use selection and starts the task.

English, Simplified Chinese, Japanese, Korean, Spanish, French, German, Brazilian Portuguese, Italian, Russian, Vietnamese and Indonesian are available. The selected language is passed unchanged into the research request; worker prose, method explanations, debate and reports follow the run language. Stable IDs, JSON keys, formulas, source titles and original quotations retain their original form. Changing the interface language does not rewrite historical research.

The complete 26-method catalog remains available with each method's identity, approach and best-fit context. The preselected panel is a starting configuration, not evidence that its size or methods are optimal. An abstention or missing source remains visible.

## Read the work

- Click a labeled row, or use Up/Down and Enter. Tab moves to the next selectable row; Esc goes back. A toolbar above the content keeps Back, History and New research in the same area at both narrow and wide sizes. Returning from a detail view restores the originating list's selection and scroll position.
- Fields edit in place while the surrounding page remains visible. Type or paste, use Left/Right, Home/End, Backspace/Delete, and Ctrl+U to clear. Enter or the **Save** button applies the value; Esc or **Cancel** discards the edit. While editing, `q` is text. Model loading and connection checks have a Cancel action; cancelling a check after saving retains the saved connection for editing or retry.
- History and model lists have a search field and `/` shortcut. Enter keywords and save to filter, or cancel to keep the previous filter. **New research** starts the ticker flow after language selection, including when the client was opened with `runs` or `attach`.
- The research view opens evidence, methods, individual Bull/Bear rounds, reports and sources. An available item opens its actual saved content, including recorded questions and answers. Waiting items do not contain invented statements.
- The run view shows phase, available artifacts, failures, recent events and elapsed time. Details scroll with arrows, the mouse wheel, Page Up/Down, Home and End. In a report or detail view, `/` searches its text and `n` moves to the next match. Long reports are not replaced with a short summary.
- The client displays public research outputs and exchanges, not private model reasoning or raw provider transcripts.
- `q` or Ctrl+C closes the interface. A live independent runner continues; reopening the same run attaches to it.
- **Stop research** is a separate confirmed action. It stops new work and saves the resulting terminal state. Providers may still bill requests already submitted.
- The same toolbar and content layout works at 80×24 and larger sizes. Resizing keeps the selected menu item visible, relocates an active editor and updates report search positions. Below 80 columns or 24 rows, hidden actions cannot be activated; enlarge the terminal to continue, or use Esc/Ctrl+C to cancel or exit. Mouse input uses standard SGR terminal events, ignores motion reports and guards against a rapid second click activating a newly opened page. No special font or terminal image extension is required. `NO_COLOR=1` disables color.

## Model connections

The chooser contains 12 connection presets and two subscription information entries. API connections use your own key; regional endpoints can require different accounts and keys.

| Connection preset | API or session | Model directory |
| --- | --- | --- |
| Codex / ChatGPT | Official, unmodified Codex CLI sign-in | Official Codex app-server `model/list`, with an official-default option |
| Claude API | Anthropic Messages | Provider API |
| OpenAI API | OpenAI Responses | Provider API |
| DeepSeek | OpenAI-compatible Chat Completions | Provider API |
| Kimi International | OpenAI-compatible Chat Completions | International provider API |
| Kimi China | OpenAI-compatible Chat Completions | Mainland provider API |
| GLM / Z.AI International | OpenAI-compatible Chat Completions | Official-documentation candidates, not verified for this account |
| GLM / BigModel China | OpenAI-compatible Chat Completions | Official-documentation candidates, not verified for this account |
| OpenRouter | OpenAI-compatible Chat Completions | Gateway API |
| OpenCode Zen | Protocol selected for the model | Gateway API |
| OpenCode Go | Protocol selected for the model; see subscription limits below | Gateway API |
| Compatible API | Your HTTPS Base URL and explicit protocol | Endpoint `/models`, when supported; manual ID entry otherwise |

Codex sign-in still uses the **official CLI**. Login instructions and clickable authorization URLs appear in the terminal; the user completes authorization in the browser. The official runtime owns its session. The bundled app-server is used only to obtain the model directory via `model/list`; listing models does not run research or prove model-specific subscription access. [Codex authentication](https://developers.openai.com/codex/auth/) · [Codex app-server](https://developers.openai.com/codex/app-server/)

Compatible connections implement three protocols: **Chat Completions**, **Responses** and **Anthropic Messages**. Base URL, protocol, connection name, credential storage and request/token limits are available under **Advanced settings**. Zen and Go map known model IDs to their documented protocol; the same model can use different protocols on those two endpoints. Unknown mappings cannot be selected directly from the list. To use another supported model, enter its ID and explicitly choose its documented protocol in Advanced settings before checking the connection. A model requiring a different protocol is not supported by these adapters. [Zen endpoints](https://opencode.ai/docs/zen/#endpoints) · [Go endpoints](https://opencode.ai/docs/go/#endpoints)

Directories identify candidates, not verified account permissions or tool support. GLM candidates are labeled as coming from documentation; they are not live account results. If a directory request fails or is unsupported, Refresh and manual entry remain available. A connection check can submit billable model and search requests, and its result is separate from directory retrieval and from a completed research run.

**Subscription scope:** OpenCode Go is intended for OpenCode and other coding agents with similar requests. It requires an identifiable client and session header; this client identifies itself as AlphaCouncil. Eligibility of this app's stock-research use has not been confirmed, so the interface recommends the separately billed Zen API. Go and Zen have different endpoints and usage allowances. [Go permitted clients and limits](https://opencode.ai/docs/go/#where-can-i-use-it)

Kimi Code and GLM Coding Plan open information pages rather than connection forms. Kimi Code supports personal interactive use in third-party agents but prohibits non-interactive batch automation; use the general Kimi API for this research client. GLM Coding Plan is restricted to officially supported tools and uses; this client offers general GLM API connections. [Kimi Code guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html) · [GLM Coding Plan policy](https://docs.z.ai/devpack/usage-policy)

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

### Research completion and failures

When a run ends, the research page reveals the full saved conclusion below the progress rows. Use the conclusion shortcut, arrows, Page Up/Down or mouse wheel to read it; the report category retains the complete report. Research status comes from the council contract, independently of whether its background process exited normally. Progress counts accepted outputs, not merely files: failed evidence and incomplete report placeholders do not fill success bars. Failure diagnostics show structured reasons and timing without private model traces. Existing history is read without rewriting its outcome.
