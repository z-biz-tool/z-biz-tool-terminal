//! 安全审计日志（T-4-7）。
//!
//! 与终端会话日志分开：这里只记录"谁在什么时候对哪台主机做了什么决定"，
//! 体量小、只追加、默认脱敏，用于事后追责而不是排障。
//!
//! 写入是 best-effort：审计失败绝不能阻断用户操作（否则一次磁盘故障就让终端不可用），
//! 但会在 stderr 留下痕迹；网关被关掉、用户取消确认这类"没执行"的决定同样要记，
//! 否则日志就只剩下一份自我表扬的执行清单。

use serde_json::{Map, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// 审计文件上限，超过后滚动一代（audit.log -> audit.log.1）
const AUDIT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 单条记录的最大长度：前端可投递 detail，超长直接省略，避免审计被刷爆
const AUDIT_MAX_LINE_BYTES: usize = 8 * 1024;

/// 上次写入后已累计的字节数；usize::MAX 表示还没读过磁盘
static APPROX_SIZE: AtomicUsize = AtomicUsize::new(usize::MAX);

pub fn audit_log_path() -> PathBuf {
    crate::config::get_config_dir().join("audit.log")
}

/// 记一条审计。`detail` 里的所有字符串都会先过一遍脱敏规则（P-4）。
pub fn record(action: &str, detail: Value) {
    let mut fields = Map::new();
    fields.insert(
        "ts".into(),
        Value::String(chrono::Local::now().to_rfc3339()),
    );
    fields.insert("action".into(), Value::String(action.to_string()));
    match detail {
        Value::Object(obj) => {
            for (k, v) in obj {
                fields.insert(k, redact_value(v));
            }
        }
        Value::Null => {}
        other => {
            fields.insert("detail".into(), redact_value(other));
        }
    }
    let line = match serde_json::to_string(&Value::Object(fields)) {
        Ok(line) => line,
        Err(e) => {
            eprintln!("[audit] 序列化失败({}): {}", action, e);
            return;
        }
    };
    // 兜底：detail 字段太多/太长时只保留骨架，宁可少记内容也不让审计被单条撑爆
    let line = if line.len() > AUDIT_MAX_LINE_BYTES {
        let head: String = line.chars().take(AUDIT_MAX_LINE_BYTES).collect();
        serde_json::to_string(&serde_json::json!({
            "ts": chrono::Local::now().to_rfc3339(),
            "action": action,
            "truncated": true,
            "head": head,
        }))
        .unwrap_or_else(|_| format!("{{\"action\":\"{}\",\"truncated\":true}}", action))
    } else {
        line
    };

    let path = audit_log_path();
    if let Err(e) = write_line(&path, &line) {
        eprintln!("[audit] 写入失败({}): {}", action, e);
    } else {
        APPROX_SIZE.fetch_add(line.len() + 1, Ordering::Relaxed);
    }
}

fn write_line(path: &PathBuf, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rotate_if_oversized(path);

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")?;
    file.flush()?;
    // 审计里是命令原文（已脱敏），只允许属主读写
    crate::config::restrict_private(path);
    Ok(())
}

/// 体积超上限就滚成 `.1`，只保留一代，避免无界增长
fn rotate_if_oversized(path: &PathBuf) {
    let size = match APPROX_SIZE.load(Ordering::Relaxed) {
        usize::MAX => match std::fs::metadata(path) {
            Ok(meta) => meta.len() as usize,
            Err(_) => 0,
        },
        cached => cached,
    };
    if size <= AUDIT_MAX_BYTES {
        return;
    }
    let rolled = PathBuf::from(format!("{}.1", path.display()));
    if std::fs::rename(path, &rolled).is_ok() {
        APPROX_SIZE.store(0, Ordering::Relaxed);
    }
}

/// 递归脱敏：审计只留证据，不留凭证原文；单个字符串截到 512 字符
fn redact_value(value: Value) -> Value {
    const MAX_STRING_CHARS: usize = 512;
    match value {
        Value::String(s) => {
            let redacted = crate::redact::redact_once(&s);
            let mut chars = redacted.chars();
            let head: String = chars.by_ref().take(MAX_STRING_CHARS).collect();
            Value::String(if chars.next().is_some() {
                format!("{}…[截断]", head)
            } else {
                head
            })
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_value).collect()),
        Value::Object(obj) => {
            Value::Object(obj.into_iter().map(|(k, v)| (k, redact_value(v))).collect())
        }
        other => other,
    }
}

