import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { ListrTaskWrapper, DefaultRenderer, SimpleRenderer } from "listr2";
import { Context } from "node:vm";

export const execAsync = promisify(exec);

export const exists = (path: string): boolean => {
  try {
    fs.accessSync(path);
    return true;
  } catch {
    return false;
  }
};

export const isRetrying = (task: ListrTaskWrapper<Context, typeof DefaultRenderer, typeof SimpleRenderer>): boolean => {
  return (task.isRetrying()?.count ?? 0) > 0;
}

export type Tier = { [pkg: string]: string[]; };