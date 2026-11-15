#[path = "../src/api.rs"]
mod api;
#[path = "../src/compatibility.rs"]
mod compatibility;
#[path = "../src/local.rs"]
mod local;

fn main() -> std::io::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let cache = std::env::args_os()
                .nth(1)
                .ok_or_else(|| std::io::Error::other("Pass the benchmark cache path"))?;
            let state = api::DesktopApi::new("benchmark".into(), cache.into());
            println!("{}", listener.local_addr()?);
            axum::serve(listener, state.clone().router()).await?;
            state.shutdown();
            Ok(())
        })
}
