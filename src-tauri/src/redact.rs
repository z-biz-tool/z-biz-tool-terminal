//! 会话日志脱敏（P-4：密钥/凭证不得泄漏到日志）。
//!
//! 终端输出按任意边界分块到达，因此这里按行缓冲处理：只有遇到 `\n` 才判定，
//! 未完成的行尾保留到下一块。PEM 私钥块用状态机跨行吞掉，避免半截私钥落盘。


/// 需要整体抹掉价值内容的敏感键名（不区分大小写）
const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "passphrase",
    "token",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "secret",
    "client_secret",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
    "privatekey",
    "aws_secret_access_key",
    "credentials",
];

const REDACTED: &str = "***";

/// 单个会话的脱敏状态
#[derive(Default)]
pub struct LogRedactor {
    /// 未完成的行尾缓冲
    pending: String,
    /// 是否处于 PEM 私钥块内部
    in_key_block: bool,
}

impl LogRedactor {
    /// 处理一段输出，返回可安全落盘的文本。
    pub fn push(&mut self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        // 先剥掉 ANSI 转义序列，避免用彩色转义把敏感串切开绕过规则
        let cleaned = strip_ansi(text);
        self.pending.push_str(&cleaned);

        while let Some(pos) = self.pending.find('\n') {
            let line = self.pending[..pos].to_string();
            self.pending.drain(..=pos);
            out.push_str(&self.redact_line(&line));
            out.push('\n');
        }
        out
    }

    fn redact_line(&mut self, line: &str) -> String {
        if self.in_key_block {
            if contains_ignore_case(line, "-----end") && contains_ignore_case(line, "private key") {
                self.in_key_block = false;
                return format!("{} [私钥块结束已脱敏]", REDACTED);
            }
            return String::new();
        }
        if is_private_key_begin(line) {
            self.in_key_block = true;
            return format!("{} [检测到私钥块，内容已脱敏]", line.trim());
        }

        let mut result = mask_secret_assignments(line);
        result = mask_bearer_tokens(&result);
        result = mask_url_credentials(&result);
        result = mask_cli_password_flags(&result);
        mask_public_key_blobs(&result)
    }

    /// 会话结束时把残留的行尾冲刷掉（不再等待换行）
    pub fn flush(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let tail = std::mem::take(&mut self.pending);
        self.redact_line(&tail)
    }
}

/// 无状态便捷入口（测试与一次性文本脱敏用）
#[cfg(test)]
pub fn redact_once(text: &str) -> String {
    let mut r = LogRedactor::default();
    let mut out = r.push(text);
    out.push_str(&r.flush());
    out
}

