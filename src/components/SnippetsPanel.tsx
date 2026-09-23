import { useState, useMemo } from "react";
import {
  Button,
  Space,
  Input,
  Modal,
  Form,
  Tag,
  Collapse,
  Popconfirm,
  message,
  Tooltip,
} from "antd";
import {
  PlusOutlined,
  PlayCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  CodeOutlined,
  CloseOutlined,
} from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";
import { describeSnippetRun } from "../utils/snippetRun";
import type { Snippet } from "../types";

export default function SnippetsPanel() {
  const { snippets, addSnippet, updateSnippet, removeSnippet, executeSnippet, toggleSnippets } =
    useServerStore();
  const [searchText, setSearchText] = useState("");
  // 悬停色由状态驱动：命令式改 inline style 之后，列表一过滤/重排，旧那行的背景会留在新行上
  const [hoverSnippet, setHoverSnippet] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [form] = Form.useForm();

  const filteredSnippets = useMemo(() => {
    if (!searchText.trim()) return snippets;
    const lower = searchText.toLowerCase();
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.command.toLowerCase().includes(lower) ||
        (s.description && s.description.toLowerCase().includes(lower))
    );
  }, [snippets, searchText]);

  const groupedSnippets = useMemo(() => {
    const groups: Record<string, Snippet[]> = {};
    const ungrouped: Snippet[] = [];
    filteredSnippets.forEach((s) => {
      if (s.group) {
        if (!groups[s.group]) groups[s.group] = [];
        groups[s.group].push(s);
      } else {
        ungrouped.push(s);
      }
    });
    return { groups, ungrouped };
  }, [filteredSnippets]);

  const handleRun = async (snippet: Snippet) => {
    const res = await executeSnippet(snippet.command);
    // 只有真写进 PTY 才报成功；网关取消/没有会话都必须如实说"没发出去"
    const notice = describeSnippetRun(res, snippet.name);
    message[notice.type](notice.text);
  };

  const handleAdd = () => {
    setEditingSnippet(null);
    form.resetFields();
    setModalOpen(true);
  };

  const handleEdit = (snippet: Snippet) => {
    setEditingSnippet(snippet);
    form.setFieldsValue(snippet);
    setModalOpen(true);
  };

  const handleDelete = (id: string) => {
    removeSnippet(id);
    message.success("已删除");
  };

  const handleModalOk = async () => {
    try {
      const values = await form.validateFields();
      if (editingSnippet) {
        updateSnippet(editingSnippet.id, values);
        message.success("已更新");
      } else {
        addSnippet(values);
        message.success("已添加");
      }
      setModalOpen(false);
      form.resetFields();
      setEditingSnippet(null);
    } catch {
      // validation failed
    }
  };

  const truncateCommand = (cmd: string, maxLen = 60) => {
    const oneLine = cmd.replace(/\n/g, " ↵ ");
    return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
  };

  const renderSnippetItem = (snippet: Snippet) => (
    <div
      key={snippet.id}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 8px",
        borderRadius: 4,
        cursor: "pointer",
        gap: 8,
        // 悬停色改由状态驱动：列表一过滤/重排，旧那行的 inline 背景会留在新行上
        background: hoverSnippet === snippet.id ? "var(--ant-color-bg-text-hover)" : "transparent",
      }}
      onMouseEnter={() => setHoverSnippet(snippet.id)}
      onMouseLeave={() => setHoverSnippet(null)}
    >
      <div
        style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
        onClick={() => handleRun(snippet)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 500, fontSize: 13 }}>{snippet.name}</span>
          {snippet.description && (
            <span style={{ fontSize: 11, color: "var(--ant-color-text-tertiary)" }}>
              {snippet.description}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            fontFamily: "monospace",
            color: "var(--ant-color-text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {truncateCommand(snippet.command)}
        </div>
      </div>
      <Space size={2} style={{ flexShrink: 0 }}>
        <Tooltip title="执行">
          <Button
            type="text"
            size="small"
            aria-label={`执行 ${snippet.name}`}
            icon={<PlayCircleOutlined />}
            onClick={() => handleRun(snippet)}
          />
        </Tooltip>
        <Tooltip title="编辑">
          <Button
            type="text"
            size="small"
            aria-label={`编辑 ${snippet.name}`}
            icon={<EditOutlined />}
            onClick={() => handleEdit(snippet)}
          />
        </Tooltip>
        <Popconfirm
          title="确认删除？"
          onConfirm={() => handleDelete(snippet.id)}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <Tooltip title="删除">
            <Button type="text" size="small" aria-label={`删除 ${snippet.name}`} icon={<DeleteOutlined />} danger />
          </Tooltip>
        </Popconfirm>
      </Space>
    </div>
  );

  const collapseItems = Object.entries(groupedSnippets.groups).map(([group, items]) => ({
    key: group,
    label: (
      <Space size={4}>
        <Tag color="blue" style={{ margin: 0 }}>
          {group}
        </Tag>
        <span style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)" }}>
          {items.length}
        </span>
      </Space>
    ),
    children: <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{items.map(renderSnippetItem)}</div>,
  }));

  if (groupedSnippets.ungrouped.length > 0) {
    collapseItems.unshift({
      key: "__ungrouped__",
      label: (
        <Space size={4}>
          <Tag style={{ margin: 0 }}>未分组</Tag>
          <span style={{ fontSize: 12, color: "var(--ant-color-text-tertiary)" }}>
            {groupedSnippets.ungrouped.length}
          </span>
        </Space>
      ),
      children: (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {groupedSnippets.ungrouped.map(renderSnippetItem)}
        </div>
      ),
    });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--ant-color-bg-container)",
      }}
    >
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderBottom: "1px solid var(--ant-color-border-secondary)",
          flexShrink: 0,
        }}
      >
        <Space size="small">
          <CodeOutlined />
          <span style={{ fontWeight: 500, fontSize: 13 }}>快捷命令</span>
          <Input
            size="small"
            prefix={<SearchOutlined />}
            placeholder="搜索命令..."
            style={{ width: 200 }}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
          />
        </Space>
        <Space size="small">
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加
          </Button>
          <Button size="small" icon={<CloseOutlined />} onClick={() => toggleSnippets(false)}>
            关闭
          </Button>
        </Space>
      </div>

      {/* 命令列表 */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {filteredSnippets.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--ant-color-text-tertiary)",
              gap: 8,
            }}
          >
            <CodeOutlined style={{ fontSize: 32 }} />
            <span style={{ fontSize: 13 }}>
              {snippets.length === 0 ? "暂无快捷命令，点击添加" : "没有匹配的命令"}
            </span>
          </div>
        ) : (
          <Collapse
            items={collapseItems}
            size="small"
            defaultActiveKey={collapseItems.map((item) => item.key)}
            ghost
            style={{ background: "transparent" }}
          />
        )}
      </div>

      {/* 添加/编辑弹窗 */}
      <Modal
        title={editingSnippet ? "编辑快捷命令" : "添加快捷命令"}
        open={modalOpen}
        onOk={handleModalOk}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
          setEditingSnippet(null);
        }}
        okText={editingSnippet ? "保存" : "添加"}
        cancelText="取消"
        width={480}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="例如: 查看磁盘" />
          </Form.Item>
          <Form.Item
            name="command"
            label="命令"
            rules={[{ required: true, message: "请输入命令" }]}
          >
            <Input.TextArea rows={3} placeholder="例如: df -h" />
          </Form.Item>
          <Form.Item name="group" label="分组">
            <Input placeholder="例如: 系统监控（可选）" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input placeholder="命令说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
