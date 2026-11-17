# github-core-clone forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/canglvam/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/canglvam/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one process, built for [the github-core-clone-01
contest](https://make.fun/bounty/github-core-clone-01). It serves git smart HTTP, the
GitHub REST v3 API, the GitHub GraphQL v4 API and a GitHub MCP server, all backed by
one on-disk store, using the Node standard library only — no dependencies, no git
binary, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. `MAKEFUN_ENV_URL` must be
set: the entry binds an ephemeral port, registers it with the env, then polls
`GET $MAKEFUN_ENV_URL/done` until the trial is over and exits 0. `MAKEFUN_SHOP_TOKEN`
is the bearer token the suite presents on every API call. The store lives in a fresh
temporary directory per process start; set `FORGE_DATA_DIR` to keep one directory
across restarts for local debugging.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry <-> env lifecycle (the starter's, unchanged apart from a header comment) |
| `app.ts` | The HTTP server: routing, auth, request bodies |
| `store.ts` | The forge's store: repositories, objects, issues, pull requests; in-memory with write-through persistence; deterministic ids and a logical clock |
| `gitutil.ts` | Git object model, pkt-line framing and packfiles (read and write, deltas included) |
| `githttp.ts` | Git smart HTTP: info/refs, protocol v2 ls-refs and fetch, protocol v0 fetch, receive-pack |
| `rest.ts` | GitHub REST v3 under `/api/v3` |
| `graphql.ts` | GitHub GraphQL v4 at `POST /api/graphql` (parser + resolvers) |
| `mcp.ts` | The GitHub MCP server at `POST /mcp` (JSON-RPC 2.0, modern `server/discover` era) |

## Surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok": true}` |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GraphQL v4: viewer, repository, issue and pull-request reads, `__type` probes, `node(id:)`, cursor pagination, the five mutations, operation batching |
| `POST /mcp` | MCP: `server/discover`, `initialize`, `tools/list`, `tools/call` (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message": "Not Found"}` |

## Notes

- Every repository belongs to the token owner (`adaiversen` in the trial). A request
  without an `Authorization: Bearer` header is 401 on the API surfaces; `/healthz` and
  the git endpoints take no token.
- Ids are sequential and every timestamp comes from a logical clock starting at the
  fixed scenario epoch, so two runs of the same trial export byte-identical state.
- The git layer stores objects verbatim (loose, zlib-deflated), speaks protocol v2
  (ls-refs, fetch with shallow/deepen) and v0, enforces fast-forward-only pushes, and
  sends plain packs (no deltas).

## License

MIT — see `LICENSE`.
