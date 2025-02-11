import fg from 'fast-glob';
import path from "node:path";
import fs from "node:fs";
import { Listr } from 'listr2'
import { KnownPackages, PackageInfo, resolveKnownPackages } from "./known-packages";
import { exists, execAsync, isRetrying, Tier } from "./utils";
import { SuccessCache } from "./sucessful-packages";

type Step = "Workspace Install" | "Install" | "Install Dev" | "Build" | "Deploy" | "Pack" | "Clean" | "Rebase" | "Push";

const success = new SuccessCache<Step>('./successful-packages.json');
interface Context {
  packages: KnownPackages;
  tiers: { [pkg: string]: string[] }[];
}

const getLocalTarballs = (dependencies: string[], packages: KnownPackages): string[] => {
  return dependencies.map((dependency) => {
    const dependencyInfo = packages.get(dependency);
    if (!dependencyInfo) {
      throw Error(`Dependency ${dependency} not found`);
    }
    if (dependencyInfo.packageType === 'service') {
      throw Error(`Dependency ${dependency} is a service`);
    }
    if (!dependencyInfo.localTarball) {
      throw Error(`Dependency ${dependency} does not have a local tarball`);
    }
    return dependencyInfo.localTarball;
  });
};

const resolveServerlessPath = (packages: KnownPackages, packageInfo: PackageInfo): string => {
  if (packageInfo.packageType !== 'service') {
    throw new Error("Unable to resolve serverless path; package is not a service");
  }
  if (exists(path.join(packageInfo.packagePath, 'serverless.ts'))) {
    return packageInfo.packagePath;
  }
  if (packageInfo.workspaceRootPackage) {
    const workspaceRootPath = packages.get(packageInfo.workspaceRootPackage)?.packagePath;
    if (workspaceRootPath && exists(path.join(workspaceRootPath, 'serverless.ts'))) {
      return workspaceRootPath;
    }
  }

  throw new Error("Unable to resolve serverless path");
};

const resolveTargetTiers = (targetServices: string[], tiers: Tier[]): Tier[] => {
  if (targetServices.length === 0) {
    return tiers;
  }

  const { targetTiers: result } = [...tiers].reverse().reduce<{ targetTiers: Tier[]; nextPackages: Set<string>; }>(
    ({ targetTiers: targetTiers, nextPackages }, tier) => {
      const newTier = Object.entries(tier).filter(([pkg]) => nextPackages.has(pkg));
      if (newTier.length === 0) {
        return { targetTiers, nextPackages };
      }
      newTier.forEach(([pkg, dependencies]) => {
        nextPackages.delete(pkg);
        dependencies.forEach((dependency) => nextPackages.add(dependency));
      });
      targetTiers.unshift(Object.fromEntries(newTier));

      return { targetTiers, nextPackages };
    },
    {
      targetTiers: [],
      nextPackages: new Set(targetServices)
    }
  );

  return result;
};

