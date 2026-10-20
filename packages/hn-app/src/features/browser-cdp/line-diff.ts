export type LineDiffRow = { type: "ctx" | "add" | "del"; text: string };

export interface LineDiffResult {
  /** 无任何增删行 */
  equal: boolean;
  added: number;
  removed: number;
  rows: LineDiffRow[];
}

/** 超过该行数放弃逐行 LCS（避免 O(n·m) 内存爆炸），整体标记为删+增 */
const MAX_LCS_LINES = 1200;

function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split(/\r\n|\r|\n/);
  // 结尾换行差异视为一致
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 行级 diff（公共前后缀裁剪 + LCS），用于发布脚本前对比沙箱文件与脚本库最新版本
 */
export function computeLineDiff(
  current: string,
  latest: string,
): LineDiffResult {
  const a = splitLines(current);
  const b = splitLines(latest);

  const rows: LineDiffRow[] = [];
  let added = 0;
  let removed = 0;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) rows.push({ type: "ctx", text: a[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length > 0 || midB.length > 0) {
    if (midA.length > MAX_LCS_LINES || midB.length > MAX_LCS_LINES) {
      for (const text of midA) {
        rows.push({ type: "del", text });
        removed++;
      }
      for (const text of midB) {
        rows.push({ type: "add", text });
        added++;
      }
    } else {
      const n = midA.length;
      const m = midB.length;
      const width = m + 1;
      const dp = new Int32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * width + j] =
            midA[i] === midB[j]
              ? dp[(i + 1) * width + (j + 1)] + 1
              : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (midA[i] === midB[j]) {
          rows.push({ type: "ctx", text: midA[i] });
          i++;
          j++;
        } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
          rows.push({ type: "del", text: midA[i] });
          removed++;
          i++;
        } else {
          rows.push({ type: "add", text: midB[j] });
          added++;
          j++;
        }
      }
      while (i < n) {
        rows.push({ type: "del", text: midA[i] });
        removed++;
        i++;
      }
      while (j < m) {
        rows.push({ type: "add", text: midB[j] });
        added++;
        j++;
      }
    }
  }

  for (let k = endA; k < a.length; k++) rows.push({ type: "ctx", text: a[k] });

  return { equal: added === 0 && removed === 0, added, removed, rows };
}
