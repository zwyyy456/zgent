import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const environment = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];

function git(cwd: string, args: string[], index?: string, input?: Buffer) {
  return execFileSync('/usr/bin/git', [...options, '-C', cwd, ...args], {
    env: { ...environment, ...(index ? { GIT_INDEX_FILE: index } : {}) },
    input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  });
}

export function projectPaths(path: string) {
  try {
    const root = realpathSync(git(realpathSync(path), ['rev-parse', '--show-toplevel']).toString().replace(/\n$/, ''));
    const gitDir = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().replace(/\n$/, ''));
    return { root, gitDir };
  } catch {
    throw new Error('Each registered project must name the root of a local Git worktree.');
  }
}

export function branch(root: string) {
  return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trimEnd();
}

export function resolveBase(root: string, baseRef: string, requested?: string) {
  const base = git(root, ['rev-parse', '--verify', baseRef + '^{commit}']).toString().trim();
  if (requested) {
    const resolved = git(root, ['rev-parse', '--verify', requested + '^{commit}']).toString().trim();
    if (resolved !== requested) throw new Error('Invalid commit.');
    git(root, ['merge-base', '--is-ancestor', resolved, base]);
  }
  const dirty = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']).length > 0;
  return { base: requested ?? base, dirty };
}

export function snapshotTracked(root: string, expectedHead: string) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim();
  if (head !== expectedHead) throw new Error('The checked-out HEAD differs from the selected base.');
  const oid = git(root, ['-c', 'user.name=Zgent', '-c', 'user.email=zgent@localhost', 'stash', 'create', 'Zgent tracked snapshot']).toString().trim();
  if (oid && git(root, ['rev-parse', oid + '^1']).toString().trim() !== head) {
    throw new Error('HEAD changed while creating the tracked snapshot.');
  }
  const excluded = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  return { original_head: head, oid: oid || head, excluded_untracked: excluded };
}

export function projectFiles(root: string, trackedOnly = false) {
  return [...new Set(git(root, ['ls-files', '--cached', '-z', ...(trackedOnly ? [] : ['--others', '--exclude-per-directory=.gitignore'])])
    .toString('utf8').split('\0').filter(Boolean))];
}

export function snapshotCheckout(root: string, head: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'zgent-index-'));
  try {
    const index = join(scratch, 'index');
    git(root, ['read-tree', '--empty'], index);
    const files = projectFiles(root).filter(path => lstatSync(join(root, path), { throwIfNoEntry: false }));
    if (files.length) git(root, ['--literal-pathspecs', 'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'],
      index, Buffer.from(files.join('\0') + '\0'));
    const tree = git(root, ['write-tree'], index).toString().trim();
    if (tree === git(root, ['rev-parse', head + '^{tree}']).toString().trim()) return head;
    return git(root, ['-c', 'user.name=Zgent', '-c', 'user.email=zgent@localhost', 'commit-tree', tree, '-p', head,
      '-m', 'Zgent workspace snapshot']).toString().trim();
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function projectGit(root: string, view: 'status' | 'diff' | 'log') {
  const args = view === 'status' ? ['status', '--short', '--untracked-files=no'] : view === 'diff'
    ? ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'] : ['log', '-20', '--no-show-signature', '--format=%h %s'];
  return git(root, args).toString('utf8');
}

export function allocate(root: string, path: string, branch: string, base: string) {
  git(root, ['worktree', 'add', '-b', branch, '--', path, base]);
}

export function retainBase(root: string, branch: string, base: string) {
  git(root, ['update-ref', 'refs/zgent/' + branch, base]);
}

export function removeCleanWorktree(root: string, path: string, branch: string) {
  removeWorktree(root, path, branch, false);
}

export function removeWorktree(root: string, path: string, branch: string, archived: boolean) {
  const records = git(root, ['worktree', 'list', '--porcelain', '-z']).toString().split('\0\0');
  const record = records.find(item => item.startsWith('worktree ' + path + '\0'));
  const directory = lstatSync(path, { throwIfNoEntry: false });
  // A completed Git removal can precede the database update across a crash.
  if (!record && !directory) return;
  if (!directory?.isDirectory() || realpathSync(path) !== path ||
      !record?.split('\0').includes('branch refs/heads/' + branch)) throw new Error('Expected managed worktree.');
  if (!archived && git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']).length) {
    throw new Error('Worktree contains local changes.');
  }
  git(root, ['worktree', 'remove', ...(archived ? ['--force'] : []), '--', path]);
}

export function applyPatch(root: string, patch: Buffer, check: boolean) {
  if (!patch.length) return;
  git(root, ['-c', 'apply.ignoreWhitespace=false', '-c', 'apply.whitespace=nowarn', 'apply', ...(check ? ['--check'] : []), '-'], undefined, patch);
}

export function changedTreePaths(root: string, first: string, last: string) {
  return git(root, ['diff', '--no-ext-diff', '--name-only', '-z', first, last, '--']).toString('utf8').split('\0').filter(Boolean);
}

export function worktreeChangedCount(root: string, base: string) {
  const tracked = git(root, ['diff', '--no-ext-diff', '--name-only', '-z', base, '--']);
  const added = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).zgent-tmp']);
  return new Set(Buffer.concat([tracked, added]).toString('utf8').split('\0').filter(Boolean)).size;
}

export function collect(path: string, base: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'zgent-index-'));
  try {
    const index = join(scratch, 'index');
    const status = git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).zgent-tmp']);
    const head = git(path, ['rev-parse', '--verify', 'HEAD']).toString().trim();
    const diffArgs = ['--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color'];
    const staged = git(path, ['diff', '--cached', ...diffArgs, 'HEAD', '--']);
    git(path, ['read-tree', 'HEAD'], index);
    git(path, ['add', '-A', '--', '.', ':(exclude).zgent-tmp'], index);
    const cumulative = git(path, ['diff', '--cached', ...diffArgs, base, '--'], index);
    const tree = git(path, ['write-tree'], index).toString().trim();
    const stagedTree = git(path, ['write-tree']).toString().trim();
    const paths = git(path, ['diff', '--cached', '--name-only', '-z', base, '--'], index)
      .toString('utf8').split('\0').filter(Boolean);
    const stagedPaths = git(path, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'])
      .toString('utf8').split('\0').filter(Boolean);
    const ignored = git(path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard',
      '--', '.', ':(exclude).zgent-tmp']).toString('utf8').split('\0').filter(Boolean);
    const sensitive = [...paths, ...stagedPaths].filter(path =>
      /(^|\/)(\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|p12|pfx|jks)|id_(?:rsa|dsa|ed25519|ecdsa)|(?:credentials|auth)\.json)$/i.test(path));
    return { sensitive, status: status.toString('utf8').split('\0').filter(Boolean), head, tree, stagedTree, cumulative, staged,
      paths: [...new Set([...paths, ...stagedPaths])], ignored };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
