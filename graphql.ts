// graphql.ts — a small GraphQL executor for the shapes gh and github-mcp-server actually
// send: viewer/repository/issue/pull-request reads, the __type feature probes, node(id:),
// cursor pagination on issues, the five mutations, and two-document operation batching.
// It is a parser plus a resolver table, not a full spec implementation: it supports the
// documents in the suite (variables, inline enum lists, inline input objects, null
// variables, operation names, aliases, named and inline fragments) and answers an unknown
// field with HTTP 200 and an errors array naming it, as GitHub does.

import { ForgeStore, VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type RepoMeta } from './store.ts';
import { parseCommit } from './gitutil.ts';

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: SelectionNode[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldSelection | FragmentSpread | InlineFragment;

interface VariableDefinition {
  name: string;
  defaultValue?: GqlValue;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDefinition>;
}

type Token =
  | { type: 'punct'; value: string }
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'float'; value: number };

const PUNCT = new Set(['{', '}', '(', ')', ':', '!', '[', ']', '$', '=', '@', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { type: 'float', value: Number(text) } : { type: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.type === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek() !== undefined) {
      const token = this.peek()!;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek()?.type === 'name') name = this.next().value as string;
        const varDefs = this.isPunct('(') ? this.parseVariableDefinitions() : [];
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
      } else if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)} at the top of a GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const defs: VariableDefinition[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: GqlValue | undefined;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      const token = this.peek();
      if (token?.type === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token?.type === 'name') {
        return { kind: 'spread', name: this.next().value as string };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, GqlValue> = {};
    if (this.isPunct('(')) args = this.parseArguments();
    let selections: SelectionNode[] = [];
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!this.isPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: token.value };
    if (token.type === 'float') return { kind: 'float', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${JSON.stringify(token)} as a GraphQL value`);
  }
}

/** Evaluate a parsed value against the request's variables. */
function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = evalValue(field, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

export interface GqlError {
  message: string;
}

export interface GqlExecutionResult {
  data: Record<string, unknown> | null;
  errors: GqlError[];
}

interface Ctx {
  store: ForgeStore;
  errors: GqlError[];
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
}

/** A resolved value, tagged with the concrete GraphQL type its fields resolve against. */
interface Resolved {
  value: unknown;
  type: string;
}

type Resolver = (ctx: Ctx, parent: unknown, args: Record<string, unknown>) => Resolved | null;

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface RepoRecord {
  __type: 'Repository';
  repo: RepoMeta;
}
interface IssueRecord {
  __type: 'Issue';
  repo: RepoMeta;
  issue: Issue;
}
interface PullRecord {
  __type: 'PullRequest';
  repo: RepoMeta;
  pull: Pull;
}
interface UserRecord {
  __type: 'User';
  login: string;
}
interface CommentRecord {
  __type: 'IssueComment';
  repo: RepoMeta;
  comment: { id: number; issueNumber: number; body: string; createdAt: string };
}

function repoRecord(repo: RepoMeta): RepoRecord {
  return { __type: 'Repository', repo };
}
function issueRecord(repo: RepoMeta, issue: Issue): IssueRecord {
  return { __type: 'Issue', repo, issue };
}
function pullRecord(repo: RepoMeta, pull: Pull): PullRecord {
  return { __type: 'PullRequest', repo, pull };
}
function userRecord(login: string): UserRecord {
  return { __type: 'User', login };
}

function concreteType(value: unknown): string {
  if (value !== null && typeof value === 'object' && '__type' in value) {
    return (value as { __type: string }).__type;
  }
  return '';
}

/** Decode one of the store's opaque global ids (base64 of `R:5000`, `I:5000:3`, ...). */
function decodeGlobalId(id: string): { kind: string; dbId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const dbId = Number(parts[1]);
    const num = parts.length > 2 ? Number(parts[2]) : 0;
    if (!Number.isInteger(dbId) || !Number.isInteger(num)) return null;
    return { kind, dbId, num };
  } catch {
    return null;
  }
}

function repoByDbId(store: ForgeStore, dbId: number): RepoMeta | undefined {
  return store.listRepos().find((r) => r.id === dbId);
}

function resolveNode(ctx: Ctx, id: string): Resolved | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const repo = repoByDbId(ctx.store, decoded.dbId);
  if (!repo) return null;
  if (decoded.kind === 'R') return { value: repoRecord(repo), type: 'Repository' };
  if (decoded.kind === 'I') {
    const issue = ctx.store.getIssue(repo, decoded.num);
    if (!issue) return null;
    return { value: issueRecord(repo, issue), type: 'Issue' };
  }
  if (decoded.kind === 'PR') {
    const pull = ctx.store.getPull(repo, decoded.num);
    if (!pull) return null;
    return { value: pullRecord(repo, pull), type: 'PullRequest' };
  }
  if (decoded.kind === 'C') {
    const comment = repo.comments.find((c) => c.id === decoded.num);
    if (!comment) return null;
    return { value: { __type: 'IssueComment', repo, comment }, type: 'IssueComment' };
  }
  return null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(createdSeq: number): string {
  return Buffer.from(`cursor:${createdSeq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface IssueConnectionValue {
  __type: 'IssueConnection';
  nodes: IssueRecord[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function issuesConnection(ctx: Ctx, repo: RepoMeta, args: Record<string, unknown>): IssueConnectionValue {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const afterSeq = decodeCursor(args.after as string | null | undefined);
  if (afterSeq !== null) {
    issues = issues.filter((i) => (direction === 'asc' ? i.createdSeq > afterSeq : i.createdSeq < afterSeq));
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
  const page = first === undefined ? issues : issues.slice(0, first);
  const hasNextPage = first !== undefined ? issues.length > first : false;
  const last = page[page.length - 1];
  const firstNode = page[0];
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueRecord(repo, issue)),
    hasNextPage,
    endCursor: last ? encodeCursor(last.createdSeq) : null,
    startCursor: firstNode ? encodeCursor(firstNode.createdSeq) : null,
  };
}

function pullFiles(ctx: Ctx, repo: RepoMeta, pull: Pull, first: number | undefined): { __type: string; nodes: Record<string, unknown>[] } {
  const headTip = ctx.store.resolveRefToCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = ctx.store.resolveRefToCommit(repo, `refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { __type: 'PullRequestChangedFileConnection', nodes: [] };
  const mergeBase = ctx.store.findMergeBase(headTip, baseTip);
  const baseTree = mergeBase ? parseCommit(ctx.store.lookup(mergeBase)!.data).tree : null;
  const headTree = parseCommit(ctx.store.lookup(headTip)!.data).tree;
  const files = ctx.store.diffTrees(baseTree, headTree);
  const limited = first === undefined ? files : files.slice(0, first);
  return {
    __type: 'PullRequestChangedFileConnection',
    nodes: limited.map((f) => ({
      __type: 'PullRequestChangedFile',
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    })),
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ value: userRecord(VIEWER_LOGIN), type: 'User' }),
    repository: (ctx, _parent, args) => {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.store.getRepo(owner, name);
      if (!repo) return null;
      return { value: repoRecord(repo), type: 'Repository' };
    },
    node: (ctx, _parent, args) => resolveNode(ctx, String(args.id ?? '')),
    __type: (_ctx, _parent, args) => {
      const name = args.name as string;
      if (!name) return null;
      if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) return null;
      return { value: { __type: '__Type', name }, type: '__Type' };
    },
  },
  User: {
    login: (_ctx, parent) => ({ value: (parent as UserRecord).login, type: 'String' }),
    id: () => ({ value: VIEWER_ID, type: 'Int' }),
    name: (_ctx, parent) => ({
      value: (parent as UserRecord).login === VIEWER_LOGIN ? 'ada iversen' : (parent as UserRecord).login,
      type: 'String',
    }),
    email: (_ctx, parent) => ({ value: `${(parent as UserRecord).login}@example.invalid`, type: 'String' }),
  },
  Repository: {
    id: (ctx, parent) => ({ value: ctx.store.globalId('R', (parent as RepoRecord).repo.id), type: 'ID' }),
    databaseId: (_ctx, parent) => ({ value: (parent as RepoRecord).repo.id, type: 'Int' }),
    name: (_ctx, parent) => ({ value: (parent as RepoRecord).repo.name, type: 'String' }),
    nameWithOwner: (_ctx, parent) => ({
      value: `${(parent as RepoRecord).repo.owner}/${(parent as RepoRecord).repo.name}`,
      type: 'String',
    }),
    owner: (_ctx, parent) => ({ value: userRecord((parent as RepoRecord).repo.owner), type: 'User' }),
    defaultBranchRef: (ctx, parent) => {
      const repo = (parent as RepoRecord).repo;
      const tip = ctx.store.resolveRefToCommit(repo, `refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return { value: { __type: 'Ref', name: repo.defaultBranch }, type: 'Ref' };
    },
    viewerPermission: () => ({ value: 'ADMIN', type: 'String' }),
    hasIssuesEnabled: () => ({ value: true, type: 'Boolean' }),
    description: (_ctx, parent) => ({ value: (parent as RepoRecord).repo.description, type: 'String' }),
    private: (_ctx, parent) => ({ value: (parent as RepoRecord).repo.private, type: 'Boolean' }),
    issue: (ctx, parent, args) => {
      const repo = (parent as RepoRecord).repo;
      const issue = ctx.store.getIssue(repo, Number(args.number));
      if (!issue) return null;
      return { value: issueRecord(repo, issue), type: 'Issue' };
    },
    issues: (ctx, parent, args) => ({ value: issuesConnection(ctx, (parent as RepoRecord).repo, args), type: 'IssueConnection' }),
    pullRequests: (ctx, parent, args) => {
      const repo = (parent as RepoRecord).repo;
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
      const pulls = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      return {
        value: { __type: 'PullRequestConnection', nodes: page.map((p) => pullRecord(repo, p)) },
        type: 'PullRequestConnection',
      };
    },
    pullRequest: (ctx, parent, args) => {
      const repo = (parent as RepoRecord).repo;
      const pull = ctx.store.getPull(repo, Number(args.number));
      if (!pull) return null;
      return { value: pullRecord(repo, pull), type: 'PullRequest' };
    },
  },
  Issue: {
    id: (ctx, parent) => {
      const rec = parent as IssueRecord;
      return { value: ctx.store.globalId('I', rec.repo.id, rec.issue.number), type: 'ID' };
    },
    number: (_ctx, parent) => ({ value: (parent as IssueRecord).issue.number, type: 'Int' }),
    title: (_ctx, parent) => ({ value: (parent as IssueRecord).issue.title, type: 'String' }),
    state: (_ctx, parent) => ({ value: issueState((parent as IssueRecord).issue), type: 'String' }),
    body: (_ctx, parent) => ({ value: (parent as IssueRecord).issue.body, type: 'String' }),
    createdAt: (_ctx, parent) => ({ value: (parent as IssueRecord).issue.createdAt, type: 'String' }),
    updatedAt: (_ctx, parent) => ({ value: (parent as IssueRecord).issue.updatedAt, type: 'String' }),
  },
  IssueConnection: {
    nodes: (_ctx, parent) => ({ value: (parent as IssueConnectionValue).nodes, type: 'Issue' }),
    pageInfo: (_ctx, parent) => {
      const conn = parent as IssueConnectionValue;
      return {
        value: {
          __type: 'PageInfo',
          hasNextPage: conn.hasNextPage,
          endCursor: conn.endCursor,
          hasPreviousPage: false,
          startCursor: conn.startCursor,
        },
        type: 'PageInfo',
      };
    },
    totalCount: (_ctx, parent) => ({ value: (parent as IssueConnectionValue).nodes.length, type: 'Int' }),
  },
  PageInfo: {
    hasNextPage: (_ctx, parent) => ({ value: (parent as { hasNextPage: boolean }).hasNextPage, type: 'Boolean' }),
    hasPreviousPage: (_ctx, parent) => ({ value: (parent as { hasPreviousPage: boolean }).hasPreviousPage, type: 'Boolean' }),
    endCursor: (_ctx, parent) => ({ value: (parent as { endCursor: string | null }).endCursor, type: 'String' }),
    startCursor: (_ctx, parent) => ({ value: (parent as { startCursor: string | null }).startCursor, type: 'String' }),
  },
  PullRequest: {
    id: (ctx, parent) => {
      const rec = parent as PullRecord;
      return { value: ctx.store.globalId('PR', rec.repo.id, rec.pull.number), type: 'ID' };
    },
    number: (_ctx, parent) => ({ value: (parent as PullRecord).pull.number, type: 'Int' }),
    title: (_ctx, parent) => ({ value: (parent as PullRecord).pull.title, type: 'String' }),
    body: (_ctx, parent) => ({ value: (parent as PullRecord).pull.body, type: 'String' }),
    state: (_ctx, parent) => ({ value: pullState((parent as PullRecord).pull), type: 'String' }),
    merged: (_ctx, parent) => ({ value: (parent as PullRecord).pull.merged, type: 'Boolean' }),
    mergedAt: (_ctx, parent) => ({ value: (parent as PullRecord).pull.mergedAt, type: 'String' }),
    headRefName: (_ctx, parent) => ({ value: (parent as PullRecord).pull.headRef, type: 'String' }),
    baseRefName: (_ctx, parent) => ({ value: (parent as PullRecord).pull.baseRef, type: 'String' }),
    mergeable: (ctx, parent) => {
      const rec = parent as PullRecord;
      const value = ctx.store.isConflicted(rec.repo, rec.pull.headRef, rec.pull.baseRef) ? 'CONFLICTING' : 'MERGEABLE';
      return { value, type: 'String' };
    },
    files: (ctx, parent, args) => {
      const rec = parent as PullRecord;
      const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : undefined;
      return { value: pullFiles(ctx, rec.repo, rec.pull, first), type: 'PullRequestChangedFileConnection' };
    },
    createdAt: (_ctx, parent) => ({ value: (parent as PullRecord).pull.createdAt, type: 'String' }),
  },
  PullRequestConnection: {
    nodes: (_ctx, parent) => ({ value: (parent as { nodes: PullRecord[] }).nodes, type: 'PullRequest' }),
    totalCount: (_ctx, parent) => ({ value: (parent as { nodes: PullRecord[] }).nodes.length, type: 'Int' }),
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, parent) => ({ value: (parent as { nodes: Record<string, unknown>[] }).nodes, type: 'PullRequestChangedFile' }),
    totalCount: (_ctx, parent) => ({ value: (parent as { nodes: Record<string, unknown>[] }).nodes.length, type: 'Int' }),
  },
  PullRequestChangedFile: {
    path: (_ctx, parent) => ({ value: (parent as { path: string }).path, type: 'String' }),
    additions: (_ctx, parent) => ({ value: (parent as { additions: number }).additions, type: 'Int' }),
    deletions: (_ctx, parent) => ({ value: (parent as { deletions: number }).deletions, type: 'Int' }),
    changes: (_ctx, parent) => ({ value: (parent as { changes: number }).changes, type: 'Int' }),
  },
  Ref: {
    name: (_ctx, parent) => ({ value: (parent as { name: string }).name, type: 'String' }),
  },
  IssueComment: {
    id: (ctx, parent) => {
      const rec = parent as CommentRecord;
      return { value: ctx.store.globalId('C', rec.repo.id, rec.comment.id), type: 'ID' };
    },
    body: (_ctx, parent) => ({ value: (parent as CommentRecord).comment.body, type: 'String' }),
    createdAt: (_ctx, parent) => ({ value: (parent as CommentRecord).comment.createdAt, type: 'String' }),
  },
  IssueCommentEdge: {
    node: (_ctx, parent) => {
      const edge = parent as { node: CommentRecord };
      return { value: edge.node, type: 'IssueComment' };
    },
    cursor: () => ({ value: null, type: 'String' }),
  },
  __Type: {
    name: (_ctx, parent) => ({ value: (parent as { name: string }).name, type: 'String' }),
    fields: (_ctx, parent) => {
      const name = (parent as { name: string }).name;
      const fields = TYPE_FIELDS[name] ?? [];
      return { value: fields.map((f) => ({ __type: '__Field', name: f })), type: '__Field' };
    },
    enumValues: (_ctx, parent) => {
      const name = (parent as { name: string }).name;
      const values = TYPE_ENUM_VALUES[name] ?? [];
      return { value: values.map((v) => ({ __type: '__EnumValue', name: v })), type: '__EnumValue' };
    },
  },
  __Field: {
    name: (_ctx, parent) => ({ value: (parent as { name: string }).name, type: 'String' }),
  },
  __EnumValue: {
    name: (_ctx, parent) => ({ value: (parent as { name: string }).name, type: 'String' }),
  },
  Mutation: {
    createIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'R' ? repoByDbId(ctx.store, decoded.dbId) : undefined;
      if (!repo) return { value: { __type: 'CreateIssuePayload', issue: null }, type: 'CreateIssuePayload' };
      const { issue } = ctx.store.createIssue(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      return { value: { __type: 'CreateIssuePayload', issue: issueRecord(repo, issue) }, type: 'CreateIssuePayload' };
    },
    closeIssue: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      let issue: Issue | null = null;
      let repo: RepoMeta | null = null;
      if (decoded && decoded.kind === 'I') {
        repo = repoByDbId(ctx.store, decoded.dbId) ?? null;
        issue = repo ? (ctx.store.getIssue(repo, decoded.num) ?? null) : null;
      }
      if (issue && repo) ctx.store.patchIssue(repo, issue.number, { state: 'closed' });
      return {
        value: { __type: 'CloseIssuePayload', issue: issue && repo ? issueRecord(repo, issue) : null },
        type: 'CloseIssuePayload',
      };
    },
    createPullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'R' ? repoByDbId(ctx.store, decoded.dbId) : undefined;
      if (!repo) return { value: { __type: 'CreatePullRequestPayload', pullRequest: null }, type: 'CreatePullRequestPayload' };
      const { pull } = ctx.store.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      return {
        value: { __type: 'CreatePullRequestPayload', pullRequest: pull ? pullRecord(repo, pull) : null },
        type: 'CreatePullRequestPayload',
      };
    },
    mergePullRequest: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      let pull: Pull | null = null;
      let repo: RepoMeta | null = null;
      if (decoded && decoded.kind === 'PR') {
        repo = repoByDbId(ctx.store, decoded.dbId) ?? null;
        pull = repo ? (ctx.store.getPull(repo, decoded.num) ?? null) : null;
      }
      if (pull && repo) {
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        ctx.store.mergePull(repo, pull.number, method === 'squash' ? 'squash' : method);
      }
      return {
        value: { __type: 'MergePullRequestPayload', pullRequest: pull && repo ? pullRecord(repo, pull) : null },
        type: 'MergePullRequestPayload',
      };
    },
    addComment: (ctx, _parent, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      let comment: { id: number; issueNumber: number; body: string; createdAt: string } | null = null;
      let repo: RepoMeta | null = null;
      if (decoded && decoded.kind === 'I') {
        repo = repoByDbId(ctx.store, decoded.dbId) ?? null;
        comment = repo ? ctx.store.createComment(repo, decoded.num, String(input.body ?? '')) : null;
      }
      const node: CommentRecord | null =
        comment && repo ? { __type: 'IssueComment', repo, comment } : null;
      return {
        value: { __type: 'AddCommentPayload', commentEdge: node ? { __type: 'IssueCommentEdge', node } : null },
        type: 'AddCommentPayload',
      };
    },
  },
  CreateIssuePayload: {
    issue: (_ctx, parent) => {
      const payload = parent as { issue: IssueRecord | null };
      return payload.issue ? { value: payload.issue, type: 'Issue' } : null;
    },
  },
  CloseIssuePayload: {
    issue: (_ctx, parent) => {
      const payload = parent as { issue: IssueRecord | null };
      return payload.issue ? { value: payload.issue, type: 'Issue' } : null;
    },
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, parent) => {
      const payload = parent as { pullRequest: PullRecord | null };
      return payload.pullRequest ? { value: payload.pullRequest, type: 'PullRequest' } : null;
    },
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, parent) => {
      const payload = parent as { pullRequest: PullRecord | null };
      return payload.pullRequest ? { value: payload.pullRequest, type: 'PullRequest' } : null;
    },
  },
  AddCommentPayload: {
    commentEdge: (_ctx, parent) => {
      const payload = parent as { commentEdge: { __type: string; node: CommentRecord } | null };
      return payload.commentEdge ? { value: payload.commentEdge, type: 'IssueCommentEdge' } : null;
    },
  },
};

