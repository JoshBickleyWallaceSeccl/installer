import fs from "node:fs";

interface SuccessCacheState<Step extends string> {
  [pkg: string]: Set<Step>;
}

const readSuccessfulPackages = <Step extends string>(
  fileName: string
): SuccessCacheState<Step> => {
  try {
    const packagesString = fs.readFileSync(fileName, 'utf-8');
    const packages = JSON.parse(packagesString);

    return Object.entries(packages).reduce<SuccessCacheState<Step>>(
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
const writeSuccessfulPackages = <Step extends string>(
  fileName: string,
  successfulPackages: SuccessCacheState<Step>
): Promise<void> => {
  return fs.promises.writeFile(fileName, JSON.stringify(
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

export class SuccessCache<Step extends string> {
  #fileName: string;
  #successes: SuccessCacheState<Step>;

  constructor(fileName: string) {
    this.#fileName = fileName;
    this.#successes = readSuccessfulPackages(fileName)
  }

  public hasSeen(pkg: string): boolean {
    return !!this.#successes[pkg];
  }

  public hasSucceeded(pkg: string, step: Step): boolean {
    return this.#successes[pkg]?.has(step) ?? false;
  }

  public async recordSuccess(
    pkg: string,
    step: Step
  ): Promise<void> {
    if (!this.#successes[pkg]) {
      this.#successes[pkg] = new Set();
    }
    this.#successes[pkg].add(step);
    await writeSuccessfulPackages(this.#fileName, this.#successes);
  }

  public async resetPackageSuccess(pkg: string): Promise<void> {
    delete this.#successes[pkg];
    await writeSuccessfulPackages(this.#fileName, this.#successes);
  };

  public wrapTask<Task extends (...args: any[]) => any>(
    step: Step,
    pkg: string,
    task: Task): (...ars: Parameters<Task>) => Promise<PromiseFulfilledResult<ReturnType<Task>>> {
    return async (...args) => {
      if (this.hasSucceeded(pkg, step)) {
        return;
      }
      const result = await task(...args);
      await this.recordSuccess(pkg, step);
      return result;
    }
  };
}

