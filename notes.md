# Notes

## application-data-resource

Also update constants and utils.

## fix-processor

**out of scope**

Need ubuntu? Get node-gyp errors while building - maybe talk to Kev

```json
  "@seccl/fix-processor": [
    "@seccl/notifications",
    "@seccl/queue"
  ],
```

> :Warning: out of scope.

## scheduler

**Required change: Add @types/aws-lambda to devDependencies.**

Fails to build:

```sh
~/src/secondary/scheduler (master●)
$ npm run build                                    <aws:sandbox> <region:eu-west-1>

> @seccl/scheduler@1.9.1 build
> tsc -d

node_modules/@seccl/aws-utils/src/Lambda/helpers/requestAudit.d.ts:1:25 - error TS2307: Cannot find module 'aws-lambda' or its corresponding type declarations.

1 import { Context } from "aws-lambda";
                          ~~~~~~~~~~~~

node_modules/@seccl/aws-utils/src/Lambda/helpers/requestAudit.d.ts:2:38 - error TS2307: Cannot find module 'aws-lambda' or its corresponding type declarations.

2 import { APIGatewayProxyEvent } from "aws-lambda";
                                       ~~~~~~~~~~~~

Found 2 errors in the same file, starting at: node_modules/@seccl/aws-utils/src/Lambda/helpers/requestAudit.d.ts:1
```

```json
// Tier 7
"@seccl/scheduler": [
  "@seccl/notifications",
  "@seccl/aws-utils",
  "@seccl/queue"
]
```

## firm-data-manager

Missing dependency "@seccl/firm-data-manager-contracts" which is also in workspace. Seems... wrong.

```sh
src/index.ts:28:7 - error TS2742: The inferred type of 'functionMap' cannot be named without a reference to '@seccl/firm-data-resource/node_modules/@seccl/constants'. This is likely not portable. A type annotation is necessary.

28 const functionMap = {
         ~~~~~~~~~~~


Found 1 error in src/index.ts:28

npm ERR! Lifecycle script `build` failed with error:
npm ERR! Error: command failed
npm ERR!   in workspace: @seccl/firm-data-manager@4.5.2
npm ERR!   at location: /Users/joshbickley-wallace/src/secondary/firm-data-manager/packages/service
```

tier 8

```json
    "@seccl/firm-data-manager": [
      "@seccl/firm-data-resource",
      "@seccl/feature-flag-utils",
      "@seccl/id-generator",
      "@seccl/security",
      "@seccl/queue"
    ],
```
