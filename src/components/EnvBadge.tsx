import { Tooltip } from "antd";
import { envMeta } from "../utils/environment";

/**
 * 环境徽标（T-5-2）：侧栏与标签页共用一份视觉，避免两处颜色/字号漂移。
 *
 * 未标注的主机一个像素都不占：存量配置普遍没有这个字段，
 * 给整列加"未知环境"只会把真正的生产标记淹没在噪声里。
 */
export default function EnvBadge({ raw, compact }: { raw?: string; compact?: boolean }) {
  const meta = envMeta(raw);
  if (!meta) return null;
  return (
    <Tooltip title={meta.label}>
      <span
        style={{
          fontSize: compact ? 9 : 10,
          lineHeight: compact ? "13px" : "14px",
          padding: compact ? "0 3px" : "0 4px",
          borderRadius: 3,
          fontWeight: 700,
          letterSpacing: 0.3,
          color: "#fff",
          background: meta.color,
          flexShrink: 0,
        }}
      >
        {meta.short}
      </span>
    </Tooltip>
  );
}
