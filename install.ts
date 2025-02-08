import fg from 'fast-glob';
import path from "node:path";
import fs from "node:fs";
import { Listr } from 'listr2'
import { KnownPackages, PackageInfo, resolveKnownPackages } from "./known-packages";
import { exists, execAsync, isRetrying, Tier } from "./utils";

type Step = "Workspace Install" | "Install" | "Install Dev" | "Build" | "Deploy" | "Pack";

const readSuccessfulPackages = async (): Promise<{ [pkg: string]: Set<Step>; }> => {
  try {
    const packagesString = await fs.promises.readFile('successful-packages.json', 'utf-8');
    const packages = JSON.parse(packagesString);

    return Object.entries(packages).reduce<{ [pkg: string]: Set<Step>; }>(
      (acc, [pkg, steps]) => {
        acc[pkg] = new Set(steps as Step[]);
        return acc;
      },
      {}
    );
  } catch {
    return {};
  }
};

const writeSuccessfulPackages = (successfulPackages: { [pkg: string]: Set<Step>; }): Promise<void> => {
  return fs.promises.writeFile('successful-packages.json', JSON.stringify(
    Object.entries(successfulPackages).reduce<{ [pkg: string]: Step[] }>(
      (acc, [pkg, steps]) => {
        acc[pkg] = Array.from(steps);
        return acc;
      },
      {}
    ),
    null,
    2
  ));
};

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

const recordSuccessfulPackage = async (
  successfulPackages: { [pkg: string]: Set<Step>; },
  pkg: string,
  step: Step
): Promise<void> => {
  if (!successfulPackages[pkg]) {
    successfulPackages[pkg] = new Set();
  }
  successfulPackages[pkg].add(step);
  await writeSuccessfulPackages(successfulPackages);
}

