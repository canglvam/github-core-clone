// store.ts — the forge's store: repositories, objects, issues and pull requests.
// All state lives in memory for speed; every mutation is written through to disk
// (loose objects under objects/, one meta.json per repo, a small state.json for the
// counters and the logical clock) so a restart reloads the same store. Nothing here
// uses wall-clock time, randomness or the process id: ids are sequential and every
// timestamp comes from a logical clock that starts at the fixed scenario epoch, so
// two runs of the same trial export byte-identical state.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildCommit,
  buildTree,
  collectReachable,
  encodeLooseObject,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
  type TreeEntry,
} from './gitutil.ts';

export const SCENARIO_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  userLogin: string;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  createdSeq: number;
  createdAt: string;
  userLogin: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
  createdAt: string;
  userLogin: string;
}

export interface RepoMeta {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Record<string, string>;
  labels: { name: string; color: string }[];
  issues: Issue[];
  pulls: Pull[];
  comments: IssueComment[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface PathEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size: number;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

const DEFAULT_LABEL_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

export function encodeRepoDirName(name: string): string {
  return encodeURIComponent(name);
}

export class ForgeStore {
  readonly dataDir: string;
  readonly objectsDir: string;
  readonly reposDir: string;
  readonly ownerLogin = VIEWER_LOGIN;
  readonly ownerId = VIEWER_ID;

  private objects = new Map<string, GitObject>();
  private repos = new Map<string, RepoMeta>();
  private nextRepoDbId = 5000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0; // logical clock: seconds past SCENARIO_EPOCH_SEC

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.objectsDir = join(dataDir, 'objects');
    this.reposDir = join(dataDir, 'repos');
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.reposDir, { recursive: true });
    this.load();
  }

  // -------------------------------------------------------------------------------------------
  // persistence
  // -------------------------------------------------------------------------------------------

