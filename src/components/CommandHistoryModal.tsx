/**
 * 命令历史检索（T-5-5）
 *
 * 只做两件事：把"以前敲过什么"找回来，以及把它**填入**当前终端（不带回车，P-1）。
 * 列表里的命令都已经在落盘前脱敏（P-4），所以这里显示的就是磁盘上有的形态。
 */

import { useMemo, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import { ClearOutlined, CopyOutlined, SearchOutlined, ThunderboltOutlined } from "@ant-design/icons";
import {
  HISTORY_LIMIT,
  clearHistory,
  historyHosts,
  listHistory,
  searchHistory,
  type HistoryEntry,
} from "../utils/commandHistory";
import { historyEnabled } from "../services/commandGate";
import { feedActiveTerminal } from "../services/terminalFeeds";
import { envListPrefix } from "../utils/environment";

const LEVEL_TAG: Record<string, { text: string; color: string }> = {
  warn: { text: "注意", color: "gold" },
  confirm: { text: "危险", color: "orange" },
  block: { text: "不可逆", color: "red" },
};

function ago(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(at).toLocaleDateString();
}

/** 历史里的主机标签是 `名称<host:port>`，展示时拆开更好读 */
function splitHost(label: string): { name: string; host: string } {
  const m = /^(.*)<(.*)>$/.exec(label);
  return m ? { name: m[1], host: m[2] } : { name: label, host: "" };
}

function hostLine(entry: HistoryEntry): { text: string; prod: boolean } {
  const first = splitHost(entry.hosts[0] ?? "");
  const more = entry.hosts.length > 1 ? ` 等 ${entry.hosts.length} 台` : "";
  return {
    text: `${envListPrefix(entry.prod > 0 ? "prod" : undefined)}${first.name}${first.host ? ` · ${first.host}` : ""}${more}`,
    prod: entry.prod > 0,
  };
}

export default function CommandHistoryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [host, setHost] = useState<string | undefined>();
  // 清空历史时查询条件可能一个都没变，靠 tick 让列表重算
  const [tick, setTick] = useState(0);
  const total = useMemo(() => (open ? listHistory().length : 0), [open, tick]);
  const hosts = useMemo(() => (open ? historyHosts() : []), [open, tick]);
  const items = useMemo(() => (open ? searchHistory(query, { host, limit: 60 }) : []), [open, query, host, tick]);

  const fill = (entry: HistoryEntry) => {
    if (!feedActiveTerminal(entry.cmd)) {
      message.warning("没有可用的活动终端，命令已复制到剪贴板");
      navigator.clipboard.writeText(entry.cmd).catch(() => {});
      return;
    }
    message.success("已填入命令行，未执行；确认无误后按回车");
    onClose();
  };

  return (
    <Modal
      open={open}
      title="命令历史"
      footer={null}
      onCancel={onClose}
      width={720}
      destroyOnHidden
    >
      {!historyEnabled() && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="命令历史记录已在设置里关闭"
          description="下面的内容是之前留下的历史；关闭开关只停止新记录，不会自动删除已有数据。"
        />
      )}
      <Space orientation="vertical" size={8} style={{ width: "100%" }}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            autoFocus
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={() => items[0] && fill(items[0])}
            placeholder="搜索命令，回车填入最上面一条"
            prefix={<SearchOutlined />}
          />
          <Select
            allowClear
            showSearch
            value={host}
            onChange={setHost}
            placeholder="全部主机"
            style={{ width: 240 }}
            options={hosts.map((h) => ({ label: splitHost(h).name || h, value: h }))}
            optionFilterProp="label"
          />
        </Space.Compact>
        <div style={{ maxHeight: 380, overflow: "auto" }}>
          {items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={total === 0 ? "还没有记录过命令：先在某台服务器上执行一条命令" : "没有匹配的历史"}
            />
          ) : (
            items.map((e, i) => {
              const line = hostLine(e);
              const lv = LEVEL_TAG[e.level];
              return (
                <div
                  key={`${e.cmd}|${e.hosts.join(",")}`}
                  onClick={() => fill(e)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    border: `1px solid rgba(127,127,127,${i === 0 ? 0.35 : 0.16})`,
                    marginBottom: 6,
                    background: i === 0 ? "rgba(127,127,127,0.08)" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Typography.Text
                      style={{
                        flex: 1,
                        fontFamily: "SF Mono, Monaco, Menlo, monospace",
                        fontSize: 13,
                        wordBreak: "break-all",
                        color: line.prod ? "#d4380d" : undefined,
                        fontWeight: line.prod ? 600 : undefined,
                      }}
                    >
                      {e.cmd}
                    </Typography.Text>
                    {lv && (
                      <Tag color={lv.color} style={{ marginInlineEnd: 0 }}>
                        {lv.text}
                      </Tag>
                    )}
                    {e.n > 1 && <Tag style={{ marginInlineEnd: 0 }}>×{e.n}</Tag>}
                    <Tooltip title="复制（不填入）">
                      <Button
                        size="small"
                        type="text"
                        aria-label="复制这条命令（不填入终端）"
                        icon={<CopyOutlined />}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          navigator.clipboard.writeText(e.cmd).catch(() => {});
                          message.success("已复制");
                        }}
                      />
                    </Tooltip>
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ago(e.at)} · {line.text} · {e.source}
                  </Typography.Text>
                </div>
              );
            })
          )}
        </div>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {total} 条（上限 {HISTORY_LIMIT}）· 点击即填入终端、不执行 · 口令类参数落盘前已脱敏
          </Typography.Text>
          <Popconfirm
            title="清空本机命令历史？"
            description="只影响本地历史，不影响审计日志。"
            okText="清空"
            okButtonProps={{ danger: true }}
            onConfirm={() => {
              clearHistory();
              setQuery("");
              setHost(undefined);
              setTick((t) => t + 1);
              message.success("已清空命令历史");
            }}
          >
            <Button size="small" danger icon={<ClearOutlined />}>
              清空
            </Button>
          </Popconfirm>
        </Space>
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
        <ThunderboltOutlined /> 历史只记录真的落地过 PTY 的命令；被危险网关拒绝的那些不在这里，它们进审计日志。
      </Typography.Text>
    </Modal>
  );
}
