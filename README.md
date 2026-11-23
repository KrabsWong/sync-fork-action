# Krabs Fork Sync

A small GitHub Action that syncs a fork branch from its upstream. It uses only Node.js built-ins and the GitHub REST API: no `npm install`, no third-party action, and no checkout of the target repository.

The action runs on the `node24` GitHub Actions runtime.

The default `fast-forward` strategy refuses to overwrite commits that exist only in the fork. Use `reset` only when you intentionally want the fork branch to match upstream exactly.

## Usage

Run this workflow in the fork repository.

```yaml
name: Sync fork

on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Sync default branch from upstream
        uses: KrabsWong/sync-fork-action@v1
        id: sync

      - name: Show result
        run: echo "updated=${{ steps.sync.outputs.updated }}"
```

For a fork of a fork, or when GitHub cannot detect the parent, set `upstream-repository` explicitly:

```yaml
with:
  upstream-repository: original-owner/original-repo
  upstream-branch: main
  target-branch: main
```

To preview a sync without changing the branch, add `dry-run: 'true'`.

## Inputs

| Name | Default | Description |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Token with `contents: write` on the fork. A PAT with read access is also needed for a private upstream. |
| `repository` | `GITHUB_REPOSITORY` | Fork repository in `owner/repo` form. |
| `upstream-repository` | detected fork parent | Upstream repository in `owner/repo` form. |
| `upstream-branch` | upstream default branch | Branch to read from upstream. |
| `target-branch` | fork default branch | Branch to update in the fork. |
| `strategy` | `fast-forward` | `fast-forward` fails on divergence; `reset` overwrites the fork branch. |
| `dry-run` | `false` | Resolve and validate without updating the branch. |

## Outputs

| Name | Description |
| --- | --- |
| `updated` | `true` when the fork branch was changed. |
| `previous-sha` | Fork branch commit before the action ran. |
| `sha` | Resulting fork commit, or the target upstream commit in dry-run mode. |
| `upstream-sha` | Upstream commit used as the sync source. |
| `strategy` | Strategy used for the sync. |

## Publishing to GitHub Marketplace

The repository itself must be public, contain exactly one `action.yml` or `action.yaml` at the root, and use a `name` that is unique across GitHub Marketplace. The action is published when a release is created with the Marketplace checkbox selected.

1. Push the action to a public repository, using this repository layout with a single root-level `action.yml`.
2. Open `action.yml` on GitHub and use the **Draft a release** banner, or open **Releases** and choose **Draft a new release**.
3. Select **Publish this action to the GitHub Marketplace**. The first time, the repository owner must accept the GitHub Marketplace Developer Agreement; publishing also requires two-factor authentication.
4. Fix any metadata warnings GitHub shows, choose a primary category, enter a version tag such as `v1`, and publish the release.
5. For later releases, move the `v1` tag to the reviewed commit and create a new immutable release tag such as `v1.0.1`.

GitHub does not review Marketplace actions before listing them. Consumers should pin actions to a commit SHA or a major release tag after reviewing the source.

## Development

```bash
npm test
```

The test suite uses Node's built-in test runner and mocks the GitHub REST API, so it needs no network access or installed packages.

## License

MIT. See [LICENSE](LICENSE).
