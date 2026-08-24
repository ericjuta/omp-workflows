//! The run source: reads bundles from a runs directory and maintains one
//! semantic *run view* per run (see docs/live-replay-protocol.md), producing
//! JSON patches as bundles grow. Both the in-process TUI and the WebSocket
//! server consume this; the protocol is just its network form.

use crate::bundle::reader::{list_bundles, read_manifest_value, BundlePaths};
use crate::bundle::tail::NdjsonTailer;
use crate::bundle::types::{DefinitionSnapshot, Manifest, RunState};
use crate::protocol::PatchOp;
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// A run whose bundle stopped changing for this long while status is
/// `running` is flagged as possibly interrupted (writer crashed).
const INTERRUPTED_AFTER: Duration = Duration::from_secs(60);
#[derive(Clone, Debug, PartialEq, Eq)]
struct BundleIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    created: Option<SystemTime>,
}
fn bundle_identity(dir: &Path) -> Option<BundleIdentity> {
    let metadata = std::fs::metadata(dir).ok()?;
    Some(BundleIdentity {
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        created: metadata.created().ok(),
    })
}

pub struct RunEntry {
    pub dir: PathBuf,
    pub manifest: Manifest,
    /// Bundle documents verbatim, as sent over the wire. The raw manifest is
    /// kept beside the typed one because views must carry it unmodified,
    /// including forward-compatible fields this build does not know about.
    pub manifest_raw: Value,
    pub workflow: Value,
    pub state_raw: Value,
    pub events: Vec<Value>,
    /// Tailed trace events whose `seq` is still ahead of `state.traceSeq`
    /// (the writer appends the trace before rewriting the state).
    pending_events: Vec<Value>,
    pub session_binding: Option<Value>,
    pub session_entries: Vec<Value>,
    pub session_events: Vec<Value>,
    pub session_events_malformed: bool,
    pub session_events_torn_tail: bool,
    pub session_capture: Option<Value>,
    /// Typed forms for rendering.
    pub state: RunState,
    pub snapshot: Option<DefinitionSnapshot>,
    pub live: bool,
    pub possibly_interrupted: bool,
    pub revision: u64,
    trace_tailer: NdjsonTailer,
    session_tailer: Option<NdjsonTailer>,
    session_event_tailer: Option<NdjsonTailer>,
    last_growth: Instant,
}

/// Parse and schema-check a state document; unsupported schemas are
/// rejected so incompatible layouts never render.
fn parse_state(raw: &str) -> Option<(Value, RunState)> {
    let state_raw: Value = serde_json::from_str(raw).ok()?;
    let state: RunState = serde_json::from_value(state_raw.clone()).ok()?;
    if state.schema != crate::bundle::types::RUN_STATE_SCHEMA {
        return None;
    }
    Some((state_raw, state))
}