/// 单次查询/导出的记录上限
const AUDIT_QUERY_MAX: usize = 5000;

/// 读两代审计文件（旧→新）。滚动只保留一代，因此历史最多覆盖两份文件。
fn read_lines() -> Vec<String> {
    let dir = crate::config::get_config_dir();
    let mut out = Vec::new();
    for name in ["audit.log.1", "audit.log"] {
        if let Ok(content) = std::fs::read_to_string(dir.join(name)) {
            out.extend(
                content
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(str::to_string),
            );
        }
    }
    out
}

fn parse_records(lines: Vec<String>) -> Vec<Value> {
    lines
        .into_iter()
        // 单行损坏（极端并发写）不该让整份审计读不出来
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect()
}

/// 拉取审计记录，最新的在前（04 §4.9 合规回溯入口）。
#[tauri::command]
pub async fn audit_records(limit: Option<usize>) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(200).clamp(1, AUDIT_QUERY_MAX);
    Ok(parse_records(read_lines())
        .into_iter()
        .rev()
        .take(limit)
        .collect())
}

/// 导出审计为 JSON（默认）或 CSV，供合规留存。
///
/// 目标路径走与文件读取同一套白名单（T-4-4），导出动作本身也会写进审计。
#[tauri::command]
pub async fn audit_export(path: String, format: Option<String>) -> Result<String, String> {
    let target = crate::paths::resolve_for_write(&path)?;
    let records = parse_records(read_lines());
    let csv = format.as_deref() == Some("csv");
    let content = if csv {
        to_csv(&records)
    } else {
        serde_json::to_string_pretty(&records).map_err(|e| format!("序列化失败: {}", e))?
    };
    std::fs::write(&target, content).map_err(|e| format!("写入失败: {}", e))?;
    crate::config::restrict_private(&target);
    record(
        "audit_export",
        serde_json::json!({
            "path": target.display().to_string(),
            "format": if csv { "csv" } else { "json" },
            "records": records.len(),
        }),
    );
    Ok(format!("已导出 {} 条审计记录", records.len()))
}