  private load(): void {
    const statePath = join(this.dataDir, 'state.json');
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
          nextRepoDbId?: number;
          nextIssueId?: number;
          nextCommentId?: number;
          nextPullId?: number;
          seq?: number;
        };
        if (typeof state.nextRepoDbId === 'number') this.nextRepoDbId = state.nextRepoDbId;
        if (typeof state.nextIssueId === 'number') this.nextIssueId = state.nextIssueId;
        if (typeof state.nextCommentId === 'number') this.nextCommentId = state.nextCommentId;
        if (typeof state.nextPullId === 'number') this.nextPullId = state.nextPullId;
        if (typeof state.seq === 'number') this.seq = state.seq;
      } catch {
        // a damaged state file is ignored; counters are rebuilt from the repos below
      }
    }
    // loose objects
    const stack: string[] = [this.objectsDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of entries) {
        const path = join(dir, name);
        if (name.length === 2 && /^[0-9a-f]{2}$/.test(name)) {
          for (const file of readdirSync(path)) {
            const oid = name + file;
            if (!isObjectId(oid)) continue;
            try {
              const raw = inflateSync(readFileSync(join(path, file)));
              const nul = raw.indexOf(0);
              const header = raw.subarray(0, nul).toString('utf8');
              const [type] = header.split(' ');
              if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') continue;
              this.objects.set(oid, { type, data: Buffer.from(raw.subarray(nul + 1)) });
            } catch {
              // a damaged loose object is skipped
            }
          }
        }
      }
    }
    // repos
    for (const dirName of readdirSync(this.reposDir)) {
      const metaPath = join(this.reposDir, dirName, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as RepoMeta;
        if (meta && typeof meta.name === 'string') {
          this.repos.set(`${meta.owner}/${meta.name}`, meta);
          this.nextRepoDbId = Math.max(this.nextRepoDbId, meta.id + 1);
          for (const issue of meta.issues) this.nextIssueId = Math.max(this.nextIssueId, issue.id + 1);
          for (const comment of meta.comments) this.nextCommentId = Math.max(this.nextCommentId, comment.id + 1);
          for (const pull of meta.pulls) this.nextPullId = Math.max(this.nextPullId, pull.id + 1);
        }
      } catch {
        // a damaged repo meta file is skipped
      }
    }
  }

  private persistState(): void {
    const state = {
      nextRepoDbId: this.nextRepoDbId,
      nextIssueId: this.nextIssueId,
      nextCommentId: this.nextCommentId,
      nextPullId: this.nextPullId,
      seq: this.seq,
    };
    const tmp = join(this.dataDir, 'state.json.tmp');
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, join(this.dataDir, 'state.json'));
  }

  private persistRepo(repo: RepoMeta): void {
    const dir = join(this.reposDir, encodeRepoDirName(repo.name));
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'meta.json.tmp');
    writeFileSync(tmp, JSON.stringify(repo));
    renameSync(tmp, join(dir, 'meta.json'));
    this.persistState();
  }

  private persistObject(oid: string, object: GitObject): void {
    const dir = join(this.objectsDir, oid.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, oid.slice(2));
    if (!existsSync(path)) writeFileSync(path, deflateSync(encodeLooseObject(object.type, object.data)));
  }

  // -------------------------------------------------------------------------------------------
  // logical clock and ids
  // -------------------------------------------------------------------------------------------

  /** The next logical second (epoch + seq), then the clock advances by one second. */
  nowEpoch(): number {
    const epoch = SCENARIO_EPOCH_SEC + this.seq;
    this.seq += 1;
    return epoch;
  }

  nowIso(): string {
    return new Date(this.nowEpoch() * 1000).toISOString();
  }

  /** An ISO timestamp for an already-recorded seq value (does not advance the clock). */
  isoForSeq(seq: number): string {
    return new Date((SCENARIO_EPOCH_SEC + seq) * 1000).toISOString();
  }

  globalId(kind: 'R' | 'I' | 'PR' | 'C', dbId: number, num?: number): string {
    const raw = num === undefined ? `${kind}:${dbId}` : `${kind}:${dbId}:${num}`;
    return Buffer.from(raw, 'utf8').toString('base64');
  }

  // -------------------------------------------------------------------------------------------
  // objects
  // -------------------------------------------------------------------------------------------

  lookup(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  lookupFn(): ObjectLookup {
    return (oid) => this.objects.get(oid);
  }

  /** Store an object (idempotent) and return its id. */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      const object: GitObject = { type, data };
      this.objects.set(oid, object);
      this.persistObject(oid, object);
    }
    return oid;
  }

  /** Store an object the caller already hashed; used for pack entries. */
  putExisting(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) {
      this.objects.set(oid, object);
      this.persistObject(oid, object);
    }
  }

  /** Resolve a tag to its target commit, or return the oid unchanged when it is not a tag. */
  peelToCommit(oid: string): string | null {
    const object = this.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.peelToCommit(target);
    }
    return null;
  }

  /** The commit a ref (or an oid) points at, following tags. */
  resolveRefToCommit(repo: RepoMeta, ref: string): string | null {
    let oid: string | undefined;
    if (isObjectId(ref)) oid = ref;
    else if (repo.refs[ref]) oid = repo.refs[ref];
    else if (repo.refs[`refs/heads/${ref}`]) oid = repo.refs[`refs/heads/${ref}`];
    else if (repo.refs[`refs/tags/${ref}`]) oid = repo.refs[`refs/tags/${ref}`];
    else if (repo.refs[`refs/heads/${repo.defaultBranch}`] && ref === 'HEAD') {
      oid = repo.refs[`refs/heads/${repo.defaultBranch}`];
    }
    if (!oid) return null;
    return this.peelToCommit(oid);
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoMeta | undefined {
    if (owner !== this.ownerLogin) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoByName(name: string): RepoMeta | undefined {
    return this.repos.get(this.repoKey(this.ownerLogin, name));
  }

  listRepos(): RepoMeta[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, description = '', isPrivate = false): RepoMeta | null {
    if (this.repos.has(this.repoKey(this.ownerLogin, name))) return null;
    const repo: RepoMeta = {
      id: this.nextRepoDbId++,
      name,
      owner: this.ownerLogin,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.seq,
      refs: {},
      labels: ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'].map(
        (label) => ({ name: label, color: DEFAULT_LABEL_COLORS[label] ?? '000000' }),
      ),
      issues: [],
      pulls: [],
      comments: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nowEpoch(); // the creation consumes one logical second
    this.repos.set(this.repoKey(this.ownerLogin, name), repo);
    this.persistRepo(repo);
    return repo;
  }

  deleteRepo(repo: RepoMeta): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    rmSync(join(this.reposDir, encodeRepoDirName(repo.name)), { recursive: true, force: true });
    this.persistState();
  }

  setRef(repo: RepoMeta, ref: string, oid: string): void {
    repo.refs[ref] = oid;
    this.persistRepo(repo);
  }

  deleteRef(repo: RepoMeta, ref: string): boolean {
    if (!(ref in repo.refs)) return false;
    delete repo.refs[ref];
    this.persistRepo(repo);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // trees and files
  // -------------------------------------------------------------------------------------------

  private treeEntries(treeOid: string | null): TreeEntry[] {
    if (!treeOid) return [];
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** A new tree with `path` set to `blobOid` (or removed when blobOid is null). */
  setPathInTree(treeOid: string | null, pathParts: readonly string[], blobOid: string | null): string {
    const entries = this.treeEntries(treeOid);
    const [head, ...rest] = pathParts;
    if (head === undefined) throw new Error('setPathInTree needs at least one path segment');
    const idx = entries.findIndex((e) => e.name === head);
    let next: TreeEntry[];
    if (rest.length === 0) {
      if (blobOid === null) {
        next = entries.filter((_, i) => i !== idx);
      } else if (idx >= 0) {
        next = entries.map((e, i) => (i === idx ? { mode: '100644', name: head, oid: blobOid } : e));
      } else {
        next = [...entries, { mode: '100644', name: head, oid: blobOid }];
      }
    } else {
      const child = idx >= 0 && entries[idx]!.mode === '40000' ? entries[idx]!.oid : null;
      const newChild = this.setPathInTree(child, rest, blobOid);
      const childEntries = this.treeEntries(newChild);
      if (childEntries.length === 0) {
        next = entries.filter((_, i) => i !== idx);
      } else if (idx >= 0) {
        next = entries.map((e, i) => (i === idx ? { mode: '40000', name: head, oid: newChild } : e));
      } else {
        next = [...entries, { mode: '40000', name: head, oid: newChild }];
      }
    }
    return this.putObject('tree', buildTree(next));
  }

  /** Walk a tree to `pathParts`; returns the entry (file or dir) or null. */
  findPathEntry(treeOid: string | null, pathParts: readonly string[]): TreeEntry | null {
    if (!treeOid) return null;
    let current = treeOid;
    for (let i = 0; i < pathParts.length; i += 1) {
      const entries = this.treeEntries(current);
      const entry = entries.find((e) => e.name === pathParts[i]);
      if (!entry) return null;
      if (i === pathParts.length - 1) return entry;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The entries of the directory at `pathParts` (empty = the tree root). */
  listDir(treeOid: string | null, pathParts: readonly string[]): PathEntry[] | null {
    if (!treeOid) return null;
    let current = treeOid;
    for (const part of pathParts) {
      const entry = this.treeEntries(current).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      current = entry.oid;
    }
    const prefix = pathParts.length ? `${pathParts.join('/')}/` : '';
    return this.treeEntries(current).map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: prefix + e.name,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : (this.objects.get(e.oid)?.data.length ?? 0),
    }));
  }

  /** Every file in a tree, as path → blob id. */
  flattenTree(treeOid: string | null, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    if (!treeOid) return out;
    for (const entry of this.treeEntries(treeOid)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') {
        for (const [k, v] of this.flattenTree(entry.oid, path)) out.set(k, v);
      } else {
        out.set(path, entry.oid);
      }
    }
    return out;
  }

  /** Create a commit on top of `treeOid` and return its id. */
  makeCommit(treeOid: string, parents: string[], message: string): string {
    const epoch = this.nowEpoch();
    const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${epoch} +0000`;
    const data = buildCommit({ tree: treeOid, parents, message, author: ident, committer: ident });
    return this.putObject('commit', data);
  }

  /**
   * Write a file at `path` on `refName` (creating the branch from the default tip when it
   * does not exist yet, and creating the first commit when the repo is unborn).
   * Returns the new commit id and whether the file already existed.
   */
  putFile(
    repo: RepoMeta,
    refName: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitOid: string; existed: boolean; blobOid: string } {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('putFile needs a non-empty path');
    const ref = `refs/heads/${refName}`;
    // a branch that does not exist yet forks from the default branch tip
    const tip =
      this.resolveRefToCommit(repo, ref) ??
      (refName === repo.defaultBranch ? null : this.resolveRefToCommit(repo, `refs/heads/${repo.defaultBranch}`));
    const blobOid = this.putObject('blob', content);
    const oldTree = tip ? parseCommit(this.objects.get(tip)!.data).tree : null;
    const existed = this.findPathEntry(oldTree, parts) !== null;
    const newTree = this.setPathInTree(oldTree, parts, blobOid);
    const commitOid = this.makeCommit(newTree, tip ? [tip] : [], message);
    repo.refs[ref] = commitOid;
    this.persistRepo(repo);
    return { commitOid, existed, blobOid };
  }

  /** Delete the file at `path` on `refName`; returns the new commit id, or null when absent. */
  deleteFile(repo: RepoMeta, refName: string, path: string, message: string): string | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const ref = `refs/heads/${refName}`;
    const tip = this.resolveRefToCommit(repo, ref);
    if (!tip) return null;
    const oldTree = parseCommit(this.objects.get(tip)!.data).tree;
    if (!this.findPathEntry(oldTree, parts)) return null;
    const newTree = this.setPathInTree(oldTree, parts, null);
    const commitOid = this.makeCommit(newTree, [tip], message);
    repo.refs[ref] = commitOid;
    this.persistRepo(repo);
    return commitOid;
  }

  /** The commits reachable from `tip`, newest first (parents walked depth-first). */
  listCommits(tip: string): { sha: string; message: string; tree: string }[] {
    const out: { sha: string; message: string; tree: string }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, tree: commit.tree });
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  /** The first common ancestor of two commits (the merge base), or null. */
  findMergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.pop()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** The file-level diff between two trees (base → head). */
  diffTrees(baseTree: string | null, headTree: string | null): ChangedFile[] {
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const files: ChangedFile[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = baseFiles.get(path);
      const headOid = headFiles.get(path);
      if (baseOid === headOid) continue;
      const baseText = baseOid ? (this.objects.get(baseOid)?.data.toString('utf8') ?? '') : '';
      const headText = headOid ? (this.objects.get(headOid)?.data.toString('utf8') ?? '') : '';
      const baseLines = baseText ? baseText.split('\n') : [];
      const headLines = headText ? headText.split('\n') : [];
      const baseSet = new Set(baseLines);
      const headSet = new Set(headLines);
      const additions = headLines.filter((l) => !baseSet.has(l)).length;
      const deletions = baseLines.filter((l) => !headSet.has(l)).length;
      files.push({
        filename: path,
        status: !baseOid ? 'added' : !headOid ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** True when head and base changed the same file differently since their merge base. */
  isConflicted(repo: RepoMeta, headRef: string, baseRef: string): boolean {
    const headTip = this.resolveRefToCommit(repo, `refs/heads/${headRef}`);
    const baseTip = this.resolveRefToCommit(repo, `refs/heads/${baseRef}`);
    if (!headTip || !baseTip) return false;
    const mergeBase = this.findMergeBase(headTip, baseTip);
    const baseTree = mergeBase ? parseCommit(this.objects.get(mergeBase)!.data).tree : null;
    const headTree = parseCommit(this.objects.get(headTip)!.data).tree;
    const baseTipTree = parseCommit(this.objects.get(baseTip)!.data).tree;
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const tipFiles = this.flattenTree(baseTipTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const m = baseFiles.get(path);
      const h = headFiles.get(path);
      const b = tipFiles.get(path);
      if (h !== m && b !== m && h !== b) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // issues and comments
  // -------------------------------------------------------------------------------------------

  createIssue(
    repo: RepoMeta,
    title: string,
    body: string,
    labelNames: string[],
  ): { issue: Issue; error?: string } {
    const labels: { name: string; color: string }[] = [];
    for (const name of labelNames) {
      const label = repo.labels.find((l) => l.name === name);
      if (!label) return { issue: null as unknown as Issue, error: `Label '${name}' does not exist` };
      labels.push({ name: label.name, color: label.color });
    }
    const seq = this.seq;
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels,
      createdSeq: seq,
      createdAt: this.isoForSeq(seq),
      updatedAt: this.isoForSeq(seq),
      userLogin: this.ownerLogin,
    };
    this.nowEpoch();
    repo.issues.push(issue);
    this.persistRepo(repo);
    return { issue };
  }

  getIssue(repo: RepoMeta, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  patchIssue(repo: RepoMeta, number: number, patch: { state?: string; title?: string; body?: string }): Issue | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedAt = this.nowIso();
    this.persistRepo(repo);
    return issue;
  }

  createComment(repo: RepoMeta, issueNumber: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const seq = this.seq;
    const comment: IssueComment = {
      id: this.nextCommentId++,
      issueNumber,
      body,
      createdSeq: seq,
      createdAt: this.isoForSeq(seq),
      userLogin: this.ownerLogin,
    };
    this.nowEpoch();
    repo.comments.push(comment);
    this.persistRepo(repo);
    return comment;
  }

  listComments(repo: RepoMeta, issueNumber: number): IssueComment[] {
    return repo.comments.filter((c) => c.issueNumber === issueNumber);
  }

  // -------------------------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------------------------

  createPull(
    repo: RepoMeta,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): { pull: Pull; error?: string } {
    const headTip = this.resolveRefToCommit(repo, `refs/heads/${headRef}`);
    const baseTip = this.resolveRefToCommit(repo, `refs/heads/${baseRef}`);
    if (!headTip || !baseTip) {
      return {
        pull: null as unknown as Pull,
        error: `head branch ${headRef} or base branch ${baseRef} does not exist`,
      };
    }
    const duplicate = repo.pulls.find(
      (p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef,
    );
    if (duplicate) {
      return { pull: null as unknown as Pull, error: 'A pull request already exists for this head and base' };
    }
    const seq = this.seq;
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      createdSeq: seq,
      createdAt: this.isoForSeq(seq),
      userLogin: this.ownerLogin,
    };
    this.nowEpoch();
    repo.pulls.push(pull);
    this.persistRepo(repo);
    return { pull };
  }

  getPull(repo: RepoMeta, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** Squash-merge a pull request; returns the merge commit id, or an error string. */
  mergePull(repo: RepoMeta, number: number, mergeMethod = 'squash'): { sha?: string; error?: string } {
    const pull = this.getPull(repo, number);
    if (!pull) return { error: 'not found' };
    if (pull.state !== 'open') return { error: 'Pull request is not open' };
    if (mergeMethod !== 'squash') return { error: `merge method ${mergeMethod} is not supported` };
    if (this.isConflicted(repo, pull.headRef, pull.baseRef)) return { error: 'conflict' };
    const headTip = this.resolveRefToCommit(repo, `refs/heads/${pull.headRef}`)!;
    const baseTip = this.resolveRefToCommit(repo, `refs/heads/${pull.baseRef}`)!;
    const headTree = parseCommit(this.objects.get(headTip)!.data).tree;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const mergeSha = this.makeCommit(headTree, [baseTip], message);
    repo.refs[`refs/heads/${pull.baseRef}`] = mergeSha;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = this.nowIso();
    this.persistRepo(repo);
    return { sha: mergeSha };
  }

  /** All objects reachable from a repo's refs (used for the state export). */
  reachableObjects(repo: RepoMeta): Set<string> {
    return collectReachable(Object.values(repo.refs), this.lookupFn(), { allowMissing: true });
  }
}
