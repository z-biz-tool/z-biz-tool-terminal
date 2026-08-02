import { useState, useMemo } from "react";
import { Button, Modal, Form, Input, InputNumber, Select, Tree, Space, Popconfirm, message, Tag } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CloudServerOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";
import type { ServerConfig } from "../types";

export default function ServerList() {
  const {
    servers,
    addServer,
    updateServer,
    removeServer,
    connectServer,
  } = useServerStore();

  const [modalVisible, setModalVisible] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();

  // 按分组组织服务器
  const treeData = useMemo(() => {
    const groups: Record<string, ServerConfig[]> = {};
    servers.forEach((s) => {
      const g = s.group || "默认分组";
      if (!groups[g]) groups[g] = [];
      groups[g].push(s);
    });
    return Object.entries(groups).map(([groupName, items]) => ({
      key: `group-${groupName}`,
      title: (
        <span style={{ fontWeight: 600, fontSize: 13, color: "#888" }}>
          {groupName} ({items.length})
        </span>
      ),
      selectable: false,
      children: items.map((s) => ({
        key: s.id,
        title: (
          <Space size="small" style={{ width: "100%", justifyContent: "space-between" }}>
            <Space size="small">
              <CloudServerOutlined />
              <span>{s.name}</span>
              <span style={{ color: "#999", fontSize: 12 }}>{s.host}:{s.port}</span>
            </Space>
            <Space size={2}>
              <Button
                type="link"
                size="small"
                icon={<LinkOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  connectServer(s);
                }}
              />
              <Button
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  handleEdit(s);
                }}
              />
              <Popconfirm
                title="确定删除该服务器?"
                onConfirm={(e) => {
                  e?.stopPropagation();
                  removeServer(s.id);
                  message.success("已删除");
                }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => e.stopPropagation()}
                />
              </Popconfirm>
            </Space>
          </Space>
        ),
        isLeaf: true,
      })),
    }));
  }, [servers]);

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
    } catch {
      // 校验失败
    }
  };

  return (
    <div style={{ padding: "8px" }}>
      <Button
        type="dashed"
        block
        icon={<PlusOutlined />}
        onClick={handleAdd}
        style={{ marginBottom: 8 }}
      >
        添加服务器
      </Button>

      {servers.length === 0 ? (
        <div style={{ textAlign: "center", color: "#999", padding: "20px 0", fontSize: 13 }}>
          暂无服务器配置
          <br />
          点击上方按钮添加
        </div>
      ) : (
        <Tree
          treeData={treeData}
          defaultExpandAll
          showLine={false}
          blockNode
        />
      )}

      <Modal
        title={editingId ? "编辑服务器" : "添加服务器"}
        open={modalVisible}
        onOk={handleSave}
        onCancel={() => setModalVisible(false)}
        width={500}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如: 生产环境Web服务器" />
          </Form.Item>
          <Form.Item name="group" label="分组">
            <Input placeholder="例如: 生产环境" />
          </Form.Item>
          <Form.Item name="host" label="主机地址" rules={[{ required: true, message: "请输入主机地址" }]}>
            <Input placeholder="例如: 192.168.1.100" />
          </Form.Item>
          <Form.Item name="port" label="端口" rules={[{ required: true, message: "请输入端口" }]}>
            <InputNumber min={1} max={65535} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="例如: root" />
          </Form.Item>
          <Form.Item name="authType" label="认证方式" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="password">密码</Select.Option>
              <Select.Option value="key">私钥</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.authType !== cur.authType}
          >
            {({ getFieldValue }) =>
              getFieldValue("authType") === "password" ? (
                <Form.Item name="password" label="密码">
                  <Input.Password placeholder="输入密码" />
                </Form.Item>
              ) : (
                <Form.Item name="privateKey" label="私钥内容(PEM格式)">
                  <Input.TextArea rows={4} placeholder="粘贴私钥内容" />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="可选备注信息" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