const resetPackageSuccess = async (successfulPackages: { [pkg: string]: Set<Step>; }, pkg: string): Promise<void> => {
  delete successfulPackages[pkg];
  await writeSuccessfulPackages(successfulPackages);
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

  const { targetTeirs: result } = [...tiers].reverse().reduce<{ targetTeirs: Tier[]; nextPackages: Set<string>; }>(
    ({ targetTeirs: effectiveTiers, nextPackages }, tier) => {
      const newTier = Object.entries(tier).filter(([pkg]) => nextPackages.has(pkg));
      if (newTier.length === 0) {
        return { targetTeirs: effectiveTiers, nextPackages };
      }
      newTier.forEach(([pkg, dependencies]) => {
        nextPackages.delete(pkg);
        dependencies.forEach((dependency) => nextPackages.add(dependency));
      });
      effectiveTiers.unshift(Object.fromEntries(newTier));

      return { targetTeirs: effectiveTiers, nextPackages };
    },
    {
      targetTeirs: [],
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
  const successfulPackages = await readSuccessfulPackages();

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
        task: ({ tiers }, task): Listr<Context> => {
          return task.newListr(tiers.map((tier, index) => ({
            title: `Tier ${index + 1}`,
            task: (ctx, task) => {
              return task.newListr<Context>(Object.entries(tier).map(([pkg, dependencies]) => ({
                title: `${pkg}`,
                retry: 1,
                task: ({ packages }, task): Listr<Context> => {
                  const packageInfo = packages.get(pkg);
                  if (!packageInfo) {
                    throw Error(`Package ${pkg} not found`);
                  }

                  const localTarballs = getLocalTarballs(dependencies, packages);
                  return task.newListr<Context>([
                    // {
                    //   title: "Rebase",
                    //   task: async () => {
                    //     await execAsync(`git fetch && git reset --hard HEAD && git pull --rebase`, { cwd: packageInfo.packagePath });
                    //     await resetPackageSuccess(successfulPackages, pkg);
                    //   }
                    // },
                    {
                      title: `Clean`,
                      enabled: () => {
                        return !successfulPackages[pkg] || isRetrying(task);
                      },
                      task: async () => {
                        await execAsync(`git reset --hard HEAD && git clean -fdX && rm -f *.tsbuildinfo`, { cwd: packageInfo.packagePath })
                        await resetPackageSuccess(successfulPackages, pkg);
                      }
                    },
                    {
                      title: "Install Workspace Packages",
                      enabled: () => !!packageInfo.workspaceRootPackage,
                      retry: 1,
                      task: async (ctx, task) => {
                        if (successfulPackages[pkg]?.has('Workspace Install')) return;

                        const command = isRetrying(task) ? "clean-install" : "install";
                        const workingDir = packages.get(packageInfo.workspaceRootPackage!)?.packagePath;

                        await execAsync(`npm ${command}`, { cwd: workingDir });

                        await recordSuccessfulPackage(successfulPackages, pkg, 'Workspace Install');
                      },
                    },
                    {
                      title: `Install dependencies`,
                      retry: 1,
                      task: async (ctx, task) => {
                        if (successfulPackages[pkg]?.has('Install')) return;
                        if (isRetrying(task)) {
                          await execAsync(`git clean -fdX && npm clean-install`, { cwd: packageInfo.packagePath })
                        }

                        const externalDependencies = Object.keys(packageInfo.packageJson.dependencies ?? {})
                          .filter((dependency: string) => dependency in externalPackageTargetVersions)
                          .map((dependency) => `${dependency}@${externalPackageTargetVersions[dependency]}`);

                        const command = `npm install ${[...localTarballs, ...externalDependencies].map((dep) => `"${dep}"`).join(' ')}`;

                        await execAsync(command, { cwd: packageInfo.packagePath });
                        await recordSuccessfulPackage(successfulPackages, pkg, 'Install');
                      },
                    },
                    {
                      title: `Install dev dependencies`,
                      retry: 1,
                      task: async (ctx, task) => {
                        if (successfulPackages[pkg]?.has('Install Dev')) return;

                        const externalDependencies = Object.keys(packageInfo.packageJson.devDependencies ?? {})
                          .filter((dependency: string) => dependency in externalPackageTargetVersions)
                          .map((dependency) => `${dependency}@${externalPackageTargetVersions[dependency]}`);

                        if (externalDependencies.length !== 0) {
                          const command = `npm install -D ${externalDependencies.map((dep) => `"${dep}"`).join(' ')}`;
                          await execAsync(command, { cwd: packageInfo.packagePath });
                        }

                        await recordSuccessfulPackage(successfulPackages, pkg, 'Install Dev');
                      },
                    },
                    {
                      title: `Build`,
                      task: async () => {
                        if (successfulPackages[pkg]?.has('Build')) return;

                        const workingDirectory = packageInfo.workspaceRootPackage
                          ? packages.get(packageInfo.workspaceRootPackage)?.packagePath
                          : packageInfo.packagePath;

                        await execAsync(`npm run build`, { cwd: workingDirectory });
                        await recordSuccessfulPackage(successfulPackages, pkg, 'Build');
                      }
                    },
                    {
                      title: `Deploy`,
                      enabled: () => packageInfo.packageType === 'service',
                      retry: 1,
                      task: async () => {
                        if (successfulPackages[pkg]?.has('Deploy')) return;
                        const serverlessPath = resolveServerlessPath(packages, packageInfo);
                        await execAsync(`npm run deploy --ignore-scripts`, { cwd: serverlessPath });
                        await recordSuccessfulPackage(successfulPackages, pkg, 'Deploy');
                      },
                    },
                    {
                      title: `Pack`,
                      enabled: () => packageInfo.packageType === 'library',
                      task: async () => {
                        if (!successfulPackages[pkg]?.has('Pack')) {
                          await execAsync(`npm pack`, { cwd: packageInfo.packagePath });
                        };

                        const [tarballPath] = await fg.glob(['*.tgz'], { cwd: packageInfo.packagePath });

                        if (!tarballPath) {
                          throw Error(`Tarball not found for ${pkg}`);
                        }

                        packageInfo.localTarball = path.join(packageInfo.packagePath, tarballPath);
                        await recordSuccessfulPackage(successfulPackages, pkg, 'Pack');
                      },
                    }
                  ], { concurrent: false, exitOnError: true });
                }
              })), { concurrent: 4, exitOnError: true });
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
