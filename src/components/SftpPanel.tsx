import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  Table,
  Button,
  Space,
  Input,
  Breadcrumb,
  message,
  Dropdown,
  Progress,
  Modal,
  theme,
  Tag,
  Tooltip,
} from "antd";
import {
  FolderOutlined,
  FileOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  HomeOutlined,
  UploadOutlined,
  DownloadOutlined,
  FolderAddOutlined,
  EditOutlined,
  DeleteOutlined,
  CopyOutlined,
  ExportOutlined,
  SelectOutlined,
  DragOutlined,
  CaretUpOutlined,
  CaretDownOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useServerStore } from "../stores/serverStore";
import type { SftpEntry } from "../types";
import { EmptyState, LoadingState } from "@/_shared";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { subscribeSftpProgress } from "../services/sftpBus";
import {
  applyProgress,
  basenameOf,
  beginTransfer,
  clearFinished,
  createTransferIds,
  describeTransfer,
  formatBytes,
  kindLabel,
  percentOf,
  settleTransfer,
  transferFailure,
  type Transfer,
  type TransferKind,
} from "../utils/sftpTransfer";
import { editLocalPath } from "../utils/sftpEditPath";
import {
  joinDownloadTarget,
  planDownloads,
  summarizeBatch,
  type BatchOutcome,
} from "../utils/sftpDownloadPlan";
import { listingCandidates } from "../utils/sftpListing";
import {
  beginBatch,
  describeBatch,
  finishItem,
  notStartedCount,
  requestCancel,
  startItem,
  type Batch,
  type LiveBytes,
} from "../utils/sftpBatch";
import { pickTabSession } from "../utils/session";

interface SftpPanelProps {
  /**
   * 面板归属的**标签页 id**。旧名叫 `serverId`，但每个调用点传的东西并不一致：工具栏和
   * ⌘⇧E 传的是 tab.id，只有标签页右键菜单传的是真 serverId —— 于是同一份"按 serverId 找标签页"
   * 的查找在两条路上传入恒不匹配的值，面板既列不出目录也做不了任何操作。改叫 tabId 并统一由
   * `pickTabSession` 解析身份，这个参数才只剩一种语义。
   */
  tabId: string;
}

/** 传输结束后进度条停留时长；摘掉时按 id 核对，晚到的定时器不得抹掉下一条传输 */
const TRANSFER_HOLD_MS = 800;

/**
 * 传输进度条。**数字只来自后端 `sftp-progress`**：旧实现是"开局写 0、IPC 返回就写 100"，
 * 那条既不知道文件多大也不知道传了多久，任何一次传输都只会在结束时瞬间满格。
 * 大小取不到时不画条（只显示已传字节 + "大小未知"），宁可少说也不猜一个百分比。
 */
function TransferBanner({
  transfer,
  onCancelTransfer,
}: {
  transfer: Transfer;
  /** 传进来才显示「中断当前」；单条传输与批量进行中的那一条共用这个入口 */
  onCancelTransfer?: () => void;
}) {
  const { token } = theme.useToken();
  const pct = percentOf(transfer);
  const failed = transfer.phase === "failed";
  const done = transfer.phase === "done";
  // 传输卡住时后端不再发事件，"用时"必须自己走：所以运行中每秒重渲染一次，
  // 停在 3 秒不动的"用时"比"没有用时"更容易让人误判成还在正常传。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (transfer.phase !== "running") return;
    const h = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(h);
  }, [transfer.phase]);
  return (
    <div
      style={{
        padding: "4px 12px",
        background: token.colorBgElevated,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ fontSize: 12, color: token.colorTextSecondary, whiteSpace: "nowrap" }}>
        {kindLabel(transfer.kind)}: {transfer.filename}
      </span>
      {pct === null ? (
        <span
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: token.colorFillSecondary,
          }}
        />
      ) : (
        <Progress
          percent={pct}
          size="small"
          style={{ flex: 1, margin: 0 }}
          status={failed ? "exception" : done ? "success" : "active"}
          strokeColor={failed ? token.colorError : done ? token.colorSuccess : token.colorPrimary}
          showInfo={false}
        />
      )}
      <span
        style={{
          fontSize: 12,
          whiteSpace: "nowrap",
          color: failed ? token.colorError : token.colorTextSecondary,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {describeTransfer(transfer, Date.now())}
          {onCancelTransfer && transfer.phase === "running" && (
            <Button
              size="small"
              type="text"
              aria-label="中断当前传输"
              style={{ fontSize: 11, height: 20, padding: "0 4px" }}
              onClick={onCancelTransfer}
            >
              中断当前
            </Button>
          )}
        </span>
      </span>
    </div>
  );
}

interface EditingFile {
  /**
   * 这份副本属于哪个会话。远端路径不是全局唯一的：两台主机上都可以有 `/etc/hosts`，
   * 只按 `remotePath` 认，A 的保存会把内容推到 B、并把两条编辑记录一起标成"已上传"。
   */
  sessionId: string;
  remotePath: string;
  localPath: string;
  filename: string;
  lastModified: number;
  watcher: number | null; // setInterval ID
}

type SortField = "name" | "size" | "modified" | "permissions";
type SortOrder = "asc" | "desc";

/** 列表不属于当前会话时用的常量：每次渲染新建 `[]` 会让下游 useMemo/useCallback 全部过期 */
const NO_ENTRIES: SftpEntry[] = [];

/** 远端文件所在目录：与拼 remotePath 时同一套规则（根目录不重复斜杠） */
function dirnameOf(remotePath: string): string {
  const at = remotePath.lastIndexOf("/");
  return at <= 0 ? "/" : remotePath.slice(0, at);
}

/**
 * 该会话是否还挂在某个标签页/面板上。编辑监听器用它判断"我这份内容还能不能回传"——
 * 不能按"面板当前有没有会话"判断：副本属于开它时的那台主机，跟人后来切到哪没关系。
 */
function isSessionAlive(sessionId: string): boolean {
  const { tabs } = useServerStore.getState();
  return tabs.some(
    (t) => t.sessionId === sessionId || t.panes.some((p) => p.sessionId === sessionId)
  );
}

