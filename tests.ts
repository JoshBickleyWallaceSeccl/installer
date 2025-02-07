import { Listr } from "listr2";
import path from "node:path";
import { KnownPackages, resolveKnownPackages } from "./known-packages";
import { execAsync, isRetrying } from "./utils";
import tiers from './tiers.json';

interface Context {
  packages: KnownPackages;
}

const main = async () => {
  const rootDirectory = path.resolve(__dirname, '..');
  const tasks = new Listr<Context>(
    [
      {
        title: 'Get Packages',
        task: async (ctx) => {
          ctx.packages = await resolveKnownPackages(rootDirectory);
        }
      },
      {
        title: 'Tests',
        task: (ctx, task): Listr<Context> => {
          return task.newListr(tiers.flatMap((tier) => {
            return Object.keys(tier).map((pkg) => ({
              title: `${pkg}`,
              retry: 1,
              task: async ({ packages }, task) => {
                const packageInfo = packages.get(pkg);
                if (!packageInfo) {
                  throw Error(`Package ${pkg} not found`);
                }

                return task.newListr([{
                  title: "Integration Tests",
                  enabled: () => {
                    return !!packageInfo.packageJson.scripts?.['test:integration'];
                  },
                  task: async () => {
                    await execAsync(`npm run test:integration`, { cwd: packageInfo.packagePath });
                  }
                }, {
                  title: "Unit Tests",
                  enabled: () => {
                    return !!packageInfo.packageJson.scripts?.['test:local'];
                  },
                  task: async () => {
                    await execAsync(`npm run test:local`, { cwd: packageInfo.packagePath });
                  }
                }]);
              }
            }))
          }))
        }
      }
    ],
    { concurrent: false, exitOnError: true }
  )

  await tasks.run()
};

void main();
