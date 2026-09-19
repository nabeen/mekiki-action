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
      - run: bun run build-storybook
      - uses: nabeen/mekiki-action@v1
        with:
          project-token: ${{ secrets.MEKIKI_TOKEN }}
          storybook-dir: storybook-static
          viewports: 1280x720,390x844
```

The setup/install/build steps belong to your application: npm, pnpm or yarn also work. The Action itself runs on GitHub's Node 24 runtime and has no npm runtime dependencies. Self-hosted runners must support Node 24 JavaScript Actions.

Install the mekiki GitHub App on the repository, register a project in mekiki, and store its CI token as `MEKIKI_TOKEN`. After the first run, require the **mekiki** check in your branch ruleset and bind its source to the mekiki GitHub App. Require the branch to be up to date. The Action waits for capture/comparison, then succeeds even if review is pending. The separate required check stays pending until approval. A failed capture/comparison fails the Action.

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
| `wait` | `true`: wait for capture/comparison, not human approval |
| `timeout` | `900` seconds for capture/comparison |

Outputs: `build-id`, `build-url`, `status`. With `wait: false`, the status may still be queued. Full Git history is needed to calculate the PR merge base. An explicit baseline with no approved build is treated as a new build, with no fallback to an unrelated PR.

## Storybook requirements

- Build Storybook before calling the Action. At most 1,000 story/viewport combinations, 10,000 files, 10 MiB per file and 200 MiB per build including generated PNGs.
- Stories tagged `!test` are excluded. Capture waits for rendering, `play`, fonts and images.
- Capture uses Chromium, UTC, en-US, DPR 1, light color scheme and reduced motion.
- Bundle fonts and images. External network requests and WebSockets are blocked during capture. Use in-process data mocks; Service Workers (including MSW's browser worker) are currently blocked.
- Fork pull requests do not receive secrets. Run trusted changes on an internal branch. Do not use `pull_request_target` to execute untrusted code with the project token.

## Development and publication

This repository is self-contained. No secrets or private packages are needed to build or test it. The private service repository has its own developer CLI and does not depend on this checkout.

```sh
bun run build
bun test
git diff -- dist/index.cjs
```

Commit `dist/index.cjs` with source changes. CI rebuilds it and checks for drift. Create a release/tag such as `v1` after publishing; this workspace does not publish or tag automatically. Consumers can then reference the public repository with `uses:`.
