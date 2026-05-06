from __future__ import annotations

import os
import shutil
import sqlite3
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Optional
import json
import re

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "studyflow.db"

load_dotenv(BASE_DIR / ".env")
DATA_DIR.mkdir(exist_ok=True)
UPLOAD_DIR.mkdir(exist_ok=True)

app = FastAPI(title="StudyFlow API", version="0.2.0")

cors_origins = [
    origin.strip()
    for origin in os.getenv(
        "STUDYFLOW_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS courses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              code TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS materials (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              course_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              material_type TEXT NOT NULL,
              original_filename TEXT NOT NULL,
              stored_path TEXT NOT NULL,
              extracted_text TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS material_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              material_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              notes TEXT,
              summary TEXT,
              difficulty TEXT NOT NULL DEFAULT 'medium',
              position INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              FOREIGN KEY(material_id) REFERENCES materials(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS past_questions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              course_id INTEGER NOT NULL,
              question TEXT NOT NULL,
              topic TEXT,
              answer TEXT,
              created_at TEXT NOT NULL,
              FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS user_progress (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic TEXT NOT NULL,
              correct_count INTEGER NOT NULL DEFAULT 0,
              wrong_count INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              chunk_id INTEGER,
              course_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              task_type TEXT NOT NULL,
              due_date TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'todo',
              created_at TEXT NOT NULL,
              FOREIGN KEY(chunk_id) REFERENCES material_chunks(id) ON DELETE SET NULL,
              FOREIGN KEY(course_id) REFERENCES courses(id) ON DELETE CASCADE
            );
            """
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(material_chunks)").fetchall()
        }
        if "summary" not in columns:
            connection.execute("ALTER TABLE material_chunks ADD COLUMN summary TEXT")


init_db()


class CourseIn(BaseModel):
    name: str
    code: Optional[str] = None


class ChunkIn(BaseModel):
    title: str
    notes: Optional[str] = None
    difficulty: str = "medium"


class TaskUpdate(BaseModel):
    status: str


class AskIn(BaseModel):
    question: str


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        try:
            import fitz  # type: ignore
        except ImportError:
            return ""

        text_parts: list[str] = []
        page_count = 0
        try:
            with fitz.open(path) as document:
                page_count = len(document)
                for page_number, page in enumerate(document, start=1):
                    text = page.get_text().strip()
                    if text:
                        text_parts.append(f"Page {page_number}\n{text}")
        except Exception:
            return ""
        text = "\n\n".join(text_parts).strip()
        if text:
            return text
        return extract_pdf_ocr_text(path, max_pages=min(page_count or 10, 20))

    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff"}:
        return extract_ocr_text(path)

    if suffix == ".docx":
        try:
            from docx import Document  # type: ignore
        except ImportError:
            return ""

        document = Document(path)
        return "\n".join(paragraph.text for paragraph in document.paragraphs).strip()

    if suffix in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="ignore").strip()

    return ""


def extract_pdf_ocr_text(path: Path, max_pages: int = 20) -> str:
    try:
        import fitz  # type: ignore
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError:
        return ""

    text_parts: list[str] = []
    try:
        with fitz.open(path) as document:
            for page_number, page in enumerate(document, start=1):
                if page_number > max_pages:
                    break
                pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                image = Image.frombytes("RGB", [pixmap.width, pixmap.height], pixmap.samples)
                text = pytesseract.image_to_string(image).strip()
                if text:
                    text_parts.append(f"Page {page_number}\n{text}")
    except Exception:
        return ""
    return "\n\n".join(text_parts).strip()


def extract_ocr_text(path: Path) -> str:
    try:
        import pytesseract  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError:
        return ""

    try:
        return pytesseract.image_to_string(Image.open(path)).strip()
    except Exception:
        return ""


def clipped(text: str, limit: int = 16000) -> str:
    normalized = re.sub(r"\s+", " ", text).strip()
    return normalized[:limit]


def ai_available() -> bool:
    return bool(os.getenv("OPENAI_API_KEY"))


def call_ai_json(system: str, user: str) -> Optional[dict]:
    if not ai_available():
        return None

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        return None

    try:
        client = OpenAI()
        response = client.chat.completions.create(
            model=os.getenv("STUDYFLOW_AI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content)
    except Exception:
        return None


def call_ai_text(system: str, user: str) -> Optional[str]:
    if not ai_available():
        return None

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        return None

    try:
        client = OpenAI()
        response = client.chat.completions.create(
            model=os.getenv("STUDYFLOW_AI_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=0.2,
        )
        return (response.choices[0].message.content or "").strip()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI request failed: {exc}") from exc


def heuristic_chunks(text: str, fallback_title: str) -> list[dict]:
    if not text:
        return [
            {
                "title": fallback_title,
                "summary": "Uploaded material is stored. Add or edit sections manually if text extraction was limited.",
                "difficulty": "medium",
                "notes": "",
            }
        ]

    heading_pattern = re.compile(r"(?m)^(?:page\s+\d+|[A-Z][A-Za-z0-9 ,:/()-]{5,80})$")
    matches = list(heading_pattern.finditer(text))
    chunks: list[dict] = []

    if len(matches) >= 2:
        for index, match in enumerate(matches[:8]):
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            body = text[start:end].strip()
            title = match.group(0).strip().replace("Page ", "Pages around ")
            if body:
                chunks.append(
                    {
                        "title": title[:90],
                        "summary": clipped(body, 260),
                        "difficulty": "hard" if len(body) > 3500 else "medium",
                        "notes": "",
                    }
                )

    if chunks:
        return chunks

    words = text.split()
    chunk_size = 850
    for index in range(0, min(len(words), chunk_size * 8), chunk_size):
        part = " ".join(words[index : index + chunk_size])
        chunks.append(
            {
                "title": f"{fallback_title} (Part {len(chunks) + 1})",
                "summary": clipped(part, 260),
                "difficulty": "hard" if len(part.split()) > 700 else "medium",
                "notes": "",
            }
        )
    return chunks or []


def ai_chunks(text: str, fallback_title: str) -> tuple[list[dict], str]:
    system = (
        "You turn raw study material into concise exam-prep sections. "
        "Return JSON only with key 'chunks'. Each chunk must have title, summary, difficulty, and notes. "
        "Use difficulty values easy, medium, or hard. Keep titles actionable and student-facing."
    )
    result = call_ai_json(
        system,
        f"Material title: {fallback_title}\n\nRaw text:\n{clipped(text)}",
    )
    if result and isinstance(result.get("chunks"), list):
        chunks = []
        for item in result["chunks"][:10]:
            if isinstance(item, dict) and item.get("title"):
                chunks.append(
                    {
                        "title": str(item.get("title", fallback_title))[:120],
                        "summary": str(item.get("summary", ""))[:800],
                        "difficulty": str(item.get("difficulty", "medium")).lower()
                        if str(item.get("difficulty", "medium")).lower() in {"easy", "medium", "hard"}
                        else "medium",
                        "notes": str(item.get("notes", ""))[:800],
                    }
                )
        if chunks:
            return chunks, "ai"
    return heuristic_chunks(text, fallback_title), "heuristic"


def extract_questions(text: str) -> list[dict]:
    system = (
        "Extract exam practice questions from study material. Return JSON only with key 'questions'. "
        "Each item needs question, topic, and answer. Use blank answer if none is present."
    )
    result = call_ai_json(system, f"Raw past question text:\n{clipped(text)}")
    if result and isinstance(result.get("questions"), list):
        questions = []
        for item in result["questions"][:60]:
            if isinstance(item, dict) and item.get("question"):
                questions.append(
                    {
                        "question": str(item.get("question", ""))[:1200],
                        "topic": str(item.get("topic", "General"))[:120],
                        "answer": str(item.get("answer", ""))[:1200],
                    }
                )
        if questions:
            return questions

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    question_lines = [
        line
        for line in lines
        if line.endswith("?") or re.match(r"^\d+[\).]\s+", line) or re.match(r"^[A-D][\).]\s+", line)
    ]
    return [{"question": line, "topic": "General", "answer": ""} for line in question_lines[:40]]


def insert_chunk(connection: sqlite3.Connection, material_id: int, payload: dict, position: int) -> int:
    now = datetime.utcnow().isoformat()
    cursor = connection.execute(
        """
        INSERT INTO material_chunks (material_id, title, notes, summary, difficulty, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            material_id,
            payload.get("title", "Study section"),
            payload.get("notes", ""),
            payload.get("summary", ""),
            payload.get("difficulty", "medium"),
            position,
            now,
        ),
    )
    return int(cursor.lastrowid)


def create_task_for_chunk(connection: sqlite3.Connection, chunk_id: int, course_id: int, title: str, task_type: str) -> int:
    prefix = "Review Practical" if task_type == "practical" else "Study"
    now = datetime.utcnow().isoformat()
    cursor = connection.execute(
        """
        INSERT INTO tasks (chunk_id, course_id, title, task_type, due_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (chunk_id, course_id, f"{prefix}: {title}", task_type, date.today().isoformat(), now),
    )
    return int(cursor.lastrowid)


def material_context(connection: sqlite3.Connection, material_id: int) -> tuple[sqlite3.Row, str]:
    material = connection.execute("SELECT * FROM materials WHERE id = ?", (material_id,)).fetchone()
    if material is None:
        raise HTTPException(status_code=404, detail="Material not found")

    chunks = connection.execute(
        """
        SELECT title, summary, notes, difficulty
        FROM material_chunks
        WHERE material_id = ?
        ORDER BY position ASC, created_at ASC
        """,
        (material_id,),
    ).fetchall()
    chunk_context = "\n\n".join(
        f"Section: {row['title']}\nDifficulty: {row['difficulty']}\nSummary: {row['summary'] or ''}\nNotes: {row['notes'] or ''}"
        for row in chunks
    )
    raw_context = material["extracted_text"] or ""
    context = f"{chunk_context}\n\nRaw extracted text:\n{raw_context}".strip()
    return material, clipped(context, 22000)


def local_answer(question: str, context: str) -> str:
    terms = [term.lower() for term in re.findall(r"[A-Za-z]{4,}", question)]
    paragraphs = [paragraph.strip() for paragraph in re.split(r"\n\s*\n", context) if paragraph.strip()]
    scored: list[tuple[int, str]] = []
    for paragraph in paragraphs:
        lower = paragraph.lower()
        score = sum(1 for term in terms if term in lower)
        if score:
            scored.append((score, paragraph))
    scored.sort(reverse=True, key=lambda item: item[0])
    if not scored:
        return "I could not find enough extracted text from this material to answer that yet. If this is a scanned PDF, install Tesseract so StudyFlow can OCR it."
    snippets = "\n\n".join(paragraph for _, paragraph in scored[:3])
    return f"AI is not configured yet, but these parts of the material look relevant:\n\n{snippets}"


def process_material(connection: sqlite3.Connection, material_id: int) -> dict:
    material = connection.execute("SELECT * FROM materials WHERE id = ?", (material_id,)).fetchone()
    if material is None:
        raise HTTPException(status_code=404, detail="Material not found")

    text = material["extracted_text"] or ""
    created_chunks = 0
    created_questions = 0
    mode = "stored-only"

    if material["material_type"] == "past_questions":
        questions = extract_questions(text)
        for item in questions:
            connection.execute(
                """
                INSERT INTO past_questions (course_id, question, topic, answer, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    material["course_id"],
                    item["question"],
                    item.get("topic", "General"),
                    item.get("answer", ""),
                    datetime.utcnow().isoformat(),
                ),
            )
            created_questions += 1
        if created_questions:
            connection.execute(
                """
                INSERT INTO tasks (course_id, title, task_type, due_date, created_at)
                VALUES (?, ?, 'practice', ?, ?)
                """,
                (
                    material["course_id"],
                    f"Practice: {min(created_questions, 10)} Questions ({material['title']})",
                    date.today().isoformat(),
                    datetime.utcnow().isoformat(),
                ),
            )
        return {"mode": "ai" if ai_available() else "heuristic", "chunks": 0, "questions": created_questions}

    chunks, mode = ai_chunks(text, material["title"])
    task_type = "practical" if material["material_type"] == "practical" else "study"
    for index, chunk in enumerate(chunks):
        chunk_id = insert_chunk(connection, material_id, chunk, index)
        create_task_for_chunk(connection, chunk_id, material["course_id"], chunk["title"], task_type)
        created_chunks += 1

    return {"mode": mode, "chunks": created_chunks, "questions": created_questions}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "studyflow-api"}


@app.get("/courses")
def list_courses() -> list[dict]:
    with db() as connection:
        rows = connection.execute(
            """
            SELECT c.*,
              COUNT(DISTINCT m.id) AS material_count,
              COUNT(DISTINCT t.id) AS task_count
            FROM courses c
            LEFT JOIN materials m ON m.course_id = c.id
            LEFT JOIN tasks t ON t.course_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
            """
        ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.post("/courses")
def create_course(payload: CourseIn) -> dict:
    now = datetime.utcnow().isoformat()
    try:
        with db() as connection:
            cursor = connection.execute(
                "INSERT INTO courses (name, code, created_at) VALUES (?, ?, ?)",
                (payload.name.strip(), payload.code, now),
            )
            course_id = cursor.lastrowid
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Course already exists") from exc

    return {"id": course_id, "name": payload.name, "code": payload.code, "created_at": now}


@app.get("/courses/{course_id}")
def get_course(course_id: int) -> dict:
    with db() as connection:
        course = connection.execute("SELECT * FROM courses WHERE id = ?", (course_id,)).fetchone()
        if course is None:
            raise HTTPException(status_code=404, detail="Course not found")

        materials = connection.execute(
            "SELECT * FROM materials WHERE course_id = ? ORDER BY created_at DESC",
            (course_id,),
        ).fetchall()
        chunks = connection.execute(
            """
            SELECT mc.*, m.title AS material_title
            FROM material_chunks mc
            JOIN materials m ON m.id = mc.material_id
            WHERE m.course_id = ?
            ORDER BY mc.position ASC, mc.created_at ASC
            """,
            (course_id,),
        ).fetchall()
        questions = connection.execute(
            "SELECT * FROM past_questions WHERE course_id = ? ORDER BY created_at DESC",
            (course_id,),
        ).fetchall()

    return {
        **row_to_dict(course),
        "materials": [row_to_dict(row) for row in materials],
        "chunks": [row_to_dict(row) for row in chunks],
        "past_questions": [row_to_dict(row) for row in questions],
    }


@app.post("/materials")
def upload_material(
    course_id: int = Form(...),
    title: str = Form(...),
    material_type: str = Form("slides"),
    file: UploadFile = File(...),
) -> dict:
    with db() as connection:
        course = connection.execute("SELECT id FROM courses WHERE id = ?", (course_id,)).fetchone()
        if course is None:
            raise HTTPException(status_code=404, detail="Course not found")

    extension = Path(file.filename or "").suffix
    stored_name = f"{uuid.uuid4().hex}{extension}"
    stored_path = UPLOAD_DIR / stored_name

    with stored_path.open("wb") as target:
        shutil.copyfileobj(file.file, target)

    extracted_text = extract_text(stored_path)
    now = datetime.utcnow().isoformat()
    with db() as connection:
        cursor = connection.execute(
            """
            INSERT INTO materials
              (course_id, title, material_type, original_filename, stored_path, extracted_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (course_id, title.strip(), material_type, file.filename, str(stored_path), extracted_text, now),
        )
        material_id = cursor.lastrowid
        processing = process_material(connection, int(material_id))

    return {
        "id": material_id,
        "course_id": course_id,
        "title": title,
        "material_type": material_type,
        "original_filename": file.filename,
        "has_extracted_text": bool(extracted_text),
        "processing": processing,
        "created_at": now,
    }


@app.post("/materials/bulk")
def upload_materials_bulk(
    course_id: int = Form(...),
    title: Optional[str] = Form(None),
    material_type: str = Form("slides"),
    files: list[UploadFile] = File(...),
) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail="Choose at least one file")

    with db() as connection:
        course = connection.execute("SELECT id FROM courses WHERE id = ?", (course_id,)).fetchone()
        if course is None:
            raise HTTPException(status_code=404, detail="Course not found")

    uploaded: list[dict] = []
    for file in files:
        extension = Path(file.filename or "").suffix
        stored_name = f"{uuid.uuid4().hex}{extension}"
        stored_path = UPLOAD_DIR / stored_name

        with stored_path.open("wb") as target:
            shutil.copyfileobj(file.file, target)

        file_title = title.strip() if title and len(files) == 1 else Path(file.filename or "Material").stem
        extracted_text = extract_text(stored_path)
        now = datetime.utcnow().isoformat()
        with db() as connection:
            cursor = connection.execute(
                """
                INSERT INTO materials
                  (course_id, title, material_type, original_filename, stored_path, extracted_text, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (course_id, file_title, material_type, file.filename, str(stored_path), extracted_text, now),
            )
            material_id = int(cursor.lastrowid)
            processing = process_material(connection, material_id)

        uploaded.append(
            {
                "id": material_id,
                "course_id": course_id,
                "title": file_title,
                "material_type": material_type,
                "original_filename": file.filename,
                "has_extracted_text": bool(extracted_text),
                "processing": processing,
                "created_at": now,
            }
        )

    return {
        "uploaded": uploaded,
        "total_files": len(uploaded),
        "total_generated": sum(
            item["processing"].get("chunks", 0) + item["processing"].get("questions", 0)
            for item in uploaded
        ),
    }


@app.post("/materials/{material_id}/chunks")
def create_chunk(material_id: int, payload: ChunkIn) -> dict:
    with db() as connection:
        material = connection.execute(
            "SELECT id, course_id FROM materials WHERE id = ?", (material_id,)
        ).fetchone()
        if material is None:
            raise HTTPException(status_code=404, detail="Material not found")

        position = connection.execute(
            "SELECT COUNT(*) AS count FROM material_chunks WHERE material_id = ?",
            (material_id,),
        ).fetchone()["count"]

        now = datetime.utcnow().isoformat()
        cursor = connection.execute(
            """
            INSERT INTO material_chunks (material_id, title, notes, difficulty, position, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (material_id, payload.title.strip(), payload.notes, payload.difficulty, position, now),
        )
        chunk_id = cursor.lastrowid

    return {
        "id": chunk_id,
        "material_id": material_id,
        "title": payload.title,
        "notes": payload.notes,
        "difficulty": payload.difficulty,
        "position": position,
        "created_at": now,
    }


@app.post("/materials/{material_id}/process")
def process_existing_material(material_id: int) -> dict:
    with db() as connection:
        existing = connection.execute(
            "SELECT COUNT(*) AS count FROM material_chunks WHERE material_id = ?",
            (material_id,),
        ).fetchone()["count"]
        if existing:
            raise HTTPException(status_code=409, detail="Material already has generated sections")
        return process_material(connection, material_id)


@app.post("/materials/{material_id}/ask")
def ask_material(material_id: int, payload: AskIn) -> dict:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Ask a question first")

    with db() as connection:
        material, context = material_context(connection, material_id)

    if not context:
        return {
            "answer": "I do not have readable text for this material yet. If it is a scanned PDF or image, install Tesseract OCR and re-upload it.",
            "mode": "no-context",
            "material_title": material["title"],
        }

    system = (
        "You are StudyFlow's exam-prep tutor. Answer only from the provided study material. "
        "Be clear, concise, and helpful. If the answer is not in the material, say so and suggest what to review. "
        "When useful, end with a tiny revision prompt or practice question."
    )
    answer = call_ai_text(
        system,
        f"Material title: {material['title']}\n\nStudy material context:\n{context}\n\nStudent question: {question}",
    )
    if answer:
        return {"answer": answer, "mode": "ai", "material_title": material["title"]}

    return {
        "answer": local_answer(question, context),
        "mode": "local",
        "material_title": material["title"],
    }


@app.post("/chunks/{chunk_id}/generate-task")
def generate_task(chunk_id: int, due_date: Optional[str] = None) -> dict:
    task_date = due_date or date.today().isoformat()
    with db() as connection:
        chunk = connection.execute(
            """
            SELECT mc.*, m.course_id, m.material_type
            FROM material_chunks mc
            JOIN materials m ON m.id = mc.material_id
            WHERE mc.id = ?
            """,
            (chunk_id,),
        ).fetchone()
        if chunk is None:
            raise HTTPException(status_code=404, detail="Chunk not found")

        task_type = "practical" if chunk["material_type"] == "practical" else "study"
        title = f"{'Review Practical' if task_type == 'practical' else 'Study'}: {chunk['title']}"
        now = datetime.utcnow().isoformat()
        cursor = connection.execute(
            """
            INSERT INTO tasks (chunk_id, course_id, title, task_type, due_date, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (chunk_id, chunk["course_id"], title, task_type, task_date, now),
        )
        task_id = cursor.lastrowid

    return {
        "id": task_id,
        "chunk_id": chunk_id,
        "course_id": chunk["course_id"],
        "title": title,
        "task_type": task_type,
        "due_date": task_date,
        "status": "todo",
        "created_at": now,
    }


@app.get("/tasks")
def list_tasks(due_date: Optional[str] = None) -> list[dict]:
    task_date = due_date or date.today().isoformat()
    with db() as connection:
        rows = connection.execute(
            """
            SELECT t.*, c.name AS course_name
            FROM tasks t
            JOIN courses c ON c.id = t.course_id
            WHERE t.due_date = ?
            ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'done' THEN 1 ELSE 2 END, t.created_at ASC
            """,
            (task_date,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


@app.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskUpdate) -> dict:
    if payload.status not in {"todo", "done"}:
        raise HTTPException(status_code=400, detail="Status must be todo or done")

    with db() as connection:
        connection.execute("UPDATE tasks SET status = ? WHERE id = ?", (payload.status, task_id))
        task = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
    return row_to_dict(task)
