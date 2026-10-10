# @gitpoc/clischema/server — policy model

State per invocation:
```ts
{ dryRun: boolean, readOnly: boolean }
```

Set by `--dryrun`/`--readonly` flags, or by `<TOOL>_DRYRUN` /
`<TOOL>_READONLY` env vars (values 1/true/yes/on).

Behavior (`checkPolicy`):

| Access | --dryrun | --readonly | --confirm required? |
|---|---|---|---|
| read  | runs (no-op for policy) | runs | n/a |
| write | synthetic success result, nothing executed | refused, exit 6 | if op is marked `dangerous` *and* policy allows it |
| write (dangerous) | same as write | refused, exit 6 | `--confirm`/`--i-understand` else exit 9 |

The `dangerous` flag is per-call-site and is part of the op implementation,
not the schema. In `aws2` it is also derived automatically from
`DANGEROUS_OPS` (e.g. `ec2 terminate-instances`, `dynamodb delete-table`,
`s3api delete-bucket`).

The synthetic dry-run result returns `{ success: true, dryRun: true,
simulated: <op-name>, command?: string[] }` — when the op has built the argv
it is included, so callers can inspect exactly what would have run.
