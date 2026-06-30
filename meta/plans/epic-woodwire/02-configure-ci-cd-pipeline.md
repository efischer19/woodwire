# feat: Configure CI/CD Pipeline for Woodwire Deployment

## What do you want to build?

Update the existing GitHub Actions workflows to support Woodwire's deployment
needs. The template repository includes a generic `deploy-aws.yml` workflow
that syncs `src/` to S3. This needs to be configured with the correct triggers,
secrets documentation, and a push-on-main auto-deploy.

Additionally, add a new workflow (or extend the existing one) to deploy the
Cloudflare Worker, and ensure CI path filters avoid unnecessary builds when
only documentation changes.

## Acceptance Criteria

- [ ] `deploy-aws.yml` is updated to trigger on push to `main` in addition to `workflow_dispatch`
- [ ] `deploy-aws.yml` only triggers when files in `src/` are changed (path filter)
- [ ] A new `deploy-worker.yml` workflow is created for Cloudflare Worker deployment via `wrangler` (can be a skeleton — Worker source is a later ticket)
- [ ] `deploy-worker.yml` only triggers when files in `worker/` are changed
- [ ] `ci.yml` is updated with path-aware job triggers so bot-only or docs-only changes don't run frontend linting
- [ ] All required GitHub repository secrets and variables are documented in a `DEPLOY.md` or in the README deployment section
- [ ] Documentation lists: `AWS_ROLE_ARN`, `AWS_REGION`, `S3_BUCKET_NAME`, `CLOUDFRONT_DISTRIBUTION_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- [ ] All CI checks pass on the PR itself

## Implementation Notes (Optional)

The existing `deploy-aws.yml` already has OIDC-based AWS credential
configuration — preserve that pattern. Do not hardcode any secrets.

For the Cloudflare Worker deployment, use the official `wrangler` CLI via
`npm`. The workflow should:

1. Install wrangler
2. Deploy using `CLOUDFLARE_API_TOKEN` from GitHub secrets

Path filters in GitHub Actions use the `paths` key under `on.push`:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
```

Keep the `workflow_dispatch` trigger on all deploy workflows so manual deploys
remain possible.

The CI workflow should continue to run on all PRs regardless of paths (quality
gate), but deploy workflows should be path-scoped.
