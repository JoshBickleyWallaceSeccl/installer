import { Listr } from "listr2";
import path from "node:path";
import { KnownPackages, resolveKnownPackages } from "./known-packages";
import { execAsync } from "./utils";
import tiers from './tiers.json';
import { SuccessCache } from "./sucessful-packages";

type Step = "Unit Tests" | "Integration Tests";

const successCache = new SuccessCache<Step>('./successful-package-tests.json');

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
          return task.newListr(tiers.map((tier, index) => ({
            title: `Tier ${index + 1}`,
            task: (ctx, task) => {
              return task.newListr<Context>(Object.keys(tier)
                .filter((pkg) => ![
                  "@seccl/portfolio-analysis-manager",
                  "@seccl/interface-manager",
                  "@seccl/investment-workflow-manager",
                  "@seccl/event-workflow-manager",
                  "@seccl/client-data-manager"
                ].includes(pkg))
                .map((pkg) => ({
                  title: `${pkg}`,
                  exitOnError: () => pkg !== '@seccl/id-generator',
                  task: ({ packages }, task) => {
                    const packageInfo = packages.get(pkg);
                    if (!packageInfo) {
                      throw Error(`Package ${pkg} not found`);
                    }

                    return task.newListr([{
                      title: "Integration Tests",
                      enabled: () => {
                        return !!packageInfo.packageJson.scripts?.['test:integration'];
                      },
                      task: successCache.wrapTask("Integration Tests", pkg, async (): Promise<void> => {
                        const command = packageInfo.packageJson.scripts?.['test:integrationlocal']
                          ? 'test:integrationlocal'
                          : 'test:integration';
                        await execAsync(
                          `npm run ${command}`,
                          { cwd: packageInfo.packagePath }
                        )
                      })
                    }, {
                      title: "Unit Tests",
                      enabled: () => {
                        return !!packageInfo.packageJson.scripts?.['test:local'];
                      },
                      task: successCache.wrapTask("Unit Tests", pkg, async (): Promise<void> => {
                        async () => execAsync(
                          `npm run test:local`,
                          { cwd: packageInfo.packagePath }
                        );
                      })
                    }], { concurrent: false });
                  }
                })))
            }
          })))
        }
      }
    ],
    { concurrent: false }
  )

  await tasks.run()
};

void main();
