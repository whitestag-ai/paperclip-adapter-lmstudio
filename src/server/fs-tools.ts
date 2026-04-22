import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { safePath } from "./path-safety.js";

export interface ToolResult {
  content: string;
  isError: boolean;
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      regex += "(?:.*/)?";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^$(){}|[]\\".includes(c)) {
      regex += "\\" + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

async function* walkFiles(dir: string, relativeFrom: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full, relativeFrom);
    } else if (entry.isFile()) {
      yield path.relative(relativeFrom, full);
    }
  }
}

async function readFileHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path), allowedWriteRoots);
  const content = await readFile(targetPath, "utf-8");

  let lines = content.split("\n");
  const offset = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
  const limit = typeof args.limit === "number" ? args.limit : lines.length;
  lines = lines.slice(offset, offset + limit);

  return { content: lines.join("\n"), isError: false };
}

async function writeFileHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path), allowedWriteRoots);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const content = String(args.content);
  await writeFile(targetPath, content, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  return { content: `File written: ${args.path} (${size} bytes)`, isError: false };
}

async function listDirectoryHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const entries = await readdir(targetPath, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? "/" : "";
    return `${e.name}${suffix}`;
  });
  return { content: lines.join("\n"), isError: false };
}

async function globHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const pattern = String(args.pattern);
  const regex = globToRegex(pattern);
  const matches: string[] = [];
  for await (const entry of walkFiles(basePath, basePath)) {
    const normalised = entry.split(path.sep).join("/");
    if (regex.test(normalised)) {
      matches.push(normalised);
    }
  }
  return { content: matches.join("\n"), isError: false };
}

async function grepHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const pattern = String(args.pattern);
  const globFilter = args.glob ? String(args.glob) : "**/*";
  const regex = new RegExp(pattern);
  const globRegex = globToRegex(globFilter);

  const results: string[] = [];
  for await (const entry of walkFiles(basePath, basePath)) {
    const normalised = entry.split(path.sep).join("/");
    if (!globRegex.test(normalised)) continue;
    const fullPath = safePath(basePath, entry, allowedWriteRoots);
    try {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          results.push(`${normalised}:${i + 1}: ${line}`);
        }
      });
    } catch {
      // Skip unreadable files (binary, permission denied, etc.)
    }
  }

  return { content: results.join("\n") || "(no matches)", isError: false };
}

export async function executeFsTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  allowedWriteRoots: string[] = [],
): Promise<ToolResult> {
  try {
    switch (name) {
      case "fs_read_file": return await readFileHandler(args, cwd, allowedWriteRoots);
      case "fs_write_file": return await writeFileHandler(args, cwd, allowedWriteRoots);
      case "fs_list_directory": return await listDirectoryHandler(args, cwd, allowedWriteRoots);
      case "fs_glob": return await globHandler(args, cwd, allowedWriteRoots);
      case "fs_grep": return await grepHandler(args, cwd, allowedWriteRoots);
      default:
        return { content: `Unknown fs tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
