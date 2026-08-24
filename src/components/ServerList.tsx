import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Tree,
  Space,
  message,
  Dropdown,
  Tooltip,
  Input as AntInput,
  ColorPicker,
} from "antd";
import type { TreeProps } from "antd";
import type { Color } from "antd/es/color-picker";
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
  CloudUploadOutlined,
  FolderAddOutlined,
  EditTwoTone,
  TagsOutlined,
  CopyOutlined,
  PoweroffOutlined,
} from "@ant-design/icons";
import { save, open } from "@tauri-apps/plugin-dialog";
import { useServerStore } from "../stores/serverStore";
import type { ServerConfig } from "../types";
import { EmptyState } from "@/_shared";
import ImportModal from "./ImportModal";

const DEFAULT_GROUP = "默认分组";
const PINNED_GROUP = "⭐ 收藏";

const PRESET_COLORS = [
  "#1677ff",
  "#52c41a",
  "#faad14",
  "#f5222d",
  "#722ed1",
  "#13c2c2",
  "#eb2f96",
  "#666666",
];

export default function ServerList() {
  const {
    servers,
    customGroups,
    addServer,
    updateServer,
    removeServer,
    connectServer,
    openNewTab,
    loadConfig,
    exportConfig,
    importConfig,
    loaded,
    addGroup,
    renameGroup,
    removeGroup,
  } = useServerStore();

  const [modalVisible, setModalVisible] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [initialGroup, setInitialGroup] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const [form] = Form.useForm();
  const [groupForm] = Form.useForm();
  const [renameForm] = Form.useForm();

  // 通用重命名 Modal 的状态
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    kind: "server" | "group";
    id?: string;
    oldName: string;
  }>({ visible: false, kind: "server", oldName: "" });

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
        (s.group || "").toLowerCase().includes(lower) ||
        (s.tags || "").toLowerCase().includes(lower)
    );
  }, [servers, searchText]);

  // 按分组组织（含收藏分组 + 自定义空分组）
  const treeData = useMemo(() => {
    const pinnedServers = filteredServers.filter((s) => s.pinned);
    const groups: Record<string, ServerConfig[]> = {};
    filteredServers.forEach((s) => {
      const g = s.group || DEFAULT_GROUP;
      if (!groups[g]) groups[g] = [];
      groups[g].push(s);
    });

    // 按 order 字段排序（升序，null 排最后），再按 name 字母排序
    const sortServers = (items: ServerConfig[]) =>
      [...items].sort((a, b) => {
        if (a.order != null && b.order == null) return -1;
        if (a.order == null && b.order != null) return 1;
        if (a.order != null && b.order != null) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });

    // 渲染服务器条目(支持右键菜单)
    const renderServerTitle = (s: ServerConfig) => {
      return (
        <Dropdown
          menu={{
            items: [
              {
                key: "connect",
                icon: <PoweroffOutlined />,
                label: "连接",
                onClick: () => connectServer(s),
              },
              {
                key: "newTab",
                icon: <PlusOutlined />,
                label: "新建终端",
                onClick: () => openNewTab(s),
              },
              {
                key: "edit",
                icon: <EditOutlined />,
                label: "编辑...",
                onClick: () => handleEdit(s),
              },
              {
                key: "rename",
                icon: <EditTwoTone />,
                label: "重命名",
                onClick: () => openRename("server", s.id, s.name),
              },
              { type: "divider" as const },
              {
                key: "clone",
                icon: <CopyOutlined />,
                label: "克隆",
                onClick: () => handleClone(s),
              },
              {
                key: "copyInfo",
                icon: <CopyOutlined />,
                label: "复制连接信息",
                onClick: () => {
                  const info = `${s.username}@${s.host}:${s.port}`;
                  navigator.clipboard.writeText(info).then(() => {
                    message.success(`已复制: ${info}`);
                  });
                },
              },
              {
                key: "pin",
                icon: s.pinned ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />,
                label: s.pinned ? "取消收藏" : "收藏",
                onClick: () => updateServer(s.id, { pinned: !s.pinned }),
              },
              { type: "divider" as const },
              {
                key: "delete",
                icon: <DeleteOutlined />,
                label: "删除",
                danger: true,
                onClick: () => {
                  Modal.confirm({
                    title: `删除服务器「${s.name}」?`,
                    content: "该操作不可撤销, 已有的连接会自动关闭。",
                    okText: "删除",
                    okButtonProps: { danger: true },
                    cancelText: "取消",
                    onOk: () => {
                      removeServer(s.id);
                      message.success("已删除");
                    },
                  });
                },
              },
            ],
          }}
          trigger={["contextMenu"]}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 22,
            }}
            onDoubleClick={() => connectServer(s)}
          >
            <Space size={6} style={{ minWidth: 0, flex: 1 }}>
              {s.color ? (
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: s.color,
                    flexShrink: 0,
                  }}
                />
              ) : (
                <DesktopOutlined style={{ color: "#1677ff", flexShrink: 0 }} />
              )}
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
              {s.tags && (
                <Tooltip title={`标签: ${s.tags}`}>
                  <TagsOutlined style={{ color: "#bbb", fontSize: 11, flexShrink: 0 }} />
                </Tooltip>
              )}
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
            </Space>
          </div>
        </Dropdown>
      );
    };

    // 渲染分组标题(支持右键菜单)
    const renderGroupTitle = (groupName: string, count: number) => {
      const isPinned = groupName === PINNED_GROUP;
      const isDefault = groupName === DEFAULT_GROUP;
      const menuItems = isPinned
        ? null
        : [
            {
              key: "add-server",
              icon: <PlusOutlined />,
              label: "在此分组添加服务器",
              onClick: () => handleAddToGroup(groupName),
            },
            ...(isDefault
              ? []
              : [
                  { type: "divider" as const },
                  {
                    key: "rename",
                    icon: <EditTwoTone />,
                    label: "重命名分组",
                    onClick: () => openRename("group", undefined, groupName),
                  },
                  {
                    key: "delete",
                    icon: <DeleteOutlined />,
                    label: "删除分组",
                    danger: true,
                    onClick: () => {
                      const usedBy = servers.filter(
                        (s) => (s.group || DEFAULT_GROUP) === groupName
                      ).length;
                      Modal.confirm({
                        title: `删除分组「${groupName}」?`,
                        content:
                          usedBy > 0
                            ? `该分组下还有 ${usedBy} 台服务器, 不会被删除, 仅移除空分组标记。`
                            : "该分组为空, 将被移除。",
                        okText: "删除",
                        okButtonProps: { danger: true },
                        cancelText: "取消",
                        onOk: () => {
                          removeGroup(groupName);
                          message.success("已删除分组");
                        },
                      });
                    },
                  },
                ]),
          ];

      const titleNode = (
        <span
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: isPinned ? "#faad14" : "#888",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {groupName} · {count}
        </span>
      );

      if (!menuItems) return titleNode;

      return (
        <Dropdown menu={{ items: menuItems }} trigger={["contextMenu"]}>
          {titleNode}
        </Dropdown>
      );
    };

    const result: any[] = [];

    // 收藏分组置顶
    if (pinnedServers.length > 0) {
      result.push({
        key: `group-${PINNED_GROUP}`,
        title: renderGroupTitle(PINNED_GROUP, pinnedServers.length),
        selectable: false,
        children: sortServers(pinnedServers).map((s) => ({
          key: `pinned-${s.id}`,
          title: renderServerTitle(s),
          isLeaf: true,
        })),
      });
    }

    // 已使用的分组(从 server.group 派生)
    Object.entries(groups).forEach(([groupName, items]) => {
      result.push({
        key: `group-${groupName}`,
        title: renderGroupTitle(groupName, items.length),
        selectable: false,
        children: sortServers(items).map((s) => ({
          key: s.id,
          title: renderServerTitle(s),
          isLeaf: true,
        })),
      });
    });

    // 追加自定义空分组(尚未添加服务器的)
    customGroups
      .filter((g) => !groups[g] && g !== DEFAULT_GROUP && g !== PINNED_GROUP)
      .forEach((g) => {
        result.push({
          key: `group-${g}`,
          title: renderGroupTitle(g, 0),
          selectable: false,
          children: [],
        });
      });

    return result;
  }, [filteredServers, customGroups, servers]);

  const handleAdd = () => {
    setEditingId(null);
    setInitialGroup("");
    form.resetFields();
    form.setFieldsValue({ port: 22, authType: "password", group: DEFAULT_GROUP, color: "#1677ff" });
    setModalVisible(true);
  };

  const handleAddToGroup = (groupName: string) => {
    setEditingId(null);
    setInitialGroup(groupName);
    form.resetFields();
    form.setFieldsValue({
      port: 22,
      authType: "password",
      group: groupName === DEFAULT_GROUP ? "" : groupName,
      color: "#1677ff",
    });
    setModalVisible(true);
  };

  const handleEdit = (server: ServerConfig) => {
    setEditingId(server.id);
    setInitialGroup(server.group || "");
    form.setFieldsValue({
      ...server,
      group: server.group || "",
      color: server.color || "#1677ff",
    });
    setModalVisible(true);
  };

  const handleClone = (source: ServerConfig) => {
    setEditingId(null);
    setInitialGroup(source.group || "");
    form.resetFields();
    const { id: _id, ...rest } = source;
    form.setFieldsValue({
      ...rest,
      name: `${source.name} (副本)`,
      group: source.group || "",
      color: source.color || "#1677ff",
    });
    setModalVisible(true);
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        group: values.group || "",
        color:
          typeof values.color === "string"
            ? values.color
            : values.color && (values.color as Color).toHexString
              ? (values.color as Color).toHexString()
              : undefined,
      };
      if (editingId) {
        updateServer(editingId, payload);
        message.success("已更新");
      } else {
        addServer(payload);
        message.success("已添加");
      }
      setModalVisible(false);
    } catch {}
  };

  const handleAddGroup = async () => {
    try {
      const { name } = await groupForm.validateFields();
      addGroup(name);
      groupForm.resetFields();
      setGroupModalVisible(false);
      message.success(`分组「${name}」已创建`);
    } catch {}
  };

  const openRename = (kind: "server" | "group", id: string | undefined, oldName: string) => {
    setRenameModal({ visible: true, kind, id, oldName });
    renameForm.setFieldsValue({ name: oldName });
  };

  const handleRenameOk = async () => {
    try {
      const { name } = await renameForm.validateFields();
      const trimmed = name.trim();
      if (!trimmed || trimmed === renameModal.oldName) {
        setRenameModal((s) => ({ ...s, visible: false }));
        return;
      }
      if (renameModal.kind === "server" && renameModal.id) {
        updateServer(renameModal.id, { name: trimmed });
        message.success("已重命名");
      } else if (renameModal.kind === "group") {
        renameGroup(renameModal.oldName, trimmed);
        message.success("分组已重命名");
      }
      setRenameModal((s) => ({ ...s, visible: false }));
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

  // 拖拽排序处理
  const handleDrop: TreeProps["onDrop"] = useCallback(
    (info: any) => {
      const dragKey = info.dragNode.key as string;
      const dropKey = info.node.key as string;
      const dropToGap = info.dropToGap;

      const isDragServer = !String(dragKey).startsWith("group-");
      const isDropGroup = String(dropKey).startsWith("group-");

      if (!isDragServer) return;

      const serverId = String(dragKey).startsWith("pinned-")
        ? String(dragKey).replace("pinned-", "")
        : String(dragKey);

      const dragServer = servers.find((s) => s.id === serverId);
      if (!dragServer) return;

      if (isDropGroup && !dropToGap) {
        const groupName = String(dropKey).replace("group-", "");
        if (groupName === PINNED_GROUP) {
          updateServer(serverId, { pinned: true });
        } else {
          updateServer(serverId, { group: groupName === DEFAULT_GROUP ? "" : groupName });
        }
        return;
      }

      let targetGroup = dragServer.group || DEFAULT_GROUP;
      let targetServerId: string | null = null;

      if (!isDropGroup) {
        const dropServerId = String(dropKey).startsWith("pinned-")
          ? String(dropKey).replace("pinned-", "")
          : String(dropKey);
        const dropServer = servers.find((s) => s.id === dropServerId);
        if (dropServer) {
          targetGroup = dropServer.group || DEFAULT_GROUP;
          targetServerId = dropServerId;
        }
      }

      const groupServers = servers
        .filter((s) => (s.group || DEFAULT_GROUP) === targetGroup)
        .sort((a, b) => {
          if (a.order != null && b.order == null) return -1;
          if (a.order == null && b.order != null) return 1;
          if (a.order != null && b.order != null) return a.order - b.order;
          return a.name.localeCompare(b.name);
        });

      const withoutDrag = groupServers.filter((s) => s.id !== serverId);
      let insertIndex: number;
      if (targetServerId) {
        const targetIdx = withoutDrag.findIndex((s) => s.id === targetServerId);
        insertIndex = dropToGap ? targetIdx : targetIdx + 1;
      } else {
        insertIndex = withoutDrag.length;
      }

      withoutDrag.splice(insertIndex, 0, dragServer);
      withoutDrag.forEach((s, idx) => {
        if (s.id === serverId) {
          const newGroup = targetGroup === DEFAULT_GROUP ? "" : targetGroup;
          updateServer(serverId, { order: idx, group: newGroup });
        } else if (s.order !== idx) {
          updateServer(s.id, { order: idx });
        }
      });
    },
    [servers, updateServer]
  );

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
          <Space size={4}>
            <Tooltip title="新建分组">
              <Button
                type="text"
                size="small"
                icon={<FolderAddOutlined />}
                onClick={() => {
                  groupForm.resetFields();
                  setGroupModalVisible(true);
                }}
              />
            </Tooltip>
            <Tooltip title="添加服务器">
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={handleAdd}
              />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  {
                    key: "import-servers",
                    label: "导入服务器",
                    icon: <CloudUploadOutlined />,
                    onClick: () => setImportModalVisible(true),
                  },
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
                ],
              }}
            >
              <Button type="text" size="small" icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
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
        {servers.length === 0 && customGroups.length === 0 ? (
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
          <Tree
            className="tree-compact"
            treeData={treeData}
            defaultExpandAll
            showLine={false}
            blockNode
            draggable={{ icon: false }}
            onDrop={handleDrop}
          />
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
        <span>
          {servers.length} 台服务器 · {customGroups.length} 个自定义分组
        </span>
        <span>~/.z-terminal</span>
      </div>

      {/* 添加 / 编辑 Modal */}
      <Modal
        title={editingId ? "编辑服务器" : initialGroup ? `添加到「${initialGroup}」` : "添加服务器"}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={560}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如: 生产环境Web服务器" />
          </Form.Item>
          <Space.Compact style={{ width: "100%" }}>
            <Form.Item
              name="group"
              label="分组"
              style={{ flex: 1, marginRight: 8 }}
            >
              <Select
                allowClear
                showSearch
                placeholder="选择或输入新分组"
                mode="tags"
                maxCount={1}
                options={Array.from(
                  new Set([
                    DEFAULT_GROUP,
                    ...customGroups,
                    ...servers.map((s) => s.group).filter(Boolean),
                  ])
                ).map((g) => ({ value: g, label: g }))}
              />
            </Form.Item>
            <Form.Item
              name="color"
              label="颜色"
              style={{ width: 110 }}
            >
              <ColorPicker
                presets={[
                  {
                    label: "预设",
                    colors: PRESET_COLORS,
                  },
                ]}
                allowClear
                format="hex"
                defaultValue="#1677ff"
              />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="tags" label="标签" extra="多个标签用逗号或空格分隔">
            <Input placeholder="例如: 生产, 阿里云, MySQL" />
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
                <Form.Item
                  name="password"
                  label="密码 / 私钥密码"
                  extra="可填入服务器登录密码, 或私钥的 passphrase(若私钥有加密)"
                >
                  <Input.Password placeholder="输入密码(留空则不修改已保存的)" />
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
          <Form.Item name="proxyJump" label="跳板机" extra="通过该服务器跳转连接">
            <Select
              allowClear
              placeholder="无 (直连)"
              options={servers
                .filter((s) => s.id !== editingId)
                .map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.host}:${s.port})`,
                }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新建分组 Modal */}
      <Modal
        title="新建分组"
        open={groupModalVisible}
        onOk={handleAddGroup}
        onCancel={() => setGroupModalVisible(false)}
        okText="创建"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={groupForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="分组名称"
            rules={[
              { required: true, message: "请输入分组名称" },
              { max: 30, message: "名称最长 30 字符" },
            ]}
          >
            <Input placeholder="例如: 生产环境" autoFocus />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重命名 Modal(服务器/分组通用) */}
      <Modal
        title={renameModal.kind === "server" ? "重命名服务器" : "重命名分组"}
        open={renameModal.visible}
        onOk={handleRenameOk}
        onCancel={() => setRenameModal((s) => ({ ...s, visible: false }))}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={renameForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="新名称"
            rules={[{ required: true, message: "请输入新名称" }]}
          >
            <Input
              placeholder={renameModal.kind === "server" ? "服务器名称" : "分组名称"}
              autoFocus
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 导入服务器 Modal */}
      <ImportModal open={importModalVisible} onClose={() => setImportModalVisible(false)} />
    </div>
  );
}
