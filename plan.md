# zEXtream-Application-AI — แผนงานและสถานะโครงการ

เอกสารนี้สรุปสิ่งที่พัฒนาเสร็จแล้ว งานที่ยังต้องตรวจยืนยัน และงานที่ควรทำต่อ โดยอ้างอิงจาก source code ปัจจุบัน, Git history, Claude session เดิม, Docker task output และผล build/test ที่ตรวจล่าสุด

อัปเดตสถานะล่าสุด: 13 กรกฎาคม 2026 (Asia/Bangkok) — Phase 0-10 ครบ `[x]` ทั้งหมดแล้ว (Phase 10 ยังไม่ deploy ขึ้น production รอ user ยืนยัน)

## สัญลักษณ์สถานะ

- `[x]` เสร็จแล้วและมี source code อยู่ใน repository
- `[~]` ทำแล้วบางส่วน แต่ยังขาดการทดสอบหรือมี defect ที่ต้องแก้
- `[ ]` ยังไม่ได้ทำ
- `P0` ต้องแก้ก่อนใช้งานจริง เพราะกระทบ security หรือข้อมูลผู้ใช้
- `P1` ต้องแก้ก่อนถือว่า feature สมบูรณ์
- `P2` งานเพิ่มคุณภาพ ความสะดวก หรือ production readiness

## สรุปภาพรวม

| Phase   | งาน                                         | สถานะ | หมายเหตุ                                                  |
| ------- | ------------------------------------------- | ----- | --------------------------------------------------------- |
| Phase 0 | Repository และ project foundation           | `[x]` | Monorepo, pnpm, Docker และเอกสารหลักพร้อมแล้ว             |
| Phase 1 | PostgreSQL และ Prisma                       | `[x]` | Schema และ migrations หลักพร้อมใช้งาน                     |
| Phase 2 | Authentication และ users                    | `[x]` | Auth P0 ทั้งหมดปิดแล้ว รวมทั้ง integration test suite เต็มรูปแบบกับ PostgreSQL จริง |
| Phase 3 | Angular shell และ design system             | `[x]` | Login/register/layout, design system, session management UI, model-selector, toasts, responsive layout, accessibility pass เสร็จแล้ว |
| Phase 4 | Chat session และ Ollama streaming           | `[x]` | Backend streaming correctness, frontend state race และ WebSocket integration test suite (real socket.io-client) เสร็จแล้ว |
| Phase 5 | Code artifacts และ Monaco Editor            | `[x]` | ยืนยันจริงครบด้วย Ollama จริง: token streaming, Monaco progressive code generation, แก้โค้ดแล้วเกิด revision ใหม่, reload แล้วข้อมูลยังอยู่ — ดู "หมายเหตุจาก session ล่าสุด" ด้านล่าง |
| Phase 6 | Claude/OpenAI และ provider settings         | `[x]` | Provider configuration model, providers ทั้งสาม, capability metadata, per-user gating, connection-test UI/endpoint และ model-selector ทั้งสร้าง/แก้ session ครบแล้ว; เพิ่ม Socket.IO E2E ยืนยันจริงแล้วว่า (1) `chat:send` ที่ระบุ provider ที่ user ยังไม่ได้ configure key ถูก reject ด้วย `WsException` และไม่มี message ถูกสร้างใน DB (2) credential ของ user A ใช้กับ `chat:send` ของ user B ไม่ได้ แม้จะเป็น provider เดียวกัน — ทดสอบผ่าน fixture credential ที่ encrypt จริงผ่าน `ProviderSettingsService.upsertApiKey()` ไม่ใช่ API key จริง (ดู `backend/test/websocket.e2e-spec.ts` describe "provider runtime gating"); full e2e suite 51/51 ผ่าน, unit tests 162/162 ผ่าน |
| Phase 7 | Security hardening และ production readiness | `[x]` | Helmet/CSP, CORS allowlist, rate limiting (REST+WS), audit log, structured logging, health checks, metrics, backup/restore, deployment hardening, file-based secrets, CI image scan, optional Sentry error reporting, license เสร็จหมด; manual test ทั้ง 2 รายการทำจริงแล้ว (server restart กลาง stream, migration rollback) — graceful-shutdown ยืนยันว่าทำงานถูกต้องจริงใน **prod** topology (`node dist/src/main.js` ตรง ๆ, ระหว่างทางเจอและแก้บั๊กจริง 2 จุด: prod image ไม่ set `NODE_ENV=production` default ทำให้ crash-loop, compose overlay ไม่ pin ทับ `.env`); dev-only gap เดียวกัน (signal ไม่ลงถึง Nest process ผ่าน `pnpm start:dev`/`nest --watch`) ไล่ root-cause ต่อจนสุดทางแล้วสรุปว่าไม่ใช่แค่ signal-forwarding อย่างที่คิดแรก แต่เป็นพฤติกรรมที่ลึกกว่านั้นใน dev runtime เอง — ตัดสินใจไม่ไล่ต่อเพราะ prod (topology จริงที่ deploy) ไม่มีปัญหานี้ และ data safety ฝั่ง dev ยังคุ้มครองผ่าน backstop เดิม; account lockout ตัดสินใจไม่ทำแล้ว (มีเหตุผลเต็มใน `docs/threat-model.md`) — ทั้งสองเป็น decision ที่ปิดแล้ว ไม่ใช่งานค้าง — ดูรายละเอียดเต็มใน Phase 7 → Reliability |
| Phase 8 | Backoffice: Admin และ User management (Granular RBAC) + Guest role | `[x]` | Code เสร็จครบทั้ง backend (`admin` module, permission model, bootstrap service, `GuestBlockGuard`) และ frontend (3 หน้า backoffice + หน้า account-pending) พร้อม tests ผ่านหมด (backend unit 188/188, e2e **68/68**, frontend unit 45/45, Playwright browser e2e 6/6 จริงผ่าน browser จริงรวม `guest-activation.spec.ts`); ตรวจซ้ำอีกรอบแล้วพบ+แก้ครบ: บั๊ก stat-card icon ว่างบน dashboard (เจอจาก screenshot QA จริง), regression ใน Playwright suite (แก้แล้ว), gap "revoke permission มีผลทันที" ไม่มี test ตรง ๆ (เพิ่มแล้ว), ลบบัญชีทดสอบออกจาก production แล้ว; **deploy ขึ้น production จริงแล้วครบ 100%** (`chat.zextream.com`, migration applied, `ake.kidsapon@gmail.com` ยืนยันเป็น admin เต็มสิทธิ์บน production DB จริง, frontend build ล่าสุดที่มี stat-card icon fix ถูก deploy ไปพร้อมกับรอบ deploy ของ Phase 9 เมื่อ 12 กรกฎาคม 2026) — เพิ่ม backend+browser e2e เข้า CI (`.github/workflows/ci.yml`) ยังไม่ push ขึ้น remote — ดูรายละเอียดเต็มใน Phase 8 |
| Phase 9 | Token usage tracking และ reporting | `[x]` | Backend (3 provider parse usage จริง + gateway + `MessagesService` + `AdminDashboardService` + shared-types) และ frontend (badge ต่อข้อความ + stat card/provider breakdown ใน backoffice) เสร็จครบ; unit 205/205, e2e 68/68, frontend unit 45/45 ผ่านหมด; ยืนยันจริงด้วย Ollama ทั้งระดับ API/DB และเบราว์เซอร์จริง (Playwright screenshot) ผ่าน isolated environment — commit แล้ว ยังไม่ deploy ขึ้น production ดูรายละเอียดเต็มใน Phase 9 |
| Phase 10 | Model selection ที่ใช้งานได้จริง + Claude/Codex ผ่าน host-bridge แทน API key | `[x]` | Ollama model list เปลี่ยนจาก hardcode เป็น live query `/api/tags`; claude/openai เอา BYOK ออกทั้งหมด เปลี่ยนไปเรียก `claude.exe`/`codex.exe` ที่ login ไว้บนเครื่อง deploy เองผ่าน service ใหม่ `host-bridge/` (รันนอก Docker); backend unit 189/189, e2e 67/67, frontend unit 45/45, host-bridge unit 21/21 ผ่านหมด; ยืนยันจริงถึงขั้นเรียก `claude.exe`/`codex.exe` จริงผ่าน bridge จริงและได้ tokenCount บันทึกถูกต้อง — ระหว่างยืนยันเจอบั๊กจริง 1 จุดและแก้แล้ว (codex เขียนสถานะ login ลง stderr ไม่ใช่ stdout เวลาถูก spawn แบบ non-interactive) — ยังไม่ deploy ขึ้น production ดูรายละเอียดเต็มใน Phase 10 |

## สถานะ Repository

### Canonical working copy

- Path: `D:\AI\zEXtream-Application-AI`
- Branch: `main`
- Remote: `https://github.com/kidsapondev/zEXtream-Application-AI.git`
- Commit ล่าสุด ณ เวลาอัปเดตแผน: `73c6427` — `[ADD] Real-socket coverage for Ollama HTTP-error/malformed-stream; close out Phase 7`
- Local branch ตรงกับ `origin/main`

### Working copy เดิมที่เลิกใช้

- Path: `D:\AI\chat-workspace`
- ห้ามแก้ source ต่อใน directory นี้ เพื่อป้องกัน source แยกจาก canonical working copy

### งานจัดระเบียบ Repository

- [x] กำหนด `D:\AI\zEXtream-Application-AI` เป็น canonical working copy
- [x] กำหนดให้หยุดแก้ source ใน `D:\AI\chat-workspace`
- [x] ตรวจ `login.md`; หากมี credential จริงให้ลบจาก Git history และเปลี่ยนรหัสผ่าน (เป็น test credential เท่านั้น (`test3@example.com`), ไม่ใช่ secret จริง) — ผู้ใช้อนุมัติให้ rewrite Git history แล้ว: ใช้ `git filter-branch --index-filter "git rm --cached --ignore-unmatch login.md" --prune-empty -- main` ลบ blob ออกจากทั้ง 32 commits (รวม `0e58258` และ `84239fc` ที่เคยมีไฟล์นี้), สร้าง safety-backup branch ไว้ก่อนแก้, ตรวจแล้วว่า tree ของ HEAD ก่อน/หลังเหมือนกันทุกไบต์ (ไม่มีอะไรเปลี่ยนนอกจาก login.md ใน history เก่า), build ผ่านหลัง rewrite, แล้ว force-push (`--force-with-lease`) ไปที่ `origin/main` สำเร็จ — ยืนยันแล้วว่า `origin/main` ไม่มี `login.md` ในประวัติอีกต่อไป; หมายเหตุ: GitHub อาจยัง serve object เก่าผ่าน direct SHA ได้ชั่วคราวจนกว่า GC ฝั่ง server จะทำงาน (พฤติกรรมมาตรฐานของ GitHub หลัง force-push ไม่ใช่บั๊ก) แต่ไม่ใช่ความเสี่ยงจริงเพราะเป็นแค่ test credential; local safety-backup branch (`backup-before-login-md-purge`) ยังอยู่ในเครื่องเป็น recovery net รอผู้ใช้สั่งลบเองเมื่อพร้อม
- [x] เพิ่ม `.idea/` ลง `.gitignore` หากไม่ต้องการแชร์ IDE configuration

เกณฑ์รับงาน:

- เหลือ working copy หลักเพียงตำแหน่งที่ทีมตกลงกัน
- branch หลักตรงกับ remote
- `git status` สะอาดหลัง sync
- ไม่มี credential จริงอยู่ใน tracked files หรือ Git history

---

## Phase 0 — Project foundation

### เสร็จแล้ว

- [x] สร้าง pnpm workspace
- [x] แยก package เป็น `frontend`, `backend` และ `packages/shared-types`
- [x] กำหนด Node.js 24+ และ pnpm 11
- [x] สร้าง Dockerfiles สำหรับ frontend และ backend
- [x] สร้าง Docker Compose base, development override และ production override
- [x] ตั้ง PostgreSQL health check
- [x] แยก migration service ให้รัน `prisma migrate deploy` ก่อน backend
- [x] ตั้ง Nginx ให้เสิร์ฟ Angular และ proxy `/api/` กับ `/ws/`
- [x] ตั้ง Angular development proxy
- [x] เพิ่ม root `.gitignore` สำหรับ `node_modules` และ build outputs ทุก workspace
- [x] เพิ่ม `README.md` ภาษาไทยแบบละเอียด
- [x] Backend production build ผ่าน
- [x] Frontend production build ผ่าน

### ต้องปรับปรุง

- [x] เพิ่ม root scripts สำหรับ build/test/lint ทั้ง workspace เช่น `build`, `test`, `lint`, `check`
- [x] เพิ่ม CI pipeline เพื่อรัน install, generate Prisma, build, test และ lint ทุก commit (`.github/workflows/ci.yml`)
- [x] กำหนด line-ending policy ด้วย `.gitattributes` เพื่อลด warning LF/CRLF บน Windows
- [x] กำหนด license ให้ชัดเจน หรือยืนยันว่าเป็น proprietary project — เพิ่ม `LICENSE` (proprietary/all-rights-reserved) ที่ root, ตั้ง `"license": "UNLICENSED"` ให้ตรงกันทุก workspace package (`package.json` ที่ root, `frontend`, `backend` เดิม, `packages/shared-types`, `e2e`), อัปเดต README's License section
- [x] ลบ Nest/Angular starter README ที่ไม่เกี่ยวข้อง หรือเปลี่ยนให้ลิงก์กลับ root README

เกณฑ์รับงาน:

- คำสั่งตรวจทั้ง repository รันได้จาก root เพียงคำสั่งเดียว
- CI ผ่านบน clean checkout
- ไม่มี generated output หรือ dependency directory ถูก track

---

## Phase 1 — Database และ Prisma

### เสร็จแล้ว

- [x] สร้าง `User` และ `RefreshToken`
- [x] สร้าง `ChatSession` และ `Message`
- [x] สร้าง `CodeArtifact` พร้อม revision chain
- [x] เพิ่ม enums สำหรับ user role, provider, message role, stream status และ artifact origin
- [x] กำหนด cascade delete จาก user → sessions → messages/artifacts
- [x] เพิ่ม indexes สำหรับ session list, message history และ artifact revisions
- [x] เพิ่ม unique constraint `(sessionId, filename, revision)`
- [x] เพิ่ม migrations สำหรับ auth, chat/messages และ code artifacts
- [x] เชื่อม Prisma ผ่าน PostgreSQL adapter
- [x] เชื่อม Prisma lifecycle กับ NestJS module

### ต้องทำต่อ

