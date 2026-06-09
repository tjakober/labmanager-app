FROM node:20-slim

WORKDIR /app

# Abhängigkeiten installieren (bcrypt hat Prebuilds für node:20-slim)
COPY package*.json ./
RUN npm install --production

# Quellcode + statische Dateien
COPY src/       ./src/
COPY public/    ./public/
COPY locales/   ./locales/
COPY migration/ ./migration/
COPY db/        ./db/

# Verzeichnisse für persistente Daten (werden via Volume gemountet)
RUN mkdir -p /app/certs /app/logs

EXPOSE 3003

CMD ["node", "src/app.js"]
