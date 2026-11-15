use fancy_regex::Regex;
use icu_collator::{Collator, CollatorBorrowed};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt::Write as _,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

const DIGEST_LIMIT: usize = 40 * 1024 * 1024;
const SEPARATOR: &str = "================================================";

#[derive(Deserialize)]
pub struct Options {
    pub input_text: String,
    #[serde(default = "default_size")]
    max_file_size: f64,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    pattern_type: String,
    #[serde(default)]
    decompile_classes: bool,
}

fn default_size() -> f64 {
    50.0
}

#[derive(Debug, Serialize)]
pub struct Digest {
    pub summary: String,
    pub tree: String,
    pub content: String,
    pub repo_name: String,
    pub files_analyzed: usize,
    pub estimated_tokens: String,
    pub total_chars: usize,
    pub mode_info: String,
}

pub enum Outcome {
    Local(Digest),
    CompatibilityBackend,
    Unreadable,
    Cancelled,
}

pub fn ingest(
    options: Options,
    mut progress: impl FnMut(&str, usize, usize, &str) -> bool,
    cancelled: impl Fn() -> bool,
) -> Outcome {
    let input = Path::new(options.input_text.trim());
    let Ok(metadata) = fs::metadata(input) else {
        return if input.is_absolute() {
            Outcome::Unreadable
        } else {
            Outcome::CompatibilityBackend
        };
    };
    let Ok(root) = std::path::absolute(input) else {
        return Outcome::Unreadable;
    };
    let is_directory = metadata.is_dir();
    if !is_directory && !metadata.is_file() {
        return Outcome::Unreadable;
    }

    let name = root
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let matcher = PathFilter::new(&options.pattern, options.pattern_type == "include");
    let max_bytes = options.max_file_size * 1024.0 * 1024.0;
    let mut paths = Vec::new();
    let mut tree = Tree::default();
    if is_directory {
        collect(
            &root, "", &matcher, max_bytes, &mut paths, &mut tree, &cancelled,
        );
    } else if metadata.len() as f64 <= max_bytes && matcher.allows(&name) {
        paths.push(LocalFile {
            path: root.clone(),
            relative: name.clone(),
            size: metadata.len(),
        });
    }
    if cancelled() {
        return Outcome::Cancelled;
    }
    if options.decompile_classes && paths.iter().any(|file| is_class(&file.relative)) {
        return Outcome::CompatibilityBackend;
    }

    let mut tree_text = "Directory structure:\n".to_string();
    if is_directory {
        let _ = writeln!(tree_text, "└── {name}/");
        let collator = Collator::try_new(Default::default(), Default::default())
            .expect("The bundled ICU data includes the default collation");
        render_tree(&tree, &mut tree_text, &mut "    ".to_string(), &collator);
    } else if !paths.is_empty() {
        tree_text.push_str(&name);
    }

    let mut content = String::new();
    let mut scratch = Vec::new();
    let mut count = 0;
    let mut chars = 0;
    let mut truncated = false;
    for file in &paths {
        if cancelled() {
            return Outcome::Cancelled;
        }
        if chars >= DIGEST_LIMIT {
            truncated = true;
            break;
        }
        let Ok(mut stream) = File::open(&file.path) else {
            continue;
        };
        scratch.clear();
        let limit = (max_bytes as u64).saturating_add(1);
        // Read small files in one pass and avoid loading the rest of large binary files.
        let first_read = if file.size <= 64 * 1024 { limit } else { 512 };
        if (&mut stream)
            .take(first_read)
            .read_to_end(&mut scratch)
            .is_err()
        {
            continue;
        }
        let class = is_class(&file.relative);
        let binary = class || scratch[..scratch.len().min(512)].contains(&0);
        let text = if binary {
            if first_read < limit
                && stream
                    .metadata()
                    .is_ok_and(|meta| meta.len() as f64 > max_bytes)
            {
                continue;
            }
            if class {
                "[Binary file: Java Class file]"
            } else {
                "[Binary file]"
            }
            .into()
        } else {
            let remaining = limit.saturating_sub(scratch.len() as u64);
            if file.size > 64 * 1024 && stream.take(remaining).read_to_end(&mut scratch).is_err() {
                continue;
            }
            String::from_utf8_lossy(&scratch)
        };
        if scratch.len() as f64 > max_bytes {
            continue;
        }
        chars += if text.is_ascii() {
            text.len()
        } else {
            text.encode_utf16().count()
        };
        if count > 0 {
            content.push('\n');
        }
        let _ = writeln!(
            content,
            "{SEPARATOR}\nFile: {}\n{SEPARATOR}\n{text}",
            file.relative
        );
        count += 1;
        // The original determines the final status from the content prefix.
        let status = if text.starts_with("[Binary file") {
            "binary"
        } else {
            "completed"
        };
        if !progress(&file.relative, count, paths.len(), status) {
            return Outcome::Cancelled;
        }
    }
    if truncated {
        content.push_str("\n\n[Notice: Digest capped at 40MB for browser rendering stability. Use pattern filters for targeted ingestion.]\n");
    }

    let source = if is_directory {
        "Local Directory"
    } else {
        "Local File"
    };
    let tokens = format_tokens((chars + 2) / 4);
    let formatted_chars = format_chars(chars);
    let mut summary = format!(
        "{source}: {}\nFiles analyzed: {}\nEstimated tokens: {tokens}\nTotal characters: {formatted_chars}",
        root.display(),
        count + usize::from(truncated),
    );
    if truncated {
        summary.push_str("\n(Digest capped at 40MB for stability)");
    }
    Outcome::Local(Digest {
        summary,
        tree: tree_text,
        content,
        repo_name: name,
        files_analyzed: count + usize::from(truncated),
        estimated_tokens: tokens,
        total_chars: chars,
        mode_info: format!("{source} (Offline, 0 Network Calls)"),
    })
}

