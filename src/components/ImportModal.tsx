import { useState, useCallback } from "react";
import { Modal, Select, Input, Button, Table, Checkbox, message } from "antd";
import { UploadOutlined, FileTextOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useServerStore } from "../stores/serverStore";

type ImportSource = "mobaxterm" | "winscp" | "csv" | "sshconfig";

interface ParsedServer {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  privateKey?: string;
  group: string;
  selected: boolean;
}

const SOURCE_OPTIONS = [
  { value: "mobaxterm", label: "MobaXterm" },
  { value: "winscp", label: "WinSCP" },
  { value: "csv", label: "CSV/TSV" },
  { value: "sshconfig", label: "SSH Config (~/.ssh/config)" },
];

function parseMobaXterm(content: string): ParsedServer[] {
  const results: ParsedServer[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("SubRep") || trimmed.startsWith("ImgNum")) {
      continue;
    }
    // MobaXterm bookmark format: sessionName=#109#0%host%22%username%-1%...
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const name = trimmed.substring(0, eqIdx).trim();
    const encoded = trimmed.substring(eqIdx + 1).trim();
    // Parse the encoded string: fields separated by %
    const parts = encoded.split("%");
    // Format: #109#0 %host%port%username% ...
    // Find host, port, username in the parts
    let host = "";
    let port = 22;
    let username = "root";
    for (let i = 0; i < parts.length; i++) {
      // Skip the initial #109#0 part
      if (parts[i].startsWith("#")) continue;
      // First non-# field after the initial marker is typically host
      if (!host && parts[i] && !parts[i].startsWith("-") && parts[i] !== "0" && parts[i] !== "1") {
        host = parts[i];
        // Next should be port
        if (i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
          port = parseInt(parts[i + 1], 10) || 22;
        }
        // Next should be username
        if (i + 2 < parts.length && parts[i + 2] && !parts[i + 2].startsWith("-")) {
          username = parts[i + 2];
        }
        break;
      }
    }
    if (host) {
      results.push({
        name: name || host,
        host,
        port,
        username,
        authType: "password",
        group: "MobaXterm导入",
        selected: true,
      });
    }
  }
  return results;
}

function parseWinSCP(content: string): ParsedServer[] {
  const results: ParsedServer[] = [];
  const lines = content.split("\n");
  let currentName = "";
  let currentHost = "";
  let currentPort = 22;
  let currentUsername = "";
  let currentPassword = "";

  const flush = () => {
    if (currentHost) {
      results.push({
        name: currentName || currentHost,
        host: currentHost,
        port: currentPort,
        username: currentUsername || "root",
        authType: currentPassword ? "password" : "key",
        password: currentPassword || undefined,
        group: "WinSCP导入",
        selected: true,
      });
    }
    currentName = "";
    currentHost = "";
    currentPort = 22;
    currentUsername = "";
    currentPassword = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Section header: [Sessions\session_name]
    const sectionMatch = trimmed.match(/^\[Sessions\\(.+)\]$/i);
    if (sectionMatch) {
      flush();
      currentName = sectionMatch[1];
      continue;
    }
    // Key=value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].toLowerCase();
      const value = kvMatch[2].trim();
      switch (key) {
        case "hostname":
          currentHost = value;
          break;
        case "portnumber":
          currentPort = parseInt(value, 10) || 22;
          break;
        case "username":
          currentUsername = value;
          break;
        case "passwordplain":
          currentPassword = value;
          break;
      }
    }
  }
  flush();
  return results;
}

