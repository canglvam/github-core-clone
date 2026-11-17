// rest.ts — the GitHub REST v3 surface under /api/v3.
// Every reply is JSON (never HTML); unknown routes answer a JSON 404; a malformed JSON
// body answers 400; every reply carries X-GitHub-Request-Id; error bodies carry a string
// `message`. Shapes follow what the suite's rest-client reads: repo/issue/pull objects
// carry the fields the checks assert on, and extra fields are tolerated by checkShape.

import { ForgeStore, VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type RepoMeta } from './store.ts';
import { parseCommit } from './gitutil.ts';

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown; // serialised as JSON, except null (empty body) for 204
}

export interface RestRequest {
  method: string;
  /** The path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The raw request body (empty for GET/DELETE without one). */
  body: Buffer;
  /** The request's Host header, for absolute Link URLs. */
  host: string;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function error(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false; error: RestResult } {
  if (!body.length) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: error(400, 'request body must be a JSON object') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: error(400, 'request body is not valid JSON') };
  }
}

function baseUrl(host: string): string {
  return `http://${host}`;
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

function userView(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    name: login === VIEWER_LOGIN ? 'ada iversen' : login,
    email: `${login}@example.invalid`,
    type: 'User',
    html_url: `https://github.com/${login}`,
    url: `https://api.github.com/users/${login}`,
  };
}

function repoView(store: ForgeStore, repo: RepoMeta, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner, VIEWER_ID),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `${baseUrl(host)}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.isoForSeq(repo.createdSeq),
    updated_at: store.isoForSeq(repo.createdSeq),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function issueView(store: ForgeStore, repo: RepoMeta, issue: Issue, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: userView(issue.userLogin, VIEWER_ID),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${baseUrl(host)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: store.listComments(repo, issue.number).length,
  };
}

function pullView(store: ForgeStore, repo: RepoMeta, pull: Pull, host: string): Record<string, unknown> {
  const headSha = store.resolveRefToCommit(repo, `refs/heads/${pull.headRef}`) ?? '';
  const baseSha = store.resolveRefToCommit(repo, `refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userView(pull.userLogin, VIEWER_ID),
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${baseUrl(host)}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