/// The instant corresponding to the newest modification time among the
/// bundle's mutable files, so a run that stalled before we started watching
/// is flagged as possibly interrupted immediately.
fn last_write_instant(paths: &BundlePaths) -> Instant {
    // Appends to files inside session/ do not bump the directory mtime, so
    // the session documents are listed individually: a run mid-conversation
    // must not open as possibly interrupted.
    let newest = [
        Some(paths.state.clone()),
        Some(paths.trace.clone()),
        paths.session_binding(),
        paths.session_entries(),
        paths.session_events(),
        paths.session_capture(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|path| std::fs::metadata(path).ok())
    .filter_map(|metadata| metadata.modified().ok())
    .max();
    let age = newest
        .and_then(|mtime| std::time::SystemTime::now().duration_since(mtime).ok())
        .unwrap_or_default();
    Instant::now().checked_sub(age).unwrap_or_else(Instant::now)
}

impl RunEntry {
    pub(crate) fn open(dir: &Path) -> Result<Self> {
        let (manifest_raw, manifest) = read_manifest_value(dir)?;
        let paths = BundlePaths::from_manifest(dir, &manifest);
        let state_text = crate::bundle::reader::read_contained(dir, &paths.state)
            .ok_or_else(|| anyhow::anyhow!("unreadable state in {}", dir.display()))?;
        let (state_raw, state) = parse_state(&state_text)
            .ok_or_else(|| anyhow::anyhow!("unsupported state schema in {}", dir.display()))?;
        let workflow: Value = crate::bundle::reader::read_contained(dir, &paths.workflow)
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let snapshot: Option<DefinitionSnapshot> = serde_json::from_value(workflow.clone())
            .ok()
            .filter(|snapshot: &DefinitionSnapshot| {
                snapshot.schema == crate::bundle::types::DEFINITION_SNAPSHOT_SCHEMA
            });
        let last_growth = last_write_instant(&paths);
        let mut entry = Self {
            dir: dir.to_path_buf(),
            trace_tailer: NdjsonTailer::contained(&paths.trace, dir),
            session_tailer: paths
                .session_entries()
                .map(|path| NdjsonTailer::contained(&path, dir)),
            session_event_tailer: paths
                .session_events()
                .map(|path| NdjsonTailer::contained(&path, dir)),
            manifest,
            manifest_raw,
            workflow,
            state_raw,
            events: Vec::new(),
            pending_events: Vec::new(),
            session_binding: None,
            session_entries: Vec::new(),
            session_events: Vec::new(),
            session_events_malformed: false,
            session_events_torn_tail: false,
            session_capture: None,
            state,
            snapshot,
            live: true,
            possibly_interrupted: false,
            revision: 0,
            last_growth,
        };
        entry.pending_events = entry.trace_tailer.poll().unwrap_or_default();
        entry.events = entry.drain_ready_events();
        entry.read_session_binding();
        if let Some(tailer) = entry.session_tailer.as_mut() {
            entry.session_entries = tailer.poll().unwrap_or_default();
        }
        if let Some(tailer) = entry.session_event_tailer.as_mut() {
            entry.session_events = tailer.poll().unwrap_or_default();
            entry.session_events_malformed = tailer.malformed();
            entry.session_events_torn_tail = tailer.has_partial_line();
        }
        entry.read_session_capture();
        entry.live = !entry.settled();
        entry.possibly_interrupted = entry.live
            && entry.state.status == crate::bundle::types::RunStatus::Running
            && entry.last_growth.elapsed() >= INTERRUPTED_AFTER;
        Ok(entry)
    }

    /// A bundle is settled (immutable, safe to stop watching) only when the
    /// terminal status has propagated through every document we track: a
    /// terminal manifest alone can race a refresh that still holds the old
    /// state or an undrained trace tail. The tail must also have reached the
    /// state's `traceSeq`: the final append can land between our trace poll
    /// and the terminal state read, and settling then would lose it.
    fn settled(&self) -> bool {
        self.manifest.status.is_terminal()
            && self.state.status.is_terminal()
            && self.pending_events.is_empty()
            && self.last_seen_seq() >= self.state.trace_seq
    }

    /// Highest trace sequence this entry has observed (published or pending).
    fn last_seen_seq(&self) -> u64 {
        self.pending_events
            .last()
            .or_else(|| self.events.last())
            .and_then(|event| event.get("seq").and_then(Value::as_u64))
            .unwrap_or(0)
    }

    /// Take the pending trace events whose `seq` the state projection has
    /// caught up with. Publishing a trace tail ahead of its state would make
    /// the panes disagree mid-transition (trace is written first).
    fn drain_ready_events(&mut self) -> Vec<Value> {
        let ready_count = self
            .pending_events
            .iter()
            .take_while(|event| {
                event
                    .get("seq")
                    .and_then(Value::as_u64)
                    .is_none_or(|seq| seq <= self.state.trace_seq)
            })
            .count();
        self.pending_events.drain(..ready_count).collect()
    }

    fn read_session_binding(&mut self) {
        if self.session_binding.is_some() {
            return;
        }
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(path) = paths.session_binding() {
            if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &path) {
                self.session_binding = serde_json::from_str(&raw).ok();
            }
        }
        // The session directory can appear after the manifest was first
        // written (it is recorded in manifest.paths from the start), so the
        // tailer may need to be created late.
        if self.session_tailer.is_none() {
            self.session_tailer = paths
                .session_entries()
                .map(|path| NdjsonTailer::contained(&path, &self.dir));
        }
        if self.session_event_tailer.is_none() {
            self.session_event_tailer = paths
                .session_events()
                .map(|path| NdjsonTailer::contained(&path, &self.dir));
        }
    }

    fn read_session_capture(&mut self) {
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(path) = paths.session_capture() {
            if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &path) {
                self.session_capture = serde_json::from_str(&raw).ok();
            }
        }
    }

    fn session_value(&self) -> Value {
        match &self.session_binding {
            Some(binding) => json!({
                "binding": binding,
                "entries": self.session_entries,
                "events": self.session_events,
                "eventsMalformed": self.session_events_malformed,
                "eventsTornTail": self.session_events_torn_tail,
                "capture": self.session_capture,
            }),
            None => Value::Null,
        }
    }

    pub fn view(&self) -> Value {
        json!({
            "manifest": self.manifest_raw,
            "workflow": self.workflow,
            "state": self.state_raw,
            "events": self.events,
            "session": self.session_value(),
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }

    /// Re-read changed files and return the patch from the previous view to
    /// the current one. `None` means nothing changed.
    fn refresh(&mut self) -> Option<Vec<PatchOp>> {
        let mut patch: Vec<PatchOp> = Vec::new();

        // Tail the trace first, but publish only after the state below has
        // been re-read: events past `state.traceSeq` wait in `pending_events`
        // so a mid-transition read never shows a trace tail ahead of the
        // projection.
        let newly_polled = self.trace_tailer.poll().unwrap_or_default();
        let mut trace_grew = !newly_polled.is_empty();
        self.pending_events.extend(newly_polled);

        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        if let Some(raw) = crate::bundle::reader::read_contained(&self.dir, &paths.state) {
            if let Some((state_raw, state)) = parse_state(&raw) {
                if state_raw != self.state_raw {
                    self.state = state;
                    self.state_raw = state_raw;
                    patch.push(PatchOp::Replace {
                        path: "/state".into(),
                        value: self.state_raw.clone(),
                    });
                }
            }
        }
        // The writer appends the trace before rewriting the state, so a
        // freshly read state can reference sequences that landed after the
        // poll above; re-poll rather than wait for a change notification the
        // finished writer will never produce again.
        if self.state.status.is_terminal() && self.last_seen_seq() < self.state.trace_seq {
            let late = self.trace_tailer.poll().unwrap_or_default();
            trace_grew = trace_grew || !late.is_empty();
            self.pending_events.extend(late);
        }
        let ready_events = self.drain_ready_events();
        if !ready_events.is_empty() {
            patch.push(PatchOp::Append {
                path: "/events".into(),
                value: ready_events.clone(),
            });
            self.events.extend(ready_events);
        }
        if let Ok((manifest_raw, manifest)) = read_manifest_value(&self.dir) {
            // Compare the raw document: a change confined to a field this
            // build does not know must still produce a patch.
            if manifest_raw != self.manifest_raw {
                self.manifest = manifest;
                self.manifest_raw = manifest_raw;
                patch.push(PatchOp::Replace {
                    path: "/manifest".into(),
                    value: self.manifest_raw.clone(),
                });
            }
        }

        let had_binding = self.session_binding.is_some();
        let previous_capture = self.session_capture.clone();
        let previous_events_malformed = self.session_events_malformed;
        let previous_events_torn_tail = self.session_events_torn_tail;
        self.read_session_binding();
        // Tail session journals before publishing a newly discovered binding,
        // so the first session value is already internally consistent.
        let new_entries: Vec<Value> = self
            .session_tailer
            .as_mut()
            .map(|tailer| tailer.poll().unwrap_or_default())
            .unwrap_or_default();
        let new_session_events: Vec<Value> = self
            .session_event_tailer
            .as_mut()
            .map(|tailer| tailer.poll().unwrap_or_default())
            .unwrap_or_default();
        if let Some(tailer) = self.session_event_tailer.as_ref() {
            self.session_events_malformed = tailer.malformed();
            self.session_events_torn_tail = tailer.has_partial_line();
        }
        let session_grew = !new_entries.is_empty() || !new_session_events.is_empty();
        self.session_entries.extend(new_entries.clone());
        self.session_events.extend(new_session_events.clone());
        self.read_session_capture();
        let capture_changed = self.session_capture != previous_capture;
        if !had_binding && self.session_binding.is_some() {
            patch.push(PatchOp::Replace {
                path: "/session".into(),
                value: self.session_value(),
            });
        } else if self.session_binding.is_some() {
            if !new_entries.is_empty() {
                patch.push(PatchOp::Append {
                    path: "/session/entries".into(),
                    value: new_entries,
                });
            }
            if !new_session_events.is_empty() {
                patch.push(PatchOp::Append {
                    path: "/session/events".into(),
                    value: new_session_events,
                });
            }
            if self.session_events_malformed != previous_events_malformed {
                patch.push(PatchOp::Replace {
                    path: "/session/eventsMalformed".into(),
                    value: json!(self.session_events_malformed),
                });
            }
            if self.session_events_torn_tail != previous_events_torn_tail {
                patch.push(PatchOp::Replace {
                    path: "/session/eventsTornTail".into(),
                    value: json!(self.session_events_torn_tail),
                });
            }
            if capture_changed {
                patch.push(PatchOp::Replace {
                    path: "/session/capture".into(),
                    value: self.session_capture.clone().unwrap_or(Value::Null),
                });
            }
        }

        let session_integrity_changed = self.session_events_malformed != previous_events_malformed
            || self.session_events_torn_tail != previous_events_torn_tail;
        if !patch.is_empty()
            || trace_grew
            || session_grew
            || session_integrity_changed
            || capture_changed
        {
            self.last_growth = Instant::now();
        }
        let live = !self.settled();
        if live != self.live {
            self.live = live;
            patch.push(PatchOp::Replace {
                path: "/live".into(),
                value: json!(live),
            });
        }
        let possibly_interrupted = self.live
            && self.state.status == crate::bundle::types::RunStatus::Running
            && self.last_growth.elapsed() >= INTERRUPTED_AFTER;
        if possibly_interrupted != self.possibly_interrupted {
            self.possibly_interrupted = possibly_interrupted;
            patch.push(PatchOp::Replace {
                path: "/possiblyInterrupted".into(),
                value: json!(possibly_interrupted),
            });
        }

        if patch.is_empty() {
            None
        } else {
            self.revision += 1;
            Some(patch)
        }
    }
}

struct RunListing {
    dir: PathBuf,
    manifest: Manifest,
    manifest_raw: Value,
    identity: BundleIdentity,
    generation: u64,
    live: bool,
    possibly_interrupted: bool,
    last_growth: Instant,
}

impl RunListing {
    fn open(
        dir: PathBuf,
        manifest_raw: Value,
        manifest: Manifest,
        identity: BundleIdentity,
        generation: u64,
    ) -> Option<Self> {
        let paths = BundlePaths::from_manifest(&dir, &manifest);
        let state_text = crate::bundle::reader::read_contained(&dir, &paths.state)?;
        let state: RunState = serde_json::from_str(&state_text).ok()?;
        if state.schema != crate::bundle::types::RUN_STATE_SCHEMA {
            return None;
        }
        let live = !manifest.status.is_terminal();
        let last_growth = if live {
            last_write_instant(&paths)
        } else {
            Instant::now()
        };
        let possibly_interrupted = live && last_growth.elapsed() >= INTERRUPTED_AFTER;
        Some(Self {
            dir,
            manifest,
            manifest_raw,
            identity,
            generation,
            live,
            possibly_interrupted,
            last_growth,
        })
    }

    fn from_entry(entry: &RunEntry, generation: u64) -> Option<Self> {
        Some(Self {
            dir: entry.dir.clone(),
            manifest: entry.manifest.clone(),
            manifest_raw: entry.manifest_raw.clone(),
            identity: bundle_identity(&entry.dir)?,
            generation,
            live: entry.live,
            possibly_interrupted: entry.possibly_interrupted,
            last_growth: entry.last_growth,
        })
    }

    fn update_manifest(
        &mut self,
        dir: PathBuf,
        manifest_raw: Value,
        manifest: Manifest,
        identity: BundleIdentity,
        generation: u64,
    ) -> (bool, bool) {
        let manifest_changed = self.manifest_raw != manifest_raw;
        let incarnation_changed = self.dir != dir || self.identity != identity;
        let previous_live = self.live;
        let previous_interrupted = self.possibly_interrupted;
        let paths = BundlePaths::from_manifest(&dir, &manifest);
        self.dir = dir;
        self.manifest = manifest;
        self.manifest_raw = manifest_raw;
        self.identity = identity;
        if incarnation_changed {
            self.generation = generation;
        }
        self.live = !self.manifest.status.is_terminal();
        self.last_growth = if self.live {
            last_write_instant(&paths)
        } else {
            Instant::now()
        };
        self.possibly_interrupted = self.live && self.last_growth.elapsed() >= INTERRUPTED_AFTER;
        (
            manifest_changed
                || self.live != previous_live
                || self.possibly_interrupted != previous_interrupted
                || incarnation_changed,
            incarnation_changed,
        )
    }

    fn differs_from_entry(&self, entry: &RunEntry) -> bool {
        self.manifest_raw != entry.manifest_raw
            || self.live != entry.live
            || self.possibly_interrupted != entry.possibly_interrupted
    }

    fn sync_from_entry(&mut self, entry: &RunEntry) {
        self.manifest = entry.manifest.clone();
        self.manifest_raw = entry.manifest_raw.clone();
        self.live = entry.live;
        self.possibly_interrupted = entry.possibly_interrupted;
        self.last_growth = entry.last_growth;
    }
    fn refresh_activity(&mut self) -> bool {
        if !self.live {
            return false;
        }
        let previous_interrupted = self.possibly_interrupted;
        let paths = BundlePaths::from_manifest(&self.dir, &self.manifest);
        self.last_growth = last_write_instant(&paths);
        self.possibly_interrupted = self.last_growth.elapsed() >= INTERRUPTED_AFTER;
        self.possibly_interrupted != previous_interrupted
    }

    fn summary(&self) -> Value {
        json!({
            "manifest": self.manifest_raw,
            "live": self.live,
            "possiblyInterrupted": self.possibly_interrupted,
        })
    }
}

pub struct RunMetadata<'a> {
    pub dir: &'a Path,
    pub manifest: &'a Manifest,
    pub generation: u64,
    pub live: bool,
    pub possibly_interrupted: bool,
}
pub(crate) struct RunLoadCandidate {
    pub dir: PathBuf,
    pub generation: u64,
}

