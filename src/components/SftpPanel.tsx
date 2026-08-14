import { useEffect, useState, useCallback, useRef } from "react";
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

export default function SftpPanel({ serverId }: SftpPanelProps) {
  const { token } = theme.useToken();
  const { sftpEntries, sftpPath, listSftp, toggleSftp } = useServerStore();
  const [pathInput, setPathInput] = useState(sftpPath);
  const [loading, setLoading] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<SftpEntry | null>(null);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenuEntry, setContextMenuEntry] = useState<SftpEntry | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [editingFiles, setEditingFiles] = useState<EditingFile[]>([]);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPathInput(sftpPath);
  }, [sftpPath]);

  // Clear selection when directory changes
  useEffect(() => {
    setSelectedEntry(null);
  }, [sftpPath]);

  const getSessionId = useCallback(() => {
    const state = useServerStore.getState();
    const tab = state.tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === state.activePaneId);
    return activePane?.sessionId || tab?.sessionId;
  }, [serverId]);

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
      // If ctrl/meta key is held, toggle selection without navigating
      if (e?.ctrlKey || e?.metaKey) {
        setSelectedEntry((prev) => (prev?.name === entry.name ? null : entry));
        return;
      }
      if (entry.is_dir) {
        const newPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
        navigateTo(newPath);
      } else {
        // Select the file
        setSelectedEntry(entry);
      }
    },
    [sftpPath, navigateTo]
  );

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
      if (e.key === "Enter") {
        navigateTo(pathInput);
      }
    },
    [pathInput, navigateTo]
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
        // open() returns string | string[] | null depending on multiple
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
          // Small delay to show 100% before clearing
          setTimeout(() => setTransfer(null), 800);
        }
      }
      // Refresh the file list
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

      const target = entry || selectedEntry;
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
    [sftpPath, selectedEntry, getSessionId]
  );

  const handleOpen = useCallback(
    (entry: SftpEntry) => {
      if (entry.is_dir) {
        const newPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
        navigateTo(newPath);
      } else {
        // Double-click on file: edit it
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
            if (selectedEntry?.name === entry.name) {
              setSelectedEntry(null);
            }
            navigateTo(sftpPath);
          } catch (e) {
            message.error(`删除失败: ${String(e)}`);
          }
        },
      });
    },
    [sftpPath, selectedEntry, getSessionId, navigateTo]
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
        // Fallback: try clipboard API
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

      // Check if already editing this file
      const alreadyEditing = editingFiles.find((f) => f.remotePath === remotePath);
      if (alreadyEditing) {
        message.info(`${entry.name} 已在编辑中`);
        return;
      }

      try {
        // Get temp directory
        const tempDir = await invoke<string>("get_temp_dir");
        // Create a unique subdirectory for this edit session
        const editDir = `${tempDir}/z-terminal-edit`;
        // Ensure the directory exists (use a simple approach)
        const localPath = `${editDir}/${entry.name}`;

        // Download the file to temp location
        setTransfer({ type: "download", filename: entry.name, progress: 0 });
        await invoke("sftp_download", {
          sessionId,
          remotePath,
          localPath,
        });
        setTransfer(null);

        // Get initial modification time
        const statResult = await invoke<{ modified: number }>("get_file_modified_time", { path: localPath }).catch(() => ({ modified: Date.now() }));
        const lastModified = statResult.modified || Date.now();

        // Open with default application
        await invoke("open_file_with_default_app", { path: localPath });
        message.success(`已打开 ${entry.name} 进行编辑`);

        // Set up polling watcher for file changes
        const watcherId = window.setInterval(async () => {
          try {
            const currentStat = await invoke<{ modified: number }>("get_file_modified_time", { path: localPath }).catch(() => ({ modified: 0 }));
            if (currentStat.modified && currentStat.modified > lastModified) {
              // File has been modified, re-upload
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
                // Update the lastModified in editingFiles
                setEditingFiles((prev) =>
                  prev.map((f) =>
                    f.remotePath === remotePath ? { ...f, lastModified: currentStat.modified } : f
                  )
                );
                // Refresh the file list
                navigateTo(sftpPath);
              } catch (e) {
                message.error(`自动上传失败: ${String(e)}`);
              }
            }
          } catch {
            // File might have been deleted or is temporarily unavailable during save
          }
        }, 3000) as unknown as number;

        // Add to editing files list
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

  // ---- Context menu ----

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: SftpEntry) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenuEntry(entry);
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      setSelectedEntry(entry);
    },
    []
  );

  const getContextMenuItems = useCallback((): MenuProps["items"] => {
    if (!contextMenuEntry) return [];
    const entry = contextMenuEntry;
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
  }, [contextMenuEntry, handleOpen, handleDownload, handleEditFile, handleRename, handleDelete, handleCopyPath]);

  // ---- Drag and drop ----

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

      // Try to get file paths from the drop event
      // In Tauri, the dataTransfer may contain file paths
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // In Tauri webview, dropped files have a `path` property on the File object
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
        // Fallback: read files as array buffers and write to temp location
        // This path is for browsers where file.path is not available
        message.info("拖拽上传需要 Tauri 环境，请使用工具栏上传按钮");
      }
    },
    [handleUpload]
  );

  // ---- Empty area context menu ----

  const handleEmptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      // Store a special marker for empty area context menu
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
        key: "refresh",
        icon: <ReloadOutlined />,
        label: "刷新",
        onClick: () => navigateTo(sftpPath),
      },
    ];
  }, [handleUpload, handleNewFolder, navigateTo, sftpPath]);

  // ---- Table columns ----

  const columns = [
    {
      title: "名称",
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
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (size: number, record: SftpEntry) => (record.is_dir ? "-" : formatSize(size)),
    },
    {
      title: "权限",
      dataIndex: "permissions",
      key: "permissions",
      width: 120,
    },
    {
      title: "修改时间",
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
            onClick={() => handleDownload()}
            disabled={!selectedEntry || selectedEntry.is_dir}
            title={selectedEntry && !selectedEntry.is_dir ? `下载 ${selectedEntry.name}` : "请先选择文件"}
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
          // Drag and drop overlay styles
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
            dataSource={sftpEntries}
            rowKey="name"
            size="small"
            pagination={false}
            onRow={(record) => ({
              onClick: (e) => {
                // Click on the row (not just the name column)
                if ((e.target as HTMLElement).closest(".ant-table-cell") && record) {
                  // Only handle if not already handled by the name column click
                }
              },
              onDoubleClick: () => {
                handleOpen(record);
              },
              onContextMenu: (e) => {
                handleContextMenu(e, record);
              },
              style: {
                cursor: "pointer",
                background:
                  selectedEntry?.name === record.name ? token.colorPrimaryBg : undefined,
              },
            })}
          />
        )}
      </div>
    </div>
  );
}
