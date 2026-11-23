'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../index.js');

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function setup(t, options = {}) {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krabs-fork-sync-'));
  const outputPath = path.join(dir, 'output');
  const summaryPath = path.join(dir, 'summary');
  fs.writeFileSync(outputPath, '');
  fs.writeFileSync(summaryPath, '');

  Object.assign(process.env, {
    INPUT_TOKEN: 'test-token',
    INPUT_REPOSITORY: options.repository || 'me/fork',
    'INPUT_UPSTREAM-REPOSITORY': options.upstreamRepository || '',
    'INPUT_UPSTREAM-BRANCH': options.upstreamBranch || '',
    'INPUT_TARGET-BRANCH': options.targetBranch || '',
    INPUT_STRATEGY: options.strategy || 'fast-forward',
    'INPUT_DRY-RUN': options.dryRun || 'false',
    GITHUB_REPOSITORY: 'me/fork',
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_API_URL: 'https://api.github.com',
  });

  const requests = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    const method = init.method;
    requests.push({ method, target, body: init.body ? JSON.parse(init.body) : null });

    if (target === 'https://api.github.com/repos/me/fork' && method === 'GET') {
      return jsonResponse({
        default_branch: 'main',
        parent: { full_name: 'up/project' },
        source: { full_name: 'up/project' },
      });
    }
    if (target === 'https://api.github.com/repos/up/project' && method === 'GET') {
      return jsonResponse({ default_branch: 'main' });
    }
    if (target === 'https://api.github.com/repos/up/project/branches/main' && method === 'GET') {
      return jsonResponse({ commit: { sha: 'upstream-sha' } });
    }
    if (target === 'https://api.github.com/repos/me/fork/branches/main' && method === 'GET') {
      return jsonResponse({ commit: { sha: options.forkSha || 'fork-sha' } });
    }
    if (target === 'https://api.github.com/repos/me/fork/compare/fork-sha...upstream-sha' && method === 'GET') {
      return jsonResponse({
        status: options.compareStatus || 'ahead',
        ahead_by: options.aheadBy === undefined ? 2 : options.aheadBy,
        behind_by: options.behindBy || 0,
      });
    }
    if (
      target === 'https://api.github.com/repos/me/fork/git/refs/heads/main' &&
      method === 'PATCH'
    ) {
      return jsonResponse({ ref: 'refs/heads/main' });
    }
    throw new Error(`Unexpected request: ${method} ${target}`);
  };

  t.after(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { outputPath, summaryPath, requests };
}

function readOutputs(outputPath) {
  const lines = fs.readFileSync(outputPath, 'utf8').trim().split('\n').filter(Boolean);
  return Object.fromEntries(
    lines.map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
}

test('fast-forwards a fork using its detected upstream parent', async (t) => {
  const env = setup(t);

  const result = await run();

  assert.deepEqual(result, {
    updated: 'true',
    'previous-sha': 'fork-sha',
    sha: 'upstream-sha',
    'upstream-sha': 'upstream-sha',
    strategy: 'fast-forward',
  });
  assert.deepEqual(readOutputs(env.outputPath), result);
  const patch = env.requests.find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: 'upstream-sha', force: false });
});

test('does nothing when the fork is already up to date', async (t) => {
  const env = setup(t, { forkSha: 'upstream-sha' });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
  assert.equal(env.requests.some((request) => request.target.includes('/compare/')), false);
});

test('refuses to overwrite divergent fork commits by default', async (t) => {
  const env = setup(t, { behindBy: 1, compareStatus: 'diverged' });

  await assert.rejects(run(), /Refusing to sync: the fork branch has 1 commit/);
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
});

test('reset explicitly overwrites the fork branch without a compare request', async (t) => {
  const env = setup(t, { strategy: 'reset', behindBy: 3, compareStatus: 'diverged' });

  const result = await run();

  assert.equal(result.updated, 'true');
  assert.equal(result.strategy, 'reset');
  assert.equal(env.requests.some((request) => request.target.includes('/compare/')), false);
  const patch = env.requests.find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: 'upstream-sha', force: true });
});

test('dry run validates the update without changing the branch', async (t) => {
  const env = setup(t, { dryRun: 'true' });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
  const summary = fs.readFileSync(env.summaryPath, 'utf8');
  assert.match(summary, /dry run, no branch was changed/);
});
