import { safePathComponent } from "./sftpEditPath";

/**
 * 批量下载的落点计划。
 *
 * 单文件下载有原生保存框兜着（它会问"已存在要替换吗"），改成"选一次目录、落 N 个文件"之后
 * 那道兜底就没了：文件名由远端目录列表决定，直接拼进本地目录等于让远端决定本地写哪、写掉谁。
 * 所以名字要在这里净化 + 批内去重，覆盖判断交给后端的 `prepare_write_new`。
 */
export interface PlannedDownload {
  /** 远端目录列表里看到的那个名字 */
  remoteName: string;
  /** 真正落到目标目录里用的名字（净化 + 去重后的结果） */
  localName: string;
  /** 净化或去重改过名字 —— 必须告诉用户，否则他会找不到文件 */
  renamed: boolean;
}

/** 远端文件名 → 本地文件名（净化）+ 批内去重：同批次里不允许两个条目落到同一个名字上 */
export function planDownloads(names: readonly string[]): PlannedDownload[] {
  const used = new Set<string>();
  return names.map((remoteName) => {
    let localName = safePathComponent(remoteName);
    if (used.has(localName)) {
      // "a?.txt" 与 "a/.txt" 净化后同名；不加后缀就是后一个把前一个覆盖掉
      const dot = localName.lastIndexOf(".");
      const stem = dot > 0 ? localName.slice(0, dot) : localName;
      const ext = dot > 0 ? localName.slice(dot) : "";
      for (let n = 2; ; n += 1) {
        const candidate = `${stem} (${n})${ext}`;
        if (!used.has(candidate)) {
          localName = candidate;
          break;
        }
      }
    }
    used.add(localName);
    return { remoteName, localName, renamed: localName !== String(remoteName) };
  });
}

/**
 * 目录 + 文件名：目录选择器的返回值形状不唯一（可能带尾斜杠，Windows 上是反斜杠），
 * 直接 `${dir}/${name}` 会拼出 `//`，而本地路径里那份 `//` 之前让落盘闸的报错变得难读。
 */
export function joinDownloadTarget(dir: string, name: string): string {
  const base = dir.replace(/[/\\]+$/, "");
  return `${base}/${name}`;
}

export interface BatchOutcome {
  /** 落盘成功的计划条目 */
  saved: PlannedDownload[];
  /** 本地目录里已经有同名文件，因此没动它 */
  existing: PlannedDownload[];
  /** 传输失败（含后端拒绝） */
  failed: { plan: PlannedDownload; reason: string }[];
}

const NAME_CAP = 6;

function nameList(items: readonly string[]): string {
  if (items.length <= NAME_CAP) return items.join("、");
  return `${items.slice(0, NAME_CAP).join("、")} 等 ${items.length} 个`;
}

/**
 * 一条汇总说清整批结果。逐项弹 toast 会让人不看内容就一路点掉，
 * 但更关键的是：批量下载里"跳过了 3 个已存在的文件"如果不说，人只会以为都下下来了。
 */
export function summarizeBatch(o: BatchOutcome, dir: string): {
  kind: "success" | "warning" | "error";
  text: string;
} {
  const parts: string[] = [];
  if (o.saved.length > 0) {
    const renamed = o.saved.filter((p) => p.renamed);
    parts.push(`已下载 ${o.saved.length} 个文件到 ${dir}`);
    if (renamed.length > 0) {
      parts.push(`其中 ${nameList(renamed.map((p) => `${p.remoteName}→${p.localName}`))} 因文件名不安全已改名`);
    }
  }
  if (o.existing.length > 0) {
    parts.push(`跳过 ${o.existing.length} 个（本地已存在，未覆盖）：${nameList(o.existing.map((p) => p.remoteName))}`);
  }
  if (o.failed.length > 0) {
    parts.push(`失败 ${o.failed.length} 个：${nameList(o.failed.map((p) => `${p.plan.remoteName}: ${p.reason}`))}`);
  }
  const text = parts.join("；");
  if (o.failed.length > 0 && o.saved.length === 0) return { kind: "error", text };
  if (o.failed.length > 0 || o.existing.length > 0) return { kind: "warning", text };
  return { kind: "success", text };
}