pub struct RunSource {
    runs_dir: PathBuf,
    listings: BTreeMap<String, RunListing>,
    loaded: BTreeMap<String, RunEntry>,
    next_generation: u64,
    /// Single-bundle mode: `runs_dir` is the bundle itself, so directory
    /// scanning must not run (it would treat the bundle as an empty listing
    /// and drop the run).
    single: bool,
}

/// One refresh round: patches per changed run, and whether the listing
/// (order, membership, summaries) changed.
pub struct RefreshOutcome {
    pub patches: Vec<(String, u64, Vec<PatchOp>)>,
    pub listing_changed: bool,
}

impl RunSource {
    pub fn new(runs_dir: &Path) -> Self {
        let mut source = Self {
            runs_dir: runs_dir.to_path_buf(),
            listings: BTreeMap::new(),
            loaded: BTreeMap::new(),
            next_generation: 1,
            single: false,
        };
        source.scan();
        source
    }

    /// Open a source for a single bundle directory (no listing).
    pub fn single(bundle_dir: &Path) -> Result<Self> {
        let entry = RunEntry::open(bundle_dir)?;
        let run_id = entry.manifest.run_id.clone();
        let listing = RunListing::from_entry(&entry, 1)
            .ok_or_else(|| anyhow::anyhow!("manifest disappeared from {}", bundle_dir.display()))?;
        let mut listings = BTreeMap::new();
        listings.insert(run_id.clone(), listing);
        let mut loaded = BTreeMap::new();
        loaded.insert(run_id, entry);
        Ok(Self {
            runs_dir: bundle_dir.to_path_buf(),
            listings,
            loaded,
            next_generation: 2,
            single: true,
        })
    }