export default function SftpPanel({ tabId }: SftpPanelProps) {
  const { token } = theme.useToken();
  const {
    sftpEntries: listedEntries,
    sftpPath: listedPath,
    sftpSessionId,
    sftpPathBySession,
    listSftp,
    toggleSftp,
  } = useServerStore();

  // 身份只有一个来源：本标签页的活跃面板，没有则回落该标签页主面板的会话（`pickTabSession`）。
  const activeSessionId = pickTabSession(useServerStore.getState(), tabId);
  // 全局只有一份列表，所以必须连"它属于哪个会话"一起读：归属对不上就当作还没列过。
  // 否则切标签页的一瞬间，旧会话的文件名会配上新会话的 sessionId —— 下载、删除、编辑回传
  // 全变成跨会话写入（P-3），而屏幕上根本看不出换了会话。
  const listingMatches = !!activeSessionId && sftpSessionId === activeSessionId;
  const sftpEntries = listingMatches ? listedEntries : NO_ENTRIES;
  const sftpPath = listingMatches ? listedPath : "/";

  const [pathInput, setPathInput] = useState(sftpPath);
  const [loading, setLoading] = useState(false);
  // 上一次列目录为什么没成：列表空着的原因必须上屏，不能只闪过一条 toast
  const [listError, setListError] = useState<string | null>(null);
  // 整批进度（一批 N 个文件时"第 2/7"与"取消"都挂在这条上）。
  // ref 与 state 同步写：循环里要读的是"此刻有没有人按过取消"，state 那份是渲染快照，会旧。
  const [batch, setBatch] = useState<Batch | null>(null);
  const batchRef = useRef<Batch | null>(null);
  /**
   * 当前这条传输的取消令牌。循环与「中断当前」按钮共享同一个对象：按下去就把
   * `cancelled` 置真，循环结束后据此把这一条分进 aborted 而不是 failed
   * —— "用户取消"和"传失败"在汇总里不是一回事。
   */
  const tokenRef = useRef<{ cancelled: boolean } | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenuEntry, setContextMenuEntry] = useState<SftpEntry | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [editingFiles, setEditingFiles] = useState<EditingFile[]>([]);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [dragDownloadEntry, setDragDownloadEntry] = useState<SftpEntry | null>(null);
  const [dropZoneActive, setDropZoneActive] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  // 编辑监听器的登记表：卸载清理必须走 ref，不能读 editingFiles —— `[]` 依赖的 effect
  // 闭包里那份数组永远是挂载时的空表，后来开的监听器一个都关不掉（3 s 一次 IPC，命中还会往远端上传）。
  const watchersRef = useRef<number[]>([]);
  /**
   * 面板还在不在。批量传输的循环、进度条的收尾定时器都会跨越卸载活下来：
   * 实测旧行为是"关掉面板 → 剩下两个文件照传 → 弹一条没有人看的汇总提示"。
   */
  const aliveRef = useRef(true);

  const cancelCurrentTransfer = useCallback(() => {
    if (!transfer || transfer.phase !== "running") return;
    if (tokenRef.current) tokenRef.current.cancelled = true;
    // "取消剩余"挡后面，"中断当前"停手上这条 —— 两件事，按钮也分开
    void invoke("sftp_cancel_transfer", { transferId: transfer.id });
  }, [transfer]);

  const applyBatch = useCallback((next: Batch | null) => {
    batchRef.current = next;
    setBatch(next);
  }, []);

  const stopWatching = useCallback((id: number) => {
    clearInterval(id);
    // 原地增删：卸载清理捕获的是同一个数组对象，换成 filter 后的新数组它就过期了
    const at = watchersRef.current.indexOf(id);
    if (at >= 0) watchersRef.current.splice(at, 1);
  }, []);

  useEffect(() => {
    const watchers = watchersRef.current;
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      watchers.forEach((id) => clearInterval(id));
      watchers.length = 0;
      // 卸载 = 用户不要这批了：剩下没开始的不再开始（正在传的那条后端没给中断手段，只能让它传完）
      if (batchRef.current) batchRef.current = requestCancel(batchRef.current);
    };
  }, []);

  useEffect(() => {
    setPathInput(sftpPath);
  }, [sftpPath, activeSessionId]);

  // Clear selection when directory changes
  // 会话换了也要清：两个会话可以停在同一个 `/`，只按 `sftpPath` 判断就选不中"换了主机"这件事，
  // 上一台勾的名字会跟着面板一起留在选中集合里。
  useEffect(() => {
    setSelectedEntries(new Set());
    setLastClickedName(null);
    setFocusedIndex(-1);
    setListError(null);
  }, [sftpPath, activeSessionId]);

  // 动作发生那一刻再取一次身份：渲染到点击之间人可能已经切了标签页/面板，
  // 用渲染期的 `activeSessionId` 会把上一条操作发到一个已经不显示的会话上。
  const getSessionId = useCallback(() => pickTabSession(useServerStore.getState(), tabId), [tabId]);

  // 整批的百分比/约剩由"已完成条目 + 当前条目实时字节"推出 ⇒ 卡住时这一行也得自己走
  const [, setBatchTick] = useState(0);
  useEffect(() => {
    if (!batch) return;
    const h = window.setInterval(() => setBatchTick((n) => n + 1), 1000);
    return () => window.clearInterval(h);
  }, [batch]);
  const live: LiveBytes | null =
    transfer && batch?.current
      ? {
          kind: transfer.kind,
          filename: transfer.filename,
          running: transfer.phase === "running",
          transferred: transfer.transferred,
        }
      : null;
  // 单条传输时 describeBatch 给 null：一条文件写"第 1/1 个"是没有信息量的噪声
  const batchText = describeBatch(batch, live, Date.now());

  const nextTransferId = useRef(createTransferIds()).current;

  // 编辑条目属于哪台主机：副本列表跨标签页存活，切走后条上的文件名若不带主机名，
  // 人会把"另一台会话的编辑中"当成眼前这一台的。
  const hostOf = useCallback((sessionId: string) => {
    const { tabs, servers } = useServerStore.getState();
    const tab = tabs.find(
      (t) => t.sessionId === sessionId || t.panes.some((p) => p.sessionId === sessionId)
    );
    return tab ? servers.find((s) => s.id === tab.serverId)?.name : undefined;
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    return subscribeSftpProgress(activeSessionId, (ev) => {
      setTransfer((prev) => applyProgress(prev, ev));
    });
  }, [activeSessionId]);

  /**
   * 执行一次传输：进度只来自后端 `sftp-progress`，成功/失败只来自命令返回的 `success`
   * （后端失败不 reject，只回 `{success:false,error}`，不读它就会把断线、只读目录报成"上传成功"）。
   * `transferId` 交给调用方塞进 IPC 参数，后端原样回带，前端凭它认领进度。
   * 返回 null 表示成功，否则返回可直接上屏的失败原因。
   */
  const runTransfer = useCallback(
    async (
      kind: TransferKind,
      filename: string,
      sessionId: string,
      call: (transferId: number) => Promise<unknown>,
      // 必传（不给默认值）：漏传不会静默把"用户中断"报成"传输失败"，而是直接编译不过
      token: { cancelled: boolean }
    ): Promise<string | null> => {
      const id = nextTransferId();
      tokenRef.current = token;
      setTransfer(beginTransfer(id, sessionId, kind, filename, Date.now()));
      let error: string | null = null;
      try {
        error = transferFailure(await call(id));
      } catch (e) {
        error = String(e);
      }
      setTransfer((prev) =>
        settleTransfer(prev, id, error === null, error ?? undefined, Date.now())
      );
      if (tokenRef.current === token) tokenRef.current = null;
      window.setTimeout(() => {
        if (!aliveRef.current) return;
        setTransfer((prev) => clearFinished(prev, id));
      }, TRANSFER_HOLD_MS);
      return error;
    },
    [nextTransferId]
  );

  // ---- Sorting ----

  const sortedEntries = useMemo(() => {
    const sorted = [...sftpEntries];
    sorted.sort((a, b) => {
      // Directories always first
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = a.size - b.size;
          break;
        case "modified":
          cmp = (a.modified || "").localeCompare(b.modified || "");
          break;
        case "permissions":
          cmp = (a.permissions || "").localeCompare(b.permissions || "");
          break;
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [sftpEntries, sortField, sortOrder]);

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortOrder("asc");
      }
    },
    [sortField]
  );

  // ---- Navigation ----

  const navigateTo = useCallback(
    async (path: string) => {
      // 取不到会话就如实说"会话未连接"：旧写法把身份传错、抛出来的异常被调用方 `.catch(() => {})`
      // 吞掉，人只看到列表永远是空的。
      const sessionId = getSessionId();
      if (!sessionId) {
        setPathInput(sftpPath);
        message.error("会话未连接，无法打开 SFTP 文件浏览器");
        return false;
      }
      setLoading(true);
      try {
        await listSftp(sessionId, path);
        setListError(null);
        return true;
      } catch (e) {
        // 路径没列成，输入框不能停在列不上去的那一级（否则显示的是没生效的地址）
        setPathInput(sftpPath);
        const reason = String(e);
        setListError(reason);
        message.error(`获取文件列表失败: ${reason}`);
        return false;
      } finally {
        setLoading(false);
      }
    },
    [getSessionId, listSftp, sftpPath]
  );

  // 打开面板/切标签页时自己把列表对齐到本会话：旧实现从不主动列目录，全靠调用方在别处
  // 顺手 `listSftp`，而那些调用传的是错的 id —— 面板于是永远空着。
  // 每个会话回到自己上次浏览的那一级（`sftpPathBySession`）；那一级已经被删掉时退回根，
  // 不然一次失败提示闪过之后面板就只剩空白，人不知道还能不能用。
  useEffect(() => {
    if (!activeSessionId || listingMatches) return;
    void (async () => {
      for (const p of listingCandidates(sftpPathBySession[activeSessionId])) {
        if (await navigateTo(p)) break;
      }
    })();
  }, [activeSessionId, listingMatches, navigateTo, sftpPathBySession]);

  const handleEntryClick = useCallback(
    (entry: SftpEntry, e?: React.MouseEvent) => {
      const entryName = entry.name;

      // Shift+Click: range select
      if (e?.shiftKey && lastClickedName) {
        const names = sortedEntries.map((en) => en.name);
        const lastIdx = names.indexOf(lastClickedName);
        const curIdx = names.indexOf(entryName);
        if (lastIdx >= 0 && curIdx >= 0) {
          const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
          const rangeNames = names.slice(from, to + 1);
          setSelectedEntries((prev) => {
            const next = new Set(prev);
            rangeNames.forEach((n) => next.add(n));
            return next;
          });
        }
        setLastClickedName(entryName);
        return;
      }

      // Ctrl/Cmd+Click: toggle select
      if (e?.ctrlKey || e?.metaKey) {
        setSelectedEntries((prev) => {
          const next = new Set(prev);
          if (next.has(entryName)) {
            next.delete(entryName);
          } else {
            next.add(entryName);
          }
          return next;
        });
        setLastClickedName(entryName);
        return;
      }

      // Normal click: single select or navigate
      if (entry.is_dir) {
        const newPath = sftpPath.endsWith("/")
          ? sftpPath + entry.name
          : sftpPath + "/" + entry.name;
        navigateTo(newPath);
      } else {
        setSelectedEntries(new Set([entryName]));
      }
      setLastClickedName(entryName);
    },
    [sftpPath, navigateTo, sortedEntries, lastClickedName]
  );

  const handleSelectAll = useCallback(() => {
    const allNames = sortedEntries.map((e) => e.name);
    if (selectedEntries.size === allNames.length && allNames.length > 0) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(allNames));
    }
  }, [sortedEntries, selectedEntries.size]);

  const handleGoUp = useCallback(() => {
    const parts = sftpPath.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    navigateTo(parent || "/");
  }, [sftpPath, navigateTo]);

  const handleGoHome = useCallback(() => {
    navigateTo("/");
  }, [navigateTo]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // If focus is on the path input, only handle Enter
      if ((e.target as HTMLElement).tagName === "INPUT") {
        if (e.key === "Enter") {
          navigateTo(pathInput);
        }
        return;
      }

      const total = sortedEntries.length;
      if (total === 0) return;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev <= 0 ? 0 : prev - 1;
            const name = sortedEntries[next]?.name;
            if (name && !e.shiftKey) {
              setSelectedEntries(new Set([name]));
            } else if (name && e.shiftKey) {
              setSelectedEntries((prevSet) => {
                const s = new Set(prevSet);
                s.add(name);
                return s;
              });
            }
            return next;
          });
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          setFocusedIndex((prev) => {
            const next = prev >= total - 1 ? total - 1 : prev + 1;
            const name = sortedEntries[next]?.name;
            if (name && !e.shiftKey) {
              setSelectedEntries(new Set([name]));
            } else if (name && e.shiftKey) {
              setSelectedEntries((prevSet) => {
                const s = new Set(prevSet);
                s.add(name);
                return s;
              });
            }
            return next;
          });
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < total) {
            const entry = sortedEntries[focusedIndex];
            if (entry) handleOpen(entry);
          }
          break;
        }
        case "Delete": {
          e.preventDefault();
          if (selectedEntries.size > 0) {
            handleBatchDelete();
          }
          break;
        }
        case "Backspace": {
          e.preventDefault();
          handleGoUp();
          break;
        }
        case "a": {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleSelectAll();
          }
          break;
        }
      }
    },
    [
      pathInput,
      navigateTo,
      sortedEntries,
      focusedIndex,
      selectedEntries.size,
      handleSelectAll,
      handleGoUp,
    ]
  );

  // ---- File operations ----

  const handleUpload = useCallback(
    async (localPaths?: string[]) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        message.error("会话未连接");
        return;
      }

      let filePaths = localPaths;
      if (!filePaths || filePaths.length === 0) {
        const selected = await open({
          multiple: true,
          title: "选择要上传的文件",
        });
        if (!selected) return;
        filePaths = Array.isArray(selected) ? selected : [selected];
      }

      // 落点名照样要过一遍净化 + 批内去重：`~/a/x.txt` 与 `~/b/x.txt` 选进同一批时，
      // 旧写法两个都报「上传成功」，实际后一个把前一个覆盖掉了。
      const plans = planDownloads(filePaths.map(basenameOf));
      const outcome: BatchOutcome = {
        saved: [],
        existing: [],
        failed: [],
        notStarted: [],
        aborted: [],
      };
      applyBatch(beginBatch("upload", plans.length));
      for (const [i, plan] of plans.entries()) {
        if (!aliveRef.current) return;
        const localPath = filePaths[i];
        const cur = batchRef.current;
        if (cur?.cancelled) {
          outcome.notStarted!.push(plan);
          continue;
        }
        applyBatch(startItem(cur!, plan.remoteName));
        const remotePath = sftpPath.endsWith("/")
          ? sftpPath + plan.localName
          : sftpPath + "/" + plan.localName;
        const token = { cancelled: false };
        const error = await runTransfer(
          "upload",
          plan.remoteName,
          sessionId,
          (transferId) => invoke("sftp_upload", { sessionId, localPath, remotePath, transferId }),
          token
        );
        if (error === null) outcome.saved.push(plan);
        else if (token.cancelled) outcome.aborted!.push(plan);
        else outcome.failed.push({ plan, reason: error });
        applyBatch(finishItem(batchRef.current!));
      }
      if (!aliveRef.current) return;
      const done = batchRef.current;
      applyBatch(null);
      // 单个文件不刷屏（一条汇总对单条来说反而罗嗦），保持原来的一句式反馈
      if (plans.length === 1 && !done?.cancelled && (outcome.aborted?.length ?? 0) === 0) {
        const only = outcome.failed[0];
        if (only) message.error(`上传失败: ${only.plan.remoteName}: ${only.reason}`);
        else message.success(`上传成功: ${plans[0].remoteName}`);
      } else {
        const summary = summarizeBatch({ ...outcome, existing: [] }, sftpPath, "上传");
        if (summary.kind === "success") message.success(summary.text);
        else message.warning(summary.text);
      }
      if (aliveRef.current) navigateTo(sftpPath);
    },
    [sftpPath, getSessionId, navigateTo, runTransfer, applyBatch]
  );

  const handleDownload = useCallback(
    async (entry?: SftpEntry) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        message.error("会话未连接");
        return;
      }

      const target = entry;
      if (!target || target.is_dir) {
        message.warning("请选择一个文件进行下载");
        return;
      }

      const remotePath = sftpPath.endsWith("/")
        ? sftpPath + target.name
        : sftpPath + "/" + target.name;

      const localPath = await save({
        defaultPath: target.name,
        title: "保存文件到",
      });
      if (!localPath) return;

      const token = { cancelled: false };
      const error = await runTransfer(
        "download",
        target.name,
        sessionId,
        (transferId) =>
          // overwrite:true = 覆盖的决定已经由原生保存框问过了（它会就"替换吗"单独确认），
          // 这里不再让后端重复拦一道；批量那条路径没有这道框，所以传的是 false。
          invoke("sftp_download", {
            sessionId,
            remotePath,
            localPath,
            transferId,
            overwrite: true,
          }),
        token
      );
      if (error === null) message.success(`下载成功: ${target.name}`);
      // 用户按的"中断"不能报成"失败"：分片已经丢掉，目标文件根本没被写过
      else if (token.cancelled) message.warning(`已中断下载: ${target.name}（半截分片已丢弃）`);
      else message.error(`下载失败: ${target.name}: ${error}`);
    },
    [sftpPath, getSessionId, runTransfer]
  );

  // ---- Batch operations ----

  const handleBatchDownload = useCallback(async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("会话未连接");
      return;
    }

    const selectedNames = Array.from(selectedEntries);
    const entries = selectedNames
      .map((name) => sortedEntries.find((e) => e.name === name))
      .filter((e): e is SftpEntry => !!e);

    const dirs = entries.filter((e) => e.is_dir);
    const files = entries.filter((e) => !e.is_dir);

    if (dirs.length > 0) {
      message.warning(
        `跳过 ${dirs.length} 个目录（不支持下载目录）: ${dirs.map((d) => d.name).join(", ")}`
      );
    }

    if (files.length === 0) {
      message.warning("没有可下载的文件");
      return;
    }

    // 一次问清整批：旧写法对每个文件弹一次原生保存框，选 10 个文件就要点 10 次对话框，
    // 而中途取消只表现为"少下了几个"，屏幕上没有任何解释。
    const dir = await open({
      directory: true,
      title: `下载 ${files.length} 个文件到目录`,
    });
    if (!dir) return;
    const targetDir = String(dir);

    const outcome: BatchOutcome = {
      saved: [],
      existing: [],
      failed: [],
      notStarted: [],
      aborted: [],
    };
    const plans = planDownloads(files.map((e) => e.name));
    // 只要有一条大小未知（远端 ls 没给、或给的是 -1/NaN），整批就不给百分比 ——
    // 拿"知道的那几条"加总当总数，会画出一个偏小的假进度
    const sizes = files.map((e) => e.size);
    const allSizesKnown = sizes.every((n) => Number.isFinite(n) && n >= 0);
    const bytesTotal = allSizesKnown ? sizes.reduce((a, n) => a + n, 0) : 0;
    applyBatch(beginBatch("download", plans.length, { bytesTotal, startedAt: Date.now() }));
    for (const plan of plans) {
      if (!aliveRef.current) return; // 面板已关：整批就地收手，也不再弹提示
      const cur = batchRef.current;
      if (cur?.cancelled) {
        outcome.notStarted!.push(plan);
        continue;
      }
      const entry = files.find((e) => e.name === plan.remoteName);
      applyBatch(startItem(cur!, plan.remoteName, entry?.size));
      if (!entry) {
        // 条目在点选之后被别的操作刷掉了：这一条按 0 字节过账，不能拿别处的 size 顶
        applyBatch(finishItem(batchRef.current!));
        outcome.failed.push({ plan, reason: "该项已不在列表里" });
        continue;
      }
      const remotePath = sftpPath.endsWith("/")
        ? sftpPath + entry.name
        : sftpPath + "/" + entry.name;
      const localPath = joinDownloadTarget(targetDir, plan.localName);
      const token = { cancelled: false };

      // 探测只为把"跳过"说清楚；真正的不覆盖兜底在后端（prepare_write_new），
      // 因为探测与写入之间文件可能刚被别的东西建出来。
      const already = await invoke<{ modified: number }>("get_file_modified_time", {
        path: localPath,
      })
        .then(() => true)
        .catch(() => false);
      if (already) {
        outcome.existing.push(plan);
        applyBatch(finishItem(batchRef.current!));
        continue;
      }

      const error = await runTransfer(
        "download",
        plan.remoteName,
        sessionId,
        (transferId) =>
          invoke("sftp_download", {
            sessionId,
            remotePath,
            localPath,
            transferId,
            overwrite: false,
          }),
        token
      );
      if (error === null) outcome.saved.push(plan);
      else if (token.cancelled) outcome.aborted!.push(plan);
      else outcome.failed.push({ plan, reason: error });
      applyBatch(finishItem(batchRef.current!));
    }
    if (!aliveRef.current) return;
    applyBatch(null);

    const summary = summarizeBatch(outcome, targetDir);
    if (summary.kind === "success") message.success(summary.text);
    else if (summary.kind === "warning") message.warning(summary.text);
    else message.error(summary.text);
  }, [sftpPath, selectedEntries, sortedEntries, getSessionId, runTransfer, applyBatch]);

  const handleBatchDelete = useCallback(() => {
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("会话未连接");
      return;
    }

    const selectedNames = Array.from(selectedEntries);
    if (selectedNames.length === 0) return;

    const entries = selectedNames
      .map((name) => sortedEntries.find((e) => e.name === name))
      .filter((e): e is SftpEntry => !!e);

    const dirCount = entries.filter((e) => e.is_dir).length;

    let contentText = `确定要删除选中的 ${entries.length} 项吗？`;
    if (dirCount > 0) {
      contentText += `（包含 ${dirCount} 个目录，将递归删除）`;
    }

    Modal.confirm({
      title: "批量删除确认",
      content: (
        <div>
          <p>{contentText}</p>
          <div
            style={{
              maxHeight: 120,
              overflow: "auto",
              fontSize: 12,
              color: token.colorTextSecondary,
            }}
          >
            {entries.map((e) => (
              <div key={e.name}>
                {e.is_dir ? "📁 " : "📄 "}
                {e.name}
              </div>
            ))}
          </div>
        </div>
      ),
      okText: `删除 ${entries.length} 项`,
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        let successCount = 0;
        let failCount = 0;
        for (const entry of entries) {
          const remotePath = sftpPath.endsWith("/")
            ? sftpPath + entry.name
            : sftpPath + "/" + entry.name;
          try {
            await invoke("sftp_remove", { sessionId, path: remotePath });
            successCount++;
          } catch (e) {
            failCount++;
            message.error(`删除失败: ${entry.name}: ${String(e)}`);
          }
        }
        if (successCount > 0) {
          message.success(
            `成功删除 ${successCount} 项${failCount > 0 ? `，${failCount} 项失败` : ""}`
          );
        }
        setSelectedEntries(new Set());
        navigateTo(sftpPath);
      },
    });
  }, [
    sftpPath,
    selectedEntries,
    sortedEntries,
    getSessionId,
    navigateTo,
    token.colorTextSecondary,
  ]);

  const handleBatchCopyPath = useCallback(async () => {
    const selectedNames = Array.from(selectedEntries);
    const paths = selectedNames.map((name) =>
      sftpPath.endsWith("/") ? sftpPath + name : sftpPath + "/" + name
    );
    const text = paths.join("\n");
    try {
      await writeText(text);
      message.success(`已复制 ${paths.length} 个路径到剪贴板`);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        message.success(`已复制 ${paths.length} 个路径到剪贴板`);
      } catch {
        message.error("复制路径失败");
      }
    }
  }, [sftpPath, selectedEntries]);

  // ---- Remote file editing ----

  const handleEditFile = useCallback(
    async (entry: SftpEntry) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        message.error("会话未连接");
        return;
      }

      if (entry.is_dir) {
        message.warning("不能编辑目录");
        return;
      }

      const remotePath = sftpPath.endsWith("/")
        ? sftpPath + entry.name
        : sftpPath + "/" + entry.name;

      const alreadyEditing = editingFiles.some(
        (f) => f.sessionId === sessionId && f.remotePath === remotePath
      );
      if (alreadyEditing) {
        message.info(`${entry.name} 已在编辑中`);
        return;
      }

      try {
        const tempDir = await invoke<string>("get_temp_dir");
        // 目录名里那份身份不能少：远端文件名可控，且同名不同路径的两份副本会互相顶掉
        const localPath = editLocalPath(tempDir, sessionId, remotePath, entry.name);

        const pulled = await runTransfer(
          "download",
          entry.name,
          sessionId,
          (transferId) => invoke("sftp_download", { sessionId, remotePath, localPath, transferId }),
          // 编辑拉取不提供中断：半截副本会直接被下一次拉取覆盖，没有"冒充完成"的风险
          { cancelled: false }
        );
        // 拉不下来就别打开编辑器：编辑一份不存在（或是上一次残留）的本地文件，
        // 保存回去会覆盖远端内容
        if (pulled !== null) {
          message.error(`编辑文件失败: ${entry.name}: ${pulled}`);
          return;
        }

        const statResult = await invoke<{ modified: number }>("get_file_modified_time", {
          path: localPath,
        }).catch(() => ({ modified: Date.now() }));
        const lastModified = statResult.modified || Date.now();

        await invoke("open_file_with_default_app", { path: localPath });
        message.success(`已打开 ${entry.name} 进行编辑`);

        // 比较基准要能被监听器自己推进：过去它比的是闭包里那个 const `lastModified`，
        // 而"成功后推进"只写进了 React 状态那份（监听器从不读回来），于是本地保存一次之后
        // 每一轮都判定"有新内容" —— 同一个文件被反复推回远端（实测 13 s 内 8 次上传 + 8 条成功提示）。
        let pushedModified = lastModified;
        // 一次上传可能比 3 s 的轮询间隔还久：不挡住下一轮的话，同一份内容会被并发推两遍
        let pushing = false;

        const watcherId = window.setInterval(async () => {
          if (pushing) return;
          try {
            const currentStat = await invoke<{ modified: number }>("get_file_modified_time", {
              path: localPath,
            }).catch(() => ({ modified: 0 }));
            if (!currentStat.modified || currentStat.modified <= pushedModified) return;
            pushing = true;
            try {
              // 回传只用**开编辑时那份**会话：这里过去读的是"面板当前"的会话，
              // 而人完全可能在保存之前切走标签页 —— 本地这份 A 主机的内容会被推成 B 主机的同名路径。
              if (!isSessionAlive(sessionId)) {
                stopWatching(watcherId);
                message.warning(`${entry.name} 的编辑监听已停止：该会话已断开，改动不会自动回传`);
                return;
              }
              const pushed = await runTransfer(
                "upload",
                entry.name,
                sessionId,
                (transferId) =>
                  invoke("sftp_upload", { sessionId, localPath, remotePath, transferId }),
                // 自动回传不提供中断：这条是监听器代发的一次性上传，中断它只会让远端停在旧内容
                { cancelled: false }
              );
              // 失败不能推进基准：推进了就再也不会重试，远端却还拿着旧内容
              if (pushed !== null) {
                message.error(`自动上传失败: ${entry.name}: ${pushed}`);
                return;
              }
              pushedModified = currentStat.modified;
              message.success(`${entry.name} 已自动上传更新`);
              setEditingFiles((prev) =>
                prev.map((f) =>
                  f.sessionId === sessionId && f.remotePath === remotePath
                    ? { ...f, lastModified: currentStat.modified }
                    : f
                )
              );
              // 刷新只针对"人此刻正看着的那一份列表"：按 store 现值核对，不经过闭包里的
              // navigateTo/getSessionId —— 那两个是开编辑那一次渲染的，切了标签页之后它们
              // 仍指向旧标签页，结果是把旧会话的列表又列了一遍，顺手把正在看的这台顶回根目录
              // （实测：一次自动上传引发 sess-2 → sess-1 → sess-2 三次列目录 + 面板闪一下）。
              const shown = useServerStore.getState();
              if (shown.sftpSessionId === sessionId && shown.sftpPath === dirnameOf(remotePath)) {
                await listSftp(sessionId, shown.sftpPath).catch((e) => {
                  message.error(`刷新列表失败: ${String(e)}`);
                });
              }
            } finally {
              pushing = false;
            }
          } catch {
            // File might have been deleted or is temporarily unavailable during save
          }
        }, 3000) as unknown as number;

        const editEntry: EditingFile = {
          sessionId,
          remotePath,
          localPath,
          filename: entry.name,
          lastModified,
          watcher: watcherId,
        };
        watchersRef.current.push(watcherId);
        setEditingFiles((prev) => [...prev, editEntry]);
      } catch (e) {
        message.error(`编辑文件失败: ${String(e)}`);
      }
    },
    [sftpPath, getSessionId, editingFiles, listSftp, stopWatching, runTransfer]
  );

  // 卸载清理见 watchersRef 那个 effect

  const handleOpen = useCallback(
    (entry: SftpEntry) => {
      if (entry.is_dir) {
        const newPath = sftpPath.endsWith("/")
          ? sftpPath + entry.name
          : sftpPath + "/" + entry.name;
        navigateTo(newPath);
      } else {
        handleEditFile(entry);
      }
    },
    [sftpPath, navigateTo, handleEditFile]
  );

  const handleNewFolder = useCallback(async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("会话未连接");
      return;
    }

    let folderName = "";
    Modal.confirm({
      title: "新建文件夹",
      content: (
        <Input
          placeholder="请输入文件夹名称"
          onChange={(e) => {
            folderName = e.target.value;
          }}
          autoFocus
        />
      ),
      onOk: async () => {
        if (!folderName.trim()) {
          message.warning("文件夹名称不能为空");
          return Promise.reject();
        }
        const newPath = sftpPath.endsWith("/")
          ? sftpPath + folderName.trim()
          : sftpPath + "/" + folderName.trim();
        try {
          await invoke("sftp_mkdir", { sessionId, path: newPath });
          message.success(`创建文件夹成功: ${folderName.trim()}`);
          navigateTo(sftpPath);
        } catch (e) {
          message.error(`创建文件夹失败: ${String(e)}`);
        }
      },
    });
  }, [sftpPath, getSessionId, navigateTo]);

  const handleRename = useCallback(
    async (entry: SftpEntry) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        message.error("会话未连接");
        return;
      }

      let newName = entry.name;
      Modal.confirm({
        title: "重命名",
        content: (
          <Input
            defaultValue={entry.name}
            onChange={(e) => {
              newName = e.target.value;
            }}
            autoFocus
          />
        ),
        onOk: async () => {
          if (!newName.trim() || newName.trim() === entry.name) {
            if (!newName.trim()) {
              message.warning("名称不能为空");
              return Promise.reject();
            }
            return;
          }
          const oldPath = sftpPath.endsWith("/")
            ? sftpPath + entry.name
            : sftpPath + "/" + entry.name;
          const newPath = sftpPath.endsWith("/")
            ? sftpPath + newName.trim()
            : sftpPath + "/" + newName.trim();
          try {
            await invoke("sftp_rename", { sessionId, oldPath, newPath });
            message.success(`重命名成功: ${entry.name} → ${newName.trim()}`);
            navigateTo(sftpPath);
          } catch (e) {
            message.error(`重命名失败: ${String(e)}`);
          }
        },
      });
    },
    [sftpPath, getSessionId, navigateTo]
  );

  const handleDelete = useCallback(
    async (entry: SftpEntry) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        message.error("会话未连接");
        return;
      }

      Modal.confirm({
        title: "确认删除",
        content: `确定要删除 "${entry.name}" 吗？${entry.is_dir ? "该操作将递归删除文件夹内所有内容。" : ""}`,
        okText: "删除",
        okType: "danger",
        cancelText: "取消",
        onOk: async () => {
          const remotePath = sftpPath.endsWith("/")
            ? sftpPath + entry.name
            : sftpPath + "/" + entry.name;
          try {
            await invoke("sftp_remove", { sessionId, path: remotePath });
            message.success(`删除成功: ${entry.name}`);
            setSelectedEntries((prev) => {
              const next = new Set(prev);
              next.delete(entry.name);
              return next;
            });
            navigateTo(sftpPath);
          } catch (e) {
            message.error(`删除失败: ${String(e)}`);
          }
        },
      });
    },
    [sftpPath, getSessionId, navigateTo]
  );

  const handleCopyPath = useCallback(
    async (entry: SftpEntry) => {
      const fullPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
      try {
        await writeText(fullPath);
        message.success(`已复制路径: ${fullPath}`);
      } catch {
        try {
          await navigator.clipboard.writeText(fullPath);
          message.success(`已复制路径: ${fullPath}`);
        } catch {
          message.error("复制路径失败");
        }
      }
    },
    [sftpPath]
  );

  // ---- Context menu ----

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: SftpEntry) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenuEntry(entry);
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      // If the right-clicked entry is not in the selection, select only it
      if (!selectedEntries.has(entry.name)) {
        setSelectedEntries(new Set([entry.name]));
      }
    },
    [selectedEntries]
  );

  const getContextMenuItems = useCallback((): MenuProps["items"] => {
    if (!contextMenuEntry) return [];
    const entry = contextMenuEntry;
    const isMultiSelected = selectedEntries.size > 1 && selectedEntries.has(entry.name);

    if (isMultiSelected) {
      return [
        {
          key: "batchDownload",
          icon: <DownloadOutlined />,
          label: `批量下载 (${selectedEntries.size} 项)`,
          onClick: () => handleBatchDownload(),
        },
        {
          key: "batchCopyPath",
          icon: <CopyOutlined />,
          label: `批量复制路径 (${selectedEntries.size} 项)`,
          onClick: () => handleBatchCopyPath(),
        },
        { type: "divider" as const },
        {
          key: "batchDelete",
          icon: <DeleteOutlined />,
          label: `批量删除 (${selectedEntries.size} 项)`,
          danger: true,
          onClick: () => handleBatchDelete(),
        },
      ];
    }

    return [
      {
        key: "open",
        icon: <ExportOutlined />,
        label: entry.is_dir ? "打开" : "下载",
        onClick: () => handleOpen(entry),
      },
      ...(entry.is_dir
        ? []
        : [
            {
              key: "edit",
              icon: <EditOutlined />,
              label: "编辑",
              onClick: () => handleEditFile(entry),
            },
            {
              key: "download",
              icon: <DownloadOutlined />,
              label: "下载...",
              onClick: () => handleDownload(entry),
            },
          ]),
      { type: "divider" as const },
      {
        key: "rename",
        icon: <EditOutlined />,
        label: "重命名",
        onClick: () => handleRename(entry),
      },
      {
        key: "delete",
        icon: <DeleteOutlined />,
        label: "删除",
        danger: true,
        onClick: () => handleDelete(entry),
      },
      { type: "divider" as const },
      {
        key: "copyPath",
        icon: <CopyOutlined />,
        label: "复制路径",
        onClick: () => handleCopyPath(entry),
      },
    ];
  }, [
    contextMenuEntry,
    selectedEntries,
    handleOpen,
    handleDownload,
    handleEditFile,
    handleRename,
    handleDelete,
    handleCopyPath,
    handleBatchDownload,
    handleBatchCopyPath,
    handleBatchDelete,
  ]);

  // ---- Drag and drop (upload) ----

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      const filePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string };
        if (file.path) {
          filePaths.push(file.path);
        }
      }

      if (filePaths.length > 0) {
        await handleUpload(filePaths);
      } else {
        message.info("拖拽上传需要 Tauri 环境，请使用工具栏上传按钮");
      }
    },
    [handleUpload]
  );

  // ---- Drag to download ----

  const handleRowDragStart = useCallback((e: React.DragEvent, entry: SftpEntry) => {
    setDragDownloadEntry(entry);
    // Set transfer data for the drag
    e.dataTransfer.setData("text/plain", entry.name);
    e.dataTransfer.effectAllowed = "copy";
    // Add a drag image
    const dragEl = document.createElement("div");
    dragEl.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;padding:4px 12px;background:#1677ff;color:#fff;border-radius:4px;font-size:12px;white-space:nowrap;";
    dragEl.textContent = entry.is_dir ? `📁 ${entry.name}` : `📄 ${entry.name}`;
    document.body.appendChild(dragEl);
    e.dataTransfer.setDragImage(dragEl, 0, 0);
    // Clean up after a tick
    requestAnimationFrame(() => document.body.removeChild(dragEl));
  }, []);

  const handleRowDragEnd = useCallback(() => {
    // If the drag ended outside the app (dropZone wasn't activated), we can't detect
    // desktop drops in Tauri webview. The drop zone at the bottom is the primary mechanism.
    setDragDownloadEntry(null);
    setDropZoneActive(false);
  }, []);

  const handleDropZoneDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDropZoneActive(true);
  }, []);

  const handleDropZoneDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropZoneActive(false);
  }, []);

  const handleDropZoneDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropZoneActive(false);

      if (!dragDownloadEntry) return;

      // Download the dragged entry
      if (dragDownloadEntry.is_dir) {
        message.warning("不支持拖拽下载目录");
        setDragDownloadEntry(null);
        return;
      }

      await handleDownload(dragDownloadEntry);
      setDragDownloadEntry(null);
    },
    [dragDownloadEntry, handleDownload]
  );

  // ---- Empty area context menu ----

  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuEntry({ name: "__empty__", is_dir: true, size: 0 } as SftpEntry);
  }, []);

  const getEmptyAreaContextMenuItems = useCallback((): MenuProps["items"] => {
    return [
      {
        key: "upload",
        icon: <UploadOutlined />,
        label: "上传文件...",
        onClick: () => handleUpload(),
      },
      {
        key: "newFolder",
        icon: <FolderAddOutlined />,
        label: "新建文件夹",
        onClick: () => handleNewFolder(),
      },
      { type: "divider" as const },
      {
        key: "selectAll",
        icon: <SelectOutlined />,
        label: "全选 (Ctrl+A)",
        onClick: () => handleSelectAll(),
      },
      { type: "divider" as const },
      {
        key: "refresh",
        icon: <ReloadOutlined />,
        label: "刷新",
        onClick: () => navigateTo(sftpPath),
      },
    ];
  }, [handleUpload, handleNewFolder, handleSelectAll, navigateTo, sftpPath]);

  // ---- Status bar info ----

  const selectedTotalSize = useMemo(() => {
    let total = 0;
    selectedEntries.forEach((name) => {
      const entry = sortedEntries.find((e) => e.name === name);
      if (entry && !entry.is_dir) {
        total += entry.size;
      }
    });
    return total;
  }, [selectedEntries, sortedEntries]);

  const dirCount = useMemo(() => sortedEntries.filter((e) => e.is_dir).length, [sortedEntries]);
  const fileCount = useMemo(() => sortedEntries.filter((e) => !e.is_dir).length, [sortedEntries]);

  // ---- Table columns ----

  const renderSortIcon = useCallback(
    (field: SortField) => {
      if (sortField !== field) return null;
      return sortOrder === "asc" ? (
        <CaretUpOutlined style={{ fontSize: 10, marginLeft: 4 }} />
      ) : (
        <CaretDownOutlined style={{ fontSize: 10, marginLeft: 4 }} />
      );
    },
    [sortField, sortOrder]
  );

  const columns = [
    {
      title: (
        <span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("name")}>
          名称 {renderSortIcon("name")}
        </span>
      ),
      dataIndex: "name",
      key: "name",
      render: (name: string, record: SftpEntry) => (
        <Space
          size="small"
          style={{ cursor: "pointer", width: "100%" }}
          onClick={(e) => handleEntryClick(record, e)}
          onContextMenu={(e) => handleContextMenu(e, record)}
        >
          {record.is_dir ? (
            <FolderOutlined style={{ color: "#faad14" }} />
          ) : (
            <FileOutlined style={{ color: token.colorTextSecondary }} />
          )}
          <span style={{ color: record.is_dir ? token.colorPrimary : "inherit" }}>{name}</span>
        </Space>
      ),
    },
    {
      title: (
        <span style={{ cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("size")}>
          大小 {renderSortIcon("size")}
        </span>
      ),
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (size: number, record: SftpEntry) => (record.is_dir ? "-" : formatBytes(size)),
    },
    {
      title: (
        <span
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => handleSort("permissions")}
        >
          权限 {renderSortIcon("permissions")}
        </span>
      ),
      dataIndex: "permissions",
      key: "permissions",
      width: 120,
    },
    {
      title: (
        <span
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => handleSort("modified")}
        >
          修改时间 {renderSortIcon("modified")}
        </span>
      ),
      dataIndex: "modified",
      key: "modified",
      width: 160,
    },
  ];

  // Determine which context menu to show
  const isContextMenuForEmptyArea = contextMenuEntry?.name === "__empty__";
  const contextMenuItems = isContextMenuForEmptyArea
    ? getEmptyAreaContextMenuItems()
    : getContextMenuItems();

  // Single selected entry for single-item operations (download button, etc.)
  const singleSelected = useMemo(() => {
    if (selectedEntries.size === 1) {
      const name = Array.from(selectedEntries)[0];
      return sortedEntries.find((e) => e.name === name) || null;
    }
    return null;
  }, [selectedEntries, sortedEntries]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: token.colorBgContainer,
        position: "relative",
      }}
      onContextMenu={handleEmptyContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Context menu overlay */}
      {contextMenuEntry && (
        <Dropdown
          menu={{ items: contextMenuItems }}
          trigger={["click"]}
          open={!!contextMenuEntry}
          onOpenChange={(open) => {
            if (!open) setContextMenuEntry(null);
          }}
        >
          <div
            style={{
              position: "fixed",
              left: contextMenuPos.x,
              top: contextMenuPos.y,
              width: 0,
              height: 0,
              zIndex: 9999,
            }}
          />
        </Dropdown>
      )}

      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Space size="small">
          <Tooltip title="回到用户主目录">
            <Button
              size="small"
              aria-label="回到用户主目录"
              icon={<HomeOutlined />}
              onClick={handleGoHome}
            />
          </Tooltip>
          <Tooltip title="上一级目录（Backspace）">
            <Button
              size="small"
              aria-label="上一级目录"
              icon={<ArrowLeftOutlined />}
              onClick={handleGoUp}
            />
          </Tooltip>
          <Tooltip title="重新列出当前目录">
            <Button
              size="small"
              aria-label="重新列出当前目录"
              icon={<ReloadOutlined />}
              onClick={() => navigateTo(sftpPath)}
            />
          </Tooltip>
          <Input
            size="small"
            style={{ width: 300 }}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入路径并按回车"
          />
        </Space>
        <Space size="small">
          {/* Batch operations when multiple selected */}
          {selectedEntries.size > 1 && (
            <>
              <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>
                已选 {selectedEntries.size} 项
              </Tag>
              <Tooltip title="批量下载选中文件">
                <Button size="small" icon={<DownloadOutlined />} onClick={handleBatchDownload}>
                  批量下载
                </Button>
              </Tooltip>
              <Tooltip title="批量删除选中项">
                <Button size="small" icon={<DeleteOutlined />} danger onClick={handleBatchDelete}>
                  批量删除
                </Button>
              </Tooltip>
              <Tooltip title="批量复制路径">
                <Button size="small" icon={<CopyOutlined />} onClick={handleBatchCopyPath}>
                  复制路径
                </Button>
              </Tooltip>
            </>
          )}
          {selectedEntries.size === 1 && (
            <Tag color="blue" style={{ margin: 0, fontSize: 11 }}>
              已选 1 项
            </Tag>
          )}
          {/* 裸 title 属性一律换成 Tooltip：原生 title 要悬停近一秒才出、不进无障碍树 */}
          <Tooltip title="上传文件">
            <Button
              size="small"
              aria-label="上传文件"
              icon={<UploadOutlined />}
              onClick={() => handleUpload()}
            >
              上传
            </Button>
          </Tooltip>
          <Tooltip
            title={
              singleSelected && !singleSelected.is_dir
                ? `下载 ${singleSelected.name}`
                : "请先选择文件"
            }
          >
            <Button
              size="small"
              aria-label="下载选中文件"
              icon={<DownloadOutlined />}
              onClick={() => singleSelected && handleDownload(singleSelected)}
              disabled={!singleSelected || singleSelected.is_dir}
            >
              下载
            </Button>
          </Tooltip>
          <Tooltip title="新建文件夹">
            <Button
              size="small"
              aria-label="新建文件夹"
              icon={<FolderAddOutlined />}
              onClick={handleNewFolder}
            />
          </Tooltip>
          <Button size="small" onClick={() => toggleSftp(false)}>
            关闭
          </Button>
        </Space>
      </div>

      {/* 面包屑导航 */}
      <div
        style={{
          padding: "4px 12px",
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Breadcrumb
          items={[
            { title: <a onClick={handleGoHome}>/</a> },
            ...sftpPath
              .split("/")
              .filter(Boolean)
              .map((p, i, arr) => {
                const target = "/" + arr.slice(0, i + 1).join("/");
                return { title: <a onClick={() => navigateTo(target)}>{p}</a> };
              }),
          ]}
        />
      </div>

      {/* 整批进度：一批 N 个文件时才出现。单条横幅说的是"这条传到哪了"，
          这条说的是"这批还剩多少、要不要停下"——两个层级不能挤在同一行里。 */}
      {batchText && batch && (
        <div
          style={{
            padding: "4px 12px",
            background: token.colorInfoBg,
            borderBottom: `1px solid ${token.colorInfoBorder}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 12, color: token.colorTextSecondary, flex: 1, minWidth: 0 }}>
            {batchText} · 已结束 {batch.finished}/{batch.total}
          </span>
          {!batch.cancelled && notStartedCount(batch) > 0 && (
            <Button
              size="small"
              type="text"
              aria-label="取消剩余传输"
              onClick={() => applyBatch(requestCancel(batchRef.current!))}
            >
              取消剩余 {notStartedCount(batch)} 个
            </Button>
          )}
        </div>
      )}

      {/* 传输进度指示器 */}
      {transfer && <TransferBanner transfer={transfer} onCancelTransfer={cancelCurrentTransfer} />}

      {/* 编辑中的文件指示器 */}
      {editingFiles.length > 0 && (
        <div
          style={{
            padding: "4px 12px",
            background: token.colorInfoBg,
            borderBottom: `1px solid ${token.colorInfoBorder}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: token.colorTextSecondary, flexShrink: 0 }}>
            编辑中:
          </span>
          {editingFiles.map((f) => {
            // 身份 = (会话, 远端路径)：两台主机可以有同名同路径的文件，只用 `remotePath`
            // 当 key 会撞 key，关闭其中一个也会把另一条从列表里抹掉 —— 而它的定时器还在跑，
            // 变成一个看不见、还在往远端写的上传器。
            const key = `${f.sessionId}\n${f.remotePath}`;
            const foreign = f.sessionId !== activeSessionId;
            return (
              <Tag
                key={key}
                icon={<EditOutlined />}
                color={foreign ? "default" : "blue"}
                closable
                onClose={() => {
                  if (f.watcher !== null) stopWatching(f.watcher);
                  setEditingFiles((prev) =>
                    prev.filter(
                      (ef) => !(ef.sessionId === f.sessionId && ef.remotePath === f.remotePath)
                    )
                  );
                }}
                title={foreign ? `${f.remotePath}（不在当前会话）` : f.remotePath}
                style={{ fontSize: 11 }}
              >
                {f.filename}
                {foreign ? ` @${hostOf(f.sessionId) || "其他会话"}` : ""}
              </Tag>
            );
          })}
        </div>
      )}

      {/* 文件列表 */}
      <div
        ref={tableRef}
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
          outline: dragOver ? `2px dashed ${token.colorPrimary}` : "none",
          outlineOffset: -2,
          background: dragOver ? token.colorPrimaryBg : "transparent",
          transition: "background 0.2s, outline 0.2s",
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
              pointerEvents: "none",
              background: `${token.colorPrimaryBg}80`,
            }}
          >
            <Space orientation="vertical" align="center">
              <UploadOutlined style={{ fontSize: 32, color: token.colorPrimary }} />
              <span style={{ color: token.colorPrimary, fontWeight: 500 }}>拖放文件到此处上传</span>
            </Space>
          </div>
        )}
        {loading ? (
          <LoadingState tip="加载文件列表..." minHeight={120} />
        ) : !activeSessionId ? (
          // 没有会话时不能写"目录为空"：那是"我看过了，确实没有东西"的意思，
          // 而这里什么都没看成。
          <EmptyState
            title="会话未连接"
            description="这一台还没有可用的 SSH 会话，连上之后这里会自动列出远端目录"
            icon={
              <FolderOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
            }
          />
        ) : listError ? (
          <EmptyState
            title="无法读取目录"
            description={`${sftpPath}：${listError}`}
            icon={
              <FolderOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
            }
          />
        ) : sftpEntries.length === 0 ? (
          <EmptyState
            title="目录为空"
            description="该目录下没有文件或子目录，可右键上传文件或新建文件夹"
            icon={
              <FolderOutlined style={{ fontSize: 48, color: "var(--ant-color-text-tertiary)" }} />
            }
          />
        ) : (
          <Table
            columns={columns}
            dataSource={sortedEntries}
            rowKey="name"
            size="small"
            pagination={false}
            onRow={(record, index) => ({
              onClick: (e) => {
                handleEntryClick(record, e);
                setFocusedIndex(index ?? -1);
              },
              onDoubleClick: () => {
                handleOpen(record);
              },
              onContextMenu: (e) => {
                handleContextMenu(e, record);
              },
              draggable: true,
              onDragStart: (e) => {
                handleRowDragStart(e, record);
              },
              onDragEnd: () => {
                handleRowDragEnd();
              },
              style: {
                cursor: "pointer",
                background: selectedEntries.has(record.name) ? token.colorPrimaryBg : undefined,
                outline: focusedIndex === index ? `2px solid ${token.colorPrimary}` : "none",
                outlineOffset: -2,
              },
            })}
          />
        )}
      </div>

      {/* 拖拽下载区域 */}
      {dragDownloadEntry && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: `2px dashed ${dropZoneActive ? token.colorPrimary : token.colorBorderSecondary}`,
            background: dropZoneActive ? token.colorPrimaryBg : token.colorBgElevated,
            transition: "all 0.2s",
            textAlign: "center",
          }}
          onDragOver={handleDropZoneDragOver}
          onDragLeave={handleDropZoneDragLeave}
          onDrop={handleDropZoneDrop}
        >
          <Space>
            <DragOutlined
              style={{ color: dropZoneActive ? token.colorPrimary : token.colorTextSecondary }}
            />
            <span
              style={{
                fontSize: 12,
                color: dropZoneActive ? token.colorPrimary : token.colorTextSecondary,
              }}
            >
              {dropZoneActive ? "释放以下载" : "拖拽下载区域 — 将文件拖到此处下载"}
            </span>
          </Space>
        </div>
      )}

      {/* 状态栏 */}
      <div
        style={{
          padding: "2px 12px",
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgElevated,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: token.colorTextTertiary,
          flexShrink: 0,
        }}
      >
        <span>
          {dirCount > 0 && `${dirCount} 个目录`}
          {dirCount > 0 && fileCount > 0 && "，"}
          {fileCount > 0 && `${fileCount} 个文件`}
          {dirCount === 0 && fileCount === 0 && "空目录"}
        </span>
        {selectedEntries.size > 0 && (
          <span>
            已选 {selectedEntries.size} 项
            {selectedTotalSize > 0 && ` · ${formatBytes(selectedTotalSize)}`}
          </span>
        )}
      </div>
    </div>
  );
}
