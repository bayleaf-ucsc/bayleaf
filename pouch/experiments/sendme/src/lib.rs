//! Standalone browser experiment, not imported by Pouch or granted its capabilities.
//! Uses Sendme's actual blobs collection format, not a new transfer protocol.
use std::{cell::{Cell, RefCell}, str::FromStr, time::Duration};

use anyhow::{Context, Result, ensure};
use iroh::{Endpoint, endpoint::{Connection, presets}, protocol::Router};
use iroh_blobs::{
    BlobFormat, BlobsProtocol,
    api::{TempTag, remote::GetProgressItem},
    format::collection::Collection,
    get::request::get_hash_seq_and_sizes,
    store::mem::MemStore,
    ticket::BlobTicket,
};
use n0_future::{StreamExt, time::timeout};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const LIMIT: u64 = 64 * 1024 * 1024;
const MAX_FILES: usize = 256;

fn js_error(e: impl std::fmt::Display) -> JsError { JsError::new(&e.to_string()) }
fn safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('\\') && !name.contains('\0')
        && name.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains(':'))
}

#[wasm_bindgen(start)]
pub fn init() { console_error_panic_hook::set_once(); }

#[derive(Serialize)]
struct FileInfo { name: String, hash: String, size: u64 }

#[wasm_bindgen]
pub struct TransferNode {
    router: Router,
    store: MemStore,
    files: RefCell<Vec<(String, TempTag)>>,
    collection: RefCell<Option<TempTag>>,
    active: RefCell<Option<Connection>>,
    received: RefCell<Option<Collection>>,
    added_bytes: Cell<u64>,
}

#[wasm_bindgen]
impl TransferNode {
    pub async fn spawn() -> Result<TransferNode, JsError> {
        let endpoint = Endpoint::builder(presets::N0).bind().await.map_err(js_error)?;
        let store = MemStore::new();
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, None)).spawn();
        timeout(Duration::from_secs(30), router.endpoint().online()).await.map_err(js_error)?;
        Ok(Self { router, store, files: RefCell::new(Vec::new()), collection: RefCell::new(None),
            active: RefCell::new(None), received: RefCell::new(None), added_bytes: Cell::new(0) })
    }

    pub fn endpoint_id(&self) -> String { self.router.endpoint().id().to_string() }

    pub async fn add_file(&self, name: String, bytes: Vec<u8>) -> Result<(), JsError> {
        if !safe_name(&name) { return Err(js_error("unsafe or empty file name")); }
        if self.files.borrow().len() >= MAX_FILES { return Err(js_error("too many files")); }
        let total = self.added_bytes.get() + bytes.len() as u64;
        if total > LIMIT - 65536 { return Err(js_error("files exceed experiment limit (64 MiB including metadata)")); }
        if self.files.borrow().iter().any(|(n, _)| n == &name) { return Err(js_error("duplicate name")); }
        let tag = self.store.add_bytes(bytes).temp_tag().await.map_err(js_error)?;
        self.files.borrow_mut().push((name, tag));
        self.added_bytes.set(total);
        Ok(())
    }

    pub async fn ticket(&self) -> Result<String, JsError> {
        let collection: Collection = self.files.borrow().iter().map(|(n, t)| (n.clone(), t.hash())).collect();
        if collection.is_empty() { return Err(js_error("select at least one file")); }
        let tag = collection.store(&self.store).await.map_err(js_error)?;
        let ticket = BlobTicket::new(self.router.endpoint().addr(), tag.hash(), BlobFormat::HashSeq);
        *self.collection.borrow_mut() = Some(tag);
        Ok(ticket.to_string())
    }

    /// Closes the transport, retaining validated bytes in memory for a retry.
    pub fn pause(&self) {
        if let Some(conn) = self.active.borrow().as_ref() { conn.close(0u8.into(), b"paused"); }
    }

    pub async fn receive(&self, ticket: String, progress: js_sys::Function) -> Result<JsValue, JsError> {
        let result = self.receive_inner(&ticket, &progress).await;
        if let Some(conn) = self.active.borrow_mut().take() { conn.close(0u8.into(), b"done"); }
        result.map_err(js_error)
    }

    pub async fn file_bytes(&self, index: usize) -> Result<Vec<u8>, JsError> {
        let hash = self.received.borrow().as_ref().and_then(|c| c.iter().nth(index).map(|(_, h)| *h))
            .ok_or_else(|| js_error("no such received file"))?;
        Ok(self.store.get_bytes(hash).await.map_err(js_error)?.to_vec())
    }

    pub async fn close(&self) -> Result<(), JsError> {
        self.pause();
        // BlobsProtocol::shutdown already shuts down its store.
        self.router.shutdown().await.map_err(js_error)?;
        Ok(())
    }
}

impl TransferNode {
    async fn receive_inner(&self, text: &str, progress: &js_sys::Function) -> Result<JsValue> {
        ensure!(self.active.borrow().is_none(), "already receiving");
        let ticket = BlobTicket::from_str(text.trim()).context("invalid Sendme ticket")?;
        ensure!(ticket.format() == BlobFormat::HashSeq, "expected a Sendme collection ticket");
        let conn = timeout(Duration::from_secs(30), self.router.endpoint().connect(ticket.addr().clone(), iroh_blobs::ALPN)).await??;
        *self.active.borrow_mut() = Some(conn.clone());
        // Bound collection metadata, then the advertised aggregate before downloading content.
        let (_, sizes) = timeout(Duration::from_secs(30), get_hash_seq_and_sizes(&conn, &ticket.hash(), 1024 * 1024, None)).await??;
        ensure!(sizes.len() <= MAX_FILES + 2, "too many files");
        let total = sizes.iter().try_fold(0u64, |sum, n| sum.checked_add(*n)).context("size overflow")?;
        ensure!(total <= LIMIT, "parcel exceeds 64 MiB experiment limit");
        let local = self.store.remote().local(ticket.hash_and_format()).await?;
        let before = local.local_bytes();
        let notify = |downloaded: u64| {
            let _ = progress.call3(&JsValue::NULL, &JsValue::from_f64(downloaded as f64),
                &JsValue::from_f64(total as f64), &JsValue::from_f64(before as f64));
        };
        notify(0);
        if !local.is_complete() {
            let get = self.store.remote().execute_get(conn, local.missing());
            let mut stream = get.stream();
            let mut done = false;
            while let Some(item) = stream.next().await {
                match item {
                    GetProgressItem::Progress(bytes) => notify(bytes),
                    GetProgressItem::Done(_) => { done = true; break; }
                    GetProgressItem::Error(e) => return Err(e.into()),
                }
            }
            ensure!(done, "transfer ended before completion");
        }
        let collection = Collection::load(ticket.hash(), self.store.as_ref()).await?;
        ensure!(collection.len() <= MAX_FILES, "too many names");
        let mut infos = Vec::new();
        let mut names = std::collections::HashSet::new();
        for (name, hash) in collection.iter() {
            ensure!(safe_name(name) && names.insert(name.clone()), "unsafe or duplicate received name");
            let size = self.store.get_bytes(*hash).await?.len() as u64;
            infos.push(FileInfo { name: name.clone(), hash: hash.to_string(), size });
        }
        *self.received.borrow_mut() = Some(collection);
        Ok(serde_wasm_bindgen::to_value(&infos)?)
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;
    #[test]
    fn paths_are_relative_and_unambiguous() {
        for name in ["hello.txt", "folder/photo.png"] { assert!(safe_name(name)); }
        for name in ["", "/abs", "a/../b", "a//b", "a\\b", "C:file", "a\0b", "./a"] { assert!(!safe_name(name)); }
    }
}
