# Release process

Cross-references: [CHANGELOG](../CHANGELOG.md), [ROADMAP](./ROADMAP.md).

This document is how to ship a new version to npm. It covers the very
first publish (still alpha, package goes to the `next` dist-tag), every
subsequent alpha / beta, and the eventual transition to a stable `latest`
release. Follow the checklist top-to-bottom; each step has a verifiable
output before moving on.

## Audience and pre-conditions

- The repository at `git@github.com:smilezheng/gojaja.git`
  is **private** during alpha. It will be flipped to public when the
  protocol is judged stable — see "Going public" below.
- npm-side, the package name `gojaja` is registered
  publicly; npm has no concept of "private GitHub + public npm" working
  against each other. Anyone with the package name can `npm view` /
  `npm install` an alpha version once published.
- All publishing happens from the maintainer's laptop (no CI release
  job yet). A CI publish workflow is sketched at the end of this doc;
  enabling it is a one-flag change once you trust the release process.

## What "a release" consists of

| Artifact | Where it lives | Mutated how |
| --- | --- | --- |
| `package.json:version` | repo | `npm version <bump>` or hand-edit |
| `CHANGELOG.md` entry | repo | hand-edit (date + section) |
| `dist/` JavaScript | tarball only | auto-built by `prepublishOnly` |
| npm dist-tag | npm registry | `npm publish --tag <tag>` |
| `git tag v<version>` | repo + GitHub | `git tag` + `git push --tags` |
| GitHub Release notes | GitHub | optional, `gh release create` |

You write the version + CHANGELOG; everything else is mechanical.

## One-time setup (once per maintainer machine)

```bash
# 1. npm credentials
npm login                                # follow prompts; opens browser
npm whoami                               # → smilezheng (or whatever your npm user is)

# 2. gh credentials — already done in this repo's history.
gh auth status                           # confirm "Logged in to github.com"
```

If `npm whoami` complains about email verification, log into
https://www.npmjs.com and confirm the verification mail; npm refuses
publish from unverified accounts.

## Per-release checklist

### 1. Confirm `main` is clean and tests pass

```bash
git checkout main
git pull                                 # fast-forward to remote
git status                               # must be clean
npm run typecheck && npm test            # both must pass
```

Stop here if anything is red. Never publish from a dirty tree.

### 2. Bump the version

For alpha increments (`2.0.0-alpha.9 → 2.0.0-alpha.10`):

```bash
npm version prerelease --preid=alpha     # bumps + commits + tags v<new>
```

For beta cuts (`2.0.0-alpha.N → 2.0.0-beta.0`):

```bash
npm version 2.0.0-beta.0                 # explicit version
```

For the eventual stable cut (`2.0.0-beta.N → 2.0.0`):

```bash
npm version 2.0.0
```

`npm version` automatically commits with message `v<version>` and creates
a matching git tag. Push the tag with the commit:

```bash
git push && git push --tags
```

### 3. Add the CHANGELOG entry

Open `CHANGELOG.md`. Below the `## [Unreleased]` header, add a section:

```markdown
## [2.0.0-alpha.10] — YYYY-MM-DD

### Added
- ...

### Fixed
- ...

### Changed
- ...
```

`npm version` does not edit the CHANGELOG. You can do this **before** the
bump (so the CHANGELOG commit is included) or commit it separately. The
prior pattern in this repo is to do it inside the same PR that ships the
work, so by the time you reach this step the entry is already present —
in that case skip ahead.

### 4. Dry-run the publish

```bash
npm publish --dry-run --tag next
```

Expected output (verify each line):

- ends with `+ gojaja@<version>` and no error.
- tarball size around 80–100 kB during alpha; warn if it suddenly
  jumps to several MB (something has slipped past the `files`
  whitelist).
- file list contains `bin/gojaja`, all `dist/cli/**/*.js` and
  `dist/core/**/*.js`, `README.md`, `README.zh-CN.md`, `LICENSE`,
  `CHANGELOG.md`, `package.json`.
- file list does NOT contain `src/`, `tests/`, `docs/` (those are
  human-facing repo docs, not user-installation docs), `.git/`,
  `node_modules/`, `.tmp/`, `coverage/`.

The `prepublishOnly` hook runs `typecheck + test + build` before each
real publish, so a broken tree cannot ship. Dry-run also triggers it.

### 5. Publish

For an alpha or beta (anything with a prerelease tag in the version):

```bash
npm publish --tag next
```

`--tag next` is mandatory — npm refuses to publish a prerelease without
an explicit tag (so you can never accidentally promote an alpha to the
default `latest` tag).

