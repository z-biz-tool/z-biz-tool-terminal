import { useEffect, useState } from "react";

/**
 * 每秒取一次"现在"，只在真的在倒数时才挂定时器。
 *
 * 倒计时文案必须由同一个时钟驱动：面板上的提示和顶部状态条如果各算各的，
 * 会出现同一句话在两个地方写着不同秒数 —— 那是新缺陷，不是信息。
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}