struct PathFilter {
    patterns: Vec<(Option<Regex>, String)>,
    include: bool,
}

impl PathFilter {
    fn new(pattern: &str, include: bool) -> Self {
        let patterns = pattern
            .split([',', '\n'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|raw| {
                let expression = raw.replace('.', "\\.").replace('*', ".*");
                let regex = Regex::new(&format!("(?i:{expression})")).ok();
                (regex, raw.to_owned())
            })
            .collect();
        Self { patterns, include }
    }

    fn allows(&self, path: &str) -> bool {
        self.patterns.is_empty()
            || self.patterns.iter().any(|(regex, raw)| {
                regex.as_ref().map_or_else(
                    || path.contains(raw),
                    |regex| regex.is_match(path).unwrap_or(false),
                )
            }) == self.include
    }
}

struct LocalFile {
    path: PathBuf,
    relative: String,
    size: u64,
}

#[derive(Default)]
struct Tree(BTreeMap<String, Option<Tree>>);

fn collect(
    directory: &Path,
    prefix: &str,
    matcher: &PathFilter,
    max_bytes: f64,
    paths: &mut Vec<LocalFile>,
    tree: &mut Tree,
    cancelled: &impl Fn() -> bool,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    // Node's Windows directory walk uses the native enumeration order for digest sections.
    // The displayed tree is sorted separately by its locale collator.
    for entry in entries.flatten() {
        if cancelled() {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(
            name.as_ref(),
            ".git" | "node_modules" | ".venv" | "$RECYCLE.BIN"
        ) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let relative = format!("{prefix}{name}");
        if kind.is_dir() {
            let mut subtree = Tree::default();
            collect(
                &entry.path(),
                &format!("{relative}/"),
                matcher,
                max_bytes,
                paths,
                &mut subtree,
                cancelled,
            );
            if !subtree.0.is_empty() {
                tree.0.insert(name.into_owned(), Some(subtree));
            }
        } else if kind.is_file()
            && matcher.allows(&relative)
            && let Ok(metadata) = entry.metadata()
            && metadata.len() as f64 <= max_bytes
        {
            tree.0.insert(name.into_owned(), None);
            paths.push(LocalFile {
                path: entry.path(),
                relative,
                size: metadata.len(),
            });
        }
    }
}

fn is_class(path: &str) -> bool {
    path.as_bytes()
        .rsplit(|b| *b == b'.')
        .next()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(b"class"))
        && path.contains('.')
}

fn render_tree(
    tree: &Tree,
    output: &mut String,
    prefix: &mut String,
    collator: &CollatorBorrowed<'_>,
) {
    let mut entries: Vec<_> = tree.0.iter().collect();
    entries.sort_by(|a, b| {
        b.1.is_some()
            .cmp(&a.1.is_some())
            .then_with(|| collator.compare(a.0, b.0))
            .then_with(|| a.0.cmp(b.0))
    });
    let last = entries.len().saturating_sub(1);
    for (index, (name, children)) in entries.into_iter().enumerate() {
        let connector = if index == last {
            "└── "
        } else {
            "├── "
        };
        let suffix = if children.is_some() { "/" } else { "" };
        let _ = writeln!(output, "{prefix}{connector}{name}{suffix}");
        if let Some(children) = children {
            let length = prefix.len();
            prefix.push_str(if index == last { "    " } else { "│   " });
            render_tree(children, output, prefix, collator);
            prefix.truncate(length);
        }
    }
}

fn format_tokens(tokens: usize) -> String {
    let (factor, unit) = match tokens {
        1_000_000.. => (1_000_000.0, "M"),
        1_000.. => (1_000.0, "k"),
        _ => return tokens.to_string(),
    };
    let value = tokens as f64 / factor;
    let whole_tenths = (value * 10.0).floor();
    // JavaScript toFixed rounds exact ties upward, unlike Rust's format precision.
    let tenths = whole_tenths as usize + usize::from(value.mul_add(10.0, -whole_tenths) >= 0.5);
    format!("{}.{}{unit}", tenths / 10, tenths % 10)
}

fn format_chars(chars: usize) -> String {
    let digits = chars.to_string();
    let mut output = String::with_capacity(digits.len() + digits.len() / 3);
    for (idx, digit) in digits.char_indices() {
        if idx > 0 && (digits.len() - idx).is_multiple_of(3) {
            output.push(',');
        }
        output.push(digit);
    }
    output
}
