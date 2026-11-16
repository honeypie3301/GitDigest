use flate2::read::GzDecoder;
use std::{
    fs, io,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{Duration, timeout},
};

const PACK_MAGIC: &[u8; 16] = b"GITDIGEST-PACK2\0";
const FOOTER_LENGTH: usize = 16 + 4 * 8 + 32;

pub struct Compatibility {
    worker: Arc<Mutex<Option<Worker>>>,
    cache: PathBuf,
}

struct Worker {
    child: Child,
    port: u16,
    activity: Arc<()>,
}

pub struct WorkerLease {
    pub port: u16,
    _activity: Arc<()>,
}

impl Worker {
    fn lease(&self) -> WorkerLease {
        WorkerLease {
            port: self.port,
            _activity: self.activity.clone(),
        }
    }
}

impl Compatibility {
    pub fn new(cache: PathBuf) -> Self {
        Self {
            worker: Arc::new(Mutex::new(None)),
            cache,
        }
    }

    pub async fn acquire(&self, key: &str) -> io::Result<WorkerLease> {
        let mut guard = self.worker.lock().await;
        if let Some(worker) = guard.as_mut() {
            if matches!(worker.child.try_wait(), Ok(None)) {
                return Ok(worker.lease());
            }
        }
        *guard = None;
        let cache = self.cache.clone();
        let payload = tokio::task::spawn_blocking(move || unpack(&cache))
            .await
            .map_err(io::Error::other)??;
        let mut child = Command::new(payload.join("node.exe"))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .current_dir(&payload)
            .arg(payload.join("server.cjs"))
            .env("GITDIGEST_DESKTOP_KEY", key)
            .env("GITDIGEST_DESKTOP_COMPATIBILITY", "1")
            .env("GITDIGEST_CFR_HOME", &payload)
            .env("GITDIGEST_DESKTOP_GIT", payload.join("git/cmd/git.exe"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Backend output unavailable"))?;
        let mut lines = BufReader::new(stdout).lines();
        let port = timeout(Duration::from_secs(15), async {
            while let Some(line) = lines.next_line().await? {
                if let Some(port) = line
                    .strip_prefix("GitIngest server running on http://127.0.0.1:")
                    .and_then(|port| port.parse::<u16>().ok())
                {
                    return Ok(port);
                }
            }
            Err(io::Error::other(
                "The GitHub ingestion engine exited during startup",
            ))
        })
        .await
        .map_err(io::Error::other)??;
        // Keep stdout drained without retaining logs that could contain credentials.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let worker = Worker {
            child,
            port,
            activity: Arc::new(()),
        };
        let lease = worker.lease();
        let activity = Arc::downgrade(&worker.activity);
        let slot = Arc::downgrade(&self.worker);
        *guard = Some(worker);
        tokio::spawn(async move {
            let mut idle = false;
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let Some(slot) = slot.upgrade() else { break };
                let mut guard = slot.lock().await;
                let Some(worker) = guard.as_ref() else { break };
                if !std::ptr::eq(activity.as_ptr(), Arc::as_ptr(&worker.activity)) {
                    break;
                }
                let inactive = Arc::strong_count(&worker.activity) == 1;
                if idle && inactive {
                    *guard = None;
                    break;
                }
                idle = inactive;
            }
        });
        Ok(lease)
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.worker.try_lock() {
            *guard = None;
        }
    }
}

fn unpack(cache: &Path) -> io::Result<PathBuf> {
    // The build appends this data after the executable image. Windows can start
    // GitDigest without mapping or unpacking any of it.
    let mut source = fs::File::open(std::env::current_exe()?)?;
    let end = source.seek(SeekFrom::End(-(FOOTER_LENGTH as i64)))?;
    let mut footer = [0; FOOTER_LENGTH];
    source.read_exact(&mut footer)?;
    if &footer[..16] != PACK_MAGIC {
        return Err(io::Error::other("Missing bundled ingestion engine"));
    }
    let length = |offset| u64::from_le_bytes(footer[offset..offset + 8].try_into().unwrap());
    let [node_length, git_length, backend_length, java_length] =
        [length(16), length(24), length(32), length(40)];
    let offset = end
        .checked_sub(node_length)
        .and_then(|pos| pos.checked_sub(git_length))
        .and_then(|pos| pos.checked_sub(backend_length))
        .and_then(|pos| pos.checked_sub(java_length))
        .filter(|pos| *pos != 0 && git_length < 300 * 1024 * 1024)
        .ok_or_else(|| io::Error::other("Invalid bundled ingestion engine"))?;
    let digest = footer[48..]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fs::create_dir_all(cache)?;
    let destination = cache.join(digest);
    let complete = || {
        destination.join("ready").is_file()
            && destination.join("server.cjs").is_file()
            && destination.join("git/cmd/git.exe").is_file()
            && destination.join("node.exe").is_file()
            && destination.join("java.zip").is_file()
    };
    if complete() {
        return Ok(destination);
    }
    let staging = tempfile::Builder::new()
        .prefix("extract-")
        .tempdir_in(cache)?;
    let root = staging.path();
    source.seek(SeekFrom::Start(offset))?;
    io::copy(
        &mut GzDecoder::new((&mut source).take(node_length)),
        &mut fs::File::create(root.join("node.exe"))?,
    )?;
    source.seek(SeekFrom::Start(offset + node_length))?;
    let mut archive = vec![0; git_length as usize];
    source.read_exact(&mut archive)?;
    let mut git = zip::ZipArchive::new(io::Cursor::new(archive))?;
    git.extract(root.join("git"))?;
    io::copy(
        &mut (&mut source).take(backend_length),
        &mut fs::File::create(root.join("server.cjs"))?,
    )?;
    io::copy(
        &mut source.take(java_length),
        &mut fs::File::create(root.join("java.zip"))?,
    )?;
    fs::write(root.join("ready"), [])?;
    match fs::rename(root, &destination) {
        Ok(()) => Ok(destination),
        Err(_) if complete() => Ok(destination),
        Err(error) => Err(error),
    }
}
