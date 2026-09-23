//! T-4-4：前端可访问的本地文件路径白名单。
//!
//! 前端拿到路径只有两条来路：原生对话框选中的文件、SFTP 下载落到临时目录。
//! 两者都落在「家目录」或「系统临时目录」内，所以把这两处作为唯一允许根，
//! `/etc`、他人 home、`..` 逃逸一律拒绝。判定以 canonicalize 之后的真实路径为准，
//! 因此指向白名单外的符号链接同样会被挡下。
//!
//! 范式沿用 `config.rs::read_session_log`（canonicalize + starts_with）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// 允许读写根。逐项在判定时 canonicalize（macOS 上 `/var` 实际是 `/private/var`）。
fn allowed_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.push(home);
    }
    roots
}

fn within_roots(canonical: &Path) -> bool {
    allowed_roots()
        .iter()
        .filter_map(|r| r.canonicalize().ok())
        .any(|r| canonical.starts_with(&r))
}

fn reject_traversal(raw: &Path) -> Result<(), String> {
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("路径不允许包含 ..".into());
    }
    Ok(())
}

fn describe(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// 读取/打开已存在的文件：必须落在白名单内
pub fn resolve_existing(path: &str) -> Result<PathBuf, String> {
    resolve_entry(path, false)
}

/// 同上，但允许目录（"在访达中打开配置目录"这类需求）
pub fn resolve_existing_any(path: &str) -> Result<PathBuf, String> {
    resolve_entry(path, true)
}

fn resolve_entry(path: &str, allow_dir: bool) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    let raw = PathBuf::from(path);
    reject_traversal(&raw)?;
    let canonical = raw
        .canonicalize()
        .map_err(|_| "文件不存在或路径无效".to_string())?;
    if !canonical.is_file() && !(allow_dir && canonical.is_dir()) {
        return Err("目标不是文件".into());
    }
    if !within_roots(&canonical) {
        return Err(format!(
            "路径不在允许的目录内（仅限家目录与临时目录）: {}",
            describe(&canonical)
        ));
    }
    Ok(canonical)
}

/// 写入目标（允许文件尚不存在）：按最近的已存在祖先判定
///
/// 只回答"这个位置允不允许写"，**不建目录** —— 要连父目录一起备好请用 [`prepare_write`]。
pub fn resolve_for_write(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".into());
    }
    let raw = PathBuf::from(path);
    reject_traversal(&raw)?;
    let file_name = raw.file_name().ok_or("路径必须指向一个文件")?;
    // 往上找到第一个存在的目录再 canonicalize，这样"还不存在的目标文件"也能安全解析
    let mut ancestor: &Path = raw.parent().unwrap_or(Path::new("."));
    let mut suffix: Vec<Component> = vec![Component::Normal(file_name)];
    loop {
        match ancestor.canonicalize() {
            Ok(dir) => {
                if !within_roots(&dir) {
                    return Err(format!(
                        "路径不在允许的目录内（仅限家目录与临时目录）: {}",
                        describe(&dir)
                    ));
                }
                let mut out = dir;
                for comp in suffix.iter().rev() {
                    out = out.join(comp.as_os_str());
                }
                return Ok(out);
            }
            Err(_) => {
                let parent = match ancestor.parent() {
                    Some(p) if !p.as_os_str().is_empty() => p,
                    _ => return Err("路径必须位于家目录或临时目录内".into()),
                };
                match ancestor.file_name() {
                    Some(name) => suffix.push(Component::Normal(name)),
                    None => return Err("路径必须位于家目录或临时目录内".into()),
                }
                ancestor = parent;
            }
        }
    }
}

/// 只在"确实不存在"时创建目录，并且权限收到 0700（`~/.ssh` 与 SFTP 落盘的临时目录就靠这一步）
///
/// 必须**递归**：下载落盘的父目录可能是 `临时目录/子目录/会话目录/` 两层都不存在，
/// 单层的 `create` 会以 `NotFound` 失败，而调用方拿到的是"创建目录失败"这种没头没尾的说法。
#[cfg(unix)]
fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    if path.exists() {
        return Ok(());
    }
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(path)
        .map_err(|e| format!("创建目录失败 {}: {}", describe(path), e))
}

#[cfg(not(unix))]
fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|e| format!("创建目录失败 {}: {}", describe(path), e))
}

/// 落盘前的准备：白名单校验 + 按需把父目录建出来（0700），返回真正要写的路径
///
/// 只校验不建目录时，"下载到一个还不存在的临时子目录"这条最正常的路径必然失败；
/// 只建目录不校验时，远端递过来的文件名就能决定本地目录结构。所以两件事必须同时做。
pub fn prepare_write(path: &str) -> Result<PathBuf, String> {
    let target = resolve_for_write(path)?;
    let parent = target.parent().ok_or("缺少父目录")?;
    ensure_parent_dir(parent)?;
    if !parent.is_dir() {
        return Err(format!("落盘位置不是目录: {}", describe(parent)));
    }
    Ok(target)
}

