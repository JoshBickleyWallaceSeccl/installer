import { exists } from "./utils";
import path from "node:path";
import fs from "node:fs";
import fg from 'fast-glob';

export interface PackageJson {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
}

type PackageType = 'workspace-root' | 'service' | 'library';

export interface PackageInfo {
  packagePath: string;
  packageJson: PackageJson;
  packageType: PackageType;
  localTarball?: string;
  workspaceRootPackage?: string;
  workspacePackages?: string[];
  defaultBranch: "main" | "master";
  currentBranch: string;
}

const getIsService = (packagePath: string, packageJson: PackageJson): boolean => {
  return exists(path.join(packagePath, 'serverless.ts'))
    || !!packageJson?.scripts?.deploy;
}

export type KnownPackages = Map<string, PackageInfo>;

const resolveDefaultBranch = async (packagePath: string): Promise<"main" | "master"> => {
  const fileContent = await fs.promises.readFile(path.resolve(packagePath, '.git', 'config'), 'utf-8');
  const match = fileContent.match(/\[branch "main"\]/);

  return match ? 'main' : 'master';
}

const resolveCurrentBranch = async (packagePath: string): Promise<string> => {
  const fileContent = await fs.promises.readFile(path.resolve(packagePath, '.git', 'HEAD'), 'utf-8');
  const match = fileContent.trim().match(/^ref: refs\/heads\/(.*)/);

  if (match) {
    return match[1];
  }

  throw new Error('Could not resolve current branch');
}

const getLocalPackageInfo = async (
  knownPackages: KnownPackages,
  {
    absolutePackageJsonPath,
    workspacePackagePath,
    workspaceRootPackage
  }: {
    absolutePackageJsonPath: string;
    workspacePackagePath?: string;
    workspaceRootPackage?: string;
  }
): Promise<PackageInfo> => {
  const packageJson = JSON.parse(await fs.promises.readFile(absolutePackageJsonPath, 'utf-8')) as PackageJson;

  if (knownPackages.has(packageJson.name)) {
    const cachedPackage = knownPackages.get(packageJson.name)!;

    if (workspaceRootPackage) {
      cachedPackage.workspaceRootPackage = workspaceRootPackage;
    }

    return knownPackages.get(packageJson.name)!;
  }

  const packagePath = path.dirname(absolutePackageJsonPath);
  const isService = getIsService(packagePath, packageJson);

  const [defaultBranch, currentBranch] = await Promise.all([
    resolveDefaultBranch(workspacePackagePath ?? packagePath),
    resolveCurrentBranch(workspacePackagePath ?? packagePath)
  ]);

  return {
    packagePath,
    packageJson,
    packageType: isService ? 'service' : 'library',
    defaultBranch,
    currentBranch,
    workspaceRootPackage
  };
}

const resolvePackage = async (
  knownPackages: KnownPackages,
  { packageJsonPath, rootDirectory }: {
    packageJsonPath: string;
    rootDirectory: string;
  }
): Promise<void> => {
  const resolvedPath = path.join(rootDirectory, packageJsonPath);
  const packageInfo = await getLocalPackageInfo(knownPackages, { absolutePackageJsonPath: resolvedPath });

  if (packageInfo.packageJson.workspaces) {
    packageInfo.packageType = 'workspace-root';
    packageInfo.workspacePackages = [];
    for (const workspacePackagePath of packageInfo.packageJson.workspaces ?? []) {
      const workspacePackageJsonPath = path.join(packageInfo.packagePath, workspacePackagePath, 'package.json');
      const childPackageInfo = await getLocalPackageInfo(
        knownPackages,
        {
          absolutePackageJsonPath: workspacePackageJsonPath,
          workspacePackagePath: packageInfo.packagePath,
          workspaceRootPackage: packageInfo.packageJson.name
        }
      )
      knownPackages.set(childPackageInfo.packageJson.name, childPackageInfo);
      packageInfo.workspacePackages.push(childPackageInfo.packageJson.name);
    }
  };
  knownPackages.set(packageInfo.packageJson.name, packageInfo);
}

export const resolveKnownPackages = async (rootDirectory: string): Promise<KnownPackages> => {
  const entries = await fg.glob(['**/package.json'], { cwd: rootDirectory, ignore: ['**/node_modules/**'] });
  const acc = new Map();
  for (const packageJsonPath of entries) {
    await resolvePackage(acc, { packageJsonPath, rootDirectory });
  }
  return acc;
};