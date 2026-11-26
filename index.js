'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_API_URL = 'https://api.github.com';
const DEFAULT_SERVER_URL = 'https://github.com';
const VALID_STRATEGIES = new Set(['fast-forward', 'merge', 'rebase', 'reset']);

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

function runGit(args, env) {
  return new Promise((resolve, reject) => {
    childProcess.execFile('git', args, { env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim().replaceAll('\n', ' ');
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
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
  } = options;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'krabs-fork-sync-'));
  const env = gitEnv(token);
  const server = serverBaseUrl();

  try {
    await runGit(['clone', '--no-checkout', `${server}/${encodeSlug(forkSlug)}.git`, directory], env);
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
    await runGit(['-C', directory, 'rebase', upstreamSha], env);
    const rebasedSha = await runGit(['-C', directory, 'rev-parse', 'HEAD'], env);

    if (!dryRun && rebasedSha !== previousSha) {
      await runGit(
        [
          '-C',
          directory,
          'push',
          `--force-with-lease=refs/heads/${targetBranch}:${previousSha}`,
          'origin',
          `HEAD:refs/heads/${targetBranch}`,
        ],
        env,
      );
    }

    return rebasedSha;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
      `Input "strategy" must be fast-forward, merge, rebase or reset, received "${strategy}".`,
    );
  }
  const dryRun = getBooleanInput('dry-run', false);

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
    });
    if (resultSha === previousSha) {
      log('Already up to date.');
    } else if (dryRun) {
      log(`Dry run: would rebase ${targetBranch} onto upstream (${resultSha}).`);
    } else {
      updated = true;
      log(`Rebased ${targetBranch} onto upstream (${resultSha}).`);
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
