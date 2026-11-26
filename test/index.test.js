'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
    if (target === 'https://api.github.com/repos/me/fork/git/merges' && method === 'POST') {
      const sha = options.mergeSha === null ? null : options.mergeSha || 'merge-sha';
      return jsonResponse(sha ? { sha } : null, options.mergeResponseStatus || 200);
    }
    if (target === 'https://api.github.com/repos/me/fork/git/blobs' && method === 'POST') {
      return jsonResponse({ sha: 'uploaded-blob-sha' }, 201);
    }
    if (target === 'https://api.github.com/repos/me/fork/git/trees' && method === 'POST') {
      return jsonResponse({ sha: 'created-tree-sha' }, 201);
    }
    if (target === 'https://api.github.com/repos/me/fork/git/commits' && method === 'POST') {
      return jsonResponse({ sha: 'created-commit-sha' }, 201);
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

test('merge keeps fork commits and creates a merge commit', async (t) => {
  const env = setup(t, { strategy: 'merge', behindBy: 1, compareStatus: 'diverged' });

  const result = await run();

  assert.equal(result.updated, 'true');
  assert.equal(result.sha, 'merge-sha');
  assert.equal(env.requests.some((request) => request.target.includes('/compare/')), false);
  const post = env.requests.find((request) => request.target.endsWith('/git/merges'));
  assert.deepEqual(post.body, {
    base: 'fork-sha',
    head: 'upstream-sha',
    commit_message: 'Merge upstream into main',
  });
  const patch = env.requests.find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: 'merge-sha', force: false });
});

test('merge treats an already merged head as a no-op', async (t) => {
  const env = setup(t, { strategy: 'merge', mergeSha: null, mergeResponseStatus: 204 });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(result.sha, 'fork-sha');
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
});

function mockGit(t, gitCalls, rebasedSha = 'rebased-sha') {
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (file, args, options, callback) => {
    assert.equal(file, 'git');
    gitCalls.push(args);
    if (args.includes('cat-file')) {
      callback(null, Buffer.from('changed content'), '');
      return;
    }
    let stdout = '';
    if (args.includes('rev-parse') && args.at(-1) === 'HEAD') stdout = rebasedSha;
    else if (args.includes('rev-list')) stdout = 'rebased-commit-sha';
    else if (args.includes('diff-tree')) {
      stdout = ':100644 100644 ' + '0'.repeat(40) + ' ' + '1'.repeat(40) + ' M\0.github/workflows/check.yml\0';
    } else if (args.includes('show') && args.includes('--format=%B')) stdout = 'Replayed commit\n';
    else if (args.includes('show') && args.includes('--format=%an%n%ae%n%aI')) {
      stdout = 'Test User\nuser@example.com\n2026-11-26T00:00:00Z';
    } else if (args.includes('rev-parse') && args.at(-1) === 'upstream-sha^{tree}') stdout = 'upstream-tree';
    else if (args.includes('rev-parse') && args.at(-1).endsWith('^{tree}')) stdout = 'rebased-tree';
    else if (args.includes('rev-parse')) stdout = 'upstream-sha';
    callback(null, stdout, '');
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
}

test('rebase replays fork commits onto upstream via the Git Data API', async (t) => {
  const gitCalls = [];
  mockGit(t, gitCalls);
  const env = setup(t, { strategy: 'rebase', behindBy: 1, compareStatus: 'diverged' });

  const result = await run();

  assert.deepEqual(result, {
    updated: 'true',
    'previous-sha': 'fork-sha',
    sha: 'created-commit-sha',
    'upstream-sha': 'upstream-sha',
    strategy: 'rebase',
  });
  assert.deepEqual(readOutputs(env.outputPath), result);
  assert.ok(env.requests.some((request) => request.target.endsWith('/git/blobs')));
  assert.ok(env.requests.some((request) => request.target.endsWith('/git/trees')));
  assert.ok(env.requests.some((request) => request.target.endsWith('/git/commits')));
  assert.ok(
    gitCalls.some(
      (args) => args.includes('fetch') && args.includes('upstream') && args.includes('main'),
    ),
  );
  assert.ok(gitCalls.some((args) => args.includes('rebase') && args.includes('upstream-sha')));
  assert.equal(gitCalls.some((args) => args.includes('push')), false);
  const patch = env.requests.find((request) => request.method === 'PATCH');
  assert.deepEqual(patch.body, { sha: 'created-commit-sha', force: true });
});

test('rebase dry run validates locally without pushing', async (t) => {
  const gitCalls = [];
  mockGit(t, gitCalls);
  const env = setup(t, { strategy: 'rebase', dryRun: 'true' });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(result.sha, 'rebased-sha');
  assert.ok(gitCalls.some((args) => args.includes('rebase')));
  assert.equal(gitCalls.some((args) => args.includes('push')), false);
  assert.equal(env.requests.some((request) => request.method === 'POST'), false);
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
});

test('rebase skips the push when the fork commits are already on upstream', async (t) => {
  const gitCalls = [];
  mockGit(t, gitCalls, 'fork-sha');
  const env = setup(t, { strategy: 'rebase' });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(result.sha, 'fork-sha');
  assert.equal(gitCalls.some((args) => args.includes('push')), false);
  assert.equal(env.requests.some((request) => request.method === 'POST'), false);
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
  assert.match(fs.readFileSync(env.summaryPath, 'utf8'), /Result: already up to date/);
});

test('dry run validates the update without changing the branch', async (t) => {
  const env = setup(t, { dryRun: 'true' });

  const result = await run();

  assert.equal(result.updated, 'false');
  assert.equal(env.requests.some((request) => request.method === 'PATCH'), false);
  const summary = fs.readFileSync(env.summaryPath, 'utf8');
  assert.match(summary, /dry run, no branch was changed/);
});