    pub fn runs_dir(&self) -> &Path {
        &self.runs_dir
    }

    /// Return a loaded run. Directory sources load a full bundle only after
    /// the UI or protocol client selects it.
    pub fn get(&self, run_id: &str) -> Option<&RunEntry> {
        self.loaded.get(run_id)
    }

    /// Load a selected run synchronously. The result says whether opening the
    /// bundle changed its lightweight listing.
    pub fn load(&mut self, run_id: &str) -> Option<bool> {
        let mut listing_changed = false;
        loop {
            if self.loaded.contains_key(run_id) {
                return Some(listing_changed);
            }
            let candidate = self.load_candidate(run_id)?;
            let generation = candidate.generation;
            let entry = RunEntry::open(&candidate.dir).ok()?;
            if let Some(changed_on_install) = self.install_loaded(run_id, generation, entry) {
                return Some(listing_changed || changed_on_install);
            }
            listing_changed |= self.scan();
            if self.load_candidate(run_id)?.generation == generation {
                return None;
            }
        }
    }

    pub(crate) fn install_loaded(
        &mut self,
        run_id: &str,
        generation: u64,
        entry: RunEntry,
    ) -> Option<bool> {
        if self.loaded.contains_key(run_id) {
            return Some(false);
        }
        let listing = self.listings.get_mut(run_id)?;
        if listing.generation != generation
            || bundle_identity(&listing.dir).as_ref() != Some(&listing.identity)
            || entry.manifest.run_id != run_id
            || entry.dir != listing.dir
        {
            return None;
        }
        let listing_changed = listing.differs_from_entry(&entry);
        listing.sync_from_entry(&entry);
        self.loaded.insert(run_id.to_string(), entry);
        Some(listing_changed)
    }
    pub(crate) fn load_candidate(&self, run_id: &str) -> Option<RunLoadCandidate> {
        let listing = self.listings.get(run_id)?;
        Some(RunLoadCandidate {
            dir: listing.dir.clone(),
            generation: listing.generation,
        })
    }

