import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bot,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquareText,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import "./globals.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const SHARE_DB_NAME = "studyflow-share-target";
const SHARE_STORE_NAME = "shared-files";

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let error = { detail: "" };
    try {
      error = text ? JSON.parse(text) : error;
    } catch {
      error = { detail: text };
    }
    if (response.status === 413) {
      throw new Error("That file is larger than the server upload limit. Try a smaller file or ask admin to raise the limit.");
    }
    if (response.status === 504) {
      throw new Error("The server took too long processing this file. Try again, or use a smaller scanned PDF.");
    }
    throw new Error(error.detail || "Request failed");
  }
  return response.json();
}

function compactName(name = "", max = 28) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > -1 ? name.slice(dot) : "";
  const base = dot > -1 ? name.slice(0, dot) : name;
  return `${base.slice(0, Math.max(10, max - ext.length - 3))}...${ext}`;
}

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SHARE_STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSharedFiles() {
  if (!("indexedDB" in window)) return [];
  const db = await openShareDb();
  const rows = await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE_NAME, "readonly");
    const request = transaction.objectStore(SHARE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(transaction.error);
  });
  db.close();
  return rows.map((item) => ({
    id: item.id,
    file: new File([item.data], item.name, { type: item.type }),
  }));
}

async function clearSharedFiles(ids) {
  const db = await openShareDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SHARE_STORE_NAME);
    ids.forEach((id) => store.delete(id));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function App() {
  const [courseId, setCourseId] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [pickedFiles, setPickedFiles] = useState([]);
  const [sharedFiles, setSharedFiles] = useState([]);
  const [pasteText, setPasteText] = useState("");
  const [question, setQuestion] = useState("");
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [activePanel, setActivePanel] = useState("sources");

  const selectedMaterials = useMemo(
    () => materials.filter((material) => selectedIds.includes(material.id)),
    [materials, selectedIds]
  );

  async function ensureWorkspace() {
    const courses = await api("/courses");
    let workspace = courses.find((course) => course.name === "Ask Workspace") || courses[0];
    if (!workspace) {
      workspace = await api("/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Ask Workspace", code: "ASK" }),
      });
    }
    setCourseId(workspace.id);
    await loadMaterials(workspace.id);
    await loadConversations();
  }

  async function loadMaterials(id = courseId) {
    if (!id) return;
    const detail = await api(`/courses/${id}`);
    setMaterials(detail.materials || []);
  }

  async function loadConversations() {
    const rows = await api("/conversations");
    setConversations(rows);
    return rows;
  }

  async function openConversation(id) {
    const conversation = await api(`/conversations/${id}`);
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages || []);
    setSelectedIds(conversation.material_ids || []);
  }

  useEffect(() => {
    ensureWorkspace().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then((registration) => registration.update()).catch(() => {});
    }

    function handleBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  }, []);

  useEffect(() => {
    readSharedFiles()
      .then((files) => {
        if (files.length) {
          setSharedFiles(files);
          setNotice(`${files.length} shared file${files.length === 1 ? "" : "s"} ready to import.`);
          window.history.replaceState({}, "", "/");
        }
      })
      .catch(() => {});
  }, []);

  function toggleSelected(id) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  async function uploadFiles(files, title = "") {
    if (!files.length) return;
    if (!courseId) {
      setNotice("Workspace is still loading. Try again in a moment.");
      return;
    }

    setUploading(true);
    try {
      const body = new FormData();
      body.append("course_id", courseId);
      body.append("title", title);
      body.append("material_type", "slides");
      files.forEach((file) => body.append("files", file));
      const result = await api("/materials/bulk", { method: "POST", body });
      const newIds = result.uploaded.map((item) => item.id);
      setSelectedIds((current) => [...new Set([...current, ...newIds])]);
      setPickedFiles([]);
      await loadMaterials(courseId);
      setActivePanel("sources");
      setNotice(`Imported ${result.total_files} source${result.total_files === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setUploading(false);
    }
  }

  async function uploadPickedFiles(event) {
    event.preventDefault();
    await uploadFiles(pickedFiles);
  }

  async function importSharedFiles() {
    await uploadFiles(sharedFiles.map((item) => item.file));
    await clearSharedFiles(sharedFiles.map((item) => item.id));
    setSharedFiles([]);
  }

  async function clearSharedImport() {
    await clearSharedFiles(sharedFiles.map((item) => item.id));
    setSharedFiles([]);
    setNotice("Shared files cleared.");
  }

  async function importPaste() {
    if (!pasteText.trim()) return;
    const file = new File([pasteText.trim()], `pasted-note-${Date.now()}.txt`, {
      type: "text/plain",
    });
    await uploadFiles([file], "Pasted note");
    setPasteText("");
  }

  async function askQuestion(event) {
    event.preventDefault();
    if (!question.trim()) {
      setNotice("Type a question first.");
      return;
    }
    if (!selectedIds.length) {
      setNotice("Choose at least one source to ask about.");
      return;
    }

    setAsking(true);
    const userMessage = {
      id: `pending-user-${Date.now()}`,
      role: "user",
      content: question,
      material_ids: selectedIds,
      created_at: new Date().toISOString(),
    };
    const pendingMessage = {
      id: `pending-assistant-${Date.now()}`,
      role: "assistant",
      content: "Thinking...",
      mode: "pending",
      material_ids: selectedIds,
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage, pendingMessage]);
    const askedQuestion = question;
    setQuestion("");
    try {
      const response = await api("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material_ids: selectedIds,
          question: askedQuestion,
          conversation_id: activeConversationId,
        }),
      });
      setActiveConversationId(response.conversation_id);
      const conversation = await api(`/conversations/${response.conversation_id}`);
      setMessages(conversation.messages || []);
      await loadConversations();
      setNotice(response.mode === "ai" ? "Answered with AI from your selected sources." : "Answered from extracted text.");
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== userMessage.id && message.id !== pendingMessage.id));
      setQuestion(askedQuestion);
      setNotice(error.message);
    } finally {
      setAsking(false);
    }
  }

  async function deleteMaterial(material) {
    await api(`/materials/${material.id}`, { method: "DELETE" });
    setMaterials((current) => current.filter((item) => item.id !== material.id));
    setSelectedIds((current) => current.filter((id) => id !== material.id));
    setNotice(`Deleted ${material.title}.`);
  }

  async function newChat() {
    setActiveConversationId(null);
    setMessages([]);
    setQuestion("");
    setActivePanel("sources");
    setNotice("New chat ready.");
  }

  async function removeConversation(conversationId) {
    await api(`/conversations/${conversationId}`, { method: "DELETE" });
    if (activeConversationId === conversationId) {
      setActiveConversationId(null);
      setMessages([]);
    }
    await loadConversations();
    setNotice("Chat deleted.");
  }

  async function installApp() {
    if (!installPrompt) {
      setNotice("Use your browser menu to install StudyFlow on this device.");
      return;
    }
    await installPrompt.prompt();
    setInstallPrompt(null);
  }

  const addPanel = (
    <section className="mobile-panel">
      {sharedFiles.length > 0 && (
        <div className="mb-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
          <div className="flex items-center gap-3">
            <UploadCloud className="h-5 w-5 text-white/55" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Shared files ready</p>
              <p className="truncate text-xs text-white/45">{sharedFiles.map((item) => compactName(item.file.name)).join(", ")}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button className="rounded-full bg-white px-3 py-2 text-sm font-semibold text-black" onClick={importSharedFiles} type="button">
              Import
            </button>
            <button className="rounded-full border border-white/10 px-3 py-2 text-sm text-white/70" onClick={clearSharedImport} type="button">
              Clear
            </button>
          </div>
        </div>
      )}

      <form className="space-y-3" onSubmit={uploadPickedFiles}>
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-white/15 bg-black/20 p-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/65">
            <UploadCloud className="h-5 w-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Import files</span>
            <span className="block truncate text-xs text-white/45">PDF, DOCX, PPTX, TXT, images</span>
          </span>
          <input
            className="sr-only"
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.pptx,.txt,.md,image/*"
            onChange={(event) => setPickedFiles(Array.from(event.target.files || []))}
          />
        </label>

        {pickedFiles.length > 0 && (
          <div className="max-h-24 space-y-1 overflow-y-auto rounded-2xl bg-black/20 p-2">
            {pickedFiles.map((file) => (
              <div className="flex items-center justify-between gap-2 px-1 text-xs" key={`${file.name}-${file.lastModified}`}>
                <span className="truncate text-white/60">{compactName(file.name, 34)}</span>
                <button className="text-white/35" type="button" onClick={() => setPickedFiles((current) => current.filter((item) => item !== file))}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <button className="w-full rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black disabled:opacity-40" disabled={uploading || !pickedFiles.length}>
          {uploading ? "Importing..." : "Import selected"}
        </button>
      </form>

      <div className="my-3 h-px bg-white/10" />

      <textarea
        className="min-h-20 w-full resize-none rounded-2xl border border-white/10 bg-black/20 p-3 text-sm text-white outline-none placeholder:text-white/30"
        placeholder="Paste notes or copied text..."
        value={pasteText}
        onChange={(event) => setPasteText(event.target.value)}
      />
      <button
        className="mt-2 w-full rounded-full border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/75 disabled:opacity-40"
        disabled={!pasteText.trim() || uploading}
        type="button"
        onClick={importPaste}
      >
        Save pasted text
      </button>
    </section>
  );

  const sourcesPanel = (
    <section className="mobile-panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Sources</h2>
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/50">{selectedIds.length} selected</span>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {materials.length === 0 && (
          <p className="rounded-2xl bg-black/20 p-4 text-sm text-white/45">Upload a document to start asking.</p>
        )}
        {materials.map((material) => {
          const selected = selectedIds.includes(material.id);
          const isImage = /\.(png|jpe?g|webp|bmp|tiff)$/i.test(material.original_filename);
          return (
            <article
              className={`flex items-center gap-3 rounded-2xl border p-2.5 transition ${
                selected ? "border-white/25 bg-white/10" : "border-white/10 bg-black/20"
              }`}
              key={material.id}
            >
              <button
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${selected ? "bg-white text-black" : "bg-white/6 text-white/45"}`}
                type="button"
                onClick={() => toggleSelected(material.id)}
              >
                {selected ? <CheckCircle2 className="h-4 w-4" /> : isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
              </button>
              <button className="min-w-0 flex-1 text-left" type="button" onClick={() => toggleSelected(material.id)}>
                <strong className="block truncate text-sm font-medium">{material.title}</strong>
                <span className="block truncate text-xs text-white/40">{compactName(material.original_filename, 40)}</span>
              </button>
              <button className="rounded-full p-2 text-white/25 hover:text-red-200" type="button" onClick={() => deleteMaterial(material)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );

  const historyPanel = (
    <section className="mobile-panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Chat history</h2>
        <button className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-black" type="button" onClick={newChat}>
          New
        </button>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
        {conversations.length === 0 && (
          <p className="rounded-2xl bg-black/20 p-4 text-sm text-white/45">Your chats will be saved here.</p>
        )}
        {conversations.map((conversation) => (
          <article
            className={`flex items-center gap-3 rounded-2xl border p-2.5 ${
              activeConversationId === conversation.id ? "border-white/25 bg-white/10" : "border-white/10 bg-black/20"
            }`}
            key={conversation.id}
          >
            <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/6 text-white/55" type="button" onClick={() => openConversation(conversation.id).catch((error) => setNotice(error.message))}>
              <MessageSquareText className="h-4 w-4" />
            </button>
            <button className="min-w-0 flex-1 text-left" type="button" onClick={() => openConversation(conversation.id).catch((error) => setNotice(error.message))}>
              <strong className="block truncate text-sm font-medium">{conversation.title}</strong>
              <span className="block truncate text-xs text-white/40">{conversation.message_count} message{conversation.message_count === 1 ? "" : "s"}</span>
            </button>
            <button className="rounded-full p-2 text-white/25 hover:text-red-200" type="button" onClick={() => removeConversation(conversation.id).catch((error) => setNotice(error.message))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );

  return (
    <main className="min-h-screen bg-[#111111] text-[#f4f0e8]">
      <div className="lab-bg fixed inset-0 overflow-hidden" />
      <section className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 py-3 sm:px-5 lg:px-8">
        <header className="flex items-center justify-between gap-3 rounded-[1.6rem] border border-white/10 bg-[#1a1a1a]/85 px-3 py-2.5 backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#ede8dc] text-[#171717]">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold leading-tight">StudyFlow</p>
              <p className="truncate text-xs text-white/42">{selectedIds.length} source{selectedIds.length === 1 ? "" : "s"} selected</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/65" type="button" onClick={installApp}>
              Install
            </button>
            <button className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/75" type="button" onClick={newChat} aria-label="New chat">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </header>

        {notice && (
          <div className="mt-2 rounded-2xl border border-white/10 bg-[#1f1f1f]/90 px-3 py-2 text-xs text-white/60">
            {notice}
          </div>
        )}

        <div className="mt-3 grid min-h-0 flex-1 gap-3 lg:grid-cols-[340px_1fr]">
          <aside className="hidden space-y-3 lg:block">
            {addPanel}
            {sourcesPanel}
            {historyPanel}
          </aside>

          <section className="flex min-h-[calc(100vh-7.5rem)] flex-col overflow-hidden rounded-[1.8rem] border border-white/10 bg-[#171717]/92 shadow-2xl backdrop-blur lg:min-h-[760px]">
            <div className="border-b border-white/10 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/30">Ask</p>
                  <h1 className="truncate text-lg font-semibold">Chat with your materials</h1>
                </div>
                <button className="hidden rounded-full bg-[#ede8dc] px-4 py-2 text-sm font-semibold text-[#151515] sm:block" type="button" onClick={newChat}>
                  New chat
                </button>
              </div>

              <div className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
                {[
                  { id: "add", label: "Add", icon: Paperclip },
                  { id: "sources", label: `Sources ${selectedIds.length}`, icon: FileText },
                  { id: "history", label: "History", icon: MessageSquareText },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-2 text-xs font-medium ${
                        activePanel === item.id ? "bg-[#ede8dc] text-[#151515]" : "bg-white/10 text-white/60"
                      }`}
                      key={item.id}
                      type="button"
                      onClick={() => setActivePanel(activePanel === item.id ? "" : item.id)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {item.label}
                    </button>
                  );
                })}
              </div>

              {activePanel && (
                <div className="mt-3 lg:hidden">
                  {activePanel === "add" && addPanel}
                  {activePanel === "sources" && sourcesPanel}
                  {activePanel === "history" && historyPanel}
                </div>
              )}

              {selectedMaterials.length > 0 && (
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {selectedMaterials.map((material) => (
                    <button
                      className="inline-flex max-w-[220px] shrink-0 items-center rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/60"
                      key={material.id}
                      type="button"
                      onClick={() => toggleSelected(material.id)}
                    >
                      <span className="truncate">{material.title}</span>
                      <X className="ml-1.5 h-3 w-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-4">
              {messages.length === 0 && (
                <div className="flex min-h-[46vh] flex-col items-center justify-center px-4 text-center">
                  <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#ede8dc] text-[#151515]">
                    <Sparkles className="h-6 w-6" />
                  </div>
                  <h2 className="text-lg font-semibold">Ask naturally.</h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-white/42">
                    Upload or paste material, select the sources, then ask for explanations, summaries, quizzes, or revision notes.
                  </p>
                </div>
              )}
              {messages.length > 0 && (
                <div className="space-y-3">
                  {messages.map((message) => (
                    <article
                      className={`max-w-[86%] rounded-[1.35rem] px-3.5 py-3 text-sm leading-6 shadow-sm ${
                        message.role === "user"
                          ? "ml-auto rounded-br-md bg-[#d8d2c4] text-[#171717]"
                          : "mr-auto rounded-bl-md bg-[#242424] text-[#f4f0e8]"
                      }`}
                      key={message.id}
                    >
                      <p className="whitespace-pre-wrap">{message.content}</p>
                      {message.role !== "user" && message.mode && message.mode !== "pending" && (
                        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-white/28">{message.mode}</p>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <form className="border-t border-white/10 bg-[#151515] p-2.5" onSubmit={askQuestion}>
              <div className="flex items-end gap-2 rounded-[1.45rem] border border-white/10 bg-[#202020] p-2">
                <textarea
                  className="max-h-28 min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-5 text-white outline-none placeholder:text-white/30"
                  placeholder={selectedIds.length ? "Ask anything..." : "Select a source first..."}
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      askQuestion(event);
                    }
                  }}
                />
                <button
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#ede8dc] text-[#151515] disabled:opacity-35"
                  disabled={asking || !question.trim() || !selectedIds.length}
                  aria-label="Send"
                >
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