function parseCsvTsv(content: string): ParsedServer[] {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  // Detect delimiter
  const firstLine = lines[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const headers = firstLine.split(delimiter).map((h) => h.trim().toLowerCase().replace(/['"]/g, ""));

  // Map headers to fields
  const fieldMap: Record<string, number> = {};
  const nameAliases = ["name", "名称", "别名", "alias", "label"];
  const hostAliases = ["host", "hostname", "主机", "地址", "address", "ip", "server"];
  const portAliases = ["port", "端口", "portnumber"];
  const userAliases = ["username", "user", "用户", "用户名", "login"];
  const authAliases = ["authtype", "auth", "认证", "auth_type", "type"];
  const passAliases = ["password", "密码", "pass", "passwordplain"];
  const keyAliases = ["privatekey", "key", "私钥", "identityfile", "keyfile"];
  const groupAliases = ["group", "分组", "category", "folder", "组"];

  headers.forEach((h, i) => {
    if (nameAliases.includes(h)) fieldMap.name = i;
    else if (hostAliases.includes(h)) fieldMap.host = i;
    else if (portAliases.includes(h)) fieldMap.port = i;
    else if (userAliases.includes(h)) fieldMap.username = i;
    else if (authAliases.includes(h)) fieldMap.authType = i;
    else if (passAliases.includes(h)) fieldMap.password = i;
    else if (keyAliases.includes(h)) fieldMap.privateKey = i;
    else if (groupAliases.includes(h)) fieldMap.group = i;
  });

  if (fieldMap.host === undefined) return [];

  const results: ParsedServer[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(delimiter).map((f) => f.trim().replace(/^["']|["']$/g, ""));
    const host = fields[fieldMap.host] || "";
    if (!host) continue;
    const authVal = fieldMap.authType !== undefined ? fields[fieldMap.authType]?.toLowerCase() : "";
    const authType: "password" | "key" = authVal === "key" || authVal === "私钥" ? "key" : "password";
    results.push({
      name: fieldMap.name !== undefined ? fields[fieldMap.name] || host : host,
      host,
      port: fieldMap.port !== undefined ? parseInt(fields[fieldMap.port], 10) || 22 : 22,
      username: fieldMap.username !== undefined ? fields[fieldMap.username] || "root" : "root",
      authType,
      password: fieldMap.password !== undefined ? fields[fieldMap.password] : undefined,
      privateKey: fieldMap.privateKey !== undefined ? fields[fieldMap.privateKey] : undefined,
      group: fieldMap.group !== undefined ? fields[fieldMap.group] || "CSV导入" : "CSV导入",
      selected: true,
    });
  }
  return results;
}

function parseSshConfig(content: string): ParsedServer[] {
  const results: ParsedServer[] = [];
  const lines = content.split("\n");
  let currentAlias = "";
  let currentHost = "";
  let currentPort = 22;
  let currentUser = "";
  let currentIdentityFile = "";

  const flush = () => {
    if (currentHost || currentAlias) {
      results.push({
        name: currentAlias || currentHost,
        host: currentHost || currentAlias,
        port: currentPort,
        username: currentUser || "root",
        authType: currentIdentityFile ? "key" : "password",
        group: "SSH Config",
        selected: true,
        ...(currentIdentityFile ? { privateKey: currentIdentityFile } : {}),
      });
    }
    currentAlias = "";
    currentHost = "";
    currentPort = 22;
    currentUser = "";
    currentIdentityFile = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("host ")) {
      flush();
      currentAlias = trimmed.substring(5).trim();
      continue;
    }
    if (lower.startsWith("hostname ")) {
      currentHost = trimmed.substring(9).trim();
    } else if (lower.startsWith("port ")) {
      currentPort = parseInt(trimmed.substring(5).trim(), 10) || 22;
    } else if (lower.startsWith("user ")) {
      currentUser = trimmed.substring(5).trim();
    } else if (lower.startsWith("identityfile ")) {
      currentIdentityFile = trimmed.substring(13).trim();
    }
  }
  flush();
  return results;
}

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ImportModal({ open, onClose }: ImportModalProps) {
  const [source, setSource] = useState<ImportSource>("mobaxterm");
  const [content, setContent] = useState("");
  const [parsedServers, setParsedServers] = useState<ParsedServer[]>([]);
  const addServer = useServerStore((s) => s.addServer);

  const handleParse = useCallback(() => {
    if (!content.trim()) {
      message.warning("请先输入或导入内容");
      return;
    }
    let results: ParsedServer[] = [];
    switch (source) {
      case "mobaxterm":
        results = parseMobaXterm(content);
        break;
      case "winscp":
        results = parseWinSCP(content);
        break;
      case "csv":
        results = parseCsvTsv(content);
        break;
      case "sshconfig":
        results = parseSshConfig(content);
        break;
    }
    if (results.length === 0) {
      message.warning("未检测到有效的服务器配置");
    }
    setParsedServers(results);
  }, [content, source]);

  const handleLoadSshConfig = useCallback(async () => {
    try {
      const configContent = await invoke<string>("read_ssh_config");
      if (!configContent) {
        message.info("~/.ssh/config 文件不存在或为空");
        return;
      }
      setContent(configContent);
    } catch (e) {
      message.error(`读取失败: ${String(e)}`);
    }
  }, []);

  const handleLoadFile = useCallback(async () => {
    try {
      const selected = await openDialog({
        title: "选择导入文件",
        filters: [
          { name: "所有文件", extensions: ["*"] },
          { name: "INI", extensions: ["ini", "mxtsessions"] },
          { name: "CSV", extensions: ["csv", "tsv"] },
          { name: "Text", extensions: ["txt", "config"] },
        ],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : selected;
      const fileContent = await invoke<string>("read_file_content", { path: filePath });
      setContent(fileContent);
    } catch {
      message.info("请将文件内容复制粘贴到文本框中");
    }
  }, []);

  const handleSelectAll = useCallback((checked: boolean) => {
    setParsedServers((prev) => prev.map((s) => ({ ...s, selected: checked })));
  }, []);

  const handleToggleServer = useCallback((index: number, checked: boolean) => {
    setParsedServers((prev) =>
      prev.map((s, i) => (i === index ? { ...s, selected: checked } : s))
    );
  }, []);

  const handleImport = useCallback(() => {
    const selected = parsedServers.filter((s) => s.selected);
    if (selected.length === 0) {
      message.warning("请至少选择一个服务器");
      return;
    }
    for (const server of selected) {
      addServer({
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        password: server.password,
        privateKey: server.privateKey,
        group: server.group,
      });
    }
    message.success(`成功导入 ${selected.length} 台服务器`);
    onClose();
    // Reset state
    setContent("");
    setParsedServers([]);
  }, [parsedServers, addServer, onClose]);

  const handleReset = useCallback(() => {
    setContent("");
    setParsedServers([]);
  }, []);

  const selectedCount = parsedServers.filter((s) => s.selected).length;

  const columns = [
    {
      title: (
        <Checkbox
          checked={parsedServers.length > 0 && selectedCount === parsedServers.length}
          indeterminate={selectedCount > 0 && selectedCount < parsedServers.length}
          onChange={(e) => handleSelectAll(e.target.checked)}
        />
      ),
      dataIndex: "selected",
      width: 48,
      render: (_: boolean, __: ParsedServer, index: number) => (
        <Checkbox
          checked={parsedServers[index].selected}
          onChange={(e) => handleToggleServer(index, e.target.checked)}
        />
      ),
    },
    { title: "名称", dataIndex: "name", width: 140, ellipsis: true },
    { title: "主机", dataIndex: "host", width: 140, ellipsis: true },
    { title: "端口", dataIndex: "port", width: 70 },
    { title: "用户名", dataIndex: "username", width: 100 },
    { title: "认证", dataIndex: "authType", width: 70, render: (v: string) => (v === "key" ? "私钥" : "密码") },
    { title: "分组", dataIndex: "group", width: 120, ellipsis: true },
  ];

  return (
    <Modal
      title="导入服务器"
      open={open}
      onCancel={onClose}
      width={800}
      footer={[
        <Button key="reset" onClick={handleReset}>
          重置
        </Button>,
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button
          key="import"
          type="primary"
          onClick={handleImport}
          disabled={selectedCount === 0}
        >
          导入 ({selectedCount})
        </Button>,
      ]}
      destroyOnClose
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ flexShrink: 0 }}>导入来源:</span>
          <Select
            value={source}
            onChange={(v) => {
              setSource(v);
              setParsedServers([]);
            }}
            options={SOURCE_OPTIONS}
            style={{ width: 240 }}
          />
          {source === "sshconfig" && (
            <Button icon={<FileTextOutlined />} onClick={handleLoadSshConfig}>
              读取 ~/.ssh/config
            </Button>
          )}
          {source !== "sshconfig" && (
            <Button icon={<UploadOutlined />} onClick={handleLoadFile}>
              选择文件
            </Button>
          )}
        </div>

        <Input.TextArea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setParsedServers([]);
          }}
          placeholder={
            source === "mobaxterm"
              ? "粘贴 MobaXterm 的 Bookmarks 内容..."
              : source === "winscp"
                ? "粘贴 WinSCP 的 sessions INI 内容..."
                : source === "csv"
                  ? "粘贴 CSV/TSV 内容（首行为表头，需包含 host 列）..."
                  : "粘贴 SSH Config 内容，或点击上方按钮读取..."
          }
          rows={8}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        />

        <Button type="primary" onClick={handleParse} disabled={!content.trim()}>
          解析内容
        </Button>

        {parsedServers.length > 0 && (
          <div>
            <div style={{ marginBottom: 8, color: "#888", fontSize: 12 }}>
              检测到 {parsedServers.length} 台服务器，已选择 {selectedCount} 台
            </div>
            <Table
              columns={columns}
              dataSource={parsedServers}
              rowKey={(_, index) => String(index)}
              size="small"
              pagination={parsedServers.length > 20 ? { pageSize: 20 } : false}
              scroll={{ y: 300 }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