// ---------------------------------------------------------------------------------------------
// selection resolution
// ---------------------------------------------------------------------------------------------

function resolveSelections(
  ctx: Ctx,
  concrete: string,
  value: unknown,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      Object.assign(out, resolveSelections(ctx, concrete, value, fragment.selections));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== concrete) continue;
      Object.assign(out, resolveSelections(ctx, concrete, value, selection.selections));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const table = RESOLVERS[concrete];
    const resolver = table?.[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${concrete}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(selection.args)) args[key] = evalValue(raw, ctx.variables);
    let resolved: Resolved | null;
    try {
      resolved = resolver(ctx, value, args);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      out[responseKey] = null;
      continue;
    }
    if (resolved === null) {
      out[responseKey] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      out[responseKey] = resolved.value;
      continue;
    }
    if (Array.isArray(resolved.value)) {
      out[responseKey] = resolved.value.map((item) => {
        if (item === null) return null;
        const itemType = concreteType(item) || resolved.type;
        return resolveSelections(ctx, itemType, item, selection.selections);
      });
      continue;
    }
    const childType = concreteType(resolved.value) || resolved.type;
    out[responseKey] = resolveSelections(ctx, childType, resolved.value, selection.selections);
  }
  return out;
}

function executeOperation(
  store: ForgeStore,
  operation: Operation,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDefinition>,
): GqlExecutionResult {
  const ctx: Ctx = { store, errors: [], variables, fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const rootValue = { __type: rootType };
  const data = resolveSelections(ctx, rootType, rootValue, operation.selections);
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------------------------

/**
 * Run one GraphQL operation document. Returns the envelope the client reads:
 * `{data, errors?}`. A document that does not parse answers `{data: null, errors: [...]}`.
 */
export function executeGraphQL(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): GqlExecutionResult {
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  let operation: Operation | undefined;
  if (operationName) {
    operation = document.operations.find((op) => op.name === operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  } else {
    return {
      data: null,
      errors: [{ message: 'The document holds more than one operation and no operationName was given.' }],
    };
  }
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (!(def.name in mergedVariables) && def.defaultValue) {
      mergedVariables[def.name] = evalValue(def.defaultValue, variables);
    }
  }
  return executeOperation(store, operation, mergedVariables, document.fragments);
}

/** Parse a request body that may hold one operation or a JSON array of operations. */
export function executeGraphQLBody(
  store: ForgeStore,
  body: Buffer,
): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { data: null, errors: [{ message: 'request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    let result: GqlExecutionResult;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      result = { data: null, errors: [{ message: 'each operation must be a JSON object with a query string' }] };
    } else {
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables =
        record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
          ? (record.variables as Record<string, unknown>)
          : {};
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      result = executeGraphQL(store, query, variables, operationName);
    }
    return result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data };
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
