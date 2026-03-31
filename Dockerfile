# P&G Intelligent Scanner — Cloud Run Dockerfile
# Build: docker build -t pg-scanner-api .
# Run:   docker run -p 8080:8080 -e GEMINI_API_KEY=your_key pg-scanner-api

FROM python:3.12-slim

WORKDIR /app

# Install deps first (layer-cached unless requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy only the server — keep the image lean
COPY server.py .

# Cloud Run injects PORT; default to 8080
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