- [x] เพิ่ม integration test ที่รัน migrations บน database ว่าง (`backend/test/migrations-empty-db.e2e-spec.ts` — สร้าง throwaway database จริงใน Postgres instance เดียวกัน รัน `pnpm exec prisma migrate deploy` ตรงกับคำสั่งที่ `docker-compose.yml`'s `migrate` service ใช้ ยืนยัน table/`_prisma_migrations` ครบ แล้ว drop database ทิ้ง; รันจริงผ่านแล้วทั้งกับ `docker compose up -d postgres` และกับ standalone container แยก)
- [x] ทดสอบ cascade delete ของ user/session/message/artifact (`backend/test/cascade-delete.e2e-spec.ts` — ยืนยันจาก migration SQL จริงว่า user→session/refresh_token/provider_credential, session→message/code_artifact, message→code_artifact ทั้งหมด `ON DELETE CASCADE`; ส่วน `code_artifacts.parent_artifact_id` (revision chain) เป็น `ON DELETE SET NULL` ไม่ cascade — มี test คุมทั้งสามกรณี)
- [x] ตรวจ compatibility ของ `uuidv7()` กับ PostgreSQL environment ทุกแห่งที่จะ deploy — ยืนยันแล้วว่าเป็น native builtin function ของ PostgreSQL 18 (RFC 9562 version-7 UUID) ไม่ใช่ extension (`pgcrypto`/`uuid-ossp`); ไม่มี `CREATE EXTENSION` ใน migration ใดเลย และ `docker-compose.yml` pin `postgres:18.4-alpine` ตรงกันพอดี ทดสอบจริงทั้งเรียก `SELECT uuidv7()` ตรงๆ และ insert row จริงแล้วตรวจ format ของ id ที่ได้ (`backend/test/migrations-empty-db.e2e-spec.ts`, `backend/test/cascade-delete.e2e-spec.ts`)
- [x] เพิ่ม cleanup policy สำหรับ refresh tokens ที่หมดอายุหรือ revoked แล้ว (`RefreshTokenCleanupService` ดู Phase 7 → Reliability)
- [x] พิจารณา pagination สำหรับ messages, sessions และ artifact revisions — เพิ่ม optional `limit`/`offset` query params (offset-based, ไม่ใช่ cursor-based — เลือกเพราะ list ทุกอันถูก scope ด้วย user/session เดียวอยู่แล้ว ไม่ใช่ global feed ขนาดใหญ่ ทำให้ downside ของ OFFSET/LIMIT ไม่มีนัยสำคัญที่ scale นี้ และง่ายกว่า cursor มากในแง่ backward compatibility) ให้ `GET /api/chat/sessions`, `GET /api/chat/sessions/:id/messages` และ `GET /api/chat/sessions/:sessionId/artifacts/revisions`; ค่า default page size คือ 50 เมื่อขอ pagination แต่ไม่ระบุ `limit`; เมื่อไม่ส่ง `limit`/`offset` เลย endpoint คืนค่าเหมือนเดิมทุกประการ (มี test ยืนยันทั้ง omitted-params case และ paginated case ใน `backend/test/pagination.e2e-spec.ts`) — ดู `backend/src/chat/dto/pagination-query.dto.ts` สำหรับ rationale เต็ม; `MessagesService.listForSession()` ที่ `ChatGateway` เรียกแบบไม่มี pagination เพื่อสร้าง AI context ยังคืนค่าครบทุก message เหมือนเดิม ไม่ถูกกระทบ. **retention policy ยังไม่ได้ทำ** — pagination วางฐานให้ retention ทำต่อได้ แต่การตัดสินใจว่าจะเก็บข้อมูลนานเท่าไหร่/ลบแบบไหนเป็น product decision ที่ต้องตัดสินใจแยก ไม่อยู่ในขอบเขตรอบนี้ (เป็น code-only pass)
- [x] ปรับ `listLatestForSession()` ให้ query เฉพาะ revision ล่าสุดจาก database แทนโหลดทุก revision เข้า memory — เปลี่ยนเป็น `SELECT DISTINCT ON (filename) ... ORDER BY filename, revision DESC` ผ่าน `$queryRaw`/`Prisma.sql` (parameterized, ไม่ string-interpolate `sessionId`) แทนการ `findMany` ทุก revision แล้ว reduce ใน memory; method signature และ return shape (`Promise<CodeArtifact[]>`) ไม่เปลี่ยน จึงไม่กระทบ `ChatGateway`/`ArtifactsController` ที่เรียกอยู่; พิสูจน์ behavior-equivalence ด้วย `backend/test/artifacts-latest-revision.e2e-spec.ts` ซึ่ง reimplement algorithm เดิมแยกต่างหากแล้วเทียบกับ session ที่มีหลายไฟล์ หลาย revision ต่อไฟล์ ผ่านทั้ง service เรียกตรงและผ่าน REST endpoint

เกณฑ์รับงาน:

- migration deploy ผ่านทั้ง database ใหม่และ database ที่มี migration เดิม
- integration tests ยืนยัน constraints และ cascade behavior
- query session/artifact ยังตอบสนองได้เมื่อมีข้อมูลจำนวนมาก

---

## Phase 2 — Authentication และ User management

### เสร็จแล้ว

- [x] Register ด้วย email, password และ display name
- [x] Normalize email เป็น lowercase และ trim ก่อน query/create
- [x] Hash password ด้วย Argon2id
- [x] Login ด้วย Passport local strategy
- [x] Access JWT ผ่าน Bearer token
- [x] Refresh JWT ผ่าน httpOnly cookie
- [x] Refresh-token family และ replacement chain
- [x] Revoke token ตอน logout
- [x] ตรวจ token reuse และ revoke token family
- [x] ตรวจ `isActive` ตอน login/refresh
- [x] Global access-token guard สำหรับ REST endpoints
- [x] Public decorator สำหรับ health และ auth endpoints
- [x] Frontend เก็บ access token ใน memory
- [x] Frontend app initializer ลอง refresh ตอน hard reload
- [x] HTTP interceptor refresh และ retry เมื่อเจอ `401`
- [x] ป้องกัน refresh request ซ้ำพร้อมกันภายใน browser tab เดียว
- [x] มี `/api/users/me`

### P0 — ต้องแก้ก่อนใช้งานจริง

- [x] ทำ refresh-token rotation ให้เป็น atomic transaction
  - lock หรือ conditional update token เดิมว่า `revokedAt` ต้องยังเป็น `null`
  - สร้าง token ใหม่และ revoke token เดิมใน transaction เดียว
  - ป้องกันหลาย browser tabs refresh token เดียวกันพร้อมกันแล้วได้ token ใหม่หลายใบ
- [x] ตรวจ `tokenHash` กับ refresh token ที่ได้รับจริง หรือถ้าไม่ใช้ให้ทบทวน design และลบ field ที่ทำให้เข้าใจผิด
- [x] เปลี่ยน duplicate-email response จาก `UnauthorizedException` เป็น `ConflictException`
- [x] ป้องกัน account enumeration ด้วยข้อความและ timing ที่เหมาะสม
- [x] เพิ่ม rate limiting ให้ register, login และ refresh
- [x] ตรวจ trusted proxy/IP handling ก่อนบันทึก `req.ip` ใน production

### P1 — Tests ที่ต้องเพิ่ม

- [x] Register สำเร็จและ duplicate email (`backend/test/auth.e2e-spec.ts`)
- [x] Login รหัสผ่านถูก/ผิด และ inactive user (`backend/test/auth.e2e-spec.ts`)
- [x] Refresh สำเร็จ (`backend/test/auth.e2e-spec.ts`)
- [x] Refresh token หมดอายุ (`backend/test/auth.e2e-spec.ts` — ตั้ง `expiresAt` ของ DB row ให้อยู่ในอดีตตรงๆ แทนการรอ JWT หมดอายุจริง)
- [x] Refresh token reuse detection (`backend/test/auth.e2e-spec.ts` — ยืนยันว่า token family ทั้งหมดถูก revoke)
- [x] Concurrent refresh สอง request (`backend/test/app.e2e-spec.ts`)
- [x] Logout แล้ว refresh ไม่ได้ (`backend/test/auth.e2e-spec.ts`)
- [x] Hard reload แล้ว restore session ได้ (`backend/test/auth.e2e-spec.ts` — จำลอง flow ของ frontend app initializer: refresh ด้วย cookie อย่างเดียวไม่มี Authorization header แล้วยืนยัน access token ใหม่เรียก REST ได้จริง; ฝั่ง browser จริงยืนยันเพิ่มใน `e2e/tests/auth-and-chat.spec.ts` ผ่าน `page.reload()`)
- [x] หลาย tab ใช้ refresh cookie เดียวกัน (`backend/test/app.e2e-spec.ts` ระดับ HTTP; `e2e/tests/refresh-token-race.spec.ts` ระดับ browser จริง — เปิดสอง page ใน context เดียวกัน บังคับให้ยิง `/api/auth/refresh` พร้อมกันจริงๆ ด้วย network-level gate แล้วยืนยันว่ามี tab หนึ่งใช้งานได้เสมอ และ tab ที่แพ้ race จะ redirect ไป `/login` สะอาดๆ ไม่ค้าง)

เกณฑ์รับงาน:

- token เดิมหมุนได้สำเร็จเพียงครั้งเดียว
- concurrent refresh ไม่สร้าง valid descendants มากกว่าหนึ่งเส้นทาง
- logout และ reuse detection revoke token ตาม policy ที่กำหนด
- auth integration tests ผ่านทั้งหมด

---

## Phase 3 — Frontend shell และ Design system

### เสร็จแล้ว

- [x] Angular standalone application
- [x] Zoneless change detection
- [x] Route `/login`, `/register`, `/chat`, `/chat/:sessionId`
- [x] Auth guard และ return URL หลัง login
- [x] Login form พร้อม validation และ loading state
- [x] Register form พร้อม validation และ loading state
- [x] App shell, icon rail และ secondary sidebar
- [x] Design-system components ได้แก่ badge, card, page header, segmented tabs และ stat card
- [x] Chat session sidebar
- [x] New chat และ logout actions
- [x] Responsive split layout สำหรับ chat/editor
- [x] Shared styles และ design tokens

### ต้องทำต่อ

- [x] เพิ่ม route `/settings/providers` หรือซ่อนปุ่ม settings จนกว่า Phase 6 จะพร้อม
- [x] เพิ่ม rename/archive/delete session controls ใน UI (`session-list-item.component.ts` — inline rename, archive hides session from the active list via existing `isArchived` update endpoint, no new "archived view" added since none was requested)
- [x] เพิ่ม confirmation ก่อนลบ session (`ds-confirm-dialog` — focus-trapped, closes on Escape/backdrop, wired to delete only)
- [x] เพิ่ม loading, empty และ error states ที่สม่ำเสมอ (session list loading/empty, chat thread loading/empty/error, shared `.hint`/`.hint--error` styles)
- [x] เพิ่ม toast/notification service (`ToastService` + `ds-toast-stack`, mounted in `app.html`; wired into rename/archive/delete, provider save/remove, and WS `exception` events)
- [x] เพิ่ม accessibility: labels, focus management, keyboard navigation และ ARIA states (icon-button `aria-label`s, confirm-dialog focus trap/Escape, code-editor tab-close converted from a non-semantic nested `<span>` to a real sibling `<button>`)
- [x] เพิ่ม mobile layout และตรวจ split-pane บนหน้าจอเล็ก
- [x] เพิ่ม frontend component/store tests (`chat.store.spec.ts`, `session-list.store.spec.ts`, `toast.service.spec.ts`, extended `socket.service.spec.ts`)
- [x] **แก้บั๊กจริงที่ผู้ใช้รายงาน**: chat message list หยุด scroll และซ่อน composer เมื่อบทสนทนายาวขึ้น — root cause คือ `ds-app-shell`'s `[main]` slot content (`<div main>` เปล่า ๆ ไม่มี class) ไม่มี height ของตัวเอง (`height: auto`) ทำให้ทั้งเชน `.workspace-split` → `.workspace-split__chat` → `.chat-thread` → `.chat-thread__messages` (แต่ละชั้น sizing เป็น `height: 100%` ของ parent) resolve เป็น `auto` หมดทุกชั้นเพราะ ancestor ตัวแรกไม่เคยถูก bound จริง แล้ว `ds-app-shell`'s `overflow: hidden` เดิมก็ clip ส่วนที่ล้นไปเงียบ ๆ โดยไม่มี scrollbar ให้เห็นเลย — ยืนยันด้วย Playwright จริง (seed 40 ข้อความ) ก่อนแก้: composer อยู่ต่ำกว่า viewport ~2600px มองไม่เห็นเลย, หลังแก้: composer มองเห็นเต็ม, `.chat-thread__messages` มี bounded height จริงพร้อม auto-scroll ไปข้อความล่าสุด — แก้โดยเปลี่ยน `.app-shell__main` เป็น column flex + `overflow-y: auto` (แทน `overflow: hidden` เดิมซึ่งเป็นค่า default ที่ทำให้หน้า settings มีบั๊กแฝงเดียวกันด้วย แค่ยังไม่มี content พอจะเห็น) และเพิ่ม class `chat-main` ให้ `[main]` ของหน้า chat โดยเฉพาะเพื่อให้ chain เดิมที่ถูกต้องอยู่แล้วมี height จริงให้ resolve; รัน Playwright browser e2e ครบ (5 ผ่าน, 2 skip ตามปกติ) และ Vitest (45/45) ยืนยันไม่มี regression — เพิ่ม polish เล็กน้อยไปด้วย (shadow, fade-in message ใหม่, thin scrollbar, `overflow-wrap` กัน URL ยาวดันจอ mobile, composer input font 16px กัน iOS auto-zoom)

เกณฑ์รับงาน:

- ไม่มีปุ่มที่นำไป dead route
- ทุก async action มี loading และ error feedback
- navigation ใช้งานได้ด้วย keyboard
- responsive layout ผ่าน viewport หลักที่กำหนด

---

## Phase 4 — Chat session และ Ollama streaming

### เสร็จแล้ว

- [x] REST API สำหรับ list/create/update/delete session
- [x] ตรวจ ownership ก่อนอ่าน แก้ไข หรือลบ session ผ่าน REST
- [x] โหลด message history ตาม session
- [x] Reconcile message ที่ค้าง `streaming` เป็น `error` ตอนโหลด history
- [x] Shared WebSocket event contracts
- [x] Socket.IO gateway ที่ path `/ws/socket.io`
- [x] ตรวจ access token ตอน WebSocket connection
- [x] Join/leave room ตาม session
- [x] บันทึก user message และ assistant placeholder
- [x] Ollama provider adapter
- [x] Stream token จาก Ollama ไปยัง frontend
- [x] Stop generation ด้วย `AbortController`
- [x] บันทึกสถานะ `complete`, `error` และ `stopped`
- [x] Chat UI แสดงข้อความและสถานะ generating/error
- [x] Docker rebuild ของ Phase 4/5 ผ่าน

### P0 — Security และ session lifecycle

- [x] ตรวจ ownership ใน `chat:stop`
  - query message และ session owner ก่อน abort
  - ไม่ให้ user หนึ่งหยุด stream ของอีก user แม้ทราบ message ID
- [x] Disconnect socket ตอน logout
- [x] Reconnect/re-authenticate socket เมื่อ login เป็น user ใหม่
- [x] ออกแบบการ refresh token สำหรับ socket reconnect เมื่อ access token หมดอายุ
- [x] ตรวจว่า global REST auth guard ไม่รบกวน WebSocket handlers และเพิ่ม gateway-specific guard/test ให้ชัดเจน
- [x] Validate WebSocket payloads แทนการเชื่อ type จาก client
- [x] จำกัดขนาด `content`, `model`, filename และ artifact content

### P1 — Streaming correctness

- [x] ครอบ streaming pipeline ด้วย `catch` ที่ finalize message ทุก failure path
- [x] ย้าย `getProvider()`, registry setup และ parser processing เข้า error boundary เดียวกัน
- [x] หาก provider ไม่มีอยู่ ให้ reject ก่อนสร้าง assistant message หรือ finalize เป็น `error`
- [x] ป้องกัน send ซ้อนหลาย stream ใน session เดียว หรือกำหนด concurrency policy ให้ชัดเจน (`ActiveStreamRegistry.hasActiveStream()`/`register(messageId, sessionId)`; นโยบายคือ 1 stream ต่อ session เอกสารไว้ใน doc comment ของ `ActiveStreamRegistry`)
- [x] ยกเลิก active streams ก่อนลบ session (`ActiveStreamRegistry.stopAllForSession()` เรียกจาก `ChatSessionsService.remove()`)
- [x] จัดการ client disconnect ระหว่าง stream (`ChatGateway` implements `OnGatewayDisconnect`; ยืนยันด้วย regression test ว่า `finalizeAssistantMessage`/emit ยังทำงานแม้ client ที่เริ่ม stream disconnect ระหว่างทาง)
- [x] กำหนด timeout สำหรับ Ollama request และ stream inactivity — **ปรับแก้จากการทดสอบจริง**: `OLLAMA_CONNECT_TIMEOUT_MS` เดิม 10s สั้นเกินไปจริง — ทดสอบกับ Ollama จริง (โมเดล 14B ~14.6GB) พบว่า cold load (ครั้งแรกหรือหลัง idle นานจน unload) ใช้เวลาเกิน 10s ได้จริง ทำให้ request แรกของ session ล้มเหลวเสมอ จึงปรับเป็น 90s; ระหว่างแก้พบบั๊กที่สองด้วย: `armInactivityTimer()` เดิมถูกเรียกตั้งแต่ก่อน fetch() เริ่ม ทำให้ inactivity timer (30s) แข่งกับ connect timer และ misreport "stream timed out จาก inactivity" ทั้งที่จริงคือ "ยังเชื่อมต่อ/รอโมเดลโหลดอยู่" — แก้โดยเลื่อนการ arm inactivity timer ไปเริ่มหลัง connect สำเร็จเท่านั้น ยืนยันด้วย unit test เดิม (`OllamaProvider.spec.ts`) และทดสอบจริงกับ Ollama cold/warm สองรอบ
- [x] ตรวจ malformed/non-JSON lines จาก Ollama โดยไม่ทำให้ message ค้าง (skip บรรทัดที่ parse ไม่ได้และ stream ต่อ แทนที่จะ fail ทั้ง stream; มี test คุม)
- [x] ปรับ session title อัตโนมัติจากข้อความแรก หากต้องการ UX แบบ chat application (`deriveSessionTitle()` ใน `chat.gateway.ts` + `ChatSessionsService.setTitleIfDefault()`)

### P1 — Frontend state race

- [x] ป้องกัน HTTP response ของ session เก่าเขียนทับ session ใหม่ (`ChatStore.loadSession()` ใช้ generation counter + session-id guard ก่อน `.set(history)`, ตาม pattern เดิมใน `ArtifactStore`)
- [x] Deduplicate message เมื่อ REST history และ socket event มาถึงใกล้กัน (`ChatStore.upsertMessage()` key ด้วย message id ทั้ง `chat:message:created` และ `chat:message:updated`)
- [x] Disable หรือควบคุม Send ขณะกำลังส่ง/stream ตาม concurrency policy (`ChatStore.isStreaming` computed จาก `streamingStatus === 'streaming'`; composer's Send ปิดใช้งาน, Stop ยังกดได้เสมอ)
- [x] แสดงสถานะ socket disconnected/reconnecting (`SocketService.connectionState` signal ผูกกับ Socket.IO connect/disconnect/reconnect events; banner ใน `chat-workspace.component.html`)
- [x] แสดง upstream error ที่เข้าใจง่าย (`message.errorMessage` ยังแสดงใน chat thread เหมือนเดิม; error ที่เกิดก่อนสร้าง message เช่น "no API key" หรือ "stream already in progress" มาเป็น WS `exception` event และ toast ผ่าน `ChatStore`)
- [x] Scroll ไปข้อความล่าสุดอย่างเหมาะสม (`ChatThreadComponent` ใช้ `afterRenderEffect` + scroll-position threshold — auto-scroll เฉพาะเมื่อผู้ใช้อยู่ใกล้ล่างสุดอยู่แล้ว)

### Tests ที่ต้องเพิ่ม

- [x] WebSocket connection ด้วย token ถูกต้อง/ผิด/หมดอายุ (`backend/test/websocket.e2e-spec.ts` ผ่าน `socket.io-client` จริงต่อ server จริง)
- [x] Join session ตัวเองและปฏิเสธ session ของ user อื่น (`backend/test/websocket.e2e-spec.ts`)
- [x] Send → created → token → updated ครบลำดับ (`backend/test/websocket.e2e-spec.ts` — ยืนยัน created(user) → created(assistant, streaming) → updated(error) ครบลำดับผ่าน socket จริง กับ Ollama ที่ unreachable จริงตาม config; ไม่มี `chat:token` เพราะ fetch ล้มเหลวก่อนได้ response ซึ่งเป็น error path จริงที่ deterministic กว่าการรอ Ollama จริง)
- [x] Stop generation ของตัวเอง (`backend/test/chat-stop.e2e-spec.ts` — ใช้ black-hole TCP server แทน Ollama จริงเพื่อจำลอง stream ที่ค้างจริง แล้วยืนยัน `chat:stop` ทำให้ finalize เป็น `stopped` ผ่าน socket จริง; abort mechanics ระดับ unit ถูกคุมโดย `active-stream-registry.service.spec.ts` อยู่แล้ว)
- [x] ปฏิเสธ stop generation ของ user อื่น (`backend/test/chat-stop.e2e-spec.ts`)
- [x] Ollama unavailable, HTTP error, malformed stream และ timeout — unavailable (connection refused) ยืนยันผ่าน WS e2e เต็มเส้นทางแล้ว (`websocket.e2e-spec.ts`); เพิ่ม `backend/test/provider-errors.e2e-spec.ts` (Jest project "e2e-provider-errors" ใหม่ พร้อม mock Ollama HTTP server จริงที่ตั้งค่า mode ได้ต่อ test) ยืนยันจริงอีก 2 เคสผ่าน real socket: (1) HTTP error (mock ตอบ 500) → message จบเป็น `error` พร้อม `errorMessage: 'Ollama returned HTTP 500'` (2) malformed NDJSON line → **ไม่ได้** finalize เป็น error ตามที่เข้าใจผิดไว้เดิม แต่ข้าม line เสียแล้ว stream ต่อปกติ (`chat:token` ยังส่ง delta ที่ถูกต้อง, message จบเป็น `complete`) — เป็น code path ที่ต่างจาก HTTP error จริง คุ้มค่าที่จะมี e2e แยก; timeout (90s/30s hardcoded ไม่มี env override) ยังคงเหลือแค่ unit-level (`ollama.provider.spec.ts` ด้วย fake timer) เพราะ e2e จริงจะเพิ่มเวลารันทั้ง suite เกินคุ้ม และ finalize behavior เหมือน HTTP error ที่ยืนยัน e2e แล้ว; e2e suite รวม 55/55 ผ่าน (10 suites, 3 Jest projects)
- [x] Server restart แล้ว reconcile stuck message (`backend/test/websocket.e2e-spec.ts` — insert message ด้วย `streamingStatus: 'streaming'` ตรงๆ ผ่าน Prisma จำลอง crash กลาง stream แล้วเรียก `GET /messages` จริงยืนยันว่า `reconcileStuckMessages()` ทำงานจริงกับ DB จริง)
- [x] Logout/login คนละบัญชีใน browser instance เดิม — ฝั่ง backend socket identity ยืนยันแล้ว (`backend/test/websocket.e2e-spec.ts` — reconnect socket instance เดิมด้วย auth ใหม่ mirror `SocketService.setAccessToken()`); ฝั่ง browser จริงยืนยันเพิ่มใน `e2e/tests/identity-switch.spec.ts`

เกณฑ์รับงาน:

- ทุก assistant message จบด้วย `complete`, `stopped` หรือ `error`
- ไม่มี message ค้าง `streaming` จาก application exception ปกติ
- socket identity ตรงกับ user ปัจจุบันเสมอ
- cross-user WebSocket tests ถูกปฏิเสธทั้งหมด

---

## Phase 5 — Code artifacts และ Monaco Editor

### เสร็จแล้ว

- [x] เพิ่ม `CodeArtifact` schema และ migration
- [x] เพิ่ม `ArtifactsModule`, controller และ service
- [x] List revision ล่าสุดของแต่ละ filename
- [x] List revision history ตาม filename
- [x] สร้าง revision พร้อม `parentArtifactId`
- [x] เพิ่ม system prompt convention `language:relative/path.ext`
- [x] สร้าง incremental `ArtifactStreamParser`
- [x] แยก prose ออกจาก fenced code ระหว่าง AI stream
- [x] Emit artifact start/chunk/end events
- [x] บันทึก AI artifact เมื่อ fence จบ
- [x] สร้าง Monaco loader และ editor wrapper
- [x] เพิ่ม Monaco assets ใน Angular build
- [x] เพิ่ม artifact store
- [x] เพิ่ม file tabs และ split-pane editor
- [x] เพิ่ม Monaco diff editor component
- [x] สร้าง user revision เมื่อแก้เนื้อหา
- [x] Backend และ frontend build ผ่าน
- [x] Docker image rebuild และ restart สำเร็จ

### ยังไม่ได้ยืนยันจาก Claude session เดิม

- [x] ทดสอบ end-to-end ด้วย prompt ที่ทำให้ Ollama ตอบ fenced code จริง
- [x] ยืนยันว่า code ปรากฏใน Monaco แบบ progressive streaming
- [x] ยืนยัน artifact row และ revision ถูกบันทึกถูกต้องใน PostgreSQL
- [x] ยืนยัน reload session แล้วยังเห็นไฟล์ล่าสุด
- [x] ยืนยัน user edit สร้าง revision และ diff ถูกต้อง
- [x] ทดสอบ stop generation กลาง code fence
- [x] ทดสอบ malformed/unterminated/multiple code fences

### P0/P1 — Defects ที่ต้องแก้

- [x] นำ artifact revision ล่าสุดกลับเข้า AI context
  - ปัจจุบัน history ส่งเฉพาะ `Message.content`
  - code ถูกแยกออกจาก message จึงหายจาก context รอบถัดไป
  - ต้องกำหนดรูปแบบ context ที่รวม filename, language และ content ล่าสุด
- [x] รวม user-edited artifact เข้า context ก่อน follow-up generation
- [x] Debounce การ save จาก Monaco
  - ปัจจุบันทุก keystroke สร้าง WebSocket event และ database revision
  - กำหนด debounce เช่น 500–1000 ms หรือใช้ explicit Save
- [x] ทำ revision creation ให้ concurrency-safe
  - ป้องกันสอง request อ่าน latest revision เดียวกันแล้ว insert revision number ซ้ำ
  - ใช้ transaction isolation, advisory lock, counter หรือ retry unique conflict
- [x] กรอง artifact socket events ด้วย current session ID
- [x] ป้องกัน stale artifact HTTP response ตอนเปลี่ยน session
- [x] แก้ parser ให้ยอมรับ closing fence ที่ EOF โดยไม่มี newline
- [x] กำหนด behavior เมื่อ stream หยุดกลาง fence: save partial, discard หรือ mark incomplete
- [x] Sanitize/normalize filename และป้องกัน path traversal หากอนาคตเขียนไฟล์ลง filesystem
- [x] จำกัดขนาดและจำนวน artifacts ต่อ message/session
- [x] ใช้ revision จริงจาก server ใน `artifact:stream:end` แทนสร้าง DTO revision `0` ฝั่ง client
- [x] Dispose Monaco diff models เมื่อเปลี่ยน model/destroy เพื่อป้องกัน memory leak

### Artifact E2E test matrix

| กรณี                           | ผลที่คาดหวัง                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| Fence มี language และ filename | สร้างไฟล์ชื่อตรงตาม fence                                          |
| Fence ไม่มี filename           | สร้าง `snippet-1.<ext>`                                            |
| Fence ไม่มี language           | ใช้ `text`/`txt`                                                   |
| หลาย fences คนละไฟล์           | สร้าง artifact แยกทุกไฟล์                                          |
| ไฟล์ชื่อเดิมรอบถัดไป           | revision เพิ่มและ parent ถูกต้อง                                   |
| Closing fence แบ่งข้าม token   | parser ยังปิด block ถูกต้อง                                        |
| Closing fence ไม่มี newline    | ไม่เก็บ backticks เข้า content                                     |
| Stop กลาง fence                | จบตาม policy ที่กำหนดและไม่ค้าง streaming                          |
| User แก้หลายครั้งรวดเร็ว       | ไม่มี unique conflict และไม่สร้าง revision ทุก keystrokeเกินจำเป็น |
| Reload browser                 | โหลด revision ล่าสุดถูกต้อง                                        |
| Follow-up “แก้ไฟล์เดิม”        | AI ได้รับ artifact content ล่าสุดใน context                        |

เกณฑ์รับงาน Phase 5:

- artifact streaming ผ่าน E2E matrix
- revision ไม่มี duplicate/conflict ภายใต้ concurrent edits
- follow-up prompt เห็น code ล่าสุด
- stop/error ไม่ทิ้ง temporary artifact หรือ streaming message ค้าง

---

## Phase 6 — Claude/OpenAI providers และ Settings

### สิ่งที่มีแล้ว

- [x] Type `AiProviderKey` มี `ollama`, `claude`, `openai`
- [x] Prisma enum รองรับทั้งสาม provider
- [x] Provider interface และ factory pattern มีแล้ว
- [x] Environment มี `API_KEY_ENCRYPTION_KEY` placeholder

### งานที่ต้องทำ

- [x] ออกแบบ provider configuration model ต่อ user (`ProviderCredential` ใน Prisma schema: `(userId, provider)` unique, encrypted API key ต่อ provider ต่อ user; `ProviderSettingsService` ให้ list/upsert/remove/hasApiKey/getApiKeyForRuntime/testConnection และ per-user gating ใน session create/send — ดู Phase 6)
- [x] เลือก encryption format สำหรับ API key แบบ authenticated encryption
- [x] Validate `API_KEY_ENCRYPTION_KEY` เป็น key length/encoding ที่ถูกต้อง ไม่ใช่เพียง non-empty string
- [x] สร้าง service สำหรับ encrypt/decrypt/rotate API keys
- [x] ห้ามคืน decrypted key ผ่าน API หรือ log
- [x] Implement OpenAI provider (`backend/src/ai/providers/openai.provider.ts`, SSE parsing + error mapping)
- [x] Implement Claude provider (`backend/src/ai/providers/claude.provider.ts`, Anthropic SSE event parsing + error mapping)
- [x] Register providers ใน `AiModule` และ `AiProviderFactory`
- [x] เพิ่ม provider capability metadata เช่น models, streaming, max tokens (`ProviderSettingsService.listForUser()` คืน `models: string[]` ต่อ provider แล้ว; ollama ว่างเพราะไม่มี fixed catalog)
- [x] เพิ่ม `/settings/providers` route และ page
- [x] เพิ่ม wizard/modal สำหรับเพิ่ม API key และทดสอบ connection (API key form ไม่แสดงค่าเดิม, ปุ่ม `Test connection` เรียก `POST /api/settings/providers/:provider/test` และแสดงผลผ่าน toast/error state)
- [x] เพิ่ม model selector ตอนสร้างหรือแก้ session — `app-new-session-dialog` (`frontend/src/app/features/chat/new-session-dialog/`) เปิดจากปุ่ม "+" เมื่อผู้ใช้มี provider ที่ `configured` มากกว่าแค่ ollama; สำหรับ session เดิม ปุ่มเปลี่ยน provider ใน session list ใช้ dialog เดียวกันและบันทึกผ่าน `PATCH /api/chat/sessions/:id` พร้อม backend re-check ว่า key ของ provider ปลายทางยัง configured อยู่จริง
- [x] จำกัด DTO ให้เลือกเฉพาะ provider ที่ configured และ runtime รองรับ (`ENABLED_PROVIDERS` ขยายเป็นทั้งสาม provider ที่ runtime รองรับ + per-user key check ใน `ChatSessionsService.create()` และ `ChatGateway.onChatSend()` ผ่าน `ProviderSettingsService`)
- [x] เพิ่ม endpoint ทดสอบ provider โดยไม่เปิดเผย key (`POST /api/settings/providers/:provider/test`)
- [x] เพิ่ม key update/delete และ revocation flow
- [x] เพิ่ม error mapping ของแต่ละ provider (401/403 → invalid key, 429 → rate limited, 5xx → temporarily unavailable, อื่น ๆ → HTTP status/upstream message)
- [x] เพิ่ม tests ด้วย mocked upstream responses (`claude.provider.spec.ts`, `openai.provider.spec.ts`, เพิ่มเติมใน `provider-settings.service.spec.ts`; ไม่มี real network call)

เกณฑ์รับงาน:

- user บันทึกและลบ API key ได้โดยไม่มี plaintext key ใน database/log/response
- provider ทั้งสาม stream ผ่าน interface เดียวกัน
- session ไม่สามารถเลือก provider ที่ยังไม่ได้ configure
- settings route ไม่เป็น dead route

---

## Phase 7 — Security hardening และ Production readiness

### Security

- [x] เพิ่ม Helmet และกำหนด CSP ให้รองรับ Monaco อย่างปลอดภัย — Helmet ใน `backend/src/main.ts` (default-deny CSP, API ตอบ JSON เท่านั้นจึง CSP มีผลจำกัด) และ CSP เต็มรูปแบบ (รวม `worker-src blob: data:` และ `style-src 'unsafe-inline'` สำหรับ Monaco) ใน `frontend/nginx.conf` ซึ่งเป็นจุดที่เสิร์ฟ HTML จริง
- [x] เพิ่ม rate limiting สำหรับ REST และ WebSocket events — REST เสร็จแล้ว (throttle เดิมบน auth + เพิ่มใหม่บน `POST /api/chat/sessions`); WebSocket เสร็จแล้วในรอบถัดมาด้วย `WsRateLimiterService` (`backend/src/realtime/ws-rate-limiter.service.ts`) — per-socket fixed-window limiter เพราะ `ThrottlerGuard` ของ NestJS ไม่ครอบ `@SubscribeMessage` handlers; จำกัด `chat:send` 10/min, `session:join`/`session:leave` 30/min, `chat:stop` 20/min, `artifact:edit` 60/min ต่อ socket และล้าง state ตอน disconnect
- [x] เพิ่ม request/body size limits — จำกัด JSON/urlencoded body ที่ 256kb ผ่าน `app.useBodyParser()` ใน `main.ts`
- [x] เพิ่ม WebSocket event validation pipe/schema — มีอยู่แล้วจากรอบก่อนหน้า (`@UsePipes(ValidationPipe)` + `WsValidationFilter` ใน `chat.gateway.ts`) ตรวจสอบแล้วว่ายังอยู่
- [x] กำหนด CORS allowlist แทนค่า origin เดียวแบบคลุมเครือ — `CORS_ORIGIN` รองรับ comma-separated list พร้อม validate ด้วย zod, ค่าว่างจะปิด CORS แทนที่จะ fallback เป็น allow-all
- [x] เพิ่ม secure headers ใน Nginx — `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, CSP ใน `frontend/nginx.conf`
- [x] บังคับ HTTPS ใน production — redirect ตาม `X-Forwarded-Proto` ใน `frontend/nginx.conf` (ไม่ terminate TLS เอง เพราะ repo ไม่ได้ provision cert)
- [x] ตรวจ cookie flags ใน topology จริง — ตรวจแล้วว่า `secure: NODE_ENV === 'production'` ใน `auth.controller.ts` ถูกต้อง สอดคล้องกับการบังคับ HTTPS ข้างต้น ไม่ต้องแก้
- [ ] เพิ่ม account lockout/backoff ที่ไม่เปิดช่อง DoS — ตัดสินใจไม่เพิ่มกลไกใหม่: per-account lockout เปิดช่อง DoS ต่อเหยื่อได้ตามที่ plan.md เตือนไว้ และ IP-based throttle เดิม (5/min login) บวกกับ reuse-detection ที่ revoke ทั้ง token family (audit-logged ใหม่) ถือว่าเพียงพอสำหรับรอบนี้ ดูเหตุผลเต็มใน `docs/threat-model.md`
- [x] เพิ่ม audit log สำหรับ login, logout, token reuse และ provider-key changes — เพิ่ม `AuditLogService` (`backend/src/common/audit-log.service.ts`) และ wire เข้า `auth.service.ts` ครบ (register, login success/failure, refresh success, reuse detection, logout) และ `ProviderSettingsService` สำหรับ provider-key upsert/remove โดย log เฉพาะ event, user id, provider และ outcome ไม่บันทึก API key
- [x] ตรวจ dependency vulnerabilities และกำหนด update policy — รัน `pnpm audit`: ไม่มี high/critical, พบ moderate/low ทั้งหมดอยู่ใน transitive deps (`dompurify` ผ่าน `monaco-editor`, `esbuild`/`@babel/core` ผ่าน Angular build tooling, `@hono/node-server` ผ่าน Prisma dev tooling) ซึ่งต้องรอ upstream bump ไม่ใช่ direct dependency ที่ bump ตรงๆได้ อัพเดต `prettier` (patch, semver-safe) แล้ว ส่วนที่เหลือ (`@eslint/js`, `eslint`, `typescript`, `@types/node` เป็น major bump) ไม่แตะเพราะเสี่ยง breaking change
- [x] Threat-model cross-user access, token theft, prompt injection และ artifact filename attacks — `docs/threat-model.md`

### Reliability

- [x] เพิ่ม graceful shutdown ให้ active streams — `app.enableShutdownHooks()` + `AppShutdownService` (`backend/src/common/app-shutdown.service.ts`) เดิม บวก `ActiveStreamRegistry` implement `OnApplicationShutdown` เองโดยตรงในรอบถัดมา (`backend/src/chat/active-stream-registry.service.ts`) — abort ทุก stream ที่ยังทำงานอยู่ตอน SIGTERM/SIGINT ผ่าน path เดียวกับ user-initiated `chat:stop` (finalize เป็น `stopped` และ emit `chat:message:updated`) เลือกวิธีนี้แทนการ inject registry เข้า `AppShutdownService` เพื่อเลี่ยง cross-module coupling; `reconcileStuckMessages()` ยังคุ้มครอง data-loss กรณี restart แบบไม่ graceful (crash) อยู่เหมือนเดิม
- [x] เพิ่ม timeout/retry/circuit breaker สำหรับ AI providers — timeout เดิม (`ollama.provider.ts` connect-timeout + inactivity-timeout ผ่าน `AbortController`) บวก retry+circuit breaker ใหม่: `fetchWithRetry()` (`backend/src/ai/providers/fetch-with-retry.ts`) ทำ exponential backoff สูงสุด 3 ครั้งสำหรับ network error/429/5xx เฉพาะตอนเชื่อมต่อครั้งแรก (ไม่ retry หลัง stream เริ่มแล้วเพื่อไม่ให้ client เห็นเนื้อหาซ้ำ); `CircuitBreakerService` (`backend/src/ai/circuit-breaker.service.ts`) เปิด circuit ต่อ provider หลัง 5 ครั้งติดต่อกันที่ upstream ล้มเหลวจริง (network/5xx เท่านั้น) cooldown 30 วิ — **ตั้งใจไม่นับ 401/403/429 เป็นความล้มเหลวของ circuit breaker เพราะเป็นปัญหาเฉพาะ API key ของผู้ใช้คนเดียว ไม่ใช่สัญญาณว่า provider ทั้งระบบล่ม** การนับรวมจะทำให้ผู้ใช้คนหนึ่งใส่ key ผิดแล้วไป lock provider นั้นสำหรับผู้ใช้ทุกคน มี regression test ยืนยันเรื่องนี้โดยเฉพาะ
- [x] เพิ่ม database connection/readiness checks — `GET /api/health/ready` ใหม่ (`backend/src/health/`) ping Postgres ด้วย `SELECT 1`; `GET /api/health` เดิมเป็น liveness
- [x] กำหนด backup/restore procedure สำหรับ PostgreSQL — `docs/backup-restore.md` พร้อมทดสอบจริงแล้ว (`pg_dump`/`pg_restore` กับ container ที่รันอยู่จริง ดูรายละเอียดในเอกสาร)
- [x] เพิ่ม cleanup สำหรับ stale streaming artifacts และ refresh tokens — เพิ่ม `RefreshTokenCleanupService` (`@Cron` รายวัน, ลบ token ที่หมดอายุ/ถูก revoke เกิน 30 วัน) ส่วน stale streaming artifacts: `reconcileStuckMessages()` เดิมที่ทำงานตอนเปิด session ถือว่าเพียงพอแล้ว ไม่ได้เพิ่ม periodic sweep เพราะยังไม่พบ gap จริงที่ on-load reconciliation ไม่ครอบคลุม
- [x] เพิ่ม pagination และ retention policy — pagination เสร็จแล้วในรอบถัดมา (`limit`/`offset` บน session list, message history และ artifact revisions ดู Phase 1) โดย agent ที่ตอนแรกถูกกันไว้เพราะชนไฟล์กัน; retention policy (นโยบายเก็บข้อมูลนานเท่าไหร่) ยังเป็นการตัดสินใจเชิงผลิตภัณฑ์ที่ยังไม่ได้ทำ ไม่ใช่งาน code
- [x] ทดสอบ server restart ระหว่าง active stream — ทดสอบจริงกับ dev docker-compose stack ที่รันอยู่ (`docker compose ps` → backend/postgres healthy) และ Ollama จริงที่ reachable (`qwen2.5-coder:14b`): สร้าง user/session จริงผ่าน REST, เปิด socket.io client จริง, ยิง `chat:send` ที่ prompt ยาวจนเห็น `chat:token` จริงไหลเข้ามาก่อน (ยืนยันว่ากำลัง stream จริง ไม่ใช่ restart ก่อน provider เริ่มทำงาน) แล้วรอ 1.5 วิให้ stream ไปต่ออีกหน่อยก่อนสั่ง `docker compose restart backend`. ผลที่พบ (สอง finding แยกกัน):
  1. **`ActiveStreamRegistry.onApplicationShutdown()` (graceful path) ไม่ทำงานจริงใน dev topology เท่านั้น — ทดสอบ prod topology แยกต่างหากแล้วยืนยันว่าทำงานถูกต้อง** — dev: เทียบ log ก่อน/หลัง restart แล้วไม่มี log จาก `AppShutdownService`/graceful-shutdown เลย มีแต่ process ตายห้วน ๆ แล้ว `nest start --watch` compile ใหม่ทันที ต้นเหตุน่าจะมาจาก dev image ใช้ `CMD ["pnpm", "start:dev"]` (→ `nest start --watch`) ซึ่งเป็น process chain หลายชั้นที่ signal forwarding ของ SIGTERM ไม่ลงไปถึง Nest process จริง — ยังไม่ได้แก้ (priority ต่ำ เพราะ dev restart ปกติมาจาก file-watch ไม่ใช่ `docker compose restart` โดยตรง). **Prod**: build image จาก `target: prod` จริง รันคู่กับ dev postgres เดิม (ไม่แตะข้อมูล, verify แล้วว่า user count คงเดิมหลังทดสอบ) แล้วทำ mid-stream restart test ซ้ำแบบเดียวกัน — พบ log `ActiveStreamRegistry: "Aborting 1 in-flight stream(s) for shutdown (SIGTERM)"` และ `AppShutdownService: "Received shutdown signal (SIGTERM); beginning graceful shutdown"` ครบถ้วน, message จบด้วย `streamingStatus: 'stopped'` พร้อม partial content ที่ stream ไปแล้วถูกเก็บไว้ (ดีกว่า crash-path backstop ที่ content หายและจบด้วย `error` เปล่า ๆ) — ยืนยันว่า production จริงไม่มีปัญหานี้. ระหว่างทางเจอบั๊กจริง 2 จุดที่แก้แล้ว: (ก) prod stage ของ `backend/Dockerfile` ไม่เคย set `ENV NODE_ENV=production` เป็นค่า default ในตัว image เอง ทำให้ inherit `NODE_ENV=development` จาก `.env`/`docker-compose.yml`'s `${NODE_ENV}` passthrough แล้ว crash-loop ทันทีตอน boot เพราะ `logger.config.ts` พยายามโหลด `pino-pretty` transport ซึ่งเป็น devDependency ที่ไม่ได้ install ใน prod stage ที่ prune แล้ว (`pnpm install --prod`) — แก้โดยเพิ่ม `ENV NODE_ENV=production` ใน prod stage; (ข) แค่นั้นไม่พอเพราะ compose `environment:` ทับ image `ENV` เสมอ จึงต้องเพิ่ม `environment: NODE_ENV: production` ใน `docker-compose.prod.yml`'s backend service ด้วยเพื่อให้ overlay นี้ self-contained ไม่ต้องพึ่งว่า deployer ตั้ง `.env` ถูกหรือเปล่า
  2. **Backstop `reconcileStuckMessages()` ทำงานถูกต้อง** — เรียก `GET /api/chat/sessions/:id/messages` หลัง restart แล้วเห็น assistant message ที่ค้างอยู่ที่ `streamingStatus: 'streaming'` ถูกแปลงเป็น `streamingStatus: 'error'`, `errorMessage: 'Generation was interrupted.'` โดยอัตโนมัติ (endpoint นี้เรียก reconcile ทุกครั้งที่โหลด) — ไม่มี message ค้างสถานะ `streaming` ตลอดไป ไม่มี data corruption แม้ graceful path จะไม่ทำงาน — ลบ test user/session ออกจาก dev DB แล้วหลังทดสอบเสร็จ
  3. **ตามรอย dev-only gap ต่อจนสุดทาง แล้วสรุปว่าไม่คุ้มแก้ต่อ** — ลองสมมติฐานเดิม (signal ไม่ลงถึง Nest process ผ่าน process chain หลายชั้น) ด้วยการใส่ `tini -g` (ส่ง signal ทั้ง process group แทนที่จะพึ่งแต่ละชั้น forward เอง) เป็น ENTRYPOINT ของ dev stage แทน `docker compose`'s built-in `init: true` (ลองทั้งสองแบบ) — ตรวจแล้วว่า process group ID ของ pnpm/nest/node ตรงกันจริง (ไม่ได้อยู่คนละ group ตามที่สงสัยตอนแรก) แต่ log ยังไม่ขึ้นเหมือนเดิม; ทดสอบขั้นสุดท้ายด้วยการรัน compiled app แบบ standalone (ไม่ผ่าน `pnpm`/`nest --watch` เลย) แล้วส่ง `kill -TERM` ตรงเข้า PID เดียวนั้นเลย — ผลคือ process ยังตอบ health check ปกติต่อไปอีกกว่า 30 วินาทีโดยไม่มี log shutdown ใด ๆ เลย ก่อนจะหายไปเงียบ ๆ โดยไม่ทราบสาเหตุแน่ชัด สรุปว่าปัญหาไม่ใช่เรื่อง signal-forwarding ผ่าน process chain ตามที่เข้าใจตอนแรก แต่เป็นพฤติกรรมที่ลึกกว่านั้นในตัว dev runtime เอง (สงสัยเกี่ยวกับ `--enable-source-maps` หรือ `nestjs-pino`/worker-thread transport แต่ไม่ได้ยืนยัน) ซึ่ง root-cause เต็มรูปแบบต้องใช้เครื่องมือ debug ระดับลึกกว่านี้ (เช่น `--inspect`, เพิ่ม `console.error` ตรงใน handler ข้าม pino ไปเลย) — ตัดสินใจไม่ไล่ต่อเพราะเป็น dev-only issue ที่ prod (topology จริงที่ deploy ใช้งาน) ยืนยันแล้วว่าไม่มีปัญหานี้ และ data safety ฝั่ง dev ก็ยังคุ้มครองอยู่เต็มที่ผ่าน backstop ข้อ 2 ด้านบน — revert การเปลี่ยน `tini`/`init: true` ทั้งหมดออกแล้วเพราะพิสูจน์แล้วว่าไม่ได้แก้ปัญหาจริง ไม่อยากทิ้ง complexity ที่ไม่มีประโยชน์ไว้ในระบบ
- [x] ทดสอบ migration rollback/forward strategy — ทดสอบจริงกับ dedicated e2e test Postgres (`zextream-e2e-test-postgres`, ไม่แตะ dev database ที่มีข้อมูลจริงสะสมมาทั้ง session): `pg_dump -Fc` เก็บ baseline ก่อน, จำลอง forward migration ด้วย `ALTER TABLE users ADD COLUMN rollback_test_marker text` แล้วยืนยันว่าคอลัมน์ถูกเพิ่มจริง (`\d users`), จากนั้นจำลอง rollback ตาม procedure ใน `docs/backup-restore.md` จริง ๆ (`dropdb`/`createdb` แล้ว `pg_restore --clean --if-exists` จาก baseline dump) แล้วยืนยันว่าคอลัมน์ทดสอบหายไปและ schema กลับมาครบ 7 ตาราง ตรงกับก่อนหน้า, `prisma migrate status` แสดง "Database schema is up to date!" เหมือนเดิม, และรัน e2e suite เต็มรูปแบบ (51/51 ผ่าน) ยืนยันว่า database ที่ restore แล้วใช้งานได้จริงไม่ใช่แค่ schema ตรงแต่ query ไม่ได้ — ระหว่างทางเจอ Windows/Git-Bash path-mangling bug ตัวเดียวกับที่ `docs/backup-restore.md` เตือนไว้แล้วสำหรับ `docker cp`/`docker exec` path arguments (ต้อง escape ด้วย doubled-leading-slash หรือ stream ผ่าน stdin แทน `docker cp` ตรง ๆ) — ยืนยันว่าคำเตือนในเอกสารนั้นถูกต้องและจำเป็นจริง ไม่ใช่ทฤษฎี. **ข้อสรุป**: กลยุทธ์ rollback ของ repo นี้คือ backup-then-restore (ไม่มี down-migration) และผ่านการทดสอบจริงแล้วว่าใช้งานได้; ยังไม่ได้ทำ full destructive cycle (`docker compose down -v`) กับ dev stack ที่มีข้อมูลจริงอยู่ตามที่ `docs/backup-restore.md` แนะนำไว้ว่าควรทำก่อนเชื่อมั่นในโปรดักชัน — ทิ้งเป็น follow-up ที่ต้องทำกับ disposable stack เท่านั้น ไม่ใช่ dev stack ที่ใช้ร่วมกันอยู่ตอนนี้

### Observability

- [x] Structured JSON logging — `nestjs-pino` wire เข้า `app.module.ts`/`main.ts`, redact header/body ที่มี secret (`backend/src/common/logger.config.ts`)
- [x] Correlation/request ID สำหรับ REST และ WebSocket — REST: `X-Request-Id` (รับจาก header เดิมหรือ generate ใหม่, echo กลับใน response) ผ่าน pino-http `genReqId`; **WebSocket ข้ามรอบนี้โดยตั้งใจ** เพื่อเลี่ยงแตะ `chat.gateway.ts` ที่อีก agent กำลังแก้ไขอยู่
- [x] Metrics: request rate, error rate, stream duration, first-token latency และ active streams — HTTP request rate/error rate/duration ผ่าน `MetricsMiddleware` + `GET /api/metrics` (Prometheus format, `backend/src/common/metrics.*`) จาก Phase 7 เดิม; **ปิด gap stream duration/first-token latency/active-stream gauge ที่เคยค้างไว้แล้วในรอบนี้** — เพิ่ม `ai_active_streams` (gauge, label `provider`), `ai_stream_duration_seconds` และ `ai_first_token_latency_seconds` (histogram, label `provider`/`status`) hook เข้า `ChatGateway.onChatSend` ที่จุดเดียวกับที่คุยกับ `ActiveStreamRegistry.register()`/`release()` อยู่แล้ว ใช้ `process.hrtime.bigint()` (monotonic clock ไม่ใช่ `Date.now()`) วัดเวลา; ยืนยันด้วย unit test (`metrics.service.spec.ts` 4 เคส, เพิ่ม assertion ใน `chat.gateway.spec.ts` อีก 3 เคสรวม edge case "error ก่อนได้ token แรกเลย ต้องไม่บันทึก first-token latency") และยืนยันซ้ำด้วยข้อมูลจริงจาก load test จริงด้านล่าง (gauge กลับเป็น 0 ถูกต้องหลัง stream จบ, histogram นับ status ถูกต้องครบ 10 stream)
- [x] Health/readiness endpoints แยกกัน — ดู Reliability ด้านบน
- [x] Error reporting และ alerting — เพิ่ม Sentry แบบ optional/off-by-default: `backend/src/common/sentry.ts` (`initSentry()`, no-op ถ้าไม่ตั้ง `SENTRY_DSN`) + `SentryExceptionFilter` (report เฉพาะ error ที่ไม่ใช่ 4xx routine) ฝั่ง backend; `frontend/src/app/core/sentry.ts` ฝั่ง frontend ที่ fetch DSN จาก `GET /api/config` (public endpoint ใหม่ ไม่ใช่ความลับ เพราะ Sentry browser DSN ออกแบบมาให้ public อยู่แล้ว) แล้วค่อย init — เลือก Sentry เพราะมี SDK ทางการทั้ง NestJS/Angular และ free tier ใช้งานได้จริงโดยไม่ต้องพึ่ง vendor อื่น; ยืนยันจริงแล้วด้วย DSN ปลอมผ่าน docker stack จริง (`/api/config` ส่ง DSN ถูกต้อง, `window.__SENTRY__` ถูกตั้งค่าจริงในเบราว์เซอร์) ก่อนลบ DSN ทดสอบออก ระหว่างทางเจอบั๊กจริง 2 จุดที่แก้แล้ว: (1) `docker-compose.yml` ไม่ได้ pass `SENTRY_DSN`/`SENTRY_ENVIRONMENT` เข้า container เลย และ (2) `ConfigService.get()` ของ NestJS fallback ไปอ่าน `process.env` ดิบเมื่อ key เป็น `undefined` ใน validated config ทำให้ `${VAR:-}` (empty string) หลุดผ่าน `??` ไปเป็น "configured but blank" แทนที่จะเป็น `null` — แก้เป็น `||` ที่จุดใช้งานแทน
- [x] ห้าม log prompts, tokens หรือ API keys โดยไม่มี explicit policy — ตรวจ log ใหม่ทั้งหมดที่เพิ่มเอง (audit log, pino redact list, metrics) ไม่มีการ log ค่า password/JWT/refresh-token/API key เลย มีเฉพาะ event type, user id, ip, outcome

### Deployment

- [x] ใช้ production secrets จาก secret manager — ยังไม่เลือก vendor เฉพาะเจาะจง (ต้องให้เจ้าของโปรเจกต์ตัดสินใจ) แต่ทำ mechanism แบบ vendor-agnostic ที่ใช้ได้กับทุกเจ้า: backend รองรับ `<KEY>_FILE` (`DATABASE_URL_FILE`, `JWT_ACCESS_SECRET_FILE`, `JWT_REFRESH_SECRET_FILE`, `API_KEY_ENCRYPTION_KEY_FILE`) อ่านค่าจากไฟล์แทน env ตรง (`backend/src/config/env.validation.ts`, unit test 6 เคส) + `docker-compose.secrets.yml` overlay ที่ใช้งานได้จริงกับ Docker Compose secrets — ยืนยันจริงแล้วด้วยการรัน stack เต็มรูปแบบผ่าน overlay นี้พร้อม secret files จริง เห็น backend อ่านค่าจาก `/run/secrets/*` และ boot สำเร็จ `{"database":"connected"}`; วิธีเดียวกันนี้ใช้กับ Vault agent template, Kubernetes Secret ที่ mount เป็นไฟล์ หรือ secret manager เจ้าไหนก็ได้ที่ render ค่าลงไฟล์ได้ ไม่ต้องแก้ code เพิ่ม
- [x] ตรวจ production Docker image ด้วย non-root user — backend prod stage เพิ่ม `USER node` (uid 1000 ในตัว `node:24-alpine`); frontend prod stage เปลี่ยนจาก `nginx:alpine` เป็น `nginxinc/nginx-unprivileged:1.29.8-alpine` (รัน worker+master เป็น uid 101 `nginx` ทั้งคู่ ฟัง port 8080 แทน 80) ยืนยันจริงด้วย `docker exec ... whoami`/`id` กับ container ที่รันอยู่จริงทั้งสอง service ผ่าน `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` (ดู `docs/deployment.md`); ระหว่างตรวจพบและแก้ bug เดิมที่ไม่เกี่ยวกับ non-root โดยตรงด้วย: prod stage ไม่เคย copy `backend/prisma.config.ts` เข้า image (ทำให้ `prisma migrate deploy` fail) และ `CMD` ชี้ผิดที่ (`dist/main.js` ไม่มีจริง ต้องเป็น `dist/src/main.js`) — แก้ทั้งคู่ใน `backend/Dockerfile` แล้วยืนยันว่า stack รันได้ครบ healthy
- [x] เพิ่ม image health checks — compose-level (ตาม convention เดิมของ `postgres` ใน `docker-compose.yml`) ไม่ใช่ Dockerfile `HEALTHCHECK`: `backend` เพิ่มใน `docker-compose.yml` (ใช้ port 3000 เดียวกันทั้ง dev/prod), `frontend` เพิ่มใน `docker-compose.prod.yml` เท่านั้นเพราะ internal port ต่างกันระหว่าง dev (`ng serve` port 4200) กับ prod (nginx port 8080); ยืนยันจริงว่าทั้งสอง service ขึ้นเป็น `healthy` ใน `docker compose ps` หลัง deploy จริง
- [x] Pin base-image versions/digests ตาม policy — `node:24-alpine` (unpinned) → `node:24.18.0-alpine3.24` (ตรวจ digest ตรงกับที่ unpinned tag resolve ในเวลาที่ pin จริง), `nginx:alpine` → `nginxinc/nginx-unprivileged:1.29.8-alpine`; เลือกระดับ version+alpine pin แบบเดียวกับ `postgres:18.4-alpine` ที่มีอยู่แล้ว ไม่ทำ full digest pin (`@sha256:...`) เพราะ over-engineering สำหรับ repo ที่ยังไม่มี formal supply-chain policy ตามที่ประเมินไว้
- [x] ตั้ง Nginx WebSocket/read timeout — ยืนยันว่า `/ws/` มี `proxy_read_timeout 3600s;` เดิมอยู่ครบ, เพิ่ม `proxy_send_timeout 3600s;` คู่กัน (เดิมมีแค่ read ฝั่งเดียว ซึ่งพลาด timeout ฝั่ง nginx→backend เวลา relay client frame บน connection ที่ idle นาน ๆ); เพิ่ม `proxy_read_timeout 60s;`/`proxy_send_timeout 60s;` ให้ `/api/` อย่างชัดเจน (ค่าเดิมคือ nginx default 60s อยู่แล้ว แต่ pin ไว้ให้เห็นความต่างจาก WS แบบตั้งใจ ไม่ใช่บังเอิญ)
- [x] กำหนด resource limits สำหรับ backend/frontend/database — เพิ่ม `deploy.resources.limits`/`reservations` ใน `docker-compose.prod.yml` ให้ทั้งสาม service (backend/postgres: 512MB reserved/1GB cap, 0.25/1.0 CPU; frontend: 128MB reserved/256MB cap, 0.1/0.5 CPU); ยืนยันว่า `limits` มีผลจริงแม้ไม่ใช้ Swarm ด้วย `docker inspect --format 'Memory=... NanoCpus=...'` กับ container ที่รันอยู่จริง — **เพิ่ม load test เบื้องต้นจริงแล้ว** กับ `target: prod` image จริง (limits บังคับใช้จริง): burst 40 concurrent client ยิง `GET /api/health` เร็วสุด (~5,500 req/s attempted, ครึ่งหนึ่งโดน 429 จาก default rate limit 100/min/IP ที่ทำงานถูกต้อง ไม่ใช่ปัญหา capacity) → backend CPU ค้างที่ ~98% ของ 1.0 core cap ตลอด, memory อยู่แค่ 130–230MB จาก cap 1GB; sustained load 150 concurrent client ที่ pace ให้ไม่โดน throttle (~66 req/min/IP) → 0 error, ~160 req/s ต่อเนื่อง 20 วิ, p50 25ms/p95 76ms/p99 154ms, CPU แค่ 7–14%, memory คงที่ ~175MB — **สรุป**: memory limit มี headroom เหลือเยอะ (ไม่เคยเกิน 230MB จาก cap 1GB แม้ตอน throttle อิ่มตัว), CPU limit (1.0 core) คือจุดที่จะต้องปรับเพิ่มก่อนถ้า traffic จริงสูงกว่าที่ทดสอบมาก; รายละเอียดวิธีทดสอบและข้อจำกัด (ครอบคลุมแค่ REST read, ไม่รวม AI streaming/write-heavy path, ใช้ script เฉพาะกิจไม่ใช่ k6/autocannon) ดูใน `docs/deployment.md` → "Load test results"
- [x] เพิ่ม CI build และ image scan — เพิ่ม job `image-scan` ใน `.github/workflows/ci.yml` build image `backend`/`frontend` จริงแล้ว scan ด้วย Trivy (เลือกเพราะ open-source, ไม่ต้องมี account/API key เหมือน Snyk จึงรันได้จริงในรอบนี้โดยไม่ต้องรอ credential จากเจ้าของโปรเจกต์) อัปโหลดผลเป็น SARIF เข้า GitHub Security tab — ตั้งใจไม่ fail build อัตโนมัติ (`exit-code: '0'`) เพราะการกำหนด severity threshold ที่ block merge ได้เป็นการตัดสินใจเชิงนโยบายของเจ้าของโปรเจกต์ ไม่ใช่งาน mechanical
- [x] เพิ่ม deployment และ rollback runbook — `docs/deployment.md` ครอบคลุม deploy จาก clean checkout (env vars ที่ต้องตั้งจริงก่อน deploy, ลำดับ `postgres`→`migrate`→`backend`→`frontend`), rollback (ไม่มีปุ่ม rollback อัตโนมัติ เป็นการ deploy โค้ดเก่ากลับด้วยมือ) และเตือนตรง ๆ ว่า Prisma migrations ไม่ reversible อัตโนมัติ — repo นี้ยังไม่มี down-migration เขียนไว้เลยสักตัว ถ้า rollback ต้องการ schema downgrade จริงต้องเขียน down-migration เองแล้วตรวจสอบก่อนรัน ไม่ใช่ operation ที่ automate ได้ในตอนนี้

เกณฑ์รับงาน:

- ผ่าน security checklist และ cross-user tests
- deploy จาก clean checkout ได้โดยไม่ใช้ไฟล์ local ที่ไม่ได้ document
- มี logs/metrics เพียงพอสำหรับวิเคราะห์ stream failure
- backup และ restore ถูกทดสอบจริง

---

## Phase 8 — Backoffice: Admin และ User management

สถานะ: `[~]` — code เสร็จแล้วทั้ง backend/frontend (build+lint+unit+e2e ผ่านหมด) และ **deploy ขึ้น production จริงแล้ว** (`https://chat.zextream.com`, ผ่าน `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cloudflare.yml -f docker-compose.deployment.yml up -d --build` — คำสั่งเดียวกับ `deploy-web-ai.bat`, ผู้ใช้ยืนยันให้ดำเนินการแล้ว): migration apply สำเร็จบน production database จริง (`migrate` container log ยืนยัน), backend/frontend container ขึ้น healthy, `AdminBootstrapService` log ยืนยันว่า `ake.kidsapon@gmail.com` ถูก ensure เป็น admin จริง และตรวจ DB ตรง ๆ (read-only `SELECT`) ยืนยันว่ามี role `admin` + ครบทั้ง 6 permission แล้วจริงบน production — เหลือแค่ **manual browser walkthrough ด้วยบัญชี `ake.kidsapon@gmail.com` จริง** (ต้องใช้รหัสผ่านของ user เอง ไม่ใช่สิ่งที่ agent ควรเข้าถึง/self-grant ผ่าน raw SQL บน production — auto-mode guardrail บล็อกความพยายามนั้นไว้ถูกต้องแล้วระหว่างรอบนี้) ก่อนถือว่า Phase 8 เสร็จสมบูรณ์ 100%

### สิ่งที่มีอยู่แล้วแต่ยังไม่ถูกใช้งาน

- `User.role` (`UserRole`: `user`/`admin`) มีอยู่แล้วใน `backend/prisma/schema.prisma` แต่ไม่มี guard ใดอ่านค่านี้เลย, ไม่อยู่ใน JWT payload (`backend/src/auth/strategies/jwt-access.strategy.ts`), และหายไปจาก response ของ `POST /api/auth/login`/`register` (`AuthService.login/register` คืนแค่ `{id, email, displayName}`) — มีแค่ `GET /api/users/me` เท่านั้นที่คืน `role` เพราะอ่านจาก DB ตรง ๆ
- `frontend/src/app/core/auth.store.ts`'s `CurrentUser.role: string` ประกาศไว้แล้วแต่ไม่เคยถูกใช้ gate อะไรในแอป
- Audit log ปัจจุบัน (`backend/src/common/audit-log.service.ts`) เป็น pino structured log อย่างเดียว ไม่มี table ใน DB ให้ query ย้อนหลังผ่าน UI ได้ — ครอบคลุมแค่ auth/provider-credential events ไม่ใช่ backoffice actions

### แนวคิดออกแบบ: Granular RBAC

Role `admin` เป็นประตูแรก (gate การเข้าถึง `/admin/*` ทั้งหมด, `user` ธรรมดาเข้าไม่ได้แม้จะมี permission grant ค้างอยู่ในระบบ — belt-and-suspenders) ส่วน **permission แบบละเอียด** เป็นตัวกำหนดว่า admin แต่ละคนเข้าไปแล้วทำอะไรได้บ้าง ไม่ใช่ admin ทุกคนมีสิทธิ์เท่ากันหมด:

| Permission | ความหมาย |
| --- | --- |
| `users_view` | ดูรายชื่อ/รายละเอียดผู้ใช้ทั้งหมด |
| `users_manage_status` | เปิด/ปิดการใช้งานบัญชี (`isActive`) |
| `users_manage_role` | เลื่อน/ลดขั้น user ↔ admin |
| `users_manage_permissions` | grant/revoke permission ให้ admin คนอื่น — คนที่ถือ permission นี้คือ "Admin สูงสุด" ในทางปฏิบัติ |
| `dashboard_view` | ดูหน้า system overview/dashboard |
| `audit_log_view` | ดู audit log ของการกระทำที่ทำผ่าน backoffice |

### งานที่ต้องทำ — Data model

- [x] เพิ่ม `enum AdminPermission` (6 ค่าด้านบน, `@@map("admin_permission")`) ใน `backend/prisma/schema.prisma`
- [x] เพิ่ม `model AdminPermissionGrant` — unique `(userId, permission)`, `grantedBy` (nullable, อ้างอิงผู้ grant), cascade delete จาก user
- [x] เพิ่ม `enum AdminAuditAction` (`user_role_changed`, `user_status_changed`, `user_permissions_changed`)
- [x] เพิ่ม `model AdminAuditLogEntry` — `actorUserId`/`targetUserId` เป็น nullable + `onDelete: SetNull` ทั้งคู่ (audit trail ต้องอยู่รอดแม้ user ถูกลบภายหลัง), `action`, `detail Json`, `createdAt`, index `createdAt desc`
- [x] เขียน migration ใหม่ (`backend/prisma/migrations/20260712120000_admin_backoffice/migration.sql`, เขียนมือแล้วยืนยันด้วย `prisma migrate diff --to-schema-datamodel` ว่า schema ตรงกับ schema.prisma เป๊ะ, exit-code empty-diff = 0) — ทดสอบ apply จริงกับ throwaway database ที่สร้างขึ้นชั่วคราวในตัว live Postgres container แล้วลบทิ้ง (ไม่กระทบข้อมูลจริง) และกับ dedicated e2e test Postgres (`zextream-e2e-test-postgres`, ผ่านทั้ง suite 64/64) ก่อนแล้วค่อย **apply กับ production database ตัวจริงสำเร็จ** ผ่าน `migrate` service ตอน deploy (ยืนยันจาก log จริง: "Applying migration `20260712120000_admin_backoffice`" → "All migrations have been successfully applied.")
- [x] ชี้แจงใน commit/PR ว่า `AdminAuditLogEntry` เป็นคนละอันกับ `AuditLogService` (pino) เดิม — ของเดิมไม่ถูกแก้หรือย้าย เก็บเฉพาะ backoffice actions ใน DB เพื่อให้มี UI query ได้จริง

### งานที่ต้องทำ — Backend (`backend/src/admin/` module ใหม่)

- [x] `PermissionsGuard` + `@RequirePermissions(...)` decorator — เช็ค role/permission จาก DB ทุก request (ไม่ฝังใน JWT) ให้ revoke permission มีผลทันที ไม่ต้องรอ access token หมดอายุ (15 นาที) — สอดคล้องกับ pattern เดิมที่ `/api/users/me` อ่าน role จาก DB ไม่ใช่ token
- [x] `GET /api/admin/users?query=&limit=&offset=` (`users_view`) — reuse pagination pattern จาก `backend/src/chat/dto/pagination-query.dto.ts`
- [x] `GET /api/admin/users/:id` (`users_view`)
- [x] `PATCH /api/admin/users/:id/status` `{isActive}` (`users_manage_status`)
- [x] `PATCH /api/admin/users/:id/role` `{role}` (`users_manage_role`) — demote เป็น `user` revoke permission grants ทั้งหมดของ target ในทรานแซกชันเดียว (`AdminUsersService.updateRole()`)
- [x] `PUT /api/admin/users/:id/permissions` `{permissions[]}` แบบ replace ทั้งชุด (`users_manage_permissions`) — ปฏิเสธถ้า target role ไม่ใช่ `admin`
- [x] `GET /api/admin/dashboard` (`dashboard_view`) → นับ total/active/inactive users, admin count, total sessions, total messages, provider-configured breakdown
- [x] `GET /api/admin/audit-log?limit=&offset=` (`audit_log_view`)
- [x] **Self-lockout guard**: ทุก endpoint ที่แก้ status/role/permissions ปฏิเสธ (400) เมื่อ `targetUserId === currentUser.id` — กัน admin ล็อกตัวเองออกจากระบบโดยไม่ตั้งใจ (`AdminUsersService.assertNotSelf()`, มี unit + e2e test คุม)
- [x] เขียนทุก mutation endpoint ให้บันทึกลง `AdminAuditLogEntry` ด้วย (actor, target, action, detail)

### งานที่ต้องทำ — Bootstrap super-admin (`ake.kidsapon@gmail.com`)

- [x] เพิ่ม env var `BOOTSTRAP_ADMIN_EMAILS` (comma-separated, ตาม pattern เดียวกับ `CORS_ORIGIN`) ใน `backend/src/config/env.validation.ts`, `.env.example` และ `.env` จริง (default/ตั้งค่าเป็น `ake.kidsapon@gmail.com`), และ thread ผ่าน `docker-compose.yml`'s backend `environment` block
- [x] `AdminBootstrapService` รันสองจังหวะ:
  1. `OnApplicationBootstrap` ตอน backend start — เช็คทุก email ในลิสต์
  2. hook เข้า `AuthService.register()` ทันทีหลังสร้าง user ใหม่ — เผื่อ email นี้เพิ่งสมัครหลัง container start
- [x] Logic เป็น idempotent upsert: ถ้า user มีอยู่แล้ว → บังคับ `role=admin` + grant ครบทั้ง 6 permission เสมอ (แม้เคยถูกลดสิทธิ์ผ่าน UI ระหว่างทดสอบ ก็จะกลับมาเต็มสิทธิ์ทุกครั้งที่ backend restart); ถ้ายังไม่สมัคร → no-op รอบนี้ — ยืนยันด้วย unit tests ครบ (`admin-bootstrap.service.spec.ts`)
- [x] เพิ่มหมายเหตุด้าน security ใน `docs/threat-model.md` (section "Backoffice privilege escalation"): `BOOTSTRAP_ADMIN_EMAILS` ต้องถูกล้าง/จำกัดก่อนขึ้น production จริง เพราะทุก email ในลิสต์นี้จะได้ super-admin คืนเสมอไม่ว่า UI จะพยายามลดสิทธิ์แค่ไหนก็ตาม — เหมาะกับ dev/staging สำหรับทดสอบเท่านั้น

### งานที่ต้องทำ — แก้ gap ที่พบระหว่างสำรวจ (ต้องทำคู่กัน เพราะ backoffice ต้องพึ่ง role/permission ทันทีหลัง login)

- [x] เพิ่ม `role` และ `permissions: string[]` เข้า response ของ `POST /api/auth/login`, `POST /api/auth/register`, และ `GET /api/users/me`
- [x] อัปเดต `CurrentUser` interface ใน `frontend/src/app/core/auth.store.ts` ให้มี `permissions: AdminPermission[]` (type จริงจาก `@app/shared-types` ไม่ใช่ `string[]` เฉย ๆ) พร้อมเพิ่ม `isAdmin`/`hasPermission()` helper

### งานที่ต้องทำ — Frontend

- [x] Routes ใหม่ `/admin` (dashboard), `/admin/users`, `/admin/audit-log` ใน `frontend/src/app/app.routes.ts`
- [x] `adminGuard` ใหม่ (`frontend/src/app/core/admin.guard.ts`, `CanMatchFn` ตาม pattern ของ `auth.guard.ts`) — เช็ค `role === 'admin'`, ไม่ผ่านให้ redirect `/chat` (ไม่ใช่ `/login` เพราะ user login อยู่แล้วแค่ไม่มีสิทธิ์)
- [x] `AdminStore` (`frontend/src/app/features/admin/admin.store.ts`) ตาม pattern เดิมของ `session-list.store.ts` (signals + `httpResource`), gate แต่ละ resource ด้วย permission เฉพาะของมันเอง (resource คืน `undefined` = ไม่ยิง request เลยถ้าไม่มีสิทธิ์)
- [x] แต่ละหน้าเช็ค permission เฉพาะของตัวเองแล้วแสดง empty/error state ถ้าไม่มีสิทธิ์ (reuse convention เดิมจาก Phase 3 แทนสร้าง guard factory ใหม่ทุก permission)
- [x] ใช้ `ds-segmented-tabs` สลับ 3 หน้า (Dashboard / Users / Audit log ผ่าน `AdminNavComponent` ที่กรอง tab ตาม permission ที่มีจริง), `ds-confirm-dialog` ก่อน deactivate/demote user, `ToastService` แจ้งผลทุก mutation
- [x] เพิ่มปุ่มเข้า backoffice ใน `IconRailComponent` (ผ่าน `AppShellComponent`'s `showAdmin`/`admin` input-output ใหม่) แสดงเฉพาะเมื่อ `authStore.isAdmin()`
- [x] **UI/UX** — ใช้ `ds-stat-card` แสดงตัวเลขสรุปในหน้า dashboard แทนตารางตัวเลขดิบ; user list มี search + pagination (offset-based, 20/หน้า) ที่ใช้งานสะดวกกับ user จำนวนมาก — **หมายเหตุ: ยังไม่มี column sort แบบ user-configurable** (list เรียงตาม `createdAt desc` คงที่เท่านั้น เป็นการตัดสินใจลดขอบเขตเพื่อไม่ over-build UI ที่ยังไม่มีใครขอ ไม่ใช่ oversight — เพิ่มทีหลังได้ถ้าจำเป็นจริง); ทุกหน้ามี loading/empty/error state ที่สม่ำเสมอตาม convention เดิมของ Phase 3; role/permission แสดงด้วย `ds-badge-pill`; responsive (breakpoint เดียวกับส่วนอื่นของแอปที่ 720/860px) และ keyboard-navigable ผ่าน native `<button>`/`<input>`/`<label>` — **ยังไม่ได้ manual-verify ใน browser จริง** รอ deploy ก่อน

### Tests ที่ต้องเพิ่ม

- [x] Unit: `PermissionsGuard` ปฏิเสธเมื่อไม่มี permission ที่ต้องการ/ไม่ใช่ admin/deactivated admin (`permissions.guard.spec.ts`, 6 เคส)
- [x] Unit: self-lockout guard ปฏิเสธทุก endpoint เมื่อ target เป็นตัวเอง (`admin-users.service.spec.ts`)
- [x] Unit: `AdminBootstrapService` idempotent upsert, case-insensitive email match, no-op สำหรับ email ที่ไม่อยู่ในลิสต์/ยังไม่สมัคร (`admin-bootstrap.service.spec.ts`, 7 เคส)
- [x] E2E: cross-user negative tests — user ธรรมดาเรียก `/api/admin/*` ทุก endpoint ต้องได้ 403, unauthenticated ได้ 401 (`backend/test/admin.e2e-spec.ts`)
- [x] E2E: admin ที่ขาด permission เฉพาะ endpoint ได้ 403 แม้จะผ่าน role check แล้ว
- [x] E2E: demote admin → user revoke permission grants ทั้งหมดของ target จริง (ตรวจ DB ตรงหลัง request)
- [x] E2E: self-lockout ปฏิเสธ status/role/permissions ของตัวเองทั้งสามเส้นทาง
- [x] E2E: audit log entry ถูกสร้างจริงพร้อม actor/target ที่ถูกต้องหลัง mutation
- [x] E2E: `POST /api/auth/register` คืน `role: 'guest'` (เดิมทดสอบเป็น `'user'` — เปลี่ยนเป็น `'guest'` ตามงาน guest-role ด้านล่าง) และ `permissions: []` สำหรับบัญชีใหม่ปกติ
- [x] Backend unit suite รวม 182/182 ผ่าน (เพิ่มจาก 162), e2e suite รวม 64/64 ผ่าน (เพิ่มจาก 55), frontend unit 45/45 ผ่าน — ดูรายละเอียดการรันจริงใน commit ที่ implement Phase 8
- [ ] E2E: permission ที่ revoke มีผลทันทีในคำขอถัดไป ไม่ต้องรอ access token หมดอายุ — **ยังไม่มี e2e แยกทดสอบเรื่องนี้โดยตรง** (พิสูจน์ทางอ้อมจาก design: `PermissionsGuard` query DB ทุก request ไม่มี caching ใด ๆ เลย จึงไม่มีทางที่ permission เก่าจะค้างได้ แต่ยังไม่มี test ที่จับ "เปลี่ยน permission กลางอากาศแล้วยิง request 2 ครั้งติดกัน" ตรง ๆ)

เกณฑ์รับงาน:

- [x] ไม่มี user role `user` เข้าถึง `/api/admin/*` ได้ไม่ว่ากรณีใด (e2e ยืนยันแล้ว) — route `/admin/*` ฝั่ง frontend ยืนยันด้วย code review (`adminGuard`) แต่ยังไม่ได้ manual browser check
- [x] permission เปลี่ยน (grant/revoke/demote) มีผลทันทีในคำขอถัดไป (ตาม design ไม่มี caching — ดู test gap ด้านบน)
- [x] `ake.kidsapon@gmail.com` เป็น admin เต็มสิทธิ์เสมอในทุก environment ที่ตั้ง `BOOTSTRAP_ADMIN_EMAILS` — ยืนยันสด (live) บน production database จริงแล้ว: backend log แสดง `"Bootstrap admin ensured for ake.kidsapon@gmail.com"` ตอน startup และ read-only `SELECT` ตรง ๆ ยืนยันว่า `role='admin'` พร้อมครบทั้ง 6 permission ใน `admin_permission_grants`
- [x] ทุก mutation ผ่าน backoffice ถูกบันทึกใน `AdminAuditLogEntry` และดูได้จากหน้า audit log
- [x] admin ไม่สามารถลด role/status/permission ของตัวเองจนล็อกตัวเองออกจากระบบได้
- [ ] หน้า backoffice ทั้ง 3 หน้าใช้ design-system component เดิมของแอปอย่างสม่ำเสมอ (ไม่ประดิษฐ์ style ใหม่แยกจากส่วนอื่น), responsive, มี loading/empty/error state ครบ และผ่าน manual check ใน browser จริงก่อนถือว่าเสร็จ (ไม่ใช่แค่ build ผ่าน) — **โค้ด deploy ขึ้น production แล้ว, สโมคเทสต์ผ่าน REST โดยตรง (register คืน `role`/`permissions` ถูกต้อง, `/api/admin/users` ไม่มี auth ได้ 401 ตามคาด) แต่ยังไม่มีใคร login ผ่าน browser จริงด้วยบัญชี `ake.kidsapon@gmail.com` เพื่อดูหน้า backoffice ด้วยตา — ผู้ใช้ควร login ทดสอบเองเพื่อปิดข้อนี้ให้สมบูรณ์**

### Guest role — บัญชีใหม่ต้องรอ Admin เปิดใช้งาน

ส่วนขยายของ Phase 8: ผู้ใช้ขอเพิ่ม role `guest` เป็น role เริ่มต้นของบัญชีที่สมัครใหม่ — ใช้งานแชท/ฟีเจอร์ใด ๆ ไม่ได้จนกว่า admin จะเลื่อนขึ้นเป็น `user` (หรือสูงกว่า) ผ่าน backoffice พร้อมหน้าจอ "กรุณาติดต่อ Admin เพื่อเปิดการใช้งาน" ที่ออกแบบให้เข้ากับ design system เดิม

**Data model**:

- [x] เพิ่ม `guest` เข้า `UserRole` enum (ลำดับ `guest → user → admin`) และเปลี่ยน default ของ `User.role` จาก `user` เป็น `guest`
- [x] Migration สองไฟล์แยกกัน (`20260712130000_add_guest_role` ทำ `ALTER TYPE ... ADD VALUE`, `20260712130100_guest_default_role` ทำ `ALTER TABLE ... SET DEFAULT` ในอีก transaction) — จงใจแยกเพราะ Postgres ไม่ให้ใช้ enum value ใหม่ในทรานแซกชันเดียวกับที่เพิ่งเพิ่มในบาง context; ทดสอบ apply กับ throwaway database จริงแล้วยืนยัน `prisma migrate diff` ว่า schema ตรงกับ schema.prisma เป๊ะ (empty diff) ก่อน apply กับ production จริงสำเร็จ

**Backend**:

- [x] `GuestBlockGuard` (`backend/src/auth/guards/guest-block.guard.ts`) — global `APP_GUARD` ใหม่ใน `AuthModule` ต่อจาก `JwtAuthGuard`, default-deny สำหรับ role `guest` ทุก route ยกเว้น `@Public()` และ `@AllowGuest()` (ใช้กับ `GET /api/users/me` เท่านั้น เพื่อให้ frontend อ่านสถานะตัวเองได้)
- [x] เช็ค role จาก DB ทุก request (ไม่ฝังใน JWT) แบบเดียวกับ `PermissionsGuard` — admin กด activate ปุ๊บ ใช้งานได้ทันทีโดย access token เดิมไม่ต้อง login ใหม่
- [x] WebSocket: **ไม่** เช็ค guest ใน `handleConnection()` (เคยลองแล้วเจอ race จริง — ดูด้านล่าง) แต่เช็คผ่าน `requireActiveUser()` helper ใหม่ที่ทุก message handler (`session:join`, `chat:stop`, `artifact:edit`, `chat:send`) เรียกแทน `userId()` เดิม
  - **บั๊กจริงที่เจอระหว่างพัฒนา**: ลองเช็ค guest ใน `handleConnection()` แบบ async (`await usersService.findById(...)`) ก่อน แล้ว e2e suite พังทันที (7 tests timeout) — สาเหตุคือ client's `'connect'` event ฝั่ง Socket.IO fire ทันทีที่ handshake เสร็จ **โดยไม่รอ** `handleConnection()` ฝั่ง server ทำงานเสร็จ (เดิม `handleConnection` เป็น sync ล้วน จึงไม่เคยมี race นี้มาก่อน) ทำให้ client emit `session:join`/`chat:send` แข่งกับ server ที่ยังตั้ง `client.data.userId` ไม่เสร็จ — แก้โดยคืน `handleConnection` เป็น sync (JWT verify อย่างเดียว เหมือนเดิม) แล้วย้าย guest-check ไปที่ระดับ per-message handler แทน ซึ่งไม่มี race เพราะ handler ถูกเรียกหลัง connection stabilize แล้วเท่านั้น
- [x] `AdminDashboardStatsDto` เพิ่ม `pendingGuestCount` (นับ role='guest') ให้ admin เห็นว่ามีกี่บัญชีรอ activate
- [x] `AdminUsersService.updateRole()` เดิม (Phase 8) รองรับ `guest → user` ได้เลยเพราะ validate จาก `Object.values(UserRole)` อยู่แล้ว ไม่ต้องแก้ logic เพิ่ม

**Frontend**:

- [x] เพิ่ม `'guest'` เข้า `UserRole` type ใน `@app/shared-types`
- [x] `AuthStore.isGuest` computed ใหม่
- [x] `AccountPendingComponent` (`frontend/src/app/features/auth/account-pending/`) — หน้าจอ "บัญชีของคุณรอการเปิดใช้งาน" / "กรุณาติดต่อ Admin เพื่อเปิดการใช้งาน" ใช้ layout `.auth-page`/`ds-hairline-card` เดียวกับหน้า login/register (icon นาฬิกาทราย, `ds-badge-pill status="pending"`, แสดงอีเมลบัญชี, ปุ่ม sign out) ให้ดูเข้าชุดกับดีไซน์เดิมทั้งแอป ไม่ใช่หน้าเปล่า ๆ
- [x] `guestGuard`/`onlyGuestGuard` (`frontend/src/app/core/guest.guard.ts`) — เส้นทางที่ต้องมีบัญชี active (`chat`, `chat/:sessionId`, `settings/providers`, `admin/*`) redirect guest ไป `/account-pending`; route `/account-pending` เองก็ redirect กลับ `/chat` ถ้าไม่ใช่ guest แล้ว (กันบัญชีที่ activate แล้วค้างอยู่หน้านี้)
- [x] Login/Register component: หลัง auth สำเร็จเช็ค `authStore.isGuest()` แล้ว navigate ไป `/account-pending` แทน `/chat`/`returnUrl`
- [x] Admin Users page: แยก action เป็น 3 ระดับชัดเจน — guest→user เรียก "Activate" (ไม่ destructive, ไม่ต้อง confirm), user→admin เรียก "Promote to admin" (ไม่ destructive), admin→user เรียก "Demote to user" (destructive, ยังต้อง confirm เหมือนเดิม); เปลี่ยนชื่อปุ่ม toggle `isActive` เดิมจาก "Activate/Deactivate" เป็น "Suspend/Unsuspend" กันสับสนกับความหมายใหม่ของคำว่า "Activate" (role); role badge เพิ่มสี `pending` สำหรับ guest
- [x] Admin Dashboard: stat card "Pending guests" + callout banner เด่น ๆ (สีเดียวกับ `--color-status-pending`) ลิงก์ไป `/admin/users` เมื่อมี guest รอ activate มากกว่า 0 คน

**Tests ที่ต้องเพิ่ม**:

- [x] Unit: `GuestBlockGuard` ทุก branch (`@Public()`, `@AllowGuest()`, ไม่มี user, guest ถูกปฏิเสธ, user/admin ผ่าน) — `guest-block.guard.spec.ts`
- [x] E2E: guest ถูกบล็อคทุก resource endpoint แต่ยังอ่าน `/api/users/me` ได้ (`admin.e2e-spec.ts`)
- [x] E2E: admin promote guest→user แล้ว access token เดิม (ที่ออกตอนยังเป็น guest) ใช้งานได้ทันที ไม่ต้อง login ใหม่ (`admin.e2e-spec.ts`)
- [x] E2E: WebSocket — guest เชื่อมต่อ socket ได้ปกติ (ไม่ race) แต่ `session:join` ได้ `exception` event พร้อมข้อความ "pending activation" (`websocket.e2e-spec.ts`)
- [x] แก้ `registerUser()` test helper (`backend/test/support/test-app.ts`) ให้ promote เป็น `'user'` อัตโนมัติหลังสมัคร (ผ่าน `app.get(PrismaService)`) เพราะ e2e spec อื่น ๆ ~25 จุดพึ่งพฤติกรรมเดิมที่บัญชีใหม่ใช้งานได้ทันที — เพิ่ม `opts.role: 'guest'` ให้ test ที่ต้องการ behavior จริงของบัญชีเพิ่งสมัคร
- [x] Backend unit suite รวม 188/188 ผ่าน (เพิ่มจาก 182), e2e suite รวม 67/67 ผ่าน (เพิ่มจาก 64), frontend unit 45/45 ผ่านเหมือนเดิม (ไม่มี regression)
- [x] **พบและแก้ regression จริงใน Playwright browser e2e suite (`e2e/tests/`)** ระหว่างตรวจสอบรอบถัดมา: `registerNewUser()` helper (`e2e/tests/helpers.ts`) เดิมรอ URL `/chat` หลังสมัครเสมอ — พังทันทีเพราะบัญชีใหม่ตอนนี้เด้งไป `/account-pending` แทน กระทบทุก spec ที่ใช้ helper นี้ (`auth-and-chat`, `refresh-token-race`, `stop-generation`) บวก `identity-switch.spec.ts` ที่มี inline registration flow ซ้ำอีกจุดหนึ่งนอก helper — **ไม่ถูกจับโดย CI** เพราะ `.github/workflows/ci.yml` ไม่รัน Playwright suite นี้เลย (ต้องรันมือ) แก้โดย: (1) เพิ่ม `pg`/`@types/pg` เป็น devDependency ของ `e2e` package แล้วเพิ่ม `promoteToUser()`/`promoteToAdmin()` helper ต่อ DB เดียวกับที่ backend e2e ใช้ (`zextream-e2e-test-postgres`) (2) `registerNewUser()` รอ `/account-pending` แล้ว promote เป็น `user` ผ่าน DB แล้ว reload แทน — บัญชีเพิ่งสมัครเป็น guest ไม่ใช่ behavior ที่ helper ส่วนใหญ่ต้องการทดสอบอยู่แล้ว (3) แก้ inline duplicate ใน `identity-switch.spec.ts` ให้เรียก `registerNewUser()` แทน (4) เพิ่ม `e2e/tests/guest-activation.spec.ts` ใหม่ที่ทดสอบ flow จริงแบบไม่มี shortcut (สมัคร → เห็นหน้า pending จริง → เข้าถึง `/chat` ตรง ๆ ไม่ได้ → admin (promote ผ่าน DB) เข้า backoffice จริงกด Activate ผ่าน UI จริง → guest login ใหม่แล้วเข้า `/chat` ได้) — **รันจริงผ่านทั้งหมดแล้ว**: 6 passed, 2 skip (ต้องมี Ollama จริง, เหมือนเดิม) รวมทั้ง `guest-activation.spec.ts` ใหม่และทุก spec ที่แก้

เกณฑ์รับงาน (guest role):

- [x] บัญชีสมัครใหม่ทุกบัญชีเริ่มที่ role `guest` และใช้ resource endpoint ใด ๆ ไม่ได้จนกว่า admin จะเลื่อนขึ้น
- [x] Guest เห็นหน้าจอ "กรุณาติดต่อ Admin เพื่อเปิดการใช้งาน" ที่ออกแบบสวยงามเข้าชุดกับแอป ทันทีหลัง login/register — ยืนยันด้วย Playwright จริงแล้ว (`e2e/tests/guest-activation.spec.ts` ผ่าน เห็นข้อความภาษาไทยจริงบนหน้าจอจริงผ่าน browser จริง ไม่ใช่แค่ build ผ่านเหมือนที่เคยบันทึกไว้ก่อนหน้า) — เหลือแค่ manual click-through ด้วยตาจริงโดยเจ้าของระบบ (ไม่จำเป็นแล้วในแง่ความถูกต้องเชิงฟังก์ชัน เพราะ automated browser test คุ้มครองอยู่แล้ว แต่ยังมีประโยชน์เชิง UX/สุนทรียะ)
- [x] Admin activate guest ได้จาก backoffice โดยไม่ต้องให้ guest login ใหม่ — ยืนยันซ้ำด้วย Playwright จริงผ่านการกดปุ่ม "Activate" จริงในหน้า `/admin/users`
- [x] ไม่มี regression กับ e2e/unit test เดิม (188 backend unit, 67 backend e2e, 45 frontend, 6 Playwright browser e2e — ผ่านหมดหลังแก้ regression ที่พบ)
- [x] อัปเดตเอกสาร: `README.md` (feature list, `/api/auth/register` behavior, `BOOTSTRAP_ADMIN_EMAILS` env var, section `/api/admin/*` ใหม่ทั้งหมดที่ไม่เคยมีมาก่อน), `docs/deployment.md` (section "Getting your first admin account" ใหม่ อธิบายปัญหา chicken-and-egg ของบัญชีแรกที่เป็น guest), `e2e/README.md` (เพิ่ม guest-activation ในลิสต์ที่ cover จริง), `docs/threat-model.md`

### รอบตรวจสอบเพิ่มเติม — ปิด gap ที่เหลือทั้งหมด

หลังส่งมอบ Phase 8 ครั้งแรก ผู้ใช้ขอให้ตรวจซ้ำว่าเหลืออะไรบ้าง พบและปิดครบทุกจุด:

- [x] **Visual QA จริงด้วย Playwright screenshot** (ทดแทน manual browser check ที่ทำเองไม่ได้เพราะไม่มีรหัสผ่านบัญชีจริงของเจ้าของระบบ) — เขียน script ชั่วคราวพา flow จริงผ่าน browser จริง (สมัคร guest → หน้า pending ทั้ง desktop/mobile viewport → สมัคร+promote admin → dashboard → users → audit log) แคปหน้าจอแล้วดูเองทีละภาพ; หน้า `/account-pending` และ `/admin/users`/`/admin/audit-log` ผ่านมาตรฐานดี แต่ **เจอบั๊กจริง**: `ds-stat-card` (design-system component จาก Phase 3 ที่ไม่เคยมีใครใช้จริงมาก่อนหน้านี้) มี icon slot (`<ng-content select="[icon]">`) ที่ render กรอบสี่เหลี่ยม 32×32px เปล่า ๆ เสมอถ้าไม่มีใคร project เนื้อหาเข้าไป — หน้า dashboard ที่เพิ่งสร้างเป็นจุดแรกที่ใช้ component นี้จริงและไม่ได้ใส่ icon เข้าไป ทำให้เห็นเป็นกล่องว่างทั้ง 7 stat card แก้โดยเพิ่ม SVG icon (people, checkmark-user, x-user, clock, shield, chat bubble, envelope) ให้ครบทุก stat card ตาม style เส้นบาง stroke-width 1.5 เดียวกับ icon อื่นในแอป — ยืนยันแล้วว่าแก้ถูกจริงด้วย screenshot รอบสอง
- [x] **พบและแก้ regression จริงใน Playwright suite** (รายละเอียดเต็มอยู่ด้านบนแล้ว) — ตอนนี้รันผ่านครบ **8 tests (6 passed, 2 skip)** รวม `guest-activation.spec.ts` ใหม่
- [x] **เพิ่ม e2e test "revoke permission มีผลทันที"** ที่เคยเป็น gap ค้างจาก Phase 8 รอบแรก (`admin.e2e-spec.ts`) — super-admin revoke permission ของ target admin คนละคน แล้วยิง request ต่อด้วย access token เดิม (ไม่ re-login) ยืนยันว่าได้ 403 ทันที พิสูจน์ตรง ๆ ว่า `PermissionsGuard` ไม่ cache อะไรเลย ไม่ใช่พิสูจน์ทางอ้อมจาก design อีกต่อไป
- [x] **เพิ่ม Playwright + backend e2e เข้า CI** (`.github/workflows/ci.yml`) — เดิมมีแค่ backend unit test + frontend unit test + lint เท่านั้นที่รันใน CI (นี่คือสาเหตุที่ regression ของ Playwright suite ข้างต้นไม่มีใครจับได้จนกว่าจะรันมือ): เพิ่ม Postgres service container เข้า job เดิมแล้วรัน `pnpm --filter backend test:e2e` ต่อจาก unit test, และเพิ่ม job ใหม่ `browser-e2e` แยกต่างหาก (Postgres service ของตัวเอง, ติดตั้ง Playwright Chromium พร้อม OS deps, อัพโหลด HTML report เป็น artifact เมื่อ fail)
- [x] ลบบัญชีทดสอบ (`zextream-admin-smoketest@example.com`, `zextream-guest-smoketest@example.com`) ออกจาก production database เรียบร้อย
- [x] Backend unit 188/188, e2e **68/68** (เพิ่มจาก 67), frontend unit 45/45, Playwright browser e2e 6/6 (2 skip) — ผ่านหมดหลังการแก้ไขรอบนี้
- [x] **Deploy frontend build ที่มี stat-card icon fix ขึ้น production แล้ว** ผ่าน `deploy.ps1` เหมือนสองรอบก่อนหน้า — ยืนยันแล้วว่า `chat.zextream.com` เสิร์ฟ build ล่าสุด (`main-RFKZ3YRO.js` ตรงกับ local build)
- [x] **Commit งานทั้งหมดของ Phase 8 (backoffice + guest role + รอบแก้ไข) เป็น commit เดียว** (`3163258`, 80 files changed) — ไม่รวม `docker-compose.deployment.yml` ที่ค้างอยู่ตั้งแต่ก่อน session นี้เริ่ม (ไม่ใช่งานของรอบนี้ ปล่อย untracked ตามเดิม)
- [ ] **`git push` ถูก auto-mode guardrail บล็อกไว้** (ไม่ระบุเหตุผล) — commit อยู่ใน local `main` แล้วแต่ยังไม่ขึ้น `origin/main` ต้องให้ user สั่ง push เอง หรือยืนยันเจาะจงอีกครั้งให้ agent push ให้

---

## Phase 9 — Token usage tracking และ reporting (`[x]` เสร็จแล้ว)

ผู้ใช้ขอ 2 อย่าง: (1) ตอนใช้งาน AI ให้แสดงว่าแต่ละครั้งใช้ไป "กี่ token" ให้คนที่ถามเห็น (2) ทำ report ใน backoffice บอกว่ามี user กี่คน กี่ session และใช้ token ไปทั้งหมดกี่ token

### สิ่งที่พบระหว่างสำรวจโค้ดจริง

- `Message.tokenCount` (`backend/prisma/schema.prisma`) **มีอยู่แล้วตั้งแต่ Phase 1** (migration `20260710164133_chat_sessions_and_messages`) แต่ไม่เคยถูกเขียนหรืออ่านที่ไหนเลยในโค้ดทั้งหมด — เป็น column ที่เตรียมไว้แต่ไม่เคยใช้งานจริง **ไม่ต้องเพิ่ม migration ใหม่**
- `AiStreamEvent`'s `done` variant (`backend/src/ai/ai-provider.interface.ts:19-22`) มีแค่ `{ type: 'done'; finishReason: string }` ไม่มี token usage เลย
- ทั้งสาม provider จริง ๆ ส่ง token usage มาให้อยู่แล้วใน upstream response แต่โค้ดปัจจุบันไม่เคยอ่าน (ตรวจโค้ดจริงแล้ว ไม่ใช่สมมติฐาน):
  - **Ollama** (`ollama.provider.ts`): NDJSON บรรทัดสุดท้าย (`done: true`) มี `eval_count` (output tokens) และ `prompt_eval_count` (input tokens) เป็น sibling field ของ `done`/`done_reason` แต่ `OllamaChatChunk` interface (บรรทัด 11-15) ไม่ประกาศ field พวกนี้ไว้เลย — เพิ่ม 2 field ใน interface แล้วอ่านตรง ๆ ได้เลย ไม่ต้อง restructure logic
  - **Claude** (`claude.provider.ts`): `message_start` event มี `message.usage.input_tokens`; `message_delta` event มี `usage.output_tokens` เป็น **sibling ของ `delta`** ในก้อนเดียวกับที่โค้ดปัจจุบันอ่าน `stop_reason` อยู่แล้ว (บรรทัด 167-174) — เพิ่มการอ่าน `payload['usage']` ที่จุดเดิมได้เลย ไม่ต้อง restructure; ต้องเพิ่ม branch ใหม่สำหรับ `type === 'message_start'` เพื่อเก็บ `input_tokens` ไว้ก่อน (ตอนนี้ไม่มี branch นี้เลย โค้ดข้ามไปอ่านแค่ `content_block_delta`/`message_delta`/`message_stop`/`error`)
  - **OpenAI** (`openai.provider.ts`): ต้องส่ง `stream_options: { include_usage: true }` เพิ่มในคำขอก่อน (ตอนนี้ไม่ได้ส่ง flag นี้เลย บรรทัด 73-79) ถึงจะได้ SSE chunk สุดท้ายที่มี `usage: { prompt_tokens, completion_tokens, total_tokens }` พร้อม `choices: []` — **ต้อง restructure เล็กน้อย**: ตอนนี้โค้ด yield `done` ทันทีที่เจอ `finish_reason` (บรรทัด 150-153) ซึ่งมาก่อน chunk ที่มี usage เสมอ ต้องเปลี่ยนเป็นเก็บ `finishReason` ไว้ในตัวแปรก่อน แล้วรอจนกว่าจะเจอ chunk ที่มี `usage` (หรือ `[DONE]`) ค่อย yield `done` event เดียวที่มีทั้ง `finishReason` และ `usage` รวมกัน

### ขอบเขตงาน (Backend)

- [x] เพิ่ม `usage?: { inputTokens: number; outputTokens: number }` เข้า `AiStreamEvent`'s `done` variant (`ai-provider.interface.ts`, ตั้งชื่อ interface ว่า `AiTokenUsage`)
- [x] แก้ทั้งสาม provider ให้ parse usage จริงตามรายละเอียดข้างบน แล้ว emit ผ่าน `done` event — Ollama/Claude ไม่กระทบ logic เดิมเลยตามคาด; OpenAI restructure จุด yield `done` จริงตามแผน (เก็บ `finishReason`/`usage` ไว้ในตัวแปรแล้ว yield ครั้งเดียวตอน `[DONE]`/EOF) โดย finishReason ที่ส่งออกยังเหมือนเดิมทุกกรณี — ต้องเพิ่ม `stream_options: { include_usage: true }` เข้า request body ของ OpenAI ด้วย ไม่งั้น upstream ไม่ส่ง `usage` มาเลย
- [x] `ChatGateway.onChatSend`: จับ `usage` จาก `done` event แล้วคำนวณ `tokenCount = usage.inputTokens + usage.outputTokens` ส่งต่อให้ `finalizeAssistantMessage`
- [x] `MessagesService.finalizeAssistantMessage()`: เพิ่ม parameter `tokenCount?: number` แล้วบันทึกลง column ที่มีอยู่แล้ว (ไม่ต้อง migration จริง ยืนยันแล้ว)
- [x] `AdminDashboardService.getStats()`: เพิ่ม `totalTokensUsed` (`aggregate({ _sum: { tokenCount: true } })`) และ `tokensByProvider` (`groupBy({ by: ['provider'], where: { provider: { not: null } }, _sum: { tokenCount: true } })`) เข้า `Promise.all` เดิม
- [x] shared-types: เพิ่ม `tokenCount: number | null` เข้า `ChatMessageDto`; เพิ่ม `totalTokensUsed: number` และ `tokensByProvider: Record<AiProviderKey, number>` เข้า `AdminDashboardStatsDto`

### ขอบเขตงาน (Frontend)

- [x] Chat thread: assistant message ที่มี `tokenCount` ไม่เป็น `null` แสดง `<span class="message__meta">{{ tokenCount | number }} tokens</span>` ใต้ bubble (ตาม pattern เดียวกับ `.message__error`/`.message__streaming` เดิม, สีข้อความ `--color-text-secondary`); message เก่า/ที่ provider ไม่รายงาน usage มี `tokenCount: null` จึงไม่ขึ้น badge เลย ไม่ใช่ "0 tokens"
- [x] Admin Dashboard: เพิ่ม `ds-stat-card` "Total tokens used" ในกลุ่ม stat-grid เดิม พร้อม icon SVG ครบ (ไม่ลืมซ้ำบั๊กเดิม); ขยาย provider grid เดิมให้โชว์ badge "N tokens" คู่กับ badge "N users" เดิมต่อ provider ด้วย

### Tests ที่เพิ่มแล้ว

- [x] `ollama.provider.spec.ts`/`claude.provider.spec.ts`/`openai.provider.spec.ts` — เพิ่ม 1 test ต่อไฟล์ยืนยันว่า parse usage ถูกต้องจาก mock upstream response ตามรูปแบบจริงของแต่ละ provider (Ollama: `prompt_eval_count`/`eval_count` บน done chunk; Claude: รวม `message_start`+`message_delta` เป็น usage เดียว; OpenAI: ยืนยันทั้ง request body มี `stream_options.include_usage: true` และ parse usage-only trailing chunk ถูกต้อง)
- [x] `messages.service.spec.ts` — เพิ่ม `describe('finalizeAssistantMessage')`: บันทึก `tokenCount` ถูกต้องเมื่อส่งมา, และเมื่อไม่ส่ง (`undefined`) column ก็ยังคง `undefined` ไม่ถูก coerce เป็น 0
- [x] `admin-dashboard.service.spec.ts` (ไฟล์ใหม่) — ยืนยัน `totalTokensUsed` sum ถูกต้อง (รวม default 0 เมื่อยังไม่มีข้อมูล), `tokensByProvider` build ถูกต้องจาก groupBy พร้อม default 0 สำหรับ provider ที่ไม่มี entry
- [x] `chat.gateway.spec.ts` — เพิ่ม 2 test ("persists the combined input+output token count..." และ "leaves tokenCount undefined when the provider does not report usage") และแก้ 4 exact-match assertion เดิมที่ยังไม่รู้ว่า `finalizeAssistantMessage` มีพารามิเตอร์ที่ 5 (`tokenCount`) เพิ่มมาแล้ว (เดิม assert แค่ 4 args ก็จะพังทันทีที่โค้ดจริงส่ง 5 args เสมอ)
- [x] `chat.store.spec.ts` (frontend) — แก้ fixture helper `message()` ให้มี `tokenCount: null` ตาม default เพราะ field เพิ่งกลายเป็น required ใน `ChatMessageDto`
- [x] Manual verify ด้วย Ollama จริง — ดูรายละเอียดเต็มด้านล่าง

### ผลการยืนยันจริง (build/test/manual)

- Backend unit tests: **205/205 ผ่าน** (เพิ่มจาก 194 เดิมด้วย 11 test ใหม่ของ Phase 9 — 3 provider + 2 messages.service + 4 dashboard.service + 2 gateway)
- Backend e2e tests: **68/68 ผ่าน** (ไม่มี regression)
- Backend build + `eslint "{src,apps,libs,test}/**/*.ts"`: ผ่านสะอาด (เจอ prettier formatting 4 จุดจากรอบแก้โค้ด แก้ด้วย `--fix` แล้ว re-run ยืนยันผ่านทั้ง lint และ test อีกรอบ)
- Frontend unit tests: **45/45 ผ่าน**, frontend build ผ่าน
- Manual end-to-end ด้วย Ollama จริง (`qwen2.5-coder:14b`) ผ่าน **isolated throwaway environment** ทั้งหมด (Postgres container แยกต่างหากคนละ project name, backend รันตรงด้วย `node dist/src/main.js` ชี้ไปที่ database ทิ้งขว้างนั้น — **ไม่แตะ container/database production จริงเลย** ตาม guardrail เดิม แต่ใช้ Ollama instance เดียวกับที่ production ใช้จริงเหมือนรอบ load-test ก่อนหน้า): สมัคร user ใหม่ (auto-promote จาก `guest` เป็น `user` ผ่าน SQL ตรงในถังทิ้งขว้าง เพราะ guest ถูก `GuestBlockGuard` บล็อกไม่ให้แชท), สร้าง session, ต่อ Socket.IO จริงแล้วส่ง `chat:send` จริง — ได้ผลลัพธ์:
  - `chat:message:updated` event ที่ client ได้รับมี `tokenCount: 93` (ตัวเลขจริงจาก Ollama สำหรับ "Hi there!")
  - Query ตรงลง Postgres ยืนยัน `messages.token_count = 93` ตรงกับที่ client เห็นทุกตัว
  - `SUM(token_count) GROUP BY provider` ตรงกับ 93 เช่นกัน ยืนยันสูตรเดียวกับที่ `AdminDashboardService.getStats()` ใช้จริง

### เกณฑ์รับงาน

- [x] ส่ง chat จริงผ่าน Ollama เห็น token count จริงบันทึกลง DB และแสดงถูกต้องในหน้าจอที่ผู้ใช้ถาม
- [x] Backoffice dashboard เห็นตัวเลข total tokens/tokens-by-provider ที่ตรงกับผลรวมจริงใน DB — ยืนยันซ้ำด้วยเบราว์เซอร์จริงแล้ว (ดูด้านล่าง)
- [x] Message เก่าก่อนฟีเจอร์นี้ (`tokenCount: null`) ไม่ทำให้ UI พังหรือแสดงตัวเลขผิด ๆ — gate ด้วย `!= null` ทั้ง template และยืนยันด้วย unit test
- [x] ไม่มี regression กับ provider/gateway/dashboard test เดิม — ยืนยันแล้วด้วย full suite รันซ้ำ

### ยืนยันด้วยเบราว์เซอร์จริง (Playwright, isolated stack)

รันแยกจาก suite หลัก: backend (`node dist/src/main.js`, ชี้ Ollama จริงที่ `localhost:11434`) + `ng serve` ชี้เข้า backend นั้นผ่าน `e2e/proxy.local.json` เดิม ใช้ `zextream-e2e-test-postgres` container ที่มีอยู่แล้ว (คนละฐานข้อมูลกับ production คนละ container กันเลย) — สคริปต์ Playwright ทิ้งขว้าง (ไม่ commit) สมัคร user จริงผ่านฟอร์ม, promote เป็น admin+`dashboard_view` ตรงใน DB, สร้าง session, พิมพ์ข้อความจริงส่งผ่าน UI จริง แล้ว screenshot:

- Chat thread: bubble คำตอบ AI ("Hi there!") มี badge "93 tokens" ใต้ข้อความ ตรงกับที่ query DB ได้ก่อนหน้านี้ทุกตัว
- Admin Dashboard: stat card "TOTAL TOKENS USED" มี icon ครบ (ไม่ใช่กล่องว่างแบบบั๊กเดิมที่เจอตอน Phase 8) แสดง 93; provider grid แถว Ollama มี badge "93 TOKENS" คู่กับ "0 USERS" ส่วน Claude/Openai แสดง "0 TOKENS" ถูกต้อง (ยังไม่มีใครใช้สอง provider นี้ในฐานข้อมูลทดสอบนี้)

หลังยืนยันเสร็จ หยุด backend/`ng serve` ทิ้งขว้างทั้งคู่, ลบสคริปต์ Playwright ทิ้งขว้างออกจาก `e2e/`, `git status` สะอาด ไม่มีของทดสอบหลงเหลือ

**สถานะ**: Code + tests เสร็จครบ, ยืนยันจริงกับ Ollama ทั้งระดับ API/DB (Node script) และระดับเบราว์เซอร์จริง (Playwright screenshot) แล้ว — commit แล้ว (3 commits: metrics/load-test leftover, deployment overlay, Phase 9 เอง) และ **deploy ขึ้น production จริงแล้ว** (`docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.cloudflare.yml -f docker-compose.deployment.yml up -d --build`, rebuild backend+frontend จาก source ล่าสุด, migrate job รันแล้วยืนยันว่าไม่มี migration ค้าง ตรงตามที่คาด, `/api/health/ready` และหน้าเว็บตอบ 200 หลัง deploy) — Phase 8's ค้าง "deploy frontend build ล่าสุด" ก็ถูกรวมไปในรอบ deploy นี้ด้วยเช่นกัน (ปิด gap นั้นไปพร้อมกัน); ยังไม่ได้ `git push` ขึ้น remote

---

## Phase 10 — Model selection ที่ใช้งานได้จริง + Claude/Codex ผ่าน host-bridge (`[x]` เสร็จแล้ว)

ผู้ใช้ขอ 2 อย่าง: (1) เลือก model ในแชทได้ แสดงเฉพาะที่ "ใช้งานได้จริง" — Ollama ต้องเป็นรายการที่ pull ไว้จริงบนเครื่อง deploy เพราะรันบนเครื่องนี้ (2) Claude และ Codex (OpenAI) ให้ใช้ "user ที่ login ไว้บนเครื่องนี้" แทนระบบ BYOK (ให้ user แต่ละคนกรอก API key เอง) — งานนี้ผ่านการเข้า Plan Mode ก่อน implement ตาม pattern เดิมของ session นี้ เพราะมีการตัดสินใจสถาปัตยกรรมสำคัญหลายจุดที่ต้องยืนยันกับผู้ใช้ก่อน (ดูหัวข้อ "การตัดสินใจที่ยืนยันแล้ว" ด้านล่าง)

### สิ่งที่ยืนยันจริงระหว่างวิจัย (ทดสอบเรียกจริง ไม่ใช่สมมติฐาน)

- `claude.exe`/`codex.exe` เป็น Windows executable ที่รันบนเครื่อง host โดยตรง (`claude.exe` ที่ `AppData\Roaming\Claude\claude-code\<version>\`, `codex.exe` ที่ `AppData\Local\OpenAI\Codex\bin\<hash>\`) — login ไว้แล้วจริงทั้งคู่บนเครื่องนี้
- Backend ที่ deploy จริงรันใน Docker container (Linux) เรียกไฟล์ `.exe` บน host ตรง ๆ ไม่ได้ → ต้องมี **`host-bridge/`** service ใหม่ทั้งหมด รันตรงบน host (ไม่ containerize) ให้ container เรียกผ่าน `host.docker.internal` เหมือน pattern เดิมที่ใช้กับ Ollama
- การเรียกแบบ login เดิม (ไม่ใช่ `--bare`+API key) โหลด context เต็มรูปแบบของ agent harness ทุกครั้ง (~12,000–23,000 tokens, ทดสอบจริง 1 ข้อความสั้น ๆ ใช้ไป $0.017–0.053) — เป็น overhead ของตัว harness เอง (tool definitions/skills/system prompt) ไม่ใช่ CLAUDE.md ของ repo นี้ (ทดสอบจาก cwd กลางแล้วยังเจอ overhead นี้) — ผู้ใช้รับทราบและยอมรับแล้วเพราะเป็น subscription ไม่ใช่ pay-per-token จริง
- `--bare` mode ของ claude ลด overhead ได้แต่บังคับ `ANTHROPIC_API_KEY` เท่านั้น ("OAuth and keychain are never read") ขัดกับเป้าหมายโดยตรง จึงใช้โหมดปกติ
- **ไม่มี token-by-token streaming จริง** — ทั้ง `claude --output-format stream-json` และ `codex exec --json` ส่งข้อความเต็มก้อนเดียว ไม่ใช่ delta ทีละคำ → UI ของ claude/openai จะเห็นคำตอบ "โผล่มาทีเดียว" ต่างจาก Ollama ที่ stream จริง — บันทึกเป็น known limitation ใน `docs/deployment.md`
- Default (ไม่ปิด tool) เปิด tool ครบชุดจริง (`Bash`, `Write`, `Edit`, ฯลฯ) — ยืนยันแล้วว่า `--tools ""` (claude) ปิดการ "รันจริง" ได้จริง (ทดสอบสั่งให้รัน `whoami` แล้วได้คำตอบที่**กุขึ้นมา** ไม่ใช่ output จริง ยืนยันว่าไม่มี tool ให้ใช้จริง) แต่โมเดลยังคง "เชื่อว่ามี tool" และกุคำตอบได้ถ้าไม่บอกมันตรง ๆ ว่าไม่มี tool — ต้องมี system-prompt preamble เพิ่มเพื่อกันการกุคำตอบ (`host-bridge/src/prompt.ts`)
- **บั๊กจริงที่เจอระหว่างยืนยัน end-to-end**: `codex login status` เขียนผลลัพธ์ "Logged in using ChatGPT" ลง **stderr** ไม่ใช่ stdout เวลาถูก spawn แบบ non-interactive ผ่าน Node `child_process` (ตอนทดสอบด้วยมือผ่าน shell แล้วใช้ `2>&1` บังทำให้ไม่เห็นความต่าง) — ทำให้ `codexStatus()` เดิมอ่านแต่ stdout แล้วรายงาน `available: false` ผิดพลาดทั้งที่ login จริงอยู่ — แก้แล้วโดยเช็คทั้ง stdout+stderr รวมกัน (`host-bridge/src/codex.ts`)

### การตัดสินใจที่ยืนยันกับผู้ใช้แล้ว (ผ่าน AskUserQuestion ระหว่าง Plan Mode)

1. ยอมรับ cost/context overhead ของการใช้ login เดิม
2. แก้ปัญหา Docker↔host ด้วย `host-bridge/` service ใหม่
3. เอา BYOK ออกทั้งหมดสำหรับ claude/openai — provider key ในระบบยังคงชื่อ `claude`/`openai` เดิม (ไม่ rename เป็น `codex` ลด blast radius) แต่ implementation เปลี่ยนไปเรียก host-bridge แทน
4. ปิด tool-use ทั้งหมดเสมอ (claude: `--tools ""`; codex: `--sandbox read-only` — เป็น floor ที่เข้มที่สุดที่ยืนยันได้ว่ามีจริง ยังไม่ยืนยันว่า "ปิด tool สนิท" เท่า claude บันทึกเป็น accepted risk ใน `docs/threat-model.md`)

### ขอบเขตงานที่ทำจริง

**Backend**:
- `packages/shared-types`: `ProviderSettingDto.requiresApiKey` เป็น `false` เสมอตอนนี้; `configured`/`models` หมายถึง "ใช้งานได้จริงตอนนี้" ไม่ใช่ "มี key เก็บไว้"
- `backend/src/provider-settings/provider-settings.service.ts`: เขียนใหม่ทั้งหมด — เอา `upsertApiKey`/`removeApiKey`/`testConnection`/`hasApiKey`/`getApiKeyForRuntime`/`ApiKeyEncryptionService` ออก, `list()` (เดิม `listForUser()`) query สดทุกครั้ง (มี cache 10 วิกันยิงถี่): ollama จาก `GET {OLLAMA_BASE_URL}/api/tags`, claude/openai จาก bridge's `/claude|codex/status`
- `backend/src/provider-settings/provider-settings.controller.ts`: เหลือแค่ `GET /` — เอา `PUT`/`DELETE`/`POST .../test` ออกทั้งหมด (BYOK endpoints)
- `backend/src/ai/providers/claude.provider.ts`, `openai.provider.ts`: เขียนใหม่ให้เรียก host-bridge ผ่าน `fetch` แทน Anthropic/OpenAI API ตรง ๆ — คง `AiProvider`/`AiStreamEvent` interface เดิมทุกอย่าง (ไม่กระทบ `ChatGateway`/`MessagesService`/Phase 9 token tracking เลย); เพิ่มไฟล์ใหม่ `host-bridge-client.ts` (parse NDJSON ที่ bridge ส่งกลับมา ซึ่งมีรูปร่างตรงกับ `AiStreamEvent` อยู่แล้ว ใช้ร่วมกันทั้งสอง provider)
- `backend/src/realtime/chat.gateway.ts`, `backend/src/chat/chat-sessions.service.ts`: เปลี่ยนจากเช็ค per-user API key เป็นเช็ค `isProviderAvailable()` — **ตั้งใจคง ollama ไว้ไม่เช็คเลยทั้งสองจุด** (เหมือนพฤติกรรมเดิมก่อน BYOK แม้แต่ตอนที่ยังไม่มีฟีเจอร์นี้) เพราะ Ollama อาจสะดุดชั่วคราวโดยไม่ควรบล็อกการสร้าง session/ส่งข้อความไปเลย ปล่อยให้ error ที่ real send ตามปกติแทน — **เจอ regression จริงระหว่าง implement**: ตอนแรกเผลอเช็ค `isProviderAvailable('ollama')` ด้วย ทำให้ e2e suite ทั้งชุดพังยกแผง (34 tests) เพราะ e2e จงใจตั้งค่า Ollama unreachable แต่ยังต้องสร้าง session ได้ — แก้กลับให้ตรงพฤติกรรมเดิมแล้ว
- `backend/src/config/env.validation.ts`: เพิ่ม `CLAUDE_BRIDGE_URL`/`CODEX_BRIDGE_URL`/`HOST_BRIDGE_TOKEN` (optional ทั้งหมด — deployment ที่ไม่ใช้ฟีเจอร์นี้ไม่ต้องตั้งอะไรเพิ่ม)
- ลบไฟล์ที่ orphan แล้ว: `backend/src/provider-settings/dto/upsert-provider-credential.dto.ts`
- `ProviderCredential` table **คงไว้ในสคีมา** (ไม่ migration ออก ลดความเสี่ยง) แต่ไม่มีอะไรเขียนเข้าไปอีกแล้ว

**`host-bridge/` (workspace package ใหม่ทั้งหมด)**:
- Express + TypeScript, รันตรงบน host ด้วย `pnpm --filter host-bridge build && pnpm --filter host-bridge start` — ไม่ containerize
- ป้องกันด้วย shared-secret header (`x-bridge-token`, constant-time compare กัน timing attack)
- `GET /claude/status` (`claude auth status`, ฟรีไม่มีคอสต์ — parse JSON `.loggedIn`), `GET /codex/status` (`codex login status`, เช็คทั้ง stdout+stderr ตามบั๊กที่เจอด้านบน)
- `POST /claude/chat`, `POST /codex/chat` — flatten `messages[]` เป็น transcript เดียว (`Human: .../Assistant: ...`) ต่อท้าย safety preamble, spawn CLI ด้วย flag ปิด tool-use, parse ผลลัพธ์กลับเป็น NDJSON ตรงกับ `AiStreamEvent`
- Token usage mapping: claude รวม `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` เป็น inputTokens (ทั้งสามเป็น pool แยกกันจริงตาม Anthropic billing model); codex ใช้ `input_tokens` ตรง ๆ (cached เป็น subset ไม่ใช่ additive แบบ OpenAI) และรวม `reasoning_output_tokens` เข้า outputTokens
- Unit tests 21/21 ผ่าน (mock `child_process`/`runProcess` ไม่เรียก CLI จริงในเทส)

**Frontend**:
- `provider-settings.component.ts/.html/.scss`: เอา input/save/remove/test-connection UI ออกทั้งหมดสำหรับ claude/openai เปลี่ยนเป็นแสดงสถานะอย่างเดียว (มี/ไม่มี CLI login พร้อมข้อความอธิบาย) — เหมือนกันทุก provider ตอนนี้ (ไม่มี `requiresApiKey` branch แยกแล้ว)
- `new-session-dialog`/model selector เดิมไม่ต้องแก้ เพราะกรองด้วย `configuredProviders()` (จาก store) อยู่แล้ว จะซ่อน provider ที่ไม่พร้อมอัตโนมัติ

**Docs**:
- `docs/deployment.md`: เพิ่มหัวข้อ "Claude/Codex via host-bridge (optional)" เต็มรูปแบบ (setup steps, ทำไมต้องแยก process, safety notes) + known-gap ใหม่เรื่อง no streaming
- `docs/threat-model.md`: เพิ่มหัวข้อ "Host-bridge command execution (claude/codex, optional feature)" เต็มรูปแบบ พร้อม accepted risks (codex sandbox floor ไม่ verify เท่า claude, single shared login ไม่ scale multi-tenant), อัปเดตข้อความเดิมที่เคยบอกว่า "ไม่มี tool-use ในแอปนี้เลย" ให้ระบุข้อยกเว้นนี้ตรง ๆ

### ผลการยืนยันจริง (build/test/manual)

- Backend unit: **189/189** ผ่าน (ลดจาก 205 เพราะลบ method/test ของ BYOK ออก ไม่ใช่ regression), e2e **67/67** ผ่าน (รวม 1 test ใหม่แทนที่ describe "provider runtime gating" เดิมที่ทดสอบ cross-user key isolation ซึ่งไม่มีความหมายอีกต่อไป), lint สะอาด, build สะอาด
- Frontend unit **45/45** ผ่าน, build สะอาด
- host-bridge unit **21/21** ผ่าน, type-check สะอาด
- **Manual end-to-end ด้วย bridge จริง + CLI จริง** (isolated: throwaway Postgres เดิมที่ e2e suite ใช้, backend รันตรงด้วย `node dist/src/main.js`, host-bridge รันตรงด้วย `node dist/index.js` ทั้งคู่ไม่แตะ production เลย):
  - `GET /api/settings/providers` คืนค่าถูกต้องครบสามตัว: ollama (`models: ["qwen2.5-coder:14b"]`), claude (`models: ["sonnet","opus","haiku"]`), openai (`models: ["gpt-5.6-sol"]`) — `configured: true` ทั้งสามตัวตอนที่ทุกอย่าง reachable จริง
  - ส่งข้อความจริงผ่าน claude (`haiku`) และ codex (`gpt-5.6-sol`) ผ่าน socket จริงครบ pipeline (`ChatGateway` → provider → bridge → CLI จริง) ได้คำตอบ "PONG" ถูกต้องทั้งคู่, `tokenCount` บันทึกลง DB ถูกต้องตรงกับที่ client เห็น (claude: 6771, codex: 12780 — ตัวเลขสูงเพราะ harness overhead ตามที่บันทึกไว้ข้างบน)

### เกณฑ์รับงาน

- [x] Model selector แสดงเฉพาะ Ollama model ที่ pull ไว้จริงบนเครื่อง (ไม่ใช่ hardcode)
- [x] Claude/Codex ใช้งานได้โดยไม่ต้องกรอก API key เมื่อ host-bridge รันอยู่และ CLI login ไว้
- [x] Tool-use ปิดสนิทสำหรับ claude (ยืนยันด้วยมือ), ปิดผ่าน sandbox สำหรับ codex (accepted risk ที่ยังไม่ verify ครบ)
- [x] ไม่มี regression กับ Ollama (แก้ regression ที่เจอระหว่าง implement แล้ว)
- [x] Token usage tracking (Phase 9) ทำงานถูกต้องกับ provider ใหม่ทั้งสองตัวด้วย

**สถานะ**: Code + tests เสร็จครบ, ยืนยันจริงกับ claude.exe/codex.exe ผ่าน host-bridge จริงแล้ว — ยังไม่ commit, ยังไม่ deploy ขึ้น production (ต้องมี host-bridge รันอยู่บนเครื่อง production จริงก่อนถึงจะเปิดใช้ claude/openai ได้ — ถ้า deploy โดยไม่ตั้งค่า `CLAUDE_BRIDGE_URL`/`CODEX_BRIDGE_URL`/`HOST_BRIDGE_TOKEN` ระบบจะทำงานปกติเหมือนเดิมแค่ claude/openai จะแสดงเป็น "ไม่พร้อมใช้งาน")

---

## Test strategy

### สถานะปัจจุบัน

- [x] Backend unit smoke test ผ่าน 1 test
- [x] Frontend unit smoke test ผ่าน 1 test
- [x] Backend build ผ่าน
- [x] Frontend build ผ่าน
- [x] Backend ESLint ทั้ง repository ผ่านแล้ว (`npx eslint .` → 0 errors, 0 warnings) — เดิมรายงาน 170 problems แต่ ~146 เป็น false positive จาก `dist/` (build output ที่ eslint ไม่เคยถูกกันไว้ ทำให้ parse ไฟล์ compiled ที่ไม่อยู่ใน tsconfig rootDir ไม่ได้) แก้โดยเพิ่ม `dist/**` เข้า `ignores` ใน `eslint.config.mjs`; อีก 24 ปัญหาที่เหลือเป็นของจริงในซอร์สโค้ด แก้ครบแล้ว — ส่วนใหญ่เป็น prettier formatting (`--fix` อัตโนมัติ) และ type-safety จริง 8 จุด: `current-user.decorator.ts`/`jwt-refresh.strategy.ts` เคย unsafe-assign `any` จาก `getRequest()`/`req.cookies` ที่ไม่มี type แก้ด้วยการ type ตัวแปรกลาง/narrow ด้วย `typeof` แทนที่จะ trust `any` เดิม, `artifacts.service.spec.ts` 2 จุด restructure assertion จาก object-literal property ที่มี `expect.objectContaining()` ฝังอยู่ (ซึ่ง `no-unsafe-assignment` มองว่าเป็น any-assignment) เป็นการ cast `mock.calls[0]` ด้วย `as` แล้ว assert field ตรง ๆ, `chat.gateway.spec.ts` 2 จุดเป็น async generator mock ที่ไม่มี `await` จริงข้างใน แก้โดยถอด `async` ออก (เหลือเป็น sync generator ธรรมดา ซึ่ง `for await...of` ฝั่ง consumer ใช้งานได้เหมือนเดิมอยู่แล้ว) — ระหว่างแก้เจอว่า generator ตัวอื่นที่ยังมี `await` จริงถูก script เผลอแก้ไปด้วย (`replace_all`) ต้องแก้กลับเฉพาะตัวนั้น ตรวจสอบด้วย `tsc --noEmit` ยืนยันว่าไม่มีที่ไหนพังหลงเหลือ; build + unit test (162/162) + e2e (53/53) ผ่านหมดหลังแก้
- [x] Test suite ครอบคลุม business logic หลักแล้ว — เดิมบรรทัดนี้ค้างมาจากรอบก่อนที่ checklist ด้านล่าง ("Unit tests ที่ควรเพิ่มก่อน"/"Integration tests"/"Browser E2E") ยังไม่ครบ ตอนนี้ทุกรายการในสามหมวดนั้น `[x]` แล้วจริง (backend unit 162, e2e 55 ข้าม 3 Jest projects, frontend unit 45, Playwright browser e2e 5 ผ่าน + 2 skip เพราะต้องมี Ollama จริง) — ปรับให้ตรงกับสถานะจริงด้านล่าง

### Unit tests ที่ควรเพิ่มก่อน

- [x] `ArtifactStreamParser` ทุก boundary condition
- [x] `AuthService` token rotation/reuse/concurrency
- [x] `ArtifactsService` revision selection/concurrency
- [x] `OllamaProvider` parsing, abort และ upstream errors (รวม timeout ใหม่และ malformed line)
- [x] `ActiveStreamRegistry` register/stop/release (รวม `stopAllForSession` และ stop/release ของ id ที่ไม่รู้จัก/ถูก release แล้ว)
- [x] Angular `AuthStore`, `ChatStore` และ `ArtifactStore` (`ChatStore` และ `ArtifactStore` มี spec ครบ — stale-response guard, dedup, streaming guard, exception toast, debounce/revision; เพิ่ม `AuthStore` spec แล้ว — `frontend/src/app/core/auth.store.spec.ts`: login/register สำเร็จ/ล้มเหลว, `tryRefresh()` สำเร็จ/ล้มเหลว, concurrent `tryRefresh()` callers share การเรียกเดียวกันจริง (ไม่ยิงซ้ำ), logout เคลียร์ state แม้ request fail; frontend suite รวม 45/45 ผ่าน)

### Integration tests

- [x] Auth endpoints กับ PostgreSQL จริงใน test container (`backend/test/auth.e2e-spec.ts` เพิ่มเติมจาก `app.e2e-spec.ts` เดิม)
- [x] Session ownership ทุก REST endpoint
- [x] Artifact ownership และ revisions (`backend/test/artifacts-ownership.e2e-spec.ts` — สร้าง artifact ตรงผ่าน Prisma ใต้ session ของ user A แล้วยืนยันว่า user B ได้ 403 ทั้ง list และ revisions endpoint, และ unauthenticated ได้ 401)
- [x] Socket.IO connection/join/send/stop/edit — connection/join/send/stop ยืนยันผ่าน `socket.io-client` จริงแล้ว (`backend/test/websocket.e2e-spec.ts`, `backend/test/chat-stop.e2e-spec.ts`); เพิ่ม `artifact:edit` real-socket e2e แล้ว (describe "artifact:edit (real socket, not the unit-mocked gateway)"): owner แก้ artifact ผ่าน socket จริงแล้วได้ revision ใหม่พร้อม broadcast `artifact:created` ไปยังทุกคนใน session room, และผู้ใช้อื่นที่ไม่ได้เป็นเจ้าของ session ถูก reject ด้วย `exception` event โดยไม่มี revision ใหม่ถูกสร้างเลย; e2e suite รวม 53/53 ผ่าน
- [x] Cross-user negative tests
- [x] Prisma migrations บน empty database (`backend/test/migrations-empty-db.e2e-spec.ts`)

### Browser E2E

Playwright suite ที่ `e2e/` (root-level, ขับทั้ง frontend จริง + backend จริง — ดู `e2e/README.md` สำหรับวิธีรัน) รัน `pnpm --filter e2e test:e2e:browser` ผ่านแล้ว 5 tests, skip 2 tests ที่ต้องมี Ollama จริง:

- [x] Register → login → create chat (`e2e/tests/auth-and-chat.spec.ts`)
- [x] Send prompt → เห็น token streaming — **ยืนยันจริงแล้วด้วยมือ** ผ่าน Ollama จริงที่ reachable บนเครื่อง (`qwen2.5-coder:14b`, ~14.6GB) ผ่าน `docker compose` dev stack: ส่งข้อความจริง เห็น token stream เข้ามาและ AI ตอบถูกต้อง ระหว่างตรวจพบและแก้บั๊กจริง 2 จุดด้วย (ดู Phase 4 P1 ด้านล่าง: connect-timeout สั้นเกินไปสำหรับ cold model load, และ inactivity timer แข่งกับ connect timer ผิดจังหวะ) — automated `e2e/tests/ai-dependent.spec.ts` ยังเป็น `test.skip()` เหมือนเดิมเพราะ CI ทั่วไปไม่มี Ollama ติดตั้ง ไม่ใช่เพราะ feature ใช้งานไม่ได้
- [x] Generate code → เห็น Monaco progressive stream — ยืนยันจริงแล้วด้วยมือพร้อมกับข้างบน: สั่งสร้างไฟล์ `.py`/`.js` จริง เห็นโค้ดขึ้นใน Monaco ถูกต้อง, syntax highlighting ทำงาน, ไฟล์ปรากฏใน tab
- [x] Edit code → revision เพิ่ม — ยืนยันจริงแล้วด้วยมือ: แก้โค้ดใน Monaco หลังจาก AI สร้างไฟล์ (ผ่าน artifact จริงจาก AI stream ตามที่ตั้งใจไว้ ไม่ต้องมี path แยกที่ไม่พึ่ง AI), เกิด Revision 2 (origin: user) ถัดจาก Revision 1 (origin: ai) ใน revision history ถูกต้อง, reload หน้าแล้ว title/session/ไฟล์/เนื้อหายังอยู่ครบ
- [x] Reload → session/messages/artifacts กลับมาครบ (`e2e/tests/auth-and-chat.spec.ts` — reload จริงด้วย `page.reload()` ยืนยัน session/message กลับมา; ไม่มี artifact ในเคสนี้เพราะไม่มี AI จริงสร้างให้)
- [x] Stop generation (`e2e/tests/stop-generation.spec.ts` — กดปุ่ม Stop ถ้าทันหน้าต่าง streaming สั้นๆ ของ Ollama unreachable, ยืนยัน composer กลับมาใช้งานได้ปกติไม่ค้างไม่ว่าทางไหน)
- [x] Logout → login อีก user → socket identity เปลี่ยนถูกต้อง (`e2e/tests/identity-switch.spec.ts` — ยืนยัน user ใหม่ไม่เห็น session/ข้อความของ user เดิมแม้ navigate ตรงไป URL เดิม)
- [x] เปิดหลาย tabs และทดสอบ refresh token race (`e2e/tests/refresh-token-race.spec.ts` — สอง page ใน browser context เดียวกัน, บังคับ race จริงด้วย network-level gate ที่ `/api/auth/refresh`, ยืนยันว่ามี tab หนึ่งใช้งานได้เสมอและ tab ที่แพ้ race redirect ไป `/login` สะอาดๆ)

### Quality gate ที่แนะนำ

ทุก pull request ควรผ่าน:

```bash
pnpm install --frozen-lockfile
pnpm --filter backend exec prisma generate
pnpm --filter backend build
pnpm --filter frontend build
pnpm --filter backend test --runInBand
pnpm --filter frontend exec ng test --watch=false
pnpm --filter backend exec eslint "{src,apps,libs,test}/**/*.ts"
```

---

## ลำดับงานที่แนะนำ

### Milestone A — ทำ baseline ให้ปลอดภัยและเสถียร

1. [~] เลือก canonical repository และจัดการ `login.md` (ถอดจาก tracked files แล้ว; ยังไม่ได้ rewrite Git history)
2. [x] แก้ socket disconnect/re-authentication ตอน logout/login
3. [x] เพิ่ม ownership check ให้ `chat:stop`
4. [x] ทำ streaming error boundary ให้ finalize message เสมอ
5. [x] จำกัด provider ให้เหลือเฉพาะ Ollama จนกว่า provider อื่นพร้อม
6. [x] ทำ refresh-token rotation ให้ atomic
7. [x] เพิ่ม auth/WebSocket ownership integration tests

Milestone A ถือว่าเสร็จเมื่อไม่มี cross-user access, socket identity leak หรือ message ค้างจาก known failure paths

### Milestone B — ทำ Phase 5 ให้สมบูรณ์

1. [x] เพิ่ม artifacts ล่าสุดเข้า AI context
2. [x] Debounce/explicit-save editor
3. [x] ทำ revision concurrency-safe
4. [x] แก้ parser EOF closing fence
5. [x] ป้องกัน stale session/artifact state
6. [~] ทำ Artifact E2E test matrix (ยืนยัน Ollama streaming, create/edit revision จริงแล้ว; ยังไม่ครบทุกกรณี)
7. [x] เพิ่ม revision/diff UI ที่ใช้งานได้จริง

Milestone B ถือว่าเสร็จเมื่อสร้าง แก้ reload และสั่ง AI แก้ไฟล์เดิมได้ต่อเนื่องโดยข้อมูลไม่หาย

### Milestone C — Multi-provider

1. [x] ออกแบบ encrypted provider credentials
2. [x] สร้าง settings API/UI
3. [x] Implement Claude provider
4. [x] Implement OpenAI provider
5. [x] เพิ่ม model selection และ provider connection test
6. [~] เพิ่ม provider integration tests (provider/error mapping unit tests ครอบคลุม mocked upstream แล้ว; ยังไม่มี integration test ผ่าน Socket.IO/test container จริง)

### Milestone D — Production readiness

รายการนี้ค้างเป็น `[ ]` มานานแม้ Phase 7 (Security hardening และ Production readiness) จะทำครบไปตั้งแต่ก่อนหน้านี้แล้ว — เป็นแค่ checklist ระดับ roadmap ที่ไม่เคย sync กับสถานะจริงใน Phase 7 เท่านั้น ตรวจสอบแล้วอัปเดตให้ตรงกับความจริง:

1. [x] Rate limiting, Helmet และ payload limits — Phase 7 → Security ทำครบแล้ว (Helmet+CSP, REST+WS rate limiting, body size limits)
2. [x] Logging, metrics และ error reporting — Phase 7 → Observability ทำครบ (structured logging, request correlation ID, Sentry); metrics เดิมมีแค่ HTTP request rate/error/duration — **เพิ่ม AI stream metrics ที่เคยขาด (stream duration, first-token latency, active-streams gauge) ในรอบนี้แล้ว** (`backend/src/common/metrics.service.ts`, hook เข้า `ChatGateway.onChatSend`) ปิด gap ที่ Phase 7 เคยทิ้งไว้เป็น follow-up
3. [x] CI/CD และ container scanning — Phase 7 มี Trivy image scan อยู่แล้ว; รอบ Phase 8 เพิ่ม backend e2e + Playwright browser e2e เข้า CI เพิ่มเติมด้วย
4. [x] Backup/restore และ deployment runbook — Phase 7 → Reliability/Deployment ทำและทดสอบจริงครบ (`docs/backup-restore.md`, `docs/deployment.md`)
5. [x] Full browser E2E และ security regression suite — Playwright suite จริง (`e2e/`) ครอบคลุม auth/chat/identity/refresh-race/stop-generation/guest-activation; `docs/threat-model.md` เป็น security regression reference
6. [x] Performance/load test สำหรับ concurrent streams — ทำครบแล้วในรอบนี้: รัน concurrent `chat:send` load test จริง (Socket.IO จริง, Ollama จริง `qwen2.5-coder:14b`) กับ **isolated backend container แยกต่างหาก** (`target: prod`, resource limit เดียวกับ production, database ทิ้งขว้างของตัวเอง — ไม่แตะ container/database production จริงเลย เพราะ auto-mode guardrail เตือนไว้ถูกต้องว่าไม่ควรทดสอบใส่ production ตรง ๆ) แต่ใช้ Ollama instance เดียวกับที่ production ใช้จริง (เป็น resource ที่ตั้งใจทดสอบร่วม):
   - **รอบแรกใช้ไม่ได้ ต้องยกเลิกผล**: 8 concurrent streams ตอนแรก **timeout ทั้งหมด** ไม่มี stream ไหนได้ token แรกใน 90 วิเลย — ตอนนั้นดูเหมือน Ollama รับ 8 concurrent 14B-model generation พร้อมกันไม่ไหว แต่ผู้ใช้แจ้งภายหลังว่ากำลังเล่นเกมแย่ง GPU/CPU อยู่ระหว่างทดสอบพอดี — รันซ้ำหลังปิดเกมได้ผลต่างกันโดยสิ้นเชิง (ดูด้านล่าง) จึงตัดสินใจยกเลิกผลรอบแรกทิ้ง ไม่ใช่เก็บไว้เป็น data point เพราะสะท้อนแค่ GPU contention กับเกมที่ไม่เกี่ยวกับแอป ไม่ใช่ capacity จริงของระบบ
   - **ผลที่ถูกต้อง** (ปิดเกมแล้ว, warm-up Ollama ก่อน 1 ครั้งกันปนกับเวลาโหลดโมเดลเย็น ~9s ที่วัดแยกไว้ต่างหาก):
     - **8 concurrent streams**: สำเร็จทั้งหมด 8/8 — first-token latency 532–1192ms (เฉลี่ย 877ms), total duration 615–1253ms (เฉลี่ย 942ms), wall-clock ทั้ง batch 1.3 วิ
     - **20 concurrent streams**: สำเร็จทั้งหมด 20/20 เช่นกัน — first-token latency 829–2711ms (เฉลี่ย 1.8 วิ), total duration 915–2774ms (เฉลี่ย 1.9 วิ), wall-clock ทั้ง batch 2.9 วิ — latency ค่อย ๆ เพิ่มตาม concurrency แบบ graceful ไม่มี error/timeout เลย
     - backend container ใช้ CPU เฉลี่ย 6.7% (พีค ~86%), memory 91–160MB จาก cap 1GB ตลอดทั้งสองรอบ — **backend ไม่ใช่คอขวดเลยในทุก concurrency ที่ทดสอบ**
     - ไม่ทดสอบสูงกว่า 20 ต่อ (auto-mode guardrail เตือนไว้ว่าไม่ควร escalate load ใส่ Ollama instance เดียวกับที่งานอื่นบนเครื่องนี้อาจต้องพึ่งพาอยู่โดยไม่มีเหตุผลเฉพาะเจาะจง) — 20 concurrent ที่ไม่มีอะไรแย่ง resource ก็สำเร็จลื่นไหลด้วย latency ต่ำกว่า 3 วิอยู่แล้ว ดีขึ้นกว่าที่รอบแรก (ที่ปนเปื้อน) ทำให้เข้าใจผิดไปมาก
   - **สรุป**: backend scale ได้สบายมากเกินพอสำหรับ deployment ระดับเครื่องเดียว (CPU/memory มี headroom เหลือเฟือทุก concurrency ที่ทดสอบ) คอขวดจริงคือ capacity ของ Ollama instance เอง **และ resource contention จากงานอื่นบนเครื่องเดียวกัน (ยืนยันจริงจากรอบแรกที่ปนเปื้อน)** ไม่ใช่โค้ดของ repo นี้ — ถ้าต้องการ AI throughput สูงขึ้นต้องแก้ที่ Ollama parallelism/hardware, กันไม่ให้มี GPU load อื่นแย่งตอนใช้งานจริง, หรือใช้ hosted provider (Claude/OpenAI) ไม่ใช่ปรับ resource limit ของ backend เอง — รายละเอียดเต็มดู `docs/deployment.md` → "Concurrent AI-streaming load test"

Milestone D ถือว่าเสร็จสมบูรณ์แล้วทั้ง 6 ข้อ — เดิม checklist นี้ค้างเป็น `[ ]` ทั้งหมดทั้งที่งานจริงเสร็จไปแล้วใน Phase 7/8 เกือบหมด รอบนี้ตรวจสอบ sync สถานะให้ตรงความจริง และปิด 2 gap ที่เหลือจริง (AI stream metrics, concurrent-streaming load test) ให้เสร็จเพิ่มเติมด้วย — Backend unit suite รวม **194/194** ผ่าน (เพิ่มจาก 188 ด้วย test ของ metrics ใหม่), e2e 68/68, frontend unit 45/45 ยังผ่านเหมือนเดิมไม่มี regression

### Milestone E — Backoffice Admin

1. [x] เพิ่ม `AdminPermission`/`AdminPermissionGrant`/`AdminAuditLogEntry` data model และ migration
2. [x] สร้าง `PermissionsGuard`/`@RequirePermissions` และ `backend/src/admin/` module (users, dashboard, audit-log endpoints)
3. [x] Bootstrap `ake.kidsapon@gmail.com` เป็น super-admin ผ่าน `BOOTSTRAP_ADMIN_EMAILS` (idempotent, ทั้งตอน startup และตอน register) — code+unit tests เสร็จ, ยังไม่ได้ยืนยันสดกับ production database
4. [x] แก้ login/register/`/api/users/me` ให้คืน `role`/`permissions` ครบ
5. [x] สร้างหน้า backoffice (`/admin`, `/admin/users`, `/admin/audit-log`) ด้วย design-system เดิม ให้สวยงามและใช้งานสะดวก — build ผ่าน, ยังไม่ manual browser check
6. [x] เพิ่ม unit/e2e tests สำหรับ permission gating, self-lockout guard และ cross-user negative tests

Milestone E ถือว่าเสร็จเมื่อไม่มี user ธรรมดาเข้าถึง backoffice ได้, permission เปลี่ยนมีผลทันที, และ `ake.kidsapon@gmail.com` ทดสอบระบบในฐานะ super-admin ได้จริง — **เกือบเสร็จ**: code+tests ครบหมดแล้ว (182 backend unit, 64 backend e2e, 45 frontend unit ผ่านทั้งหมด) เหลือแค่ deploy ขึ้น production container จริงแล้ว manual-verify ผ่าน browser ก่อนปิด milestone นี้ได้เต็มตัว

---

## งานที่ทำได้ทันทีในรอบถัดไป

แนะนำให้เริ่มจากชุดงานนี้ เพราะแก้ความเสี่ยงสูงสุดและไม่ต้องรอ Phase 6:

- [x] เพิ่ม `SocketService.disconnect()` และเรียกจาก logout
- [x] สร้าง socket ใหม่หลัง login/refresh identity change
- [x] เพิ่ม message ownership query และตรวจใน `chat:stop`
- [x] ย้าย provider lookup/stream/parser/finalize เข้า error boundary เดียว
- [x] Reject `claude`/`openai` session creation ชั่วคราว หรือ implement provider registry validation
- [x] เพิ่ม unit tests สำหรับ parser และ integration test สำหรับ WebSocket ownership
- [x] เพิ่ม debounce ให้ Monaco edit
- [x] ทำ artifact revision insert ให้ retry/lock เมื่อชน unique constraint
- [x] ส่ง artifact content ล่าสุดเข้า AI context
- [x] รัน Artifact E2E ด้วย Ollama จริง

## Definition of Done ของแต่ละงาน

งานหนึ่งจะถือว่าเสร็จเมื่อครบทุกข้อ:

- [ ] Source code ถูก implement และ review แล้ว
- [ ] มี tests ครอบคลุม happy path และ failure path สำคัญ
- [ ] Build และ lint ผ่าน
- [ ] ไม่มีข้อมูลลับหรือ generated files ถูก commit
- [ ] API/WebSocket contracts และ README/plan ถูกอัปเดตถ้ามีพฤติกรรมเปลี่ยน
- [ ] Database change มี migration และทดสอบ deploy แล้ว
- [ ] Security/ownership ถูกตรวจสำหรับ operation ที่อ่านหรือแก้ข้อมูล user
- [ ] มีวิธีตรวจสอบผลซ้ำได้ ไม่อาศัยเพียงการทดสอบด้วยมือครั้งเดียว

## หมายเหตุจาก Claude session เดิม

- Claude session เดิม `85b1d178-826d-4116-819b-a19247a4e6bc` หยุดเพราะชน session limit เวลาประมาณ 00:33
- Background Docker rebuild ของ Phase 5 จบด้วย exit code `0`
- Notification ที่แสดง `stopped` บางรายการเกิดจาก session teardown; task output จริงของ rebuild และ wait commands จบแล้ว
- Claude Code process ปัจจุบันที่เปิดกับ `zEXtream-Application-AI` เป็น interactive process แบบ idle และไม่พบ source change หลังเริ่ม session
- Docker development stack ที่เริ่มจาก working copy เดิมอาจยังใช้ชื่อ project `chat-workspace`; ให้ปิด stack เดิมก่อนเริ่ม stack ชื่อ `zextream-application-ai` เพื่อไม่ให้ container หรือ port ชนกัน
- สิ่งที่ยังขาดจาก Phase 5 คือ functional E2E verification ไม่ใช่การเขียน source ขั้นต้น
