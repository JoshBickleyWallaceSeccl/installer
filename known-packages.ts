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

export interface PackageInfo {
  packagePath: string;
  packageJson: PackageJson;
  isService: boolean;
  localTarball?: string;
  workspaceRootPackage?: string;
  workspacePackages?: string[];
}

const getIsService = (packagePath: string, packageJson: PackageJson): boolean => {
  return exists(path.join(packagePath, 'serverless.ts'))
    || !!packageJson?.scripts?.deploy;
}

export type KnownPackages = Map<string, PackageInfo>;

const getLocalPackageInfo = (
  knownPackages: KnownPackages,
  { absolutePackageJsonPath }: { absolutePackageJsonPath: string; }
): PackageInfo => {
  const packageJson = JSON.parse(fs.readFileSync(absolutePackageJsonPath, 'utf-8')) as PackageJson;
  if (knownPackages.has(packageJson.name)) {
    return knownPackages.get(packageJson.name)!;
  }
  const packagePath = path.dirname(absolutePackageJsonPath);
  const isService = getIsService(packagePath, packageJson);

  return {
    packagePath,
    packageJson,
    isService
  };
}

const resolvePackage = (
  knownPackages: KnownPackages,
  { packageJsonPath, rootDirectory }: {
    packageJsonPath: string;
    rootDirectory: string;
  }
): void => {
  const resolvedPath = path.join(rootDirectory, packageJsonPath);
  const packageInfo = getLocalPackageInfo(knownPackages, { absolutePackageJsonPath: resolvedPath });
  packageInfo.workspacePackages = packageInfo.packageJson.workspaces?.map((workspacePackagePath) => {
    const workspacePackageJsonPath = path.join(packageInfo.packagePath, workspacePackagePath, 'package.json');
    const childPackageInfo = {
      ...getLocalPackageInfo(knownPackages, { absolutePackageJsonPath: workspacePackageJsonPath }),
      workspaceRootPackage: packageInfo.packageJson.name
    };
    knownPackages.set(childPackageInfo.packageJson.name, childPackageInfo);
    return childPackageInfo.packageJson.name;
  });

  knownPackages.set(packageInfo.packageJson.name, packageInfo);
};

export const resolveKnownPackages = async (rootDirectory: string): Promise<KnownPackages> => {
  const entries = await fg.glob(['**/package.json'], { cwd: rootDirectory, ignore: ['**/node_modules/**'] });
  return entries.reduce<KnownPackages>(
    (acc, packageJsonPath) => {
      resolvePackage(acc, { packageJsonPath, rootDirectory });
      return acc;
    },
    new Map()
  );
};