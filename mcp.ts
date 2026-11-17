// mcp.ts — the GitHub MCP server at POST /mcp: JSON-RPC 2.0 over Streamable HTTP.
// The modern era is implemented: `server/discover` answers the server's identity, its
// capabilities and its supported revisions (2026-07-28 first); `initialize` and
// `notifications/initialized` are implemented too for the pre-discover handshake. Every
// tools/list answer is the same constant list, byte for byte, and every tools/call
// answer echoes the request's id verbatim. Tool results carry both a text block (the
// JSON the suite's readers parse) and structuredContent.

import { ForgeStore, VIEWER_ID } from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The one tool list every tools/list call answers (a constant: byte-identical each time). */
export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The repository owner (the token owner).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
}

function okResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

/** Split an owner/repo pair out of the arguments (a full_name, or owner + repo). */
function repoFromArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [owner, repo] = args.full_name.split('/', 2);
    if (owner && repo) return { owner, repo };
  }
  if (typeof args.owner === 'string' && typeof args.repo === 'string') {
    return { owner: args.owner, repo: args.repo };
  }
  return null;
}

function repoView(store: ForgeStore, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return errorResult('create_repo requires a name');
      if (store.getRepoByName(repoName)) return errorResult(`Repository ${repoName} already exists`);
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      )!;
      return okResult(repoView(store, repo.owner, repo.name));
    }
    case 'get_repo': {
      const target = repoFromArgs(args);
      if (!target) return errorResult('get_repo requires owner and repo');
      const view = repoView(store, target.owner, target.repo);
      if (!view) return errorResult(`Repository ${target.owner}/${target.repo} not found`);
      return okResult(view);
    }
    case 'create_issue': {
      const target = repoFromArgs(args);
      if (!target) return errorResult('create_issue requires owner and repo');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return errorResult('create_issue requires a title');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return errorResult(`Repository ${target.owner}/${target.repo} not found`);
      const { issue, error } = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if (error) return errorResult(error);
      return okResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    case 'list_issues': {
      const target = repoFromArgs(args);
      if (!target) return errorResult('list_issues requires owner and repo');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return errorResult(`Repository ${target.owner}/${target.repo} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return okResult(
        issues.map((i) => ({
          id: i.id,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          labels: i.labels,
        })),
      );
    }
    case 'create_pull_request': {
      const target = repoFromArgs(args);
      if (!target) return errorResult('create_pull_request requires owner and repo');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!title || !head || !base) return errorResult('create_pull_request requires title, head and base');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return errorResult(`Repository ${target.owner}/${target.repo} not found`);
      const { pull, error } = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (error) return errorResult(error);
      return okResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef },
        base: { ref: pull.baseRef },
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    case 'merge_pull_request': {
      const target = repoFromArgs(args);
      if (!target) return errorResult('merge_pull_request requires owner and repo');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!Number.isInteger(number)) return errorResult('merge_pull_request requires a pull_number');
      const repo = store.getRepo(target.owner, target.repo);
      if (!repo) return errorResult(`Repository ${target.owner}/${target.repo} not found`);
      const pull = store.getPull(repo, number);
      if (!pull) return errorResult(`Pull request #${number} not found`);
      const { sha, error } = store.mergePull(repo, number, 'squash');
      if (error || !sha) return errorResult(error ?? 'Pull request cannot be merged');
      return okResult({ number, merged: true, sha, state: 'closed' });
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and the JSON body (or null for a
 * notification, which answers 202 with an empty body).
 */
export function handleMcp(store: ForgeStore, body: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = 'id' in request ? request.id : undefined;
  const isNotification = id === undefined;
  if (isNotification) {
    // a notification (no id) is acknowledged with an empty 202, never a JSON-RPC answer
    return { status: 202, body: null };
  }
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          serverInfo,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      };
    }
    case 'initialize': {
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: MCP_SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args =
        params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const known = MCP_TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        return { status: 200, body: rpcError(id, -32601, `Method not found: unknown tool ${toolName}`) };
      }
      const result = callTool(store, toolName, args);
      return { status: 200, body: rpcResult(id, result) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

