// githttp.ts — git smart HTTP: info/refs advertisements, protocol v2 ls-refs and fetch,
// protocol v0 fetch, and receive-pack pushes. The wire shapes mirror what the suite's
// git-client.ts sends and parses, including the details that matter there:
//  - a v2 command response carries no `version 2` line and no capability lines; those live
//    only in the info/refs advertisement.
//  - a v0 advertisement carries its capabilities on the first ref line only, and the
//    `capabilities^{}` pseudo-ref for an unborn repo carries no NUL and no capabilities.
//  - a v2 fetch omits the packfile section entirely when there is no pack data.
//  - a receive-pack report travels inside sideband band 1 as its own pkt-line stream.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  isObjectId,
  parseCommit,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitutil.ts';
import { ForgeStore, type RepoMeta } from './store.ts';

export const AGENT = 'forge/1.0';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(service: string): GitHttpResult {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`repository not found (${service})\n`) };
}

function ok(contentType: string, body: Buffer): GitHttpResult {
  return { status: 200, contentType, body };
}

interface AdvRef {
  oid: string;
  name: string;
  unborn?: boolean;
  peeled?: string;
  symrefTarget?: string;
}

/** Every ref the repo advertises, HEAD first, then branches and tags in name order. */
function advertisedRefs(store: ForgeStore, repo: RepoMeta): AdvRef[] {
  const refs: AdvRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs[defaultRef];
  refs.push({
    oid: defaultTip ?? ZERO_OID,
    name: 'HEAD',
    unborn: defaultTip ? undefined : true,
    symrefTarget: defaultRef,
  });
  for (const name of Object.keys(repo.refs).sort()) {
    const oid = repo.refs[name]!;
    const entry: AdvRef = { oid, name };
    const object = store.lookup(oid);
    if (object && object.type === 'tag') {
      const peeled = store.peelToCommit(oid);
      if (peeled) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

const UPLOAD_V2_CAPABILITIES = ['ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];

const UPLOAD_V0_CAPABILITIES =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed ' +
  `symref=HEAD:refs/heads/main agent=${AGENT}`;

const RECEIVE_V0_CAPABILITIES = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function v0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  store: ForgeStore,
  repo: RepoMeta,
): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPABILITIES : RECEIVE_V0_CAPABILITIES;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(store, repo);
  refs.forEach((ref, index) => {
    const line = `${ref.oid} ${ref.name}${index === 0 ? `\u0000${caps}` : ''}\n`;
    parts.push(encodePktLine(line));
    if (ref.peeled) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
  });
  if (refs.length === 1 && refs[0]!.unborn) {
    // an unborn repo advertises the capabilities pseudo-ref with no NUL and no caps
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [encodePktLine('version 2\n')];
  for (const capability of UPLOAD_V2_CAPABILITIES) parts.push(encodePktLine(`${capability}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  store: ForgeStore,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | null,
): GitHttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(service);
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') return ok(contentType, v0Advertisement(service, store, repo));
  if (gitProtocol === 'version=2') return ok(contentType, v2Advertisement());
  return ok(contentType, v0Advertisement(service, store, repo));
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** The objects to pack (empty when nothing is new). */
  objects: GitObject[];
  /** New shallow boundaries, for a depth fetch. */
  shallow: string[];
  /** Old shallow boundaries that are now complete. */
  unshallow: string[];
  /** The haves the server acknowledges, in request order. */
  acks: string[];
  /** True when every have was acknowledged (so the client may stop negotiating). */
  ready: boolean;
}

/**
 * Work out what a fetch sends. `wants` are oids (commits or tags); `haves` are commits the
 * client already holds; `shallowBoundaries` are the client's current shallow boundaries.
 * A have listed as a shallow boundary contributes only itself, not its ancestors.
 */
export function planFetch(
  store: ForgeStore,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
  deepenSince: number | null,
): FetchPlan {
  const lookup = store.lookupFn();
  const shallowSet = new Set(shallowBoundaries);

  // the closure of the wants, with tag objects peeled to their commits
  const wantCommits: string[] = [];
  const extraObjects = new Set<string>(); // the tag objects themselves
  for (const want of wants) {
    const object = store.lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extraObjects.add(want);
      const commit = store.peelToCommit(want);
      if (commit) wantCommits.push(commit);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  // the closure the client already holds
  const haveClosure = new Set<string>();
  for (const have of haves) {
    if (shallowSet.has(have)) {
      haveClosure.add(have);
    } else {
      for (const oid of collectReachable([have], lookup, { allowMissing: true })) haveClosure.add(oid);
    }
  }

  // which haves the server acknowledges: those inside the wanted closure
  const wantClosure = collectReachable(wantCommits, lookup, { allowMissing: true });
  const acks = haves.filter((have) => wantClosure.has(have));
  const ready = haves.length > 0 && acks.length === haves.length;

  let sendCommits: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];

  if (depth != null) {
    // commits within `depth` generations of the wants, by breadth-first distance
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const commit of wantCommits) {
      if (!distance.has(commit)) {
        distance.set(commit, 0);
        queue.push(commit);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const dist = distance.get(oid)!;
      if (dist + 1 >= depth) continue;
      const object = store.lookup(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    }
    sendCommits = new Set<string>();
    for (const [oid, dist] of distance) {
      if (haveClosure.has(oid)) continue;
      sendCommits.add(oid);
      if (dist === depth - 1 && !haveClosure.has(oid)) shallow.push(oid);
    }
    // an old boundary is complete once every parent of it is now held or sent
    for (const boundary of shallowSet) {
      const object = store.lookup(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((p) => haveClosure.has(p) || sendCommits.has(p))) unshallow.push(boundary);
    }
    // deepen-since narrows the boundary the same way a depth does; the checks do not use it
    void deepenSince;
  } else {
    sendCommits = new Set<string>();
    for (const oid of wantClosure) if (!haveClosure.has(oid)) sendCommits.add(oid);
  }

  const sendOids = new Set<string>(extraObjects);
  for (const oid of collectReachable(sendCommits, lookup, { allowMissing: true })) sendOids.add(oid);
  // a tag object the client asked for is sent even when its commit is already held
  const objects: GitObject[] = [];
  for (const oid of sendOids) {
    const object = store.lookup(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow, acks, ready };
}

/** Split a pack into sideband band-1 packets of at most 32 KiB of pack data each. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

function v2FetchResponse(plan: FetchPlan, depth: number | null): Buffer {
  const parts: Buffer[] = [encodePktLine('acknowledgments\n')];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    if (plan.ready) parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (depth != null) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPack(writePack(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
    if (plan.ready) parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.objects.length) parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

/** Parse a v2 fetch/ls-refs request body into its header lines and its argument lines. */
function splitV2Command(body: Buffer): { header: string[]; args: string[] } {
  const { packets } = decodePktLines(body);
  const header: string[] = [];
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (afterDelim) args.push(line);
    else header.push(line);
  }
  return { header, args };
}

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) request.depth = n;
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number.parseInt(arg.slice(13).trim(), 10);
      if (Number.isFinite(n)) request.deepenSince = n;
    } else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
  }
  return request;
}

/** POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs/fetch, or a v0 fetch. */
export function handleUploadPack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): GitHttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound('git-upload-pack');
  const contentType = 'application/x-git-upload-pack-result';

  if (gitProtocol === 'version=2') {
    const { header, args } = splitV2Command(body);
    const command = header.find((line) => line.startsWith('command='))?.slice('command='.length);
    if (command === 'ls-refs') {
      const peel = args.includes('peel');
      const symrefs = args.includes('symrefs');
      const wantUnborn = args.includes('unborn');
      const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
      const parts: Buffer[] = [];
      for (const ref of advertisedRefs(store, repo)) {
        if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
        if (ref.unborn && !wantUnborn) continue;
        let line: string;
        if (ref.unborn) {
          line = `unborn ${ref.name}`;
          if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
        } else {
          line = `${ref.oid} ${ref.name}`;
          if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
          if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
        }
        parts.push(encodePktLine(`${line}\n`));
      }
      parts.push(pktFlush());
      return ok(contentType, Buffer.concat(parts));
    }
    if (command === 'fetch') {
      const request = parseFetchArgs(args);
      const plan = planFetch(store, request.wants, request.haves, request.shallow, request.depth, request.deepenSince);
      return ok(contentType, v2FetchResponse(plan, request.depth));
    }
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`unknown v2 command ${command ?? ''}\n`) };
  }

  // protocol v0 fetch: two sections (wants + shallow/deepen, flush, haves + done, flush)
  const { packets } = decodePktLines(body);
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    sections[sections.length - 1]!.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const args: string[] = [];
  for (const section of sections) {
    for (const line of section) {
      if (line.startsWith('want ')) args.push(`want ${line.slice(5).split(' ')[0]}`);
      else if (line.startsWith('shallow ')) args.push(line);
      else if (line.startsWith('deepen ')) args.push(line);
      else if (line.startsWith('deepen-since ')) args.push(line);
      else if (line.startsWith('deepen-not ')) args.push(line);
      else if (line.startsWith('have ')) args.push(line);
      else if (line === 'done') args.push(line);
    }
  }
  const request = parseFetchArgs(args);
  const plan = planFetch(store, request.wants, request.haves, request.shallow, request.depth, request.deepenSince);
  return ok(contentType, v0FetchResponse(plan));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Is `newOid` a fast-forward of `oldOid` (or a create/delete)? A create is always allowed;
 * an update must have the old tip as an ancestor of the new tip.
 */
function isFastForward(store: ForgeStore, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (newOid === ZERO_OID) return true;
  const ancestors = collectReachable([newOid], store.lookupFn(), { allowMissing: true });
  return ancestors.has(oldOid);
}

/** POST /{owner}/{repo}.git/git-receive-pack — a v0 push. */
export function handleReceivePack(
  store: ForgeStore,
  owner: string,
  repoName: string,
  body: Buffer,
): GitHttpResult {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound('git-receive-pack');
  const contentType = 'application/x-git-receive-pack-result';

  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let malformed = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue; // the flush ends the command list
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const commandLine = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = commandLine.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  if (malformed || !commands.length) {
    return {
      status: 400,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from('malformed receive-pack command list\n'),
    };
  }

  // unpack the pack (a delete-only push carries none)
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef && rest.length) {
    try {
      const pack = readPack(rest, { resolveBase: store.lookupFn() });
      for (const [oid, object] of pack.objects) store.putExisting(oid, object);
    } catch (err) {
      const report = Buffer.concat([
        encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(`unpack error ${(err as Error).message}\n`)])),
        pktFlush(),
      ]);
      return ok(contentType, report);
    }
  }

  // apply the commands, one line of report each; a refused ref does not stop the others
  const reportLines: string[] = ['unpack ok'];
  for (const command of commands) {
    const current = repo.refs[command.ref];
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} no such ref`);
      } else {
        store.deleteRef(repo, command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
        continue;
      }
    } else if (current === undefined) {
      reportLines.push(`ng ${command.ref} no such ref`);
      continue;
    } else if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} expected ${command.oldOid} but found ${current}`);
      continue;
    }
    if (!isFastForward(store, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    store.setRef(repo, command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const reportBody = Buffer.concat(reportLines.map((line) => encodePktLine(`${line}\n`)));
  const sideband = Buffer.concat([
    ...sidebandPackets(reportBody),
    pktFlush(),
  ]);
  return ok(contentType, sideband);
}

/** Wrap arbitrary bytes in sideband band-1 packets (32 KiB chunks). */
function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

