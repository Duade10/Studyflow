const CACHE_NAME = "studyflow-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/pwa-icon.svg"];
const DB_NAME = "studyflow-share-target";
const STORE_NAME = "shared-files";

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSharedFiles(files) {
  const db = await openShareDb();
  await Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          const store = transaction.objectStore(STORE_NAME);
          store.put({
            id: `${Date.now()}-${crypto.randomUUID()}`,
            name: file.name || "Shared material",
            type: file.type || "application/octet-stream",
            data: file,
            createdAt: Date.now()
          });
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        })
    )
  );
  db.close();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const files = formData
          .getAll("files")
          .filter((item) => item && typeof item === "object" && "arrayBuffer" in item);

        if (files.length) {
          await saveSharedFiles(files);
        }

        return Response.redirect("/?shared=1", 303);
      })()
    );
    return;
  }

  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((response) => response || caches.match("/")))
  );
});
