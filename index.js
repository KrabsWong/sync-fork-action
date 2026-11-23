'use strict';

const fs = require('node:fs');

const DEFAULT_API_URL = 'https://api.github.com';
const VALID_STRATEGIES = new Set(['fast-forward', 'merge', 'reset']);

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

function mergeUpstream(slug, targetBranch, upstreamSha, token) {
  const path = `/repos/${encodeSlug(slug)}/merges`;
  return request('POST', path, token, {
    base: targetBranch,
    head: upstreamSha,
    commit_message: `Merge upstream into ${targetBranch}`,
  });
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
      `Input "strategy" must be fast-forward, merge or reset, received "${strategy}".`,
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
      const merge = await mergeUpstream(forkSlug, targetBranch, upstreamSha, token);
      if (merge && merge.sha) {
        resultSha = merge.sha;
        updated = true;
        log(`Merged upstream into ${targetBranch} (${resultSha}).`);
      } else {
        resultSha = previousSha;
        log('Already up to date.');
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