/// 落盘私钥：0600，且覆盖已存在文件时也重新收紧权限
///
/// `OpenOptions::mode` 只在**新建**时生效，旧文件的 0644 会留着，所以写完还要显式改权限。
pub fn write_private_key(path: &str, content: &str) -> Result<String, String> {
    let target = prepare_write(path)?;
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&target).map_err(|e| format!("写入失败: {}", e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("写入失败: {}", e))?;
    file.flush().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置权限失败: {}", e))?;
    }
    Ok(describe(&target))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_name(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "zterm-paths-{}-{}-{}",
            tag,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn accepts_file_inside_temp_dir() {
        let path = temp_name("ok");
        fs::write(&path, "hello").unwrap();
        let resolved = resolve_existing(&describe(&path)).expect("临时目录内应放行");
        assert_eq!(resolved, path.canonicalize().unwrap());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_paths_outside_the_allow_list() {
        for p in ["/etc/hosts", "/etc/passwd", "/proc/self/environ"] {
            assert!(resolve_existing(p).is_err(), "白名单外应拒绝: {}", p);
        }
    }

    #[test]
    fn rejects_traversal_even_from_inside() {
        let path = temp_name("trav");
        fs::write(&path, "x").unwrap();
        assert!(resolve_existing("../etc/hosts").is_err());
        assert!(resolve_existing(&format!("{}/../../etc/hosts", describe(&path))).is_err());
        assert!(resolve_for_write("/tmp/a/../../etc/x").is_err());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn rejects_missing_and_directories() {
        assert!(resolve_existing(&describe(&temp_name("nope"))).is_err());
        assert!(resolve_existing("   ").is_err());
        // 目录本身不能当文件读
        assert!(resolve_existing(&describe(&std::env::temp_dir())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_pointing_outside_is_rejected() {
        use std::os::unix::fs::symlink;
        let link = temp_name("link");
        if symlink("/etc/hosts", &link).is_err() {
            return; // 文件系统不支持符号链接则跳过（不留假失败）
        }
        assert!(
            resolve_existing(&describe(&link)).is_err(),
            "指向白名单外的符号链接必须被 canonicalize 拆穿"
        );
        fs::remove_file(&link).ok();
    }

    #[test]
    fn opener_accepts_directories_but_reads_do_not() {
        let dir = std::env::temp_dir();
        // "打开配置目录"这类需求要允许目录，读取/转 base64 则不允许
        assert!(resolve_existing_any(&describe(&dir)).is_ok());
        assert!(resolve_existing(&describe(&dir)).is_err());
        assert!(resolve_existing_any("/etc").is_err());
        assert!(resolve_existing_any("/").is_err());
    }

    #[test]
    fn write_target_allows_missing_file_but_not_outside_root() {
        let path = temp_name("write-new");
        let resolved = resolve_for_write(&describe(&path)).expect("临时目录内可写");
        assert_eq!(resolved.file_name(), path.file_name());
        assert!(!resolved.exists());
        assert!(resolve_for_write("/etc/new_private_key").is_err());
    }

    #[test]
    fn private_key_is_written_with_0600_even_overwriting() {
        let path = temp_name("key");
        write_private_key(&describe(&path), "-----BEGIN KEY-----\nabc\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "新建私钥必须 0600，实测 {:o}", mode);
            // 先放宽，再覆盖写：必须再次收紧（OpenOptions::mode 不会作用于已存在文件）
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            write_private_key(&describe(&path), "-----BEGIN KEY-----\nxyz\n").unwrap();
            let mode2 = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode2, 0o600, "覆盖写后仍要 0600，实测 {:o}", mode2);
        }
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "-----BEGIN KEY-----\nxyz\n"
        );
        fs::remove_file(&path).ok();
    }

    #[test]
    fn private_key_creates_missing_dir_as_0700() {
        let dir = temp_name("sshdir");
        let path = dir.join("id_ed25519");
        write_private_key(&describe(&path), "k").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "代建的 .ssh 目录应收到 0700，实测 {:o}", mode);
        }
        assert!(path.exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prepare_write_creates_two_missing_levels() {
        // 下载落盘的形状就是"临时目录/应用子目录/会话目录/文件"：两层都不存在
        let root = temp_name("nested");
        let path = root.join("sess-1").join("app.jar");
        assert!(!root.exists(), "前置条件：整条链都不存在");
        let target = prepare_write(&describe(&path)).expect("两层缺失也要备得出父目录");
        assert!(target.parent().unwrap().is_dir(), "父目录应真的建出来了");
        assert_eq!(target.file_name().unwrap(), "app.jar");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for dir in [root.clone(), root.join("sess-1")] {
                let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
                assert_eq!(
                    mode,
                    0o700,
                    "代建的每一层都要 0700，实测 {} 是 {:o}",
                    describe(&dir),
                    mode
                );
            }
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn prepare_write_refers_to_the_same_gate_as_resolve_for_write() {
        // 建目录之前必须先过白名单，否则"按需创建"会变成"想建哪建哪"
        assert!(prepare_write("/etc/zterm-should-not-exist/x").is_err());
        assert!(!Path::new("/etc/zterm-should-not-exist").exists());
        assert!(prepare_write(&describe(&std::env::temp_dir().join("..").join("x"))).is_err());
        assert!(prepare_write("").is_err());
        assert!(prepare_write("   ").is_err());
    }

    #[test]
    fn prepare_write_survives_a_hostile_remote_file_name() {
        // SFTP 目录列表里的文件名由远端决定，这几个都是"看起来像名字"的逃逸写法
        let root = temp_name("hostile");
        fs::create_dir_all(&root).unwrap();
        // macOS 上 $TMPDIR 会 canonicalize 成 /private/var/…，比较一律用解析后的那一份
        let root_canon = root.canonicalize().unwrap();
        for name in [
            "../../../../etc/passwd",
            "..\\..\\windows\\system32\\config",
            "/etc/sudoers",
            "../../.ssh/config",
            "a/../../b.jar",
            "",
            ".",
            "..",
        ] {
            let raw = format!("{}/{}", describe(&root_canon), name);
            match prepare_write(&raw) {
                // 要么直接被闸拒掉
                Err(_) => {}
                // 要么落在自己那棵临时目录树里
                Ok(target) => {
                    assert!(
                        target.starts_with(&root_canon),
                        "远端文件名不得决定本地位置: {} ⇒ {:?}",
                        raw,
                        target
                    );
                }
            }
        }
        fs::remove_dir_all(&root).ok();
    }
}
