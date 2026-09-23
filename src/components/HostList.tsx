/**
 * 受影响主机清单（危险命令确认框、关闭会话确认框共用同一份渲染）。
 *
 * 两个确认框要回答的是同一个问题——"点下去会动到哪几台机"，所以生产机必须在这两处
 * 都是红字加粗、环境前缀必须是同一串写法。分头渲染迟早会漂成一边醒目一边淹没在列表里。
 */

import { Typography } from "antd";
import type { CSSProperties } from "react";
import { envListPrefix, isProd } from "../utils/environment";
import type { GuardTarget } from "./DangerConfirm";

export default function HostList({
  targets,
  style,
}: {
  targets: GuardTarget[];
  style?: CSSProperties;
}) {
  return (
    <ul
      style={{
        margin: "4px 0 0",
        paddingLeft: 18,
        maxHeight: 160,
        overflow: "auto",
        ...style,
      }}
    >
      {targets.map((t, i) => (
        <li key={`${t.host}-${i}`}>
          {isProd(t.environment) ? (
            <Typography.Text strong style={{ color: "#d4380d" }}>
              {envListPrefix(t.environment).trim()}{" "}
            </Typography.Text>
          ) : (
            envListPrefix(t.environment)
          )}
          {t.name} <Typography.Text code>{t.host}</Typography.Text>
        </li>
      ))}
    </ul>
  );
}
