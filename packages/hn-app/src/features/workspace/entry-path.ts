/** 取相对路径的父目录（根级文件返回 ""） */
export function parentDirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

/** 拼接 baseDir + 输入名（baseDir 为空时即输入值），用于「新建文件于此」 */
export function joinEntryPath(baseDir: string, name: string): string {
  const base = baseDir.replace(/\/+$/, "");
  const trimmed = name.trim();
  if (!base) return trimmed;
  return `${base}/${trimmed}`;
}

/**
 * 校验新建 / 重命名输入的路径段（相对路径；禁止绝对路径、穿越、空段、`.` / `..`）。
 * 返回错误文案则不通过；返回 undefined 通过。
 */
export function validateEntryName(value: string): string | undefined {
  const v = value.trim();
  if (!v) return "路径不能为空";
  if (v.startsWith("/")) return "请输入相对路径（如 src/new.ts）";
  for (const seg of v.split("/")) {
    if (!seg) return "路径不能含空段";
    if (seg === ".." || seg === ".") return "路径不能含 . 或 ..";
  }
  return undefined;
}
