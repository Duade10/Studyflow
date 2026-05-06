import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  Bot,
  CalendarCheck,
  Check,
  CircleUserRound,
  FileQuestion,
  FileUp,
  FlaskConical,
  FolderOpen,
  GraduationCap,
  HelpCircle,
  Layers,
  Plus,
  Search,
  Send,
  Share2,
  Sparkles,
  Smartphone,
  Trash2,
} from "lucide-react";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const SHARE_DB_NAME = "studyflow-share-target";
const SHARE_STORE_NAME = "shared-files";
const compactName = (name = "", max = 34) => {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > -1 ? name.slice(dot) : "";
  const base = dot > -1 ? name.slice(0, dot) : name;
  return `${base.slice(0, Math.max(12, max - extension.length - 3))}...${extension}`;
};

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(error.detail || "Request failed");
  }
  return response.json();
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
  const files = await new Promise((resolve, reject) => {
    const transaction = db.transaction(SHARE_STORE_NAME, "readonly");
    const request = transaction.objectStore(SHARE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return files.map((item) => ({
    id: item.id,
    file: new File([item.data], item.name, { type: item.type }),
    createdAt: item.createdAt,
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
  const [courses, setCourses] = useState([]);
  const [selectedCourseId, setSelectedCourseId] = useState(null);
  const [courseDetail, setCourseDetail] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [notice, setNotice] = useState("");
  const [activeView, setActiveView] = useState("today");
  const [courseForm, setCourseForm] = useState({ name: "", code: "" });
  const [uploadForm, setUploadForm] = useState({ title: "", material_type: "slides", files: [] });
  const [chunkForm, setChunkForm] = useState({ material_id: "", title: "", difficulty: "medium", notes: "" });
  const [askForm, setAskForm] = useState({ material_id: "", question: "" });
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [sharedFiles, setSharedFiles] = useState([]);
  const [shareMaterialType, setShareMaterialType] = useState("slides");
  const [importingShare, setImportingShare] = useState(false);
  const [filesPanel, setFilesPanel] = useState("upload");
  const [expandedMaterialId, setExpandedMaterialId] = useState(null);

  const selectedCourse = useMemo(
    () => courses.find((course) => course.id === selectedCourseId),
    [courses, selectedCourseId]
  );

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const materialCount = courseDetail?.materials?.length || 0;
  const chunkCount = courseDetail?.chunks?.length || 0;

  async function refresh() {
    const [courseRows, taskRows] = await Promise.all([api("/courses"), api("/tasks")]);
    setCourses(courseRows);
    setTasks(taskRows);
    if (!selectedCourseId && courseRows.length > 0) {
      setSelectedCourseId(courseRows[0].id);
    }
  }

  async function refreshCourse(courseId = selectedCourseId) {
    if (!courseId) return;
    setCourseDetail(await api(`/courses/${courseId}`));
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    refreshCourse(selectedCourseId).catch((error) => setNotice(error.message));
  }, [selectedCourseId]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone;
    setIsInstalled(Boolean(standalone));

    function handleBeforeInstallPrompt(event) {
      event.preventDefault();
      setInstallPrompt(event);
    }

    function handleInstalled() {
      setIsInstalled(true);
      setInstallPrompt(null);
      setNotice("StudyFlow installed.");
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  useEffect(() => {
    readSharedFiles()
      .then((files) => {
        setSharedFiles(files);
        if (files.length) {
          setActiveView("materials");
          setNotice(`${files.length} shared document${files.length === 1 ? "" : "s"} ready to import.`);
          window.history.replaceState({}, "", "/");
        }
      })
      .catch(() => {});
  }, []);

  async function installApp() {
    if (!installPrompt) {
      setNotice("Use your browser menu to install StudyFlow on this device.");
      return;
    }
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  async function createCourse(event) {
    event.preventDefault();
    if (!courseForm.name.trim()) return;
    try {
      const course = await api("/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(courseForm),
      });
      setCourseForm({ name: "", code: "" });
      setSelectedCourseId(course.id);
      setActiveView("materials");
      setNotice("Course created.");
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function uploadMaterial(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!selectedCourseId) {
      setNotice("Create or select a course before uploading material.");
      return;
    }
    if (!uploadForm.files.length) {
      setNotice("Choose at least one file before uploading.");
      return;
    }
    if (uploadForm.files.length === 1 && !uploadForm.title.trim()) {
      setNotice("Add a material title before uploading.");
      return;
    }
    try {
      const body = new FormData();
      body.append("course_id", selectedCourseId);
      body.append("title", uploadForm.title);
      body.append("material_type", uploadForm.material_type);
      uploadForm.files.forEach((file) => body.append("files", file));
      const result = await api("/materials/bulk", { method: "POST", body });
      setUploadForm({ title: "", material_type: "slides", files: [] });
      form.reset();
      setNotice(`Processed ${result.total_files} document${result.total_files === 1 ? "" : "s"} and generated ${result.total_generated} item${result.total_generated === 1 ? "" : "s"}.`);
      await refreshCourse();
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function createChunk(event) {
    event.preventDefault();
    if (!chunkForm.material_id || !chunkForm.title.trim()) return;
    try {
      const chunk = await api(`/materials/${chunkForm.material_id}/chunks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: chunkForm.title,
          difficulty: chunkForm.difficulty,
          notes: chunkForm.notes,
        }),
      });
      await api(`/chunks/${chunk.id}/generate-task`, { method: "POST" });
      setChunkForm({ ...chunkForm, title: "", notes: "" });
      setNotice("Section added and task generated.");
      await refreshCourse();
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function toggleTask(task) {
    await api(`/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: task.status === "done" ? "todo" : "done" }),
    });
    await refresh();
  }

  async function askMaterial(event) {
    event.preventDefault();
    if (!askForm.material_id) {
      setNotice("Choose a material to ask about.");
      return;
    }
    if (!askForm.question.trim()) {
      setNotice("Type a question first.");
      return;
    }
    setAsking(true);
    setAnswer(null);
    try {
      const response = await api(`/materials/${askForm.material_id}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: askForm.question }),
      });
      setAnswer(response);
      setNotice(response.mode === "ai" ? "Answered from your material." : "Answered with extracted text.");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setAsking(false);
    }
  }

  async function deleteMaterial(material) {
    const confirmed = window.confirm(`Delete "${material.title}" and its generated tasks?`);
    if (!confirmed) return;
    try {
      await api(`/materials/${material.id}`, { method: "DELETE" });
      setNotice(`Deleted ${material.title}.`);
      if (askForm.material_id === String(material.id)) {
        setAskForm({ material_id: "", question: "" });
        setAnswer(null);
      }
      await refreshCourse();
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function openMaterialExternal(material) {
    window.location.href = `${API_BASE}/materials/${material.id}/file`;
  }

  async function shareMaterial(material) {
    const fileUrl = `${API_BASE}/materials/${material.id}/file`;
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error("Could not fetch file");
      const blob = await response.blob();
      const file = new File([blob], material.original_filename, {
        type: blob.type || "application/octet-stream",
      });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: material.title,
          text: "Open this study material",
        });
        return;
      }

      setNotice("This device cannot share files directly. Use Open with instead.");
    } catch (error) {
      setNotice(error.message || "Could not share file.");
    }
  }

  async function importSharedFiles() {
    if (!selectedCourseId) {
      setNotice("Create or select a course before importing shared files.");
      return;
    }
    if (!sharedFiles.length) return;

    setImportingShare(true);
    try {
      const body = new FormData();
      body.append("course_id", selectedCourseId);
      body.append("material_type", shareMaterialType);
      sharedFiles.forEach((item) => body.append("files", item.file));
      const result = await api("/materials/bulk", { method: "POST", body });
      await clearSharedFiles(sharedFiles.map((item) => item.id));
      setSharedFiles([]);
      setNotice(`Imported ${result.total_files} shared document${result.total_files === 1 ? "" : "s"} into Files.`);
      await refreshCourse();
      await refresh();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setImportingShare(false);
    }
  }

  async function clearSharedImport() {
    if (!sharedFiles.length) return;
    await clearSharedFiles(sharedFiles.map((item) => item.id));
    setSharedFiles([]);
    setNotice("Cleared shared files.");
  }

  const dockItems = [
    { id: "today", label: "Today", icon: CalendarCheck },
    { id: "materials", label: "Files", icon: FolderOpen },
    { id: "ask", label: "Ask", icon: Bot },
    { id: "courses", label: "Courses", icon: GraduationCap },
  ];

  return (
    <main className="app">
      <header className="phone-top">
        <button className="bubble-button" type="button" aria-label="Profile">
          <CircleUserRound size={30} />
        </button>
        <div className="brand-lockup">
          <div className="brand-flower"><Sparkles size={30} /></div>
          <strong>StudyFlow</strong>
        </div>
        <div className="top-actions">
          <button className="bubble-button" type="button" aria-label="New course" onClick={() => setActiveView("courses")}>
            <Plus size={30} />
          </button>
          <button className="bubble-button" type="button" aria-label="Ask" onClick={() => setActiveView("ask")}>
            <Search size={30} />
          </button>
        </div>
      </header>

      <section className="hero-balance">
        <div className="segmented-control">
          <button className={activeView === "today" ? "selected" : ""} onClick={() => setActiveView("today")} type="button">
            Today
          </button>
          <button className={activeView === "materials" ? "selected" : ""} onClick={() => setActiveView("materials")} type="button">
            Materials
          </button>
        </div>
        <p>{selectedCourse ? selectedCourse.name : "No course selected"}</p>
        <h1>{doneCount}/{tasks.length}</h1>
        <span>tasks complete</span>
      </section>

      {courses.length > 0 && (
        <nav className="course-tabs" aria-label="Courses">
          {courses.map((course) => (
            <button
              className={course.id === selectedCourseId ? "active" : ""}
              key={course.id}
              onClick={() => setSelectedCourseId(course.id)}
              type="button"
            >
              {course.name}
            </button>
          ))}
        </nav>
      )}

      {notice && <div className="notice">{notice}</div>}

      {!isInstalled && (
        <article className="install-card">
          <span className="row-icon"><Smartphone size={23} /></span>
          <div>
            <strong>Install StudyFlow</strong>
            <p>Keep the MVP on your home screen for quick study sessions.</p>
          </div>
          <button type="button" onClick={installApp}>Install</button>
        </article>
      )}

      <section className="screen-panel">
        {activeView === "today" && (
          <div className="view-stack">
            <div className="todo-carousel">
              <article className="todo-card accent-blue">
                <small>Study</small>
                <strong>{tasks.find((task) => task.status !== "done")?.title || "Upload slides to begin"}</strong>
                <BookOpen size={64} />
              </article>
              <article className="todo-card accent-green">
                <small>Materials</small>
                <strong>{materialCount} files</strong>
                <FolderOpen size={64} />
              </article>
            </div>

            <article className="forecast-pill">
              <span className="glass-icon">◌</span>
              <div>
                <strong>Upcoming</strong>
                <p>{chunkCount ? `${chunkCount} generated sections waiting` : "Upload a PDF to generate sections"}</p>
              </div>
            </article>

            <div className="section-line">
              <h2>Today</h2>
              <span>{doneCount}/{tasks.length}</span>
            </div>

            <div className="list-stack">
              {tasks.length === 0 && <p className="empty">No tasks yet.</p>}
              {tasks.map((task) => (
                <button className={`task-row ${task.status}`} key={task.id} onClick={() => toggleTask(task)} type="button">
                  <span className="row-icon">
                    {task.task_type === "practical" ? <FlaskConical size={22} /> : task.task_type === "practice" ? <HelpCircle size={22} /> : <BookOpen size={22} />}
                  </span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>{task.course_name}</small>
                  </span>
                  <Check size={22} />
                </button>
              ))}
            </div>
          </div>
        )}

        {activeView === "materials" && (
          <div className="view-stack">
            {sharedFiles.length > 0 && (
              <article className="shared-import-card">
                <div className="row-icon"><FileUp size={22} /></div>
                <div>
                  <strong>Shared from WhatsApp</strong>
                  <p>{sharedFiles.length} file{sharedFiles.length === 1 ? "" : "s"} · {sharedFiles.map((item) => compactName(item.file.name, 22)).join(", ")}</p>
                </div>
                <select value={shareMaterialType} onChange={(event) => setShareMaterialType(event.target.value)}>
                  <option value="slides">Slides / Notes</option>
                  <option value="past_questions">Past Questions</option>
                  <option value="practical">Practical Guide</option>
                </select>
                <button type="button" disabled={importingShare || !selectedCourseId} onClick={importSharedFiles}>
                  {importingShare ? "Importing" : "Import"}
                </button>
                <button className="ghost-action" type="button" disabled={importingShare} onClick={clearSharedImport}>
                  Clear
                </button>
              </article>
            )}

            <div className="files-actions">
              <button className={filesPanel === "upload" ? "active" : ""} type="button" onClick={() => setFilesPanel(filesPanel === "upload" ? "" : "upload")}>
                <FileUp size={18} />
                Upload
              </button>
              <button className={filesPanel === "section" ? "active" : ""} type="button" onClick={() => setFilesPanel(filesPanel === "section" ? "" : "section")}>
                <Layers size={18} />
                Section
              </button>
            </div>

            {filesPanel === "upload" && (
              <form className="glass-form compact-form" onSubmit={uploadMaterial}>
                <input
                  placeholder="Title, optional for multiple files"
                  value={uploadForm.title}
                  onChange={(event) => setUploadForm({ ...uploadForm, title: event.target.value })}
                  disabled={!selectedCourseId}
                />
                <div className="form-grid">
                  <select
                    value={uploadForm.material_type}
                    onChange={(event) => setUploadForm({ ...uploadForm, material_type: event.target.value })}
                    disabled={!selectedCourseId}
                  >
                    <option value="slides">Slides / Notes</option>
                    <option value="past_questions">Past Questions</option>
                    <option value="practical">Practical Guide</option>
                  </select>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,image/*"
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      const inferredTitle = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : "";
                      setUploadForm({ ...uploadForm, files, title: uploadForm.title || inferredTitle });
                    }}
                    disabled={!selectedCourseId}
                  />
                </div>
                <div className="compact-submit">
                  <p className="file-count">{uploadForm.files.length ? `${uploadForm.files.length} selected` : "PDF, DOCX, images"}</p>
                  <div className="submit-actions">
                    {uploadForm.files.length > 0 && (
                      <button
                        className="ghost-action"
                        type="button"
                        onClick={() => {
                          setUploadForm({ ...uploadForm, title: "", files: [] });
                          const input = document.querySelector(".compact-form input[type='file']");
                          if (input) input.value = "";
                        }}
                      >
                        Clear
                      </button>
                    )}
                    <button disabled={!selectedCourseId}>Upload</button>
                  </div>
                </div>
              </form>
            )}

            {filesPanel === "section" && (
              <form className="glass-form compact-form" onSubmit={createChunk}>
                <select
                  value={chunkForm.material_id}
                  onChange={(event) => setChunkForm({ ...chunkForm, material_id: event.target.value })}
                  disabled={!courseDetail?.materials?.length}
                >
                  <option value="">Choose material</option>
                  {courseDetail?.materials?.map((material) => (
                    <option value={material.id} key={material.id}>{material.title}</option>
                  ))}
                </select>
                <div className="form-grid">
                  <input
                    placeholder="Topic or section title"
                    value={chunkForm.title}
                    onChange={(event) => setChunkForm({ ...chunkForm, title: event.target.value })}
                  />
                  <select value={chunkForm.difficulty} onChange={(event) => setChunkForm({ ...chunkForm, difficulty: event.target.value })}>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                  </select>
                </div>
                <div className="compact-submit">
                  <p className="file-count">Adds a task for today</p>
                  <button disabled={!courseDetail?.materials?.length}>Save</button>
                </div>
              </form>
            )}

            <div className="section-line">
              <h2>Material Hub</h2>
              <span>{chunkCount} sections</span>
            </div>

            <div className="list-stack">
              {courseDetail?.materials?.length === 0 && <p className="empty">Materials will appear here.</p>}
              {courseDetail?.materials?.map((material) => (
                <article key={material.id} className="material-row">
                  <div className="row-icon"><FolderOpen size={22} /></div>
                  <div>
                    <strong>{material.title}</strong>
                    <small title={material.original_filename}>{material.material_type.replace("_", " ")} · {compactName(material.original_filename)}</small>
                  </div>
                  <div className="material-actions">
                    <span>{courseDetail.chunks.filter((chunk) => chunk.material_id === material.id).length}</span>
                    <button type="button" aria-label={`Show details for ${material.title}`} onClick={() => setExpandedMaterialId(expandedMaterialId === material.id ? null : material.id)}>
                      <Layers size={18} />
                    </button>
                    {(material.original_filename.toLowerCase().endsWith(".pdf") || material.original_filename.toLowerCase().endsWith(".docx") || material.original_filename.toLowerCase().endsWith(".doc")) && (
                      <button type="button" aria-label={`Open ${material.title}`} onClick={() => openMaterialExternal(material)}>
                        <BookOpen size={18} />
                      </button>
                    )}
                    {(material.original_filename.toLowerCase().endsWith(".pdf") || material.original_filename.toLowerCase().endsWith(".docx") || material.original_filename.toLowerCase().endsWith(".doc")) && (
                      <button type="button" aria-label={`Share ${material.title}`} onClick={() => shareMaterial(material)}>
                        <Share2 size={18} />
                      </button>
                    )}
                    <button type="button" aria-label={`Delete ${material.title}`} onClick={() => deleteMaterial(material)}>
                      <Trash2 size={20} />
                    </button>
                  </div>
                </article>
              ))}
            </div>

            {expandedMaterialId && (
              <section className="sections-sheet">
                <div className="section-line">
                  <h2>Sections</h2>
                  <button type="button" onClick={() => setExpandedMaterialId(null)}>Close</button>
                </div>
                <div className="section-chip-grid">
                  {courseDetail.chunks
                    .filter((chunk) => chunk.material_id === expandedMaterialId)
                    .map((chunk) => (
                      <article className="section-chip" key={chunk.id}>
                        <strong>{chunk.title}</strong>
                        <small>{chunk.difficulty}{chunk.summary ? ` · ${chunk.summary}` : ""}</small>
                      </article>
                    ))}
                </div>
              </section>
            )}
          </div>
        )}

        {activeView === "ask" && (
          <div className="view-stack">
            <form className="ask-surface" onSubmit={askMaterial}>
              <h2><Bot size={22} /> Ask Your Material</h2>
              <select
                value={askForm.material_id}
                onChange={(event) => setAskForm({ ...askForm, material_id: event.target.value })}
                disabled={!courseDetail?.materials?.length}
              >
                <option value="">Choose PDF or material</option>
                {courseDetail?.materials?.map((material) => (
                  <option value={material.id} key={material.id}>{material.title}</option>
                ))}
              </select>
              <div className="question-box">
                <FileQuestion size={20} />
                <input
                  placeholder="Explain this topic, quiz me, or make revision notes"
                  value={askForm.question}
                  onChange={(event) => setAskForm({ ...askForm, question: event.target.value })}
                  disabled={!courseDetail?.materials?.length}
                />
                <button disabled={asking || !courseDetail?.materials?.length}>
                  <Send size={18} />
                  {asking ? "Thinking" : "Ask"}
                </button>
              </div>
            </form>
            {answer && (
              <article className="answer-box">
                <small>{answer.material_title} · {answer.mode}</small>
                <p>{answer.answer}</p>
              </article>
            )}
          </div>
        )}

        {activeView === "courses" && (
          <div className="view-stack">
            <form className="glass-form" onSubmit={createCourse}>
              <h2><Plus size={21} /> New Course</h2>
              <input
                placeholder="Anatomy"
                value={courseForm.name}
                onChange={(event) => setCourseForm({ ...courseForm, name: event.target.value })}
              />
              <input
                placeholder="Code, optional"
                value={courseForm.code}
                onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })}
              />
              <button>Create course</button>
            </form>

            <div className="section-line">
              <h2>Courses</h2>
              <span>{courses.length}</span>
            </div>
            <div className="list-stack">
              {courses.map((course) => (
                <button
                  className={`account-row ${course.id === selectedCourseId ? "active" : ""}`}
                  key={course.id}
                  onClick={() => setSelectedCourseId(course.id)}
                  type="button"
                >
                  <span className="course-logo"><GraduationCap size={24} /></span>
                  <span>
                    <strong>{course.name}</strong>
                    <small>{course.material_count} files · {course.task_count} tasks</small>
                  </span>
                  <Plus size={24} />
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <nav className="dock" aria-label="Primary">
        {dockItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activeView === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setActiveView(item.id)}
              type="button"
            >
              <span><Icon size={25} /></span>
              <small>{item.label}</small>
            </button>
          );
        })}
      </nav>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