function commitView(store: ForgeStore, sha: string, message: string): Record<string, unknown> {
  const object = store.lookup(sha);
  let author = '';
  let committer = '';
  let date = '';
  if (object && object.type === 'commit') {
    const commit = parseCommit(object.data);
    author = commit.author;
    committer = commit.committer;
    const match = commit.author.match(/ (\d+) \+0000$/);
    if (match) date = new Date(Number(match[1]) * 1000).toISOString();
  }
  const nameFrom = (line: string): string => line.split(' <')[0] ?? '';
  return {
    sha,
    commit: {
      message,
      author: { name: nameFrom(author), email: `${VIEWER_LOGIN}@example.invalid`, date },
      committer: { name: nameFrom(committer), email: `${VIEWER_LOGIN}@example.invalid`, date },
    },
    author: userView(VIEWER_LOGIN, VIEWER_ID),
    committer: userView(VIEWER_LOGIN, VIEWER_ID),
  };
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Route one REST request. The caller has already authenticated the request and stripped
 * the /api/v3 prefix; `segments` are the remaining URL-decoded path parts.
 */
export function routeRest(store: ForgeStore, req: RestRequest): RestResult {
  const [first, ...rest] = req.segments;

  if (first === undefined || first === '') {
    // GET /api/v3/ — the API root
    if (req.method !== 'GET') return error(404, 'Not Found');
    return json(200, {
      current_user_url: `${baseUrl(req.host)}/api/v3/user`,
      repository_url: `${baseUrl(req.host)}/api/v3/repos/{owner}/{repo}`,
      user_url: `${baseUrl(req.host)}/api/v3/users/{username}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (first === 'meta') {
    if (req.method !== 'GET') return error(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  if (first === 'user') {
    if (rest.length === 0) {
      if (req.method !== 'GET') return error(404, 'Not Found');
      return json(200, userView(VIEWER_LOGIN, VIEWER_ID));
    }
    if (rest[0] === 'repos') {
      if (req.method === 'POST') return createRepo(store, req);
      if (req.method === 'GET') return listUserRepos(store, req);
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  if (first === 'repos') {
    return routeRepo(store, req, rest);
  }

  return error(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// /user/repos
// ---------------------------------------------------------------------------------------------

function createRepo(store: ForgeStore, req: RestRequest): RestResult {
  const parsed = parseJsonBody(req.body);
  if (!parsed.ok) return parsed.error;
  const body = parsed.value;
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return error(422, 'name is required');
  if (store.getRepoByName(name)) return error(422, `Repository ${name} already exists`);
  const repo = store.createRepo(
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
  )!;
  return json(201, repoView(store, repo, req.host));
}

function listUserRepos(store: ForgeStore, req: RestRequest): RestResult {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
  const repos = store.listRepos();
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const links: string[] = [];
  const pageUrl = (p: number): string =>
    `${baseUrl(req.host)}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`, `<${pageUrl(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${pageUrl(1)}>; rel="first"`, `<${pageUrl(page - 1)}>; rel="prev"`);
  return json(200, slice.map((r) => repoView(store, r, req.host)), links.length ? { Link: links.join(', ') } : undefined);
}

// ---------------------------------------------------------------------------------------------
// /repos/{owner}/{repo}/...
// ---------------------------------------------------------------------------------------------

function routeRepo(store: ForgeStore, req: RestRequest, segments: string[]): RestResult {
  const [owner, repoName, ...tail] = segments;
  if (!owner || !repoName) return error(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return error(404, 'Not Found');

  if (tail.length === 0) {
    if (req.method === 'GET') return json(200, repoView(store, repo, req.host));
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return parsed.error;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
      return json(200, repoView(store, repo, req.host));
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(repo);
      return { status: 204, body: null };
    }
    return error(404, 'Not Found');
  }

  const [section, ...sub] = tail;
  switch (section) {
    case 'branches':
      return routeBranches(store, req, repo, sub);
    case 'commits':
      return routeCommits(store, req, repo);
    case 'git':
      return routeGitRefs(store, req, repo, sub);
    case 'contents':
      return routeContents(store, req, repo, sub);
    case 'labels':
      return routeLabels(store, req, repo, sub);
    case 'issues':
      return routeIssues(store, req, repo, sub);
    case 'pulls':
      return routePulls(store, req, repo, sub);
    default:
      return error(404, 'Not Found');
  }
}

function routeBranches(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  if (req.method !== 'GET') return error(404, 'Not Found');
  const branchNames = Object.keys(repo.refs)
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length))
    .sort();
  if (sub.length === 0) {
    return json(
      200,
      branchNames.map((name) => ({
        name,
        commit: { sha: store.resolveRefToCommit(repo, `refs/heads/${name}`) ?? '' },
        protected: false,
      })),
    );
  }
  const branch = sub.join('/');
  const tip = store.resolveRefToCommit(repo, `refs/heads/${branch}`);
  if (!tip) return error(404, `Branch ${branch} not found`);
  return json(200, { name: branch, commit: { sha: tip }, protected: false });
}

function routeCommits(store: ForgeStore, req: RestRequest, repo: RepoMeta): RestResult {
  if (req.method !== 'GET') return error(404, 'Not Found');
  const shaParam = req.query.get('sha');
  let tip: string | null;
  if (shaParam) {
    tip = store.resolveRefToCommit(repo, shaParam);
    if (!tip) return error(404, `No commit found for ${shaParam}`);
  } else {
    tip = store.resolveRefToCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (!tip) return json(200, []);
  }
  const commits = store.listCommits(tip);
  return json(200, commits.map((c) => commitView(store, c.sha, c.message)));
}

function routeGitRefs(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  if (sub[0] !== 'refs') return error(404, 'Not Found');
  if (req.method === 'POST' && sub.length === 1) {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return parsed.error;
    const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    if (!ref.startsWith('refs/')) return error(422, 'ref must start with refs/');
    if (!store.lookup(sha)) return error(422, `object ${sha} does not exist`);
    if (repo.refs[ref]) return error(422, `Reference ${ref} already exists`);
    store.setRef(repo, ref, sha);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  if (req.method === 'GET' && sub[1] === 'heads' && sub.length > 2) {
    const branch = sub.slice(2).join('/');
    const tip = store.resolveRefToCommit(repo, `refs/heads/${branch}`);
    if (!tip) return error(404, `Reference refs/heads/${branch} not found`);
    return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
  }
  if (req.method === 'GET' && sub[1] === 'tags' && sub.length > 2) {
    const tag = sub.slice(2).join('/');
    const oid = repo.refs[`refs/tags/${tag}`];
    if (!oid) return error(404, `Reference refs/tags/${tag} not found`);
    return json(200, { ref: `refs/tags/${tag}`, object: { sha: oid, type: 'tag' } });
  }
  return error(404, 'Not Found');
}

function routeContents(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  const path = sub.join('/');
  if (!path) return error(404, 'Not Found');
  const refParam = req.query.get('ref');

  if (req.method === 'GET') {
    // ?ref names a branch, a full ref or an object id; without it, the default branch
    const tip = store.resolveRefToCommit(repo, refParam ?? `refs/heads/${repo.defaultBranch}`);
    if (!tip) return error(404, 'Not Found');
    const treeOid = parseCommit(store.lookup(tip)!.data).tree;
    const entry = store.findPathEntry(treeOid, path.split('/'));
    if (!entry) return error(404, 'Not Found');
    if (entry.mode === '40000') {
      const listing = store.listDir(treeOid, path.split('/'));
      if (!listing) return error(404, 'Not Found');
      return json(
        200,
        listing.map((e) => ({
          type: e.type,
          name: e.name,
          path: e.path,
          sha: e.sha,
          size: e.size,
          url: `${baseUrl(req.host)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
        })),
      );
    }
    const blob = store.lookup(entry.oid);
    if (!blob) return error(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: blob.data.length,
      content: blob.data.toString('base64'),
      url: `${baseUrl(req.host)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    });
  }

  if (req.method === 'PUT') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return parsed.error;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const content = typeof body.content === 'string' ? body.content : '';
    const branchName = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    let contentBuffer: Buffer;
    try {
      contentBuffer = Buffer.from(content, 'base64');
    } catch {
      return error(422, 'content is not valid base64');
    }
    // a branch that does not exist yet forks from the default branch tip, so the
    // stale-sha check runs against the tree the new branch would start from
    const tip =
      store.resolveRefToCommit(repo, `refs/heads/${branchName}`) ??
      (branchName === repo.defaultBranch
        ? null
        : store.resolveRefToCommit(repo, `refs/heads/${repo.defaultBranch}`));
    if (tip) {
      const treeOid = parseCommit(store.lookup(tip)!.data).tree;
      const existing = store.findPathEntry(treeOid, path.split('/'));
      if (existing) {
        if (sha === undefined) return error(422, 'sha is required to update a file');
        if (sha !== existing.oid) return error(409, 'sha does not match the current file');
      }
    }
    const { commitOid, existed, blobOid } = store.putFile(repo, branchName, path, contentBuffer, message);
    return json(existed ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: contentBuffer.length,
        content,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (req.method === 'DELETE') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return parsed.error;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const sha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = store.resolveRefToCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (!tip) return error(404, 'Not Found');
    const treeOid = parseCommit(store.lookup(tip)!.data).tree;
    const existing = store.findPathEntry(treeOid, path.split('/'));
    if (!existing) return error(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) return error(409, 'sha does not match the current file');
    const commitOid = store.deleteFile(repo, repo.defaultBranch, path, message);
    if (!commitOid) return error(404, 'Not Found');
    return json(200, { commit: { sha: commitOid, message } });
  }

  return error(404, 'Not Found');
}

function routeLabels(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  if (sub.length !== 0) return error(404, 'Not Found');
  if (req.method === 'GET') {
    return json(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
  }
  if (req.method === 'POST') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return parsed.error;
    const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : '000000';
    if (!name) return error(422, 'name is required');
    if (repo.labels.some((l) => l.name === name)) return error(422, `Label ${name} already exists`);
    repo.labels.push({ name, color });
    return json(201, { name, color });
  }
  return error(404, 'Not Found');
}

function routeIssues(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  if (sub.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return parsed.error;
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      if (!title) return error(422, 'title is required');
      const labelNames = Array.isArray(body.labels)
        ? body.labels.map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l !== null && typeof (l as { name?: unknown }).name === 'string' ? ((l as { name: string }).name) : '')).filter(Boolean)
        : [];
      const { issue, error: labelError } = store.createIssue(
        repo,
        title,
        typeof body.body === 'string' ? body.body : '',
        labelNames,
      );
      if (labelError) return error(422, labelError);
      return json(201, issueView(store, repo, issue, req.host));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return json(200, issues.map((i) => issueView(store, repo, i, req.host)));
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  if (sub.length === 1) {
    if (req.method === 'GET') {
      const issue = store.getIssue(repo, number);
      if (!issue) return error(404, 'Not Found');
      return json(200, issueView(store, repo, issue, req.host));
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return parsed.error;
      const issue = store.patchIssue(repo, number, {
        state: typeof parsed.value.state === 'string' ? parsed.value.state : undefined,
        title: typeof parsed.value.title === 'string' ? parsed.value.title : undefined,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : undefined,
      });
      if (!issue) return error(404, 'Not Found');
      return json(200, issueView(store, repo, issue, req.host));
    }
    return error(404, 'Not Found');
  }

  if (sub[1] === 'comments') {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return parsed.error;
      const bodyText = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (!bodyText) return error(422, 'body is required');
      const comment = store.createComment(repo, number, bodyText);
      if (!comment) return error(404, 'Not Found');
      return json(201, {
        id: comment.id,
        body: comment.body,
        user: userView(comment.userLogin, VIEWER_ID),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      });
    }
    if (req.method === 'GET') {
      if (!store.getIssue(repo, number)) return error(404, 'Not Found');
      return json(
        200,
        store.listComments(repo, number).map((c) => ({
          id: c.id,
          body: c.body,
          user: userView(c.userLogin, VIEWER_ID),
          created_at: c.createdAt,
          updated_at: c.createdAt,
        })),
      );
    }
  }
  return error(404, 'Not Found');
}

function routePulls(store: ForgeStore, req: RestRequest, repo: RepoMeta, sub: string[]): RestResult {
  if (sub.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return parsed.error;
      const body = parsed.value;
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (!title || !head || !base) return error(422, 'title, head and base are required');
      const { pull, error: pullError } = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      if (pullError) return error(422, pullError);
      return json(201, pullView(store, repo, pull, req.host));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return json(200, pulls.map((p) => pullView(store, repo, p, req.host)));
    }
    return error(404, 'Not Found');
  }

  const number = Number.parseInt(sub[0]!, 10);
  if (!Number.isInteger(number)) return error(404, 'Not Found');
  if (sub.length === 1) {
    if (req.method !== 'GET') return error(404, 'Not Found');
    const pull = store.getPull(repo, number);
    if (!pull) return error(404, 'Not Found');
    return json(200, pullView(store, repo, pull, req.host));
  }

  if (sub[1] === 'files' && req.method === 'GET') {
    const pull = store.getPull(repo, number);
    if (!pull) return error(404, 'Not Found');
    const headTip = store.resolveRefToCommit(repo, `refs/heads/${pull.headRef}`);
    const baseTip = store.resolveRefToCommit(repo, `refs/heads/${pull.baseRef}`);
    if (!headTip || !baseTip) return error(404, 'Not Found');
    const mergeBase = store.findMergeBase(headTip, baseTip);
    const baseTree = mergeBase ? parseCommit(store.lookup(mergeBase)!.data).tree : null;
    const headTree = parseCommit(store.lookup(headTip)!.data).tree;
    return json(200, store.diffTrees(baseTree, headTree));
  }

  if (sub[1] === 'merge' && req.method === 'PUT') {
    const pull = store.getPull(repo, number);
    if (!pull) return error(404, 'Not Found');
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return parsed.error;
    const method = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    if (method !== 'squash') return error(405, `merge method ${method} is not supported`);
    if (store.isConflicted(repo, pull.headRef, pull.baseRef)) {
      return error(405, 'Merge conflict');
    }
    const { sha, error: mergeError } = store.mergePull(repo, number, method);
    if (mergeError || !sha) return error(405, mergeError ?? 'Pull request cannot be merged');
    return json(200, { sha, merged: true, message: `Pull Request #${number} successfully merged` });
  }

  return error(404, 'Not Found');
}
