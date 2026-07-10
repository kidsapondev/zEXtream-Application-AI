# zEXtream-Application-AI

zEXtream-Application-AI เป็นเว็บแอปสำหรับสนทนากับโมเดล AI แบบ streaming พร้อมพื้นที่แก้ไขโค้ดในหน้าเดียวกัน เมื่อโมเดลตอบกลับด้วย fenced code block ระบบจะแยกโค้ดออกจากข้อความ บันทึกเป็นไฟล์แบบมี revision และเปิดไฟล์นั้นใน Monaco Editor โดยอัตโนมัติ

โปรเจกต์นี้เป็น TypeScript monorepo ประกอบด้วย Angular frontend, NestJS backend, PostgreSQL, Prisma ORM, Socket.IO และ Ollama

> สถานะปัจจุบัน: เหมาะสำหรับการพัฒนาและทดลองใช้งานภายใน ระบบรองรับ Ollama จริงเพียง provider เดียว แม้ type และ schema จะเตรียมค่า `claude` และ `openai` ไว้แล้ว ดูข้อจำกัดเพิ่มเติมในหัวข้อ [ข้อจำกัดที่ทราบ](#ข้อจำกัดที่ทราบ)

## ความสามารถหลัก

- สมัครสมาชิกและเข้าสู่ระบบด้วยอีเมล/รหัสผ่าน
- JWT access token อายุสั้น เก็บใน memory ของ browser
- Refresh token แบบ httpOnly cookie พร้อม token rotation และ reuse detection
- สร้าง เปลี่ยนชื่อ archive และลบ chat session
- รับคำตอบจาก Ollama แบบ token streaming ผ่าน WebSocket
- หยุดการ generate ระหว่างทางได้
- แยก fenced code block เป็น code artifact แบบ realtime
- เปิดและแก้ไข artifact ด้วย Monaco Editor
- เก็บ revision history ของแต่ละ filename
- แยกข้อมูล session และ artifact ตามเจ้าของบัญชี
- Docker Compose สำหรับ development และ production-like deployment

## Technology stack

| ส่วน           | เทคโนโลยี                                                        |
| -------------- | ---------------------------------------------------------------- |
| Frontend       | Angular 22, Signals, RxJS, Socket.IO Client, Monaco Editor, SCSS |
| Backend        | NestJS 11, Passport, JWT, Socket.IO, Zod, class-validator        |
| AI             | Ollama HTTP streaming API                                        |
| Database       | PostgreSQL 18, Prisma 7, Prisma PostgreSQL adapter               |
| Authentication | Argon2id, JWT access/refresh tokens, httpOnly cookie             |
| Tooling        | TypeScript, pnpm workspace, Jest, Vitest, ESLint, Prettier       |
| Runtime        | Node.js 24+, Docker Compose, Nginx                               |

## โครงสร้างโปรเจกต์

```text
zEXtream-Application-AI/
├── backend/
│   ├── prisma/
│   │   ├── migrations/          # SQL migrations
│   │   └── schema.prisma        # Database schema
│   ├── src/
│   │   ├── ai/                  # Provider abstraction, Ollama และ artifact parser
│   │   ├── artifacts/           # Artifact queries และ revision creation
│   │   ├── auth/                # Login, JWT strategies และ refresh rotation
│   │   ├── chat/                # Session และ message services/controllers
│   │   ├── config/              # Environment validation
│   │   ├── prisma/              # Prisma lifecycle service
│   │   ├── realtime/            # Socket.IO gateway และ active stream registry
│   │   ├── users/               # User queries และ /users/me
│   │   ├── app.module.ts
│   │   └── main.ts
│   ├── test/
│   └── Dockerfile
├── frontend/
│   ├── public/
│   ├── src/app/
│   │   ├── core/                # Auth store/interceptor/guard และ socket service
│   │   ├── design-system/       # Shared UI components
│   │   └── features/
│   │       ├── auth/            # Login และ register pages
│   │       ├── chat/            # Session list, chat store และ chat thread
│   │       └── code-editor/     # Artifact store และ Monaco components
│   ├── nginx.conf
│   ├── proxy.conf.json
│   └── Dockerfile
├── packages/shared-types/       # DTO และ WebSocket contracts ที่ใช้ร่วมกัน
├── docker-compose.yml           # Base services
├── docker-compose.override.yml  # Development overrides
├── docker-compose.prod.yml      # Production overrides
├── pnpm-workspace.yaml
└── package.json
```

## ภาพรวมสถาปัตยกรรม

```text
Browser
  ├── HTTP /api/* ───────────────> NestJS REST controllers
  │                                  ├── Auth / Users
  │                                  ├── Chat sessions / messages
  │                                  └── Artifacts
  │
  └── Socket.IO /ws/socket.io ───> ChatGateway
                                      ├── ตรวจ JWT ตอนเชื่อมต่อ
                                      ├── ตรวจ ownership ของ session
                                      ├── ส่ง history ไปยัง AI provider
                                      ├── stream จาก Ollama
                                      ├── แยก prose และ code artifacts
                                      └── broadcast event กลับเข้า session room

NestJS ── Prisma ──> PostgreSQL
NestJS ── HTTP ────> Ollama
```

Nginx ใน production ทำหน้าที่เสิร์ฟ Angular static files และ proxy `/api/` กับ `/ws/` ไปยัง backend ภายใน Docker network

## ลำดับการทำงานหลัก

### Authentication

1. ผู้ใช้สมัครหรือ login ผ่าน REST API
2. Backend ตรวจรหัสผ่านด้วย Argon2id
3. Backend ตอบ access token ใน JSON และตั้ง refresh token เป็น httpOnly cookie
4. Frontend เก็บ access token ใน signal ซึ่งอยู่ใน memory เท่านั้น
5. HTTP interceptor แนบ `Authorization: Bearer <token>` ให้ request ปกติ
6. เมื่อ REST API ตอบ `401` frontend จะเรียก `/api/auth/refresh` แล้ว retry request เดิมหนึ่งครั้ง
7. เมื่อ hard reload ตัว app initializer จะลอง refresh token เพื่อสร้าง access token ใหม่
8. Logout จะ revoke refresh-token row และล้าง cookie

Refresh cookie ใช้ `SameSite=Strict`, path `/api/auth` และเปิด `Secure` เมื่อ `NODE_ENV=production`

### Chat streaming

1. Frontend โหลด session และ emit `session:join`
2. Gateway ตรวจว่า session เป็นของ user ที่เชื่อมต่ออยู่ แล้วนำ socket เข้า room `session:<sessionId>`
3. Frontend emit `chat:send`
4. Backend บันทึก user message และ assistant message สถานะ `streaming`
5. Backend รวม system prompt กับ message history แล้วเรียก Ollama `/api/chat`
6. Token ที่เป็นข้อความปกติจะถูก broadcast ด้วย `chat:token`
7. Token ที่อยู่ใน fenced code block จะถูกส่งเป็น artifact stream
8. เมื่อ stream จบ backend บันทึกข้อความเป็น `complete`, `stopped` หรือ `error`
9. หาก server restart ระหว่าง generate ข้อความที่ยังเป็น `streaming` จะถูกปรับเป็น `error` เมื่อเปิด session นั้นอีกครั้ง

### Code artifact

ระบบคาดหวัง code fence ในรูปแบบต่อไปนี้:

````markdown
```typescript:src/example.ts
export const answer = 42;
```
````

- ส่วนก่อน `:` คือภาษา
- ส่วนหลัง `:` คือ relative filename
- หากไม่มี filename ระบบสร้างชื่อ `snippet-<n>.<ext>` ให้
- ระหว่าง stream frontend จะแสดงไฟล์ชั่วคราวด้วย `tempId`
- เมื่อ fence จบ backend จะบันทึก `CodeArtifact` แล้วส่ง database ID กลับมา
- การแก้ไขใน editor จะสร้าง artifact revision ใหม่ โดยเชื่อม `parentArtifactId` ไปยัง revision ก่อนหน้า

## ข้อกำหนดระบบ

### วิธีที่แนะนำ: Docker

- Docker Engine หรือ Docker Desktop
- Docker Compose v2
- Ollama ที่เข้าถึงได้จาก container
- โมเดล Ollama ที่ต้องการใช้งาน เช่น `qwen2.5-coder:14b`

### รันบนเครื่องโดยตรง

- Node.js 24 หรือใหม่กว่า
- pnpm 11
- PostgreSQL 18
- Ollama

โปรเจกต์ใช้ `uuidv7()` เป็น database default จึงควรใช้ PostgreSQL รุ่นที่รองรับฟังก์ชันนี้ตาม migration ปัจจุบัน

## เริ่มต้นใช้งานด้วย Docker

### 1. เตรียม Ollama

ติดตั้งและเปิด Ollama บน host จากนั้นดาวน์โหลดโมเดลเริ่มต้นที่ frontend ใช้:

```bash
ollama pull qwen2.5-coder:14b
```

ตรวจว่า Ollama ทำงาน:

```bash
ollama list
```

ค่าเริ่มต้นใน `.env.example` ให้ container ติดต่อ Ollama ผ่าน `host.docker.internal:11434`

### 2. สร้าง environment file

PowerShell:

```powershell
Copy-Item .env.example .env
```

Bash:

```bash
cp .env.example .env
```

เปลี่ยน password และ secrets ใน `.env` ก่อนใช้งาน โดยเฉพาะ production

ตัวอย่างสร้าง random secret ด้วย Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3. เปิด development stack

```bash
docker compose up --build
```

หรือใช้ root script:

```bash
pnpm dev:build
```

Docker Compose จะทำงานตามลำดับดังนี้:

1. เปิด PostgreSQL และรอ health check
2. Build backend image
3. รัน `prisma migrate deploy`
4. เปิด NestJS backend แบบ watch mode
5. เปิด Angular dev server แบบ polling

บริการใน development:

| บริการ       | URL/Port                                            |
| ------------ | --------------------------------------------------- |
| Frontend     | http://localhost:4200                               |
| Backend      | http://localhost:3000                               |
| Health check | http://localhost:3000/api/health                    |
| PostgreSQL   | localhost:5432                                      |
| Socket.IO    | ws://localhost:4200/ws/socket.io ผ่าน Angular proxy |

### 4. หยุดบริการ

```bash
docker compose down
```

ข้อมูล PostgreSQL ยังอยู่ใน named volume `pgdata` หากต้องการลบข้อมูลทั้งหมดด้วย ให้ใช้คำสั่งนี้ด้วยความระมัดระวัง:

```bash
docker compose down --volumes
```

## Environment variables

| ตัวแปร                   | จำเป็น            | ตัวอย่าง                                 | รายละเอียด                                                                   |
| ------------------------ | ----------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `POSTGRES_USER`          | ใช่สำหรับ Compose | `chatapp`                                | PostgreSQL username                                                          |
| `POSTGRES_PASSWORD`      | ใช่สำหรับ Compose | ค่า secret                               | PostgreSQL password                                                          |
| `POSTGRES_DB`            | ใช่สำหรับ Compose | `chatapp`                                | Database name                                                                |
| `DATABASE_URL`           | ใช่               | `postgresql://...@postgres:5432/chatapp` | Prisma connection string; ใช้ hostname `postgres` ภายใน Compose              |
| `JWT_ACCESS_SECRET`      | ใช่               | random string                            | Secret สำหรับ access JWT; ขั้นต่ำ 16 ตัวอักษร                                |
| `JWT_REFRESH_SECRET`     | ใช่               | random string คนละค่ากัน                 | Secret สำหรับ refresh JWT; ขั้นต่ำ 16 ตัวอักษร                               |
| `JWT_ACCESS_EXPIRES_IN`  | ไม่               | `15m`                                    | รองรับหน่วย `s`, `m`, `h`, `d`                                               |
| `JWT_REFRESH_EXPIRES_IN` | ไม่               | `7d`                                     | อายุ refresh token และ cookie                                                |
| `API_KEY_ENCRYPTION_KEY` | ใช่ตาม validation | base64 key                               | เตรียมไว้สำหรับ encrypt provider API keys แต่ยังไม่ถูกใช้งานใน flow ปัจจุบัน |
| `OLLAMA_BASE_URL`        | ใช่               | `http://host.docker.internal:11434`      | Ollama base URL                                                              |
| `CORS_ORIGIN`            | ไม่               | `http://localhost:4200`                  | Allowed browser origin ใน development                                        |
| `NODE_ENV`               | ไม่               | `development`                            | `development`, `production` หรือ `test`                                      |
| `PORT`                   | ไม่               | `3000`                                   | Backend port                                                                 |

Backend validate environment ตอน startup ด้วย Zod และจะหยุดทันทีหากค่าที่จำเป็นหายหรือรูปแบบไม่ถูกต้อง

## รันโดยไม่ใช้ Docker

ติดตั้ง dependencies จาก root:

```bash
corepack enable
pnpm install
```

แก้ `DATABASE_URL` ให้ชี้ PostgreSQL ที่เข้าถึงได้จาก host เช่น `localhost` แทน service name `postgres` จากนั้น generate Prisma Client และ migrate:

```bash
pnpm --filter backend exec prisma generate
pnpm --filter backend exec prisma migrate deploy
```

เปิด backend:

```bash
pnpm --filter backend start:dev
```

เปิด frontend ในอีก terminal:

```bash
pnpm --filter frontend start
```

เมื่อรัน Angular บน host ต้องปรับ `frontend/proxy.conf.json` หาก backend ไม่ได้ resolve ด้วย hostname `backend` ค่าแบบ local ทั่วไปคือ `http://localhost:3000`

## Production build ด้วย Docker Compose

ตรวจ `.env` ให้ใช้ secrets จริง, `NODE_ENV=production`, database URL ที่ถูกต้อง และ Ollama URL ที่ backend เข้าถึงได้ แล้วรัน:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

Frontend จะเปิดที่ port 80 ผ่าน Nginx:

```text
http://localhost/
```

ดูสถานะและ log:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f backend
```

ข้อควรพิจารณาก่อน deploy จริง:

- ใช้ TLS/HTTPS เพื่อให้ refresh cookie แบบ `Secure` ทำงาน
- จำกัดการเข้าถึง PostgreSQL และ Ollama จาก public network
- ใช้ secret manager แทนการเก็บ production secrets ในไฟล์
- ตั้ง reverse-proxy timeout ให้ยาวพอสำหรับ AI streaming
- เพิ่ม rate limit สำหรับ login, register และ chat events
- เพิ่ม monitoring, structured logging และ error reporting

## REST API

ทุก endpoint มี prefix `/api` ส่วน endpoint ที่ไม่ได้ระบุว่า public ต้องส่ง header:

```http
Authorization: Bearer <access-token>
```

### Health

#### `GET /api/health`

Public endpoint สำหรับตรวจ backend และ database connection

```json
{
  "status": "ok",
  "database": "connected"
}
```

### Authentication

#### `POST /api/auth/register`

```json
{
  "email": "user@example.com",
  "password": "a-strong-password",
  "displayName": "Example User"
}
```

ข้อกำหนด:

- email ต้องถูกต้องและยาวไม่เกิน 255 ตัวอักษร
- password ยาว 8-128 ตัวอักษร
- display name ยาว 1-100 ตัวอักษร

Response มีข้อมูล user และ access token พร้อมตั้ง refresh cookie

#### `POST /api/auth/login`

```json
{
  "email": "user@example.com",
  "password": "a-strong-password"
}
```

#### `POST /api/auth/refresh`

ใช้ refresh cookie ไม่ต้องส่ง token ใน request body และตอบ access token ใหม่

```json
{
  "accessToken": "..."
}
```

#### `POST /api/auth/logout`

Revoke refresh token ปัจจุบันและล้าง cookie

```json
{
  "success": true
}
```

### User

#### `GET /api/users/me`

คืนข้อมูล user ปัจจุบัน โดยไม่คืน password hash

### Chat sessions

#### `GET /api/chat/sessions`

คืน session ที่ยังไม่ archive ของ user ปัจจุบัน เรียงตาม `updatedAt` ล่าสุด

#### `POST /api/chat/sessions`

```json
{
  "title": "Optional title",
  "defaultProvider": "ollama",
  "defaultModel": "qwen2.5-coder:14b"
}
```

`title` ไม่จำเป็น ส่วน `defaultProvider` และ `defaultModel` จำเป็น

#### `PATCH /api/chat/sessions/:id`

```json
{
  "title": "Renamed chat",
  "isArchived": false
}
```

ส่งเฉพาะ field ที่ต้องการเปลี่ยนได้

#### `DELETE /api/chat/sessions/:id`

ลบ session พร้อม messages และ artifacts ผ่าน cascade relations

#### `GET /api/chat/sessions/:id/messages`

คืน message history เรียงจากเก่าไปใหม่ ก่อนคืนข้อมูลระบบจะเปลี่ยนข้อความที่ค้าง `streaming` ให้เป็น `error`

### Artifacts

#### `GET /api/chat/sessions/:sessionId/artifacts`

คืน revision ล่าสุดของทุก filename ใน session

#### `GET /api/chat/sessions/:sessionId/artifacts/revisions?filename=src/example.ts`

คืน revision ทั้งหมดของ filename ที่กำหนด เรียงจากเก่าไปใหม่

## WebSocket API

Socket.IO endpoint:

```text
/ws/socket.io
```

Client ต้องส่ง access token ตอน handshake:

```ts
const socket = io("/", {
  path: "/ws/socket.io",
  auth: { token: accessToken },
});
```

Type contracts กลางอยู่ใน `packages/shared-types/src/index.ts`

### Client → Server

| Event           | Payload                                     | หน้าที่                                 |
| --------------- | ------------------------------------------- | --------------------------------------- |
| `session:join`  | `{ sessionId }`                             | ตรวจ ownership และเข้าร่วม session room |
| `session:leave` | `{ sessionId }`                             | ออกจาก session room                     |
| `chat:send`     | `{ sessionId, content, provider?, model? }` | บันทึกข้อความและเริ่ม AI stream         |
| `chat:stop`     | `{ messageId }`                             | abort active stream                     |
| `artifact:edit` | `{ artifactId, content }`                   | สร้าง user revision ใหม่                |

### Server → Client

| Event                   | Payload                                                | หน้าที่                               |
| ----------------------- | ------------------------------------------------------ | ------------------------------------- |
| `chat:message:created`  | `{ message }`                                          | แจ้ง user/assistant message ใหม่      |
| `chat:token`            | `{ messageId, delta }`                                 | ต่อข้อความปกติระหว่าง stream          |
| `chat:message:updated`  | `{ message }`                                          | แจ้งสถานะและ content สุดท้าย          |
| `artifact:stream:start` | `{ tempId, sessionId, messageId, filename, language }` | เริ่ม artifact ชั่วคราว               |
| `artifact:stream:chunk` | `{ tempId, delta }`                                    | ต่อเนื้อหา artifact                   |
| `artifact:stream:end`   | `{ tempId, realArtifactId }`                           | เปลี่ยน temporary ID เป็น database ID |
| `artifact:created`      | `{ artifact }`                                         | แจ้ง revision ที่ผู้ใช้สร้าง          |
| `error`                 | `{ code, message }`                                    | แจ้ง application-level error          |

## Database model

### `User`

เก็บ email, Argon2 password hash, display name, role และสถานะ active มีความสัมพันธ์กับ refresh tokens และ chat sessions

### `RefreshToken`

เก็บ refresh-token metadata, SHA-256 token hash, token family, expiry, revocation, replacement chain, user agent และ IP address

### `ChatSession`

เป็นเจ้าของ message และ artifact มี default provider/model และสถานะ archive

### `Message`

รองรับ role `user`, `assistant`, `system` และสถานะ `pending`, `streaming`, `complete`, `error`, `stopped`

### `CodeArtifact`

เก็บ filename, language, content, revision, origin และ parent revision โดยมี unique constraint ที่ `(sessionId, filename, revision)`

ความสัมพันธ์หลัก:

```text
User
├── RefreshToken[]
└── ChatSession[]
    ├── Message[]
    │   └── CodeArtifact[]
    └── CodeArtifact[]
        └── child revisions[]
```

## คำสั่งสำหรับนักพัฒนา

### Build

```bash
pnpm --filter backend build
pnpm --filter frontend build
```

### Unit tests

```bash
pnpm --filter backend test --runInBand
pnpm --filter frontend exec ng test --watch=false
```

### Backend end-to-end tests

```bash
pnpm --filter backend test:e2e
```

E2E tests ต้องมี environment และ PostgreSQL ที่พร้อมใช้งาน

### Lint

Script `backend` ปัจจุบันเปิด `--fix` โดยอัตโนมัติ:

```bash
pnpm --filter backend lint
```

หากต้องการตรวจโดยไม่แก้ไฟล์:

```bash
pnpm --filter backend exec eslint "{src,apps,libs,test}/**/*.ts"
```

### Format

```bash
pnpm --filter backend format
```

### Prisma

```bash
# Generate client
pnpm --filter backend exec prisma generate

# สร้าง migration ระหว่าง development
pnpm --filter backend exec prisma migrate dev --name <migration-name>

# Apply migrations ใน deployment
pnpm --filter backend exec prisma migrate deploy

# เปิด Prisma Studio
pnpm --filter backend exec prisma studio
```

## การเพิ่ม AI provider

Type และ database enum เตรียม `claude` และ `openai` ไว้แล้ว แต่ยังต้อง implement runtime provider ก่อนใช้งานจริง:

1. สร้าง class ที่ implement `AiProvider` ใน `backend/src/ai/providers/`
2. กำหนด `key` ให้ตรงกับ `AiProviderKey`
3. Implement `streamChat()` ให้ yield `token`, `done` และ `error`
4. Register provider ใน `AiModule`
5. เพิ่ม provider เข้า `AiProviderFactory`
6. เพิ่มการจัดเก็บและ decrypt API key อย่างปลอดภัย
7. เพิ่ม provider settings UI และ route
8. เพิ่ม unit/integration tests สำหรับ abort, upstream errors และ malformed stream

## ข้อจำกัดที่ทราบ

รายการต่อไปนี้เป็นข้อจำกัดของ implementation ปัจจุบัน:

- Runtime รองรับเพียง Ollama แต่ DTO และ database ยอมรับ Claude/OpenAI
- Artifact content ไม่ถูกนำกลับเข้า AI history ทำให้ follow-up ที่อ้างถึงไฟล์เดิมไม่มี source code ล่าสุดใน context
- Socket ถูก cache ไว้และยังไม่มี lifecycle สำหรับ disconnect/re-authenticate ตอน logout หรือเปลี่ยน user
- `chat:stop` ยังไม่ตรวจว่า message เป็นของ user ที่ส่งคำสั่งหยุด
- Exception บางชนิดใน streaming path อาจทำให้ assistant message ค้างสถานะ `streaming` จนกว่าจะ reload session
- Monaco ส่ง `artifact:edit` ทุกการพิมพ์ ยังไม่มี debounce, explicit save หรือ optimistic concurrency control
- การสร้าง revision พร้อมกันอาจชน unique constraint ของ revision number
- Artifact parser ต้องการ newline หลัง closing fence; fence ที่จบตรง EOF อาจถูกรวมเข้า content
- การเปลี่ยน session อย่างรวดเร็วอาจเกิด stale HTTP response เขียนทับ state ของ session ใหม่
- Artifact socket handlers ยังไม่กรอง event ด้วย current session ID
- ปุ่ม provider settings ชี้ไป route ที่ยังไม่มี implementation
- Test suite ปัจจุบันเป็น smoke test และยังไม่ครอบคลุม auth rotation, WebSocket authorization, streaming และ artifact parser
- ยังไม่มี rate limiting, audit logging, observability หรือ API documentation generator เช่น OpenAPI

## แนวทางปรับปรุงที่แนะนำ

ลำดับงานที่แนะนำก่อนเปิดใช้จริง:

1. จัดการ socket lifecycle ให้ disconnect ตอน logout และ reconnect ด้วย access token ใหม่
2. ตรวจ ownership ของทุก WebSocket mutation รวมถึง `chat:stop`
3. รวม artifact revision ล่าสุดเข้า context ที่ส่งให้ AI
4. ครอบ streaming pipeline ด้วย error handling ที่ finalize message ได้ทุกเส้นทาง
5. จำกัดให้เลือกเฉพาะ provider ที่ลงทะเบียนจริง หรือ implement provider ที่เหลือ
6. Debounce editor save และ serialize/lock artifact revision creation
7. ป้องกัน stale HTTP responses และกรอง socket events ตาม session
8. ทำ refresh-token rotation เป็น atomic transaction ที่รองรับ concurrent requests
9. เพิ่ม test สำหรับ parser boundaries, stream abort, reconnect, multi-tab refresh และ cross-user access
10. เพิ่ม rate limiting, logs, metrics และ production secret management

## Troubleshooting

### Backend ติดต่อ Ollama ไม่ได้

ตรวจว่า Ollama เปิดอยู่และ URL ใน `OLLAMA_BASE_URL` เข้าถึงได้จาก backend container:

```bash
docker compose logs -f backend
```

บน Linux อาจต้องตรวจการรองรับ `host.docker.internal` และ Docker host-gateway configuration

### ไม่พบโมเดล

ดาวน์โหลดชื่อโมเดลให้ตรงกับ `defaultModel`:

```bash
ollama pull qwen2.5-coder:14b
```

### Migration ล้มเหลว

ตรวจ PostgreSQL health และ migration logs:

```bash
docker compose ps
docker compose logs postgres
docker compose logs migrate
```

### Frontend เรียก backend ไม่ได้เมื่อรันนอก Docker

แก้ target ใน `frontend/proxy.conf.json` จาก `http://backend:3000` เป็น `http://localhost:3000` หรือ hostname ที่เข้าถึง backend ได้จริง

### Access token หมดอายุแล้ว request ล้มเหลว

ตรวจว่า browser ส่ง refresh cookie ไป `/api/auth/refresh`, origin ตรงกับ CORS config และ production ใช้ HTTPS สำหรับ cookie แบบ `Secure`

### ข้อความค้าง `streaming`

เปิด session ใหม่หรือ reload session เพื่อให้ backend reconcile ข้อความค้างเป็น `error` จากนั้นตรวจ backend/Ollama logs เพื่อหาสาเหตุของ stream interruption

## Security notes

- ห้าม commit `.env`, token, API key หรือข้อมูล login จริง
- ใช้ secret คนละค่าสำหรับ access และ refresh JWT
- เปลี่ยน default database password ก่อนนำไปใช้นอกเครื่องพัฒนา
- เปิด HTTPS ใน production
- อย่า expose PostgreSQL หรือ Ollama ต่อ Internet โดยตรง
- ตรวจและจำกัด filename จาก AI ก่อนนำ artifact ไปเขียนลง filesystem ในอนาคต
- หากเพิ่ม API key storage ต้องใช้ authenticated encryption และมี key rotation strategy

## License

ยังไม่ได้กำหนด license สำหรับ repository นี้ โดย `backend/package.json` ระบุ `UNLICENSED` จึงไม่ควรนำไปเผยแพร่หรือใช้งานต่อภายนอกโดยถือว่ามีสิทธิ์แบบ open source จนกว่าจะเพิ่มไฟล์ license อย่างชัดเจน
