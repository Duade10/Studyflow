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

  return (
    <main className="min-h-screen bg-[#0b0d10] text-white">
      <div className="lab-bg fixed inset-0 overflow-hidden" />
      <section className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-xl">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/40">StudyFlow</p>
              <h1 className="text-xl font-semibold tracking-tight">Ask your study materials</h1>
            </div>
          </div>
          <button
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 backdrop-blur hover:bg-white/10"
            type="button"
            onClick={installApp}
          >
            Install
          </button>
        </header>

        {notice && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm text-white/75">
            {notice}
          </div>
        )}

        <div className="grid flex-1 gap-4 py-5 lg:grid-cols-[380px_1fr]">
          <aside className="space-y-4">
            {sharedFiles.length > 0 && (
              <section className="rounded-[2rem] border border-emerald-400/20 bg-emerald-400/10 p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-emerald-300 p-2 text-black">
                    <UploadCloud className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">Shared into StudyFlow</h2>
                    <p className="truncate text-sm text-white/60">
                      {sharedFiles.map((item) => compactName(item.file.name)).join(", ")}
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <button className="flex-1 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black" onClick={importSharedFiles} type="button">
                    Import
                  </button>
                  <button className="rounded-full border border-white/10 px-4 py-2 text-sm text-white/70" onClick={clearSharedImport} type="button">
                    Clear
                  </button>
                </div>
              </section>
            )}

            <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 shadow-2xl backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">Add sources</h2>
                <Paperclip className="h-5 w-5 text-white/40" />
              </div>

              <form className="space-y-3" onSubmit={uploadPickedFiles}>
                <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-white/15 bg-black/20 px-4 py-5 text-center hover:border-white/35">
                  <UploadCloud className="mb-2 h-7 w-7 text-sky-300" />
                  <span className="text-sm font-medium">Upload PDFs, DOCX, PPTX, images</span>
                  <span className="mt-1 text-xs text-white/40">Multiple files supported</span>
                  <input
                    className="sr-only"
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,.pptx,.txt,.md,image/*"
                    onChange={(event) => setPickedFiles(Array.from(event.target.files || []))}
                  />
                </label>

                {pickedFiles.length > 0 && (
                  <div className="space-y-2 rounded-2xl bg-black/20 p-3">
                    {pickedFiles.map((file) => (
                      <div className="flex items-center justify-between gap-2 text-sm" key={`${file.name}-${file.lastModified}`}>
                        <span className="truncate text-white/70">{compactName(file.name, 36)}</span>
                        <button
                          className="text-white/40 hover:text-white"
                          type="button"
                          onClick={() => setPickedFiles((current) => current.filter((item) => item !== file))}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  className="w-full rounded-full bg-white px-4 py-3 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={uploading || !pickedFiles.length}
                >
                  {uploading ? "Importing..." : "Import files"}
                </button>
              </form>

              <div className="my-4 h-px bg-white/10" />

              <textarea
                className="min-h-28 w-full resize-none rounded-[1.5rem] border border-white/10 bg-black/20 p-4 text-sm text-white outline-none placeholder:text-white/30 focus:border-sky-300/50"
                placeholder="Paste text, notes, copied slides, or a WhatsApp message here..."
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
              />
              <button
                className="mt-3 w-full rounded-full border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/80 disabled:opacity-40"
                disabled={!pasteText.trim() || uploading}
                type="button"
                onClick={importPaste}
              >
                Save pasted text
              </button>
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Sources</h2>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/60">{selectedIds.length} selected</span>
              </div>
              <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                {materials.length === 0 && (
                  <p className="rounded-2xl bg-black/20 p-4 text-sm text-white/45">Upload something to start asking.</p>
                )}
                {materials.map((material) => {
                  const selected = selectedIds.includes(material.id);
                  const isImage = /\.(png|jpe?g|webp|bmp|tiff)$/i.test(material.original_filename);
                  return (
                    <article
                      className={`flex items-center gap-3 rounded-2xl border p-3 transition ${
                        selected ? "border-sky-300/50 bg-sky-300/10" : "border-white/10 bg-black/20"
                      }`}
                      key={material.id}
                    >
                      <button
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                          selected ? "bg-sky-300 text-black" : "bg-white/5 text-white/50"
                        }`}
                        type="button"
                        onClick={() => toggleSelected(material.id)}
                      >
                        {selected ? <CheckCircle2 className="h-5 w-5" /> : isImage ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                      </button>
                      <button className="min-w-0 flex-1 text-left" type="button" onClick={() => toggleSelected(material.id)}>
                        <strong className="block truncate text-sm">{material.title}</strong>
                        <span className="block truncate text-xs text-white/45">{compactName(material.original_filename, 42)}</span>
                      </button>
                      <button
                        className="rounded-full p-2 text-white/35 hover:bg-red-400/10 hover:text-red-200"
                        type="button"
                        onClick={() => deleteMaterial(material)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Chat history</h2>
                <button
                  className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-black"
                  type="button"
                  onClick={newChat}
                >
                  New
                </button>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {conversations.length === 0 && (
                  <p className="rounded-2xl bg-black/20 p-4 text-sm text-white/45">Your chats will be saved here.</p>
                )}
                {conversations.map((conversation) => (
                  <article
                    className={`flex items-center gap-3 rounded-2xl border p-3 ${
                      activeConversationId === conversation.id
                        ? "border-emerald-300/50 bg-emerald-300/10"
                        : "border-white/10 bg-black/20"
                    }`}
                    key={conversation.id}
                  >
                    <button
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/5 text-white/55"
                      type="button"
                      onClick={() => openConversation(conversation.id).catch((error) => setNotice(error.message))}
                    >
                      <MessageSquareText className="h-4 w-4" />
                    </button>
                    <button
                      className="min-w-0 flex-1 text-left"
                      type="button"
                      onClick={() => openConversation(conversation.id).catch((error) => setNotice(error.message))}
                    >
                      <strong className="block truncate text-sm">{conversation.title}</strong>
                      <span className="block truncate text-xs text-white/45">
                        {conversation.message_count} message{conversation.message_count === 1 ? "" : "s"}
                      </span>
                    </button>
                    <button
                      className="rounded-full p-2 text-white/30 hover:bg-red-400/10 hover:text-red-200"
                      type="button"
                      onClick={() => removeConversation(conversation.id).catch((error) => setNotice(error.message))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </aside>

          <section className="flex min-h-[640px] flex-col rounded-[2.4rem] border border-white/10 bg-white/[0.045] p-4 shadow-2xl backdrop-blur lg:p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/35">Ask</p>
                <h2 className="text-2xl font-semibold tracking-tight">Chat with selected sources</h2>
              </div>
              <button
                className="inline-flex items-center gap-2 rounded-full bg-sky-300 px-4 py-2 text-sm font-semibold text-black"
                type="button"
                onClick={newChat}
              >
                <Plus className="h-4 w-4" />
                New chat
              </button>
            </div>

            <div className="mb-4 flex flex-wrap gap-2">
              {selectedMaterials.length === 0 ? (
                <span className="rounded-full bg-black/20 px-3 py-2 text-sm text-white/45">No source selected yet</span>
              ) : (
                selectedMaterials.map((material) => (
                  <button
                    className="max-w-full rounded-full bg-white/10 px-3 py-2 text-sm text-white/75"
                    key={material.id}
                    type="button"
                    onClick={() => toggleSelected(material.id)}
                  >
                    <span className="inline-block max-w-[220px] truncate align-bottom">{material.title}</span>
                    <X className="ml-2 inline h-3.5 w-3.5" />
                  </button>
                ))
              )}
            </div>

            <div className="flex-1 overflow-y-auto rounded-[1.75rem] bg-black/20 p-4">
              {messages.length === 0 && (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white text-black">
                    <Sparkles className="h-7 w-7" />
                  </div>
                  <h3 className="text-xl font-semibold">Ask across PDFs, docs, slides, images, or pasted text.</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-white/45">
                    Select the exact sources you want, then ask for explanations, summaries, quizzes, weak areas, or revision notes.
                  </p>
                </div>
              )}
              {messages.length > 0 && (
                <div className="space-y-3">
                  {messages.map((message) => (
                    <article
                      className={`max-w-[92%] rounded-2xl p-4 ${
                        message.role === "user"
                          ? "ml-auto bg-sky-300 text-black"
                          : "mr-auto bg-white text-black"
                      }`}
                      key={message.id}
                    >
                      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] opacity-45">
                        {message.role === "user" ? "You" : message.mode === "pending" ? "StudyFlow" : `${message.mode || "saved"} answer`}
                      </p>
                      <p className="whitespace-pre-wrap leading-7">{message.content}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <form className="mt-4 rounded-[1.75rem] border border-white/10 bg-black/25 p-3" onSubmit={askQuestion}>
              <textarea
                className="min-h-24 w-full resize-none bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-white/30"
                placeholder="Ask a question about the selected sources..."
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    askQuestion(event);
                  }
                }}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-white/35">{selectedIds.length} source{selectedIds.length === 1 ? "" : "s"} selected</span>
                <button
                  className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={asking || !question.trim() || !selectedIds.length}
                >
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {asking ? "Thinking" : "Ask"}
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
