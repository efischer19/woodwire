# feat: Add Worker and Bot Test Jobs to CI Pipeline

## What do you want to build?

Add two new jobs to `.github/workflows/ci.yml` so that the Cloudflare Worker
unit tests and the Python bot unit tests run on every pull request and push to
`main`. Currently, neither test suite is executed in CI — Worker regressions
are only caught at deploy time, and bot regressions are only caught locally.
Both test suites already exist and pass; they just need to be wired into the
CI workflow.

## Acceptance Criteria

- [ ] A new `worker-tests` job in `.github/workflows/ci.yml` runs `npm ci && npm test` in the `worker/` directory
- [ ] The `worker-tests` job uses `actions/setup-node@v4` with `node-version: '20'`
- [ ] The `worker-tests` job has a path filter so it only runs when files in `worker/` change (on push events) or on all pull requests
- [ ] A new `bot-tests` job in `.github/workflows/ci.yml` runs `python -m unittest discover -s bot/tests -v`
- [ ] The `bot-tests` job uses `actions/setup-python@v6` with `python-version: '3.12'`
- [ ] The `bot-tests` job installs bot dependencies via `pip install -r bot/requirements.txt` before running tests
- [ ] The `bot-tests` job has a path filter so it only runs when files in `bot/` change (on push events) or on all pull requests
- [ ] Both new jobs have `permissions: contents: read`
- [ ] Existing CI jobs are not modified
- [ ] Both new jobs pass on the current codebase

## Implementation Notes (Optional)

**Path filtering pattern:** Follow the existing `detect-changes` job pattern
in the CI workflow. Add `worker` and `bot` outputs to the `detect-changes`
job's path filter step, then use `needs: detect-changes` with an `if`
condition on the new jobs.

**Worker test job structure:**

```yaml
worker-tests:
  name: Worker Tests
  needs: detect-changes
  if: needs.detect-changes.outputs.worker == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout code
      uses: actions/checkout@v7

    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install dependencies
      run: npm ci
      working-directory: worker

    - name: Run tests
      run: npm test
      working-directory: worker
```

**Bot test job structure:**

```yaml
bot-tests:
  name: Bot Tests
  needs: detect-changes
  if: needs.detect-changes.outputs.bot == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout code
      uses: actions/checkout@v7

    - name: Set up Python
      uses: actions/setup-python@v6
      with:
        python-version: '3.12'

    - name: Install dependencies
      run: pip install -r bot/requirements.txt

    - name: Run tests
      run: python -m unittest discover -s bot/tests -v
```

**Files to modify:**

- `.github/workflows/ci.yml`: Add path filter outputs for `worker` and `bot`
  in the `detect-changes` job, add `worker-tests` and `bot-tests` jobs.