/// 拍平成 CSV：表头取所有记录的字段并集，单元格去掉换行避免记录串行。
fn to_csv(records: &[Value]) -> String {
    let mut headers: Vec<String> = Vec::new();
    for record in records {
        if let Value::Object(obj) = record {
            for key in obj.keys() {
                if !headers.contains(key) {
                    headers.push(key.clone());
                }
            }
        }
    }
    headers.sort();
    // BOM：Excel 没有它就按本地代码页解读中文列名
    let mut out = String::from("\u{feff}");
    out.push_str(
        &headers
            .iter()
            .map(|h| csv_cell(h))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for record in records {
        let row: Vec<String> = headers
            .iter()
            .map(|key| {
                let value = record.get(key).cloned().unwrap_or(Value::Null);
                match value {
                    Value::String(s) => csv_cell(&s),
                    Value::Null => String::new(),
                    other => csv_cell(&other.to_string()),
                }
            })
            .collect();
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// CSV 注入防护：以公式前缀开头的单元格前置 `'`，否则 Excel 会把命令原文当公式执行。
fn csv_cell(raw: &str) -> String {
    let guarded = match raw.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') => format!("'{}", raw),
        _ => raw.to_string(),
    };
    let single_line = guarded.replace('\n', " ").replace('\r', " ");
    format!("\"{}\"", single_line.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// 改环境变量与进程内计数，必须和 config 侧测试共用同一把串行锁
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        crate::config::lock_config_dir_env()
    }

    fn isolated_dir(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "z-terminal-audit-{}-{}-{}",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("临时目录可创建");
        std::env::set_var("Z_TERMINAL_CONFIG_DIR", &dir);
        APPROX_SIZE.store(usize::MAX, Ordering::Relaxed);
        dir
    }

    fn read_records(path: &PathBuf) -> Vec<Value> {
        let content = std::fs::read_to_string(path).expect("审计文件应可读");
        content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("每条审计必须是单行合法 JSON"))
            .collect()
    }

    #[test]
    fn record_appends_single_line_json_with_ts_and_action() {
        let _guard = lock_env();
        let dir = isolated_dir("append");
        record(
            "command_gate",
            json!({"command": "ls -la", "level": "safe"}),
        );
        record(
            "host_key",
            json!({"host": "10.0.0.1", "decision": "trusted"}),
        );

        let path = dir.join("audit.log");
        let records = read_records(&path);
        assert_eq!(records.len(), 2, "两次记录应各占一行");
        assert_eq!(records[0]["action"], "command_gate");
        assert_eq!(records[1]["action"], "host_key");
        assert_eq!(records[1]["decision"], "trusted", "detail 字段应平铺进记录");
        assert!(
            records[0]["ts"].as_str().unwrap().contains('-'),
            "应带时间戳"
        );

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_redacts_secrets_in_nested_detail() {
        let _guard = lock_env();
        let dir = isolated_dir("redact");
        record(
            "exec",
            json!({
                "command": "mysql -u root -p Sup3rS3cret db",
                "targets": [{"host": "api_key: leaked-key-value"}],
                "output_bytes": 12
            }),
        );

        let raw = std::fs::read_to_string(dir.join("audit.log")).expect("审计文件应可读");
        assert!(
            !raw.contains("Sup3rS3cret") && !raw.contains("leaked-key-value"),
            "凭证不得进入审计: {}",
            raw
        );
        let records = read_records(&dir.join("audit.log"));
        assert_eq!(records[0]["output_bytes"], 12, "数值字段不该被当成敏感串");
        assert!(records[0]["command"].as_str().unwrap().contains("mysql"));

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_survives_newlines_without_forging_extra_lines() {
        let _guard = lock_env();
        let dir = isolated_dir("newline");
        // 命令里塞换行 + 一段伪造记录：必须被 JSON 转义关在同一个字符串里
        record(
            "command_gate",
            json!({"command": "rm -rf /\n{\"action\":\"innocent\",\"ts\":\"x\"}"}),
        );
        let path = dir.join("audit.log");
        let records = read_records(&path);
        assert_eq!(records.len(), 1, "换行不得伪造出第二条记录");
        assert_eq!(records[0]["action"], "command_gate");

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_log_rolls_to_single_backup() {
        let _guard = lock_env();
        let dir = isolated_dir("rotate");
        let path = dir.join("audit.log");
        std::fs::write(&path, vec![b'x'; AUDIT_MAX_BYTES + 1]).expect("预置超大审计文件失败");
        APPROX_SIZE.store(usize::MAX, Ordering::Relaxed);

        record("command_gate", json!({"command": "id"}));

        assert!(
            PathBuf::from(format!("{}.1", path.display())).exists(),
            "超限后应滚动一代"
        );
        let records = read_records(&path);
        assert_eq!(records.len(), 1, "滚动后的新文件只含本次记录");

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn audit_file_is_owner_only() {
        let _guard = lock_env();
        let dir = isolated_dir("perm");
        record("export", json!({"path": "/tmp/x.json"}));
        let path = dir.join("audit.log");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "审计文件权限应为 0600");
        }
        #[cfg(not(unix))]
        let _ = &path;

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn records_return_newest_first_and_export_leaves_trail() {
        let _guard = lock_env();
        let dir = isolated_dir("export");
        record("command_gate", json!({"command": "ls", "level": "safe"}));
        record(
            "ssh_execute",
            json!({"command": "=HYPERLINK(x)", "confirmed": true}),
        );

        let records = audit_records(Some(10)).await.unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["action"], "ssh_execute", "最新记录应排在最前");

        let csv_path = dir.join("audit-export.csv");
        let message = audit_export(csv_path.display().to_string(), Some("csv".into()))
            .await
            .unwrap();
        assert!(message.contains('2'), "应回报导出条数: {}", message);
        let csv = std::fs::read_to_string(&csv_path).expect("CSV 应已写出");
        assert!(csv.starts_with('\u{feff}'), "CSV 需带 BOM 供 Excel 识别");
        assert!(
            csv.contains("\"'=HYPERLINK"),
            "公式前缀单元格必须转义: {}",
            csv
        );
        assert_eq!(csv.lines().count(), 3, "表头 + 2 条记录，不得多出换行");

        // 导出这个动作本身也要留痕
        let after = audit_records(Some(1)).await.unwrap();
        assert_eq!(after[0]["action"], "audit_export");

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn export_refuses_paths_outside_whitelist() {
        let _guard = lock_env();
        let dir = isolated_dir("export-guard");
        record("command_gate", json!({"command": "id"}));

        let error = audit_export("/etc/audit-leak.json".into(), None)
            .await
            .expect_err("白名单外路径必须被拒绝");
        assert!(
            error.contains("目录"),
            "错误信息要说明受限于白名单: {}",
            error
        );
        assert!(
            !std::path::Path::new("/etc/audit-leak.json").exists(),
            "拒绝发生在写入之前"
        );

        std::env::remove_var("Z_TERMINAL_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
