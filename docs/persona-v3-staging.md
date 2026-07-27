# PersonaPack v3 staging workflow

`knowledge/staging/personas-v3/` is the content-production workspace for the fixed 26-seat
v0.9.0 roster. It is intentionally separate from the production loader root
`knowledge/masters/`.

## Safety boundary

Staging is not a second production registry:

- each seat has `scaffold.json`, not `manifest.json`;
- the scaffold format has no maturity or admission field;
- `production_eligible`, manifest creation and registry registration are locked to `false`;
- source queues start empty, with no invented citations or reviewer approvals;
- npm publication includes `knowledge/masters/` only; scaffolds, acquisition records and
  archived source bytes under `knowledge/staging/` are excluded from the tarball;
- the staging report always reports zero production-eligible and zero physical production
  v3 packs;
- only a separate release operation may construct a physical pack under
  `knowledge/masters/<persona_id>/`, after which the normal loader, admission, compiler and
  release-count gates still apply.

Any `manifest.json` or symlink found under staging is an integrity error. The factory also
refuses a staging root inside the production tree (or a production tree inside staging).

## Commands

Initialize only missing artifacts:

```bash
npm run persona:stage:init
```

The command is idempotent and never overwrites a queue or scaffold. Validate the tree or
render a progress table with:

```bash
npm run persona:stage:check
npm run persona:stage:report
npm run persona:stage:report -- --json
```

## Per-seat workflow

1. Add a proposed real source anchor to `source-adjudication-queue.json` with status
   `pending`. Follow `schemas/source-anchor-v1.schema.json` and record a precise locator,
   source dates and a hash of retrieved content.
2. A human reads the primary material. Reviewer IDs and `reviewed_at` are recorded only
   after review actually occurs. A/B primary material needs two independent reviewers to
   define a named method rule.
3. Build doctrine, case, failure, counterfactual, research-policy, decision-policy, tool,
   memory and evaluation artifacts outside the production registry. The decision policy
   and tool graph must follow the executor-owned v1 schemas referenced by the scaffold.
4. Mark a component `reviewed` only with its artifact hash, two reviewer IDs and an actual
   review timestamp. This changes staging progress, not production maturity.
5. When every artifact is reviewed, the report may say `release_review_pending`. It still
   cannot promote the seat. The release process must construct and validate a production
   pack explicitly.

The source template under `_templates/` is deliberately invalid as a source record until
every `REPLACE` placeholder is replaced. It must never be copied into a queue unchanged.

## Raw source acquisition

Source discovery and source adjudication are separate operations. The acquisition command
accepts one explicit HTTP(S) URL; it does not search, infer a URL, assign a grade, approve a
source, or append anything to `source-adjudication-queue.json`.

Preview a request without network access:

```bash
npm run persona:source:acquire -- \
  --persona master_buffett \
  --candidate-id berkshire-letter-1986 \
  --url https://www.berkshirehathaway.com/letters/1986.html
```

Add `--write` to perform the explicit retrieval:

```bash
npm run persona:source:acquire -- \
  --write \
  --persona master_buffett \
  --candidate-id berkshire-letter-1986 \
  --url https://www.berkshirehathaway.com/letters/1986.html
```

The command resolves every initial and redirected hostname itself, rejects any loopback,
private, link-local, metadata or reserved destination, and pins the validated public IP into
the HTTP request so a second DNS answer cannot redirect the connection. It requests
`Accept-Encoding: identity`, archives the exact response-body bytes it receives, and hashes
those same bytes. Defaults are a 15-second total timeout, 10 MiB maximum body and three
redirects; bounded overrides are available through `--timeout-ms`, `--max-bytes` and
`--max-redirects`.

Successful artifacts live only under:

```text
knowledge/staging/personas-v3/<persona_id>/acquisitions/
└── candidates/<candidate-id>/
    ├── record.json
    └── source.bin
```

Every record is locked to `retrieved_unadjudicated`, `human_review.status=not_requested` and
an empty reviewer list. The schema deliberately has no grade or approval field. Reusing the
same candidate ID and URL is idempotent. Reusing an ID for another URL, an URL for another
ID, or identical content under another candidate is an integrity error requiring a human to
resolve the ambiguity.

The final candidate directory is published with one atomic directory rename only after both
the byte archive and record have been written and synced. A record-write failure therefore
cannot expose or strand a blob. Commits use a 30-second JSON lease. A confirmed live local
owner is never pre-empted even after lease expiry; only a confirmed-dead local owner can be
recovered after a five-second grace. Foreign, unverifiable and malformed leases fail closed.

Validate all acquisitions without network access:

```bash
npm run persona:source:check
```

After reading the archived bytes, a human may manually create a separate source-anchor
record with `pending` adjudication in the queue. Acquisition never performs that transfer.

## Release boundary

Before any staging work is promoted, the resulting production artifacts must independently
pass:

```bash
npm run persona:compile -- --require-count 26
npm run check
```

The 26-count gate remains expected to fail until all 26 physical production packs exist.
Staging counts are never added to that total.
