//! `ompw serve`: a WebSocket server exposing run views over the live replay
//! protocol. The server is a bundle reader like any other — it never writes
//! bundles — and binds to localhost by default because bundles contain
//! private data.

use crate::bundle::reader::read_declared_artifact_checked;
use crate::protocol::{ClientMessage, PatchOp, ServerMessage, PROTOCOL_ID};
use crate::source::{RunEntry, RunSource};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// Broadcast from the refresh loop to every connection task.
#[derive(Clone, Debug)]
enum Update {
    Runs(Vec<serde_json::Value>),
    Patch {
        run_id: String,
        revision: u64,
        patch: Vec<PatchOp>,
    },
}

/// Cap on `fetch_artifact` responses: bundles can declare arbitrary sizes,
/// and a single WebSocket text frame holds the whole content.
const ARTIFACT_MAX_BYTES: u64 = 4 * 1024 * 1024;

pub struct ServeOptions {
    pub runs_dir: PathBuf,
    pub bind: String,
}

pub async fn serve(options: ServeOptions) -> Result<()> {
    let listener = TcpListener::bind(&options.bind)
        .await
        .with_context(|| format!("binding {}", options.bind))?;
    eprintln!(
        "ompw serve: watching {} on ws://{}/ws",
        options.runs_dir.display(),
        listener.local_addr()?
    );
    serve_on(listener, options.runs_dir).await
}

/// Accept-loop core, split out so tests can bind an ephemeral port.
pub async fn serve_on(listener: TcpListener, runs_dir: PathBuf) -> Result<()> {
    // The protocol has no authentication, so a reachable server hands run
    // bundles to anyone. Refuse non-loopback listeners here, at the single
    // entry point every caller goes through; view remote runs through an
    // SSH tunnel instead.
    let local = listener.local_addr()?;
    if !local.ip().is_loopback() {
        anyhow::bail!(
            "refusing to serve on non-loopback address {local}: the live replay \
             protocol is unauthenticated; bind to 127.0.0.1 and use an SSH tunnel \
             for remote access"
        );
    }
    let source = Arc::new(Mutex::new(RunSource::new(&runs_dir)));
    let (updates_tx, _) = broadcast::channel::<Update>(256);

    // Refresh loop: wake on filesystem changes (plus a slow safety tick for
    // the possibly-interrupted timer) and broadcast the resulting patches.
    {
        let source = Arc::clone(&source);
        let updates_tx = updates_tx.clone();
        let runs_dir = runs_dir.clone();
        tokio::spawn(async move {
            let mut watcher = crate::bundle::watch::RunsWatcher::new(&runs_dir).ok();
            loop {
                match watcher.as_mut() {
                    Some(watcher) => {
                        tokio::select! {
                            _ = watcher.changed() => {}
                            _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {}
                        }
                    }
                    None => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
                }
                // Coalesce a token burst into one revision while preserving
                // each durable event as a distinct append record.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let outcome = source.lock().await.refresh_all();
                for (run_id, revision, patch) in outcome.patches {
                    let _ = updates_tx.send(Update::Patch {
                        run_id,
                        revision,
                        patch,
                    });
                }
                if outcome.listing_changed {
                    let _ = updates_tx.send(Update::Runs(source.lock().await.summaries()));
                }
            }
        });
    }

    loop {
        let (stream, _addr) = listener.accept().await?;
        let source = Arc::clone(&source);
        let updates_rx = updates_tx.subscribe();
        let connection_updates_tx = updates_tx.clone();
        tokio::spawn(async move {
            let _ = handle_connection(stream, source, connection_updates_tx, updates_rx).await;
        });
    }
}

async fn send(
    sink: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    message: &ServerMessage,
) -> Result<()> {
    let text = serde_json::to_string(message)?;
    sink.send(Message::Text(text.into())).await?;
    Ok(())
}

// The error type (a full HTTP response) is dictated by tungstenite's
// handshake callback signature.
#[allow(clippy::result_large_err)]
fn reject_browser_origins(
    request: &tokio_tungstenite::tungstenite::handshake::server::Request,
    response: tokio_tungstenite::tungstenite::handshake::server::Response,
) -> Result<
    tokio_tungstenite::tungstenite::handshake::server::Response,
    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
