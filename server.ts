import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { createClient } from "@libsql/client";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

type Role = "customer" | "admin" | "staff";
type SessionUser = {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
};
type JsonObject = Record<string, unknown>;
type CancellationPolicy = { fullRefundDays: number; partialRefundDays: number; partialRefundPercent: number };
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
if (Boolean(tursoUrl) !== Boolean(tursoToken)) throw new Error("Set both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or neither.");
const dataDir = process.env.DATA_DIR || join(root, "data");
if (!tursoUrl) mkdirSync(dataDir, { recursive: true });
const client = createClient(tursoUrl && tursoToken ? { url: tursoUrl, authToken: tursoToken } : { url: `file:${process.env.DATABASE_PATH || join(dataDir, "escape-villa.sqlite3")}` });
function makeDatabase(executor: any): any {
  return {
    exec: async (sql: string) => { await executor.executeMultiple(sql); },
    prepare: (sql: string) => ({
      run: async (...args: unknown[]) => executor.execute({ sql, args }),
      get: async (...args: unknown[]) => (await executor.execute({ sql, args })).rows[0],
      all: async (...args: unknown[]) => (await executor.execute({ sql, args })).rows,
    }),
    transaction: async (work: (tx: any) => Promise<any>) => {
      const tx = await client.transaction("write");
      try { const result = await work(makeDatabase(tx)); await tx.commit(); return result; }
      catch (error) { await tx.rollback(); throw error; }
    },
  };
}
const database = makeDatabase(client);
let secret = process.env.ESCAPE_VILLA_SECRET || "development-secret-change-before-deployment";
async function initializeDatabase(): Promise<void> {
if (!tursoUrl) await database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
await database.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('customer','admin','staff')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL, required_skill TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS packages(id INTEGER PRIMARY KEY, service_id INTEGER NOT NULL REFERENCES services(id), name TEXT NOT NULL, price REAL NOT NULL, price_from INTEGER NOT NULL DEFAULT 0, duration_minutes INTEGER, description TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(service_id,name));
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, reference TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES users(id), service_id INTEGER NOT NULL REFERENCES services(id), package_id INTEGER REFERENCES packages(id), package_name TEXT NOT NULL DEFAULT '', package_price REAL, package_price_from INTEGER NOT NULL DEFAULT 0, package_description TEXT NOT NULL DEFAULT '', event_type TEXT NOT NULL DEFAULT '', event_date TEXT NOT NULL, start_time TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, venue TEXT NOT NULL, guests INTEGER, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Pending Payment', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, booking_id INTEGER UNIQUE NOT NULL REFERENCES bookings(id), amount REAL, status TEXT NOT NULL DEFAULT 'Pending', evidence_received INTEGER NOT NULL DEFAULT 0, proof_data TEXT, proof_mime TEXT, proof_filename TEXT, rejection_reason TEXT, reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), skills TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), staff_id INTEGER REFERENCES staff(id), name TEXT NOT NULL, required_skill TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Unassigned', notes TEXT NOT NULL DEFAULT '', UNIQUE(booking_id,name));
CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), customer_id INTEGER NOT NULL REFERENCES users(id), requested_json TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Pending', response TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS changes_one_reschedule_per_booking ON changes(booking_id);
CREATE TABLE IF NOT EXISTS cancellation_requests(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), customer_id INTEGER NOT NULL REFERENCES users(id), request_type TEXT NOT NULL DEFAULT 'customer' CHECK(request_type IN ('customer','venue')), status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')), reason TEXT NOT NULL DEFAULT '', rejection_reason TEXT, calculated_refund_amount REAL NOT NULL DEFAULT 0, approved_refund_amount REAL NOT NULL DEFAULT 0, reviewed_by INTEGER REFERENCES users(id), requested_at TEXT NOT NULL, reviewed_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS cancellation_one_pending_per_booking ON cancellation_requests(booking_id) WHERE status='Pending';
CREATE TABLE IF NOT EXISTS refunds(id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id), cancellation_request_id INTEGER NOT NULL UNIQUE REFERENCES cancellation_requests(id), amount REAL NOT NULL CHECK(amount>0), status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Processed','Failed')), transfer_reference TEXT, failure_reason TEXT, updated_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, processed_at TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, recipient_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enquiries(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY, actor_id INTEGER, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log(created_at DESC);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`);
await database.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('cancellation_policy',?)").run(JSON.stringify({ fullRefundDays: 7, partialRefundDays: 3, partialRefundPercent: 50 }));
const paymentColumns = new Set((await database.prepare("PRAGMA table_info(payments)").all()).map((column: any) => String(column.name)));
for (const [name, declaration] of [["proof_data", "TEXT"], ["proof_mime", "TEXT"], ["proof_filename", "TEXT"]] as const) {
  if (!paymentColumns.has(name)) await database.exec(`ALTER TABLE payments ADD COLUMN ${name} ${declaration}`);
}
const bookingColumns = new Set(
  (await database.prepare("PRAGMA table_info(bookings)").all()).map((column: any) => String(column.name)),
);
for (const [name, declaration] of [
  ["package_id", "INTEGER REFERENCES packages(id)"],
  ["package_name", "TEXT NOT NULL DEFAULT ''"],
  ["package_price", "REAL"],
  ["package_price_from", "INTEGER NOT NULL DEFAULT 0"],
  ["package_description", "TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!bookingColumns.has(name)) await database.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${declaration}`);
}
const initialServices = [
  [
    "Photography",
    "Professional maternity, birthday, graduation, corporate and brand photography shoots.",
  ],
  [
    "Videography",
    "Film and video shoots for occasions, brands and creative projects.",
  ],
  [
    "Event Planning",
    "Greek-inspired outdoor venue hire, décor and catering for baby showers, birthdays, graduation parties and year-end functions. Maximum 45 guests; rates depend on guest numbers.",
  ],
  ["Makeup", "Makeup, hair installation and styling by appointment."],
  [
    "Romantic Private Dinner",
    "A romantic private-dining setup with a three-course meal, arranged by appointment.",
  ],
];
for (const [name, description] of initialServices)
  await database
    .prepare(
      "INSERT OR IGNORE INTO services(name,description,required_skill) VALUES(?,?,?)",
    )
    .run(name, description, name);
for (const [name, description] of initialServices)
  await database
    .prepare("UPDATE services SET description=? WHERE name=?")
    .run(description, name);
const initialPackages: Array<[string, string, number, boolean, number | null, string]> = [
  ["Photography", "Basic Moments", 850, false, 60, "Up to 1 hour|1 photography session|10 edited digital photos|1 location|Online digital delivery"],
  ["Photography", "Classic Memories", 1500, false, 120, "Up to 2 hours|1 photography session|25 edited digital photos|Up to 2 outfit changes|1 location"],
  ["Photography", "Premium Moments", 3500, false, 240, "Up to 4 hours|Event photography coverage|At least 100 edited photos|Candid and group photos|Digital gallery delivery"],
  ["Videography", "Mini Moments", 1200, false, 60, "Up to 1 hour of filming|30–60 second highlight video|Basic editing|Social-media-ready format"],
  ["Videography", "Signature Film", 2500, false, 180, "Up to 3 hours of filming|2–3 minute highlight video|Music and colour editing|Digital delivery"],
  ["Videography", "Premium Cinema", 4500, false, 300, "Up to 5 hours of filming|4–6 minute highlight film|30–60 second social media reel|Professional editing"],
  ["Event Planning", "Essential Planning", 1500, false, null, "Initial planning consultation|Event theme and concept|Basic event checklist|Budget planning assistance"],
  ["Event Planning", "Signature Celebration", 3500, false, null, "Event planning and coordination|Theme and décor planning|Supplier coordination|Event-day schedule"],
  ["Event Planning", "Luxury Events", 7500, true, null, "Detailed event planning|Venue and supplier coordination|Décor and setup coordination|Event-day management"],
  ["Makeup", "Soft Glam", 450, false, 60, "Natural, soft glam makeup|Skin preparation|Lashes included|Suitable for photoshoots and daytime events"],
  ["Makeup", "Full Glam", 650, false, 90, "Full glam makeup application|Contour and highlight|Lashes included|Suitable for parties and special occasions"],
  ["Makeup", "Bridal Glam", 1200, false, 120, "Bridal makeup application|Skin preparation and lashes|Long-wear makeup finish|Brief consultation before the event"],
  ["Romantic Private Dinner", "Love in Simplicity", 1200, false, 180, "For 2 people|Romantic table setup|Candles and rose-petal styling|Personalized table message|Basic photo-taking area"],
  ["Romantic Private Dinner", "Romance Experience", 2000, false, 180, "For 2 people|Enhanced romantic décor|Floral table centerpiece|Personalized message|Dinner arrangement coordination|Photos of the setup"],
  ["Romantic Private Dinner", "Luxury Love Affair", 3500, false, 180, "For 2 people|Premium romantic table styling|Flowers and candle décor|Personalized celebration setup|Dinner and venue coordination|Photography session of the couple"],
];
const packageStatement = await database.prepare(
  "INSERT INTO packages(service_id,name,price,price_from,duration_minutes,description) SELECT id,?,?,?,?,? FROM services WHERE name=? ON CONFLICT(service_id,name) DO UPDATE SET price=excluded.price,price_from=excluded.price_from,duration_minutes=excluded.duration_minutes,description=excluded.description,active=1",
);
for (const [serviceName, name, price, priceFrom, durationMinutes, description] of initialPackages)
  await packageStatement.run(name, price, priceFrom ? 1 : 0, durationMinutes, description, serviceName);
await database
  .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
  .run(
    "mission",
    "Our mission is to provide high-quality photography and event services that capture meaningful moments, create memorable experiences and deliver value to our clients.",
  );
await database
  .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)")
  .run(
    "vision",
    "Our vision is to grow into a trusted and recognised creative services brand known for quality, professionalism, creativity and positive customer experiences.",
  );

const storedSessionSecret = await database
  .prepare("SELECT value FROM settings WHERE key='session_secret_override'")
  .get() as { value: string } | undefined;
secret = storedSessionSecret?.value || process.env.ESCAPE_VILLA_SECRET || "development-secret-change-before-deployment";
}
await initializeDatabase();
const now = (): string => new Date().toISOString();
const defaultCancellationPolicy: CancellationPolicy = { fullRefundDays: 7, partialRefundDays: 3, partialRefundPercent: 50 };
async function cancellationPolicy(): Promise<CancellationPolicy> {
  const saved = await database.prepare("SELECT value FROM settings WHERE key='cancellation_policy'").get() as { value: string } | undefined;
  if (!saved) return defaultCancellationPolicy;
  try {
    const parsed = JSON.parse(saved.value) as CancellationPolicy;
    if (Number.isInteger(parsed.fullRefundDays) && Number.isInteger(parsed.partialRefundDays) && parsed.fullRefundDays > parsed.partialRefundDays && parsed.partialRefundDays >= 1 && parsed.partialRefundPercent >= 0 && parsed.partialRefundPercent <= 100)
      return parsed;
  } catch { /* Fall back to the documented default policy. */ }
  return defaultCancellationPolicy;
}
function southAfricanDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function refundForBooking(amountPaid: number, eventDate: string, policy: CancellationPolicy, venueCancelled = false): number {
  const paid = Math.max(0, Math.round(amountPaid * 100) / 100);
  if (venueCancelled) return paid;
  const daysUntil = Math.max(0, Math.floor((Date.parse(`${eventDate}T00:00:00Z`) - Date.parse(`${southAfricanDate()}T00:00:00Z`)) / 86_400_000));
  const percentage = daysUntil >= policy.fullRefundDays ? 100 : daysUntil >= policy.partialRefundDays ? policy.partialRefundPercent : 0;
  return Math.round(paid * percentage) / 100;
}
async function logActivity(actor: SessionUser | null, action: string, entity: string, entityId = "", details = ""): Promise<void> {
  await database.prepare("INSERT INTO activity_log(actor_id,actor_name,actor_role,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(actor?.id ?? null, actor?.name ?? "Visitor", actor?.role ?? "visitor", action, entity, entityId, details.slice(0, 500), now());
}
const json = (res: ServerResponse, body: unknown, status = 200): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text), "X-Content-Type-Options": "nosniff" });
  res.end(text);
};
async function readJson(req: IncomingMessage): Promise<JsonObject> {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 5_000_000) throw new Error("Request body is too large. Payment proof files must be 3 MB or smaller."); }
  try { return data ? (JSON.parse(data) as JsonObject) : {}; } catch { throw new Error("Invalid JSON request."); }
}
const hashPassword = (password: string): string => { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; };
const verifyPassword = (password: string, saved: string): boolean => { const [salt, hash] = saved.split(":"); if (!salt || !hash) return false; const actual = scryptSync(password, salt, 64); const expected = Buffer.from(hash, "hex"); return actual.length === expected.length && timingSafeEqual(actual, expected); };
function sessionCookie(userId: number): string {
  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400; const data = `${userId}.${expiry}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return `ev_session=${data}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
async function currentUser(req: IncomingMessage): Promise<SessionUser | null> {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("ev_session="))?.slice("ev_session=".length);
  if (!cookie) return null;
  const [idText, expiry, signature] = cookie.split(".");
  if (!idText || !expiry || !signature || Number(expiry) < Date.now() / 1000) return null;
  const expected = createHmac("sha256", secret).update(`${idText}.${expiry}`).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return await database.prepare("SELECT id,name,email,phone,role FROM users WHERE id=? AND active=1").get(Number(idText)) as SessionUser | undefined || null;
}
async function requireRole(req: IncomingMessage, res: ServerResponse, roles: Role[]): Promise<SessionUser | null> {
  const user = await currentUser(req);
  if (!user) { json(res, { error: "Sign in required." }, 401); return null; }
  if (!roles.includes(user.role)) { json(res, { error: "Not authorised." }, 403); return null; }
  return user;
}
async function login(req: IncomingMessage, res: ServerResponse, user: SessionUser): Promise<void> {
  await logActivity(user, "Signed in", "Account", String(user.id)); res.setHeader("Set-Cookie", sessionCookie(user.id)); json(res, user);
}
async function notify(userId: number, message: string): Promise<void> {
  await database.prepare("INSERT INTO notifications(recipient_id,message,created_at) VALUES(?,?,?)").run(userId, message, now());
}
async function assignTask(bookingId: number): Promise<boolean> {
  const booking = await database.prepare("SELECT b.*,s.name AS service,s.required_skill FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.id=?").get(bookingId) as any;
  if (!booking) return false;
  await database.prepare("INSERT OR IGNORE INTO tasks(booking_id,name,required_skill,due_at) VALUES(?,?,?,?)").run(bookingId, `${booking.service} · event delivery`, booking.required_skill, `${booking.event_date}T${booking.start_time}`);
  const task = await database.prepare("SELECT id,staff_id FROM tasks WHERE booking_id=?").get(bookingId) as any;
  if (task.staff_id) return true;
  const candidates = await database.prepare("SELECT st.id,st.user_id FROM staff st JOIN users u ON u.id=st.user_id WHERE u.active=1 AND lower(st.skills) LIKE lower(?) ORDER BY (SELECT COUNT(*) FROM tasks WHERE staff_id=st.id AND status NOT IN ('Completed','Cancelled'))").all(`%${booking.required_skill}%`) as any[];
  for (const staff of candidates) {
    const conflict = await database.prepare("SELECT 1 FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE t.staff_id=? AND b.event_date=? AND t.status NOT IN ('Completed','Cancelled')").get(staff.id, booking.event_date);
    if (conflict) continue;
    await database.prepare("UPDATE tasks SET staff_id=?,status='Assigned' WHERE id=?").run(staff.id, task.id);
    await notify(staff.user_id, `New task assigned for booking ${booking.reference}.`);
    return true;
  }
  for (const admin of await database.prepare("SELECT id FROM users WHERE role='admin'").all() as any[])
    await notify(admin.id, `No qualified staff is available for ${booking.reference}. Manual assignment needed.`);
  return false;
}
function validISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function timeEnd(startTime: string, durationMinutes: number): string {
  const start = new Date(`2000-01-01T${startTime}:00Z`);
  start.setUTCMinutes(start.getUTCMinutes() + durationMinutes);
  return `${String(start.getUTCHours()).padStart(2, "0")}:${String(start.getUTCMinutes()).padStart(2, "0")}`;
}
async function bookingTimeCollision(db: any, date: string, startTime: string, duration: number, exceptBookingId: number): Promise<boolean> {
  const end = timeEnd(startTime, duration);
  return Boolean(await db.prepare("SELECT 1 FROM bookings WHERE event_date=? AND id<>? AND status NOT IN ('Cancelled','Declined') AND start_time < ? AND time(start_time,'+'||duration_minutes||' minutes') > ? LIMIT 1")
    .get(date, exceptBookingId, end, startTime));
}
async function sendBookingApprovalEmail(to: string, customerName: string, reference: string, service: string, packageName: string, eventDate: string, startTime: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ESCAPE_VILLA_EMAIL_FROM;
  if (!apiKey || !from) throw new Error("Email delivery is not configured. Set RESEND_API_KEY and ESCAPE_VILLA_EMAIL_FROM.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `booking-approved-${reference}` },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Your Escape Villa booking is approved · ${reference}`,
      text: `Hello ${customerName},\n\nYour booking has been approved.\n\nReference: ${reference}\nService: ${service}\nPackage: ${packageName || "Not specified"}\nDate: ${eventDate}\nTime: ${startTime}\n\nThe Escape Villa team will contact you if any further details are needed.\n\nEscape Villa SA`,
    }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method || "GET";
  if (method === "GET" && path === "/api/me")
    return (json(res, await currentUser(req)), true);
  if (method === "GET" && path === "/api/booking-dates") {
    const month = url.searchParams.get("month") || "";
    const [year, monthNumber] = month.split("-").map(Number);
    if (!/^\d{4}-\d{2}$/.test(month) || monthNumber < 1 || monthNumber > 12)
      return (json(res, { error: "Choose a valid calendar month." }, 400), true);
    const nextMonthDate = new Date(year, monthNumber, 1);
    const nextMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
    const booked = await database.prepare("SELECT DISTINCT event_date FROM bookings WHERE event_date>=? AND event_date<? AND status NOT IN ('Cancelled','Declined') ORDER BY event_date").all(`${month}-01`, nextMonth) as Array<{ event_date: string }>;
    return (json(res, { bookedDates: booked.map((row) => row.event_date) }), true);
  }
  if (method === "GET" && path === "/api/public") {
    const serviceRows = await database
      .prepare(
        "SELECT id,name,description,required_skill FROM services WHERE active=1 ORDER BY id",
      )
      .all();
    const packageRows = await database
      .prepare("SELECT p.id,p.service_id,s.name AS service_name,p.name,p.price,p.price_from,p.duration_minutes,p.description FROM packages p JOIN services s ON s.id=p.service_id WHERE p.active=1 AND s.active=1 ORDER BY s.id,p.id")
      .all();
    return (json(res, { services: serviceRows, packages: packageRows }), true);
  }
  if (method === "POST" && path === "/api/register") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    const confirmPassword = String(body.confirm_password || "");
    if (
      !name ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      password.length < 10 ||
      password !== confirmPassword
    )
      return (
        json(
          res,
          {
            error:
              "Enter your name and a valid email, use a password of at least 10 characters, and make sure both passwords match.",
          },
          400,
        ),
        true
      );
    try {
      const result = await database
        .prepare(
          "INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,'customer',?)",
        )
        .run(
          name,
          email,
          String(body.phone || ""),
          hashPassword(password),
          now(),
        );
      const customer = await database
        .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
        .get(Number(result.lastInsertRowid)) as SessionUser;
      await logActivity(customer, "Created customer account", "Account", String(customer.id));
      json(res, { ok: true });
    } catch {
      json(res, { error: "That email address is already registered." }, 409);
    }
    return true;
  }
  if (
    method === "POST" &&
    ["/api/login", "/api/admin/login", "/api/staff/login"].includes(path)
  ) {
    const body = await readJson(req);
    const user = await database
      .prepare("SELECT * FROM users WHERE email=? AND active=1")
      .get(String(body.email || "").trim().toLowerCase()) as
      | (SessionUser & { password_hash: string })
      | undefined;
    const required = path.includes("/admin/")
      ? "admin"
      : path.includes("/staff/")
        ? "staff"
        : undefined;
    if (
      !user ||
      !verifyPassword(String(body.password || ""), user.password_hash) ||
      (required && user.role !== required)
    ) {
      await logActivity(null, "Failed sign-in attempt", "Account", "", required || "Customer account");
      return (
        json(res, { error: "Email or password is incorrect." }, 401),
        true
      );
    }
    await login(req, res, user);
    return true;
  }
  if (method === "POST" && path === "/api/admin/recover") {
    const body = await readJson(req);
    const configured = process.env.ESCAPE_VILLA_ADMIN_RECOVERY_KEY || "";
    const provided = String(body.recovery_key || "");
    const configuredBytes = Buffer.from(configured);
    const providedBytes = Buffer.from(provided);
    if (configuredBytes.length < 32 || configuredBytes.length !== providedBytes.length || !timingSafeEqual(configuredBytes, providedBytes))
      return (json(res, { error: "Recovery is unavailable or the recovery key is incorrect." }, 403), true);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10)
      return (json(res, { error: "Enter a name, valid email and password of at least 10 characters." }, 400), true);
    const admins = await database.prepare("SELECT id FROM users WHERE role='admin'").all() as Array<{ id: number }>;
    if (admins.length !== 1)
      return (json(res, { error: admins.length === 0 ? "No administrator account exists. Use the initial setup page instead." : "There is more than one administrator account. Ask an existing administrator to update the account." }, 409), true);
    const adminId = admins[0].id;
    const duplicate = await database.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(email, adminId);
    if (duplicate)
      return (json(res, { error: "That email address is already registered." }, 409), true);
    await database.prepare("UPDATE users SET name=?,email=?,password_hash=? WHERE id=?")
      .run(name, email, hashPassword(password), adminId);
    const admin = await database.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
      .get(adminId) as SessionUser;
    await logActivity(admin, "Recovered administrator login details", "Account", String(admin.id));
    process.env.ESCAPE_VILLA_ADMIN_RECOVERY_KEY = "";
    await login(req, res, admin);
    return true;
  }
  if (method === "POST" && path === "/api/admin/reset-all") {
    const body = await readJson(req);
    const configured = process.env.ESCAPE_VILLA_RESET_ALL_KEY || "";
    const provided = String(body.reset_key || "");
    const configuredBytes = Buffer.from(configured);
    const providedBytes = Buffer.from(provided);
    if (configuredBytes.length < 32 || configuredBytes.length !== providedBytes.length || !timingSafeEqual(configuredBytes, providedBytes))
      return (json(res, { error: "Reset is unavailable or the reset key is incorrect." }, 403), true);
    if (body.confirmation !== "ERASE ALL ACCOUNTS")
      return (json(res, { error: "Type ERASE ALL ACCOUNTS exactly to continue." }, 400), true);
    if (!process.env.ESCAPE_VILLA_SETUP_KEY)
      return (json(res, { error: "Configure ESCAPE_VILLA_SETUP_KEY before erasing accounts, so a new administrator can be created afterward." }, 503), true);
    try {
      const newSessionSecret = randomBytes(32).toString("hex");
      await database.transaction(async (tx: any) => {
        for (const table of ["notifications", "refunds", "cancellation_requests", "changes", "tasks", "payments", "bookings", "staff", "users", "activity_log"])
          await tx.prepare(`DELETE FROM ${table}`).run();
        await tx.prepare("INSERT INTO settings(key,value) VALUES('session_secret_override',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(newSessionSecret);
      });
      secret = newSessionSecret;
      process.env.ESCAPE_VILLA_RESET_ALL_KEY = "";
    } catch {
      return (json(res, { error: "The reset could not be completed. No partial reset was kept." }, 500), true);
    }
    res.setHeader("Set-Cookie", "ev_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return (json(res, { ok: true, message: "Accounts and linked business data were erased. Create the new administrator at /admin/setup." }), true);
  }
  if (method === "POST" && path === "/api/admin/setup") {
    const body = await readJson(req);
    const configured = process.env.ESCAPE_VILLA_SETUP_KEY;
    if (
      !configured ||
      body.setup_key !== configured ||
      Number(
        await database
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'")
          .get()?.count,
      ) > 0
    )
      return (
        json(
          res,
          {
            error:
              "Setup is unavailable or the one-time setup key is incorrect.",
          },
          403,
        ),
        true
      );
    if (
      !String(body.name || "").trim() ||
      !/^\S+@\S+\.\S+$/.test(String(body.email || "")) ||
      String(body.password || "").length < 10
    )
      return (
        json(
          res,
          {
            error:
              "Enter a name, valid email and password of at least 10 characters.",
          },
          400,
        ),
        true
      );
    const result = await database
      .prepare(
        "INSERT INTO users(name,email,password_hash,role,created_at) VALUES(?,?,?,'admin',?)",
      )
      .run(
        String(body.name || "").trim(),
        String(body.email || "").toLowerCase(),
        hashPassword(String(body.password || "")),
        now(),
      );
    const admin = await database
      .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
      .get(Number(result.lastInsertRowid)) as SessionUser;
    await logActivity(admin, "Created administrator account", "Account", String(admin.id));
    await login(req, res, admin);
    return true;
  }
  if (method === "POST" && path === "/api/logout") {
    const user = await currentUser(req);
    if (user) await logActivity(user, "Signed out", "Account", String(user.id));
    res.setHeader(
      "Set-Cookie",
      "ev_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return (json(res, { ok: true }), true);
  }
  if (method === "POST" && path === "/api/contact") {
    const body = await readJson(req);
    const vals = ["name", "email", "phone", "subject", "message"].map((key) =>
      String(body[key] || "").trim(),
    );
    if (vals.some((value) => !value))
      return (json(res, { error: "Complete all contact fields." }, 400), true);
    const enquiryInsert = await database
      .prepare("INSERT INTO enquiries(name,email,phone,subject,message,created_at) VALUES(?,?,?,?,?,?) RETURNING id")
      .run(...vals, now());
    const enquiryId = Number(enquiryInsert.rows[0]?.id || enquiryInsert.lastInsertRowid || 0);
    await logActivity(null, "Submitted contact enquiry", "Enquiry", String(enquiryId), vals[3]);
    for (const admin of await database
      .prepare("SELECT id FROM users WHERE role='admin'")
      .all() as Array<{ id: number }>)
      await notify(admin.id, "A new contact enquiry has arrived.");
    return (json(res, { ok: true }), true);
  }
  if (method === "PATCH" && path === "/api/admin/account") {
    const user = await requireRole(req, res, ["admin"]);
    if (!user) return true;
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email))
      return (json(res, { error: "Enter your name and a valid email address." }, 400), true);
    const saved = await database
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(user.id) as { password_hash: string } | undefined;
    if (!saved || !verifyPassword(currentPassword, saved.password_hash))
      return (json(res, { error: "Your current password is incorrect." }, 401), true);
    if (newPassword && newPassword.length < 10)
      return (json(res, { error: "Your new password must be at least 10 characters." }, 400), true);
    const duplicate = await database
      .prepare("SELECT 1 FROM users WHERE email=? AND id<>?")
      .get(email, user.id);
    if (duplicate)
      return (json(res, { error: "That email address is already registered." }, 409), true);
    try {
      await database.prepare("UPDATE users SET name=?,email=? WHERE id=?").run(name, email, user.id);
      if (newPassword)
        await database.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(newPassword), user.id);
    } catch {
      return (json(res, { error: "That email address is already registered." }, 409), true);
    }
    const updated = await database
      .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
      .get(user.id) as SessionUser;
    const changes = [email !== user.email ? "email changed" : "", newPassword ? "password changed" : ""]
      .filter(Boolean)
      .join("; ") || "name updated";
    await logActivity(updated, "Updated administrator login details", "Account", String(user.id), changes);
    return (json(res, updated), true);
  }
  if (method === "PATCH" && path === "/api/account/profile") {
    const user = await requireRole(req, res, ["customer", "staff"]);
    if (!user) return true;
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const currentPassword = String(body.current_password || "");
    const newPassword = String(body.new_password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email))
      return (
        json(res, { error: "Enter your name and a valid email address." }, 400),
        true
      );
    const duplicate = await database
      .prepare("SELECT 1 FROM users WHERE email=? AND id<>?")
      .get(email, user.id);
    if (duplicate)
      return (
        json(res, { error: "That email address is already registered." }, 409),
        true
      );
    if (newPassword) {
      const saved = await database
        .prepare("SELECT password_hash FROM users WHERE id=?")
        .get(user.id) as { password_hash: string } | undefined;
      if (!saved || !verifyPassword(currentPassword, saved.password_hash))
        return (
          json(res, { error: "Your current password is incorrect." }, 401),
          true
        );
      if (newPassword.length < 10)
        return (
          json(res, { error: "Your new password must be at least 10 characters." }, 400),
          true
        );
    }
    try {
      await database
        .prepare("UPDATE users SET name=?,email=?,phone=? WHERE id=?")
        .run(name, email, phone, user.id);
      if (newPassword)
        await database
          .prepare("UPDATE users SET password_hash=? WHERE id=?")
          .run(hashPassword(newPassword), user.id);
    } catch {
      return (
        json(res, { error: "That email address is already registered." }, 409),
        true
      );
    }
    const updated = await database
      .prepare("SELECT id,name,email,phone,role FROM users WHERE id=?")
      .get(user.id) as SessionUser;
    await logActivity(updated, "Updated account profile", "Account", String(user.id), newPassword ? "Profile and password updated" : "Profile updated");
    return (json(res, updated), true);
  }
  if (method === "GET" && path === "/api/customer/bookings") {
    const user = await requireRole(req, res, ["customer"]);
    if (!user) return true;
    const [bookings, cancellations, reschedules, policy] = await Promise.all([
      database.prepare("SELECT b.*,s.name AS service,p.status AS payment_status,p.amount AS amount_paid,(SELECT cr.status FROM cancellation_requests cr WHERE cr.booking_id=b.id ORDER BY cr.id DESC LIMIT 1) AS cancellation_status,(SELECT cr.id FROM cancellation_requests cr WHERE cr.booking_id=b.id AND cr.status='Pending' LIMIT 1) AS pending_cancellation_id,(SELECT COUNT(*) FROM changes ch WHERE ch.booking_id=b.id) AS reschedule_request_count,(SELECT ch.status FROM changes ch WHERE ch.booking_id=b.id ORDER BY ch.id DESC LIMIT 1) AS reschedule_status FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id WHERE b.customer_id=? ORDER BY b.event_date DESC,b.start_time").all(user.id),
      database.prepare("SELECT cr.id,cr.booking_id,cr.request_type,cr.status,cr.reason,cr.rejection_reason,cr.calculated_refund_amount,cr.approved_refund_amount,cr.requested_at,cr.reviewed_at,b.reference,b.event_date,r.amount AS refund_amount,r.status AS refund_status,r.transfer_reference,r.failure_reason,r.processed_at FROM cancellation_requests cr JOIN bookings b ON b.id=cr.booking_id LEFT JOIN refunds r ON r.cancellation_request_id=cr.id WHERE cr.customer_id=? ORDER BY cr.id DESC").all(user.id),
      database.prepare("SELECT ch.id,ch.booking_id,ch.requested_json,ch.reason,ch.status,ch.response,ch.created_at,b.reference,b.event_date,b.start_time FROM changes ch JOIN bookings b ON b.id=ch.booking_id WHERE ch.customer_id=? ORDER BY ch.id DESC").all(user.id),
      cancellationPolicy(),
    ]);
    return (json(res, { bookings, cancellations, reschedules, policy }), true);
  }
  if (method === "POST" && path === "/api/customer/cancellation-requests") {
    const user = await requireRole(req, res, ["customer"]);
    if (!user) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const policy = await cancellationPolicy();
    let insertedId = 0;
    let refundEstimate = 0;
    try {
      await database.transaction(async (tx: any) => {
        const booking = await tx.prepare("SELECT b.id,b.customer_id,b.event_date,b.status,p.amount FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id WHERE b.id=? AND b.customer_id=?").get(bookingId, user.id) as any;
        if (!booking) throw new Error("BOOKING_NOT_FOUND");
        if (["Completed", "Cancelled", "Declined"].includes(booking.status)) throw new Error("BOOKING_NOT_CANCELLABLE");
        const existing = await tx.prepare("SELECT id FROM cancellation_requests WHERE booking_id=? AND status='Pending'").get(bookingId);
        if (existing) throw new Error("CANCELLATION_ALREADY_PENDING");
        refundEstimate = refundForBooking(Number(booking.amount || 0), booking.event_date, policy);
        const result = await tx.prepare("INSERT INTO cancellation_requests(booking_id,customer_id,request_type,status,reason,calculated_refund_amount,requested_at) VALUES(?,?,'customer','Pending',?,?,?)")
          .run(bookingId, user.id, String(body.reason || "").trim().slice(0, 500), refundEstimate, now());
        insertedId = Number(result.lastInsertRowid);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "BOOKING_NOT_FOUND") return (json(res, { error: "Booking not found." }, 404), true);
      if (message === "BOOKING_NOT_CANCELLABLE") return (json(res, { error: "This booking can no longer be cancelled through the portal." }, 409), true);
      if (message === "CANCELLATION_ALREADY_PENDING" || /cancellation_one_pending_per_booking|UNIQUE constraint failed/i.test(message)) return (json(res, { error: "A cancellation request is already awaiting review for this booking." }, 409), true);
      throw error;
    }
    const admins = await database.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all() as Array<{id:number}>;
    for (const admin of admins) await notify(admin.id, `Customer cancellation request received for booking ${bookingId}.`);
    await logActivity(user, "Requested booking cancellation", "Cancellation", String(insertedId), `Calculated refund: R${refundEstimate.toFixed(2)}`);
    return (json(res, { ok: true, request_id: insertedId, calculated_refund_amount: refundEstimate }, 201), true);
  }
  if (method === "POST" && path === "/api/customer/reschedule-requests") {
    const user = await requireRole(req, res, ["customer"]);
    if (!user) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const date = String(body.event_date || "");
    const time = String(body.start_time || "");
    if (!validISODate(date) || date < southAfricanDate() || !/^\d{2}:\d{2}$/.test(time) || Number(time.slice(0,2)) > 23 || Number(time.slice(3)) > 59)
      return (json(res, { error: "Choose a valid future date and time." }, 400), true);
    const booking = await database.prepare("SELECT id,customer_id,event_date,start_time,duration_minutes,status FROM bookings WHERE id=? AND customer_id=?").get(bookingId, user.id) as any;
    if (!booking) return (json(res, { error: "Booking not found." }, 404), true);
    if (["Completed", "Cancelled", "Declined"].includes(booking.status)) return (json(res, { error: "This booking can no longer be rescheduled." }, 409), true);
    if (await database.prepare("SELECT id FROM cancellation_requests WHERE booking_id=? AND status='Pending' LIMIT 1").get(bookingId)) return (json(res, { error: "This booking has a cancellation request awaiting review." }, 409), true);
    if (Number(time.slice(0,2)) * 60 + Number(time.slice(3)) + Number(booking.duration_minutes) > 1440) return (json(res, { error: "The booking duration cannot run past midnight." }, 400), true);
    if (await database.prepare("SELECT id FROM changes WHERE booking_id=? LIMIT 1").get(bookingId)) return (json(res, { error: "Only one rescheduling request is allowed for each booking." }, 409), true);
    if (await bookingTimeCollision(database, date, time, Number(booking.duration_minutes), bookingId)) return (json(res, { error: "That requested time overlaps another booking." }, 409), true);
    let result: any;
    try { result = await database.prepare("INSERT INTO changes(booking_id,customer_id,requested_json,reason,status,created_at) VALUES(?,?,?,?, 'Pending',?)")
      .run(bookingId, user.id, JSON.stringify({ event_date: date, start_time: time }), String(body.reason || "").trim().slice(0, 500), now()); }
    catch (error) { if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : "")) return (json(res, { error: "Only one rescheduling request is allowed for each booking." }, 409), true); throw error; }
    const admins = await database.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all() as Array<{id:number}>;
    for (const admin of admins) await notify(admin.id, `Rescheduling request received for booking ${bookingId}.`);
    await logActivity(user, "Requested booking reschedule", "Reschedule", String(result.lastInsertRowid), `${date} ${time}`);
    return (json(res, { ok: true, request_id: Number(result.lastInsertRowid) }, 201), true);
  }
  if (method === "POST" && path === "/api/customer/bookings") {
    const user = await requireRole(req, res, ["customer"]);
    if (!user) return true;
    const body = await readJson(req);
    const proof = body.payment_proof as { name?: unknown; type?: unknown; data?: unknown } | undefined;
    const allowedProofTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    const proofMatch = typeof proof?.data === "string" ? proof.data.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!proof || !proofMatch || !allowedProofTypes.includes(proofMatch[1]))
      return (json(res, { error: "Upload your proof of payment as a JPG, PNG, WebP or PDF file." }, 400), true);
    const proofBytes = Buffer.from(proofMatch[2], "base64");
    if (!proofBytes.length || proofBytes.length > 3 * 1024 * 1024 || proofBytes.toString("base64") !== proofMatch[2])
      return (json(res, { error: "Payment proof must be a valid file no larger than 3 MB." }, 400), true);
    const proofName = String(proof.name || "proof-of-payment").replaceAll("/", "_").replaceAll("\\", "_").replace(/[\0-\x1f]/g, "_").slice(0, 120);
    const signatureIsValid = proofMatch[1] === "image/jpeg" ? proofBytes[0] === 0xff && proofBytes[1] === 0xd8 && proofBytes[2] === 0xff
      : proofMatch[1] === "image/png" ? proofBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : proofMatch[1] === "image/webp" ? proofBytes.toString("ascii", 0, 4) === "RIFF" && proofBytes.toString("ascii", 8, 12) === "WEBP"
      : proofBytes.toString("ascii", 0, 5) === "%PDF-";
    if (!signatureIsValid) return (json(res, { error: "The selected file does not match its file type." }, 400), true);
    const date = String(body.event_date || "");
    const time = String(body.start_time || "");
    const venue = "Escape Villa, 38 Voortrekker Street, Polokwane Central";
    const packageId = Number(body.package_id);
    const selectedPackage = await database
      .prepare("SELECT p.id,p.service_id,p.name,p.price,p.price_from,p.duration_minutes,p.description,s.required_skill FROM packages p JOIN services s ON s.id=p.service_id WHERE p.id=? AND p.active=1 AND s.active=1")
      .get(packageId) as { id: number; service_id: number; name: string; price: number; price_from: number; duration_minutes: number | null; description: string; required_skill: string } | undefined;
    if (!selectedPackage)
      return (json(res, { error: "Choose an available package." }, 400), true);
    const minutes = Math.max(
      30,
      Math.min(960, Number(body.duration_minutes) || selectedPackage.duration_minutes || 60),
    );
    const service = selectedPackage.service_id;
    const guestCount =
      body.guests === undefined || body.guests === null || body.guests === ""
        ? null
        : Number(body.guests);
    if (
      guestCount !== null &&
      (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 45)
    )
      return (
        json(res, { error: "Escape Villa can accommodate up to 45 guests." }, 400),
        true
      );
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < new Date().toISOString().slice(0, 10) ||
      !/^\d{2}:\d{2}$/.test(time)
    )
      return (
        json(
          res,
          { error: "Choose a future date and valid time." },
          400,
        ),
        true
      );
    const end = new Date(`2000-01-01T${time}:00`);
    end.setMinutes(end.getMinutes() + minutes);
    const endText = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    const collision = await database
      .prepare(
        "SELECT 1 FROM bookings WHERE event_date=? AND status NOT IN ('Cancelled','Declined') AND start_time < ? AND time(start_time,'+'||duration_minutes||' minutes') > ?",
      )
      .get(date, endText, time);
    if (collision)
      return (
        json(
          res,
          { error: "That time overlaps another booking request." },
          409,
        ),
        true
      );
    const reference = `EV-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const bookingId = await database.transaction(async (tx: any) => {
      const result = await tx.prepare("INSERT INTO bookings(reference,customer_id,service_id,package_id,package_name,package_price,package_price_from,package_description,event_type,event_date,start_time,duration_minutes,venue,guests,details,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Pending Payment',?)")
        .run(reference, user.id, service, selectedPackage.id, selectedPackage.name, selectedPackage.price, selectedPackage.price_from, selectedPackage.description, String(body.event_type || ""), date, time, minutes, venue, guestCount, String(body.details || ""), now());
      const id = Number(result.lastInsertRowid);
      await tx.prepare("INSERT INTO payments(booking_id,status,evidence_received,proof_data,proof_mime,proof_filename) VALUES(?,'Pending',1,?,?,?)")
        .run(id, proofMatch[2], proofMatch[1], proofName);
      return id;
    });
    await logActivity(user, "Submitted service booking with payment proof", "Booking", reference, `${date} ${time}; ${selectedPackage.name} (R${selectedPackage.price}${selectedPackage.price_from ? "+" : ""})`);
    return (
      json(res, { ok: true, reference, status: "Pending Payment" }, 201),
      true
    );
  }
  if (method === "GET" && path === "/api/admin/dashboard") {
    if (!await requireRole(req, res, ["admin"])) return true;
    const [bookings, staff, cancellationRequests, rescheduleRequests, policy] = await Promise.all([
      database.prepare("SELECT b.*,u.name AS customer,s.name AS service,p.status AS payment_status,p.evidence_received,p.amount AS amount_paid FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id ORDER BY b.created_at DESC").all(),
      database.prepare("SELECT u.id,u.name,u.email,st.skills FROM users u JOIN staff st ON st.user_id=u.id WHERE u.role='staff' AND u.active=1 ORDER BY u.name").all(),
      database.prepare("SELECT cr.*,b.reference,b.event_date,b.start_time,b.status AS booking_status,b.package_name,u.name AS customer,u.email AS customer_email,u.phone AS customer_phone,s.name AS service,COALESCE(p.amount,0) AS amount_paid,r.id AS refund_id,r.amount AS refund_amount,r.status AS refund_status,r.transfer_reference,r.failure_reason,r.processed_at FROM cancellation_requests cr JOIN bookings b ON b.id=cr.booking_id JOIN users u ON u.id=cr.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id LEFT JOIN refunds r ON r.cancellation_request_id=cr.id ORDER BY CASE cr.status WHEN 'Pending' THEN 0 ELSE 1 END,cr.id DESC").all(),
      database.prepare("SELECT ch.id,ch.booking_id,ch.customer_id,ch.requested_json,ch.reason,ch.status,ch.response,ch.created_at,b.reference,b.event_date,b.start_time,b.duration_minutes,b.status AS booking_status,u.name AS customer,u.email AS customer_email FROM changes ch JOIN bookings b ON b.id=ch.booking_id JOIN users u ON u.id=ch.customer_id ORDER BY CASE ch.status WHEN 'Pending' THEN 0 ELSE 1 END,ch.id DESC").all(),
      cancellationPolicy(),
    ]);
    return (json(res, { bookings, staff, cancellationRequests, rescheduleRequests, policy }), true);
  }
  if (method === "PATCH" && path === "/api/admin/cancellation-policy") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const policy = { fullRefundDays: Number(body.fullRefundDays), partialRefundDays: Number(body.partialRefundDays), partialRefundPercent: Number(body.partialRefundPercent) };
    if (!Number.isInteger(policy.fullRefundDays) || policy.fullRefundDays < 1 || policy.fullRefundDays > 365 || !Number.isInteger(policy.partialRefundDays) || policy.partialRefundDays < 1 || policy.partialRefundDays >= policy.fullRefundDays || !Number.isInteger(policy.partialRefundPercent) || policy.partialRefundPercent < 0 || policy.partialRefundPercent > 100)
      return (json(res, { error: "Use a full-refund threshold from 1–365 days, a lower partial-refund threshold, and a partial percentage from 0–100." }, 400), true);
    await database.prepare("INSERT INTO settings(key,value) VALUES('cancellation_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
    await logActivity(admin, "Updated cancellation policy", "Settings", "cancellation_policy", JSON.stringify(policy));
    return (json(res, { ok: true, policy }), true);
  }
  if (method === "PATCH" && path === "/api/admin/payment-amount") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const amount = Number(body.amount_paid);
    if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100)
      return (json(res, { error: "Enter the total amount actually received to the nearest cent." }, 400), true);
    const payment = await database.prepare("SELECT status FROM payments WHERE booking_id=?").get(bookingId) as {status:string} | undefined;
    if (!payment) return (json(res, { error: "Payment record not found." }, 404), true);
    if (!["Deposit Paid", "Partially Paid", "Fully Paid"].includes(payment.status)) return (json(res, { error: "Only a verified payment can have an amount recorded. Approve its proof after checking the bank first." }, 409), true);
    await database.prepare("UPDATE payments SET amount=? WHERE booking_id=?").run(Math.round(amount * 100) / 100, bookingId);
    const booking = await database.prepare("SELECT event_date FROM bookings WHERE id=?").get(bookingId) as {event_date:string};
    const policy = await cancellationPolicy();
    const estimate = refundForBooking(amount, booking.event_date, policy);
    await database.prepare("UPDATE cancellation_requests SET calculated_refund_amount=? WHERE booking_id=? AND status='Pending'").run(estimate, bookingId);
    await logActivity(admin, "Recorded total amount paid", "Payment", String(bookingId), `R${amount.toFixed(2)} total received to date`);
    return (json(res, { ok: true, amount_paid: amount }), true);
  }
  if (method === "PATCH" && path === "/api/admin/cancellation-requests") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const requestId = Number(body.request_id);
    const decision = String(body.decision || "");
    const cancellation = await database.prepare("SELECT cr.*,b.reference,b.status AS booking_status,b.event_date,COALESCE(p.amount,0) AS amount_paid,p.status AS payment_status FROM cancellation_requests cr JOIN bookings b ON b.id=cr.booking_id LEFT JOIN payments p ON p.booking_id=b.id WHERE cr.id=?").get(requestId) as any;
    if (!cancellation) return (json(res, { error: "Cancellation request not found." }, 404), true);
    if (cancellation.status !== "Pending") return (json(res, { error: "This cancellation request has already been reviewed." }, 409), true);
    if (decision === "reject") {
      const reason = String(body.reason || "").trim().slice(0, 500);
      if (!reason) return (json(res, { error: "Enter a reason when rejecting a cancellation request." }, 400), true);
      const rejection = await database.prepare("UPDATE cancellation_requests SET status='Rejected',rejection_reason=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status='Pending'").run(reason, admin.id, now(), requestId);
      if (Number(rejection.rowsAffected) !== 1) return (json(res, { error: "This cancellation request has already been reviewed." }, 409), true);
      await notify(cancellation.customer_id, `Your cancellation request for ${cancellation.reference} was rejected: ${reason}`);
      await logActivity(admin, "Rejected cancellation request", "Cancellation", String(requestId), reason);
      return (json(res, { ok: true }), true);
    }
    if (decision !== "approve") return (json(res, { error: "Choose approve or reject." }, 400), true);
    if (["Completed", "Cancelled", "Declined"].includes(cancellation.booking_status)) return (json(res, { error: "This booking can no longer be cancelled." }, 409), true);
    if (["Deposit Paid", "Partially Paid", "Fully Paid"].includes(cancellation.payment_status) && Number(cancellation.amount_paid || 0) <= 0) return (json(res, { error: "Record the total verified amount actually paid before approving this cancellation." }, 409), true);
    const policy = await cancellationPolicy();
    const calculated = refundForBooking(Number(cancellation.amount_paid || 0), cancellation.event_date, policy, cancellation.request_type === "venue");
    const refundAmount = Number(body.refund_amount);
    if (!Number.isFinite(refundAmount) || refundAmount < 0 || refundAmount > Number(cancellation.amount_paid || 0) || Math.round(refundAmount * 100) !== refundAmount * 100)
      return (json(res, { error: "Refund must be from R0 up to the total verified amount actually paid, to the nearest cent." }, 400), true);
    let releasedStaff: number[] = [];
    try {
      await database.transaction(async (tx: any) => {
        const fresh = await tx.prepare("SELECT cr.status,b.status AS booking_status,COALESCE(p.amount,0) AS amount_paid,b.event_date FROM cancellation_requests cr JOIN bookings b ON b.id=cr.booking_id LEFT JOIN payments p ON p.booking_id=b.id WHERE cr.id=?").get(requestId) as any;
        if (!fresh || fresh.status !== "Pending") throw new Error("REQUEST_ALREADY_REVIEWED");
        if (["Completed", "Cancelled", "Declined"].includes(fresh.booking_status)) throw new Error("BOOKING_NO_LONGER_CANCELLABLE");
        if (refundAmount > Number(fresh.amount_paid || 0)) throw new Error("REFUND_EXCEEDS_PAID");
        const currentEstimate = refundForBooking(Number(fresh.amount_paid || 0), fresh.event_date, policy, cancellation.request_type === "venue");
        const taskRows = await tx.prepare("SELECT DISTINCT st.user_id FROM tasks t JOIN staff st ON st.id=t.staff_id WHERE t.booking_id=? AND t.status<>'Completed'").all(cancellation.booking_id) as Array<{user_id:number}>;
        releasedStaff = taskRows.map((row) => row.user_id);
        await tx.prepare("UPDATE cancellation_requests SET status='Approved',calculated_refund_amount=?,approved_refund_amount=?,reviewed_by=?,reviewed_at=? WHERE id=?")
          .run(currentEstimate, Math.round(refundAmount * 100) / 100, admin.id, now(), requestId);
        await tx.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(cancellation.booking_id);
        await tx.prepare("UPDATE tasks SET staff_id=NULL,status='Cancelled' WHERE booking_id=? AND status<>'Completed'").run(cancellation.booking_id);
        await tx.prepare("UPDATE changes SET status='Rejected',response='Booking cancelled before rescheduling review.' WHERE booking_id=? AND status='Pending'").run(cancellation.booking_id);
        if (refundAmount > 0) await tx.prepare("INSERT INTO refunds(booking_id,cancellation_request_id,amount,status,updated_by,created_at,updated_at) VALUES(?,?,?,'Pending',?,?,?)")
          .run(cancellation.booking_id, requestId, Math.round(refundAmount * 100) / 100, admin.id, now(), now());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "REQUEST_ALREADY_REVIEWED") return (json(res, { error: "This cancellation request has already been reviewed." }, 409), true);
      if (message === "BOOKING_NO_LONGER_CANCELLABLE") return (json(res, { error: "This booking can no longer be cancelled." }, 409), true);
      if (message === "REFUND_EXCEEDS_PAID") return (json(res, { error: "Refund cannot exceed the current verified amount actually paid." }, 409), true);
      if (/UNIQUE constraint failed/i.test(message)) return (json(res, { error: "A refund record already exists for this booking." }, 409), true);
      throw error;
    }
    for (const staffUserId of releasedStaff) await notify(staffUserId, `The task for cancelled booking ${cancellation.booking_id} was released.`);
    await notify(cancellation.customer_id, refundAmount > 0 ? `Your cancellation for booking ${cancellation.booking_id} was approved. Refund of R${refundAmount.toFixed(2)} is Pending; Escape Villa must send it outside the website.` : `Your cancellation for booking ${cancellation.booking_id} was approved. No refund is due under the recorded decision.`);
    await logActivity(admin, "Approved cancellation request", "Cancellation", String(requestId), `Policy estimate R${calculated.toFixed(2)}; approved refund R${refundAmount.toFixed(2)}`);
    return (json(res, { ok: true, calculated_refund_amount: calculated, approved_refund_amount: refundAmount, refund_status: refundAmount > 0 ? "Pending" : null }), true);
  }
  if (method === "POST" && path === "/api/admin/venue-cancellations") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const reason = String(body.reason || "Escape Villa cancelled this booking.").trim().slice(0, 500);
    const booking = await database.prepare("SELECT b.id,b.customer_id,b.status,b.event_date,COALESCE(p.amount,0) AS amount_paid,p.status AS payment_status FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id WHERE b.id=?").get(bookingId) as any;
    if (!booking) return (json(res, { error: "Booking not found." }, 404), true);
    if (["Completed", "Cancelled", "Declined"].includes(booking.status)) return (json(res, { error: "This booking cannot be cancelled." }, 409), true);
    if (["Deposit Paid", "Partially Paid", "Fully Paid"].includes(booking.payment_status) && Number(booking.amount_paid || 0) <= 0) return (json(res, { error: "Record the total verified amount actually paid before cancelling this booking." }, 409), true);
    let requestId = 0;
    let releasedStaff: number[] = [];
    const amountPaid = Math.round(Number(booking.amount_paid || 0) * 100) / 100;
    try {
      await database.transaction(async (tx: any) => {
        const freshBooking = await tx.prepare("SELECT b.customer_id,b.status,COALESCE(p.amount,0) AS amount_paid FROM bookings b LEFT JOIN payments p ON p.booking_id=b.id WHERE b.id=?").get(bookingId) as any;
        if (!freshBooking || ["Completed", "Cancelled", "Declined"].includes(freshBooking.status)) throw new Error("BOOKING_NO_LONGER_CANCELLABLE");
        const currentAmountPaid = Math.round(Number(freshBooking.amount_paid || 0) * 100) / 100;
        const pending = await tx.prepare("SELECT id FROM cancellation_requests WHERE booking_id=? AND status='Pending'").get(bookingId) as {id:number} | undefined;
        if (pending) {
          requestId = pending.id;
          await tx.prepare("UPDATE cancellation_requests SET request_type='venue',reason=?,status='Approved',calculated_refund_amount=?,approved_refund_amount=?,reviewed_by=?,reviewed_at=? WHERE id=?")
            .run(reason, currentAmountPaid, currentAmountPaid, admin.id, now(), requestId);
        } else {
          const result = await tx.prepare("INSERT INTO cancellation_requests(booking_id,customer_id,request_type,status,reason,calculated_refund_amount,approved_refund_amount,reviewed_by,requested_at,reviewed_at) VALUES(?,?,'venue','Approved',?,?,?,?,?,?)")
            .run(bookingId, freshBooking.customer_id, reason, currentAmountPaid, currentAmountPaid, admin.id, now(), now());
          requestId = Number(result.lastInsertRowid);
        }
        const staff = await tx.prepare("SELECT DISTINCT st.user_id FROM tasks t JOIN staff st ON st.id=t.staff_id WHERE t.booking_id=? AND t.status<>'Completed'").all(bookingId) as Array<{user_id:number}>;
        releasedStaff = staff.map((row) => row.user_id);
        await tx.prepare("UPDATE bookings SET status='Cancelled' WHERE id=?").run(bookingId);
        await tx.prepare("UPDATE tasks SET staff_id=NULL,status='Cancelled' WHERE booking_id=? AND status<>'Completed'").run(bookingId);
        await tx.prepare("UPDATE changes SET status='Rejected',response='Booking cancelled before rescheduling review.' WHERE booking_id=? AND status='Pending'").run(bookingId);
        if (currentAmountPaid > 0) await tx.prepare("INSERT INTO refunds(booking_id,cancellation_request_id,amount,status,updated_by,created_at,updated_at) VALUES(?,?,?,'Pending',?,?,?)")
          .run(bookingId, requestId, currentAmountPaid, admin.id, now(), now());
        booking.customer_id = freshBooking.customer_id;
        booking.amount_paid = currentAmountPaid;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "BOOKING_NO_LONGER_CANCELLABLE") return (json(res, { error: "This booking can no longer be cancelled." }, 409), true);
      if (/UNIQUE constraint failed/i.test(message)) return (json(res, { error: "A cancellation or refund record already exists for this booking." }, 409), true);
      throw error;
    }
    for (const staffUserId of releasedStaff) await notify(staffUserId, `Escape Villa cancelled booking ${bookingId}; your task was released.`);
    await notify(booking.customer_id, amountPaid > 0 ? `Escape Villa cancelled your booking. You qualify for a full refund of R${amountPaid.toFixed(2)}. Refund status: Pending.` : "Escape Villa cancelled your booking. No payment amount is recorded for refund.");
    await logActivity(admin, "Cancelled booking on behalf of Escape Villa", "Cancellation", String(requestId), `${reason}; full refund R${amountPaid.toFixed(2)}`);
    return (json(res, { ok: true, request_id: requestId, refund_amount: amountPaid }), true);
  }
  if (method === "PATCH" && path === "/api/admin/refunds") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const refundId = Number(body.refund_id);
    const status = String(body.status || "");
    const refund = await database.prepare("SELECT r.*,cr.customer_id,b.reference,COALESCE(p.amount,0) AS amount_paid FROM refunds r JOIN cancellation_requests cr ON cr.id=r.cancellation_request_id JOIN bookings b ON b.id=r.booking_id LEFT JOIN payments p ON p.booking_id=r.booking_id WHERE r.id=?").get(refundId) as any;
    if (!refund) return (json(res, { error: "Refund record not found." }, 404), true);
    if (refund.status === "Processed") return (json(res, { error: "A processed refund is locked to prevent duplicate payment." }, 409), true);
    if (!["Pending", "Processed", "Failed"].includes(status)) return (json(res, { error: "Choose Pending, Processed or Failed." }, 400), true);
    if (Number(refund.amount) <= 0 || Number(refund.amount) > Number(refund.amount_paid)) return (json(res, { error: "Refund amount must be positive and no greater than the total verified amount paid." }, 409), true);
    const transferReference = String(body.transfer_reference || "").trim().slice(0, 120);
    const failureReason = String(body.failure_reason || "").trim().slice(0, 500);
    if (status === "Processed" && (body.money_sent !== true || !transferReference)) return (json(res, { error: "Only mark Processed after sending the money outside this website; enter the bank transfer reference." }, 400), true);
    if (status === "Failed" && !failureReason) return (json(res, { error: "Enter a reason for the failed refund." }, 400), true);
    try {
      await database.transaction(async (tx:any) => {
        const fresh = await tx.prepare("SELECT r.status,r.amount,COALESCE(p.amount,0) AS amount_paid FROM refunds r LEFT JOIN payments p ON p.booking_id=r.booking_id WHERE r.id=?").get(refundId) as any;
        if (!fresh) throw new Error("REFUND_NOT_FOUND");
        if (fresh.status === "Processed") throw new Error("REFUND_ALREADY_PROCESSED");
        if (Number(fresh.amount) <= 0 || Number(fresh.amount) > Number(fresh.amount_paid)) throw new Error("REFUND_AMOUNT_INVALID");
        const updated = await tx.prepare("UPDATE refunds SET status=?,transfer_reference=?,failure_reason=?,updated_by=?,updated_at=?,processed_at=? WHERE id=? AND status<>'Processed'")
          .run(status, status === "Processed" ? transferReference : null, status === "Failed" ? failureReason : null, admin.id, now(), status === "Processed" ? now() : null, refundId);
        if (Number(updated.rowsAffected) !== 1) throw new Error("REFUND_ALREADY_PROCESSED");
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "REFUND_NOT_FOUND") return (json(res, { error: "Refund record not found." }, 404), true);
      if (message === "REFUND_ALREADY_PROCESSED") return (json(res, { error: "A processed refund is locked to prevent duplicate payment." }, 409), true);
      if (message === "REFUND_AMOUNT_INVALID") return (json(res, { error: "Refund amount must be positive and no greater than the current verified amount paid." }, 409), true);
      throw error;
    }
    const notice = status === "Processed" ? `Your R${Number(refund.amount).toFixed(2)} refund for ${refund.reference} was marked Processed by Escape Villa. Transfer reference: ${transferReference}.` : status === "Failed" ? `Your refund for ${refund.reference} was marked Failed: ${failureReason}` : `Your refund for ${refund.reference} is Pending.`;
    await notify(refund.customer_id, notice);
    await logActivity(admin, `Updated refund status to ${status}`, "Refund", String(refundId), status === "Processed" ? `R${Number(refund.amount).toFixed(2)}; transfer reference ${transferReference}` : failureReason);
    return (json(res, { ok: true }), true);
  }
  if (method === "PATCH" && path === "/api/admin/reschedule-requests") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const requestId = Number(body.request_id);
    const decision = String(body.decision || "");
    const change = await database.prepare("SELECT ch.*,b.status AS booking_status,b.duration_minutes,b.reference,b.id AS booking_id,(SELECT COUNT(*) FROM cancellation_requests cr WHERE cr.booking_id=b.id AND cr.status='Pending') AS pending_cancellations FROM changes ch JOIN bookings b ON b.id=ch.booking_id WHERE ch.id=?").get(requestId) as any;
    if (!change) return (json(res, { error: "Rescheduling request not found." }, 404), true);
    if (change.status !== "Pending") return (json(res, { error: "This rescheduling request has already been reviewed." }, 409), true);
    if (decision === "reject") {
      const reason = String(body.reason || "").trim().slice(0,500);
      if (!reason) return (json(res, { error: "Enter a reason when rejecting a rescheduling request." }, 400), true);
      await database.prepare("UPDATE changes SET status='Rejected',response=? WHERE id=? AND status='Pending'").run(reason, requestId);
      await notify(change.customer_id, `Your rescheduling request for ${change.reference} was rejected: ${reason}`);
      await logActivity(admin, "Rejected rescheduling request", "Reschedule", String(requestId), reason);
      return (json(res, { ok: true }), true);
    }
    if (decision !== "approve") return (json(res, { error: "Choose approve or reject." }, 400), true);
    if (["Completed", "Cancelled", "Declined"].includes(change.booking_status)) return (json(res, { error: "This booking can no longer be rescheduled." }, 409), true);
    if (Number(change.pending_cancellations) > 0) return (json(res, { error: "Resolve the pending cancellation request before approving a reschedule." }, 409), true);
    let requested: {event_date:string;start_time:string};
    try { requested = JSON.parse(change.requested_json) as {event_date:string;start_time:string}; }
    catch { return (json(res, { error: "The requested date and time could not be read." }, 400), true); }
    if (!validISODate(requested.event_date) || requested.event_date < southAfricanDate() || !/^\d{2}:\d{2}$/.test(requested.start_time)) return (json(res, { error: "The requested time is no longer valid." }, 400), true);
    if (Number(requested.start_time.slice(0,2)) * 60 + Number(requested.start_time.slice(3)) + Number(change.duration_minutes) > 1440) return (json(res, { error: "The booking duration cannot run past midnight." }, 400), true);
    if (await bookingTimeCollision(database, requested.event_date, requested.start_time, Number(change.duration_minutes), change.booking_id)) return (json(res, { error: "That time is no longer available because it overlaps another booking." }, 409), true);
    let assignedStaffUser: number | null = null;
    try {
      await database.transaction(async (tx:any) => {
        const fresh = await tx.prepare("SELECT status FROM changes WHERE id=?").get(requestId) as {status:string};
        if (!fresh || fresh.status !== "Pending") throw new Error("RESCHEDULE_ALREADY_REVIEWED");
        const task = await tx.prepare("SELECT id,staff_id FROM tasks WHERE booking_id=?").get(change.booking_id) as any;
        await tx.prepare("UPDATE bookings SET event_date=?,start_time=? WHERE id=?").run(requested.event_date,requested.start_time,change.booking_id);
        if (task) {
          if (task.staff_id) {
            const conflict = await tx.prepare("SELECT 1 FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE t.staff_id=? AND t.booking_id<>? AND b.event_date=? AND t.status NOT IN ('Completed','Cancelled') LIMIT 1").get(task.staff_id,change.booking_id,requested.event_date);
            if (conflict) await tx.prepare("UPDATE tasks SET staff_id=NULL,status='Unassigned',due_at=? WHERE id=?").run(`${requested.event_date}T${requested.start_time}`,task.id);
            else await tx.prepare("UPDATE tasks SET due_at=? WHERE id=?").run(`${requested.event_date}T${requested.start_time}`,task.id);
          } else await tx.prepare("UPDATE tasks SET due_at=? WHERE id=?").run(`${requested.event_date}T${requested.start_time}`,task.id);
        }
        await tx.prepare("UPDATE changes SET status='Approved',response=? WHERE id=?").run(`Approved for ${requested.event_date} ${requested.start_time}`,requestId);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "RESCHEDULE_ALREADY_REVIEWED") return (json(res, { error: "This rescheduling request has already been reviewed." }, 409), true);
      throw error;
    }
    const taskInfo = await database.prepare("SELECT st.user_id FROM tasks t JOIN staff st ON st.id=t.staff_id WHERE t.booking_id=?").get(change.booking_id) as {user_id:number}|undefined;
    if (taskInfo) assignedStaffUser = taskInfo.user_id;
    else if (change.booking_status === "Booking approved") await assignTask(change.booking_id);
    await notify(change.customer_id, `Your rescheduling request for ${change.reference} was approved for ${requested.event_date} at ${requested.start_time}.`);
    await logActivity(admin, "Approved rescheduling request", "Reschedule", String(requestId), `${requested.event_date} ${requested.start_time}`);
    return (json(res, { ok: true, staff_assigned: Boolean(assignedStaffUser) }), true);
  }
  if ((method === "POST" || method === "PATCH") && path === "/api/admin/staff") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const selectedSkills = Array.isArray(body.skills)
      ? body.skills.map((skill) => String(skill).trim()).filter(Boolean)
      : String(body.skills || "").split(",").map((skill) => skill.trim()).filter(Boolean);
    const allowedSkills = (await database.prepare("SELECT required_skill FROM services WHERE active=1").all() as Array<{ required_skill: string }>).map((service) => service.required_skill);
    const skills = [...new Set(selectedSkills.filter((skill) => allowedSkills.includes(skill)))].join(", ");
    if (!skills) return (json(res, { error: "Select at least one active service for this staff member." }, 400), true);
    if (method === "PATCH") {
      const staffUserId = Number(body.staff_user_id);
      const staffUser = await database.prepare("SELECT id,name,email,role FROM users WHERE id=? AND role='staff' AND active=1").get(staffUserId) as SessionUser | undefined;
      if (!staffUser) return (json(res, { error: "Active staff account not found." }, 404), true);
      await database.prepare("UPDATE staff SET skills=? WHERE user_id=?").run(skills, staffUserId);
      await logActivity(admin, "Updated staff services", "Account", String(staffUserId), skills);
      return (json(res, { ok: true }), true);
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const password = String(body.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10)
      return (
        json(
          res,
          { error: "Enter a name, valid email and password of at least 10 characters." },
          400,
        ),
        true
      );
    try {
      const staffUser = await database.transaction(async (tx: any) => {
        const result = await tx.prepare("INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES(?,?,?,?,'staff',?)")
          .run(name, email, phone, hashPassword(password), now());
        const userId = Number(result.lastInsertRowid);
        await tx.prepare("INSERT INTO staff(user_id,skills) VALUES(?,?)").run(userId, skills);
        return await tx.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?").get(userId) as SessionUser;
      });
      await logActivity(admin, "Created staff account", "Account", String(staffUser.id), `${staffUser.email}; services: ${skills}`);
      return (json(res, staffUser, 201), true);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: users.email"))
        return (
          json(res, { error: "That email address is already registered." }, 409),
          true
        );
      console.error(error);
      return (json(res, { error: "Could not create the staff account." }, 500), true);
    }
  }
  if (method === "GET" && path === "/api/admin/reports") {
    if (!await requireRole(req, res, ["admin"])) return true;
    const period = url.searchParams.get("period") || "daily";
    const selected =
      url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    if (
      !["daily", "weekly", "monthly"].includes(period) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(selected) ||
      Number.isNaN(Date.parse(`${selected}T00:00:00Z`))
    )
      return (
        json(
          res,
          { error: "Choose daily, weekly or monthly and a valid date." },
          400,
        ),
        true
      );
    const anchor = new Date(`${selected}T00:00:00Z`);
    let startDate: Date;
    let endDate: Date;
    if (period === "daily") {
      startDate = anchor;
      endDate = new Date(anchor);
      endDate.setUTCDate(endDate.getUTCDate() + 1);
    } else if (period === "weekly") {
      startDate = new Date(anchor);
      const back = (anchor.getUTCDay() + 6) % 7;
      startDate.setUTCDate(startDate.getUTCDate() - back);
      endDate = new Date(startDate);
      endDate.setUTCDate(endDate.getUTCDate() + 7);
    } else {
      startDate = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1),
      );
      endDate = new Date(
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1),
      );
    }
    const from = startDate.toISOString().slice(0, 10);
    const until = endDate.toISOString().slice(0, 10);
    const bookings = await database
      .prepare(
        "SELECT b.reference,b.event_date,b.start_time,b.event_type,b.venue,b.status,b.package_name,b.package_price,b.package_price_from,u.name AS customer,u.email,s.name AS service,p.status AS payment_status,p.amount AS paid_amount FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id WHERE b.event_date>=? AND b.event_date<? ORDER BY b.event_date,b.start_time",
      )
      .all(from, until) as Array<Record<string, string | number | null>>;
    const activity = await database
      .prepare("SELECT id,actor_name,actor_role,action,entity,entity_id,details,created_at FROM activity_log ORDER BY id DESC")
      .all();
    const byService = await database
      .prepare(
        "SELECT s.name AS label,COUNT(*) AS count FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.event_date>=? AND b.event_date<? GROUP BY s.id ORDER BY count DESC",
      )
      .all(from, until);
    const byStatus = await database
      .prepare(
        "SELECT status AS label,COUNT(*) AS count FROM bookings WHERE event_date>=? AND event_date<? GROUP BY status ORDER BY count DESC",
      )
      .all(from, until);
    const paymentStatuses = await database
      .prepare(
        "SELECT p.status AS label,COUNT(*) AS count FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.event_date>=? AND b.event_date<? GROUP BY p.status ORDER BY count DESC",
      )
      .all(from, until);
    const tasks = await database
      .prepare(
        "SELECT t.status AS label,COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<? GROUP BY t.status ORDER BY count DESC",
      )
      .all(from, until);
    const paid = await database
      .prepare(
        "SELECT COALESCE(SUM(p.amount),0) AS amount FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.event_date>=? AND b.event_date<? AND p.status IN ('Deposit Paid','Partially Paid','Fully Paid')",
      )
      .get(from, until) as { amount: number };
    const summary = {
      totalBookings: bookings.length,
      confirmed: bookings.filter((b) =>
        ["Confirmed", "Booking approved", "Assigned", "In Progress", "Completed"].includes(
          String(b.status),
        ),
      ).length,
      cancelled: bookings.filter((b) => b.status === "Cancelled").length,
      completedTasks: Number(
        await database
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<? AND t.status='Completed'",
          )
          .get(from, until)?.count || 0,
      ),
      totalTasks: Number(
        await database
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks t JOIN bookings b ON b.id=t.booking_id WHERE b.event_date>=? AND b.event_date<?",
          )
          .get(from, until)?.count || 0,
      ),
      paymentAmount: Number(paid.amount || 0),
    };
    return (
      json(res, {
        period,
        selectedDate: selected,
        startDate: from,
        endDateExclusive: until,
        summary,
        byService,
        byStatus,
        paymentStatuses,
        tasks,
        bookings,
        activity,
      }),
      true
    );
  }
  if (method === "GET" && path === "/api/staff/tasks") {
    const user = await requireRole(req, res, ["staff"]);
    if (!user) return true;
    return (
      json(
        res,
        await database
          .prepare(
            "SELECT t.*,b.reference,b.event_date,b.start_time,b.venue,s.name AS service FROM tasks t JOIN bookings b ON b.id=t.booking_id JOIN services s ON s.id=b.service_id JOIN staff st ON st.id=t.staff_id WHERE st.user_id=? ORDER BY t.due_at",
          )
          .all(user.id),
      ),
      true
    );
  }
  if (method === "PATCH" && path === "/api/staff/tasks") {
    const user = await requireRole(req, res, ["staff"]);
    if (!user) return true;
    const body = await readJson(req);
    const status = String(body.status || "");
    if (!["In Progress", "Blocked", "Completed"].includes(status))
      return (json(res, { error: "Invalid task status." }, 400), true);
    const task = await database
      .prepare(
        "SELECT t.id,t.booking_id FROM tasks t JOIN staff s ON s.id=t.staff_id WHERE t.id=? AND s.user_id=?",
      )
      .get(Number(body.task_id), user.id) as
      | { id: number; booking_id: number }
      | undefined;
    if (!task) return (json(res, { error: "Task not found." }, 404), true);
    await database
      .prepare("UPDATE tasks SET status=?,notes=? WHERE id=?")
      .run(status, String(body.notes || ""), task.id);
    await logActivity(user, "Updated task status", "Task", String(task.id), `${status}; booking ${task.booking_id}`);
    for (const admin of await database
      .prepare("SELECT id FROM users WHERE role='admin'")
      .all() as Array<{ id: number }>)
      await notify(admin.id, `Staff updated task ${task.id}: ${status}.`);
    return (json(res, { ok: true }), true);
  }
  if (method === "GET" && path === "/api/admin/activity") {
    if (!await requireRole(req, res, ["admin"])) return true;
    return (json(res, await database.prepare("SELECT id,actor_name,actor_role,action,entity,entity_id,details,created_at FROM activity_log ORDER BY id DESC").all()), true);
  }
  if (method === "GET" && path === "/api/notifications") {
    const user = await requireRole(req, res, ["customer", "admin", "staff"]);
    if (!user) return true;
    return (
      json(
        res,
        await database
          .prepare(
            "SELECT * FROM notifications WHERE recipient_id=? ORDER BY id DESC LIMIT 50",
          )
          .all(user.id),
      ),
      true
    );
  }
  if (method === "GET" && path === "/api/admin/bookings") {
    if (!await requireRole(req, res, ["admin"])) return true;
    return (
      json(
        res,
        await database
          .prepare(
            "SELECT b.*,u.name AS customer,s.name AS service,p.status AS payment_status FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id LEFT JOIN payments p ON p.booking_id=b.id ORDER BY b.id DESC",
          )
          .all(),
      ),
      true
    );
  }
  if (method === "GET" && path === "/api/admin/customer-records") {
    if (!await requireRole(req, res, ["admin"])) return true;
    const customers = await database.prepare("SELECT u.id,u.name,u.email,u.phone,u.created_at,COUNT(b.id) AS booking_count,MAX(b.event_date) AS last_booking_date FROM users u LEFT JOIN bookings b ON b.customer_id=u.id WHERE u.role='customer' GROUP BY u.id,u.name,u.email,u.phone,u.created_at ORDER BY lower(u.name),u.id").all();
    return (json(res, customers), true);
  }
  const paymentProofMatch = path.match(/^\/api\/admin\/payment-proof\/(\d+)$/);
  if (method === "GET" && paymentProofMatch) {
    if (!await requireRole(req, res, ["admin"])) return true;
    const proof = await database.prepare("SELECT proof_data,proof_mime,proof_filename FROM payments WHERE booking_id=? AND evidence_received=1").get(Number(paymentProofMatch[1])) as any;
    if (!proof?.proof_data || !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(proof.proof_mime)) {
      json(res, { error: "Payment proof was not found." }, 404);
      return true;
    }
    const file = Buffer.from(proof.proof_data, "base64");
    res.writeHead(200, { "Content-Type": proof.proof_mime, "Content-Length": file.length, "Content-Disposition": `attachment; filename="${String(proof.proof_filename || "payment-proof").replaceAll("\\", "_").replace(/[\"\r\n]/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.end(file);
    return true;
  }
  if (method === "POST" && path === "/api/admin/payment-review") {
    const admin = await requireRole(req, res, ["admin"]);
    if (!admin) return true;
    const body = await readJson(req);
    const bookingId = Number(body.booking_id);
    const amountReceived = Number(body.amount_received);
    if (body.approve === true && (!Number.isFinite(amountReceived) || amountReceived <= 0 || Math.round(amountReceived * 100) !== amountReceived * 100))
      return (json(res, { error: "Enter the total amount actually received for this booking, to the nearest cent." }, 400), true);
    const evidence = await database
      .prepare("SELECT evidence_received FROM payments WHERE booking_id=?")
      .get(bookingId) as { evidence_received: number } | undefined;
    if (body.approve === true && !evidence?.evidence_received)
      return (json(res, { error: "Payment evidence must be recorded before approval." }, 400), true);
    const booking = await database
      .prepare("SELECT b.customer_id,b.reference,b.event_date,b.start_time,b.package_name,u.name AS customer_name,u.email AS customer_email,s.name AS service FROM bookings b JOIN users u ON u.id=b.customer_id JOIN services s ON s.id=b.service_id WHERE b.id=?")
      .get(bookingId) as { customer_id: number; reference: string; event_date: string; start_time: string; package_name: string; customer_name: string; customer_email: string; service: string } | undefined;
    if (!booking) return (json(res, { error: "Booking not found." }, 404), true);
    if (body.approve === true) {
      await database.prepare("UPDATE payments SET amount=?,status='Deposit Paid',rejection_reason=NULL,reviewed_at=? WHERE booking_id=?")
        .run(Math.round(amountReceived * 100) / 100, now(), bookingId);
    } else {
      await database.prepare("UPDATE payments SET status='Rejected',rejection_reason=?,reviewed_at=? WHERE booking_id=?")
        .run(String(body.reason || "Please submit corrected proof."), now(), bookingId);
    }
    await logActivity(admin, body.approve === true ? "Approved payment" : "Rejected payment", "Booking", String(bookingId), body.approve === true ? "Payment approved" : String(body.reason || "Payment rejected"));
    await database
      .prepare("UPDATE bookings SET status=? WHERE id=?")
      .run(body.approve === true ? "Booking approved" : "Pending Verification", bookingId);
    if (body.approve !== true) {
      await notify(booking.customer_id, "Payment proof needs correction. Please resubmit.");
      return (json(res, { ok: true, emailSent: false }), true);
    }
    const staffAssigned = await assignTask(bookingId);
    await notify(
      booking.customer_id,
      staffAssigned
        ? "Your booking is approved and a staff member has been assigned."
        : "Your booking is approved. The team will arrange staff and contact you if needed.",
    );
    let emailSent = false;
    let emailMessage = "";
    try {
      await sendBookingApprovalEmail(booking.customer_email, booking.customer_name, booking.reference, booking.service, booking.package_name, booking.event_date, booking.start_time);
      emailSent = true;
    } catch (error) {
      emailMessage = error instanceof Error ? error.message : "Email delivery failed.";
      await logActivity(admin, "Booking approval email failed", "Booking", String(bookingId), emailMessage);
    }
    return (json(res, { ok: true, staffAssigned, emailSent, emailMessage }), true);
  }
  if (path.startsWith("/api/")) {
    json(res, { error: "Not found." }, 404);
    return true;
  }
  return false;
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};
createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self' https://images.unsplash.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https://images.unsplash.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    let asset =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    asset = normalize(asset);
    const file = join(publicDir, asset);
    const rel = relative(publicDir, file);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      !existsSync(file)
    ) {
      const index = join(publicDir, "index.html");
      res.writeHead(200, { "Content-Type": mime[".html"] });
      res.end(readFileSync(index));
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
    });
    res.end(readFileSync(file));
  } catch (error) {
    console.error(error);
    if (!res.headersSent)
      json(res, { error: "Server error. Check input and try again." }, 500);
    else res.end();
  }
}).listen(Number(process.env.PORT || 8000), "0.0.0.0", () =>
  console.log(
    `Escape Villa ready at http://0.0.0.0:${process.env.PORT || 8000}`,
  ),
);
