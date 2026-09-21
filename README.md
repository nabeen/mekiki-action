# mekiki Action

Build your Storybook in CI and upload it to mekiki. Screenshots, comparison, review and hosting run on mekiki's Cloudflare infrastructure. This Action does not install a browser or fetch the private mekiki repository.

## Usage

The example assumes this directory has been published as `nabeen/mekiki-action` and a `v1` release exists. Pin a full release commit SHA for reproducible use.

```yaml
name: Visual review
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - run: bun install --frozen-lockfile
      - run: bun run build-storybook --stats-json
      - uses: nabeen/mekiki-action@v1
        with:
          project-token: ${{ secrets.MEKIKI_TOKEN }}
          storybook-dir: storybook-static
          viewports: 1280x720,390x844
```

The setup/install/build steps belong to your application: npm, pnpm or yarn also work. The Action runs on GitHub's Node 24 runtime with its ZIP library bundled; users do not install its dependencies. Self-hosted runners must support Node 24 JavaScript Actions.

Install the mekiki GitHub App on the repository, register a project in mekiki, and store its CI token as `MEKIKI_TOKEN`. After the first run, require the **mekiki** check in your branch ruleset and bind its source to the mekiki GitHub App. Require the branch to be up to date. The Action uploads one ZIP and exits after submitting the build. Extraction, capture, comparison and review continue on mekiki. The separate required check reports progress and failures, and stays pending until approval when there are changes. Its Details link and summary both link to the build; the Action job summary also provides the link.

## Inputs

| Input | Default / meaning |
| --- | --- |
| `project-token` | Required project CI token |
| `api-url` | `https://app.mekiki.dev` |
| `storybook-dir` | `storybook-static`; already built with `index.json` |
| `viewports` | `1280x720`; comma-separated dimensions |
| `commit` | PR head SHA or workflow SHA; checkout must match |
| `branch` | PR head branch or workflow branch |
| `base-commit` | PR merge base; otherwise latest approved default-branch build |
| `pull-request` | PR number from the event |
| `only-changed` | `true`: reuse approved snapshots with identical dependency inputs; full capture when tracing is unavailable |
| `force-rebuild` | `false`: set `true` to capture all stories for this run |
| `project-dir` | `.`; the working directory used to build Storybook, especially important in monorepos |
| `externals` | Optional comma/newline separated `*`, `**`, `?` globs relative to project-dir; changes invalidate all stories, including gitignored generated files |
| `wait` | `false`: exit after submitting the ZIP; opt into `true` to wait for capture/comparison, not human approval |
| `timeout` | `900` seconds for capture/comparison |

Outputs: `build-id`, `build-url`, `status`. With `wait: false`, the status may still be queued. Full Git history is needed to calculate the PR merge base. An explicit baseline with no approved build is treated as a new build, with no fallback to an unrelated PR.

## Storybook requirements

- Build Storybook before calling the Action. At most 1,000 story/viewport combinations, 10,000 files, 10 MiB per file and 200 MiB per build including generated PNGs. Compressed ZIP limit: 32 MiB.
- Stories tagged `!test` are excluded. Capture waits for rendering, `play`, fonts and images.
- Capture uses Chromium, UTC, en-US, DPR 1, light color scheme and reduced motion.
- Bundle fonts and images. External network requests and WebSockets are blocked during capture. Use in-process data mocks; Service Workers (including MSW's browser worker) are currently blocked.
- Fork pull requests do not receive secrets. Run trusted changes on an internal branch. Do not use `pull_request_target` to execute untrusted code with the project token.

## Incremental capture

Build with `--stats-json` (`npm run build-storybook -- --stats-json` for npm). Starting with the next approved baseline containing input hashes, the Action traces each story's transitive dependencies from `preview-stats.json`. It fingerprints source contents and dependency edges; mekiki compares those fingerprints against its exact approved baseline. Unchanged stories reuse baseline pixels without starting a browser or running their play functions. Changed/new stories are captured and removed stories still require review. The UI and GitHub Check report reused counts. The full Storybook is still uploaded for hosting.

Preview/decorator dependencies, configuration, lockfiles, untraced Git-managed files, static assets, and `VITE_*`, `STORYBOOK_*`, `NODE_ENV`, `TZ` changes invalidate all stories. Use `externals` for generated inputs. Stats paths must match `project-dir`; source files must match the built Storybook. A lockfile is required. Vite Storybook 10.6 is covered with real-build tests. Standard Webpack modules/reasons are accepted; unsupported forms (including concatenated modules), missing sources/stats or dependencies outside the checkout fall back to full capture. The Action logs the fallback reason. No Git-history-based guess is used for deciding reuse.

Changes driven by arbitrary environment variables, time, randomness or external generators cannot be inferred from a source graph. Make those inputs deterministic, list input files in `externals`, or use `force-rebuild: true`. `only-changed: false` disables optimization entirely. The first build after upgrading still captures all stories because old baselines have no fingerprints. Reused PNGs are copied into the new build; only successfully captured story/viewport pairs consume the monthly allowance. Reused and removed snapshots are free, so an entirely reused build can run even at the monthly limit. Capture failures before a screenshot is produced do not consume allowance; retries of the same snapshot do not double-charge. A successful screenshot remains counted even if its subsequent storage or comparison fails.

## Development and publication

Deploy the incremental-capable backend (migrations through `0006_capture_usage.sql`) before publishing this Action version.

This repository is self-contained. No secrets or private packages are needed to build or test it. The private service repository has its own developer CLI and does not depend on this checkout.

```sh
bun run build
bun test
git diff -- dist/index.cjs
```

Commit `dist/index.cjs` with source changes. CI rebuilds it and checks for drift. Create a release/tag such as `v1` after publishing; this workspace does not publish or tag automatically. Consumers can then reference the public repository with `uses:`.

The build replaces `import.meta.url` with an empty string to keep the bundle independent of the checkout path. ZIP processing uses `useWebWorkers: false`, so zip.js does not need a worker asset base URL.