> {
    if request.headers().contains_key("origin") {
        let mut rejection = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(
            Some("browser origins are not allowed".to_string()),
        );
        *rejection.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
        return Err(rejection);
    }
    Ok(response)
}
#[derive(Clone, Copy)]
struct WatchedRun {
    revision: u64,
    generation: u64,
}

type Snapshot = (u64, u64, serde_json::Value);

async fn load_snapshot(
    source: &Arc<Mutex<RunSource>>,
    updates_tx: &broadcast::Sender<Update>,
    run_id: &str,
) -> Option<Snapshot> {
    let mut listing_changed = false;
    loop {
        let (snapshot, candidate) = {
            let source = source.lock().await;
            let snapshot = source.get(run_id).and_then(|entry| {
                let generation = source.metadata(run_id)?.generation;
                Some((entry.revision, generation, entry.view()))
            });
            let candidate = if snapshot.is_none() {
                source.load_candidate(run_id)
            } else {
                None
            };
            if listing_changed && (snapshot.is_some() || candidate.is_none()) {
                let _ = updates_tx.send(Update::Runs(source.summaries()));
            }
            (snapshot, candidate)
        };
        if snapshot.is_some() {
            return snapshot;
        }
        let candidate = candidate?;
        let generation = candidate.generation;
        let opened = tokio::task::spawn_blocking(move || RunEntry::open(&candidate.dir))
            .await
            .ok()
            .and_then(Result::ok);
        let Some(entry) = opened else {
            if listing_changed {
                let source = source.lock().await;
                let _ = updates_tx.send(Update::Runs(source.summaries()));
            }
            return None;
        };
        let (snapshot, retry) = {
            let mut source = source.lock().await;
            let installed = source.install_loaded(run_id, generation, entry);
            listing_changed |= match installed {
                Some(changed_on_install) => changed_on_install,
                None => source.scan(),
            };
            let snapshot = source.get(run_id).and_then(|entry| {
                let generation = source.metadata(run_id)?.generation;
                Some((entry.revision, generation, entry.view()))
            });
            let retry = installed.is_none()
                && snapshot.is_none()
                && source.load_candidate(run_id).is_some();
            if listing_changed && !retry {
                let _ = updates_tx.send(Update::Runs(source.summaries()));
            }
            (snapshot, retry)
        };
        if !retry {
            return snapshot;
        }
    }
}