    pub fn metadata(&self, run_id: &str) -> Option<RunMetadata<'_>> {
        let listing = self.listings.get(run_id)?;
        Some(RunMetadata {
            dir: &listing.dir,
            manifest: &listing.manifest,
            generation: listing.generation,
            live: listing.live,
            possibly_interrupted: listing.possibly_interrupted,
        })
    }

    /// Run ids ordered newest first (startedAt desc, then run id desc).
    pub fn ordered_run_ids(&self) -> Vec<String> {
        let mut listings: Vec<&RunListing> = self.listings.values().collect();
        listings.sort_by(|a, b| {
            b.manifest
                .started_at
                .cmp(&a.manifest.started_at)
                .then_with(|| b.manifest.run_id.cmp(&a.manifest.run_id))
        });
        listings
            .into_iter()
            .map(|listing| listing.manifest.run_id.clone())
            .collect()
    }

    pub fn summaries(&self) -> Vec<Value> {
        self.ordered_run_ids()
            .iter()
            .filter_map(|id| self.listings.get(id))
            .map(RunListing::summary)
            .collect()
    }

    /// Discover new bundles and drop deleted ones. Full trace and session
    /// journals remain unopened until a consumer selects the run.
    pub fn scan(&mut self) -> bool {
        if self.single {
            return false;
        }
        let found = list_bundles(&self.runs_dir);
        let mut changed = false;
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (dir, manifest_raw, manifest) in found {
            let run_id = manifest.run_id.clone();
            if seen.contains(&run_id) {
                continue;
            }
            let Some(identity) = bundle_identity(&dir) else {
                continue;
            };
            let current_listing_is_valid = self.listings.get(&run_id).is_some_and(|listing| {
                listing.dir == dir
                    && listing.identity == identity
                    && (self.loaded.contains_key(&run_id) || listing.manifest_raw == manifest_raw)
            });
            if current_listing_is_valid {
                seen.insert(run_id.clone());
                if !self.loaded.contains_key(&run_id) {
                    if let Some(listing) = self.listings.get_mut(&run_id) {
                        changed |= listing.refresh_activity();
                    }
                }
                continue;
            }
            let generation = self.next_generation;
            let Some(candidate) =
                RunListing::open(dir, manifest_raw, manifest, identity, generation)
            else {
                continue;
            };
            seen.insert(run_id.clone());
            self.next_generation = self.next_generation.wrapping_add(1).max(1);
            if let Some(listing) = self.listings.get_mut(&run_id) {
                let (listing_changed, incarnation_changed) = listing.update_manifest(
                    candidate.dir,
                    candidate.manifest_raw,
                    candidate.manifest,
                    candidate.identity,
                    generation,
                );
                changed |= listing_changed;
                if incarnation_changed {
                    self.loaded.remove(&run_id);
                }
            } else {
                self.listings.insert(run_id, candidate);
                changed = true;
            }
        }
        let stale: Vec<String> = self
            .listings
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in stale {
            self.listings.remove(&id);
            self.loaded.remove(&id);
            changed = true;
        }
        changed
    }

    /// Rescan and refresh loaded runs, collecting patches.
    pub fn refresh_all(&mut self) -> RefreshOutcome {
        let mut listing_changed = self.scan();
        let mut patches = Vec::new();
        for (run_id, entry) in self.loaded.iter_mut() {
            // Terminal bundles are immutable per the format contract; stop
            // re-reading them (discovery of new runs still happens above).
            if !entry.live {
                continue;
            }
            if let Some(patch) = entry.refresh() {
                patches.push((run_id.clone(), entry.revision, patch));
            }
            if let Some(listing) = self.listings.get_mut(run_id) {
                listing_changed |= listing.differs_from_entry(entry);
                listing.sync_from_entry(entry);
            }
        }
        RefreshOutcome {
            patches,
            listing_changed,
        }
    }
}