fn is_private_key_begin(line: &str) -> bool {
    let up = line.to_ascii_uppercase();
    up.contains("BEGIN ") && (up.contains("PRIVATE KEY") || up.contains("OPENSSH PRIVATE KEY"))
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

/// 剥除 ANSI CSI / OSC 转义序列。
///
/// 终端输出中 `\x1b[31m` 之类会打断关键词（例如 `pas\x1b[Xmsword=`），
/// 因此脱敏必须在剥离之后进行，落盘时保留可读文本即可。
pub fn strip_ansi(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            // ESC [ ... m  /  ESC ] ... BEL/ST  /  ESC + 单字符
            if i + 1 < bytes.len() {
                match bytes[i + 1] {
                    b'[' => {
                        let mut j = i + 2;
                        while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                            j += 1;
                        }
                        i = j + 1;
                        continue;
                    }
                    b']' => {
                        let mut j = i + 2;
                        while j < bytes.len() && bytes[j] != 0x07 && bytes[j] != 0x1b {
                            j += 1;
                        }
                        i = j + 1;
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            }
            i += 1;
            continue;
        }
        // UTF-8 安全：逐字节推进可能切开多字节字符，这里用原始切片再合并
        let ch_len = utf8_len(bytes[i]);
        let end = (i + ch_len).min(bytes.len());
        if let Ok(s) = std::str::from_utf8(&bytes[i..end]) {
            out.push_str(s);
        }
        i = end;
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// `key = value` / `key: value` / `key=value` 形式的敏感键。
///
/// 按 char 索引扫描，替换后从头重扫（最多 8 轮），避免字节偏移错位与漏扫。
fn mask_secret_assignments(line: &str) -> String {
    let mut current = line.to_string();
    for _ in 0..8 {
        match mask_one_assignment(&current) {
            Some(replaced) => current = replaced,
            None => break,
        }
    }
    current
}

/// 找到第一处 `敏感键 <分隔> 值` 并替换其值；没有命中返回 None
fn mask_one_assignment(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let lower: String = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    let lower = lower.as_str();

    for key in SECRET_KEYS {
        let kb = key.as_bytes();
        let mut from = 0usize;
        while let Some(rel) = find_sub(lower[from..].as_bytes(), kb) {
            let start = from + rel;
            let end = start + kb.len();
            let before_ok = start == 0 || !is_word_char(chars[start - 1]);
            let after_ok = end >= chars.len()
                || !is_word_char(chars[end])
                || chars[end] == '_'
                || chars[end] == '-';
            if !before_ok || !after_ok {
                from = end;
                continue;
            }
            let mut cursor = end;
            // JSON 形态的 "key":"value" —— 分隔符前允许一个收尾引号
            if matches!(chars.get(cursor), Some('"') | Some('\'')) {
                cursor += 1;
            }
            cursor = skip_spaces(&chars, cursor);
            let sep = if chars.get(cursor..cursor + 2) == Some(&['=', '='][..]) {
                2
            } else if matches!(chars.get(cursor), Some('=') | Some(':')) {
                1
            } else {
                from = end;
                continue;
            };
            let value_start = skip_spaces(&chars, cursor + sep);
            if value_start >= chars.len() {
                from = end;
                continue;
            }
            let value_end = match chars[value_start] {
                q @ ('"' | '\'' | '`') => {
                    let mut i = value_start + 1;
                    while i < chars.len() && chars[i] != q {
                        i += 1;
                    }
                    i
                }
                _ => {
                    let mut i = value_start;
                    while i < chars.len()
                        && !chars[i].is_whitespace()
                        && !matches!(chars[i], ',' | ';' | '}' | ']' | '"' | '\'')
                    {
                        i += 1;
                    }
                    i
                }
            };
            if value_end <= value_start {
                from = end;
                continue;
            }
            let mut out: String = chars[..value_start].iter().collect();
            out.push_str(REDACTED);
            out.extend(chars[value_end..].iter());
            return Some(out);
        }
    }
    None
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn skip_spaces(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
        i += 1;
    }
    i
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `Bearer xxx` / `Basic xxx`
fn mask_bearer_tokens(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let lower: String = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let matched = ["bearer ", "basic "]
            .iter()
            .find(|n| lower[i..].starts_with(*n) && (i == 0 || !is_word_char(chars[i - 1])));
        match matched {
            Some(needle) => {
                let n = needle.chars().count();
                out.extend(&chars[i..i + n]);
                let value_start = skip_spaces(&chars, i + n);
                let mut value_end = value_start;
                while value_end < chars.len() && !chars[value_end].is_whitespace() {
                    value_end += 1;
                }
                if value_end > value_start {
                    out.extend(REDACTED.chars());
                }
                i = value_end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out.into_iter().collect()
}

/// `scheme://user:password@host`
fn mask_url_credentials(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut out: Vec<char> = Vec::with_capacity(chars.len());
    while i < chars.len() {
        if chars[i] == ':' && chars.get(i + 1) == Some(&'/') && chars.get(i + 2) == Some(&'/') {
            let mut end = i;
            while end > 0 && !chars[end - 1].is_whitespace() {
                end -= 1;
            }
            let authority_start = i + 3;
            let mut authority_end = authority_start;
            while authority_end < chars.len()
                && !chars[authority_end].is_whitespace()
                && !matches!(chars[authority_end], '/' | '?' | '#')
            {
                authority_end += 1;
            }
            let authority = &chars[authority_start..authority_end];
            // 先定位 userinfo 与 host 的分界 '@'，再取 '@' 之前的 ':'，
            // 否则 host 端口里的冒号会被当成密码分隔符
            let at = authority.iter().rposition(|c| *c == '@').and_then(|at| {
                authority[..at]
                    .iter()
                    .rposition(|c| *c == ':')
                    .map(|colon| (colon, at))
            });
            out.truncate(end);
            out.extend(&chars[end..authority_start]);
            if let Some((colon, at)) = at {
                out.extend(&authority[..colon]);
                out.push(':');
                out.extend(REDACTED.chars());
                out.push('@');
                out.extend(&authority[(at + 1)..]);
            } else {
                out.extend(authority.iter());
            }
            i = authority_end;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out.into_iter().collect()
}

/// `mysql -pSecret` / `--password=Secret` / `mysql -p Secret`
fn mask_cli_password_flags(line: &str) -> String {
    let mut current = line.to_string();
    for _ in 0..8 {
        match mask_cli_password_once(&current) {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    current
}

fn mask_cli_password_once(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();

    for flag in [
        "--password=", "--passwd=", "--pass=", "--token=", "--api-key=", "--apikey=",
    ] {
        let fb: Vec<char> = flag.chars().collect();
        if let Some(rel) = find_sub_chars(&lower, &fb) {
            let value_start = rel + fb.len();
            let mut value_end = value_start;
            while value_end < chars.len() && !chars[value_end].is_whitespace() {
                value_end += 1;
            }
            if value_end > value_start && !is_already_redacted(&chars, value_start, value_end) {
                let mut out: String = chars[..value_start].iter().collect();
                out.push_str(REDACTED);
                out.extend(chars[value_end..].iter());
                return Some(out);
            }
        }
    }

    // `-p<secret>` / `-p <secret>` 只有在使用方确实是接受口令的 CLI 时才启用，
    // 否则会把 `grep -pattern` 之类的普通参数当成口令打掉。
    let lower_str: String = lower.iter().collect();
    if !MENTIONS_CREDENTIAL_CLI.iter().any(|c| lower_str.contains(*c)) {
        return None;
    }
    let mut i = 0;
    while i + 2 < chars.len() {
        if chars[i] == ' ' && chars[i + 1] == '-' && chars.get(i + 2) == Some(&'p') {
            let after = i + 3;
            let value_start = skip_spaces(&chars, after);
            let mut value_end = value_start;
            while value_end < chars.len() && !chars[value_end].is_whitespace() {
                value_end += 1;
            }
            let attached = value_start == after;
            let worth_masking = value_end > value_start
                && (attached || chars[after] == ' ')
                && chars[value_start] != '-'
                && !is_already_redacted(&chars, value_start, value_end);
            if worth_masking {
                let mut out: String = chars[..value_start].iter().collect();
                out.push_str(REDACTED);
                out.extend(chars[value_end..].iter());
                return Some(out);
            }
        }
        i += 1;
    }
    None
}

fn is_already_redacted(chars: &[char], start: usize, end: usize) -> bool {
    let red: Vec<char> = REDACTED.chars().collect();
    chars.get(start..end) == Some(&red[..])
}

/// 接受明文口令参数的命令行工具
const MENTIONS_CREDENTIAL_CLI: &[&str] = &[
    "mysql", "mysqldump", "mysqladmin", "psql", "pg_dump", "redis-cli", "sshpass", "ldapsearch",
    "ssh ", "scp ", "sftp ", "curl -u", "wget --password",
];

fn find_sub_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if hay.len() < needle.len() || needle.is_empty() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// `ssh-ed25519 AAAA...` / `ssh-rsa AAAA...` 之类的公钥整行
fn mask_public_key_blobs(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for prefix in ["ssh-rsa ", "ssh-ed25519 ", "ecdsa-sha2-", "ssh-dss "] {
        if lower.contains(prefix) {
            if let Some(rel) = lower.find(prefix) {
                let value_start = rel + prefix.len();
                let blob = line[value_start..].trim_start().split_whitespace().next().unwrap_or("");
                if looks_like_base64(blob) {
                    let cut = value_start + (line[value_start..].len() - line[value_start..].trim_start().len());
                    let mut out = line[..cut].to_string();
                    out.push_str(REDACTED);
                    return out;
                }
            }
        }
    }
    line.to_string()
}

fn looks_like_base64(s: &str) -> bool {
    s.len() >= 24 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' || b == b' ')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_escapes() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("a\x1b]0;title\x07b"), "ab");
        assert_eq!(strip_ansi("中文 \u{1b}[1Mbold"), "中文 bold");
    }

    #[test]
    fn ansi_split_keyword_still_redacted() {
        // pas\x1b[Xmsword= 若先脱敏再剥色会漏掉，这里顺序正确
        let out = redact_once("pass\x1b[31mword=SuperSecret123\n");
        assert!(!out.contains("SuperSecret123"), "got: {}", out);
    }

    #[test]
    fn masks_key_value_assignments() {
        for case in [
            ("Password: hunter2", "hunter2"),
            ("export API_KEY=sk-live-abcdef123456", "sk-live-abcdef123456"),
            ("client_secret = \"quoted-secret\"", "quoted-secret"),
            ("token: mytoken123 tail", "mytoken123"),
            ("\"password\":\"p@ssw0rd!\"", "p@ssw0rd!"),
        ] {
            let out = redact_once(case.0);
            assert!(!out.contains(case.1), "leaked {:?} -> {:?}", case.0, out);
        }
    }

    #[test]
    fn masks_bearer_and_url_credentials() {
        let a = redact_once("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
        assert!(!a.contains("eyJhbGciOiJIUzI1NiJ9"), "got {}", a);
        let b = redact_once("postgres://app:S3cr3t@db.internal:5432/prod");
        assert!(!b.contains("S3cr3t"), "got {}", b);
        assert!(b.contains("app:"), "用户名应保留以便定位: {}", b);
    }

    #[test]
    fn masks_cli_password_flags() {
        for case in [
            "mysql -u root -pTopSecret db",
            "mysql -u root -p TopSecret db",
            "mysqldump --password=TopSecret db",
        ] {
            let out = redact_once(case);
            assert!(!out.contains("TopSecret"), "leaked {:?} -> {:?}", case, out);
        }
        // -p 后跟普通参数不应误伤
        let keep = redact_once("grep -pattern file.txt");
        assert!(keep.contains("-pattern"), "误伤: {}", keep);
    }

    #[test]
    fn swallows_pem_private_key_block_across_chunks() {
        let mut r = LogRedactor::default();
        let chunk1 = "before\ncat id_rsa\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n";
        let chunk2 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter\n";
        let out = format!("{}{}", r.push(chunk1), {
            let t = r.push(chunk2);
            t
        });
        assert!(!out.contains("b3BlbnNzaC1rZXktdjEA"), "私钥正文泄漏: {}", out);
        assert!(!out.contains("AAAAAA"), "私钥正文泄漏: {}", out);
        assert!(out.contains("before"), "正常内容应保留: {}", out);
        assert!(out.contains("after"), "块结束后应恢复: {}", out);
    }

    #[test]
    fn partial_line_waits_for_newline() {
        let mut r = LogRedactor::default();
        let a = r.push("passwor");
        let b = r.push("d=abc");
        assert_eq!(a, "");
        assert_eq!(b, "");
        let c = r.push("\n");
        assert!(!c.contains("abc"), "补轮换行后应脱敏: {}", c);
    }

    #[test]
    fn flush_emits_trailing_partial_line_redacted() {
        let mut r = LogRedactor::default();
        let _ = r.push("password=tailsecret");
        let tail = r.flush();
        assert!(!tail.contains("tailsecret"), "got {}", tail);
        assert!(tail.contains("password"), "键名应保留: {}", tail);
    }

    #[test]
    fn masks_public_key_blob_lines() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExample user@host";
        let out = redact_once(line);
        assert!(!out.contains("AAAAC3NzaC1lZDI1NTE5"), "got {}", out);
    }

    #[test]
    fn benign_output_untouched() {
        for case in [
            "total 48\ndrwxr-xr-x  6 root root 4096 Sep 1 12:00 .\n",
            "git commit -m \"fix: pass tests\"\n",
            "export PATH=$PATH:/usr/local/bin\n",
        ] {
            assert_eq!(redact_once(case), case, "不应改写: {:?}", case);
        }
    }
}