const main = async (
  targetServices: string[] = [],
  externalPackageTargetVersions: { [pkg: string]: string } = {}
) => {
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
        title: 'Resolve Tiers',
        task: async (ctx) => {
          const { default: tiers } = await import('./tiers.json');
          ctx.tiers = await resolveTargetTiers(targetServices, tiers as unknown as Tier[]);
        }
      },
      {
        title: 'Deploy Stack',
        task: ({ tiers, packages }, task): Listr<Context> => {
          return task.newListr(tiers.map((tier, index) => ({
            title: `Tier ${index + 1}`,
            task: (ctx, task) => {

              return task.newListr<Context>(Object.entries(tier).map(([pkg, dependencies]) => {
                const packageInfo = packages.get(pkg);

                if (!packageInfo) {
                  throw Error(`Package ${pkg} not found`);
                }
                return {
                  title: `${pkg} (${packageInfo.currentBranch})`,
                  retry: 1,
                  task: (ctx, task): Listr<Context> => {
                    return task.newListr<Context>([
                      {
                        title: "Rebase",
                        enabled: () => {
                          return !success.hasSeen(pkg)
                            && (!packageInfo.workspaceRootPackage || !success.hasSucceeded(
                              packageInfo.workspaceRootPackage, "Rebase"
                            ));
                        },
                        task: async () => {
                          await execAsync(
                            `git fetch && git reset --hard HEAD && git rebase origin/${packageInfo.defaultBranch}`,
                            { cwd: packageInfo.packagePath }
                          );
                          await success.resetPackageSuccess(pkg);
                          if (packageInfo.workspaceRootPackage) {
                            await success.recordSuccess(packageInfo.workspaceRootPackage, 'Rebase');
                          }
                        }
                      },
                      {
                        title: "Push",
                        enabled: () => {
                          return packageInfo.currentBranch !== packageInfo.defaultBranch;
                        },
                        task: async () => {
                          if (success.hasSucceeded(pkg, "Push")) return;
                          await execAsync(
                            `git push --force-with-lease`,
                            { cwd: packageInfo.packagePath }
                          );
                          await success.recordSuccess(pkg, 'Push');
                        }
                      },
                      {
                        title: `Clean`,
                        enabled: () => {
                          return !success.hasSeen(pkg) && (!packageInfo.workspaceRootPackage || !success.hasSucceeded(
                            packageInfo.workspaceRootPackage, "Clean"
                          ));
                        },
                        task: async () => {
                          await execAsync(`git reset --hard HEAD && git clean -fdX && rm -f *.tsbuildinfo`, { cwd: packageInfo.packagePath })
                          await success.resetPackageSuccess(pkg);
                          if (packageInfo.workspaceRootPackage) {
                            await success.recordSuccess(packageInfo.workspaceRootPackage, 'Clean');
                          }
                        }
                      },
                      {
                        title: "Install Workspace Packages",
                        enabled: () => !!packageInfo.workspaceRootPackage,
                        retry: 1,
                        task: async (ctx, task) => {
                          if (success.hasSucceeded(pkg, "Workspace Install")) return;

                          const command = isRetrying(task) ? "clean-install" : "install";
                          const workingDir = packages.get(packageInfo.workspaceRootPackage!)?.packagePath;

                          await execAsync(`npm ${command}`, { cwd: workingDir });

                          await success.recordSuccess(pkg, 'Workspace Install');
                        },
                      },
                      {
                        title: `Install dependencies`,
                        retry: 1,
                        task: async (ctx, task) => {
                          if (success.hasSucceeded(pkg, "Install")) return;
                          if (isRetrying(task)) {
                            await execAsync(`git clean -fdX && npm clean-install`, { cwd: packageInfo.packagePath })
                          }

                          const externalDependencies = Object.keys(packageInfo.packageJson.dependencies ?? {})
                            .filter((dependency: string) => dependency in externalPackageTargetVersions)
                            .map((dependency) => `${dependency}@${externalPackageTargetVersions[dependency]}`);

                          const localTarballs = getLocalTarballs(dependencies, packages);

                          const command = `npm install ${[...localTarballs, ...externalDependencies].map((dep) => `"${dep}"`).join(' ')}`;

                          await execAsync(command, { cwd: packageInfo.packagePath });

                          await success.recordSuccess(pkg, 'Install');
                        },
                      },
                      {
                        title: `Install dev dependencies`,
                        retry: 1,
                        task: async (ctx, task) => {
                          if (success.hasSucceeded(pkg, "Install Dev")) return;

                          const externalDependencies = Object.keys(packageInfo.packageJson.devDependencies ?? {})
                            .filter((dependency: string) => dependency in externalPackageTargetVersions)
                            .map((dependency) => `${dependency}@${externalPackageTargetVersions[dependency]}`);

                          if ("@seccl/test-utils" in (packageInfo.packageJson.devDependencies ?? {})) {
                            externalDependencies.push("@jest/globals");
                          }

                          if (externalDependencies.length !== 0) {
                            const command = `npm install -D ${externalDependencies.map((dep) => `"${dep}"`).join(' ')}`;
                            await execAsync(command, { cwd: packageInfo.packagePath });
                          }

                          await success.recordSuccess(pkg, 'Install Dev');
                        },
                      },
                      {
                        title: `Build`,
                        task: async () => {
                          if (success.hasSucceeded(pkg, "Build")) return;

                          const workingDirectory = packageInfo.workspaceRootPackage
                            ? packages.get(packageInfo.workspaceRootPackage)?.packagePath
                            : packageInfo.packagePath;

                          await execAsync(`npm run build`, { cwd: workingDirectory });
                          await success.recordSuccess(pkg, 'Build');
                        }
                      },
                      {
                        title: `Deploy`,
                        enabled: () => packageInfo.packageType === 'service',
                        retry: 1,
                        task: async () => {
                          if (success.hasSucceeded(pkg, "Deploy")) return;
                          const serverlessPath = resolveServerlessPath(packages, packageInfo);
                          await execAsync(`npm run deploy --ignore-scripts`, { cwd: serverlessPath });
                          await success.recordSuccess(pkg, 'Deploy');
                        },
                      },
                      {
                        title: `Pack`,
                        enabled: () => packageInfo.packageType === 'library',
                        task: async () => {
                          if (!success.hasSucceeded(pkg, "Pack")) {
                            await execAsync(`npm pack`, { cwd: packageInfo.packagePath });
                          };

                          const [tarballPath] = await fg.glob(['*.tgz'], { cwd: packageInfo.packagePath });

                          if (!tarballPath) {
                            throw Error(`Tarball not found for ${pkg}`);
                          }

                          packageInfo.localTarball = path.join(packageInfo.packagePath, tarballPath);
                          await success.recordSuccess(pkg, 'Pack');
                        },
                      }
                    ], { concurrent: false, exitOnError: true });
                  }
                }
              }), { concurrent: 4, exitOnError: true });
            }
          })));
        }
      }
    ],
    { concurrent: false, exitOnError: true }
  )

  await tasks.run()
};

void main([
], {
  mongodb: "^6.13.0",
  "serverless-plugin-datadog": "latest"
});
