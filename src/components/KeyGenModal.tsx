import { useState } from "react";
import { Modal, Select, Input, Button, Space, message, theme, Typography } from "antd";
import { KeyOutlined, CopyOutlined, SaveOutlined, FolderOpenOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";

const { TextArea } = Input;
const { Text } = Typography;

interface KeyGenResult {
  success: boolean;
  public_key?: string;
  private_key?: string;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function KeyGenModal({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const [keyType, setKeyType] = useState<string>("ed25519");
  const [keySize, setKeySize] = useState<number>(4096);
  const [passphrase, setPassphrase] = useState("");
  const [generating, setGenerating] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await invoke<KeyGenResult>("ssh_generate_keypair", {
        keyType,
        keySize: keyType === "rsa" ? keySize : undefined,
        passphrase: passphrase || undefined,
      });
      if (result.success) {
        setPublicKey(result.public_key || "");
        setPrivateKey(result.private_key || "");
        message.success("密钥对生成成功");
      } else {
        message.error(result.error || "生成密钥失败");
      }
    } catch (e) {
      message.error(`生成密钥失败: ${e}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyPublic = () => {
    navigator.clipboard.writeText(publicKey).then(() => {
      message.success("公钥已复制到剪贴板");
    }).catch(() => {
      message.error("复制失败");
    });
  };

  const handleSavePrivateToFile = async () => {
    try {
      const filePath = await save({
        defaultPath: keyType === "ed25519" ? "id_ed25519" : "id_rsa",
        filters: [{ name: "所有文件", extensions: ["*"] }],
      });
      if (filePath) {
        const encoder = new TextEncoder();
        await writeFile(filePath, encoder.encode(privateKey));
        message.success("私钥已保存");
      }
    } catch (e) {
      message.error(`保存失败: ${e}`);
    }
  };

  const handleSaveToSshDir = async () => {
    try {
      const home = await homeDir();
      const sshDir = `${home}.ssh`;
      const pubFileName = keyType === "ed25519" ? "id_ed25519.pub" : "id_rsa.pub";
      const privFileName = keyType === "ed25519" ? "id_ed25519" : "id_rsa";

      // Ensure .ssh directory exists
      if (!(await exists(sshDir))) {
        await mkdir(sshDir);
      }

      const encoder = new TextEncoder();
      await writeFile(`${sshDir}/${privFileName}`, encoder.encode(privateKey));
      await writeFile(`${sshDir}/${pubFileName}`, encoder.encode(publicKey));
      message.success(`密钥已保存到 ${sshDir}/`);
    } catch (e) {
      message.error(`保存到 ~/.ssh/ 失败: ${e}`);
    }
  };

  const handleClose = () => {
    setPublicKey("");
    setPrivateKey("");
    setPassphrase("");
    setKeyType("ed25519");
    setKeySize(4096);
    onClose();
  };

  return (
    <Modal
      title={
        <Space>
          <KeyOutlined />
          生成 SSH 密钥
        </Space>
      }
      open={open}
      onCancel={handleClose}
      footer={<Button onClick={handleClose}>关闭</Button>}
      width={560}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>
              密钥类型
            </Text>
            <Select
              value={keyType}
              onChange={setKeyType}
              style={{ width: "100%" }}
              options={[
                { value: "ed25519", label: "Ed25519 (推荐)" },
                { value: "rsa", label: "RSA" },
              ]}
            />
          </div>
          {keyType === "rsa" && (
            <div style={{ flex: 1 }}>
              <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>
                密钥长度
              </Text>
              <Select
                value={keySize}
                onChange={setKeySize}
                style={{ width: "100%" }}
                options={[
                  { value: 2048, label: "2048" },
                  { value: 4096, label: "4096" },
                ]}
              />
            </div>
          )}
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: "block" }}>
            密码短语 (可选)
          </Text>
          <Input.Password
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="留空则无密码保护"
          />
        </div>

        <Button
          type="primary"
          icon={<KeyOutlined />}
          onClick={handleGenerate}
          loading={generating}
          block
        >
          生成密钥对
        </Button>

        {publicKey && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>公钥</Text>
              <Button size="small" type="link" icon={<CopyOutlined />} onClick={handleCopyPublic}>
                复制
              </Button>
            </div>
            <TextArea
              value={publicKey}
              readOnly
              rows={3}
              style={{ fontFamily: "monospace", fontSize: 12, background: token.colorBgLayout }}
            />
          </div>
        )}

        {privateKey && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>私钥</Text>
              <Space size={4}>
                <Button size="small" type="link" icon={<SaveOutlined />} onClick={handleSavePrivateToFile}>
                  保存到文件
                </Button>
                <Button size="small" type="link" icon={<FolderOpenOutlined />} onClick={handleSaveToSshDir}>
                  保存到 ~/.ssh/
                </Button>
              </Space>
            </div>
            <TextArea
              value={privateKey}
              readOnly
              rows={5}
              style={{ fontFamily: "monospace", fontSize: 12, background: token.colorBgLayout }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