async fn handle_connection(
    stream: TcpStream,
    source: Arc<Mutex<RunSource>>,
    updates_tx: broadcast::Sender<Update>,
    mut updates_rx: broadcast::Receiver<Update>,
) -> Result<()> {
    // Browsers always send an Origin header; native clients do not. The
    // protocol is unauthenticated, so a web page must never be able to read
    // run bundles by opening a WebSocket to localhost — reject any
    // browser-originated handshake outright.
    let ws = tokio_tungstenite::accept_hdr_async(stream, reject_browser_origins).await?;
    let (mut sink, mut reads) = ws.split();
    send(
        &mut sink,
        &ServerMessage::Hello {
            protocol: PROTOCOL_ID.to_string(),
        },
    )
    .await?;

    let mut watching_runs = false;
    // A key remains present while its run is unavailable. Available values pin both
    // the run incarnation and the last revision delivered to this connection.
    let mut watched: HashMap<String, Option<WatchedRun>> = HashMap::new();

    loop {
        tokio::select! {
            incoming = reads.next() => {
                let Some(incoming) = incoming else { break };
                let message = match incoming {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                };
                let Ok(request) = serde_json::from_str::<ClientMessage>(&message) else {
                    // Unknown message types must be ignored.
                    continue;
                };
                match request {
                    ClientMessage::WatchRuns => {
                        watching_runs = true;
                        let runs = source.lock().await.summaries();
                        send(&mut sink, &ServerMessage::Runs { runs }).await?;
                    }
                    ClientMessage::WatchRun { run_id } => {
                        watched.entry(run_id.clone()).or_insert(None);
                        match load_snapshot(&source, &updates_tx, &run_id).await {
                            Some((revision, generation, view)) => {
                                watched.insert(
                                    run_id.clone(),
                                    Some(WatchedRun {
                                        revision,
                                        generation,
                                    }),
                                );
                                send(&mut sink, &ServerMessage::RunSnapshot {
                                    run_id,
                                    revision,
                                    view,
                                }).await?;
                            }
                            None => {
                                send(&mut sink, &ServerMessage::Error {
                                    message: format!("unknown run {run_id}"),
                                    run_id: Some(run_id),
                                }).await?;
                            }
                        }
                    }
                    ClientMessage::UnwatchRun { run_id } => {
                        watched.remove(&run_id);
                    }
                    ClientMessage::FetchArtifact { run_id, path } => {
                        let content = {
                            let source = source.lock().await;
                            source.metadata(&run_id).and_then(|metadata| {
                                let artifact_dir = metadata.manifest.paths.artifacts.as_deref()?;
                                read_declared_artifact_checked(
                                    metadata.dir,
                                    artifact_dir,
                                    &path,
                                    ARTIFACT_MAX_BYTES,
                                )
                            })
                        };
                        match content {
                            Some(content) => {
                                send(&mut sink, &ServerMessage::Artifact { run_id, path, content }).await?;
                            }
                            None => {
                                send(&mut sink, &ServerMessage::Error {
                                    message: format!("artifact {path} not available"),
                                    run_id: Some(run_id),
                                }).await?;
                            }
                        }
                    }
                }
            }
            update = updates_rx.recv() => {
                match update {
                    Ok(Update::Runs(runs)) => {
                        if watching_runs {
                            send(&mut sink, &ServerMessage::Runs { runs }).await?;
                        }
                        let reload_ids = {
                            let source = source.lock().await;
                            watched
                                .iter_mut()
                                .filter_map(|(run_id, watched_run)| {
                                    let Some(metadata) = source.metadata(run_id) else {
                                        *watched_run = None;
                                        return None;
                                    };
                                    let needs_snapshot = watched_run
                                        .is_none_or(|watched_run| {
                                            watched_run.generation != metadata.generation
                                        });
                                    if needs_snapshot {
                                        *watched_run = None;
                                        Some(run_id.clone())
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>()
                        };
                        for run_id in reload_ids {
                            if let Some((revision, generation, view)) =
                                load_snapshot(&source, &updates_tx, &run_id).await
                            {
                                watched.insert(
                                    run_id.clone(),
                                    Some(WatchedRun {
                                        revision,
                                        generation,
                                    }),
                                );
                                send(&mut sink, &ServerMessage::RunSnapshot {
                                    run_id,
                                    revision,
                                    view,
                                }).await?;
                            }
                        }
                    }
                    Ok(Update::Patch { run_id, revision, patch }) => {
                        let Some(Some(current)) = watched.get(&run_id).copied() else {
                            continue;
                        };
                        if revision == current.revision + 1 {
                            watched.insert(
                                run_id.clone(),
                                Some(WatchedRun {
                                    revision,
                                    generation: current.generation,
                                }),
                            );
                            send(&mut sink, &ServerMessage::RunPatch { run_id, revision, patch }).await?;
                        } else if revision > current.revision {
                            // Missed one (lagged broadcast): resnapshot.
                            if let Some((revision, generation, view)) =
                                load_snapshot(&source, &updates_tx, &run_id).await
                            {
                                watched.insert(
                                    run_id.clone(),
                                    Some(WatchedRun {
                                        revision,
                                        generation,
                                    }),
                                );
                                send(&mut sink, &ServerMessage::RunSnapshot {
                                    run_id,
                                    revision,
                                    view,
                                }).await?;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Drop the retained backlog before publishing current state; otherwise an
                        // older queued Runs message could regress this connection after recovery.
                        updates_rx = updates_tx.subscribe();
                        if watching_runs {
                            let runs = source.lock().await.summaries();
                            send(&mut sink, &ServerMessage::Runs { runs }).await?;
                        }
                        let run_ids: Vec<String> = watched.keys().cloned().collect();
                        for run_id in run_ids {
                            match load_snapshot(&source, &updates_tx, &run_id).await {
                                Some((revision, generation, view)) => {
                                    watched.insert(
                                        run_id.clone(),
                                        Some(WatchedRun {
                                            revision,
                                            generation,
                                        }),
                                    );
                                    send(&mut sink, &ServerMessage::RunSnapshot {
                                        run_id,
                                        revision,
                                        view,
                                    }).await?;
                                }
                                None => {
                                    watched.insert(run_id, None);
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}
