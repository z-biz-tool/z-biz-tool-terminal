import { useEffect, useState } from "react";
import { Table, Button, Space, Input, Breadcrumb, message } from "antd";
import {
  FolderOutlined,
  FileOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  HomeOutlined,
} from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";
import type { SftpEntry } from "../types";
import { EmptyState, LoadingState } from "@/_shared";

interface SftpPanelProps {
  serverId: string;
}

export default function SftpPanel({ serverId }: SftpPanelProps) {
  const { sftpEntries, sftpPath, listSftp, toggleSftp } = useServerStore();
  const [pathInput, setPathInput] = useState(sftpPath);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setPathInput(sftpPath);
  }, [sftpPath]);

  const navigateTo = async (path: string) => {
    setLoading(true);
    try {
      await listSftp(serverId, path);
    } catch (e) {
      message.error(`获取文件列表失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleEntryClick = (entry: SftpEntry) => {
    if (entry.is_dir) {
      const newPath = sftpPath.endsWith("/") ? sftpPath + entry.name : sftpPath + "/" + entry.name;
      navigateTo(newPath);
    }
  };

  const handleGoUp = () => {
    const parts = sftpPath.split("/").filter(Boolean);
    parts.pop();
    const parent = "/" + parts.join("/");
    navigateTo(parent || "/");
  };

  const handleGoHome = () => {
    navigateTo("/");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      navigateTo(pathInput);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const columns = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (name: string, record: SftpEntry) => (
        <Space
          size="small"
          style={{ cursor: record.is_dir ? "pointer" : "default" }}
          onClick={() => handleEntryClick(record)}
        >
          {record.is_dir ? (
            <FolderOutlined style={{ color: "#faad14" }} />
          ) : (
            <FileOutlined style={{ color: "#8c8c8c" }} />
          )}
          <span style={{ color: record.is_dir ? "#1677ff" : "inherit" }}>{name}</span>
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#fff" }}>
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderBottom: "1px solid #e8e8e8",
        }}
      >
        <Space size="small">
          <Button size="small" icon={<HomeOutlined />} onClick={handleGoHome} />
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={handleGoUp} />
          <Button size="small" icon={<ReloadOutlined />} onClick={() => navigateTo(sftpPath)} />
          <Input
            size="small"
            style={{ width: 400 }}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入路径并按回车"
          />
        </Space>
        <Button size="small" onClick={() => toggleSftp(false)}>
          关闭
        </Button>
      </div>

      {/* 面包屑导航 */}
      <div style={{ padding: "4px 12px", borderBottom: "1px solid #e8e8e8" }}>
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

      {/* 文件列表 */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {loading ? (
          <LoadingState tip="加载文件列表..." minHeight={120} />
        ) : sftpEntries.length === 0 ? (
          <EmptyState
            title="目录为空"
            description="该目录下没有文件或子目录"
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
          />
        )}
      </div>
    </div>
  );
}
