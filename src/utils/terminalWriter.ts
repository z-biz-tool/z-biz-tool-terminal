/**
 * xterm 写入的合并/背压包装（T-3-3）。
 *
 * `term.write()` 是异步入队的：上一帧还没画完就继续 write，只会让 xterm 内部队列越堆越长，
 * 主线程被一串小 write 拖住。这里改成回调驱动——同一时刻只在途一次 write，两次回调之间
 * 到达的小块拼成一次下发，既不丢字节也保持顺序。
 */

export interface WriteTarget {
  write(data: string, callback?: () => void): void;
}

export interface BackpressuredWriter {
  push(data: string): void;
  /** 已合并、尚未交给 xterm 的字符数 */
  queued(): number;
  dispose(): void;
}

export function createBackpressuredWriter(target: WriteTarget): BackpressuredWriter {
  let pending = "";
  let writing = false;
  let disposed = false;

  const drain = () => {
    if (disposed || writing || !pending) return;
    const chunk = pending;
    pending = "";
    writing = true;
    target.write(chunk, () => {
      writing = false;
      drain();
    });
  };

  return {
    push(data: string) {
      if (disposed || !data) return;
      pending += data;
      drain();
    },
    queued() {
      return pending.length;
    },
    dispose() {
      disposed = true;
      pending = "";
    },
  };
}
