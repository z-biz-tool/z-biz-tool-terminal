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

interface SftpPanelProps {
  serverId: string;
}

interface TransferState {
  type: "upload" | "download";
  filename: string;
  progress: number; // 0-100
}

interface EditingFile {
  remotePath: string;
  localPath: string;
  filename: string;
  lastModified: number;
  watcher: number | null; // setInterval ID
}

type SortField = "name" | "size" | "modified" | "permissions";
type SortOrder = "asc" | "desc";

export default function SftpPanel({ serverId }: SftpPanelProps) {
  const { token } = theme.useToken();
  const { sftpEntries, sftpPath, listSftp, toggleSftp } = useServerStore();
  const [pathInput, setPathInput] = useState(sftpPath);
  const [loading, setLoading] = useState(false);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [lastClickedName, setLastClickedName] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenuEntry, setContextMenuEntry] = useState<SftpEntry | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [editingFiles, setEditingFiles] = useState<EditingFile[]>([]);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [dragDownloadEntry, setDragDownloadEntry] = useState<SftpEntry | null>(null);
  const [dropZoneActive, setDropZoneActive] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPathInput(sftpPath);
  }, [sftpPath]);

  // Clear selection when directory changes
  useEffect(() => {
    setSelectedEntries(new Set());
    setLastClickedName(null);
    setFocusedIndex(-1);
  }, [sftpPath]);

  const getSessionId = useCallback(() => {
    const state = useServerStore.getState();
    const tab = state.tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === state.activePaneId);
    return activePane?.sessionId || tab?.sessionId;
  }, [serverId]);

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
      setLoading(true);
      try {
        await listSftp(serverId, path);
      } catch (e) {
        message.error(`获取文件列表失败: ${String(e)}`);
      } finally {
        setLoading(false);
      }
    },
    [serverId, listSftp]
  );

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
        const newPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
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
    [pathInput, navigateTo, sortedEntries, focusedIndex, selectedEntries.size, handleSelectAll, handleGoUp]
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

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

      for (const localPath of filePaths) {
        const filename = localPath.split("/").pop() || localPath.split("\\").pop() || "file";
        const remotePath = sftpPath.endsWith("/") ? sftpPath + filename : sftpPath + "/" + filename;
        setTransfer({ type: "upload", filename, progress: 0 });
        try {
          await invoke("sftp_upload", {
            sessionId,
            localPath,
            remotePath,
          });
          setTransfer((prev) => (prev ? { ...prev, progress: 100 } : null));
          message.success(`上传成功: ${filename}`);
        } catch (e) {
          message.error(`上传失败: ${String(e)}`);
        } finally {
          setTimeout(() => setTransfer(null), 800);
        }
      }
      navigateTo(sftpPath);
    },
    [sftpPath, getSessionId, navigateTo]
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

      setTransfer({ type: "download", filename: target.name, progress: 0 });
      try {
        await invoke("sftp_download", {
          sessionId,
          remotePath,
          localPath,
        });
        setTransfer((prev) => (prev ? { ...prev, progress: 100 } : null));
        message.success(`下载成功: ${target.name}`);
      } catch (e) {
        message.error(`下载失败: ${String(e)}`);
      } finally {
        setTimeout(() => setTransfer(null), 800);
      }
    },
    [sftpPath, getSessionId]
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
      message.warning(`跳过 ${dirs.length} 个目录（不支持下载目录）: ${dirs.map((d) => d.name).join(", ")}`);
    }

    if (files.length === 0) {
      message.warning("没有可下载的文件");
      return;
    }

    for (const entry of files) {
      const remotePath = sftpPath.endsWith("/")
        ? sftpPath + entry.name
        : sftpPath + "/" + entry.name;

      const localPath = await save({
        defaultPath: entry.name,
        title: `保存文件到 (${entry.name})`,
      });
      if (!localPath) continue;

      setTransfer({ type: "download", filename: entry.name, progress: 0 });
      try {
        await invoke("sftp_download", {
          sessionId,
          remotePath,
          localPath,
        });
        setTransfer((prev) => (prev ? { ...prev, progress: 100 } : null));
        message.success(`下载成功: ${entry.name}`);
      } catch (e) {
        message.error(`下载失败: ${entry.name}: ${String(e)}`);
      } finally {
        setTimeout(() => setTransfer(null), 800);
      }
    }
  }, [sftpPath, selectedEntries, sortedEntries, getSessionId]);

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
          <div style={{ maxHeight: 120, overflow: "auto", fontSize: 12, color: token.colorTextSecondary }}>
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
          message.success(`成功删除 ${successCount} 项${failCount > 0 ? `，${failCount} 项失败` : ""}`);
        }
        setSelectedEntries(new Set());
        navigateTo(sftpPath);
      },
    });
  }, [sftpPath, selectedEntries, sortedEntries, getSessionId, navigateTo, token.colorTextSecondary]);

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

      const alreadyEditing = editingFiles.find((f) => f.remotePath === remotePath);
      if (alreadyEditing) {
        message.info(`${entry.name} 已在编辑中`);
        return;
      }

      try {
        const tempDir = await invoke<string>("get_temp_dir");
        const editDir = `${tempDir}/z-terminal-edit`;
        const localPath = `${editDir}/${entry.name}`;

        setTransfer({ type: "download", filename: entry.name, progress: 0 });
        await invoke("sftp_download", {
          sessionId,
          remotePath,
          localPath,
        });
        setTransfer(null);

        const statResult = await invoke<{ modified: number }>("get_file_modified_time", { path: localPath }).catch(() => ({ modified: Date.now() }));
        const lastModified = statResult.modified || Date.now();

        await invoke("open_file_with_default_app", { path: localPath });
        message.success(`已打开 ${entry.name} 进行编辑`);

        const watcherId = window.setInterval(async () => {
          try {
            const currentStat = await invoke<{ modified: number }>("get_file_modified_time", { path: localPath }).catch(() => ({ modified: 0 }));
            if (currentStat.modified && currentStat.modified > lastModified) {
              const currentSessionId = getSessionId();
              if (!currentSessionId) {
                clearInterval(watcherId);
                return;
              }
              try {
                await invoke("sftp_upload", {
                  sessionId: currentSessionId,
                  localPath,
                  remotePath,
                });
                message.success(`${entry.name} 已自动上传更新`);
                setEditingFiles((prev) =>
                  prev.map((f) =>
                    f.remotePath === remotePath ? { ...f, lastModified: currentStat.modified } : f
                  )
                );
                navigateTo(sftpPath);
              } catch (e) {
                message.error(`自动上传失败: ${String(e)}`);
              }
            }
          } catch {
            // File might have been deleted or is temporarily unavailable during save
          }
        }, 3000) as unknown as number;

        const editEntry: EditingFile = {
          remotePath,
          localPath,
          filename: entry.name,
          lastModified,
          watcher: watcherId,
        };
        setEditingFiles((prev) => [...prev, editEntry]);
      } catch (e) {
        setTransfer(null);
        message.error(`编辑文件失败: ${String(e)}`);
      }
    },
    [sftpPath, getSessionId, editingFiles, navigateTo]
  );

  // Cleanup watchers on unmount
  useEffect(() => {
    return () => {
      editingFiles.forEach((f) => {
        if (f.watcher !== null) {
          clearInterval(f.watcher);
        }
      });
    };
  }, []);

  const handleOpen = useCallback(
    (entry: SftpEntry) => {
      if (entry.is_dir) {
        const newPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
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
      const fullPath = sftpPath.endsWith("/")
        ? sftpPath + entry.name
        : sftpPath + "/" + entry.name;
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
  }, [contextMenuEntry, selectedEntries, handleOpen, handleDownload, handleEditFile, handleRename, handleDelete, handleCopyPath, handleBatchDownload, handleBatchCopyPath, handleBatchDelete]);

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

  const handleRowDragStart = useCallback(
    (e: React.DragEvent, entry: SftpEntry) => {
      setDragDownloadEntry(entry);
      // Set transfer data for the drag
      e.dataTransfer.setData("text/plain", entry.name);
      e.dataTransfer.effectAllowed = "copy";
      // Add a drag image
      const dragEl = document.createElement("div");
      dragEl.style.cssText = "position:absolute;top:-9999px;left:-9999px;padding:4px 12px;background:#1677ff;color:#fff;border-radius:4px;font-size:12px;white-space:nowrap;";
      dragEl.textContent = entry.is_dir ? `📁 ${entry.name}` : `📄 ${entry.name}`;
      document.body.appendChild(dragEl);
      e.dataTransfer.setDragImage(dragEl, 0, 0);
      // Clean up after a tick
      requestAnimationFrame(() => document.body.removeChild(dragEl));
    },
    []
  );

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

  const handleEmptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      setContextMenuEntry({ name: "__empty__", is_dir: true, size: 0 } as SftpEntry);
    },
    []
  );

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
        <span
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => handleSort("name")}
        >
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
        <span
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => handleSort("size")}
        >
          大小 {renderSortIcon("size")}
        </span>
      ),
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (size: number, record: SftpEntry) => (record.is_dir ? "-" : formatSize(size)),
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
          <Button size="small" icon={<HomeOutlined />} onClick={handleGoHome} />
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={handleGoUp} />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => navigateTo(sftpPath)} />
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
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={handleBatchDownload}
                >
                  批量下载
                </Button>
              </Tooltip>
              <Tooltip title="批量删除选中项">
                <Button
                  size="small"
                  icon={<DeleteOutlined />}
                  danger
                  onClick={handleBatchDelete}
                >
                  批量删除
                </Button>
              </Tooltip>
              <Tooltip title="批量复制路径">
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={handleBatchCopyPath}
                >
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
          <Button
            size="small"
            icon={<UploadOutlined />}
            onClick={() => handleUpload()}
            title="上传文件"
          >
            上传
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => singleSelected && handleDownload(singleSelected)}
            disabled={!singleSelected || singleSelected.is_dir}
            title={singleSelected && !singleSelected.is_dir ? `下载 ${singleSelected.name}` : "请先选择文件"}
          >
            下载
          </Button>
          <Button
            size="small"
            icon={<FolderAddOutlined />}
            onClick={handleNewFolder}
            title="新建文件夹"
          />
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

      {/* 传输进度指示器 */}
      {transfer && (
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
            {transfer.type === "upload" ? "上传" : "下载"}: {transfer.filename}
          </span>
          <Progress
            percent={transfer.progress}
            size="small"
            style={{ flex: 1, margin: 0 }}
            strokeColor={token.colorPrimary}
            showInfo={false}
          />
          <span style={{ fontSize: 12, color: token.colorTextSecondary, whiteSpace: "nowrap" }}>
            {transfer.progress < 100 ? "传输中..." : "完成"}
          </span>
        </div>
      )}

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
          {editingFiles.map((f) => (
            <Tag
              key={f.remotePath}
              icon={<EditOutlined />}
              color="blue"
              closable
              onClose={() => {
                if (f.watcher !== null) clearInterval(f.watcher);
                setEditingFiles((prev) => prev.filter((ef) => ef.remotePath !== f.remotePath));
              }}
              style={{ fontSize: 11 }}
            >
              {f.filename}
            </Tag>
          ))}
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
            <Space direction="vertical" align="center">
              <UploadOutlined style={{ fontSize: 32, color: token.colorPrimary }} />
              <span style={{ color: token.colorPrimary, fontWeight: 500 }}>
                拖放文件到此处上传
              </span>
            </Space>
          </div>
        )}
        {loading ? (
          <LoadingState tip="加载文件列表..." minHeight={120} />
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
                background: selectedEntries.has(record.name)
                  ? token.colorPrimaryBg
                  : undefined,
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
            <DragOutlined style={{ color: dropZoneActive ? token.colorPrimary : token.colorTextSecondary }} />
            <span style={{ fontSize: 12, color: dropZoneActive ? token.colorPrimary : token.colorTextSecondary }}>
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
            {selectedTotalSize > 0 && ` · ${formatSize(selectedTotalSize)}`}
          </span>
        )}
      </div>
    </div>
  );
}
