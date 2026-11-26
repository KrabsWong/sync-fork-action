'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_SERVER_URL = 'https://github.com';
const VALID_STRATEGIES = new Set([
  'fast-forward',
  'merge',
  'rebase',
  'rebase-squash',
  'reset',
]);
const VALID_REBASE_CONFLICT_MODES = new Set(['fail', 'prefer-upstream']);

function log(message) {
  process.stdout.write(`${message}\n`);
}

function getInput(name, fallback = '') {
  const key = `INPUT_${name.toUpperCase().replaceAll(' ', '_')}`;
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function getBooleanInput(name, fallback = false) {
  const value = getInput(name);
  if (value === '') return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`Input "${name}" must be true or false, received "${value}".`);
}

function parseRepositorySlug(slug, label) {
  if (!slug) throw new Error(`${label} is required.`);
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`${label} must be in owner/repo form, received "${slug}".`);
  }
  return slug;
}

function encodeSlug(slug) {
  const [owner, repo] = parseRepositorySlug(slug, 'repository').split('/');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function apiBaseUrl() {
  return (process.env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
}

function serverBaseUrl() {
  return (process.env.GITHUB_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

async function request(method, path, token, body) {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'krabs-fork-sync',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === 'object' && data.message
        ? data.message
        : String(data || '').slice(0, 500);
    throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${message}`);
  }

  return data;
}

function getRepository(slug, token) {
  return request('GET', `/repos/${encodeSlug(slug)}`, token);
}

async function getBranchSha(slug, branch, token) {
  const path = `/repos/${encodeSlug(slug)}/branches/${encodeURIComponent(branch)}`;
  const data = await request('GET', path, token);
  if (!data.commit || !data.commit.sha) {
    throw new Error(`Branch "${branch}" in ${slug} has no commit SHA.`);
  }
  return data.commit.sha;
}

function setBranchSha(slug, branch, sha, force, token) {
  const path = `/repos/${encodeSlug(slug)}/git/refs/heads/${encodeURIComponent(branch)}`;
  return request('PATCH', path, token, { sha, force });
}

function createGitMerge(slug, base, head, message, token) {
  const path = `/repos/${encodeSlug(slug)}/git/merges`;
  return request('POST', path, token, {
    base,
    head,
    commit_message: message,
  });
}

function createBlob(slug, content, token) {
  const path = `/repos/${encodeSlug(slug)}/git/blobs`;
  return request('POST', path, token, { content, encoding: 'base64' });
}

function createTree(slug, baseTree, entries, token) {
  const path = `/repos/${encodeSlug(slug)}/git/trees`;
  return request('POST', path, token, { base_tree: baseTree, tree: entries });
}

function createCommit(slug, message, tree, parent, author, token) {
  const path = `/repos/${encodeSlug(slug)}/git/commits`;
  return request('POST', path, token, { message, tree, parents: [parent], author });
}

function gitEnv(token) {
  const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: authorization,
  };
}

function execGit(args, env, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', args, { env, encoding, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim().replaceAll('\n', ' ');
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runGit(args, env) {
  return execGit(args, env).then((output) => String(output).trim());
}

function parseRawDiff(raw, excludeWorkflowFiles = false) {
  const parts = String(raw).split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < parts.length; index += 2) {
    const header = parts[index];
    const filePath = parts[index + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) [A-Z]/.exec(header);
    if (!match || !filePath) throw new Error(`Cannot parse git diff entry: ${header}`);
    if (excludeWorkflowFiles && filePath.startsWith('.github/workflows/')) continue;
    const [, oldMode, newMode, sha] = match;
    if (newMode === '000000') {
      entries.push({ path: filePath, mode: oldMode, type: 'blob', sha: null });
    } else {
      entries.push({ path: filePath, mode: newMode, type: newMode === '160000' ? 'commit' : 'blob', sha });
    }
  }
  return entries;
}

async function commitRebasedHistory(options) {
  const { slug, directory, previousSha, upstreamSha, rebasedSha, env, token } = options;
  const blobCache = new Map();
  const forkTree = await runGit(['-C', directory, 'rev-parse', `${previousSha}^{tree}`], env);
  const commits = (await runGit(['-C', directory, 'rev-list', '--reverse', `${upstreamSha}..${rebasedSha}`], env))
    .split('\n')
    .map((sha) => sha.trim())
    .filter(Boolean);

  let baseTree = forkTree;
  let parent = upstreamSha;
  let previousLocalCommit = previousSha;
  for (const commitSha of commits) {
    const rawDiff = await runGit(
      ['-C', directory, 'diff-tree', '-r', '--raw', '--no-commit-id', '-z', previousLocalCommit, commitSha],
      env,
    );
    const entries = parseRawDiff(rawDiff, true);
    for (const entry of entries) {
      if (entry.sha === null || entry.type !== 'blob') continue;
      if (!blobCache.has(entry.sha)) {
        const content = await execGit(['-C', directory, 'cat-file', 'blob', entry.sha], env, 'buffer');
        const uploaded = await createBlob(slug, Buffer.from(content).toString('base64'), token);
        if (!uploaded.sha) throw new Error(`GitHub API did not return a blob SHA for ${entry.path}.`);
        blobCache.set(entry.sha, uploaded.sha);
      }
      entry.sha = blobCache.get(entry.sha);
    }

    if (entries.length > 0) {
      const createdTree = await createTree(slug, baseTree, entries, token);
      if (!createdTree.sha) throw new Error('GitHub API did not return a tree SHA.');
      baseTree = createdTree.sha;
    }

    const message = await runGit(['-C', directory, 'show', '-s', '--format=%B', commitSha], env);
    const authorParts = (await runGit(['-C', directory, 'show', '-s', '--format=%an%n%ae%n%aI', commitSha], env)).split('\n');
    const author = {
      name: authorParts[0] || 'github-actions[bot]',
      email: authorParts[1] || '41898282+github-actions[bot]@users.noreply.github.com',
      ...(authorParts[2] ? { date: authorParts[2] } : {}),
    };
    const createdCommit = await createCommit(slug, message.trimEnd(), baseTree, parent, author, token);
    if (!createdCommit.sha) throw new Error('GitHub API did not return a commit SHA.');
    parent = createdCommit.sha;
    previousLocalCommit = commitSha;
  }

  return parent;
}

async function rebaseForkBranch(options) {
  const {
    forkSlug,
    upstreamSlug,
    upstreamBranch,
    targetBranch,
    upstreamSha,
    previousSha,
    token,
    dryRun,
    preferUpstream,
  } = options;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'krabs-fork-sync-'));
  const env = gitEnv(token);
  const server = serverBaseUrl();

  try {
    await runGit(
      [
        'clone',
        '--no-checkout',
        '--filter=blob:none',
        `${server}/${encodeSlug(forkSlug)}.git`,
        directory,
      ],
      env,
    );
    await runGit(['-C', directory, 'config', 'user.name', 'github-actions[bot]'], env);
    await runGit(
      ['-C', directory, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
      env,
    );
    await runGit(
      ['-C', directory, 'remote', 'add', 'upstream', `${server}/${encodeSlug(upstreamSlug)}.git`],
      env,
    );
    await runGit(['-C', directory, 'fetch', '--no-tags', 'upstream', upstreamBranch], env);
    await runGit(['-C', directory, 'checkout', '--detach', previousSha], env);
    await runGit(
      [
        '-C',
        directory,
        'rebase',
        ...(preferUpstream ? ['--strategy-option=theirs'] : []),
        upstreamSha,
      ],
      env,
    );
    const rebasedSha = await runGit(['-C', directory, 'rev-parse', 'HEAD'], env);

    if (!dryRun && rebasedSha !== previousSha) {
      const resultSha = await commitRebasedHistory({
        slug: forkSlug,
        directory,
        previousSha,
        upstreamSha,
        rebasedSha,
        env,
        token,
      });
      await setBranchSha(forkSlug, targetBranch, resultSha, true, token);
      return resultSha;
    }

    return rebasedSha;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function squashRebase(options) {
  const { slug, upstreamSlug, upstreamBranch, upstreamSha, previousSha, directory, env, token } = options;
  const server = serverBaseUrl();

  await runGit(
    ['clone', '--no-checkout', '--filter=blob:none', `${server}/${encodeSlug(slug)}.git`, directory],
    env,
  );
  await runGit(
    ['-C', directory, 'remote', 'add', 'upstream', `${server}/${encodeSlug(upstreamSlug)}.git`],
    env,
  );
  await runGit(['-C', directory, 'fetch', '--no-tags', 'upstream', upstreamBranch], env);

  const baseTree = await runGit(['-C', directory, 'rev-parse', `${previousSha}^{tree}`], env);
  const rawDiff = await runGit(
    ['-C', directory, 'diff-tree', '-r', '--raw', '--no-commit-id', '-z', previousSha, upstreamSha],
    env,
  );
  const entries = parseRawDiff(rawDiff, true);
  for (const entry of entries) {
    if (entry.sha === null || entry.type !== 'blob') continue;
    const content = await execGit(['-C', directory, 'cat-file', 'blob', entry.sha], env, 'buffer');
    const uploaded = await createBlob(slug, Buffer.from(content).toString('base64'), token);
    if (!uploaded.sha) throw new Error(`GitHub API did not return a blob SHA for ${entry.path}.`);
    entry.sha = uploaded.sha;
  }

  let tree = baseTree;
  if (entries.length > 0) {
    const createdTree = await createTree(slug, baseTree, entries, token);
    if (!createdTree.sha) throw new Error('GitHub API did not return a tree SHA.');
    tree = createdTree.sha;
  }

  const createdCommit = await createCommit(
    slug,
    'Rebase fork contents onto upstream',
    tree,
    upstreamSha,
    {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
      date: new Date().toISOString(),
    },
    token,
  );
  if (!createdCommit.sha) throw new Error('GitHub API did not return a commit SHA.');
  return createdCommit.sha;
}

async function compareCommits(slug, previousSha, upstreamSha, token) {
  const base = encodeURIComponent(previousSha);
  const head = encodeURIComponent(upstreamSha);
  const path = `/repos/${encodeSlug(slug)}/compare/${base}...${head}`;
  const data = await request('GET', path, token);
  return {
    status: data.status,
    aheadBy: Number(data.ahead_by || 0),
    behindBy: Number(data.behind_by || 0),
  };
}

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function run() {
  const token = getInput('token');
  if (!token) {
    throw new Error('Input "token" is required. Pass ${{ github.token }} or a PAT with repository access.');
  }

  const forkSlug = parseRepositorySlug(
    getInput('repository') || process.env.GITHUB_REPOSITORY || '',
    'repository',
  );
  const strategy = getInput('strategy', 'fast-forward');
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(
      `Input "strategy" must be fast-forward, merge, rebase, rebase-squash or reset, received "${strategy}".`,
    );
  }
  const dryRun = getBooleanInput('dry-run', false);
  const rebaseConflict = getInput('rebase-conflict', 'fail');
  if (!VALID_REBASE_CONFLICT_MODES.has(rebaseConflict)) {
    throw new Error(
      `Input "rebase-conflict" must be fail or prefer-upstream, received "${rebaseConflict}".`,
    );
  }

  const fork = await getRepository(forkSlug, token);
  const targetBranch = getInput('target-branch') || fork.default_branch;
  if (!targetBranch) {
    throw new Error(`Cannot determine the default branch of ${forkSlug}. Set "target-branch".`);
  }

  const detectedUpstream = fork.parent && fork.parent.full_name
    ? fork.parent.full_name
    : fork.source && fork.source.full_name;
  const upstreamSlug = parseRepositorySlug(
    getInput('upstream-repository') || detectedUpstream || '',
    'upstream repository',
  );
  const upstream = upstreamSlug.toLowerCase() === forkSlug.toLowerCase()
    ? fork
    : await getRepository(upstreamSlug, token);
  const upstreamBranch = getInput('upstream-branch') || upstream.default_branch;
  if (!upstreamBranch) {
    throw new Error(`Cannot determine the default branch of ${upstreamSlug}. Set "upstream-branch".`);
  }

  const [upstreamSha, previousSha] = await Promise.all([
    getBranchSha(upstreamSlug, upstreamBranch, token),
    getBranchSha(forkSlug, targetBranch, token),
  ]);

  log(`Fork:     ${forkSlug}@${targetBranch} (${previousSha})`);
  log(`Upstream: ${upstreamSlug}@${upstreamBranch} (${upstreamSha})`);

  let updated = false;
  let resultSha = upstreamSha;
  if (previousSha === upstreamSha) {
    log('Already up to date.');
  } else if (strategy === 'fast-forward') {
    const comparison = await compareCommits(forkSlug, previousSha, upstreamSha, token);
    if (comparison.behindBy > 0 || comparison.status === 'diverged') {
      throw new Error(
        `Refusing to sync: the fork branch has ${comparison.behindBy} commit(s) not in upstream ` +
          `(compare status: ${comparison.status}). Use "strategy: reset" to overwrite them.`,
      );
    }
    if (dryRun) {
      log(`Dry run: would fast-forward ${comparison.aheadBy} commit(s).`);
    } else {
      await setBranchSha(forkSlug, targetBranch, upstreamSha, false, token);
      updated = true;
      log(`Fast-forwarded ${comparison.aheadBy} commit(s).`);
    }
  } else if (strategy === 'merge') {
    if (dryRun) {
      log('Dry run: would merge upstream into the fork branch.');
    } else {
      const merge = await createGitMerge(
        forkSlug,
        previousSha,
        upstreamSha,
        `Merge upstream into ${targetBranch}`,
        token,
      );
      if (merge && merge.sha) {
        await setBranchSha(forkSlug, targetBranch, merge.sha, false, token);
        resultSha = merge.sha;
        updated = true;
        log(`Merged upstream into ${targetBranch} (${resultSha}).`);
      } else {
        resultSha = previousSha;
        log('Already up to date.');
      }
    }
  } else if (strategy === 'rebase') {
    resultSha = await rebaseForkBranch({
      forkSlug,
      upstreamSlug,
      upstreamBranch,
      targetBranch,
      upstreamSha,
      previousSha,
      token,
      dryRun,
      preferUpstream: rebaseConflict === 'prefer-upstream',
    });
    if (resultSha === previousSha) {
      log('Already up to date.');
    } else if (dryRun) {
      log(`Dry run: would rebase ${targetBranch} onto upstream (${resultSha}).`);
    } else {
      updated = true;
      log(`Rebased ${targetBranch} onto upstream (${resultSha}).`);
    }
  } else if (strategy === 'rebase-squash') {
    if (dryRun) {
      resultSha = previousSha;
      log(`Dry run: would squash ${targetBranch} onto upstream.`);
    } else {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'krabs-fork-sync-'));
      try {
        resultSha = await squashRebase({
          slug: forkSlug,
          upstreamSlug,
          upstreamBranch,
          upstreamSha,
          previousSha,
          directory,
          env: gitEnv(token),
          token,
        });
        await setBranchSha(forkSlug, targetBranch, resultSha, true, token);
        updated = true;
        log(`Squash-rebased ${targetBranch} onto upstream (${resultSha}).`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  } else if (dryRun) {
    log('Dry run: would reset the fork branch to upstream.');
  } else {
    await setBranchSha(forkSlug, targetBranch, upstreamSha, true, token);
    updated = true;
    log('Reset the fork branch to upstream.');
  }

  const result = {
    updated: String(updated),
    'previous-sha': previousSha,
    sha: resultSha,
    'upstream-sha': upstreamSha,
    strategy,
  };
  for (const [name, value] of Object.entries(result)) setOutput(name, value);

  writeSummary([
    '### Fork sync',
    '',
    `- Fork: \`${forkSlug}@${targetBranch}\``,
    `- Upstream: \`${upstreamSlug}@${upstreamBranch}\``,
    `- Previous SHA: \`${previousSha}\``,
    `- Upstream SHA: \`${upstreamSha}\``,
    `- Strategy: \`${strategy}\``,
    dryRun
      ? '- Result: dry run, no branch was changed.'
      : updated
        ? '- Result: branch updated.'
        : '- Result: already up to date.',
  ]);

  return result;
}

if (require.main === module) {
  run().catch((error) => {
    const message = String(error && error.message ? error.message : error).replaceAll('\n', ' ');
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, parseRepositorySlug };
