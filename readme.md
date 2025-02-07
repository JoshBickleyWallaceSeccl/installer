# Installer

This is not intended for any more than a tool of convenience, so it's incomplete, rough, temperamental etc. etc.

```sh
npm i -g pnpm && pnpm i
```

will get you started.

You can use this to install teirs of packages up to a service, e.g.

In `installer.ts` see the final line:

```ts
void main([
  "@seccl/custody-workflow-manager"
]);
```

Running `pnpm install-packages` will install and pack everything up to `custody-workflow-manager` (you will need all the repos on disk.)

It will cache what it's done in `successful-packages.json` - delete entries to clean and start again or remove steps to rerun them.