For the stable `2.0.0` cut (no prerelease tag in the version):

```bash
npm publish                              # default tag is "latest"
```

Sanity check immediately after:

```bash
npm view gojaja dist-tags
# during alpha:  { next: "2.0.0-alpha.10" }
# after stable:  { latest: "2.0.0", next: "<latest alpha if still around>" }
```

### 6. Verify the install path from a clean environment

In a separate shell, away from this repo:

```bash
mkdir -p /tmp/ma-test && cd /tmp/ma-test
npx -y gojaja@next --version
# → gojaja <version>
npx -y gojaja@next help
# → full help, no stack traces
```

If `--version` or `help` errors, **immediately deprecate the broken
release** (does not delete it, but warns installs):

```bash
npm deprecate gojaja@<version> "broken; use <next-good-version>"
```

Then fix-forward with a new patch / prerelease bump.

### 7. Create a GitHub Release (optional but useful for tracking)

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes-file - <<'EOF'
See CHANGELOG.md for the full notes.
EOF
```

For a richer release, paste the CHANGELOG section as the body. GitHub
auto-attaches the source archive; no need to upload binaries (npm has
those).

While the repo is private, releases are private too — they are useful
for your own changelog navigation but invisible to outside collaborators.
They become public the moment the repo is flipped to public.

## Going public

When you decide the protocol is stable enough to invite outside use:

```bash
gh repo edit smilezheng/gojaja --visibility public
```

There is no separate npm step — the package is already publicly
installable from `next` (npm has no concept of repo-tied visibility).
What changes after the flip:

- GitHub issues / PRs become open.
- Existing GitHub releases / tags become visible.
- The `homepage` and `repository` URLs in the npm metadata start
  resolving to a public page rather than a 404.
- `gh repo view --web` from anyone (not just you) works.

Consider also adding a `LICENSE` reminder, a `CONTRIBUTING.md`, and a
`CODE_OF_CONDUCT.md` before flipping — outside contributors look for
these. The license is already in `LICENSE` at the repo root; the other
two are conventions, not requirements.

## Promoting an alpha to stable `latest`

When you ship `2.0.0` final:

1. `npm publish` (no `--tag` flag — defaults to `latest`).
2. `npm view gojaja dist-tags` should now show
   `latest: 2.0.0` and (if you want to keep them) older alpha versions
   still living under `next`.
3. The README's `npm install -g gojaja` instruction
   (without `@next`) now works as expected; users get 2.0.0.

If you want to retire the `next` tag entirely so it does not float on
an old alpha:

```bash
npm dist-tag rm gojaja next
```

## Yanking a bad release

You cannot delete a published version on npm (npm forbids unpublish
after 72 hours, and even within the window the version number stays
reserved). To withdraw a broken release:

```bash
# 1. Mark it broken so npm warns on install:
npm deprecate gojaja@<bad-version> "broken; upgrade to <good-version>"

# 2. Publish a fresh patch with the fix.
# 3. If the broken version was on the `next` tag, point `next` away:
npm dist-tag add gojaja@<good-version> next
```

The deprecate message is shown to users at install time and shown
prominently on the npmjs.com page.

## Future automation (when manual flow feels stable)

Drop this into `.github/workflows/release.yml` to publish on tag push:

```yaml
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: "https://registry.npmjs.org"
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: npm run build
      - run: |
          if [[ "${GITHUB_REF_NAME}" == *"alpha"* || "${GITHUB_REF_NAME}" == *"beta"* ]]; then
            npm publish --tag next
          else
            npm publish
          fi
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Setup steps when enabling:

1. On npmjs.com → Account → Access Tokens → Generate "Automation" token.
2. On GitHub → repo Settings → Secrets and variables → Actions →
   `New repository secret` → name `NPM_TOKEN`, paste the npm token.
3. Push a `v...` tag; watch the run succeed.

Manual publish from a laptop still works after this — they are
complementary, not exclusive.

## Reference: dist-tag mental model

```
next     → latest alpha/beta            (npm i ...@next)
latest   → stable                       (npm i ... with no tag)
```

`npm publish` with no flag goes to `latest`. `npm publish --tag <name>`
goes to whatever tag you specify. npm refuses to put a version with a
prerelease component (`-alpha.X`, `-beta.X`) on `latest` unless you
explicitly opt in — that is the safety net that has saved this project
more than once during the alpha cycle.

Always think "which tag should this version live under?" before
publishing. When in doubt, `--tag next`.
