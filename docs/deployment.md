# Development backend deployment

This runbook deploys the development API to AWS and points it at the active
Neon database. It does not deploy the Expo app or the production environment.

Run it from the repository root. Stop if any identity, diff, migration, or
probe does not match the expected result. Never paste or print the database URL.
It contains the database password.

## Deployment facts

| Item | Value |
| --- | --- |
| AWS account | `195950944150` |
| AWS region | `us-east-2` |
| CloudFormation stack | `BetterWakeUp-Api-dev` |
| Lambda function | `betterwakeup-api-dev` |
| API URL | `https://v2lss2uehl656cxcweqxjezyxi0pvqxw.lambda-url.us-east-2.on.aws` |
| Database parameter | `/betterwakeup/dev/secrets/database-url` |
| Neon project | `BetterWakeUp` (`raspy-fire-73288057`) |
| Neon branch | `production` |
| Neon role | `neondb_owner` |
| Neon database | `neondb` |

The Neon branch is currently named `production`, but this procedure uses it for
the development API. Do not infer the AWS stage from the branch name.

## 1. Check the checkout and credentials

Deploy a committed, clean checkout so the running code can be traced back to a
Git commit.

```sh
test -z "$(git status --porcelain)"
git rev-parse HEAD
pnpm run check

aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output json
pnpm dlx neonctl@3.6.0 auth
```

The AWS account must be `195950944150`. Neon authentication opens a browser and
stores the resulting CLI session outside the repository.

## 2. Retrieve and verify the active database URL

Keep shell tracing off while the connection string is in memory. The pooled
hostname is required because the Lambda selects the Neon serverless driver from
that hostname.

```sh
set -euo pipefail
set +x

DATABASE_URL=$(pnpm --silent dlx neonctl@3.6.0 connection-string production \
  --project-id raspy-fire-73288057 \
  --role-name neondb_owner \
  --database-name neondb \
  --pooled \
  --ssl require)

PGCONNECT_TIMEOUT=15 psql "$DATABASE_URL" \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --tuples-only \
  --command 'select 1;' | grep -q '1'
```

Do not continue if this fails. A reachable hostname is not enough. The probe
must authenticate successfully.

## 3. Update Parameter Store

Write the verified URL as a SecureString, read it back, and prove that the value
AWS now holds can connect. None of these commands prints the value.

```sh
aws ssm put-parameter \
  --name /betterwakeup/dev/secrets/database-url \
  --type SecureString \
  --value "$DATABASE_URL" \
  --overwrite \
  --region us-east-2 \
  --query '{Version:Version,Tier:Tier}' \
  --output json

DEPLOYED_DATABASE_URL=$(aws ssm get-parameter \
  --name /betterwakeup/dev/secrets/database-url \
  --with-decryption \
  --region us-east-2 \
  --query Parameter.Value \
  --output text)

PGCONNECT_TIMEOUT=15 psql "$DEPLOYED_DATABASE_URL" \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --tuples-only \
  --command 'select 1;' | grep -q '1'
```

## 4. Apply migrations

Migrations must reach the database before code that expects the new schema.

```sh
DATABASE_URL="$DEPLOYED_DATABASE_URL" \
  pnpm --filter @betterwakeup/server run db:migrate
```

The command must report `Migrations applied via neon-serverless.`

## 5. Build the Lambda bundle

The Lambda bundle must be CommonJS. The AWS SDK contains CommonJS dependencies
that make an ESM bundle fail during Lambda initialization with a dynamic
`require` error.

```sh
BUNDLE="/tmp/betterwakeup-lambda-$(git rev-parse --short HEAD)"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"

pnpm dlx esbuild@0.25.12 server/src/lambda/runtime.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --sourcemap \
  --sources-content=false \
  --outfile="$BUNDLE/index.js"

node -e '
  const deployed = require(process.argv[1]);
  if (typeof deployed.handler !== "function") process.exit(1);
' "$BUNDLE/index.js"
```

Do not add a `package.json` with `"type": "module"` to the bundle.

## 6. Review and deploy the CDK change

First use a template diff. For an application-only deployment, the diff must
change only the Lambda `Code` asset and its asset metadata. Stop if it changes
IAM, schedules, alarms, secrets, or any other resource.

```sh
cd infra

pnpm exec cdk diff BetterWakeUp-Api-dev \
  -c bwu:codeAssetPath="$BUNDLE" \
  --method template

pnpm exec cdk deploy BetterWakeUp-Api-dev \
  -c bwu:codeAssetPath="$BUNDLE" \
  --yes

cd ..
```

CloudFormation must finish with `UPDATE_COMPLETE`.

## 7. Prove the deployment

The health endpoint proves that Lambda can initialize and answer HTTP. It does
not open the database, so it cannot prove the repaired credential or migrated
schema.

```sh
curl --fail --silent --show-error \
  https://v2lss2uehl656cxcweqxjezyxi0pvqxw.lambda-url.us-east-2.on.aws/health

aws lambda get-function-configuration \
  --function-name betterwakeup-api-dev \
  --region us-east-2 \
  --query '{LastModified:LastModified,LastUpdateStatus:LastUpdateStatus}' \
  --output json
```

The health response must be `{"status":"ok"}`, and `LastUpdateStatus` must be
`Successful`.

Then open a development build, sign in, and load or refresh home. This is the
end-to-end database probe because it sends an authenticated
`GET /challenges/current`. Confirm its HTTP 200 in CloudWatch:

```sh
aws logs tail /aws/lambda/betterwakeup-api-dev \
  --since 10m \
  --format short \
  --region us-east-2 \
  | grep '"route":"/challenges/current"' \
  | tail
```

Do not accept `/health` alone as deployment proof. The authenticated route must
also return 200.

## 8. Clean up

```sh
unset DATABASE_URL DEPLOYED_DATABASE_URL
rm -rf "$BUNDLE"
git status --short
```

The final `git status` must be empty. Build output belongs in `/tmp`; never add a
Lambda bundle or decrypted connection string to the repository.

## Failure handling

- If the database probe reports password authentication failure, retrieve the
  current Neon connection string again. Do not reuse the previous Parameter
  Store value.
- If `/health` returns 502 after deployment, inspect initialization logs before
  touching the app:

  ```sh
  aws logs tail /aws/lambda/betterwakeup-api-dev \
    --since 10m \
    --format short \
    --region us-east-2
  ```

- If the authenticated route returns 401 after changing databases, the device
  may hold a session created in the previous database. Sign in again. The app
  clears a session the server refuses.
- If the authenticated route returns 500, use its CloudWatch request ID to find
  the failing database operation. Do not treat a healthy `/health` response as
  evidence that the database works.
