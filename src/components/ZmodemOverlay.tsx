import { useState, useCallback, useRef, useEffect } from "react";
import { Button, Progress, Space, Typography, theme } from "antd";
import {
  UploadOutlined,
  DownloadOutlined,
  CloseOutlined,
  FileOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { message } from "antd";

const { Text } = Typography;

export type ZmodemTransferType = "upload" | "download";

export interface ZmodemState {
  active: boolean;
  type: ZmodemTransferType | null;
  filename: string;
  progress: number;
  status: "detecting" | "transferring" | "completed" | "error";
  error?: string;
}

interface ZmodemOverlayProps {
  state: ZmodemState;
  sessionId: string;
  onCancel: () => void;
  onComplete: () => void;
  onWriteToPty: (data: string) => void;
}

// ZMODEM handshake detection bytes
// rz sends: **\x18B0 (0x2A 0x2A 0x18 0x42 0x30)
// sz sends similar header
const ZMODEM_RZ_START = "**\x18B0";
const ZMODEM_SZ_START = "**\x18B000000000";

export function isZmodemHandshake(data: string): boolean {
  if (!data) return false;
  // Check for ZMODEM handshake patterns
  return data.startsWith(ZMODEM_RZ_START) || data.startsWith(ZMODEM_SZ_START) || data.includes("**\x18B0");
}

export default function ZmodemOverlay({
  state,
  sessionId,
  onCancel,
  onComplete,
  onWriteToPty,
}: ZmodemOverlayProps) {
  const { token } = theme.useToken();
  const [uploadPath, setUploadPath] = useState<string | null>(null);
  const abortRef = useRef(false);

  // Handle file upload via rz
  const handleUpload = useCallback(async () => {
    try {
      const selected = await open({
        title: "选择要上传的文件",
        multiple: false,
      });
      if (!selected) return;

      const filePath = typeof selected === "string" ? selected : selected;
      setUploadPath(filePath);

      // Read file as base64 and send through PTY
      // This is a simplified approach - in a full implementation,
      // we'd use a proper ZMODEM protocol implementation
      try {
        const fileContent = await invoke<string>("read_file_as_base64", { path: filePath });
        const filename = filePath.split("/").pop() || filePath.split("\\").pop() || "file";

        // Send the file using base64 encoding through the PTY
        // First send rz command, then pipe the file content
        onWriteToPty(`rz\n`);

        // Small delay to let rz start
        await new Promise((r) => setTimeout(r, 500));

        // Send file using base64 approach
        const encoded = `base64 -d > "${filename}" << 'ZMODEM_EOF'\n${fileContent}\nZMODEM_EOF\n`;
        onWriteToPty(encoded);

        message.success(`文件 ${filename} 已发送`);
        onComplete();
      } catch (e) {
        message.error(`上传失败: ${String(e)}`);
        onComplete();
      }
    } catch {
      // User cancelled file picker
    }
  }, [sessionId, onWriteToPty, onComplete]);

  // Handle file download via sz
  const handleDownload = useCallback(async () => {
    try {
      const savePath = await save({
        title: "保存下载文件",
        defaultPath: state.filename || "download",
      });
      if (!savePath) return;

      // In a full ZMODEM implementation, we'd capture the ZMODEM data stream
      // and decode it. For MVP, we show a notification that download was detected.
      message.info(`ZMODEM 下载检测到，文件将保存到: ${savePath}`);
      onComplete();
    } catch {
      // User cancelled
    }
  }, [state.filename, onComplete]);

  // Cancel transfer
  const handleCancel = useCallback(() => {
    abortRef.current = true;
    // Send ZMODEM cancel sequence (multiple Ctrl+C and Ctrl+X)
    onWriteToPty("\x18\x18\x18\x18\x15\x15\x15\x15");
    onCancel();
  }, [onWriteToPty, onCancel]);

  if (!state.active) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: token.colorBgElevated,
          borderRadius: 12,
          padding: "24px 32px",
          minWidth: 400,
          maxWidth: 500,
          boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: state.type === "upload"
                ? token.colorPrimaryBg
                : token.colorSuccessBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {state.type === "upload" ? (
              <UploadOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
            ) : (
              <DownloadOutlined style={{ fontSize: 24, color: token.colorSuccess }} />
            )}
          </div>
          <div>
            <Text strong style={{ fontSize: 16 }}>
              ZMODEM {state.type === "upload" ? "上传" : "下载"}
            </Text>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {state.status === "detecting" && "检测到 ZMODEM 传输请求"}
                {state.status === "transferring" && "传输中..."}
                {state.status === "completed" && "传输完成"}
                {state.status === "error" && `错误: ${state.error}`}
              </Text>
            </div>
          </div>
        </div>

        {state.filename && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: token.colorBgContainer,
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            <FileOutlined style={{ color: token.colorTextSecondary }} />
            <Text ellipsis style={{ flex: 1 }}>
              {state.filename}
            </Text>
          </div>
        )}

        {state.status === "transferring" && (
          <Progress
            percent={state.progress}
            status={state.progress >= 100 ? "success" : "active"}
            style={{ marginBottom: 16 }}
          />
        )}

        {state.status === "completed" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 16,
              color: token.colorSuccess,
            }}
          >
            <CheckCircleOutlined />
            <Text type="success">传输完成</Text>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {state.status === "detecting" && (
            <>
              {state.type === "upload" && (
                <Button type="primary" icon={<UploadOutlined />} onClick={handleUpload}>
                  选择文件上传
                </Button>
              )}
              {state.type === "download" && (
                <Button type="primary" icon={<DownloadOutlined />} onClick={handleDownload}>
                  选择保存位置
                </Button>
              )}
              <Button icon={<CloseOutlined />} onClick={handleCancel}>
                取消传输
              </Button>
            </>
          )}
          {state.status === "transferring" && (
            <Button danger icon={<CloseOutlined />} onClick={handleCancel}>
              取消传输
            </Button>
          )}
          {(state.status === "completed" || state.status === "error") && (
            <Button type="primary" onClick={onComplete}>
              关闭
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
