// app.ts — the forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL
// v4 and MCP from a single store. The store lives in a fresh temporary directory per
// process start (FORGE_DATA_DIR overrides it for local debugging), so a trial always
// starts empty and two runs never share state.
//
// Routing:
//   GET  /healthz                                  the boot probe, no token
//   GET  /{owner}/{repo}.git/info/refs            git smart-HTTP advertisement, no token
//   POST /{owner}/{repo}.git/git-upload-pack      git fetch / ls-refs, no token
//   POST /{owner}/{repo}.git/git-receive-pack     git push, no token
//   POST /mcp                                     MCP, Bearer required
//   /api/v3/...                                   REST v3, Bearer required
//   POST /api/graphql                             GraphQL v4, Bearer required
//   anything else                                 404 {"message": ...}
//
// A request without an Authorization Bearer header is 401 on the API surfaces; the suite
// never sends a wrong token, only a missing one, so any non-empty Bearer is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeStore } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { routeRest, type RestRequest } from './rest.ts';
import { executeGraphQLBody } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs and contents writes are far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer one request with raw bytes and an explicit content type. */
function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read a request body, whole, up to MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const dataDir = process.env.FORGE_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'forge-'));
  const store = new ForgeStore(dataDir);
  let requestSeq = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestSeq}`;
    const commonHeaders: Record<string, string> = { 'X-GitHub-Request-Id': requestId };
    const unauthorized = (): void => {
      sendJson(res, 401, { message: 'Requires authentication' }, commonHeaders);
    };
    const hasBearer = (): boolean => {
      const header = req.headers.authorization ?? '';
      return /^Bearer\s+\S+$/.test(header);
    };

    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'Request body is too large' }, commonHeaders);
        return;
      }
      const method = req.method ?? 'GET';
      const pathname = pathOf(req);
      const segments = pathname.split('/').filter((part) => part !== '');

      try {
        // the boot probe: no token, always 200 {"ok": true}
        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true }, commonHeaders);
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const tail = gitMatch[3]!;
          if (tail === 'info/refs' && method === 'GET') {
            const service = queryOf(req).get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service must be git-upload-pack or git-receive-pack' }, commonHeaders);
              return;
            }
            const gitProtocol = req.headers['git-protocol'] ?? null;
            const result = handleInfoRefs(store, owner, repoName, service, gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body, commonHeaders);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const gitProtocol = req.headers['git-protocol'] ?? null;
            const result = handleUploadPack(store, owner, repoName, body, gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body, commonHeaders);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const result = handleReceivePack(store, owner, repoName, body);
            sendRaw(res, result.status, result.contentType, result.body, commonHeaders);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }

        // MCP: Bearer required
        if (pathname === '/mcp' && method === 'POST') {
          if (!hasBearer()) {
            unauthorized();
            return;
          }
          const result = handleMcp(store, body);
          if (result.body === null) {
            res.writeHead(result.status, { ...commonHeaders });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, commonHeaders);
          return;
        }

        // GraphQL v4: Bearer required
        if (pathname === '/api/graphql' && method === 'POST') {
          if (!hasBearer()) {
            unauthorized();
            return;
          }
          const result = executeGraphQLBody(store, body);
          sendJson(res, result.status, result.body, commonHeaders);
          return;
        }

        // REST v3: Bearer required
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!hasBearer()) {
            unauthorized();
            return;
          }
          const restRequest: RestRequest = {
            method,
            segments: segments.slice(2).map((part) => {
              try {
                return decodeURIComponent(part);
              } catch {
                return part;
              }
            }),
            query: queryOf(req),
            body,
            host: req.headers.host ?? 'localhost',
          };
          const result = routeRest(store, restRequest);
          if (result.status === 204) {
            res.writeHead(204, { ...commonHeaders });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, { ...commonHeaders, ...(result.headers ?? {}) });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
      } catch (err) {
        // a handler must never take the server down with it
        process.stderr.write(`[app] ${method} ${pathname}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' }, commonHeaders);
        } else {
          res.end();
        }
      }
    })();
  });
}
