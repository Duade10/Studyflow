# StudyFlow

Minimal v2 MVP for a material-driven exam prep planner.

## What works now

- Create courses.
- Upload PDFs, docs, and images into a local material hub.
- Extract text from PDFs, DOCX, TXT/MD files, and images.
- OCR image uploads with Tesseract when it is installed on the machine.
- Use AI to split material into sections, summaries, difficulty levels, and past-question tags when `OPENAI_API_KEY` is set.
- Fall back to local heuristic chunking when AI or OCR is unavailable.
- Manually add extra sections.
- Generate daily tasks from those sections.
- Mark daily dashboard tasks as done.

## Run locally

Backend:

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

For AI processing and material Q&A, copy `backend/.env.example` to `backend/.env`, then put your key there:

```env
OPENAI_API_KEY=sk-your-key-here
STUDYFLOW_AI_MODEL=gpt-4o-mini
```

Restart the backend after changing `.env`.

For OCR image processing, install the Tesseract desktop binary and make sure `tesseract` is available on your system PATH.

Frontend:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Deploy notes

Frontend production config:

```env
VITE_API_BASE_URL=https://api.your-domain.com
```

Backend production config in `backend/.env`:

```env
OPENAI_API_KEY=your-key
STUDYFLOW_AI_MODEL=gpt-4o-mini
STUDYFLOW_CORS_ORIGINS=https://your-domain.com
```

On a VPS, run the backend with something like:

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

Build the frontend with:

```bash
npm install
npm run build
```

Serve `dist/` with Nginx/Caddy and reverse-proxy the backend API. Keep `backend/.env`, `backend/data/`, logs, and uploaded files off GitHub.

## MVP boundaries

Weakness-based rescheduling and full practice analytics are still the next layer. The current product gets raw files into sections, summaries, past-question items, and daily tasks.
