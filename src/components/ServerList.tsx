import { useState, useMemo, useEffect } from "react";
import {
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Tree,
  Space,
  Popconfirm,
  message,
  Dropdown,
  Tooltip,
  Input as AntInput,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CloudServerOutlined,
  LinkOutlined,
  MoreOutlined,
  ImportOutlined,
  ExportOutlined,
  SearchOutlined,
  DesktopOutlined,
  StarOutlined,
  StarFilled,
} from "@ant-design/icons";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useServerStore } from "../stores/serverStore";
import type { ServerConfig } from "../types";
import { EmptyState } from "@/_shared";

export default function ServerList() {
  const {
    servers,
    addServer,
    updateServer,
    removeServer,
    connectServer,
    loadConfig,
    exportConfig,
    importConfig,
    loaded,
  } = useServerStore();

  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [form] = Form.useForm();

  useEffect(() => {
    if (!loaded) loadConfig();
  }, []);

  // 监听全局快捷键触发的新建连接事件
  useEffect(() => {
    const handler = () => handleAdd();
    window.addEventListener("z-terminal:add-server", handler);
    return () => window.removeEventListener("z-terminal:add-server", handler);
  }, []);

  // 搜索过滤
  const filteredServers = useMemo(() => {
    if (!searchText) return servers;
    const lower = searchText.toLowerCase();
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.host.toLowerCase().includes(lower) ||
        s.group.toLowerCase().includes(lower)
    );
  }, [servers, searchText]);

  // 按分组组织（含收藏分组）
  const treeData = useMemo(() => {
    const pinnedServers = filteredServers.filter((s) => s.pinned);
    const groups: Record<string, ServerConfig[]> = {};
    filteredServers.forEach((s) => {
      const g = s.group || "默认分组";
      if (!groups[g]) groups[g] = [];
      groups[g].push(s);
    });

    const renderServerTitle = (s: ServerConfig) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "2px 0",
        }}
        onDoubleClick={() => connectServer(s)}
      >
        <Space size={6} style={{ minWidth: 0, flex: 1 }}>
          <DesktopOutlined style={{ color: "#1677ff", flexShrink: 0 }} />
          <span
            style={{
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {s.name}
          </span>
          <span style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }}>
            {s.host}:{s.port}
          </span>
        </Space>
        <Space size={0} style={{ flexShrink: 0, opacity: 0.6 }}>
          <Tooltip title={s.pinned ? "取消收藏" : "收藏"}>
            <Button
              type="text"
              size="small"
              icon={s.pinned ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                updateServer(s.id, { pinned: !s.pinned });
              }}
            />
          </Tooltip>
          <Tooltip title="连接">
            <Button
              type="text"
              size="small"
              icon={<LinkOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                connectServer(s);
              }}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                handleEdit(s);
              }}
            />
          </Tooltip>
          <Popconfirm
            title="删除该服务器？"
            okText="删除"
            cancelText="取消"
            onConfirm={(e) => {
              e?.stopPropagation();
              removeServer(s.id);
              message.success("已删除");
            }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </Space>
      </div>
    );

    const result: any[] = [];

    // 收藏分组置顶
    if (pinnedServers.length > 0) {
      result.push({
        key: "group-⭐ 收藏",
        title: (
          <span
            style={{
              fontWeight: 600,
              fontSize: 12,
              color: "#faad14",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            ⭐ 收藏 · {pinnedServers.length}
          </span>
        ),
        selectable: false,
        children: pinnedServers.map((s) => ({
          key: `pinned-${s.id}`,
          title: renderServerTitle(s),
          isLeaf: true,
        })),
      });
    }

    // 原始分组
    Object.entries(groups).forEach(([groupName, items]) => {
      result.push({
        key: `group-${groupName}`,
        title: (
          <span
            style={{
              fontWeight: 600,
              fontSize: 12,
              color: "#888",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            {groupName} · {items.length}
          </span>
        ),
        selectable: false,
        children: items.map((s) => ({
          key: s.id,
          title: renderServerTitle(s),
          isLeaf: true,
        })),
      });
    });

    return result;
  }, [filteredServers]);

  const handleAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({ port: 22, authType: "password", group: "默认分组" });
    setModalVisible(true);
  };

  const handleEdit = (server: ServerConfig) => {
    setEditingId(server.id);
    form.setFieldsValue(server);
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      if (editingId) {
        updateServer(editingId, values);
        message.success("已更新");
      } else {
        addServer(values);
        message.success("已添加");
      }
      setModalVisible(false);
    } catch {}
  };

  const handleExport = async () => {
    try {
      const path = await save({
        title: "导出配置",
        defaultPath: "z-terminal-config.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        const msg = await exportConfig(path);
        message.success(msg);
      }
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleImport = async () => {
    try {
      const path = await open({
        title: "导入配置",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await importConfig(path as string);
        message.success("导入成功");
      }
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶部标题 + 操作 */}
      <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid #f0f0f0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: 0.5 }}>z-Terminal</span>
          <Dropdown
            menu={{
              items: [
                {
                  key: "import",
                  label: "导入配置",
                  icon: <ImportOutlined />,
                  onClick: handleImport,
                },
                {
                  key: "export",
                  label: "导出配置",
                  icon: <ExportOutlined />,
                  onClick: handleExport,
                },
                { type: "divider" },
                {
                  key: "add",
                  label: "添加服务器",
                  icon: <PlusOutlined />,
                  onClick: handleAdd,
                },
              ],
            }}
          >
            <Button type="text" size="small" icon={<MoreOutlined />} />
          </Dropdown>
        </div>
        {/* 搜索框 */}
        <AntInput
          size="small"
          prefix={<SearchOutlined style={{ color: "#bbb" }} />}
          placeholder="搜索服务器..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ borderRadius: 6 }}
        />
      </div>

      {/* 服务器列表 */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 8px" }}>
        {servers.length === 0 ? (
          <EmptyState
            title="暂无服务器"
            description="点击右上角 + 添加"
            icon={
              <CloudServerOutlined
                style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }}
              />
            }
          />
        ) : (
          <Tree treeData={treeData} defaultExpandAll showLine={false} blockNode />
        )}
      </div>

      {/* 底部状态栏 */}
      <div
        style={{
          padding: "6px 12px",
          borderTop: "1px solid #f0f0f0",
          fontSize: 11,
          color: "#bbb",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{servers.length} 台服务器</span>
        <span>~/.z-terminal</span>
      </div>

      {/* 添加/编辑 Modal */}
      <Modal
        title={editingId ? "编辑服务器" : "添加服务器"}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={520}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如: 生产环境Web服务器" />
          </Form.Item>
          <Form.Item name="group" label="分组">
            <Input placeholder="例如: 生产环境" />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              name="host"
              label="主机地址"
              rules={[{ required: true, message: "请输入主机地址" }]}
              style={{ flex: 1, marginRight: 8 }}
            >
              <Input placeholder="192.168.1.100" />
            </Form.Item>
            <Form.Item
              name="port"
              label="端口"
              rules={[{ required: true, message: "请输入端口" }]}
              style={{ width: 100 }}
            >
              <InputNumber min={1} max={65535} style={{ width: "100%" }} />
            </Form.Item>
          </Space.Compact>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="password">密码</Select.Option>
              <Select.Option value="key">私钥</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.authType !== cur.authType}>
            {({ getFieldValue }) =>
              getFieldValue("authType") === "password" ? (
                <Form.Item name="password" label="密码">
                  <Input.Password placeholder="输入密码" />
                </Form.Item>
              ) : (
                <Form.Item name="privateKey" label="私钥内容 (PEM)">
                  <Input.TextArea
                    rows={4}
                    placeholder="粘贴私钥内容"
                    style={{ fontFamily: "monospace" }}
                  />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
