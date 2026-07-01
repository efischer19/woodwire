# feat: Add CloudFormation Template Validation to CI

## What do you want to build?

Add a CI job that validates the CloudFormation templates in the `infra/`
directory on every pull request and push to `main`. Currently, the templates
are not validated in any CI workflow — a YAML syntax error or invalid resource
property would only be caught during manual deployment. The `cfn-lint` tool
provides static analysis of CloudFormation templates without requiring AWS
credentials.

## Acceptance Criteria

- [ ] A new `cfn-lint` job in `.github/workflows/ci.yml` validates all `*.yaml` files in the `infra/` directory
- [ ] The job uses the `cfn-lint` Python package (installed via `pip install cfn-lint`)
- [ ] The job uses `actions/setup-python@v6` with `python-version: '3.12'`
- [ ] The job has a path filter so it only runs when files in `infra/` change (on push events) or on all pull requests
- [ ] The job has `permissions: contents: read`
- [ ] The job runs `cfn-lint infra/*.yaml` and fails on any errors
- [ ] All existing CloudFormation templates pass `cfn-lint` without errors (fix any issues found)
- [ ] Existing CI jobs are not modified

## Implementation Notes (Optional)

**Job structure:**

```yaml
cfn-lint:
  name: CloudFormation Lint
  needs: detect-changes
  if: needs.detect-changes.outputs.infra == 'true'
  runs-on: ubuntu-latest
  steps:
    - name: Checkout code
      uses: actions/checkout@v7

    - name: Set up Python
      uses: actions/setup-python@v6
      with:
        python-version: '3.12'

    - name: Install cfn-lint
      run: pip install cfn-lint

    - name: Lint CloudFormation templates
      run: cfn-lint infra/*.yaml
```

**Path filter addition** (in the `detect-changes` job):

Add an `infra` filter:

```yaml
infra:
  - 'infra/**'
```

And a corresponding output decision step.

**Files to modify:**

- `.github/workflows/ci.yml`: Add `infra` path filter output, add `cfn-lint`
  job
